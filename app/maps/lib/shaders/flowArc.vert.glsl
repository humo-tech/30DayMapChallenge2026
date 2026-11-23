// Flows (FlowArcsMeshDesc): one arc per instance, a ribbon of quads widened on screen, a little
// wider where the bikes arrived, with the bead's place passed on for its comet tail.
// (with three's log depth chunks, as Navara's depth buffer is logarithmic)
#include <common>
#include <logdepthbuf_pars_vertex>
attribute float aT; // along the arc, 0-1
attribute float aSide; // -1 or 1 across the ribbon
uniform vec2 uResolution; // drawing buffer, px
uniform float uPixelRatio;
uniform float uWidth; // px per sqrt(bike) at the wide end
varying float vT;
varying float vSide;
varying float vLit;
varying vec2 vBead; // x: the bead's place along the arc, or -1; y: its tail's length
// (flowCommon.glsl is inserted here)
#include <flowCommon>

const float SEGMENTS = 16.0;
// Tail length = the bead's speed x this (s), at most TAIL_MAX of the arc
const float TAIL_S = 0.3;
const float TAIL_MAX = 0.4;

void main() {
  vLit = flowLit();
  if (vLit < 2e-3) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // off screen: nothing to draw
    return;
  }
  vT = aT;
  vSide = aSide;
  vec2 b = bead();
  vBead = vec2(b.x, min(TAIL_MAX, b.y * TAIL_S));
  setTops();
  mat4 mvp = projectionMatrix * modelViewMatrix;
  vec4 c0 = mvp * vec4(arcPoint(aT), 1.0);
  // The direction along the ribbon on screen, from a neighbouring point
  float ahead = aT < 1.0 ? 1.0 : -1.0;
  vec4 c1 = mvp * vec4(arcPoint(aT + ahead / SEGMENTS), 1.0);
  vec2 dir = (c1.xy / c1.w - c0.xy / c0.w) * uResolution * ahead;
  dir = length(dir) > 1e-6 ? normalize(dir) : vec2(1.0, 0.0);
  float width = min(10.0, 1.0 + uWidth * sqrt(vLit)) * (0.5 + 0.5 * aT) * uPixelRatio;
  // (one px is 2 / resolution in clip space: half the width each side)
  c0.xy += vec2(-dir.y, dir.x) * aSide * width / uResolution * c0.w;
  gl_Position = c0;
  #include <logdepthbuf_vertex>
}
