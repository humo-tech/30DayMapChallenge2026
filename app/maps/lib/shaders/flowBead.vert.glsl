// Beads (FlowArcsMeshDesc): one point sprite per flow, where its bead is along the arc, as
// bright and as big as its bikes; none while resting or for a flow too faint to see.
#include <common>
#include <logdepthbuf_pars_vertex>
uniform float uSize; // CSS px for one bike
uniform float uPixelRatio;
varying float vAlpha;
// (flowCommon.glsl is inserted here)
#include <flowCommon>

void main() {
  float lit = flowLit();
  vec2 b = bead();
  if (lit < 0.03 || b.x < 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // off screen: nothing to draw
    gl_PointSize = 0.0;
    return;
  }
  setTops();
  vAlpha = min(1.0, lit);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(arcPoint(b.x), 1.0);
  gl_PointSize = uSize * (0.6 + 0.4 * sqrt(min(lit, 6.0))) * uPixelRatio;
  #include <logdepthbuf_vertex>
}
