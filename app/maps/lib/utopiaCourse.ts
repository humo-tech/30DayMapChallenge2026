// The Day 8 course: a 2 km loop with gentle ups and downs, and the ground around it.
// World space: metres, y up; the loop wanders round the origin.

export const COURSE_M = 2000
export const ROAD_HALF_WIDTH = 3.5

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

// Road height along the loop (m): one long climb, a couple of rollers; at most ~3.5%
function roadHeight(s: number) {
  const a = (2 * Math.PI * s) / COURSE_M
  return 5 * Math.sin(a) + 2.2 * Math.sin(2 * a + 0.8) + 0.9 * Math.sin(3 * a + 2)
}

// Rolling meadows, rising into big soft mounds far from the loop
function hills(x: number, z: number) {
  const r = Math.hypot(x, z)
  return (
    3.5 * Math.sin(x * 0.013 + 1) * Math.cos(z * 0.011 - 0.5) +
    2 * Math.sin(x * 0.029 - z * 0.021 + 2) +
    1.2 * Math.cos(x * 0.05 + z * 0.043) +
    Math.max(0, r - 520) ** 1.25 * 0.1 * (0.7 + 0.3 * Math.sin(Math.atan2(z, x) * 5))
  )
}

const CELL = 32

export class Course {
  /** Samples every metre along the loop: position, unit tangent (xz), grade (%) */
  readonly x = new Float32Array(COURSE_M)
  readonly y = new Float32Array(COURSE_M)
  readonly z = new Float32Array(COURSE_M)
  readonly tx = new Float32Array(COURSE_M)
  readonly tz = new Float32Array(COURSE_M)
  readonly grade = new Float32Array(COURSE_M)
  private grid = new Map<string, number[]>()

  constructor() {
    // A wobbly loop in polar form, then rescaled to exactly COURSE_M and resampled per metre
    const n = 8000
    const raw: [number, number][] = []
    for (let k = 0; k <= n; k++) {
      const t = (2 * Math.PI * k) / n
      const r = 300 + 55 * Math.sin(2 * t + 0.4) + 35 * Math.sin(3 * t + 1.3) + 12 * Math.sin(5 * t)
      raw.push([r * Math.cos(t), r * Math.sin(t)])
    }
    const cum = [0]
    for (let k = 1; k <= n; k++) cum.push(cum[k - 1]! + Math.hypot(raw[k]![0] - raw[k - 1]![0], raw[k]![1] - raw[k - 1]![1]))
    const scale = COURSE_M / cum[n]!
    let k = 0
    for (let s = 0; s < COURSE_M; s++) {
      const target = s / scale
      while (cum[k + 1]! < target) k++
      const f = (target - cum[k]!) / (cum[k + 1]! - cum[k]!)
      this.x[s] = (raw[k]![0] + (raw[k + 1]![0] - raw[k]![0]) * f) * scale
      this.z[s] = (raw[k]![1] + (raw[k + 1]![1] - raw[k]![1]) * f) * scale
      this.y[s] = roadHeight(s)
    }
    for (let s = 0; s < COURSE_M; s++) {
      const a = (s + COURSE_M - 1) % COURSE_M
      const b = (s + 1) % COURSE_M
      const dx = this.x[b]! - this.x[a]!
      const dz = this.z[b]! - this.z[a]!
      const len = Math.hypot(dx, dz)
      this.tx[s] = dx / len
      this.tz[s] = dz / len
      this.grade[s] = ((roadHeight(s + 0.5) - roadHeight(s - 0.5)) / 1) * 100
      const key = `${Math.floor(this.x[s]! / CELL)},${Math.floor(this.z[s]! / CELL)}`
      if (!this.grid.has(key)) this.grid.set(key, [])
      this.grid.get(key)!.push(s)
    }
  }

  /** Linear interpolation of a per-metre array at distance s (wraps round the loop) */
  at(arr: Float32Array, s: number) {
    const w = ((s % COURSE_M) + COURSE_M) % COURSE_M
    const i = Math.floor(w)
    const f = w - i
    return arr[i]! + (arr[(i + 1) % COURSE_M]! - arr[i]!) * f
  }

  height(s: number) {
    return roadHeight(((s % COURSE_M) + COURSE_M) % COURSE_M)
  }

  /** The nearest point of the loop within about a grid cell (d is Infinity beyond that) */
  nearest(x: number, z: number): { d: number; s: number } {
    const cx = Math.floor(x / CELL)
    const cz = Math.floor(z / CELL)
    let best = Infinity
    let bestS = 0
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        for (const s of this.grid.get(`${cx + i},${cz + j}`) ?? []) {
          const d = (this.x[s]! - x) ** 2 + (this.z[s]! - z) ** 2
          if (d < best) {
            best = d
            bestS = s
          }
        }
      }
    }
    return { d: Math.sqrt(best), s: bestS }
  }

  /** Ground height: flat under the road, easing out into the hills */
  groundAt(x: number, z: number) {
    const { d, s } = this.nearest(x, z)
    const h = hills(x, z)
    if (!Number.isFinite(d)) return h
    const road = roadHeight(s) - 0.08
    return road + (h - road) * smoothstep(ROAD_HALF_WIDTH + 1.5, 30, d)
  }
}
