// Day 6: a dark walnut desk, with the sheet's soft shadow
uniform float uCrumple;
varying vec2 vWorld;

void main() {
  vec2 w = vWorld;
  float grain = fbm(vec2(w.x * 1.2 + 0.3 * fbm(w * 2.0), w.y * 24.0));
  vec3 col = vec3(0.16, 0.10, 0.06) * (0.7 + 0.6 * grain);

  // World (x, z) -> paper coordinates, shifted away from the light; a crumpled sheet stands
  // higher, so its shadow falls further and softer
  vec2 p = vec2(w.x + uAspect * 0.5, 0.5 - w.y) - vec2(0.4, -0.5) * (0.012 + 0.02 * uCrumple);
  float dist = paperDist(p);
  float blur = 0.008 + 0.025 * uCrumple;
  col *= 1.0 - 0.6 * smoothstep(-blur, blur, dist);

  col *= 1.0 - 0.7 * smoothstep(0.7, 2.6, length(w));
  gl_FragColor = vec4(col, 1.0);
}
