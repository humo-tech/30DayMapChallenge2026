// Mt. Fuji's summit crater as a surface draped with its aerial photo, for Navara: the survey's
// 0.5 m DEM, every 4 m, under its 0.4 m photo (scripts/day14/extract_crater.py). It comes in
// and goes out as a front sweeping out from the crater floor, ragged with noise: shown where
// the front has passed `assemble` and not yet `dissolve`.
//
// Vertices are in the crater's West-Up-North frame: place the mesh with `geodetic` at its origin.
import { MeshDesc, setupMaterialForMRT, type MeshConfig, type MeshUpdate } from '@navaramap/three'
import { BufferGeometry, Float32BufferAttribute, Mesh, ShaderMaterial, SRGBColorSpace, Texture, Uint32BufferAttribute } from 'three'
import { craterFront } from './craterFront'

type CraterSurfaceOptions = {
  /** Grid vertices, xyz interleaved, in metres (West-Up-North), rows north to south */
  vertices: Float32Array
  cols: number
  rows: number
  /** The aerial photo over the grid's extent, north up */
  photo: Texture
  /** Lift (m) over the ground, so the GSI terrain under it doesn't show through. Default: 3 */
  lift?: number
}
type Description = { craterSurface?: CraterSurfaceOptions }
export type CraterSurfaceConfig = MeshConfig & Description
type CraterSurfaceUpdate = MeshUpdate & Description

const vertexShader = /* glsl */ `
  uniform float uLift;
  varying vec2 vUv;
  varying vec3 vLocal;
  varying vec3 vNormal;
  void main() {
    vUv = uv;
    vLocal = position;
    vNormal = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position + vec3(0.0, uLift, 0.0), 1.0);
  }
`

// setupMaterialForMRT appends the G-buffer writes before main()'s closing brace: keep main() last
const fragmentShader = /* glsl */ `
  uniform sampler2D uPhoto;
  uniform float uAssemble;
  uniform float uDissolve;
  varying vec2 vUv;
  varying vec3 vLocal;
  varying vec3 vNormal;
  ${craterFront}
  void main() {
    vec3 normal = vNormal; // read by the G-buffer write appended below
    float f = craterFront(vLocal);
    if (f > uAssemble || f < uDissolve) discard;
    // (the photo decodes from sRGB as it's sampled: the view composes in linear)
    gl_FragColor = vec4(texture2D(uPhoto, vUv).rgb, 1.0);
  }
`

export class CraterSurfaceMeshDesc extends MeshDesc<CraterSurfaceConfig, CraterSurfaceUpdate, Mesh<BufferGeometry, ShaderMaterial>> {
  private config: CraterSurfaceConfig
  private material?: ShaderMaterial

  constructor(...args: ConstructorParameters<typeof MeshDesc<CraterSurfaceConfig, CraterSurfaceUpdate>>) {
    super(...args)
    this.config = args[2] ?? {}
  }

  override createMesh() {
    const { vertices, cols, rows, photo, lift = 3 } = this.config.craterSurface!
    const uv = new Float32Array(cols * rows * 2)
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < cols; j++) uv.set([j / (cols - 1), 1 - i / (rows - 1)], (i * cols + j) * 2)
    }
    const index = new Uint32Array((cols - 1) * (rows - 1) * 6)
    let k = 0
    for (let i = 0; i < rows - 1; i++) {
      for (let j = 0; j < cols - 1; j++) {
        const a = i * cols + j
        index.set([a, a + cols, a + 1, a + 1, a + cols, a + cols + 1], k)
        k += 6
      }
    }
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new Float32BufferAttribute(vertices, 3))
    geometry.setAttribute('uv', new Float32BufferAttribute(uv, 2))
    geometry.setIndex(new Uint32BufferAttribute(index, 1))
    geometry.computeVertexNormals()

    photo.colorSpace = SRGBColorSpace
    photo.anisotropy = 8
    photo.needsUpdate = true
    const material = new ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        uPhoto: { value: photo },
        uLift: { value: lift },
        uAssemble: { value: -1 },
        uDissolve: { value: -1 },
      },
    })
    setupMaterialForMRT(material)
    this.material = material

    const mesh = new Mesh(geometry, material)
    mesh.frustumCulled = false
    return mesh
  }

  /** Shows the surface where the crater's front (0 at the floor, ~1 at the edge) is between `dissolve` and `assemble`. */
  setFront(assemble: number, dissolve: number): void {
    const u = this.material?.uniforms
    if (!u) return
    u.uAssemble!.value = assemble
    u.uDissolve!.value = dissolve
    this.raw!.visible = assemble > -0.5 && dissolve < 1.5
  }

  override onDestroy(): void {
    const mesh = this.raw
    super.onDestroy()
    mesh?.geometry.dispose()
    this.material?.dispose()
  }
}
