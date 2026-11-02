// Rail lines (RailGlowMeshDesc): passes each vertex's distance along its route and its
// route index on to the fragment shader.
attribute float aDist;
attribute float aRoute; // route index
varying float vDist;
varying float vRoute;
void main() {
  vDist = aDist;
  vRoute = aRoute;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
