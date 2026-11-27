// Day 28: how the map moves under a finger, by what the finger is on. The map is tied to the
// finger by a spring (stiffness k, damping c): stiff and light on ice, so it follows at once and
// slides on when let go; slack and heavy on the sea, so it lags behind and soon stops; in a town
// it sticks till the finger has pulled far enough, then lurches (stick-slip: ゴゴゴ). Slopes
// push back when the finger climbs and help it down. All in screen pixels, so it feels the same
// at any distance: (x, y) = (east, north).
import type { Material } from './feelGround'

export type Feel = {
  /** Spring to the finger (1/s²) */
  k: number
  /** Damping while held (1/s) */
  c: number
  /** How fast it slows once let go (1/s) */
  glide: number
  /** Random push while moving (px/s² per px/s of speed): brush, crunch */
  rough: number
  /** Static friction, as the stretch (px) the spring must reach before it gives; 0 = none */
  stick: number
}

export const FEELS: Record<Material, Feel> = {
  sea: { k: 7, c: 7.5, glide: 2.2, rough: 0, stick: 0 },
  ice: { k: 90, c: 3.5, glide: 0.12, rough: 0, stick: 0 },
  snow: { k: 45, c: 12, glide: 6, rough: 1.2, stick: 0 },
  forest: { k: 38, c: 15, glide: 8, rough: 3.5, stick: 0 },
  town: { k: 110, c: 9, glide: 14, rough: 0.6, stick: 46 },
  lake: { k: 70, c: 4.5, glide: 0.5, rough: 0.2, stick: 0 },
}

/** How hard a slope pushes (px/s² for a rise of 1 in 1) */
const SLOPE_PUSH = 2_600

export type Under = {
  material: Material
  amount: number
  /** Rise per metre (east, north) */
  slope: [number, number]
}

export type StepEvents = {
  /** A town gave way: how hard (0-1) */
  slip?: number
}

const mix = (a: Feel, b: Feel, t: number): Feel => ({
  k: a.k + (b.k - a.k) * t,
  c: a.c + (b.c - a.c) * t,
  glide: a.glide + (b.glide - a.glide) * t,
  rough: a.rough + (b.rough - a.rough) * t,
  stick: t < 0.5 ? a.stick : b.stick,
})

/** The feel of what is under the finger: thin ice is half sea, a sparse town half snow */
export function feelOf(u: Under): Feel {
  if (u.material === 'town') {
    const f = mix(FEELS.snow, FEELS.town, Math.min(1, 0.4 + u.amount))
    return { ...f, stick: FEELS.town.stick * (0.5 + Math.min(1, u.amount * 2)) }
  }
  return FEELS[u.material]
}

export class Slider {
  /** Where the map is, and how fast it is going (px, px/s) */
  pos = [0, 0]
  vel = [0, 0]
  /** Where the finger would have it */
  target = [0, 0]
  held = false
  private stuck = false
  private feel: Feel = FEELS.snow

  grab() {
    this.held = true
    this.target = [...this.pos]
    this.stuck = false
  }

  release() {
    this.held = false
    this.stuck = false
  }

  /** The finger moved by (dx, dy) px: the map should move the other way */
  drag(dx: number, dy: number) {
    this.target[0]! -= dx
    this.target[1]! -= dy
  }

  get speed() {
    return Math.hypot(this.vel[0]!, this.vel[1]!)
  }

  step(dt: number, under: Under, pxPerMetre: number): StepEvents {
    const ev: StepEvents = {}
    const want = feelOf(under)
    // Ease into a new feel over a few frames, except a town's grip, which takes hold at once
    const t = 1 - Math.exp(-dt * 25)
    this.feel = { ...mix(this.feel, want, t), stick: want.stick }
    const f = this.feel
    const [vx, vy] = this.vel as [number, number]
    const speed = Math.hypot(vx, vy)
    let ax = 0
    let ay = 0
    // Slopes: a rise ahead of the finger pushes back (the finger moves over the ground the way the
    // map's centre moves, +vel), a fall ahead helps it on
    const s = SLOPE_PUSH * Math.min(1, pxPerMetre * 2_000)
    ax -= under.slope[0] * s
    ay -= under.slope[1] * s
    if (this.held) {
      const ex = this.target[0]! - this.pos[0]!
      const ey = this.target[1]! - this.pos[1]!
      const stretch = Math.hypot(ex, ey)
      if (f.stick > 0) {
        if (this.stuck) {
          if (stretch < f.stick) {
            this.vel = [0, 0]
            return ev
          }
          this.stuck = false
          ev.slip = Math.min(1, stretch / (f.stick * 1.6))
        } else if (speed < 60 && stretch < f.stick * 0.35) {
          this.stuck = true
          this.vel = [0, 0]
          return ev
        }
      }
      ax += f.k * ex - f.c * vx
      ay += f.k * ey - f.c * vy
    } else {
      ax -= f.glide * vx
      ay -= f.glide * vy
      // Let go, it settles: no sliding down the hills for ever
      if (speed < 4) {
        this.vel = [0, 0]
        return ev
      }
    }
    if (f.rough > 0 && speed > 1) {
      ax += (Math.random() * 2 - 1) * f.rough * speed
      ay += (Math.random() * 2 - 1) * f.rough * speed
    }
    this.vel[0] = vx + ax * dt
    this.vel[1] = vy + ay * dt
    this.pos[0]! += this.vel[0]! * dt
    this.pos[1]! += this.vel[1]! * dt
    return ev
  }
}
