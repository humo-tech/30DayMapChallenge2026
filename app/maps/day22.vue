<script setup lang="ts">
// Day 22: Projections — the freehand projection. A designer's map is thinned and bent on purpose
// (coasts rounded off, Tokyo blown up, Okinawa in a box, Greenland shrunk), so no formula takes
// latitude and longitude onto it; a thin-plate spline through tie points does (lib/freehand.ts).
// The art is plain SVG, shown as it is; the pins, the graticule and the real borders on top of it
// all go through the projection. Click anywhere for the place under the pointer.
// Beside it, the same places on Web Mercator (lib/MercatorPane.vue): a click on either map puts a
// pin on both. "Align a PDF" fits the projection to a designer's own PDF, half by hand (lib/AlignPanel.vue).
// Data: scripts/day22/build_maps.py (the art and the ties) -> public/data/day22/
import {
  FreehandProjection,
  decodeRings,
  fmtLngLat,
  graticule as gridLines,
  inRings,
  parsePath,
  placePin,
  toPath,
  unjump,
  type MapData,
  type Placed,
  type Ring,
  type XY,
} from './lib/freehand'
import { usePanZoom } from './lib/usePanZoom'
import { warpRaster } from './lib/warpRaster'
import MercatorPane from './lib/MercatorPane.vue'
// pdf.js and the fitting load only when Align mode is opened
const AlignPanel = defineAsyncComponent(() => import('./lib/AlignPanel.vue'))

const dataURL = `${useRuntimeConfig().app.baseURL}data/day22`

type Mode = 'japan' | 'world' | 'align'
type MapMode = Exclude<Mode, 'align'>

type Loaded = {
  data: MapData
  art: string // the designer's SVG, inside its <svg>
  proj: FreehandProjection
  artRings: Map<string, Ring[]>
  dots: Map<string, XY>
  realRings: Map<string, Ring[]>
  pins: (Placed & { name: string; lng: number; lat: number; order: number })[]
  graticule?: string
  real?: string
  landPath?: string
  rasters: Partial<Record<Raster, Promise<string>>> // warped, by raster
}

// snap: how far (art units) a pin just off its region's art is moved onto it; only a hair, to cover
// a coast the designer smoothed, not to drag a pin in from the sea
type Settings = { pin: number; snap: number; grid: number; step: number; lng: [number, number]; lat: [number, number] }
// Blue Marble: the grid it's warped on (degrees), and its pixels per art unit
type Warp = { lng: [number, number]; lat: [number, number]; step: number; scale: number }
const SETTINGS: Record<MapMode, Settings & { warp: Warp }> = {
  japan: {
    pin: 0.72, snap: 3, grid: 1, step: 0.05, lng: [122, 150], lat: [23, 46],
    warp: { lng: [121.5, 150.5], lat: [22.5, 46.5], step: 0.08, scale: 2.5 },
  },
  // Parallels run from the cut at 30°W round to it again, so they don't jump across the map
  world: {
    pin: 0.55, snap: 3, grid: 15, step: 0.5, lng: [-30, 330], lat: [-60, 75],
    warp: { lng: [-30, 330], lat: [-60, 85], step: 1, scale: 2.5 },
  },
}

const mode = ref<Mode>('japan')
const mapMode = ref<MapMode>('japan') // the last map shown
const showTies = ref(false)
const showReal = ref(false)
// A raster warped onto the freehand map: NASA's Blue Marble, or a 0.5° grid to show the stretch
type Raster = 'bluemarble' | 'grid'
const raster = ref<Raster>()
const landOnly = ref(true)
const rasterUrl = ref<string>()
const warping = ref(false)
// On a phone the controls fold away (with Align mode's toolbar) behind one button
const controlsOpen = ref(true)
const alignBar = ref(0) // Align mode's toolbar height, to keep the controls above it on a phone
const toggleRaster = (r: Raster) => (raster.value = raster.value === r ? undefined : r)
const loaded = shallowRef<Loaded>()
const loading = ref(true)
const container = ref<HTMLDivElement>()
const cursor = ref<{ lng: number; lat: number } | null | undefined>()
const hover = ref<{ name: string; lng: number; lat: number; sx: number; sy: number }>()
// The place picked on either map (xy: where it is on the freehand map, null if off it)
const mine = ref<{ xy: XY | null; lng: number; lat: number; key: number }>()

