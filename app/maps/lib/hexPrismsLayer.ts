// Day 20's glowing H3 prisms on MapLibre GL JS (Mercator only): a custom layer with a Three.js
// renderer on the map's own GL context (as Day 10's bears and Day 12's waves).
//
// - The look is the Navara version's (HexPrismsMeshDesc.ts): the same fragment shaders, the same
//   growing, rising and twinkling. Only the frame differs: positions are Web Mercator, in metres
//   (as they are at the anchor's latitude) from an anchor, x east, y north, z up. Mercator draws
//   a metre bigger the farther north, by 1/cos(lat), so each cell carries that against the
//   anchor (`aScale`), for its height and its pool of light to keep to its outline's size.
// - MapLibre has no bloom, so the layer brings its own: the prisms and pools are drawn into an
//   offscreen target, its bright parts blurred down and back up a mip chain (as the
//   postprocessing library's bloom, which Navara's selective bloom is), and the two laid over the
//   map. Nothing else on the map is bright, so it's as selective as Navara's.
import { MercatorCoordinate, type CustomLayerInterface, type Map as MapLibreMap } from 'maplibre-gl'
import {
  BufferAttribute,
  BufferGeometry,
  Camera,
  CustomBlending,
  DoubleSide,
  Group,
  HalfFloatType,
  Matrix4,
  Mesh,
  NoBlending,
  OneFactor,
  OneMinusSrcAlphaFactor,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
  WebGLRenderTarget,
  WebGLRenderer,
  ZeroFactor,
  type Blending,
} from 'three'
import type { H3Set } from './h3Cells'
import { GLOW_MIN, common, glowFragmentShader, prismFragmentShader } from './HexPrismsMeshDesc'

export type HexPrismsLayerOptions = {
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
  /** Bloom, as Navara's selectiveBloom: strength, mix of the wide blur against the tight (0-1), luminance threshold */
  bloom?: { strength: number; radius: number; threshold: number }
  /** Called at the start of every frame, before anything is drawn */
  beforeFrame?: (now: number) => void
}

const DEFAULTS = {
  anchor: { lng: 137.5, lat: 36 },
  fill: 0.9,
  height: 6,
  glow: 0.7,
  sparkle: 1,
  duration: 800,
  bloom: { strength: 0.5, radius: 0.4, threshold: 0.5 },
}

/** Mip levels of the bloom's blur, from half the screen down */
export const BLOOM_LEVELS = 6

// The Navara version's vertex shader, with "up" as +z and each cell's own Mercator scale
const prismVertexShader = /* glsl */ `
  ${common}
  attribute vec3 aCenter;
  attribute vec3 aInfo;   // x: 0 top, 1 wall; y: 0 at the foot, 1 at the head; z: 0 at the middle of the top, 1 at its edge
  attribute vec3 aVS;     // value, seed, Mercator scale against the anchor
  uniform vec3 uFocus;
  uniform float uFocusR;
  uniform float uEdge;
  uniform float uHeight;
  uniform float uExtrude;
  uniform float uGrow;
  uniform float uLeaving;
  uniform float uTime;
  varying vec3 vInfo;
  varying vec2 vVS;
  varying vec3 vPosV;
  varying float vHeightE;
  varying float vWave;

  void main() {
    float value = aVS.x;
    float seed = aVS.y;
    float d = clamp(length(aCenter.xy - uFocus.xy) / uFocusR, 0.0, 1.0);

    float g = stagger(uGrow, seed, 0.8);
    float grow = uLeaving > 0.5 ? 1.0 - easeInCubic(g) : easeOutBack(g);
    float ex = easeOutBack(stagger(uExtrude, d, 0.9));
    ex = uExtrude <= 0.0 ? 0.0 : uExtrude >= 1.0 ? 1.0 : ex;
    float breathe = 1.0 + 0.07 * value * sin(d * 14.0 - uTime * 2.0);

    float tile = 0.05;
    float column = 0.5 + uHeight * pow(value, 1.15);
    float edge = uEdge * aVS.z;
    float h = mix(tile, column, ex) * breathe * max(grow, 0.0) * edge;

    vec3 foot = aCenter + (position - aCenter) * max(grow, 0.0);
    vec3 p = foot + vec3(0.0, 0.0, h * aInfo.y);

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vPosV = mv.xyz;
    vInfo = aInfo;
    vVS = aVS.xy;
    vHeightE = h * aInfo.y / edge;
    vWave = d;
    gl_Position = projectionMatrix * mv;
  }
`

