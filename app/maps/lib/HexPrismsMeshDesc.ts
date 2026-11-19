// H3 cells as glowing hexagonal prisms standing on the globe, for Navara.
//
// - Prisms: each cell is its own small mesh (top fan + side walls) built from its real H3 outline,
//   so pentagons and the cells bent across icosahedron edges come out right. Everything for one
//   resolution is one merged geometry, positions measured from an anchor for float precision.
//   Height is decided in the vertex shader: `uExtrude` 0 is a flat tile (2D), 1 is a column
//   as tall as the cell's value (3D). It rises in a wave out from the view centre and overshoots.
// - Sparkle: twinkling per cell, light climbing the walls, a bright rim on the top, a wave of
//   brightness running outward. All in the fragment shader, all driven by one clock.
// - Glow: an additive pool of light on the ground under the brighter cells.
//   Prisms and pools both write to the emissive buffer, so the selective bloom spreads them.
// - Resolution changes: `show()` grows the new set in (staggered, with overshoot) and shrinks the
//   old one away at the same time.
import {
  MeshDescWithSelectiveEffect,
  geodeticToVector3,
  setupMaterialForMRT,
  type MeshConfigWithSelectiveEffect,
  type MeshUpdateWithSelectiveEffect,
} from '@navaramap/three'
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Group,
  Mesh,
  ShaderMaterial,
  Vector3,
} from 'three'
import type { H3Set } from './h3Cells'

type HexPrismsOptions = {
  /** Where the vertex positions are measured from; keep it near the data for float precision */
  anchor?: { lng: number; lat: number }
  /** How much of the cell the prism covers (0-1); the rest is the gap between cells. Default: 0.9 */
  fill?: number
  /** Column height at full value, in cell edge lengths. Default: 6 */
  height?: number
  /** Ground pool strength. Default: 0.7 */
  glow?: number
  /** Twinkle strength. Default: 1 */
  sparkle?: number
  /** Time to grow in / shrink away on a resolution change (ms). Default: 800 */
  duration?: number
}
type Description = { hexPrisms?: HexPrismsOptions }
export type HexPrismsConfig = MeshConfigWithSelectiveEffect & Description
type HexPrismsUpdate = MeshUpdateWithSelectiveEffect & Description

const DEFAULTS = {
  anchor: { lng: 137.5, lat: 36 },
  fill: 0.9,
  height: 6,
  glow: 0.7,
  sparkle: 1,
  duration: 800,
}

/** Cells with a value under this get no pool of light */
const GLOW_MIN = 0.3

// Shared GLSL: easing, staggering, and the color ramp (indigo -> blue -> cyan -> magenta -> gold -> white)
const common = /* glsl */ `
  float easeOutBack(float t) { float u = t - 1.0; return 1.0 + 2.4 * u * u * u + 1.4 * u * u; }
  float easeInCubic(float t) { return t * t * t; }
  // 0 -> 1 as p goes 0 -> 1, but each item starts late by up to s of the run (d in 0-1 is its place in the queue)
  float stagger(float p, float d, float s) { return clamp(p * (1.0 + s) - d * s, 0.0, 1.0); }
  vec3 ramp(float t) {
    t = clamp(t, 0.0, 1.0);
    vec3 c0 = vec3(0.10, 0.14, 0.45);
    vec3 c1 = vec3(0.17, 0.42, 0.98);
    vec3 c2 = vec3(0.10, 0.86, 0.88);
    vec3 c3 = vec3(1.00, 0.30, 0.85);
    vec3 c4 = vec3(1.00, 0.82, 0.25);
    vec3 c5 = vec3(1.00, 0.94, 0.78);
    vec3 c = mix(c0, c1, smoothstep(0.00, 0.22, t));
    c = mix(c, c2, smoothstep(0.20, 0.45, t));
    c = mix(c, c3, smoothstep(0.42, 0.68, t));
    c = mix(c, c4, smoothstep(0.66, 0.90, t));
    return mix(c, c5, smoothstep(0.93, 1.00, t));
  }
`

