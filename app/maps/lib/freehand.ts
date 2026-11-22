// The freehand projection: latitude / longitude onto a designer's map, which no formula draws.
// The map comes with ties (a real place, and where it is on the art); a thin-plate spline through
// them, per frame, puts everything else. Frames are the parts the designer moved on their own
// (Okinawa into a box, Hokkaido shrunk, Greenland across the cut); each has a domain on the globe
// and its own spline. Built by scripts/day22/build_maps.py.

export type Tie = [lng: number, lat: number, x: number, y: number]
export type FrameData = {
  name: string
  base?: 'mercator' | 'naturalEarth'
  lng0?: number
  shift?: number
  wrap?: boolean
  domain?: [number, number][]
  boxPx?: [number, number, number, number]
  ties?: Tie[]
  off?: boolean
  /** 'affine' for a straight fit (a first few ties); a thin-plate spline otherwise */
  fit?: 'affine' | 'tps'
  /** This frame's smoothing, if not the map's */
  lambda?: number
}
export type RegionData = { id: string; name: string; rings: number[][] }
export type PinData = { name: string; lng: number; lat: number; region: string }
export type MapData = {
  width: number
  height: number
  lambda: number
  frames: FrameData[]
  quantum: number
  regions: RegionData[]
  pins: PinData[]
}
export type XY = [number, number]
export type Ring = XY[]

const DEG = Math.PI / 180

// ---- Base projections (as in the script), in degree-like units

function naturalEarth(lam: number, phi: number): XY {
  const l = lam * DEG
  const p = phi * DEG
  const p2 = p * p
  const p4 = p2 * p2
  const x = l * (0.8707 - 0.131979 * p2 + p4 * (-0.013791 + p4 * (0.003971 * p2 - 0.001529 * p4)))
  const y = p * (1.007226 + p2 * (0.015085 + p4 * (-0.044475 + 0.028874 * p2 - 0.005916 * p4)))
  return [x / DEG, y / DEG]
}

function naturalEarthInverse(x: number, y: number): XY {
  // Newton on y(phi), then lambda from x
  let p = (y * DEG) / 1.007226
  for (let i = 0; i < 12; i++) {
    const p2 = p * p
    const p4 = p2 * p2
    const f = p * (1.007226 + p2 * (0.015085 + p4 * (-0.044475 + 0.028874 * p2 - 0.005916 * p4))) - y * DEG
    const df = 1.007226 + p2 * (3 * 0.015085 + p4 * (-7 * 0.044475 + 9 * 0.028874 * p2 - 11 * 0.005916 * p4))
    p -= f / df
  }
  const p2 = p * p
  const p4 = p2 * p2
  const l = (x * DEG) / (0.8707 - 0.131979 * p2 + p4 * (-0.013791 + p4 * (0.003971 * p2 - 0.001529 * p4)))
  return [l / DEG, p / DEG]
}

export function toBase(f: FrameData, lng: number, lat: number): XY {
  if (f.base === 'mercator') {
    const la = Math.max(-85, Math.min(85, lat))
    return [lng, Math.log(Math.tan(Math.PI / 4 + (la * DEG) / 2)) / DEG]
  }
  // Longitude in -180..180 first, so a frame that doesn't wrap (shifted round the cut) gets the
  // same place whichever way round it's written (330° or -30°)
  let lam = ((((lng + 180) % 360) + 360) % 360) - 180 - (f.lng0 ?? 0) + (f.shift ?? 0)
  if (f.wrap ?? true) lam = ((((lam + 180) % 360) + 360) % 360) - 180
  return naturalEarth(lam, lat)
}

export function fromBase(f: FrameData, x: number, y: number): XY {
  if (f.base === 'mercator') return [x, (2 * Math.atan(Math.exp(y * DEG)) - Math.PI / 2) / DEG]
  const [lam, lat] = naturalEarthInverse(x, y)
  const lng = lam + (f.lng0 ?? 0) - (f.shift ?? 0)
  return [((((lng + 180) % 360) + 360) % 360) - 180, lat]
}

// ---- Thin-plate spline

const sub = (a: XY, b: XY): XY => [a[0] - b[0], a[1] - b[1]]

const kernel = (d2: number) => (d2 > 0 ? 0.5 * d2 * Math.log(d2) : 0)

