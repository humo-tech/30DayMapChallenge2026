// Day 23's six autumn flavours as small 3D models, each about 1 unit across its round part.
//
// Each is one geometry with its colours in the vertices (skin, streaks, stem, calyx), so a whole
// heap of one kind is a single instanced draw. Bodies are lathed (turned like a pot on a wheel)
// from a profile, then nudged: a persimmon squared off, a chestnut flattened on one side, the
// apple's blush streaked. `parts` are what the heaps stack with: a few balls that roughly fill
// its shape (one for an apple, a flat ring of them for a persimmon, a row for a sweet potato).
// Kept low-poly: a piece is a few dozen pixels across at most, and there are thousands.
import { BufferGeometry, Color, CylinderGeometry, Float32BufferAttribute, LatheGeometry, SphereGeometry, Vector2 } from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

export type FruitKey = 'ringo' | 'kaki' | 'nashi' | 'budou' | 'kuri' | 'kansho'

export type Fruit = {
  geometry: BufferGeometry
  /** Balls filling its shape, for stacking: [x, y, z, r] in model units (y up) */
  parts: [number, number, number, number][]
  roughness: number
  clearcoat: number
}

// A cheap, smooth value noise over the angle around and the height, so streaks wrap around seamlessly
function hash(n: number) {
  const s = Math.sin(n * 127.1) * 43758.5453
  return s - Math.floor(s)
}
function noise1(x: number, period: number) {
  const i = Math.floor(x)
  const f = x - i
  const u = f * f * (3 - 2 * f)
  return hash(((i % period) + period) % period) * (1 - u) + hash((((i + 1) % period) + period) % period) * u
}

type Profile = (a: number) => { r: number; y: number }

/** A body turned from `profile` (a: 0 at the bottom pole to π at the top), coloured by `paint` */
function lathe(profile: Profile, paint: (phi: number, a: number, c: Color) => void, rings = 14, segments = 20) {
  const pts: Vector2[] = []
  for (let i = 0; i <= rings; i++) {
    const a = (i / rings) * Math.PI
    const { r, y } = profile(a)
    pts.push(new Vector2(Math.max(r, 1e-4), y))
  }
  const g = new LatheGeometry(pts, segments)
  const colors: number[] = []
  const c = new Color()
  // LatheGeometry: vertex (segment i, profile point j) at index i * (rings + 1) + j
  for (let i = 0; i <= segments; i++) {
    const phi = (i / segments) * Math.PI * 2
    for (let j = 0; j <= rings; j++) {
      paint(phi, (j / rings) * Math.PI, c)
      colors.push(c.r, c.g, c.b)
    }
  }
  g.setAttribute('color', new Float32BufferAttribute(colors, 3))
  return g
}

function painted(g: BufferGeometry, color: string) {
  const c = new Color(color)
  const n = g.getAttribute('position').count
  g.setAttribute('color', new Float32BufferAttribute(Array.from({ length: n * 3 }, (_, i) => [c.r, c.g, c.b][i % 3]!), 3))
  return g
}

