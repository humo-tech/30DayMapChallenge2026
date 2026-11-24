// Day 25: the playgrounds' animals as play equipment, with the toy's children on them
// (toyKids.ts), and the animals (toyAnimals.ts) never quite still:
//
// - Buta-koen (Pig Park): a big pig to climb up by a ladder at its tail, run along its back and
//   slide down off its snout; it nods and its tail spins; and two piglets on springs to ride;
// - Uma-koen (Horse Park): two big rocking horses, a child on each; a pony on a spring;
// - Risu-koen (Squirrel Park): a squirrel sitting up on a big tree stump nibbling an acorn, the
//   stump to climb by its holds and jump down from; two squirrels on springs;
// - Kirin-san Parking: a giraffe, a long ladder up to its head, and down its neck, along its back
//   and off its tail by a chute.
//
// Each piece is built in its model's units (about 12 to an animal's length; u along it, up),
// scaled to its size, set at a spot in the playground and turned to the spot's angle.
import { BufferGeometry, CylinderGeometry, Group, Mesh, Quaternion, SphereGeometry, Vector3 } from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { giraffe, horse, pig, rockers, spring, squirrel, type Model, type Part } from './toyAnimals'
import { K, type Kids, type Spot } from './toyKids'
import { mergeGeometries, painted, seeded, type ParkData } from './toyPark'

const g = (geo: BufferGeometry, color: string) => painted(geo.index ? geo.toNonIndexed() : geo, color)
const rod = (a: [number, number, number], b: [number, number, number], r: number, color: string) => {
  const va = new Vector3(...a)
  const vb = new Vector3(...b)
  const geo = new CylinderGeometry(r, r, va.distanceTo(vb), 8)
  geo.applyQuaternion(new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), vb.clone().sub(va).normalize()))
  return g(geo.translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2), color)
}

/** A ladder from (u0, 0) up to (u1, h1), `w` wide (model units) */
function ladder(u0: number, u1: number, h1: number, w: number): BufferGeometry {
  const parts = [rod([u0, 0, -w / 2], [u1, h1, -w / 2], 0.16, '#f2e2c4'), rod([u0, 0, w / 2], [u1, h1, w / 2], 0.16, '#f2e2c4')]
  const n = Math.max(3, Math.round(h1 / 1.1))
  for (let i = 1; i < n; i++) {
    const t = i / n
    const u = u0 + (u1 - u0) * t
    parts.push(rod([u, h1 * t, -w / 2], [u, h1 * t, w / 2], 0.1, '#e8483c'))
  }
  return mergeGeometries(parts)!
}

/** A chute from (u0, h0) down to (u1, h1), `w` wide, with sides (model units) */
function chute(u0: number, h0: number, u1: number, h1: number, w: number): BufferGeometry {
  const len = Math.hypot(u1 - u0, h1 - h0)
  const angle = Math.atan2(h1 - h0, u1 - u0)
  const mid = [(u0 + u1) / 2, (h0 + h1) / 2] as const
  const parts = [g(new RoundedBoxGeometry(len, 0.25, w, 2, 0.1).rotateZ(angle).translate(mid[0], mid[1], 0), '#ffcc2e')]
  for (const z of [-w / 2, w / 2]) parts.push(g(new RoundedBoxGeometry(len, 0.55, 0.16, 1, 0.06).rotateZ(angle).translate(mid[0], mid[1] + 0.3, z), '#ff9a3c'))
  return mergeGeometries(parts)!
}

type Rig = { spot: Spot; h: number; sc: number; moving: Group; body: Group; head: Group; tail: Group; lift: number }

/** Sets up a model at a spot: its body rocks in `moving` (about the ground under its middle) */
function rig(kids: Kids, model: Model, spot: Spot, h: number, size: number, extra: BufferGeometry[] = [], lift = 0, fixed: BufferGeometry[] = []): Rig {
  const sc = size / 12
  const holder = new Group()
  holder.position.set(spot.x, h, -spot.y)
  holder.rotation.y = spot.yaw
  holder.scale.setScalar(sc)
  const moving = new Group()
  holder.add(moving)
  const body = new Group()
  body.position.y = lift
  moving.add(body)
  const mesh = (geo: BufferGeometry, parent: Group) => {
    const m = new Mesh(geo, kids.material)
    m.castShadow = m.receiveShadow = true
    parent.add(m)
    return m
  }
  mesh(model.body, body)
  const pivoted = (p: Part) => {
    const grp = new Group()
    grp.position.set(...p.at)
    mesh(p.geometry, grp)
    body.add(grp)
    return grp
  }
  const head = pivoted(model.head)
  model.legs.forEach(pivoted)
  const tail = pivoted(model.tail)
  for (const geo of extra) mesh(geo, moving)
  for (const geo of fixed) mesh(geo, holder)
  kids.group.add(holder)
  return { spot, h, sc, moving, body, head, tail, lift }
}

