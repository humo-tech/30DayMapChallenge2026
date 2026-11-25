// A typhoon over the sea, for Navara (Day 26): the clouds as Himawari saw them, raymarched as a
// volume up to the height of their tops (sunlit, shading themselves), their detail drifting with
// ECMWF's winds: the low clouds spiralling in, the cirrus over the tops fanning out. Their
// shadows fall on the sea (the waves under them are Day 12's fluid, a mesh of its own); a line
// marks where there's Himawari; the storm's track is drawn on the sea behind it, faint ahead.
//
// Everything follows the hour given to `tick`; the shaders read the textures (typhoon.ts) at
// that hour and work out the rest (typhoonShaders.ts). The clouds are raymarched off screen at
// a fraction of the resolution, in `tick`, and laid over the scene by a full-screen quad. Wired
// into the G-buffer like ThunderMeshDesc. Nothing of it glows (the bloom would show through the
// clouds).
import {
  MeshDescWithSelectiveEffect,
  geodeticToVector3,
  getWGS84SemiMajorAxis,
  setupMaterialForMRT,
  type MeshConfigWithSelectiveEffect,
  type MeshUpdateWithSelectiveEffect,
} from '@navaramap/three'
import {
  BufferGeometry,
  Camera,
  CustomBlending,
  Data3DTexture,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  HalfFloatType,
  LinearFilter,
  Matrix3,
  Matrix4,
  Mesh,
  NormalBlending,
  OneFactor,
  OneMinusSrcAlphaFactor,
  PlaneGeometry,
  RedFormat,
  RepeatWrapping,
  Scene,
  ShaderMaterial,
  Uint32BufferAttribute,
  UnsignedByteType,
  Vector2,
  Vector3,
  Vector4,
  WebGLRenderTarget,
  type Blending,
  type IUniform,
  type PerspectiveCamera,
  type WebGLRenderer,
} from 'three'
import { stormAt, type Champi, type Storm, type Winds } from './typhoon'
import { ellipsoid, trackRibbon } from './typhoonTrack'
import * as glsl from './typhoonShaders'

type TyphoonOptions = {
  champi: Champi
  winds: Winds
  /** How much taller than life the clouds are drawn. Default: 12 */
  exaggeration?: number
}
type Description = { typhoon?: TyphoonOptions }
export type TyphoonConfig = MeshConfigWithSelectiveEffect & Description
type TyphoonUpdate = MeshUpdateWithSelectiveEffect & Description

// The clouds' shadows reach this far (°) past the scenes' box
const SHADOW_MARGIN = 4
// The outline of the scenes' box: this wide (m)
const OUTLINE_WIDTH = 7_000
// ...and stands this high (m): over the land's relief, drawn taller than life, along its edges
const OUTLINE_LIFT = 45_000
// The shadows, the outline and the track sit this high (m) over the ellipsoid's own tessellation
const SEA_LIFT = 4_000
const TRACK_LIFT = 6_000
// The light: from the south-west, low, to bring out the cloud tops' relief
const SUN_AZIMUTH = 235
const SUN_ELEVATION = 30

/** Tunable as it runs (?gui=1). */
export type TyphoonParams = {
  /** The clouds shown, with their shadows on the sea; off, the sea alone */
  clouds: boolean
  exaggeration: number
  /** The clouds' extinction at full density (1/m) */
  density: number
  /** Raymarching steps, and the share of the screen's resolution it's done at */
  steps: number
  resolution: number
  /** How fast the clouds' detail drifts with the wind: seconds of wind a second */
  drift: number
}

export class TyphoonMeshDesc extends MeshDescWithSelectiveEffect<TyphoonConfig, TyphoonUpdate, Group> {
  private config: TyphoonConfig
  private mask: IUniform<number> = { value: 0 }
  private materials = new Set<ShaderMaterial>()
  private geometries = new Set<BufferGeometry>()
  private u: Record<string, IUniform> = {}
  private trackHour: IUniform<number> = { value: 0 }
  private root?: Group
  private parts?: {
    sea: Mesh<BufferGeometry, ShaderMaterial>
    composite: Mesh<BufferGeometry, ShaderMaterial>
  }
  // The clouds, off screen
  private volume?: { scene: Scene; camera: Camera; material: ShaderMaterial; target: WebGLRenderTarget; noise: Data3DTexture }
  readonly params: TyphoonParams = {
    clouds: true,
    exaggeration: 12,
    density: 4.5e-5,
    steps: 90,
    resolution: 0.75,
    drift: 1000,
  }
  /** The storm at the last tick */
  storm?: Storm
  private lastTime?: number

