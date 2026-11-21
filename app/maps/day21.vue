<script setup lang="ts">
// Day 21: OpenStreetMap — a year of OSM edits (2025-11-01 to 2026-10-31) played back on the
// globe, every node created, modified or deleted flaring where it happened and leaving a faint
// mark. Japan on its own, or the world split into six regions side by side on one clock.
// Data: OSM's daily replication diffs, counted per cell and hour (scripts/day21/)
import ThreeView, { Color, geodeticToVector3 } from '@navaramap/three'
import { DefaultPlugin, type DefaultDescriptions } from '@navaramap/three-default-plugin'
import { TileJsonPlugin } from '@navaramap/three-plugins'
import { OsmEditsMeshDesc, type OsmEditsConfig } from './lib/OsmEditsMeshDesc'
import { StarfieldMeshDesc, type StarfieldConfig } from './lib/StarfieldMeshDesc'
import { LimbGlowMeshDesc, type LimbGlowConfig } from './lib/LimbGlowMeshDesc'
import { loadEdits, within, type EditPoints, type EditsMeta } from './lib/osmEdits'

const baseURL = useRuntimeConfig().app.baseURL
const dataURL = `${baseURL}data/day21`

const NAVY = '#050816'
// Seconds a spark takes to fade, but never longer than a day of the data (a busy cell has an
// entry every hour; sparks lasting days would pile up into a white blot)
const SPARK_S = 0.45
const SPARK_MAX_DAYS = 1
// Pause at the end of the year before it starts over
const HOLD_S = 3

type CameraSpot = { lng: number; lat: number; distance: number; heading: number; pitch: number; roll: number }
type Region = { name: string; camera: CameraSpot }

const JAPAN: CameraSpot = { lng: 135.0, lat: 33.4, distance: 2_000_000, heading: -38, pitch: -58, roll: 0 }
const top = (lng: number, lat: number, distance: number): CameraSpot => ({ lng, lat, distance, heading: 0, pitch: -90, roll: 0 })
const REGIONS: Region[] = [
  { name: 'North America', camera: top(-97, 41, 7_500_000) },
  { name: 'Europe', camera: top(13, 51, 4_800_000) },
  { name: 'Asia', camera: top(108, 30, 8_000_000) },
  { name: 'South America', camera: top(-62, -20, 8_000_000) },
  { name: 'Africa', camera: top(19, 2, 8_500_000) },
  { name: 'Oceania', camera: top(150, -22, 7_500_000) },
]

const SPEEDS = [
  { label: '1 day/s', days: 1 },
  { label: '1 week/s', days: 7 },
  { label: '1 month/s', days: 30 },
]

type Mode = 'japan' | 'world'

const mode = ref<Mode>('japan')
const speed = ref(7)
const playing = ref(true)
const now = ref(0) // days since the start
const japanMeta = ref<EditsMeta>()
const worldMeta = ref<EditsMeta>()
const meta = computed(() => (mode.value === 'japan' ? japanMeta.value : worldMeta.value))
const loading = ref(true)
const japanEl = ref<HTMLDivElement>()
const panelEls = ref<HTMLDivElement[]>([])

type Panel = { view: ThreeView<DefaultDescriptions>; mesh: { ref: OsmEditsMeshDesc } }
let japanPanel: Panel | undefined
let worldPanels: Panel[] = []
let worldPoints: Promise<EditPoints> | undefined
let alive = true
let raf = 0

const START = Date.UTC(2025, 10, 1)
const dateOf = (d: number) => new Date(START + Math.floor(d) * 86_400_000)
const dateLabel = computed(() =>
  dateOf(Math.min(now.value, (meta.value?.days ?? 1) - 0.001)).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }),
)
const today = computed<[number, number, number]>(
  () => meta.value?.daily[Math.min(Math.floor(now.value), meta.value.days - 1)] ?? [0, 0, 0],
)
const fmt = (n: number) => n.toLocaleString('en-US')

