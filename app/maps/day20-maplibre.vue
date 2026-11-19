<script setup lang="ts">
// Day 20: Hexagons, on MapLibre GL JS (the hidden page /day/20-maplibre) — the same glowing H3
// prisms as the Navara map (day20.vue), drawn by a custom layer (hexPrismsLayer.ts) that shares
// the Navara version's shaders and brings its own bloom. Mercator only: no globe, no stars, no
// glow round the Earth's edge.
// Reuses Day 4's data: public/data/day04/stations.geojson (scripts/day04/extract_stations.py)
import * as maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
// MapLibre finds its worker next to its own module, which Vite's bundling moves: point it there
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'
import { buildCells, pickRes, type H3Set, type StationPoint } from './lib/h3Cells'
import { hexPrismsLayer, type HexPrismsLayer } from './lib/hexPrismsLayer'

maplibregl.setWorkerUrl(workerUrl)

const stationsURL = `${useRuntimeConfig().app.baseURL}data/day04/stations.geojson`

const NAVY = '#050816'

// A cell's edge on screen, about this many px, at whatever height the camera is. The Navara map
// asks for 22, but its cells come out about twice that on screen (its metres per pixel, from
// Navara's zoom, run small); MapLibre's zoom gives them as seen, so this matches the Navara map
const EDGE_PX = 44
// The Navara map's views, in MapLibre's terms: pitch from straight down (Navara's -52° below the
// horizon is 38°), and the zoom that frames about the same on a ~900 px tall window
const JAPAN_VIEW = { center: [137.5, 35.4] as [number, number], zoom: 4.4, bearing: 0, pitch: 35 }
const TOKYO_VIEW = { center: [139.76, 35.68] as [number, number], zoom: 12.5, bearing: 20, pitch: 38 }
const TILT_3D = 38
const HEADING_3D = 20
const INTRO_MS = 12_000
const MODE_MS = 1300

type Mode = '2d' | '3d'

const container = ref<HTMLDivElement>()
const mode = ref<Mode>('3d')
const info = ref({ res: 0, cells: 0, edge: '' })
let map: maplibregl.Map | undefined
let layer: HexPrismsLayer | undefined
let setMode: ((m: Mode) => void) | undefined
let replay: (() => void) | undefined

