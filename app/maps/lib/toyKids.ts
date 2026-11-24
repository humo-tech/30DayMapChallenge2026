// Day 25: children at play in the wooden Komazawa Olympic Park. Little peg dolls with big heads,
// bright caps and swinging arms, and wooden play equipment for them in the playgrounds:
//
// - Uma-koen (Horse Park): swings and a slide, and rocking horses (toyAnimalPlay.ts);
// - Risu-koen (Squirrel Park): a roundabout and a seesaw, and a squirrel's tree stump to climb (toyAnimalPlay.ts);
// - Buta-koen (Pig Park): a big pig to climb and slide down (toyAnimalPlay.ts);
// - the Free Lawn: games of tag and circles of children throwing a ball;
// - the paddling pool (Jabu-jabu-ike): children splashing under the fountains;
// - the family course: children on little bikes.
//
// Built like the rest of the toy (toyPark.ts): x east, y up, z south. A piece of equipment is built
// in its own frame (u along it, v across, up), placed at a point and turned by an angle.
import {
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DynamicDrawUsage,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  Object3D,
  Points,
  PointsMaterial,
  Quaternion,
  SphereGeometry,
  Vector3,
  type Material,
} from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { bicycle, distToRing, mergeGeometries, painted, pointInRing, ringBounds, seeded, type ParkData, type Ring } from './toyPark'

export type Kid = {
  x: number
  y: number
  h: number
  yaw: number
  /** Arms: each one's swing forward (rad, 0 down, π up), and how far both are spread sideways */
  l: number
  r: number
  spread: number
  /** The way it faces now, turning towards `yaw` at a child's pace */
  face?: number
  /** Shirt and cap colours (a team's), or picked at random */
  shirt?: string
  cap?: string
}

const SHIRTS = ['#ff5a4e', '#ffcc2e', '#3fa9f5', '#5ccf72', '#ff8fc7', '#a77bf3', '#ff9a3c', '#2ad1c9', '#ffffff']
const HATS = ['#ffffff', '#e8483c', '#ffd23a', '#ffd23a', '#3f7fe0', '#ff8fc7']
const BALLS = ['#ff4d4d', '#ffd02e', '#3fa9f5', '#ff8fc7']

/** A child, about 6.4 m tall on the toy: body, head, cap with a brim, arms from the shoulders */
function kidGeometries() {
  const body = new CylinderGeometry(1.0, 1.45, 3.4, 14).translate(0, 1.7, 0)
  const head = new SphereGeometry(1.55, 16, 12).translate(0, 4.75, 0)
  const hat = mergeGeometries([
    new SphereGeometry(1.65, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2).translate(0, 4.95, 0).toNonIndexed(),
    new CylinderGeometry(1.15, 1.15, 0.18, 16).scale(1, 1, 1).translate(1.2, 4.95, 0).toNonIndexed(),
  ])!
  const arm = mergeGeometries([
    new CylinderGeometry(0.36, 0.32, 2.2, 8).translate(0, -1.1, 0).toNonIndexed(),
    new SphereGeometry(0.45, 8, 6).translate(0, -2.25, 0).toNonIndexed(),
  ])!
  return { body, head, hat, arm }
}
const SHOULDER = 3.05
const SHOULDER_SIDE = 1.3
/** The children and their equipment: far larger than the park's scale, so what they're up to reads at a glance */
export const K = 2.4
/** How fast a child turns round (rad/s) */
const TURN = 6

// ---- Play equipment ------------------------------------------------------------------------

const g = (geo: BufferGeometry, color: string) => painted(geo.index ? geo.toNonIndexed() : geo, color)
const rod = (a: [number, number, number], b: [number, number, number], r: number, color: string) => {
  const va = new Vector3(...a)
  const vb = new Vector3(...b)
  const len = va.distanceTo(vb)
  const geo = new CylinderGeometry(r, r, len, 8)
  const q = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), vb.clone().sub(va).normalize())
  geo.applyQuaternion(q).translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2)
  return g(geo, color)
}
// Equipment is built with v across it: three's z is -v
const P = (u: number, h: number, v: number): [number, number, number] => [u, h, -v]

/** Swings: an A-frame, a bar across the top, and `seats` seats hanging from it */
function swingFrame(seats: number) {
  const W = seats * 5.5 + 2
  const H = 11
  const parts = [rod(P(-W / 2, 0, -3.5), P(-W / 2, H, 0), 0.5, '#e8483c'), rod(P(-W / 2, 0, 3.5), P(-W / 2, H, 0), 0.5, '#e8483c')]
  parts.push(rod(P(W / 2, 0, -3.5), P(W / 2, H, 0), 0.5, '#e8483c'), rod(P(W / 2, 0, 3.5), P(W / 2, H, 0), 0.5, '#e8483c'))
  parts.push(rod(P(-W / 2 - 0.4, H, 0), P(W / 2 + 0.4, H, 0), 0.55, '#ffd23a'))
  const seat = mergeGeometries([
    rod(P(-1.2, 0, 0), P(-1.2, -8, 0), 0.12, '#6b4a2e'),
    rod(P(1.2, 0, 0), P(1.2, -8, 0), 0.12, '#6b4a2e'),
    g(new RoundedBoxGeometry(3.2, 0.45, 1.8, 2, 0.2).translate(0, -8.1, 0), '#3fa9f5'),
  ])!
  const xs = Array.from({ length: seats }, (_, i) => -W / 2 + 1 + 2.75 + i * 5.5)
  return { frame: mergeGeometries(parts)!, seat, xs, H, rope: 8 }
}