// The timeline's bars: each day's edits, stacked by kind
const BAR_H = 44
const bars = computed(() => {
  const m = meta.value
  if (!m) return []
  const max = Math.max(...m.daily.map((d) => d[0] + d[1] + d[2]))
  return m.daily.map(([c, mo, de], i) => {
    const s = BAR_H / max
    return { x: i, created: c * s, modified: mo * s, deleted: de * s }
  })
})

// One generation per switch of mode: a panel that finishes loading after the next switch goes away
let generation = 0

/**
 * A view on its own canvas with the basemap and the edits. The points are loaded once the view is
 * up (Navara's geodetic maths needs an initialized view), relative to `anchorAt` (or the Earth's
 * centre). Resolves undefined if the mode changed meanwhile.
 */
async function makePanel(
  container: HTMLElement,
  camera: CameraSpot,
  load: (anchor: { x: number; y: number; z: number }) => Promise<EditPoints>,
  anchorAt?: { lng: number; lat: number },
): Promise<Panel | undefined> {
  const gen = generation
  const stale = () => !alive || gen !== generation
  const v = new ThreeView<DefaultDescriptions>({
    container,
    backgroundColor: new Color().setStyle(NAVY),
    animation: true,
    // Each tile's mesh in this many strips a side (Navara's default, 10, leaves the globe seen from
    // afar visibly polygonal at its edge; as in Day 17)
    segments: 40,
    pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
  })
  const drop = () => (v.dispose(), undefined)
  v.addPlugin(new DefaultPlugin())
  const tilejson = new TileJsonPlugin()
  v.addPlugin(tilejson)
  await v.init()
  if (stale()) return drop()
  v.registerMesh('osmEdits', OsmEditsMeshDesc)
  v.registerMesh('starfield', StarfieldMeshDesc)
  v.registerMesh('limbGlow', LimbGlowMeshDesc)
  v.setCamera({ ...camera, height: 0 })

  const starfield: StarfieldConfig = { starfield: {} }
  v.addMesh<StarfieldMeshDesc>(starfield)
  const limbGlow: LimbGlowConfig = { limbGlow: { color: new Color().setStyle('#3d6bff'), intensity: 0.7, scaleHeight: 90_000 } }
  v.addMesh<LimbGlowMeshDesc>(limbGlow)
  // The dark Re:Earth Papers basemap, as in Day 20; the plugin credits it from the TileJSON
  const basemap = await tilejson.addSource({ type: 'raster-tile', url: 'https://papers.reearth.land/styles/papers-dark/tilejson.json' })
  if (stale()) return drop()
  v.addLayer({ type: 'raster', source: basemap })

  const anchor = anchorAt ? geodeticToVector3({ ...anchorAt, height: 0 }) : { x: 0, y: 0, z: 0 }
  const points = await load(anchor)
  if (stale()) return drop()
  const bloom = v.addEffect({ selectiveBloom: { strength: 0.6, radius: 0.5, threshold: 0 } })
  const cell = points.meta.grid.res * 111_000
  const config: OsmEditsConfig = { effectIds: [bloom.id], osmEdits: { anchor, points, cell } }
  const mesh = v.addMesh<OsmEditsMeshDesc>(config)

  v.on('preUpdate', () => {
    mesh.ref.tick(now.value, Math.min(SPARK_S * speed.value, SPARK_MAX_DAYS), container.clientHeight / 2, Math.min(window.devicePixelRatio || 1, 2))
  })
  v.attribution?.add([
    { attributionHtml: 'Edits: <a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a> (replication diffs)' },
  ])
  return { view: v, mesh }
}

async function showJapan() {
  if (!japanEl.value) return
  loading.value = true
  const panel = await makePanel(
    japanEl.value,
    JAPAN,
    async (anchor) => {
      const points = await loadEdits(`${dataURL}/japan`, anchor)
      japanMeta.value = points.meta
      return points
    },
    { lng: 137, lat: 36 },
  )
  if (!panel) return
  japanPanel = panel
  loading.value = false
}

