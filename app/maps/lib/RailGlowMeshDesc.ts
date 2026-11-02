// Glowing rail lines with light pulses racing along them, for Navara.
// Navara's own polylines write no emissive, so they can't feed the selective bloom;
// this draws the lines and the pulses with custom shaders wired into the G-buffer instead.
//
// Each route fires one pulse at a time: it shoots out of the start terminal at full speed,
// brakes all the way into the end terminal, then rests before the next run.
//
// - Lines: GL line segments carrying each vertex's distance along its route. The fragment
//   shader lights a comet tail behind the route's pulse, stretched with its speed.
// - Pulses: one point sprite per route, moved along the route on the CPU in `tick()`.
import {
  Color,
  MeshDescWithSelectiveEffect,
  geodeticToVector3,
  setupMaterialForMRT,
  type MeshConfigWithSelectiveEffect,
  type MeshUpdateWithSelectiveEffect,
} from '@navaramap/three'
import {
  AdditiveBlending,
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  LineSegments,
  Points,
  ShaderMaterial,
  Vector2,
  Vector3,
  type IUniform,
} from 'three'
import lineFragmentShader from './shaders/railLine.frag.glsl?raw'
import lineVertexShader from './shaders/railLine.vert.glsl?raw'
import pointFragmentShader from './shaders/railPulse.frag.glsl?raw'
import pointVertexShader from './shaders/railPulse.vert.glsl?raw'

export type RailRoute = {
  /** [lng, lat] from start to end */
  coords: [number, number][]
}

type RailGlowOptions = {
  routes: RailRoute[]
  /** Line color. Default: electric cyan */
  color?: Color
  /** Pulse color. Default: near white */
  pulseColor?: Color
  /** Height above the ellipsoid (m), so the lines clear the draped land. Default: 4 km */
  height?: number
  /** Run time (s) = `baseDuration` + route length / `cruise`. Default: 0.5 s */
  baseDuration?: number
  /** See `baseDuration` (m/s). Default: 450 km/s */
  cruise?: number
  /** Rest between runs (s), picked per route within [min, max]. Default: [0.6, 1.8] */
  pause?: [number, number]
  /** Tail length = current speed × `tailTime` (s), so it stretches as the pulse speeds up. Default: 0.09 s */
  tailTime?: number
  /** Pulse sprite size (CSS px). Default: 26 */
  pulseSize?: number
  /** Size the pulse shrinks to as it brakes to a stop, relative to `pulseSize`. Default: 0.35 */
  pulseMinScale?: number
}
type Description = { railGlow?: RailGlowOptions }
export type RailGlowConfig = MeshConfigWithSelectiveEffect & Description
type RailGlowUpdate = MeshUpdateWithSelectiveEffect & Description

const DEFAULTS = {
  color: new Color().setStyle('#1ee8ff'),
  pulseColor: new Color().setStyle('#f2fdff'),
  height: 4_000,
  baseDuration: 0.5,
  cruise: 450_000,
  pause: [0.6, 1.8] as [number, number],
  tailTime: 0.09,
  pulseSize: 26,
  pulseMinScale: 0.35,
}

type Route = {
  /** ECEF positions, xyz interleaved */
  positions: Float64Array
  /** Cumulative distance at each vertex (m) */
  dists: Float64Array
  length: number
  /** Run time and rest after it (s) */
  duration: number
  pause: number
  /** Start time offset (s) */
  phase: number
}

// Stable pseudo-random timing per route so pulses don't leave every terminal in lockstep
function rand(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453
  return x - Math.floor(x)
}

// easeOutExpo (rescaled to end exactly at 1) and its derivative: a burst off the line,
// then braking all the way in
const EXPO = 10
const EXPO_SCALE = 1 / (1 - 2 ** -EXPO)
function ease(u: number): number {
  return (1 - 2 ** (-EXPO * u)) * EXPO_SCALE
}
function easeSpeed(u: number): number {
  return EXPO * Math.LN2 * 2 ** (-EXPO * u) * EXPO_SCALE
}