function merge(parts: BufferGeometry[]) {
  const flat = parts.map((p) => {
    const q = p.index ? p.toNonIndexed() : p
    for (const name of Object.keys(q.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'color') q.deleteAttribute(name)
    return q
  })
  const g = mergeGeometries(flat)!
  g.computeBoundingSphere()
  return g
}

// 'plain': one flat colour per part (skin, stem, calyx), no streaks or speckles, all matte, like
// painted clay; for a pared-down map, where the 'real' skins look out of place
let plain = false
const flat = (c: Color, color: string) => (c.set(color), true)

const mix = (c: Color, a: string, b: string, t: number) => c.set(a).lerp(new Color(b), Math.min(1, Math.max(0, t)))

function apple(): Fruit {
  const body = lathe(
    (a) => {
      const top = Math.exp(-(((Math.PI - a) / 0.42) ** 2))
      const bottom = Math.exp(-((a / 0.38) ** 2))
      return { r: Math.sin(a) * (1 + 0.07 * -Math.cos(a)), y: -Math.cos(a) * 0.86 - 0.26 * top + 0.14 * bottom }
    },
    (phi, a, c) => {
      if (plain) return flat(c, '#cf3027')
      // Deep red, streaked toward yellow-green low on one side, paler round the stem's hollow
      const streak = noise1(phi * 5.73, 36) * 0.6 + noise1(phi * 17.2, 108) * 0.4
      const shade = Math.max(0, Math.cos(phi - 0.6)) * (1 - a / Math.PI) * 1.2
      mix(c, '#a5121c', '#d8a43a', streak * shade * 0.8)
      if (a > 2.75) c.lerp(new Color('#c9b04a'), (a - 2.75) * 1.6)
    },
  )
  const stem = painted(new CylinderGeometry(0.035, 0.05, 0.34, 6).translate(0.03, 0.66, 0).rotateZ(-0.12), '#4a3020')
  return { geometry: merge([body, stem]), parts: [[0, -0.08, 0, 0.9]], roughness: 0.35, clearcoat: 0.6 }
}

function persimmon(): Fruit {
  const body = lathe(
    (a) => {
      const top = Math.exp(-(((Math.PI - a) / 0.5) ** 2))
      return { r: Math.sin(a) * 1.05 * (1 - 0.05 * Math.cos(a)), y: -Math.cos(a) * 0.7 - 0.08 * top }
    },
    (phi, a, c) => {
      if (plain) return flat(c, '#ee7a22')
      mix(c, '#e0661a', '#c2410e', (a / Math.PI) ** 2 * 0.8 + noise1(phi * 6, 36) * 0.15)
    },
  )
  // Squared off: four soft corners round the middle
  const p = body.getAttribute('position')
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i)
    const z = p.getZ(i)
    const k = 1 + 0.045 * Math.cos(4 * Math.atan2(z, x))
    p.setXYZ(i, x * k, p.getY(i), z * k)
  }
  body.computeVertexNormals()
  // The calyx: four broad, dull green-brown leaves lying on top, and a stub of a stem
  const leaves = [0, 1, 2, 3].map((i) =>
    painted(
      new SphereGeometry(0.3, 8, 4)
        .scale(1, 0.12, 0.62)
        .translate(0.26, 0.69, 0)
        .rotateY((i * Math.PI) / 2 + 0.4),
      '#5b5a26',
    ),
  )
  const stem = painted(new CylinderGeometry(0.05, 0.06, 0.12, 6).translate(0, 0.76, 0), '#3e3218')
  // Squat: a middle ball and four round it, no taller than the fruit
  const parts: Fruit['parts'] = [[0, 0, 0, 0.68], [0.42, 0, 0, 0.62], [-0.42, 0, 0, 0.62], [0, 0, 0.42, 0.62], [0, 0, -0.42, 0.62]]
  return { geometry: merge([body, ...leaves, stem]), parts, roughness: 0.3, clearcoat: 0.8 }
}

function pear(): Fruit {
  const body = lathe(
    (a) => {
      const top = Math.exp(-(((Math.PI - a) / 0.35) ** 2))
      const bottom = Math.exp(-((a / 0.35) ** 2))
      return { r: Math.sin(a) * 1.02, y: -Math.cos(a) * 0.88 - 0.12 * top + 0.12 * bottom }
    },
    (phi, a, c) => {
      if (plain) return flat(c, '#dcaa48')
      // Russet gold, freckled with pale lenticels
      const freckle = hash(Math.floor(phi * 9) * 31 + Math.floor(a * 9))
      mix(c, '#c9963f', '#a8722e', noise1(phi * 4, 24) * 0.6 + (a / Math.PI) * 0.3)
      if (freckle > 0.82) c.lerp(new Color('#e8cf8a'), 0.45)
    },
    16,
    24,
  )
  const stem = painted(new CylinderGeometry(0.03, 0.04, 0.3, 5).translate(0, 0.84, 0), '#5a3d22')
  return { geometry: merge([body, stem]), parts: [[0, 0, 0, 0.94]], roughness: 0.62, clearcoat: 0.05 }
}

