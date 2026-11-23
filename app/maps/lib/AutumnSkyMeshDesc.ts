// A clear autumn sky for Navara, behind the globe: deep blue overhead fading to a pale haze at the
// horizon, with thin wisps of high cloud (cirrus) drawn across it. Drawn at infinity behind
// everything else (like SkyDomeMeshDesc), placed with `geodetic` so its zenith is that place's up.
//
// Seen from high above, the Earth's rim sits well below the level: `dip` (radians) moves the pale
// horizon down to it, so the haze hugs the globe's edge, and the blue comes in over `span` above it.
import { MeshDesc, type MeshConfig, type MeshUpdate } from '@navaramap/three'
import { BackSide, Color, Mesh, ShaderMaterial, SphereGeometry } from 'three'

type AutumnSkyOptions = {
  /** Linear colours */
  horizon: Color
  zenith: Color
  cloud: Color
  /** How far below the level the rim of the Earth is (radians) */
  dip?: number
  /** Angle above the rim (radians) over which the haze turns to full blue */
  span?: number
  /** Peak cloud opacity, 0-1 */
  cloudiness?: number
}
type Description = { autumnSky?: AutumnSkyOptions }
export type AutumnSkyConfig = MeshConfig & Description
type AutumnSkyUpdate = MeshUpdate & Description

const vertexShader = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    // w = 0: rotation only, so the dome sits at infinity round the camera; z = w pins it to the far plane
    vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * mat3(modelMatrix) * position, 0.0);
    p.z = p.w;
    gl_Position = p;
  }
`

const fragmentShader = /* glsl */ `
  uniform vec3 uHorizon;
  uniform vec3 uZenith;
  uniform vec3 uCloud;
  uniform float uDip;
  uniform float uSpan;
  uniform float uCloudiness;
  varying vec3 vDir;

  float hash(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float noise(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
      mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y),
      f.z);
  }
  float fbm(vec3 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 5; i++) {
      v += a * noise(p);
      p = p * 2.03 + vec3(1.7, 9.2, 3.1);
      a *= 0.5;
    }
    return v;
  }

  void main() {
    vec3 d = normalize(vDir);
    // Angle above the Earth's rim, over the span in which the haze turns to full blue (from high
    // up only a strip of sky shows over the rim, so the blue has to come in quickly)
    float h = clamp((asin(clamp(d.y, -1.0, 1.0)) + uDip) / uSpan, 0.0, 1.0);
    vec3 sky = mix(uHorizon, uZenith, pow(h, 0.55));

    // Cirrus: noise stretched flat (long, thin streaks lying along the sky), bent by a slower warp,
    // thinning out toward the rim and the zenith
    vec3 q = d * vec3(2.2, 18.0, 2.2);
    q.xz += vec2(fbm(d * 3.0), fbm(d * 3.0 + 5.2)) * 1.6;
    float wisp = smoothstep(0.52, 0.8, fbm(q));
    float band = smoothstep(0.04, 0.3, h);
    gl_FragColor = vec4(mix(sky, uCloud, wisp * band * uCloudiness), 1.0);
  }
`

export class AutumnSkyMeshDesc extends MeshDesc<AutumnSkyConfig, AutumnSkyUpdate, Mesh<SphereGeometry, ShaderMaterial>> {
  private config: AutumnSkyConfig
  private material?: ShaderMaterial

  constructor(...args: ConstructorParameters<typeof MeshDesc<AutumnSkyConfig, AutumnSkyUpdate>>) {
    super(...args)
    this.config = args[2] ?? {}
  }

  override createMesh() {
    const { horizon, zenith, cloud, dip = 0, span = 0.4, cloudiness = 0.6 } = this.config.autumnSky!
    const material = new ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        uHorizon: { value: horizon },
        uZenith: { value: zenith },
        uCloud: { value: cloud },
        uDip: { value: dip },
        uSpan: { value: span },
        uCloudiness: { value: cloudiness },
      },
      side: BackSide,
      depthWrite: false,
      transparent: true,
    })
    this.material = material
    const mesh = new Mesh(new SphereGeometry(1, 64, 32), material)
    mesh.frustumCulled = false
    mesh.renderOrder = -1
    return mesh
  }

  override onDestroy(): void {
    const mesh = this.raw
    super.onDestroy()
    mesh?.geometry.dispose()
    this.material?.dispose()
  }
}