/** A slide: a tower with a pointed roof, a ladder up one side, the chute down the other */
function slideGeometry() {
  const Hp = 7.2
  const parts: BufferGeometry[] = []
  for (const [a, b] of [
    [-2.2, -2.2],
    [-2.2, 2.2],
    [2.2, -2.2],
    [2.2, 2.2],
  ] as const) {
    parts.push(rod(P(a, 0, b), P(a, Hp + 4.2, b), 0.4, '#f2e2c4'))
  }
  parts.push(g(new RoundedBoxGeometry(5.4, 0.7, 5.4, 2, 0.2).translate(0, Hp, 0), '#5ccf72'))
  parts.push(g(new ConeGeometry(4.2, 3.4, 4, 1).rotateY(Math.PI / 4).translate(0, Hp + 5.9, 0), '#e8483c'))
  // Ladder
  for (const v of [-1.3, 1.3]) parts.push(rod(P(-2.6, Hp + 0.3, v), P(-6.8, 0, v), 0.28, '#f2e2c4'))
  for (let i = 1; i < 6; i++) {
    const t = i / 6
    parts.push(rod(P(-2.6 - 4.2 * t, (Hp + 0.3) * (1 - t), -1.3), P(-2.6 - 4.2 * t, (Hp + 0.3) * (1 - t), 1.3), 0.18, '#f2e2c4'))
  }
  // Chute: from the platform's edge down to the ground, with sides
  const a = new Vector3(2.7, Hp + 0.2, 0)
  const b = new Vector3(14, 1.0, 0)
  const len = a.distanceTo(b)
  const angle = Math.atan2(b.y - a.y, b.x - a.x)
  const chute = new RoundedBoxGeometry(len, 0.45, 3.0, 2, 0.15).rotateZ(angle).translate((a.x + b.x) / 2, (a.y + b.y) / 2, 0)
  parts.push(g(chute, '#ffcc2e'))
  for (const v of [-1.55, 1.55]) {
    parts.push(g(new RoundedBoxGeometry(len, 0.9, 0.3, 1, 0.12).rotateZ(angle).translate((a.x + b.x) / 2, (a.y + b.y) / 2 + 0.5, -v), '#ff9a3c'))
  }
  parts.push(rod(P(13.2, 0, 0), P(13.2, 0.9, 0), 0.6, '#f2e2c4'))
  return { geometry: mergeGeometries(parts)!, Hp, chuteTop: a, chuteEnd: b }
}

/** A seesaw: a block in the middle and the plank (apart, it tips) */
function seesawGeometry() {
  const base = g(new RoundedBoxGeometry(2.2, 2.6, 2.2, 2, 0.4).translate(0, 1.3, 0), '#a77bf3')
  const plank = mergeGeometries([
    g(new RoundedBoxGeometry(15, 0.55, 1.9, 2, 0.2), '#ffd23a'),
    ...[-5.3, 5.3].map((u) => rod(P(u, 0, -0.9), P(u, 1.8, 0), 0.2, '#e8483c')),
    ...[-5.3, 5.3].map((u) => rod(P(u, 0, 0.9), P(u, 1.8, 0), 0.2, '#e8483c')),
  ])!
  return { base, plank, pivot: 2.7 }
}

/** A roundabout: a striped disc on a post, with handles (the disc and handles turn) */
function roundaboutGeometry() {
  const R = 6.2
  const disc: BufferGeometry[] = []
  for (let i = 0; i < 8; i++) {
    disc.push(g(new CylinderGeometry(R, R, 0.8, 6, 1, false, (i * Math.PI) / 4, Math.PI / 4).translate(0, 1.1, 0), i % 2 ? '#ffffff' : '#ff5a4e'))
  }
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2 + Math.PI / 4
    disc.push(rod(P(Math.cos(a) * 4.6, 1.5, Math.sin(a) * 4.6), P(Math.cos(a) * 1.0, 4.6, Math.sin(a) * 1.0), 0.25, '#3fa9f5'))
  }
  disc.push(g(new SphereGeometry(1.0, 12, 8).translate(0, 4.8, 0), '#ffd23a'))
  const base = g(new CylinderGeometry(1.2, 1.8, 0.8, 12).translate(0, 0.4, 0), '#8a6a4a')
  return { disc: mergeGeometries(disc)!, base: base, R }
}

// ---- Placing things in a playground --------------------------------------------------------

export type Spot = { x: number; y: number; yaw: number }