/** Plan point and height of model point (u, up), the body rocked by `rock` about the ground */
function world(r: Rig, u: number, up: number, rock = 0): [number, number, number] {
  const c = Math.cos(rock)
  const s = Math.sin(rock)
  const uu = (u * c - up * s) * r.sc
  const hh = (u * s + up * c) * r.sc
  const cy = Math.cos(r.spot.yaw)
  const sy = Math.sin(r.spot.yaw)
  return [r.spot.x + uu * cy, r.spot.y + uu * sy, r.h + hh]
}

/** Children riding at points (u, up) on a rig's back, facing forward, now and then arms up */
function riders(kids: Kids, r: Rig, seats: [number, number][], rock: () => number) {
  const who = seats.map(() => kids.kid())
  kids.every((t) => {
    const a = rock()
    who.forEach((k, i) => {
      const kid = kids.pose(k)
      const [x, y, hh] = world(r, seats[i]![0], seats[i]![1], a)
      kid.x = x
      kid.y = y
      kid.h = hh - 0.6 * K
      kid.yaw = r.spot.yaw
      const whee = Math.sin(t * 1.7 + i * 2.1) > 0.4
      kid.l = kid.r = whee ? 0 : 1.3
      kid.spread = whee ? 2.7 : 0.15
    })
  })
}

type Leg = { to: [number, number]; how: 'climb' | 'walk' | 'slide' | 'jump' }

/** Children going round a route on a rig: up a ladder, along, down a slide, off with a jump */
function route(kids: Kids, r: Rig, from: [number, number], legs: Leg[], n: number) {
  // Seconds per model unit, by how they go
  const pace = { climb: 0.5, walk: 0.22, slide: 0.07, jump: 0.15 }
  const pts = [from, ...legs.map((l) => l.to)]
  const times = legs.map((l, i) => Math.hypot(pts[i + 1]![0] - pts[i]![0], pts[i + 1]![1] - pts[i]![1]) * pace[l.how] * (12 / Math.max(8, r.sc * 12)) ** 0.3)
  // And back round to the start along the ground
  const back = Math.abs(from[0] - pts[pts.length - 1]![0]) * 0.12 + 0.6
  const T = times.reduce((a, b) => a + b, 0) + back
  const who = Array.from({ length: n }, () => kids.kid())
  kids.every((t) => {
    who.forEach((k, i) => {
      const kid = kids.pose(k)
      let tt = (t + (i * T) / n) % T
      let u: number
      let up: number
      let how: Leg['how'] | 'run' = 'run'
      let dir = 1
      let j = 0
      while (j < legs.length && tt > times[j]!) tt -= times[j++]!
      if (j < legs.length) {
        const f = tt / times[j]!
        const a = pts[j]!
        const b = pts[j + 1]!
        u = a[0] + (b[0] - a[0]) * (legs[j]!.how === 'slide' ? f ** 1.4 : f)
        up = a[1] + (b[1] - a[1]) * f
        if (legs[j]!.how === 'jump') up += Math.sin(f * Math.PI) * 3
        how = legs[j]!.how
        dir = Math.sign(b[0] - a[0]) || 1
      } else {
        // Run back round to the ladder, off to one side
        const f = tt / back
        const end = pts[pts.length - 1]!
        u = end[0] + (from[0] - end[0]) * f
        up = Math.abs(Math.sin(t * 6.5 + i)) * 0.4
        dir = Math.sign(from[0] - end[0]) || 1
      }
      const side = how === 'run' ? 4.5 * Math.sin(Math.min(1, ((t + (i * T) / n) % T) / T) * Math.PI) : 0
      const [x, y, hh] = world(r, u, up)
      const cy = Math.cos(r.spot.yaw)
      const sy = Math.sin(r.spot.yaw)
      kid.x = x - sy * side * r.sc
      kid.y = y + cy * side * r.sc
      kid.h = hh + (how === 'slide' ? -0.3 * K : 0)
      kid.yaw = r.spot.yaw + (dir < 0 ? Math.PI : 0)
      if (how === 'climb') {
        kid.l = 2.6 + 0.35 * Math.sin(t * 12)
        kid.r = 2.6 - 0.35 * Math.sin(t * 12)
        kid.spread = 0.2
      } else if (how === 'slide' || how === 'jump') {
        kid.l = kid.r = 0
        kid.spread = 2.7
      } else {
        const s = Math.sin(t * 6.5 + i)
        kid.l = s
        kid.r = -s
        kid.spread = 0.15
      }
    })
  })
}

