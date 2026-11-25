// Day 26's data: Typhoon Champi's track and Himawari's infrared clouds over it
// (scripts/day26/fetch_champi.py), ECMWF's waves under it and winds round it
// (scripts/day26/fetch_waves.py, fetch_winds.py), and the storm worked out of them at any hour:
// where its centre is, how strong, how wide.
import { DataTexture, DataUtils, Data3DTexture, LinearFilter, RedFormat, RGBAFormat, UnsignedByteType } from 'three'
import type { WaveGrid } from './waveSim'

export type Fix = {
  /** Hours since the clouds' start */
  hour: number
  lat: number
  lon: number
  /** Maximum sustained wind (kt) */
  wind: number
  /** Central pressure (hPa) */
  pressure: number | null
  /** Radius of maximum wind (nm) */
  rmw: number
  /** Mean radius of gale-force (34 kt) wind (nm), 0 before it had one */
  r34: number
}

type Grid = { width: number; height: number; west: number; south: number; step: number }

export type ChampiMeta = {
  name: string
  track: Fix[]
  clouds: Grid & {
    start: string
    every: number
    frames: number
    tbMin: number
    tbStep: number
    /** Scenes come a day at a time in WebP files, `frames` to a file, `columns` across, north up */
    atlas: { columns: number; frames: number; files: number }
  }
}

/** The track and the cloud scenes, as bytes (what the 2D minimap needs) */
export type ChampiScenes = {
  meta: ChampiMeta
  /** Brightness temperature, (Tb - tbMin) / tbStep: the scenes one after another, rows from the south */
  scenes: Uint8Array
}

/** ...and the scenes on the GPU (what the 3D clouds need) */
export type Champi = ChampiScenes & {
  /** Brightness temperature, (Tb - tbMin) / tbStep / 255; one layer a scene */
  clouds: Data3DTexture
  /** The same, blurred a little (3 x 3 cells): what the cloud tops' heights are drawn from */
  smooth: Data3DTexture
}

const NM = 1852

export async function loadChampiScenes(base: string): Promise<ChampiScenes> {
  const meta = (await fetch(`${base}/champi.json`).then((r) => r.json())) as ChampiMeta
  return { meta, scenes: await cloudScenes(base, meta.clouds) }
}

export async function loadChampi(base: string): Promise<Champi> {
  const { meta, scenes: cloudBytes } = await loadChampiScenes(base)
  const c = meta.clouds
  const texture = (bytes: Uint8Array) => {
    const t = new Data3DTexture(bytes, c.width, c.height, c.frames)
    t.format = RedFormat
    t.type = UnsignedByteType
    t.minFilter = t.magFilter = LinearFilter
    t.unpackAlignment = 1
    t.needsUpdate = true
    return t
  }
  const clouds = texture(cloudBytes)
  const smooth = texture(blurred(cloudBytes, c.width, c.height, c.frames, 1, 1))
  return { meta, scenes: cloudBytes, clouds, smooth }
}

// The cloud scenes, one after another, each from the south: out of the day files' tiles
async function cloudScenes(base: string, c: ChampiMeta['clouds']): Promise<Uint8Array> {
  const { width: w, height: h } = c
  const out = new Uint8Array(w * h * c.frames)
  await Promise.all(
    Array.from({ length: c.atlas.files }, async (_, f) => {
      const name = `${base}/clouds-${String(f).padStart(2, '0')}.webp`
      const blob = await fetch(name).then((r) => r.blob())
      // (no color management: the bytes are temperatures, not colors)
      const bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })
      const { width: aw, height: ah } = bitmap
      const canvas = new OffscreenCanvas(aw, ah)
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!
      ctx.drawImage(bitmap, 0, 0)
      bitmap.close()
      const px = ctx.getImageData(0, 0, aw, ah).data
      for (let i = 0; i < c.atlas.frames; i++) {
        const frame = f * c.atlas.frames + i
        if (frame >= c.frames) break
        const x0 = (i % c.atlas.columns) * w
        const y0 = Math.floor(i / c.atlas.columns) * h
        for (let y = 0; y < h; y++) {
          // The tile's top row is the scene's north
          const src = ((y0 + h - 1 - y) * aw + x0) * 4
          const dst = (frame * h + y) * w
          for (let x = 0; x < w; x++) out[dst + x] = px[src + x * 4]!
        }
      }
    }),
  )
  return out
}

