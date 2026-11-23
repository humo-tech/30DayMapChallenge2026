// How full each bike station is, as a column, for Navara (Day 24): a faint glass shell as tall
// as its docks, filled to the bikes in them at the clock's time (from the 5-minute counts, eased
// between them). The fill is orange while the station is filling up, blue while it empties, grey
// while it holds (its half-hour average against that two hours before, so not flickering with
// the counts); the arcs above are near white, so the colors are the columns' alone.
import { MeshDesc, setupMaterialForMRT, type MeshConfig, type MeshUpdate } from '@navaramap/three'
import {
  AdditiveBlending,
  Color,
  CylinderGeometry,
  DataTexture,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  LinearFilter,
  Matrix3,
  Mesh,
  RedFormat,
  ShaderMaterial,
  UnsignedByteType,
  Vector3,
} from 'three'

type StationColumnsOptions = {
  /** ECEF (m) the positions are measured from */
  anchor: { x: number; y: number; z: number }
  /** Station positions relative to `anchor` (m), xyz per station */
  stations: Float32Array
  /** Docks per station */
  capacity: number[]
  /** Bikes in docks per station per 5 minutes of the day (288 a row, a row per station) */
  docked: Uint8Array
  /** Column height per bike (m). Default: 8 */
  metersPerBike?: number
  /** Column radius (m). Default: 45 */
  radius?: number
  /** Colors (CSS) filling, emptying, holding */
  rising?: string
  falling?: string
  steady?: string
}
type Description = { stationColumns?: StationColumnsOptions }
export type StationColumnsConfig = MeshConfig & Description
type StationColumnsUpdate = MeshUpdate & Description

const SLOTS = 288
// CSS colors into the linear working space, so they come out on screen as written (taking them
// as linear values already lifts and pales them)
const css = (c: string) => new Color().setStyle(c)

/** The fill's colors: filling up, emptying, holding (the page's key shows the same) */
export const COLUMN_COLORS = { rising: '#ff8a1f', falling: '#3a86ff', steady: '#5d6474' }

// (Navara's renderer has a logarithmic depth buffer: without its chunks the ground, which writes
// log depth, cuts into the columns)
const vertexShader = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute vec3 aStation; // relative to the anchor
  attribute vec2 aRow; // x: this station's row in uDocked (texture v), y: its docks
  uniform sampler2D uDocked;
  uniform float uClock; // hours, JST
  uniform mat3 uBasis; // east, up, south (right-handed, so the faces wind as built)
  uniform float uMeters;
  uniform float uRadius;
  varying vec3 vPosV;
  varying vec3 vNormalV;
  varying float vTrend;
  varying float vHeight; // 0 at the foot, 1 at the top

  float docked(float hours) {
    float slot = clamp(hours * 12.0, 0.0, ${SLOTS - 1}.0);
    return texture2D(uDocked, vec2((slot + 0.5) / ${SLOTS}.0, aRow.x)).r * 255.0;
  }

  // The bikes averaged over the half hour up to \`hours\` (7 steps), for the color: the counts
  // tick up and down by one all day, and a raw difference would flip it back and forth
  float smoothed(float hours) {
    float sum = 0.0;
    for (int i = 0; i < 7; i++) sum += docked(hours - float(i) / 12.0);
    return sum / 7.0;
  }

  void main() {
    float now = docked(uClock);
    // (against two hours before: the evening's bikes come home a few at a time, over hours)
    vTrend = smoothed(uClock) - smoothed(uClock - 2.0);
    // (a sliver even when empty, so the station still shows; FlowArcsMeshDesc lands its arcs
    // on this top, so keep the two alike)
  #ifdef SHELL
    // A little taller than full and sunk a little, so no face of it ever lies on the fill's
    // (coplanar faces fight over depth and flicker)
    float base = -3.0;
    float top = aRow.y * uMeters + 2.0 + 5.0;
    float r = uRadius * 1.3;
  #else
    float base = 0.0;
    float top = now * uMeters + 2.0;
    float r = uRadius;
  #endif
    vHeight = position.y + 0.5;
    vec3 local = uBasis * vec3(position.x * r, base + vHeight * (top - base), position.z * r);
    vec4 mv = modelViewMatrix * vec4(aStation + local, 1.0);
    vPosV = mv.xyz;
    vNormalV = mat3(modelViewMatrix) * (uBasis * normal);
    gl_Position = projectionMatrix * mv;
    #include <logdepthbuf_vertex>
  }