const prismVertexShader = /* glsl */ `
  ${common}
  // position: the ground point, relative to the anchor
  attribute vec3 aCenter; // the cell's centre, same frame
  attribute vec3 aInfo;   // x: 0 top, 1 wall; y: 0 at the foot, 1 at the head; z: 0 at the middle of the top, 1 at its edge
  attribute vec2 aVS;     // value, seed
  uniform vec3 uAnchor;   // the anchor in ECEF, for the local vertical
  uniform vec3 uFocus;    // the view centre, relative to the anchor
  uniform float uFocusR;  // metres from there at which the wave is spent
  uniform float uEdge;    // cell edge (m)
  uniform float uHeight;  // column height at full value, in edges
  uniform float uExtrude; // 0 flat, 1 columns (overshoots while rising)
  uniform float uGrow;    // 0-1 progress of this set growing in / shrinking away
  uniform float uLeaving; // 1 while shrinking away
  uniform float uTime;
  varying vec3 vInfo;
  varying vec2 vVS;
  varying vec3 vPosV;
  varying float vHeightE; // height of this vertex above the ground, in edges
  varying float vWave;    // 0-1 along the run out from the view centre

  void main() {
    float value = aVS.x;
    float seed = aVS.y;
    float d = clamp(length(aCenter - uFocus) / uFocusR, 0.0, 1.0);

    // This set growing in (from the cell centre, up) or shrinking away
    float g = stagger(uGrow, seed, 0.8);
    float grow = uLeaving > 0.5 ? 1.0 - easeInCubic(g) : easeOutBack(g);
    // 2D <-> 3D: a wave from the view centre outward, the columns springing past their height and settling
    float ex = easeOutBack(stagger(uExtrude, d, 0.9));
    ex = uExtrude <= 0.0 ? 0.0 : uExtrude >= 1.0 ? 1.0 : ex;
    // Breathing: the taller ones swell with the wave that keeps running through
    float breathe = 1.0 + 0.07 * value * sin(d * 14.0 - uTime * 2.0);

    float tile = 0.05;
    float column = 0.5 + uHeight * pow(value, 1.15);
    float h = mix(tile, column, ex) * breathe * max(grow, 0.0) * uEdge;

    vec3 foot = aCenter + (position - aCenter) * max(grow, 0.0);
    vec3 up = normalize(foot + uAnchor);
    vec3 p = foot + up * (h * aInfo.y);

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vPosV = mv.xyz;
    vInfo = aInfo;
    vVS = aVS;
    vHeightE = h * aInfo.y / uEdge;
    vWave = d;
    gl_Position = projectionMatrix * mv;
  }
`

// setupMaterialForMRT appends the G-buffer writes before main()'s closing brace, so keep main() last
const prismFragmentShader = /* glsl */ `
  ${common}
  uniform float uTime;
  uniform float uSparkle;
  uniform float uExtrude;
  varying vec3 vInfo;
  varying vec2 vVS;
  varying vec3 vPosV;
  varying float vHeightE;
  varying float vWave;

  void main() {
    float value = vVS.x;
    float seed = vVS.y;
    // Flat shading: the surface's own slope, turned to face the viewer (also read by the G-buffer write appended below)
    vec3 normal = normalize(cross(dFdx(vPosV), dFdy(vPosV)));
    vec3 V = normalize(-vPosV);
    if (dot(normal, V) < 0.0) normal = -normal;
    vec3 L = normalize(vec3(-0.4, 0.7, 0.6));
    float diff = 0.5 + 0.5 * dot(normal, L);
    float fres = pow(1.0 - max(dot(normal, V), 0.0), 3.0);

    // The wave of brightness running out from the view centre, and the twinkle
    float wave = 0.5 + 0.5 * sin(vWave * 18.0 - uTime * 2.2);
    float tw = pow(0.5 + 0.5 * sin(uTime * (1.6 + seed * 3.4) + seed * 61.0), 14.0) * uSparkle;

    vec3 hue = ramp(value);
    vec3 c;
    if (vInfo.x < 0.5) {
      // Top: lit from the middle, with a bright line round the edge
      float rim = smoothstep(0.80, 1.0, vInfo.z);
      c = hue * (0.55 + 0.45 * diff) * (1.0 + 0.7 * (1.0 - vInfo.z) * value);
      c += ramp(value + 0.28) * rim * (0.9 + 0.8 * wave) * (0.5 + 0.8 * uExtrude);
    } else {
      // Wall: darker toward the foot, with bands of light climbing it, and a lit lip at the head
      vec3 lift = ramp(value * (0.45 + 0.55 * vInfo.y));
      c = lift * (0.4 + 0.6 * diff);
      float climb = fract(vHeightE * 1.6 - uTime * 0.45 + seed);
      float band = smoothstep(0.0, 0.08, climb) * smoothstep(0.30, 0.08, climb);
      c += ramp(value + 0.2) * band * (0.35 + 0.9 * value) * uExtrude;
      c += ramp(value + 0.28) * smoothstep(0.88, 1.0, vInfo.y) * 1.2;
    }
    c += hue * fres * 0.8;
    // Twinkle, mostly on the bright cells; a flash of near white
    c += vec3(1.0, 0.96, 0.88) * tw * (0.25 + 1.4 * value);
    c *= 0.7; // keep the tall cells from clipping to white
    gl_FragColor = vec4(c, 1.0);
  }
`