const glowVertexShader = /* glsl */ `
  ${common}
  attribute vec2 aCorner;
  attribute vec3 aVS;
  uniform float uEdge;
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
    float edge = uEdge * aVS.z;
    float r = edge * (1.6 + 2.2 * value) * max(grow, 0.0);
    vec3 p = position + vec3(aCorner * r, edge * 0.06);
    vCorner = aCorner;
    vVS = aVS.xy;
    vFade = 1.0;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`

// Full-screen passes: one triangle over the whole target
export const passVertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = position.xy * 0.5 + 0.5;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`

// The bright parts, at half size (a 4-tap box, so nothing twinkles away between pixels)
export const brightFragmentShader = /* glsl */ `
  uniform sampler2D tInput;
  uniform vec2 uTexel;
  uniform float uThreshold;
  varying vec2 vUv;
  void main() {
    vec4 c = 0.25 * (texture2D(tInput, vUv + uTexel * vec2(-0.5, -0.5)) + texture2D(tInput, vUv + uTexel * vec2(0.5, -0.5))
      + texture2D(tInput, vUv + uTexel * vec2(-0.5, 0.5)) + texture2D(tInput, vUv + uTexel * vec2(0.5, 0.5)));
    float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
    gl_FragColor = vec4(c.rgb * smoothstep(uThreshold, uThreshold + 0.03, l), 1.0);
  }
`

// Down the chain: 13 taps (as Call of Duty's / the postprocessing library's)
export const downFragmentShader = /* glsl */ `
  uniform sampler2D tInput;
  uniform vec2 uTexel;
  varying vec2 vUv;
  vec3 at(vec2 o) { return texture2D(tInput, vUv + uTexel * o).rgb; }
  void main() {
    vec3 c = at(vec2(0.0)) * 0.125;
    c += (at(vec2(-1.0, -1.0)) + at(vec2(1.0, -1.0)) + at(vec2(-1.0, 1.0)) + at(vec2(1.0, 1.0))) * 0.125;
    c += (at(vec2(-2.0, -2.0)) + at(vec2(2.0, -2.0)) + at(vec2(-2.0, 2.0)) + at(vec2(2.0, 2.0))) * 0.03125;
    c += (at(vec2(-2.0, 0.0)) + at(vec2(2.0, 0.0)) + at(vec2(0.0, -2.0)) + at(vec2(0.0, 2.0))) * 0.0625;
    gl_FragColor = vec4(c, 1.0);
  }
`

// Back up: a 9-tap tent over the level below, mixed with this level's own by the radius
export const upFragmentShader = /* glsl */ `
  uniform sampler2D tInput;
  uniform sampler2D tSupport;
  uniform vec2 uTexel;
  uniform float uRadius;
  varying vec2 vUv;
  vec3 at(vec2 o) { return texture2D(tInput, vUv + uTexel * o).rgb; }
  void main() {
    vec3 c = at(vec2(0.0)) * 0.25;
    c += (at(vec2(-1.0, 0.0)) + at(vec2(1.0, 0.0)) + at(vec2(0.0, -1.0)) + at(vec2(0.0, 1.0))) * 0.125;
    c += (at(vec2(-1.0, -1.0)) + at(vec2(1.0, -1.0)) + at(vec2(-1.0, 1.0)) + at(vec2(1.0, 1.0))) * 0.0625;
    gl_FragColor = vec4(mix(texture2D(tSupport, vUv).rgb, c, uRadius), 1.0);
  }
