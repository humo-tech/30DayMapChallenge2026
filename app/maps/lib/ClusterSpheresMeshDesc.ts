// Cluster markers as glossy 3D spheres resting on the globe, each over a pool of light, for Navara.
//
// - Spheres: one instanced draw of a unit sphere, scaled per instance. Sizes are given in
//   screen px at the view centre and turned into metres with `metersPerPx` every frame, so
//   they keep their on-screen size as the camera zooms while still foreshortening in a
//   tilted view. Shaded in view space (the key light stays over the viewer's shoulder),
//   with a sky term along the local vertical so their undersides sit in shadow.
// - Glow: an additive disc on the ground under each sphere, brighter for hotter clusters,
//   written to the emissive buffer so the selective bloom spreads it.
// - Transitions: `transition()` moves each sphere from one state to another (a cluster
//   splitting into its children, or children gathering into their cluster) and then shows
//   the final set.
import {
  Color,
  MeshDescWithSelectiveEffect,
  geodeticSurfaceNormal,
  geodeticToVector3,
  setupMaterialForMRT,
  type MeshConfigWithSelectiveEffect,
  type MeshUpdateWithSelectiveEffect,
} from '@navaramap/three'
import {
  AdditiveBlending,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  PlaneGeometry,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
} from 'three'

export type ClusterSphere = {
  lng: number
  lat: number
  /** Diameter (CSS px at the view centre) */
  size: number
  /** 0-1: brightens the glow under the sphere */
  heat: number
}
export type ClusterSphereMove = { from: ClusterSphere; to: ClusterSphere }

type ClusterSpheresOptions = {
  /** Most spheres drawn at once. Default: 16384 */
  capacity?: number
  /** Where the instance offsets are measured from; keep it near the data for float precision */
  anchor?: { lng: number; lat: number }
  color?: Color
  /** Shadow side of the spheres */
  shadeColor?: Color
  /** Ground glow color */
  glowColor?: Color
  /** Ground glow strength. Default: 0.55 */
  glow?: number
  /** Ground glow radius relative to the sphere's. Default: 2 */
  glowScale?: number
  /** Transition length (ms). Default: 700 */
  duration?: number
}
type Description = { clusterSpheres?: ClusterSpheresOptions }
export type ClusterSpheresConfig = MeshConfigWithSelectiveEffect & Description
type ClusterSpheresUpdate = MeshUpdateWithSelectiveEffect & Description

const DEFAULTS = {
  capacity: 16_384,
  anchor: { lng: 137.5, lat: 36 },
  color: new Color().setStyle('#fabe00'),
  shadeColor: new Color().setStyle('#bf7a00'),
  glowColor: new Color().setStyle('#ffe39a'),
  glow: 0.55,
  glowScale: 2,
  duration: 700,
}

const commonVertex = /* glsl */ `
  attribute vec3 aCenter; // ground point under the sphere, relative to the anchor
  attribute vec3 aUp;     // local vertical there
  attribute float aSize;
  attribute float aHeat;
  uniform float uMetersPerPx;
  varying float vHeat;
`

const sphereVertexShader = /* glsl */ `
  ${commonVertex}
  varying vec3 vPosV;
  varying vec3 vNormalV;
  varying vec3 vUpV;
  void main() {
    float r = 0.5 * aSize * uMetersPerPx;
    vec4 mv = modelViewMatrix * vec4(aCenter + aUp * r + position * r, 1.0);
    vPosV = mv.xyz;
    vNormalV = mat3(modelViewMatrix) * position;
    vUpV = mat3(modelViewMatrix) * aUp;
    vHeat = aHeat;
    gl_Position = projectionMatrix * mv;
  }
`

// setupMaterialForMRT appends the G-buffer writes before main()'s closing brace, so keep main() last
const sphereFragmentShader = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uShadeColor;
  varying float vHeat;
  varying vec3 vPosV;
  varying vec3 vNormalV;
  varying vec3 vUpV;
  void main() {
    vec3 normal = normalize(vNormalV); // also read by the G-buffer write appended below
    vec3 V = normalize(-vPosV);
    vec3 L = normalize(vec3(-0.45, 0.7, 0.55)); // key light: upper left, toward the viewer

    // Shade by shifting toward a warm dark rather than toward black, so the yellow stays clean
    float light = smoothstep(-0.9, 1.0, dot(normal, L)) * mix(0.8, 1.0, 0.5 + 0.5 * dot(normal, normalize(vUpV)));
    vec3 c = mix(uShadeColor, uColor, light);
    // Glossy plastic: a soft-edged highlight over a broad sheen. A crisp spot and a bright rim
    // read as metal, so neither is used
    float nh = max(dot(normal, normalize(L + V)), 0.0);
    c += vec3(pow(nh, 40.0) * 0.32 + pow(nh, 6.0) * 0.05);
    gl_FragColor = vec4(c, 1.0);
  }
