// Lightning and its thunder, for Navara: each strike flashes as a jagged bolt (or, inside the
// cloud, as a glow alone), lights the cloud and the ground under it, then lets its thunder out as
// a ring on the ground that spreads at the speed of sound. The ring is a band, not a line: the
// channel is kilometres long, so its sound arrives over seconds, and the band is the rumble's
// length on the ground. A marker stands where the listener is, and flares when a ring reaches it.
//
// Wired into the G-buffer like RailGlowMeshDesc, so it all feeds the selective bloom.
import {
  Color,
  MeshDescWithSelectiveEffect,
  geodeticToVector3,
  headingPitchRollToFixedFrame,
  setupMaterialForMRT,
  type MeshConfigWithSelectiveEffect,
  type MeshUpdateWithSelectiveEffect,
} from '@navaramap/three'
import {
  AdditiveBlending,
  BufferGeometry,
  CanvasTexture,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  LineLoop,
  Mesh,
  Points,
  ShaderMaterial,
  Vector2,
  Vector3,
  type IUniform,
} from 'three'

/** m/s, in air at about 20 °C */
export const SOUND_SPEED = 343
/** Thunder is rarely heard past ~20 km: the rings fade out by then */
export const AUDIBLE = 20_000
/** Thunder's loudness falls to half at this distance (m), to a third at twice it, and so on */
export const HALF_LOUD = 1_200
/** How loud thunder is from `distance` m away, 1 up close */
export const loudness = (distance: number) => 1 / (1 + distance / HALF_LOUD)

export type Strike = {
  lng: number
  lat: number
  /** Time of the first flash (s, on the same clock as `tick`) */
  time: number
  /** Inside the cloud: a flash with no bolt to the ground */
  cloudOnly: boolean
  /** Height of the cloud base, where the bolt starts (m) */
  base: number
  /** Return strokes: each one's offset from `time` (s) */
  strokes: number[]
  /** How far the sound's sources spread along the channel (m): the band's width */
  span: number
}

// How bright the strike is `t` s after its first flash: a stepped leader feels its way down
// for the first LEADER s, then each return stroke spikes and dies off; a little afterglow
const LEADER = 0.08
export function flashAt(s: Strike, t: number): number {
  if (t < 0) return 0
  let f = s.cloudOnly || t >= LEADER ? 0 : 0.15
  for (const at of s.strokes) {
    const dt = t - LEADER - at
    if (dt >= 0) f += Math.exp(-dt / 0.05) + 0.12 * Math.exp(-dt / 0.35)
  }
  return f
}
/** How far down the leader has reached, 0 (cloud) - 1 (ground) */
const reachAt = (t: number) => Math.min(1, Math.max(0, t / LEADER))
/** Seconds after which the flash is over */
export const flashEnd = (s: Strike) => LEADER + (s.strokes.at(-1) ?? 0) + 1.5

/**
 * The ring's radius on the ground (m) `t` s after the strike, `lag` m behind its front. The
 * nearest sound comes from the ground for a bolt, from the cloud for a flash inside it.
 */
export function frontAt(s: Strike, t: number, lag = 0): number {
  const r = Math.max(0, SOUND_SPEED * t - lag)
  const h = s.cloudOnly ? s.base : 0
  return Math.sqrt(Math.max(0, r * r - h * h))
}

type ThunderOptions = {
  /** Bolt color. Default: violet white */
  boltColor?: Color
  /** Cloud and ground glow. Default: lavender */
  glowColor?: Color
  /** The thunder rings. Default: amber */
  ringColor?: Color
  /** The listener's marker. Default: near white */
  listenerColor?: Color
  /** Its size, halo included (CSS px). Default: 40 */
  listenerSize?: number
}
type Description = { thunder?: ThunderOptions }
export type ThunderConfig = MeshConfigWithSelectiveEffect & Description
type ThunderUpdate = MeshUpdateWithSelectiveEffect & Description

const DEFAULTS = {
  boltColor: new Color().setStyle('#ece6ff'),
  glowColor: new Color().setStyle('#a99bff'),
  ringColor: new Color().setStyle('#ffae4f'),
  listenerColor: new Color().setStyle('#fff6e8'),
  listenerSize: 40,
}

// Glow sprites: two per strike (the cloud and the ground under it)
const MAX_STRIKES = 96
// Earth's radius, to bend the rings down onto the ground
const EARTH_R = 6_371_000
// Rings sit this high (m), drawn without the depth test
const RING_LIFT = 15
// Ripples inside the band (m apart): the rumble rolling
const RIPPLE = 700
// Rings fade out as they go, gone RING_LIFE s after the strike (~10 km out), so they don't pile up
export const RING_LIFE = 30