const pz = usePanZoom(container, {
  content: () => loaded.value && { x0: 0, y0: 0, w: loaded.value.data.width, h: loaded.value.data.height },
  onClick: (p) => drop(p),
  onHover: (p) => readout(p),
  ignore: (t) => !!t.closest('.pin, .controls, .readout, .attribution'),
})
const { view, size, viewBox, fit } = pz

const cache = new Map<MapMode, Promise<Loaded>>()

async function load(m: MapMode): Promise<Loaded> {
  const [data, svgText] = await Promise.all([
    fetch(`${dataURL}/${m}.json`).then((r) => r.json() as Promise<MapData>),
    fetch(`${dataURL}/${m}.svg`).then((r) => r.text()),
  ])
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml')
  const svg = doc.documentElement
  svg.querySelector('title')?.remove()
  const artRings = new Map<string, Ring[]>()
  svg.querySelectorAll('#land path').forEach((p) => artRings.set(p.id, parsePath(p.getAttribute('d') ?? '')))
  const dots = new Map<string, XY>()
  svg.querySelectorAll('#land circle').forEach((c) => dots.set(c.id, [Number(c.getAttribute('cx')), Number(c.getAttribute('cy'))]))

  const proj = new FreehandProjection(data)
  const s = SETTINGS[m]
  const pins = data.pins
    .map((p) => {
      const raw = proj.project(p.lng, p.lat)
      if (!raw) return null
      const placed = placePin(raw, artRings.get(p.region), dots.get(p.region), s.snap, 1)
      return { ...placed, name: p.name, lng: p.lng, lat: p.lat, order: 0 }
    })
    .filter((p) => p !== null)
  // They drop in from north to south
  ;[...pins].sort((a, b) => a.xy[1] - b.xy[1]).forEach((p, i) => (p.order = i))

  const realRings = new Map(data.regions.map((r) => [r.id, decodeRings(r.rings, data.quantum)]))
  return { data, art: svg.innerHTML, proj, artRings, dots, realRings, pins, rasters: {} }
}

async function show(m: Mode) {
  hover.value = undefined
  mine.value = undefined
  if (m === 'align') return
  mapMode.value = m
  loading.value = true
  let p = cache.get(m)
  if (!p) cache.set(m, (p = load(m)))
  const l = await p
  if (mode.value !== m) return
  loaded.value = l
  loading.value = false
  await nextTick()
  fit()
}

watch(mode, show)

// The graticule and the real borders are worked out the first time they're asked for
const graticule = computed(() => {
  const l = loaded.value
  if (!l || !showTies.value) return ''
  if (l.graticule === undefined) {
    const s = SETTINGS[mapMode.value]
    l.graticule = toPath(unjump(gridLines(l.proj, s.lng, s.lat, s.grid, s.step), l.data.width / 4))
  }
  return l.graticule
})

const real = computed(() => {
  const l = loaded.value
  if (!l || !showReal.value) return ''
  if (l.real === undefined) {
    const lines: XY[][] = []
    for (const rings of l.realRings.values()) {
      for (const r of rings) lines.push(...l.proj.line([...r, r[0]!]))
    }
    l.real = toPath(unjump(lines, l.data.width / 4))
  }
  return l.real
})

// ---- Rasters warped onto the art (lib/warpRaster.ts), each the first time it's asked for.
// Blue Marble comes per map (scripts/day22/fetch_blue_marble.py); so does the grid
// (scripts/day22/make_grid.py): the world 3600 x 1800 with lines every 0.5°, Japan cut from a
// 10800-wide base (30 px per degree) with lines every 0.2°.

type RasterSource = { file: string; bbox: [number, number, number, number] }
const GRIDS: Record<MapMode, RasterSource & { step: number }> = {
  japan: { file: 'grid-japan.png', bbox: [121, 22, 151, 47], step: 0.2 },
  world: { file: 'grid-3600x1800.png', bbox: [-180, -90, 180, 90], step: 0.5 },
}
let blueMarbleMeta: Promise<Record<MapMode, RasterSource>> | undefined

async function rasterSource(r: Raster, m: MapMode): Promise<RasterSource> {
  if (r === 'grid') return GRIDS[m]
  blueMarbleMeta ??= fetch(`${dataURL}/bluemarble.json`).then((res) => res.json())
  return (await blueMarbleMeta)[m]
}