async function showWorld() {
  loading.value = true
  await nextTick()
  // One load shared by all six panels (and kept for the next visit)
  const load = () =>
    (worldPoints ??= loadEdits(`${dataURL}/world`, { x: 0, y: 0, z: 0 }).then((p) => {
      worldMeta.value = p.meta
      return p
    }))
  const els = panelEls.value
  // Each panel takes only the points on its side of the globe
  const panels = await Promise.all(
    REGIONS.map((r, i) => makePanel(els[i]!, r.camera, async () => within(await load(), r.camera.lng, r.camera.lat, 50))),
  )
  if (panels.some((p) => !p)) {
    panels.forEach((p) => p?.view.dispose())
    return
  }
  worldPanels = panels as Panel[]
  loading.value = false
}

function dropAll() {
  japanPanel?.view.dispose()
  japanPanel = undefined
  worldPanels.forEach((p) => p.view.dispose())
  worldPanels = []
}

async function setMode(m: Mode) {
  if (m === mode.value) return
  generation++
  // Only one mode's views at a time, so there are never more WebGL contexts than panels
  dropAll()
  mode.value = m
  document.documentElement.classList.toggle('day21-world', m === 'world')
  await nextTick()
  if (m === 'world') await showWorld()
  else await showJapan()
}

// The clock: runs at `speed` days per second, holds at the end, then starts the year over
let last = 0
let held = 0
function frame(t: number) {
  const dt = last ? Math.min(0.1, (t - last) / 1000) : 0
  last = t
  const days = meta.value?.days ?? 0
  if (playing.value && days) {
    if (now.value >= days) {
      held += dt
      if (held > HOLD_S) {
        held = 0
        now.value = 0
      }
    } else {
      now.value = Math.min(days, now.value + dt * speed.value)
    }
  }
  raf = requestAnimationFrame(frame)
}

// Scrubbing on the timeline
const scrubbing = ref(false)
function scrubTo(e: PointerEvent) {
  const el = e.currentTarget as HTMLElement
  const r = el.getBoundingClientRect()
  const days = meta.value?.days ?? 0
  now.value = Math.max(0, Math.min(days, ((e.clientX - r.left) / r.width) * days))
  held = 0
}
function scrubStart(e: PointerEvent) {
  scrubbing.value = true
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  scrubTo(e)
}
function scrubMove(e: PointerEvent) {
  if (scrubbing.value) scrubTo(e)
}

function togglePlay() {
  if (!playing.value && now.value >= (meta.value?.days ?? 0)) now.value = 0
  playing.value = !playing.value
}

onMounted(async () => {
  raf = requestAnimationFrame(frame)
  await showJapan()
})

onBeforeUnmount(() => {
  document.documentElement.classList.remove('day21-world')
  alive = false
  cancelAnimationFrame(raf)
  dropAll()
})
</script>

<template>
  <div class="map-canvas day21">
    <div v-if="mode === 'japan'" ref="japanEl" class="map-canvas" />
    <div v-else class="regions">
      <div v-for="r in REGIONS" :key="r.name" class="panel">
        <div ref="panelEls" class="map-canvas" />
        <span class="region">{{ r.name }}</span>
      </div>
    </div>

    <div class="controls">
      <div class="seg" role="group" aria-label="Region">
        <button type="button" :aria-pressed="mode === 'japan'" @click="setMode('japan')">Japan</button>
        <button type="button" :aria-pressed="mode === 'world'" @click="setMode('world')">World</button>
      </div>
      <div class="seg" role="group" aria-label="Speed">
        <button v-for="s in SPEEDS" :key="s.days" type="button" :aria-pressed="speed === s.days" @click="speed = s.days">
          {{ s.label }}
        </button>
      </div>
    </div>

    <div class="timeline">
      <div class="head">
        <button type="button" class="play" :aria-label="playing ? 'Pause' : 'Play'" @click="togglePlay">
          {{ playing ? '❚❚' : '▶' }}
        </button>
        <span class="date">{{ meta ? dateLabel : loading ? 'Loading…' : '' }}</span>
        <span v-if="meta" class="counts">
          <span class="c">+{{ fmt(today[0]) }} created</span>
          <span class="m">{{ fmt(today[1]) }} modified</span>
          <span class="d">−{{ fmt(today[2]) }} deleted</span>
          <span class="scope">nodes · {{ mode === 'japan' ? 'Japan' : 'worldwide' }}</span>
        </span>
      </div>
      <div
        class="track"
        @pointerdown="scrubStart"
        @pointermove="scrubMove"
        @pointerup="scrubbing = false"
        @pointercancel="scrubbing = false"
      >
        <svg v-if="meta" :viewBox="`0 0 ${meta.days} ${BAR_H}`" preserveAspectRatio="none">
          <g v-for="b in bars" :key="b.x">
            <rect :x="b.x" :y="BAR_H - b.created" width="0.8" :height="b.created" class="c" />
            <rect :x="b.x" :y="BAR_H - b.created - b.modified" width="0.8" :height="b.modified" class="m" />
            <rect :x="b.x" :y="BAR_H - b.created - b.modified - b.deleted" width="0.8" :height="b.deleted" class="d" />
          </g>
          <!-- Days still to come, dimmed: one rect, so the bars don't re-render every frame -->
          <rect :x="now" y="0" :width="Math.max(0, meta.days - now)" :height="BAR_H" class="ahead" />
        </svg>
        <div v-if="meta" class="playhead" :style="{ left: `${(now / meta.days) * 100}%` }" />
      </div>
    </div>
  </div>