/** Solves A x = b in place (Gaussian elimination, partial pivoting); b has two columns. */
function solve(A: Float64Array[], b: Float64Array[]): void {
  const n = A.length
  for (let c = 0; c < n; c++) {
    let piv = c
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r]![c]!) > Math.abs(A[piv]![c]!)) piv = r
    ;[A[c], A[piv]] = [A[piv]!, A[c]!]
    ;[b[c], b[piv]] = [b[piv]!, b[c]!]
    const ac = A[c]!
    const bc = b[c]!
    for (let r = c + 1; r < n; r++) {
      const ar = A[r]!
      const k = ar[c]! / ac[c]!
      if (k === 0) continue
      for (let j = c; j < n; j++) ar[j]! -= k * ac[j]!
      b[r]![0]! -= k * bc[0]!
      b[r]![1]! -= k * bc[1]!
    }
  }
  for (let c = n - 1; c >= 0; c--) {
    const ac = A[c]!
    for (let j = c + 1; j < n; j++) {
      b[c]![0]! -= ac[j]! * b[j]![0]!
      b[c]![1]! -= ac[j]! * b[j]![1]!
    }
    b[c]![0]! /= ac[c]!
    b[c]![1]! /= ac[c]!
  }
}

export interface Fit {
  at(x: number, y: number): XY
}

/** Least-squares affine map (needs three ties not in a line) */
export class Affine implements Fit {
  private readonly m: [number, number, number, number, number, number]

  constructor(src: XY[], dst: XY[]) {
    // Normal equations for [x y 1] -> x' and -> y'
    const A = Array.from({ length: 3 }, () => new Float64Array(3))
    const b = Array.from({ length: 3 }, () => new Float64Array(2))
    src.forEach(([x, y], i) => {
      const r = [x, y, 1]
      for (let j = 0; j < 3; j++) {
        for (let k = 0; k < 3; k++) A[j]![k]! += r[j]! * r[k]!
        b[j]![0]! += r[j]! * dst[i]![0]
        b[j]![1]! += r[j]! * dst[i]![1]
      }
    })
    solve(A, b)
    this.m = [b[0]![0]!, b[1]![0]!, b[2]![0]!, b[0]![1]!, b[1]![1]!, b[2]![1]!]
  }

  at(x: number, y: number): XY {
    const m = this.m
    return [m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5]]
  }
}

export class Tps implements Fit {
  private readonly mx: number
  private readonly my: number
  private readonly scale: number
  private readonly sx: Float64Array
  private readonly sy: Float64Array
  private readonly w: Float64Array[]

  constructor(src: XY[], dst: XY[], lambda: number) {
    const n = src.length
    this.mx = src.reduce((a, p) => a + p[0], 0) / n
    this.my = src.reduce((a, p) => a + p[1], 0) / n
    const v = src.reduce((a, p) => a + (p[0] - this.mx) ** 2 + (p[1] - this.my) ** 2, 0) / (2 * n)
    this.scale = Math.sqrt(v) || 1
    this.sx = Float64Array.from(src, (p) => (p[0] - this.mx) / this.scale)
    this.sy = Float64Array.from(src, (p) => (p[1] - this.my) / this.scale)
    const A = Array.from({ length: n + 3 }, () => new Float64Array(n + 3))
    const b = Array.from({ length: n + 3 }, (_, i) => Float64Array.of(dst[i]?.[0] ?? 0, dst[i]?.[1] ?? 0))
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        A[i]![j] = kernel((this.sx[i]! - this.sx[j]!) ** 2 + (this.sy[i]! - this.sy[j]!) ** 2)
      }
      A[i]![i]! += lambda
      A[i]![n] = A[n]![i] = 1
      A[i]![n + 1] = A[n + 1]![i] = this.sx[i]!
      A[i]![n + 2] = A[n + 2]![i] = this.sy[i]!
    }
    solve(A, b)
    this.w = b
  }

  at(x: number, y: number): XY {
    const n = this.sx.length
    const qx = (x - this.mx) / this.scale
    const qy = (y - this.my) / this.scale
    const w = this.w
    let ox = w[n]![0]! + w[n + 1]![0]! * qx + w[n + 2]![0]! * qy
    let oy = w[n]![1]! + w[n + 1]![1]! * qx + w[n + 2]![1]! * qy
    for (let i = 0; i < n; i++) {
      const u = kernel((qx - this.sx[i]!) ** 2 + (qy - this.sy[i]!) ** 2)
      ox += u * w[i]![0]!
      oy += u * w[i]![1]!
    }
    return [ox, oy]
  }
}

// ---- Geometry helpers

export function inRing(p: XY, ring: Ring): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!
    const [xj, yj] = ring[j]!
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** Even-odd over all rings, so holes count */
export const inRings = (p: XY, rings: Ring[]) => rings.reduce((a, r) => (inRing(p, r) ? !a : a), false)

