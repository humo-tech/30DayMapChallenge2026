// Arcs (ArcGlowMeshDesc): each vertex placed on its arc at `aT`, and the runner's place and
// tail on that arc passed on to the fragment shader. arcPoint.glsl is prepended.
attribute float aT;
attribute vec3 aColor;
uniform float uTailTime;
varying float vT;
varying vec3 vColor;
// x: the runner's place along the arc (t), y: tail length (t); y = 0 while resting
varying vec2 vRunner;
void main() {
  vT = aT;
  vColor = aColor;
  float u = runProgress();
  // (no runner until the arc has grown all the way)
  vRunner = u > 1.0 || uGrow < 1.0 ? vec2(0.0) : vec2(ease(u), min(0.45, easeSpeed(u) / aTiming.y * uTailTime));
  gl_Position = projectionMatrix * modelViewMatrix * vec4(arcPoint(aT), 1.0);
}
