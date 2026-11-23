// Beads (FlowArcsMeshDesc): a round sprite with a white-hot core and a warm halo, as Day 2's
// pulses. setupMaterialForMRT appends the G-buffer writes before main()'s closing brace, so keep
// main() last.
#include <logdepthbuf_pars_fragment>
uniform vec3 uToColor;
varying float vAlpha;
void main() {
  #include <logdepthbuf_fragment>
  vec3 normal = vec3(0.0, 0.0, 1.0); // read by the G-buffer write appended below
  float d = length(gl_PointCoord - 0.5) * 2.0;
  if (d > 1.0) discard;
  float core = smoothstep(0.45, 0.0, d);
  float halo = pow(1.0 - d, 2.0);
  gl_FragColor = vec4((vec3(1.0) * core * 2.5 + uToColor * halo * 1.2) * vAlpha, 1.0);
}