`

const glowVertexShader = /* glsl */ `
  ${commonVertex}
  uniform float uGlowScale;
  varying vec2 vXY;
  void main() {
    float r = 0.5 * aSize * uMetersPerPx;
    vec3 east = normalize(cross(vec3(0.0, 0.0, 1.0), aUp));
    vec3 north = cross(aUp, east);
    // Lifted a little off the ground so the basemap doesn't fight it
    vec3 p = aCenter + (east * position.x + north * position.y) * r * uGlowScale + aUp * r * 0.03;
    vXY = position.xy;
    vHeat = aHeat;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`

const glowFragmentShader = /* glsl */ `
  uniform vec3 uGlowColor;
  uniform float uGlow;
  varying float vHeat;
  varying vec2 vXY;
  void main() {
    vec3 normal = vec3(0.0, 0.0, 1.0); // read by the G-buffer write appended below
    float d = length(vXY);
    if (d > 1.0) discard;
    float g = exp(-d * d * 6.0) * (1.0 - d) * uGlow * (0.25 + 0.75 * vHeat);
    gl_FragColor = vec4(uGlowColor * g, 1.0);
  }
`

// Splitting children spring out past their spots and settle back; gathering ones speed into the parent
const easeOutBack = (t: number) => 1 + 2.2 * (t - 1) ** 3 + 1.2 * (t - 1) ** 2
const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2)

export class ClusterSpheresMeshDesc extends MeshDescWithSelectiveEffect<ClusterSpheresConfig, ClusterSpheresUpdate, Group> {
  private config: ClusterSpheresConfig
  private anchor = new Vector3()
  private geometries: InstancedBufferGeometry[] = []
  private sphereMaterial?: ShaderMaterial
  private glowMaterial?: ShaderMaterial
  private aCenter?: InstancedBufferAttribute
  private aUp?: InstancedBufferAttribute
  private aSize?: InstancedBufferAttribute
  private aHeat?: InstancedBufferAttribute
  private moves: ClusterSphereMove[] = []
  private ease = easeInOutCubic
  private settled: ClusterSphere[] = []
  private startedAt = -1

  constructor(...args: ConstructorParameters<typeof MeshDescWithSelectiveEffect<ClusterSpheresConfig, ClusterSpheresUpdate>>) {
    super(...args)
    this.config = args[2] ?? {}
  }

  private get options() {
    return { ...DEFAULTS, ...this.config.clusterSpheres }
  }

  override createMesh() {
    const opts = this.options
    this.anchor.copy(geodeticToVector3({ ...opts.anchor, height: 0 }))
    const n = opts.capacity
    this.aCenter = new InstancedBufferAttribute(new Float32Array(n * 3), 3)
    this.aUp = new InstancedBufferAttribute(new Float32Array(n * 3), 3)
    this.aSize = new InstancedBufferAttribute(new Float32Array(n), 1)
    this.aHeat = new InstancedBufferAttribute(new Float32Array(n), 1)

    const instanced = (base: SphereGeometry | PlaneGeometry) => {
      const g = new InstancedBufferGeometry()
      g.index = base.index
      g.setAttribute('position', base.getAttribute('position'))
      g.setAttribute('aCenter', this.aCenter!)
      g.setAttribute('aUp', this.aUp!)
      g.setAttribute('aSize', this.aSize!)
      g.setAttribute('aHeat', this.aHeat!)
      g.instanceCount = 0
      this.geometries.push(g)
      return g
    }
    const metersPerPx = { value: 1 }

    this.sphereMaterial = new ShaderMaterial({
      vertexShader: sphereVertexShader,
      fragmentShader: sphereFragmentShader,
      uniforms: {
        uMetersPerPx: metersPerPx,
        uColor: { value: new Vector3(...opts.color.toArray()) },
        uShadeColor: { value: new Vector3(...opts.shadeColor.toArray()) },
      },
    })
    setupMaterialForMRT(this.sphereMaterial)

    this.glowMaterial = new ShaderMaterial({
      vertexShader: glowVertexShader,
      fragmentShader: glowFragmentShader,
      uniforms: {
        uMetersPerPx: metersPerPx,
        uGlowScale: { value: opts.glowScale },
        uGlowColor: { value: new Vector3(...opts.glowColor.toArray()) },
        uGlow: { value: opts.glow },
      },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    })
    // Selective bloom: the shader's color is written to the emissive buffer as is
    this.glowMaterial.defines.USE_SELECTIVE_EFFECT = 1
    this.glowMaterial.userData.uEffectIdsMask = { value: 0 }
    this.glowMaterial.uniforms.uEffectIdsMask = this.glowMaterial.userData.uEffectIdsMask
    this.glowMaterial.uniforms.uEmissiveColor = { value: new Vector3() }
    this.glowMaterial.uniforms.uEmissiveIntensity = { value: 1 }
    setupMaterialForMRT(this.glowMaterial)

    const spheres = new Mesh(instanced(new SphereGeometry(1, 40, 24)), this.sphereMaterial)
    const glows = new Mesh(instanced(new PlaneGeometry(2, 2)), this.glowMaterial)
    // Instances are placed in the shaders: skip bounds-based culling
    spheres.frustumCulled = false
    glows.frustumCulled = false
    const group = new Group()
    group.position.copy(this.anchor)
    group.add(glows, spheres)
    return group
  }

  /** Shows `spheres` as they are. */
  set(spheres: ClusterSphere[]): void {
    this.moves = []
    this.startedAt = -1
    this.settled = spheres
    this.write(spheres.length, (i) => spheres[i]!)
  }

  /** Moves spheres `from` -> `to` over the transition, then shows `then`. */
  transition(moves: ClusterSphereMove[], then: ClusterSphere[], kind: 'split' | 'merge'): void {
    if (moves.length === 0) return this.set(then)
    this.moves = moves
    this.settled = then
    this.ease = kind === 'split' ? easeOutBack : easeInOutCubic
    this.startedAt = -1 // stamped by the next tick
    this.write(moves.length, (i) => moves[i]!.from)
  }

  /** Advances the transition to `now` (ms) and sets the px -> m scale at the view centre. */
  tick(now: number, metersPerPx: number): void {
    if (!this.sphereMaterial) return
    this.sphereMaterial.uniforms.uMetersPerPx!.value = metersPerPx
    if (this.moves.length === 0) return
    if (this.startedAt < 0) this.startedAt = now
    const t = Math.min(1, (now - this.startedAt) / this.options.duration)
    if (t >= 1) {
      this.set(this.settled)
      return
    }
    const e = this.ease(t)
    const lerp = (a: number, b: number) => a + (b - a) * e
    const s: ClusterSphere = { lng: 0, lat: 0, size: 0, heat: 0 }
    this.write(this.moves.length, (i) => {
      const { from, to } = this.moves[i]!
      s.lng = lerp(from.lng, to.lng)
      s.lat = lerp(from.lat, to.lat)
      s.size = lerp(from.size, to.size)
      s.heat = lerp(from.heat, to.heat)
      return s
    })
  }

  private write(count: number, at: (i: number) => ClusterSphere): void {
    if (!this.aCenter || !this.aUp || !this.aSize || !this.aHeat) return
    const n = Math.min(count, this.options.capacity)
    const lle = { lng: 0, lat: 0, height: 0 }
    for (let i = 0; i < n; i++) {
      const s = at(i)
      lle.lng = s.lng
      lle.lat = s.lat
      const p = geodeticToVector3(lle).sub(this.anchor)
      const u = geodeticSurfaceNormal(lle)
      this.aCenter.setXYZ(i, p.x, p.y, p.z)
      this.aUp.setXYZ(i, u.x, u.y, u.z)
      this.aSize.setX(i, s.size)
      this.aHeat.setX(i, s.heat)
    }
    for (const a of [this.aCenter, this.aUp, this.aSize, this.aHeat]) {
      a.clearUpdateRanges()
      a.addUpdateRange(0, n * a.itemSize)
      a.needsUpdate = true
    }
    for (const g of this.geometries) g.instanceCount = n
  }

  protected override updateEffectIdsMask(): void {
    const registry = this.ctx.selectiveEffectRegistry
    if (!registry || !this.glowMaterial) return
    this.glowMaterial.userData.uEffectIdsMask.value = this._effectIds.length > 0 ? registry.computeMask(this._effectIds) : 0
  }

  override onDestroy(): void {
    super.onDestroy()
    for (const g of this.geometries) g.dispose()
    this.sphereMaterial?.dispose()
    this.glowMaterial?.dispose()
  }
}
