// Day 6: the sheet, raised by the crumple's height map; the flap right of the tear curls up
uniform sampler2D uHeight;
uniform float uCrumple;
varying vec2 vUv;

void main() {
  vUv = uv;
  vec2 p = vec2(uv.x * uAspect, uv.y);
  float h = texture2D(uHeight, uv).r * uCrumple;
  float len = crackLen();
  if (len > 0.0 && p.y < len) {
    float k = 1.0 - p.y / len;
    h += uTear * 0.03 * k * k * smoothstep(0.0, 0.3, p.x - crackX(p.y));
  }
  vec3 pos = position + vec3(0.0, 0.0, h + 0.002);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
}
