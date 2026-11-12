// The world's ocean waves as a fluid, for Navara: a Navier-Stokes simulation (Stable Fluids:
// advection, vorticity confinement, pressure projection) run on the GPU over the part of the
// globe in view (see waveField.ts), the swell pulling it along and its power poured in as dye.
//
// - Its flow is pulled toward the way the waves go, at their phase speed (gT/2π, relative: the
//   longer the period, the faster); the swell's bends shear it, rough seas stir it, and the
//   confinement curls it up. Carried over to a new square, its velocities turn to its axes.
// - Dye in the color of the wave power, P = ρg²/64π · Hs² · T ≈ 0.49 Hs² T kW/m, is poured in
//   patches, and the flow stirs it. The shell over the sea lights it as a surface, its relief
//   from the dye, so it heaves as it flows.
import type { MeshConfigWithSelectiveEffect } from '@navaramap/three'
import { HalfFloatType, LinearFilter, RGBAFormat, Vector2, Vector3, WebGLRenderTarget, type Mesh, type ShaderMaterial, type WebGLRenderer } from 'three'
import {
  WaveDomainMeshDesc,
  domainChunk,
  rampChunk,
  resampleFragment,
  varyings,
  waveChunk,
  type Domain,
  type WaveGrid,
} from './waveField'

type WaveFluidOptions = {
  grid?: WaveGrid
  /** The flow's grid, this squared. Default: 256 */
  simSize?: number
  /** The dye's. Default: 1280 */
  dyeSize?: number
}
export type WaveFluidConfig = MeshConfigWithSelectiveEffect & { waveFluid?: WaveFluidOptions }

// The flow: a 10 s swell runs at SPEED of the square a second, and the flow is pulled toward it
// at PULL (1/s); rough seas stir it on top, up to STIR flow texels/s for an 8 m sea. CURL is the
// vorticity confinement, PRESSURE_ITERATIONS the Jacobi steps
const SPEED = 0.1
const PULL = 1.5
const STIR = 60
const CURL = 20
const PRESSURE_ITERATIONS = 20
const VELOCITY_DISSIPATION = 0.15
// The dye: poured in at INJECT a second where the patches are, and fading at DYE_DISSIPATION
const INJECT = 2.5
const DYE_DISSIPATION = 0.25

const noiseChunk = /* glsl */ `
  float hash3(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float noise3(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash3(i), hash3(i + vec3(1, 0, 0)), f.x), mix(hash3(i + vec3(0, 1, 0)), hash3(i + vec3(1, 1, 0)), f.x), f.y),
               mix(mix(hash3(i + vec3(0, 0, 1)), hash3(i + vec3(1, 0, 1)), f.x), mix(hash3(i + vec3(0, 1, 1)), hash3(i + vec3(1, 1, 1)), f.x), f.y), f.z);
  }
  float fbm(vec3 p) {
    return 0.55 * noise3(p) + 0.3 * noise3(p * 2.03 + 7.1) + 0.15 * noise3(p * 4.01 + 3.7);
  }
  // Patches fixed to the globe, about a tenth of the square across whatever its size: two scales
  // a power of two apart, crossfaded, so they don't jump as the square changes
  float patches(vec2 lngLat, float s, float time) {
    vec2 ll = radians(lngLat);
    vec3 p = vec3(cos(ll.y) * cos(ll.x), cos(ll.y) * sin(ll.x), sin(ll.y));
    float level = log2(5.0 / s);
    float l0 = floor(level);
    vec3 drift = vec3(0.0, 0.0, time * 0.07);
    float a = fbm(p * exp2(l0) + drift);
    float b = fbm(p * exp2(l0 + 1.0) + drift + 11.0);
    return mix(a, b, level - l0);
  }
`

