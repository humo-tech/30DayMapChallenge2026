// Day 28: the drift ice as floes a finger can shove about. Each floe is a disc in the sim (its
// drawn outline is ragged, see DriftIceMeshDesc.ts), laid where the day's satellite image shows
// ice, as close packed as the ice was. A finger is a disc too, that pushes floes out of its way;
// pushed floes push the next ones, glide on over the water (ice on water hardly slows), turn as
// they are struck off centre, rock, and settle. Floes keep off the land. Only floes that move are
// stepped; the rest sleep till something hits them.
//
// The sim's plane: metres east and north of an anchor, east scaled by the cosine of each point's
// own latitude, so it stays true across the few degrees of the Sea of Okhotsk in view.
import type { Ground } from './feelGround'

const M_PER_DEG = 110_950
const CELL = 3_000 // spatial hash cell (m)

export type Contact = {
  /** How hard (m/s of closing speed) */
  speed: number
  /** Where, in the sim's plane */
  x: number
  y: number
  /** The bigger of the two floes (m) */
  r: number
}

export class DriftIce {
  readonly count: number
  readonly x: Float64Array
  readonly y: Float64Array
  readonly vx: Float64Array
  readonly vy: Float64Array
  readonly r: Float32Array
  readonly ang: Float32Array
  readonly spin: Float32Array
  /** How hard it rocks now (0-1), and its rocking's phase */
  readonly rock: Float32Array
  readonly rockPhase: Float32Array
  /** Whether it has moved since the mesh last drew it */
  readonly dirty: Uint8Array
  private awake = new Set<number>()
  private cells = new Map<number, number[]>()
  private cellOf: Float64Array

  constructor(
    readonly anchor: { lng: number; lat: number },
    private readonly ground: Ground,
    /** Floe spacing (m) */
    spacing: number,
  ) {
    // Candidates on a fine jittered grid over the ice, each with a size drawn from a long tail
    // (many small floes, few big ones, as pack ice breaks), bigger where the ice was closer.
    // Then laid biggest first, each only where it fits clear of those already down and wholly on
    // the water: the small ones fill the gaps the big ones leave.
    const { west, east, south, north } = ground.meta
    let seed = 28
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    const fine = spacing * 0.45
    const rMin = spacing * 0.1
    const rMax = spacing * 1.1
    const cand: { x: number; y: number; r: number }[] = []
    for (let lat = south; lat < north; lat += fine / M_PER_DEG) {
      const step = fine / (M_PER_DEG * Math.cos((lat * Math.PI) / 180))
      for (let lng = west; lng < east; lng += step) {
        const jl = lng + (rnd() - 0.5) * step
        const jt = lat + ((rnd() - 0.5) * fine) / M_PER_DEG
        const s = ground.at(jl, jt)
        if (s.material !== 'ice' || rnd() > Math.pow(s.amount, 0.5)) continue
        const r = rMin * Math.pow(rMax / rMin, Math.pow(rnd(), 2.4) * (0.55 + 0.45 * s.amount))
        const [x, y] = this.toPlane(jl, jt)
        cand.push({ x, y, r })
      }
    }
    cand.sort((a, b) => b.r - a.r)
    const xs: number[] = []
    const ys: number[] = []
    const rs: number[] = []
    const grid = new Map<number, number[]>()
    const gap = spacing * 0.035
    for (const c of cand) {
      let clear = true
      const reach = Math.ceil((c.r + rMax) / CELL)
      const cx = Math.floor(c.x / CELL)
      const cy = Math.floor(c.y / CELL)
      for (let a = -reach; a <= reach && clear; a++)
        for (let b = -reach; b <= reach && clear; b++) {
          for (const j of grid.get((cx + a + 32768) * 65536 + cy + b + 32768) ?? []) {
            if (Math.hypot(xs[j]! - c.x, ys[j]! - c.y) < rs[j]! + c.r + gap) {
              clear = false
              break
            }
          }
        }
      if (!clear) continue
      // Wholly on the water: its rim, all round
      let wet = true
      for (let k = 0; k < 6 && wet; k++) {
        const a = (k / 6) * Math.PI * 2
        wet = this.onWater(c.x + Math.cos(a) * c.r, c.y + Math.sin(a) * c.r)
      }
      if (!wet) continue
      const key = (cx + 32768) * 65536 + cy + 32768
      let cell = grid.get(key)
      if (!cell) grid.set(key, (cell = []))
      cell.push(xs.length)
      xs.push(c.x)
      ys.push(c.y)
      rs.push(c.r)
    }
    const n = xs.length
    this.count = n
    this.x = Float64Array.from(xs)
    this.y = Float64Array.from(ys)
    this.r = Float32Array.from(rs)
    this.vx = new Float64Array(n)
    this.vy = new Float64Array(n)
    this.ang = new Float32Array(n).map(() => rnd() * Math.PI * 2)
    this.spin = new Float32Array(n)
    this.rock = new Float32Array(n)
    this.rockPhase = new Float32Array(n).map(() => rnd() * Math.PI * 2)
    this.dirty = new Uint8Array(n).fill(1)
    this.cellOf = new Float64Array(n)
    for (let i = 0; i < n; i++) this.insert(i)
  }

