// Guessed bike rides between stations as low glowing arcs, for Navara (Day 24).
// Every flow (from, to, hour of leaving, expected bikes) is one instance of a single ribbon: the
// instance carries its ends and weight, the shader lifts it on a sine, widens it on screen
// (thin where the bikes left, wide where they arrived) and lights it through its hour, fading
// over the next few. Tens of thousands of faint flows (the gravity model's) add up to a haze.
// A bead runs along each lit flow the way the bikes went, as Day 2's pulses, a comet tail
// lighting the ribbon behind it. Given the stations' columns (StationColumnsMeshDesc), each arc runs from the top of one to the
// top of the other at the clock's time, poured in rather than run through them.
import {
  MeshDescWithSelectiveEffect,
  setupMaterialForMRT,
  type MeshConfigWithSelectiveEffect,
  type MeshUpdateWithSelectiveEffect,
} from '@navaramap/three'
import {
  AdditiveBlending,
  Color,
  DataTexture,
  LinearFilter,
  RedFormat,
  UnsignedByteType,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  LinearSRGBColorSpace,
  Mesh,
  Points,
  ShaderMaterial,
  Vector2,
  Vector3,
} from 'three'
import beadFragmentShader from './shaders/flowBead.frag.glsl?raw'
import beadVertexShader from './shaders/flowBead.vert.glsl?raw'
import fragmentShader from './shaders/flowArc.frag.glsl?raw'
import vertexShader from './shaders/flowArc.vert.glsl?raw'
import flowCommon from './shaders/flowCommon.glsl?raw'

// (three resolves only its own chunks: put the shared one in by hand)
const withCommon = (shader: string) => shader.replace('#include <flowCommon>', flowCommon)

export type Flows = {
  /** Instance count */
  count: number
  /** Per flow: from station, to station (indices into the stations) */
  from: Uint16Array
  to: Uint16Array
  /** Per flow: hour of leaving (JST, 0-23) and expected bikes */
  hour: Float32Array
  bikes: Float32Array
}

type FlowArcsOptions = {
  /** ECEF (m) the positions are measured from */
  anchor: { x: number; y: number; z: number }
  /** Station positions relative to `anchor` (m), xyz per station */
  stations: Float32Array
  flows: Flows
  /** Colors (CSS) at the leaving and the arriving end: near whites, so the columns' orange and
   *  blue (filling, emptying) stay theirs */
  fromColor?: string
  toColor?: string
  /** Brightness per expected bike. Default: 0.45 */
  gain?: number
  /** Width (CSS px) per √bike at the arriving end. Default: 2.5 */
  width?: number
  /** Hours to fade to 1/e after the hour of leaving. Default: 1.5 */
  fade?: number
  /** Bead size (CSS px) for a flow of one bike. Default: 13 */
  beadSize?: number
  /** The columns' bikes in docks (as StationColumnsMeshDesc's `docked`) and height per bike (m) */
  docked?: Uint8Array
  metersPerBike?: number
}
type Description = { flowArcs?: FlowArcsOptions }
export type FlowArcsConfig = MeshConfigWithSelectiveEffect & Description
type FlowArcsUpdate = MeshUpdateWithSelectiveEffect & Description

// Must match SEGMENTS in flowArc.vert.glsl
const SEGMENTS = 16
const css = (c: string) => new Color().setStyle(c, LinearSRGBColorSpace)

export class FlowArcsMeshDesc extends MeshDescWithSelectiveEffect<FlowArcsConfig, FlowArcsUpdate, Group> {
  private config: FlowArcsConfig
  private clock = { value: 0 }
  private time = { value: 0 }
  private resolution = { value: new Vector2(1, 1) }
  private pixelRatio = { value: 1 }
  private materials: ShaderMaterial[] = []
  private texture?: DataTexture

  constructor(...args: ConstructorParameters<typeof MeshDescWithSelectiveEffect<FlowArcsConfig, FlowArcsUpdate>>) {
    super(...args)
    this.config = args[2] ?? {}
  }

