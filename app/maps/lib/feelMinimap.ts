// Day 28's minimap: the ground the map feels like, drawn from the same grid (feelGround.ts) —
// the sea dark, the drift ice white as it is thick, forest dark green, towns red, the snowfields
// pale and shaded by their relief — with where the view is (its footprint on the ground) and
// where the finger is. Plate carrée squeezed by the cosine of the middle latitude, so Hokkaido
// keeps its shape.
import type { Ground } from './feelGround'

type LngLat = { lng: number; lat: number }

const SEA = [26, 38, 58]
const ICE = [232, 240, 248]
const LAKE = [196, 214, 228]
const FOREST = [70, 96, 82]
const TOWN = [214, 96, 70]
const SNOW = [214, 216, 214]

export class FeelMinimap {
  private readonly base: OffscreenCanvas
  readonly aspect: number

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly ground: Ground,
  ) {
    const { west, east, south, north, width: W, height: H } = ground.meta
    this.aspect = ((east - west) * Math.cos((((north + south) / 2) * Math.PI) / 180)) / (north - south)
    this.base = new OffscreenCanvas(W, H)
    const ctx = this.base.getContext('2d')!
    const img = ctx.createImageData(W, H)
    const px = ground.pixels
    const step = ground.meta.heightStep
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const k = (y * W + x) * 4
        const m = px[k]!
        const amount = px[k + 1]! / 255
        // Light from the north-west, on the relief
        const h = px[k + 2]! * step
        const hw = px[(y * W + Math.max(0, x - 1)) * 4 + 2]! * step
        const hn = px[(Math.max(0, y - 1) * W + x) * 4 + 2]! * step
        const shade = Math.max(0.55, Math.min(1.25, 1 + ((h - hw) * 0.5 + (h - hn) * 0.5) * 0.004))
        let c: number[]
        if (m === 0) c = SEA
        else if (m === 1) c = SEA.map((s, i) => s + (ICE[i]! - s) * Math.min(1, amount * 1.2))
        else if (m === 5) c = LAKE
        else if (m === 3) c = FOREST.map((v) => v * shade)
        else if (m === 4) c = TOWN
        else c = SNOW.map((v) => v * shade)
        img.data[k] = c[0]!
        img.data[k + 1] = c[1]!
        img.data[k + 2] = c[2]!
        img.data[k + 3] = 255
      }
    }
    ctx.putImageData(img, 0, 0)
  }

  /** Where a point of the minimap (CSS px from its corner) is on the ground */
  toLngLat(x: number, y: number): LngLat {
    const { west, east, south, north } = this.ground.meta
    const r = this.canvas.getBoundingClientRect()
    return { lng: west + (x / r.width) * (east - west), lat: north - (y / r.height) * (north - south) }
  }

  /** The view's footprint (its corners on the ground, in order) and the finger, if any */
  draw(footprint: LngLat[], finger?: LngLat): void {
    const { canvas } = this
    const css = canvas.getBoundingClientRect()
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const w = Math.round(css.width * dpr)
    const h = Math.round(css.height * dpr)
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
    }
    const ctx = canvas.getContext('2d')!
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(this.base, 0, 0, w, h)
    const { west, east, south, north } = this.ground.meta
    const at = (p: LngLat): [number, number] => [((p.lng - west) / (east - west)) * w, ((north - p.lat) / (north - south)) * h]

    // The view: dim what is outside it a little, and outline it
    ctx.save()
    ctx.beginPath()
    ctx.rect(0, 0, w, h)
    footprint.forEach((p, i) => (i ? ctx.lineTo(...at(p)) : ctx.moveTo(...at(p))))
    ctx.closePath()
    ctx.fillStyle = 'rgba(5, 10, 20, 0.35)'
    ctx.fill('evenodd')
    ctx.restore()
    ctx.beginPath()
    footprint.forEach((p, i) => (i ? ctx.lineTo(...at(p)) : ctx.moveTo(...at(p))))
    ctx.closePath()
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)'
    ctx.lineWidth = 1.5 * dpr
    ctx.lineJoin = 'round'
    ctx.stroke()

    if (finger) {
      const [x, y] = at(finger)
      ctx.fillStyle = '#ffd166'
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)'
      ctx.lineWidth = dpr
      ctx.beginPath()
      ctx.arc(x, y, 3 * dpr, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()
    }
  }
}
