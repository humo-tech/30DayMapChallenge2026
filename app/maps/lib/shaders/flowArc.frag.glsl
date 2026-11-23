// Flows (FlowArcsMeshDesc): near white, cool where the bikes left and warm where they arrived,
// as bright as its bikes, soft at the edges, and a comet tail behind the bead.
// setupMaterialForMRT appends the G-buffer writes before main()'s closing brace, so keep main() last.
#include <logdepthbuf_pars_fragment>
uniform float uGain;
uniform vec3 uFromColor;
uniform vec3 uToColor;
varying float vT;
varying float vSide;
varying float vLit;
varying vec2 vBead;
void main() {
  #include <logdepthbuf_fragment>
  vec3 normal = vec3(0.0, 0.0, 1.0); // read by the G-buffer write appended below
  float edge = 1.0 - smoothstep(0.5, 1.0, abs(vSide));
  float behind = vBead.x - vT;
  float tail = vBead.x >= 0.0 && behind >= 0.0 && behind < vBead.y ? pow(1.0 - behind / vBead.y, 2.0) : 0.0;
  // (linear in bikes, so a thousand faint flows shine no more than the bikes they share)
  float k = uGain * min(vLit, 6.0) * (0.2 + 0.5 * vT * vT + 1.6 * tail) * edge;
  gl_FragColor = vec4(mix(uFromColor, uToColor, smoothstep(0.1, 0.9, vT)) * k, 1.0);
}