// The flow, pulled toward the swell and stirred where the sea is rough (the curl of a noise
// fixed to the globe, so it adds no divergence); still on land and off the globe
const forceFragment = /* glsl */ `
  ${varyings}
  ${waveChunk}
  ${domainChunk}
  ${noiseChunk}
  uniform sampler2D uVelocity;
  uniform vec3 uDomain;
  uniform float uDt;
  uniform float uSize;
  uniform float uTime;
  float stirAt(vec2 uv) {
    vec2 ll;
    return fromDomain(uv, uDomain, ll) ? patches(ll, uDomain.z * 2.0, uTime * 2.0 + 40.0) : 0.5;
  }
  void main() {
    vec2 ll;
    if (!fromDomain(vUv, uDomain, ll)) { gl_FragColor = vec4(0.0); return; }
    Wave w = wave(ll);
    vec2 v = texture2D(uVelocity, vUv).xy;
    // The way the waves go, on the square: a short step that way, projected
    float eps = 2e-3 * uDomain.z;
    vec2 toward = degrees(eps * w.dir / vec2(max(cos(radians(ll.y)), 0.05), 1.0));
    float front;
    vec2 ahead = (toDomain(ll + toward, uDomain, front) - vUv) / eps;
    // uv/s, into texels/s: at the centre, ${SPEED} of the square a second for a 10 s swell
    float speed = ${SPEED.toFixed(3)} * (w.period / 10.0) * 2.0 * uDomain.z;
    vec2 target = ahead * speed * uSize * smoothstep(0.2, 0.7, w.steady);
    // The noise's slope across a texel, times the ~uSize / 5 texels an eddy spans: about 1
    vec2 slope = vec2(stirAt(vR) - stirAt(vL), stirAt(vT) - stirAt(vB)) * 0.5 * uSize / 5.0;
    target += vec2(slope.y, -slope.x) * ${STIR.toFixed(1)} * smoothstep(0.5, 8.0, w.height);
    v += (target - v) * (1.0 - exp(-uDt * ${PULL.toFixed(2)}));
    gl_FragColor = vec4(v * smoothstep(0.0, 0.5, w.sea), 0.0, 1.0);
  }
`

const curlFragment = /* glsl */ `
  ${varyings}
  uniform sampler2D uVelocity;
  void main() {
    float l = texture2D(uVelocity, vL).y;
    float r = texture2D(uVelocity, vR).y;
    float t = texture2D(uVelocity, vT).x;
    float b = texture2D(uVelocity, vB).x;
    gl_FragColor = vec4(0.5 * (r - l - t + b), 0.0, 0.0, 1.0);
  }
`

const vorticityFragment = /* glsl */ `
  ${varyings}
  uniform sampler2D uVelocity;
  uniform sampler2D uCurl;
  uniform float uDt;
  void main() {
    float l = texture2D(uCurl, vL).x;
    float r = texture2D(uCurl, vR).x;
    float t = texture2D(uCurl, vT).x;
    float b = texture2D(uCurl, vB).x;
    float c = texture2D(uCurl, vUv).x;
    vec2 force = 0.5 * vec2(abs(t) - abs(b), abs(r) - abs(l));
    force /= length(force) + 1e-4;
    force *= ${CURL.toFixed(1)} * c;
    force.y *= -1.0;
    vec2 v = texture2D(uVelocity, vUv).xy + force * uDt;
    gl_FragColor = vec4(clamp(v, -1000.0, 1000.0), 0.0, 1.0);
  }
`

const divergenceFragment = /* glsl */ `
  ${varyings}
  uniform sampler2D uVelocity;
  void main() {
    float l = texture2D(uVelocity, vL).x;
    float r = texture2D(uVelocity, vR).x;
    float t = texture2D(uVelocity, vT).y;
    float b = texture2D(uVelocity, vB).y;
    vec2 c = texture2D(uVelocity, vUv).xy;
    // Walls at the square's edges
    if (vL.x < 0.0) l = -c.x;
    if (vR.x > 1.0) r = -c.x;
    if (vT.y > 1.0) t = -c.y;
    if (vB.y < 0.0) b = -c.y;
    gl_FragColor = vec4(0.5 * (r - l + t - b), 0.0, 0.0, 1.0);
  }
`

const pressureFragment = /* glsl */ `
  ${varyings}
  uniform sampler2D uPressure;
  uniform sampler2D uDivergence;
  uniform float uKeep;
  void main() {
    float l = texture2D(uPressure, vL).x;
    float r = texture2D(uPressure, vR).x;
    float t = texture2D(uPressure, vT).x;
    float b = texture2D(uPressure, vB).x;
    float div = texture2D(uDivergence, vUv).x;
    // uKeep < 1: the first step starts from the last frame's pressure, damped
    gl_FragColor = vec4(uKeep * (l + r + b + t - div) * 0.25, 0.0, 0.0, 1.0);
  }
`

const gradientFragment = /* glsl */ `
  ${varyings}
  uniform sampler2D uPressure;
  uniform sampler2D uVelocity;
  void main() {
    float l = texture2D(uPressure, vL).x;
    float r = texture2D(uPressure, vR).x;
    float t = texture2D(uPressure, vT).x;
    float b = texture2D(uPressure, vB).x;
    vec2 v = texture2D(uVelocity, vUv).xy - vec2(r - l, t - b);
    gl_FragColor = vec4(v, 0.0, 1.0);
  }
`

