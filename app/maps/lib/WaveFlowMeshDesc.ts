// The world's ocean waves as a flowing fluid, for Navara, all of it worked out on the GPU.
//
// The wave model's grid (height, direction, period on 0.25° cells) goes up as one float16
// texture, as it is, and every shader reads it through `wave()`: the four cells around a point,
// interpolated linearly, sea cells only, with the direction as a vector. On it:
//
// - crests: particles (one per texel of a float state texture, ping-ponged) carried along the
//   way the waves go at their phase speed, c = gT/2π, then born again somewhere else;
// - their energy: a trail on a world-wide texture (equirectangular), which each frame is
//   advected at the group speed, half the phase speed in deep water, as a fluid (each texel
//   looks back to where it came from), and fades, before the crests are drawn into it. The
//   crests outrun their own energy, so they leave a wake that the flow bends and stretches;
// - a shell over the ocean shows the trail, colored by the wave power there: the energy the
//   waves carry through each metre of crest, P = ρg²/64π · Hs² · T ≈ 0.49 Hs² T kW/m.
//
// Wired into the G-buffer like ThunderMeshDesc, so it all feeds the selective bloom.
import {
  MeshDescWithSelectiveEffect,
  geodeticToVector3,
  getWGS84SemiMajorAxis,
  setupMaterialForMRT,
  type MeshConfigWithSelectiveEffect,
  type MeshUpdateWithSelectiveEffect,
} from '@navaramap/three'
import {
  AdditiveBlending,
  BufferGeometry,
  Camera,
  DataTexture,
  DoubleSide,
  Float32BufferAttribute,
  FloatType,
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  NearestFilter,
  NoBlending,
  PlaneGeometry,
  Points,
  RGBAFormat,
  RedFormat,
  RepeatWrapping,
  Scene,
  ShaderMaterial,
  Vector3,
  WebGLRenderTarget,
  type IUniform,
  type WebGLRenderer,
} from 'three'

/** The grid, as written by scripts/day12/fetch_waves.py */
export type WaveGrid = {
  width: number
  height: number
  /** The first row's latitude (north) and the first column's longitude (west) */
  lat0: number
  lng0: number
  /** Cell size (°), the same both ways */
  dlon: number
  /** swh, mwd, mwp per cell, float16; land and sea ice -1 */
  data: Uint16Array
}

type WaveFlowOptions = {
  grid?: WaveGrid
  /** Particles: this squared. Default: 512 */
  particles?: number
  /** The trail texture's width (its height is half). Default: 4096 */
  trailWidth?: number
}
type Description = { waveFlow?: WaveFlowOptions }
export type WaveFlowConfig = MeshConfigWithSelectiveEffect & Description
type WaveFlowUpdate = MeshUpdateWithSelectiveEffect & Description

/** How much faster than real the waves run (1 s on screen: ~7 h) */
export const TIME_LAPSE = 25_000
// A crest lives this long (s, on screen) before it's born again elsewhere
const LIFE: [number, number] = [2.5, 7]
// The wake fades to 1/e in this long (s)
const FADE = 1.6
// The shell sits this high (m), over the ellipsoid's own tessellation
const LIFT = 3_000
const WGS84_E2 = 6.69437999014e-3

