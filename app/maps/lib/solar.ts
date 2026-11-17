// Where the sun is, for a place and a moment (NOAA's low-precision solar position, good to ~0.01°).
// Only used for the readout and the daylight bar: the shadows themselves come from Navara's sun.

const RAD = Math.PI / 180

export type Sun = {
  /** degrees above the horizon (negative: below it) */
  altitude: number
  /** degrees clockwise from north */
  azimuth: number
}

export function sunAt(date: Date, lat: number, lng: number): Sun {
  const jd = date.getTime() / 86400000 + 2440587.5
  const n = jd - 2451545.0
  const L = (280.46 + 0.9856474 * n) % 360 // mean longitude
  const g = ((357.528 + 0.9856003 * n) % 360) * RAD // mean anomaly
  const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD // ecliptic longitude
  const eps = (23.439 - 0.0000004 * n) * RAD
  const decl = Math.asin(Math.sin(eps) * Math.sin(lambda))
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda))
  const gmst = (280.46061837 + 360.98564736629 * n) % 360
  const ha = (((gmst + lng) * RAD - ra) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI // hour angle
  const phi = lat * RAD
  const altitude = Math.asin(Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(ha))
  const azimuth = Math.atan2(-Math.sin(ha), Math.tan(decl) * Math.cos(phi) - Math.sin(phi) * Math.cos(ha))
  return { altitude: altitude / RAD, azimuth: ((azimuth / RAD) + 360) % 360 }
}

/** The minutes of the day (JST) the sun rises and sets at, or undefined in polar day / night */
export function daylightOf(day: string, lat: number, lng: number): { rise: number; set: number } | undefined {
  const midnight = new Date(`${day}T00:00:00+09:00`).getTime()
  let rise: number | undefined
  let set: number | undefined
  let prev = sunAt(new Date(midnight), lat, lng).altitude
  for (let m = 1; m <= 1440; m++) {
    const alt = sunAt(new Date(midnight + m * 60000), lat, lng).altitude
    // -0.833°: the sun's upper edge on the horizon, with refraction
    if (prev < -0.833 && alt >= -0.833) rise ??= m
    if (prev >= -0.833 && alt < -0.833) set ??= m
    prev = alt
  }
  return rise !== undefined && set !== undefined ? { rise, set } : undefined
}
