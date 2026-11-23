// Flat geometry for Day 23's ground, in plan km (see HarvestLandMeshDesc.ts): slabs, flat covers,
// and cutting big faces finer before they're bent onto the globe.
import { BufferGeometry, Color, ExtrudeGeometry, Float32BufferAttribute, Shape, Vector2 } from 'three'
import type { Ring } from './harvestHeaps'

export function shapeOf(rings: Ring[]) {
  const shape = new Shape(rings[0]!.map(([x, y]) => new Vector2(x, y)))
  shape.holes = rings
    .slice(1)
    .filter((h) => h.length >= 3)
    .map((h) => new Shape(h.map(([x, y]) => new Vector2(x, y))))
  return shape
}

/** A flat slab of `rings`, top at `top` km, bevelled, in one colour */
export function slab(rings: Ring[], top: number, color: Color) {
  // The bevel adds its thickness above and below: the top lands at exactly `top`
  const bevel = Math.min(top * 0.25, 1)
  const g = new ExtrudeGeometry(shapeOf(rings), { depth: top - 2 * bevel, bevelEnabled: true, bevelThickness: bevel, bevelSize: 0.6, bevelSegments: 2, curveSegments: 1 })
  g.translate(0, 0, bevel)
  return painted(g, color) // (extruded geometry comes non-indexed)
}

export function painted(g: BufferGeometry, color: Color) {
  const n = g.getAttribute('position').count
  g.setAttribute('color', new Float32BufferAttribute(Array.from({ length: n * 3 }, (_, k) => [color.r, color.g, color.b][k % 3]!), 3))
  g.deleteAttribute('uv')
  g.deleteAttribute('normal')
  return g
}

/**
 * Cuts each triangle (non-indexed) in two across its longest edge, over and over, until no edge is
 * over `max` km in plan (halving the long edge, not quartering, so the long thin triangles a
 * coastline's triangulation makes don't multiply out of hand)
 */
export function subdivide(g: BufferGeometry, max: number) {
  const names = Object.keys(g.attributes)
  const attrs = names.map((n) => g.getAttribute(n))
  const sizes = attrs.map((a) => a.itemSize)
  const pos = names.indexOf('position')
  const out = names.map(() => [] as number[])
  type V = number[][] // per attribute, the vertex's values
  const vertex = (i: number): V => attrs.map((a, k) => Array.from({ length: sizes[k]! }, (_, c) => a.array[i * sizes[k]! + c]!))
  const mid = (a: V, b: V): V => a.map((x, k) => x.map((v, c) => (v + b[k]![c]!) / 2))
  const len = (a: V, b: V) => Math.hypot(a[pos]![0]! - b[pos]![0]!, a[pos]![1]! - b[pos]![1]!)
  for (let t = 0; t < attrs[pos]!.count / 3; t++) {
    const stack: V[][] = [[vertex(t * 3), vertex(t * 3 + 1), vertex(t * 3 + 2)]]
    while (stack.length) {
      const [a, b, c] = stack.pop()!
      const e = [len(a!, b!), len(b!, c!), len(c!, a!)]
      const k = e.indexOf(Math.max(...e))
      if (e[k]! <= max) {
        for (const v of [a!, b!, c!]) v.forEach((vals, i) => out[i]!.push(...vals))
        continue
      }
      // Rotate so the long edge is p-q, then split it at m
      const [p, q, r] = k === 0 ? [a!, b!, c!] : k === 1 ? [b!, c!, a!] : [c!, a!, b!]
      const m = mid(p, q)
      stack.push([p, m, r], [m, q, r])
    }
  }
  const r = new BufferGeometry()
  names.forEach((n, i) => r.setAttribute(n, new Float32BufferAttribute(out[i]!, sizes[i]!)))
  return r
}

