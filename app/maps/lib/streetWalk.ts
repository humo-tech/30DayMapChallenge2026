// Walking Shibuya's streets (scripts/day13/extract_shibuya.py): the street graph in metres,
// someone walking it who can only ever be on a street, and the doors of the coffee shops
// along them.
//
// Positions are metres east (x) and north (y) of the graph's origin. An input is a direction
// in the same plane (unit, or null for none); the walker follows the street it is on in
// whichever way is nearer the input, carries on round bends, and at a junction takes the
// street that leads off nearest the input.

export type Vec = { x: number; y: number }

export type StreetData = {
  bbox: { xmin: number; xmax: number; ymin: number; ymax: number }
  nodes: [number, number][]
  edges: { a: number; b: number; class: string; line: [number, number][] }[]
  rails: [number, number][][]
}

export type Edge = {
  a: number
  b: number
  cls: string
  pts: Vec[]
  /** Distance along the street to each of `pts` */
  cum: number[]
  length: number
}

export type Graph = {
  origin: { lng: number; lat: number }
  nodes: Vec[]
  edges: Edge[]
  /** The edges at each junction */
  at: number[][]
  toLocal: (lng: number, lat: number) => Vec
  toLngLat: (p: Vec) => { lng: number; lat: number }
}

const M_PER_LAT = 110_950

export function buildGraph(data: StreetData): Graph {
  const origin = { lng: (data.bbox.xmin + data.bbox.xmax) / 2, lat: (data.bbox.ymin + data.bbox.ymax) / 2 }
  const mPerLng = 111_320 * Math.cos((origin.lat * Math.PI) / 180)
  const toLocal = (lng: number, lat: number) => ({ x: (lng - origin.lng) * mPerLng, y: (lat - origin.lat) * M_PER_LAT })
  const toLngLat = (p: Vec) => ({ lng: origin.lng + p.x / mPerLng, lat: origin.lat + p.y / M_PER_LAT })

  const nodes = data.nodes.map(([lng, lat]) => toLocal(lng, lat))
  const at: number[][] = nodes.map(() => [])
  const edges = data.edges.map((e, i): Edge => {
    // The ends sit exactly on their junctions
    const pts = e.line.map(([lng, lat]) => toLocal(lng, lat))
    pts[0] = nodes[e.a]!
    pts[pts.length - 1] = nodes[e.b]!
    const cum = [0]
    for (let j = 1; j < pts.length; j++) cum.push(cum[j - 1]! + dist(pts[j - 1]!, pts[j]!))
    at[e.a]!.push(i)
    if (e.b !== e.a) at[e.b]!.push(i)
    return { a: e.a, b: e.b, cls: e.class, pts, cum, length: cum[cum.length - 1]! }
  })
  return { origin, nodes, edges, at, toLocal, toLngLat }
}

const dist = (a: Vec, b: Vec) => Math.hypot(b.x - a.x, b.y - a.y)
const dot = (a: Vec, b: Vec) => a.x * b.x + a.y * b.y
const unit = (v: Vec): Vec => {
  const l = Math.hypot(v.x, v.y)
  return l > 1e-9 ? { x: v.x / l, y: v.y / l } : { x: 0, y: 0 }
}

/** The piece of the street's line that `s` falls on, preferring the one ahead in `sign`'s direction */
function pieceAt(e: Edge, s: number, sign = 1): number {
  const n = e.pts.length - 1
  let i = 0
  while (i < n - 1 && (sign > 0 ? e.cum[i + 1]! <= s : e.cum[i + 1]! < s)) i++
  return i
}

export function pointAt(e: Edge, s: number): Vec {
  const i = pieceAt(e, s)
  const [p, q] = [e.pts[i]!, e.pts[i + 1]!]
  const span = e.cum[i + 1]! - e.cum[i]!
  const t = span > 0 ? Math.min(1, Math.max(0, (s - e.cum[i]!) / span)) : 0
  return { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t }
}

/** The street's direction (from `a` to `b`) at `s`, on the piece ahead in `sign`'s direction */
export function tangentAt(e: Edge, s: number, sign = 1): Vec {
  const i = pieceAt(e, s, sign)
  return unit({ x: e.pts[i + 1]!.x - e.pts[i]!.x, y: e.pts[i + 1]!.y - e.pts[i]!.y })
}

// The way a street leads off a junction: towards its point this far along, so a kink right at
// the junction doesn't count
const LEAD_M = 8