/** Spots for things of radius `radii` (the children's units) in `ring`, none overlapping each other, the edge or `avoid` (x, y, radius in m) */
export function spots(ring: Ring, radii: number[], rnd: () => number, avoid: [number, number, number][] = []): Spot[] {
  const [x0, y0, x1, y1] = ringBounds(ring)
  const out: (Spot & { r: number })[] = []
  for (const r of radii.map((x) => x * K)) {
    let best: (Spot & { r: number }) | undefined
    let bestScore = -Infinity
    for (let k = 0; k < 400; k++) {
      const x = x0 + rnd() * (x1 - x0)
      const y = y0 + rnd() * (y1 - y0)
      if (!pointInRing(ring, x, y)) continue
      const edge = distToRing(ring, x, y)
      if (edge < r) continue
      const gap = Math.min(Infinity, ...out.map((o) => Math.hypot(o.x - x, o.y - y) - o.r - r), ...avoid.map(([ax, ay, ar]) => Math.hypot(ax - x, ay - y) - ar - r))
      if (gap < 2) continue
      // Prefer spots with room round them
      const score = Math.min(edge - r, gap) + rnd() * 3
      if (score > bestScore) {
        bestScore = score
        best = { x, y, yaw: rnd() * Math.PI * 2, r }
      }
    }
    if (best) out.push(best)
  }
  return out
}

/** A plan point from a piece of equipment's frame (u along, v across, in its own units) */
function at(s: Spot, u: number, v: number): [number, number] {
  const c = Math.cos(s.yaw) * K
  const sn = Math.sin(s.yaw) * K
  return [s.x + u * c - v * sn, s.y + u * sn + v * c]
}

// ---- The children --------------------------------------------------------------------------

export type Behaviour = (t: number, dt: number) => void

export class Kids {
  readonly group = new Group()
  private kids: Kid[] = []
  private behaviours: Behaviour[] = []
  private moving: { obj: Object3D; base: number; spot: Spot }[] = []
  private disposables: { dispose(): void }[] = []
  private inst!: { body: InstancedMesh; head: InstancedMesh; hat: InstancedMesh; armL: InstancedMesh; armR: InstancedMesh }
  private balls!: InstancedMesh
  private ballPos: { x: number; y: number; h: number; color?: string }[] = []
  private bikes!: InstancedMesh
  private bikeKids: number[] = []
  private spray?: { points: Points; jets: [number, number][]; h: number; n: number }
  private rnd = seeded(2025)
  /** The equipment so far, for the next to keep clear of: x, y, radius (m) */
  readonly obstacles: [number, number, number][] = []

  constructor(
    d: ParkData,
    private ground: { play: number; lawn: number; pool: number; family: number },
    private paint: Material,
    private cloth: Material,
    private skin: Material,
    /** Adds games on the pitches and the animal equipment (toySports.ts, toyAnimalPlay.ts) */
    sports?: (kids: Kids) => void,
  ) {
    const area = (name: string) => d.areas.find((a) => a.name === name)?.rings[0]
    const uma = area('うま公園')
    const risu = area('りす公園')
    const buta = area('ぶた公園')
    const lawn = area('自由広場')
    const pool = d.areas.find((a) => a.kind === 'pool')?.rings[0]
    const smallLawn = d.areas.find((a) => a.kind === 'lawn' && !a.name)?.rings[0]

    // The games and the animal equipment first: they need the room most
    sports?.(this)
    if (uma) {
      const [sw, sl] = this.equip(uma, [10, 12])
      if (sw) this.swings(sw, 2, ground.play)
      if (sl) this.slide(sl, 2, ground.play)
      this.freePlay(uma, 3, ground.play)
    }
    if (risu) {
      const [mg, ss] = this.equip(risu, [8.5, 8.5])
      if (mg) this.roundabout(mg, ground.play)
      if (ss) this.seesaw(ss, ground.play)
      this.freePlay(risu, 2, ground.play)
    }
    if (buta) this.freePlay(buta, 2, ground.play)
    if (lawn) {
      this.freePlay(lawn, 5, ground.lawn)
      const [c] = spots(lawn, [11], this.rnd)
      if (c) this.ballCircle(c, 3, 7, ground.lawn)
    }
    if (smallLawn) {
      const [c] = spots(smallLawn, [10], this.rnd)
      if (c) this.ballCircle(c, 3, 7, ground.lawn)
    }
    if (pool) this.splash(pool, 6, ground.pool)
    this.familyBikes(d.loops.family, 5, ground.family)
    this.build()
  }

  /** Spots for equipment in a playground, clear of what's there already */
  equip(ring: Ring, radii: number[]): Spot[] {
    const found = spots(ring, radii, this.rnd, this.obstacles)
    found.forEach((s, i) => this.obstacles.push([s.x, s.y, radii[i]! * K]))
    return found
  }

  /** A new child (its index), in a team's shirt and cap if given */
  kid(shirt?: string, cap?: string): number {
    this.kids.push({ x: 0, y: 0, h: 0, yaw: 0, l: 0, r: 0, spread: 0, shirt, cap })
    return this.kids.length - 1
  }

