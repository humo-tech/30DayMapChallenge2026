// Day 25: the animals the playgrounds are named after, as wooden play equipment's shapes: a pig
// for Buta-koen (Pig Park), a horse for Uma-koen (Horse Park), a squirrel for Risu-koen
// (Squirrel Park) and a giraffe for Kirin-san Parking (Mr Giraffe's car park). Each model is made
// about 12 units long, facing +x, standing on y = 0, with its head, legs and tail apart on pivots
// so they can move (toyAnimalPlay.ts sets them rocking, nodding and wagging, with children on
// them). Built like the rest of the toy (toyPark.ts): x east, y up, z south.
import {
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { mergeGeometries, painted } from './toyPark'

export type Species = 'pig' | 'horse' | 'squirrel' | 'giraffe'

/** A coil spring under a spring rider, `h` tall (model units) */
export function spring(h: number): BufferGeometry {
  const coils: BufferGeometry[] = []
  const n = 5
  for (let i = 0; i < n; i++) coils.push(g(new TorusGeometry(1.1, 0.22, 6, 16).rotateX(Math.PI / 2).translate(0, 0.3 + (i * (h - 0.6)) / (n - 1), 0), '#555a66'))
  coils.push(g(new CylinderGeometry(1.6, 1.8, 0.4, 16).translate(0, 0.2, 0), '#8a8f99'))
  return merge(coils)
}

/** A pair of rockers under a rocking animal, `w` apart, `len` long */
export function rockers(w: number, len: number): BufferGeometry {
  const R = len * 1.4
  const arc = (len / R) * 1.0
  return merge(
    [-w / 2, w / 2].map((z) => g(new TorusGeometry(R, 0.45, 6, 28, arc).rotateZ(-Math.PI / 2 - arc / 2).translate(0, R + 0.4, z), '#b07a3e')),
  )
}

/** A moving part: its geometry about its pivot, and where the pivot is on the body */
export type Part = { geometry: BufferGeometry; at: [number, number, number] }
export type Model = { body: BufferGeometry; head: Part; legs: Part[]; tail: Part }

const g = (geo: BufferGeometry, color: string) => painted(geo.index ? geo.toNonIndexed() : geo, color)
const merge = (parts: BufferGeometry[]) => mergeGeometries(parts)!
const part = (geometry: BufferGeometry, at: [number, number, number]): Part => ({ geometry, at })
/** A leg hanging from its hip: `len` long, `r` thick, a hoof or paw of another colour */
const leg = (len: number, r: number, color: string, foot: string) =>
  merge([g(new CylinderGeometry(r, r * 0.88, len, 12).translate(0, -len / 2, 0), color), g(new CylinderGeometry(r * 0.95, r * 0.95, len * 0.14, 12).translate(0, -len * 0.93, 0), foot)])

/** Paints a giraffe's patches: brown cells parted by pale lines (a Voronoi pattern in space) */
function patches(geo: BufferGeometry, seeds: Vector3[], line: number, brown: string, pale: string): BufferGeometry {
  const out = g(geo, pale)
  const pos = out.getAttribute('position')
  const col = out.getAttribute('color')
  const { r: br, g: bg, b: bb } = new Color(brown)
  const v = new Vector3()
  for (let i = 0; i < pos.count; i += 3) {
    // Per triangle (so the edges stay crisp): its middle
    v.set(0, 0, 0)
    for (let k = 0; k < 3; k++) v.add(new Vector3(pos.getX(i + k), pos.getY(i + k), pos.getZ(i + k)))
    v.divideScalar(3)
    let d1 = Infinity
    let d2 = Infinity
    for (const s of seeds) {
      const d = s.distanceTo(v)
      if (d < d1) {
        d2 = d1
        d1 = d
      } else if (d < d2) d2 = d
    }
    if (d2 - d1 > line) for (let k = 0; k < 3; k++) col.setXYZ(i + k, br, bg, bb)
  }
  return out
}
// ---- The models (each about 12 units long, facing +x) --------------------------------------

export function pig(): Model {
  const PINK = '#f4a6b8'
  const SNOUT = '#e98aa0'
  const DARK = '#3a2a2a'
  const head = merge([
    g(new SphereGeometry(3.3, 20, 14).translate(1.6, 0.4, 0), PINK),
    g(new CylinderGeometry(1.55, 1.7, 1.6, 18).rotateZ(Math.PI / 2).translate(5.0, -0.1, 0), SNOUT),
    ...[-0.6, 0.6].map((z) => g(new SphereGeometry(0.33, 8, 6).translate(5.8, -0.1, z), DARK)),
    ...[-1.9, 1.9].map((z) => g(new ConeGeometry(1.2, 2.2, 10).rotateX(z > 0 ? 0.5 : -0.5).rotateZ(-0.35).translate(0.9, 3.6, z), SNOUT)),
    ...[-1.35, 1.35].map((z) => g(new SphereGeometry(0.42, 10, 8).translate(4.1, 1.6, z), DARK)),
  ])
  return {
    body: g(new SphereGeometry(1, 24, 16).scale(6.2, 4.4, 4.4).translate(0, 6.0, 0), PINK),
    head: part(head, [4.0, 7.0, 0]),
    legs: [
      [3.2, 2.2],
      [3.2, -2.2],
      [-3.2, 2.2],
      [-3.2, -2.2],
    ].map(([x, z]) => part(leg(3.4, 0.95, PINK, SNOUT), [x!, 3.4, z!])),
    tail: part(g(new TorusGeometry(0.8, 0.28, 8, 20, Math.PI * 1.6).rotateY(Math.PI / 2), SNOUT), [-6.4, 7.6, 0]),
  }
}

export function horse(coat = '#c98a4b', mane = '#5a3418'): Model {
  const MUZZLE = '#f1dcc0'
  const head = merge([
    // Neck rising forward from the shoulders, the head at its top
    g(new RoundedBoxGeometry(2.2, 6.4, 1.9, 2, 0.8).rotateZ(-0.55).translate(1.6, 2.6, 0), coat),
    g(new RoundedBoxGeometry(2.2, 5.6, 0.6, 2, 0.25).rotateZ(-0.55).translate(0.8, 3.2, 0), mane),
    g(new RoundedBoxGeometry(4.6, 2.0, 1.8, 2, 0.8).rotateZ(-0.35).translate(4.4, 5.4, 0), coat),
    g(new RoundedBoxGeometry(1.6, 1.7, 1.7, 2, 0.7).rotateZ(-0.35).translate(6.3, 4.6, 0), MUZZLE),
    ...[-0.55, 0.55].map((z) => g(new ConeGeometry(0.45, 1.5, 8).translate(3.0, 7.1, z), coat)),
    ...[-0.95, 0.95].map((z) => g(new SphereGeometry(0.3, 8, 6).translate(4.6, 6.1, z), '#2b2b2b')),
  ])
  return {
    body: merge([g(new SphereGeometry(1, 24, 16).scale(5.4, 2.7, 2.4).translate(0, 8.6, 0), coat), g(new RoundedBoxGeometry(3.0, 0.7, 2.6, 2, 0.3).translate(-0.4, 11.2, 0), '#e8483c')]),
    head: part(head, [4.0, 9.6, 0]),
    legs: [
      [3.6, 1.3],
      [3.6, -1.3],
      [-3.6, 1.3],
      [-3.6, -1.3],
    ].map(([x, z]) => part(leg(7.2, 0.72, coat, '#3a2a22'), [x!, 7.4, z!])),
    tail: part(merge([g(new CylinderGeometry(0.55, 0.35, 5.2, 8).translate(0, -2.6, 0), mane)]), [-5.2, 9.6, 0]),
  }
}

export function squirrel(): Model {
  const FUR = '#d07b32'
  const CREAM = '#f6e2c0'
  const TAIL = '#b8642a'
  const head = merge([
    g(new SphereGeometry(2.0, 18, 14).translate(1.2, 1.4, 0), FUR),
    g(new SphereGeometry(1.1, 12, 10).translate(2.5, 0.8, 0), CREAM),
    g(new SphereGeometry(0.35, 8, 6).translate(3.5, 1.0, 0), '#3a2a2a'),
    ...[-1.0, 1.0].map((z) => g(new SphereGeometry(0.42, 10, 8).translate(2.6, 2.1, z), '#2b2b2b')),
    ...[-0.95, 0.95].map((z) => g(new ConeGeometry(0.6, 1.8, 8).translate(0.6, 3.6, z), FUR)),
    ...[-0.95, 0.95].map((z) => g(new ConeGeometry(0.25, 0.9, 6).translate(0.6, 4.8, z), '#7a3a14')),
  ])
  // The tail: a plume of fluff up the back, curling over at the top
  const tail: BufferGeometry[] = []
  // (many small steps, so it reads as one smooth plume, not beads)
  for (let i = 0; i <= 28; i++) {
    const t = i / 28
    const a = t * Math.PI * 1.15
    const x = -1.2 - Math.sin(a) * 2.2 + t * 1.2
    const y = t * 8.5 + (1 - Math.cos(a)) * 0.4
    tail.push(g(new SphereGeometry(1.9 + Math.sin(t * Math.PI) * 0.9, 14, 10).translate(x, y, 0), TAIL))
  }
  return {
    body: merge([g(new SphereGeometry(1, 20, 14).scale(3.2, 2.6, 2.3).translate(0, 3.8, 0), FUR), g(new SphereGeometry(1, 14, 10).scale(2.2, 1.8, 1.7).translate(0.9, 3.2, 0), CREAM)]),
    head: part(head, [2.4, 5.2, 0]),
    legs: [
      [1.8, 1.0],
      [1.8, -1.0],
      [-1.8, 1.3],
      [-1.8, -1.3],
    ].map(([x, z], i) => part(i < 2 ? leg(2.0, 0.45, FUR, CREAM) : merge([g(new SphereGeometry(1.1, 10, 8).translate(0, -0.6, 0), FUR), leg(2.2, 0.5, FUR, CREAM)]), [x!, 2.3, z!])),
    tail: part(merge(tail), [-2.6, 3.4, 0]),
  }
}

export function giraffe(rnd: () => number): Model {
  const YELLOW = '#f6c453'
  const BROWN = '#a8592a'
  const seeds = (n: number, box: [number, number, number, number, number, number]) =>
    Array.from({ length: n }, () => new Vector3(box[0] + rnd() * (box[1] - box[0]), box[2] + rnd() * (box[3] - box[2]), box[4] + rnd() * (box[5] - box[4])))
  const body = patches(new SphereGeometry(1, 28, 18).scale(5.0, 2.8, 2.3).translate(0, 13.6, 0), seeds(70, [-5, 5, 10.8, 16.4, -2.3, 2.3]), 0.32, BROWN, YELLOW)
  const neck = patches(new CylinderGeometry(0.75, 1.35, 12, 16, 8).translate(0, 6, 0).rotateZ(-0.38), seeds(60, [-1.5, 6, 0, 12, -1.4, 1.4]), 0.26, BROWN, YELLOW)
  const head = merge([
    neck,
    g(new RoundedBoxGeometry(3.6, 1.6, 1.5, 2, 0.6).rotateZ(-0.3).translate(5.6, 11.6, 0), YELLOW),
    g(new RoundedBoxGeometry(1.2, 1.2, 1.3, 2, 0.5).rotateZ(-0.3).translate(7.2, 11.0, 0), '#e8b46a'),
    ...[-0.4, 0.4].flatMap((z) => [g(new CylinderGeometry(0.18, 0.2, 1.3, 6).translate(4.4, 13.1, z), BROWN), g(new SphereGeometry(0.3, 8, 6).translate(4.4, 13.8, z), '#5a3418')]),
    ...[-0.8, 0.8].map((z) => g(new ConeGeometry(0.35, 1.2, 8).rotateX(z > 0 ? -1.1 : 1.1).translate(4.0, 12.4, z * 1.3), YELLOW)),
    ...[-0.78, 0.78].map((z) => g(new SphereGeometry(0.24, 8, 6).translate(5.8, 12.2, z), '#2b2b2b')),
    // The mane down the back of the neck
    g(new RoundedBoxGeometry(0.6, 10, 0.4, 1, 0.2).translate(-0.6, 5.5, 0).rotateZ(-0.38), BROWN),
  ])
  return {
    body,
    head: part(head, [3.6, 15.0, 0]),
    legs: [
      [3.2, 1.2],
      [3.2, -1.2],
      [-3.2, 1.2],
      [-3.2, -1.2],
    ].map(([x, z]) => part(leg(12.2, 0.62, YELLOW, '#5a3418'), [x!, 12.2, z!])),
    tail: part(merge([g(new CylinderGeometry(0.2, 0.2, 5, 6).translate(0, -2.5, 0), YELLOW), g(new SphereGeometry(0.55, 8, 6).scale(0.8, 1.6, 0.8).translate(0, -5.2, 0), '#3a2a22')]), [-4.9, 14.6, 0]),
  }
}
