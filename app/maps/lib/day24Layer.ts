// Day 24's network on MapLibre GL JS (Mercator only): one custom layer with a Three.js renderer on
// the map's own GL context (as Day 20's prisms, hexPrismsLayer.ts), made of
//
// - the GROUND: Day 24's marks (offices, homes, stations...) painted flat, and the RIPPLES rain
//   leaves, procedural rings in a hashed grid, lit only as many as the rain is hard,
// - the STATIONS' COLUMNS and the ARCS, the Navara version's shaders (flowArc, flowBead) as they
//   are, up to the frame: there, positions are ECEF metres round an anchor with "up" the radial;
//   here they are Web Mercator metres from the anchor (true metres at its latitude), x east,
//   y north, z up. Both are lit with Navara's selective bloom, which this layer brings its own of
//   (the passes are Day 20's),
// - the RAIN: 24 000 streaks falling through a box that follows the map's centre, each a
//   ribbon widened on screen, wrapped in the vertex shader so none is ever created or removed,
//   and only as many drawn as the rain is hard.
import { MercatorCoordinate, type CustomLayerInterface, type Map as MapLibreMap } from 'maplibre-gl'
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Camera,
  CanvasTexture,
  Color,
  CustomBlending,
  CylinderGeometry,
  DataTexture,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  HalfFloatType,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  LinearFilter,
  LinearMipmapLinearFilter,
  LinearSRGBColorSpace,
  Matrix3,
  Matrix4,
  Mesh,
  NoBlending,
  OneFactor,
  OneMinusSrcAlphaFactor,
  Points,
  RedFormat,
  Scene,
  ShaderMaterial,
  UnsignedByteType,
  Vector2,
  Vector3,
  WebGLRenderTarget,
  WebGLRenderer,
  ZeroFactor,
  type Blending,
} from 'three'
import type { Flows } from './FlowArcsMeshDesc'
import { paintMark, type GroundMark } from './GroundMarksMeshDesc'
import {
  BLOOM_LEVELS,
  brightFragmentShader,
  compositeFragmentShader,
  downFragmentShader,
  passVertexShader,
  upFragmentShader,
} from './hexPrismsLayer'
import beadFragmentShader from './shaders/flowBead.frag.glsl?raw'
import beadVertexShader from './shaders/flowBead.vert.glsl?raw'
import fragmentShader from './shaders/flowArc.frag.glsl?raw'
import vertexShader from './shaders/flowArc.vert.glsl?raw'
import flowCommon from './shaders/flowCommon.glsl?raw'

/** The fill's colors: filling up, emptying, holding (the page's key shows the same) */
export const COLUMN_COLORS = { rising: '#ff8a1f', falling: '#3a86ff', steady: '#5d6474' }

/** What the page says about this frame: the clock, and how hard it rains (0-1) */
export type Day24Frame = { hours: number; wet: number }

export type Day24LayerOptions = {
  /** The middle of the area: where the frame's metres are measured from */
  anchor: { lng: number; lat: number }
  /** Stations, [lng, lat], and their docks */
  stations: [number, number][]
  capacity: number[]
  marks: GroundMark[]
  /** The map's bearing the marks face (deg), as the Navara version's camera heading */
  heading: number
  /** Called at the start of every frame */
  frame: () => Day24Frame
}

export type Day24Layer = CustomLayerInterface & {
  /** The day's bikes in docks (288 per 5 minutes, a row per station): columns and arc ends follow it */
  setDocked(docked: Uint8Array): void
  /** The arcs of one run, or none */
  setFlows(flows: Flows | undefined): void
  dispose(): void
}

const SLOTS = 288
const SEGMENTS = 16 // must match flowArc.vert.glsl
const METERS_PER_BIKE = 8
const RADIUS = 45
const RAIN_DROPS = 24_000
const RAIN_BOX = 7_000 // m, a side
const RAIN_HEIGHT = 1_200 // m
const RAIN_LEN = 45 // m
const RIPPLE_HALF = 4_000 // m, the ground quad's half side (it follows the map's centre)
const BLOOM = { strength: 0.6, radius: 0.45, threshold: 0.35 }

// (flowCommon.glsl is shared by the arc and bead shaders: put it in by hand)
const withCommon = (shader: string) => shader.replace('#include <flowCommon>', flowCommon)
// CSS colors into the linear working space, as the Navara version's columns
const css = (c: string) => new Color().setStyle(c)
// The arcs' near whites are taken as linear values already, as there
const linear = (c: string) => new Color().setStyle(c, LinearSRGBColorSpace)