  constructor(...args: ConstructorParameters<typeof MeshDescWithSelectiveEffect<TyphoonConfig, TyphoonUpdate>>) {
    super(...args)
    this.config = args[2] ?? {}
    if (this.config.typhoon?.exaggeration) this.params.exaggeration = this.config.typhoon.exaggeration
  }

  private material(vertex: string, fragment: string, extra: Record<string, IUniform>, opts: { glow?: boolean; blending?: Blending; mrt?: boolean } = {}) {
    const material = new ShaderMaterial({
      vertexShader: glsl.common + vertex,
      fragmentShader: glsl.common + fragment,
      uniforms: { ...this.u, ...extra },
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      blending: opts.blending ?? NormalBlending,
    })
    if (opts.glow) {
      // Selective bloom: the shader's color is written to the emissive buffer as is
      material.defines.USE_SELECTIVE_EFFECT = 1
      material.userData.uEffectIdsMask = this.mask
      material.uniforms.uEffectIdsMask = this.mask
      material.uniforms.uEmissiveColor = { value: new Vector3() }
      material.uniforms.uEmissiveIntensity = { value: 1 }
    }
    if (opts.mrt !== false) setupMaterialForMRT(material)
    this.materials.add(material)
    return material
  }

  private geometry<G extends BufferGeometry>(g: G) {
    this.geometries.add(g)
    return g
  }

  override createMesh() {
    const { champi, winds } = this.config.typhoon!
    const { meta } = champi
    const c = meta.clouds
    const w = winds.meta
    const axis = (lng: number, lat: number) => geodeticToVector3({ lng, lat, height: 0 }).normalize()
    this.u = {
      uClouds: { value: champi.clouds },
      uSmooth: { value: champi.smooth },
      uWinds: { value: winds.texture },
      uCloudBox: { value: new Vector4(c.west, c.south, c.width * c.step, c.height * c.step) },
      // (the winds' texels are at their grid points: the box reaches half a step past them)
      uWindBox: { value: new Vector4(w.lng0 - w.step / 2, w.lat0 - (w.height - 0.5) * w.step, w.width * w.step, w.height * w.step) },
      uCloudW: { value: 0 },
      uWindW: { value: 0 },
      uWindScale: { value: w.scale },
      uDrift: { value: 0 },
      uTb: { value: new Vector2(c.tbMin, c.tbStep * 255) },
      uExag: { value: this.params.exaggeration },
      uAxX: { value: axis(0, 0) },
      uAxY: { value: axis(90, 0) },
      uAxZ: { value: axis(0, 90) },
      uR0: { value: getWGS84SemiMajorAxis() },
      uSun: { value: sunDirection() },
      uSunW: { value: new Vector3() },
      uPole: { value: axis(0, 90) },
      uCam: { value: new Vector3() },
      uSigma: { value: this.params.density },
    }
    const root = (this.root = new Group())
    const west = c.west - SHADOW_MARGIN
    const south = c.south - SHADOW_MARGIN
    const east = c.west + c.width * c.step + SHADOW_MARGIN
    const north = c.south + c.height * c.step + SHADOW_MARGIN

    // The clouds' shadows on the sea: a 0.25° grid
    const sea = new Mesh(
      this.geometry(boxGrid(west, south, east, north, Math.round((east - west) * 4), Math.round((north - south) * 4), SEA_LIFT)),
      this.material(glsl.seaVertex, glsl.seaFragment, { uBox: { value: new Vector4(west, south, east, north) } }),
    )
    sea.renderOrder = 1

    // The track: a ribbon along the storm's path, hour by hour
    const track = new Mesh(this.geometry(trackRibbon(champi.meta.track, 9_000, TRACK_LIFT)), this.material(glsl.trackVertex, glsl.trackFragment, { uHour: this.trackHour }))
    track.renderOrder = 2

    // Where there's Himawari: a thin line round the scenes' box, on the sea (under the clouds)
    const outline = new Mesh(
      this.geometry(boxOutline(c.west, c.south, c.west + c.width * c.step, c.south + c.height * c.step, OUTLINE_WIDTH)),
      this.material(glsl.outlineVertex, glsl.outlineFragment, {}),
    )
    outline.renderOrder = 2

    // The clouds: raymarched off screen, laid over the scene (premultiplied)
    const noise = cellNoise(64)
    const volumeMaterial = this.material(
      glsl.volumeVertex,
      glsl.volumeFragment,
      {
        uInvProj: { value: new Matrix4() },
        uCamRot: { value: new Matrix3() },
        uNoise: { value: noise },
        uSteps: { value: this.params.steps },
      },
      { mrt: false },
    )
    volumeMaterial.transparent = false
    const volumeScene = new Scene()
    const quad = new Mesh(this.geometry(new PlaneGeometry(2, 2)), volumeMaterial)
    quad.frustumCulled = false
    volumeScene.add(quad)
    const target = new WebGLRenderTarget(2, 2, { type: HalfFloatType, minFilter: LinearFilter, magFilter: LinearFilter, depthBuffer: false })
    this.volume = { scene: volumeScene, camera: new Camera(), material: volumeMaterial, target, noise }

    const compositeMaterial = this.material(glsl.compositeVertex, glsl.compositeFragment, {
      uVolume: { value: target.texture },
      uViewport: { value: new Vector2(1, 1) },
    })
    compositeMaterial.depthTest = false
    compositeMaterial.blending = CustomBlending
    compositeMaterial.blendSrc = OneFactor
    compositeMaterial.blendDst = OneMinusSrcAlphaFactor
    const composite = new Mesh(this.geometry(new PlaneGeometry(2, 2)), compositeMaterial)
    composite.renderOrder = 3

    for (const m of [sea, outline, track, composite]) {
      m.frustumCulled = false
      root.add(m)
    }
    this.parts = { sea, composite }
    return root
  }

