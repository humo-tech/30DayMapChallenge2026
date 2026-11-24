// Day 25's wooden toy of Komazawa Olympic Park: the shapes. A board of light wood cut to the
// park's outline, painted pieces set into it (lawns, pitches, the stadium and its track, the
// courses), blocks for the buildings, the Olympic tower stacked from discs, lollipop trees and
// peg dolls. Everything is built in metres on the park's plane: x east, y up, z south (three's
// usual frame); ToyParkMeshDesc turns it into Navara's West-Up-North.
import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  ConeGeometry,
  CylinderGeometry,
  ExtrudeGeometry,
  IcosahedronGeometry,
  Path,
  RepeatWrapping,
  Shape,
  SphereGeometry,
  SRGBColorSpace,
  type Texture,
} from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'

export type Ring = [number, number][]
export type Poly = Ring[]
export type TreeKind = 'cherry' | 'zelkova' | 'maple' | 'evergreen' | 'ginkgo'
export type ParkData = {
  center: [number, number]
  park: Poly
  areas: { kind: string; sport?: string; name?: string; rings: Poly }[]
  buildings: { kind: 'tower' | 'gym' | 'arena' | 'roof' | 'house'; name: string; h: number; ring: Ring }[]
  surfaces: Record<'walk' | 'family' | 'cycle' | 'jog', Poly[]>
  lines: Poly[]
  stadium: { center: [number, number]; angle: number; track: [number, number, number]; stands: Poly[] }
  loops: { jog: Ring; cycle: Ring; family: Ring }
  trees: [number, number, TreeKind, number][]
}

/** The board's thickness (m): everything else stands on its top */
export const BOARD = 12

/** Painted wood: each piece's colour, set into the board (heights above its top, m) */
export const PAINT: Record<string, { color: string; h: number }> = {
  lawn: { color: '#8cc063', h: 0.7 },
  wood: { color: '#5f9e4c', h: 0.7 },
  bird_hide: { color: '#5f9e4c', h: 0.7 },
  garden: { color: '#f2a5bf', h: 1.2 },
  plaza: { color: '#efe3c8', h: 0.5 },
  stairs: { color: '#e2d2b0', h: 1.4 },
  parking: { color: '#c9c2b4', h: 0.5 },
  playground: { color: '#f4c55a', h: 0.9 },
  dog_park: { color: '#c7b3e6', h: 0.9 },
  cycletrack: { color: '#f19a5b', h: 0.9 },
  pool: { color: '#5bc2e6', h: 0.4 },
  swimming_pool: { color: '#5bc2e6', h: 0.4 },
  pitch: { color: '#58a84e', h: 1.1 },
  tennis: { color: '#3f9a8c', h: 1.1 },
  baseball: { color: '#5aa64a', h: 1.1 },
  skateboard: { color: '#b9b4c4', h: 1.1 },
  archery: { color: '#7cba5e', h: 1.1 },
  gateball: { color: '#c9a56a', h: 1.1 },
  walk: { color: '#f6ead0', h: 1.0 },
  family: { color: '#f2a0c8', h: 1.15 },
  cycle: { color: '#6f98d8', h: 1.25 },
  jog: { color: '#d9774e', h: 1.35 },
  track: { color: '#cf5a3e', h: 1.3 },
  field: { color: '#4f9f45', h: 1.45 },
  stands: { color: '#d8c7a6', h: 7 },
}

/** Wood grain drawn on a canvas, `light` for the painted pieces (a faint grain under the paint) */
export function grainTexture(light: boolean): Texture {
  const W = 512
  const H = 512
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const g = c.getContext('2d')!
  g.fillStyle = light ? '#ffffff' : '#e2bd86'
  g.fillRect(0, 0, W, H)
  // Rings: wavy stripes along x, darker and lighter, with a knot or two
  let seed = light ? 7 : 3
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  for (let i = 0; i < 90; i++) {
    const y0 = rnd() * H
    const amp = 2 + rnd() * 6
    const freq = (1 + Math.floor(rnd() * 3)) * ((2 * Math.PI) / W)
    const ph = rnd() * 6.28
    const dark = rnd() < 0.6
    g.strokeStyle = light
      ? `rgba(120, 90, 60, ${0.03 + rnd() * 0.05})`
      : dark
        ? `rgba(150, 95, 45, ${0.12 + rnd() * 0.22})`
        : `rgba(255, 235, 200, ${0.1 + rnd() * 0.2})`
    g.lineWidth = 0.6 + rnd() * (light ? 2 : 3.5)
    g.beginPath()
    for (let x = -4; x <= W + 4; x += 4) {
      const y = y0 + amp * Math.sin(x * freq + ph) + 1.5 * Math.sin(x * freq * 5 + ph * 2)
      if (x === -4) g.moveTo(x, y)
      else g.lineTo(x, y)
    }
    g.stroke()
    // Tile seamlessly in y
    if (y0 < 12 || y0 > H - 12) {
      g.save()
      g.translate(0, y0 < 12 ? H : -H)
      g.stroke()
      g.restore()
    }
  }
  const t = new CanvasTexture(c)
  t.wrapS = t.wrapT = RepeatWrapping
  t.colorSpace = SRGBColorSpace
  t.anisotropy = 8
  return t
}

