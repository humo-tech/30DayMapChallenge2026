<script setup lang="ts">
// Day 20: Hexagons — HELLO CYCLING's stations binned into H3 cells, as glowing hexagonal prisms.
// The cells change resolution with the zoom (about the same size on screen at any height), and the
// view flips between flat tiles seen from above (2D) and columns standing on the map (3D).
// Reuses Day 4's data: public/data/day04/stations.geojson (scripts/day04/extract_stations.py)
import ThreeView, { Color } from '@navaramap/three'
import { DefaultPlugin, type DefaultDescriptions } from '@navaramap/three-default-plugin'
import { TileJsonPlugin } from '@navaramap/three-plugins'
import { HexPrismsMeshDesc, type HexPrismsConfig } from './lib/HexPrismsMeshDesc'
import { LimbGlowMeshDesc, type LimbGlowConfig } from './lib/LimbGlowMeshDesc'
import { StarfieldMeshDesc, type StarfieldConfig } from './lib/StarfieldMeshDesc'
import { buildCells, pickRes, type H3Set, type StationPoint } from './lib/h3Cells'

const baseURL = useRuntimeConfig().app.baseURL
const stationsURL = `${baseURL}data/day04/stations.geojson`

const NAVY = '#050816'

// A cell's edge on screen, about this many px, at whatever height the camera is
const EDGE_PX = 22
// The camera: all of Japan -> down into central Tokyo, once; and the tilt of the 3D view
const JAPAN_VIEW = { lng: 137.5, lat: 35.4, distance: 3_000_000, heading: 0, pitch: -55, roll: 0 }
const TOKYO_VIEW = { lng: 139.76, lat: 35.68, distance: 24_000, heading: 20, pitch: -52, roll: 0 }
const TILT_3D = -52
const HEADING_3D = 20
const INTRO_MS = 12_000
const MODE_MS = 1300

type Mode = '2d' | '3d'

const container = ref<HTMLDivElement>()
const mode = ref<Mode>('3d')
const info = ref({ res: 0, cells: 0, edge: '' })
let view: ThreeView<DefaultDescriptions> | undefined
let setMode: ((m: Mode) => void) | undefined
let replay: (() => void) | undefined

