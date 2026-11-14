// Falling snow, for Navara: flakes drifting down through a box, each at its own pace and sway,
// with a slow wind carrying them all. Sized in metres, so near flakes loom large and soft and
// far ones shrink to specks. The box either stays put (the crater filling with snow, seen from
// anywhere) or wraps round the camera (the flakes right in front of it, wherever it goes).
//
// Flakes are in a West-Up-North frame: place the mesh with `geodetic` at its origin.
import { MeshDesc, setupMaterialForMRT, type MeshConfig, type MeshUpdate } from '@navaramap/three'
import { BufferGeometry, Color, Float32BufferAttribute, Points, ShaderMaterial, Vector2, Vector3 } from 'three'

type SnowfallOptions = {
  /** Number of flakes. Default: 100000 */
  count?: number
  /** The box's size (m): across (west, north) and up. Default: 900 x 500 m */
  width?: number
  height?: number
  /** The box's lowest corner, in the frame (m). Ignored when following the camera */
  base?: [number, number, number]
  /** Wrap the box round the camera instead. Default: false */
  followCamera?: boolean
  /** Flake size (m): big, wet flakes. Default: 0.05 */
  size?: number
  /** Distance (m) the flakes fade out by. Default: 600 */
  far?: number
}
type Description = { snowfall?: SnowfallOptions }
export type SnowfallConfig = MeshConfig & Description
type SnowfallUpdate = MeshUpdate & Description

const vertexShader = /* glsl */ `
  attribute float aSeed;
  uniform float uTime;
  uniform vec3 uBox;
  uniform vec3 uBase;
  uniform vec3 uCamera;
  uniform float uFollow;
  uniform vec2 uWind;
  uniform float uDensity;
  uniform float uSize;
  uniform float uFar;
  uniform float uPixelRatio;
  uniform float uHalfHeight;
  varying float vAlpha;
  varying float vSoft;
  void main() {
    if (aSeed > uDensity) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      gl_PointSize = 0.0;
      return;
    }
    float s2 = fract(aSeed * 91.7);
    float s3 = fract(aSeed * 317.3);
    // About a metre a second, the larger flakes a little faster; each sways on its own circle
    float fall = 0.7 + 0.6 * s2;
    float sway = 0.4 + 1.2 * s3;
    float w = 0.5 + 0.9 * fract(aSeed * 53.1);
    vec3 p = position * uBox;
    p.y -= uTime * fall;
    p.x += sway * sin(uTime * w + aSeed * 40.0) + uWind.x * uTime;
    p.z += sway * cos(uTime * w * 0.83 + aSeed * 23.0) + uWind.y * uTime;
    // Wrap into the box: fixed, or centred on the camera
    vec3 lo = mix(uBase, uCamera - uBox * 0.5, uFollow);
    p = lo + mod(p - lo, uBox);

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    float dist = -mv.z;
    float size = uSize * (0.6 + 0.9 * s2);
    float px = size * projectionMatrix[1][1] * uHalfHeight / max(dist, 0.05);
    // Right at the lens they'd fill the screen: fade those, and the far ones into the air
    vAlpha = smoothstep(0.15, 0.8, dist) * (1.0 - smoothstep(uFar * 0.5, uFar, dist));
    // Under a pixel, a flake keeps its pixel but thins out instead
    vAlpha *= min(px, 1.0);
    vSoft = smoothstep(4.0, 30.0, px); // the near ones, out of focus
    gl_PointSize = clamp(px, 1.0, 48.0) * uPixelRatio;
  }
`

// setupMaterialForMRT appends the G-buffer writes before main()'s closing brace: keep main() last
const fragmentShader = /* glsl */ `
  uniform vec3 uColor;
  varying float vAlpha;
  varying float vSoft;
  void main() {
    vec3 normal = vec3(0.0, 0.0, 1.0); // read by the G-buffer write appended below
    float d = length(gl_PointCoord - 0.5) * 2.0;
    if (d > 1.0) discard;
    // A crisp flake far off, a soft disc up close
    float a = mix(1.0 - smoothstep(0.45, 1.0, d), (1.0 - d * d) * 0.45, vSoft) * vAlpha;
    gl_FragColor = vec4(uColor, a);
  }
`

const DEFAULTS = { count: 100_000, width: 900, height: 500, base: [-450, -20, -450] as [number, number, number], followCamera: false, size: 0.05, far: 600 }

export class SnowfallMeshDesc extends MeshDesc<SnowfallConfig, SnowfallUpdate, Points<BufferGeometry, ShaderMaterial>> {
  private config: SnowfallConfig
  private material?: ShaderMaterial
  private readonly camera = new Vector3()

  constructor(...args: ConstructorParameters<typeof MeshDesc<SnowfallConfig, SnowfallUpdate>>) {
    super(...args)
    this.config = args[2] ?? {}
  }

  private get options() {
    return { ...DEFAULTS, ...this.config.snowfall }
  }

  override createMesh() {
    const { count, width, height, base, followCamera, size, far } = this.options
    const positions = new Float32Array(count * 3)
    const seeds = new Float32Array(count)
    for (let i = 0; i < count; i++) {
      positions.set([Math.random(), Math.random(), Math.random()], i * 3)
      seeds[i] = Math.random()
    }
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
    geometry.setAttribute('aSeed', new Float32BufferAttribute(seeds, 1))

    const material = new ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        uTime: { value: 0 },
        uBox: { value: new Vector3(width, height, width) },
        uBase: { value: new Vector3(...base) },
        uCamera: { value: new Vector3() },
        uFollow: { value: followCamera ? 1 : 0 },
        uWind: { value: new Vector2(0.6, 0.25) },
        uDensity: { value: 0 },
        uSize: { value: size },
        uFar: { value: far },
        uColor: { value: new Color(0.9, 0.93, 1.0) },
        uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 3) },
        uHalfHeight: { value: window.innerHeight / 2 },
      },
      transparent: true,
      depthWrite: false,
    })
    setupMaterialForMRT(material)
    this.material = material

    const points = new Points(geometry, material)
    points.frustumCulled = false
    return points
  }

  /** Advances the snow to `time` (s), with `density` of the flakes falling (0-1) and the flakes' color dimmed by `light`. */
  tick(time: number, density: number, light = 1): void {
    const u = this.material?.uniforms
    const mesh = this.raw
    if (!u || !mesh) return
    u.uTime!.value = time
    u.uDensity!.value = density
    ;(u.uColor!.value as Color).setRGB(0.9 * light, 0.93 * light, light)
    u.uHalfHeight!.value = window.innerHeight / 2
    mesh.visible = density > 0
    // The camera, in the flakes' own frame
    mesh.updateWorldMatrix(true, false)
    this.camera.setFromMatrixPosition(this.view.camera.raw.matrixWorld)
    ;(u.uCamera!.value as Vector3).copy(mesh.worldToLocal(this.camera))
  }

  override onDestroy(): void {
    const mesh = this.raw
    super.onDestroy()
    mesh?.geometry.dispose()
    this.material?.dispose()
  }
}
