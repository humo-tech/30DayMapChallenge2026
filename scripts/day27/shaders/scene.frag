// Pass 3: the storm's clouds, the sea under them and the air over both, for one frame of the
// video, in two goes: uMode 0, the clouds alone, raymarched at a lower resolution (they're soft:
// half as fine shows no less, at a quarter of the cost); uMode 1, the ground and the air at
// full resolution, with those clouds laid in. Linear light out (summed over any jittered passes,
// then tone mapped by tonemap.frag).

in vec2 vNdc;
layout(location = 0) out vec4 fragColor;
layout(location = 1) out vec4 fragDepth;

uniform int uMode;
// (mode 1) The clouds: their light (premultiplied) and what they let through; and how far
// along the ray they are, on average
uniform sampler2D uCloud;
uniform sampler2D uCloudDepth;

uniform vec3 uCam;
uniform mat3 uCamRot;
uniform vec2 uTanFov;
uniform vec2 uViewport;
uniform vec2 uJitter;
uniform int uSteps;
// Steps towards the sun taken with the clouds' detail before pass 2's take over
const int NEAR = 1;

// --- the air ----------------------------------------------------------------------------

// Light scattered by the air towards the eye between t0 and t1 along o + d t, and what of the
// light from beyond gets through
vec3 airBetween(vec3 o, vec3 d, float t0, float t1, out vec3 trans) {
  vec2 shell = sphere(o, d, R + ATM);
  t0 = max(t0, shell.x);
  t1 = min(t1, shell.y);
  trans = vec3(1.0);
  if (t1 <= t0) return vec3(0.0);
  const int N = 10;
  float ds = (t1 - t0) / float(N);
  float c = dot(d, uSun);
  vec3 sumR = vec3(0.0);
  vec3 sumM = vec3(0.0);
  vec3 tau = vec3(0.0);
  for (int i = 0; i < N; i++) {
    vec3 p = o + d * (t0 + ds * (float(i) + 0.5));
    float r = length(p);
    float h = max(r - R, 0.0);
    float dR = exp(-h / H_R) * ds;
    float dM = exp(-h / H_M) * ds;
    vec3 stepTau = BETA_R * dR + BETA_M * 1.1 * dM;
    vec3 seen = exp(-(tau + stepTau * 0.5)) * sunThrough(h, dot(p, uSun) / r);
    sumR += seen * dR;
    sumM += seen * dM;
    tau += stepTau;
  }
  trans = exp(-tau);
  return SUN * 0.3 * (BETA_R * phaseR(c) * sumR + BETA_M * hg(c, 0.76) * sumM);
}

// The sky's light from above at a point (a rough stand-in for the whole dome): blue by day,
// fading through the twilight, warmer near the sun's horizon
vec3 skyLight(vec3 p) {
  float c = dot(normalize(p), uSun);
  float day = smoothstep(-0.18, 0.25, c);
  vec3 blue = vec3(0.32, 0.5, 0.95);
  vec3 dusk = vec3(0.55, 0.42, 0.55);
  return mix(dusk, blue, smoothstep(0.0, 0.4, c)) * day * 1.5;
}

// --- the ground: the sea and the land ------------------------------------------------------

// The land's heights (m; 0 the sea), Mapterhorn's
uniform sampler2D uTerrain;
uniform vec4 uTerrainBox;
// ECMWF's waves at this moment: significant height (m; < 0 on land), the way they're going (a
// unit vector, east and north), their period (s)
uniform sampler2D uWaves;
uniform vec4 uWavesBox;
// The sea's temperature today (°C, NOAA OISST)
uniform sampler2D uSst;
uniform vec4 uSstBox;
// Champi's track as a field: how far it is (km), the hour (since 15 October 00 UTC) and the
// wind (kt) where it's nearest
uniform sampler2D uTrack;
uniform vec4 uTrackBox;
// The land's highest (km, as drawn) near each block of it
uniform sampler2D uLandMax;
uniform vec4 uLandMaxBox;
uniform float uHour;
// Seconds into the video: what the swell runs on (the hours fly past far too fast for it)
uniform float uClock;
// Day 12's fluid on the sea (the dye, over its box)
uniform sampler2D uDye;
uniform vec4 uDyeBox;
uniform vec2 uDyeTexel;
const float FLATNESS = 0.05;
float lum(vec3 c) { return dot(c, vec3(0.3, 0.5, 0.2)); }
// How brightly the sea shows, and the track; and over the exposure (so they're as bright on
// screen whatever it is)
const float SEA_GLOW = 2.5;
uniform float uGlow;

