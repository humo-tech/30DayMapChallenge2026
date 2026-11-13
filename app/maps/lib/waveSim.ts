// What Day 12's two looks at the world's ocean waves share, whatever draws the map: the wave
// model's grid on the GPU, and the square of the globe they're worked out over. Three.js only, on
// whichever WebGLRenderer the map lends it: Navara's (waveField.ts) or one on MapLibre's own GL
// context (waveGlobeLayer.ts).
//
// - The grid (height, direction, period on 0.25° cells) goes up as one float16 texture, as it
//   is, and every shader reads it through `wave()`: the four cells around a point, interpolated
//   linearly, sea cells only, with the direction as a vector.
// - Each look lives on a square in the orthographic projection centred on the view (what the eye
//   sees of the globe from afar), sized to what's in view, so it's as fine zoomed in as out. When
//   the view leaves it, or zooms well into it, a new square is taken and the look carried over
//   to it, and it builds up its own detail there.
// - The map shows it on a shell over the sea, whose fragment shader (`shellFragment`) looks
//   itself up on the square: it gets the lng/lat (vGeo: 0-1 from 180°W, 90°S) of where it is.
import {
  Camera,
  DataTexture,
  HalfFloatType,
  Mesh,
  NearestFilter,
  NoBlending,
  PlaneGeometry,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  Vector2,
  type IUniform,
  type WebGLRenderer,
  type WebGLRenderTarget,
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

/**
 * How fast both looks run: a 10 s swell's crests cross this much of the square a second (its
 * energy, at the group speed, half that). Relative to the square, so it reads the same at any zoom
 */
export const PHASE_SPEED = 0.05

// The square takes in this much more than the view
export const MARGIN = 1.3

/** The square: centre lng, lat (radians), half side (earth radii) */
export type Domain = [number, number, number]

/** A point on the globe, in radians */
export type LngLatRad = { lng: number; lat: number }

// The grid's four cells round a point, linearly interpolated: sea cells only, so the coasts
// don't drag the waves down to nothing, and the direction as a vector, so 350° and 10° make 0°
export const waveChunk = /* glsl */ `
  uniform sampler2D uField;
  uniform vec4 uGrid; // width, height, lat0, lng0
  uniform float uCell;
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
  // Wave power (kW/m)
  float power(Wave w) { return 0.49 * w.height * w.height * w.period; }
`

// The square: the orthographic projection centred on (lng, lat) (radians), its half side s (in
// earth radii), mapped onto uv 0-1
export const domainChunk = /* glsl */ `
  // A point (degrees) on the square, and whether it faces the centre's side of the globe (> 0)
  vec2 toDomain(vec2 lngLat, vec3 d, out float front) {
    vec2 ll = radians(lngLat);
    float dl = ll.x - d.x;
    float cl = cos(ll.y);
    vec2 xy = vec2(cl * sin(dl), cos(d.y) * sin(ll.y) - sin(d.y) * cl * cos(dl));
    front = sin(d.y) * sin(ll.y) + cos(d.y) * cl * cos(dl);
    return xy / (2.0 * d.z) + 0.5;
  }
  // A point on the square to degrees; false off the globe
  bool fromDomain(vec2 uv, vec3 d, out vec2 lngLat) {
    vec2 xy = (uv - 0.5) * 2.0 * d.z;
    float rho = length(xy);
    if (rho >= 1.0) return false;
    float c = asin(rho);
    float sc = sin(c), cc = cos(c);
    float lat = rho < 1e-7 ? d.y : asin(cc * sin(d.y) + xy.y * sc * cos(d.y) / rho);
    float lng = d.x + atan(xy.x * sc, rho * cc * cos(d.y) - xy.y * sc * sin(d.y));
    lngLat = degrees(vec2(mod(lng + 3.14159265, 6.28318531) - 3.14159265, lat));
    return true;
  }
  bool inside(vec2 uv) { return all(greaterThanEqual(uv, vec2(0.0))) && all(lessThanEqual(uv, vec2(1.0))); }
`

// How far (degrees) the waves at `lngLat` carry something in `dt` s, at `speed` of the square a
// second for a 10 s swell (the longer the period, the faster: gT/2π). Wants uDomain declared;
// uSpeed is the crests' speed (PHASE_SPEED, or as tuned)
export const travelChunk = /* glsl */ `
  uniform float uSpeed;
  vec2 travel(Wave w, vec2 lngLat, float dt, float speed) {
    float angle = speed * (w.period / 10.0) * 2.0 * uDomain.z * dt;
    return degrees(angle * w.dir / vec2(max(cos(radians(lngLat.y)), 0.05), 1.0));
  }
`

export function rampChunk() {
  return /* glsl */ `
  // Wave power (kW/m, on a log scale up to 600) to color, lighter the more power: navy in the
  // calms, blue, cyan, pale, and near white under the storms, the very strongest a touch warm
  // (kept below full white: the bloom lifts it)
  vec3 ramp(float kw) {
    float t = clamp(log(1.0 + kw) / log(1.0 + 600.0), 0.0, 1.0);
    vec3 c = mix(vec3(0.02, 0.06, 0.28), vec3(0.04, 0.24, 0.72), smoothstep(0.0, 0.38, t));
    c = mix(c, vec3(0.08, 0.62, 0.95), smoothstep(0.32, 0.62, t));
    c = mix(c, vec3(0.48, 0.82, 0.95), smoothstep(0.58, 0.82, t));
    return mix(c, vec3(0.86, 0.86, 0.8), smoothstep(0.8, 1.0, t));
  }
`
}

export const quadVertex = /* glsl */ `
  uniform vec2 uTexel;
  varying vec2 vUv;
  varying vec2 vL;
  varying vec2 vR;
  varying vec2 vT;
  varying vec2 vB;
  void main() {
    vUv = uv;
    vL = uv - vec2(uTexel.x, 0.0);
    vR = uv + vec2(uTexel.x, 0.0);
    vT = uv + vec2(0.0, uTexel.y);
    vB = uv - vec2(0.0, uTexel.y);
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`
export const varyings = /* glsl */ `
  varying vec2 vUv;
  varying vec2 vL;
  varying vec2 vR;
  varying vec2 vT;
  varying vec2 vB;
`

// Carries a field over to a new square: each texel finds itself on the old one. A velocity (in
// flow texels/s, uVector 1) is carried as a short step, so it turns with the new square's axes
export const resampleFragment = /* glsl */ `
  ${varyings}
  ${domainChunk}
  uniform sampler2D uSource;
  uniform vec3 uOld;
  uniform vec3 uNew;
  uniform float uVector;
  uniform vec2 uSimTexel;
  void main() {
    vec2 ll;
    if (!fromDomain(vUv, uNew, ll)) { gl_FragColor = vec4(0.0); return; }
    float front;
    vec2 old = toDomain(ll, uOld, front);
    if (front <= 0.0 || !inside(old)) { gl_FragColor = vec4(0.0); return; }
    vec4 c = texture2D(uSource, old);
    if (uVector > 0.5) {
      float dt = 0.05;
      vec2 q;
      if (!fromDomain(old + c.xy * uSimTexel * dt, uOld, q)) { gl_FragColor = vec4(0.0); return; }
      c.xy = (toDomain(q, uNew, front) - vUv) / (uSimTexel * dt);
    }
    gl_FragColor = c;
  }
`

/** A look, run on a square that follows the view; the map shows it through `shellFragment`. */
export abstract class WaveSim {
  /** The shell's fragment shader: reads `varying vec2 vGeo` (lng, lat as 0-1) and `uDomain` */
  abstract readonly shellFragment: string
  /** The shell's uniforms; `step()` returns the values to set on them each frame */
  abstract readonly shellUniforms: Record<string, IUniform>
  /** The crests' speed, as a share of the square a second for a 10 s swell (tunable) */
  speed = PHASE_SPEED
  protected time = 0
  private disposables: { dispose(): void }[] = []
  private scene = new Scene()
  private quad?: Mesh<PlaneGeometry, ShaderMaterial>
  private offCamera = new Camera()
  private domain?: Domain

  protected track<T extends { dispose(): void }>(t: T): T {
    this.disposables.push(t)
    return t
  }

  /** The grid, as a texture, and the uniforms `waveChunk` reads it through */
  protected fieldUniforms(grid: WaveGrid): () => Record<string, IUniform> {
    // Half floats, read texel by texel (RGB16F won't always upload: as RGBA)
    const cells = grid.width * grid.height
    const rgba = new Uint16Array(cells * 4)
    for (let i = 0; i < cells; i++) rgba.set(grid.data.subarray(i * 3, i * 3 + 3), i * 4)
    const field = this.track(new DataTexture(rgba, grid.width, grid.height, RGBAFormat, HalfFloatType))
    field.minFilter = field.magFilter = NearestFilter
    field.generateMipmaps = false
    field.needsUpdate = true
    return () => ({
      uField: { value: field },
      uGrid: { value: [grid.width, grid.height, grid.lat0, grid.lng0] },
      uCell: { value: grid.dlon },
      uDomain: { value: [0, 0, 1] },
      uSpeed: { value: PHASE_SPEED },
    })
  }

  /** A full-screen pass, run with `run()` */
  protected pass(fragmentShader: string, uniforms: Record<string, IUniform> = {}, vertexShader = quadVertex): ShaderMaterial {
    return this.track(
      new ShaderMaterial({
        vertexShader,
        fragmentShader,
        uniforms: { uTexel: { value: new Vector2() }, ...uniforms },
        depthTest: false,
        depthWrite: false,
        blending: NoBlending,
        toneMapped: false,
      }),
    )
  }

  /** Renders `material` over all of `target`, with `uniforms` set first. */
  protected run(renderer: WebGLRenderer, material: ShaderMaterial, target: WebGLRenderTarget, uniforms: Record<string, unknown> = {}) {
    for (const [k, v] of Object.entries(uniforms)) material.uniforms[k]!.value = v
    ;(material.uniforms.uTexel!.value as Vector2).set(1 / target.width, 1 / target.height)
    if (!this.quad) {
      this.quad = new Mesh(this.track(new PlaneGeometry(2, 2)), material)
      this.quad.frustumCulled = false
      this.scene.add(this.quad)
    }
    this.quad.material = material
    renderer.setRenderTarget(target)
    renderer.render(this.scene, this.offCamera)
  }

  /** Renders a scene of its own (e.g. points) into `target`, over what's there. */
  protected draw(renderer: WebGLRenderer, scene: Scene, target: WebGLRenderTarget) {
    renderer.setRenderTarget(target)
    renderer.render(scene, this.offCamera)
  }

  /** Starts afresh on `domain` (nothing from before carries over). */
  protected abstract begin(renderer: WebGLRenderer, domain: Domain): void
  /** Carries the look from the square `from` over to `to`. */
  protected abstract carry(renderer: WebGLRenderer, from: Domain, to: Domain): void
  /** Runs it on by `dt` s on `domain`; returns the shell's uniforms to set. */
  protected abstract simulate(renderer: WebGLRenderer, dt: number, domain: Domain): Record<string, unknown>

  /** Next time, starts afresh (e.g. after being hidden a while). */
  reset(): void {
    this.domain = undefined
  }

  /**
   * Runs on by `dt` s over the view, `points` being what it sees (a 5 × 5 grid over the screen,
   * row by row, the centre in the middle; off the globe, the horizon that way). Returns the
   * values to set on `shellUniforms`. Leaves the renderer drawing where it was.
   */
  step(renderer: WebGLRenderer, dt: number, points: LngLatRad[]): Record<string, unknown> {
    dt = Math.min(dt, 1 / 30)
    this.time += dt
    const previous = renderer.getRenderTarget()
    const autoClear = renderer.autoClear
    renderer.autoClear = false

    // A new square when the view has left this one, or zoomed well into it
    const wanted = viewDomain(points)
    if (!this.domain || needsNewDomain(this.domain, wanted, points)) {
      const next: Domain = [wanted[0], wanted[1], Math.min(1, wanted[2] * MARGIN)]
      if (this.domain) this.carry(renderer, this.domain, next)
      else this.begin(renderer, next)
      this.domain = next
    }
    const uniforms = this.simulate(renderer, dt, this.domain)

    renderer.setRenderTarget(previous)
    renderer.autoClear = autoClear
    return { ...uniforms, uDomain: this.domain }
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose()
    this.disposables = []
  }
}

// The view is sampled on a 5 × 5 grid over the screen
export const VIEW_SAMPLES = 5

/** A point on the orthographic projection centred on `d`, in earth radii; and whether it faces it */
function project(d: Domain, p: LngLatRad) {
  const dl = p.lng - d[0]
  const cl = Math.cos(p.lat)
  return {
    x: cl * Math.sin(dl),
    y: Math.cos(d[1]) * Math.sin(p.lat) - Math.sin(d[1]) * cl * Math.cos(dl),
    front: Math.sin(d[1]) * Math.sin(p.lat) + Math.cos(d[1]) * cl * Math.cos(dl),
  }
}
/** The smallest square, centred where the view's centre meets the globe, that holds the view */
export function viewDomain(points: LngLatRad[]): Domain {
  const centre = points[(points.length - 1) / 2]!
  const d: Domain = [centre.lng, centre.lat, 1]
  let s = 0.01
  for (const p of points) {
    const q = project(d, p)
    s = q.front < 0 ? 1 : Math.max(s, Math.abs(q.x), Math.abs(q.y))
    if (s >= 1) break
  }
  d[2] = Math.min(1, s)
  return d
}
export function needsNewDomain(current: Domain, wanted: Domain, points: LngLatRad[]): boolean {
  // Zoomed well in: a finer square
  if (wanted[2] * MARGIN < current[2] * 0.6) return true
  // Some of the view off this one
  for (const p of points) {
    const q = project(current, p)
    const edge = current[2] * 0.98
    if (q.front < -0.02 || Math.abs(q.x) > edge || Math.abs(q.y) > edge) return true
  }
  return false
}