// Each scene blurred: a box `radius` cells each way, `passes` times over (near enough a Gaussian)
function blurred(src: Uint8Array, w: number, h: number, frames: number, radius: number, passes: number): Uint8Array {
  const out = new Uint8Array(src.length)
  const a = new Float32Array(w * h)
  const b = new Float32Array(w * h)
  const n = 2 * radius + 1
  for (let f = 0; f < frames; f++) {
    const o = f * w * h
    for (let i = 0; i < w * h; i++) a[i] = src[o + i]!
    for (let pass = 0; pass < passes; pass++) {
      // Along the rows, then down the columns, each a running sum (clamped at the edges)
      for (let y = 0; y < h; y++) {
        const r = y * w
        let sum = 0
        for (let k = -radius; k <= radius; k++) sum += a[r + Math.min(w - 1, Math.max(0, k))]!
        for (let x = 0; x < w; x++) {
          b[r + x] = sum / n
          sum += a[r + Math.min(w - 1, x + radius + 1)]! - a[r + Math.max(0, x - radius)]!
        }
      }
      for (let x = 0; x < w; x++) {
        let sum = 0
        for (let k = -radius; k <= radius; k++) sum += b[Math.min(h - 1, Math.max(0, k)) * w + x]!
        for (let y = 0; y < h; y++) {
          a[y * w + x] = sum / n
          sum += b[Math.min(h - 1, y + radius + 1) * w + x]! - b[Math.max(0, y - radius) * w + x]!
        }
      }
    }
    for (let i = 0; i < w * h; i++) out[o + i] = Math.round(a[i]!)
  }
  return out
}