function leadOff(g: Graph, edge: number, node: number): Vec {
  const e = g.edges[edge]!
  const fromA = e.a === node
  const p = pointAt(e, fromA ? Math.min(LEAD_M, e.length) : Math.max(0, e.length - LEAD_M))
  return unit({ x: p.x - g.nodes[node]!.x, y: p.y - g.nodes[node]!.y })
}

/** The nearest point on any street to `p` */
export function nearestOnGraph(g: Graph, p: Vec): { edge: number; s: number; point: Vec; dist: number } {
  let best = { edge: 0, s: 0, point: g.nodes[g.edges[0]!.a]!, dist: Infinity }
  g.edges.forEach((e, edge) => {
    for (let i = 0; i < e.pts.length - 1; i++) {
      const [a, b] = [e.pts[i]!, e.pts[i + 1]!]
      const ab = { x: b.x - a.x, y: b.y - a.y }
      const l2 = dot(ab, ab)
      const t = l2 > 0 ? Math.min(1, Math.max(0, dot({ x: p.x - a.x, y: p.y - a.y }, ab) / l2)) : 0
      const q = { x: a.x + ab.x * t, y: a.y + ab.y * t }
      const d = dist(p, q)
      if (d < best.dist) best = { edge, s: e.cum[i]! + t * Math.sqrt(l2), point: q, dist: d }
    }
  })
  return best
}

// Within this angle of a street (cos), an input sets off along it
const ALONG = 0.5
// At a junction, the street that leads off nearest the input is taken if it's within this
// angle of it (cos: about 78°): generous, as the keys give only four or eight ways
const TURN = 0.2
// An input across the street heads for a junction this near (m) with a street off it that
// way, within this angle (cos) and nearer the input than the street you're on by TURN_BETTER
const TURN_AHEAD_M = 20
const TURN_AHEAD = 0.55
const TURN_BETTER = 0.15
// Walking, the input may turn this far off the way you're going (cos) and you keep going
const CARRY_ON = -0.2
// No street off a junction near the input, you carry on along one this straight (cos)
const STRAIGHT_ON = 0.7

export type Walker = {
  edge: number
  s: number
  /** The way along the street you're walking: 1 towards `b`, -1 towards `a`, 0 standing */
  moving: number
  /** The way you face */
  facing: Vec
}

export function walkerAt(g: Graph, p: Vec): Walker {
  const { edge, s } = nearestOnGraph(g, p)
  return { edge, s, moving: 0, facing: tangentAt(g.edges[edge]!, s) }
}

export function positionOf(g: Graph, w: Walker): Vec {
  return pointAt(g.edges[w.edge]!, w.s)
}

/**
 * Which way along its street `w` should go to turn the way `input` points at a junction just
 * ahead or behind (1 towards `b`, -1 towards `a`), if one within TURN_AHEAD_M has a street off
 * it at least `min` (cos) near the input. The nearer such junction, or the one ahead.
 */
function turnAhead(g: Graph, w: Walker, input: Vec, min: number): number | undefined {
  const e = g.edges[w.edge]!
  // The street the junction itself would pick (so the two never disagree and you never dither
  // there), if it's another one
  const offers = (node: number) => {
    let best: { edge: number; score: number } | undefined
    for (const edge of g.at[node]!) {
      if (g.edges[edge]!.length < 1e-6) continue
      const score = dot(input, leadOff(g, edge, node))
      if (!best || score > best.score) best = { edge, score }
    }
    return !!best && best.edge !== w.edge && best.score >= min
  }
  const ends = [
    { sign: 1, d: e.length - w.s, node: e.b },
    { sign: -1, d: w.s, node: e.a },
  ]
    .filter((end) => end.d <= TURN_AHEAD_M && offers(end.node))
    .sort((p, q) => (p.sign === w.moving ? -1 : q.sign === w.moving ? 1 : p.d - q.d))
  return ends[0]?.sign
}