async function warp(l: Loaded, r: Raster, m: MapMode): Promise<string> {
  const src = await rasterSource(r, m)
  const image = new Image()
  image.src = `${dataURL}/${src.file}`
  await image.decode()
  return warpRaster(l.proj, image, { bbox: src.bbox, width: l.data.width, height: l.data.height, ...SETTINGS[m].warp })
}

watch([raster, loaded], async ([r, l]) => {
  rasterUrl.value = undefined
  const m = mapMode.value
  if (!r || !l) return
  warping.value = true
  try {
    const url = await (l.rasters[r] ??= warp(l, r, m))
    if (loaded.value === l && raster.value === r) rasterUrl.value = url
  } finally {
    warping.value = false
  }
})

/** Every region's outline on the art (dots for the smallest countries), to clip Blue Marble to the land */
const landPath = computed(() => {
  const l = loaded.value
  if (!l || !raster.value) return ''
  if (l.landPath === undefined) {
    const rings = [...l.artRings.values()].flat()
    const r = 3.2
    l.landPath =
      rings.map((ring) => 'M' + ring.map(([x, y]) => `${x} ${y}`).join('L') + 'Z').join('') +
      [...l.dots.values()].map(([x, y]) => `M${x - r} ${y}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`).join('')
  }
  return l.landPath
})

// The real borders for the Mercator map beside (all the regions' rings)
const realBorders = computed(() => (loaded.value ? [...loaded.value.realRings.values()].flat() : []))

const ties = computed(() => {
  const l = loaded.value
  if (!l || !showTies.value) return []
  return l.data.frames.flatMap((f) => (f.ties ?? []).map((t) => [t[2], t[3]] as XY))
})

let readoutFrame = 0
function readout(p: XY | null) {
  cancelAnimationFrame(readoutFrame)
  if (!p) {
    cursor.value = undefined
    return
  }
  readoutFrame = requestAnimationFrame(() => {
    const l = loaded.value
    if (!l) return
    const ll = l.proj.invert(p[0], p[1])
    cursor.value = ll ? { lng: ll[0], lat: ll[1] } : null
  })
}

function drop(xy: XY) {
  const l = loaded.value
  if (!l) return
  const ll = l.proj.invert(xy[0], xy[1])
  if (!ll) return
  mine.value = { xy, lng: ll[0], lat: ll[1], key: performance.now() }
}

/** A place picked on the Mercator map (or by geolocation): through the projection, onto its region's art */
function pickAt(lng: number, lat: number) {
  const l = loaded.value
  if (!l) return
  const raw = l.proj.project(lng, lat)
  let xy: XY | null = null
  if (raw) {
    const region = [...l.realRings].find(([, rings]) => inRings([lng, lat], rings))?.[0]
    const s = SETTINGS[mapMode.value]
    xy = placePin(raw, region ? l.artRings.get(region) : undefined, region ? l.dots.get(region) : undefined, s.snap, 1).xy
    // Bring it into view if it's off the edge
    const [sx, sy] = pz.toScreen(xy)
    const { w, h } = size.value
    if (sx < 0 || sy < 0 || sx > w || sy > h) view.value = { ...view.value, x: xy[0] - w / 2 / view.value.k, y: xy[1] - h / 2 / view.value.k }
  }
  mine.value = { xy, lng, lat, key: performance.now() }
}

// "Where am I": the browser's position, on both maps
const locating = ref(false)
function locate() {
  if (!navigator.geolocation) return
  locating.value = true
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      locating.value = false
      pickAt(pos.coords.longitude, pos.coords.latitude)
    },
    () => (locating.value = false),
    { enableHighAccuracy: false, timeout: 10_000 },
  )
}

function enterPin(e: PointerEvent, p: { name: string; lng: number; lat: number }) {
  const r = container.value!.getBoundingClientRect()
  hover.value = { ...p, sx: e.clientX - r.left, sy: e.clientY - r.top }
}

// Pins a fixed size on screen, smaller on a small screen, a little bigger as you zoom in
const pinPx = computed(() => {
  const { w, h } = size.value
  const f = pz.fitK()
  if (!loaded.value || !f) return 1 // hidden (Align mode)
  return Math.min(1, Math.max(0.6, Math.min(w, h) / 800)) * (view.value.k / f) ** 0.2
})
const pinScale = computed(() => (SETTINGS[mapMode.value].pin * pinPx.value) / view.value.k)

onMounted(() => show(mode.value))
onBeforeUnmount(() => cancelAnimationFrame(readoutFrame))
</script>

