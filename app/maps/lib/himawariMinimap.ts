// Day 26's minimap: Himawari's infrared scene itself, flat (plate carrée over the scenes' box),
// as a weather map shows it: the colder the cloud top, the whiter. Blended between the hourly
// scenes, with the coastlines, the storm's track (behind it in the color of its wind, faint
// ahead) and where it is now.
import { stormAt, windColor, type ChampiScenes } from './typhoon'

// Black for a warm sea (300 K), white for the coldest tops (190 K)
const WARM = 300
const COLD = 190

export class HimawariMinimap {
  private readonly scene: OffscreenCanvas
  private readonly sceneCtx: OffscreenCanvasRenderingContext2D
  private readonly pixels: ImageData
  private readonly gray = new Uint8Array(256)
  private shown = NaN

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly champi: ChampiScenes,
    private readonly coast: [number, number][][],
  ) {
    const c = champi.meta.clouds
    this.scene = new OffscreenCanvas(c.width, c.height)
    this.sceneCtx = this.scene.getContext('2d')!
    this.pixels = this.sceneCtx.createImageData(c.width, c.height)
    for (let k = 0; k < 256; k++) {
      const t = Math.min(1, Math.max(0, (WARM - (c.tbMin + k * c.tbStep)) / (WARM - COLD)))
      this.gray[k] = Math.round(255 * Math.pow(t, 0.8))
    }
  }

  /** Shows the scene at `hour` (since the clouds' start); does nothing if it's what's shown. */
  draw(hour: number): void {
    const c = this.champi.meta.clouds
    // Four steps an hour are plenty
    const f = Math.round(Math.min(Math.max(hour / c.every, 0), c.frames - 1) * 4) / 4
    const css = this.canvas.getBoundingClientRect()
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const w = Math.round(css.width * dpr)
    const h = Math.round(css.height * dpr)
    if (f === this.shown && this.canvas.width === w && this.canvas.height === h) return
    this.shown = f
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w
      this.canvas.height = h
    }

    // The scene, blended between the two either side (rows from the south in the data)
    const data = this.champi.scenes
    const i = Math.min(Math.floor(f), c.frames - 2)
    const t = f - i
    const n = c.width * c.height
    const px = this.pixels.data
    for (let y = 0; y < c.height; y++) {
      const src = (c.height - 1 - y) * c.width
      for (let x = 0; x < c.width; x++) {
        const k = src + x
        const v = this.gray[Math.round(data[i * n + k]! * (1 - t) + data[(i + 1) * n + k]! * t)]!
        const o = (y * c.width + x) * 4
        px[o] = px[o + 1] = px[o + 2] = v
        px[o + 3] = 255
      }
    }
    this.sceneCtx.putImageData(this.pixels, 0, 0)

    const ctx = this.canvas.getContext('2d')!
    ctx.imageSmoothingEnabled = true
    ctx.drawImage(this.scene, 0, 0, w, h)
    const west = c.west
    const north = c.south + c.height * c.step
    const sx = w / (c.width * c.step)
    const sy = h / (c.height * c.step)
    const at = (lng: number, lat: number): [number, number] => [(lng - west) * sx, (north - lat) * sy]

    // Coastlines
    ctx.lineWidth = dpr
    ctx.strokeStyle = 'rgba(240, 200, 90, 0.75)'
    ctx.beginPath()
    for (const line of this.coast) {
      line.forEach(([lng, lat], k) => (k ? ctx.lineTo(...at(lng, lat)) : ctx.moveTo(...at(lng, lat))))
    }
    ctx.stroke()

    // The track: ahead, faint dashes; behind, in the color of its wind
    const { track } = this.champi.meta
    const now = f * c.every
    ctx.setLineDash([3 * dpr, 3 * dpr])
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)'
    ctx.beginPath()
    for (let hh = now, k = 0; hh <= track.at(-1)!.hour; hh += 1, k++) {
      const s = stormAt(track, hh)
      if (k) ctx.lineTo(...at(s.lon, s.lat))
      else ctx.moveTo(...at(s.lon, s.lat))
    }
    ctx.stroke()
    ctx.setLineDash([])
    ctx.lineWidth = 2 * dpr
    let prev: [number, number] | undefined
    for (let hh = track[0]!.hour; hh <= now; hh += 1) {
      const s = stormAt(track, Math.min(hh, now))
      const p = at(s.lon, s.lat)
      if (prev) {
        const [r, g, b] = windColor(s.wind)
        ctx.strokeStyle = `rgb(${r * 255}, ${g * 255}, ${b * 255})`
        ctx.beginPath()
        ctx.moveTo(...prev)
        ctx.lineTo(...p)
        ctx.stroke()
      }
      prev = p
    }

    // Where it is now
    const s = stormAt(track, now)
    const [r, g, b] = windColor(s.wind)
    ctx.strokeStyle = `rgb(${r * 255}, ${g * 255}, ${b * 255})`
    ctx.lineWidth = 2 * dpr
    ctx.beginPath()
    ctx.arc(...at(s.lon, s.lat), 6 * dpr, 0, Math.PI * 2)
    ctx.stroke()
  }
}
