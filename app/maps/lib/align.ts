// Day 22's Align mode: fitting the freehand projection to a designer's map, half by hand.
// A few ties clicked per frame give a rough fit (affine below six ties); the automatic fit then
// matches the art's outlines to the real borders (iterative closest point): every few px along
// the art's paths, the nearest real border as the current fit draws it becomes a tie, the fit is
// redone with them, and again with a tighter reach, five times over.
import { FreehandProjection, inRing, inRings, type FrameData, type MapData, type Ring, type Tie, type XY } from './freehand'

export type AlignTie = { art: XY; ll: [number, number]; auto?: boolean }
export type AlignFrame = { name: string; boxPx?: [number, number, number, number]; domain?: [number, number][] }
export type Base = Pick<FrameData, 'base' | 'lng0' | 'wrap'>

// Smoothing: hand ties are a few px out, the automatic ones more so
export const LAMBDA_HAND = 1e-2
export const LAMBDA_AUTO = 3e-3

const inBox = (p: XY, b?: [number, number, number, number]) =>
  !!b && p[0] >= b[0] && p[0] <= b[0] + b[2] && p[1] >= b[1] && p[1] <= b[1] + b[3]

/** Which frame a point of the art belongs to: the box it's in, else the main frame (0) */
export function artFrame(frames: AlignFrame[], p: XY): number {
  const i = frames.findIndex((f) => inBox(p, f.boxPx))
  return i >= 0 ? i : 0
}

/**
 * A part moved on its own may straddle the world map's cut (Greenland at 30°W): its longitudes
 * then run on round the cut rather than jumping to the other edge
 */
function unwrapped(base: Base, domain?: [number, number][]): Partial<FrameData> {
  if (base.base !== 'naturalEarth' || !domain?.length) return {}
  const lng0 = base.lng0 ?? 0
  const c = domain.reduce((a, p) => a + p[0], 0) / domain.length
  const lam = ((((c - lng0 + 180) % 360) + 360) % 360) - 180
  return { wrap: false, shift: lam - (c - lng0) }
}

/** The ties as FreehandProjection's frames: insets first (their domains decide), the main frame last */
export function toMapData(frames: AlignFrame[], ties: AlignTie[], base: Base, width: number, height: number, lambda?: number): MapData {
  const order = [...frames.keys()].filter((i) => i > 0).concat(0)
  const out: FrameData[] = order.map((i) => {
    const f = frames[i]!
    const own = ties.filter((t) => artFrame(frames, t.art) === i)
    const auto = own.some((t) => t.auto)
    return {
      name: f.name,
      ...base,
      ...(i > 0 ? { domain: f.domain, boxPx: f.boxPx, ...unwrapped(base, f.domain) } : {}),
      fit: own.length < 6 ? 'affine' : 'tps',
      lambda: lambda ?? (auto ? LAMBDA_AUTO : LAMBDA_HAND),
      ties: own.map((t) => [t.ll[0], t.ll[1], t.art[0], t.art[1]] as Tie),
    }
  })
  return { width, height, lambda: LAMBDA_HAND, frames: out, quantum: 1, regions: [], pins: [] }
}

/** Points every `step` along polylines */
export function resample(lines: XY[][], step: number): XY[] {
  const out: XY[] = []
  for (const l of lines) {
    let carry = 0
    for (let i = 1; i < l.length; i++) {
      const [ax, ay] = l[i - 1]!
      const [bx, by] = l[i]!
      const d = Math.hypot(bx - ax, by - ay)
      let t = carry
      while (t < d) {
        out.push([ax + ((bx - ax) * t) / d, ay + ((by - ay) * t) / d])
        t += step
      }
      carry = t - d
    }
  }
  return out
}

/** Real border points no further apart than `step` degrees */
export function densify(rings: Ring[], step: number): XY[] {
  const out: XY[] = []
  for (const r of rings) {
    for (let i = 0; i < r.length; i++) {
      const a = r[i]!
      const b = r[(i + 1) % r.length]!
      const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step))
      for (let k = 0; k < n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n])
    }
  }
  return out
}