  /**
   * Shows the storm at `hour` (since the clouds' start), the clouds' detail drifting on `time`
   * (s, real time: it goes on while the hour holds still), and raymarches the clouds for the
   * camera as it is now.
   */
  tick(hour: number, time: number): void {
    const champi = this.config.typhoon?.champi
    const winds = this.config.typhoon?.winds
    if (!champi || !winds || !this.parts || !this.volume || !this.root) return
    const { meta } = champi
    const c = meta.clouds
    const u = this.u
    const p = this.params

    const h = Math.min(Math.max(hour, 0), (c.frames - 1) * c.every)
    u.uCloudW!.value = (h / c.every + 0.5) / c.frames
    const wm = winds.meta
    u.uWindW!.value = (Math.min(Math.max((hour - winds.offset) / wm.every, 0), wm.frames - 1) + 0.5) / wm.frames
    if (this.lastTime !== undefined) (u.uDrift!.value as number) += Math.min(time - this.lastTime, 0.1) * p.drift
    this.lastTime = time
    u.uExag!.value = p.exaggeration
    // (no clouds, none in the way either: the track shows in full)
    u.uSigma!.value = p.clouds ? p.density : 0
    for (const part of [this.parts.sea, this.parts.composite]) part.visible = p.clouds
    this.trackHour.value = hour

    const storm = (this.storm = stormAt(meta.track, hour))
    const centre = geodeticToVector3({ lng: storm.lon, lat: storm.lat, height: 0 })
    const up = geodeticToVector3({ lng: storm.lon, lat: storm.lat, height: 1 }).sub(centre).normalize()
    const pole = u.uPole!.value as Vector3
    const east = new Vector3().crossVectors(pole, up).normalize()
    const north = new Vector3().crossVectors(up, east)
    // Heights over a sphere of the earth's radius here, the light in the storm's own east, north, up
    u.uR0!.value = centre.length()
    const sun = u.uSun!.value as Vector3
    ;(u.uSunW!.value as Vector3).copy(east).multiplyScalar(sun.x).addScaledVector(north, sun.y).addScaledVector(up, sun.z).normalize()


    // The camera, in the meshes' own frame (ECEF, whatever origin shift the engine applies)
    const renderer = this.ctx.getRenderer() as WebGLRenderer
    const camera = this.view.camera.raw as PerspectiveCamera
    camera.updateMatrixWorld()
    this.root.updateWorldMatrix(true, false)
    const toLocal = new Matrix4().copy(this.root.matrixWorld).invert()
    const camLocal = new Matrix4().multiplyMatrices(toLocal, camera.matrixWorld)
    ;(u.uCam!.value as Vector3).setFromMatrixPosition(camLocal)

    const size = renderer.getDrawingBufferSize(new Vector2())
    this.parts.composite.material.uniforms.uViewport!.value.copy(size)

    // The clouds, raymarched at a fraction of the resolution (not at all when they're off)
    if (!p.clouds) return
    const { volume } = this
    const w = Math.max(2, Math.round(size.x * p.resolution))
    const hgt = Math.max(2, Math.round(size.y * p.resolution))
    if (volume.target.width !== w || volume.target.height !== hgt) volume.target.setSize(w, hgt)
    const vu = volume.material.uniforms
    ;(vu.uInvProj!.value as Matrix4).copy(camera.projectionMatrix).invert()
    ;(vu.uCamRot!.value as Matrix3).setFromMatrix4(camLocal)
    vu.uSteps!.value = p.steps
    const previous = renderer.getRenderTarget()
    const autoClear = renderer.autoClear
    renderer.autoClear = true
    renderer.setRenderTarget(volume.target)
    renderer.render(volume.scene, volume.camera)
    renderer.setRenderTarget(previous)
    renderer.autoClear = autoClear
  }

