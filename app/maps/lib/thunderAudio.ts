// Day 11 thunder, synthesized live with Web Audio: filtered noise shaped into rolls. The air
// soaks up the high notes over distance, so a near strike cracks and booms and a far one only
// grumbles low; and the farther it is, the longer the rumble rolls on. Nothing to download.
import { loudness } from './ThunderMeshDesc'

export type Thunder = {
  /** Distance to the nearest part of the channel (m) */
  distance: number
  /** How long the sound keeps arriving from the rest of the channel (s) */
  spread: number
  /** Where it comes from, -1 (left) - 1 (right) */
  pan: number
}

const rnd = (a: number, b: number) => a + Math.random() * (b - a)

export class ThunderVoice {
  private ctx = new AudioContext()
  private master: GainNode
  private brown: AudioBuffer
  private white: AudioBuffer

  constructor() {
    const { ctx } = this
    this.master = ctx.createGain()
    this.master.gain.value = 0
    const comp = ctx.createDynamicsCompressor()
    comp.threshold.value = -10
    this.master.connect(comp).connect(ctx.destination)

    // Eight seconds of white noise, and of brown noise (integrated white noise: mostly lows)
    const length = ctx.sampleRate * 8
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
  }

  /** Fade in (or out) over half a second */
  set playing(on: boolean) {
    const { ctx } = this
    void ctx.resume()
    const g = this.master.gain
    g.cancelScheduledValues(ctx.currentTime)
    g.setValueAtTime(g.value, ctx.currentTime)
    g.linearRampToValueAtTime(on ? 0.9 : 0, ctx.currentTime + 0.5)
  }

  /** Plays a thunder now */
  play({ distance, spread, pan }: Thunder): void {
    const { ctx } = this
    const now = ctx.currentTime
    const km = distance / 1000
    // Loudness falls off with distance, as the rings fade (gently: the compressor and the ear
    // even it out)
    const loud = loudness(distance)
    // The air filters the highs out: ~4 kHz up close, a low grumble far off
    const cutoff = 160 + 3800 * Math.exp(-km / 1.8)
    const length = Math.min(10, 1.6 + spread * 1.3 + km * 0.25)

    const out = ctx.createStereoPanner()
    out.pan.value = Math.max(-1, Math.min(1, pan))
    out.connect(this.master)

    // The rumble: rolls ("goro-goro-goro") of brown noise, each one swelling and dying off,
    // weaker and farther apart as it goes on
    const rumble = this.noise(this.brown, cutoff, now, length + 1)
    const env = ctx.createGain()
    rumble.connect(env).connect(out)
    const g = env.gain
    g.setValueAtTime(0, now)
    let at = now + rnd(0.02, 0.12)
    for (let i = 0; at < now + length; i++) {
      const left = 1 - (at - now) / length
      const peak = loud * (0.45 + 0.55 * Math.random()) * left ** 0.8 * (i === 0 ? 1.2 : 1)
      g.linearRampToValueAtTime(peak, at + rnd(0.04, 0.12))
      g.setTargetAtTime(peak * 0.25, at + 0.15, rnd(0.12, 0.3))
      at += rnd(0.25, 0.7) * (1 + (at - now) / length)
    }
    g.setTargetAtTime(0, now + length, 0.4)

    // Up close, the crack before it: a burst of hiss that tears for a moment
    if (km < 3) {
      const near = 1 - km / 3
      const crack = this.noise(this.white, 2500 + 5000 * near, now, 0.8)
      const hp = ctx.createBiquadFilter()
      hp.type = 'highpass'
      hp.frequency.value = 500
      const cg = ctx.createGain()
      crack.connect(hp).connect(cg).connect(out)
      cg.gain.setValueAtTime(0, now)
      cg.gain.linearRampToValueAtTime(near * 1.4, now + 0.006)
      cg.gain.setTargetAtTime(near * 0.5, now + 0.03, 0.05)
      cg.gain.setTargetAtTime(0, now + 0.15, 0.12)
    }

    // And the boom you feel: the lows of a near strike
    if (km < 6) {
      const boom = this.noise(this.brown, 90, now, 2.5)
      const bg = ctx.createGain()
      boom.connect(bg).connect(out)
      const level = loud * 2.2 * (1 - km / 6)
      bg.gain.setValueAtTime(0, now)
      bg.gain.linearRampToValueAtTime(level, now + 0.05)
      bg.gain.setTargetAtTime(0, now + 0.2, 0.45)
    }
  }

  /** A noise source from `buffer`, low-passed at `cutoff`, playing for `duration` s from `at` */
  private noise(buffer: AudioBuffer, cutoff: number, at: number, duration: number): AudioNode {
    const { ctx } = this
    const src = ctx.createBufferSource()
    src.buffer = buffer
    src.loop = true
    src.playbackRate.value = rnd(0.8, 1.1)
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = cutoff
    lp.Q.value = 0.5
    src.connect(lp)
    src.start(at, rnd(0, buffer.duration))
    src.stop(at + duration)
    return lp
  }

  dispose() {
    void this.ctx.close()
  }
}