  toPlane(lng: number, lat: number): [number, number] {
    return [(lng - this.anchor.lng) * M_PER_DEG * Math.cos((lat * Math.PI) / 180), (lat - this.anchor.lat) * M_PER_DEG]
  }

  toLngLat(x: number, y: number): { lng: number; lat: number } {
    const lat = this.anchor.lat + y / M_PER_DEG
    return { lng: this.anchor.lng + x / (M_PER_DEG * Math.cos((lat * Math.PI) / 180)), lat }
  }

  private key(x: number, y: number) {
    return (Math.floor(x / CELL) + 32768) * 65536 + Math.floor(y / CELL) + 32768
  }

  private insert(i: number) {
    const k = this.key(this.x[i]!, this.y[i]!)
    this.cellOf[i] = k
    let c = this.cells.get(k)
    if (!c) this.cells.set(k, (c = []))
    c.push(i)
  }

  private rehash(i: number) {
    const k = this.key(this.x[i]!, this.y[i]!)
    if (k === this.cellOf[i]) return
    const c = this.cells.get(this.cellOf[i]!)!
    c.splice(c.indexOf(i), 1)
    this.insert(i)
  }

  /** Every floe in the cells round (x, y) */
  private near(x: number, y: number, f: (j: number) => void, reach = 1) {
    const cx = Math.floor(x / CELL) + 32768
    const cy = Math.floor(y / CELL) + 32768
    for (let a = -reach; a <= reach; a++)
      for (let b = -reach; b <= reach; b++) {
        const c = this.cells.get((cx + a) * 65536 + cy + b)
        if (c) for (const j of c) f(j)
      }
  }

  private wake(i: number) {
    this.awake.add(i)
  }

  private onWater(x: number, y: number) {
    const { lng, lat } = this.toLngLat(x, y)
    const m = this.ground.at(lng, lat).material
    return m === 'sea' || m === 'ice'
  }

  /** The floe under (x, y), if any */
  at(x: number, y: number): number | undefined {
    let hit: number | undefined
    this.near(x, y, (j) => {
      if (Math.hypot(this.x[j]! - x, this.y[j]! - y) < this.r[j]!) hit = j
    })
    return hit
  }