// The grid's four cells round a point, linearly interpolated: sea cells only, so the coasts
// don't drag the waves down to nothing, and the direction as a vector, so 350° and 10° make 0°
const waveChunk = /* glsl */ `
  uniform sampler2D uField;
  uniform vec4 uGrid; // width, height, lat0, lng0
  uniform float uCell;
  const float PI = 3.14159265;
  struct Wave {
    vec2 dir;      // the way the waves go, east and north, unit
    float steady;  // how much the four cells agree on it: 1 all one way, 0 where seas cross
    float height;  // significant wave height (m)
    float period;  // mean period (s)
    float sea;     // 0 (land) to 1 (open sea)
  };
  Wave wave(vec2 lngLat) {
    vec2 f = vec2((lngLat.x - uGrid.w) / uCell, (uGrid.z - lngLat.y) / uCell);
    vec2 i0 = floor(f);
    vec2 t = f - i0;
    vec2 dir = vec2(0.0);
    float h = 0.0, p = 0.0, sum = 0.0;
    for (int k = 0; k < 4; k++) {
      vec2 o = vec2(k & 1, k >> 1);
      ivec2 c = ivec2(mod(i0.x + o.x, uGrid.x), clamp(i0.y + o.y, 0.0, uGrid.y - 1.0));
      vec3 v = texelFetch(uField, c, 0).rgb;
      float w = (o.x > 0.5 ? t.x : 1.0 - t.x) * (o.y > 0.5 ? t.y : 1.0 - t.y);
      if (v.x < 0.0) continue;
      // mwd is where they come from, clockwise from north
      float a = radians(v.y);
      dir -= w * vec2(sin(a), cos(a));
      h += w * v.x;
      p += w * v.z;
      sum += w;
    }
    if (sum <= 0.0) return Wave(vec2(0.0), 0.0, 0.0, 0.0, 0.0);
    float l = length(dir);
    return Wave(dir / max(l, 1e-4), l / sum, h / sum, p / sum, sum);
  }
  // Deep-water phase speed (m/s)
  float phaseSpeed(float period) { return 9.81 * period / (2.0 * PI); }
  // A step of \`metres\` east and north from a point, in degrees
  vec2 stepDeg(vec2 metres, float lat) {
    return metres / vec2(111195.0 * max(cos(radians(lat)), 0.05), 111195.0);
  }
`

const hashChunk = /* glsl */ `
  float hash(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
`

const quadVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`

// The crests' state, one per texel: lng, lat, age, life
const particleFragment = /* glsl */ `
  ${waveChunk}
  ${hashChunk}
  uniform sampler2D uState;
  uniform float uDt;
  uniform float uSeed;
  uniform float uInit;
  uniform float uLapse;
  uniform vec2 uLife;
  void main() {
    vec4 s = texelFetch(uState, ivec2(gl_FragCoord.xy), 0);
    Wave w = wave(s.xy);
    // Where two seas meet head on the crests would pile up along the line: they end there
    if (uInit > 0.5 || s.z >= s.w || w.sea < 0.5 || w.steady < 0.3) {
      // Born again anywhere, evenly over the sphere (on land, it tries again next frame)
      vec2 seed = gl_FragCoord.xy + uSeed;
      float lng = hash(seed) * 360.0 - 180.0;
      float lat = degrees(asin(hash(seed + 17.0) * 2.0 - 1.0));
      float life = mix(uLife.x, uLife.y, hash(seed + 31.0));
      // At the start, spread over their lives so they don't all go at once
      gl_FragColor = vec4(lng, lat, uInit > 0.5 ? hash(seed + 47.0) * life : 0.0, life);
      return;
    }
    // Midpoint step, so the crests bend round with the swell
    vec2 v0 = w.dir * phaseSpeed(w.period) * uLapse;
    vec2 mid = s.xy + stepDeg(v0 * uDt * 0.5, s.y);
    Wave wm = wave(mid);
    vec2 v = wm.sea > 0.0 ? wm.dir * phaseSpeed(wm.period) * uLapse : v0;
    vec2 p = s.xy + stepDeg(v * uDt, s.y);
    p.x = mod(p.x + 180.0, 360.0) - 180.0;
    p.y = clamp(p.y, -89.0, 89.0);
    gl_FragColor = vec4(p, s.z + uDt, s.w);
  }
`

// The wake: each texel takes what was upstream of it, a group speed's step back, and fades
const advectFragment = /* glsl */ `
  ${waveChunk}
  uniform sampler2D uTrail;
  uniform float uDt;
  uniform float uDecay;
  uniform float uInit;
  uniform float uLapse;
  varying vec2 vUv;
  void main() {
    if (uInit > 0.5) { gl_FragColor = vec4(0.0); return; }
    vec2 lngLat = vec2(vUv.x * 360.0 - 180.0, vUv.y * 180.0 - 90.0);
    Wave w = wave(lngLat);
    vec2 back = stepDeg(w.dir * phaseSpeed(w.period) * 0.5 * uLapse * uDt, lngLat.y);
    float prev = textureLod(uTrail, vUv - back / vec2(360.0, 180.0), 0.0).r;
    gl_FragColor = vec4(prev * uDecay * smoothstep(0.0, 0.5, w.sea), 0.0, 0.0, 1.0);
  }
