// Glowing arcs from many homes to one finish, a runner racing along each, for Navara.
// Like RailGlowMeshDesc, but for hundreds of arcs: rather than a uniform per route moved on
// the CPU, every vertex carries its arc's ends and timing, and the shaders place it and the
// runner from the time alone (see shaders/arcPoint.glsl).
//
// Each runner leaves home fast and eases into the finish, rests there, then runs again;
// the farther the home, the longer the run and the higher the arc.
//
// For telling it as a story, the homes can show one by one (`setRevealed()`, in `order`),
// and the arcs grow out of them towards the finish (`setGrow()`); by default all is shown.
import {
  MeshDescWithSelectiveEffect,
  geodeticToVector3,
  setupMaterialForMRT,
  type MeshConfigWithSelectiveEffect,
  type MeshUpdateWithSelectiveEffect,
} from '@navaramap/three'
import {
  AdditiveBlending,
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Group,
  LinearSRGBColorSpace,
  LineSegments,
  Points,
  ShaderMaterial,
  Vector3,
  type IUniform,
} from 'three'
import arcPoint from './shaders/arcPoint.glsl?raw'
import lineFragmentShader from './shaders/arcLine.frag.glsl?raw'
import lineVertexShader from './shaders/arcLine.vert.glsl?raw'
import runnerFragmentShader from './shaders/arcRunner.frag.glsl?raw'
import runnerVertexShader from './shaders/arcRunner.vert.glsl?raw'

type ArcGlowOptions = {
  /** [lng, lat] of each home */
  homes: [number, number][]
  /** [lng, lat] of the finish */
  to: [number, number]
  /** When each home shows, as a rank (0 first) for `setRevealed()`. Default: in order */
  order?: number[]
  /** Colors (CSS) along the distance home to finish (km), log-interpolated between the stops */
  colorStops?: [number, string][]
  /** Brightness of the thread under the runners. Default: 0.12 */
  base?: number
  /** Run time (s) = `baseDuration` + `durationPerSqrtKm` × √(distance in km). Default: 1.3 s */
  baseDuration?: number
  /** See `baseDuration`. Default: 0.035 */
  durationPerSqrtKm?: number
  /** Rest between runs (s), picked per arc within [min, max]. Default: [0.5, 3] */
  pause?: [number, number]
  /** Tail length = current speed × `tailTime` (s). Default: 0.3 s */
  tailTime?: number
  /** Runner sprite size (CSS px). Default: 14 */
  runnerSize?: number
  /** Home dot size (CSS px). Default: 3 */
  homeSize?: number
}
type Description = { arcGlow?: ArcGlowOptions }
export type ArcGlowConfig = MeshConfigWithSelectiveEffect & Description
type ArcGlowUpdate = MeshUpdateWithSelectiveEffect & Description

const DEFAULTS = {
  colorStops: [
    [8, '#ffc15e'],
    [120, '#ff7a59'],
    [1_200, '#ff4f9a'],
    [9_000, '#62d6ff'],
  ] as [number, string][],
  base: 0.12,
  baseDuration: 1.3,
  durationPerSqrtKm: 0.035,
  pause: [0.5, 3] as [number, number],
  tailTime: 0.3,
  runnerSize: 14,
  homeSize: 3,
}

/** Line segments per arc: a handful for the short hops, more for the long hauls */
function segmentsFor(km: number): number {
  return Math.round(Math.min(96, 6 + 10 * Math.sqrt(km / 100)))
}

/** Peak height (m): a third of the distance for the short hops, flattening out for the long hauls */
function heightFor(km: number): number {
  return Math.min(0.3 * km, 300 + 0.13 * km) * 1000
}

// The CSS values as they are, as RailGlowMeshDesc passes Navara's colors
const css = (c: string) => new Color().setStyle(c, LinearSRGBColorSpace)

function colorFor(km: number, stops: [number, string][]): Color {
  const [first, ...rest] = stops
  if (!first) return new Color(1, 1, 1)
  let [d0, c0] = first
  if (km <= d0) return css(c0)
  for (const [d1, c1] of rest) {
    if (km <= d1) return css(c0).lerp(css(c1), Math.log(km / d0) / Math.log(d1 / d0))
    ;[d0, c0] = [d1, c1]
  }
  return css(c0)
}

