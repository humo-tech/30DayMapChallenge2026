// Day 28: what the ground is made of at a point — the grid scripts/day28/build_feel.py packs into
// one PNG (material, how much of it, height) — read back in the browser.

export const MATERIALS = ['sea', 'ice', 'snow', 'forest', 'town', 'lake'] as const
export type Material = (typeof MATERIALS)[number]

export type FeelMeta = {
  west: number
  east: number
  south: number
  north: number
  width: number
  height: number
  date: string
  materials: string[]
  heightStep: number
}

export type Sample = {
  material: Material
  /** Ice cover on the sea, or the built-up share in a town, 0-1 */
  amount: number
  /** Metres */
  height: number
}

export type Ground = {
  meta: FeelMeta
  at(lng: number, lat: number): Sample
  heightAt(lng: number, lat: number): number
  /** The slope, rise per metre east and north */
  slope(lng: number, lat: number): [number, number]
}

const M_PER_DEG_LAT = 110_950

export async function loadGround(base: string): Promise<Ground> {
  const [meta, blob] = await Promise.all([
    fetch(`${base}/feel.json`).then((r) => r.json() as Promise<FeelMeta>),
    fetch(`${base}/feel.png`).then((r) => r.blob()),
  ])
  // Read the bytes as they are, without colour management
  const bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none' })
  const canvas = new OffscreenCanvas(meta.width, meta.height)
  const ctx = canvas.getContext('2d', { colorSpace: 'srgb' })!
  ctx.drawImage(bitmap, 0, 0)
  const px = ctx.getImageData(0, 0, meta.width, meta.height).data

  const { west, east, south, north, width: W, height: H } = meta
  const dx = (east - west) / W
  const dy = (north - south) / H
  const cell = (lng: number, lat: number) => {
    const x = Math.min(W - 1, Math.max(0, Math.floor((lng - west) / dx)))
    const y = Math.min(H - 1, Math.max(0, Math.floor((north - lat) / dy)))
    return (y * W + x) * 4
  }
  const heightAt = (lng: number, lat: number) => {
    // Bilinear, so the slope has no steps in it
    const fx = Math.min(W - 1.001, Math.max(0, (lng - west) / dx - 0.5))
    const fy = Math.min(H - 1.001, Math.max(0, (north - lat) / dy - 0.5))
    const x = Math.floor(fx)
    const y = Math.floor(fy)
    const h = (i: number, j: number) => {
      const k = ((y + j) * W + x + i) * 4
      return px[k + 2]! * meta.heightStep
    }
    const tx = fx - x
    const ty = fy - y
    return (h(0, 0) * (1 - tx) + h(1, 0) * tx) * (1 - ty) + (h(0, 1) * (1 - tx) + h(1, 1) * tx) * ty
  }
  return {
    meta,
    at(lng, lat) {
      const k = cell(lng, lat)
      return { material: MATERIALS[px[k]!] ?? 'sea', amount: px[k + 1]! / 255, height: heightAt(lng, lat) }
    },
    heightAt,
    slope(lng, lat) {
      // Over one cell either way (≈ 400-550 m)
      const mx = dx * M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180)
      const my = dy * M_PER_DEG_LAT
      return [
        (heightAt(lng + dx, lat) - heightAt(lng - dx, lat)) / (2 * mx),
        (heightAt(lng, lat + dy) - heightAt(lng, lat - dy)) / (2 * my),
      ]
    },
  }
}
