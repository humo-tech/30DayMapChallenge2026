// LEDs (SkytreeLedsMeshDesc): a soft round dot in the lighting color, turning white-hot where
// the sweep or the wipe passes. setupMaterialForMRT appends the G-buffer writes before main()'s
// closing brace, so keep main() last.
uniform vec3 uColor;
uniform vec3 uNextColor;
uniform vec3 uSparkColor;
varying float vGlow;
varying float vSpark;
varying float vNext;
void main() {
  vec3 normal = vec3(0.0, 0.0, 1.0); // read by the G-buffer write appended below
  float d = length(gl_PointCoord - 0.5) * 2.0;
  if (d > 1.0) discard;
  float a = pow(1.0 - d, 1.5);
  vec3 c = mix(mix(uColor, uNextColor, vNext), uSparkColor, clamp(vSpark, 0.0, 1.0));
  gl_FragColor = vec4(c * vGlow * a, 1.0);
}