`

// The crests, drawn into the wake: as bright as the waves are high, fading in and out
const depositVertex = /* glsl */ `
  ${waveChunk}
  uniform sampler2D uState;
  uniform float uSide;
  varying float vBright;
  void main() {
    int n = int(uSide);
    vec4 s = texelFetch(uState, ivec2(gl_VertexID % n, gl_VertexID / n), 0);
    Wave w = wave(s.xy);
    float fade = smoothstep(0.0, 0.5, s.z) * smoothstep(0.0, 0.8, s.w - s.z);
    vBright = fade * smoothstep(0.5, 1.0, w.sea) * smoothstep(0.3, 0.8, w.steady) * (0.15 + 0.85 * smoothstep(0.0, 8.0, w.height));
    gl_Position = vec4(s.x / 180.0, s.y / 90.0, 0.0, 1.0);
    gl_PointSize = vBright > 0.0 ? 1.5 : 0.0;
  }
`
const depositFragment = /* glsl */ `
  varying float vBright;
  void main() {
    gl_FragColor = vec4(vBright * 0.03, 0.0, 0.0, 1.0);
  }
`

// The shell over the sea
const shellVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`
// setupMaterialForMRT appends the G-buffer writes before main()'s closing brace: keep main() last
const shellFragment = /* glsl */ `
  ${waveChunk}
  uniform sampler2D uTrail;
  uniform float uOpacity;
  varying vec2 vUv;
  // Wave power (kW/m) to color: a calm deep blue, teal, a pale cyan, white-hot amber in the storms
  vec3 ramp(float kw) {
    float t = clamp(log(1.0 + kw) / log(1.0 + 600.0), 0.0, 1.0);
    vec3 c = mix(vec3(0.05, 0.16, 0.55), vec3(0.0, 0.62, 0.85), smoothstep(0.0, 0.45, t));
    c = mix(c, vec3(0.3, 0.85, 1.0), smoothstep(0.4, 0.68, t));
    c = mix(c, vec3(1.0, 0.78, 0.4), smoothstep(0.66, 0.84, t));
    return mix(c, vec3(1.0, 0.35, 0.12), smoothstep(0.84, 1.0, t));
  }
  void main() {
    vec3 normal = vec3(0.0, 0.0, 1.0); // read by the G-buffer write appended below
    vec2 lngLat = vec2(vUv.x * 360.0 - 180.0, vUv.y * 180.0 - 90.0);
    Wave w = wave(lngLat);
    if (w.sea <= 0.0) discard;
    float kw = 0.49 * w.height * w.height * w.period;
    float trail = 1.0 - exp(-1.2 * texture(uTrail, vUv).r);
    // A faint wash of the power field under the moving wake
    float wash = 0.05 + 0.12 * smoothstep(0.0, 300.0, kw);
    float a = (wash + trail * (0.5 + 1.1 * smoothstep(10.0, 400.0, kw))) * smoothstep(0.0, 0.6, w.sea);
    gl_FragColor = vec4(ramp(kw) * a * uOpacity, 1.0);
  }
`

type PingPong = [WebGLRenderTarget, WebGLRenderTarget]

export class WaveFlowMeshDesc extends MeshDescWithSelectiveEffect<WaveFlowConfig, WaveFlowUpdate, Mesh> {
  private config: WaveFlowConfig
  private mask: IUniform<number> = { value: 0 }
  private field?: DataTexture
  private state?: PingPong
  private trail?: PingPong
  // Offscreen: the crests' step, and the wake's (its advection, then the crests drawn over it)
  private stepScene = new Scene()
  private wakeScene = new Scene()
  private offCamera = new Camera()
  private stepMaterial?: ShaderMaterial
  private advectMaterial?: ShaderMaterial
  private depositMaterial?: ShaderMaterial
  private shell?: Mesh<BufferGeometry, ShaderMaterial>
  private disposables: { dispose(): void }[] = []
  private started = false
  /** Seconds on screen per real second; the view eases it as it zooms */
  lapse = TIME_LAPSE