  /** The painted wood the equipment is made of */
  get material(): Material {
    return this.paint
  }

  /** A child's pose, for the games to set */
  pose(k: number): Kid {
    return this.kids[k]!
  }

  /** A new ball (its index), coloured, or the balls' colours by turn */
  ball(color?: string): number {
    this.ballPos.push({ x: 0, y: 0, h: 0, color })
    return this.ballPos.length - 1
  }

  /** A ball's place, for the games to set */
  ballAt(i: number) {
    return this.ballPos[i]!
  }

  /** Something every frame: (now, dt) */
  every(b: Behaviour): void {
    this.behaviours.push(b)
  }

  /** A painted piece set down at plan (x, y), height h, turned by yaw, at the children's scale */
  set(geometry: BufferGeometry, x: number, y: number, h: number, yaw: number): void {
    this.place(geometry, { x, y, yaw }, h)
  }

  /** Adds a piece of equipment's mesh at a spot (`moving` ones are turned by their behaviour) */
  private place(geometry: BufferGeometry, s: Spot, h: number): Mesh {
    const m = new Mesh(geometry, this.paint)
    m.castShadow = m.receiveShadow = true
    m.position.set(s.x, h, -s.y)
    m.rotation.y = s.yaw
    m.scale.setScalar(K)
    this.group.add(m)
    this.disposables.push(geometry)
    return m
  }

  private swings(s: Spot, seats: number, h: number) {
    const sw = swingFrame(seats)
    this.place(sw.frame, s, h)
    sw.xs.forEach((u, i) => {
      const pivot = new Group()
      const seat = new Mesh(sw.seat, this.paint)
      seat.castShadow = true
      pivot.add(seat)
      pivot.position.set(u, sw.H, 0)
      const holder = new Group()
      holder.position.set(s.x, h, -s.y)
      holder.rotation.y = s.yaw
      holder.scale.setScalar(K)
      holder.add(pivot)
      this.group.add(holder)
      const k = this.kid()
      const phase = this.rnd() * 6
      let amp = 0
      this.behaviours.push((t, dt) => {
        const kid = this.kids[k]!
        amp += (0.85 - amp) * Math.min(1, dt * 0.8)
        const phi = amp * Math.sin(t * 2.3 + phase)
        pivot.rotation.x = phi
        // On the seat: down the rope, out along v
        const [x, y] = at(s, u, sw.rope * Math.sin(phi))
        kid.x = x
        kid.y = y
        kid.h = h + (sw.H - sw.rope * Math.cos(phi) + 0.2) * K
        kid.yaw = s.yaw + Math.PI / 2
        kid.l = kid.r = 2.7
        kid.spread = 0.25
      })
    })
    this.disposables.push(sw.seat)
  }

  private slide(s: Spot, n: number, h: number) {
    const sl = slideGeometry()
    // Centred on the middle of its length
    const off = -4
    const geo = sl.geometry.translate(off, 0, 0)
    this.place(geo, s, h)
    const T = 8
    const path: [number, number][] = [
      [15.6, 0],
      [15.6, 5.8],
      [-7.6, 5.8],
      [-7.6, 0],
      [-6.9, 0],
    ]
    const lens = path.slice(1).map((p, i) => Math.hypot(p[0] - path[i]![0], p[1] - path[i]![1]))
    const total = lens.reduce((a, b) => a + b, 0)
    for (let i = 0; i < n; i++) {
      const k = this.kid()
      const phase = i / n
      this.behaviours.push((t) => {
        const kid = this.kids[k]!
        const p = (t / T + phase) % 1
        let u: number
        let v = 0
        let hh = 0
        let yaw = 0
        if (p < 0.42) {
          // Run round to the ladder
          let dist = (p / 0.42) * total
          let j = 0
          while (j < lens.length - 1 && dist > lens[j]!) dist -= lens[j++]!
          const a = path[j]!
          const b = path[j + 1]!
          const f = Math.min(1, dist / lens[j]!)
          u = a[0] + (b[0] - a[0]) * f
          v = a[1] + (b[1] - a[1]) * f
          yaw = Math.atan2(b[1] - a[1], b[0] - a[0])
          hh = Math.abs(Math.sin(t * 6.5 + i)) * 0.6
          kid.l = Math.sin(t * 6.5 + i) * 0.9
          kid.r = -kid.l
          kid.spread = 0.15
        } else if (p < 0.66) {
          // Up the ladder, hand over hand
          const f = (p - 0.42) / 0.24
          u = -6.9 + 4.2 * f
          hh = (sl.Hp + 0.3) * f
          kid.l = 2.6 + 0.35 * Math.sin(t * 12)
          kid.r = 2.6 - 0.35 * Math.sin(t * 12)
          kid.spread = 0.2
        } else if (p < 0.74) {
          // Across the top
          const f = (p - 0.66) / 0.08
          u = -2.5 + 5.0 * f
          hh = sl.Hp + 0.35
          kid.l = kid.r = 0.4
          kid.spread = 0.3
        } else if (p < 0.88) {
          // Down the chute, arms up
          const f = ((p - 0.74) / 0.14) ** 1.5
          u = sl.chuteTop.x + (sl.chuteEnd.x - sl.chuteTop.x) * f
          hh = sl.chuteTop.y + (sl.chuteEnd.y - sl.chuteTop.y) * f + 0.2
          kid.l = kid.r = 0
          kid.spread = 2.7
        } else {
          // Off the end with a jump
          const f = (p - 0.88) / 0.12
          u = sl.chuteEnd.x + 1.6 * f
          hh = (1 - f) * 1.0 + Math.sin(f * Math.PI) * 2.2
          kid.l = kid.r = 0
          kid.spread = 2.5 * Math.sin(f * Math.PI)
        }
        const [x, y] = at(s, u + off, v)
        kid.x = x
        kid.y = y
        kid.h = h + hh * K
        kid.yaw = s.yaw + yaw
      })
    }
  }