  protected override updateEffectIdsMask(): void {
    const registry = this.ctx.selectiveEffectRegistry
    if (!registry) return
    this.mask.value = this._effectIds.length > 0 ? registry.computeMask(this._effectIds) : 0
  }

  override onDestroy(): void {
    super.onDestroy()
    for (const g of this.geometries) g.dispose()
    for (const m of this.materials) m.dispose()
    this.geometries.clear()
    this.materials.clear()
    this.volume?.target.dispose()
    this.volume?.noise.dispose()
    this.volume = undefined
  }
}

// The light, in a place's own east, north, up
function sunDirection(): Vector3 {
  const az = (SUN_AZIMUTH * Math.PI) / 180
  const el = (SUN_ELEVATION * Math.PI) / 180
  return new Vector3(Math.sin(az) * Math.cos(el), Math.cos(az) * Math.cos(el), Math.sin(el))
}

/**
 * Billows: `n`³ texels of cellular (Worley) noise, three octaves, inverted so each cell is a
 * puff; it tiles, so it can be read anywhere.
 */
function cellNoise(n: number): Data3DTexture {
  const octaves = [
    { cells: 4, weight: 0.55 },
    { cells: 8, weight: 0.3 },
    { cells: 16, weight: 0.15 },
  ]
  const field = new Float32Array(n * n * n)
  for (const { cells, weight } of octaves) {
    // A random point in each cell
    const pts = new Float32Array(cells * cells * cells * 3).map(() => Math.random())
    const size = n / cells
    for (let z = 0; z < n; z++) {
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          const fx = x / size
          const fy = y / size
          const fz = z / size
          const cx = Math.floor(fx)
          const cy = Math.floor(fy)
          const cz = Math.floor(fz)
          let best = 9
          for (let dz = -1; dz <= 1; dz++) {
            for (let dy = -1; dy <= 1; dy++) {
              for (let dx = -1; dx <= 1; dx++) {
                const ix = (((cx + dx) % cells) + cells) % cells
                const iy = (((cy + dy) % cells) + cells) % cells
                const iz = (((cz + dz) % cells) + cells) % cells
                const k = ((iz * cells + iy) * cells + ix) * 3
                const px = cx + dx + pts[k]! - fx
                const py = cy + dy + pts[k + 1]! - fy
                const pz = cz + dz + pts[k + 2]! - fz
                best = Math.min(best, px * px + py * py + pz * pz)
              }
            }
          }
          field[(z * n + y) * n + x]! += weight * (1 - Math.min(1, Math.sqrt(best)))
        }
      }
    }
  }
  const data = new Uint8Array(field.length)
  for (let i = 0; i < field.length; i++) data[i] = Math.round(Math.min(1, Math.max(0, field[i]!)) * 255)
  const t = new Data3DTexture(data, n, n, n)
  t.format = RedFormat
  t.type = UnsignedByteType
  t.minFilter = t.magFilter = LinearFilter
  t.wrapS = t.wrapT = t.wrapR = RepeatWrapping
  t.unpackAlignment = 1
  t.needsUpdate = true
  return t
}

