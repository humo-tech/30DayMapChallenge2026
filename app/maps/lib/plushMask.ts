// Day 28's plush mask: a felt bear's head drawn over the face, so the face itself never shows. It
// sits where the face is, as big, tilted and turned as it is, and wears its expression: button
// eyes that close to stitched arcs, embroidered brows that knit or lift, a mouth that smiles,
// sulks or drops open, cheeks that blush with a smile. Without a camera, demoFace() acts the six
// moods out in turn, so the map still has a face to follow.
import { MOODS, type Mood } from './moodPalette'

export type Pose = {
  /** The head's centre and radius (px), tilt (rad), turn left-right and up-down (-1..1) */
  x: number
  y: number
  r: number
  roll: number
  yaw: number
  pitch: number
}

const FUR = '#c8946a'
const FUR_DARK = '#a2704b'
const FUR_LIGHT = '#e0b58c'
const MUZZLE = '#f4dfc4'
const EAR_IN = '#f0a8b6'
const NOSE = '#3a2318'
const STITCH = 'rgba(255, 244, 228, 0.85)'
const THREAD = '#3a2318'

/** Fibres: a tile of short random strokes, laid over the felt */
function fibres(): CanvasPattern | null {
  const c = document.createElement('canvas')
  c.width = c.height = 96
  const g = c.getContext('2d')!
  for (let i = 0; i < 420; i++) {
    const x = Math.random() * 96
    const y = Math.random() * 96
    const a = Math.random() * Math.PI
    const l = 2 + Math.random() * 4
    g.strokeStyle = Math.random() < 0.5 ? 'rgba(255,255,255,0.10)' : 'rgba(60,30,10,0.10)'
    g.lineWidth = 0.8
    g.beginPath()
    g.moveTo(x, y)
    g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l)
    g.stroke()
  }
  return g.createPattern(c, 'repeat')
}

let pattern: CanvasPattern | null | undefined