`

// Onto the map: the prisms (premultiplied: the pools have no alpha, they only add light) and the
// bloom over them. The colors are linear, as in Navara, which encodes its frame for the screen at
// the end; MapLibre draws straight to the screen, so this does it
export const compositeFragmentShader = /* glsl */ `
  uniform sampler2D tScene;
  uniform sampler2D tBloom;
  uniform float uStrength;
  varying vec2 vUv;
  void main() {
    vec4 s = texture2D(tScene, vUv);
    vec3 c = s.rgb + texture2D(tBloom, vUv).rgb * uStrength;
    gl_FragColor = vec4(linearToOutputTexel(vec4(c, 1.0)).rgb, s.a);
  }
`

type Slot = {
  prism: Mesh<BufferGeometry, ShaderMaterial>
  glow: Mesh<BufferGeometry, ShaderMaterial>
  /** Time (ms) this slot began growing or shrinking; -1 until the next frame stamps it */
  startedAt: number
  leaving: boolean
  active: boolean
}

export type HexPrismsLayer = CustomLayerInterface & {
  /** Shows `set`, growing it in while the one on show shrinks away */
  show(set: H3Set): void
  /** 0 = flat tiles, 1 = columns */
  setExtrude(v: number): void
  /** The view centre, and how far out from it (m) the wave of motion reaches */
  setFocus(lng: number, lat: number, radius: number): void
  dispose(): void
}

export function hexPrismsLayer(options: HexPrismsLayerOptions = {}): HexPrismsLayer {
  const opts = { ...DEFAULTS, ...options }
  const origin = MercatorCoordinate.fromLngLat([opts.anchor.lng, opts.anchor.lat], 0)
  const unit = origin.meterInMercatorCoordinateUnits()
  const anchorCos = Math.cos((opts.anchor.lat * Math.PI) / 180)
  // Frame: metres (at the anchor's latitude) from the anchor, x east, y north, z up
  const model = new Matrix4().makeTranslation(origin.x, origin.y, 0).scale(new Vector3(unit, -unit, unit))
  const toFrame = (lng: number, lat: number): [number, number] => {
    const m = MercatorCoordinate.fromLngLat([lng, lat], 0)
    return [(m.x - origin.x) / unit, (origin.y - m.y) / unit]
  }
  // A metre on the ground at `lat`, in the frame's units
  const scaleAt = (lat: number) => anchorCos / Math.cos((lat * Math.PI) / 180)

  let map: MapLibreMap | undefined
  let renderer: WebGLRenderer | undefined
  const scene = new Scene()
  const group = new Group()
  scene.add(group)
  // Its matrices are set from the map's each frame
  const camera = new Camera()
  camera.matrixWorldAutoUpdate = false

  const extrude = { value: 1 }
  const time = { value: 0 }
  const focus = { value: new Vector3() }
  const focusR = { value: 100_000 }

  const makeSlot = (): Slot => {
    const own = { uEdge: { value: 1 }, uGrow: { value: 1 }, uLeaving: { value: 0 } }
    const shared = { uFocus: focus, uFocusR: focusR, uExtrude: extrude, uTime: time }
    const prism = new Mesh(
      new BufferGeometry(),
      new ShaderMaterial({
        vertexShader: prismVertexShader,
        fragmentShader: prismFragmentShader,
        uniforms: { ...shared, ...own, uHeight: { value: opts.height }, uSparkle: { value: opts.sparkle } },
        side: DoubleSide,
      }),
    )
    // The pools add light, and nothing to the alpha: where there is no prism, the map shows through
    const glow = new Mesh(
      new BufferGeometry(),
      new ShaderMaterial({
        vertexShader: glowVertexShader,
        fragmentShader: glowFragmentShader,
        uniforms: { ...shared, ...own, uGlow: { value: opts.glow } },
        transparent: true,
        depthWrite: false,
        blending: CustomBlending,
        blendSrc: OneFactor,
        blendDst: OneFactor,
        blendSrcAlpha: ZeroFactor,
        blendDstAlpha: OneFactor,
      }),
    )
    // Positions are placed in the shaders: skip bounds-based culling
    prism.frustumCulled = glow.frustumCulled = false
    prism.visible = glow.visible = false
    group.add(glow, prism)
    return { prism, glow, startedAt: -1, leaving: false, active: false }
  }
  const slots = [makeSlot(), makeSlot()]
  let front = 0

  const setUniform = (slot: Slot, name: string, value: number) => {
    slot.prism.material.uniforms[name]!.value = value
    slot.glow.material.uniforms[name]!.value = value
  }

  const prismGeometry = (set: H3Set): BufferGeometry => {
    let vertices = 0
    let indices = 0
    for (const c of set.cells) {
      vertices += 5 * c.ring.length + 1
      indices += 9 * c.ring.length
    }
    const position = new Float32Array(vertices * 3)
    const center = new Float32Array(vertices * 3)
    const info = new Float32Array(vertices * 3)
    const vs = new Float32Array(vertices * 3)
    const index = new Uint32Array(indices)
    let v = 0
    let ix = 0
    for (const cell of set.cells) {
      const [cx, cy] = toFrame(cell.center[0], cell.center[1])
      const s = scaleAt(cell.center[1])
      const put = (x: number, y: number, kind: number, up: number, edge: number) => {
        position.set([x, y, 0], v * 3)
        center.set([cx, cy, 0], v * 3)
        info.set([kind, up, edge], v * 3)
        vs.set([cell.value, cell.seed, s], v * 3)
        return v++
      }
      // The outline pulled in toward the centre, to leave a gap between cells
      const ring = cell.ring.map(([lng, lat]) => {
        const [x, y] = toFrame(lng, lat)
        return [cx + (x - cx) * opts.fill, cy + (y - cy) * opts.fill] as const
      })
      const n = ring.length
      // Top: a fan from the middle
      const mid = put(cx, cy, 0, 1, 0)
      const first = v
      for (const [x, y] of ring) put(x, y, 0, 1, 1)
      for (let i = 0; i < n; i++) {
        index.set([mid, first + i, first + ((i + 1) % n)], ix)
        ix += 3
      }
      // Walls: a quad per side, foot to head
      for (let i = 0; i < n; i++) {
        const [ax, ay] = ring[i]!
        const [bx, by] = ring[(i + 1) % n]!
        const a0 = put(ax, ay, 1, 0, 1)
        const b0 = put(bx, by, 1, 0, 1)
        const b1 = put(bx, by, 1, 1, 1)
        const a1 = put(ax, ay, 1, 1, 1)
        index.set([a0, b0, b1, a0, b1, a1], ix)
        ix += 6
      }
    }
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(position, 3))
    g.setAttribute('aCenter', new BufferAttribute(center, 3))
    g.setAttribute('aInfo', new BufferAttribute(info, 3))
    g.setAttribute('aVS', new BufferAttribute(vs, 3))
    g.setIndex(new BufferAttribute(index, 1))
    return g
  }

  const glowGeometry = (set: H3Set): BufferGeometry => {
    const lit = set.cells.filter((c) => c.value >= GLOW_MIN)
    const position = new Float32Array(lit.length * 4 * 3)
    const corner = new Float32Array(lit.length * 4 * 2)
    const vs = new Float32Array(lit.length * 4 * 3)
    const index = new Uint32Array(lit.length * 6)
    const corners = [-1, -1, 1, -1, 1, 1, -1, 1]
    lit.forEach((cell, k) => {
      const [x, y] = toFrame(cell.center[0], cell.center[1])
      const s = scaleAt(cell.center[1])
      for (let j = 0; j < 4; j++) {
        const v = k * 4 + j
        position.set([x, y, 0], v * 3)
        corner.set([corners[j * 2]!, corners[j * 2 + 1]!], v * 2)
        vs.set([cell.value, cell.seed, s], v * 3)
      }
      index.set([k * 4, k * 4 + 1, k * 4 + 2, k * 4, k * 4 + 2, k * 4 + 3], k * 6)
    })
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(position, 3))
    g.setAttribute('aCorner', new BufferAttribute(corner, 2))
    g.setAttribute('aVS', new BufferAttribute(vs, 3))
    g.setIndex(new BufferAttribute(index, 1))
    return g
  }

  // Grow / shrink: as the Navara version's tick()
  const tick = (now: number) => {
    time.value = now / 1000
    for (const slot of slots) {
      if (!slot.active) continue
      if (slot.startedAt < 0) slot.startedAt = now
      const t = Math.min(1, (now - slot.startedAt) / opts.duration)
      setUniform(slot, 'uGrow', t)
      if (t >= 1 && slot.leaving) {
        slot.active = false
        slot.prism.visible = slot.glow.visible = false
        slot.prism.geometry.dispose()
        slot.glow.geometry.dispose()
      }
    }
  }

  // The offscreen targets and passes
  const pass = (fragmentShader: string, uniforms: Record<string, { value: unknown }>, blending: Blending = NoBlending) =>
    new ShaderMaterial({ vertexShader: passVertexShader, fragmentShader, uniforms, blending, depthTest: false, depthWrite: false })
  const bright = pass(brightFragmentShader, { tInput: { value: null }, uTexel: { value: new Vector2() }, uThreshold: { value: opts.bloom.threshold } })
  const down = pass(downFragmentShader, { tInput: { value: null }, uTexel: { value: new Vector2() } })
  const up = pass(upFragmentShader, {
    tInput: { value: null },
    tSupport: { value: null },
    uTexel: { value: new Vector2() },
    uRadius: { value: opts.bloom.radius },
  })
  const composite = pass(compositeFragmentShader, { tScene: { value: null }, tBloom: { value: null }, uStrength: { value: opts.bloom.strength } }, CustomBlending)
  composite.blendSrc = OneFactor
  composite.blendDst = OneMinusSrcAlphaFactor
  const triangle = new BufferGeometry()
  triangle.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3))
  const quad = new Mesh(triangle, bright)
  quad.frustumCulled = false
  const passScene = new Scene().add(quad)

  const target = (samples = 0) => new WebGLRenderTarget(1, 1, { type: HalfFloatType, samples, depthBuffer: samples > 0 })
  const sceneTarget = target(4)
  const downs = Array.from({ length: BLOOM_LEVELS }, () => target())
  const ups = Array.from({ length: BLOOM_LEVELS - 1 }, () => target())
  const resize = (w: number, h: number) => {
    if (sceneTarget.width === w && sceneTarget.height === h) return
    sceneTarget.setSize(w, h)
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      const [lw, lh] = [Math.max(1, w >> (i + 1)), Math.max(1, h >> (i + 1))]
      downs[i]!.setSize(lw, lh)
      ups[i]?.setSize(lw, lh)
    }
  }
  const draw = (material: ShaderMaterial, to: WebGLRenderTarget | null) => {
    quad.material = material
    renderer!.setRenderTarget(to)
    renderer!.render(passScene, camera)
  }
  const texel = (m: ShaderMaterial, t: WebGLRenderTarget) => (m.uniforms.uTexel!.value as Vector2).set(1 / t.width, 1 / t.height)

  const projection = new Matrix4()
  const flipY = new Matrix4().makeScale(1, -1, 1)

  return {
    id: 'hex-prisms',
    type: 'custom',
    renderingMode: '3d',
    onAdd(m, gl) {
      map = m
      renderer = new WebGLRenderer({ canvas: m.getCanvas(), context: gl })
      renderer.autoClear = false
    },
    prerender() {
      const now = performance.now()
      opts.beforeFrame?.(now)
      tick(now)
    },
    render(gl, { defaultProjectionData, projectionMatrix }) {
      if (!map || !renderer) return
      // MapLibre's matrix takes Web Mercator to the screen; split off its perspective so the
      // shaders get a view space (y up) to shade in, as they do in Navara
      projection.fromArray(projectionMatrix as unknown as number[]).multiply(flipY)
      camera.projectionMatrix.copy(projection)
      camera.projectionMatrixInverse.copy(projection).invert()
      camera.matrixWorldInverse
        .copy(camera.projectionMatrixInverse)
        .multiply(new Matrix4().fromArray(defaultProjectionData.mainMatrix as unknown as number[]))
        .multiply(model)
      camera.matrixWorld.copy(camera.matrixWorldInverse).invert()

      renderer.resetState()
      resize(gl.drawingBufferWidth, gl.drawingBufferHeight)
      renderer.setClearColor(0x000000, 0)
      renderer.setRenderTarget(sceneTarget)
      renderer.clear()
      renderer.render(scene, camera)

      // Bloom: the bright parts down the chain, then back up
      bright.uniforms.tInput!.value = sceneTarget.texture
      texel(bright, sceneTarget)
      draw(bright, downs[0]!)
      for (let i = 1; i < BLOOM_LEVELS; i++) {
        down.uniforms.tInput!.value = downs[i - 1]!.texture
        texel(down, downs[i - 1]!)
        draw(down, downs[i]!)
      }
      let below = downs[BLOOM_LEVELS - 1]!
      for (let i = BLOOM_LEVELS - 2; i >= 0; i--) {
        up.uniforms.tInput!.value = below.texture
        up.uniforms.tSupport!.value = downs[i]!.texture
        texel(up, below)
        draw(up, ups[i]!)
        below = ups[i]!
      }

      composite.uniforms.tScene!.value = sceneTarget.texture
      composite.uniforms.tBloom!.value = below.texture
      renderer.setRenderTarget(null)
      renderer.setViewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight)
      draw(composite, null)
      // It never stops moving
      map.triggerRepaint()
    },
    onRemove() {
      map = undefined
    },
    show(set) {
      const old = slots[front]!
      front = 1 - front
      const next = slots[front]!
      // The old set leaves (whatever was still leaving in the slot we're taking over is dropped)
      if (old.active) {
        old.leaving = true
        old.startedAt = -1
        setUniform(old, 'uLeaving', 1)
        setUniform(old, 'uGrow', 0)
      }
      next.prism.geometry.dispose()
      next.glow.geometry.dispose()
      next.prism.geometry = prismGeometry(set)
      next.glow.geometry = glowGeometry(set)
      setUniform(next, 'uEdge', set.edge)
      next.prism.visible = next.glow.visible = true
      next.leaving = false
      next.active = true
      next.startedAt = -1
      setUniform(next, 'uLeaving', 0)
      setUniform(next, 'uGrow', 0)
      map?.triggerRepaint()
    },
    setExtrude(v) {
      extrude.value = v
    },
    setFocus(lng, lat, radius) {
      const [x, y] = toFrame(lng, lat)
      focus.value.set(x, y, 0)
      focusR.value = Math.max(radius * scaleAt(lat), 1)
    },
    dispose() {
      for (const slot of slots) {
        slot.prism.geometry.dispose()
        slot.glow.geometry.dispose()
        slot.prism.material.dispose()
        slot.glow.material.dispose()
      }
      for (const m of [bright, down, up, composite]) m.dispose()
      triangle.dispose()
      for (const t of [sceneTarget, ...downs, ...ups]) t.dispose()
      renderer?.dispose()
      renderer = undefined
    },
  }
}
