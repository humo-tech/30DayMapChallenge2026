// Day 12's fluid (app/maps/lib/waveFluidSim.ts), ported: the waves as a Navier-Stokes simulation
// (Stable Fluids) over a lng/lat box round the storm, stepped once a frame, each step carrying on
// from the last. The swell pulls it along at the group speed; rough seas stir eddies into it;
// dye in the color of the wave power is poured in a little at a time and carried and marbled by
// the flow. Each pass is one of the PASS_* below (render.py defines which); all read and write
// textures over the box (uv 0 - 1, south first).
//
// Flows are in texels of the flow's grid a second (of the video).

in vec2 vNdc;
out vec4 outColor;

uniform vec4 uBox;
uniform vec2 uTexel;
uniform float uDt;
uniform float uTime;
// ECMWF's waves over their own box: height (m), the way they go (unit, east and north),
// period (s), with land filled from the nearest sea; and how much is sea (0 - 1), and how
// steady their way is (1 all one way, 0 where seas cross)
uniform sampler2D uWaves;
uniform sampler2D uWavesSea;
uniform vec4 uWavesBox;

vec2 uvHere() { return gl_FragCoord.xy * uTexel; }
vec2 llOfUv(vec2 uv) { return uBox.xy + uv * uBox.zw; }

struct Wave {
  vec2 dir;
  float height;
  float period;
  float sea;
  float steady;
};
Wave wave(vec2 ll) {
  vec2 uv = (ll - uWavesBox.xy) / uWavesBox.zw;
  vec4 w = texture(uWaves, uv);
  vec2 s = texture(uWavesSea, uv).rg;
  return Wave(normalize(w.yz + 1e-6), max(w.x, 0.0), max(w.w, 1.0), s.x, s.y);
}
float power(Wave w) { return 0.49 * w.height * w.height * w.period; }

// Wave power (kW/m, on a log scale up to 600) to color, as Day 12's
vec3 ramp(float kw) {
  float t = clamp(log(1.0 + kw) / log(1.0 + 600.0), 0.0, 1.0);
  vec3 c = mix(vec3(0.02, 0.06, 0.28), vec3(0.04, 0.24, 0.72), smoothstep(0.0, 0.38, t));
  c = mix(c, vec3(0.08, 0.62, 0.95), smoothstep(0.32, 0.62, t));
  c = mix(c, vec3(0.48, 0.82, 0.95), smoothstep(0.58, 0.82, t));
  return mix(c, vec3(0.86, 0.86, 0.8), smoothstep(0.8, 1.0, t));
}