function shapeOf(rings: Poly): Shape {
  const s = new Shape(rings[0]!.map(([x, y]) => ({ x, y }) as never))
  for (const h of rings.slice(1)) s.holes.push(new Path(h.map(([x, y]) => ({ x, y }) as never)))
  return s
}

/** Fills a geometry's colour attribute with one colour */
export function painted(g: BufferGeometry, color: Color | string): BufferGeometry {
  const c = new Color(color)
  const n = g.getAttribute('position').count
  const a = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) c.toArray(a, i * 3)
  g.setAttribute('color', new BufferAttribute(a, 3))
  return g
}

/** A plan polygon as a slab from `bottom` to `top` (m), its upper edge rounded by `bevel` */
export function slab(rings: Poly, bottom: number, top: number, bevel = 0.3, curveSegments = 2): BufferGeometry {
  const b = Math.min(bevel, (top - bottom) / 2.5)
  const g = new ExtrudeGeometry(shapeOf(rings), {
    depth: Math.max(0.01, top - bottom - 2 * b),
    bevelEnabled: b > 0,
    bevelThickness: b,
    bevelSize: b,
    bevelOffset: -b,
    bevelSegments: 2,
    curveSegments,
  })
  // Extruded along +z with the bevel past both ends (-b .. depth + b): lay it down (plan y north →
  // -z) and lift it
  g.rotateX(-Math.PI / 2)
  g.translate(0, bottom + b, 0)
  return clean(g)
}

/** ExtrudeGeometry's attributes trimmed to what mergeGeometries can join */
function clean(g: BufferGeometry): BufferGeometry {
  const out = g.index ? g.toNonIndexed() : g
  for (const k of Object.keys(out.attributes)) if (!['position', 'normal', 'uv'].includes(k)) out.deleteAttribute(k)
  out.clearGroups()
  return out
}

/** A 400 m track's oval (straights along x), `r` from the middle of the bends */
export function oval(straight: number, r: number, segments = 24): Ring {
  const pts: Ring = []
  for (let i = 0; i <= segments; i++) {
    const t = -Math.PI / 2 + (Math.PI * i) / segments
    pts.push([straight / 2 + r * Math.cos(t), r * Math.sin(t)])
  }
  for (let i = 0; i <= segments; i++) {
    const t = Math.PI / 2 + (Math.PI * i) / segments
    pts.push([-straight / 2 + r * Math.cos(t), r * Math.sin(t)])
  }
  return pts
}

function place(ring: Ring, cx: number, cy: number, angle: number): Ring {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  return ring.map(([x, y]) => [cx + x * c - y * s, cy + x * s + y * c])
}

/**
 * The stadium: a track of eight lanes with white lines round the field, and the stands. Returns
 * the painted slabs (vertex coloured) and the lines
 */
export function stadiumGeometry(st: ParkData['stadium']): { paint: BufferGeometry[]; lines: BufferGeometry[] } {
  const [straight, r, lanes] = st.track
  const [cx, cy] = st.center
  const at = (ring: Ring) => place(ring, cx, cy, st.angle)
  const top = BOARD
  const paint = [
    painted(slab([at(oval(straight, r + lanes)), at(oval(straight, r)).reverse()], top, top + PAINT.track!.h), PAINT.track!.color),
    painted(slab([at(oval(straight, r))], top, top + PAINT.field!.h), PAINT.field!.color),
  ]
  const lines: BufferGeometry[] = []
  // Every other lane's line: all nine shimmer from afar
  for (let i = 0; i <= 8; i += 2) {
    const rr = r + (lanes * i) / 8
    lines.push(band(at(oval(straight, rr + 0.2, 48)), at(oval(straight, rr - 0.2, 48)), top + PAINT.track!.h + 0.05))
  }
  // The stands, in two tiers
  for (const p of st.stands) {
    paint.push(painted(slab(p, top, top + PAINT.stands!.h * 0.55, 0.6), '#e4d5b5'))
  }
  return { paint, lines }
}

