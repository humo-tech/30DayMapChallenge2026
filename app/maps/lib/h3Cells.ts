// HELLO CYCLING stations -> H3 cells, one set per resolution, built on demand.
import { cellToBoundary, cellToLatLng, getHexagonEdgeLengthAvg, latLngToCell } from 'h3-js'

export type StationPoint = { lng: number; lat: number; capacity: number }

export type H3Cell = {
  id: string
  center: [number, number] // [lng, lat]
  /** The cell's outline: 6 corners, 5 for the pentagons, a few more where it straddles an icosahedron edge */
  ring: [number, number][]
  /** Docks in the cell */
  capacity: number
  /** Stations in the cell */
  count: number
  /** 0-1: log of the docks, against the fullest cell of this resolution */
  value: number
  /** 0-1, fixed per cell, for twinkling and staggering */
  seed: number
}

export type H3Set = { res: number; edge: number; cells: H3Cell[] }

export const MIN_RES = 3
export const MAX_RES = 10

/** Average edge length (m) of a cell at each resolution */
export const EDGE_M: Record<number, number> = Object.fromEntries(
  Array.from({ length: MAX_RES + 1 }, (_, r) => [r, getHexagonEdgeLengthAvg(r, 'm')]),
)

// A small stable hash of the cell id -> 0-1
function hash01(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  h ^= h >>> 15
  h = Math.imul(h, 2246822519)
  h ^= h >>> 13
  return ((h >>> 0) % 100_000) / 100_000
}

export function buildCells(points: StationPoint[], res: number): H3Set {
  const bins = new Map<string, { capacity: number; count: number }>()
  for (const p of points) {
    const id = latLngToCell(p.lat, p.lng, res)
    const bin = bins.get(id)
    if (bin) {
      bin.capacity += p.capacity
      bin.count += 1
    } else {
      bins.set(id, { capacity: p.capacity, count: 1 })
    }
  }
  let max = 1
  for (const b of bins.values()) max = Math.max(max, b.capacity)
  const denom = Math.log1p(max)

  const cells: H3Cell[] = []
  for (const [id, b] of bins) {
    const [clat, clng] = cellToLatLng(id)
    cells.push({
      id,
      center: [clng, clat],
      ring: cellToBoundary(id).map(([lat, lng]) => [lng, lat] as [number, number]),
      capacity: b.capacity,
      count: b.count,
      value: Math.log1p(b.capacity) / denom,
      seed: hash01(id),
    })
  }
  return { res, edge: EDGE_M[res]!, cells }
}

/** The resolution whose cells come closest to `edgePx` on screen, leaning toward `current` so it doesn't flicker at the boundary */
export function pickRes(metersPerPx: number, edgePx: number, current?: number): number {
  const ideal = edgePx * metersPerPx
  const miss = (r: number) => Math.abs(Math.log(EDGE_M[r]! / ideal))
  let best = MIN_RES
  for (let r = MIN_RES; r <= MAX_RES; r++) if (miss(r) < miss(best)) best = r
  if (current !== undefined && miss(current) < miss(best) + 0.25) return current
  return best
}