  /**
   * One step. `pusher`: the finger, a disc at (x, y) of radius r moving at (vx, vy) m/s, if it is
   * down. `scale`: metres per screen pixel, so the speeds that count as still and as a knock
   * follow what can be seen. Returns the knocks worth a sound.
   */
  step(dt: number, scale: number, pusher?: { x: number; y: number; r: number; vx: number; vy: number }): Contact[] {
    const contacts: Contact[] = []
    // Ice on water glides on: a little drag, more on the spin
    const drag = Math.exp(-dt * 0.9)
    const spinDrag = Math.exp(-dt * 2.2)
    const still = 6 * scale // m/s: under 6 px/s it sleeps

    if (pusher) {
      this.near(
        pusher.x,
        pusher.y,
        (j) => {
          const dx = this.x[j]! - pusher.x
          const dy = this.y[j]! - pusher.y
          const d = Math.hypot(dx, dy) || 1
          const overlap = pusher.r + this.r[j]! - d
          if (overlap <= 0) return
          const nx = dx / d
          const ny = dy / d
          // Out of the finger's way, and moving off at least as fast as the finger comes on
          this.x[j]! += nx * overlap
          this.y[j]! += ny * overlap
          const push = pusher.vx * nx + pusher.vy * ny
          const vn = this.vx[j]! * nx + this.vy[j]! * ny
          if (push > vn) {
            const dv = (push - vn) * 1.15
            this.vx[j]! += nx * dv
            this.vy[j]! += ny * dv
            // Struck off its centre, it turns
            const tx = pusher.vx - push * nx
            const ty = pusher.vy - push * ny
            this.spin[j]! += ((nx * ty - ny * tx) / this.r[j]!) * 0.15
            this.rock[j] = Math.min(1, this.rock[j]! + dv / (300 * scale))
            if (dv > 80 * scale) contacts.push({ speed: dv / scale, x: this.x[j]!, y: this.y[j]!, r: this.r[j]! })
          }
          this.rehash(j)
          this.dirty[j] = 1
          this.wake(j)
        },
        Math.ceil(pusher.r / CELL) + 1,
      )
    }

    for (const i of [...this.awake]) {
      const ox = this.x[i]!
      const oy = this.y[i]!
      this.x[i]! += this.vx[i]! * dt
      this.y[i]! += this.vy[i]! * dt
      // Not onto the land: back, and bounce off it, weakly
      if (!this.onWater(this.x[i]!, this.y[i]!)) {
        this.x[i] = ox
        this.y[i] = oy
        this.vx[i]! *= -0.25
        this.vy[i]! *= -0.25
      }
      this.vx[i]! *= drag
      this.vy[i]! *= drag
      this.ang[i]! += this.spin[i]! * dt
      this.spin[i]! *= spinDrag
      this.rock[i]! *= Math.exp(-dt * 1.4)
      this.rockPhase[i]! += dt * 5
      this.rehash(i)
      this.dirty[i] = 1

      // Knocks with the floes round it: apart, and the momentum shared (heavier = bigger)
      this.near(this.x[i]!, this.y[i]!, (j) => {
        if (j === i) return
        const dx = this.x[j]! - this.x[i]!
        const dy = this.y[j]! - this.y[i]!
        const d = Math.hypot(dx, dy) || 1
        const overlap = this.r[i]! + this.r[j]! - d
        if (overlap <= 0) return
        const nx = dx / d
        const ny = dy / d
        const mi = this.r[i]! ** 2
        const mj = this.r[j]! ** 2
        const wi = mj / (mi + mj)
        const wj = mi / (mi + mj)
        this.x[i]! -= nx * overlap * wi
        this.y[i]! -= ny * overlap * wi
        this.x[j]! += nx * overlap * wj
        this.y[j]! += ny * overlap * wj
        const rel = (this.vx[i]! - this.vx[j]!) * nx + (this.vy[i]! - this.vy[j]!) * ny
        if (rel > 0) {
          const e = 0.25 // ice on ice: a dull knock, little bounce
          const jimp = (1 + e) * rel
          this.vx[i]! -= nx * jimp * wi
          this.vy[i]! -= ny * jimp * wi
          this.vx[j]! += nx * jimp * wj
          this.vy[j]! += ny * jimp * wj
          // A glancing knock turns them both
          const tx = (this.vx[i]! - this.vx[j]!) - rel * nx
          const ty = (this.vy[i]! - this.vy[j]!) - rel * ny
          const t = (nx * ty - ny * tx) * 0.05
          this.spin[i]! += t / this.r[i]!
          this.spin[j]! -= t / this.r[j]!
          this.rock[j] = Math.min(1, this.rock[j]! + rel / (400 * scale))
          if (rel > 60 * scale) contacts.push({ speed: rel / scale, x: this.x[j]!, y: this.y[j]!, r: Math.max(this.r[i]!, this.r[j]!) })
        }
        this.rehash(j)
        this.dirty[j] = 1
        this.wake(j)
      })

      const moving = Math.hypot(this.vx[i]!, this.vy[i]!) > still || this.rock[i]! > 0.02
      if (!moving) {
        this.vx[i] = this.vy[i] = 0
        this.spin[i] = 0
        this.rock[i] = 0
        this.awake.delete(i)
      }
    }
    return contacts
  }

  get moving() {
    return this.awake.size
  }
}