/** A flat band between two rings of the same length, at height `y` (facing up) */
function band(outer: Ring, inner: Ring, y: number): BufferGeometry {
  const n = outer.length
  const pos = new Float32Array(n * 2 * 3)
  for (let i = 0; i < n; i++) {
    pos.set([outer[i]![0], y, -outer[i]![1]], i * 6)
    pos.set([inner[i]![0], y, -inner[i]![1]], i * 6 + 3)
  }
  const index: number[] = []
  for (let i = 0; i < n - 1; i++) {
    const a = i * 2
    // Anticlockwise rings: outer, inner, next outer faces up
    index.push(a, a + 2, a + 1, a + 1, a + 2, a + 3)
  }
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(pos, 3))
  g.setAttribute('normal', new BufferAttribute(new Float32Array(n * 2 * 3).map((_, k) => (k % 3 === 1 ? 1 : 0)), 3))
  g.setAttribute('uv', new BufferAttribute(new Float32Array(n * 2 * 2), 2))
  g.setIndex(index)
  return g.toNonIndexed()
}

/** A building as a painted wooden block (pastel walls, a darker top) */
export function buildingGeometry(b: ParkData['buildings'][number], i: number): BufferGeometry[] {
  const top = BOARD
  const wall = ['#f3e6cf', '#d9ecf2', '#f6d6c2', '#e1efd6', '#efe0f0'][i % 5]!
  const roofs = ['#c8644a', '#4f7fb5', '#5b9a6a', '#c79a3e', '#8a6aa8']
  if (b.kind === 'tower') return []
  if (b.kind === 'gym') {
    // The gymnasium: an octagon with a tall, pointed roof (its own is like a turtle's shell)
    const [cx, cy, rad] = circleOf(b.ring)
    // (tall, so it stands out of the trees round it)
    const walls = new CylinderGeometry(rad * 0.98, rad, 18, 8, 1).rotateY(Math.PI / 8).translate(cx, top + 9, -cy)
    const roof = new ConeGeometry(rad * 1.08, 26, 8, 1).rotateY(Math.PI / 8).translate(cx, top + 18 + 13, -cy)
    const cap = new SphereGeometry(3.2, 12, 8).translate(cx, top + 44.5, -cy)
    return [painted(clean(walls), '#f4ead6'), painted(clean(roof), '#4e9a8a'), painted(clean(cap), '#e8b84a')]
  }
  if (b.kind === 'arena') {
    const block = painted(slab([b.ring], top, top + 9, 1.2), '#eae0f2')
    const roof = painted(slab([shrink(b.ring, 0.92)], top + 9, top + 12.5, 1.4, 4), '#8a6aa8')
    return [block, roof]
  }
  const h = b.kind === 'roof' ? 7 : b.h * 1.2
  return [painted(slab([b.ring], top, top + h, 0.6), wall), painted(slab([shrink(b.ring, 0.96)], top + h, top + h + 1.6, 0.5), roofs[i % roofs.length]!)]
}

/**
 * The Olympic Memorial Tower as a stacking toy: a tall wooden post with five discs round it in
 * the colours of the Olympic rings, a ball on top
 */
export function towerGeometry(ring: Ring): BufferGeometry[] {
  const [cx, cy] = circleOf(ring)
  // Twice its height and more, so it stands up over the trees and the children
  const k = 2
  const H = 46
  const parts: BufferGeometry[] = []
  const add = (geo: BufferGeometry, color: string) => parts.push(painted(clean(geo).scale(k, k, k).translate(cx, BOARD, -cy), color))
  add(new CylinderGeometry(2.6, 3.4, H, 16).translate(0, H / 2, 0), '#e9d2a8')
  const colours = ['#0081c8', '#fcb131', '#2b2b2b', '#00a651', '#ee334e']
  for (let i = 0; i < 5; i++) add(new CylinderGeometry(7.5 - i * 0.6, 7.9 - i * 0.6, 2.2, 28).translate(0, 10 + i * 7.2, 0), colours[i]!)
  add(new SphereGeometry(3.4, 16, 12).translate(0, H + 2.5, 0), '#f2c94c')
  // A round base
  add(new CylinderGeometry(9, 10, 2.5, 28).translate(0, 1.25, 0), '#d9c3a0')
  return parts
}

/** The middle of a ring and roughly how far its edge is */
function circleOf(ring: Ring): [number, number, number] {
  let x = 0
  let y = 0
  const n = ring.length - 1
  for (let i = 0; i < n; i++) {
    x += ring[i]![0]
    y += ring[i]![1]
  }
  x /= n
  y /= n
  let r = 0
  for (const [px, py] of ring) r += Math.hypot(px - x, py - y)
  return [x, y, r / ring.length]
}