float hash3(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float vnoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash3(i), hash3(i + vec3(1, 0, 0)), f.x), mix(hash3(i + vec3(0, 1, 0)), hash3(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(hash3(i + vec3(0, 0, 1)), hash3(i + vec3(1, 0, 1)), f.x), mix(hash3(i + vec3(0, 1, 1)), hash3(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float fbm(vec3 p) { return 0.55 * vnoise(p) + 0.3 * vnoise(p * 2.03 + 7.1) + 0.15 * vnoise(p * 4.01 + 3.7); }
// A noise that changes in place over time: two unrelated ones crossfaded, held to one contrast
float morph(vec3 p, float time) {
  float k = floor(time);
  float f = smoothstep(0.0, 1.0, time - k);
  float a = fbm(p + vec3(17.3, -9.1, 5.7) * k);
  float b = fbm(p + vec3(17.3, -9.1, 5.7) * (k + 1.0));
  return (mix(a, b, f) - 0.5) / sqrt(f * f + (1.0 - f) * (1.0 - f)) + 0.5;
}
// Patches fixed to the globe, about a tenth of the box across (Day 12's: 5 over the square's
// half side, in earth radii; `s` times that)
float patches(vec2 ll, float s, float time) {
  vec2 r = radians(ll);
  vec3 p = vec3(cos(r.y) * cos(r.x), cos(r.y) * sin(r.x), sin(r.y));
  return morph(p * 5.0 / (radians(uBox.w) * 0.5 * s), time * 0.07);
}

#ifdef PASS_MEAN
// The swell's own flow at the group speed (half the crests': a 10 s swell's crests cross
// PHASE_SPEED of the box's height a second, longer ones faster), never projected
uniform float uPhaseSpeed;
void main() {
  vec2 ll = llOfUv(uvHere());
  Wave w = wave(ll);
  float g = 0.5 * uPhaseSpeed * (w.period / 10.0) * uBox.w;
  vec2 deg = g * w.dir / vec2(max(cos(radians(ll.y)), 0.05), 1.0);
  outColor = vec4(deg / uBox.zw / uTexel * smoothstep(0.2, 0.7, w.steady) * smoothstep(0.0, 0.5, w.sea), 0.0, 1.0);
}
#endif

#ifdef PASS_FORCE
// The eddies, stirred where the sea is rough (the curl of a noise fixed to the globe: no
// divergence); still on land
uniform sampler2D uVelocity;
uniform float uStir;
uniform float uPull;
float stirAt(vec2 uv) { return patches(llOfUv(uv), 2.0, uTime * 2.0 + 40.0); }
void main() {
  vec2 uv = uvHere();
  Wave w = wave(llOfUv(uv));
  vec2 v = texture(uVelocity, uv).xy;
  float n = 1.0 / uTexel.y;
  vec2 slope = vec2(stirAt(uv + vec2(uTexel.x, 0.0)) - stirAt(uv - vec2(uTexel.x, 0.0)),
                    stirAt(uv + vec2(0.0, uTexel.y)) - stirAt(uv - vec2(0.0, uTexel.y))) * 0.5 * n / 5.0;
  vec2 target = vec2(slope.y, -slope.x) * uStir * smoothstep(0.5, 8.0, w.height);
  v += (target - v) * (1.0 - exp(-uDt * uPull));
  outColor = vec4(v * smoothstep(0.0, 0.5, w.sea), 0.0, 1.0);
}
#endif

#ifdef PASS_CURL
uniform sampler2D uVelocity;
void main() {
  vec2 uv = uvHere();
  float l = texture(uVelocity, uv - vec2(uTexel.x, 0.0)).y;
  float r = texture(uVelocity, uv + vec2(uTexel.x, 0.0)).y;
  float t = texture(uVelocity, uv + vec2(0.0, uTexel.y)).x;
  float b = texture(uVelocity, uv - vec2(0.0, uTexel.y)).x;
  outColor = vec4(0.5 * (r - l - t + b), 0.0, 0.0, 1.0);
}
#endif

#ifdef PASS_VORTICITY
uniform sampler2D uVelocity;
uniform sampler2D uCurl;
uniform float uConfinement;
void main() {
  vec2 uv = uvHere();
  float l = texture(uCurl, uv - vec2(uTexel.x, 0.0)).x;
  float r = texture(uCurl, uv + vec2(uTexel.x, 0.0)).x;
  float t = texture(uCurl, uv + vec2(0.0, uTexel.y)).x;
  float b = texture(uCurl, uv - vec2(0.0, uTexel.y)).x;
  float c = texture(uCurl, uv).x;
  vec2 force = 0.5 * vec2(abs(t) - abs(b), abs(r) - abs(l));
  force /= length(force) + 1e-4;
  force *= uConfinement * c;
  force.y *= -1.0;
  vec2 v = texture(uVelocity, uv).xy + force * uDt;
  outColor = vec4(clamp(v, -1000.0, 1000.0), 0.0, 1.0);
}
#endif

#ifdef PASS_DIVERGENCE
uniform sampler2D uVelocity;
void main() {
  vec2 uv = uvHere();
  vec2 c = texture(uVelocity, uv).xy;
  float l = uv.x - uTexel.x < 0.0 ? -c.x : texture(uVelocity, uv - vec2(uTexel.x, 0.0)).x;
  float r = uv.x + uTexel.x > 1.0 ? -c.x : texture(uVelocity, uv + vec2(uTexel.x, 0.0)).x;
  float t = uv.y + uTexel.y > 1.0 ? -c.y : texture(uVelocity, uv + vec2(0.0, uTexel.y)).y;
  float b = uv.y - uTexel.y < 0.0 ? -c.y : texture(uVelocity, uv - vec2(0.0, uTexel.y)).y;
  outColor = vec4(0.5 * (r - l + t - b), 0.0, 0.0, 1.0);
}
#endif

#ifdef PASS_PRESSURE
uniform sampler2D uPressure;
uniform sampler2D uDivergence;
uniform float uKeep;
void main() {
  vec2 uv = uvHere();
  float l = texture(uPressure, uv - vec2(uTexel.x, 0.0)).x;
  float r = texture(uPressure, uv + vec2(uTexel.x, 0.0)).x;
  float t = texture(uPressure, uv + vec2(0.0, uTexel.y)).x;
  float b = texture(uPressure, uv - vec2(0.0, uTexel.y)).x;
  outColor = vec4(uKeep * (l + r + b + t - texture(uDivergence, uv).x) * 0.25, 0.0, 0.0, 1.0);
}
#endif

#ifdef PASS_GRADIENT
uniform sampler2D uPressure;
uniform sampler2D uVelocity;
void main() {
  vec2 uv = uvHere();
  float l = texture(uPressure, uv - vec2(uTexel.x, 0.0)).x;
  float r = texture(uPressure, uv + vec2(uTexel.x, 0.0)).x;
  float t = texture(uPressure, uv + vec2(0.0, uTexel.y)).x;
  float b = texture(uPressure, uv - vec2(0.0, uTexel.y)).x;
  outColor = vec4(texture(uVelocity, uv).xy - vec2(r - l, t - b), 0.0, 1.0);
}
#endif

#ifdef PASS_ADVECT
// Semi-Lagrangian: each texel takes what was a step upstream, in the swell's flow and the
// eddies together (flow texels/s; uSimTexel: the flow's grid's texel, which may not be this one)
uniform sampler2D uMean;
uniform sampler2D uVelocity;
uniform sampler2D uSource;
uniform vec2 uSimTexel;
uniform float uDissipation;
void main() {
  vec2 uv = uvHere();
  vec2 from = uv - uDt * (texture(uMean, uv).xy + texture(uVelocity, uv).xy) * uSimTexel;
  outColor = texture(uSource, from) / (1.0 + uDissipation * uDt);
}
#endif

#ifdef PASS_DEEP
// The patches the dye's deeper in: fixed to the globe and never changing, so worked out once
void main() {
  outColor = vec4(smoothstep(0.45, 0.7, patches(llOfUv(uvHere()), 1.0, 0.0)), 0.0, 0.0, 1.0);
}
#endif

#ifdef PASS_INJECT
// Dye added everywhere, a little at a time, easing toward the color of the power there (the
// stormier, and the deeper into a patch, the more); none on land
uniform sampler2D uDye;
uniform sampler2D uDeep;
uniform float uRelax;
uniform float uPlumes;
void main() {
  vec2 uv = uvHere();
  vec2 ll = llOfUv(uv);
  Wave w = wave(ll);
  vec4 dye = texture(uDye, uv);
  float kw = power(w);
  float deep = texture(uDeep, uv).r;
  vec3 target = ramp(kw) * (0.25 + 0.5 * smoothstep(0.0, 250.0, kw)) * (0.35 + uPlumes * deep);
  dye.rgb += (target - dye.rgb) * (1.0 - exp(-uDt * uRelax));
  outColor = vec4(dye.rgb * smoothstep(0.0, 0.5, w.sea), 1.0);
}
#endif
