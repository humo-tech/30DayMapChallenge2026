// Day 6: the sheet, raised by the crumple's height map
uniform sampler2D uHeight;
uniform float uHeightMin;
uniform float uCrumple;
varying vec2 vUv;

void main() {
  vUv = uv;
  float h = (texture2D(uHeight, uv).r - uHeightMin) * uCrumple;
  vec3 pos = position + vec3(0.0, 0.0, h + 0.002);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
}
