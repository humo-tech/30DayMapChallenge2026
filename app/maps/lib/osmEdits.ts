// OSM edits for Day 21, as packed by scripts/day21/pack_edits.py: one entry per grid cell and
// time bin with edits in it, sorted by time. Loaded from a gzipped binary plus a JSON beside it.
import { geodeticToVector3 } from '@navaramap/three'

export type EditsMeta = {
  start: string
  days: number
  /** Length of a time bin (h) */
  hours: number
  count: number
  grid: { lon0: number; lat0: number; res: number }
  /** Per day: [created, modified, deleted] */
  daily: [number, number, number][]
}

export type EditPoints = {
  meta: EditsMeta
  /** Cell centres in ECEF minus the anchor, xyz interleaved */
  position: Float32Array
  /** When (days since the start), spread over the bin so a bin doesn't flash all at once */
  time: Float32Array
  /** log2 of the edits in the entry */
  size: Float32Array
  /** Share created, share deleted (the rest: modified) */
  mix: Float32Array
  /** When the same cell is edited next (days; far off if never): until then this entry is its latest */
  next: Float32Array
}

// The .bin is gzipped. Inflate it here unless the server already did (one that sends it with
// Content-Encoding: gzip hands over the plain bytes)
async function gunzip(res: Response): Promise<ArrayBuffer> {
  const buf = await res.arrayBuffer()
  const b = new Uint8Array(buf, 0, 2)
  if (b[0] !== 0x1f || b[1] !== 0x8b) return buf
  return new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()
}

// A fixed 0-1 per entry (integer hash), so the spread within a bin is the same on every load
function hash01(i: number): number {
  let h = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

export async function loadEdits(url: string, anchor: { x: number; y: number; z: number }): Promise<EditPoints> {
  const [meta, buf] = await Promise.all([
    fetch(`${url}.json`).then((r) => r.json() as Promise<EditsMeta>),
    fetch(`${url}.bin`).then(gunzip),
  ])
  const n = meta.count
  const x = new Uint16Array(buf, 0, n)
  const y = new Uint16Array(buf, 2 * n, n)
  const t = new Uint16Array(buf, 4 * n, n)
  const sz = new Uint8Array(buf, 6 * n, n)
  const mx = new Uint8Array(buf, 7 * n, n)
  const { lon0, lat0, res } = meta.grid
  const binDays = meta.hours / 24

  const position = new Float32Array(n * 3)
  const time = new Float32Array(n)
  const size = new Float32Array(n)
  const mix = new Float32Array(n * 2)
  const next = new Float32Array(n)
  // A cell recurs all year: its ECEF position is worked out once
  const cells = new Map<number, number>()
  const xyz: number[] = []
  for (let i = 0; i < n; i++) {
    const key = x[i]! * 65536 + y[i]!
    let c = cells.get(key)
    if (c === undefined) {
      c = xyz.length
      const p = geodeticToVector3({ lng: lon0 + (x[i]! + 0.5) * res, lat: lat0 + (y[i]! + 0.5) * res, height: 0 })
      xyz.push(p.x - anchor.x, p.y - anchor.y, p.z - anchor.z)
      cells.set(key, c)
    }
    position[i * 3] = xyz[c]!
    position[i * 3 + 1] = xyz[c + 1]!
    position[i * 3 + 2] = xyz[c + 2]!
    time[i] = (t[i]! + hash01(i)) * binDays
    size[i] = sz[i]! / 16
    mix[i * 2] = (mx[i]! >> 4) / 15
    mix[i * 2 + 1] = (mx[i]! & 15) / 15
  }
  // Backwards through time: each entry learns when its cell is edited again
  const later = new Map<number, number>()
  for (let i = n - 1; i >= 0; i--) {
    const key = x[i]! * 65536 + y[i]!
    next[i] = later.get(key) ?? 1e6
    later.set(key, time[i]!)
  }
  return { meta, position, time, size, mix, next }
}

/**
 * The entries within `degrees` of the point over (lng, lat), for points loaded relative to the
 * Earth's centre: a panel only gets its side of the globe.
 */
export function within(points: EditPoints, lng: number, lat: number, degrees: number): EditPoints {
  const c = geodeticToVector3({ lng, lat, height: 0 }).normalize()
  const [ux, uy, uz] = [c.x, c.y, c.z]
  const cos = Math.cos((degrees * Math.PI) / 180)
  const { position: p } = points
  const keep: number[] = []
  for (let i = 0; i < points.time.length; i++) {
    const x = p[i * 3]!
    const y = p[i * 3 + 1]!
    const z = p[i * 3 + 2]!
    if (x * ux + y * uy + z * uz > cos * Math.hypot(x, y, z)) keep.push(i)
  }
  const pick = (a: Float32Array, k: number) => {
    const out = new Float32Array(keep.length * k)
    keep.forEach((i, j) => {
      for (let m = 0; m < k; m++) out[j * k + m] = a[i * k + m]!
    })
    return out
  }
  return {
    meta: points.meta,
    position: pick(points.position, 3),
    time: pick(points.time, 1),
    size: pick(points.size, 1),
    mix: pick(points.mix, 2),
    next: pick(points.next, 1),
  }
}
