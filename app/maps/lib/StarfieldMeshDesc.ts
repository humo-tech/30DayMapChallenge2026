// A texture-free starfield for Navara. The built-in `stars` shades stars through the
// atmosphere and so loads the same ~8 MB of scattering textures as the photoreal sky.
// Here stars are just random directions drawn at infinity, behind everything else.
import { MeshDesc, type MeshConfig, type MeshUpdate } from '@navaramap/three'
import { BufferGeometry, Float32BufferAttribute, Points, ShaderMaterial } from 'three'

type StarfieldOptions = {
  /** Number of stars. Default: 3000 */
  count?: number
  /** Largest star size in CSS px. Default: 2 */
  size?: number
}
type Description = { starfield?: StarfieldOptions }
export type StarfieldConfig = MeshConfig & Description
type StarfieldUpdate = MeshUpdate & Description

const vertexShader = /* glsl */ `
  attribute float brightness;
  uniform float uSize;
  uniform float uPixelRatio;
  varying float vBrightness;
  void main() {
    // w = 0 puts the star at infinity in its direction (rotation only, no translation);
    // z = w pins it to the far plane so the globe and everything else draw over it
    vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 0.0);
    p.z = p.w;
    gl_Position = p;
    gl_PointSize = max(1.0, uSize * brightness) * uPixelRatio;
    vBrightness = brightness;
  }
`

const fragmentShader = /* glsl */ `
  varying float vBrightness;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.0, d) * vBrightness;
    gl_FragColor = vec4(vec3(0.85, 0.9, 1.0) * a, a);
  }
`

export class StarfieldMeshDesc extends MeshDesc<StarfieldConfig, StarfieldUpdate, Points<BufferGeometry, ShaderMaterial>> {
  private config: StarfieldConfig

  constructor(...args: ConstructorParameters<typeof MeshDesc<StarfieldConfig, StarfieldUpdate>>) {
    super(...args)
    this.config = args[2] ?? {}
  }

  override createMesh() {
    const { count = 3000, size = 2 } = this.config.starfield ?? {}
    const positions = new Float32Array(count * 3)
    const brightness = new Float32Array(count)
    for (let i = 0; i < count; i++) {
      // Uniform on the sphere
      const z = Math.random() * 2 - 1
      const t = Math.random() * Math.PI * 2
      const r = Math.sqrt(1 - z * z)
      positions.set([r * Math.cos(t), r * Math.sin(t), z], i * 3)
      // Mostly faint, a few bright ones
      brightness[i] = 0.15 + 0.85 * Math.pow(Math.random(), 4)
    }
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
    geometry.setAttribute('brightness', new Float32BufferAttribute(brightness, 1))

    const material = new ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: { uSize: { value: size }, uPixelRatio: { value: window.devicePixelRatio } },
      transparent: true,
      depthWrite: false,
    })
    const points = new Points(geometry, material)
    points.frustumCulled = false // positions are directions, not world coordinates
    return points
  }
}