export function drawPlush(ctx: CanvasRenderingContext2D, pose: Pose, s: Record<string, number>): void {
  pattern ??= fibres()
  const g = (k: string) => s[k] ?? 0
  const avg = (a: string, b: string) => (g(a) + g(b)) / 2
  const smile = avg('mouthSmileLeft', 'mouthSmileRight')
  const frown = avg('mouthFrownLeft', 'mouthFrownRight')
  const jaw = g('jawOpen')
  const browDown = avg('browDownLeft', 'browDownRight')
  const browUp = Math.max(g('browInnerUp'), avg('browOuterUpLeft', 'browOuterUpRight'))
  const inner = g('browInnerUp')
  const wide = avg('eyeWideLeft', 'eyeWideRight')
  // The image is mirrored, so the face's left eye is on the screen's left
  const blinkL = g('eyeBlinkRight')
  const blinkR = g('eyeBlinkLeft')

  ctx.save()
  ctx.translate(pose.x, pose.y)
  ctx.rotate(pose.roll)
  ctx.scale(pose.r, pose.r)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  // Features slide with the turn of the head
  const fx = pose.yaw * 0.28
  const fy = pose.pitch * 0.16

  // A soft shadow under the head
  ctx.fillStyle = 'rgba(30, 15, 5, 0.25)'
  ctx.beginPath()
  ctx.ellipse(0.04, 0.1, 1.05, 0.98, 0, 0, Math.PI * 2)
  ctx.fill()

  // Ears, then the head over them
  for (const side of [-1, 1]) {
    const ex = side * 0.74 + fx * 0.3
    ctx.fillStyle = FUR_DARK
    ctx.beginPath()
    ctx.arc(ex, -0.78, 0.36, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = EAR_IN
    ctx.beginPath()
    ctx.arc(ex, -0.76, 0.2, 0, Math.PI * 2)
    ctx.fill()
  }
  const felt = ctx.createRadialGradient(-0.35, -0.45, 0.1, 0, 0, 1.15)
  felt.addColorStop(0, FUR_LIGHT)
  felt.addColorStop(0.6, FUR)
  felt.addColorStop(1, FUR_DARK)
  ctx.fillStyle = felt
  ctx.beginPath()
  ctx.ellipse(0, 0, 1, 0.93, 0, 0, Math.PI * 2)
  ctx.fill()
  if (pattern) {
    ctx.save()
    ctx.scale(1 / 140, 1 / 140)
    ctx.fillStyle = pattern
    ctx.beginPath()
    ctx.ellipse(0, 0, 140, 130, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  }
  // Seams: round the face, and down the crown
  ctx.strokeStyle = STITCH
  ctx.lineWidth = 0.022
  ctx.setLineDash([0.06, 0.05])
  ctx.beginPath()
  ctx.ellipse(0, 0.02, 0.88, 0.8, 0, 0, Math.PI * 2)
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(fx * 0.5, -0.92)
  ctx.quadraticCurveTo(fx * 0.7, -0.6, fx * 0.8, -0.38)
  ctx.stroke()
  ctx.setLineDash([])

  // Blush
  const blush = 0.15 + 0.65 * smile
  for (const side of [-1, 1]) {
    const grd = ctx.createRadialGradient(side * 0.6 + fx, 0.22 + fy, 0, side * 0.6 + fx, 0.22 + fy, 0.2)
    grd.addColorStop(0, `rgba(255, 120, 140, ${blush})`)
    grd.addColorStop(1, 'rgba(255, 120, 140, 0)')
    ctx.fillStyle = grd
    ctx.beginPath()
    ctx.arc(side * 0.6 + fx, 0.22 + fy, 0.2, 0, Math.PI * 2)
    ctx.fill()
  }

  // Muzzle
  ctx.fillStyle = MUZZLE
  ctx.beginPath()
  ctx.ellipse(fx * 1.1, 0.38 + fy, 0.42, 0.31 + jaw * 0.08, 0, 0, Math.PI * 2)
  ctx.fill()

  // Eyes: buttons, or stitched arcs when shut
  const eyeY = -0.06 + fy - browUp * 0.03
  for (const [side, blink] of [
    [-1, blinkL],
    [1, blinkR],
  ] as const) {
    const ex = side * 0.36 + fx
    const open = Math.max(0, 1 - blink * 1.15)
    const er = 0.115 * (1 + wide * 0.35)
    if (open < 0.25) {
      ctx.strokeStyle = THREAD
      ctx.lineWidth = 0.045
      ctx.beginPath()
      ctx.arc(ex, eyeY - 0.03, er, 0.15 * Math.PI, 0.85 * Math.PI)
      ctx.stroke()
    } else {
      ctx.fillStyle = '#1b1210'
      ctx.beginPath()
      ctx.ellipse(ex, eyeY, er, er * open, 0, 0, Math.PI * 2)
      ctx.fill()
      // The button's shine
      ctx.fillStyle = 'rgba(255, 255, 255, 0.85)'
      ctx.beginPath()
      ctx.arc(ex - er * 0.35, eyeY - er * 0.35 * open, er * 0.28, 0, Math.PI * 2)
      ctx.fill()
    }
    // Brows: their inner ends down when cross, up when sad or surprised
    const d = (browDown - inner) * 0.07
    const by = eyeY - 0.2 - browUp * 0.1 + browDown * 0.04
    ctx.strokeStyle = FUR_DARK
    ctx.lineWidth = 0.05
    ctx.beginPath()
    ctx.moveTo(ex - side * 0.12, by + d)
    ctx.lineTo(ex + side * 0.12, by - d)
    ctx.stroke()
  }

  // Nose
  const nx = fx * 1.15
  const ny = 0.22 + fy
  ctx.fillStyle = NOSE
  ctx.beginPath()
  ctx.moveTo(nx - 0.11, ny - 0.04)
  ctx.quadraticCurveTo(nx, ny - 0.1, nx + 0.11, ny - 0.04)
  ctx.quadraticCurveTo(nx + 0.08, ny + 0.07, nx, ny + 0.09)
  ctx.quadraticCurveTo(nx - 0.08, ny + 0.07, nx - 0.11, ny - 0.04)
  ctx.fill()
  ctx.fillStyle = 'rgba(255,255,255,0.5)'
  ctx.beginPath()
  ctx.ellipse(nx - 0.03, ny - 0.04, 0.03, 0.015, -0.3, 0, Math.PI * 2)
  ctx.fill()

  // Mouth: a stitch down from the nose, then a smile, a sulk, or open
  const my = ny + 0.2
  ctx.strokeStyle = THREAD
  ctx.lineWidth = 0.035
  ctx.beginPath()
  ctx.moveTo(nx, ny + 0.09)
  ctx.lineTo(nx, my - 0.02)
  ctx.stroke()
  const curve = (smile - frown) * 0.12
  if (jaw > 0.25) {
    const h = 0.05 + jaw * 0.2
    ctx.fillStyle = '#5a1f22'
    ctx.beginPath()
    ctx.ellipse(nx, my + h * 0.6, 0.1 + smile * 0.06, h, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#f07f8f'
    ctx.beginPath()
    ctx.ellipse(nx, my + h * 1.05, 0.07, h * 0.45, 0, 0, Math.PI)
    ctx.fill()
  } else {
    const w = 0.16 + smile * 0.05
    ctx.beginPath()
    ctx.moveTo(nx - w, my - curve)
    ctx.quadraticCurveTo(nx - w / 2, my + curve * 1.2 + 0.04, nx, my)
    ctx.quadraticCurveTo(nx + w / 2, my + curve * 1.2 + 0.04, nx + w, my - curve)
    ctx.stroke()
  }
  ctx.restore()
}

// The demo: each mood's face held for a while, eased into the next, the head bobbing
const DEMO: Record<Mood, Record<string, number>> = {
  calm: {},
  happy: { mouthSmileLeft: 0.95, mouthSmileRight: 0.95, cheekSquintLeft: 0.5, cheekSquintRight: 0.5 },
  sad: { mouthFrownLeft: 0.85, mouthFrownRight: 0.85, browInnerUp: 0.85 },
  angry: { browDownLeft: 0.95, browDownRight: 0.95, noseSneerLeft: 0.7, noseSneerRight: 0.7 },
  surprised: { jawOpen: 0.8, browInnerUp: 0.8, browOuterUpLeft: 0.9, browOuterUpRight: 0.9, eyeWideLeft: 0.8, eyeWideRight: 0.8 },
  sleepy: { eyeBlinkLeft: 0.97, eyeBlinkRight: 0.97 },
}
const HOLD_S = 3.2

export function demoFace(t: number): { shapes: Record<string, number>; yaw: number; pitch: number; roll: number } {
  const n = MOODS.length
  const i = Math.floor(t / HOLD_S) % n
  const f = Math.min(1, (t % HOLD_S) / 0.6)
  const e = f * f * (3 - 2 * f)
  const from = DEMO[MOODS[(i + n - 1) % n]!]
  const to = DEMO[MOODS[i]!]
  const shapes: Record<string, number> = {}
  for (const k of new Set([...Object.keys(from), ...Object.keys(to)])) shapes[k] = (from[k] ?? 0) * (1 - e) + (to[k] ?? 0) * e
  // A blink now and then, unless asleep
  if (MOODS[i] !== 'sleepy' && t % 4.1 < 0.12) shapes.eyeBlinkLeft = shapes.eyeBlinkRight = 1
  return { shapes, yaw: Math.sin(t * 0.7) * 0.35, pitch: Math.sin(t * 0.9 + 1) * 0.15, roll: Math.sin(t * 0.5) * 0.12 }
}