class Grid {
  private readonly cells = new Map<number, number[]>()
  constructor(
    private readonly pts: XY[],
    private readonly size: number,
  ) {
    pts.forEach((p, i) => {
      const k = this.key(Math.floor(p[0] / size), Math.floor(p[1] / size))
      const c = this.cells.get(k)
      if (c) c.push(i)
      else this.cells.set(k, [i])
    })
  }
  private key(cx: number, cy: number) {
    return (cx + 32768) * 65536 + (cy + 32768)
  }
  nearest(p: XY, reach: number): { i: number; d: number } | null {
    const cx = Math.floor(p[0] / this.size)
    const cy = Math.floor(p[1] / this.size)
    const n = Math.ceil(reach / this.size)
    let best: { i: number; d: number } | null = null
    for (let dx = -n; dx <= n; dx++) {
      for (let dy = -n; dy <= n; dy++) {
        for (const i of this.cells.get(this.key(cx + dx, cy + dy)) ?? []) {
          const q = this.pts[i]!
          const d = Math.hypot(q[0] - p[0], q[1] - p[1])
          if (d <= reach && (!best || d < best.d)) best = { i, d }
        }
      }
    }
    return best
  }
}

export type RealRegion = { id: string; rings: Ring[] } // lng / lat

export type AutoFitInput = {
  frames: AlignFrame[]
  hand: AlignTie[]
  base: Base
  width: number
  height: number
  shapes: XY[][][] // the art's paths, each with its subpaths
  regions: RealRegion[] // the real lines worth matching (see matchable)
  nodeEps: number // degrees: how close two regions' rings run along a shared border
  onProgress?: (step: number, of: number) => void
}

export type AutoFitResult = { ties: AlignTie[]; median: number; identified: number; nodes: number; shapeRegions: string[] }

// Coarse to fine: a long reach and a stiff fit first (only the broad bends), then shorter and looser.
// Art units at ART_SIZE 1600.
const REACH = [40, 32, 25, 20, 16, 12, 9, 7, 5]
const LAMBDA_FROM = 0.3
const SPACING = 24
const STEP = 3

type ArtShape = { rings: XY[][]; edge: XY[]; inside: XY[]; frame: number }

function boxOf(rings: XY[][]): [number, number, number, number] {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const r of rings) {
    for (const [x, y] of r) {
      x0 = Math.min(x0, x)
      y0 = Math.min(y0, y)
      x1 = Math.max(x1, x)
      y1 = Math.max(y1, y)
    }
  }
  return [x0, y0, x1, y1]
}

/** Points inside, on a grid of about 8 x 8 over the rings' box (a line, or a speck, has none) */
function insidePoints(rings: XY[][], box: readonly [number, number, number, number], unit: number): XY[] {
  const [x0, y0, x1, y1] = box
  const g = Math.max(1.5 * unit, Math.max(x1 - x0, y1 - y0) / 8)
  const out: XY[] = []
  for (let x = x0 + g / 2; x < x1; x += g) {
    for (let y = y0 + g / 2; y < y1; y += g) if (inRings([x, y], rings)) out.push([x, y])
  }
  return out
}

function artShapes(shapes: XY[][][], frames: AlignFrame[], unit: number): ArtShape[] {
  return shapes.map((rings) => {
    const box = boxOf(rings)
    const inside = insidePoints(rings, box, unit)
    const mid: XY = inside[Math.floor(inside.length / 2)] ?? [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2]
    return { rings, edge: resample(rings, STEP * unit), inside, frame: artFrame(frames, mid) }
  })
}