<template>
  <div class="map-canvas day22">
    <AlignPanel v-if="mode === 'align'" :folded="!controlsOpen" @bar-height="alignBar = $event" />
    <div
      v-show="mode !== 'align'"
      ref="container"
      class="viewer"
      @pointerdown="pz.handlers.onDown"
      @pointermove="pz.handlers.onMove"
      @pointerup="pz.handlers.onUp"
      @pointercancel="pz.handlers.onUp"
      @pointerleave="pz.handlers.onLeave"
      @wheel.prevent="pz.handlers.onWheel"
    >
    <svg v-if="loaded" :key="mapMode" class="stage" :viewBox="viewBox" preserveAspectRatio="xMinYMin meet">
      <!-- The designer's art, as delivered -->
      <g class="art" v-html="loaded.art" />

      <!-- A raster warped by the projection: on the land only, or sea and all; the borders back on top -->
      <template v-if="raster && rasterUrl">
        <defs>
          <clipPath id="day22-land"><path :d="landPath" clip-rule="evenodd" /></clipPath>
        </defs>
        <image
          :href="rasterUrl"
          x="0"
          y="0"
          :width="loaded.data.width"
          :height="loaded.data.height"
          preserveAspectRatio="none"
          :clip-path="landOnly ? 'url(#day22-land)' : undefined"
        />
        <path class="bm-borders" :class="raster" :d="landPath" />
      </template>

      <path v-if="showTies" class="graticule" :d="graticule" />
      <path v-if="showReal" class="real" :d="real" />
      <g v-if="showTies" class="ties">
        <circle v-for="(t, i) in ties" :key="i" :cx="t[0]" :cy="t[1]" :r="1.6 / view.k" />
        <template v-for="p in loaded.pins" :key="p.name">
          <g v-if="p.snapped" class="snap">
            <line :x1="p.raw[0]" :y1="p.raw[1]" :x2="p.xy[0]" :y2="p.xy[1]" />
            <circle :cx="p.raw[0]" :cy="p.raw[1]" :r="2.5 / view.k" />
          </g>
        </template>
      </g>

      <g class="pins">
        <g
          v-for="p in loaded.pins"
          :key="p.name"
          class="pin"
          :transform="`translate(${p.xy[0]} ${p.xy[1]}) scale(${pinScale})`"
          @pointerenter="enterPin($event, p)"
          @pointerleave="hover = undefined"
        >
          <g class="drop" :style="{ animationDelay: `${300 + p.order * (mapMode === 'japan' ? 28 : 9)}ms` }">
            <ellipse class="shadow" cx="0" cy="0" rx="5" ry="2" />
            <path class="head" d="M0 0C-1.5-5-8-10.5-8-17A8 8 0 0 1 8-17C8-10.5 1.5-5 0 0Z" />
            <circle class="eye" cx="0" cy="-17" r="3" />
          </g>
        </g>
        <g v-if="mine?.xy" :key="mine.key" class="pin mine" :transform="`translate(${mine.xy[0]} ${mine.xy[1]}) scale(${(0.9 * pinPx) / view.k})`">
          <g class="drop" style="animation-delay: 0ms">
            <ellipse class="shadow" cx="0" cy="0" rx="5" ry="2" />
            <path class="head" d="M0 0C-1.5-5-8-10.5-8-17A8 8 0 0 1 8-17C8-10.5 1.5-5 0 0Z" />
            <circle class="eye" cx="0" cy="-17" r="3" />
          </g>
        </g>
      </g>
    </svg>

    <div v-if="hover" class="tip" :style="{ left: `${hover.sx}px`, top: `${hover.sy}px` }">
      <strong>{{ hover.name }}</strong>
      <span>{{ fmtLngLat(hover.lng, hover.lat) }}</span>
    </div>
    <div
      v-if="mine?.xy && loaded"
      :key="mine.key"
      class="tip mine"
      :style="{ left: `${(mine.xy[0] - view.x) * view.k}px`, top: `${(mine.xy[1] - view.y) * view.k - 22}px` }"
    >
      <span>{{ fmtLngLat(mine.lng, mine.lat) }}</span>
    </div>

    <div class="readout">
      <span v-if="loading">Loading…</span>
      <span v-else-if="warping">Warping {{ raster === 'grid' ? 'the grid' : 'Blue Marble' }}…</span>
      <span v-else-if="cursor">{{ fmtLngLat(cursor.lng, cursor.lat) }}</span>
      <span v-else-if="cursor === null" class="off">off the map</span>
      <span v-else-if="mine && !mine.xy" class="off">{{ fmtLngLat(mine.lng, mine.lat) }} is off this map</span>
      <span v-else class="hint">Click either map: a pin on both</span>
    </div>

    <div class="attribution">
      <template v-if="mapMode === 'japan'">
        © <a href="https://overturemaps.org/">Overture Maps Foundation</a> · ©
        <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors
      </template>
      <template v-else><a href="https://www.naturalearthdata.com/">Natural Earth</a></template>
      <template v-if="raster === 'bluemarble'"> · Blue Marble: <a href="https://earthdata.nasa.gov/gibs">NASA GIBS</a></template>
    </div>
    </div>

    <!-- The same places on Web Mercator, to compare -->
    <div v-show="mode !== 'align'" class="mercator">
      <MercatorPane
        :view="mapMode"
        :pins="loaded?.data.pins ?? []"
        :picked="mine"
        :imagery="raster === 'bluemarble' ? 'bluemarble' : 'papers'"
        :grid="raster === 'grid' ? GRIDS[mapMode].step : undefined"
        :borders="realBorders"
        @pick="pickAt"
      />
    </div>

    <div
      class="controls"
      :class="{ folded: !controlsOpen, 'over-bar': mode === 'align' }"
      :style="{ '--align-bar': `${alignBar}px` }"
    >
      <div class="seg" role="group" aria-label="Map">
        <button type="button" :aria-pressed="mode === 'japan'" @click="mode = 'japan'">Japan</button>
        <button type="button" :aria-pressed="mode === 'world'" @click="mode = 'world'">World</button>
        <button type="button" :aria-pressed="mode === 'align'" @click="mode = 'align'">Align a PDF</button>
      </div>
      <template v-if="mode !== 'align'">
        <div class="seg" role="group" aria-label="Raster">
          <button type="button" :aria-pressed="raster === 'bluemarble'" @click="toggleRaster('bluemarble')">Blue Marble</button>
          <button type="button" :aria-pressed="raster === 'grid'" @click="toggleRaster('grid')">Grid {{ GRIDS[mapMode].step }}°</button>
          <button v-if="raster" type="button" :aria-pressed="landOnly" @click="landOnly = !landOnly">Land only</button>
        </div>
        <div class="seg" role="group" aria-label="Show">
          <button type="button" :aria-pressed="showTies" @click="showTies = !showTies">Ties</button>
          <button type="button" :aria-pressed="showReal" @click="showReal = !showReal">Real borders</button>
        </div>
        <div class="seg">
          <button type="button" :disabled="locating" @click="locate">{{ locating ? 'Locating…' : 'Where am I?' }}</button>
          <button type="button" aria-label="Fit the map" @click="fit">⤢</button>
        </div>
      </template>
      <button
        type="button"
        class="fold"
        :aria-expanded="controlsOpen"
        :aria-label="controlsOpen ? 'Hide the controls' : 'Show the controls'"
        @click="controlsOpen = !controlsOpen"
      >
        {{ controlsOpen ? '×' : '☰' }}
      </button>
    </div>
  </div>