// The land's height (km, as drawn) at ll
float landAt(vec2 ll) {
  vec2 uv = (ll - uTerrainBox.xy) / uTerrainBox.zw;
  if (!inBox(uv)) return 0.0;
  return texture(uTerrain, uv).r * 1e-3 * uExag;
}
const float LAND_TOP = 4.5;

// East and north at p
mat2x3 tangents(vec3 up) {
  vec3 east = normalize(cross(vec3(0.0, 0.0, 1.0), up));
  return mat2x3(east, cross(up, east));
}
vec2 kmOf(vec2 ll) { return vec2((ll.x - 136.0) * 111.32 * cos(radians(ll.y)), (ll.y - 16.0) * 110.95); }

// How much of the sun the clouds hide at p, along the way to the sun through their layer
float cloudShadow(vec3 p, int n) {
  float baked;
  if (bakedTau(p, baked)) return exp(-baked);
  // (as far as pass 2 looks, so there's no seam at its grid's edge)
  float far = min(sphere(p, uSun, R + TROPO * uExag).y, uLightReach);
  if (far <= 0.0) return 1.0;
  float ds = far / float(n);
  float tau = 0.0;
  float j = hash(p.xy);
  for (int i = 0; i < n; i++) tau += coarseDensity(p + uSun * ds * (float(i) + j)) * uSigma * ds;
  return exp(-tau);
}

// The track's colors by the storm's wind (kt), as Day 26's
vec3 windColor(float kt) {
  vec3 c = vec3(0.75, 0.85, 0.95);
  c = mix(c, vec3(0.55, 0.9, 0.85), smoothstep(25.0, 34.0, kt));
  c = mix(c, vec3(1.0, 0.92, 0.45), smoothstep(34.0, 64.0, kt));
  c = mix(c, vec3(1.0, 0.6, 0.25), smoothstep(64.0, 96.0, kt));
  c = mix(c, vec3(1.0, 0.25, 0.3), smoothstep(96.0, 130.0, kt));
  return mix(c, vec3(0.95, 0.35, 0.95), smoothstep(130.0, 150.0, kt));
}
// The track's light at p on the ground: behind the storm a line in the color of its wind,
// ahead faint dashes
vec3 trackGlow(vec2 ll) {
  const float HALF_WIDTH = 14.0;
  vec2 uv = (ll - uTrackBox.xy) / uTrackBox.zw;
  if (!inBox(uv)) return vec3(0.0);
  vec3 near = texture(uTrack, uv).xyz;
  float line = 1.0 - smoothstep(HALF_WIDTH * 0.5, HALF_WIDTH, near.x);
  if (line <= 0.0) return vec3(0.0);
  float past = step(near.y, uHour);
  float dash = step(0.5, fract(near.y / 4.0));
  return mix(vec3(0.85) * 0.3 * dash, windColor(near.z) * 1.6, past) * line;
}

