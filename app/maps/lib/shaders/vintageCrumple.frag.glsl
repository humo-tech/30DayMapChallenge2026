// Day 6: bakes the crumple into a height map once (R: height, G: how worn the crease is).
// Crumpled paper is flat facets meeting at sharp creases: each layer is a triangulated lattice of
// jittered points, every point at a random height, interpolated linearly across each triangle;
// layers at different scales and angles hide the lattice. Over them, the old map's folds (two
// across, one down the middle), each a kinked ridge or valley.
varying vec2 vUv;

const float JITTER = 0.27;

float lattice(vec2 v, float seed) {
  return hash(v + seed * 17.31);
}

vec2 latticePoint(vec2 v, float seed) {
  return v + (vec2(lattice(v, seed), lattice(v, seed + 1.0)) - 0.5) * 2.0 * JITTER;
}

// Height and closeness to a crease (the smallest barycentric weight) if q is in the triangle
bool triangle(vec2 q, vec2 a, vec2 b, vec2 c, float seed, float amp, out vec2 result) {
  vec2 pa = latticePoint(a, seed);
  vec2 pb = latticePoint(b, seed);
  vec2 pc = latticePoint(c, seed);
  float det = (pb.y - pc.y) * (pa.x - pc.x) + (pc.x - pb.x) * (pa.y - pc.y);
  float u = ((pb.y - pc.y) * (q.x - pc.x) + (pc.x - pb.x) * (q.y - pc.y)) / det;
  float v = ((pc.y - pa.y) * (q.x - pc.x) + (pa.x - pc.x) * (q.y - pc.y)) / det;
  float w = 1.0 - u - v;
  if (min(u, min(v, w)) < -1e-5) return false;
  vec3 h = (vec3(lattice(a, seed + 2.0), lattice(b, seed + 2.0), lattice(c, seed + 2.0)) - 0.5) * 2.0 * amp;
  result = vec2(dot(vec3(u, v, w), h), min(u, min(v, w)));
  return true;
}

vec2 facets(vec2 p, float cell, float amp, float angle, float seed) {
  float cs = cos(angle);
  float sn = sin(angle);
  vec2 q = vec2(p.x * cs - p.y * sn, p.x * sn + p.y * cs) / cell;
  vec2 base = floor(q);
  vec2 result;
  // q may sit in a neighbor's jittered quad
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      vec2 c = base + vec2(float(dx), float(dy));
      vec2 c10 = c + vec2(1.0, 0.0);
      vec2 c11 = c + vec2(1.0, 1.0);
      vec2 c01 = c + vec2(0.0, 1.0);
      // Each quad split along a random diagonal
      if (lattice(c, seed + 3.0) < 0.5) {
        if (triangle(q, c, c10, c11, seed, amp, result)) return result;
        if (triangle(q, c, c11, c01, seed, amp, result)) return result;
      } else {
        if (triangle(q, c, c10, c01, seed, amp, result)) return result;
        if (triangle(q, c10, c11, c01, seed, amp, result)) return result;
      }
    }
  }
  return vec2(0.0, 1.0);
}

vec2 fold(vec2 p, vec2 at, vec2 dir, float reach, float amp) {
  float across = abs(dot(p - at, vec2(-dir.y, dir.x)));
  float r = max(0.0, 1.0 - across / reach);
  return vec2(amp * r * r, max(0.0, 1.0 - across / 0.003));
}

void main() {
  vec2 p = vec2(vUv.x * uAspect, vUv.y);
  vec2 big = facets(p, 0.11, 0.006, 0.4, 1.0);
  float h = big.x + facets(p, 0.045, 0.0025, 1.3, 2.0).x + facets(p, 0.02, 0.0008, 2.2, 3.0).x;
  // The biggest creases rub pale
  float wear = max(0.0, 1.0 - big.y / 0.015) * 0.25;
  vec2 f1 = fold(p, vec2(uAspect / 3.0, 0.5), vec2(0.0, 1.0), 0.2, 0.012);
  vec2 f2 = fold(p, vec2(uAspect * 2.0 / 3.0, 0.5), vec2(0.0, 1.0), 0.2, -0.012);
  vec2 f3 = fold(p, vec2(uAspect / 2.0, 0.5), vec2(1.0, 0.0), 0.22, 0.01);
  h += f1.x + f2.x + f3.x;
  wear = max(wear, max(f1.y, max(f2.y, f3.y)));
  gl_FragColor = vec4(h, wear, 0.0, 1.0);
}
