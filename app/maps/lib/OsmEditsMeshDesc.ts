// OSM edits as sparks on the globe, for Navara (Day 21). One point per cell and time bin with
// edits in it (osmEdits.ts), all year in one static buffer; the clock is a uniform, so playing,
// scrubbing and changing speed cost nothing per frame.
//
// - Spark: an entry flares when the clock passes its time and fades over `uTau` days, bigger
//   and brighter the more edits it holds. Colored by what was done: mint for created,
//   amber for modified, rose for deleted, mixed in their shares.
// - Mark: a cell keeps a dot after its latest edit, bright when fresh and dimming over
//   `uMarkTau` days to a faint floor; so the map shows where OSM is being worked on now and
//   where it was touched this year at all.
// Written to the emissive buffer, so the selective bloom spreads the sparks.
import {
  MeshDescWithSelectiveEffect,
  setupMaterialForMRT,
  type MeshConfigWithSelectiveEffect,
  type MeshUpdateWithSelectiveEffect,
} from '@navaramap/three'
import { AdditiveBlending, BufferGeometry, Float32BufferAttribute, Points, ShaderMaterial, Vector3 } from 'three'
import type { EditPoints } from './osmEdits'

type OsmEditsOptions = {
  /** Where the positions are measured from, in ECEF (must be the anchor the points were loaded with). Default: the Earth's centre */
  anchor?: { x: number; y: number; z: number }
  points?: EditPoints
  /** A cell's width (m), for the size of the lasting mark */
  cell?: number
  /** Spark size per doubling of the edits (px) */
  sparkPx?: number
  /** Strength of the mark after an edit, and how long it takes to dim (days). Default: 0.45, 20 */
  mark?: number
  markTau?: number
}
type Description = { osmEdits?: OsmEditsOptions }
export type OsmEditsConfig = MeshConfigWithSelectiveEffect & Description
type OsmEditsUpdate = MeshUpdateWithSelectiveEffect & Description

const DEFAULTS = { cell: 1000, sparkPx: 0.8, mark: 0.45, markTau: 20 }

const vertexShader = /* glsl */ `
  attribute float aTime;
  attribute float aSize;  // log2 of the edits
  attribute vec2 aMix;    // share created, share deleted
  attribute float aNext;  // when the cell is edited next (days)
  uniform float uNow;     // days since the start
  uniform float uTau;     // a spark's fade (days)
  uniform float uCell;
  uniform float uSparkPx;
  uniform float uMark;
  uniform float uMarkTau;
  uniform float uPixelRatio;
  uniform float uHalfHeight;
  varying vec3 vColor;
  varying float vCore;

  const vec3 CREATED = vec3(0.30, 1.00, 0.66);
  const vec3 MODIFIED = vec3(1.00, 0.72, 0.25);
  const vec3 DELETED = vec3(1.00, 0.28, 0.45);
  const vec3 FRESH = vec3(0.45, 0.85, 1.00);
  const vec3 OLD = vec3(0.30, 0.38, 0.95);

  void main() {
    float age = uNow - aTime;
    if (age < 0.0) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // not yet: off screen
      gl_PointSize = 0.0;
      return;
    }
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;

    float a = age / uTau;
    // A quick swell, then the fade
    float spark = exp(-a) * smoothstep(0.0, 0.08, a + 0.02);
    float weight = 0.25 + 0.75 * clamp(aSize / 10.0, 0.0, 1.0);
    vec3 kind = aMix.x * CREATED + aMix.y * DELETED + max(0.0, 1.0 - aMix.x - aMix.y) * MODIFIED;

    // The mark: the cell's own width on the ground, at least a pixel
    float cellPx = uCell * projectionMatrix[1][1] * uHalfHeight / max(-mv.z, 1.0);
    float markPx = clamp(cellPx * 1.6, 1.6, 6.0);
    float sparkPx = (2.0 + aSize * uSparkPx) * (1.0 + 0.5 * exp(-a * 3.0));
    // Only the cell's latest entry holds the mark
    float latest = step(uNow, aNext);
    float fresh = exp(-age / uMarkTau);
    float mark = latest * uMark * (0.3 + 0.7 * fresh) * smoothstep(0.0, 1.0, a);

    vColor = kind * spark * weight * 1.3 + mix(OLD, FRESH, fresh) * mark;
    vCore = spark;
    gl_PointSize = max(markPx * latest, sparkPx * spark + markPx * (1.0 - spark) * latest) * uPixelRatio;
    if (spark < 0.004 && latest < 0.5) gl_PointSize = 0.0;
  }
`