  private seesaw(s: Spot, h: number) {
    const ss = seesawGeometry()
    this.place(ss.base, s, h)
    const plank = this.place(ss.plank, s, h)
    const holder = new Group()
    holder.position.set(s.x, h, -s.y)
    holder.rotation.y = s.yaw
    holder.scale.setScalar(K)
    this.group.remove(plank)
    plank.position.set(0, ss.pivot, 0)
    plank.rotation.set(0, 0, 0)
    plank.scale.setScalar(1)
    holder.add(plank)
    this.group.add(holder)
    const a = this.kid()
    const b = this.kid()
    let amp = 0
    this.behaviours.push((t, dt) => {
      amp += (0.32 - amp) * Math.min(1, dt * 1.5)
      const alpha = amp * Math.sin(t * 2.4)
      plank.rotation.z = alpha
      for (const [k, u] of [
        [a, -6.4],
        [b, 6.4],
      ] as const) {
        const kid = this.kids[k]!
        const [x, y] = at(s, u * Math.cos(alpha), 0)
        kid.x = x
        kid.y = y
        kid.h = h + (ss.pivot + 0.3 + u * Math.sin(alpha)) * K
        kid.yaw = s.yaw + (u < 0 ? 0 : Math.PI)
        // Hold on, and up with both arms at the top
        const top = (u < 0 ? -alpha : alpha) / 0.32
        kid.l = kid.r = top > 0.6 ? 0 : 1.3
        kid.spread = top > 0.6 ? 2.6 : 0.2
      }
    })
  }

  private roundabout(s: Spot, h: number) {
    const rg = roundaboutGeometry()
    this.place(rg.base, s, h)
    const disc = new Mesh(rg.disc, this.paint)
    disc.castShadow = disc.receiveShadow = true
    disc.position.set(s.x, h, -s.y)
    disc.scale.setScalar(K)
    this.group.add(disc)
    this.disposables.push(rg.disc)
    const riders = [this.kid(), this.kid(), this.kid()]
    const pusher = this.kid()
    let angle = 0
    let speed = 0
    this.behaviours.push((t, dt) => {
      speed += (1.6 - speed) * Math.min(1, dt * 0.7)
      angle += speed * dt
      disc.rotation.y = angle
      riders.forEach((k, i) => {
        const kid = this.kids[k]!
        // Plan angle: the disc turns anticlockwise seen from above (rotation.y > 0)
        const a = angle + (i * 2 * Math.PI) / 3
        kid.x = s.x + Math.cos(a) * 3.4 * K
        kid.y = s.y + Math.sin(a) * 3.4 * K
        kid.h = h + 1.5 * K
        kid.yaw = a + Math.PI / 2
        const whee = Math.sin(t * 2 + i * 2) > 0.3
        kid.l = kid.r = whee ? 0 : 1.2
        kid.spread = whee ? 2.6 : 0.2
      })
      const kid = this.kids[pusher]!
      const a = angle - 0.35
      kid.x = s.x + Math.cos(a) * 7.8 * K
      kid.y = s.y + Math.sin(a) * 7.8 * K
      kid.h = h + Math.abs(Math.sin(t * 6.5)) * 0.5 * K
      kid.yaw = a + Math.PI / 2
      kid.l = kid.r = 1.4
      kid.spread = 0.1
    })
  }

