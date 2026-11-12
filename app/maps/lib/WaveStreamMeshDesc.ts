// The world's ocean waves as streamlines, for Navara, worked out on the GPU over the part of the
// globe in view (see waveField.ts).
//
// - Crests: particles (one per texel of a float state texture, ping-ponged), born anywhere on the
//   square and carried the way the waves go at their phase speed (gT/2π, relative: the longer
//   the period, the faster), then born again.
// - Their energy: a trail on the square, which each frame is advected at the group speed, half
//   the phase speed in deep water (each texel looks back to where it came from), and fades,
//   before the crests are drawn into it. The crests outrun their own energy, so they leave a wake
//   that the flow bends and stretches.
// - The shell over the sea shows the trail, colored by the wave power there, P ≈ 0.49 Hs² T kW/m.
import type { MeshConfigWithSelectiveEffect } from '@navaramap/three'
import {
  AdditiveBlending,
  BufferGeometry,
  Float32BufferAttribute,
  FloatType,
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  NearestFilter,
  Points,
  RGBAFormat,
  RedFormat,
  Scene,
  Vector2,
  WebGLRenderTarget,
  type Mesh,
  type ShaderMaterial,
  type WebGLRenderer,
} from 'three'
import {
  PHASE_SPEED,
  WaveDomainMeshDesc,
  domainChunk,
  rampChunk,
  resampleFragment,
  travelChunk,
  varyings,
  waveChunk,
  type Domain,
  type WaveGrid,
} from './waveField'

type WaveStreamOptions = {
  grid?: WaveGrid
  /** Particles: this squared. Default: 384 */
  particles?: number
  /** The trail's texture, this squared. Default: 2048 */
  trailSize?: number
}
export type WaveStreamConfig = MeshConfigWithSelectiveEffect & { waveStream?: WaveStreamOptions }

// A crest lives this long (s) before it's born again elsewhere
const LIFE: [number, number] = [2.5, 7]
// The wake fades to 1/e in this long (s)
const FADE = 1.6

const hashChunk = /* glsl */ `
  float hash(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
`
// The crests' state, one per texel: lng, lat, age, life
const particleFragment = /* glsl */ `
  ${waveChunk}
  ${domainChunk}
  ${hashChunk}
  uniform vec3 uDomain;
  ${travelChunk}
  uniform sampler2D uState;
  uniform float uDt;
  uniform float uSeed;
  uniform float uInit;
  uniform vec2 uLife;
  void main() {
    vec4 s = texelFetch(uState, ivec2(gl_FragCoord.xy), 0);
    Wave w = wave(s.xy);
    float front;
    vec2 at = toDomain(s.xy, uDomain, front);
    // Where two seas meet head on the crests would pile up along the line: they end there; and
    // when they leave the square
    if (uInit > 0.5 || s.z >= s.w || w.sea < 0.5 || w.steady < 0.3 || front <= 0.0 || !inside(at)) {
      // Born again anywhere on the square (off the globe or on land, it tries again next frame)
      vec2 seed = gl_FragCoord.xy + uSeed;
      vec2 ll;
      float life = mix(uLife.x, uLife.y, hash(seed + 31.0));
      if (!fromDomain(vec2(hash(seed), hash(seed + 17.0)), uDomain, ll)) life = 0.0;
      // At the start, spread over their lives so they don't all go at once
      gl_FragColor = vec4(ll, uInit > 0.5 ? hash(seed + 47.0) * life : 0.0, life);
      return;
    }
    // Midpoint step, so the crests bend round with the swell
    vec2 mid = s.xy + travel(w, s.xy, uDt * 0.5, ${PHASE_SPEED.toFixed(4)});
    Wave wm = wave(mid);
    if (wm.sea <= 0.0) wm = w;
    vec2 p = s.xy + travel(wm, mid, uDt, ${PHASE_SPEED.toFixed(4)});
    p.x = mod(p.x + 180.0, 360.0) - 180.0;
    p.y = clamp(p.y, -89.0, 89.0);
    gl_FragColor = vec4(p, s.z + uDt, s.w);
  }
`

// The wake: each texel takes what was upstream of it, a group speed's step back, and fades
const advectFragment = /* glsl */ `
  ${varyings}
  ${waveChunk}
  ${domainChunk}
  uniform vec3 uDomain;
  ${travelChunk}
  uniform sampler2D uTrail;
  uniform float uDt;
  uniform float uDecay;
  void main() {
    vec2 ll;
    if (!fromDomain(vUv, uDomain, ll)) { gl_FragColor = vec4(0.0); return; }
    Wave w = wave(ll);
    float front;
    vec2 from = toDomain(ll - travel(w, ll, uDt, ${(PHASE_SPEED / 2).toFixed(4)}), uDomain, front);
    float prev = textureLod(uTrail, from, 0.0).r;
    gl_FragColor = vec4(prev * uDecay * smoothstep(0.0, 0.5, w.sea), 0.0, 0.0, 1.0);
  }
`

// The crests, drawn into the wake: as bright as the waves are high, fading in and out
const depositVertex = /* glsl */ `
  ${waveChunk}
  ${domainChunk}
  uniform vec3 uDomain;
  uniform sampler2D uState;
  uniform float uSide;
  varying float vBright;
  void main() {
    int n = int(uSide);
    vec4 s = texelFetch(uState, ivec2(gl_VertexID % n, gl_VertexID / n), 0);
    Wave w = wave(s.xy);
    float front;
    vec2 at = toDomain(s.xy, uDomain, front);
    float fade = smoothstep(0.0, 0.5, s.z) * smoothstep(0.0, 0.8, s.w - s.z);
    vBright = front > 0.0 ? fade * smoothstep(0.5, 1.0, w.sea) * smoothstep(0.3, 0.8, w.steady) * (0.15 + 0.85 * smoothstep(0.0, 8.0, w.height)) : 0.0;
    gl_Position = vec4(at * 2.0 - 1.0, 0.0, 1.0);
    gl_PointSize = vBright > 0.0 ? 1.5 : 0.0;
  }
`
const depositFragment = /* glsl */ `
  varying float vBright;
  void main() {
    gl_FragColor = vec4(vBright * 0.04, 0.0, 0.0, 1.0);
  }
`