function shrink(ring: Ring, k: number): Ring {
  const [cx, cy] = circleOf(ring)
  return ring.map(([x, y]) => [cx + (x - cx) * k, cy + (y - cy) * k])
}

/** Tree crowns by kind (unit size: ~1 m across), and their trunks */
export function treeGeometries() {
  const round = clean(new IcosahedronGeometry(1, 2))
  const cone = clean(new ConeGeometry(1, 2.4, 10, 1).translate(0, 0.9, 0))
  const ginkgo = clean(new SphereGeometry(1, 14, 10).scale(0.8, 1.35, 0.8))
  const trunk = clean(new CylinderGeometry(0.11, 0.15, 1, 8).translate(0, 0.5, 0))
  return { round, cone, ginkgo, trunk }
}

/** Crown shape, size (m across) and height of the crown's middle above the ground, by kind */
export const TREE_FORM: Record<TreeKind, { shape: 'round' | 'cone' | 'ginkgo'; r: number; trunk: number }> = {
  zelkova: { shape: 'round', r: 7.5, trunk: 8 },
  maple: { shape: 'round', r: 5.5, trunk: 6 },
  cherry: { shape: 'round', r: 6.5, trunk: 6 },
  evergreen: { shape: 'cone', r: 5.5, trunk: 4 },
  ginkgo: { shape: 'ginkgo', r: 5, trunk: 7 },
}

/** A peg doll: a rounded body (white, tinted per instance) and a head */
export function pegDoll(): { body: BufferGeometry; head: BufferGeometry } {
  const body = clean(new CylinderGeometry(1.6, 2.4, 6.6, 14).translate(0, 3.3, 0))
  const head = clean(new SphereGeometry(2.1, 14, 10).translate(0, 8.6, 0))
  return { body, head }
}

/** A bicycle under a peg doll: two wheels and a bar, along x */
export function bicycle(): BufferGeometry {
  const wheel = (x: number) => clean(new CylinderGeometry(2.2, 2.2, 0.7, 16).rotateX(Math.PI / 2).translate(x, 2.2, 0))
  const bar = clean(new RoundedBoxGeometry(5.4, 0.9, 0.7, 2, 0.3).translate(0, 3.8, 0))
  return mergeGeometries([wheel(-2.7), wheel(2.7), bar])!
}

/** A wooden dog: body, head and tail, along x */
export function dog(): BufferGeometry {
  const body = clean(new RoundedBoxGeometry(3.4, 1.6, 1.4, 2, 0.5).translate(0, 2.0, 0))
  const head = clean(new RoundedBoxGeometry(1.5, 1.4, 1.2, 2, 0.45).translate(2.0, 3.0, 0))
  const legs = [-1.1, 1.1].flatMap((x) => [-0.45, 0.45].map((z) => clean(new CylinderGeometry(0.3, 0.3, 1.3, 8).translate(x, 0.65, z))))
  const tail = clean(new CylinderGeometry(0.18, 0.25, 1.4, 8).rotateZ(-0.9).translate(-2.1, 2.9, 0))
  return mergeGeometries([body, head, tail, ...legs])!
}

/** Whether (x, y) is inside `ring` */
export function pointInRing(ring: Ring, x: number, y: number): boolean {
  let c = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!
    const [xj, yj] = ring[j]!
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c
  }
  return c
}

/** How far (x, y) is from the nearest edge of `ring` */
export function distToRing(ring: Ring, x: number, y: number): number {
  let best = Infinity
  for (let i = 0; i < ring.length - 1; i++) {
    const [ax, ay] = ring[i]!
    const [bx, by] = ring[i + 1]!
    const vx = bx - ax
    const vy = by - ay
    const t = Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / (vx * vx + vy * vy || 1)))
    best = Math.min(best, Math.hypot(x - ax - vx * t, y - ay - vy * t))
  }
  return best
}

/** The box round a ring: x0, y0, x1, y1 */
export function ringBounds(ring: Ring): [number, number, number, number] {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const [x, y] of ring) {
    x0 = Math.min(x0, x)
    y0 = Math.min(y0, y)
    x1 = Math.max(x1, x)
    y1 = Math.max(y1, y)
  }
  return [x0, y0, x1, y1]
}

/** A seeded random number generator (0-1) */
export function seeded(seed: number): () => number {
  let s = seed
  return () => (s = (s * 16807) % 2147483647) / 2147483647
}

export { mergeGeometries }
