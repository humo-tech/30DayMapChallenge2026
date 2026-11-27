// Day 28's drift ice, drawn: every floe of driftIce.ts one instance of a ragged slab — a snowy top,
// a little domed, and sides the blue-green of sea ice — stretched and turned a little differently
// each, lying on the sea and rocking when struck. Far thicker than real ice (a few metres), or
// from up here it would be a sheet of paper: its sides catch the light and its shadow falls on the
// water. Only the floes that moved are rewritten each frame.
import { MeshDesc, setupMaterialForMRT, type MeshConfig, type MeshUpdate } from '@navaramap/three'
import { BufferGeometry, Color, DynamicDrawUsage, Float32BufferAttribute, InstancedMesh, Matrix4, Quaternion, ShaderMaterial, Vector3 } from 'three'
import type { DriftIce } from './driftIce'

type DriftIceOptions = {
  ice: DriftIce
  /** The sea's height as drawn (m) */
  seaHeight: number
  /** How far the slabs stand out of the water (m) */
  thickness: number
  /**
   * The height of the anchor the view places the mesh at (config `geodetic`, which must match).
   * Above the water: an object whose origin is under the ground is hidden whole.
   */
  anchorHeight: number
}
type Description = { driftIce?: DriftIceOptions }
export type DriftIceConfig = MeshConfig & Description
type DriftIceUpdate = MeshUpdate & Description

// The floes' own shading (three's built-in materials don't reach the photoreal pipeline's G-buffer
// from here: see setupMaterialForMRT): the sun's light on them, the sky's from all round, and a
// little shine off the snow
const vertexShader = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vColor;
  varying vec3 vView;
  void main() {
    mat4 im = mat4(1.0);
    #ifdef USE_INSTANCING
      im = instanceMatrix;
    #endif
    vec4 mv = modelViewMatrix * im * vec4(position, 1.0);
    // Normals through the instance's stretch (inverse transpose), then into view space
    vNormal = normalize(normalMatrix * (transpose(inverse(mat3(im))) * normal));
    vColor = color;
    #ifdef USE_INSTANCING_COLOR
      vColor *= instanceColor;
    #endif
    vView = -mv.xyz;
    gl_Position = projectionMatrix * mv;
  }
`
const fragmentShader = /* glsl */ `
  uniform vec3 uSun;
  uniform vec3 uSunColor;
  uniform vec3 uSky;
  uniform vec3 uUp;
  varying vec3 vNormal;
  varying vec3 vColor;
  varying vec3 vView;
  void main() {
    vec3 n = normalize(vNormal);
    vec3 v = normalize(vView);
    float ndl = max(dot(n, uSun), 0.0);
    // The sky lights the tops more than the sides
    vec3 sky = uSky * (0.55 + 0.45 * max(dot(n, uUp), 0.0));
    vec3 col = vColor * (sky + uSunColor * ndl);
    vec3 h = normalize(uSun + v);
    col += uSunColor * 0.18 * pow(max(dot(n, h), 0.0), 48.0);
    gl_FragColor = vec4(col, 1.0);
  }