const vec = (c: Color) => new Vector3(...c.toArray())

// Bolts are ribbons: each segment a quad, widened on screen across the segment. aSide is -1/1 for
// the two edges; the width is uWidth m, kept within uMinPx-uMaxPx on screen
const boltVertex = /* glsl */ `
  attribute vec3 aOther;
  attribute float aSide;
  attribute float aFlip;
  attribute float aT;
  attribute float aWeight;
  uniform vec2 uViewport;
  uniform float uWidth;
  uniform float uMinPx;
  uniform float uMaxPx;
  varying float vT;
  varying float vWeight;
  varying float vSide;
  void main() {
    vT = aT;
    vWeight = aWeight;
    vSide = aSide;
    vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    vec4 q = projectionMatrix * modelViewMatrix * vec4(aOther, 1.0);
    vec2 dir = normalize((q.xy / q.w - p.xy / p.w) * uViewport + 1e-6) * aFlip;
    vec2 across = vec2(-dir.y, dir.x);
    float px = clamp(uWidth * projectionMatrix[1][1] * uViewport.y * 0.5 / p.w, uMinPx, uMaxPx) * mix(0.5, 1.0, aWeight);
    p.xy += across * aSide * px / uViewport * p.w;
    gl_Position = p;
  }
`
// setupMaterialForMRT appends the G-buffer writes before main()'s closing brace: keep main() last
const boltFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uFlash;
  uniform float uReach;
  varying float vT;
  varying float vWeight;
  varying float vSide;
  void main() {
    vec3 normal = vec3(0.0, 0.0, 1.0); // read by the G-buffer write appended below
    if (vT > uReach || uFlash <= 0.001) discard;
    // A white-hot core, softer to the edges
    float core = 1.0 - vSide * vSide;
    gl_FragColor = vec4(uColor * uFlash * vWeight * (0.4 + 2.6 * core), 1.0);
  }
