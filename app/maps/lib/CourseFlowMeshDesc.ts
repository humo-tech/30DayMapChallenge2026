// A marathon for Navara: the course drawn as a plain line, and the field as little running
// figures on it (no glow: they're blended normally, and given no effects), legs going, each
// facing the way it runs on screen. Everyone lines up at the start, crosses the line over the
// first minutes (the fastest at the front), then the crowd strings out along the course: the leader in
// about 2 hours, the last in about 6, everyone at their own steady pace, compressed so an
// hour of the race takes `secondsPerHour`. Each runner fades out at the finish; when the
// last is in, the race starts over. One of them, `me`, runs in its own color; `meAt()`,
// `runnerAt()` and `nearMe()` tell where I am and who runs around me, to hang things over us.
//
// The points are moved on the CPU in `tick()`, over the course resampled at fixed steps so
// finding a runner's place is a lookup. Like RailGlowMeshDesc, the shaders write the
// G-buffer, as Navara's renderer expects.
import {
  MeshDescWithSelectiveEffect,
  geodeticToVector3,
  setupMaterialForMRT,
  type MeshConfigWithSelectiveEffect,
  type MeshUpdateWithSelectiveEffect,
} from '@navaramap/three'
import {
  NormalBlending,
  BufferGeometry,
  CanvasTexture,
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

type CourseFlowOptions = {
  /** [lng, lat] from the start to the finish */
  course: [number, number][]
  /** Line color (CSS). Default: lime */
  color?: string
  /** Runner color (CSS). Default: lime */
  runnerColor?: string
  /** Number of runners (besides `me`). Default: 1500 */
  runners?: number
  /** My finish time (h): a runner of my own, in `meColor`. Default: none */
  me?: number
  /** Default: white */
  meColor?: string
  /** Around each figure, so a crowd still reads as people. Default: dark navy */
  outlineColor?: string
  /** Strides a second (each swaps the figure's legs). Default: 5 */
  strideRate?: number
  /** Seconds the animation takes per hour of the race. Default: 5 (the leader in), 10 s */
  secondsPerHour?: number
  /** Finish times (h): the fastest, the slowest, and the bulk around [mean, sd]. Default: 2, 6, [4.6, 0.8] */
  fastest?: number
  slowest?: number
  finishTimes?: [number, number]
  /** Time (h) the whole field takes to cross the start line. Default: 0.4 h */
  startSpread?: number
  /** Rest (s) after the last runner is in, before the race starts over. Default: 3 s */
  rest?: number
  /** Time (s) a runner takes to fade out after finishing. Default: 0.6 s */
  fadeOut?: number
  /** How far (m) the runners spread to either side of the course: wider than any road, so the
   * field reads as a crowd rather than a line from afar. Default: 60 m */
  spread?: number
  /** Height above the ellipsoid (m), so the course clears the draped land. Default: 150 m */
  height?: number
  /** Runner figure size (CSS px; `me` half as big again). Default: 13 */
  runnerSize?: number
  /** Opacity of a runner. Default: 0.85 */
  runnerOpacity?: number
  /** Opacity of the line. Default: 0.6 */
  lineOpacity?: number
}
type Description = { courseFlow?: CourseFlowOptions }
export type CourseFlowConfig = MeshConfigWithSelectiveEffect & Description
type CourseFlowUpdate = MeshUpdateWithSelectiveEffect & Description

const DEFAULTS = {
  color: '#9dff4f',
  runnerColor: '#b4ff6e',
  runners: 1500,
  meColor: '#ffffff',
  outlineColor: '#0b1020',
  strideRate: 5,
  secondsPerHour: 5,
  fastest: 2,
  slowest: 6,
  finishTimes: [4.6, 0.8] as [number, number],
  startSpread: 0.4,
  rest: 3,
  fadeOut: 0.6,
  spread: 60,
  height: 150,
  runnerSize: 13,
  runnerOpacity: 0.85,
  lineOpacity: 0.6,
}

/** The course resampled every STEP m */
const STEP = 10

// The line keeps main() last: setupMaterialForMRT appends the G-buffer writes before its
// closing brace
const lineVertexShader = /* glsl */ `
  void main() {
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`
const lineFragmentShader = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  void main() {
    vec3 normal = vec3(0.0, 0.0, 1.0); // read by the G-buffer write appended below
    gl_FragColor = vec4(uColor, uOpacity);
  }
`
// The figures: a sprite of two frames side by side (FIGURE), the frame picked by the time
// and the runner's own phase, mirrored when it runs leftwards on screen
const runnerVertexShader = /* glsl */ `
  attribute float aAlpha;
  attribute vec3 aDir; // the way it runs (ECEF)
  attribute float aPhase;
  attribute float aMe;
  uniform float uSize;
  uniform float uPixelRatio;
  uniform float uTime;
  uniform float uStrideRate;
  varying float vAlpha;
  varying float vFrame;
  varying float vFlip;
  varying float vMe;
  void main() {
    vAlpha = aAlpha;
    vMe = aMe;
    vFrame = mod(floor(uTime * uStrideRate + aPhase), 2.0);
    vFlip = (modelViewMatrix * vec4(aDir, 0.0)).x < 0.0 ? 1.0 : 0.0;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = uSize * (1.0 + 0.5 * aMe) * uPixelRatio;
  }
`
const runnerFragmentShader = /* glsl */ `
  uniform sampler2D uFigure;
  uniform vec3 uColor;
  uniform vec3 uMeColor;
  uniform vec3 uOutline;
  uniform float uOpacity;
  varying float vAlpha;
  varying float vFrame;
  varying float vFlip;
  varying float vMe;
  void main() {
    vec3 normal = vec3(0.0, 0.0, 1.0); // read by the G-buffer write appended below
    vec2 c = gl_PointCoord;
    if (vFlip > 0.5) c.x = 1.0 - c.x;
    // The figure in white, its outline in black: tinted to the color and the outline color
    vec4 t = texture2D(uFigure, vec2((c.x + vFrame) / 2.0, 1.0 - c.y));
    float a = t.a * vAlpha;
    if (a < 0.3) discard;
    gl_FragColor = vec4(mix(uOutline, mix(uColor, uMeColor, vMe), t.r), a * mix(uOpacity, 1.0, vMe));
  }
`

/** A runner facing right, white with a black outline, in two frames: legs apart, legs passing */
function drawFigure(): CanvasTexture {
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = size * 2
  canvas.height = size
  const g = canvas.getContext('2d')!
  g.lineCap = g.lineJoin = 'round'
  const limb = (...pts: [number, number][]) => {
    g.beginPath()
    pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)))
    g.stroke()
  }
  const frames: [number, number][][][] = [
    // Legs apart, arms swinging
    [
      [[35, 22], [29, 40]],
      [[29, 40], [40, 49], [38, 61]],
      [[29, 40], [21, 51], [11, 55]],
      [[34, 26], [43, 32], [49, 25]],
      [[34, 26], [24, 33], [19, 41]],
    ],
    // Legs passing, arms in
    [
      [[35, 22], [29, 40]],
      [[29, 40], [34, 51], [29, 61]],
      [[29, 40], [25, 51], [19, 58]],
      [[34, 26], [39, 35], [44, 32]],
      [[34, 26], [29, 35], [25, 40]],
    ],
  ]
  // The outline first, then the figure over it
  for (const [color, grow] of [['#000', 3], ['#fff', 0]] as const) {
    g.strokeStyle = g.fillStyle = color
    g.lineWidth = 7 + 2 * grow
    frames.forEach((limbs, f) => {
      g.save()
      g.translate(f * size, 0)
      g.beginPath()
      g.arc(39, 12, 7 + grow, 0, Math.PI * 2)
      g.fill()
      for (const l of limbs) limb(...l)
      g.restore()
    })
  }
  return new CanvasTexture(canvas)
}

// The CSS values as they are, as RailGlowMeshDesc passes Navara's colors
const css = (c: string) => new Color().setStyle(c, LinearSRGBColorSpace)

// mulberry32: a small seeded PRNG, so the field is the same every time
function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function makeMaterial(vertexShader: string, fragmentShader: string, uniforms: Record<string, IUniform>) {
  const material = new ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms,
    transparent: true,
    depthWrite: false,
    blending: NormalBlending,
  })
  // (wired for the selective effects as RailGlowMeshDesc is; with no effectIds, none apply)
  material.defines.USE_SELECTIVE_EFFECT = 1
  material.userData.uEffectIdsMask = { value: 0 }
  material.uniforms.uEffectIdsMask = material.userData.uEffectIdsMask
  material.uniforms.uEmissiveColor = { value: new Vector3() } // added to the color: none
  material.uniforms.uEmissiveIntensity = { value: 1 }
  setupMaterialForMRT(material)
  return material
}

export class CourseFlowMeshDesc extends MeshDescWithSelectiveEffect<CourseFlowConfig, CourseFlowUpdate, Group> {
  private config: CourseFlowConfig
  /** ECEF positions every STEP m along the course, and the unit vector to its side there, xyz interleaved */
  private samples = new Float64Array()
  private sides = new Float64Array()
  private length = 0
  /** Per runner (s of animation): when it crosses the start line, and its time to the finish */
  private starts = new Float32Array()
  private durations = new Float32Array()
  /** Per runner: how far to the side it runs (m) */
  private offsets = new Float32Array()
  /** The index of `me`, if there is one */
  private me = -1
  private figure?: CanvasTexture
  private time = { value: 0 }
  private cycle = 1
  private materials: ShaderMaterial[] = []
  private runners?: Points<BufferGeometry, ShaderMaterial>

  constructor(...args: ConstructorParameters<typeof MeshDescWithSelectiveEffect<CourseFlowConfig, CourseFlowUpdate>>) {
    super(...args)
    this.config = args[2] ?? {}
  }

  private get options() {
    return { ...DEFAULTS, ...this.config.courseFlow }
  }

  override createMesh() {
    const opts = this.options
    const course = opts.course ?? []
    const points = course.map(([lng, lat]) => geodeticToVector3({ lng, lat, height: opts.height }))

    // Line
    const segCount = Math.max(points.length - 1, 0)
    const linePos = new Float32Array(segCount * 6)
    for (let i = 0; i < segCount; i++) {
      const [a, b] = [points[i]!, points[i + 1]!]
      linePos.set([a.x, a.y, a.z, b.x, b.y, b.z], i * 6)
    }
    const lineGeometry = new BufferGeometry()
    lineGeometry.setAttribute('position', new Float32BufferAttribute(linePos, 3))
    const lineMaterial = makeMaterial(lineVertexShader, lineFragmentShader, {
      uColor: { value: css(opts.color) },
      uOpacity: { value: opts.lineOpacity },
    })

    // The course every STEP m
    const dists = [0]
    for (let i = 1; i < points.length; i++) dists.push(dists[i - 1]! + points[i]!.distanceTo(points[i - 1]!))
    this.length = dists[dists.length - 1] ?? 0
    const count = Math.floor(this.length / STEP) + 2
    this.samples = new Float64Array(count * 3)
    const p = new Vector3()
    for (let k = 0, j = 1; k < count; k++) {
      const d = Math.min(k * STEP, this.length)
      while (j < points.length - 1 && dists[j]! < d) j++
      const t = (d - dists[j - 1]!) / Math.max(dists[j]! - dists[j - 1]!, 1e-6)
      p.lerpVectors(points[j - 1]!, points[j]!, Math.min(1, Math.max(0, t)))
      this.samples.set([p.x, p.y, p.z], k * 3)
    }
    // The side: across the course, level with the ground
    this.sides = new Float64Array(count * 3)
    const along = new Vector3()
    const side = new Vector3()
    for (let k = 0; k < count; k++) {
      const [a, b] = [Math.max(k - 1, 0) * 3, Math.min(k + 1, count - 1) * 3]
      along.set(this.samples[b]! - this.samples[a]!, this.samples[b + 1]! - this.samples[a + 1]!, this.samples[b + 2]! - this.samples[a + 2]!)
      p.set(this.samples[k * 3]!, this.samples[k * 3 + 1]!, this.samples[k * 3 + 2]!)
      side.crossVectors(along, p).normalize()
      this.sides.set([side.x, side.y, side.z], k * 3)
    }

    // The field: finish times around the bulk, clipped to [fastest, slowest]; the faster
    // the further forward at the start, so the sooner across the line
    const random = seeded(42)
    const [mean, sd] = opts.finishTimes
    const hours = Array.from({ length: opts.runners }, (_, i) => {
      if (i === 0) return opts.fastest // someone wins in the fastest time
      const g = Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random())
      return Math.min(opts.slowest, Math.max(opts.fastest + 0.15, mean + sd * g))
    }).sort((a, b) => a - b)
    // Where in the field each lines up (0 at the front, 1 at the back): me among my peers,
    // but last in the buffers, so drawn on top
    const ranks = hours.map((_, i) => i / Math.max(hours.length - 1, 1))
    if (opts.me !== undefined) {
      const me = opts.me
      this.me = hours.length
      ranks.push(hours.filter((h) => h < me).length / Math.max(hours.length, 1))
      hours.push(me)
    }
    const n = hours.length
    const sph = opts.secondsPerHour
    this.starts = Float32Array.from(ranks, (r) => opts.startSpread * sph * r)
    this.durations = Float32Array.from(hours, (h) => h * sph)
    this.offsets = Float32Array.from(hours, () => opts.spread * (random() + random() - 1))
    this.cycle = Math.max(...hours.map((h, i) => this.starts[i]! + h * sph)) + opts.fadeOut + opts.rest

    const runnerGeometry = new BufferGeometry()
    runnerGeometry.setAttribute('position', new Float32BufferAttribute(new Float32Array(n * 3), 3))
    runnerGeometry.setAttribute('aAlpha', new Float32BufferAttribute(new Float32Array(n), 1))
    runnerGeometry.setAttribute('aDir', new Float32BufferAttribute(new Float32Array(n * 3), 3))
    runnerGeometry.setAttribute('aPhase', new Float32BufferAttribute(Float32Array.from(hours, () => Math.floor(random() * 2)), 1))
    runnerGeometry.setAttribute('aMe', new Float32BufferAttribute(Float32Array.from(hours, (_, i) => (i === this.me ? 1 : 0)), 1))
    this.figure = drawFigure()
    const runnerMaterial = makeMaterial(runnerVertexShader, runnerFragmentShader, {
      uFigure: { value: this.figure },
      uColor: { value: css(opts.runnerColor) },
      uMeColor: { value: css(opts.meColor) },
      uOutline: { value: css(opts.outlineColor) },
      uOpacity: { value: opts.runnerOpacity },
      uSize: { value: opts.runnerSize },
      uPixelRatio: { value: window.devicePixelRatio },
      uTime: this.time,
      uStrideRate: { value: opts.strideRate },
    })
    this.runners = new Points(runnerGeometry, runnerMaterial)
    this.materials = [lineMaterial, runnerMaterial]

    const lines = new LineSegments(lineGeometry, lineMaterial)
    // Positions are ECEF and the runners move every frame: skip bounds-based culling
    lines.frustumCulled = false
    this.runners.frustumCulled = false
    const group = new Group()
    group.add(lines, this.runners)
    this.tick(0)
    return group
  }

  /** Advances the race to `time` seconds (it starts over every cycle). */
  tick(time: number): void {
    if (!this.runners || this.samples.length < 6) return
    const { fadeOut } = this.options
    this.time.value = time
    const t = this.raceTime(time)
    const s = this.samples
    const side = this.sides
    const last = s.length / 3 - 1
    const position = this.runners.geometry.getAttribute('position') as Float32BufferAttribute
    const alpha = this.runners.geometry.getAttribute('aAlpha') as Float32BufferAttribute
    const dir = this.runners.geometry.getAttribute('aDir') as Float32BufferAttribute
    for (let i = 0; i < this.starts.length; i++) {
      const u = (t - this.starts[i]!) / this.durations[i]!
      // Waiting at the start, running, or fading out past the finish
      const after = (u - 1) * this.durations[i]!
      alpha.setX(i, u <= 1 ? 1 : Math.max(0, 1 - after / fadeOut))
      const f = (Math.min(1, Math.max(0, u)) * this.length) / STEP
      const k = Math.min(Math.floor(f), last - 1)
      const w = Math.min(1, f - k)
      const a = k * 3
      const o = this.offsets[i]!
      position.setXYZ(
        i,
        s[a]! + (s[a + 3]! - s[a]!) * w + side[a]! * o,
        s[a + 1]! + (s[a + 4]! - s[a + 1]!) * w + side[a + 1]! * o,
        s[a + 2]! + (s[a + 5]! - s[a + 2]!) * w + side[a + 2]! * o,
      )
      dir.setXYZ(i, s[a + 3]! - s[a]!, s[a + 4]! - s[a + 1]!, s[a + 5]! - s[a + 2]!)
    }
    position.needsUpdate = true
    alpha.needsUpdate = true
    dir.needsUpdate = true
  }

  private raceTime(time: number): number {
    return ((time % this.cycle) + this.cycle) % this.cycle
  }

  /** The `count` runners whose pace is closest to mine (so who run around me), nearest first. */
  nearMe(count: number): number[] {
    if (this.me < 0) return []
    const mine = this.durations[this.me]!
    return Array.from(this.durations.keys())
      .filter((i) => i !== this.me)
      .sort((a, b) => Math.abs(this.durations[a]! - mine) - Math.abs(this.durations[b]! - mine))
      .slice(0, count)
  }

  /**
   * Where runner `i` is (ECEF, into `target`), as last ticked; false while it waits at the
   * start or after it's in.
   */
  runnerAt(i: number, time: number, target: Vector3): boolean {
    if (!this.runners || i < 0 || i >= this.starts.length) return false
    const u = (this.raceTime(time) - this.starts[i]!) / this.durations[i]!
    if (u <= 0 || u >= 1) return false
    const position = this.runners.geometry.getAttribute('position') as Float32BufferAttribute
    target.fromBufferAttribute(position, i)
    return true
  }

  /** Where `me` is: see `runnerAt()`; false when there's no `me`. */
  meAt(time: number, target: Vector3): boolean {
    return this.runnerAt(this.me, time, target)
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
    this.figure?.dispose()
    group?.traverse((o) => {
      if (o instanceof LineSegments || o instanceof Points) {
        o.geometry.dispose()
        o.material.dispose()
      }
    })
  }
}
