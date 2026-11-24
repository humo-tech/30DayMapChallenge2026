// Day 25: games on Komazawa Olympic Park's pitches, played by the toy's children (toyKids.ts):
//
// - football on the football pitches and in the stadium: two small teams, the ball dribbled,
//   passed, won back and shot; a goal sets the scorers jumping for joy, then kick-off again;
// - baseball on the baseball fields: a diamond of red earth, the pitch, a big hit to the
//   outfield, a fielder running after it, and the batter round all four bases (a home run, every
//   time);
// - tennis on the courts: rallies.
//
// Every game is laid out along its pitch: u along it, v across, from its middle.
import { BufferGeometry, CylinderGeometry } from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { K, type Kids } from './toyKids'
import { mergeGeometries, painted, seeded, type Ring } from './toyPark'

/** A pitch as a rectangle: middle, angle of its length, length and width (m) */
export type Rect = { cx: number; cy: number; angle: number; L: number; W: number }

/** The rectangle round a ring along its principal axis */
export function rectOf(ring: Ring): Rect {
  const pts = ring.slice(0, -1)
  const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length
  const cy = pts.reduce((a, p) => a + p[1], 0) / pts.length
  let sxx = 0
  let syy = 0
  let sxy = 0
  for (const [x, y] of pts) {
    sxx += (x - cx) ** 2
    syy += (y - cy) ** 2
    sxy += (x - cx) * (y - cy)
  }
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy)
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  let u0 = Infinity
  let u1 = -Infinity
  let v0 = Infinity
  let v1 = -Infinity
  for (const [x, y] of pts) {
    const u = (x - cx) * c + (y - cy) * s
    const v = -(x - cx) * s + (y - cy) * c
    u0 = Math.min(u0, u)
    u1 = Math.max(u1, u)
    v0 = Math.min(v0, v)
    v1 = Math.max(v1, v)
  }
  // Centred on the box, not the vertices' mean
  const mu = (u0 + u1) / 2
  const mv = (v0 + v1) / 2
  return { cx: cx + mu * c - mv * s, cy: cy + mu * s + mv * c, angle, L: u1 - u0, W: v1 - v0 }
}

/** Plan point from a pitch's (u, v) */
function at(r: Rect, u: number, v: number): [number, number] {
  const c = Math.cos(r.angle)
  const s = Math.sin(r.angle)
  return [r.cx + u * c - v * s, r.cy + u * s + v * c]
}

const g = (geo: BufferGeometry, color: string) => painted(geo.index ? geo.toNonIndexed() : geo, color)

/** A white goal: two posts and a crossbar, a net of thin bars behind (facing +u) */
function goalGeometry(): BufferGeometry {
  const W = 7.3
  const H = 2.6
  const parts = [
    g(new CylinderGeometry(0.16, 0.16, H, 8).translate(0, H / 2, -W / 2), '#ffffff'),
    g(new CylinderGeometry(0.16, 0.16, H, 8).translate(0, H / 2, W / 2), '#ffffff'),
    g(new CylinderGeometry(0.16, 0.16, W, 8).rotateX(Math.PI / 2).translate(0, H, 0), '#ffffff'),
    g(new RoundedBoxGeometry(0.08, H, W, 1, 0.02).translate(-1.6, H / 2, 0), '#e8eef2'),
  ]
  return mergeGeometries(parts)!
}

const TEAMS: [string, string][] = [
  ['#e8483c', '#ffffff'],
  ['#2f7fe0', '#ffd23a'],
  ['#ffd23a', '#2f7fe0'],
  ['#35a364', '#ffffff'],
]

type Player = { k: number; team: 0 | 1; base: [number, number]; keeper: boolean; u: number; v: number; jump: number; phase: number; moving: boolean }

