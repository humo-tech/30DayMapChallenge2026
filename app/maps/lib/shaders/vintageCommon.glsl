// Day 6: shared by the paper and the desk (whose shadow follows the torn outline).
// Paper coordinates p: x in [0, uAspect] west to east, y in [0, 1] south to north.
uniform float uAspect;
uniform float uTear;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

float fbm(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    s += a * vnoise(p);
    p = p * 2.03 + 17.1;
    a *= 0.5;
  }
  return s;
}

// The tear runs up from the bottom edge, wandering a little
float crackX(float y) {
  return 0.62 * uAspect + 0.04 * y + 0.06 * (fbm(vec2(y * 5.0, 3.7)) - 0.5);
}

float crackLen() {
  return 0.34 * uTear;
}

// Signed distance (paper units) to the paper's outline as it tears; negative is gone.
// `fiber` is how much of the torn edge's white fibre shows here.
float tornDist(vec2 p, out float fiber) {
  // Edges: frayed and chipped
  float d = min(min(p.x, uAspect - p.x), min(p.y, 1.0 - p.y));
  float rag = uTear * (0.003 + 0.008 * fbm(p * 30.0) + 0.03 * smoothstep(0.55, 0.75, fbm(p * 4.0 + 3.0)));
  float edge = d - rag;

  // The top-right corner torn off along a jagged diagonal
  float q = (uAspect - p.x) + (1.0 - p.y);
  float jag = 0.06 * (fbm(vec2((p.x - p.y) * 9.0, 1.3)) - 0.5);
  float corner = (q - uTear * (0.17 + jag)) * 0.7071;

  // The tear: a gap opening from the bottom edge, a hairline toward its tip
  float crack = 1.0;
  float len = crackLen();
  if (len > 0.0) {
    if (p.y < len) {
      float k = 1.0 - p.y / len;
      crack = abs(p.x - crackX(p.y)) - 0.009 * k * k + 0.0015 * (fbm(p * 90.0) - 0.5);
    } else {
      crack = length(vec2(p.x - crackX(len), p.y - len));
    }
  }

  float dist = min(edge, min(corner, crack));
  float width = 0.002 + 0.004 * vnoise(p * 300.0);
  fiber = uTear * (1.0 - smoothstep(0.0, width, dist));
  return dist;
}
