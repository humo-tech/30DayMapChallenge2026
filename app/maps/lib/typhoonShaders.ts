// Day 26's shaders: the clouds (raymarched as a volume, drifting with the wind), their shadows
// on the sea, the outline of where there's Himawari, and the track. All of them read the same
// textures and the same storm, so they share the chunk below.
//
// Places are ECEF (the meshes have no transform of their own): the earth's centre is the origin.
// Heights are over a sphere of the earth's radius at the storm, drawn `uExag` times taller than
// life.

/** Shared by every shader: the textures, the storm, and what's read off them. */
export const common = /* glsl */ `
  precision highp sampler3D;
  uniform sampler3D uClouds;
  uniform sampler3D uSmooth;
  uniform sampler3D uWinds;
  // The textures' extents: west, south edges and width, height (°)
  uniform vec4 uCloudBox;
  uniform vec4 uWindBox;
  // Where in time: the cloud scene's and the winds' texture coordinate
  uniform float uCloudW;
  uniform float uWindW;
  // Winds (m/s) = (texel * 255 - 128) * this
  uniform float uWindScale;
  // How far the clouds' detail has drifted: seconds of wind (runs on in real time, sped up)
  uniform float uDrift;
  // Brightness temperature = x + texel * y
  uniform vec2 uTb;
  uniform float uExag;
  // ECEF's axes (Navara's, read off geodeticToVector3)
  uniform vec3 uAxX;
  uniform vec3 uAxY;
  uniform vec3 uAxZ;
  // The earth's radius under the storm: heights are over a sphere this big
  uniform float uR0;
  // The sun, in the storm's east, north, up, and in ECEF
  uniform vec3 uSun;
  uniform vec3 uSunW;
  // The camera (ECEF), and the clouds' extinction at full density (1/m)
  uniform vec3 uCam;
  uniform float uSigma;

  const float M_LAT = 110950.0;
  // The clouds' tops: from a sea at about SEA_K (K), cooling at LAPSE K/m up to the tropopause
  const float SEA_K = 300.0;
  const float LAPSE = 6.5e-3;
  const float TROPOPAUSE = 16500.0;
  // Cloud base (m), under the exaggeration
  const float BASE = 600.0;

  float mLon(float lat) { return 111320.0 * cos(radians(lat)); }

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

  // (a clear sky outside the scenes' box)
  bool outside(vec2 uv) { return any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0))); }
  float tbAt(vec2 ll) {
    vec2 uv = (ll - uCloudBox.xy) / uCloudBox.zw;
    if (outside(uv)) return 300.0;
    return uTb.x + texture(uClouds, vec3(uv, uCloudW)).r * uTb.y;
  }
  // ...blurred: the tops as a smooth surface, not a bed of nails
  float tbSmoothAt(vec2 ll) {
    vec2 uv = (ll - uCloudBox.xy) / uCloudBox.zw;
    if (outside(uv)) return 300.0;
    return uTb.x + texture(uSmooth, vec3(uv, uCloudW)).r * uTb.y;
  }
  // The wind (m/s, east and north) at 850 hPa (xy) and 200 hPa (zw); calm outside the box
  vec4 windsAt(vec2 ll) {
    vec2 uv = (ll - uWindBox.xy) / uWindBox.zw;
    if (outside(uv)) return vec4(0.0);
    return (texture(uWinds, vec3(uv, uWindW)) * 255.0 - 128.0) * uWindScale;
  }
  // The cloud top's real height (m); nothing over a clear sky, whose warm sea reads near SEA_K
  float topOf(float tb) {
    return clamp((SEA_K - tb) / LAPSE, 0.0, TROPOPAUSE) * smoothstep(292.0, 278.0, tb);
  }
  // ...as drawn (m): the blurred tops, but down to the sharp ones where those are far lower, so
  // the eye stays open
  float shownAt(vec2 ll) { return min(topOf(tbSmoothAt(ll)), topOf(tbAt(ll)) + 4000.0) * uExag; }
  // How much of a cloud there is, 0 - 1
  float coverOf(float tb) { return smoothstep(291.0, 262.0, tb); }
  // Thinning out just inside the scenes' edges (the outline marks them)
  float edgeOf(vec2 ll) {
    vec2 inBox = min(ll - uCloudBox.xy, uCloudBox.xy + uCloudBox.zw - ll);
    return smoothstep(0.0, 0.6, min(inBox.x, inBox.y));
  }

  // Anywhere: ECEF -> lng/lat (geodetic) and height over the storm's sphere
  vec2 llOfP(vec3 p) {
    float x = dot(p, uAxX);
    float y = dot(p, uAxY);
    float z = dot(p, uAxZ);
    float latc = atan(z, length(vec2(x, y)));
    return vec2(degrees(atan(y, x)), degrees(atan(tan(latc) / (1.0 - 6.69438e-3))));
  }
  float heightOfP(vec3 p) { return length(p) - uR0; }

  // What kind of cloud a top this cold is, as satellite pictures show them (weights 0 - 1):
  // x deep (towering cumulonimbus, the central overcast: thick and bright down to the base),
  // y cirrus (high but not deep: a thin, see-through veil near the top), z low (warm tops: small
  // cumulus, low down)
  vec3 kindsOf(float tb, float tbSmooth) {
    float deep = smoothstep(238.0, 212.0, mix(tbSmooth, tb, 0.6));
    float high = smoothstep(268.0, 242.0, mix(tbSmooth, tb, 0.4));
    float low = smoothstep(291.0, 281.0, tb) * (1.0 - high);
    return vec3(deep, max(high - deep, 0.0), low);
  }

  // The cloud's density (0 - 1) at ECEF p, before the detail: each kind its own profile up the
  // column from the base to the top
  float coarseDensity(vec3 p, out vec2 ll, out float h, out float top, out vec3 kind) {
    h = heightOfP(p);
    ll = llOfP(p);
    top = shownAt(ll);
    float base = BASE * uExag;
    kind = vec3(0.0);
    if (h > top || h < base) return 0.0;
    float hf = (h - base) / max(top - base, 1.0);
    kind = kindsOf(tbAt(ll), tbSmoothAt(ll)) * edgeOf(ll);
    // Deep: solid up to a flat, spreading top (the anvil); thick below its canopy of cirrus,
    // opaque and bright, as from space
    float deep = smoothstep(0.0, 0.06, hf) * (1.0 - smoothstep(0.85, 1.0, hf)) * (1.0 + 2.0 * (1.0 - smoothstep(0.75, 0.95, hf)));
    // Cirrus: a sheet just under the top
    float cirrus = smoothstep(0.66, 0.82, hf) * (1.0 - smoothstep(0.92, 1.0, hf)) * 1.4;
    // Low: rounded heaps
    float low = smoothstep(0.0, 0.15, hf) * (1.0 - smoothstep(0.45, 1.0, hf));
    return dot(kind, vec3(deep, cirrus, low));
  }
  float coarseDensity(vec3 p, out vec2 ll, out float h, out float top) {
    vec3 kind;
    return coarseDensity(p, ll, h, top, kind);
  }

  // How much of the cloud lies between ECEF a and b (optical depth, roughly)
  float cloudBetween(vec3 a, vec3 b, float sigma) {
    float tau = 0.0;
    vec3 d = (b - a) / 8.0;
    float len = length(d);
    vec2 ll;
    float h;
    float top;
    for (int i = 0; i < 8; i++) tau += coarseDensity(a + d * (float(i) + 0.5), ll, h, top) * sigma * len;
    return tau;
  }

  // How much of the sun the clouds hide at ll, from height z0 (m, drawn): along the way to the
  // sun, does the ray pass under a cloud top?
  float shadowAt(vec2 ll, float z0) {
    float flat_ = length(uSun.xy);
    float tanEl = uSun.z / flat_;
    vec2 dir = uSun.xy / flat_;
    float reach = max(TROPOPAUSE * uExag - z0, 0.0) / tanEl;
    float occ = 0.0;
    // (each place starts at its own point within the first step, so the steps don't band)
    float jitter = hash(ll * 517.3);
    for (int k = 0; k < 12; k++) {
      float d = reach * (float(k) + jitter) / 12.0;
      vec2 p = ll + vec2(dir.x * d / mLon(ll.y), dir.y * d / M_LAT);
      float ray = z0 + d * tanEl;
      float soft = 0.08 * TROPOPAUSE * uExag;
      occ = max(occ, smoothstep(ray - soft, ray + soft, shownAt(p)) * coverOf(tbSmoothAt(p)) * edgeOf(p));
    }
    return occ;
  }

`