/** Adds light to the color, nothing to the alpha: where nothing else is drawn, the map shows through */
function additive<T extends ShaderMaterial>(m: T): T {
  m.blending = CustomBlending
  m.blendSrc = OneFactor
  m.blendDst = OneFactor
  m.blendSrcAlpha = ZeroFactor
  m.blendDstAlpha = OneFactor
  return m
}

// ---------------------------------------------------------------------------------------------
// The columns: the Navara version's shaders (StationColumnsMeshDesc), with "up" as +z
// ---------------------------------------------------------------------------------------------
const columnVertexShader = /* glsl */ `
  attribute vec3 aStation; // east, north (m) from the anchor
  attribute vec2 aRow; // x: this station's row in uDocked (texture v), y: its docks
  uniform sampler2D uDocked;
  uniform float uClock; // hours, JST
  uniform mat3 uBasis; // the cylinder's (x, up, z) into the frame's (east, north, up)
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
  #ifdef SHELL
    // A little taller than full and sunk a little, so no face of it ever lies on the fill's
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
    vec4 mv = modelViewMatrix * vec4(vec3(aStation.xy, 0.0) + local, 1.0);
    vPosV = mv.xyz;
    vNormalV = mat3(modelViewMatrix) * (uBasis * normal);
    gl_Position = projectionMatrix * mv;
  }
`

const columnFragmentShader = /* glsl */ `
  uniform vec3 uRising;
  uniform vec3 uFalling;
  uniform vec3 uSteady;
  varying vec3 vPosV;
  varying vec3 vNormalV;
  varying float vTrend;
  varying float vHeight;
  void main() {
    // (the frame is mirrored on its way to the screen: face the viewer, whatever the winding)
    vec3 normal = normalize(vNormalV);
    if (dot(normal, -vPosV) < 0.0) normal = -normal;
  #ifdef SHELL
    // Glass: only its rim shows, faintly, brighter toward the top
    float rim = 1.0 - abs(dot(normal, normalize(-vPosV)));
    gl_FragColor = vec4(vec3(0.55, 0.62, 0.78) * (0.012 + 0.1 * pow(rim, 4.0)) * (0.5 + 0.5 * vHeight), 1.0);
  #else
    vec3 c = vTrend >= 0.0 ? mix(uSteady, uRising, smoothstep(0.25, 1.5, vTrend)) : mix(uSteady, uFalling, smoothstep(0.25, 1.5, -vTrend));
    vec3 L = normalize(vec3(-0.45, 0.7, 0.55)); // key light: upper left, toward the viewer
    float light = 0.45 + 0.55 * max(dot(normal, L), 0.0);
    gl_FragColor = vec4(c * light * (0.55 + 0.45 * vHeight), 1.0);
  #endif
  }
`

// ---------------------------------------------------------------------------------------------
// The rain: ribbons that fall, wrap and widen on screen, all in the vertex shader
// ---------------------------------------------------------------------------------------------
const rainVertexShader = /* glsl */ `
  attribute vec4 aSeed; // x, y: where in the box; z: how far down it falls; w: its speed
  attribute float aT; // 0 at the head, 1 at the tail
  attribute float aSide; // -1 or 1 across the ribbon
  uniform vec2 uCenter; // the box's middle (m, frame)
  uniform float uSize;
  uniform float uHeight;
  uniform float uLen;
  uniform float uTime;
  uniform vec2 uWind; // m east and north the wind carries a drop over each m it falls
  uniform vec2 uResolution;
  uniform float uPixelRatio;
  varying float vA;
  varying float vSide;

  void main() {
    float speed = 150.0 + 70.0 * aSeed.w;
    float fall = fract(aSeed.z + uTime * speed / uHeight);
    float z = uHeight * (1.0 - fall);
    // Wrapped round the centre, so the box moves with the map and no drop is made or lost
    vec2 xy = uCenter + (fract(aSeed.xy - uCenter / uSize) - 0.5) * uSize + uWind * (uHeight - z);
    vec3 head = vec3(xy, z);
    vec3 d = normalize(vec3(uWind, -1.0));
    vec3 tail = head - d * uLen;
    mat4 mvp = projectionMatrix * modelViewMatrix;
    vec4 c0 = mvp * vec4(head, 1.0);
    vec4 c1 = mvp * vec4(tail, 1.0);
    vec2 dir = (c1.xy / c1.w - c0.xy / c0.w) * uResolution;
    dir = length(dir) > 1e-6 ? normalize(dir) : vec2(0.0, 1.0);
    vec4 c = mix(c0, c1, aT);
    // (a px is 2 / resolution in clip space: half the width each side)
    c.xy += vec2(-dir.y, dir.x) * aSide * (0.55 * uPixelRatio) / uResolution * c.w;
    gl_Position = c;
    // Fades in at the top, out into the ground
    vA = (1.0 - 0.8 * aT) * smoothstep(0.0, 25.0, z) * smoothstep(0.0, 60.0, uHeight - z);
    vSide = aSide;
  }
`
const rainFragmentShader = /* glsl */ `
  uniform float uBright;
  varying float vA;
  varying float vSide;
  void main() {
    float edge = 1.0 - smoothstep(0.4, 1.0, abs(vSide));
    gl_FragColor = vec4(vec3(0.62, 0.74, 0.95) * uBright * vA * edge, 1.0);
  }
`