// Stable pseudo-random timing per arc so the runners don't leave home in lockstep
function rand(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453
  return x - Math.floor(x)
}

function makeMaterial(vertexShader: string, fragmentShader: string, uniforms: Record<string, IUniform>) {
  const material = new ShaderMaterial({
    vertexShader: `${arcPoint}\n${vertexShader}`,
    fragmentShader,
    uniforms,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  })
  // Selective bloom: the shader's color is written to the emissive buffer as is
  material.defines.USE_SELECTIVE_EFFECT = 1
  material.userData.uEffectIdsMask = { value: 0 }
  material.uniforms.uEffectIdsMask = material.userData.uEffectIdsMask
  material.uniforms.uEmissiveColor = { value: new Vector3() } // added to the color: none
  material.uniforms.uEmissiveIntensity = { value: 1 }
  setupMaterialForMRT(material)
  return material
}

export class ArcGlowMeshDesc extends MeshDescWithSelectiveEffect<ArcGlowConfig, ArcGlowUpdate, Group> {
  private config: ArcGlowConfig
  private time = { value: 0 }
  private homeScale = { value: 1 }
  private revealed = { value: 1e9 }
  private grow = { value: 1 }
  private materials: ShaderMaterial[] = []

  constructor(...args: ConstructorParameters<typeof MeshDescWithSelectiveEffect<ArcGlowConfig, ArcGlowUpdate>>) {
    super(...args)
    this.config = args[2] ?? {}
  }

  private get options() {
    return { ...DEFAULTS, ...this.config.arcGlow }
  }