// --- the sea: the clouds' shadows on it ---------------------------------------------

export const seaVertex = /* glsl */ `
  attribute vec2 aLL;
  attribute vec3 aUp;
  uniform vec3 uPole;
  varying vec2 vLL;
  varying vec3 vPosV;
  varying vec3 vEastV;
  varying vec3 vNorthV;
  varying vec3 vUpV;
  void main() {
    vLL = aLL;
    vec3 east = normalize(cross(uPole, aUp));
    vUpV = normalize(normalMatrix * aUp);
    vEastV = normalize(normalMatrix * east);
    vNorthV = normalize(normalMatrix * cross(aUp, east));
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vPosV = mv.xyz;
    gl_Position = projectionMatrix * mv;
  }
`

export const seaFragment = /* glsl */ `
  uniform vec4 uBox;
  varying vec2 vLL;
  varying vec3 vPosV;
  varying vec3 vEastV;
  varying vec3 vNorthV;
  varying vec3 vUpV;

  // Only the clouds' shadows, laid over the waves (Day 12's fluid, drawn first) and the land
  void main() {
    vec3 normal = normalize(vUpV); // read by the G-buffer write appended below
    float edge = smoothstep(0.0, 2.5, min(min(vLL.x - uBox.x, uBox.z - vLL.x), min(vLL.y - uBox.y, uBox.w - vLL.y)));
    float shade = 0.6 * shadowAt(vLL, 0.0) * edge;
    if (shade < 0.01) discard;
    gl_FragColor = vec4(vec3(0.0), shade);
  }
`