// ---------------------------------------------------------------------------------------------
// The ground: ripples where the drops land
// ---------------------------------------------------------------------------------------------
const rippleVertexShader = /* glsl */ `
  uniform vec2 uCenter;
  varying vec2 vXY;
  void main() {
    vXY = position.xy + uCenter;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position + vec3(uCenter, 0.0), 1.0);
  }
`
const rippleFragmentShader = /* glsl */ `
  uniform float uTime;
  uniform float uWet;
  uniform vec2 uCenter;
  varying vec2 vXY;
  const float CELL = 34.0; // m
  const float REACH = 16.0; // m a ring spreads to: within the cell's half, so 4 cells are enough

  float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  void main() {
    // Rings no wider than a pixel or two shimmer, so they give way as the view lifts
    float mpp = length(fwidth(vXY));
    float fade = 1.0 - smoothstep(4.0, 11.0, mpp);
    float near = 1.0 - smoothstep(2200.0, 3600.0, length(vXY - uCenter));
    if (fade * near * uWet <= 0.0) discard;
    vec2 cell = floor(vXY / CELL);
    float sum = 0.0;
    // (the 2 x 2 cells nearest the pixel: a ring reaches no further than half a cell)
    vec2 nearer = step(0.5, fract(vXY / CELL)) * 2.0 - 1.0;
    for (int j = 0; j <= 1; j++) {
      for (int i = 0; i <= 1; i++) {
        vec2 id = cell + vec2(float(i), float(j)) * nearer;
        float rank = hash(id);
        if (rank > uWet) continue;
        float h2 = hash(id + 7.3);
        float h3 = hash(id + 3.1);
        vec2 at = (id + vec2(h2, h3)) * CELL;
        float period = 0.9 + 0.9 * h2;
        float age = fract(uTime / period + h3);
        float d = length(vXY - at);
        float w = max(1.1, mpp * 0.9);
        float ring = exp(-pow((d - age * REACH) / w, 2.0)) * (1.0 - age) * (1.0 - age);
        sum += ring;
      }
    }
    gl_FragColor = vec4(vec3(0.55, 0.72, 1.0) * min(sum, 1.0) * 0.55 * fade * near, 1.0);
  }
`

// The ground marks: a painted quad, as it was drawn (sRGB, straight alpha)
const markVertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`
const markFragmentShader = /* glsl */ `
  uniform sampler2D uMap;
  varying vec2 vUv;
  void main() {
    vec4 c = texture2D(uMap, vUv);
    if (c.a < 0.01) discard;
    gl_FragColor = c;
  }
