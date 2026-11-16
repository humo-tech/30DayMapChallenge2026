// Shared by the arc shaders (ArcGlowMeshDesc): where an arc is at `t` (0 at the home, 1 at
// the finish), and how far along its run the runner is at `uTime`.
uniform float uTime;
attribute vec3 aFrom; // ECEF (m)
attribute vec3 aTo;
// x: angle between the ends (rad, worked out in double on the CPU), y: peak height (m)
attribute vec2 aArc;
// x: start offset, y: run time, z: rest after it (s)
attribute vec3 aTiming;
// When the home shows (rank), against how many show now; how far the arcs have grown (0-1)
attribute float aRank;
uniform float uRevealed;
uniform float uGrow;

// Lift (m), so the ends clear the land draped on the ellipsoid
const float LIFT = 500.0;

vec3 arcPoint(float t) {
  float ra = length(aFrom);
  float rb = length(aTo);
  float omega = aArc.x;
  // Slerp between the ends' directions, the radius eased from one end's to the other's so
  // both ends sit exactly on the ellipsoid, lifted on a sine
  vec3 dir = omega < 1e-7
    ? aFrom / ra
    : (sin((1.0 - t) * omega) * (aFrom / ra) + sin(t * omega) * (aTo / rb)) / sin(omega);
  return dir * (mix(ra, rb, t) + LIFT + aArc.y * sin(3.14159265 * t));
}

// Progress through the current run, 0-1; past 1 the runner is resting at the finish
float runProgress() {
  float cycle = aTiming.y + aTiming.z;
  return mod(uTime - aTiming.x, cycle) / aTiming.y;
}

// easeOutCubic: off the line fast, easing into the finish
float ease(float u) {
  float v = 1.0 - u;
  return 1.0 - v * v * v;
}
float easeSpeed(float u) {
  float v = 1.0 - u;
  return 3.0 * v * v;
}