function makeMaterial(vertexShader: string, fragmentShader: string, uniforms: Record<string, IUniform>) {
  const material = new ShaderMaterial({
    vertexShader,
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
  material.uniforms.uEmissiveColor = { value: new Vector3() }
  material.uniforms.uEmissiveIntensity = { value: 1 }
  setupMaterialForMRT(material)
  return material
}

export class RailGlowMeshDesc extends MeshDescWithSelectiveEffect<RailGlowConfig, RailGlowUpdate, Group> {
  private config: RailGlowConfig
  private routes: Route[] = []
  private lineMaterial?: ShaderMaterial
  private pointMaterial?: ShaderMaterial
  private pulses?: Points<BufferGeometry, ShaderMaterial>

  constructor(...args: ConstructorParameters<typeof MeshDescWithSelectiveEffect<RailGlowConfig, RailGlowUpdate>>) {
    super(...args)
    this.config = args[2] ?? {}
  }

  private get options() {
    return { ...DEFAULTS, ...this.config.railGlow }
  }

  override createMesh() {
    const opts = this.options
    const lle = { lng: 0, lat: 0, height: opts.height }
    const [pauseMin, pauseMax] = opts.pause
    this.routes = (opts.routes ?? []).map(({ coords }, i) => {
      const positions = new Float64Array(coords.length * 3)
      const dists = new Float64Array(coords.length)
      let prev: Vector3 | undefined
      coords.forEach(([lng, lat], j) => {
        lle.lng = lng
        lle.lat = lat
        const p = geodeticToVector3(lle)
        positions.set([p.x, p.y, p.z], j * 3)
        dists[j] = prev ? dists[j - 1]! + p.distanceTo(prev) : 0
        prev = p
      })
      const length = dists[dists.length - 1] ?? 0
      const duration = opts.baseDuration + length / opts.cruise
      const pause = pauseMin + rand(i + 0.5) * (pauseMax - pauseMin)
      return { positions, dists, length, duration, pause, phase: rand(i + 1) * (duration + pause) }
    })
    const routeCount = Math.max(this.routes.length, 1)

    // Lines
    const segCount = this.routes.reduce((n, r) => n + r.dists.length - 1, 0)
    const linePos = new Float32Array(segCount * 6)
    const lineDist = new Float32Array(segCount * 2)
    const lineRoute = new Float32Array(segCount * 2)
    let s = 0
    this.routes.forEach((r, i) => {
      for (let j = 0; j < r.dists.length - 1; j++, s++) {
        linePos.set(r.positions.subarray(j * 3, j * 3 + 6), s * 6)
        lineDist.set([r.dists[j]!, r.dists[j + 1]!], s * 2)
        lineRoute.set([i, i], s * 2)
      }
    })
    const lineGeometry = new BufferGeometry()
    lineGeometry.setAttribute('position', new Float32BufferAttribute(linePos, 3))
    lineGeometry.setAttribute('aDist', new Float32BufferAttribute(lineDist, 1))
    lineGeometry.setAttribute('aRoute', new Float32BufferAttribute(lineRoute, 1))

    const shared = {
      uColor: { value: new Vector3(...opts.color.toArray()) },
      uPulseColor: { value: new Vector3(...opts.pulseColor.toArray()) },
    }
    this.lineMaterial = makeMaterial(lineVertexShader, lineFragmentShader, {
      ...shared,
      uPulses: { value: Array.from({ length: routeCount }, () => new Vector2()) },
    })
    this.lineMaterial.defines.ROUTE_COUNT = routeCount
    const lines = new LineSegments(lineGeometry, this.lineMaterial)

    // Pulses
    const pointGeometry = new BufferGeometry()
    pointGeometry.setAttribute('position', new Float32BufferAttribute(new Float32Array(routeCount * 3), 3))
    pointGeometry.setAttribute('aAlpha', new Float32BufferAttribute(new Float32Array(routeCount), 1))
    pointGeometry.setAttribute('aScale', new Float32BufferAttribute(new Float32Array(routeCount).fill(1), 1))
    this.pointMaterial = makeMaterial(pointVertexShader, pointFragmentShader, {
      ...shared,
      uSize: { value: opts.pulseSize },
      uPixelRatio: { value: window.devicePixelRatio },
    })
    this.pulses = new Points(pointGeometry, this.pointMaterial)

    // Positions are ECEF and the pulses move every frame: skip bounds-based culling
    lines.frustumCulled = false
    this.pulses.frustumCulled = false
    const group = new Group()
    group.add(lines, this.pulses)
    this.tick(0)
    return group
  }

  /** Advances the animation to `time` seconds. */
  tick(time: number): void {
    if (!this.lineMaterial || !this.pulses) return
    const { tailTime, pulseMinScale } = this.options
    const pulses = this.lineMaterial.uniforms.uPulses!.value as Vector2[]
    const position = this.pulses.geometry.getAttribute('position') as Float32BufferAttribute
    const alpha = this.pulses.geometry.getAttribute('aAlpha') as Float32BufferAttribute
    const scale = this.pulses.geometry.getAttribute('aScale') as Float32BufferAttribute

    this.routes.forEach((r, i) => {
      // Progress through the current run, 0-1; past 1 the route is resting
      const cycle = r.duration + r.pause
      const local = (time - r.phase) % cycle // negative before the first run
      const u = (local < 0 ? local + cycle : local) / r.duration
      if (u > 1) {
        pulses[i]!.set(0, 0)
        alpha.setX(i, 0)
        return
      }
      const d = r.length * ease(u)
      const speed = (r.length * easeSpeed(u)) / r.duration
      pulses[i]!.set(d, speed * tailTime)
      // Shrink with the speed (relative to the launch speed); the square root keeps the
      // pulse big for a while after the launch instead of collapsing right away
      scale.setX(i, pulseMinScale + (1 - pulseMinScale) * Math.sqrt(easeSpeed(u) / easeSpeed(0)))

      let j = 1
      while (j < r.dists.length - 1 && r.dists[j]! < d) j++
      const d0 = r.dists[j - 1]!
      const t = (d - d0) / Math.max(r.dists[j]! - d0, 1e-6)
      const a = (j - 1) * 3
      const b = j * 3
      const p = r.positions
      position.setXYZ(
        i,
        p[a]! + (p[b]! - p[a]!) * t,
        p[a + 1]! + (p[b + 1]! - p[a + 1]!) * t,
        p[a + 2]! + (p[b + 2]! - p[a + 2]!) * t,
      )
      // Snap in (the launch should feel instant); fade out over the last 30%, where the
      // pulse has all but stopped at the terminal
      alpha.setX(i, Math.min(1, u / 0.015, (1 - u) / 0.3))
    })
    position.needsUpdate = true
    alpha.needsUpdate = true
    scale.needsUpdate = true
  }

  protected override updateEffectIdsMask(): void {
    const registry = this.ctx.selectiveEffectRegistry
    if (!registry) return
    const mask = this._effectIds.length > 0 ? registry.computeMask(this._effectIds) : 0
    for (const m of [this.lineMaterial, this.pointMaterial]) {
      if (m) m.userData.uEffectIdsMask.value = mask
    }
  }

  override onDestroy(): void {
    const group = this.raw
    super.onDestroy()
    group?.traverse((o) => {
      if (o instanceof LineSegments || o instanceof Points) {
        o.geometry.dispose()
        o.material.dispose()
      }
    })
  }
}