  /** Children running about `ring`: playing tag, or chasing whatever `chase` points at */
  private freePlay(ring: Ring, n: number, h: number, chase?: () => [number, number] | undefined) {
    const [x0, y0, x1, y1] = ringBounds(ring)
    const pick = (near?: [number, number], spread = 12): [number, number] => {
      for (let k = 0; k < 60; k++) {
        const x = near ? near[0] + (this.rnd() - 0.5) * spread * 2 : x0 + this.rnd() * (x1 - x0)
        const y = near ? near[1] + (this.rnd() - 0.5) * spread * 2 : y0 + this.rnd() * (y1 - y0)
        if (pointInRing(ring, x, y) && distToRing(ring, x, y) > 4) return [x, y]
      }
      return near ?? [(x0 + x1) / 2, (y0 + y1) / 2]
    }
    const who = Array.from({ length: n }, () => {
      const [x, y] = pick()
      return { k: this.kid(), x, y, target: pick(), speed: 20 + this.rnd() * 10, jump: 0, phase: this.rnd() * 6 }
    })
    // Tag: "it" counts to one first, and can't tag straight back the one who tagged them
    let it = 0
    let counting = 1
    let lastIt = -1
    let safe = 0
    this.behaviours.push((t, dt) => {
      counting -= dt
      safe -= dt
      who.forEach((w, i) => {
        const kid = this.kids[w.k]!
        let moving = false
        if (w.jump > 0) {
          w.jump -= dt
        } else if (!(i === it && counting > 0 && !chase)) {
          let target = w.target
          const quarry = chase?.()
          if (quarry) {
            if (Math.hypot(w.target[0] - w.x, w.target[1] - w.y) < 2) w.target = pick(quarry, 14)
            target = w.target
          } else if (i === it) {
            // It: after the nearest one (not the one who just tagged them)
            let best = -1
            let bd = Infinity
            who.forEach((o, j) => {
              if (j === i || (j === lastIt && safe > 0)) return
              const dd = Math.hypot(o.x - w.x, o.y - w.y)
              if (dd < bd) {
                bd = dd
                best = j
              }
            })
            if (best >= 0) {
              target = [who[best]!.x, who[best]!.y]
              if (bd < 2.5 * K) {
                // Caught! A jump for joy, and the other one is it
                w.jump = 0.6
                w.target = pick()
                lastIt = i
                it = best
                counting = 1
                safe = 2
              }
            }
          } else if (Math.hypot(w.target[0] - w.x, w.target[1] - w.y) < 2 || this.rnd() < dt * 0.3) {
            w.target = pick()
          }
          const dx = target[0] - w.x
          const dy = target[1] - w.y
          const dd = Math.hypot(dx, dy)
          if (dd > 1) {
            const sp = w.speed * (i === it && !chase ? 1.08 : 1)
            const step = Math.min(dd, sp * dt)
            const nx = w.x + (dx / dd) * step
            const ny = w.y + (dy / dd) * step
            if (pointInRing(ring, nx, ny)) {
              w.x = nx
              w.y = ny
            } else w.target = pick()
            kid.yaw = Math.atan2(dy, dx)
            moving = true
          }
          // Now and then, a hop for nothing at all
          if (this.rnd() < dt * 0.08) w.jump = 0.6
        }
        kid.x = w.x
        kid.y = w.y
        if (w.jump > 0) {
          const f = Math.sin((w.jump / 0.6) * Math.PI)
          kid.h = h + Math.max(0, f) * 3 * K
          kid.l = kid.r = 0
          kid.spread = 2.6 * Math.max(0, f)
        } else if (moving) {
          const s = Math.sin(t * 6.5 + w.phase)
          kid.h = h + Math.abs(s) * 0.6 * K
          kid.l = s * 1.0
          kid.r = -s * 1.0
          kid.spread = 0.15
        } else {
          // Counting, hands over eyes
          kid.h = h
          kid.l = kid.r = 2.9
          kid.spread = 0.1
        }
      })
    })
  }

  /** Children in a ring throwing a ball across to one another */
  private ballCircle(s: Spot, n: number, R: number, h: number) {
    const ks = Array.from({ length: n }, () => this.kid())
    R *= K
    const ball = this.ballPos.length
    this.ballPos.push({ x: s.x, y: s.y, h })
    let from = 0
    let to = 1
    let tt = 0
    const T = 1.15
    this.behaviours.push((t, dt) => {
      tt += dt
      if (tt > T) {
        tt = 0
        from = to
        to = (from + 1 + Math.floor(this.rnd() * (n - 1))) % n
      }
      const pos = (i: number): [number, number] => {
        const a = s.yaw + (i * 2 * Math.PI) / n + Math.sin(t * 0.7 + i) * 0.08
        return [s.x + Math.cos(a) * R, s.y + Math.sin(a) * R]
      }
      ks.forEach((k, i) => {
        const kid = this.kids[k]!
        const [x, y] = pos(i)
        kid.x = x
        kid.y = y
        kid.yaw = Math.atan2(s.y - y, s.x - x)
        const f = tt / T
        const catching = i === to && f > 0.55
        const throwing = i === from && f < 0.25
        kid.h = h + (catching ? Math.sin(((f - 0.55) / 0.45) * Math.PI) * 1.6 : Math.abs(Math.sin(t * 5 + i)) * 0.3) * K
        kid.l = kid.r = catching ? 2.8 : throwing ? 2.4 - f * 6 : 0.5
        kid.spread = catching ? 0.4 : 0.15
      })
      const [ax, ay] = pos(from)
      const [bx, by] = pos(to)
      const f = tt / T
      const b = this.ballPos[ball]!
      b.x = ax + (bx - ax) * f
      b.y = ay + (by - ay) * f
      b.h = h + (6 + Math.sin(f * Math.PI) * 9) * K
    })
  }