const glowVertexShader = /* glsl */ `
  ${common}
  // position: the cell's centre, relative to the anchor
  attribute vec2 aCorner; // -1..1
  attribute vec2 aVS;
  uniform vec3 uAnchor;
  uniform vec3 uFocus;
  uniform float uFocusR;
  uniform float uEdge;
  uniform float uExtrude;
  uniform float uGrow;
  uniform float uLeaving;
  varying vec2 vCorner;
  varying vec2 vVS;
  varying float vFade;
  void main() {
    float value = aVS.x;
    float seed = aVS.y;
    float g = stagger(uGrow, seed, 0.8);
    float grow = uLeaving > 0.5 ? 1.0 - easeInCubic(g) : easeOutBack(g);
    vec3 up = normalize(position + uAnchor);
    vec3 east = normalize(cross(vec3(0.0, 0.0, 1.0), up));
    vec3 north = cross(up, east);
    float r = uEdge * (1.6 + 2.2 * value) * max(grow, 0.0);
    // Lifted a little off the ground so the basemap doesn't fight it
    vec3 p = position + (east * aCorner.x + north * aCorner.y) * r + up * uEdge * 0.06;
    vCorner = aCorner;
    vVS = aVS;
    vFade = 1.0;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`

const glowFragmentShader = /* glsl */ `
  uniform float uGlow;
  uniform float uTime;
  uniform float uExtrude;
  varying vec2 vCorner;
  varying vec2 vVS;
  varying float vFade;
  ${common}
  void main() {
    vec3 normal = vec3(0.0, 0.0, 1.0); // read by the G-buffer write appended below
    float d = length(vCorner);
    if (d > 1.0) discard;
    float value = vVS.x;
    float pulse = 0.85 + 0.15 * sin(uTime * 1.7 + vVS.y * 40.0);
    float g = exp(-d * d * 5.0) * (1.0 - d) * uGlow * pow(value, 1.6) * pulse * (0.7 + 0.5 * uExtrude);
    gl_FragColor = vec4(ramp(value + 0.15) * g, 1.0);
  }
`

type Slot = {
  prism: Mesh<BufferGeometry, ShaderMaterial>
  glow: Mesh<BufferGeometry, ShaderMaterial>
  /** Time (ms) this slot began growing or shrinking; -1 until the next tick stamps it */
  startedAt: number
  leaving: boolean
  active: boolean
}

export class HexPrismsMeshDesc extends MeshDescWithSelectiveEffect<HexPrismsConfig, HexPrismsUpdate, Group> {
  private config: HexPrismsConfig
  private anchor = new Vector3()
  private slots: Slot[] = []
  private front = 0
  private extrude = { value: 1 }
  private time = { value: 0 }
  private focus = { value: new Vector3() }
  private focusR = { value: 100_000 }

  constructor(...args: ConstructorParameters<typeof MeshDescWithSelectiveEffect<HexPrismsConfig, HexPrismsUpdate>>) {
    super(...args)
    this.config = args[2] ?? {}
  }

  private get options() {
    return { ...DEFAULTS, ...this.config.hexPrisms }
  }

  override createMesh() {
    const opts = this.options
    this.anchor.copy(geodeticToVector3({ ...opts.anchor, height: 0 }))
    const group = new Group()
    group.position.copy(this.anchor)
    for (let i = 0; i < 2; i++) {
      const slot = this.makeSlot()
      this.slots.push(slot)
      group.add(slot.glow, slot.prism)
    }
    return group
  }

