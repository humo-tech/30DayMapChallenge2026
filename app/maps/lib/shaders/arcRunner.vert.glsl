// Runners (ArcGlowMeshDesc): one point sprite per arc, riding it; with HOME defined, a small
// fixed dot at each home instead. arcPoint.glsl is prepended.
attribute vec3 aColor;
uniform float uSize;
uniform float uSizeScale;
uniform float uPixelRatio;
varying float vAlpha;
varying vec3 vColor;
void main() {
  vColor = aColor;
#ifdef HOME
  vAlpha = aRank < floor(uRevealed) ? 0.55 : 0.0;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(arcPoint(0.0), 1.0);
  gl_PointSize = uSize * uSizeScale * uPixelRatio;
#else
  float u = runProgress();
  // Snap in at the home; fade out over the last part, where the runner has all but stopped
  vAlpha = u > 1.0 || uGrow < 1.0 ? 0.0 : min(1.0, min(u / 0.02, (1.0 - u) / 0.25));
  gl_Position = projectionMatrix * modelViewMatrix * vec4(arcPoint(ease(min(u, 1.0))), 1.0);
  gl_PointSize = uSize * uSizeScale * (0.4 + 0.6 * sqrt(easeSpeed(min(u, 1.0)) / 3.0)) * uPixelRatio;
#endif
}