  constructor(...args: ConstructorParameters<typeof MeshDescWithSelectiveEffect<WaveFlowConfig, WaveFlowUpdate>>) {
    super(...args)
    this.config = args[2] ?? {}
  }

  private get options() {
    return { particles: 512, trailWidth: 4096, ...this.config.waveFlow }
  }

  private track<T extends { dispose(): void }>(t: T): T {
    this.disposables.push(t)
    return t
  }

  override createMesh() {
    const { grid, particles, trailWidth } = this.options
    if (!grid) throw new Error('waveFlow.grid is required')

    // The grid as it comes, half floats, read texel by texel (RGB16F won't always upload: as RGBA)
    const cells = grid.width * grid.height
    const rgba = new Uint16Array(cells * 4)
    for (let i = 0; i < cells; i++) rgba.set(grid.data.subarray(i * 3, i * 3 + 3), i * 4)
    const field = this.track(new DataTexture(rgba, grid.width, grid.height, RGBAFormat, HalfFloatType))
    field.minFilter = field.magFilter = NearestFilter
    field.generateMipmaps = false
    field.flipY = false
    field.needsUpdate = true
    this.field = field
    const fieldUniforms = () => ({
      uField: { value: field },
      uGrid: { value: [grid.width, grid.height, grid.lat0, grid.lng0] },
      uCell: { value: grid.dlon },
    })

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
    // The wake, mipmapped for when the whole globe is in view
    const trailTarget = () =>
      this.track(
        new WebGLRenderTarget(trailWidth, trailWidth / 2, {
          type: HalfFloatType,
          format: RedFormat,
          minFilter: LinearMipmapLinearFilter,
          magFilter: LinearFilter,
          wrapS: RepeatWrapping,
          depthBuffer: false,
          generateMipmaps: true,
        }),
      )
    this.trail = [trailTarget(), trailTarget()]

    const quad = this.track(new PlaneGeometry(2, 2))
    const offscreen = (vertexShader: string, fragmentShader: string, uniforms: Record<string, IUniform>) =>
      this.track(
        new ShaderMaterial({ vertexShader, fragmentShader, uniforms, depthTest: false, depthWrite: false, blending: NoBlending, toneMapped: false }),
      )
    const common = { uDt: { value: 0 }, uInit: { value: 1 }, uLapse: { value: this.lapse } }
    this.stepMaterial = offscreen(quadVertex, particleFragment, {
      ...fieldUniforms(),
      ...common,
      uState: { value: null },
      uSeed: { value: 0 },
      uLife: { value: LIFE },
    })
    this.advectMaterial = offscreen(quadVertex, advectFragment, {
      ...fieldUniforms(),
      ...common,
      uTrail: { value: null },
      uDecay: { value: 1 },
    })
    this.depositMaterial = offscreen(depositVertex, depositFragment, {
      ...fieldUniforms(),
      uState: { value: null },
      uSide: { value: particles },
    })
    this.depositMaterial.blending = AdditiveBlending
    this.depositMaterial.transparent = true

    const stepQuad = new Mesh(quad, this.stepMaterial)
    const advectQuad = new Mesh(quad, this.advectMaterial)
    // One vertex per crest; the shader finds its texel by gl_VertexID
    const crestGeometry = this.track(new BufferGeometry())
    crestGeometry.setAttribute('position', new Float32BufferAttribute(new Float32Array(particles * particles * 3), 3))
    const crests = new Points(crestGeometry, this.depositMaterial)
    advectQuad.renderOrder = 0
    crests.renderOrder = 1
    for (const o of [stepQuad, advectQuad, crests]) o.frustumCulled = false
    this.stepScene.add(stepQuad)
    this.wakeScene.add(advectQuad, crests)

    // The shell: a lng/lat grid over the ellipsoid, uv straight onto the wake's texture
    const material = new ShaderMaterial({
      vertexShader: shellVertex,
      fragmentShader: shellFragment,
      uniforms: { ...fieldUniforms(), uTrail: { value: this.trail[0].texture }, uOpacity: { value: 1 } },
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      blending: AdditiveBlending,
      toneMapped: false,
    })
    material.defines.USE_SELECTIVE_EFFECT = 1
    material.userData.uEffectIdsMask = this.mask
    material.uniforms.uEffectIdsMask = this.mask
    material.uniforms.uEmissiveColor = { value: new Vector3() }
    material.uniforms.uEmissiveIntensity = { value: 1 }
    setupMaterialForMRT(material)
    this.track(material)
    this.shell = new Mesh(this.track(ellipsoidGrid(720, 360, LIFT)), material)
    this.shell.frustumCulled = false
    return this.shell
  }