  private makeSlot(): Slot {
    const opts = this.options
    // Per slot: its own edge length and growth; the 2D/3D mix, the clock and the view centre are shared
    const own = { uEdge: { value: 1 }, uGrow: { value: 1 }, uLeaving: { value: 0 } }
    const shared = {
      uAnchor: { value: this.anchor },
      uFocus: this.focus,
      uFocusR: this.focusR,
      uExtrude: this.extrude,
      uTime: this.time,
    }
    const prismMaterial = new ShaderMaterial({
      vertexShader: prismVertexShader,
      fragmentShader: prismFragmentShader,
      uniforms: { ...shared, ...own, uHeight: { value: opts.height }, uSparkle: { value: opts.sparkle } },
      side: DoubleSide,
    })
    const glowMaterial = new ShaderMaterial({
      vertexShader: glowVertexShader,
      fragmentShader: glowFragmentShader,
      uniforms: { ...shared, ...own, uGlow: { value: opts.glow } },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    })
    for (const m of [prismMaterial, glowMaterial]) {
      // Selective bloom: the shader's color is written to the emissive buffer as is
      m.defines.USE_SELECTIVE_EFFECT = 1
      m.userData.uEffectIdsMask = { value: 0 }
      m.uniforms.uEffectIdsMask = m.userData.uEffectIdsMask
      m.uniforms.uEmissiveColor = { value: new Vector3() }
      m.uniforms.uEmissiveIntensity = { value: 1 }
      setupMaterialForMRT(m)
    }
    const prism = new Mesh(new BufferGeometry(), prismMaterial)
    const glow = new Mesh(new BufferGeometry(), glowMaterial)
    // Positions are placed in the shaders: skip bounds-based culling
    prism.frustumCulled = false
    glow.frustumCulled = false
    prism.visible = glow.visible = false
    return { prism, glow, startedAt: -1, leaving: false, active: false }
  }

  /** Shows `set`, growing it in while the one on show shrinks away. */
  show(set: H3Set): void {
    if (this.slots.length < 2) return
    const old = this.slots[this.front]!
    this.front = 1 - this.front
    const next = this.slots[this.front]!

    // The old set leaves (whatever was still leaving in the slot we're taking over is dropped)
    if (old.active) {
      old.leaving = true
      old.startedAt = -1
      this.setUniform(old, 'uLeaving', 1)
      this.setUniform(old, 'uGrow', 0)
    }
    this.fill(next, set)
    next.leaving = false
    next.active = true
    next.startedAt = -1
    this.setUniform(next, 'uLeaving', 0)
    this.setUniform(next, 'uGrow', 0)
  }

  /** 0 = flat tiles, 1 = columns. It may be driven past 1 or below 0 only by the shader's own overshoot, so keep it in 0-1. */
  setExtrude(v: number): void {
    this.extrude.value = v
  }

  /** The view centre (ECEF, relative to the anchor's frame) and how far out the wave of motion reaches (m) */
  setFocus(lng: number, lat: number, radius: number): void {
    const p = geodeticToVector3({ lng, lat, height: 0 })
    this.focus.value.set(p.x - this.anchor.x, p.y - this.anchor.y, p.z - this.anchor.z)
    this.focusR.value = Math.max(radius, 1)
  }

  /** Advances the clock and the grow / shrink animations to `now` (ms). */
  tick(now: number): void {
    this.time.value = now / 1000
    const duration = this.options.duration
    for (const slot of this.slots) {
      if (!slot.active) continue
      if (slot.startedAt < 0) slot.startedAt = now
      const t = Math.min(1, (now - slot.startedAt) / duration)
      this.setUniform(slot, 'uGrow', t)
      if (t >= 1 && slot.leaving) {
        slot.active = false
        slot.prism.visible = slot.glow.visible = false
        slot.prism.geometry.dispose()
        slot.glow.geometry.dispose()
      }
    }
  }

  private setUniform(slot: Slot, name: string, value: number): void {
    slot.prism.material.uniforms[name]!.value = value
    slot.glow.material.uniforms[name]!.value = value
  }

  private fill(slot: Slot, set: H3Set): void {
    const opts = this.options
    slot.prism.geometry.dispose()
    slot.glow.geometry.dispose()
    slot.prism.geometry = this.prismGeometry(set, opts.fill)
    slot.glow.geometry = this.glowGeometry(set)
    this.setUniform(slot, 'uEdge', set.edge)
    slot.prism.visible = slot.glow.visible = true
  }