/** Rings in lng / lat with points `step` degrees apart (thinned where finer, filled in where coarser) */
export function respace(rings: Ring[], step: number): Ring[] {
  return rings.map((r) => {
    const out: Ring = [r[0]!]
    for (let i = 1; i <= r.length; i++) {
      const p = r[i % r.length]!
      const last = out[out.length - 1]!
      const d = Math.hypot(p[0] - last[0], p[1] - last[1])
      if (d < step) continue
      const n = Math.ceil(d / step)
      for (let k = 1; k <= n; k++) out.push([last[0] + ((p[0] - last[0]) * k) / n, last[1] + ((p[1] - last[1]) * k) / n])
    }
    return out
  })
}

/** Art units per degree near the hand ties, to put real points about one art unit apart */
export function scaleOf(hand: AlignTie[]): number {
  const r: number[] = []
  for (let i = 0; i < hand.length; i++) {
    for (let j = i + 1; j < hand.length; j++) {
      const a = hand[i]!
      const b = hand[j]!
      const dl = Math.hypot(a.ll[0] - b.ll[0], a.ll[1] - b.ll[1])
      if (dl > 0) r.push(Math.hypot(a.art[0] - b.art[0], a.art[1] - b.art[1]) / dl)
    }
  }
  r.sort((x, y) => x - y)
  return r[Math.floor(r.length / 2)] ?? 10
}

/**
 * The automatic fit. Each round: the real regions as the current fit draws them; each of the art's
 * shapes taken as the region covering most of it (so a border is only ever matched to its own
 * region's border, even a few lines out); then every few px along each shape's edge, the nearest
 * point of its region's real border becomes a tie. Art with no shapes to tell apart (strokes only)
 * is matched to the nearest real line of any region.
 */
