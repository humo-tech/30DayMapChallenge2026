// Day 26's track of Typhoon Champi, for Navara: a flat ribbon over the sea along the storm's path,
// behind it in the color of its wind, ahead faint dashes, moving on with the hour given to
// `tick`. Also the geometry both of Day 26's maps build on: places on the WGS84 ellipsoid, and
// the track's ribbon.
import { MeshDesc, geodeticToVector3, getWGS84SemiMajorAxis, setupMaterialForMRT, type MeshConfig, type MeshUpdate } from '@navaramap/three'
import { BufferGeometry, DoubleSide, Float32BufferAttribute, Mesh, ShaderMaterial, Vector3 } from 'three'
import { stormAt, windColor, type Fix } from './typhoon'

const WGS84_E2 = 6.69437999014e-3

/**
 * ECEF on the WGS84 ellipsoid, `height` m up, and the ellipsoid's normal there. Navara's axes
 * are read off geodeticToVector3, as in waveField.ts
 */
export function ellipsoid() {
  const axis = (lng: number, lat: number) => geodeticToVector3({ lng, lat, height: 0 }).normalize()
  const [ex, ey, ez] = [axis(0, 0), axis(90, 0), axis(0, 90)]
  const a = getWGS84SemiMajorAxis()
  return (lngDeg: number, latDeg: number, height: number, out: Vector3, normal?: Vector3) => {
    const lat = (latDeg * Math.PI) / 180
    const lng = (lngDeg * Math.PI) / 180
    const n = a / Math.sqrt(1 - WGS84_E2 * Math.sin(lat) ** 2)
    out
      .copy(ex)
      .multiplyScalar((n + height) * Math.cos(lat) * Math.cos(lng))
      .addScaledVector(ey, (n + height) * Math.cos(lat) * Math.sin(lng))
      .addScaledVector(ez, (n * (1 - WGS84_E2) + height) * Math.sin(lat))
    normal
      ?.copy(ex)
      .multiplyScalar(Math.cos(lat) * Math.cos(lng))
      .addScaledVector(ey, Math.cos(lat) * Math.sin(lng))
      .addScaledVector(ez, Math.sin(lat))
  }
}

/** The track as a flat ribbon `width` m wide, `height` m up, every half hour, with the hour and the wind's color. */
export function trackRibbon(track: Fix[], width: number, height: number): BufferGeometry {
  const at = ellipsoid()
  const first = track[0]!.hour
  const last = track.at(-1)!.hour
  const hours: number[] = []
  for (let h = first; h <= last; h += 0.5) hours.push(h)
  const position: number[] = []
  const hour: number[] = []
  const color: number[] = []
  const p = new Vector3()
  for (let i = 0; i < hours.length; i++) {
    const s = stormAt(track, hours[i]!)
    const a = stormAt(track, hours[Math.max(0, i - 1)]!)
    const b = stormAt(track, hours[Math.min(hours.length - 1, i + 1)]!)
    // Across the way it's going, in degrees
    const dx = (b.lon - a.lon) * Math.cos((s.lat * Math.PI) / 180)
    const dy = b.lat - a.lat
    const len = Math.hypot(dx, dy) || 1
    const off = width / 2 / 111_000
    const nx = (-dy / len) * off
    const ny = (dx / len) * off
    for (const side of [-1, 1]) {
      at(s.lon + (side * nx) / Math.cos((s.lat * Math.PI) / 180), s.lat + side * ny, height, p)
      position.push(p.x, p.y, p.z)
      hour.push(hours[i]!)
      color.push(...windColor(s.wind))
    }
  }
  const index: number[] = []
  for (let i = 0; i < hours.length - 1; i++) index.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2)
  const g = new BufferGeometry()
  g.setAttribute('position', new Float32BufferAttribute(position, 3))
  g.setAttribute('aHour', new Float32BufferAttribute(hour, 1))
  g.setAttribute('aColor', new Float32BufferAttribute(color, 3))
  g.setIndex(index)
  return g
}

const vertexShader = /* glsl */ `
  attribute float aHour;
  attribute vec3 aColor;
  varying float vHour;
  varying vec3 vColor;
  void main() {
    vHour = aHour;
    vColor = aColor;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

// setupMaterialForMRT appends the G-buffer writes before main()'s closing brace: keep main() last
const fragmentShader = /* glsl */ `
  uniform float uHour;
  varying float vHour;
  varying vec3 vColor;
  void main() {
    vec3 normal = vec3(0.0, 0.0, 1.0); // read by the G-buffer write appended below
    // Behind the storm, its track in the color of its wind; ahead, faint dashes
    float past = step(vHour, uHour);
    float dash = step(0.5, fract(vHour / 4.0));
    float a = mix(0.35 * dash, 0.95, past);
    gl_FragColor = vec4(mix(vec3(0.9), vColor, past) * a, a);
  }
`

type TrackOptions = {
  track: Fix[]
  /** Width (m). Default: 9 km */
  width?: number
  /** Height over the ellipsoid (m), over the sea's shell. Default: 6 km */
  height?: number
}
type Description = { typhoonTrack?: TrackOptions }
export type TrackConfig = MeshConfig & Description
type TrackUpdate = MeshUpdate & Description

export class TrackMeshDesc extends MeshDesc<TrackConfig, TrackUpdate, Mesh<BufferGeometry, ShaderMaterial>> {
  private config: TrackConfig
  private material?: ShaderMaterial

  constructor(...args: ConstructorParameters<typeof MeshDesc<TrackConfig, TrackUpdate>>) {
    super(...args)
    this.config = args[2] ?? {}
  }

  override createMesh() {
    const { track, width = 9_000, height = 6_000 } = this.config.typhoonTrack!
    const material = new ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: { uHour: { value: 0 } },
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
    })
    setupMaterialForMRT(material)
    this.material = material
    const mesh = new Mesh(trackRibbon(track, width, height), material)
    mesh.frustumCulled = false
    mesh.renderOrder = 2
    return mesh
  }

  /** Behind the storm at `hour` (since the clouds' start), the track drawn in full. */
  tick(hour: number): void {
    if (this.material) this.material.uniforms.uHour!.value = hour
  }

  override onDestroy(): void {
    const mesh = this.raw
    super.onDestroy()
    mesh?.geometry.dispose()
    this.material?.dispose()
  }
}
