// The front the crater's photo surface sweeps in with, and the value noise its snow drifts
// use: 0 on the crater floor, ~1 at the survey's edges, ragged
export const craterFront = /* glsl */ `
  float craterHash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }
  float craterNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(craterHash(i), craterHash(i + vec2(1.0, 0.0)), f.x),
               mix(craterHash(i + vec2(0.0, 1.0)), craterHash(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  float craterFront(vec3 local) {
    vec2 p = local.xz;
    float n = craterNoise(p / 40.0) * 0.6 + craterNoise(p / 9.0) * 0.3 + craterNoise(p / 2.0) * 0.1;
    return length(p) / 700.0 + (n - 0.5) * 0.18;
  }
`