export async function autoFit(input: AutoFitInput): Promise<AutoFitResult> {
  const { frames, hand, base, width, height } = input
  const unit = Math.max(width, height) / 1600
  const shapes = artShapes(input.shapes, frames, unit)
  const regions = input.regions.map((r) => ({ id: r.id, rings: respace(r.rings, (1.2 * unit) / scaleOf(hand)) }))
  // Where borders meet, on the globe (owners: regions) and on the art (owners: shapes)
  const realNodes = findNodes(
    input.regions.flatMap((r, i) => r.rings.map((ring) => ({ owner: i, ring }))),
    input.nodeEps,
  )
  const artNodes = findNodes(
    shapes.flatMap((sh, i) => (sh.inside.length ? sh.rings.map((ring) => ({ owner: i, ring })) : [])),
    1.5 * unit,
  )
  const nodeKey = (owners: number[], coast: boolean) => `${owners.join(',')}|${coast}`
  let auto: AlignTie[] = []
  let median = 0
  let identified = 0
  let nodeCount = 0
  let shapeRegions: string[] = []

  for (let it = 0; it < REACH.length; it++) {
    input.onProgress?.(it + 1, REACH.length)
    await new Promise((r) => setTimeout(r, 0)) // let the page draw the progress
    const reach = REACH[it]! * unit
    const lambda = auto.length ? LAMBDA_FROM * (LAMBDA_AUTO / LAMBDA_FROM) ** (it / (REACH.length - 1)) : undefined
    const proj = new FreehandProjection(toMapData(frames, [...hand, ...auto], base, width, height, lambda))
    const frameIndex = proj.frames.map((f) => frames.findIndex((g) => g.name === f.name))

    // The real regions where the fit puts them (for telling shapes apart, only rings it places whole)
    const placed = regions.map((r) => {
      const rings: XY[][] = []
      const pts: XY[] = []
      const lls: XY[] = []
      const frame: number[] = []
      let x0 = Infinity
      let y0 = Infinity
      let x1 = -Infinity
      let y1 = -Infinity
      for (const ring of r.rings) {
        const out: XY[] = []
        const outLl: XY[] = []
        const outFrame: number[] = []
        for (const ll of ring) {
          const fi = proj.frameOf(ll[0], ll[1])
          if (fi < 0 || !proj.fitted(fi)) continue
          const xy = proj.project(ll[0], ll[1], fi)!
          out.push(xy)
          outLl.push(ll)
          outFrame.push(frameIndex[fi]!)
          x0 = Math.min(x0, xy[0])
          y0 = Math.min(y0, xy[1])
          x1 = Math.max(x1, xy[0])
          y1 = Math.max(y1, xy[1])
        }
        pts.push(...out)
        lls.push(...outLl)
        frame.push(...outFrame)
        if (out.length === ring.length) rings.push(out)
      }
      return { rings, pts, lls, frame, box: [x0, y0, x1, y1] as const, grid: undefined as Grid | undefined }
    })
    const gridOf = (i: number) => (placed[i]!.grid ??= new Grid(placed[i]!.pts, reach))

    // Which region each shape is: how much of the shape lies in the region, plus how much of the
    // region lies in the shape (so a shape drawn twice the size of its region still counts as it)
    const regionInside = placed.map((r) => insidePoints(r.rings, r.box, unit))
    const shapeBoxes = shapes.map((sh) => boxOf(sh.rings))
    const scores: { s: number; r: number; score: number }[] = []
    shapes.forEach((sh, si) => {
      if (!sh.inside.length) return
      placed.forEach((r, i) => {
        const [x0, y0, x1, y1] = r.box
        const [sx0, sy0, sx1, sy1] = shapeBoxes[si]!
        if (sx1 < x0 || sx0 > x1 || sy1 < y0 || sy0 > y1 || !regionInside[i]!.length) return
        const a = sh.inside.filter((p) => inRings(p, r.rings)).length / sh.inside.length
        if (!a) return
        const b = regionInside[i]!.filter((p) => inRings(p, sh.rings)).length / regionInside[i]!.length
        if (a + b >= 0.6) scores.push({ s: si, r: i, score: a + b })
      })
    })
    // Best pairs first, one shape per region, except islands (a shape much smaller than the one
    // the region already has) may share it
    scores.sort((x, y) => y.score - x.score)
    const regionOf = shapes.map(() => -1)
    const mainOf = new Map<number, number>() // region -> its first (largest-scoring) shape
    const sizeOf = (si: number) => {
      const [x0, y0, x1, y1] = shapeBoxes[si]!
      return (x1 - x0) * (y1 - y0)
    }
    for (const { s: si, r } of scores) {
      if (regionOf[si]! >= 0) continue
      const main = mainOf.get(r)
      if (main !== undefined && sizeOf(si) > 0.25 * sizeOf(main)) continue
      regionOf[si] = r
      if (main === undefined) mainOf.set(r, si)
    }
    identified = regionOf.filter((r) => r >= 0).length
    shapeRegions = regionOf.map((r) => (r >= 0 ? regions[r]!.id : ''))

    // Junctions: an art junction of regions {A, B, C} (or A, B and the sea) is tied to the real one
    // of the same regions, the nearest if there are several. No sliding along a border here.
    const realByKey = new Map<string, { xy: XY; ll: XY }[]>()
    for (const n of realNodes) {
      const fi = proj.frameOf(n.p[0], n.p[1])
      if (fi < 0 || !proj.fitted(fi)) continue
      const k = nodeKey(n.owners, n.coast)
      const list = realByKey.get(k) ?? []
      list.push({ xy: proj.project(n.p[0], n.p[1], fi)!, ll: n.p })
      realByKey.set(k, list)
    }
    const nodeTies: AlignTie[] = []
    const nodeReach = 2.5 * reach
    for (const n of artNodes) {
      const owners = [...new Set(n.owners.map((o) => regionOf[o]!))].sort((a, b) => a - b)
      if (owners.length < 2 || owners[0]! < 0 || owners.length !== n.owners.length) continue
      let best: { ll: XY; d: number } | undefined
      for (const c of realByKey.get(nodeKey(owners, n.coast)) ?? []) {
        const d = Math.hypot(c.xy[0] - n.p[0], c.xy[1] - n.p[1])
        if (d < nodeReach && (!best || d < best.d)) best = { ll: c.ll, d }
      }
      if (best && !hand.some((h) => Math.hypot(h.art[0] - n.p[0], h.art[1] - n.p[1]) < SPACING * unit)) {
        nodeTies.push({ art: n.p, ll: [best.ll[0], best.ll[1]], auto: true })
      }
    }
    nodeCount = nodeTies.length
    const fixed = [...hand, ...nodeTies]

    // Closest real point to each art sample: in the shape's region, or (no regions told apart) anywhere
    const pairs: { art: XY; ll: XY; d: number }[] = []
    let all: Grid | undefined
    const allPts = identified ? [] : placed.flatMap((r) => r.pts)
    const allLls = identified ? [] : placed.flatMap((r) => r.lls)
    const allFrames = identified ? [] : placed.flatMap((r) => r.frame)
    shapes.forEach((sh, k) => {
      const ri = regionOf[k]!
      if (identified && ri < 0) return
      for (const s of sh.edge) {
        if (ri >= 0) {
          const hit = gridOf(ri).nearest(s, reach)
          const r = placed[ri]!
          if (hit && r.frame[hit.i] === sh.frame) pairs.push({ art: s, ll: r.lls[hit.i]!, d: hit.d })
        } else {
          all ??= new Grid(allPts, reach)
          const hit = all.nearest(s, reach)
          if (hit && allFrames[hit.i] === sh.frame) pairs.push({ art: s, ll: allLls[hit.i]!, d: hit.d })
        }
      }
    })
    if (!pairs.length && !nodeTies.length) break
    const ds = pairs.map((p) => p.d).sort((a, b) => a - b)
    median = ds[Math.floor(ds.length / 2)] ?? 0
    const cut = Math.max(2 * unit, 2.5 * median)

    // One per cell of SPACING, the closest; none right next to a hand tie (those win)
    const cells = new Map<string, (typeof pairs)[number]>()
    for (const p of pairs) {
      if (p.d > cut) continue
      if (fixed.some((h) => Math.hypot(h.art[0] - p.art[0], h.art[1] - p.art[1]) < SPACING * unit)) continue
      const key = `${Math.floor(p.art[0] / (SPACING * unit))},${Math.floor(p.art[1] / (SPACING * unit))}`
      const had = cells.get(key)
      if (!had || p.d < had.d) cells.set(key, p)
    }
    auto = [...nodeTies, ...[...cells.values()].map((p): AlignTie => ({ art: p.art, ll: [p.ll[0], p.ll[1]], auto: true }))]
  }
  return { ties: auto, median, identified, nodes: nodeCount, shapeRegions }
}