/** The animal equipment in the playgrounds (and the giraffe in its car park) */
export function animalPlaygrounds(kids: Kids, d: ParkData, play: number, parking: number): void {
  const rnd = seeded(1225)
  const area = (name: string) => d.areas.find((a) => a.name === name)?.rings[0]
  const buta = area('ぶた公園')
  const uma = area('うま公園')
  const risu = area('りす公園')
  const kirin = area('きりんさんパーキング')
  // Spots: radius in the children's units (m / K)
  const r = (m: number) => m / K

  if (buta) {
    const [big, s1, s2] = kids.equip(buta, [r(22), r(7), r(7)])
    if (big) {
      const rig_ = rig(kids, pig(), big, play, 34, [ladder(-11.5, -5.6, 8.4, 2.4), chute(9.4, 7.0, 14.0, 0.7, 2.6)])
      kids.every((t) => {
        rig_.head.rotation.z = Math.sin(t * 1.6) * 0.08
        rig_.head.rotation.x = Math.sin(t * 1.1) * 0.06
        rig_.tail.rotation.x = t * 6
        rig_.moving.position.y = Math.abs(Math.sin(t * 1.6)) * 0.15
      })
      route(
        kids,
        rig_,
        [-11.5, 0],
        [
          { to: [-5.6, 8.6], how: 'climb' },
          { to: [0, 10.6], how: 'walk' },
          { to: [5.4, 10.9], how: 'walk' },
          { to: [9.4, 7.6], how: 'slide' },
          { to: [14.0, 1.2], how: 'slide' },
          { to: [16.5, 0], how: 'jump' },
        ],
        3,
      )
    }
    for (const s of [s1, s2]) if (s) springRider(kids, s, play, pig(), 11, rnd() * 6)
  }

  if (uma) {
    const found = kids.equip(uma, [r(15), r(15), r(7)])
    found.slice(0, 2).forEach((s, i) => {
      const model = i ? horse('#f6f0e2', '#7a4a2a') : horse()
      const phase = rnd() * 6
      let a = 0
      const rg = rig(kids, model, s, play, 24, [rockers(2.8, 12)], 0.9)
      kids.every((t) => {
        a = 0.16 * Math.sin(t * 2.6 + phase)
        rg.moving.rotation.z = a
        rg.head.rotation.z = -a * 0.6
        rg.tail.rotation.x = Math.sin(t * 3.3 + phase) * 0.4
      })
      riders(kids, rg, [[-0.4, 12.6]], () => a)
    })
    if (found[2]) springRider(kids, found[2], play, horse('#e6b98a', '#8a5a33'), 12, rnd() * 6)
  }

  if (risu) {
    const [big, s1, s2] = kids.equip(risu, [r(17), r(6.5), r(6.5)])
    if (big) {
      // A squirrel sitting up on top of a big tree stump, nibbling an acorn; the children climb
      // the stump by its holds, from both sides, and jump down off the top
      const STUMP = 12
      const rg = rig(kids, squirrel(), big, play, 24, [], STUMP, [stump(STUMP)])
      rg.body.rotation.z = 0.5
      const acorn = new Mesh(acornGeometry(), kids.material)
      acorn.castShadow = true
      acorn.position.set(2.6, -1.2, 0)
      rg.head.add(acorn)
      kids.every((t) => {
        rg.tail.rotation.z = Math.sin(t * 1.3) * 0.08
        rg.tail.rotation.x = Math.sin(t * 2.1) * 0.06
        // Nibble, nibble, and now and then a look round
        rg.head.rotation.z = -0.35 + Math.abs(Math.sin(t * 9)) * 0.06
        rg.head.rotation.y = Math.sin(t * 0.6) > 0.7 ? Math.sin(t * 3) * 0.4 : 0
      })
      for (const turn of [0, Math.PI * 0.65, Math.PI * 1.3]) {
        const side = { ...rg, spot: { ...big, yaw: big.yaw + Math.PI + turn } }
        route(
          kids,
          side,
          [9.5, 0],
          [
            { to: [6.0, STUMP - 0.5], how: 'climb' },
            { to: [5.0, STUMP + 0.2], how: 'walk' },
            { to: [11.5, 0], how: 'jump' },
          ],
          1,
        )
      }
    }
    for (const s of [s1, s2]) if (s) springRider(kids, s, play, squirrel(), 10, rnd() * 6)
  }

  if (kirin) {
    const [s] = kids.equip(kirin, [r(26)])
    if (s) {
      const rg = rig(kids, giraffe(seeded(7)), s, parking, 26, [ladder(14.5, 10.4, 27.2, 2.2), chute(-4.8, 15.4, -12.5, 0.7, 2.6)])
      kids.every((t) => {
        rg.head.rotation.z = Math.sin(t * 0.7) * 0.05
        rg.head.rotation.x = Math.sin(t * 0.5) * 0.04
        rg.tail.rotation.x = Math.sin(t * 3) * 0.5
      })
      route(
        kids,
        rg,
        [14.5, 0],
        [
          { to: [10.4, 27.6], how: 'climb' },
          { to: [8.2, 27.3], how: 'walk' },
          { to: [3.2, 17.6], how: 'slide' },
          { to: [-3.6, 16.9], how: 'slide' },
          { to: [-4.8, 16.0], how: 'walk' },
          { to: [-12.5, 1.2], how: 'slide' },
          { to: [-15, 0], how: 'jump' },
        ],
        3,
      )
    }
  }
}