/** Area of a ring (shoelace) */
export function ringArea(ring: Ring): number {
  let a = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j]![0] * ring[i]![1] - ring[i]![0] * ring[j]![1]
  return Math.abs(a) / 2
}

/** The nearest point on any ring, how far, and the area of the ring it's on (its island) */
function nearestOnRings(p: XY, rings: Ring[]): { q: XY; d: number; area: number } {
  let best = { q: p, d: Infinity, area: 0 }
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[j]!
      const b = ring[i]!
      const dx = b[0] - a[0]
      const dy = b[1] - a[1]
      const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)))
      const q: XY = [a[0] + t * dx, a[1] + t * dy]
      const d = Math.hypot(p[0] - q[0], p[1] - q[1])
      if (d < best.d) best = { q, d, area: ringArea(ring) }
    }
  }
  return best
}

/** Decodes the script's delta-coded rings (1/quantum degree) */
export function decodeRings(rings: number[][], quantum: number): Ring[] {
  return rings.map((r) => {
    const out: Ring = []
    let x = 0
    let y = 0
    for (let i = 0; i < r.length; i += 2) {
      x += r[i]!
      y += r[i + 1]!
      out.push([x / quantum, y / quantum])
    }
    return out
  })
}

/** Rings of an SVG path made of M, L and Z only (as the art is written) */
export function parsePath(d: string): Ring[] {
  return d
    .split('Z')
    .filter((s) => s.trim())
    .map((s) =>
      s
        .replace('M', '')
        .split('L')
        .map((pt) => pt.trim().split(/\s+/).map(Number) as XY),
    )
}

// ---- The projection

export type Placed = { xy: XY; raw: XY; snapped: boolean }

export class FreehandProjection {
  readonly frames: FrameData[]
  private readonly splines: (Fit | null)[]
  private readonly inverses: (Fit | null)[]

  constructor(data: Pick<MapData, 'frames' | 'lambda'>) {
    this.frames = data.frames
    const make = (f: FrameData, src: XY[], dst: XY[]): Fit | null => {
      if (src.length < 3) return null
      return f.fit === 'affine' ? new Affine(src, dst) : new Tps(src, dst, f.lambda ?? data.lambda)
    }
    this.splines = data.frames.map((f) => {
      const t = f.ties ?? []
      return make(f, t.map((t) => toBase(f, t[0], t[1])), t.map((t) => [t[2], t[3]]))
    })
    // The other way round, for a first guess when inverting
    this.inverses = data.frames.map((f) => {
      const t = f.ties ?? []
      return make(f, t.map((t) => [t[2], t[3]]), t.map((t) => toBase(f, t[0], t[1])))
    })
  }

  /** Whether a frame has enough ties to place anything */
  fitted(frame: number): boolean {
    return !!this.splines[frame]
  }

  /** The frame a place falls in, or -1 if it's left off the map */
  frameOf(lng: number, lat: number): number {
    lng = ((((lng + 180) % 360) + 360) % 360) - 180
    for (let i = 0; i < this.frames.length; i++) {
      const f = this.frames[i]!
      if (!f.domain || inRing([lng, lat], f.domain)) return f.off ? -1 : i
    }
    return -1
  }

  project(lng: number, lat: number, frame = this.frameOf(lng, lat)): XY | null {
    const s = this.splines[frame]
    if (!s) return null
    const [bx, by] = toBase(this.frames[frame]!, lng, lat)
    return s.at(bx, by)
  }

  /** The place under a point of the art (Newton's method on the spline), or null if none */
  invert(x: number, y: number): [number, number] | null {
    const inBox = this.frames.findIndex(
      (f) => f.boxPx && x >= f.boxPx[0] && x <= f.boxPx[0] + f.boxPx[2] && y >= f.boxPx[1] && y <= f.boxPx[1] + f.boxPx[3],
    )
    const candidates = inBox >= 0 ? [inBox] : this.frames.map((f, i) => (this.splines[i] && !f.boxPx ? i : -1)).filter((i) => i >= 0)
    let fallback: [number, number] | null = null
    for (const fi of candidates) {
      const f = this.frames[fi]!
      const s = this.splines[fi]
      if (!s) continue
      let [bx, by] = this.inverses[fi]!.at(x, y)
      for (let it = 0; it < 8; it++) {
        const [px, py] = s.at(bx, by)
        const ex = px - x
        const ey = py - y
        if (Math.hypot(ex, ey) < 1e-3) break
        const h = 1e-4
        const [ax, ay] = s.at(bx + h, by)
        const [cx, cy] = s.at(bx, by + h)
        const j11 = (ax - px) / h
        const j21 = (ay - py) / h
        const j12 = (cx - px) / h
        const j22 = (cy - py) / h
        const det = j11 * j22 - j12 * j21
        if (!det) break
        bx -= (j22 * ex - j12 * ey) / det
        by -= (-j21 * ex + j11 * ey) / det
      }
      const ll = fromBase(f, bx, by)
      // Off the globe (past the poles, beyond the edge of the world), or no spot projects here
      const back = Math.abs(ll[1]) <= 90 && Math.hypot(...sub(toBase(f, ll[0], ll[1]), [bx, by])) < 1e-3
      if (!back || Math.hypot(...sub(s.at(bx, by), [x, y])) > 0.5) continue
      if (this.frameOf(ll[0], ll[1]) === fi) return ll
      fallback ??= ll
    }
    return inBox >= 0 ? fallback : null
  }