// Semi-Lagrangian: each texel takes what was a step upstream (velocity in flow texels/s)
const advectFragment = /* glsl */ `
  ${varyings}
  uniform sampler2D uVelocity;
  uniform sampler2D uSource;
  uniform vec2 uSimTexel;
  uniform float uDt;
  uniform float uDissipation;
  void main() {
    vec2 from = vUv - uDt * texture2D(uVelocity, vUv).xy * uSimTexel;
    gl_FragColor = texture2D(uSource, from) / (1.0 + uDissipation * uDt);
  }
`

// Dye poured in, in patches, the color of the power there; none on land
const injectFragment = /* glsl */ `
  ${varyings}
  ${waveChunk}
  ${domainChunk}
  ${noiseChunk}
  ${rampChunk()}
  uniform sampler2D uDye;
  uniform vec3 uDomain;
  uniform float uDt;
  uniform float uTime;
  void main() {
    vec2 ll;
    if (!fromDomain(vUv, uDomain, ll)) { gl_FragColor = vec4(0.0); return; }
    Wave w = wave(ll);
    vec4 dye = texture2D(uDye, vUv);
    float kw = power(w);
    // Patches that come and go, so the flow carries each one off before the next
    float spot = smoothstep(0.6, 0.68, patches(ll, uDomain.z, uTime * 8.0));
    float amount = spot * (0.35 + 0.65 * smoothstep(0.0, 250.0, kw));
    dye.rgb += uDt * ${INJECT.toFixed(2)} * amount * ramp(kw);
    gl_FragColor = vec4(dye.rgb * smoothstep(0.0, 0.5, w.sea), 1.0);
  }
`

// setupMaterialForMRT appends the G-buffer writes before main()'s closing brace: keep main() last
const shellFragment = /* glsl */ `
  ${waveChunk}
  ${domainChunk}
  ${rampChunk()}
  uniform sampler2D uDye;
  uniform vec3 uDomain;
  uniform vec2 uDyeTexel;
  uniform vec3 uLight;
  varying vec2 vGeo;
  float lum(vec3 c) { return dot(c, vec3(0.3, 0.5, 0.2)); }
  void main() {
    vec3 normal = vec3(0.0, 0.0, 1.0); // read by the G-buffer write appended below
    vec2 ll = vec2(vGeo.x * 360.0 - 180.0, vGeo.y * 180.0 - 90.0);
    float front;
    vec2 uv = toDomain(ll, uDomain, front);
    if (front <= 0.0 || !inside(uv)) discard;
    Wave w = wave(ll);
    if (w.sea <= 0.0) discard;
    vec3 dye = texture2D(uDye, uv).rgb;
    // The dye's depth as the surface's height: its slope lights it like a heaving sea
    vec2 d = uDyeTexel * 1.5;
    float hx = lum(texture2D(uDye, uv + vec2(d.x, 0.0)).rgb) - lum(texture2D(uDye, uv - vec2(d.x, 0.0)).rgb);
    float hy = lum(texture2D(uDye, uv + vec2(0.0, d.y)).rgb) - lum(texture2D(uDye, uv - vec2(0.0, d.y)).rgb);
    vec3 n = normalize(vec3(-hx, -hy, 0.12));
    float diffuse = 0.55 + 0.6 * max(dot(n, uLight), 0.0);
    float glint = pow(max(dot(n, normalize(uLight + vec3(0.0, 0.0, 1.0))), 0.0), 40.0);
    vec3 c = (1.0 - exp(-0.9 * dye)) * diffuse + glint * 0.35 * (0.3 + ramp(power(w)));
    // A faint wash of the power field under it all
    c += ramp(power(w)) * 0.05;
    gl_FragColor = vec4(c * smoothstep(0.0, 0.6, w.sea), 1.0);
  }
`

type Target = WebGLRenderTarget
type PingPong = [Target, Target]
const swap = (pair: PingPong) => pair.reverse()

const clearFragment = /* glsl */ `
  void main() { gl_FragColor = vec4(0.0); }
`

export class WaveFluidMeshDesc extends WaveDomainMeshDesc<WaveFluidConfig> {
  private velocity?: PingPong
  private pressure?: PingPong
  private dye?: PingPong
  private divergence?: Target
  private curl?: Target
  private passes: Record<string, ShaderMaterial> = {}

  private get options() {
    return { simSize: 256, dyeSize: 1280, ...this.config.waveFluid }
  }

