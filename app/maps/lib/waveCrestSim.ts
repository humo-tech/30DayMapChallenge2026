// The world's ocean waves as crests: little flat "^" marks, each lying across the way the waves go
// and running that way at their phase speed (the longer the period, the faster), colored by the
// wave height. Shown by Navara (WaveCrestMeshDesc.ts) or MapLibre (waveGlobeLayer.ts).
//
// - The marks are the streamlines' crests (waveStreamSim.ts): particles born anywhere on the
//   square, carried the way the waves go, born again after a second or two; slower than the
//   other looks' (`pace`), so they read as an easy swell, and fewer, so each stands apart.
// - Each frame they're drawn afresh, as point sprites, into a texture on the square: the sprite
//   turned to the waves' way there, the "^" drawn in it (its apex ahead), fading in and out with
//   the mark's life. The longer the period, the longer the mark.
// - Behind each, a thin tail that shows the flow even at that pace: a dot dropped where the mark
//   is into a second texture, which fades each frame (as the streamlines' wake, unadvected), so
//   it draws the path the mark came along. (The marks themselves left to fade would smear into
//   solid blobs, each "^" swept along its own length.)
// - The shell over the sea shows that texture, over a faint wash of the height's color.
import {
  BufferGeometry,
  CustomBlending,
  Float32BufferAttribute,
  FloatType,
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  NearestFilter,
  OneFactor,
  OneMinusSrcAlphaFactor,
  Points,
  RGBAFormat,
  Scene,
  Vector2,
  WebGLRenderTarget,
  type IUniform,
  type ShaderMaterial,
  type WebGLRenderer,
} from 'three'
import { WaveSim, domainChunk, resampleFragment, travelChunk, waveChunk, type Domain, type WaveGrid } from './waveSim'
import { particleFragment } from './waveStreamSim'

export type WaveCrestOptions = {
  /** Marks: this squared. Default: 40 */
  marks?: number
  /** The texture they're drawn into, this squared. Default: 2048 */
  size?: number
}

export const CREST_DEFAULTS = {
  /** A 10 s swell's mark, across (texels of the square's texture) */
  size: 34,
  /** How bright the marks show */
  brightness: 1,
  /** How fast the marks run, against the other looks' crests: slower, for the swell's ease */
  pace: 0.35,
  /** A mark lives this long (s) before it's born again elsewhere: briefly, rising and settling
   * like a single wave */
  lifeMin: 1.2,
  lifeMax: 2.8,
  /** Its tail fades to 1/e in this long (s) */
  tail: 0.25,
}
export type CrestParams = typeof CREST_DEFAULTS

// The wave height (m) to color: navy in a calm, blue, cyan, pale, and near white over 10 m, the
// very highest a touch warm (the same colors as the power's ramp)
const heightRampChunk = /* glsl */ `
  vec3 heightRamp(float h) {
    float t = clamp(log(1.0 + h) / log(1.0 + 12.0), 0.0, 1.0);
    vec3 c = mix(vec3(0.02, 0.06, 0.28), vec3(0.04, 0.24, 0.72), smoothstep(0.0, 0.38, t));
    c = mix(c, vec3(0.08, 0.62, 0.95), smoothstep(0.32, 0.62, t));
    c = mix(c, vec3(0.48, 0.82, 0.95), smoothstep(0.58, 0.82, t));
    return mix(c, vec3(0.95, 0.92, 0.82), smoothstep(0.8, 1.0, t));
  }
`