  /** Lines on the art for lines on the globe, broken where they change frame or leave the map */
  line(points: XY[]): XY[][] {
    const out: XY[][] = []
    let cur: XY[] = []
    let last = -2
    for (const [lng, lat] of points) {
      let fi = this.frameOf(lng, lat)
      if (fi >= 0 && !this.splines[fi]) fi = -1
      if (fi !== last && cur.length) {
        if (cur.length > 1) out.push(cur)
        cur = []
      }
      last = fi
      if (fi < 0) continue
      cur.push(this.project(lng, lat, fi)!)
    }
    if (cur.length > 1) out.push(cur)
    return out
  }
}

/** How far a small country's capital is pulled onto its dot */
const DOT_SNAP = 3

/**
 * A pin's spot: where the spline puts it, then (if that's just outside the region it belongs in,
 * as it can be by a thinned coast) moved onto the region's art, a little way in. maxSnap may be a
 * function of the area of the island it would land on, so small islands can be left alone.
 */
export function placePin(
  raw: XY,
  art: Ring[] | undefined,
  dot: XY | undefined,
  maxSnap: number | ((islandArea: number) => number),
  inset: number,
): Placed {
  if (dot) {
    const d = Math.hypot(raw[0] - dot[0], raw[1] - dot[1])
    const max = typeof maxSnap === 'number' ? maxSnap : DOT_SNAP
    return d < max && d > 0.5 ? { xy: dot, raw, snapped: true } : { xy: raw, raw, snapped: false }
  }
  if (!art || inRings(raw, art)) return { xy: raw, raw, snapped: false }
  const { q, d, area } = nearestOnRings(raw, art)
  if (d > (typeof maxSnap === 'number' ? maxSnap : maxSnap(area))) return { xy: raw, raw, snapped: false }
  const ux = (q[0] - raw[0]) / (d || 1)
  const uy = (q[1] - raw[1]) / (d || 1)
  const xy: XY = [q[0] + ux * inset, q[1] + uy * inset]
  return { xy: inRings(xy, art) ? xy : q, raw, snapped: true }
}

// ---- Drawing helpers

export const toPath = (lines: XY[][]) => lines.map((l) => 'M' + l.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join('L')).join('')

/** Splits a projected line where it jumps (across the cut, round the back of the world) */
export function unjump(lines: XY[][], max: number): XY[][] {
  const out: XY[][] = []
  for (const l of lines) {
    let cur: XY[] = [l[0]!]
    for (let i = 1; i < l.length; i++) {
      const a = l[i - 1]!
      const b = l[i]!
      if (Math.abs(b[0] - a[0]) > max) {
        if (cur.length > 1) out.push(cur)
        cur = []
      }
      cur.push(b)
    }
    if (cur.length > 1) out.push(cur)
  }
  return out
}

/** A graticule through the projection: meridians and parallels every `grid` degrees over a range */
export function graticule(proj: FreehandProjection, lng: [number, number], lat: [number, number], grid: number, step: number): XY[][] {
  const range = (a: number, b: number, d: number) => Array.from({ length: Math.floor((b - a) / d) + 1 }, (_, i) => a + i * d)
  const lines: XY[][] = []
  for (const x of range(Math.ceil(lng[0] / grid) * grid, lng[1], grid)) {
    lines.push(...proj.line(range(lat[0], lat[1], step).map((y) => [x, y] as XY)))
  }
  for (const y of range(Math.ceil(lat[0] / grid) * grid, lat[1], grid)) {
    lines.push(...proj.line(range(lng[0], lng[1], step).map((x) => [x, y] as XY)))
  }
  return lines
}

export const fmtLngLat = (lng: number, lat: number) =>
  `${Math.abs(lat).toFixed(4)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lng).toFixed(4)}° ${lng >= 0 ? 'E' : 'W'}`
