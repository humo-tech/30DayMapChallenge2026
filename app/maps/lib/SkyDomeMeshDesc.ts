// A plain sky for Navara: a gradient from the horizon up to the zenith, drawn at infinity behind
// everything else (like StarfieldMeshDesc), with colors that can change as it runs. Placed with
// `geodetic`, so its zenith is that place's up.
import { MeshDesc, type MeshConfig, type MeshUpdate } from '@navaramap/three'
import { BackSide, Color, Mesh, ShaderMaterial, SphereGeometry } from 'three'

type Description = { skyDome?: Record<string, never> }
export type SkyDomeConfig = MeshConfig & Description
type SkyDomeUpdate = MeshUpdate & Description

const vertexShader = /* glsl */ `
  varying float vUp;
  void main() {
    vUp = normalize(position).y;
    // w = 0: rotation only, so the dome sits at infinity round the camera; z = w pins it to the far plane
    vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * mat3(modelMatrix) * position, 0.0);
    p.z = p.w;
    gl_Position = p;
  }
`

const fragmentShader = /* glsl */ `
  uniform vec3 uHorizon;
  uniform vec3 uZenith;
  varying float vUp;
  void main() {
    gl_FragColor = vec4(mix(uHorizon, uZenith, pow(clamp(vUp, 0.0, 1.0), 0.6)), 1.0);
  }
`

export class SkyDomeMeshDesc extends MeshDesc<SkyDomeConfig, SkyDomeUpdate, Mesh<SphereGeometry, ShaderMaterial>> {
  private material?: ShaderMaterial

  override createMesh() {
    const material = new ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: { uHorizon: { value: new Color() }, uZenith: { value: new Color() } },
      side: BackSide,
      depthWrite: false,
      transparent: true,
    })
    this.material = material
    const mesh = new Mesh(new SphereGeometry(1, 48, 24), material)
    mesh.frustumCulled = false
    mesh.renderOrder = -1
    return mesh
  }

  /** Sets the sky's colors (linear). */
  setColors(horizon: Color, zenith: Color): void {
    const u = this.material?.uniforms
    ;(u?.uHorizon!.value as Color | undefined)?.copy(horizon)
    ;(u?.uZenith!.value as Color | undefined)?.copy(zenith)
  }

  override onDestroy(): void {
    const mesh = this.raw
    super.onDestroy()
    mesh?.geometry.dispose()
    this.material?.dispose()
  }
}
