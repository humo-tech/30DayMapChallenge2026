// Day 23's plan coordinates: km on a Lambert conformal conic over Japan (GRS80, standard
// parallels 33° and 44°, centred on 137°E 36°N) — the projection scripts/day23/build_data.py
// writes the prefectures in. Ellipsoidal formulas from Snyder, "Map Projections: A Working Manual"
// (1987), §15.

const A = 6378.137 // km
const F = 1 / 298.257222101
const E = Math.sqrt(2 * F - F * F)
const RAD = Math.PI / 180
const LNG0 = 137 * RAD

const m = (phi: number) => Math.cos(phi) / Math.sqrt(1 - (E * Math.sin(phi)) ** 2)
const t = (phi: number) => Math.tan(Math.PI / 4 - phi / 2) / ((1 - E * Math.sin(phi)) / (1 + E * Math.sin(phi))) ** (E / 2)

const [P1, P2, P0] = [33 * RAD, 44 * RAD, 36 * RAD]
const N = (Math.log(m(P1)) - Math.log(m(P2))) / (Math.log(t(P1)) - Math.log(t(P2)))
const AF = (A * m(P1)) / (N * t(P1) ** N)
const RHO0 = AF * t(P0) ** N

/** lng/lat (degrees) -> plan km (x east, y north) */
export function toPlan(lng: number, lat: number): [number, number] {
  const rho = AF * t(lat * RAD) ** N
  const theta = N * (lng * RAD - LNG0)
  return [rho * Math.sin(theta), RHO0 - rho * Math.cos(theta)]
}

/** Plan km -> lng/lat (degrees) */
export function fromPlan(x: number, y: number): [number, number] {
  const dy = RHO0 - y
  const rho = Math.hypot(x, dy)
  const tt = (rho / AF) ** (1 / N)
  let phi = Math.PI / 2 - 2 * Math.atan(tt)
  for (let i = 0; i < 6; i++) {
    const s = E * Math.sin(phi)
    phi = Math.PI / 2 - 2 * Math.atan(tt * ((1 - s) / (1 + s)) ** (E / 2))
  }
  return [(Math.atan2(x, dy) / N + LNG0) / RAD, phi / RAD]
}