/** A frame's domain on the globe from two corners (lng / lat), as a closed ring */
export function rectDomain(a: XY, b: XY): [number, number][] {
  const [x0, x1] = [Math.min(a[0], b[0]), Math.max(a[0], b[0])]
  const [y0, y1] = [Math.min(a[1], b[1]), Math.max(a[1], b[1])]
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ]
}

export const insideDomain = (ll: XY, f: AlignFrame) => !f.domain || inRing(ll, f.domain)

/**
 * The real lines worth matching: each region's outer rings, big enough to be on a thinned map.
 * Lakes (holes) and islets aren't on the art, and would pull the fit onto whatever line is nearby.
 */
export function matchable(regions: Ring[][], minSize: number): Ring[][] {
  return regions.map((rings) => {
    const out: Ring[] = []
    const boxes = rings.map((r) => {
      let x0 = Infinity
      let y0 = Infinity
      let x1 = -Infinity
      let y1 = -Infinity
      for (const [x, y] of r) {
        x0 = Math.min(x0, x)
        y0 = Math.min(y0, y)
        x1 = Math.max(x1, x)
        y1 = Math.max(y1, y)
      }
      return [x0, y0, x1, y1] as const
    })
    rings.forEach((r, i) => {
      const [x0, y0, x1, y1] = boxes[i]!
      if (Math.hypot(x1 - x0, y1 - y0) < minSize) return
      const hole = rings.some((o, j) => {
        const b = boxes[j]!
        return j !== i && b[0] <= x0 && b[1] <= y0 && b[2] >= x1 && b[3] >= y1 && inRing(r[0]!, o)
      })
      if (!hole) out.push(r)
    })
    return out
  })
}

