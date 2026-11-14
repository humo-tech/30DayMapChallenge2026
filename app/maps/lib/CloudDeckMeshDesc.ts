// A sea of clouds for Navara: a flat disc under the summit in the sky's horizon color, so that
// past it the world below is gone and the sky runs on seamlessly beneath the horizon. Raised
// while the mountain sinks, it swallows the mountain on its way down.
//
// The disc lies in a West-Up-North frame: place the mesh with `geodetic` and set its height
// (m, in the frame) as it runs.
import { MeshDesc, setupMaterialForMRT, type MeshConfig, type MeshUpdate } from '@navaramap/three'
import { CircleGeometry, Color, Mesh, ShaderMaterial } from 'three'

type CloudDeckOptions = {
  /** The disc's radius (m). Default: 80 km */
  radius?: number
}
type Description = { cloudDeck?: CloudDeckOptions }
export type CloudDeckConfig = MeshConfig & Description
type CloudDeckUpdate = MeshUpdate & Description

const vertexShader = /* glsl */ `
  void main() {
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

// setupMaterialForMRT appends the G-buffer writes before main()'s closing brace: keep main() last
const fragmentShader = /* glsl */ `
  uniform vec3 uColor;
  void main() {
    vec3 normal = vec3(0.0, 1.0, 0.0); // read by the G-buffer write appended below
    gl_FragColor = vec4(uColor, 1.0);
  }
`

export class CloudDeckMeshDesc extends MeshDesc<CloudDeckConfig, CloudDeckUpdate, Mesh<CircleGeometry, ShaderMaterial>> {
  private config: CloudDeckConfig
  private material?: ShaderMaterial

  constructor(...args: ConstructorParameters<typeof MeshDesc<CloudDeckConfig, CloudDeckUpdate>>) {
    super(...args)
    this.config = args[2] ?? {}
  }

  override createMesh() {
    const { radius = 80_000 } = this.config.cloudDeck ?? {}
    // Lying flat, facing up
    const geometry = new CircleGeometry(radius, 96).rotateX(-Math.PI / 2)
    const material = new ShaderMaterial({ vertexShader, fragmentShader, uniforms: { uColor: { value: new Color() } } })
    setupMaterialForMRT(material)
    this.material = material
    const mesh = new Mesh(geometry, material)
    mesh.frustumCulled = false
    return mesh
  }

  /** Puts the deck `height` m above the frame's origin, in `color` (linear); hidden when `show` is false. */
  set(height: number, color: Color, show: boolean): void {
    const mesh = this.raw
    if (!mesh) return
    mesh.position.y = height
    mesh.visible = show
    ;(this.material?.uniforms.uColor!.value as Color | undefined)?.copy(color)
  }

  override onDestroy(): void {
    const mesh = this.raw
    super.onDestroy()
    mesh?.geometry.dispose()
    this.material?.dispose()
  }
}