  override createMesh() {
    const opts = this.options
    const homes = opts.homes ?? []
    const to = geodeticToVector3({ lng: opts.to?.[0] ?? 0, lat: opts.to?.[1] ?? 0, height: 0 })
    const toUnit = to.clone().normalize()
    const [pauseMin, pauseMax] = opts.pause

    // Per arc: its ends, angle, height, timing and color
    const arcs = homes.map(([lng, lat], i) => {
      const from = geodeticToVector3({ lng, lat, height: 0 })
      const omega = Math.acos(Math.min(1, Math.max(-1, from.clone().normalize().dot(toUnit))))
      const km = (omega * (from.length() + to.length())) / 2 / 1000
      const duration = opts.baseDuration + opts.durationPerSqrtKm * Math.sqrt(km)
      const pause = pauseMin + rand(i + 0.5) * (pauseMax - pauseMin)
      return {
        from,
        omega,
        height: heightFor(km),
        timing: [rand(i + 1) * (duration + pause), duration, pause],
        color: colorFor(km, opts.colorStops),
        rank: opts.order?.[i] ?? i,
        segments: segmentsFor(km),
      }
    })

    // Interleaved per-arc attributes, repeated for each of its vertices
    const perArc = (count: number) => ({
      from: new Float32Array(count * 3),
      to: new Float32Array(count * 3),
      arc: new Float32Array(count * 2),
      timing: new Float32Array(count * 3),
      color: new Float32Array(count * 3),
      rank: new Float32Array(count),
    })
    const fill = (a: ReturnType<typeof perArc>, k: number, arc: (typeof arcs)[number]) => {
      a.from.set([arc.from.x, arc.from.y, arc.from.z], k * 3)
      a.to.set([to.x, to.y, to.z], k * 3)
      a.arc.set([arc.omega, arc.height], k * 2)
      a.timing.set(arc.timing, k * 3)
      a.color.set([arc.color.r, arc.color.g, arc.color.b], k * 3)
      a.rank[k] = arc.rank
    }
    const setAttributes = (geometry: BufferGeometry, a: ReturnType<typeof perArc>) => {
      geometry.setAttribute('aFrom', new Float32BufferAttribute(a.from, 3))
      geometry.setAttribute('aTo', new Float32BufferAttribute(a.to, 3))
      geometry.setAttribute('aArc', new Float32BufferAttribute(a.arc, 2))
      geometry.setAttribute('aTiming', new Float32BufferAttribute(a.timing, 3))
      geometry.setAttribute('aColor', new Float32BufferAttribute(a.color, 3))
      geometry.setAttribute('aRank', new Float32BufferAttribute(a.rank, 1))
    }

    // Lines: the arcs as segments, each vertex knowing how far along its arc it is
    const vertexCount = arcs.reduce((n, a) => n + a.segments * 2, 0)
    const lineAttrs = perArc(vertexCount)
    const lineT = new Float32Array(vertexCount)
    let k = 0
    for (const arc of arcs) {
      for (let s = 0; s < arc.segments; s++) {
        for (const t of [s / arc.segments, (s + 1) / arc.segments]) {
          fill(lineAttrs, k, arc)
          lineT[k++] = t
        }
      }
    }
    const lineGeometry = new BufferGeometry()
    setAttributes(lineGeometry, lineAttrs)
    lineGeometry.setAttribute('aT', new Float32BufferAttribute(lineT, 1))
    // (three wants a position to count the vertices by; the shader places them itself)
    lineGeometry.setAttribute('position', new Float32BufferAttribute(new Float32Array(vertexCount * 3), 3))

    // Runners and homes: a point per arc
    const pointAttrs = perArc(arcs.length)
    arcs.forEach((arc, i) => fill(pointAttrs, i, arc))
    const pointGeometry = new BufferGeometry()
    setAttributes(pointGeometry, pointAttrs)
    pointGeometry.setAttribute('position', new Float32BufferAttribute(new Float32Array(arcs.length * 3), 3))

    const pixelRatio = { value: window.devicePixelRatio }
    const lineMaterial = makeMaterial(lineVertexShader, lineFragmentShader, {
      uTime: this.time,
      uRevealed: this.revealed,
      uGrow: this.grow,
      uTailTime: { value: opts.tailTime },
      uBase: { value: opts.base },
    })
    const runnerMaterial = makeMaterial(runnerVertexShader, runnerFragmentShader, {
      uTime: this.time,
      uRevealed: this.revealed,
      uGrow: this.grow,
      uSize: { value: opts.runnerSize },
      uSizeScale: { value: 1 },
      uPixelRatio: pixelRatio,
      uCore: { value: 2.0 },
    })
    const homeMaterial = makeMaterial(runnerVertexShader, runnerFragmentShader, {
      uTime: this.time,
      uRevealed: this.revealed,
      uGrow: this.grow,
      uSize: { value: opts.homeSize },
      uSizeScale: this.homeScale,
      uPixelRatio: pixelRatio,
      uCore: { value: 0.4 },
    })
    homeMaterial.defines.HOME = 1
    this.materials = [lineMaterial, runnerMaterial, homeMaterial]

    const group = new Group()
    for (const o of [
      new LineSegments(lineGeometry, lineMaterial),
      new Points(pointGeometry, homeMaterial),
      new Points(pointGeometry, runnerMaterial),
    ]) {
      // Placed in the shaders: no bounds to cull by
      o.frustumCulled = false
      group.add(o)
    }
    return group
  }

  /** Advances the runners to `time` seconds. */
  tick(time: number): void {
    this.time.value = time
  }

  /** Shows the first `count` homes by `order` (fractions round down). */
  setRevealed(count: number): void {
    this.revealed.value = count
  }

  /** Grows the arcs out of their homes: 0 none, 1 all the way to the finish, the runners on them. */
  setGrow(grow: number): void {
    this.grow.value = grow
  }

  /** Scales the home dots (1 = `homeSize` as given); the runners keep `runnerSize`. */
  setHomeScale(scale: number): void {
    this.homeScale.value = scale
  }

  protected override updateEffectIdsMask(): void {
    const registry = this.ctx.selectiveEffectRegistry
    if (!registry) return
    const mask = this._effectIds.length > 0 ? registry.computeMask(this._effectIds) : 0
    for (const m of this.materials) m.userData.uEffectIdsMask.value = mask
  }

  override onDestroy(): void {
    const group = this.raw
    super.onDestroy()
    const geometries = new Set<BufferGeometry>()
    group?.traverse((o) => {
      if (o instanceof LineSegments || o instanceof Points) {
        geometries.add(o.geometry)
        o.material.dispose()
      }
    })
    for (const g of geometries) g.dispose()
  }
}
