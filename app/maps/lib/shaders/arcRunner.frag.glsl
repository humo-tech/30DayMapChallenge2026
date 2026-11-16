// Runners (ArcGlowMeshDesc): a round sprite, a white-hot core in a halo of the arc's color.
// setupMaterialForMRT appends the G-buffer writes before main()'s closing brace, so keep
// main() last.
uniform float uCore;
varying float vAlpha;
varying vec3 vColor;
void main() {
  vec3 normal = vec3(0.0, 0.0, 1.0); // read by the G-buffer write appended below
  float d = length(gl_PointCoord - 0.5) * 2.0;
  if (d > 1.0 || vAlpha <= 0.0) discard;
  float core = smoothstep(0.45, 0.0, d);
  float halo = pow(1.0 - d, 2.0);
  vec3 c = vec3(1.0, 0.97, 0.9) * core * uCore + vColor * halo * 1.3;
  gl_FragColor = vec4(c * vAlpha, 1.0);
}
