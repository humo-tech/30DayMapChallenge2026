// A light-weight atmosphere for Navara: a soft glow along the globe's limb, brightest at the
// surface and fading out exponentially into space. Unlike the photoreal sky it needs no
// precomputed scattering textures (~8 MB), and unlike `glowGlobe` it fades outward.
import { Color, MeshDesc, getWGS84SemiMajorAxis, type MeshConfig, type MeshUpdate } from '@navaramap/three'
import { AdditiveBlending, BackSide, Mesh, ShaderMaterial, SphereGeometry, Vector3 } from 'three'

type LimbGlowOptions = {
  /** Glow color. Default: soft blue */
  color?: Color
  /** Peak opacity at the surface, 0-1. Default: 0.8 */
  intensity?: number
  /** Altitude (m) over which the glow falls to 1/e. Default: 80 km */
  scaleHeight?: number
}
type Description = { limbGlow?: LimbGlowOptions }
export type LimbGlowConfig = MeshConfig & Description
type LimbGlowUpdate = MeshUpdate & Description

const DEFAULTS = { color: new Color().setStyle('#6f9bff'), intensity: 0.8, scaleHeight: 80_000 }

const vertexShader = /* glsl */ `
  varying vec3 vPos;
  varying vec3 vCenter;
  void main() {
    // View space: the camera sits at the origin whatever origin shift the engine applies
    vec4 p = modelViewMatrix * vec4(position, 1.0);
    vPos = p.xyz;
    vCenter = (modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
    gl_Position = projectionMatrix * p;
  }
`

const fragmentShader = /* glsl */ `
  uniform vec3 uColor;
  uniform float uIntensity;
  uniform float uRadius;
  uniform float uScaleHeight;
  varying vec3 vPos;
  varying vec3 vCenter;
  void main() {
    // Lowest altitude the view ray reaches: its closest approach to the earth's center
    vec3 dir = normalize(vPos);
    float h = length(vCenter - dot(vCenter, dir) * dir) - uRadius;
    float a = exp(-max(h, 0.0) / uScaleHeight) * uIntensity;
    gl_FragColor = vec4(uColor * a, a);
  }
`

export class LimbGlowMeshDesc extends MeshDesc<LimbGlowConfig, LimbGlowUpdate, Mesh<SphereGeometry, ShaderMaterial>> {
  private config: LimbGlowConfig

  constructor(...args: ConstructorParameters<typeof MeshDesc<LimbGlowConfig, LimbGlowUpdate>>) {
    super(...args)
    this.config = args[2] ?? {}
  }

  override createMesh() {
    const cfg = { ...DEFAULTS, ...this.config.limbGlow }
    const radius = getWGS84SemiMajorAxis()
    // Shell thick enough that the glow has faded to ~0 at its outer edge
    const geometry = new SphereGeometry(radius + cfg.scaleHeight * 8, 128, 64)
    const material = new ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        uColor: { value: new Vector3(...cfg.color.toArray()) },
        uIntensity: { value: cfg.intensity },
        uRadius: { value: radius },
        uScaleHeight: { value: cfg.scaleHeight },
      },
      // Back faces only: the half of the shell behind the globe is hidden by its depth,
      // so the glow shows just beyond the limb
      side: BackSide,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    })
    return new Mesh(geometry, material)
  }

  override onUpdateConfig(updates: LimbGlowUpdate): void {
    const cfg = updates.limbGlow
    const uniforms = this._instance?.material.uniforms
    if (cfg && uniforms) {
      if (cfg.color) uniforms.uColor!.value = new Vector3(...cfg.color.toArray())
      if (cfg.intensity !== undefined) uniforms.uIntensity!.value = cfg.intensity
      if (cfg.scaleHeight !== undefined) uniforms.uScaleHeight!.value = cfg.scaleHeight
      this.config = { ...this.config, limbGlow: { ...this.config.limbGlow, ...cfg } }
      this.emit('needsUpdate')
    }
    super.onUpdateConfig(updates)
  }
}