  /** Children splashing in the paddling pool, under jets of water */
  private splash(ring: Ring, n: number, h: number) {
    const [x0, y0, x1, y1] = ringBounds(ring)
    const pick = (): [number, number] => {
      for (let k = 0; k < 60; k++) {
        const x = x0 + this.rnd() * (x1 - x0)
        const y = y0 + this.rnd() * (y1 - y0)
        if (pointInRing(ring, x, y) && distToRing(ring, x, y) > 4) return [x, y]
      }
      return [(x0 + x1) / 2, (y0 + y1) / 2]
    }
    const who = Array.from({ length: n }, () => {
      const [x, y] = pick()
      return { k: this.kid(), x, y, target: pick(), phase: this.rnd() * 6, jumpy: this.rnd() < 0.5 }
    })
    this.behaviours.push((t, dt) => {
      for (const w of who) {
        const kid = this.kids[w.k]!
        const dx = w.target[0] - w.x
        const dy = w.target[1] - w.y
        const dd = Math.hypot(dx, dy)
        if (dd < 1.5) w.target = pick()
        else {
          w.x += (dx / dd) * Math.min(dd, 9 * dt)
          w.y += (dy / dd) * Math.min(dd, 9 * dt)
          kid.yaw = Math.atan2(dy, dx)
        }
        const j = w.jumpy ? Math.max(0, Math.sin(t * 5 + w.phase)) : 0
        kid.x = w.x
        kid.y = w.y
        // Knee-deep, jumping and splashing
        kid.h = h + (-1.2 + j * 2.2) * K
        kid.l = 1.6 + Math.sin(t * 11 + w.phase) * 1.2
        kid.r = 1.6 - Math.sin(t * 11 + w.phase) * 1.2
        kid.spread = 0.6 + j * 1.8
      }
    })
    // Fountains: jets of drops arching out of the water
    const jets = spots(ring, [8, 8, 8], this.rnd).map((s) => [s.x, s.y] as [number, number])
    const per = 70
    const count = jets.length * per
    const geo = new BufferGeometry()
    geo.setAttribute('position', new Float32BufferAttribute(new Float32Array(count * 3), 3))
    const mat = new PointsMaterial({ color: '#e6f7ff', size: 1.4 * K, sizeAttenuation: true, transparent: true, opacity: 0.9 })
    const points = new Points(geo, mat)
    points.frustumCulled = false
    this.group.add(points)
    this.disposables.push(geo, mat)
    this.spray = { points, jets, h, n: per }
  }

  /** Children on little bikes round the family course */
  private familyBikes(loop: Ring, n: number, h: number) {
    const cum = [0]
    for (let i = 1; i < loop.length; i++) cum.push(cum[i - 1]! + Math.hypot(loop[i]![0] - loop[i - 1]![0], loop[i]![1] - loop[i - 1]![1]))
    const L = cum[cum.length - 1]!
    const who = Array.from({ length: n }, () => ({ k: this.kid(), s: this.rnd() * L, speed: 16 + this.rnd() * 10, side: (this.rnd() - 0.5) * 2 }))
    this.bikeKids = who.map((w) => w.k)
    this.behaviours.push((_t, dt) => {
      for (const w of who) {
        w.s = (w.s + w.speed * dt) % L
        let j = 1
        while (j < cum.length - 1 && cum[j]! < w.s) j++
        const a = loop[j - 1]!
        const b = loop[j]!
        const len = cum[j]! - cum[j - 1]! || 1
        const f = (w.s - cum[j - 1]!) / len
        const dx = (b[0] - a[0]) / len
        const dy = (b[1] - a[1]) / len
        const kid = this.kids[w.k]!
        kid.x = a[0] + (b[0] - a[0]) * f + dy * w.side
        kid.y = a[1] + (b[1] - a[1]) * f - dx * w.side
        kid.h = h + 2.0 * K
        kid.yaw = Math.atan2(dy, dx)
        kid.l = kid.r = 1.3
        kid.spread = 0.1
      }
    })
  }

