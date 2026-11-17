// Mt. Fuji as a surface of its own, draped with its aerial photo, for Navara: GSI's DEM at z12
// inside the outline of its foot (scripts/day18/null_fuji.py), over a terrain that has had the
// mountain taken out. It goes with `setPresence`: pixels drop out in a scatter as it falls from 1
// to 0, so the mountain is gone in a moment, and the ground under it shows through.
//
// Vertices are in the mountain's West-Up-North frame: place the mesh with `geodetic` at its origin.
import { MeshDesc, setupMaterialForMRT, type MeshConfig, type MeshUpdate } from '@navaramap/three'
import { BufferGeometry, Float32BufferAttribute, Mesh, ShaderMaterial, SRGBColorSpace, Texture, Uint32BufferAttribute } from 'three'

type FujiMountainOptions = {
  /** Grid vertices, xyz interleaved, in metres (West-Up-North), rows north to south */
  vertices: Float32Array
  /** Which grid vertices are on the mountain (1) and which aren't (0) */
  inside: Uint8Array
  cols: number
  rows: number
  /** The aerial photo over the grid's extent, north up */
  photo: Texture
}
type Description = { fujiMountain?: FujiMountainOptions }
export type FujiMountainConfig = MeshConfig & Description
type FujiMountainUpdate = MeshUpdate & Description

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormal;
  void main() {
    vUv = uv;
    vNormal = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

// setupMaterialForMRT appends the G-buffer writes before main()'s closing brace: keep main() last
const fragmentShader = /* glsl */ `
  uniform sampler2D uPhoto;
  uniform float uPresence;
  varying vec2 vUv;
  varying vec3 vNormal;
  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
  }
  void main() {
    vec3 normal = vNormal; // read by the G-buffer write appended below
    // Each screen pixel has its own threshold: as the presence falls, more of them drop out
    if (hash(floor(gl_FragCoord.xy)) >= uPresence) discard;
    // (the photo decodes from sRGB as it's sampled: the view composes in linear)
    gl_FragColor = vec4(texture2D(uPhoto, vUv).rgb, 1.0);
  }
`

export class FujiMountainMeshDesc extends MeshDesc<FujiMountainConfig, FujiMountainUpdate, Mesh<BufferGeometry, ShaderMaterial>> {
  private config: FujiMountainConfig
  private material?: ShaderMaterial

  constructor(...args: ConstructorParameters<typeof MeshDesc<FujiMountainConfig, FujiMountainUpdate>>) {
    super(...args)
    this.config = args[2] ?? {}
  }

  override createMesh() {
    const { vertices, inside, cols, rows, photo } = this.config.fujiMountain!
    const uv = new Float32Array(cols * rows * 2)
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < cols; j++) uv.set([(j + 0.5) / cols, 1 - (i + 0.5) / rows], (i * cols + j) * 2)
    }
    // Only the quads with all four corners on the mountain
    const quads: number[] = []
    for (let i = 0; i < rows - 1; i++) {
      for (let j = 0; j < cols - 1; j++) {
        const a = i * cols + j
        if (inside[a] && inside[a + 1] && inside[a + cols] && inside[a + cols + 1]) quads.push(a)
      }
    }
    const index = new Uint32Array(quads.length * 6)
    quads.forEach((a, k) => index.set([a, a + cols, a + 1, a + 1, a + cols, a + cols + 1], k * 6))

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
      uniforms: { uPhoto: { value: photo }, uPresence: { value: 1 } },
    })
    setupMaterialForMRT(material)
    this.material = material

    const mesh = new Mesh(geometry, material)
    mesh.frustumCulled = false
    return mesh
  }

  /** 1: the whole mountain; 0: none of it */
  setPresence(presence: number): void {
    const u = this.material?.uniforms
    if (!u) return
    u.uPresence!.value = presence
    this.raw!.visible = presence > 0
  }

  override onDestroy(): void {
    const mesh = this.raw
    super.onDestroy()
    mesh?.geometry.dispose()
    this.material?.dispose()
  }
}