// ---- Where borders meet

export type Node = { p: XY; owners: number[]; coast: boolean }

/** Segments bucketed on a grid, for "is any other ring within eps of this point" */
class SegmentGrid {
  private readonly cells = new Map<number, number[]>()
  private readonly segs: { a: XY; b: XY; owner: number }[] = []
  constructor(
    rings: { owner: number; ring: XY[] }[],
    private readonly size: number,
  ) {
    for (const { owner, ring } of rings) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i]!
        const b = ring[(i + 1) % ring.length]!
        const id = this.segs.push({ a, b, owner }) - 1
        const [cx0, cx1] = [Math.floor(Math.min(a[0], b[0]) / size), Math.floor(Math.max(a[0], b[0]) / size)]
        const [cy0, cy1] = [Math.floor(Math.min(a[1], b[1]) / size), Math.floor(Math.max(a[1], b[1]) / size)]
        for (let cx = cx0; cx <= cx1; cx++) {
          for (let cy = cy0; cy <= cy1; cy++) {
            const k = (cx + 32768) * 65536 + (cy + 32768)
            const c = this.cells.get(k)
            if (c) c.push(id)
            else this.cells.set(k, [id])
          }
        }
      }
    }
  }
  /** Owners other than `self` with a segment within eps (eps <= size) */
  near(p: XY, eps: number, self: number): Set<number> {
    const out = new Set<number>()
    const cx = Math.floor(p[0] / this.size)
    const cy = Math.floor(p[1] / this.size)
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const id of this.cells.get((cx + dx + 32768) * 65536 + (cy + dy + 32768)) ?? []) {
          const s = this.segs[id]!
          if (s.owner === self || out.has(s.owner)) continue
          const ex = s.b[0] - s.a[0]
          const ey = s.b[1] - s.a[1]
          const t = Math.max(0, Math.min(1, ((p[0] - s.a[0]) * ex + (p[1] - s.a[1]) * ey) / (ex * ex + ey * ey || 1)))
          if (Math.hypot(s.a[0] + t * ex - p[0], s.a[1] + t * ey - p[1]) < eps) out.add(s.owner)
        }
      }
    }
    return out
  }
}

/**
 * The points where neighbours change along each ring: three regions meeting, or a border reaching
 * the coast. Owners are whatever the rings belong to (regions, or the art's shapes).
 */
export function findNodes(rings: { owner: number; ring: XY[] }[], eps: number): Node[] {
  const grid = new SegmentGrid(rings, eps * 2)
  const raw: Node[] = []
  for (const { owner, ring } of rings) {
    const labels = ring.map((p) => [...grid.near(p, eps, owner)].sort((a, b) => a - b))
    const key = (l: number[]) => l.join(',')
    for (let i = 0; i < ring.length; i++) {
      const prev = labels[(i - 1 + ring.length) % ring.length]!
      const cur = labels[i]!
      if (key(prev) === key(cur)) continue
      const owners = [...new Set([owner, ...prev, ...cur])].sort((a, b) => a - b)
      raw.push({ p: ring[i]!, owners, coast: !prev.length || !cur.length })
    }
  }
  // The same node turns up from each ring that meets there, and labels flicker near it: merge
  const out: (Node & { n: number })[] = []
  for (const r of raw) {
    if (r.owners.length < 2) continue
    const k = `${r.owners.join(',')}|${r.coast}`
    const m = out.find((o) => `${o.owners.join(',')}|${o.coast}` === k && Math.hypot(o.p[0] - r.p[0], o.p[1] - r.p[1]) < eps * 8)
    if (m) {
      m.p = [(m.p[0] * m.n + r.p[0]) / (m.n + 1), (m.p[1] * m.n + r.p[1]) / (m.n + 1)]
      m.n++
    } else out.push({ ...r, n: 1 })
  }
  return out.map(({ p, owners, coast }) => ({ p, owners, coast }))
}
