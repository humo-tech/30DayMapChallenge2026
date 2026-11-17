// GSI's DEM tiles with Mt. Fuji taken out, made in the browser as Navara asks for them.
//
// Navara fetches a `raster-dem` source's tiles with the page's `fetch`: while installed, a URL on
// NULL_HOST is the same tile from GSI, and where the tile overlaps the mountain its elevations go
// down to the fill (scripts/day18/null_fuji.py) by the fill's weight there. Only ever down: the
// mountain is taken away, nothing is added.

/** The fill and its weight, on a Web Mercator pixel grid at zoom z (rows north to south) */
export type NullGrid = {
  z: number
  x0: number
  y0: number
  cols: number
  rows: number
  /** Fill height (m) */
  fill: Float32Array
  /** 0-1: how much of the ground is the fill */
  weight: Float32Array
}

const GSI_DEM = 'https://cyberjapandata.gsi.go.jp/xyz/dem_png'
const NULL_HOST = 'https://null-fuji.invalid/dem_png'
/** The Fuji-less DEM's tile URL, for a `raster-dem` source */
export const NULL_DEM_URL = `${NULL_HOST}/{z}/{x}/{y}.png`

/** Reads fuji_null.bin: uint16 fill (dm), then uint8 weight */
export function readNullGrid(layout: Omit<NullGrid, 'fill' | 'weight'>, buffer: ArrayBuffer): NullGrid {
  const n = layout.cols * layout.rows
  const fill = Float32Array.from(new Uint16Array(buffer, 0, n), (d) => d / 10)
  const weight = Float32Array.from(new Uint8Array(buffer, 2 * n, n), (w) => w / 255)
  return { ...layout, fill, weight }
}

/** Swaps the page's fetch for one that serves NULL_DEM_URL; returns the uninstaller */
export function installNullDem(grid: NullGrid): () => void {
  const original = window.fetch
  const patched: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!url.startsWith(NULL_HOST)) return original(input, init)
    const m = /\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(url)!
    const [z, x, y] = [Number(m[1]), Number(m[2]), Number(m[3])]
    return original(`${GSI_DEM}/${z}/${x}/${y}.png`, init).then((res) => (res.ok && overlaps(grid, z, x, y) ? nullTile(grid, z, x, y, res) : res))
  }
  window.fetch = patched
  return () => {
    if (window.fetch === patched) window.fetch = original
  }
}

function overlaps(g: NullGrid, z: number, x: number, y: number): boolean {
  const s = 2 ** (g.z - z) * 256 // the tile's size in grid pixels
  return x * s < g.x0 + g.cols && (x + 1) * s > g.x0 && y * s < g.y0 + g.rows && (y + 1) * s > g.y0
}

async function nullTile(g: NullGrid, z: number, x: number, y: number, res: Response): Promise<Response> {
  const bitmap = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(bitmap, 0, 0)
  bitmap.close()
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const d = image.data
  const size = canvas.width
  const scale = (2 ** (g.z - z) * 256) / size // grid pixels per tile pixel

  for (let py = 0; py < size; py++) {
    // Bilinear, between the grid pixels' centres
    const gy = (y * size + py + 0.5) * scale - g.y0 - 0.5
    const i0 = Math.floor(gy)
    const fy = gy - i0
    if (i0 < -1 || i0 >= g.rows) continue
    for (let px = 0; px < size; px++) {
      const gx = (x * size + px + 0.5) * scale - g.x0 - 0.5
      const j0 = Math.floor(gx)
      const fx = gx - j0
      if (j0 < -1 || j0 >= g.cols) continue
      let w = 0
      let f = 0
      let sum = 0
      for (const [di, dj, k] of [
        [0, 0, (1 - fy) * (1 - fx)],
        [0, 1, (1 - fy) * fx],
        [1, 0, fy * (1 - fx)],
        [1, 1, fy * fx],
      ] as const) {
        const i = i0 + di
        const j = j0 + dj
        if (i < 0 || i >= g.rows || j < 0 || j >= g.cols) continue
        w += g.weight[i * g.cols + j]! * k
        f += g.fill[i * g.cols + j]! * k
        sum += k
      }
      if (w <= 0) continue
      f /= sum
      const o = (py * size + px) * 4
      const [r, gg, b] = [d[o]!, d[o + 1]!, d[o + 2]!]
      if (r === 128 && gg === 0 && b === 0) continue // no data (the sea)
      let v = (r << 16) | (gg << 8) | b
      if (v >= 1 << 23) v -= 1 << 24
      const h = v / 100
      const lowered = h - Math.max(0, w * (h - f))
      if (lowered === h) continue
      let e = Math.round(lowered * 100)
      if (e < 0) e += 1 << 24
      d[o] = (e >> 16) & 255
      d[o + 1] = (e >> 8) & 255
      d[o + 2] = e & 255
    }
  }
  ctx.putImageData(image, 0, 0)
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  return new Response(blob, { status: 200, headers: { 'Content-Type': 'image/png' } })
}