/** Football on pitch `r` at height `h`, two teams of `perTeam` */
export function football(kids: Kids, r: Rect, h: number, colours: number, perTeam = 3): void {
  const rnd = seeded(77 + colours)
  const L = r.L * 0.92
  const W = r.W * 0.9
  // Goals at both ends, facing in
  for (const side of [-1, 1]) {
    const [x, y] = at(r, side * (L / 2), 0)
    kids.set(goalGeometry(), x, y, h, r.angle + (side > 0 ? Math.PI : 0))
  }
  const teamColours = [TEAMS[colours % TEAMS.length]!, TEAMS[(colours + 1) % TEAMS.length]!]
  // A formation per team, attacking +u for team 0: keeper, then the rest spread up the pitch
  const shape: [number, number][] = [
    [-0.44, 0],
    [-0.12, -0.2],
    [0.02, 0.16],
    [-0.25, 0.22],
    [0.06, -0.14],
  ]
  const players: Player[] = []
  for (const team of [0, 1] as const) {
    for (let i = 0; i < perTeam; i++) {
      const [fu, fv] = shape[i % shape.length]!
      const dir = team === 0 ? 1 : -1
      const base: [number, number] = [fu * L * dir, fv * W * dir]
      const [shirt, cap] = teamColours[team]!
      players.push({ k: kids.kid(shirt, cap), team, base, keeper: i === 0, u: base[0], v: base[1], jump: 0, phase: rnd() * 6, moving: false })
    }
  }
  const ball = kids.ball('#ffffff')
  let owner: Player | undefined = players[perTeam + 3]
  let flight: { from: [number, number]; to: [number, number]; t: number; T: number; lift: number; shot: boolean; to_?: Player } | undefined
  let decide = 1
  // A moment after winning the ball when it can't be won straight back
  let hold = 0
  let celebrate = 0
  let bu = 0
  let bv = 0
  let bh = 0
  const kickOff = (team: 0 | 1) => {
    for (const p of players) {
      p.u = p.base[0] * 0.8
      p.v = p.base[1]
    }
    owner = players.find((p) => p.team === team && !p.keeper && p.base[0] * (team ? -1 : 1) > -0.05 * L)
    if (owner) {
      owner.u = 0
      owner.v = 0
    }
    flight = undefined
    decide = 1.2
  }
  kickOff(1)
  const speed = 20
  kids.every((t, dt) => {
    const goalU = (team: 0 | 1) => (team === 0 ? L / 2 : -L / 2)
    hold -= dt
    if (celebrate > 0) {
      celebrate -= dt
      if (celebrate <= 0) kickOff(owner?.team === 0 ? 1 : 0)
    } else if (flight) {
      flight.t += dt
      const f = Math.min(1, flight.t / flight.T)
      bu = flight.from[0] + (flight.to[0] - flight.from[0]) * f
      bv = flight.from[1] + (flight.to[1] - flight.from[1]) * f
      bh = Math.sin(f * Math.PI) * flight.lift
      if (f >= 1) {
        if (flight.shot && rnd() < 0.65) {
          // Goal! The scorers' team jumps for joy
          for (const p of players) if (p.team === owner?.team) p.jump = 1.6
          celebrate = 1.8
        } else {
          // Whoever's nearest takes it (sometimes the other side)
          let best = players[0]!
          let bd = Infinity
          for (const p of players) {
            const d = Math.hypot(p.u - bu, p.v - bv) - (p === flight.to_ ? 6 : 0)
            if (d < bd) {
              bd = d
              best = p
            }
          }
          owner = best
          decide = 0.6 + rnd() * 1.2
        }
        if (celebrate <= 0) flight = undefined
      }
    } else if (owner) {
      // On the ball: run at their goal, then pass ahead, or shoot when close
      const dir = owner.team === 0 ? 1 : -1
      decide -= dt
      if (decide <= 0) {
        const goal = goalU(owner.team)
        if (Math.abs(goal - owner.u) < L * 0.3) {
          flight = { from: [owner.u, owner.v], to: [goal, (rnd() - 0.5) * 6], t: 0, T: 0.6, lift: 2.5 * K, shot: true }
        } else {
          const mates = players.filter((p) => p.team === owner!.team && p !== owner && !p.keeper)
          const to = mates[Math.floor(rnd() * mates.length)]!
          const lead: [number, number] = [to.u + dir * 8, to.v]
          flight = { from: [owner.u, owner.v], to: lead, t: 0, T: 0.7, lift: 1.5 * K, shot: false, to_: to }
        }
      }
    }
    if (owner && !flight && celebrate <= 0) {
      const dir = owner.team === 0 ? 1 : -1
      bu = owner.u + dir * 1.2 * K
      bv = owner.v
      bh = 0
    }
    // Everyone: the one on the ball runs at goal, the nearest of the others goes for the ball,
    // the rest keep their shape shifted towards it; keepers stay home
    const chasers = new Set<Player>()
    for (const team of [0, 1] as const) {
      if (owner?.team === team && !flight) continue
      let best: Player | undefined
      let bd = Infinity
      for (const p of players) {
        if (p.team !== team || p.keeper) continue
        const d = Math.hypot(p.u - bu, p.v - bv)
        if (d < bd) {
          bd = d
          best = p
        }
      }
      if (best) chasers.add(best)
    }
    for (const p of players) {
      const kid = kids.pose(p.k)
      let tu: number
      let tv: number
      if (celebrate > 0) {
        tu = p.u
        tv = p.v
      } else if (p === owner && !flight) {
        tu = goalU(p.team)
        tv = p.v + Math.sin(t * 1.3 + p.phase) * 4
      } else if (chasers.has(p)) {
        tu = bu
        tv = bv
        // Win it back
        if (owner && !flight && hold <= 0 && owner.team !== p.team && Math.hypot(p.u - bu, p.v - bv) < 2.2 * K && rnd() < dt * 0.8) {
          owner = p
          decide = 0.5 + rnd()
          hold = 1.5
        }
      } else if (p.keeper) {
        tu = p.base[0]
        tv = Math.max(-4, Math.min(4, bv * 0.3))
      } else {
        tu = p.base[0] + bu * 0.55
        tv = p.base[1] + bv * 0.35
      }
      tu = Math.max(-L / 2, Math.min(L / 2, tu))
      tv = Math.max(-W / 2, Math.min(W / 2, tv))
      const du = tu - p.u
      const dv = tv - p.v
      const d = Math.hypot(du, dv)
      const sp = (p === owner ? 0.8 : 1) * speed
      // Off when well away from where they want to be, still once there (not flickering between)
      if (d > 3) p.moving = true
      else if (d < 0.8) p.moving = false
      const moving = p.moving
      if (moving) {
        const step = Math.min(d, sp * dt)
        p.u += (du / d) * step
        p.v += (dv / d) * step
      }
      const [x, y] = at(r, p.u, p.v)
      kid.x = x
      kid.y = y
      // Facing the way they run, else the ball
      const fu = moving ? du : bu - p.u
      const fv = moving ? dv : bv - p.v
      kid.yaw = r.angle + Math.atan2(fv, fu)
      if (p.jump > 0) {
        p.jump -= dt
        const j = Math.abs(Math.sin(p.jump * 7))
        kid.h = h + j * 3 * K
        kid.l = kid.r = 0
        kid.spread = 2.7
      } else if (moving) {
        const s = Math.sin(t * 6.5 + p.phase)
        kid.h = h + Math.abs(s) * 0.6 * K
        kid.l = s
        kid.r = -s
        kid.spread = 0.15
      } else {
        kid.h = h
        kid.l = kid.r = 0.3
        kid.spread = p.keeper ? 1.2 : 0.2
      }
    }
    const b = kids.ballAt(ball)
    const [x, y] = at(r, bu, bv)
    b.x = x
    b.y = y
    b.h = h + 1.25 * K * 0.6 + bh
  })
}

