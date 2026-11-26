#version 410
// Pass 3b: the clouds carried on from the frames before (the video's drawn in order, each
// frame after the last). This frame's raymarch (fewer steps, started at a different jitter
// each frame) is blended into what the last frame had at the same place: found by taking this
// pixel's cloud back to where the last frame's camera saw it, and held to the range of this
// frame's neighbours there, so whatever's moved or changed doesn't leave a ghost.

in vec2 vNdc;
layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outDepth;

uniform sampler2D uRaw;
uniform sampler2D uRawDepth;
uniform sampler2D uHistory;
uniform vec3 uCam;
uniform mat3 uCamRot;
uniform vec3 uPrevCam;
uniform mat3 uPrevCamRot;
uniform vec2 uTanFov;
// How much of this frame goes in (1: none of the last; the first frame)
uniform float uBlend;

void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  ivec2 size = textureSize(uRaw, 0);
  vec4 raw = texelFetch(uRaw, px, 0);
  float depth = texelFetch(uRawDepth, px, 0).r;
  outDepth = vec4(depth);

  // The range of this frame round here
  vec4 lo = raw;
  vec4 hi = raw;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec4 c = texelFetch(uRaw, clamp(px + ivec2(x, y), ivec2(0), size - 1), 0);
      lo = min(lo, c);
      hi = max(hi, c);
    }
  }

  // Where the last frame saw this
  vec3 d = normalize(uCamRot * vec3(vNdc * uTanFov, -1.0));
  vec3 p = uCam + d * depth;
  vec3 v = transpose(uPrevCamRot) * (p - uPrevCam);
  vec2 uv = (v.xy / -v.z / uTanFov) * 0.5 + 0.5;
  if (uBlend >= 1.0 || v.z >= 0.0 || any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) {
    outColor = raw;
    return;
  }
  vec4 last = clamp(texture(uHistory, uv), lo, hi);
  outColor = mix(last, raw, uBlend);
}
