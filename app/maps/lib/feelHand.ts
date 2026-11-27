// Day 28: a hand in front of the camera as the finger, by MediaPipe's hand landmarker. Pinching
// (thumb tip to index tip) presses on the map; the pinch's point is where. The camera image stays
// in the browser: only the 21 landmarks per frame come out, and only they are drawn.
import type { HandLandmarker as HL } from '@mediapipe/tasks-vision'

// The runtime's version must match the package's
const WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.3/wasm'
const MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'

/** The bones between the 21 landmarks */
export const BONES: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [0, 17], [17, 18], [18, 19], [19, 20],
]

export type HandFrame = {
  /** The landmarks on the screen (CSS px) */
  points: [number, number][]
  /** The pinch point on the screen */
  at: [number, number]
  pinched: boolean
  /** How closed the pinch is, 0 (open) - 1 (closed) */
  closure: number
}

// Pinch on below this (thumb-to-index over the palm's length), off above the other: the gap
// between them keeps a wavering pinch from flickering
const PINCH_ON = 0.3
const PINCH_OFF = 0.45
// The part of the camera's view that maps to the whole screen (a hand needn't reach the edges)
const MARGIN = 0.12

export class HandInput {
  private video = document.createElement('video')
  private stream?: MediaStream
  private landmarker?: HL
  private pinched = false
  private smooth?: [number, number][]
  private lastTime = -1

  /** Asks for the camera and loads the model; rejects if either fails */
  async start() {
    const vision = await import('@mediapipe/tasks-vision')
    const fileset = await vision.FilesetResolver.forVisionTasks(WASM)
    const [landmarker, stream] = await Promise.all([
      vision.HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL, delegate: 'GPU' },
        runningMode: 'VIDEO',
        numHands: 1,
      }),
      navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: 640, height: 480 }, audio: false }),
    ])
    this.landmarker = landmarker
    this.stream = stream
    this.video.srcObject = stream
    this.video.muted = true
    this.video.playsInline = true
    await this.video.play()
  }

  /** The hand now, on a screen of w × h; undefined when no hand is in view */
  read(w: number, h: number): HandFrame | undefined {
    const { video, landmarker } = this
    if (!landmarker || video.readyState < 2) return undefined
    if (video.currentTime === this.lastTime) return this.last(w, h)
    this.lastTime = video.currentTime
    const result = landmarker.detectForVideo(video, performance.now())
    const lm = result.landmarks[0]
    if (!lm) {
      this.smooth = undefined
      this.pinched = false
      return undefined
    }
    // Mirrored, as in a mirror; eased a little against jitter
    const raw = lm.map((p) => [1 - p.x, p.y] as [number, number])
    this.smooth = this.smooth ? this.smooth.map((s, i) => [s[0] + (raw[i]![0] - s[0]) * 0.6, s[1] + (raw[i]![1] - s[1]) * 0.6]) : raw
    const d = (a: number, b: number) => Math.hypot(lm[a]!.x - lm[b]!.x, lm[a]!.y - lm[b]!.y)
    const ratio = d(4, 8) / Math.max(1e-3, d(0, 9))
    this.pinched = this.pinched ? ratio < PINCH_OFF : ratio < PINCH_ON
    this.closure = Math.min(1, Math.max(0, (PINCH_OFF * 1.6 - ratio) / (PINCH_OFF * 1.6 - PINCH_ON * 0.6)))
    return this.last(w, h)
  }

  private closure = 0

  private last(w: number, h: number): HandFrame | undefined {
    if (!this.smooth) return undefined
    const toScreen = ([x, y]: [number, number]): [number, number] => [
      ((x - MARGIN) / (1 - 2 * MARGIN)) * w,
      ((y - MARGIN) / (1 - 2 * MARGIN)) * h,
    ]
    const points = this.smooth.map(toScreen)
    const a = points[4]!
    const b = points[8]!
    return { points, at: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], pinched: this.pinched, closure: this.closure }
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = undefined
    this.landmarker?.close()
    this.landmarker = undefined
  }
}
