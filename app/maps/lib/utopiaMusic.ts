// Day 8 background music, played live with Web Audio: a 16-bar music-box tune over oom-pah bass,
// a soft pad and a light bouncy beat, with a little room reverb. Nothing to download.

const BPM = 112
const SWING = 0.56 // where the off-beat eighth falls within the beat

// Melody, eight eighths a bar (MIDI notes; 0 is a rest)
const MELODY = [
  [76, 79, 84, 79, 76, 0, 79, 0], [81, 0, 84, 0, 83, 81, 79, 0], [77, 81, 84, 81, 77, 0, 81, 0], [79, 0, 83, 0, 86, 0, 83, 0],
  [84, 0, 83, 84, 88, 0, 86, 84], [81, 0, 76, 0, 81, 83, 84, 0], [86, 84, 81, 77, 79, 0, 83, 0], [84, 0, 79, 0, 84, 0, 0, 0],
  [81, 0, 84, 0, 89, 0, 88, 86], [86, 0, 83, 0, 79, 0, 83, 86], [88, 0, 83, 0, 79, 0, 76, 0], [81, 0, 84, 0, 88, 86, 84, 83],
  [81, 0, 77, 0, 81, 0, 84, 0], [83, 0, 86, 0, 91, 0, 89, 0], [88, 86, 84, 0, 81, 0, 84, 0], [86, 0, 0, 0, 83, 0, 0, 0],
].flat()

// Chords, one per half bar: bass root and pad voicing
const C = { root: 36, pad: [60, 64, 67] }
const Am = { root: 45, pad: [57, 60, 64] }
const F = { root: 41, pad: [57, 60, 65] }
const G = { root: 43, pad: [55, 59, 62] }
const G7 = { root: 43, pad: [53, 59, 62] }
const Dm = { root: 38, pad: [57, 62, 65] }
const Em = { root: 40, pad: [55, 59, 64] }
const CHORDS = [
  C, C, Am, Am, F, F, G, G, C, C, Am, Am, Dm, G, C, C,
  F, F, G, G, Em, Em, Am, Am, F, F, G7, G7, C, Am, Dm, G,
]

const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12)

export class MusicBox {
  /** Tempo multiplier, e.g. for a fast-forwarded recording */
  speed = 1
  private ctx: BaseAudioContext
  private master: GainNode
  private dry: GainNode
  private wet: GainNode
  private noise: AudioBuffer
  private timer?: ReturnType<typeof setInterval>
  private step = 0 // eighth notes since the start
  private nextAt = 0

