// Pass 2: how much cloud lies between each point of the grid over the fine box and the sun
// (optical depth), marched once here rather than at every step of every pixel

out vec4 outTau;


void main() {
  vec2 cell = gl_FragCoord.xy;
  float cols = uLightGrid.w;
  vec2 tile = floor(cell / uLightGrid.xy);
  float layer = tile.y * cols + tile.x;
  if (layer > uLightGrid.z - 1.0) {
    outTau = vec4(0.0);
    return;
  }
  vec2 uv = (cell - tile * uLightGrid.xy) / uLightGrid.xy;
  vec2 ll = uFineBox.xy + uv * uFineBox.zw;
  float base = BASE * uExag;
  float h = base + layer / (uLightGrid.z - 1.0) * (topMax() - base);
  vec3 p = dirOf(ll) * (R + h);

  float far = min(sphere(p, uSun, R + topMax()).y, uLightReach);
  float tau = 0.0;
  if (far > 0.0) {
    const int N = 16;
    // (closer together near the point, where it matters most)
    for (int i = 0; i < N; i++) {
      float s0 = far * pow(float(i) / float(N), 1.6);
      float s1 = far * pow(float(i + 1) / float(N), 1.6);
      tau += coarseDensity(p + uSun * (s0 + s1) * 0.5) * uSigma * (s1 - s0);
    }
  }
  outTau = vec4(tau, 0.0, 0.0, 1.0);
}