`

// WGS84
const A = 6_378_137
const E2 = 6.69437999014e-3

function ecef(lng: number, lat: number, h: number, out: Vector3) {
  const l = (lng * Math.PI) / 180
  const p = (lat * Math.PI) / 180
  const n = A / Math.sqrt(1 - E2 * Math.sin(p) ** 2)
  return out.set((n + h) * Math.cos(p) * Math.cos(l), (n + h) * Math.cos(p) * Math.sin(l), (n * (1 - E2) + h) * Math.sin(p))
}

/** A unit slab with a ragged outline: radius about 1, top at z = 1, bottom at z = -0.4 */
function slab(): BufferGeometry {
  const SIDES = 11
  let seed = 7
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  const ring: [number, number][] = []
  for (let k = 0; k < SIDES; k++) {
    const a = (k / SIDES) * Math.PI * 2 + (rnd() - 0.5) * 0.35
    const r = 0.82 + rnd() * 0.3
    ring.push([Math.cos(a) * r, Math.sin(a) * r])
  }
  const pos: number[] = []
  const col: number[] = []
  const TOP = [0.96, 0.975, 1]
  const RIM = [0.88, 0.93, 0.97]
  const SIDE = [0.42, 0.66, 0.76]
  const SIDE_LOW = [0.16, 0.33, 0.45]
  const tri = (a: number[], b: number[], c: number[], ca: number[], cb: number[], cc: number[]) => {
    pos.push(...a, ...b, ...c)
    col.push(...ca, ...cb, ...cc)
  }
  // The top: a low dome over the rim
  for (let k = 0; k < SIDES; k++) {
    const [x0, y0] = ring[k]!
    const [x1, y1] = ring[(k + 1) % SIDES]!
    tri([0, 0, 1.12], [x0, y0, 1], [x1, y1, 1], TOP, RIM, RIM)
  }
  // The sides, lighter at the top
  for (let k = 0; k < SIDES; k++) {
    const [x0, y0] = ring[k]!
    const [x1, y1] = ring[(k + 1) % SIDES]!
    tri([x0, y0, 1], [x0, y0, -0.4], [x1, y1, -0.4], SIDE, SIDE_LOW, SIDE_LOW)
    tri([x0, y0, 1], [x1, y1, -0.4], [x1, y1, 1], SIDE, SIDE_LOW, SIDE)
  }
  const g = new BufferGeometry()
  g.setAttribute('position', new Float32BufferAttribute(pos, 3))
  g.setAttribute('color', new Float32BufferAttribute(col, 3))
  g.computeVertexNormals()
  return g
}

export class DriftIceMeshDesc extends MeshDesc<DriftIceConfig, DriftIceUpdate, InstancedMesh> {
  private config: DriftIceConfig
  private mesh?: InstancedMesh
  private anchor = new Vector3()
  // Each floe's own stretch (along and across), fixed
  private stretch?: Float32Array

  constructor(...args: ConstructorParameters<typeof MeshDesc<DriftIceConfig, DriftIceUpdate>>) {
    super(...args)
    this.config = args[2] ?? {}
  }

  // With the photoreal scene's G-buffer in use, lit meshes draw in the MRT pass (the opaque scene
  // is painted over)
  protected override getPassKey() {
    return 'mrt' as const
  }

  override createMesh() {
    const { ice } = this.config.driftIce!
    ecef(ice.anchor.lng, ice.anchor.lat, this.config.driftIce!.anchorHeight, this.anchor)
    // From the Earth's axes to the anchor's west-up-north ones (the frame `geodetic` gives)
    const l = (ice.anchor.lng * Math.PI) / 180
    const ph = (ice.anchor.lat * Math.PI) / 180
    const east = new Vector3(-Math.sin(l), Math.cos(l), 0)
    const north = new Vector3(-Math.sin(ph) * Math.cos(l), -Math.sin(ph) * Math.sin(l), Math.cos(ph))
    const up = new Vector3(Math.cos(ph) * Math.cos(l), Math.cos(ph) * Math.sin(l), Math.sin(ph))
    this.up.copy(up)
    this.toFrame.makeBasis(east.negate(), up, north).transpose()
    const material = new ShaderMaterial({
      vertexShader,
      fragmentShader,
      vertexColors: true,
      uniforms: {
        uSun: { value: new Vector3(0, 1, 0) },
        uSunColor: { value: new Color(1.0, 0.96, 0.9) },
        uSky: { value: new Color(0.42, 0.48, 0.58) },
        uUp: { value: new Vector3(0, 1, 0) },
      },
    })
    setupMaterialForMRT(material, { normal: 'vNormal' })
    this.material = material
    const mesh = new InstancedMesh(slab(), material, Math.max(1, ice.count))
    mesh.instanceMatrix.setUsage(DynamicDrawUsage)
    mesh.castShadow = mesh.receiveShadow = true
    mesh.frustumCulled = false
    // A few shades of white: older, snowier, greyer floes
    let seed = 3
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    const c = new Color()
    this.stretch = new Float32Array(ice.count * 2)
    for (let i = 0; i < ice.count; i++) {
      const v = 0.86 + rnd() * 0.14
      mesh.setColorAt(i, c.setRGB(v, v * (0.99 + rnd() * 0.01), v * (1 + rnd() * 0.02)))
      this.stretch[i * 2] = 0.9 + rnd() * 0.3
      this.stretch[i * 2 + 1] = 0.75 + rnd() * 0.2
    }
    this.mesh = mesh
    this.sync(true)
    // The view places it at the anchor (config `geodetic`), in its west-up-north frame
    return mesh
  }

  private material?: ShaderMaterial
  private sun = new Vector3()
  private up = new Vector3()
  private toFrame = new Matrix4()
  private m = new Matrix4()
  private basis = new Matrix4()
  private local = new Matrix4()
  private q = new Quaternion()
  private tilt = new Quaternion()
  private axis = new Vector3()
  private p = new Vector3()
  private size = new Vector3() // (not `scale`: the base class reads that as the whole mesh's)

  /** Rewrites the floes that moved (all of them if `all`) */
  sync(all = false): void {
    const mesh = this.mesh
    const opts = this.config.driftIce
    if (!mesh || !opts || !this.stretch) return
    const { ice, seaHeight, thickness } = opts
    // The sun, in view space
    if (this.material) {
      const cam = this.view.camera.raw
      this.sun.copy(this.view.atmosphere.sunDirection).transformDirection(cam.matrixWorldInverse)
      ;(this.material.uniforms.uSun!.value as Vector3).copy(this.sun)
      ;(this.material.uniforms.uUp!.value as Vector3).copy(this.up).transformDirection(cam.matrixWorldInverse)
    }
    let any = false
    for (let i = 0; i < ice.count; i++) {
      if (!all && !ice.dirty[i]) continue
      ice.dirty[i] = 0
      any = true
      const { lng, lat } = ice.toLngLat(ice.x[i]!, ice.y[i]!)
      const l = (lng * Math.PI) / 180
      const ph = (lat * Math.PI) / 180
      // The local frame there: x east, y north, z up
      this.basis.set(
        -Math.sin(l), -Math.sin(ph) * Math.cos(l), Math.cos(ph) * Math.cos(l), 0,
        Math.cos(l), -Math.sin(ph) * Math.sin(l), Math.cos(ph) * Math.sin(l), 0,
        0, Math.cos(ph), Math.sin(ph), 0,
        0, 0, 0, 1,
      )
      // Rocking: a tilt about an axis of its own, and a bob
      const rock = ice.rock[i]!
      const phase = ice.rockPhase[i]!
      const bob = rock * thickness * 0.35 * Math.sin(phase)
      ecef(lng, lat, seaHeight + bob, this.p).sub(this.anchor)
      this.q.setFromAxisAngle(this.axis.set(0, 0, 1), ice.ang[i]!)
      if (rock > 0) {
        const a = phase * 0.37 + i
        this.tilt.setFromAxisAngle(this.axis.set(Math.cos(a), Math.sin(a), 0), rock * 0.09 * Math.sin(phase))
        this.q.premultiply(this.tilt)
      }
      const r = ice.r[i]!
      this.size.set(r * this.stretch[i * 2]!, r * this.stretch[i * 2 + 1]!, thickness)
      this.local.compose(this.axis.set(0, 0, 0), this.q, this.size)
      this.m.multiplyMatrices(this.basis, this.local).setPosition(this.p).premultiply(this.toFrame)
      mesh.setMatrixAt(i, this.m)
    }
    if (any) mesh.instanceMatrix.needsUpdate = true
  }
}