// The sea's colors by its temperature, as Day 26's: navy where it's too cool to feed a typhoon,
// teal at the 26.5 °C it needs, orange and red over the warm pool
vec3 sstColor(float t) {
  vec3 c = vec3(0.04, 0.1, 0.28);
  c = mix(c, vec3(0.06, 0.26, 0.52), smoothstep(18.0, 23.0, t));
  c = mix(c, vec3(0.08, 0.5, 0.6), smoothstep(23.0, 26.5, t));
  c = mix(c, vec3(0.36, 0.72, 0.5), smoothstep(26.5, 27.6, t));
  c = mix(c, vec3(0.93, 0.8, 0.34), smoothstep(27.6, 28.7, t));
  c = mix(c, vec3(0.96, 0.52, 0.22), smoothstep(28.7, 29.6, t));
  return mix(c, vec3(0.86, 0.22, 0.2), smoothstep(29.6, 30.6, t));
}
// The land's colors by height (m), as Day 26's: green lowlands, yellow-green hills, brown
// mountains, pale peaks
vec3 landColor(float m) {
  vec3 c = vec3(0.17, 0.33, 0.2);
  c = mix(c, vec3(0.32, 0.42, 0.2), smoothstep(1.0, 600.0, m));
  c = mix(c, vec3(0.52, 0.42, 0.25), smoothstep(600.0, 1800.0, m));
  return mix(c, vec3(0.76, 0.7, 0.6), smoothstep(1800.0, 3500.0, m));
}

vec3 groundColor(vec3 p, vec3 d, bool land) {
  vec3 up = normalize(p);
  mat2x3 en = tangents(up);
  vec3 v = -d;
  vec2 ll = llOf(p);
  float cosZ = dot(up, uSun);
  vec3 sun = SUN * sunThrough(0.0, cosZ);
  float shadow = cosZ > -0.05 ? cloudShadow(p, 16) : 0.0;
  vec3 sky = skyLight(p);
  vec3 glow = trackGlow(ll) * uGlow;

  if (land) {
    // Lit by its slope (from the heights either side, as drawn)
    const float D = 0.03;
    float dx = (landAt(ll + vec2(D, 0.0)) - landAt(ll - vec2(D, 0.0))) / (2.0 * D * 111.32 * cos(radians(ll.y)));
    float dy = (landAt(ll + vec2(0.0, D)) - landAt(ll - vec2(0.0, D))) / (2.0 * D * 110.95);
    vec3 n = normalize(up - en[0] * dx - en[1] * dy);
    vec3 alb = landColor(landAt(ll) / uExag * 1e3) * 0.35;
    // (and, as the sea, a faint light of its own, so it doesn't go black by night)
    float relief = 0.6 + 0.4 * max(dot(n, normalize(up + en[0] * -0.5 + en[1] * 0.6)), 0.0);
    return alb * (sun * shadow * max(dot(n, uSun), 0.0) + sky * 0.5 * (0.5 + 0.5 * dot(n, up))) + alb * relief * 1.2 * uGlow + glow;
  }

  float t = texture(uSst, (ll - uSstBox.xy) / uSstBox.zw).r;
  // Day 12's fluid (as Day 26 showed it): its dye's depth as the surface's height, lit from a
  // fixed side as a map is, colored by the sea's temperature, the rougher the lighter
  vec3 mapCol = sstColor(t) * 0.5;
  vec3 n = up;
  vec2 duv = (ll - uDyeBox.xy) / uDyeBox.zw;
  if (inBox(duv)) {
    vec3 dye = texture(uDye, duv).rgb;
    vec2 dd = uDyeTexel * 2.5;
    float hx = lum(texture(uDye, duv + vec2(dd.x, 0.0)).rgb) - lum(texture(uDye, duv - vec2(dd.x, 0.0)).rgb);
    float hy = lum(texture(uDye, duv + vec2(0.0, dd.y)).rgb) - lum(texture(uDye, duv - vec2(0.0, dd.y)).rgb);
    vec3 nm = normalize(vec3(-hx, -hy, FLATNESS));
    const vec3 L = vec3(-0.5, 0.6, 0.62);
    float diffuse = 0.3 + 0.75 * max(dot(nm, normalize(L)), 0.0);
    float shine = pow(max(dot(nm, normalize(normalize(L) + vec3(0.0, 0.0, 1.0))), 0.0), 40.0);
    float energy = 1.0 - exp(-0.9 * lum(dye));
    // (fading into the plain color just inside the box's edges)
    vec2 edge = min(duv, 1.0 - duv) * uDyeBox.zw;
    float inside = smoothstep(0.0, 2.0, min(edge.x, edge.y));
    mapCol = mix(mapCol, sstColor(t) * (0.5 + 0.8 * energy) * diffuse + shine * 0.3 * (0.3 + energy), inside);
    // (and the sun's glint follows the same relief)
    n = normalize(up * FLATNESS * 4.0 - en[0] * hx - en[1] * hy);
  }
  float a2 = 0.06;
  vec3 hv = normalize(uSun + v);
  float nh = max(dot(n, hv), 0.0);
  float Dg = a2 / (PI * pow(nh * nh * (a2 - 1.0) + 1.0, 2.0));
  float nv = max(dot(n, v), 0.02);
  float F = 0.02 + 0.98 * pow(1.0 - nv, 5.0);
  float Fs = 0.02 + 0.98 * pow(1.0 - max(dot(hv, v), 0.0), 5.0);
  vec3 glint = sun * shadow * Dg * Fs / (4.0 * nv) * max(dot(n, uSun), 0.0) * 2.0;
  // The map's color glowing of itself; over it the water's own light: the sky in it, the sun's
  // glint
  vec3 lightIn = sun * max(dot(up, uSun), 0.0) * mix(0.35, 1.0, shadow) + sky;
  vec3 body = vec3(0.004, 0.01, 0.02) * lightIn + mapCol * SEA_GLOW * uGlow;
  return body * (1.0 - F) + sky * 0.15 * F + glint + glow;
}