  override createMesh(): Mesh {
    const { grid, simSize, dyeSize } = this.options
    if (!grid) throw new Error('waveFluid.grid is required')
    const geo = this.fieldUniforms(grid)

    const target = (size: number) =>
      this.track(
        new WebGLRenderTarget(size, size, {
          type: HalfFloatType,
          format: RGBAFormat,
          minFilter: LinearFilter,
          magFilter: LinearFilter,
          depthBuffer: false,
          generateMipmaps: false,
        }),
      )
    this.velocity = [target(simSize), target(simSize)]
    this.pressure = [target(simSize), target(simSize)]
    this.divergence = target(simSize)
    this.curl = target(simSize)
    this.dye = [target(dyeSize), target(dyeSize)]

    const simTexel = () => ({ value: new Vector2(1 / simSize, 1 / simSize) })
    this.passes = {
      clear: this.pass(clearFragment),
      force: this.pass(forceFragment, { ...geo(), uVelocity: { value: null }, uDt: { value: 0 }, uSize: { value: simSize }, uTime: { value: 0 } }),
      curl: this.pass(curlFragment, { uVelocity: { value: null } }),
      vorticity: this.pass(vorticityFragment, { uVelocity: { value: null }, uCurl: { value: null }, uDt: { value: 0 } }),
      divergence: this.pass(divergenceFragment, { uVelocity: { value: null } }),
      pressure: this.pass(pressureFragment, { uPressure: { value: null }, uDivergence: { value: null }, uKeep: { value: 1 } }),
      gradient: this.pass(gradientFragment, { uPressure: { value: null }, uVelocity: { value: null } }),
      advect: this.pass(advectFragment, {
        uVelocity: { value: null },
        uSource: { value: null },
        uSimTexel: simTexel(),
        uDt: { value: 0 },
        uDissipation: { value: 0 },
      }),
      inject: this.pass(injectFragment, { ...geo(), uDye: { value: null }, uDt: { value: 0 }, uTime: { value: 0 } }),
      resample: this.pass(resampleFragment, {
        uSource: { value: null },
        uOld: { value: [0, 0, 1] },
        uNew: { value: [0, 0, 1] },
        uVector: { value: 0 },
        uSimTexel: simTexel(),
      }),
    }

    return this.createShell(shellFragment, {
      ...geo(),
      uDye: { value: this.dye[0].texture },
      uDyeTexel: { value: new Vector2(1 / dyeSize, 1 / dyeSize) },
      uLight: { value: new Vector3(-0.5, 0.6, 0.62).normalize() },
    })
  }

  protected override begin(renderer: WebGLRenderer): void {
    for (const t of [...this.velocity!, ...this.pressure!, ...this.dye!]) this.run(renderer, this.passes.clear!, t)
  }

  protected override carry(renderer: WebGLRenderer, from: Domain, to: Domain): void {
    for (const [pair, vector] of [[this.velocity!, 1], [this.dye!, 0]] as const) {
      this.run(renderer, this.passes.resample!, pair[1], { uSource: pair[0].texture, uOld: from, uNew: to, uVector: vector })
      swap(pair)
    }
  }

  protected override simulate(renderer: WebGLRenderer, dt: number, domain: Domain) {
    const [velocity, pressure, dye, divergence, curl] = [this.velocity!, this.pressure!, this.dye!, this.divergence!, this.curl!]
    const p = this.passes as Record<string, ShaderMaterial>
    this.run(renderer, p.force!, velocity[1], { uVelocity: velocity[0].texture, uDomain: domain, uDt: dt, uTime: this.time })
    swap(velocity)
    this.run(renderer, p.curl!, curl, { uVelocity: velocity[0].texture })
    this.run(renderer, p.vorticity!, velocity[1], { uVelocity: velocity[0].texture, uCurl: curl.texture, uDt: dt })
    swap(velocity)
    this.run(renderer, p.divergence!, divergence, { uVelocity: velocity[0].texture })
    for (let i = 0; i < PRESSURE_ITERATIONS; i++) {
      this.run(renderer, p.pressure!, pressure[1], { uPressure: pressure[0].texture, uDivergence: divergence.texture, uKeep: i === 0 ? 0.8 : 1 })
      swap(pressure)
    }
    this.run(renderer, p.gradient!, velocity[1], { uPressure: pressure[0].texture, uVelocity: velocity[0].texture })
    swap(velocity)
    this.run(renderer, p.advect!, velocity[1], { uVelocity: velocity[0].texture, uSource: velocity[0].texture, uDt: dt, uDissipation: VELOCITY_DISSIPATION })
    swap(velocity)
    this.run(renderer, p.advect!, dye[1], { uVelocity: velocity[0].texture, uSource: dye[0].texture, uDt: dt, uDissipation: DYE_DISSIPATION })
    swap(dye)
    this.run(renderer, p.inject!, dye[1], { uDye: dye[0].texture, uDomain: domain, uDt: dt, uTime: this.time })
    swap(dye)
    return { uDye: dye[0].texture }
  }
}