// --- the clouds: raymarched, off screen at a lower resolution --------------------

export const volumeVertex = /* glsl */ `
  varying vec2 vNdc;
  void main() {
    vNdc = position.xy;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`

export const volumeFragment = /* glsl */ `
  uniform mat4 uInvProj;
  uniform mat3 uCamRot;
  uniform sampler3D uNoise;
  uniform int uSteps;
  varying vec2 vNdc;

  // The detail, from a tiling cellular noise, in metres east and north on the earth (heights
  // as in life), carried along by the wind: the low clouds' by the 850 hPa wind, the high ones'
  // by the 200 hPa wind. x puffs (towers and cumulus: three octaves down to a few km), y fibres
  // (cirrus: streaks drawn out along the wind)
  float puffsAt(vec2 xy, float z) {
    vec3 q = vec3(xy, z * 4.0) / 45000.0;
    return texture(uNoise, q).r * 0.5 + texture(uNoise, q * 3.3 + 0.41).r * 0.3 + texture(uNoise, q * 9.7 + 0.77).r * 0.2;
  }
  float fibresAt(vec2 xy, float z, vec2 along) {
    vec3 f = vec3(dot(xy, along) / 70000.0, dot(xy, vec2(-along.y, along.x)) / 9000.0, z / 3000.0);
    return texture(uNoise, f).r * 0.6 + texture(uNoise, f * vec3(3.0, 3.0, 2.0) + 0.29).r * 0.4;
  }
  vec2 detail(vec2 ll, float h, bool wantFibres) {
    float z = h / uExag;
    vec4 w4 = windsAt(ll);
    vec2 wind = mix(w4.xy, w4.zw, smoothstep(3000.0, 10000.0, z));
    vec2 xy = vec2((ll.x - 140.0) * mLon(ll.y), (ll.y - 20.0) * M_LAT);
    // Carried along for a while, then started again: two such, half a while apart, crossfaded
    // so neither restart shows (a flow map)
    const float WHILE = 2400.0;
    float a = fract(uDrift / WHILE);
    float b = fract(uDrift / WHILE + 0.5);
    float wa = 1.0 - abs(2.0 * a - 1.0);
    vec2 pa = xy - wind * a * WHILE;
    vec2 pb = xy - wind * b * WHILE + 23000.0;
    vec2 along = wind / max(length(wind), 0.5);
    float puffs = mix(puffsAt(pb, z), puffsAt(pa, z), wa);
    // (the streaks only where there's cirrus to streak)
    float fibres = wantFibres ? mix(fibresAt(pb, z, along), fibresAt(pa, z, along), wa) : puffs;
    return vec2(puffs, fibres);
  }

  // The cloud's density with its detail (hf: the height up the column, 0 base - 1 top): eaten
  // away by it, the deep cloud a little (crisp, solid), cumulus a lot (broken into heaps), cirrus
  // into streaks
  float fineDensity(vec3 p, out vec2 ll, out float h, out float top, out float hf) {
    vec3 kind;
    float dens = coarseDensity(p, ll, h, top, kind);
    hf = (h - BASE * uExag) / max(top - BASE * uExag, 1.0);
    if (dens <= 0.001) return 0.0;
    float w = max(kind.x + kind.y + kind.z, 1e-3);
    // (the deep cloud's top a canopy of cirrus, streaked like the rest, with towers punching
    // through)
    float canopy = smoothstep(0.75, 0.95, hf);
    vec2 dt2 = detail(ll, h, kind.y > 0.01 || (kind.x > 0.01 && canopy > 0.0));
    float deepDetail = mix(dt2.x, dt2.x * 0.45 + dt2.y * 0.55, canopy);
    float b = (kind.x * deepDetail + kind.y * dt2.y + kind.z * dt2.x) / w;
    float erode = (kind.x * mix(0.25, 0.6, hf) + kind.y * 0.4 + kind.z * 0.8) / w;
    dens = max((dens - (1.0 - b) * erode) / (1.0 - erode * 0.6), 0.0);
    // (and the cirrus streaked, thicker and thinner rather than holed)
    return dens * mix(1.0, 0.45 + 1.1 * dt2.y, kind.y / w);
  }

  // Where a ray from o along d is inside a sphere of radius r round the origin: [near, far]
  vec2 sphere(vec3 o, vec3 d, float r) {
    float b = dot(o, d);
    float c = dot(o, o) - r * r;
    float disc = b * b - c;
    if (disc < 0.0) return vec2(1e20, -1e20);
    float s = sqrt(disc);
    return vec2(-b - s, -b + s);
  }

  float hg(float c, float g) { return (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * c, 1.5) / 12.566; }

  void main() {
    vec4 v = uInvProj * vec4(vNdc, 1.0, 1.0);
    vec3 d = normalize(uCamRot * (v.xyz / v.w));
    vec3 o = uCam;

    float topMax = TROPOPAUSE * uExag * 1.05;
    vec2 outer = sphere(o, d, uR0 + topMax);
    vec2 ground = sphere(o, d, uR0);
    float t0 = max(outer.x, 0.0);
    float t1 = outer.y;
    if (ground.x > 0.0) t1 = min(t1, ground.x);
    if (t1 <= t0) {
      gl_FragColor = vec4(0.0);
      return;
    }

    int n = uSteps;
    float dt = (t1 - t0) / float(n);
    // (each pixel starts at its own point within the first step, so the steps don't band)
    float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    float t = t0 + dt * jitter;

    float cosSun = dot(d, uSunW);
    float phase = mix(hg(cosSun, 0.6), hg(cosSun, -0.2), 0.4);
    vec3 sunCol = vec3(1.0, 0.95, 0.88) * 8.5;
    vec3 col = vec3(0.0);
    float trans = 1.0;
    float base = BASE * uExag;

    for (int i = 0; i < 160; i++) {
      if (i >= n || trans < 0.015) break;
      vec3 p = o + d * t;
      vec2 ll;
      float h;
      float top;
      float hf;
      float dens = fineDensity(p, ll, h, top, hf);
      vec3 emit = vec3(0.0);
      float sigma = 0.0;
      if (dens > 0.0) {
        sigma = dens * uSigma;
        // Sunlight, through the cloud towards the sun
        float tauSun = 0.0;
        vec2 l2;
        float h2;
        float top2;
        for (int k = 1; k <= 4; k++) {
          float s = float(k * k) * 0.012 * topMax;
          tauSun += coarseDensity(p + uSunW * s, l2, h2, top2) * uSigma * 1.5 * float(2 * k - 1) * 0.012 * topMax;
        }
        // Beer's law, darkened at the edges facing away (the powder effect), with a little
        // light that's scattered many times
        float sunT = exp(-tauSun) * (1.0 - exp(-sigma * 6e4)) * 2.0 + exp(-tauSun * 0.2) * 0.12;
        vec3 sky = mix(vec3(0.16, 0.2, 0.3), vec3(0.5, 0.58, 0.72), smoothstep(0.0, 1.0, hf));
        emit = sunCol * phase * sunT + sky * mix(0.5, 1.0, min(dens, 1.0));
        // ...and as white as the scene shows it: the colder the top, the whiter, as Himawari's
        // infrared does, so its own bands, gradients and cold specks show through
        emit *= mix(0.42, 1.0, smoothstep(288.0, 200.0, tbAt(ll)));
      }
      if (sigma > 0.0) {
        float a = exp(-sigma * dt);
        col += trans * emit * (1.0 - a);
        trans *= a;
      }
      t += dt;
    }
    gl_FragColor = vec4(col, 1.0 - trans);
  }
`

