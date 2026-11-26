// Day 27: what every pass shares (prepended to each by render.py): the scans, the clouds made
// of them, the air.
//
// The earth is a sphere of R km; positions are ECEF in km (x towards 0°E, y 90°E, z north).
// The clouds are drawn uExag times taller than life; the air is not (its light is worked out
// at each point's real height).
//
// Each frame is drawn in three passes, the first two baking what the third would otherwise
// work out again and again at every step of every pixel:
// 1. columns.frag: what the clouds are at each place (their top, kinds, whiteness), from the
//    scans either side of this moment -> uColFine / uColCoarse (2D)
// 2. light.frag: how much cloud lies between each point of the storm and the sun -> uLight (a
//    3D grid, its layers tiled in 2D)
// 3. scene.frag: the clouds, the sea and the air, raymarched

uniform vec3 uSun;
uniform float uExag;
uniform float uSigma;
// Seconds since the first scan: how far the detail has drifted on the wind
uniform float uDrift;
uniform float uSeed;
// 0: no clouds at all (the sea, the land and the track alone)
uniform float uClouds;

// The scans' boxes: west, south, width, height (°). Fine: every 10 minutes at 0.02°, round
// the storm; coarse: Day 26's hourly 0.125°, out to the horizon
uniform vec4 uFineBox;
uniform vec4 uCoarseBox;
// The clouds at each place (pass 1): top (km, real), and how deep, cirrus and low (rgba);
// and the brightness temperature (K, r)
uniform sampler2D uColFine;
uniform sampler2D uColFineTb;
uniform sampler2D uColCoarse;
uniform sampler2D uColCoarseTb;
// The highest top (km, real) over blocks of those grids and their neighbours (pass 1b)
uniform sampler2D uTopMaxFine;
uniform sampler2D uTopMaxCoarse;
// ECMWF's wind (m/s, east and north) at 850 hPa (rg) and 200 hPa (ba)
uniform sampler2D uWinds;
uniform vec4 uWindBox;
uniform sampler3D uNoise;
// The cloud between each point and the sun (pass 2): optical depth on a grid over the fine
// box, uLightGrid.z layers from the cloud base to the top, tiled uLightGrid.w across
uniform sampler2D uLight;
uniform vec4 uLightGrid;
// How far towards the sun to look (km, as drawn): past a while, the light's let through, as if
// scattered round (and the tops at a low sun stay lit, as they look)
uniform float uLightReach;

const float PI = 3.14159265;
const float R = 6371.0;
const float ATM = 80.0;
// Cloud tops: from a sea at SEA_K, cooling LAPSE K/km, up to the tropopause (km, real)
const float SEA_K = 300.0;
const float LAPSE = 6.5;
const float TROPO = 16.5;
const float BASE = 0.6;
// The air: Rayleigh and Mie scattering (1/km at sea level) and their scale heights (km)
const vec3 BETA_R = vec3(5.8e-3, 13.5e-3, 33.1e-3);
const float H_R = 8.0;
const float BETA_M = 4e-3;
const float H_M = 1.2;
const vec3 SUN = vec3(1.0, 0.97, 0.93) * 20.0;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7)) + uSeed) * 43758.5453); }
float topMax() { return TROPO * uExag * 1.02; }

vec2 llOf(vec3 p) { return vec2(degrees(atan(p.y, p.x)), degrees(asin(p.z / length(p)))); }
vec3 dirOf(vec2 ll) {
  vec2 r = radians(ll);
  return vec3(cos(r.y) * cos(r.x), cos(r.y) * sin(r.x), sin(r.y));
}
bool inBox(vec2 uv) { return all(greaterThan(uv, vec2(0.0))) && all(lessThan(uv, vec2(1.0))); }

vec4 windsAt(vec2 ll) { return texture(uWinds, (ll - uWindBox.xy) / uWindBox.zw); }

// --- the clouds -----------------------------------------------------------------------

