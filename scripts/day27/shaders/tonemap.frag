#version 410
// The frame exposed on a filmic curve (Narkowicz's fit of ACES), to sRGB

in vec2 vNdc;
out vec4 fragColor;

uniform sampler2D uHdr;
uniform float uExposure;

void main() {
  vec3 c = texelFetch(uHdr, ivec2(gl_FragCoord.xy), 0).rgb * uExposure;
  vec3 x = (c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14);
  // A faint vignette, as a lens would
  float v = 1.0 - 0.18 * pow(length(vNdc * vec2(0.8, 1.0)) / 1.28, 2.5);
  x = clamp(x * v, 0.0, 1.0);
  fragColor = vec4(pow(x, vec3(1.0 / 2.2)), 1.0);
}