export const compositeVertex = /* glsl */ `
  void main() {
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`

export const compositeFragment = /* glsl */ `
  uniform sampler2D uVolume;
  uniform vec2 uViewport;
  void main() {
    vec3 normal = vec3(0.0, 0.0, 1.0); // read by the G-buffer write appended below
    vec4 c = texture2D(uVolume, gl_FragCoord.xy / uViewport);
    // (premultiplied) Exposed on a filmic curve (Narkowicz's fit of ACES) that keeps its
    // gradation into the highlights, and stops short of pure white: the sunlit tops don't clip
    vec3 x = c.rgb / max(c.a, 1e-3) * 0.75;
    vec3 col = clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0) * 0.93;
    // Thin cloud too hides what's under it, near enough: the sea seen through it would only
    // confuse (as if twice as thick, keeping its color)
    float a = 1.0 - (1.0 - c.a) * (1.0 - c.a);
    gl_FragColor = vec4(col * a, a);
  }
`

// --- the outline of the scenes' box ---------------------------------------------------

export const outlineVertex = /* glsl */ `
  void main() {
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

export const outlineFragment = /* glsl */ `
  void main() {
    vec3 normal = vec3(0.0, 0.0, 1.0); // read by the G-buffer write appended below
    gl_FragColor = vec4(0.78, 0.88, 1.0, 0.6);
  }
`

// --- the track -----------------------------------------------------------------

export const trackVertex = /* glsl */ `
  attribute float aHour;
  attribute vec3 aColor;
  varying float vHour;
  varying vec3 vColor;
  void main() {
    vHour = aHour;
    // (under the cloud, as much of it as is in the way: its glow mustn't shine through)
    vColor = aColor * exp(-cloudBetween(position, uCam, uSigma));
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

export const trackFragment = /* glsl */ `
  uniform float uHour;
  varying float vHour;
  varying vec3 vColor;
  void main() {
    vec3 normal = vec3(0.0, 0.0, 1.0); // read by the G-buffer write appended below
    // Behind the storm, its track in the color of its wind; ahead, faint dashes
    float past = step(vHour, uHour);
    float dash = step(0.5, fract(vHour / 4.0));
    float a = mix(0.28 * dash, 0.95, past);
    float seen = max(max(vColor.r, vColor.g), vColor.b);
    gl_FragColor = vec4(mix(vec3(0.85) * seen, vColor, past) * a, a * seen);
  }
`