  // An OfflineAudioContext renders the music to a file instead
  constructor(ctx: BaseAudioContext = new AudioContext()) {
    this.ctx = ctx
    this.master = ctx.createGain()
    this.dry = ctx.createGain()
    this.wet = ctx.createGain()
    const comp = ctx.createDynamicsCompressor()
    this.master.gain.value = 0
    this.master.connect(comp).connect(ctx.destination)
    this.dry.connect(this.master)
    // Reverb: a convolver with two seconds of decaying noise
    const verb = ctx.createConvolver()
    const ir = ctx.createBuffer(2, ctx.sampleRate * 2, ctx.sampleRate)
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch)
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length) ** 3
    }
    verb.buffer = ir
    this.wet.gain.value = 0.35
    this.wet.connect(verb).connect(this.master)
    this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate)
    const n = this.noise.getChannelData(0)
    for (let i = 0; i < n.length; i++) n[i] = Math.random() * 2 - 1
  }

  /** Fade in (or out) over a second; playing starts on the first fade in */
  set playing(on: boolean) {
    const { ctx } = this
    if (ctx instanceof AudioContext) void ctx.resume()
    const g = this.master.gain
    g.cancelScheduledValues(ctx.currentTime)
    g.setValueAtTime(g.value, ctx.currentTime)
    g.linearRampToValueAtTime(on ? 0.5 : 0, ctx.currentTime + 1)
    if (on && !this.timer) {
      this.nextAt = ctx.currentTime + 0.1
      // Schedule a little ahead on a timer, so timing doesn't hang on the frame rate
      this.timer = setInterval(() => this.schedule(), 25)
    }
  }

  dispose() {
    clearInterval(this.timer)
    if (this.ctx instanceof AudioContext) void this.ctx.close()
  }

  /** Volume without the fade in, for rendering */
  set volume(v: number) {
    this.master.gain.value = v
  }

  /** Schedule every note starting before `until` (s) */
  schedule(until = this.ctx.currentTime + 0.15) {
    while (this.nextAt < until) {
      const beat = 60 / (BPM * this.speed)
      const i = this.step % MELODY.length
      const eighth = i % 8
      // Swing: the off-beat eighth lands late, the next on-beat on time
      const t = this.nextAt + (eighth % 2 ? beat * (SWING - 0.5) : 0)
      const note = MELODY[i]!
      if (note) this.bell(t, hz(note))
      const chord = CHORDS[Math.floor(i / 4)]!
      if (eighth % 4 === 0) {
        this.pad(t, chord.pad, beat * 2)
        this.bass(t, hz(chord.root))
      } else if (eighth % 4 === 2) {
        this.bass(t, hz(chord.root + 12))
      }
      if (eighth === 0 || eighth === 4) this.kick(t)
      if (eighth === 2 || eighth === 6) this.snap(t)
      if (eighth % 2) this.shaker(t)
      this.step++
      this.nextAt += beat / 2
    }
  }

  private env(t: number, peak: number, attack: number, decay: number, send = 0.5) {
    const g = this.ctx.createGain()
    g.gain.setValueAtTime(0, t)
    g.gain.linearRampToValueAtTime(peak, t + attack)
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay)
    g.connect(this.dry)
    if (send) {
      const s = this.ctx.createGain()
      s.gain.value = send
      g.connect(s).connect(this.wet)
    }
    return g
  }

  private osc(type: OscillatorType, freq: number, t: number, dur: number, out: AudioNode, detune = 0) {
    const o = this.ctx.createOscillator()
    o.type = type
    o.frequency.value = freq
    o.detune.value = detune
    o.connect(out)
    o.start(t)
    o.stop(t + dur)
    return o
  }

  // Music box: a sine with a quiet, quickly fading overtone
  private bell(t: number, f: number) {
    this.osc('sine', f, t, 1.6, this.env(t, 0.16, 0.004, 1.5, 0.6), 3)
    this.osc('sine', f * 3, t, 0.4, this.env(t, 0.03, 0.002, 0.35, 0.6))
    this.osc('triangle', f * 2, t, 0.6, this.env(t, 0.025, 0.003, 0.5, 0.6), -4)
  }

  private bass(t: number, f: number) {
    const lp = this.ctx.createBiquadFilter()
    lp.frequency.value = 600
    lp.connect(this.env(t, 0.22, 0.01, 0.35, 0.1))
    this.osc('triangle', f, t, 0.45, lp)
  }

  private pad(t: number, notes: number[], dur: number) {
    for (const n of notes) {
      const g = this.ctx.createGain()
      g.gain.setValueAtTime(0, t)
      g.gain.linearRampToValueAtTime(0.03, t + 0.25)
      g.gain.setValueAtTime(0.03, t + dur - 0.15)
      g.gain.linearRampToValueAtTime(0, t + dur + 0.2)
      g.connect(this.dry)
      g.connect(this.wet)
      this.osc('sine', hz(n), t, dur + 0.25, g, 5)
      this.osc('sine', hz(n), t, dur + 0.25, g, -5)
    }
  }

  private kick(t: number) {
    const o = this.ctx.createOscillator()
    o.frequency.setValueAtTime(140, t)
    o.frequency.exponentialRampToValueAtTime(45, t + 0.12)
    o.connect(this.env(t, 0.35, 0.003, 0.18, 0))
    o.start(t)
    o.stop(t + 0.25)
  }

  private burst(t: number, filter: BiquadFilterType, freq: number, peak: number, decay: number, send: number) {
    const src = this.ctx.createBufferSource()
    src.buffer = this.noise
    const f = this.ctx.createBiquadFilter()
    f.type = filter
    f.frequency.value = freq
    src.connect(f).connect(this.env(t, peak, 0.002, decay, send))
    src.start(t, Math.random() * 0.5)
    src.stop(t + decay + 0.05)
  }

  private snap(t: number) {
    this.burst(t, 'bandpass', 1800, 0.09, 0.09, 0.4)
  }

  private shaker(t: number) {
    this.burst(t, 'highpass', 7000, 0.035, 0.05, 0.2)
  }
}
