<script setup lang="ts">
// Day 17: Light & dark — the Kanto plain and Mt. Fuji with nothing on them but the shadows the
// sun throws. Elevation is Mapterhorn's global DEM; pick a day on the calendar and slide the
// clock, and the sun moves across the sky and the shadows follow it.
import ThreeView, { Color, TERRARIUM_ELEVATION_DECODER } from '@navaramap/three'
import { DefaultPlugin, type DefaultDescriptions } from '@navaramap/three-default-plugin'
import { daylightOf, sunAt } from './lib/solar'

const MAPTERHORN = 'https://tiles.mapterhorn.com/{z}/{x}/{y}.webp'
// The sun's clock is Japan Standard Time (UTC+9); the readout is for the middle of the view
const JST = 9
const PLACE = { lat: 35.5, lng: 139.3 }

const SKY = '#0b0e14'
// The sea and the land, as the unlit colors the sun then lights
const SEA = [0.16, 0.22, 0.3, 1]
const LAND = [0.86, 0.84, 0.8, 1]

// Mt. Fuji at the lower left, the Kanto plain and Tokyo Bay opening to the right, seen from the south
const CAMERA = { lng: 139.3, lat: 33.8, height: 150_000, heading: 350, pitch: -40, roll: 0 }

// ?cam=lng,lat,height,heading,pitch  ?d=YYYY-MM-DD  ?t=minutes, for tuning a view or a moment
const query = useRoute().query
const camQuery = String(query.cam ?? '').split(',').map(Number)
if (camQuery.length === 5 && camQuery.every(Number.isFinite)) {
  const [lng, lat, height, heading, pitch] = camQuery as [number, number, number, number, number]
  Object.assign(CAMERA, { lng, lat, height, heading, pitch })
}

const pad = (n: number) => String(n).padStart(2, '0')
const jstNow = new Date(Date.now() + JST * 3600_000)
const todayStr = `${jstNow.getUTCFullYear()}-${pad(jstNow.getUTCMonth() + 1)}-${pad(jstNow.getUTCDate())}`
const hhmm = (m: number) => `${pad(Math.floor(m / 60) % 24)}:${pad(Math.floor(m) % 60)}`

const container = ref<HTMLDivElement>()
const date = ref(/^\d{4}-\d{2}-\d{2}$/.test(String(query.d)) ? String(query.d) : todayStr)
const minutes = ref(query.t !== undefined && Number.isFinite(Number(query.t)) ? Number(query.t) : 10 * 60) // JST, from midnight
const playing = ref(false)
let view: ThreeView<DefaultDescriptions> | undefined

const instant = computed(() => new Date(`${date.value || todayStr}T${hhmm(minutes.value)}:00+09:00`))
const sun = computed(() => sunAt(instant.value, PLACE.lat, PLACE.lng))
const daylight = computed(() => daylightOf(date.value || todayStr, PLACE.lat, PLACE.lng))
const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']
const compass = computed(() => COMPASS[Math.round(sun.value.azimuth / 22.5) % 16])
// The slider's track: dark where the sun is down, light where it is up
const track = computed(() => {
  const d = daylight.value
  if (!d) return undefined
  const [a, b] = [(d.rise / 1440) * 100, (d.set / 1440) * 100]
  return `linear-gradient(90deg, #2a3648 ${a}%, #e8d9a8 ${a}%, #e8d9a8 ${b}%, #2a3648 ${b}%)`
})

// Calendar shortcuts: the days the sun's path turns
const YEAR = jstNow.getUTCFullYear()
const SHORTCUTS = [
  { label: 'Winter solstice', date: `${YEAR}-12-22` },
  { label: 'Equinox', date: `${YEAR}-03-21` },
  { label: 'Summer solstice', date: `${YEAR}-06-21` },
]

// The sun and its shadows follow the clock
watch(instant, (d) => {
  if (view) view.atmosphere.date = d
})

// Play: a day in about 20 s
let last = 0
let raf = 0
function tick(now: number) {
  if (!playing.value) return
  minutes.value = (minutes.value + ((now - last) / 1000) * 72) % 1440
  last = now
  raf = requestAnimationFrame(tick)
}
watch(playing, (on) => {
  cancelAnimationFrame(raf)
  if (on) {
    last = performance.now()
    raf = requestAnimationFrame(tick)
  }
})