/** Walks `w` up to `budget` metres the way `input` points */
export function walk(g: Graph, w: Walker, input: Vec | null, budget: number): void {
  if (!input) {
    w.moving = 0
    return
  }
  for (let guard = 0; budget > 1e-6 && guard < 32; guard++) {
    const e = g.edges[w.edge]!
    const atA = w.s <= 1e-6
    const atB = w.s >= e.length - 1e-6
    // At a junction, take whichever street leads off nearest the input
    if (atA || atB) {
      // (both on a street with no length: the end you were heading for)
      const node = atA && atB ? (w.moving < 0 ? e.a : e.b) : atA ? e.a : e.b
      // Walking on, the street that carries straight on is taken when none leads off near the input
      const ahead = w.moving ? w.facing : null
      let best: { edge: number; score: number } | undefined
      let straight: { edge: number; score: number } | undefined
      for (const edge of g.at[node]!) {
        if (g.edges[edge]!.length < 1e-6) continue
        const lead = leadOff(g, edge, node)
        const score = dot(input, lead)
        if (!best || score > best.score) best = { edge, score }
        const on = ahead ? dot(lead, ahead) : -1
        if (score > CARRY_ON && (!straight || on > straight.score)) straight = { edge, score: on }
      }
      const next = best && best.score > TURN ? best : straight && straight.score > STRAIGHT_ON ? straight : undefined
      if (!next) {
        w.moving = 0
        return
      }
      // (a street that loops back here is set off along from its `a`)
      const ne = g.edges[next.edge]!
      const fromA = ne.a === node
      w.edge = next.edge
      w.s = fromA ? 0 : ne.length
      w.moving = fromA ? 1 : -1
    }

    const edge = g.edges[w.edge]!
    const t = tangentAt(edge, w.s, w.moving || 1)
    const along = dot(input, t)
    const turn = turnAhead(g, w, input, Math.max(TURN_AHEAD, Math.abs(along) + TURN_BETTER))
    let sign: number
    if (turn) sign = turn
    else if (Math.abs(along) > ALONG) sign = Math.sign(along)
    else if (w.moving && along * w.moving > CARRY_ON) sign = w.moving
    else {
      w.moving = 0
      return
    }
    // Up to the end of this piece of the street, so the next step looks at the next piece
    const i = pieceAt(edge, w.s, sign)
    const stop = sign > 0 ? edge.cum[i + 1]! : edge.cum[i]!
    const step = Math.min(budget, Math.abs(stop - w.s))
    w.s = Math.min(edge.length, Math.max(0, w.s + sign * step))
    if (Math.abs(stop - w.s) < 1e-6) w.s = stop
    budget -= step
    w.moving = sign
    const dir = tangentAt(edge, w.s, sign)
    w.facing = { x: dir.x * sign, y: dir.y * sign }
  }
}

export type Door = {
  /** Index into the shops */
  shop: number
  edge: number
  s: number
  /** On the street, where you go in */
  point: Vec
  /** The way in, from the street to the shop; null when the shop is right on the street */
  into: Vec | null
  /** The shop itself */
  at: Vec
}

export function doorsOf(g: Graph, shops: Vec[]): Door[] {
  return shops.map((at, shop) => {
    const near = nearestOnGraph(g, at)
    const into = near.dist > 1.5 ? unit({ x: at.x - near.point.x, y: at.y - near.point.y }) : null
    return { shop, edge: near.edge, s: near.s, point: near.point, into, at }
  })
}

// Close enough to a door to go in (m), and how straight at it to push (cos)
export const DOOR_REACH = 7
const PUSH = 0.6

/**
 * The door `input` pushes into from where `w` stands, if any: the one within reach that it
 * points most straight into. A shop right on the street is gone into from either side, with
 * the input across the street.
 */
export function doorPushed(g: Graph, w: Walker, input: Vec | null, doors: Door[]): Door | undefined {
  if (!input) return undefined
  const p = positionOf(g, w)
  const t = tangentAt(g.edges[w.edge]!, w.s)
  let best: Door | undefined
  let bestScore = -Infinity
  for (const d of doors) {
    if (dist(p, d.point) > DOOR_REACH) continue
    const score = d.into ? dot(input, d.into) : 1 - Math.abs(dot(input, t))
    if (score > PUSH && score > bestScore) {
      best = d
      bestScore = score
    }
  }
  return best
}

/** Standing at the junction with the most streets within `radius` m of `p` */
export function startAt(g: Graph, p: Vec, radius = 40): Walker {
  let best = -1
  g.nodes.forEach((n, i) => {
    if (dist(n, p) > radius) return
    if (best < 0 || g.at[i]!.length > g.at[best]!.length) best = i
  })
  if (best < 0) return walkerAt(g, p)
  const edge = g.at[best]![0]!
  const e = g.edges[edge]!
  const s = e.a === best ? 0 : e.length
  return { edge, s, moving: 0, facing: tangentAt(e, s) }
}