const edgeLabel = (m: number) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10_000 ? 1 : 0)} km`)

onMounted(async () => {
  const v = new ThreeView<DefaultDescriptions>({
    container: container.value!,
    backgroundColor: new Color().setStyle(NAVY),
    animation: true,
    pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
  })
  view = v
  v.addPlugin(new DefaultPlugin())
  const tilejson = new TileJsonPlugin()
  v.addPlugin(tilejson)
  await v.init()
  if (view !== v) return // unmounted while initializing
  v.registerMesh('limbGlow', LimbGlowMeshDesc)
  v.registerMesh('starfield', StarfieldMeshDesc)
  v.registerMesh('hexPrisms', HexPrismsMeshDesc)

  v.setCamera({ ...JAPAN_VIEW, height: 0 })

  const limbGlow: LimbGlowConfig = { limbGlow: { color: new Color().setStyle('#6a5cff'), intensity: 0.9, scaleHeight: 90_000 } }
  v.addMesh<LimbGlowMeshDesc>(limbGlow)
  const starfield: StarfieldConfig = { starfield: {} }
  v.addMesh<StarfieldMeshDesc>(starfield)

  // The dark sibling of the basemap Navara's own examples use (Re:Earth Papers); the plugin credits it from the TileJSON
  const basemap = await tilejson.addSource({
    type: 'raster-tile',
    url: 'https://papers.reearth.land/styles/papers-dark/tilejson.json',
  })
  if (view !== v) return
  v.addLayer({ type: 'raster', source: basemap })

  const geojson: { features: { properties: { capacity: number }; geometry: { coordinates: [number, number] } }[] } = await (
    await fetch(stationsURL)
  ).json()
  if (view !== v) return
  const stations: StationPoint[] = geojson.features.map((f) => ({
    lng: f.geometry.coordinates[0],
    lat: f.geometry.coordinates[1],
    capacity: f.properties.capacity,
  }))

  // Cells per resolution, built the first time a zoom asks for them
  const sets = new Map<number, H3Set>()
  const setFor = (res: number) => {
    let s = sets.get(res)
    if (!s) sets.set(res, (s = buildCells(stations, res)))
    return s
  }

  const bloom = v.addEffect({ selectiveBloom: { strength: 0.5, radius: 0.4, threshold: 0.5 } })
  const hexConfig: HexPrismsConfig = {
    effectIds: [bloom.id],
    hexPrisms: { anchor: { lng: 137.5, lat: 36 }, fill: 0.9, height: 6, glow: 0.3, sparkle: 0.5, duration: 800 },
  }
  const hex = v.addMesh<HexPrismsMeshDesc>(hexConfig)

  // Navara's zoom comes from the camera's height; a tilted camera sees the ground at the view
  // centre farther off, along its line of sight
  const centreZoom = () => {
    const pitch = Math.abs(v.camera.orientation.pitch ?? -90)
    return (v.camera.zoom ?? 0) + Math.log2(Math.sin((pitch * Math.PI) / 180))
  }

  // Where the camera looks at the ground, and how far it is from there (a flat-earth estimate: good for city-sized views)
  const lookAt = () => {
    const { lng, lat, height } = v.camera.positionGeographic
    const heading = v.camera.orientation.heading ?? 0
    const pitch = v.camera.orientation.pitch ?? -90
    const p = (Math.min(90, Math.max(5, Math.abs(pitch))) * Math.PI) / 180
    const ground = height / Math.tan(p)
    const h = (heading * Math.PI) / 180
    return {
      lng: lng + (ground * Math.sin(h)) / (111_320 * Math.cos((lat * Math.PI) / 180)),
      lat: lat + (ground * Math.cos(h)) / 111_320,
      distance: height / Math.sin(p),
      heading,
    }
  }

  // The flat <-> columns mix, eased by the shader; this only runs it from one end to the other
  let extrude = { from: 0, to: 0, start: 0 }
  const rise = (to: number) => {
    const now = performance.now()
    const t = Math.min(1, (now - extrude.start) / MODE_MS)
    extrude = { from: extrude.from + (extrude.to - extrude.from) * t, to, start: now }
  }

  let res: number | undefined
  v.on('preUpdate', () => {
    const now = performance.now()
    const lat = v.camera.positionGeographic.lat
    const metersPerPx = (156_543.03 * Math.cos((lat * Math.PI) / 180)) / 2 ** centreZoom()

    // The cells follow the zoom
    const next = pickRes(metersPerPx, EDGE_PX, res)
    if (next !== res) {
      res = next
      const set = setFor(next)
      hex.ref.show(set)
      info.value = { res: next, cells: set.cells.length, edge: edgeLabel(set.edge) }
    }

    const t = Math.min(1, (now - extrude.start) / MODE_MS)
    hex.ref.setExtrude(extrude.from + (extrude.to - extrude.from) * t)
    const c = lookAt()
    hex.ref.setFocus(c.lng, c.lat, metersPerPx * Math.min(window.innerWidth, window.innerHeight) * 0.9)
    hex.ref.tick(now)
  })

  v.attribution?.add([
    {
      attributionHtml:
        'Stations: <a href="https://www.hellocycling.jp/">HELLO CYCLING</a> (GBFS) · Cells: <a href="https://h3geo.org/">H3</a>',
    },
  ])

  // One run of the intro at a time; anything else that moves the camera bumps the number and ends it
  let run = 0
  const intro = async () => {
    const id = ++run
    const live = () => view === v && id === run
    if (mode.value === '3d') extrude = { from: extrude.from, to: 0, start: performance.now() }
    v.setCamera({ ...(mode.value === '3d' ? JAPAN_VIEW : { ...JAPAN_VIEW, pitch: -90, heading: 0 }), height: 0 })
    await new Promise((r) => setTimeout(r, 900))
    if (!live()) return
    if (mode.value === '3d') rise(1)
    await new Promise((r) => setTimeout(r, 2200))
    if (!live()) return
    const to = mode.value === '3d' ? TOKYO_VIEW : { ...TOKYO_VIEW, pitch: -90, heading: 0 }
    await v.flyTo(to, { duration: INTRO_MS, easing: 'cubicInOut' })
  }
  replay = () => void intro()

  setMode = (m) => {
    if (m === mode.value) return
    mode.value = m
    run++ // the intro, if it's still flying, is over
    const c = lookAt()
    v.flyTo(
      {
        lng: c.lng,
        lat: c.lat,
        distance: c.distance,
        heading: m === '3d' ? (c.heading || HEADING_3D) : 0,
        pitch: m === '3d' ? TILT_3D : -90,
        roll: 0,
      },
      { duration: MODE_MS, easing: 'cubicInOut' },
    )
    rise(m === '3d' ? 1 : 0)
  }

  void intro()
})

onBeforeUnmount(() => {
  setMode = undefined
  replay = undefined
  view?.dispose()
  view = undefined
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