// setupMaterialForMRT appends the G-buffer writes before main()'s closing brace, so keep main() last
const fragmentShader = /* glsl */ `
  varying vec3 vColor;
  varying float vCore;
  void main() {
    vec3 normal = vec3(0.0, 0.0, 1.0); // read by the G-buffer write appended below
    float d = length(gl_PointCoord - 0.5) * 2.0;
    if (d > 1.0) discard;
    // Soft halo, with a white-hot core while it's fresh
    float halo = pow(1.0 - d, 1.6);
    float core = exp(-d * d * 18.0) * vCore;
    gl_FragColor = vec4(vColor * (halo + core * 0.6), 1.0);
  }
`

export class OsmEditsMeshDesc extends MeshDescWithSelectiveEffect<OsmEditsConfig, OsmEditsUpdate, Points> {
  private config: OsmEditsConfig
  private material?: ShaderMaterial

  constructor(...args: ConstructorParameters<typeof MeshDescWithSelectiveEffect<OsmEditsConfig, OsmEditsUpdate>>) {
    super(...args)
    this.config = args[2] ?? {}
  }

  private get options() {
    return { ...DEFAULTS, ...this.config.osmEdits! }
  }

  override createMesh() {
    const opts = this.options
    const p = opts.points
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new Float32BufferAttribute(p?.position ?? new Float32Array(), 3))
    geometry.setAttribute('aTime', new Float32BufferAttribute(p?.time ?? new Float32Array(), 1))
    geometry.setAttribute('aSize', new Float32BufferAttribute(p?.size ?? new Float32Array(), 1))
    geometry.setAttribute('aMix', new Float32BufferAttribute(p?.mix ?? new Float32Array(), 2))
    geometry.setAttribute('aNext', new Float32BufferAttribute(p?.next ?? new Float32Array(), 1))

    const material = new ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        uNow: { value: 0 },
        uTau: { value: 1 },
        uCell: { value: opts.cell },
        uSparkPx: { value: opts.sparkPx },
        uMark: { value: opts.mark },
        uMarkTau: { value: opts.markTau },
        uPixelRatio: { value: window.devicePixelRatio },
        uHalfHeight: { value: 400 },
      },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    })
    // Selective bloom: the shader's color is written to the emissive buffer as is
    material.defines.USE_SELECTIVE_EFFECT = 1
    material.userData.uEffectIdsMask = { value: 0 }
    material.uniforms.uEffectIdsMask = material.userData.uEffectIdsMask
    material.uniforms.uEmissiveColor = { value: new Vector3() }
    material.uniforms.uEmissiveIntensity = { value: 1 }
    setupMaterialForMRT(material)
    this.material = material

    const mesh = new Points(geometry, material)
    if (opts.anchor) mesh.position.set(opts.anchor.x, opts.anchor.y, opts.anchor.z)
    mesh.frustumCulled = false
    return mesh
  }

  /**
   * Sets the clock to `now` (days since the start) with sparks fading over `tau` days, for a
   * view `halfHeight` CSS px tall at half; `pixelRatio` is the renderer's.
   */
  tick(now: number, tau: number, halfHeight: number, pixelRatio: number): void {
    const u = this.material?.uniforms
    if (!u) return
    u.uNow!.value = now
    u.uTau!.value = tau
    u.uHalfHeight!.value = halfHeight
    u.uPixelRatio!.value = pixelRatio
  }

  protected override updateEffectIdsMask(): void {
    const registry = this.ctx.selectiveEffectRegistry
    if (!registry || !this.material) return
    this.material.userData.uEffectIdsMask.value = this._effectIds.length > 0 ? registry.computeMask(this._effectIds) : 0
  }

  override onDestroy(): void {
    const mesh = this.raw
    super.onDestroy()
    mesh?.geometry.dispose()
    this.material?.dispose()
  }
}
