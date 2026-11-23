// Heaps of fruit for Day 23: where each piece comes to rest, and when it drops.
//
// Pieces are dropped one at a time round each prefecture's heap point (onto its land) and settle
// the way balls in a bin do: a piece at (x, y) rests where it first touches the board, the table
// round it, or a piece already there (each piece as the few balls that fill its shape). Of a few spots near the heap point it takes the lowest,
// then rolls downhill while there's a clearly lower spot a step away, so a heap's sides settle
// at a slope. Each heap keeps to its own prefecture (so neighbours' heaps stay apart); one too
// big for its land spills over the coast onto the table. Plan coordinates are km (x east, y north); heights are above the board's top.
import type { FruitKey } from './harvestFruits'

export type Placement = {
  key: FruitKey
  x: number
  y: number
  /** Height of the centre above the board */
  h: number
  scale: number
  /** Turn about the vertical (radians, as three.js turns about +y) */
  yaw: number
  /** Tilt off upright: axis angle in plan, and how far */
  tiltDir: number
  tilt: number
  /** When it drops (s from the start), lowest first */
  delay: number
  pref: number
}

export type Ring = [number, number][]
export type PrefShape = { heap: [number, number]; polygons: Ring[][] }

/** Deterministic random numbers (mulberry32) */
export function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function inRing(x: number, y: number, ring: Ring) {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!
    const [xj, yj] = ring[j]!
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

export type Land = { box: [number, number, number, number]; rings: Ring[]; pref: number }[]

export function landOf(prefs: PrefShape[]): Land {
  return prefs.flatMap((p, pref) =>
    p.polygons.map((rings) => {
      const xs = rings[0]!.map((q) => q[0])
      const ys = rings[0]!.map((q) => q[1])
      return { box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] as [number, number, number, number], rings, pref }
    }),
  )
}

/** The prefecture whose land (x, y) is on, or -1 off the land */
export function prefAt(land: Land, x: number, y: number) {
  const hit = land.find(
    ({ box: [x0, y0, x1, y1], rings }) =>
      x >= x0 && x <= x1 && y >= y0 && y <= y1 && inRing(x, y, rings[0]!) && !rings.slice(1).some((h) => inRing(x, y, h)),
  )
  return hit ? hit.pref : -1
}

// How much lower (in radii of its biggest ball) a step must go for a piece to keep rolling: the
// heap's slope
const ROLL = 0.7

type Part = [number, number, number, number]

type HeapOptions = {
  /** Size of a piece: km per model unit */
  size: number
  /** Each kind's shape, as balls (see Fruit.parts) */
  parts: Record<FruitKey, Part[]>
  /** The board's thickness: how far below its top the table is (km) */
  board: number
  seed?: number
}

type Ball = { x: number; y: number; h: number; r: number }

/**
 * Heaps for every prefecture. `counts[i]` is how many of each kind go on prefecture i; a
 * prefecture's kinds are mixed through its heap.
 *
 * Each piece stacks as the few balls that fill its shape, turned with it (a persimmon lies flat
 * and wide, a sweet potato long), so pieces neither sink into each other nor hang in the air.
 */