/** A tree stump `h` tall to climb, with bright holds round it (model units) */
function stump(h: number): BufferGeometry {
  const parts = [
    g(new CylinderGeometry(5.0, 6.0, h, 24, 4).translate(0, h / 2, 0), '#8a5a33'),
    g(new CylinderGeometry(5.05, 5.05, 0.3, 24).translate(0, h, 0), '#e2c08f'),
    // Roots splaying out at the foot
    ...[0, 1, 2, 3, 4].map((i) => g(new RoundedBoxGeometry(4, 1.4, 1.6, 2, 0.6).translate(6.2, 0.6, 0).rotateY((i * 2 * Math.PI) / 5 + 0.3), '#7a4a2a')),
  ]
  const holds = ['#e8483c', '#ffd23a', '#3fa9f5', '#5ccf72', '#ff8fc7']
  for (let i = 0; i < 26; i++) {
    const a = i * 2.4
    const y = 1.2 + ((i * 0.37) % 1) * (h - 2)
    parts.push(g(new RoundedBoxGeometry(1.0, 0.8, 1.0, 2, 0.3).translate(Math.cos(a) * 5.6, y, Math.sin(a) * 5.6), holds[i % holds.length]!))
  }
  return mergeGeometries(parts)!
}

/** An acorn, for the squirrel's paws (model units) */
function acornGeometry(): BufferGeometry {
  return mergeGeometries([
    g(new SphereGeometry(0.9, 12, 10).scale(1, 1.25, 1), '#c9873a'),
    g(new SphereGeometry(0.95, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2).translate(0, 0.35, 0), '#7a4a2a'),
    g(new CylinderGeometry(0.12, 0.12, 0.6, 6).translate(0, 1.4, 0), '#5a3418'),
  ])!
}

/** A small animal on a spring, a child on its back, rocking */
function springRider(kids: Kids, s: Spot, h: number, model: Model, size: number, phase: number) {
  // The child sits on top of the body, which stands on the spring
  model.body.computeBoundingBox()
  const LIFT = 3.2
  const back = model.body.boundingBox!.max.y + LIFT
  const rg = rig(kids, model, s, h, size, [], LIFT, [spring(3.4)])
  let a = 0
  kids.every((t) => {
    a = 0.22 * Math.sin(t * 4.2 + phase)
    rg.moving.rotation.z = a
    rg.moving.rotation.x = 0.08 * Math.sin(t * 3.1 + phase)
  })
  riders(kids, rg, [[-0.4, back]], () => a)
}