/** Baseball on field `ring` at height `h`: the diamond laid towards the field's middle */
export function baseball(kids: Kids, r: Rect, h: number, colours: number): void {
  const rnd = seeded(91 + colours)
  // Home plate near one end, the diamond opening towards the other
  const B = Math.max(24, r.L * 0.2)
  const home: [number, number] = [-r.L * 0.36, 0]
  const D = (k: number): [number, number] => {
    // Bases: 0 home, 1 first, 2 second, 3 third
    const a = Math.PI / 4
    if (k === 0 || k === 4) return home
    if (k === 1) return [home[0] + B * Math.cos(a), home[1] - B * Math.sin(a)]
    if (k === 2) return [home[0] + B * Math.SQRT2, home[1]]
    return [home[0] + B * Math.cos(a), home[1] + B * Math.sin(a)]
  }
  // The red earth of the infield, the bases and the mound
  const dirt = new RoundedBoxGeometry(B * 1.25, 0.12, B * 1.25, 1, 0.05).rotateY(Math.PI / 4)
  const [dx, dy] = at(r, home[0] + (B * Math.SQRT2) / 2, 0)
  kids.set(g(dirt.scale(1 / K, 1, 1 / K), '#cf8a55'), dx, dy, h, r.angle)
  for (let k = 0; k < 4; k++) {
    const [bx, by] = at(r, ...D(k))
    kids.set(g(new RoundedBoxGeometry(1.4, 0.3, 1.4, 1, 0.1).rotateY(Math.PI / 4), '#ffffff'), bx, by, h + 0.1, r.angle)
  }
  const mound = D(2).map((v, i) => (v + home[i]!) / 2) as [number, number]
  const [mx, my] = at(r, ...mound)
  kids.set(g(new CylinderGeometry(2.2, 2.8, 0.4, 20), '#c27a48'), mx, my, h + 0.05, r.angle)

  const [field, bat] = [TEAMS[(colours + 1) % TEAMS.length]!, TEAMS[colours % TEAMS.length]!]
  const fielder = (u: number, v: number) => ({ k: kids.kid(field[0], field[1]), u, v, hu: u, hv: v })
  const pitcher = fielder(...mound)
  const catcher = fielder(home[0] - 3.5, 0)
  const infield = [fielder(...shift(D(1), 6, 4)), fielder(...shift(D(3), 6, -4))]
  const outfield = [fielder(home[0] + B * 2.3, -B * 0.9), fielder(home[0] + B * 2.6, 0), fielder(home[0] + B * 2.3, B * 0.9)]
  const batter = { k: kids.kid(bat[0], bat[1]) }
  const ball = kids.ball('#ffffff')
  const T = 7.5
  let land: [number, number] = [0, 0]
  let catcherOf = outfield[1]!
  let lastCycle = -1
  kids.every((t, dt) => {
    const cyc = Math.floor(t / T)
    const p = (t % T) / T
    const tt = p * T
    if (cyc !== lastCycle) {
      lastCycle = cyc
      // Where this one goes: deep, somewhere across the outfield
      const a = (rnd() - 0.5) * 1.2
      const dist = B * (2.6 + rnd() * 0.9)
      land = [home[0] + Math.cos(a) * dist, Math.sin(a) * dist]
      catcherOf = outfield.reduce((a2, f) => (Math.hypot(f.hu - land[0], f.hv - land[1]) < Math.hypot(a2.hu - land[0], a2.hv - land[1]) ? f : a2))
    }
    const put = (k: number, u: number, v: number, hh: number, yawTo: [number, number], l: number, rr: number, spread: number) => {
      const kid = kids.pose(k)
      const [x, y] = at(r, u, v)
      kid.x = x
      kid.y = y
      kid.h = h + hh
      kid.yaw = r.angle + Math.atan2(yawTo[1] - v, yawTo[0] - u)
      kid.l = l
      kid.r = rr
      kid.spread = spread
    }
    // The ball: pitched (0-0.8 s), hit high and deep (0.8-3.0 s), thrown back in (4.0-5.0 s)
    let bu: number
    let bv: number
    let bh: number
    if (tt < 0.8) {
      const f = tt / 0.8
      bu = mound[0] + (home[0] - mound[0]) * f
      bv = mound[1]
      bh = 4 * K
    } else if (tt < 3.0) {
      const f = (tt - 0.8) / 2.2
      bu = home[0] + (land[0] - home[0]) * f
      bv = home[1] + (land[1] - home[1]) * f
      bh = 4 * K + Math.sin(f * Math.PI) * 26 * K * (1 - f * 0.2)
    } else if (tt < 4.0) {
      bu = catcherOf.u
      bv = catcherOf.v
      bh = 4.5 * K
    } else if (tt < 5.0) {
      const f = tt - 4.0
      bu = catcherOf.u + (mound[0] - catcherOf.u) * f
      bv = catcherOf.v + (mound[1] - catcherOf.v) * f
      bh = 4 * K + Math.sin(f * Math.PI) * 8 * K
    } else {
      bu = mound[0]
      bv = mound[1]
      bh = 4.5 * K
    }
    const b = kids.ballAt(ball)
    const [x, y] = at(r, bu, bv)
    b.x = x
    b.y = y
    b.h = h + bh

    // The pitcher winds up and throws; the catcher crouches; the infield on its toes
    const wind = tt < 0.8 ? Math.sin((tt / 0.8) * Math.PI) : 0
    put(pitcher.k, pitcher.u, pitcher.v, 0, home, 2.8 * wind, 0.4, 0.2)
    put(catcher.k, catcher.u, catcher.v, -0.8 * K, mound, 1.3, 1.3, 0.6)
    for (const f of infield) put(f.k, f.u, f.v, Math.abs(Math.sin(t * 4 + f.hu)) * 0.3 * K, home, 0.6, 0.6, 0.4)
    // The fielder nearest where it comes down runs for it and leaps; the others drift over
    for (const f of outfield) {
      const chase = f === catcherOf && tt > 0.9 && tt < 4.0
      const [gu, gv] = chase ? land : [f.hu, f.hv]
      const du = gu - f.u
      const dv = gv - f.v
      const d = Math.hypot(du, dv)
      const step = Math.min(d, 26 * dt)
      if (d > 0.5) {
        f.u += (du / d) * step
        f.v += (dv / d) * step
      }
      const leap = chase && tt > 2.6 && tt < 3.2 ? Math.sin(((tt - 2.6) / 0.6) * Math.PI) : 0
      const s = d > 0.5 ? Math.sin(t * 6.5 + f.hu) : 0
      put(f.k, f.u, f.v, (Math.abs(s) * 0.8 + leap * 5) * K, d > 0.5 ? [gu, gv] : home, leap ? 3 : s, leap ? 3 : -s, leap ? 0.3 : 0.15)
    }
    // The batter: waits, swings, then round the bases and a jump for joy at home
    if (tt < 0.8) {
      put(batter.k, home[0], home[1] + 3, 0, mound, 2.2, 2.2, 0.3)
    } else if (tt < 1.0) {
      const f = (tt - 0.8) / 0.2
      put(batter.k, home[0], home[1] + 3, 0, mound, 2.2 - f * 3.2, 2.2 - f * 3.2, 0.3 + f * 0.8)
    } else if (tt < 6.4) {
      const f = ((tt - 1.0) / 5.4) * 4
      const leg = Math.min(3, Math.floor(f))
      const a = D(leg)
      const c = D(leg + 1)
      const ff = f - leg
      const s = Math.sin(t * 7)
      put(batter.k, a[0] + (c[0] - a[0]) * ff, a[1] + (c[1] - a[1]) * ff, Math.abs(s) * 0.8 * K, c, s, -s, 0.15)
    } else {
      const j = Math.abs(Math.sin((tt - 6.4) * 6))
      put(batter.k, home[0], home[1], j * 3 * K, mound, 0, 0, 2.7)
    }
  })
}