  override createMesh() {
    const opts = { fromColor: '#a9b8d6', toColor: '#fbf6ec', gain: 0.45, width: 2.5, fade: 1.5, beadSize: 13, ...this.config.flowArcs! }
    const { anchor, stations, flows } = opts

    // One ribbon: two triangles per segment, each vertex knowing how far along it is and which side
    const t: number[] = []
    const side: number[] = []
    for (let s = 0; s < SEGMENTS; s++) {
      const [t0, t1] = [s / SEGMENTS, (s + 1) / SEGMENTS]
      for (const [tt, ss] of [[t0, -1], [t0, 1], [t1, -1], [t1, -1], [t0, 1], [t1, 1]] as const) {
        t.push(tt)
        side.push(ss)
      }
    }
    const geometry = new InstancedBufferGeometry()
    geometry.setAttribute('aT', new Float32BufferAttribute(t, 1))
    geometry.setAttribute('aSide', new Float32BufferAttribute(side, 1))
    // (three wants a position to count the vertices by; the shader places them itself)
    geometry.setAttribute('position', new Float32BufferAttribute(new Float32Array(t.length * 3), 3))
    const n = flows.count
    const aFrom = new Float32Array(n * 3)
    const aTo = new Float32Array(n * 3)
    const aFlow = new Float32Array(n * 2)
    // Each end's row in the docked texture (v)
    const nStations = stations.length / 3
    const aRows = new Float32Array(n * 2)
    // Each bead's timing, stable per flow (pseudo-random, so they don't run in lockstep)
    const aSeed = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const x = Math.sin((i + 1) * 12.9898) * 43758.5453
      aSeed[i] = x - Math.floor(x)
      aRows[i * 2] = (flows.from[i]! + 0.5) / nStations
      aRows[i * 2 + 1] = (flows.to[i]! + 0.5) / nStations
      const a = flows.from[i]! * 3
      const b = flows.to[i]! * 3
      aFrom.set(stations.subarray(a, a + 3), i * 3)
      aTo.set(stations.subarray(b, b + 3), i * 3)
      aFlow[i * 2] = flows.hour[i]!
      aFlow[i * 2 + 1] = flows.bikes[i]!
    }
    const perFlow = {
      aFrom: new InstancedBufferAttribute(aFrom, 3),
      aTo: new InstancedBufferAttribute(aTo, 3),
      aFlow: new InstancedBufferAttribute(aFlow, 2),
      aRows: new InstancedBufferAttribute(aRows, 2),
      aSeed: new InstancedBufferAttribute(aSeed, 1),
    }
    for (const [name, attr] of Object.entries(perFlow)) geometry.setAttribute(name, attr)
    // No columns: a one-texel texture and no height
    const docked = opts.docked ?? new Uint8Array(1)
    const texture = new DataTexture(docked, opts.docked ? 288 : 1, opts.docked ? nStations : 1, RedFormat, UnsignedByteType)
    texture.magFilter = LinearFilter
    texture.minFilter = LinearFilter
    texture.needsUpdate = true
    this.texture = texture
    geometry.instanceCount = n

    const uniforms = {
      uClock: this.clock,
      uTime: this.time,
      uResolution: this.resolution,
      uPixelRatio: this.pixelRatio,
      uUp: { value: new Vector3(anchor.x, anchor.y, anchor.z).normalize() },
      uGain: { value: opts.gain },
      uWidth: { value: opts.width },
      uFade: { value: opts.fade },
      uSize: { value: opts.beadSize },
      uDocked: { value: texture },
      uMeters: { value: opts.docked ? (opts.metersPerBike ?? 8) : 0 },
      uFromColor: { value: css(opts.fromColor) },
      uToColor: { value: css(opts.toColor) },
    }
    const makeMaterial = (vs: string, fs: string) => {
      const material = new ShaderMaterial({
        vertexShader: withCommon(vs),
        fragmentShader: fs,
        uniforms,
        transparent: true,
        depthWrite: false,
        side: DoubleSide,
        blending: AdditiveBlending,
      })
      // Selective bloom: the shader's color is written to the emissive buffer as is
      material.defines.USE_SELECTIVE_EFFECT = 1
      material.userData.uEffectIdsMask = { value: 0 }
      material.uniforms.uEffectIdsMask = material.userData.uEffectIdsMask
      material.uniforms.uEmissiveColor = { value: new Vector3() }
      material.uniforms.uEmissiveIntensity = { value: 1 }
      setupMaterialForMRT(material)
      this.materials.push(material)
      return material
    }

    // The beads: one point per flow, sharing the ribbons' per-flow attributes
    const beads = new InstancedBufferGeometry()
    beads.setAttribute('position', new Float32BufferAttribute([0, 0, 0], 3))
    for (const [name, attr] of Object.entries(perFlow)) beads.setAttribute(name, attr)
    beads.instanceCount = n

    const group = new Group()
    group.position.set(anchor.x, anchor.y, anchor.z)
    for (const o of [
      new Mesh(geometry, makeMaterial(vertexShader, fragmentShader)),
      new Points(beads, makeMaterial(beadVertexShader, beadFragmentShader)),
    ]) {
      // Placed in the shaders: no bounds to cull by
      o.frustumCulled = false
      group.add(o)
    }
    return group
  }

  /**
   * Sets the clock to `hours` (JST, 0-24) and the beads to `time` (s), for a drawing buffer
   * `width` × `height` px.
   */
  tick(hours: number, time: number, width: number, height: number, pixelRatio: number): void {
    this.clock.value = hours
    this.time.value = time
    this.resolution.value.set(width, height)
    this.pixelRatio.value = pixelRatio
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
    group?.traverse((o) => {
      if (o instanceof Mesh || o instanceof Points) o.geometry.dispose()
    })
    for (const m of this.materials) m.dispose()
    this.texture?.dispose()
  }
}