/** A lng/lat grid of cells over a box, each vertex at a cell's centre, with its lng/lat and up. */
function boxGrid(west: number, south: number, east: number, north: number, columns: number, rows: number, height: number): BufferGeometry {
  const at = ellipsoid()
  const n = columns * rows
  const position = new Float32Array(n * 3)
  const up = new Float32Array(n * 3)
  const ll = new Float32Array(n * 2)
  const p = new Vector3()
  const q = new Vector3()
  for (let j = 0; j < rows; j++) {
    const lat = south + ((j + 0.5) / rows) * (north - south)
    for (let i = 0; i < columns; i++) {
      const lng = west + ((i + 0.5) / columns) * (east - west)
      const k = j * columns + i
      at(lng, lat, height, p, q)
      position.set([p.x, p.y, p.z], k * 3)
      up.set([q.x, q.y, q.z], k * 3)
      ll.set([lng, lat], k * 2)
    }
  }
  const index = new Uint32Array((columns - 1) * (rows - 1) * 6)
  let m = 0
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < columns - 1; i++) {
      const k = j * columns + i
      index.set([k, k + 1, k + columns, k + 1, k + columns + 1, k + columns], m)
      m += 6
    }
  }
  const g = new BufferGeometry()
  g.setAttribute('position', new Float32BufferAttribute(position, 3))
  g.setAttribute('aUp', new Float32BufferAttribute(up, 3))
  g.setAttribute('aLL', new Float32BufferAttribute(ll, 2))
  g.setIndex(new Uint32BufferAttribute(index, 1))
  return g
}

/** A flat line `width` m wide round a lng/lat box: its parallels and meridians, every 0.25°. */
function boxOutline(west: number, south: number, east: number, north: number, width: number): BufferGeometry {
  const at = ellipsoid()
  const position: number[] = []
  const index: number[] = []
  const p = new Vector3()
  const halfLat = width / 2 / 110_950
  const halfLng = (lat: number) => width / 2 / (111_320 * Math.cos((lat * Math.PI) / 180))
  // One edge: from a to b, sideways by (dLng, dLat) per unit of `side` at each point
  const edge = (a: [number, number], b: [number, number], across: (lng: number, lat: number) => [number, number]) => {
    const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.25))
    const first = position.length / 3
    for (let i = 0; i <= steps; i++) {
      const lng = a[0] + ((b[0] - a[0]) * i) / steps
      const lat = a[1] + ((b[1] - a[1]) * i) / steps
      const [dx, dy] = across(lng, lat)
      for (const side of [-1, 1]) {
        at(lng + side * dx, lat + side * dy, OUTLINE_LIFT, p)
        position.push(p.x, p.y, p.z)
      }
    }
    for (let i = 0; i < steps; i++) {
      const v = first + i * 2
      index.push(v, v + 1, v + 2, v + 1, v + 3, v + 2)
    }
  }
  // (each reaching half a width past the corners, so they meet)
  const parallel = (): [number, number] => [0, halfLat]
  const meridian = (_: number, lat: number): [number, number] => [halfLng(lat), 0]
  edge([west - halfLng(south), south], [east + halfLng(south), south], parallel)
  edge([west - halfLng(north), north], [east + halfLng(north), north], parallel)
  edge([west, south], [west, north], meridian)
  edge([east, south], [east, north], meridian)
  const g = new BufferGeometry()
  g.setAttribute('position', new Float32BufferAttribute(position, 3))
  g.setIndex(index)
  return g
}
