// Rail lines (RailGlowMeshDesc): the base glow plus a comet tail behind the route's pulse.
// ROUTE_COUNT is defined by RailGlowMeshDesc. setupMaterialForMRT appends the G-buffer
// writes before main()'s closing brace, so keep main() last.
uniform vec3 uColor;
uniform vec3 uPulseColor;
// Per route: (pulse distance along the route, tail length), both in m; tail 0 = at rest
uniform vec2 uPulses[ROUTE_COUNT];
varying float vDist;
varying float vRoute;
void main() {
  vec3 normal = vec3(0.0, 0.0, 1.0); // read by the G-buffer write appended below
  vec2 pulse = uPulses[int(vRoute + 0.5)];
  // How far this fragment trails the pulse
  float behind = pulse.x - vDist;
  float k = behind >= 0.0 && behind < pulse.y ? pow(1.0 - behind / pulse.y, 2.0) : 0.0;
  gl_FragColor = vec4(uColor * 0.55 + mix(uColor, uPulseColor, k) * k * 2.5, 1.0);
}
