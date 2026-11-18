// A globe of toast for Navara: a shell over the ellipsoid, its land toasted brown with a darker,
// crisp rim along every coast and a golden halo out over the sea, the sea soft white crumb, and
// a crust round the globe's edge. Land comes as a mask blurred three ways (scripts/day19/
// toast_globe.py): R crisp, G a little, B a lot.
//
// It also carries the photos of the real slice of toast, pinned to the map where the burnt Japan
// on it meets the real one (a similarity transform from the photo to an orthographic projection
// round Japan, so the slice is square to a camera straight above), with a finer land mask in the
// photo's own pixels for the coast there: so the photo can turn into the globe. Over the photo,
// Japan's own coast (to pick out in gold), the slice's outline in the last photo, and where the
// heat comes off it: there the toast shimmers in the rising hot air, and glows warm from within.
// Fresh out of the toaster, a honey-gold aura lifts off the slice's edge, the crust is lit warm
// from inside, and fine cracks open in it for a moment as it cools.
import { MeshDesc, setupMaterialForMRT, type MeshConfig, type MeshUpdate } from '@navaramap/three'
import { BufferGeometry, Color, Mesh, RepeatWrapping, ShaderMaterial, Texture, Vector2, Vector3, Vector4 } from 'three'
import { ellipsoidGrid } from './waveField'

type ToastGlobeOptions = {
  /** The land over the globe, equirectangular, north up */
  land: Texture
  /** The land in the photos' pixels */
  breadLand: Texture
  /** The real crumb (light and shade, 128 its own tone), tiling */
  crumb: Texture
  /** The real toast's browned surface (light and shade, 80 its own tone), tiling */
  toasted: Texture
  /** Over the photos: R Japan alone, blurred as breadLand's G; G the slice in the last photo; B the heat off Japan */
  slice: Texture
  /** ortho = [a -c; c a] (u, -v) + (tx, ty), for the photos' uv (0-1, v down) */
  frame: { a: number; c: number; tx: number; ty: number }
  /** The orthographic projection's centre (deg) */
  projection: { lng: number; lat: number }
  /** What the screen shows past the photo before the globe comes up */
  background: Color
}
type Description = { toastGlobe?: ToastGlobeOptions }
export type ToastGlobeConfig = MeshConfig & Description
type ToastGlobeUpdate = MeshUpdate & Description

/** How much of each thing shows, 0-1 */
export type ToastGlobeState = {
  /** The photo over the globe */
  photo: number
  /** ... and of it, the plate round the slice too (0: only the slice) */
  plate: number
  /** The globe round the photo (0: background) */
  globe: number
  /** The golden line along Japan's coast */
  edge: number
  /** The heat off the toast: shimmer and a warm glow */
  heat: number
}

// The shell sits this high (m), over the ellipsoid's own tessellation
const LIFT = 1_000

const vertexShader = /* glsl */ `
  varying vec2 vGeo;
  varying vec3 vNormal;
  varying vec3 vDir;
  varying vec3 vView;
  void main() {
    vGeo = uv;
    vDir = normalize(position);
    vNormal = normalize(normalMatrix * vDir);
    vec4 p = modelViewMatrix * vec4(position, 1.0);
    vView = p.xyz;
    gl_Position = projectionMatrix * p;
  }
`