// The clouds at ll (pass 1's): top, kinds; and the brightness temperature
vec4 columnAt(vec2 ll, out float tb) {
  vec2 uv = (ll - uFineBox.xy) / uFineBox.zw;
  if (inBox(uv)) {
    tb = texture(uColFineTb, uv).r;
    return texture(uColFine, uv);
  }
  uv = (ll - uCoarseBox.xy) / uCoarseBox.zw;
  if (inBox(uv)) {
    tb = texture(uColCoarseTb, uv).r;
    return texture(uColCoarse, uv);
  }
  tb = SEA_K;
  return vec4(0.0);
}

// The highest cloud top anywhere near ll (km, real), and how far it's safe to stride for it
// (km): a block's width
float topNear(vec2 ll, out float reach) {
  vec2 uv = (ll - uFineBox.xy) / uFineBox.zw;
  if (inBox(uv)) {
    reach = 30.0;
    return texture(uTopMaxFine, uv).r;
  }
  uv = (ll - uCoarseBox.xy) / uCoarseBox.zw;
  reach = 60.0;
  return inBox(uv) ? texture(uTopMaxCoarse, uv).r : 0.0;
}

// The cloud's density (0 - 1) at p before its detail: each kind its own profile up the column
float coarseDensity(vec3 p, out vec2 ll, out float h, out float hf, out vec3 kind, out float tb) {
  h = (length(p) - R) / uExag;
  kind = vec3(0.0);
  hf = 0.0;
  tb = SEA_K;
  if (uClouds < 0.5 || h < BASE || h > TROPO * 1.02) return 0.0;
  ll = llOf(p);
  vec4 col = columnAt(ll, tb);
  float top = col.x;
  if (h > top) return 0.0;
  hf = (h - BASE) / max(top - BASE, 0.1);
  kind = col.yzw;
  float deep = smoothstep(0.0, 0.06, hf) * (1.0 - smoothstep(0.88, 1.0, hf)) * (1.0 + 2.0 * (1.0 - smoothstep(0.75, 0.95, hf)));
  float cirrus = smoothstep(0.66, 0.82, hf) * (1.0 - smoothstep(0.92, 1.0, hf)) * 1.4;
  float low = smoothstep(0.0, 0.15, hf) * (1.0 - smoothstep(0.45, 1.0, hf));
  return dot(kind, vec3(deep, cirrus, low));
}
float coarseDensity(vec3 p) {
  vec2 ll;
  float h;
  float hf;
  vec3 kind;
  float tb;
  return coarseDensity(p, ll, h, hf, kind, tb);
}

// The detail: a tiling cellular noise in km as drawn (round puffs on screen), carried on the
// wind: the low clouds' on the 850 hPa wind, the high ones' on the 200 hPa. Carried for a
// while, then started again, two such half a while apart, crossfaded (a flow map)
float puffs(vec3 q) {
  return texture(uNoise, q).r * 0.45 + texture(uNoise, q * 2.7 + 0.37).r * 0.27 + texture(uNoise, q * 7.3 + 0.71).r * 0.17
    + texture(uNoise, q * 19.7 + 0.13).r * 0.11;
}
float detail(vec2 ll, float h) {
  vec4 w4 = windsAt(ll);
  vec2 wind = mix(w4.xy, w4.zw, smoothstep(3.0, 10.0, h)) * 1e-3;
  vec2 xy = vec2((ll.x - 136.0) * 111.32 * cos(radians(ll.y)), (ll.y - 16.0) * 110.95);
  const float WHILE = 2400.0;
  float a = fract(uDrift / WHILE);
  float b = fract(uDrift / WHILE + 0.5);
  float wa = 1.0 - abs(2.0 * a - 1.0);
  vec3 pa = vec3(xy - wind * a * WHILE, h * uExag) / 16.0;
  vec3 pb = vec3(xy - wind * b * WHILE + 23.0, h * uExag) / 16.0;
  return mix(puffs(pb), puffs(pa), wa);
}
float fineDensity(vec3 p, out float hf, out float tb) {
  vec2 ll;
  float h;
  vec3 kind;
  float dens = coarseDensity(p, ll, h, hf, kind, tb);
  if (dens <= 0.001) return 0.0;
  float w = max(kind.x + kind.y + kind.z, 1e-3);
  float n = detail(ll, h);
  // Eaten away by it: the deep cloud a little at its sides and much at its top (the towers
  // and the anvil's rim), cirrus into wisps, cumulus into heaps
  float erode = (kind.x * mix(0.15, 0.45, hf) + kind.y * 0.6 + kind.z * 0.85) / w;
  return max((dens - (1.0 - n) * erode) / (1.0 - erode * 0.6), 0.0);
}
float fineDensity(vec3 p) {
  float hf;
  float tb;
  return fineDensity(p, hf, tb);
}