// setupMaterialForMRT appends the G-buffer writes before main()'s closing brace: keep main() last
const shellFragment = /* glsl */ `
  ${waveChunk}
  ${domainChunk}
  ${rampChunk()}
  uniform vec3 uDomain;
  uniform sampler2D uTrail;
  varying vec2 vGeo;
  void main() {
    vec3 normal = vec3(0.0, 0.0, 1.0); // read by the G-buffer write appended below
    vec2 ll = vec2(vGeo.x * 360.0 - 180.0, vGeo.y * 180.0 - 90.0);
    float front;
    vec2 uv = toDomain(ll, uDomain, front);
    if (front <= 0.0 || !inside(uv)) discard;
    Wave w = wave(ll);
    if (w.sea <= 0.0) discard;
    float kw = power(w);
    float trail = 1.0 - exp(-1.2 * texture2D(uTrail, uv).r);
    // A faint wash of the power field under the moving wake
    float wash = 0.05 + 0.12 * smoothstep(0.0, 300.0, kw);
    float a = (wash + trail * (0.45 + 0.75 * smoothstep(10.0, 400.0, kw))) * smoothstep(0.0, 0.6, w.sea);
    gl_FragColor = vec4(ramp(kw) * a, 1.0);
  }
`

const clearFragment = /* glsl */ `
  void main() { gl_FragColor = vec4(0.0); }
`

type PingPong = [WebGLRenderTarget, WebGLRenderTarget]
const swap = (pair: PingPong) => pair.reverse()

export class WaveStreamMeshDesc extends WaveDomainMeshDesc<WaveStreamConfig> {
  private state?: PingPong
  private trail?: PingPong
  private passes: Record<string, ShaderMaterial> = {}
  private deposit?: ShaderMaterial
  // The crests, drawn into the trail
  private crests = new Scene()
  private fresh = true

  private get options() {
    return { particles: 384, trailSize: 2048, ...this.config.waveStream }
  }

  override createMesh(): Mesh {
    const { grid, particles, trailSize } = this.options
    if (!grid) throw new Error('waveStream.grid is required')
    const geo = this.fieldUniforms(grid)

    const stateTarget = () =>
      this.track(
        new WebGLRenderTarget(particles, particles, {
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
    const trailTarget = () =>
      this.track(
        new WebGLRenderTarget(trailSize, trailSize, {
          type: HalfFloatType,
          format: RedFormat,
          minFilter: LinearMipmapLinearFilter,
          magFilter: LinearFilter,
          depthBuffer: false,
          generateMipmaps: true,
        }),
      )
    this.trail = [trailTarget(), trailTarget()]

    this.passes = {
      clear: this.pass(clearFragment),
      step: this.pass(particleFragment, {
        ...geo(),
        uState: { value: null },
        uDt: { value: 0 },
        uSeed: { value: 0 },
        uInit: { value: 1 },
        uLife: { value: LIFE },
      }),
      advect: this.pass(advectFragment, { ...geo(), uTrail: { value: null }, uDt: { value: 0 }, uDecay: { value: 1 } }),
      resample: this.pass(resampleFragment, {
        uSource: { value: null },
        uOld: { value: [0, 0, 1] },
        uNew: { value: [0, 0, 1] },
        uVector: { value: 0 },
        uSimTexel: { value: new Vector2() },
      }),
    }
    // One vertex per crest; the shader finds its texel by gl_VertexID
    this.deposit = this.pass(depositFragment, { ...geo(), uState: { value: null }, uSide: { value: particles } }, depositVertex)
    this.deposit.blending = AdditiveBlending
    this.deposit.transparent = true
    const geometry = this.track(new BufferGeometry())
    geometry.setAttribute('position', new Float32BufferAttribute(new Float32Array(particles * particles * 3), 3))
    const points = new Points(geometry, this.deposit)
    points.frustumCulled = false
    this.crests.add(points)

    return this.createShell(shellFragment, { ...geo(), uTrail: { value: this.trail[0].texture } })
  }

  protected override begin(renderer: WebGLRenderer): void {
    for (const t of this.trail!) this.run(renderer, this.passes.clear!, t)
    this.fresh = true
  }

  protected override carry(renderer: WebGLRenderer, from: Domain, to: Domain): void {
    // The crests are on the globe, not the square: only the trail moves over
    const trail = this.trail!
    this.run(renderer, this.passes.resample!, trail[1], { uSource: trail[0].texture, uOld: from, uNew: to })
    swap(trail)
  }

  protected override simulate(renderer: WebGLRenderer, dt: number, domain: Domain) {
    const [state, trail, p] = [this.state!, this.trail!, this.passes]
    this.run(renderer, p.step!, state[1], {
      uState: state[0].texture,
      uDomain: domain,
      uDt: dt,
      uSeed: Math.random() * 1000,
      uInit: this.fresh ? 1 : 0,
    })
    swap(state)
    this.fresh = false
    this.run(renderer, p.advect!, trail[1], { uTrail: trail[0].texture, uDomain: domain, uDt: dt, uDecay: Math.exp(-dt / FADE) })
    const d = this.deposit!.uniforms
    d.uState!.value = state[0].texture
    d.uDomain!.value = domain
    this.draw(renderer, this.crests, trail[1])
    swap(trail)
    return { uTrail: trail[0].texture }
  }
}