  private prismGeometry(set: H3Set, fill: number): BufferGeometry {
    const { cells } = set
    let vertices = 0
    let indices = 0
    for (const c of cells) {
      const n = c.ring.length
      vertices += 5 * n + 1
      indices += 9 * n
    }
    const position = new Float32Array(vertices * 3)
    const center = new Float32Array(vertices * 3)
    const info = new Float32Array(vertices * 3)
    const vs = new Float32Array(vertices * 2)
    const index = new Uint32Array(indices)

    const { x: ax, y: ay, z: az } = this.anchor
    const lle = { lng: 0, lat: 0, height: 0 }
    let v = 0
    let ix = 0
    const put = (px: number, py: number, pz: number, cx: number, cy: number, cz: number, kind: number, up: number, edge: number, value: number, seed: number) => {
      position.set([px, py, pz], v * 3)
      center.set([cx, cy, cz], v * 3)
      info.set([kind, up, edge], v * 3)
      vs.set([value, seed], v * 2)
      return v++
    }

    for (const cell of cells) {
      lle.lng = cell.center[0]
      lle.lat = cell.center[1]
      const c0 = geodeticToVector3(lle)
      const cx = c0.x - ax
      const cy = c0.y - ay
      const cz = c0.z - az
      // The outline pulled in toward the centre, to leave a gap between cells
      const ring: number[][] = cell.ring.map(([lng, lat]) => {
        lle.lng = lng
        lle.lat = lat
        const p = geodeticToVector3(lle)
        return [cx + (p.x - ax - cx) * fill, cy + (p.y - ay - cy) * fill, cz + (p.z - az - cz) * fill]
      })
      const n = ring.length

      // Top: a fan from the middle
      const mid = put(cx, cy, cz, cx, cy, cz, 0, 1, 0, cell.value, cell.seed)
      const first = v
      for (const r of ring) put(r[0]!, r[1]!, r[2]!, cx, cy, cz, 0, 1, 1, cell.value, cell.seed)
      for (let i = 0; i < n; i++) {
        index[ix++] = mid
        index[ix++] = first + i
        index[ix++] = first + ((i + 1) % n)
      }
      // Walls: a quad per side, foot to head
      for (let i = 0; i < n; i++) {
        const a = ring[i]!
        const b = ring[(i + 1) % n]!
        const a0 = put(a[0]!, a[1]!, a[2]!, cx, cy, cz, 1, 0, 1, cell.value, cell.seed)
        const b0 = put(b[0]!, b[1]!, b[2]!, cx, cy, cz, 1, 0, 1, cell.value, cell.seed)
        const b1 = put(b[0]!, b[1]!, b[2]!, cx, cy, cz, 1, 1, 1, cell.value, cell.seed)
        const a1 = put(a[0]!, a[1]!, a[2]!, cx, cy, cz, 1, 1, 1, cell.value, cell.seed)
        index.set([a0, b0, b1, a0, b1, a1], ix)
        ix += 6
      }
    }

    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(position, 3))
    g.setAttribute('aCenter', new BufferAttribute(center, 3))
    g.setAttribute('aInfo', new BufferAttribute(info, 3))
    g.setAttribute('aVS', new BufferAttribute(vs, 2))
    g.setIndex(new BufferAttribute(index, 1))
    return g
  }

  private glowGeometry(set: H3Set): BufferGeometry {
    const lit = set.cells.filter((c) => c.value >= GLOW_MIN)
    const position = new Float32Array(lit.length * 4 * 3)
    const corner = new Float32Array(lit.length * 4 * 2)
    const vs = new Float32Array(lit.length * 4 * 2)
    const index = new Uint32Array(lit.length * 6)
    const { x: ax, y: ay, z: az } = this.anchor
    const lle = { lng: 0, lat: 0, height: 0 }
    const corners = [-1, -1, 1, -1, 1, 1, -1, 1]
    lit.forEach((cell, k) => {
      lle.lng = cell.center[0]
      lle.lat = cell.center[1]
      const c = geodeticToVector3(lle)
      for (let j = 0; j < 4; j++) {
        const v = k * 4 + j
        position.set([c.x - ax, c.y - ay, c.z - az], v * 3)
        corner.set([corners[j * 2]!, corners[j * 2 + 1]!], v * 2)
        vs.set([cell.value, cell.seed], v * 2)
      }
      index.set([k * 4, k * 4 + 1, k * 4 + 2, k * 4, k * 4 + 2, k * 4 + 3], k * 6)
    })
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(position, 3))
    g.setAttribute('aCorner', new BufferAttribute(corner, 2))
    g.setAttribute('aVS', new BufferAttribute(vs, 2))
    g.setIndex(new BufferAttribute(index, 1))
    return g
  }

  protected override updateEffectIdsMask(): void {
    const registry = this.ctx.selectiveEffectRegistry
    if (!registry) return
    const mask = this._effectIds.length > 0 ? registry.computeMask(this._effectIds) : 0
    for (const slot of this.slots) {
      slot.prism.material.userData.uEffectIdsMask.value = mask
      slot.glow.material.userData.uEffectIdsMask.value = mask
    }
  }

  override onDestroy(): void {
    super.onDestroy()
    for (const slot of this.slots) {
      slot.prism.geometry.dispose()
      slot.glow.geometry.dispose()
      slot.prism.material.dispose()
      slot.glow.material.dispose()
    }
  }
}