`

export function day24Layer(options: Day24LayerOptions): Day24Layer {
  const { anchor, stations: lngLats, capacity } = options
  const n = lngLats.length
  const origin = MercatorCoordinate.fromLngLat([anchor.lng, anchor.lat], 0)
  const unit = origin.meterInMercatorCoordinateUnits()
  // Frame: metres (at the anchor's latitude) from the anchor, x east, y north, z up
  const model = new Matrix4().makeTranslation(origin.x, origin.y, 0).scale(new Vector3(unit, -unit, unit))
  const toFrame = (lng: number, lat: number): [number, number] => {
    const m = MercatorCoordinate.fromLngLat([lng, lat], 0)
    return [(m.x - origin.x) / unit, (origin.y - m.y) / unit]
  }
  const stations = new Float32Array(n * 3)
  lngLats.forEach(([lng, lat], i) => stations.set([...toFrame(lng, lat), 0], i * 3))

  let map: MapLibreMap | undefined
  let renderer: WebGLRenderer | undefined
  // Its matrices are set from the map's each frame
  const camera = new Camera()
  camera.matrixWorldAutoUpdate = false

  const groundScene = new Scene() // drawn straight to the screen: marks, ripples
  const scene = new Scene() // drawn offscreen, then bloomed: columns, arcs, rain
  const arcs = new Group()
  scene.add(arcs)

  // Shared uniforms, one clock for all
  const clock = { value: 0 }
  const time = { value: 0 }
  const wet = { value: 0 }
  const resolution = { value: new Vector2(1, 1) }
  const pixelRatio = { value: 1 }
  const center = { value: new Vector2() }

  // The docked counts: one texture, its data swapped with the day
  const docked = new DataTexture(new Uint8Array(SLOTS * n), SLOTS, n, RedFormat, UnsignedByteType)
  docked.magFilter = LinearFilter
  docked.minFilter = LinearFilter
  docked.needsUpdate = true

  const triangle = new BufferGeometry()
  triangle.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3))

  // --- Ground: marks (the quads' own textures) and ripples
  const heading = (options.heading * Math.PI) / 180
  const right = new Vector2(Math.cos(heading), -Math.sin(heading))
  const top = new Vector2(Math.sin(heading), Math.cos(heading))
  const markTextures: CanvasTexture[] = []
  const markMaterials: ShaderMaterial[] = []
  for (const mark of options.marks) {
    const { canvas, wM, hM } = paintMark(mark)
    const texture = new CanvasTexture(canvas)
    texture.minFilter = LinearMipmapLinearFilter
    texture.anisotropy = 8
    markTextures.push(texture)
    const [cx, cy] = toFrame(mark.lng, mark.lat)
    const corner = (sx: number, sy: number) => [
      cx + right.x * ((sx * wM) / 2) + top.x * ((sy * hM) / 2),
      cy + right.y * ((sx * wM) / 2) + top.y * ((sy * hM) / 2),
      0,
    ]
    const g = new BufferGeometry()
    g.setAttribute('position', new Float32BufferAttribute([...corner(-1, -1), ...corner(1, -1), ...corner(1, 1), ...corner(-1, 1)], 3))
    g.setAttribute('uv', new Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2))
    g.setIndex([0, 1, 2, 0, 2, 3])
    const material = new ShaderMaterial({
      vertexShader: markVertexShader,
      fragmentShader: markFragmentShader,
      uniforms: { uMap: { value: texture } },
      transparent: true,
      depthTest: false,
      depthWrite: false,
    })
    markMaterials.push(material)
    const quad = new Mesh(g, material)
    quad.frustumCulled = false
    quad.renderOrder = 1
    groundScene.add(quad)
  }
  const rippleGeometry = new BufferGeometry()
  rippleGeometry.setAttribute(
    'position',
    new Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0].map((v, i) => (i % 3 === 2 ? 0 : v * RIPPLE_HALF)), 3),
  )
  rippleGeometry.setIndex([0, 1, 2, 0, 2, 3])
  const ripples = additive(
    new ShaderMaterial({
      vertexShader: rippleVertexShader,
      fragmentShader: rippleFragmentShader,
      uniforms: { uTime: time, uWet: wet, uCenter: center },
      transparent: true,
      depthTest: false,
      depthWrite: false,
    }),
  )
  const rippleMesh = new Mesh(rippleGeometry, ripples)
  rippleMesh.frustumCulled = false
  groundScene.add(rippleMesh)

  // --- Columns
  const up = new Vector3(0, 0, 1)
  // east, up, south into east, north, up: x stays, the cylinder's up (y) becomes up (z), and its
  // z (south) becomes -north. A proper rotation
  const basis = new Matrix3().set(1, 0, 0, 0, 0, -1, 0, 1, 0)
  const columnUniforms = {
    uDocked: { value: docked },
    uClock: clock,
    uBasis: { value: basis },
    uMeters: { value: METERS_PER_BIKE },
    uRadius: { value: RADIUS },
    uRising: { value: css(COLUMN_COLORS.rising) },
    uFalling: { value: css(COLUMN_COLORS.falling) },
    uSteady: { value: css(COLUMN_COLORS.steady) },
  }
  const rows = new Float32Array(n * 2)
  for (let i = 0; i < n; i++) rows.set([(i + 0.5) / n, capacity[i]!], i * 2)
  const cyl = new CylinderGeometry(1, 1, 1, 20, 1, false)
  const columnGeometry = new InstancedBufferGeometry()
  columnGeometry.index = cyl.index
  columnGeometry.setAttribute('position', cyl.getAttribute('position'))
  columnGeometry.setAttribute('normal', cyl.getAttribute('normal'))
  columnGeometry.setAttribute('aStation', new InstancedBufferAttribute(stations, 3))
  columnGeometry.setAttribute('aRow', new InstancedBufferAttribute(rows, 2))
  columnGeometry.instanceCount = n
  const fill = new ShaderMaterial({
    vertexShader: columnVertexShader,
    fragmentShader: columnFragmentShader,
    uniforms: columnUniforms,
    side: DoubleSide,
  })
  const shell = additive(
    new ShaderMaterial({
      vertexShader: columnVertexShader,
      fragmentShader: columnFragmentShader,
      uniforms: columnUniforms,
      defines: { SHELL: 1 },
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
    }),
  )
  const fills = new Mesh(columnGeometry, fill)
  const shells = new Mesh(columnGeometry, shell)
  shells.renderOrder = 1
  for (const m of [fills, shells]) {
    m.frustumCulled = false // placed in the shader
    scene.add(m)
  }

  // --- Arcs and beads, per run
  const arcUniforms = {
    uClock: clock,
    uTime: time,
    uResolution: resolution,
    uPixelRatio: pixelRatio,
    uUp: { value: up },
    uGain: { value: 0.45 },
    uWidth: { value: 2.5 },
    uFade: { value: 1.5 },
    uSize: { value: 13 },
    uDocked: { value: docked },
    uMeters: { value: METERS_PER_BIKE },
    uFromColor: { value: linear('#a9b8d6') },
    uToColor: { value: linear('#fbf6ec') },
  }
  const arcMaterial = additive(
    new ShaderMaterial({
      vertexShader: withCommon(vertexShader),
      fragmentShader,
      uniforms: arcUniforms,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
    }),
  )
  const beadMaterial = additive(
    new ShaderMaterial({
      vertexShader: withCommon(beadVertexShader),
      fragmentShader: beadFragmentShader,
      uniforms: arcUniforms,
      transparent: true,
      depthWrite: false,
    }),
  )
  // One ribbon: two triangles per segment, each vertex knowing how far along it is and which side
  const ribbon = (() => {
    const t: number[] = []
    const side: number[] = []
    for (let s = 0; s < SEGMENTS; s++) {
      const [t0, t1] = [s / SEGMENTS, (s + 1) / SEGMENTS]
      for (const [tt, ss] of [[t0, -1], [t0, 1], [t1, -1], [t1, -1], [t0, 1], [t1, 1]] as const) {
        t.push(tt)
        side.push(ss)
      }
    }
    return { t, side }
  })()
  let arcMeshes: (Mesh | Points)[] = []
  const clearArcs = () => {
    for (const o of arcMeshes) {
      arcs.remove(o)
      o.geometry.dispose()
    }
    arcMeshes = []
  }
  const buildArcs = (flows: Flows) => {
    const count = flows.count
    const aFrom = new Float32Array(count * 3)
    const aTo = new Float32Array(count * 3)
    const aFlow = new Float32Array(count * 2)
    const aRows = new Float32Array(count * 2) // each end's row in the docked texture (v)
    const aSeed = new Float32Array(count) // each bead's timing, stable per flow
    for (let i = 0; i < count; i++) {
      const x = Math.sin((i + 1) * 12.9898) * 43758.5453
      aSeed[i] = x - Math.floor(x)
      aRows[i * 2] = (flows.from[i]! + 0.5) / n
      aRows[i * 2 + 1] = (flows.to[i]! + 0.5) / n
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
    const geometry = new InstancedBufferGeometry()
    geometry.setAttribute('aT', new Float32BufferAttribute(ribbon.t, 1))
    geometry.setAttribute('aSide', new Float32BufferAttribute(ribbon.side, 1))
    // (three wants a position to count the vertices by; the shader places them itself)
    geometry.setAttribute('position', new Float32BufferAttribute(new Float32Array(ribbon.t.length * 3), 3))
    const beads = new InstancedBufferGeometry()
    beads.setAttribute('position', new Float32BufferAttribute([0, 0, 0], 3))
    for (const [name, attr] of Object.entries(perFlow)) {
      geometry.setAttribute(name, attr)
      beads.setAttribute(name, attr)
    }
    geometry.instanceCount = beads.instanceCount = count
    arcMeshes = [new Mesh(geometry, arcMaterial), new Points(beads, beadMaterial)]
    for (const o of arcMeshes) {
      o.frustumCulled = false // placed in the shaders
      o.renderOrder = 2
      arcs.add(o)
    }
  }

  // --- Rain
  const rainGeometry = (() => {
    const g = new InstancedBufferGeometry()
    // A ribbon of one quad: head to tail, two sides
    g.setAttribute('aT', new Float32BufferAttribute([0, 0, 1, 1, 0, 1], 1))
    g.setAttribute('aSide', new Float32BufferAttribute([-1, 1, -1, -1, 1, 1], 1))
    g.setAttribute('position', new Float32BufferAttribute(new Float32Array(6 * 3), 3))
    const seed = new Float32Array(RAIN_DROPS * 4)
    // (a fixed pseudo-random stream: the same rain every time)
    let s = 1234567
    const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296)
    for (let i = 0; i < seed.length; i++) seed[i] = rnd()
    g.setAttribute('aSeed', new InstancedBufferAttribute(seed, 4))
    g.instanceCount = RAIN_DROPS
    return g
  })()
  const rainUniforms = {
    uCenter: center,
    uSize: { value: RAIN_BOX },
    uHeight: { value: RAIN_HEIGHT },
    uLen: { value: RAIN_LEN },
    uTime: time,
    uWind: { value: new Vector2(0.18, -0.08) },
    uResolution: resolution,
    uPixelRatio: pixelRatio,
    uBright: { value: 0.5 },
  }
  const rainMaterial = additive(
    new ShaderMaterial({
      vertexShader: rainVertexShader,
      fragmentShader: rainFragmentShader,
      uniforms: rainUniforms,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
    }),
  )
  const rain = new Mesh(rainGeometry, rainMaterial)
  rain.frustumCulled = false
  rain.renderOrder = 3
  scene.add(rain)

  // --- The offscreen targets and bloom (Day 20's passes)
  const pass = (fragment: string, uniforms: Record<string, { value: unknown }>, blending: Blending = NoBlending) =>
    new ShaderMaterial({ vertexShader: passVertexShader, fragmentShader: fragment, uniforms, blending, depthTest: false, depthWrite: false })
  const bright = pass(brightFragmentShader, { tInput: { value: null }, uTexel: { value: new Vector2() }, uThreshold: { value: BLOOM.threshold } })
  const down = pass(downFragmentShader, { tInput: { value: null }, uTexel: { value: new Vector2() } })
  const upPass = pass(upFragmentShader, {
    tInput: { value: null },
    tSupport: { value: null },
    uTexel: { value: new Vector2() },
    uRadius: { value: BLOOM.radius },
  })
  const composite = pass(compositeFragmentShader, { tScene: { value: null }, tBloom: { value: null }, uStrength: { value: BLOOM.strength } }, CustomBlending)
  composite.blendSrc = OneFactor
  composite.blendDst = OneMinusSrcAlphaFactor
  const quad = new Mesh(triangle, bright)
  quad.frustumCulled = false
  const passScene = new Scene().add(quad)

  const target = (samples = 0) => new WebGLRenderTarget(1, 1, { type: HalfFloatType, samples, depthBuffer: samples > 0 })
  const sceneTarget = target(4)
  const downs = Array.from({ length: BLOOM_LEVELS }, () => target())
  const ups = Array.from({ length: BLOOM_LEVELS - 1 }, () => target())
  const resize = (w: number, h: number) => {
    if (sceneTarget.width === w && sceneTarget.height === h) return
    sceneTarget.setSize(w, h)
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      const [lw, lh] = [Math.max(1, w >> (i + 1)), Math.max(1, h >> (i + 1))]
      downs[i]!.setSize(lw, lh)
      ups[i]?.setSize(lw, lh)
    }
  }
  const draw = (material: ShaderMaterial, to: WebGLRenderTarget | null) => {
    quad.material = material
    renderer!.setRenderTarget(to)
    renderer!.render(passScene, camera)
  }
  const texel = (m: ShaderMaterial, t: WebGLRenderTarget) => (m.uniforms.uTexel!.value as Vector2).set(1 / t.width, 1 / t.height)

  const projection = new Matrix4()
  const flipY = new Matrix4().makeScale(1, -1, 1)
  const mainMatrix = new Matrix4()

  return {
    id: 'day24-network',
    type: 'custom',
    renderingMode: '3d',
    onAdd(m, gl) {
      map = m
      renderer = new WebGLRenderer({ canvas: m.getCanvas(), context: gl })
      renderer.autoClear = false
    },
    prerender() {
      const f = options.frame()
      clock.value = f.hours
      wet.value = f.wet
      // As many drops as the rain is hard (their order is random), none when dry
      rainGeometry.instanceCount = Math.ceil(RAIN_DROPS * f.wet)
      rain.visible = f.wet > 0.002
      rippleMesh.visible = rain.visible
      time.value = performance.now() / 1000
      if (map) {
        const c = map.getCenter()
        const [x, y] = toFrame(c.lng, c.lat)
        center.value.set(x, y)
        pixelRatio.value = map.getPixelRatio()
      }
    },
    render(gl, { defaultProjectionData, projectionMatrix }) {
      if (!map || !renderer) return
      const w = gl.drawingBufferWidth
      const h = gl.drawingBufferHeight
      resolution.value.set(w, h)
      // MapLibre's matrix takes Web Mercator to the screen; split off its perspective so the
      // shaders get a view space (y up) to shade in, as they do in Navara
      projection.fromArray(projectionMatrix as unknown as number[]).multiply(flipY)
      camera.projectionMatrix.copy(projection)
      camera.projectionMatrixInverse.copy(projection).invert()
      mainMatrix.fromArray(defaultProjectionData.mainMatrix as unknown as number[])
      camera.matrixWorldInverse.copy(camera.projectionMatrixInverse).multiply(mainMatrix).multiply(model)
      camera.matrixWorld.copy(camera.matrixWorldInverse).invert()

      renderer.resetState()
      resize(w, h)
      // The marks and ripples on the map
      renderer.setRenderTarget(null)
      renderer.setViewport(0, 0, w, h)
      renderer.render(groundScene, camera)

      // The columns, arcs and rain, bloomed
      renderer.setClearColor(0x000000, 0)
      renderer.setRenderTarget(sceneTarget)
      renderer.clear()
      renderer.render(scene, camera)
      bright.uniforms.tInput!.value = sceneTarget.texture
      texel(bright, sceneTarget)
      draw(bright, downs[0]!)
      for (let i = 1; i < BLOOM_LEVELS; i++) {
        down.uniforms.tInput!.value = downs[i - 1]!.texture
        texel(down, downs[i - 1]!)
        draw(down, downs[i]!)
      }
      let below = downs[BLOOM_LEVELS - 1]!
      for (let i = BLOOM_LEVELS - 2; i >= 0; i--) {
        upPass.uniforms.tInput!.value = below.texture
        upPass.uniforms.tSupport!.value = downs[i]!.texture
        texel(upPass, below)
        draw(upPass, ups[i]!)
        below = ups[i]!
      }
      composite.uniforms.tScene!.value = sceneTarget.texture
      composite.uniforms.tBloom!.value = below.texture
      renderer.setRenderTarget(null)
      renderer.setViewport(0, 0, w, h)
      draw(composite, null)
      // It never stops moving: the clock, the beads, the rain
      map.triggerRepaint()
    },
    onRemove() {
      map = undefined
    },
    setDocked(data) {
      docked.image.data = data
      docked.needsUpdate = true
    },
    setFlows(flows) {
      clearArcs()
      if (flows) buildArcs(flows)
      map?.triggerRepaint()
    },
    dispose() {
      clearArcs()
      for (const g of [triangle, rippleGeometry, columnGeometry, rainGeometry, cyl]) g.dispose()
      for (const m of [ripples, fill, shell, arcMaterial, beadMaterial, rainMaterial, bright, down, upPass, composite, ...markMaterials]) m.dispose()
      for (const t of [docked, ...markTextures]) t.dispose()
      for (const t of [sceneTarget, ...downs, ...ups]) t.dispose()
      renderer?.dispose()
      renderer = undefined
    },
  }
}
