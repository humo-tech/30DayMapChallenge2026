// Day 12's looks at the world's ocean waves (waveSim.ts) on Navara: a mesh descriptor that runs
// one on Navara's renderer over what the camera sees, and shows it on a shell over the sea, a
// lng/lat grid over the ellipsoid. Wired into the G-buffer like ThunderMeshDesc, so it feeds the
// selective bloom.
import {
  MeshDescWithSelectiveEffect,
  geodeticToVector3,
  getWGS84SemiMajorAxis,
  setupMaterialForMRT,
  vector3ToGeodetic,
  type MeshConfigWithSelectiveEffect,
  type MeshUpdateWithSelectiveEffect,
} from '@navaramap/three'
import {
  AdditiveBlending,
  BufferGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Mesh,
  Ray,
  ShaderMaterial,
  Sphere,
  Vector3,
  type IUniform,
  type PerspectiveCamera,
  type WebGLRenderer,
} from 'three'
import { VIEW_SAMPLES, type LngLatRad, type WaveSim } from './waveSim'

// The shell sits this high (m), over the ellipsoid's own tessellation
export const LIFT = 3_000
const WGS84_E2 = 6.69437999014e-3

// The shell over the sea
const shellVertex = /* glsl */ `
  varying vec2 vGeo;
  void main() {
    vGeo = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

/** A look, run over what the camera sees and shown on a shell over the ellipsoid. */
export abstract class WaveDomainMeshDesc<Config extends MeshConfigWithSelectiveEffect, Sim extends WaveSim> extends MeshDescWithSelectiveEffect<
  Config,
  MeshUpdateWithSelectiveEffect,
  Mesh
> {
  protected config: Config
  private mask: IUniform<number> = { value: 0 }
  private shell?: Mesh<BufferGeometry, ShaderMaterial>
  protected sim?: Sim

  constructor(...args: ConstructorParameters<typeof MeshDescWithSelectiveEffect<Config, MeshUpdateWithSelectiveEffect>>) {
    super(...args)
    this.config = args[2] ?? ({} as Config)
  }

  /** The look, from the config */
  protected abstract createSim(): Sim

  override createMesh(): Mesh {
    const sim = (this.sim = this.createSim())
    const material = new ShaderMaterial({
      vertexShader: shellVertex,
      fragmentShader: sim.shellFragment,
      uniforms: sim.shellUniforms,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      blending: AdditiveBlending,
      toneMapped: false,
    })
    material.defines.USE_SELECTIVE_EFFECT = 1
    material.userData.uEffectIdsMask = this.mask
    material.uniforms.uEffectIdsMask = this.mask
    material.uniforms.uEmissiveColor = { value: new Vector3() }
    material.uniforms.uEmissiveIntensity = { value: 1 }
    setupMaterialForMRT(material)
    this.shell = new Mesh(ellipsoidGrid(720, 360, LIFT), material)
    this.shell.frustumCulled = false
    return this.shell
  }

  /** The crests' speed, as a share of the square a second for a 10 s swell (tunable) */
  get speed(): number {
    return this.sim?.speed ?? 0
  }
  set speed(x: number) {
    if (this.sim) this.sim.speed = x
  }

  /** Next time, starts afresh (e.g. after being hidden a while). */
  reset(): void {
    this.sim?.reset()
  }

  /** Runs on by `dt` s over what `camera` sees, on the GPU. */
  step(dt: number, camera: PerspectiveCamera): void {
    if (!this.shell || !this.sim) return
    const renderer = this.ctx.getRenderer() as WebGLRenderer
    const u = this.shell.material.uniforms
    for (const [k, v] of Object.entries(this.sim.step(renderer, dt, viewPoints(camera)))) u[k]!.value = v
  }

  protected override updateEffectIdsMask(): void {
    const registry = this.ctx.selectiveEffectRegistry
    if (!registry) return
    this.mask.value = this._effectIds.length > 0 ? registry.computeMask(this._effectIds) : 0
  }

  override onDestroy(): void {
    const shell = this.shell
    super.onDestroy()
    shell?.geometry.dispose()
    shell?.material.dispose()
    this.sim?.dispose()
  }
}

// What the camera sees, sampled on a grid over the screen: where each ray meets the globe, or
// for those that miss it, the horizon that way (the globe's point nearest the ray)
// (its radius set on first use: Navara's WASM isn't up when this module loads)
const sphere = new Sphere(new Vector3(), 0)
const ray = new Ray()
const hit = new Vector3()
function viewPoints(camera: PerspectiveCamera): LngLatRad[] {
  const points = []
  sphere.radius ||= getWGS84SemiMajorAxis()
  camera.updateMatrixWorld()
  const origin = new Vector3().setFromMatrixPosition(camera.matrixWorld)
  for (let j = 0; j < VIEW_SAMPLES; j++) {
    for (let i = 0; i < VIEW_SAMPLES; i++) {
      const ndc = new Vector3((i / (VIEW_SAMPLES - 1)) * 2 - 1, (j / (VIEW_SAMPLES - 1)) * 2 - 1, 0.5).unproject(camera)
      ray.set(origin, ndc.sub(origin).normalize())
      if (!ray.intersectSphere(sphere, hit)) {
        ray.closestPointToPoint(sphere.center, hit)
        hit.setLength(sphere.radius)
      }
      const { lng, lat } = vector3ToGeodetic(hit)
      points.push({ lng: (lng * Math.PI) / 180, lat: (lat * Math.PI) / 180 })
    }
  }
  return points
}

/**
 * A lng/lat grid over the WGS84 ellipsoid, `height` m up, with uv = (lng, lat) from 180°W, 90°S.
 * Navara's ECEF axes are read off geodeticToVector3, so the grid lines up whichever way they run.
 */
export function ellipsoidGrid(columns: number, rows: number, height: number): BufferGeometry {
  const axis = (lng: number, lat: number) => geodeticToVector3({ lng, lat, height: 0 }).normalize()
  const [ex, ey, ez] = [axis(0, 0), axis(90, 0), axis(0, 90)]
  const a = getWGS84SemiMajorAxis()
  const position = new Float32Array((columns + 1) * (rows + 1) * 3)
  const uv = new Float32Array((columns + 1) * (rows + 1) * 2)
  const p = new Vector3()
  for (let j = 0; j <= rows; j++) {
    const lat = ((j / rows) * 180 - 90) * (Math.PI / 180)
    const n = a / Math.sqrt(1 - WGS84_E2 * Math.sin(lat) ** 2)
    for (let i = 0; i <= columns; i++) {
      const lng = ((i / columns) * 360 - 180) * (Math.PI / 180)
      const k = j * (columns + 1) + i
      p.copy(ex)
        .multiplyScalar((n + height) * Math.cos(lat) * Math.cos(lng))
        .addScaledVector(ey, (n + height) * Math.cos(lat) * Math.sin(lng))
        .addScaledVector(ez, (n * (1 - WGS84_E2) + height) * Math.sin(lat))
      position.set([p.x, p.y, p.z], k * 3)
      uv.set([i / columns, j / rows], k * 2)
    }
  }
  const index: number[] = []
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < columns; i++) {
      const k = j * (columns + 1) + i
      index.push(k, k + 1, k + columns + 1, k + 1, k + columns + 2, k + columns + 1)
    }
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(position, 3))
  geometry.setAttribute('uv', new Float32BufferAttribute(uv, 2))
  geometry.setIndex(index)
  return geometry
}