`

const ringVertex = /* glsl */ `
  attribute float aEdge;
  uniform float uInner;
  uniform float uOuter;
  varying float vR;
  void main() {
    float r = mix(uInner, uOuter, aEdge);
    vR = r;
    // The flat local frame rises off the curved ground: bring the ring back down
    vec3 p = position * r + vec3(0.0, ${RING_LIFT.toFixed(1)} - r * r / ${(2 * EARTH_R).toFixed(1)}, 0.0);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`
const ringFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOuter;
  uniform float uStrength;
  uniform float uFill;
  uniform float uHeight;
  varying float vR;
  void main() {
    vec3 normal = vec3(0.0, 0.0, 1.0); // read by the G-buffer write appended below
    // As bright as the thunder is loud there (its source uHeight m up), and gone by ${AUDIBLE / 1000} km
    float fade = 1.0 / (1.0 + length(vec2(vR, uHeight)) / ${HALF_LOUD.toFixed(1)});
    fade *= smoothstep(${AUDIBLE.toFixed(1)}, ${(AUDIBLE * 0.8).toFixed(1)}, vR);
    // The band (uFill > 0) rolls with ripples, brightest just behind the front; the front
    // itself (uFill = 0) is a crisp line
    float behind = uOuter - vR;
    float ripple = 0.3 + 0.7 * cos(6.2831853 * behind / ${RIPPLE.toFixed(1)});
    float a = uFill > 0.0 ? uFill * max(ripple, 0.0) * (0.3 + 0.7 * exp(-behind / 1500.0)) : 1.0;
    gl_FragColor = vec4(uColor * a * fade * uStrength, 1.0);
  }
`

const glowVertex = /* glsl */ `
  attribute float aAlpha;
  attribute float aSize;
  uniform float uPixelRatio;
  uniform vec2 uViewport;
  varying float vAlpha;
  void main() {
    vAlpha = aAlpha;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    // aSize is in metres: to pixels at this depth
    gl_PointSize = aAlpha <= 0.0 ? 0.0 : min(2048.0, aSize * projectionMatrix[1][1] * uViewport.y * 0.5 / gl_Position.w) * uPixelRatio;
  }
`
const glowFragment = /* glsl */ `
  uniform vec3 uColor;
  varying float vAlpha;
  void main() {
    vec3 normal = vec3(0.0, 0.0, 1.0); // read by the G-buffer write appended below
    float d = length(gl_PointCoord - 0.5) * 2.0;
    if (d > 1.0 || vAlpha <= 0.0) discard;
    // Falls smoothly to 0 at the sprite's edge, so no rim shows (the bloom would pick one out)
    float k = 1.0 - d * d;
    float a = k * k * k * vAlpha;
    gl_FragColor = vec4(uColor * a, 1.0);
  }
`

// The listener: a person standing on the spot (the sprite is lifted so the feet are on it)
const FEET = 0.8 // where the feet are in the icon, from its top
const listenerVertex = /* glsl */ `
  uniform float uSize;
  uniform float uPixelRatio;
  uniform vec2 uViewport;
  void main() {
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position.y += ${(FEET - 0.5).toFixed(3)} * uSize / uViewport.y * 2.0 * gl_Position.w;
    gl_PointSize = uSize * uPixelRatio;
  }
`
const listenerFragment = /* glsl */ `
  uniform sampler2D uIcon;
  uniform vec3 uColor;
  uniform vec3 uRingColor;
  uniform float uFlare;
  void main() {
    vec3 normal = vec3(0.0, 0.0, 1.0); // read by the G-buffer write appended below
    vec2 uv = gl_PointCoord;
    vec4 icon = texture2D(uIcon, uv);
    // A halo in the rings' color round the person while the thunder is heard
    float d = length(uv - vec2(0.5, 0.55)) * 2.0;
    float halo = pow(max(0.0, 1.0 - d), 2.0) * uFlare;
    // The icon's red is the figure, its alpha the dark outline that keeps it readable
    vec3 c = uColor * icon.r * 1.4 + uRingColor * halo * 2.5 * (1.0 - icon.a);
    if (icon.a < 0.01 && halo < 0.01) discard;
    gl_FragColor = vec4(c, 1.0);
  }
`

// The person, drawn once on a canvas: head and shoulders, with a dark outline
function personIcon(): CanvasTexture {
  const n = 128
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = n
  const g = canvas.getContext('2d')!
  const figure = new Path2D()
  figure.arc(64, 36, 15, 0, Math.PI * 2)
  // Body, from the shoulders down to the feet at FEET
  const [top, feet] = [56, n * FEET]
  figure.moveTo(40, feet)
  figure.lineTo(42, top + 12)
  figure.quadraticCurveTo(43, top, 55, top)
  figure.lineTo(73, top)
  figure.quadraticCurveTo(85, top, 86, top + 12)
  figure.lineTo(88, feet)
  figure.closePath()
  // Outline (alpha) in black, figure (red) in white: the shader reads the two apart
  g.lineJoin = 'round'
  g.lineWidth = 12
  g.strokeStyle = '#000'
  g.stroke(figure)
  g.fillStyle = '#fff'
  g.fill(figure)
  const texture = new CanvasTexture(canvas)
  texture.flipY = false
  return texture
}

type Live = {
  strike: Strike
  group: Group
  bolt?: ShaderMaterial
  boltGeom?: BufferGeometry
  band: ShaderMaterial
  front: ShaderMaterial
  foot: Vector3
  cloud: Vector3
}

export class ThunderMeshDesc extends MeshDescWithSelectiveEffect<ThunderConfig, ThunderUpdate, Group> {
  private config: ThunderConfig
  private root?: Group
  private live: Live[] = []
  private mask: IUniform<number> = { value: 0 }
  private glows?: Points<BufferGeometry, ShaderMaterial>
  private listener?: Points<BufferGeometry, ShaderMaterial>
  private materials = new Set<ShaderMaterial>()
  private viewport: IUniform<Vector2> = { value: new Vector2(1, 1) }
  private icon = personIcon()
  // Shared by every strike's rings
  private bandGeometry?: BufferGeometry
  private frontGeometry?: BufferGeometry

  constructor(...args: ConstructorParameters<typeof MeshDescWithSelectiveEffect<ThunderConfig, ThunderUpdate>>) {
    super(...args)
    this.config = args[2] ?? {}
  }

  private get options() {
    return { ...DEFAULTS, ...this.config.thunder }
  }

  private material(vertexShader: string, fragmentShader: string, uniforms: Record<string, IUniform>, depthTest = true) {
    const material = new ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms,
      transparent: true,
      depthWrite: false,
      depthTest,
      side: DoubleSide,
      blending: AdditiveBlending,
    })
    // Selective bloom: the shader's color is written to the emissive buffer as is
    material.defines.USE_SELECTIVE_EFFECT = 1
    material.userData.uEffectIdsMask = this.mask
    material.uniforms.uEffectIdsMask = this.mask
    material.uniforms.uEmissiveColor = { value: new Vector3() }
    material.uniforms.uEmissiveIntensity = { value: 1 }
    setupMaterialForMRT(material)
    this.materials.add(material)
    return material
  }

  override createMesh() {
    const opts = this.options
    const root = new Group()
    this.root = root

    // A unit circle in the local frame's ground plane (x west, z north), as a band's two edges
    // and as a loop for its front
    const SEG = 256
    const band = new Float32Array((SEG + 1) * 6)
    const edge = new Float32Array((SEG + 1) * 2)
    const loop = new Float32Array(SEG * 3)
    for (let i = 0; i <= SEG; i++) {
      const a = (i / SEG) * Math.PI * 2
      const [x, z] = [Math.cos(a), Math.sin(a)]
      band.set([x, 0, z, x, 0, z], i * 6)
      edge.set([0, 1], i * 2)
      if (i < SEG) loop.set([x, 0, z], i * 3)
    }
    const index: number[] = []
    for (let i = 0; i < SEG; i++) {
      const [a, b, c, d] = [i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 3]
      index.push(a, b, c, b, d, c)
    }
    this.bandGeometry = new BufferGeometry()
    this.bandGeometry.setAttribute('position', new Float32BufferAttribute(band, 3))
    this.bandGeometry.setAttribute('aEdge', new Float32BufferAttribute(edge, 1))
    this.bandGeometry.setIndex(index)
    this.frontGeometry = new BufferGeometry()
    this.frontGeometry.setAttribute('position', new Float32BufferAttribute(loop, 3))
    this.frontGeometry.setAttribute('aEdge', new Float32BufferAttribute(new Float32Array(SEG).fill(1), 1))

    // Glows: the cloud and the ground under each strike
    const glowGeometry = new BufferGeometry()
    glowGeometry.setAttribute('position', new Float32BufferAttribute(new Float32Array(MAX_STRIKES * 6), 3))
    glowGeometry.setAttribute('aAlpha', new Float32BufferAttribute(new Float32Array(MAX_STRIKES * 2), 1))
    glowGeometry.setAttribute('aSize', new Float32BufferAttribute(new Float32Array(MAX_STRIKES * 2), 1))
    this.glows = new Points(
      glowGeometry,
      this.material(glowVertex, glowFragment, {
        uColor: { value: vec(opts.glowColor) },
        uPixelRatio: { value: window.devicePixelRatio },
        uViewport: this.viewport,
      }),
    )
    // The view's size, for the shaders that size things on screen (CSS px)
    this.glows.onBeforeRender = (renderer) => {
      const el = renderer.domElement
      this.viewport.value.set(el.clientWidth || 1, el.clientHeight || 1)
    }

    const listenerGeometry = new BufferGeometry()
    listenerGeometry.setAttribute('position', new Float32BufferAttribute(new Float32Array(3), 3))
    this.listener = new Points(
      listenerGeometry,
      this.material(
        listenerVertex,
        listenerFragment,
        {
          uIcon: { value: this.icon },
          uColor: { value: vec(opts.listenerColor) },
          uRingColor: { value: vec(opts.ringColor) },
          uFlare: { value: 0 },
          uSize: { value: opts.listenerSize },
          uPixelRatio: { value: window.devicePixelRatio },
          uViewport: this.viewport,
        },
        false,
      ),
    )

    // Positions are ECEF or move every frame: skip bounds-based culling
    this.glows.frustumCulled = false
    this.listener.frustumCulled = false
    root.add(this.glows, this.listener)
    return root
  }

  /** Puts the listener's marker at `lng`, `lat`. */
  setListener(lng: number, lat: number): void {
    const p = geodeticToVector3({ lng, lat, height: RING_LIFT })
    const position = this.listener?.geometry.getAttribute('position') as Float32BufferAttribute | undefined
    position?.setXYZ(0, p.x, p.y, p.z)
    if (position) position.needsUpdate = true
  }

  /** Lets a strike flash, from its `time` on. */
  add(strike: Strike): void {
    if (!this.root || this.live.length >= MAX_STRIKES) return
    const opts = this.options
    const group = new Group()
    group.matrixAutoUpdate = false
    group.matrix.copy(headingPitchRollToFixedFrame({ lng: strike.lng, lat: strike.lat, height: 0 }))
    group.matrixWorldNeedsUpdate = true

    let bolt: ShaderMaterial | undefined
    let boltGeom: BufferGeometry | undefined
    if (!strike.cloudOnly) {
      bolt = this.material(boltVertex, boltFragment, {
        uColor: { value: vec(opts.boltColor) },
        uFlash: { value: 0 },
        uReach: { value: 0 },
        uViewport: this.viewport,
        uWidth: { value: 30 },
        uMinPx: { value: 2 },
        uMaxPx: { value: 7 },
      })
      boltGeom = boltGeometry(strike.base)
      const ribbon = new Mesh(boltGeom, bolt)
      ribbon.frustumCulled = false
      group.add(ribbon)
    }
    const ringUniforms = (fill: number) => ({
      uColor: { value: vec(opts.ringColor) },
      uInner: { value: 0 },
      uOuter: { value: 0 },
      uStrength: { value: 0 },
      uFill: { value: fill },
      uHeight: { value: strike.cloudOnly ? strike.base : 0 },
    })
    const band = this.material(ringVertex, ringFragment, ringUniforms(0.6), false)
    const front = this.material(ringVertex, ringFragment, ringUniforms(0), false)
    const bandMesh = new Mesh(this.bandGeometry, band)
    const frontLoop = new LineLoop(this.frontGeometry, front)
    bandMesh.frustumCulled = false
    frontLoop.frustumCulled = false
    group.add(bandMesh, frontLoop)
    this.root.add(group)

    this.live.push({
      strike,
      group,
      bolt,
      boltGeom,
      band,
      front,
      foot: geodeticToVector3({ lng: strike.lng, lat: strike.lat, height: 30 }),
      cloud: geodeticToVector3({ lng: strike.lng, lat: strike.lat, height: strike.base + 600 }),
    })
  }

  /** Advances everything to `now` (s); `flare` lights the listener's halo (0-1). */
  tick(now: number, flare: number): void {
    if (!this.glows || !this.listener) return
    const position = this.glows.geometry.getAttribute('position') as Float32BufferAttribute
    const alpha = this.glows.geometry.getAttribute('aAlpha') as Float32BufferAttribute
    const size = this.glows.geometry.getAttribute('aSize') as Float32BufferAttribute
    alpha.array.fill(0)

    this.live = this.live.filter((l) => {
      const s = l.strike
      const t = now - s.time
      // Gone once its ring has faded out
      if (t > RING_LIFE || frontAt(s, t, s.span) > AUDIBLE) {
        this.drop(l)
        return false
      }
      return true
    })
    this.live.forEach((l, i) => {
      const s = l.strike
      const t = now - s.time
      const flash = flashAt(s, t)
      if (l.bolt) {
        l.bolt.uniforms.uFlash!.value = flash
        l.bolt.uniforms.uReach!.value = reachAt(t)
      }
      const outer = frontAt(s, t)
      const inner = frontAt(s, t, s.span)
      for (const m of [l.band, l.front]) {
        m.uniforms.uOuter!.value = outer
        m.uniforms.uInner!.value = m === l.front ? outer : inner
        // Fade in as the sound leaves, so no dot sits at the strike, then out with time: the
        // sound weakening as it goes (on top of each part's own loudness, in the shader)
        m.uniforms.uStrength!.value = outer > 0 ? Math.min(1, outer / 800) * (1 - t / RING_LIFE) : 0
      }
      position.setXYZ(i * 2, l.cloud.x, l.cloud.y, l.cloud.z)
      alpha.setX(i * 2, Math.min(1.5, flash) * (s.cloudOnly ? 1.2 : 0.9))
      size.setX(i * 2, s.cloudOnly ? 9000 : 7000)
      position.setXYZ(i * 2 + 1, l.foot.x, l.foot.y, l.foot.z)
      alpha.setX(i * 2 + 1, s.cloudOnly ? 0 : Math.min(1.5, flash) * 0.6)
      size.setX(i * 2 + 1, 4000)
    })
    position.needsUpdate = true
    alpha.needsUpdate = true
    size.needsUpdate = true
    this.listener.material.uniforms.uFlare!.value = flare
  }

  private drop(l: Live): void {
    this.root?.remove(l.group)
    // (the rings' geometries are shared)
    l.boltGeom?.dispose()
    for (const m of [l.bolt, l.band, l.front]) {
      if (!m) continue
      m.dispose()
      this.materials.delete(m)
    }
  }

  protected override updateEffectIdsMask(): void {
    const registry = this.ctx.selectiveEffectRegistry
    if (!registry) return
    this.mask.value = this._effectIds.length > 0 ? registry.computeMask(this._effectIds) : 0
  }

  override onDestroy(): void {
    super.onDestroy()
    for (const l of this.live) this.drop(l)
    this.live = []
    this.glows?.geometry.dispose()
    this.listener?.geometry.dispose()
    this.bandGeometry?.dispose()
    this.frontGeometry?.dispose()
    this.icon.dispose()
    for (const m of this.materials) m.dispose()
    this.materials.clear()
  }
}

