// Day 28: a world map's colours for each feeling, and the feelings read off a face. Six moods, each
// a palette for the same parts of the map (space, the ocean, the graticule, the countries' four
// shades, ice, lakes and rivers, borders, cities); the face's blendshapes (MediaPipe) weigh them,
// and the map wears the mix.

export const MOODS = ['calm', 'happy', 'sad', 'angry', 'surprised', 'sleepy'] as const
export type Mood = (typeof MOODS)[number]
export type Weights = Record<Mood, number>

// The parts of the world map, each painted per mood
export const ROLES = ['sky', 'ocean', 'grid', 'landA', 'landB', 'landC', 'landD', 'ice', 'water', 'border', 'city'] as const
export type Role = (typeof ROLES)[number]
export type Palette = Record<Role, string>

export const PALETTES: Record<Mood, Palette> = {
  // A school atlas
  calm: {
    sky: '#dfe6ee',
    ocean: '#cde2ef',
    grid: '#b3c9d9',
    landA: '#f2e6c9',
    landB: '#e1ebc9',
    landC: '#f3d8cd',
    landD: '#dcd7ea',
    ice: '#ffffff',
    water: '#a6cbe3',
    border: '#8e8a80',
    city: '#6b5e52',
  },
  // Sunny pastels
  happy: {
    sky: '#fff2c2',
    ocean: '#8fd9ff',
    grid: '#c2ecff',
    landA: '#ffd36e',
    landB: '#ffa3b8',
    landC: '#b6ef88',
    landD: '#ffc48a',
    ice: '#fffaf0',
    water: '#6cc8ff',
    border: '#ff8a5c',
    city: '#ff5f7e',
  },
  // A grey-blue rainy day
  sad: {
    sky: '#2b3542',
    ocean: '#384a5d',
    grid: '#4a5d72',
    landA: '#6a7c8f',
    landB: '#5c6f83',
    landC: '#728598',
    landD: '#637589',
    ice: '#9eafc1',
    water: '#2b3d51',
    border: '#93a6ba',
    city: '#c4d2e2',
  },
  // Molten: the world smoulders
  angry: {
    sky: '#100302',
    ocean: '#1d0705',
    grid: '#3c1008',
    landA: '#5e150c',
    landB: '#7c1b0e',
    landC: '#4a0f0a',
    landD: '#6a1a10',
    ice: '#2c0a06',
    water: '#0c0302',
    border: '#ff6a1a',
    city: '#ffd000',
  },
  // Neon pop
  surprised: {
    sky: '#0c0625',
    ocean: '#160b45',
    grid: '#3d22a6',
    landA: '#ff3ec8',
    landB: '#22e8ff',
    landC: '#b4ff2b',
    landD: '#ff9a1f',
    ice: '#ffffff',
    water: '#3d1aff',
    border: '#fff200',
    city: '#ffffff',
  },
  // Night: the world asleep, its cities lit
  sleepy: {
    sky: '#010309',
    ocean: '#040917',
    grid: '#0e1931',
    landA: '#0e1626',
    landB: '#111b2d',
    landC: '#0c1422',
    landD: '#131d30',
    ice: '#28334d',
    water: '#030711',
    border: '#24345a',
    city: '#ffd36a',
  },
}

const rgb = (h: string): [number, number, number] => {
  const n = parseInt(h.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
const CACHE = Object.fromEntries(
  MOODS.map((m) => [m, Object.fromEntries(ROLES.map((r) => [r, rgb(PALETTES[m][r])]))]),
) as Record<Mood, Record<Role, [number, number, number]>>

/** The palettes mixed by `w` (weights summing to 1): colours as 0-1 sRGB triples */
export function blend(w: Weights): Record<Role, [number, number, number]> {
  const colors = {} as Record<Role, [number, number, number]>
  for (const r of ROLES) {
    const c: [number, number, number] = [0, 0, 0]
    for (const m of MOODS) {
      const k = w[m]
      if (!k) continue
      const p = CACHE[m][r]
      c[0] += (p[0] / 255) * k
      c[1] += (p[1] / 255) * k
      c[2] += (p[2] / 255) * k
    }
    colors[r] = c
  }
  return colors
}

export const only = (m: Mood): Weights => Object.fromEntries(MOODS.map((k) => [k, k === m ? 1 : 0])) as Weights

/**
 * How much of each mood a face shows, from MediaPipe's blendshape scores (0-1 each). Each mood
 * past a small dead zone, so a still face is calm; calm takes what is left.
 */
export function moodsOf(b: Record<string, number>): Weights {
  const g = (k: string) => b[k] ?? 0
  const avg = (a: string, c: string) => (g(a) + g(c)) / 2
  const past = (x: number, from: number, to: number) => Math.min(1, Math.max(0, (x - from) / (to - from)))
  const smile = avg('mouthSmileLeft', 'mouthSmileRight')
  const frown = avg('mouthFrownLeft', 'mouthFrownRight')
  const browDown = avg('browDownLeft', 'browDownRight')
  const browUp = (g('browInnerUp') + avg('browOuterUpLeft', 'browOuterUpRight')) / 2
  const blink = avg('eyeBlinkLeft', 'eyeBlinkRight')
  const wide = avg('eyeWideLeft', 'eyeWideRight')
  const jaw = g('jawOpen')
  const sneer = avg('noseSneerLeft', 'noseSneerRight')
  const raw: Omit<Weights, 'calm'> = {
    happy: past(smile, 0.25, 0.7),
    sad: past(frown + g('browInnerUp') * 0.6 - smile, 0.15, 0.55),
    angry: past(browDown + sneer * 0.5, 0.25, 0.65),
    surprised: past(jaw * 0.6 + browUp * 0.5 + wide * 0.4, 0.3, 0.7),
    sleepy: past(blink, 0.45, 0.85),
  }
  const total = Object.values(raw).reduce((a, x) => a + x, 0)
  const scale = total > 1 ? 1 / total : 1
  const w = { calm: 0 } as Weights
  let used = 0
  for (const [k, x] of Object.entries(raw) as [Mood, number][]) {
    w[k] = x * scale
    used += w[k]
  }
  w.calm = 1 - used
  return w
}