// --- the clouds ------------------------------------------------------------------------------

void main() {
  vec2 ndc = vNdc + uJitter * 2.0 / uViewport;
  vec3 d = normalize(uCamRot * vec3(ndc * uTanFov, -1.0));
  vec3 o = uCam;

  vec2 ground = sphere(o, d, R);
  float tGround = ground.x > 0.0 ? ground.x : 1e20;
  // The land: down from over its highest to the sea, the first step under its surface, then
  // narrowed down
  bool land = false;
  vec2 hills = sphere(o, d, R + LAND_TOP * uExag);
  // (only where there's land near: the sea under the ray, or where it comes down through the
  // land's highest)
  bool near = false;
  if (hills.y > 0.0) {
    for (int k = 0; k <= 2; k++) {
      float tk = mix(max(hills.x, 0.0), min(hills.y, tGround), float(k) * 0.5);
      vec2 luv = (llOf(o + d * tk) - uLandMaxBox.xy) / uLandMaxBox.zw;
      if (inBox(luv) && texture(uLandMax, luv).r > 0.0) near = true;
    }
  }
  if (near) {
    float ta = max(hills.x, 0.0);
    float tb = min(hills.y, tGround);
    const int N = 48;
    float dt = (tb - ta) / float(N);
    float prev = ta;
    for (int i = 1; i <= N; i++) {
      float t = ta + dt * float(i);
      vec3 p = o + d * t;
      if (length(p) - R < landAt(llOf(p))) {
        float lo = prev;
        float hi = t;
        for (int k = 0; k < 6; k++) {
          float mid = (lo + hi) * 0.5;
          vec3 q = o + d * mid;
          if (length(q) - R < landAt(llOf(q))) hi = mid;
          else lo = mid;
        }
        tGround = hi;
        land = landAt(llOf(o + d * hi)) > 0.0005 * uExag;
        break;
      }
      prev = t;
    }
  }
  float topM = topMax();
  vec2 shell = sphere(o, d, R + topM);

  vec3 col = vec3(0.0);
  float trans = 1.0;
  float tSum = 0.0;
  float wSum = 0.0;
  float t0 = max(shell.x, 0.0);
  float t1 = min(shell.y, tGround);
  if (uMode == 0 && uClouds > 0.5 && t1 > t0) {
    int n = uSteps;
    float dt = (t1 - t0) / float(n);
    float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))) + uSeed * 0.618);
    float t = t0 + dt * jitter;
    float cosD = dot(d, uSun);
    // Two lobes (forward, a little back) and the light scattered again and again, each time
    // spread wider and dimmed less (Wrenninge's octaves)
    for (int i = 0; i < 1024; i++) {
      if (t > t1 || trans < 0.01) break;
      vec3 p = o + d * t;
      // Clear air over every cloud near here: stride down to their tops (or a block on)
      vec3 up0 = p / length(p);
      float h = (length(p) - R) / uExag;
      float reach;
      float cap = topNear(llOf(p), reach);
      if (h > cap + 0.3) {
        float down = -dot(d, up0);
        float jump = down > 0.0 ? (h - cap - 0.15) * uExag / down : reach;
        t += clamp(jump, dt, reach);
        continue;
      }
      float hf;
      float tb;
      float dens = fineDensity(p, hf, tb);
      if (dens > 0.0) {
        float sigma = dens * uSigma;
        vec3 up = normalize(p);
        float cosZ = dot(up, uSun);
        float hReal = (length(p) - R) / uExag;
        vec3 sun = SUN * sunThrough(hReal, cosZ);
        float tauSun = 0.0;
        if (dot(sun, sun) > 1e-6) {
          // Near, with the detail (the puffs shade one another); beyond, pass 2's (or, outside
          // its grid, a few steps through the clouds without their detail)
          for (int k = 1; k <= NEAR; k++) {
            float s0 = topM * 0.004 * float((k - 1) * (k - 1));
            float s1 = topM * 0.004 * float(k * k);
            tauSun += fineDensity(p + uSun * (s0 + s1) * 0.5) * uSigma * (s1 - s0);
          }
          float baked;
          if (bakedTau(p + uSun * topM * 0.004 * float(NEAR * NEAR), baked)) {
            tauSun += baked;
          } else {
            for (int k = NEAR + 1; k <= 6; k++) {
              float s0 = topM * 0.004 * float((k - 1) * (k - 1));
              float s1 = topM * 0.004 * float(k * k);
              tauSun += coarseDensity(p + uSun * (s0 + s1) * 0.5) * uSigma * (s1 - s0);
            }
          }
        }
        vec3 lit = vec3(0.0);
        float a = 1.0;
        float b = 1.0;
        float c = 1.0;
        for (int o2 = 0; o2 < 3; o2++) {
          float ph = mix(hg(cosD, 0.7 * c), hg(cosD, -0.25 * c), 0.35);
          lit += sun * a * ph * exp(-tauSun * b);
          a *= 0.5;
          b *= 0.35;
          c *= 0.5;
        }
        // (darker where the light only skims in: the powder effect)
        lit *= 1.0 - 0.6 * exp(-sigma * 3.0);
        // (and in the dark, a faint light of their own, as the sea's color has: else on the
        // night side they'd be black holes in it)
        vec3 amb = skyLight(p) * mix(0.2, 1.0, hf) * 0.25 + vec3(0.4, 0.42, 0.48) * uGlow * mix(0.55, 1.0, hf);
        vec3 emit = (lit + amb) * mix(0.8, 1.0, smoothstep(285.0, 210.0, tb));
        float alpha = 1.0 - exp(-sigma * dt);
        col += trans * emit * alpha;
        tSum += t * trans * alpha;
        wSum += trans * alpha;
        trans *= 1.0 - alpha;
      }
      t += dt;
    }
  }

  // The air in front of the clouds and behind them, and the sea or space beyond
  float tEnd = tGround < 1e19 ? tGround : 1e6;
  if (uMode == 0) {
    fragColor = vec4(col, trans);
    fragDepth = vec4(wSum > 1e-4 ? tSum / wSum : tEnd);
    return;
  }
  vec2 cuv = gl_FragCoord.xy / uViewport;
  vec4 cloud = texture(uCloud, cuv);
  col = cloud.rgb;
  trans = cloud.a;
  float tc = min(texture(uCloudDepth, cuv).r, tEnd);
  vec3 tFront;
  vec3 tBack;
  vec3 front = airBetween(o, d, 0.0, tc, tFront);
  vec3 back = airBetween(o, d, tc, tEnd, tBack);
  vec3 beyond = tGround < 1e19 ? groundColor(o + d * tGround, d, land) : vec3(0.0);
  vec3 L = front + tFront * (col + trans * (back + tBack * beyond));
  fragColor = vec4(L, 1.0);
}
