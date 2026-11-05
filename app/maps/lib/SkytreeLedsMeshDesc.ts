// Tokyo Skytree's lighting as LEDs, for Navara: points scattered over the tower's surface
// (scripts/day05/extract_skytree.py) that twinkle, with a band of white light sweeping from
// the foot to the top, and a wipe that repaints them in the next lighting's color from the
// top down. Wired into the G-buffer like RailGlowMeshDesc, so they feed the selective bloom.
//
// The points are in the tower's West-Up-North frame: place the mesh with `geodetic` at the
// frame's origin (the foot of the axis).
import {
  Color,
  MeshDescWithSelectiveEffect,
  setupMaterialForMRT,
  type MeshConfigWithSelectiveEffect,
  type MeshUpdateWithSelectiveEffect,
} from '@navaramap/three'
import { AdditiveBlending, BufferGeometry, Float32BufferAttribute, Points, ShaderMaterial, Vector3 } from 'three'
import fragmentShader from './shaders/skytreeLed.frag.glsl?raw'
import vertexShader from './shaders/skytreeLed.vert.glsl?raw'

type SkytreeLedsOptions = {
  /** LED positions, xyz interleaved, in metres (West-Up-North) */
  points: Float32Array
  /** Lighting color. Default: Iki's pale blue */
  color?: Color
  /** Color where the sweep passes. Default: near white */
  sparkColor?: Color
  /** LED size (m), clamped to `minPx`-`maxPx` on screen. Default: 1.1 m, 1.5-6 px */
  size?: number
  minPx?: number
  maxPx?: number
  /** Half height (m) of the sweeping band. Default: 18 m */
  sweepWidth?: number
}
type Description = { skytreeLeds?: SkytreeLedsOptions }
export type SkytreeLedsConfig = MeshConfigWithSelectiveEffect & Description
type SkytreeLedsUpdate = MeshUpdateWithSelectiveEffect & Description

// A wipe this high leaves every LED in the current color
const NO_WIPE = 1e5

const DEFAULTS = {
  color: new Color().setStyle('#8fd8ff'),
  sparkColor: new Color().setStyle('#f4fbff'),
  size: 1.1,
  minPx: 1.5,
  maxPx: 6,
  sweepWidth: 18,
}

export class SkytreeLedsMeshDesc extends MeshDescWithSelectiveEffect<SkytreeLedsConfig, SkytreeLedsUpdate, Points> {
  private config: SkytreeLedsConfig
  private material?: ShaderMaterial

  constructor(...args: ConstructorParameters<typeof MeshDescWithSelectiveEffect<SkytreeLedsConfig, SkytreeLedsUpdate>>) {
    super(...args)
    this.config = args[2] ?? {}
  }

  private get options() {
    return { ...DEFAULTS, ...this.config.skytreeLeds }
  }

  override createMesh() {
    const opts = this.options
    const points = opts.points ?? new Float32Array()
    const seeds = new Float32Array(points.length / 3)
    for (let i = 0; i < seeds.length; i++) seeds[i] = Math.random()
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new Float32BufferAttribute(points, 3))
    geometry.setAttribute('aSeed', new Float32BufferAttribute(seeds, 1))

    const material = new ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        uTime: { value: 0 },
        uSweep: { value: -1 },
        uSweepWidth: { value: opts.sweepWidth },
        uWipe: { value: NO_WIPE },
        uColor: { value: new Vector3(...opts.color.toArray()) },
        uNextColor: { value: new Vector3(...opts.color.toArray()) },
        uSparkColor: { value: new Vector3(...opts.sparkColor.toArray()) },
        uSize: { value: opts.size },
        uMinPx: { value: opts.minPx },
        uMaxPx: { value: opts.maxPx },
        uPixelRatio: { value: window.devicePixelRatio },
        uHalfHeight: { value: window.innerHeight / 2 },
      },
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
    this.material = material

    const mesh = new Points(geometry, material)
    mesh.frustumCulled = false
    return mesh
  }

  /**
   * Advances the twinkle to `time` (s), puts the sweep's band at `sweep` and the wipe's edge at
   * `wipe` (m above the foot). A negative sweep hides it; an omitted wipe leaves the LEDs in the
   * current color.
   */
  tick(time: number, sweep: number, wipe = NO_WIPE): void {
    const u = this.material?.uniforms
    if (!u) return
    u.uTime!.value = time
    u.uSweep!.value = sweep
    u.uWipe!.value = wipe
    u.uHalfHeight!.value = window.innerHeight / 2
  }

  /** Sets the lighting color and the one the wipe paints in. */
  setColors(color: Color, next: Color): void {
    const u = this.material?.uniforms
    ;(u?.uColor!.value as Vector3 | undefined)?.set(...color.toArray())
    ;(u?.uNextColor!.value as Vector3 | undefined)?.set(...next.toArray())
  }

  protected override updateEffectIdsMask(): void {
    const registry = this.ctx.selectiveEffectRegistry
    if (!registry || !this.material) return
    this.material.userData.uEffectIdsMask.value = this._effectIds.length > 0 ? registry.computeMask(this._effectIds) : 0
  }

  override onDestroy(): void {
    const mesh = this.raw
    super.onDestroy()
    mesh?.geometry.dispose()
    this.material?.dispose()
  }
}