export type Storm = {
  lat: number
  lon: number
  /** kt */
  wind: number
  pressure: number
  /** Radius of maximum wind (m) */
  rmw: number
  /** Radius of gale-force wind (m) */
  r34: number
  /** 0 (a depression) - 1 (a super typhoon) */
  strength: number
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** The storm at `hour`: the track through the fixes as a Catmull-Rom curve, the rest linear. */
export function stormAt(track: Fix[], hour: number): Storm {
  const n = track.length
  let i = 0
  while (i < n - 2 && track[i + 1]!.hour <= hour) i++
  const a = track[i]!
  const b = track[i + 1]!
  const t = Math.min(1, Math.max(0, (hour - a.hour) / (b.hour - a.hour)))
  const p0 = track[Math.max(0, i - 1)]!
  const p3 = track[Math.min(n - 1, i + 2)]!
  const cr = (k: 'lat' | 'lon') => {
    const [v0, v1, v2, v3] = [p0[k], a[k], b[k], p3[k]]
    return 0.5 * (2 * v1 + (-v0 + v2) * t + (2 * v0 - 5 * v1 + 4 * v2 - v3) * t * t + (-v0 + 3 * v1 - 3 * v2 + v3) * t * t * t)
  }
  const lin = (x: number, y: number) => x + (y - x) * t
  const wind = lin(a.wind, b.wind)
  return {
    lat: cr('lat'),
    lon: cr('lon'),
    wind,
    pressure: lin(a.pressure ?? 1006, b.pressure ?? 1006),
    rmw: lin(a.rmw, b.rmw) * NM,
    r34: lin(a.r34, b.r34) * NM,
    strength: smooth(25, 150, wind),
  }
}

/** Saffir-Simpson-ish color of a wind (kt), from a pale depression to a deep super typhoon. */
export function windColor(kt: number): [number, number, number] {
  const stops: [number, [number, number, number]][] = [
    [25, [0.75, 0.85, 0.95]],
    [34, [0.55, 0.9, 0.85]],
    [64, [1.0, 0.92, 0.45]],
    [96, [1.0, 0.6, 0.25]],
    [130, [1.0, 0.25, 0.3]],
    [150, [0.95, 0.35, 0.95]],
  ]
  if (kt <= stops[0]![0]) return stops[0]![1]
  for (let i = 1; i < stops.length; i++) {
    const [k1, c1] = stops[i]!
    const [k0, c0] = stops[i - 1]!
    if (kt <= k1) {
      const f = (kt - k0) / (k1 - k0)
      return [0, 1, 2].map((j) => c0[j]! + (c1[j]! - c0[j]!) * f) as [number, number, number]
    }
  }
  return stops.at(-1)![1]
}

// --- the waves ---------------------------------------------------------------

type WavesMeta = {
  start: string
  every: number
  frames: number
  width: number
  height: number
  lat0: number
  lng0: number
  dlon: number
  scale: { swh: number; mwd: number; mwp: number }
  land: number
}

/**
 * ECMWF's waves under the storm (scripts/day26/fetch_waves.py), every 3 hours, and Day 12's wave
 * grid (waveSim.ts) to show them on: `at(hour)` blends the two scenes either side into it.
 */
export type Waves = {
  meta: WavesMeta
  grid: WaveGrid
  /** Fills `grid.data` for `hour` (since the clouds' start); false if it's the same as last time */
  at(hour: number): boolean
}

export async function loadWaves(base: string, start: number): Promise<Waves> {
  const meta = (await fetch(`${base}/waves/waves.json`).then((r) => r.json())) as WavesMeta
  const cells = meta.width * meta.height
  const frames = await Promise.all(
    Array.from({ length: meta.frames }, async (_, i) => {
      const blob = await fetch(`${base}/waves/${String(i).padStart(3, '0')}.webp`).then((r) => r.blob())
      // (no color management: the bytes are heights, directions and periods, not colors)
      const bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })
      const canvas = new OffscreenCanvas(meta.width, meta.height)
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!
      ctx.drawImage(bitmap, 0, 0)
      bitmap.close()
      return ctx.getImageData(0, 0, meta.width, meta.height).data
    }),
  )
  const grid: WaveGrid = { width: meta.width, height: meta.height, lat0: meta.lat0, lng0: meta.lng0, dlon: meta.dlon, data: new Uint16Array(cells * 3) }
  // Its edges are land: Day 12's grid wraps round the globe, this one doesn't
  const edge = (i: number) => {
    const x = i % meta.width
    const y = Math.floor(i / meta.width)
    return x === 0 || y === 0 || x === meta.width - 1 || y === meta.height - 1
  }
  const LAND_HALF = DataUtils.toHalfFloat(-1)
  const sin = Float32Array.from({ length: 256 }, (_, k) => Math.sin(((k * meta.scale.mwd) * Math.PI) / 180))
  const cos = Float32Array.from({ length: 256 }, (_, k) => Math.cos(((k * meta.scale.mwd) * Math.PI) / 180))
  const offset = (Date.parse(meta.start) - start) / 3_600_000
  let last = NaN

  return {
    meta,
    grid,
    at(hour) {
      // Twelve steps between scenes are plenty
      const f = Math.min(Math.max((hour - offset) / meta.every, 0), meta.frames - 1)
      const q = Math.round(f * 12) / 12
      if (q === last) return false
      last = q
      const i = Math.min(Math.floor(q), meta.frames - 2)
      const t = q - i
      const a = frames[i]!
      const b = frames[i + 1]!
      const out = grid.data
      for (let c = 0; c < cells; c++) {
        const o = c * 4
        if (edge(c) || a[o] === meta.land || b[o] === meta.land) {
          out[c * 3] = out[c * 3 + 1] = out[c * 3 + 2] = LAND_HALF
          continue
        }
        const swh = (a[o]! + (b[o]! - a[o]!) * t) * meta.scale.swh
        const mwp = (a[o + 2]! + (b[o + 2]! - a[o + 2]!) * t) * meta.scale.mwp
        // The direction as a vector, so 350° and 10° make 0°
        const x = sin[a[o + 1]!]! * (1 - t) + sin[b[o + 1]!]! * t
        const y = cos[a[o + 1]!]! * (1 - t) + cos[b[o + 1]!]! * t
        const mwd = ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360
        out[c * 3] = DataUtils.toHalfFloat(swh)
        out[c * 3 + 1] = DataUtils.toHalfFloat(mwd)
        out[c * 3 + 2] = DataUtils.toHalfFloat(mwp)
      }
      return true
    },
  }
}

// --- the winds ---------------------------------------------------------------

export type WindsMeta = {
  start: string
  every: number
  frames: number
  width: number
  height: number
  lat0: number
  lng0: number
  step: number
  /** m/s = (byte - 128) * scale */
  scale: number
}

/**
 * ECMWF's winds round the storm (scripts/day26/fetch_winds.py), every 3 hours, as a texture: one
 * RGBA layer a scene, rows from the south, u850, v850, u200, v200 as (m/s / scale) + 128.
 */
export type Winds = { meta: WindsMeta; texture: Data3DTexture; offset: number }