// Pass 2's optical depth from p to the sun (false outside its grid); above the grid's top
// there's no cloud left to cross
bool bakedTau(vec3 p, out float tau) {
  tau = 0.0;
  vec2 uv = (llOf(p) - uFineBox.xy) / uFineBox.zw;
  if (!inBox(uv)) return false;
  float base = BASE * uExag;
  float layers = uLightGrid.z;
  float z = (length(p) - R - base) / (topMax() - base) * (layers - 1.0);
  if (z > layers - 1.0) return true;
  z = max(z, 0.0);
  float z0 = floor(z);
  float z1 = min(z0 + 1.0, layers - 1.0);
  // (kept half a texel inside each tile, so its neighbours don't bleed in)
  vec2 inner = clamp(uv, 0.5 / uLightGrid.xy, 1.0 - 0.5 / uLightGrid.xy);
  float cols = uLightGrid.w;
  vec2 tiles = vec2(cols, ceil(layers / cols));
  vec2 t0 = (vec2(mod(z0, cols), floor(z0 / cols)) + inner) / tiles;
  vec2 t1 = (vec2(mod(z1, cols), floor(z1 / cols)) + inner) / tiles;
  tau = mix(texture(uLight, t0).r, texture(uLight, t1).r, z - z0);
  return true;
}

// --- the air ----------------------------------------------------------------------------

vec2 sphere(vec3 o, vec3 d, float r) {
  float b = dot(o, d);
  float c = dot(o, o) - r * r;
  float disc = b * b - c;
  if (disc < 0.0) return vec2(1e20, -1e20);
  float s = sqrt(disc);
  return vec2(-b - s, -b + s);
}

// The air's optical depth from height h (km) up to the sun at cos(zenith) c, scaled by its
// density at h (Schüler's approximation of the Chapman function)
float chapman(float X, float h, float c) {
  float s = sqrt(X + h);
  if (c >= 0.0) return s / (s * c + 1.0) * exp(-h);
  float x0 = sqrt(1.0 - c * c) * (X + h);
  float s0 = sqrt(x0);
  return 2.0 * s0 * exp(X - x0) - s / (1.0 - s * c) * exp(-h);
}
// What of the sun gets through the air to a point h km up whose zenith is at cos c
vec3 sunThrough(float h, float c) {
  // (below the earth's edge from there: in its shadow)
  float horizon = -sqrt(max(1.0 - (R / (R + h)) * (R / (R + h)), 0.0));
  if (c < horizon - 0.02) return vec3(0.0);
  float tR = H_R * chapman(R / H_R, h / H_R, c);
  float tM = H_M * chapman(R / H_M, h / H_M, c);
  return exp(-(BETA_R * tR + BETA_M * 1.1 * tM)) * smoothstep(horizon - 0.02, horizon + 0.01, c);
}
float phaseR(float c) { return 3.0 / (16.0 * PI) * (1.0 + c * c); }
float hg(float c, float g) { return (1.0 - g * g) / pow(max(1.0 + g * g - 2.0 * g * c, 1e-4), 1.5) / (4.0 * PI); }