// One sprite per mark, found by gl_VertexID: on the square where the mark is, turned to the way
// the waves go there, as long as the period
const markVertex = /* glsl */ `
  ${waveChunk}
  ${domainChunk}
  uniform vec3 uDomain;
  ${travelChunk}
  ${heightRampChunk}
  uniform sampler2D uState;
  uniform float uSide;
  uniform float uSize;
  varying vec2 vDir;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    int n = int(uSide);
    vec4 s = texelFetch(uState, ivec2(gl_VertexID % n, gl_VertexID / n), 0);
    Wave w = wave(s.xy);
    float front, ahead;
    vec2 at = toDomain(s.xy, uDomain, front);
    // The way the waves go, on the square
    vec2 next = toDomain(s.xy + travel(w, s.xy, 0.05, 1.0), uDomain, ahead);
    vec2 d = next - at;
    vDir = d / max(length(d), 1e-9);
    vColor = heightRamp(w.height);
    // In over the first third of its life, out over the last half
    float fade = smoothstep(0.0, 0.35 * s.w, s.z) * smoothstep(0.0, 0.5 * s.w, s.w - s.z);
    vAlpha = front > 0.0 ? fade * smoothstep(0.5, 1.0, w.sea) * smoothstep(0.3, 0.7, w.steady) : 0.0;
    gl_Position = vec4(at * 2.0 - 1.0, 0.0, 1.0);
    gl_PointSize = vAlpha > 0.0 ? uSize * (0.7 + 0.3 * w.period / 10.0) : 0.0;
  }
`
// The tail's dot, round
const dotFragment = /* glsl */ `
  uniform float uBrightness;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    float a = (1.0 - smoothstep(0.25, 0.5, length(gl_PointCoord - 0.5))) * vAlpha;
    if (a <= 0.0) discard;
    gl_FragColor = vec4(vColor * uBrightness * a, a);
  }
`

// The mark: a flat "^" across the waves' way, its apex (rounded) pointing the way they go,
// tapered at its ends
const markFragment = /* glsl */ `
  uniform float uBrightness;
  varying vec2 vDir;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec2 p = gl_PointCoord - 0.5;
    p.y = -p.y;
    float along = dot(p, vDir);
    float across = dot(p, vec2(-vDir.y, vDir.x));
    float curve = 0.2 * (1.0 - sqrt(across * across + 0.0025) / 0.42) - 0.09;
    float line = 1.0 - smoothstep(0.035, 0.07, abs(along - curve));
    float ends = 1.0 - smoothstep(0.34, 0.44, abs(across));
    float a = line * ends * vAlpha;
    if (a <= 0.0) discard;
    gl_FragColor = vec4(vColor * uBrightness * a, a);
  }
`

// Navara appends its G-buffer writes (which read `normal`) before main()'s closing brace: keep
// main() last
const shellFragment = /* glsl */ `
  ${waveChunk}
  ${domainChunk}
  ${heightRampChunk}
  uniform vec3 uDomain;
  uniform sampler2D uMarks;
  uniform sampler2D uTails;
  varying vec2 vGeo;
  void main() {
    vec3 normal = vec3(0.0, 0.0, 1.0); // read by Navara's G-buffer write, if appended
    vec2 ll = vec2(vGeo.x * 360.0 - 180.0, vGeo.y * 180.0 - 90.0);
    float front;
    vec2 uv = toDomain(ll, uDomain, front);
    if (front <= 0.0 || !inside(uv)) discard;
    Wave w = wave(ll);
    if (w.sea <= 0.0) discard;
    vec4 marks = texture2D(uMarks, uv);
    vec4 tails = texture2D(uTails, uv);
    // A faint wash of the height's color under the marks
    vec3 wash = heightRamp(w.height) * 0.12;
    gl_FragColor = vec4((wash + tails.rgb * 0.6 + marks.rgb) * smoothstep(0.0, 0.6, w.sea), 1.0);
  }
`

const clearFragment = /* glsl */ `
  void main() { gl_FragColor = vec4(0.0); }
`

// The last frame's tails, faded
const fadeFragment = /* glsl */ `
  varying vec2 vUv;
  uniform sampler2D uSource;
  uniform float uDecay;
  void main() { gl_FragColor = texture2D(uSource, vUv) * uDecay; }
`

// The tail's width (texels of the square's texture, for a 10 s swell)
const TAIL_WIDTH = 3

type PingPong = [WebGLRenderTarget, WebGLRenderTarget]
const swap = (pair: PingPong) => pair.reverse()

export class WaveCrestSim extends WaveSim {
  readonly shellFragment = shellFragment
  readonly shellUniforms: Record<string, IUniform>
  private state: PingPong
  private marks: WebGLRenderTarget
  private tails: PingPong
  private passes: Record<string, ShaderMaterial>
  private sprites: ShaderMaterial
  private dots: ShaderMaterial
  // The marks, and their tails' dots, drawn into their textures
  private markScene = new Scene()
  private dotScene = new Scene()
  private fresh = true
  /** Tunable as it runs */
  params: CrestParams = { ...CREST_DEFAULTS }