function grapes(): Fruit {
  // A bunch: seven big berries (so it still reads as grapes from far off), three at the
  // shoulders, three below, one at the tip
  const berries: BufferGeometry[] = []
  const rows = [
    { y: 0.38, r: 0.34, n: 3 },
    { y: -0.08, r: 0.3, n: 3 },
    { y: -0.52, r: 0, n: 1 },
  ]
  rows.forEach((row, i) => {
    for (let k = 0; k < row.n; k++) {
      const t = (k / row.n) * Math.PI * 2 + i * (Math.PI / 3)
      const b = new SphereGeometry(0.4, 12, 8).translate(Math.cos(t) * row.r, row.y, Math.sin(t) * row.r)
      // Deep purple with a dusty bloom, each berry a touch different
      painted(b, '#3a1d4a')
      const col = b.getAttribute('color')
      const pos = b.getAttribute('position')
      const tint = hash(i * 13 + k)
      for (let v = 0; v < col.count; v++) {
        const up = pos.getY(v) - row.y
        const c = plain ? new Color('#52278a') : new Color().set('#2e1240').lerp(new Color('#6a4a86'), 0.25 + 0.35 * tint + up * 0.45)
        col.setXYZ(v, c.r, c.g, c.b)
      }
      berries.push(b)
    }
  })
  const stem = painted(new CylinderGeometry(0.04, 0.06, 0.4, 5).translate(0, 0.9, 0), '#6b5a2e')
  // Laid on its side, the long way along x
  const geometry = merge([...berries, stem]).translate(0, -0.08, 0).rotateZ(Math.PI / 2)
  // Shoulders (now at -x) wide, tapering to the tip at +x
  const parts: Fruit['parts'] = [[-0.3, 0, 0, 0.72], [0.16, 0, 0, 0.66], [0.6, 0, 0, 0.42]]
  return { geometry, parts, roughness: 0.42, clearcoat: 0.25 }
}

function chestnut(): Fruit {
  const body = lathe(
    (a) => {
      // Plump: round below, drawn up into a short point
      const t = a / Math.PI
      return { r: Math.sin(a) * (1 - 0.28 * t * t), y: -Math.cos(a) * 0.82 + 0.1 * t * t }
    },
    (phi, a, c) => {
      // (plain: the dark brown head and the broad pale base, a clean line between them)
      if (plain) return flat(c, a < 1.05 ? '#e6cf9f' : '#76361a')
      // Glossy chestnut brown with fine darker lines, the rough base pale and matte-looking
      const lines = noise1(phi * 14, 84)
      mix(c, '#7a3b1a', '#3f1d0c', lines * 0.5 + (a / Math.PI) * 0.35)
      if (a < 1.1) c.lerp(new Color('#d4b886'), Math.min(1, (1.1 - a) * 4))
    },
  )
  body.scale(1, 1, 0.82) // a little flat on one side
  // Lying on its flat side, the pale base turned out sideways (to +z) where it can be seen
  body.rotateX(-1.25)
  body.computeVertexNormals()
  return { geometry: merge([body]), parts: [[0, 0, 0, 0.76]], roughness: 0.25, clearcoat: 1.0 }
}

function sweetPotato(): Fruit {
  const body = lathe(
    (a) => {
      // A spindle, plump in the middle and tapering to both ends, a little lumpy
      const s = Math.sin(a)
      return { r: 0.48 * s ** 0.75 * (1 + 0.08 * Math.sin(a * 5)), y: -Math.cos(a) * 1.25 }
    },
    (phi, a, c) => {
      if (plain) return flat(c, '#ae2f60')
      mix(c, '#9a2a57', '#5e1636', noise1(phi * 5 + a * 3, 30) * 0.7)
      if (hash(Math.floor(phi * 7) * 17 + Math.floor(a * 6)) > 0.9) c.lerp(new Color('#3a0e22'), 0.5)
    },
  )
  body.rotateZ(Math.PI / 2) // long way along x
  return { geometry: merge([body]), parts: [[-0.72, 0, 0, 0.38], [0, 0, 0, 0.48], [0.72, 0, 0, 0.38]], roughness: 0.55, clearcoat: 0.1 }
}

export const FRUIT_KEYS: FruitKey[] = ['ringo', 'kaki', 'nashi', 'budou', 'kuri', 'kansho']

export function makeFruits(style: 'real' | 'plain' = 'real'): Record<FruitKey, Fruit> {
  plain = style === 'plain'
  const fruits = { ringo: apple(), kaki: persimmon(), nashi: pear(), budou: grapes(), kuri: chestnut(), kansho: sweetPotato() }
  if (plain) for (const f of Object.values(fruits)) Object.assign(f, { roughness: 0.8, clearcoat: 0 })
  plain = false
  return fruits
}
