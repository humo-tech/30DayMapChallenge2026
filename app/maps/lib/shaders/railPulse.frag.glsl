// Pulses (RailGlowMeshDesc): a round sprite with a white-hot core and a halo in the line color.
// setupMaterialForMRT appends the G-buffer writes before main()'s closing brace, so keep
// main() last.
uniform vec3 uColor;
uniform vec3 uPulseColor;
varying float vAlpha;
void main() {
  vec3 normal = vec3(0.0, 0.0, 1.0); // read by the G-buffer write appended below
  float d = length(gl_PointCoord - 0.5) * 2.0;
  if (d > 1.0 || vAlpha <= 0.0) discard;
  // White-hot core fading out through the line color
  float core = smoothstep(0.45, 0.0, d);
  float halo = pow(1.0 - d, 2.0);
  vec3 c = uPulseColor * core * 3.0 + uColor * halo * 1.5;
  gl_FragColor = vec4(c * vAlpha, 1.0);
}