function shift(p: [number, number], du: number, dv: number): [number, number] {
  return [p[0] + du, p[1] + dv]
}

/** Tennis on court area `r` at height `h`: a rally on each court that fits */
export function tennis(kids: Kids, r: Rect, h: number, colours: number): void {
  const courts = Math.max(1, Math.min(3, Math.floor(r.W / 22)))
  for (let c = 0; c < courts; c++) {
    const v0 = (c - (courts - 1) / 2) * (r.W / courts)
    const half = Math.min(r.L * 0.42, 24)
    const shirts = [TEAMS[(colours + c) % TEAMS.length]!, TEAMS[(colours + c + 2) % TEAMS.length]!]
    const a = kids.kid(shirts[0]![0], shirts[0]![1])
    const b = kids.kid(shirts[1]![0], shirts[1]![1])
    const ball = kids.ball('#d8f04a')
    const T = 1.3
    const phase = c * 0.7
    kids.every((t) => {
      const n = Math.floor((t + phase) / T)
      const f = ((t + phase) % T) / T
      // Where each shot goes across the court
      const side = (k: number) => Math.sin(k * 2.7 + c) * 4
      const fromA = n % 2 === 0
      const u0 = fromA ? -half : half
      const u1 = -u0
      const v1 = v0 + side(n + 1)
      const vFrom = v0 + side(n)
      const bu = u0 + (u1 - u0) * f
      const bv = vFrom + (v1 - vFrom) * f
      // Over the net, a bounce before it reaches them
      const bh = f < 0.75 ? Math.sin((f / 0.75) * Math.PI) * 7 * K * 0.5 + 2 * K : Math.sin(((f - 0.75) / 0.25) * Math.PI) * 2.5 * K + 1
      for (const [k, u, mine] of [
        [a, -half, !fromA],
        [b, half, fromA],
      ] as const) {
        const kid = kids.pose(k)
        // Each one moves across to meet the ball coming
        const v = mine ? vFrom + (v1 - vFrom) * Math.min(1, f * 1.2) : v0 + side(n)
        const [x, y] = at(r, u, v)
        kid.x = x
        kid.y = y
        kid.h = h + Math.abs(Math.sin(t * 5 + u)) * 0.3 * K
        kid.yaw = r.angle + (u < 0 ? 0 : Math.PI)
        // The swing as the ball arrives
        const swing = mine && f > 0.85 ? (f - 0.85) / 0.15 : 0
        kid.l = 0.4
        kid.r = 0.8 + swing * 2
        kid.spread = 0.3 + swing * 0.8
      }
      const ballRef = kids.ballAt(ball)
      const [x, y] = at(r, bu, bv)
      ballRef.x = x
      ballRef.y = y
      ballRef.h = h + bh
    })
  }
}