</template>

<style>
/* World mode: the page's title panel down to its links, title and subtitle, over a band the panels leave free */
html.day21-world .map-header .date,
html.day21-world .map-header .desc {
  display: none;
}
</style>

<style scoped>
.day21 {
  position: relative;
}

.regions {
  position: absolute;
  /* Under the (shrunk) title panel and clear of the timeline, so no region is under either */
  inset: 116px 0 128px;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  grid-template-rows: repeat(2, 1fr);
  gap: 2px;
  background: #000;
}

@media (max-aspect-ratio: 1/1) {
  .regions {
    inset: 116px 0 158px;
    grid-template-columns: repeat(2, 1fr);
    grid-template-rows: repeat(3, 1fr);
  }
}

.panel {
  position: relative;
  min-width: 0;
  min-height: 0;
}

.region {
  position: absolute;
  left: 10px;
  bottom: 8px;
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--fg-muted);
  pointer-events: none;
}

.controls {
  position: absolute;
  top: 12px;
  right: 12px;
  z-index: 10;
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}

/* Matches the page's header panel */
.seg,
.timeline {
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
.play {
  padding: 8px 12px;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  color: var(--fg-muted);
  background: transparent;
  border: 0;
  cursor: pointer;
}

.seg button[aria-pressed='true'] {
  color: #050816;
  background: linear-gradient(135deg, #4dffa8, #ffb84d);
}

.seg button:not([aria-pressed='true']):hover,
.play:hover {
  color: var(--accent);
}

.timeline {
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: 40px;
  z-index: 10;
  padding: 6px 12px 10px;
  font-size: 12px;
  color: var(--fg);
}

.head {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px 14px;
  margin-bottom: 6px;
}

.play {
  padding: 4px 6px;
  width: 28px;
}

.date {
  font-size: 14px;
  font-weight: 600;
  min-width: 128px;
  font-variant-numeric: tabular-nums;
}

.counts {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  font-variant-numeric: tabular-nums;
}

.counts .c {
  color: #4dffa8;
}
.counts .m {
  color: #ffb84d;
}
.counts .d {
  color: #ff4772;
}
.counts .scope {
  color: var(--fg-muted);
}

.track {
  position: relative;
  height: 44px;
  cursor: ew-resize;
  touch-action: none;
}

.track svg {
  display: block;
  width: 100%;
  height: 100%;
}

rect.c {
  fill: #4dffa8;
}
rect.m {
  fill: #ffb84d;
}
rect.d {
  fill: #ff4772;
}
rect.ahead {
  fill: rgba(15, 20, 25, 0.65);
}

.playhead {
  position: absolute;
  top: -2px;
  bottom: -2px;
  width: 2px;
  margin-left: -1px;
  background: #fff;
  box-shadow: 0 0 6px #fff;
  pointer-events: none;
}
</style>
