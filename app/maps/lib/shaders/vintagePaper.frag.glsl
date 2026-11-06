// Day 6: the aerial photo aging into a faded, faintly sepia print: fading in from the edges, stains,
// foxing and grain, creases worn pale, shading from the crumple.
// Colors stay in display (sRGB) space throughout.
uniform sampler2D uMap;
uniform sampler2D uHeight;
uniform vec2 uTexel;
uniform float uFade;
uniform float uCrumple;
uniform float uRelief;
uniform vec3 uLight;
varying vec2 vUv;

// Greys warmed with a little sepia
const vec3 DARK = vec3(0.39, 0.36, 0.32);
const vec3 LIGHT = vec3(0.96, 0.94, 0.89);
const vec3 STAIN = vec3(0.92, 0.88, 0.80);
const vec3 EDGE = vec3(0.95, 0.91, 0.84);
const vec3 BACK = vec3(0.89, 0.87, 0.82);

void main() {
  vec2 p = vec2(vUv.x * uAspect, vUv.y);

  // Normal from the height map, per pixel so the creases stay sharp
  float hl = texture2D(uHeight, vUv - vec2(uTexel.x, 0.0)).r;
  float hr = texture2D(uHeight, vUv + vec2(uTexel.x, 0.0)).r;
  float hd = texture2D(uHeight, vUv - vec2(0.0, uTexel.y)).r;
  float hu = texture2D(uHeight, vUv + vec2(0.0, uTexel.y)).r;
  vec2 grad = vec2((hr - hl) / (2.0 * uTexel.x * uAspect), (hu - hd) / (2.0 * uTexel.y)) * uCrumple * uRelief;
  vec3 n = normalize(vec3(-grad, 1.0));
  if (!gl_FrontFacing) n = -n;
  float diff = max(dot(n, uLight), 0.0);
  float shade = 0.35 + 0.65 * diff / uLight.z; // 1 where flat
  float spec = pow(max(reflect(-uLight, n).z, 0.0), 30.0) * 0.06 * uCrumple;

  // Aging creeps in from the edges, unevenly
  float d = min(min(p.x, uAspect - p.x), min(p.y, 1.0 - p.y));
  float inner = smoothstep(0.0, 0.4, d);
  float age = smoothstep(0.0, 1.0, uFade * 1.6 - inner * 0.45 - fbm(p * 3.0 + 7.0) * 0.15);

  vec3 photo = texture2D(uMap, vUv).rgb;
  float lum = dot(photo, vec3(0.299, 0.587, 0.114));
  // Faded: the colors gone, contrast flattened toward the paper
  vec3 aged = mix(DARK, LIGHT, smoothstep(0.03, 0.68, lum));
  aged = mix(aged, LIGHT, 0.15);
  // Water stains, foxing, darkened edges, grain
  float stain = smoothstep(0.5, 0.75, fbm(p * 2.5 + 11.0));
  aged *= mix(vec3(1.0), STAIN, stain * 0.45);
  float ring = smoothstep(0.012, 0.0, abs(length((p - vec2(0.28, 0.3)) * vec2(1.0, 1.1)) - 0.11 - 0.01 * fbm(p * 20.0)));
  aged *= mix(vec3(1.0), STAIN, ring * 0.3);
  float fox = smoothstep(0.78, 0.86, vnoise(p * 70.0)) * smoothstep(0.45, 0.7, fbm(p * 5.0));
  aged *= 1.0 - 0.2 * fox;
  float burn = 1.0 - smoothstep(0.0, 0.05, d + 0.03 * (fbm(p * 12.0) - 0.5));
  aged = mix(aged, aged * EDGE, burn * 0.35);
  aged *= 0.92 + 0.12 * vnoise(p * 900.0) + 0.06 * fbm(vec2(p.x * 40.0, p.y * 400.0));

  vec3 col = mix(photo, aged, age);
  // Folds rubbed pale along their ridges
  float wear = texture2D(uHeight, vUv).g;
  wear *= smoothstep(0.3, 0.7, fbm(p * 18.0));
  col = mix(col, LIGHT, clamp(wear, 0.0, 1.0) * uCrumple * age * 0.35);
  if (!gl_FrontFacing) col = mix(BACK, BACK * STAIN, stain * uFade);
  col = col * shade + spec;
  gl_FragColor = vec4(col, 1.0);
}