</template>

<style>
/* Shared by the viewer and the Align panel (lib/AlignPanel.vue); matches the page's header panel */
.day22 .seg,
.day22 .readout {
  background: rgba(15, 20, 25, 0.82);
  backdrop-filter: blur(6px);
  border: 1px solid var(--border);
  border-radius: 10px;
}

.day22 .seg {
  display: flex;
  flex-wrap: wrap;
  overflow: hidden;
}

.day22 .seg button {
  padding: 8px 12px;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  color: var(--fg-muted);
  background: transparent;
  border: 0;
  cursor: pointer;
}

.day22 .seg button:disabled {
  opacity: 0.4;
  cursor: default;
}

.day22 .seg button[aria-pressed='true'] {
  color: #1d3557;
  background: linear-gradient(135deg, #f7c294, #f3a3a4);
}

.day22 .seg button:not([aria-pressed='true']):not(:disabled):hover {
  color: var(--accent);
}
</style>

<style scoped>
.day22 {
  position: relative;
  overflow: hidden;
  background: #cfe4ea;
  touch-action: none;
  cursor: crosshair;
  user-select: none;
}

/* Freehand on the left, Web Mercator on the right (stacked on a narrow screen) */
.viewer,
.mercator {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 50%;
}

.viewer {
  left: 0;
}

.mercator {
  right: 0;
  border-left: 2px solid #0f1419;
  cursor: auto;
}

@media (max-width: 700px) {
  .viewer,
  .mercator {
    width: auto;
    left: 0;
    right: 0;
  }

  .viewer {
    bottom: 45%;
  }

  .mercator {
    top: 55%;
    border-left: 0;
    border-top: 2px solid #0f1419;
  }
}

.stage {
  display: block;
  width: 100%;
  height: 100%;
}

.graticule {
  fill: none;
  stroke: #ffffff;
  stroke-opacity: 0.75;
  stroke-width: 0.8;
  stroke-dasharray: 3 3;
  vector-effect: non-scaling-stroke;
}

.bm-borders {
  fill: none;
  stroke: #ffffff;
  stroke-opacity: 0.85;
  stroke-width: 1;
  stroke-linejoin: round;
}

/* On the pale grid, the borders in ink */
.bm-borders.grid {
  stroke: #1d3557;
  stroke-opacity: 0.7;
}

.real {
  fill: none;
  stroke: #1d3557;
  stroke-opacity: 0.7;
  stroke-width: 0.7;
  stroke-linejoin: round;
  vector-effect: non-scaling-stroke;
}

.ties circle {
  fill: #1d3557;
  fill-opacity: 0.55;
}

.snap line {
  stroke: #e5484d;
  stroke-width: 1.2;
  vector-effect: non-scaling-stroke;
}

.snap circle {
  fill: none;
  stroke: #e5484d;
  stroke-width: 1.2;
  vector-effect: non-scaling-stroke;
}

.pin {
  cursor: pointer;
}

.pin .drop {
  animation: drop 0.55s cubic-bezier(0.3, 0.7, 0.4, 1.2) both;
}

.pin .shadow {
  fill: #1d3557;
  opacity: 0.25;
}

.pin .head {
  fill: #e5484d;
  stroke: #ffffff;
  stroke-width: 1.2;
}

.pin .eye {
  fill: #ffffff;
}

.pin.mine {
  pointer-events: none;
}

.pin.mine .head {
  fill: #3a5bd9;
}

.pin:hover .head {
  fill: #c2272d;
}

@keyframes drop {
  from {
    transform: translateY(-36px);
    opacity: 0;
  }
  40% {
    opacity: 1;
  }
  to {
    transform: translateY(0);
    opacity: 1;
  }
}

.tip {
  position: absolute;
  z-index: 11;
  transform: translate(-50%, calc(-100% - 30px));
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 4px 9px;
  font-size: 12px;
  line-height: 1.35;
  white-space: nowrap;
  color: #1d3557;
  background: rgba(255, 255, 255, 0.94);
  border-radius: 6px;
  box-shadow: 0 2px 8px rgba(29, 53, 87, 0.2);
  pointer-events: none;
}

.tip span {
  font-variant-numeric: tabular-nums;
  color: #4a607a;
}

.tip.mine {
  transform: translate(-50%, -100%);
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
  max-width: calc(100% - 24px);
  cursor: default;
}


.readout {
  position: absolute;
  left: 12px;
  bottom: 12px;
  z-index: 10;
  padding: 6px 12px;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  color: var(--fg);
  cursor: default;
}

.readout .off,
.readout .hint {
  color: var(--fg-muted);
}

.attribution {
  position: absolute;
  right: 6px;
  bottom: 4px;
  z-index: 10;
  font-size: 10px;
  color: #4a607a;
  cursor: default;
}

.attribution a {
  text-decoration: underline;
}

/* The fold button: on a phone only */
.fold {
  display: none;
  width: 38px;
  height: 38px;
  padding: 0;
  font: inherit;
  font-size: 18px;
  line-height: 1;
  color: var(--fg);
  background: rgba(15, 20, 25, 0.82);
  backdrop-filter: blur(6px);
  border: 1px solid var(--border);
  border-radius: 10px;
  cursor: pointer;
}

@media (max-width: 700px) {
  .controls {
    top: auto;
    bottom: 52px;
    right: 8px;
    align-items: flex-end;
  }

  .fold {
    display: block;
  }

  .controls.folded .seg {
    display: none;
  }

  /* In Align mode, just above its toolbar */
  .controls.over-bar {
    bottom: calc(var(--align-bar) + 8px);
  }
}

@media (max-width: 600px) {
  .readout {
    left: 8px;
    bottom: 8px;
  }
}
</style>