  /** Runs the waves on by `dt` s, on the GPU. */
  step(dt: number): void {
    const renderer = this.ctx.getRenderer() as WebGLRenderer
    const [state, trail] = [this.state, this.trail]
    if (!state || !trail || !this.stepMaterial || !this.advectMaterial || !this.depositMaterial || !this.shell) return
    const init = this.started ? 0 : 1
    this.started = true
    dt = Math.min(dt, 1 / 20)

    const previous = renderer.getRenderTarget()
    const autoClear = renderer.autoClear
    renderer.autoClear = false

    const s = this.stepMaterial.uniforms
    s.uState!.value = state[0].texture
    s.uDt!.value = dt
    s.uInit!.value = init
    s.uSeed!.value = Math.random() * 1000
    s.uLapse!.value = this.lapse
    renderer.setRenderTarget(state[1])
    renderer.render(this.stepScene, this.offCamera)
    state.reverse()

    const a = this.advectMaterial.uniforms
    a.uTrail!.value = trail[0].texture
    a.uDt!.value = dt
    a.uInit!.value = init
    a.uDecay!.value = Math.exp(-dt / FADE)
    a.uLapse!.value = this.lapse
    this.depositMaterial.uniforms.uState!.value = state[0].texture
    renderer.setRenderTarget(trail[1])
    renderer.render(this.wakeScene, this.offCamera)
    trail.reverse()
    this.shell.material.uniforms.uTrail!.value = trail[0].texture

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
    for (const d of this.disposables) d.dispose()
    this.disposables = []
  }
}

/**
 * A lng/lat grid over the WGS84 ellipsoid, `height` m up, with uv = (lng, lat) from 180°W, 90°S.
 * Navara's ECEF axes are read off geodeticToVector3, so the grid lines up whichever way they run.
 */
function ellipsoidGrid(columns: number, rows: number, height: number): BufferGeometry {
  const axis = (lng: number, lat: number) => geodeticToVector3({ lng, lat, height: 0 }).normalize()
  const [ex, ey, ez] = [axis(0, 0), axis(90, 0), axis(0, 90)]
  const a = getWGS84SemiMajorAxis()
  const position = new Float32Array((columns + 1) * (rows + 1) * 3)
  const uv = new Float32Array((columns + 1) * (rows + 1) * 2)
  const p = new Vector3()
  for (let j = 0; j <= rows; j++) {
    const lat = ((j / rows) * 180 - 90) * (Math.PI / 180)
    const n = a / Math.sqrt(1 - WGS84_E2 * Math.sin(lat) ** 2)
    for (let i = 0; i <= columns; i++) {
      const lng = ((i / columns) * 360 - 180) * (Math.PI / 180)
      const k = j * (columns + 1) + i
      p.copy(ex)
        .multiplyScalar((n + height) * Math.cos(lat) * Math.cos(lng))
        .addScaledVector(ey, (n + height) * Math.cos(lat) * Math.sin(lng))
        .addScaledVector(ez, (n * (1 - WGS84_E2) + height) * Math.sin(lat))
      position.set([p.x, p.y, p.z], k * 3)
      uv.set([i / columns, j / rows], k * 2)
    }
  }
  const index: number[] = []
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < columns; i++) {
      const k = j * (columns + 1) + i
      index.push(k, k + 1, k + columns + 1, k + 1, k + columns + 2, k + columns + 1)
    }
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(position, 3))
  geometry.setAttribute('uv', new Float32BufferAttribute(uv, 2))
  geometry.setIndex(index)
  return geometry
}
