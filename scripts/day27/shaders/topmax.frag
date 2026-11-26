// Pass 1b: the highest cloud top over each block of a grid of pass 1's, and its neighbours:
// where the march may stride through the clear air above

out vec4 outTop;

uniform sampler2D uTopSrc;
uniform int uBlock;

void main() {
  ivec2 size = textureSize(uTopSrc, 0);
  ivec2 b = ivec2(gl_FragCoord.xy);
  float top = 0.0;
  for (int y = (b.y - 1) * uBlock; y < (b.y + 2) * uBlock; y++) {
    for (int x = (b.x - 1) * uBlock; x < (b.x + 2) * uBlock; x++) {
      top = max(top, texelFetch(uTopSrc, clamp(ivec2(x, y), ivec2(0), size - 1), 0).r);
    }
  }
  outTop = vec4(top, 0.0, 0.0, 1.0);
}