// setupMaterialForMRT appends the G-buffer writes before main()'s closing brace: keep main() last
const fragmentShader = /* glsl */ `
  uniform sampler2D uLand;
  uniform sampler2D uBreadLand;
  uniform sampler2D uSlice;
  uniform sampler2D uCrumb;
  uniform sampler2D uToasted;
  uniform sampler2D uPhoto;
  uniform vec4 uFrame;
  uniform vec2 uCenter;
  uniform vec3 uBackground;
  uniform float uPhotoMix;
  uniform float uPlate;
  uniform float uGlobe;
  uniform float uEdge;
  uniform float uHeat;
  uniform float uTime;
  varying vec2 vGeo;
  varying vec3 vNormal;
  varying vec3 vDir;
  varying vec3 vView;

  #define PI 3.141592653589793
  // Crumb tiles to the globe's radius, seen whole
  #define CRUMB_K 3.4
  // ... and as many of its texels to a pixel, wherever seen
  #define CRUMB_TEXELS 5.4
  // The toasted surface likewise (its glints a pixel or two)
  #define TOASTED_K 6.0
  #define TOASTED_TEXELS 2.2

  vec3 srgb(vec3 c) { return pow(c, vec3(2.2)); }

  vec3 hash3(vec3 p) {
    p = vec3(dot(p, vec3(127.1, 311.7, 74.7)), dot(p, vec3(269.5, 183.3, 246.1)), dot(p, vec3(113.5, 271.9, 124.6)));
    return fract(sin(p) * 43758.5453);
  }
  float vnoise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float n000 = hash3(i).x, n100 = hash3(i + vec3(1, 0, 0)).x, n010 = hash3(i + vec3(0, 1, 0)).x, n110 = hash3(i + vec3(1, 1, 0)).x;
    float n001 = hash3(i + vec3(0, 0, 1)).x, n101 = hash3(i + vec3(1, 0, 1)).x, n011 = hash3(i + vec3(0, 1, 1)).x, n111 = hash3(i + vec3(1, 1, 1)).x;
    return mix(mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y), mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y), f.z);
  }
  // Crumb, golden, brown, burnt: how far toasted (0-1) to a color
  vec3 toastColor(float t) {
    vec3 c0 = srgb(vec3(0.95, 0.89, 0.76));
    vec3 c1 = srgb(vec3(0.94, 0.78, 0.50));
    vec3 c2 = srgb(vec3(0.80, 0.51, 0.23));
    vec3 c3 = srgb(vec3(0.50, 0.27, 0.11));
    vec3 c4 = srgb(vec3(0.16, 0.09, 0.05));
    t = clamp(t, 0.0, 1.0);
    if (t < 0.3) return mix(c0, c1, t / 0.3);
    if (t < 0.55) return mix(c1, c2, (t - 0.3) / 0.25);
    if (t < 0.8) return mix(c2, c3, (t - 0.55) / 0.25);
    return mix(c3, c4, (t - 0.8) / 0.2);
  }
  // A photo's tiling light and shade round the globe, k tiles to its radius: projected along each
  // axis and blended by how square the surface is to it
  float triplanar(sampler2D tex, vec3 dir, vec3 w, float k, vec2 shift) {
    return texture2D(tex, dir.yz * k + shift).r * w.x + texture2D(tex, dir.zx * k + shift).r * w.y
      + texture2D(tex, dir.xy * k + shift).r * w.z;
  }
  // ... at a scale that keeps it about that many of its texels to a pixel however near: from far off,
  // k0 tiles; nearer, sets 4x, 16x, ... finer, each fading in as the one before grows too coarse
  float scaleFree(sampler2D tex, vec3 dir, float k0, float size, float texels, vec2 shift) {
    vec3 w = pow(abs(dir), vec3(4.0));
    w /= w.x + w.y + w.z;
    float seen = length(fwidth(dir)) * k0 * size;
    float level = max(log(texels / max(seen, 1e-6)) / log(4.0), 0.0);
    float k = k0 * pow(4.0, floor(level));
    return mix(triplanar(tex, dir, w, k, shift), triplanar(tex, dir, w, k * 4.0, shift), smoothstep(0.0, 1.0, fract(level)));
  }
  // The real crumb (1: its own tone), the holes deeper and the crumb between them brighter
  float crumb(vec3 dir) {
    float c = scaleFree(uCrumb, dir, CRUMB_K, 512.0, CRUMB_TEXELS, vec2(0.0)) / 0.502;
    return clamp(1.0 + (c - 1.0) * 1.6, 0.5, 1.35);
  }
  // The real toast's browned surface (1: its own tone): pits darker, butter glinting above 1.
  // Two layers of it, at scales that don't line up, so its small tile doesn't show repeating
  float toasted(vec3 dir) {
    float a = scaleFree(uToasted, dir, TOASTED_K, 256.0, TOASTED_TEXELS, vec2(0.0));
    float b = scaleFree(uToasted, dir, TOASTED_K * 1.37, 256.0, TOASTED_TEXELS * 1.37, vec2(0.31, 0.67));
    return (a * 0.6 + b * 0.4) / 0.3137;
  }

  // The slice's outline, blurred: read off a coarser mipmap (2^bias px a texel), smoothed by a few
  // taps r (uv) apart
  float sliceBlur(vec2 uv, float bias, float r) {
    float a = texture2D(uSlice, uv, bias).g;
    a += texture2D(uSlice, uv + vec2(r, 0.0), bias).g + texture2D(uSlice, uv - vec2(r, 0.0), bias).g;
    a += texture2D(uSlice, uv + vec2(0.0, r), bias).g + texture2D(uSlice, uv - vec2(0.0, r), bias).g;
    return a / 5.0;
  }
  // Cracks: how near the nearest edge between cells (x), and the cell's own number (z)
  vec3 cracks(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    float d1 = 8.0;
    float d2 = 8.0;
    float id = 0.0;
    for (int y = -1; y <= 1; y++)
      for (int x = -1; x <= 1; x++) {
        vec2 o = vec2(float(x), float(y));
        vec2 r = o + hash3(vec3(i + o, 7.0)).xy - f;
        float d = dot(r, r);
        if (d < d1) {
          d2 = d1;
          d1 = d;
          id = hash3(vec3(i + o, 3.0)).x;
        } else if (d < d2) {
          d2 = d;
        }
      }
    return vec3(sqrt(d2) - sqrt(d1), 0.0, id);
  }

  void main() {
    vec3 normal = vNormal; // read by the G-buffer write appended below
    float lng = (vGeo.x * 360.0 - 180.0) * PI / 180.0;
    float lat = (vGeo.y * 180.0 - 90.0) * PI / 180.0;

    // Where this is in the photos: on the near side of the projection only
    float dl = lng - uCenter.x;
    float cosc = sin(uCenter.y) * sin(lat) + cos(uCenter.y) * cos(lat) * cos(dl);
    vec2 o = vec2(cos(lat) * sin(dl), cos(uCenter.y) * sin(lat) - sin(uCenter.y) * cos(lat) * cos(dl));
    vec2 d = o - uFrame.zw;
    float s2 = dot(uFrame.xy, uFrame.xy);
    vec2 uv = vec2(uFrame.x * d.x + uFrame.y * d.y, uFrame.y * d.x - uFrame.x * d.y) / s2;
    vec2 tuv = vec2(uv.x, 1.0 - uv.y);
    vec2 inner = min(uv, 1.0 - uv);
    float inFrame = step(0.0, min(inner.x, inner.y)) * step(0.0, cosc);

    // The land: the photos' finer mask inside them, the globe's elsewhere
    vec3 land = texture2D(uLand, vGeo).rgb;
    float wFine = inFrame * smoothstep(0.0, 0.08, min(inner.x, inner.y));
    land = mix(land, texture2D(uBreadLand, tuv).rgb, wFine);

    // How far toasted, as a real toast browns: the land deepest inland, golden-brown towards its
    // coast, unevenly, in patches; a golden halo out over the crumb round it
    vec3 dir = vDir;
    float grain = vnoise(dir * 22.0) * 0.6 + vnoise(dir * 70.0) * 0.4;
    float patches = vnoise(dir * 9.0) * 0.6 + vnoise(dir * 31.0) * 0.4;
    float aa = max(fwidth(land.g), 1e-4);
    float isLand = smoothstep(0.5 - aa, 0.5 + aa, land.g);
    float rim = smoothstep(0.5, 0.56, land.g) * (1.0 - smoothstep(0.62, 0.9, land.g));
    float inland = smoothstep(0.5, 0.97, land.b);
    // ... its surface the real toast's: pits browner, the butter on it glinting
    float tz = toasted(dir);
    float tLand = 0.46 + 0.3 * inland + (patches - 0.5) * 0.22 + rim * 0.06 + (1.0 - clamp(tz, 0.0, 1.6)) * 0.16;
    float tSea = 0.06 + 0.42 * pow(land.b, 1.6) + (grain - 0.5) * 0.14;
    float t = mix(tSea, tLand, isLand);
    vec3 col = toastColor(t);
    // Made of real crumb: its holes show through, a little deeper where it's toasted
    float cr = crumb(dir);
    col *= mix(cr, pow(cr, 1.3), isLand);
    col += srgb(vec3(1.0, 0.88, 0.66)) * smoothstep(1.6, 2.8, tz) * 0.16 * isLand;

    // Lit from the upper left, and a crust round the globe's edge
    vec3 n = normalize(vNormal);
    vec3 l = normalize(vec3(-0.45, 0.6, 0.65));
    col *= 0.62 + 0.48 * max(dot(n, l), 0.0);
    // A slice of bread, seen whole: the crumb goes golden near its edge, then a band of crust round
    // it, brown and darker to the outside, with the crumb's texture through it too
    float edgeOn = 1.0 - max(dot(n, normalize(-vView)), 0.0);
    float golden = smoothstep(0.55, 0.74, edgeOn) * (1.0 - isLand * 0.6);
    col = mix(col, col * vec3(1.0, 0.82, 0.58), golden * 0.6);
    float crust = smoothstep(0.71, 0.75, edgeOn);
    vec3 crustCol = mix(srgb(vec3(0.66, 0.40, 0.16)), srgb(vec3(0.36, 0.18, 0.07)), smoothstep(0.8, 0.99, edgeOn));
    // ... standing a little proud of the crumb: rounded over, lit on the side towards the light and
    // shaded on the other, and a little shadow cast on the crumb just inside it
    vec2 radial = normalize(n.xy + 1e-6);
    float lit = dot(radial, normalize(vec2(-0.45, 0.6)));
    float r = length(n.xy);
    float r0 = sqrt(1.0 - 0.29 * 0.29);
    float u = clamp((r - r0) / (1.0 - r0), 0.0, 1.0);
    crustCol *= 1.0 + 0.7 * lit * (1.0 - 2.0 * u) - 0.25 * u * u;
    crustCol += srgb(vec3(0.95, 0.7, 0.4)) * 0.18 * exp(-pow((u - 0.3) / 0.14, 2.0)) * max(lit, 0.0);
    float lip = smoothstep(r0 - 0.03, r0, r) * (1.0 - crust);
    col *= 1.0 - lip * (0.12 + 0.3 * max(lit, 0.0));
    col = mix(col, crustCol * pow(cr, 1.4), crust);

    col = mix(uBackground, col, uGlobe);

    // The photo, and of it the slice alone or the plate round it too
    vec3 slRaw = texture2D(uSlice, tuv).rgb;
    vec3 sl = slRaw * inFrame;
    float plate = smoothstep(0.0, 0.12, min(inner.x, inner.y));
    float photoA = inFrame * mix(sl.g, plate, uPlate) * uPhotoMix;
    // Hot air rising off the toast: the photo shimmers through it, the ripples drifting up
    float heat = sl.b * uHeat;
    vec3 hp = vec3(tuv * vec2(70.0, 45.0) - vec2(0.0, uTime * 2.4), uTime * 0.7);
    vec2 shimmer = vec2(vnoise(hp), vnoise(hp + 17.3)) - 0.5;
    vec3 photo = texture2D(uPhoto, tuv + shimmer * 0.004 * heat).rgb;
    // The light drops a touch as the smell rises, all but round Japan, so the gold in the air shows
    photo *= mix(1.0, 0.88, uHeat * (1.0 - 0.7 * sl.b));
    col = mix(col, photo, photoA);

    // ... and the toast warm from within, the glow slowly breathing
    float breath = 0.8 + 0.2 * sin(uTime * 1.4);
    vec3 amber = srgb(vec3(1.0, 0.62, 0.25));
    col = mix(col, col * vec3(1.12, 0.96, 0.8) + amber * 0.07, clamp(heat * breath * 0.8, 0.0, 1.0));

    // (on uHeat alone: a branch that differs across a frame's edge breaks the textures' mipmaps)
    if (uHeat > 0.0) {
      // Off the slice's edge, a honey-gold aura lifting into the air (once the plate's gone)
      float wob = 0.55 + 0.45 * vnoise(vec3(tuv * vec2(9.0, 5.0) - vec2(0.0, uTime * 0.35), uTime * 0.2));
      float around = sliceBlur(tuv - vec2(0.0, 0.012), 5.0, 0.012);
      float aura = max(around - sl.g, 0.0) * wob * uHeat * (1.0 - uPlate) * uPhotoMix * inFrame;
      col += srgb(vec3(1.0, 0.78, 0.42)) * aura * 0.35;

      // Just inside the crust, the bread warm right through, light showing through its edge
      float crustBand = clamp((sl.g - sliceBlur(tuv, 3.5, 0.005)) * 2.5, 0.0, 1.0) * inFrame;
      col += srgb(vec3(1.0, 0.55, 0.2)) * crustBand * 0.12 * uHeat * photoA;

      // ... and the crust crackling as it cools: fine cracks that open for a moment, warm in them
      vec3 cr = cracks(tuv * 70.0);
      float open = fract(uTime * 0.22 + cr.z);
      float flash = smoothstep(0.0, 0.03, open) * (1.0 - smoothstep(0.06, 0.25, open));
      float crack = (1.0 - smoothstep(0.0, 0.05, cr.x)) * flash;
      col += srgb(vec3(1.0, 0.8, 0.45)) * crack * crustBand * 0.8 * uHeat * photoA;
    }

    // Japan's coast in gold: a fine line and a soft glow round it
    // (the line's width from the unmasked texture: the frame's own edge would read as a coast)
    float ja = clamp(fwidth(slRaw.r), 1e-4, 0.05);
    float line = (1.0 - smoothstep(0.4 * ja, 1.4 * ja, abs(sl.r - 0.5))) * inFrame;
    float glow = exp(-pow((sl.r - 0.5) / (5.0 * ja), 2.0));
    vec3 gold = srgb(vec3(1.0, 0.8, 0.4));
    col = mix(col, gold, uEdge * (0.85 * line + 0.18 * glow));

    gl_FragColor = vec4(col, 1.0);
  }
`