  constructor(grid: WaveGrid, { marks = 40, size = 2048 }: WaveCrestOptions = {}) {
    super()
    const geo = this.fieldUniforms(grid)

    const stateTarget = () =>
      this.track(
        new WebGLRenderTarget(marks, marks, {
          type: FloatType,
          format: RGBAFormat,
          minFilter: NearestFilter,
          magFilter: NearestFilter,
          depthBuffer: false,
          generateMipmaps: false,
        }),
      )
    this.state = [stateTarget(), stateTarget()]
    // Mipmapped, for when the whole globe is in view
    const target = () =>
      this.track(
        new WebGLRenderTarget(size, size, {
          type: HalfFloatType,
          format: RGBAFormat,
          minFilter: LinearMipmapLinearFilter,
          magFilter: LinearFilter,
          depthBuffer: false,
          generateMipmaps: true,
        }),
      )
    this.marks = target()
    this.tails = [target(), target()]

    this.passes = {
      clear: this.pass(clearFragment),
      fade: this.pass(fadeFragment, { uSource: { value: null }, uDecay: { value: 1 } }),
      resample: this.pass(resampleFragment, {
        uSource: { value: null },
        uOld: { value: [0, 0, 1] },
        uNew: { value: [0, 0, 1] },
        uVector: { value: 0 },
        uSimTexel: { value: new Vector2() },
      }),
      step: this.pass(particleFragment, {
        ...geo(),
        uState: { value: null },
        uDt: { value: 0 },
        uSeed: { value: 0 },
        uInit: { value: 1 },
        uLife: { value: [0, 0] },
      }),
    }
    // One vertex per mark; the shaders find its texel by gl_VertexID. Premultiplied "over"
    const geometry = this.track(new BufferGeometry())
    geometry.setAttribute('position', new Float32BufferAttribute(new Float32Array(marks * marks * 3), 3))
    const sprites = (fragment: string, scene: Scene) => {
      const m = this.pass(fragment, { ...geo(), uState: { value: null }, uSide: { value: marks }, uSize: { value: 0 }, uBrightness: { value: 0 } }, markVertex)
      m.blending = CustomBlending
      m.blendSrc = OneFactor
      m.blendDst = OneMinusSrcAlphaFactor
      m.transparent = true
      const points = new Points(geometry, m)
      points.frustumCulled = false
      scene.add(points)
      return m
    }
    this.sprites = sprites(markFragment, this.markScene)
    this.dots = sprites(dotFragment, this.dotScene)

    this.shellUniforms = { ...geo(), uMarks: { value: this.marks.texture }, uTails: { value: this.tails[0].texture } }
  }

  protected override begin(renderer: WebGLRenderer): void {
    for (const t of this.tails) this.run(renderer, this.passes.clear!, t)
    this.fresh = true
  }

  // The marks are on the globe, not the square: only their tails move over
  protected override carry(renderer: WebGLRenderer, from: Domain, to: Domain): void {
    this.run(renderer, this.passes.resample!, this.tails[1], { uSource: this.tails[0].texture, uOld: from, uNew: to })
    swap(this.tails)
  }

  protected override simulate(renderer: WebGLRenderer, dt: number, domain: Domain) {
    const [state, p, q] = [this.state, this.passes, this.params]
    this.run(renderer, p.step!, state[1], {
      uState: state[0].texture,
      uDomain: domain,
      uSpeed: this.speed * q.pace,
      uLife: [q.lifeMin, Math.max(q.lifeMin, q.lifeMax)],
      uDt: dt,
      uSeed: Math.random() * 1000,
      uInit: this.fresh ? 1 : 0,
    })
    swap(state)
    this.fresh = false
    for (const [m, size] of [[this.sprites, q.size], [this.dots, TAIL_WIDTH]] as const) {
      const u = m.uniforms
      u.uState!.value = state[0].texture
      u.uDomain!.value = domain
      u.uSize!.value = size
      u.uBrightness!.value = q.brightness
    }
    // The tails: the last frame's faded, and a dot where each mark is now
    const tails = this.tails
    this.run(renderer, p.fade!, tails[1], { uSource: tails[0].texture, uDecay: Math.exp(-dt / Math.max(q.tail, 0.01)) })
    this.draw(renderer, this.dotScene, tails[1])
    swap(tails)
    // The marks, drawn afresh
    this.run(renderer, p.clear!, this.marks)
    this.draw(renderer, this.markScene, this.marks)
    return { uTails: tails[0].texture }
  }
}