`

// setupMaterialForMRT appends the G-buffer writes before main()'s closing brace, so keep main() last
const fragmentShader = /* glsl */ `
  #include <logdepthbuf_pars_fragment>
  uniform vec3 uRising;
  uniform vec3 uFalling;
  uniform vec3 uSteady;
  varying vec3 vPosV;
  varying vec3 vNormalV;
  varying float vTrend;
  varying float vHeight;
  void main() {
    #include <logdepthbuf_fragment>
    vec3 normal = normalize(vNormalV); // also read by the G-buffer write appended below
  #ifdef SHELL
    // Glass: only its rim shows, faintly, brighter toward the top
    float rim = 1.0 - abs(dot(normal, normalize(-vPosV)));
    // (kept faint: added over the fill, any more would wash its color out)
    gl_FragColor = vec4(vec3(0.55, 0.62, 0.78) * (0.012 + 0.1 * pow(rim, 4.0)) * (0.5 + 0.5 * vHeight), 1.0);
  #else
    // (under a quarter of a bike's change is no change; a bike and a half, full color)
    vec3 c = vTrend >= 0.0 ? mix(uSteady, uRising, smoothstep(0.25, 1.5, vTrend)) : mix(uSteady, uFalling, smoothstep(0.25, 1.5, -vTrend));
    vec3 L = normalize(vec3(-0.45, 0.7, 0.55)); // key light: upper left, toward the viewer
    float light = 0.45 + 0.55 * max(dot(normal, L), 0.0);
    // Darker toward the foot, so the top (the level) reads
    gl_FragColor = vec4(c * light * (0.55 + 0.45 * vHeight), 1.0);
  #endif
  }
`

export class StationColumnsMeshDesc extends MeshDesc<StationColumnsConfig, StationColumnsUpdate, Group> {
  private config: StationColumnsConfig
  private clock = { value: 0 }
  private texture?: DataTexture

  constructor(...args: ConstructorParameters<typeof MeshDesc<StationColumnsConfig, StationColumnsUpdate>>) {
    super(...args)
    this.config = args[2] ?? {}
  }

  override createMesh() {
    const opts = {
      metersPerBike: 8,
      radius: 45,
      ...COLUMN_COLORS,
      ...this.config.stationColumns!,
    }
    const { anchor, stations, capacity, docked } = opts
    const n = capacity.length

    // The local frame at the anchor: east, up, south (east, up, north would mirror the cylinder
    // and turn its faces inside out)
    const up = new Vector3(anchor.x, anchor.y, anchor.z).normalize()
    const east = new Vector3(0, 0, 1).cross(up).normalize()
    const south = east.clone().cross(up)
    const basis = new Matrix3().set(east.x, up.x, south.x, east.y, up.y, south.y, east.z, up.z, south.z)

    const texture = new DataTexture(docked, SLOTS, n, RedFormat, UnsignedByteType)
    texture.magFilter = LinearFilter
    texture.minFilter = LinearFilter
    texture.needsUpdate = true
    this.texture = texture

    const rows = new Float32Array(n * 2)
    for (let i = 0; i < n; i++) rows.set([(i + 0.5) / n, capacity[i]!], i * 2)
    const base = new CylinderGeometry(1, 1, 1, 20, 1, false)
    const geometry = new InstancedBufferGeometry()
    geometry.index = base.index
    geometry.setAttribute('position', base.getAttribute('position'))
    geometry.setAttribute('normal', base.getAttribute('normal'))
    geometry.setAttribute('aStation', new InstancedBufferAttribute(stations, 3))
    geometry.setAttribute('aRow', new InstancedBufferAttribute(rows, 2))
    geometry.instanceCount = n

    const uniforms = {
      uDocked: { value: texture },
      uClock: this.clock,
      uBasis: { value: basis },
      uMeters: { value: opts.metersPerBike },
      uRadius: { value: opts.radius },
      uRising: { value: css(opts.rising) },
      uFalling: { value: css(opts.falling) },
      uSteady: { value: css(opts.steady) },
    }
    const fill = new ShaderMaterial({ vertexShader, fragmentShader, uniforms })
    setupMaterialForMRT(fill)
    const shell = new ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms,
      defines: { SHELL: 1 },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    })
    setupMaterialForMRT(shell)

    const group = new Group()
    group.position.set(anchor.x, anchor.y, anchor.z)
    const fills = new Mesh(geometry, fill)
    const shells = new Mesh(geometry, shell)
    shells.renderOrder = 1
    for (const m of [fills, shells]) {
      // Placed in the shader: no bounds to cull by
      m.frustumCulled = false
      group.add(m)
    }
    return group
  }

  /** Sets the clock to `hours` (JST, 0-24). */
  tick(hours: number): void {
    this.clock.value = hours
  }

  override onDestroy(): void {
    const group = this.raw
    super.onDestroy()
    const done = new Set()
    group?.traverse((o) => {
      if (!(o instanceof Mesh)) return
      if (!done.has(o.geometry)) o.geometry.dispose()
      done.add(o.geometry)
      o.material.dispose()
    })
    this.texture?.dispose()
  }
}
