// Day 28: the sound of a finger dragged over the ground, synthesized live with Web Audio from
// noise (as Day 11's thunder): the sea sloshes, ice hisses and now and then squeaks, snow
// crunches, a forest rustles, a town rumbles and thuds when it gives way. Each is a bed of
// filtered noise whose loudness follows how fast the finger goes over that ground, plus grains
// fired by the page.
import type { Material } from './feelGround'

type Bed = { gain: GainNode; level: number }

export class FeelVoice {
  private ctx = new AudioContext()
  private master: GainNode
  private beds = {} as Record<Material, Bed>
  private white: AudioBuffer
  private brown: AudioBuffer
  private townAm: GainNode

  constructor() {
    const { ctx } = this
    this.master = ctx.createGain()
    this.master.gain.value = 0.9
    const comp = ctx.createDynamicsCompressor()
    comp.threshold.value = -14
    this.master.connect(comp).connect(ctx.destination)

    const length = ctx.sampleRate * 4
    this.white = ctx.createBuffer(1, length, ctx.sampleRate)
    this.brown = ctx.createBuffer(1, length, ctx.sampleRate)
    const w = this.white.getChannelData(0)
    const b = this.brown.getChannelData(0)
    let last = 0
    for (let i = 0; i < length; i++) {
      w[i] = Math.random() * 2 - 1
      last = (last + 0.02 * w[i]!) / 1.02
      b[i] = last * 3.5
    }

    const loop = (buf: AudioBuffer) => {
      const s = ctx.createBufferSource()
      s.buffer = buf
      s.loop = true
      s.loopStart = Math.random()
      s.start(0, Math.random() * 3)
      return s
    }
    const filter = (type: BiquadFilterType, f: number, q = 0.7) => {
      const n = ctx.createBiquadFilter()
      n.type = type
      n.frequency.value = f
      n.Q.value = q
      return n
    }
    const lfo = (rate: number, depth: number, into: AudioParam) => {
      const o = ctx.createOscillator()
      o.frequency.value = rate
      const g = ctx.createGain()
      g.gain.value = depth
      o.connect(g).connect(into)
      o.start()
    }
    const bed = (m: Material, chain: AudioNode[]) => {
      const gain = ctx.createGain()
      gain.gain.value = 0
      chain.reduce((a, n) => (a.connect(n), n)).connect(gain).connect(this.master)
      this.beds[m] = { gain, level: 0 }
    }

    // Sea: brown noise through a low-pass that opens and closes (the slosh)
    const seaLp = filter('lowpass', 380, 1.2)
    lfo(0.7, 220, seaLp.frequency)
    bed('sea', [loop(this.brown), seaLp])
    // Ice: a thin high hiss
    bed('ice', [loop(this.white), filter('bandpass', 5_200, 2.5), filter('highpass', 2_500)])
    // Frozen lake: the same, lower and duller
    bed('lake', [loop(this.white), filter('bandpass', 2_600, 2)])
    // Snow: a soft packed hush under the crunches
    bed('snow', [loop(this.white), filter('bandpass', 1_200, 1.4)])
    // Forest: twigs and needles, a rustle that flutters
    const rustle = ctx.createGain()
    lfo(9, 0.6, rustle.gain)
    bed('forest', [loop(this.white), filter('highpass', 2_200), filter('lowpass', 7_000), rustle])
    // Town: a low grinding rumble that judders (ゴゴゴ)
    this.townAm = ctx.createGain()
    lfo(13, 0.8, this.townAm.gain)
    bed('town', [loop(this.brown), filter('lowpass', 140, 2), this.townAm])
  }

  resume() {
    void this.ctx.resume()
  }

  set muted(on: boolean) {
    const g = this.master.gain
    const now = this.ctx.currentTime
    g.cancelScheduledValues(now)
    g.setTargetAtTime(on ? 0 : 0.9, now, 0.08)
  }

