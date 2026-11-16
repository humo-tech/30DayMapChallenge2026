// Day 16's 20 seconds, as a script: I ask the runners around me "Where are you from?", they
// answer, and their homes show one by one on the map and the minimap; then faster and faster
// until everyone has answered, then the punchline, then the pull-back as the arcs grow.
//
// Times are seconds from the start of the piece. Everything here is a pure function of the
// time, so the page can just ask what's on at any frame.

/** The town names, and per runner [lng, lat, town index] (scripts/day16/scatter_homes.py) */
export type Homes = { towns: string[]; homes: [number, number, number][] }

/** The first few, asked one at a time: when I ask, when they answer, and from where */
const ONE_BY_ONE = [
  { ask: 1.0, answer: 1.8, town: 'Kobe, by the sea', text: 'Kobe!' },
  { ask: 2.9, answer: 3.6, town: 'Osaka', text: 'Osaka.' },
  { ask: 4.5, answer: 5.1, town: 'Sapporo', text: 'Sapporo!' },
  { ask: 5.9, answer: 6.4, town: 'Taipei', text: 'Taipei!' },
  { ask: 7.1, answer: 7.5, town: 'Himeji', text: 'Himeji.' },
]
const ANSWER_FOR = 0.9
/** Then everyone else, ever faster: I ask every ASK_EVERY s, someone answers every ANSWER_EVERY s */
const RUSH = { from: 8.2, to: 12.0, askEvery: 0.45, askFor: 0.3, answerEvery: 0.16, answerFor: 0.6 }
/** And then I own up */
export const PUNCHLINE = { from: 12.4, to: 15.0, text: '…is what I wanted to ask.' }
/** The camera pulls back, and the arcs grow out of the homes */
export const PULL_BACK = { at: 14.0, duration: 6.0 }
const GROW = { from: 14.5, to: 19.5 }
/** The minimap goes as the globe comes; the watermark comes after */
const MINIMAP_OUT = { from: 14.5, to: 16.0 }
const WATERMARK_IN = { from: 16.0, to: 18.0 }

export const ASK_TEXT = 'Where are you from?'

/** Who answers: an index into the runners near me (`nearMe()`) */
export type Bubble = { who: 'me' | number; text: string; key: string; pop: number }

const clamp01 = (x: number) => Math.min(1, Math.max(0, x))
const ramp = ({ from, to }: { from: number; to: number }, t: number) => clamp01((t - from) / (to - from))
const smooth = (x: number) => x * x * (3 - 2 * x)

/** How far into its life [from, from + length) a bubble is, eased in and out; 0 outside it */
function pop(t: number, from: number, length: number): number {
  const u = (t - from) / length
  if (u < 0 || u >= 1) return 0
  return Math.min(1, u / Math.min(0.15, 0.08 / length), (1 - u) / Math.min(0.2, 0.12 / length))
}

// mulberry32: a small seeded PRNG, so the order is the same every time
function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** "Kobe, by the sea" → "Kobe", "Toyonaka and Suita" → "Toyonaka" */
const shortName = (town: string) => town.split(/,| and /)[0]!.trim()

export class WhereFrom {
  /** Homes in the order they're told, and each home's rank in it */
  readonly order: number[]
  readonly rank: number[]
  private names: string[]

  constructor(private data: Homes) {
    const { towns, homes } = data
    const first = ONE_BY_ONE.map(({ town }) => homes.findIndex(([, , t]) => towns[t] === town))
    const random = seeded(16)
    const rest = homes.map((_, i) => i).filter((i) => !first.includes(i))
    for (let i = rest.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1))
      ;[rest[i], rest[j]] = [rest[j]!, rest[i]!]
    }
    this.order = [...first.filter((i) => i >= 0), ...rest]
    this.rank = new Array(homes.length)
    this.order.forEach((h, r) => (this.rank[h] = r))
    this.names = this.order.map((h) => shortName(towns[homes[h]![2]]!))
  }

  /** How many homes have shown by `t` */
  revealed(t: number): number {
    const told = ONE_BY_ONE.filter(({ answer }) => t >= answer).length
    if (t < RUSH.from) return told
    const n = this.data.homes.length
    // Slow at first, then pouring in
    return Math.min(n, told + (n - told) * ramp(RUSH, t) ** 2)
  }

  /** The bubbles up at `t` */
  bubbles(t: number): Bubble[] {
    const out: Bubble[] = []
    ONE_BY_ONE.forEach(({ ask, answer, text }, i) => {
      const asking = pop(t, ask, answer + 0.15 - ask)
      if (asking > 0) out.push({ who: 'me', text: ASK_TEXT, key: `ask${i}`, pop: asking })
      const answering = pop(t, answer, ANSWER_FOR)
      // (each from someone else around me)
      if (answering > 0) out.push({ who: i * 3, text, key: `answer${i}`, pop: answering })
    })
    if (t >= RUSH.from && t < RUSH.to + RUSH.answerFor) {
      const k = Math.floor((t - RUSH.from) / RUSH.askEvery)
      const asking = pop(t, RUSH.from + k * RUSH.askEvery, RUSH.askFor)
      if (asking > 0 && t < RUSH.to) out.push({ who: 'me', text: ASK_TEXT, key: `rushAsk${k}`, pop: asking })
      // The answers overlap: everyone still up from the last answerFor s
      const last = Math.floor((Math.min(t, RUSH.to) - RUSH.from) / RUSH.answerEvery)
      for (let j = Math.max(0, last - Math.ceil(RUSH.answerFor / RUSH.answerEvery)); j <= last; j++) {
        const at = RUSH.from + j * RUSH.answerEvery
        const p = pop(t, at, RUSH.answerFor)
        if (p <= 0) continue
        const name = this.names[Math.min(this.names.length - 1, Math.max(0, Math.floor(this.revealed(at)) - 1))]!
        // (from all over the field around me, so they don't pile up on each other)
        out.push({ who: 15 + ((j * 37) % 385), text: `${name}!`, key: `rush${j}`, pop: p })
      }
    }
    const owning = pop(t, PUNCHLINE.from, PUNCHLINE.to - PUNCHLINE.from)
    if (owning > 0) out.push({ who: 'me', text: PUNCHLINE.text, key: 'punchline', pop: owning })
    return out
  }

  /** How far the arcs have grown (0-1) */
  grow(t: number): number {
    return smooth(ramp(GROW, t))
  }

  /** The minimap's and the watermark's opacity */
  minimap(t: number): number {
    return 1 - smooth(ramp(MINIMAP_OUT, t))
  }
  watermark(t: number): number {
    return smooth(ramp(WATERMARK_IN, t))
  }
}
