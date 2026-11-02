// Pulses (RailGlowMeshDesc): one point sprite per route, sized by its speed (aScale).
attribute float aAlpha;
attribute float aScale;
uniform float uSize;
uniform float uPixelRatio;
varying float vAlpha;
void main() {
  vAlpha = aAlpha;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = uSize * aScale * uPixelRatio;
}