  /** The finger is on `material`, going `speed` (0-1, 1 = a brisk swipe) over it */
  set(material: Material, speed: number) {
    const now = this.ctx.currentTime
    const LEVEL: Record<Material, number> = { sea: 1.6, ice: 0.35, lake: 0.4, snow: 0.35, forest: 0.45, town: 2.2 }
    for (const m of Object.keys(this.beds) as Material[]) {
      const bed = this.beds[m]
      const level = m === material ? LEVEL[m] * Math.min(1, speed) : 0
      if (Math.abs(level - bed.level) < 0.005) continue
      bed.level = level
      bed.gain.gain.setTargetAtTime(level, now, 0.05)
    }
  }

  /** A short burst of filtered noise */
  private grain(f: number, q: number, gain: number, dur: number, brown = false) {
    const { ctx } = this
    const now = ctx.currentTime
    const s = ctx.createBufferSource()
    s.buffer = brown ? this.brown : this.white
    const bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.frequency.value = f
    bp.Q.value = q
    const g = ctx.createGain()
    g.gain.setValueAtTime(0, now)
    g.gain.linearRampToValueAtTime(gain, now + 0.003)
    g.gain.exponentialRampToValueAtTime(0.001, now + dur)
    s.connect(bp).connect(g).connect(this.master)
    s.start(now, Math.random() * 3, dur + 0.05)
  }

  /** One step's crunch in the snow */
  crunch(strength: number) {
    this.grain(900 + Math.random() * 1_400, 1.5, 0.5 * strength, 0.05 + Math.random() * 0.05)
  }

  /** A twig */
  twig() {
    this.grain(2_500 + Math.random() * 3_000, 4, 0.25, 0.02)
  }

  /** A floe's edge: a short squeak */
  squeak(strength: number) {
    const { ctx } = this
    const now = ctx.currentTime
    const o = ctx.createOscillator()
    o.type = 'triangle'
    const f0 = 700 + Math.random() * 500
    o.frequency.setValueAtTime(f0, now)
    o.frequency.exponentialRampToValueAtTime(f0 * 1.6, now + 0.09)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0, now)
    g.gain.linearRampToValueAtTime(0.12 * strength, now + 0.01)
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.12)
    o.connect(g).connect(this.master)
    o.start(now)
    o.stop(now + 0.15)
  }

  /**
   * Floe on floe: a hollow knock, a dull tok with a short ring of ice in it, lower for the bigger
   * floes (`size` about 0.2-0.6)
   */
  knock(strength: number, size: number) {
    const { ctx } = this
    const now = ctx.currentTime
    const f0 = (520 + Math.random() * 160) * (0.45 / Math.max(0.15, size))
    for (const [ratio, gain, dur] of [
      [1, 0.35, 0.09],
      [2.76, 0.12, 0.05],
    ] as const) {
      const o = ctx.createOscillator()
      o.frequency.setValueAtTime(f0 * ratio, now)
      o.frequency.exponentialRampToValueAtTime(f0 * ratio * 0.92, now + dur)
      const g = ctx.createGain()
      g.gain.setValueAtTime(0, now)
      g.gain.linearRampToValueAtTime(gain * strength, now + 0.003)
      g.gain.exponentialRampToValueAtTime(0.001, now + dur)
      o.connect(g).connect(this.master)
      o.start(now)
      o.stop(now + dur + 0.02)
    }
    this.grain(f0 * 3, 3, 0.35 * strength, 0.03)
  }

  /** A town giving way: a low thud */
  thud(strength: number) {
    const { ctx } = this
    const now = ctx.currentTime
    const o = ctx.createOscillator()
    o.frequency.setValueAtTime(70, now)
    o.frequency.exponentialRampToValueAtTime(38, now + 0.25)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0, now)
    g.gain.linearRampToValueAtTime(0.9 * strength, now + 0.008)
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.3)
    o.connect(g).connect(this.master)
    o.start(now)
    o.stop(now + 0.35)
    this.grain(180, 1, 0.8 * strength, 0.18, true)
  }

  /** A slosh as the finger dips into the water */
  splash(strength: number) {
    this.grain(500 + Math.random() * 300, 0.8, 0.5 * strength, 0.35, true)
  }

  /** Crossing a contour */
  tick() {
    this.grain(3_200, 6, 0.12, 0.015)
  }

  dispose() {
    void this.ctx.close()
  }
}
