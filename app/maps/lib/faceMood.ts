// Day 28: the face in front of the camera, by MediaPipe's face landmarker: where it is (a few of
// its 478 landmarks), how it is turned, and its expression (52 blendshape scores). The camera's
// image stays in the browser; the page draws only a plush mask over it, never the face.
import type { FaceLandmarker as FL } from '@mediapipe/tasks-vision'

// The runtime's version must match the package's
const WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.3/wasm'
const MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task'

export type Face = {
  /** Landmarks the mask needs, in the video's 0-1 coordinates (not mirrored) */
  top: [number, number] // forehead (10)
  chin: [number, number] // (152)
  left: [number, number] // the face's right cheek edge, on the image's left (234)
  right: [number, number] // (454)
  nose: [number, number] // tip (1)
  /** Turned left-right and up-down, -1..1 (from where the nose sits between the cheeks) */
  yaw: number
  pitch: number
  /** Blendshape scores by name, 0-1 */
  shapes: Record<string, number>
}

export class FaceInput {
  readonly video = document.createElement('video')
  private stream?: MediaStream
  private landmarker?: FL
  private lastTime = -1
  private last?: Face

  /** Asks for the camera and loads the model; rejects if either fails */
  async start() {
    const vision = await import('@mediapipe/tasks-vision')
    const fileset = await vision.FilesetResolver.forVisionTasks(WASM)
    const [landmarker, stream] = await Promise.all([
      vision.FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL, delegate: 'GPU' },
        runningMode: 'VIDEO',
        numFaces: 1,
        outputFaceBlendshapes: true,
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

  get ready() {
    return !!this.landmarker && this.video.readyState >= 2
  }

  /** The face in the latest frame, or undefined if there is none */
  read(): Face | undefined {
    const { video, landmarker } = this
    if (!landmarker || video.readyState < 2) return undefined
    if (video.currentTime === this.lastTime) return this.last
    this.lastTime = video.currentTime
    const r = landmarker.detectForVideo(video, performance.now())
    const lm = r.faceLandmarks[0]
    if (!lm) return (this.last = undefined)
    const p = (i: number): [number, number] => [lm[i]!.x, lm[i]!.y]
    const shapes: Record<string, number> = {}
    for (const c of r.faceBlendshapes[0]?.categories ?? []) shapes[c.categoryName] = c.score
    const left = p(234)
    const right = p(454)
    const top = p(10)
    const chin = p(152)
    const nose = p(1)
    // Where the nose sits across and down the face, around its middle
    const across = (nose[0] - left[0]) / Math.max(1e-3, right[0] - left[0])
    const down = (nose[1] - top[1]) / Math.max(1e-3, chin[1] - top[1])
    this.last = { top, chin, left, right, nose, yaw: (across - 0.5) * 2.4, pitch: (down - 0.58) * 3, shapes }
    return this.last
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = undefined
    this.landmarker?.close()
    this.landmarker = undefined
  }
}
