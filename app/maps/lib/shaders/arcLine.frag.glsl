// Arcs (ArcGlowMeshDesc): a faint thread, and a comet tail behind the runner. setupMaterialForMRT
// appends the G-buffer writes before main()'s closing brace, so keep main() last.
uniform float uBase;
uniform float uGrow;
varying float vT;
varying vec3 vColor;
varying vec2 vRunner;
void main() {
  vec3 normal = vec3(0.0, 0.0, 1.0); // read by the G-buffer write appended below
  if (vT > uGrow) discard; // not grown this far yet
  float behind = vRunner.x - vT;
  float k = vRunner.y > 0.0 && behind >= 0.0 && behind < vRunner.y ? pow(1.0 - behind / vRunner.y, 2.0) : 0.0;
  // The thread fades in from the home so the finish, where they all meet, carries the light
  float thread = uBase * (0.35 + 0.65 * vT);
  gl_FragColor = vec4(vColor * (thread + k * 1.4), 1.0);
}