/**
 * A bolt from the cloud base `base` m up down to the ground, in the local frame (x west, y up,
 * z north): a main channel that zigzags down in short steps, with branches that fork off it and
 * die out in the air, as ribbons (see boltVertex). Each vertex carries how far down the bolt it is (aT: 0 at the cloud, 1 at
 * the ground, for the leader) and how bright its channel is (aWeight).
 */
function boltGeometry(base: number): BufferGeometry {
  const pos: number[] = []
  const others: number[] = []
  const sides: number[] = []
  const flips: number[] = []
  const ts: number[] = []
  const weights: number[] = []
  const index: number[] = []
  const rnd = (a: number, b: number) => a + Math.random() * (b - a)

  // The channel leans a little on the way down
  const STEPS = 48
  const step = base / STEPS
  const lean = new Vector3(rnd(-1, 1), 0, rnd(-1, 1)).multiplyScalar(base * 0.25)
  const main: Vector3[] = [new Vector3(lean.x, base, lean.z)]
  for (let i = 1; i <= STEPS; i++) {
    const prev = main[i - 1]!
    const y = i === STEPS ? 0 : base - i * step
    // Pulled toward a straight line to the foot (the origin), with a jitter on top
    const k = 1 - y / base
    const target = lean.clone().multiplyScalar(1 - k)
    const p = new Vector3(
      prev.x + (target.x - prev.x) * 0.3 + rnd(-1, 1) * step * 0.9,
      y,
      prev.z + (target.z - prev.z) * 0.3 + rnd(-1, 1) * step * 0.9,
    )
    if (i === STEPS) p.set(0, 0, 0)
    main.push(p)
  }
  // A quad per segment: both edges at each end. Seen from the far end the segment runs the other
  // way, so the far end flips its direction back (aFlip)
  const segment = (a: Vector3, b: Vector3, weight: number) => {
    const i = pos.length / 3
    for (const [p, o, side, flip] of [[a, b, -1, 1], [a, b, 1, 1], [b, a, -1, -1], [b, a, 1, -1]] as const) {
      pos.push(p.x, p.y, p.z)
      others.push(o.x, o.y, o.z)
      sides.push(side)
      flips.push(flip)
      ts.push(1 - p.y / base)
      weights.push(weight)
    }
    index.push(i, i + 1, i + 3, i, i + 3, i + 2)
  }
  for (let i = 0; i < STEPS; i++) segment(main[i]!, main[i + 1]!, 1)

  // Branches: they fork off the upper part and fade toward their tips
  const branches = Math.round(rnd(3, 7))
  for (let b = 0; b < branches; b++) {
    let p = main[Math.floor(rnd(2, STEPS * 0.7))]!.clone()
    const dir = new Vector3(rnd(-1, 1), 0, rnd(-1, 1)).normalize()
    const n = Math.round(rnd(6, 16))
    for (let j = 0; j < n && p.y > step; j++) {
      const q = new Vector3(
        p.x + dir.x * step * 0.8 + rnd(-1, 1) * step * 0.7,
        p.y - step * rnd(0.6, 1.1),
        p.z + dir.z * step * 0.8 + rnd(-1, 1) * step * 0.7,
      )
      segment(p, q, 0.45 * (1 - j / n))
      p = q
    }
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(pos, 3))
  geometry.setAttribute('aOther', new Float32BufferAttribute(others, 3))
  geometry.setAttribute('aSide', new Float32BufferAttribute(sides, 1))
  geometry.setAttribute('aFlip', new Float32BufferAttribute(flips, 1))
  geometry.setIndex(index)
  geometry.setAttribute('aT', new Float32BufferAttribute(ts, 1))
  geometry.setAttribute('aWeight', new Float32BufferAttribute(weights, 1))
  return geometry
}
