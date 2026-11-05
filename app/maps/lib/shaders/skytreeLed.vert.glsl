// LEDs (SkytreeLedsMeshDesc): one point sprite per LED, sized in metres so they shrink with
// distance, and lit by a twinkle of their own plus the band of light sweeping up the tower.
// Above the wipe's height the LED takes the next lighting's color.
attribute float aSeed;
uniform float uTime;
uniform float uSweep;
uniform float uSweepWidth;
uniform float uWipe;
uniform float uSize;
uniform float uMinPx;
uniform float uMaxPx;
uniform float uPixelRatio;
uniform float uHalfHeight;
varying float vGlow;
varying float vSpark;
varying float vNext;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;

  // Twinkle: each LED pulses at its own rate, sharpened so it mostly rests dim
  float rate = 0.6 + fract(aSeed * 7.31) * 1.6;
  float tw = pow(0.5 + 0.5 * sin(uTime * rate * 6.2832 + aSeed * 40.0), 6.0);
  // The sweep: a soft band centred at uSweep (m), with a fading trail below it
  float dh = position.y - uSweep;
  float band = uSweep < 0.0 ? 0.0 : exp(-dh * dh / (uSweepWidth * uSweepWidth));
  float trail = uSweep >= 0.0 && dh < 0.0 ? exp(dh / (uSweepWidth * 6.0)) * 0.35 : 0.0;
  // The wipe's edge flashes as it passes
  float dw = position.y - uWipe;
  float edge = exp(-dw * dw / (uSweepWidth * uSweepWidth * 0.5));
  vGlow = 0.25 + 0.75 * tw + max(band, trail) * 3.0 + edge * 2.0;
  vSpark = max(band, edge);
  vNext = step(uWipe, position.y);

  // Metres -> CSS px: projectionMatrix[1][1] = cot(fov / 2), the half viewport height (px) a
  // metre spans 1 m away. The band swells the LEDs it passes
  float px = uSize * projectionMatrix[1][1] * uHalfHeight / max(-mv.z, 1.0);
  gl_PointSize = clamp(px, uMinPx, uMaxPx) * (1.0 + vSpark) * uPixelRatio;
}