const edgeLabel = (m: number) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10_000 ? 1 : 0)} km`)
const flat = <T extends { bearing: number; pitch: number }>(v: T): T => ({ ...v, bearing: 0, pitch: 0 })
const cubicInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)

onMounted(async () => {
  const geojson: { features: { properties: { capacity: number }; geometry: { coordinates: [number, number] } }[] } = await (
    await fetch(stationsURL)
  ).json()
  if (!container.value) return // unmounted while loading
  const stations: StationPoint[] = geojson.features.map((f) => ({
    lng: f.geometry.coordinates[0],
    lat: f.geometry.coordinates[1],
    capacity: f.properties.capacity,
  }))

  const m = new maplibregl.Map({
    container: container.value,
    style: {
      version: 8,
      sources: {
        // The basemap the Navara map uses (Re:Earth Papers, dark)
        papers: { type: 'raster', url: 'https://papers.reearth.land/styles/papers-dark/tilejson.json', tileSize: 512 },
      },
      layers: [
        { id: 'night', type: 'background', paint: { 'background-color': NAVY } },
        { id: 'papers', type: 'raster', source: 'papers' },
      ],
    },
    ...(mode.value === '3d' ? JAPAN_VIEW : flat(JAPAN_VIEW)),
    maxPitch: 70,
    attributionControl: {
      customAttribution:
        'Stations: <a href="https://www.hellocycling.jp/">HELLO CYCLING</a> (GBFS) · Cells: <a href="https://h3geo.org/">H3</a>',
    },
  })
  map = m

  // Cells per resolution, built the first time a zoom asks for them
  const sets = new Map<number, H3Set>()
  const setFor = (res: number) => {
    let s = sets.get(res)
    if (!s) sets.set(res, (s = buildCells(stations, res)))
    return s
  }

  // The flat <-> columns mix, eased by the shader; this only runs it from one end to the other
  let extrude = { from: 0, to: 0, start: 0 }
  const rise = (to: number) => {
    const now = performance.now()
    const t = Math.min(1, (now - extrude.start) / MODE_MS)
    extrude = { from: extrude.from + (extrude.to - extrude.from) * t, to, start: now }
  }

  let res: number | undefined
  const l = hexPrismsLayer({
    anchor: { lng: 137.5, lat: 36 },
    fill: 0.9,
    height: 6,
    glow: 0.3,
    sparkle: 0.5,
    duration: 800,
    bloom: { strength: 0.5, radius: 0.4, threshold: 0.5 },
    // MapLibre's zoom is the view centre's, tilted or not
    beforeFrame: (now) => {
      const c = m.getCenter()
      const metersPerPx = (78_271.517 * Math.cos((c.lat * Math.PI) / 180)) / 2 ** m.getZoom()

      // The cells follow the zoom
      const next = pickRes(metersPerPx, EDGE_PX, res)
      if (next !== res) {
        res = next
        const set = setFor(next)
        l.show(set)
        info.value = { res: next, cells: set.cells.length, edge: edgeLabel(set.edge) }
      }

      const t = Math.min(1, (now - extrude.start) / MODE_MS)
      l.setExtrude(extrude.from + (extrude.to - extrude.from) * t)
      l.setFocus(c.lng, c.lat, metersPerPx * Math.min(window.innerWidth, window.innerHeight) * 0.9)
    },
  })
  layer = l
  m.once('load', () => {
    if (map === m) m.addLayer(l)
  })

  // One run of the intro at a time; anything else that moves the camera bumps the number and ends it
  let run = 0
  const intro = async () => {
    const id = ++run
    const live = () => map === m && id === run
    const tilted = mode.value === '3d'
    if (tilted) extrude = { from: extrude.from, to: 0, start: performance.now() }
    m.jumpTo(tilted ? JAPAN_VIEW : flat(JAPAN_VIEW))
    await new Promise((r) => setTimeout(r, 900))
    if (!live()) return
    if (tilted) rise(1)
    await new Promise((r) => setTimeout(r, 2200))
    if (!live()) return
    m.flyTo({ ...(tilted ? TOKYO_VIEW : flat(TOKYO_VIEW)), duration: INTRO_MS, easing: cubicInOut, essential: true })
  }
  replay = () => void intro()

  // MapLibre turns the camera about the point it looks at, so only the tilt and heading change
  setMode = (next) => {
    if (next === mode.value) return
    mode.value = next
    run++ // the intro, if it hasn't started flying, is over (easeTo stops a flight under way)
    m.easeTo({
      pitch: next === '3d' ? TILT_3D : 0,
      bearing: next === '3d' ? m.getBearing() || HEADING_3D : 0,
      duration: MODE_MS,
      easing: cubicInOut,
    })
    rise(next === '3d' ? 1 : 0)
  }

  void intro()
})

onBeforeUnmount(() => {
  setMode = undefined
  replay = undefined
  map?.remove()
  map = undefined
  layer?.dispose()
  layer = undefined
})
</script>

<template>
  <div class="map-canvas day20">
    <div ref="container" class="map-canvas" />

    <div class="controls">
      <div class="seg" role="group" aria-label="View">
        <button type="button" :aria-pressed="mode === '2d'" @click="setMode?.('2d')">2D</button>
        <button type="button" :aria-pressed="mode === '3d'" @click="setMode?.('3d')">3D</button>
      </div>
      <button type="button" class="again" title="Fly in from Japan again" @click="replay?.()">↻ Intro</button>
    </div>

    <div class="legend">
      <div v-if="info.res" class="read">
        H3 res <b>{{ info.res }}</b> · edge ≈ {{ info.edge }} · {{ info.cells.toLocaleString('en-US') }} cells
      </div>
      <div class="bar" />
      <div class="ends"><span>fewer docks</span><span>more (log)</span></div>
    </div>
  </div>
</template>

<style scoped>
.day20 {
  position: relative;
}

.controls {
  position: absolute;
  top: 12px;
  right: 12px;
  z-index: 10;
  display: flex;
  gap: 8px;
}

/* Matches the page's header panel */
.seg,
.again {
  background: rgba(15, 20, 25, 0.82);
  backdrop-filter: blur(6px);
  border: 1px solid var(--border);
  border-radius: 10px;
}

.seg {
  display: flex;
  overflow: hidden;
}

.seg button,
.again {
  padding: 8px 14px;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  color: var(--fg-muted);
  background: transparent;
  border: 0;
  cursor: pointer;
}

.again {
  border: 1px solid var(--border);
  background: rgba(15, 20, 25, 0.82);
  border-radius: 10px;
}

.seg button[aria-pressed='true'] {
  color: #050816;
  background: linear-gradient(135deg, #5be7ff, #ff6ee0);
}

.seg button:not([aria-pressed='true']):hover,
.again:hover {
  color: var(--accent);
}

.legend {
  position: absolute;
  left: 12px;
  bottom: 40px;
  z-index: 10;
  width: 220px;
  padding: 10px 12px;
  font-size: 12px;
  color: var(--fg);
  background: rgba(15, 20, 25, 0.82);
  backdrop-filter: blur(6px);
  border: 1px solid var(--border);
  border-radius: 10px;
  pointer-events: none;
}

.read {
  margin-bottom: 8px;
  font-variant-numeric: tabular-nums;
}

.bar {
  height: 8px;
  border-radius: 4px;
  background: linear-gradient(90deg, #1a2473, #2b6bfa, #1adbe0, #ff4dd9, #ffd140, #fff8e6);
}

.ends {
  display: flex;
  justify-content: space-between;
  margin-top: 4px;
  color: var(--fg-muted);
  font-size: 11px;
}
</style>
