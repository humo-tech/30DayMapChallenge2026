// Shared by the flow shaders (FlowArcsMeshDesc), after three's <common>: where a flow's arc is,
// how lit it is at the clock's time, and where its bead is along it.
attribute vec3 aFrom; // relative to the anchor (m)
attribute vec3 aTo;
attribute vec2 aFlow; // x: hour of leaving, y: expected bikes
attribute vec2 aRows; // each end's row in uDocked
attribute float aSeed; // 0-1, the bead's timing
uniform sampler2D uDocked; // bikes in docks per station per 5 minutes (/255)
uniform float uMeters; // column height per bike, 0 for none
uniform float uClock; // hours, JST
uniform float uTime; // s, for the beads
uniform float uFade; // hours to fade to 1/e after the hour
uniform vec3 uUp;

// Clear of the column tops, and the arc's peak: a fifth of its length, at most this
const float LIFT = 15.0;
const float MAX_PEAK = 600.0;

// Each end's column top (m) at the clock's time, as StationColumnsMeshDesc draws it
float fromTop;
float toTop;
float columnTop(float row) {
  if (uMeters == 0.0) return 0.0;
  float slot = clamp(uClock * 12.0, 0.0, 287.0);
  return texture2D(uDocked, vec2((slot + 0.5) / 288.0, row)).r * 255.0 * uMeters + 2.0;
}
void setTops() {
  fromTop = columnTop(aRows.x);
  toTop = columnTop(aRows.y);
}

vec3 arcPoint(float t) {
  vec3 d = aTo - aFrom;
  float base = mix(fromTop, toTop, t);
  return aFrom + d * t + uUp * (base + LIFT + min(0.2 * length(d), MAX_PEAK) * sin(PI * t));
}

// Expected bikes, brightening through the flow's hour (leaving) and fading over the next ones
float flowLit() {
  float x = uClock - aFlow.x;
  return aFlow.y * (x < 1.0 ? smoothstep(0.0, 1.0, x) : exp(-(x - 1.0) / uFade));
}

// The bead, as Day 2's pulses: off the start fast, braking into the end, then a rest before the
// next run (longer runs for longer arcs). x: how far along (0-1), or -1 while resting; y: its
// speed (arc lengths per s), for the tail
vec2 bead() {
  float run = 1.2 + 0.45 * sqrt(length(aTo - aFrom) / 1000.0);
  float cycle = run + 0.4 + 1.4 * aSeed;
  float u = mod(uTime + aSeed * 37.0, cycle) / run;
  if (u > 1.0) return vec2(-1.0, 0.0);
  float v = 1.0 - u;
  return vec2(1.0 - v * v * v, 3.0 * v * v / run);
}