onMounted(async () => {
  const v = new ThreeView<DefaultDescriptions>({
    container: container.value!,
    backgroundColor: new Color().setStyle(SKY),
    animation: true,
    shadow: true,
  })
  view = v
  v.addPlugin(new DefaultPlugin())
  await v.init()
  if (view !== v) return // unmounted while initializing

  v.setCamera(CAMERA)
  v.atmosphere.date = instant.value
  v.addLight({ ambient: { intensity: 0.15 } })
  v.addLight({ sun: { intensity: 3, castShadow: true } })

  const dem = v.addSource({
    type: 'raster-dem',
    url: MAPTERHORN,
    elevationDecoder: TERRARIUM_ELEVATION_DECODER(),
    tileSize: 512,
    maxZoom: 12,
  })
  v.addLayer({ type: 'terrain', source: dem, terrain: { castShadow: true, receiveShadow: true } })
  // Terrain and raster tiles are unlit on their own; the DEM's hillshade gives them normals, so the
  // sun lights them and their shadows are cast
  v.addLayer({ type: 'raster', source: dem, hillshade: {} })
  // The DEM also tells the sea (0 m) from the land: one flat tone each
  v.addLayer({
    type: 'raster',
    source: dem,
    elevationHeatmap: {
      minHeight: -1,
      maxHeight: 1,
      colorStops: new Float32Array([-1, 0.4, 0.6, 1]),
      colorMap: new Float32Array([...SEA, ...SEA, ...LAND, ...LAND]),
    },
  })

  v.attribution?.add([{ attributionHtml: 'Elevation: <a href="https://mapterhorn.com/attribution">© Mapterhorn</a>' }])
})

onBeforeUnmount(() => {
  playing.value = false
  view?.dispose()
  view = undefined
})
</script>

<template>
  <div class="map-canvas day17">
    <div ref="container" class="map-canvas" />
    <div class="panel">
      <div class="row">
        <input v-model="date" type="date" class="date" aria-label="Date" />
        <button v-for="s in SHORTCUTS" :key="s.date" type="button" class="chip" :aria-pressed="date === s.date" @click="date = s.date">
          {{ s.label }}
        </button>
      </div>
      <div class="row">
        <button type="button" class="chip play" :aria-label="playing ? 'Pause' : 'Play'" @click="playing = !playing">
          {{ playing ? '❚❚' : '▶' }}
        </button>
        <input
          v-model.number="minutes"
          type="range"
          min="0"
          max="1439"
          step="1"
          class="slider"
          :style="track ? { '--track': track } : undefined"
          aria-label="Time of day (JST)"
          @input="playing = false"
        />
        <span class="clock">{{ hhmm(minutes) }}</span>
      </div>
      <div class="readout">
        <template v-if="sun.altitude > 0">Sun {{ sun.altitude.toFixed(0) }}° up, from the {{ compass }}</template>
        <template v-else>Sun below the horizon</template>
        <template v-if="daylight"> · ↑ {{ hhmm(daylight.rise) }} ↓ {{ hhmm(daylight.set) }}</template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.day17 {
  position: relative;
}

.panel {
  position: absolute;
  right: 12px;
  bottom: 12px;
  left: 12px;
  z-index: 10;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: 640px;
  padding: 10px 14px;
  margin: 0 0 0 auto;
  background: rgba(15, 20, 25, 0.82);
  backdrop-filter: blur(6px);
  border: 1px solid var(--border);
  border-radius: 10px;
}

.row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

.date {
  padding: 4px 8px;
  font: inherit;
  font-size: 13px;
  color: var(--fg);
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 8px;
}

.chip {
  padding: 4px 10px;
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  color: var(--fg);
  cursor: pointer;
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 8px;
}

.chip:hover,
.chip[aria-pressed='true'] {
  color: var(--accent);
  border-color: var(--accent);
}

.play {
  min-width: 36px;
}

.slider {
  flex: 1;
  min-width: 0;
  height: 6px;
  appearance: none;
  background: var(--track, #2a3648);
  border-radius: 3px;
}

.slider::-webkit-slider-thumb {
  width: 18px;
  height: 18px;
  appearance: none;
  background: var(--accent);
  border: 2px solid #0f1419;
  border-radius: 50%;
}

.slider::-moz-range-thumb {
  width: 14px;
  height: 14px;
  background: var(--accent);
  border: 2px solid #0f1419;
  border-radius: 50%;
}

.clock {
  min-width: 3.4em;
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.readout {
  font-size: 12px;
  color: var(--fg-muted);
}
</style>