export async function loadWinds(base: string, start: number): Promise<Winds> {
  const meta = (await fetch(`${base}/winds/winds.json`).then((r) => r.json())) as WindsMeta
  const { width: w, height: h } = meta
  const bytes = new Uint8Array(w * h * 4 * meta.frames)
  await Promise.all(
    Array.from({ length: meta.frames }, async (_, i) => {
      const blob = await fetch(`${base}/winds/${String(i).padStart(3, '0')}.webp`).then((r) => r.blob())
      // (no color management: the bytes are winds, not colors)
      const bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })
      const canvas = new OffscreenCanvas(w, h * 2)
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!
      ctx.drawImage(bitmap, 0, 0)
      bitmap.close()
      const px = ctx.getImageData(0, 0, w, h * 2).data
      // 850 hPa over 200 hPa, north up in the file; from the south in the texture
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const low = ((h - 1 - y) * w + x) * 4
          const high = ((2 * h - 1 - y) * w + x) * 4
          const o = ((i * h + y) * w + x) * 4
          bytes[o] = px[low]!
          bytes[o + 1] = px[low + 1]!
          bytes[o + 2] = px[high]!
          bytes[o + 3] = px[high + 1]!
        }
      }
    }),
  )
  const texture = new Data3DTexture(bytes, w, h, meta.frames)
  texture.format = RGBAFormat
  texture.type = UnsignedByteType
  texture.minFilter = texture.magFilter = LinearFilter
  texture.needsUpdate = true
  return { meta, texture, offset: (Date.parse(meta.start) - start) / 3_600_000 }
}

// --- the sea's temperature -----------------------------------------------------

type SstMeta = {
  days: string[]
  width: number
  height: number
  /** The first column's and the first (north) row's cell centres */
  lng0: number
  lat0: number
  step: number
  /** °C = byte / scale - offset */
  offset: number
  scale: number
  land: number
}

/**
 * NOAA OISST under the storm (scripts/day26/fetch_sst.py), a day at a time: `at(hour)` blends
 * the two days either side into `texture` (a byte a cell, °C as in the files; the land given the
 * sea's nearby, so it doesn't bleed in at the coasts), over `box` (west, south, width, height °).
 */
export type Sst = {
  meta: SstMeta
  texture: DataTexture
  box: [number, number, number, number]
  /** Fills `texture` for `hour` (since the clouds' start); false if it's the same as last time */
  at(hour: number): boolean
}

export async function loadSst(base: string, start: number): Promise<Sst> {
  const meta = (await fetch(`${base}/sst/sst.json`).then((r) => r.json())) as SstMeta
  const { width: w, height: h } = meta
  const days = await Promise.all(
    meta.days.map(async (_, i) => {
      const blob = await fetch(`${base}/sst/${String(i).padStart(2, '0')}.webp`).then((r) => r.blob())
      // (no color management: the bytes are temperatures, not colors)
      const bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })
      const canvas = new OffscreenCanvas(w, h)
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!
      ctx.drawImage(bitmap, 0, 0)
      bitmap.close()
      const px = ctx.getImageData(0, 0, w, h).data
      // North up in the file; from the south in the texture
      const day = new Uint8Array(w * h)
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) day[y * w + x] = px[((h - 1 - y) * w + x) * 4]!
      return fillLand(day, w, h, meta.land)
    }),
  )
  const data = new Uint8Array(w * h)
  const texture = new DataTexture(data, w, h, RedFormat, UnsignedByteType)
  texture.minFilter = texture.magFilter = LinearFilter
  texture.unpackAlignment = 1
  // Each day's mean at its noon
  const noon0 = (Date.parse(`${meta.days[0]}T12:00:00Z`) - start) / 3_600_000
  let last = NaN
  return {
    meta,
    texture,
    box: [meta.lng0 - meta.step / 2, meta.lat0 - (h - 0.5) * meta.step, w * meta.step, h * meta.step],
    at(hour) {
      // Twelve steps a day are plenty
      const f = Math.min(Math.max((hour - noon0) / 24, 0), days.length - 1)
      const q = Math.round(f * 12) / 12
      if (q === last) return false
      last = q
      const i = Math.min(Math.floor(q), days.length - 2)
      const t = q - i
      const a = days[i]!
      const b = days[i + 1]!
      for (let k = 0; k < data.length; k++) data[k] = Math.round(a[k]! + (b[k]! - a[k]!) * t)
      texture.needsUpdate = true
      return true
    },
  }
}

// Land and ice cells given the mean of the sea round them, spread inland a cell at a time
function fillLand(day: Uint8Array, w: number, h: number, land: number): Uint8Array {
  const out = day.slice()
  let known = Uint8Array.from(day, (v) => (v === land ? 0 : 1))
  for (let pass = 0, left = true; left && pass < 64; pass++) {
    left = false
    const next = known.slice()
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x
        if (known[i]) continue
        let sum = 0
        let n = 0
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const xx = x + dx
          const yy = y + dy
          if (xx < 0 || yy < 0 || xx >= w || yy >= h || !known[yy * w + xx]) continue
          sum += out[yy * w + xx]!
          n++
        }
        if (n) {
          out[i] = Math.round(sum / n)
          next[i] = 1
        } else left = true
      }
    }
    known = next
  }
  return out
}