export class ToastGlobeMeshDesc extends MeshDesc<ToastGlobeConfig, ToastGlobeUpdate, Mesh<BufferGeometry, ShaderMaterial>> {
  private config: ToastGlobeConfig
  private material?: ShaderMaterial

  constructor(...args: ConstructorParameters<typeof MeshDesc<ToastGlobeConfig, ToastGlobeUpdate>>) {
    super(...args)
    this.config = args[2] ?? {}
  }

  override createMesh() {
    const { land, breadLand, crumb, toasted, slice, frame, projection, background } = this.config.toastGlobe!
    for (const t of [land, breadLand, crumb, toasted, slice]) {
      t.anisotropy = 8
      t.needsUpdate = true
    }
    for (const t of [crumb, toasted]) t.wrapS = t.wrapT = RepeatWrapping
    const material = new ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        uLand: { value: land },
        uBreadLand: { value: breadLand },
        uCrumb: { value: crumb },
        uToasted: { value: toasted },
        uSlice: { value: slice },
        uPhoto: { value: null },
        uFrame: { value: new Vector4(frame.a, frame.c, frame.tx, frame.ty) },
        uCenter: { value: new Vector2(projection.lng, projection.lat).multiplyScalar(Math.PI / 180) },
        uBackground: { value: new Vector3(...background.toArray()) },
        uPhotoMix: { value: 1 },
        uPlate: { value: 1 },
        uGlobe: { value: 0 },
        uEdge: { value: 0 },
        uHeat: { value: 0 },
        uTime: { value: 0 },
      },
    })
    setupMaterialForMRT(material)
    this.material = material

    const mesh = new Mesh(ellipsoidGrid(1440, 720, LIFT), material)
    mesh.frustumCulled = false
    return mesh
  }

  /** The photo to show (its color space set to sRGB, as it was taken) */
  setPhoto(photo: Texture): void {
    const u = this.material?.uniforms
    if (u) u.uPhoto!.value = photo
  }

  setState(state: ToastGlobeState, time: number): void {
    const u = this.material?.uniforms
    if (!u) return
    u.uPhotoMix!.value = state.photo
    u.uPlate!.value = state.plate
    u.uGlobe!.value = state.globe
    u.uEdge!.value = state.edge
    u.uHeat!.value = state.heat
    u.uTime!.value = time
  }

  override onDestroy(): void {
    const mesh = this.raw
    super.onDestroy()
    mesh?.geometry.dispose()
    this.material?.dispose()
  }
}