  private build() {
    const n = this.kids.length
    const geo = kidGeometries()
    // A team's colours where they have them, else one at random
    const pick = (i: number, colors: string[]) => {
      const kid = this.kids[i]!
      const own = colors === SHIRTS ? kid.shirt : colors === HATS ? kid.cap : undefined
      return own ?? colors[Math.floor(this.rnd() * colors.length)]!
    }
    const mk = (geometry: BufferGeometry, material: Material, colors?: string[]) => {
      const m = new InstancedMesh(geometry, material, n)
      m.castShadow = m.receiveShadow = true
      m.frustumCulled = false
      m.instanceMatrix.setUsage(DynamicDrawUsage)
      if (colors) for (let i = 0; i < n; i++) m.setColorAt(i, new Color(pick(i, colors)))
      this.group.add(m)
      this.disposables.push(geometry)
      return m
    }
    const body = mk(geo.body, this.cloth, SHIRTS)
    const armL = mk(geo.arm, this.cloth, [])
    const armR = mk(geo.arm.clone(), this.cloth, [])
    for (let i = 0; i < n; i++) {
      const c = new Color()
      body.getColorAt(i, c)
      armL.setColorAt(i, c)
      armR.setColorAt(i, c)
    }
    this.inst = { body, head: mk(geo.head, this.skin), hat: mk(geo.hat, this.cloth, HATS), armL, armR }

    const ballGeo = new SphereGeometry(1.25, 12, 8)
    this.balls = new InstancedMesh(ballGeo, this.cloth, Math.max(1, this.ballPos.length))
    this.balls.castShadow = true
    this.balls.frustumCulled = false
    this.ballPos.forEach((b, i) => this.balls.setColorAt(i, new Color(b.color ?? BALLS[i % BALLS.length]!)))
    this.group.add(this.balls)
    this.disposables.push(ballGeo)

    const bikeGeo = bicycle().scale(0.62, 0.62, 0.62)
    this.bikes = new InstancedMesh(bikeGeo, this.cloth, Math.max(1, this.bikeKids.length))
    this.bikes.castShadow = true
    this.bikes.frustumCulled = false
    this.bikeKids.forEach((_, i) => this.bikes.setColorAt(i, new Color(SHIRTS[(i * 3 + 1) % SHIRTS.length]!)))
    this.group.add(this.bikes)
    this.disposables.push(bikeGeo)
  }

  /** Moves everyone on by `dt` (s) at `now` (s) */
  update(dt: number, now: number): void {
    for (const b of this.behaviours) b(now, dt)
    // Turn to face the new way over a moment, not in one frame
    for (const kid of this.kids) {
      if (kid.face === undefined) kid.face = kid.yaw
      const d = Math.atan2(Math.sin(kid.yaw - kid.face), Math.cos(kid.yaw - kid.face))
      kid.face += Math.sign(d) * Math.min(Math.abs(d), dt * TURN)
    }

    const m = new Matrix4()
    const arm = new Matrix4()
    const q = new Quaternion()
    const up = new Vector3(0, 1, 0)
    const p = new Vector3()
    const s = new Vector3()
    const qa = new Quaternion()
    const ql = new Quaternion()
    const X = new Vector3(1, 0, 0)
    const Z = new Vector3(0, 0, 1)
    const { body, head, hat, armL, armR } = this.inst
    this.kids.forEach((kid, i) => {
      q.setFromAxisAngle(up, kid.face!)
      p.set(kid.x, kid.h, -kid.y)
      s.setScalar(K)
      m.compose(p, q, s)
      body.setMatrixAt(i, m)
      head.setMatrixAt(i, m)
      hat.setMatrixAt(i, m)
      // Arms: out to the side (about x), then forward (about z), from the shoulder
      for (const [mesh, side, swing] of [
        [armL, 1, kid.l],
        [armR, -1, kid.r],
      ] as const) {
        qa.setFromAxisAngle(X, -side * kid.spread)
        ql.setFromAxisAngle(Z, swing)
        qa.multiply(ql)
        arm.compose(new Vector3(0, SHOULDER, side * SHOULDER_SIDE), qa, new Vector3(1, 1, 1))
        mesh.setMatrixAt(i, m.clone().multiply(arm))
      }
    })
    for (const mesh of [body, head, hat, armL, armR]) mesh.instanceMatrix.needsUpdate = true

    this.ballPos.forEach((b, i) => {
      p.set(b.x, b.h, -b.y)
      s.setScalar(K)
      m.compose(p, q.identity(), s)
      this.balls.setMatrixAt(i, m)
    })
    this.balls.instanceMatrix.needsUpdate = true

    this.bikeKids.forEach((k, i) => {
      const kid = this.kids[k]!
      q.setFromAxisAngle(up, kid.yaw)
      p.set(kid.x, kid.h - 2.0 * K, -kid.y)
      s.setScalar(K)
      m.compose(p, q, s)
      this.bikes.setMatrixAt(i, m)
    })
    this.bikes.instanceMatrix.needsUpdate = true

    if (this.spray) {
      const { points, jets, h, n } = this.spray
      const pos = points.geometry.getAttribute('position')
      jets.forEach(([jx, jy], j) => {
        for (let i = 0; i < n; i++) {
          // Each drop on its own arc, out from the jet and back down
          const life = 1.3
          const tt = (now + (i / n) * life + j * 0.37) % life
          const a = i * 2.39996 + j
          const out = (3.2 + (i % 5) * 0.6) * K * 0.7
          const vy = (13 + (i % 3) * 1.5) * K * 0.7
          const fall = 22 * K * 0.7
          pos.setXYZ(j * n + i, jx + Math.cos(a) * out * tt, h + vy * tt - 0.5 * fall * tt * tt, -(jy + Math.sin(a) * out * tt))
        }
      })
      pos.needsUpdate = true
    }
  }

  dispose(): void {
    for (const x of this.disposables) x.dispose()
  }
}
