// Pass 1: what the clouds are at each place of one grid (the fine or the coarse scans'), from
// the scans either side of this moment, followed along the optical flow between them

layout(location = 0) out vec4 outColumn;
layout(location = 1) out vec4 outTb;

// The grid being baked
uniform vec4 uBakeBox;
uniform vec2 uBakeSize;
// The scans: brightness temperature (K) sharp and blurred (r, g), the one before (A) and after
// (B) this moment, and the optical flow from one to the other (cells); f is how far along
uniform sampler2D uFineA;
uniform sampler2D uFineB;
uniform sampler2D uFineFlow;
uniform float uFineF;
uniform sampler2D uCoarseA;
uniform sampler2D uCoarseB;
uniform sampler2D uCoarseFlow;
uniform float uCoarseF;

// One run of scans at ll; and how far inside its box (0 at the edge, 1 a degree in)
vec2 fieldAt(sampler2D a, sampler2D b, sampler2D flow, vec4 box, float f, vec2 ll, out float inside) {
  vec2 uv = (ll - box.xy) / box.zw;
  vec2 m = min(uv, 1.0 - uv) * box.zw;
  inside = smoothstep(0.0, 1.0, min(m.x, m.y));
  if (inside <= 0.0) return vec2(SEA_K);
  vec2 fl = texture(flow, uv).xy / vec2(textureSize(flow, 0));
  vec2 ta = texture(a, uv - f * fl).xy;
  vec2 tb = texture(b, uv + (1.0 - f) * fl).xy;
  return mix(ta, tb, f);
}
// The brightness temperature sharp (x) and blurred (y): the fine scans, fading into the coarse
vec2 tbAt(vec2 ll) {
  float wc;
  float wf;
  vec2 c = mix(vec2(SEA_K), fieldAt(uCoarseA, uCoarseB, uCoarseFlow, uCoarseBox, uCoarseF, ll, wc), wc);
  vec2 f = fieldAt(uFineA, uFineB, uFineFlow, uFineBox, uFineF, ll, wf);
  return mix(c, f, wf);
}

// The cloud top's real height (km); none over a clear sky, whose warm sea reads near SEA_K
float topOf(float tb) { return clamp((SEA_K - tb) / LAPSE, 0.0, TROPO) * smoothstep(292.0, 278.0, tb); }

// What kind of cloud a top this cold is (0 - 1): x deep (cumulonimbus, the central overcast),
// y cirrus (high, thin), z low (warm tops: cumulus)
vec3 kindsOf(vec2 tb) {
  float deep = smoothstep(238.0, 212.0, mix(tb.y, tb.x, 0.6));
  float high = smoothstep(268.0, 242.0, mix(tb.y, tb.x, 0.4));
  float low = smoothstep(291.0, 281.0, tb.x) * (1.0 - high);
  return vec3(deep, max(high - deep, 0.0), low);
}

void main() {
  vec2 ll = uBakeBox.xy + gl_FragCoord.xy / uBakeSize * uBakeBox.zw;
  vec2 tb = tbAt(ll);
  // The tops from the blurred scans, but down to the sharp ones where those are far lower (the
  // eye)
  float top = min(topOf(tb.y), topOf(tb.x) + 4.0);
  outColumn = vec4(top, kindsOf(tb));
  outTb = vec4(tb.x, 0.0, 0.0, 1.0);
}