export function buildHeaps(prefs: PrefShape[], land: Land, counts: Partial<Record<FruitKey, number>>[], o: HeapOptions): Placement[] {
  const rand = rng(o.seed ?? 23)
  const out: Placement[] = []
  // Spatial hash of the balls placed so far, for the ones a new piece can rest on
  const balls: Ball[] = []
  const cell = 2.4 * o.size
  const grid = new Map<string, number[]>()
  const keyOf = (x: number, y: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand())

  /** A piece's balls in plan (offsets east/north, height offset, radius; km), turned by `yaw` */
  const shape = (key: FruitKey, scale: number, yaw: number) => {
    const [c, s] = [Math.cos(yaw), Math.sin(yaw)]
    const k = o.size * scale
    // Model x east, z south; turning by yaw about the vertical as three.js does
    return o.parts[key].map(([x, y, z, r]) => ({ dx: (x * c + z * s) * k, dy: -(-x * s + z * c) * k, dh: y * k, r: r * k }))
  }
  type Shape = ReturnType<typeof shape>

  /** Height of the centre of a piece of `parts` dropped at (x, y): where its first ball touches */
  const restHeight = (x: number, y: number, parts: Shape) => {
    const floor = prefAt(land, x, y) >= 0 ? 0 : -o.board
    let h = -Infinity
    for (const p of parts) {
      const px = x + p.dx
      const py = y + p.dy
      h = Math.max(h, floor + p.r - p.dh)
      const cx = Math.floor(px / cell)
      const cy = Math.floor(py / cell)
      for (let i = -1; i <= 1; i++) {
        for (let j = -1; j <= 1; j++) {
          for (const b of grid.get(`${cx + i},${cy + j}`) ?? []) {
            const q = balls[b]!
            const d2 = (q.x - px) ** 2 + (q.y - py) ** 2
            const reach = (q.r + p.r) ** 2
            if (d2 < reach) h = Math.max(h, q.h + Math.sqrt(reach - d2) - p.dh)
          }
        }
      }
    }
    return h
  }

  prefs.forEach((pref, pi) => {
    const kinds = Object.entries(counts[pi] ?? {}).flatMap(([k, n]) => Array<FruitKey>(n ?? 0).fill(k as FruitKey))
    if (kinds.length === 0) return
    for (let i = kinds.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1))
      ;[kinds[i], kinds[j]] = [kinds[j]!, kinds[i]!]
    }
    // Spread: the footprint of a mound of this many pieces
    const spread = o.size * 0.4 * Math.cbrt(kinds.length)
    const start = out.length
    for (const key of kinds) {
      const scale = 0.9 + 0.2 * rand()
      const yaw = rand() * Math.PI * 2
      const parts = shape(key, scale, yaw)
      const r = Math.max(...parts.map((p) => p.r))
      let best: { x: number; y: number; h: number } | undefined
      for (let tries = 0, found = 0; found < 3 && tries < 40; tries++) {
        const x = pref.heap[0] + gauss() * spread
        const y = pref.heap[1] + gauss() * spread
        if (tries < 30 && prefAt(land, x, y) !== pi) continue
        found++
        const h = restHeight(x, y, parts)
        if (!best || h < best.h) best = { x, y, h }
      }
      if (!best) best = { x: pref.heap[0], y: pref.heap[1], h: restHeight(pref.heap[0], pref.heap[1], parts) }
      // Then it rolls: a step at a time down the steepest way while that's clearly lower (big
      // steps, so it doesn't stop in every little hollow between the pieces), over its own
      // prefecture's land or off the coast, but not onto a neighbour's
      for (let step = 0; step < 30; step++) {
        let next: typeof best | undefined
        for (let k = 0; k < 8; k++) {
          const a = (k / 8) * Math.PI * 2 + rand() * 0.5
          const x = best.x + Math.cos(a) * r * 1.6
          const y = best.y + Math.sin(a) * r * 1.6
          const at = prefAt(land, x, y)
          if (at !== pi && at !== -1) continue // never onto a neighbour's land
          const h = restHeight(x, y, parts)
          if (h < (next?.h ?? best.h - r * ROLL)) next = { x, y, h }
        }
        if (!next) break
        best = next
      }
      out.push({
        key,
        ...best,
        scale,
        yaw,
        tiltDir: rand() * Math.PI * 2,
        // Only a slight lean: the balls it stacks with don't lean with it
        tilt: 0.12 * rand(),
        delay: 0,
        pref: pi,
      })
      for (const p of parts) {
        const b = { x: best.x + p.dx, y: best.y + p.dy, h: best.h + p.dh, r: p.r }
        const g = keyOf(b.x, b.y)
        grid.set(g, [...(grid.get(g) ?? []), balls.push(b) - 1])
      }
    }
    // Drop order: from the bottom up, the bigger heaps given longer to fill
    const mine = out.slice(start).sort((a, b) => a.h - b.h)
    const span = 0.5 + 1.6 * Math.sqrt(mine.length / 400)
    const offset = 0.25 * rand()
    mine.forEach((p, i) => (p.delay = offset + (i / mine.length) * span + 0.05 * rand()))
  })
  return out
}
