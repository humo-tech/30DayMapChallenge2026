<script setup lang="ts">
// Day 25: Is this a map? — Komazawa Olympic Park as a wooden toy: the park cut out of a board of
// light wood, its lawns, pitches, stadium and courses painted on, the buildings wooden blocks, the
// Olympic tower a stacking toy, lollipop trees, and peg dolls running round the jogging course
// and riding round the cycling course; above all, children at play, far larger than life: on the
// swings, slides, seesaw and roundabout, on the animals the playgrounds are named after (a pig to
// climb and slide off, rocking horses, a squirrel's tree stump to climb, a giraffe with a slide
// down its neck), at football, baseball and tennis on the pitches, tag and catch on the lawn, in
// the paddling pool. One bright afternoon in early May, always. Navara: the real sun over the park
// then, its cascaded shadows, ambient occlusion between the toys; the camera tours the
// playgrounds till someone takes it.
// Data: scripts/day25/fetch_osm.py, scripts/day25/build_park.py. Font: Inter Bold (SIL OFL 1.1,
// public/fonts/Inter-OFL.txt)
import ThreeView, { Color } from '@navaramap/three'
import { DefaultPlugin, type DefaultDescriptions } from '@navaramap/three-default-plugin'
import { ToyParkMeshDesc, type ToyParkConfig } from './lib/ToyParkMeshDesc'
import { BOARD, type ParkData } from './lib/toyPark'

const baseURL = useRuntimeConfig().app.baseURL
const dataBase = `${baseURL}data/day25`

// One afternoon: early May (fresh green), half past two (JST), the sun high in the south-west
const WHEN = new Date('2026-05-05T05:30:00Z')
// The table under the toy
const TABLE = '#efe4cc'
const FILL = '#d6dceb'

// The tour: seconds on each shot and between them, and how fast it turns round a shot (°/s)
const HOLD_S = 9
const MOVE_S = 3.5
const SPIN = 2.5
type Shot = { at: [number, number]; bearing: number; up: number; dist: number }

const query = useRoute().query
const container = ref<HTMLDivElement>()
// ?camera= holds the camera still; otherwise it tours the playgrounds till someone takes it
const touring = ref(true)
let resumeTour: (() => void) | undefined
const loading = ref(true)
let view: ThreeView<DefaultDescriptions> | undefined
let frame = 0

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

onMounted(async () => {
  const data = (await fetch(`${dataBase}/park.json`).then((r) => r.json())) as ParkData
  if (!container.value) return
  const v = new ThreeView<DefaultDescriptions>({
    container: container.value,
    backgroundColor: new Color().setStyle(TABLE),
    animation: true,
    shadow: true,
    pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
  })
  view = v
  const plugin = new DefaultPlugin()
  v.addPlugin(plugin)
  await v.init()
  if (view !== v) return
  v.registerMesh('toyPark', ToyParkMeshDesc)
  v.globe.color = new Color().setStyle(TABLE)
  v.atmosphere.date = WHEN

  // The sun, its shadows across the board, tone mapping and antialiasing; no sky or haze (a toy on
  // a table, not a landscape)
  const scene = plugin.addDefaultPhotorealScene()
  scene.sky.delete()
  scene.stars.delete()
  scene.aerialPerspective.update({ aerialPerspective: { inscatter: false, transmittance: false } })
  scene.sun.update({
    sun: {
      intensity: 2.0,
      castShadow: true,
      shadowFar: 5_000,
      shadowMapSize: v.isMobileOptimized() ? 2048 : 4096,
      shadowCascadeCount: 3,
      shadowLambda: 0.8,
      shadowNormalBias: 2,
    },
  })
  v.addLight({ ambient: { intensity: 0.9, color: new Color().setStyle(FILL) } })
  v.addEffect({ ssao: { radius: 6, intensity: 2.2, samples: 16 } })
  // (not too much under a high sun, or the colours wash out)
  v.toneMappingExposure = 1.7

  const config: ToyParkConfig = {
    toyPark: {
      data,
      table: { color: TABLE, radius: 6_000 },
      // The name, faint in the wood of the table beyond the park's far side
      name: {
        text: 'KOMAZAWA PARK',
        at: [100, 520],
        size: [520, 108],
        angle: 0,
        color: '#c9a477',
        opacity: 0.45,
        font: `${baseURL}fonts/inter-latin-700-normal.woff2`,
      },
    },
    geodetic: { lng: data.center[0], lat: data.center[1], height: 0.5 },
  }
  const park = v.addMesh<ToyParkMeshDesc>(config).ref
  v.attribution?.add([{ attributionHtml: 'Park: © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }])

  // The camera: on a tour of where the children play, or where ?camera= puts it, or (once
  // someone takes it) wherever they move it
  const aspect = container.value.clientWidth / container.value.clientHeight
  const far = aspect > 1.2 ? 1 : 1.7
  const centre = (name: string): [number, number] => {
    const ring = data.areas.find((a) => a.name === name || (name === 'pool' && a.kind === 'pool'))?.rings[0]
    if (!ring) return [0, 0]
    const n = ring.length - 1
    return [ring.slice(0, n).reduce((a, p) => a + p[0], 0) / n, ring.slice(0, n).reduce((a, p) => a + p[1], 0) / n]
  }
  const lawn = centre('自由広場')
  const buta = centre('ぶた公園')
  const shots: Shot[] = [
    { at: [40, 30], bearing: 160, up: 46, dist: 780 },
    { at: centre('うま公園'), bearing: 205, up: 30, dist: 260 },
    { at: centre('駒沢第１球技場'), bearing: 150, up: 30, dist: 300 },
    { at: [(lawn[0] + buta[0]) / 2, (lawn[1] + buta[1]) / 2], bearing: 185, up: 32, dist: 330 },
    { at: centre('りす公園'), bearing: 245, up: 32, dist: 260 },
    { at: centre('駒沢硬式野球場'), bearing: 200, up: 32, dist: 320 },
    { at: centre('きりんさんパーキング'), bearing: 200, up: 26, dist: 330 },
    { at: centre('pool'), bearing: 170, up: 34, dist: 260 },
  ]
  const pose = (s: Shot, spin = 0) => {
    // The camera so far off the target, at that bearing (from the target) and height angle
    const b = ((s.bearing + spin) * Math.PI) / 180
    const up = (s.up * Math.PI) / 180
    const d = s.dist * (s === shots[0] ? far : 1)
    const east = s.at[0] + Math.sin(b) * Math.cos(up) * d
    const north = s.at[1] + Math.cos(b) * Math.cos(up) * d
    return {
      lng: data.center[0] + east / (111_320 * Math.cos((data.center[1] * Math.PI) / 180)),
      lat: data.center[1] + north / 110_950,
      height: BOARD + Math.sin(up) * d,
      heading: (s.bearing + spin + 180) % 360,
      pitch: -s.up,
      roll: 0,
    }
  }
  const cam = (query.camera as string | undefined)?.split(',').map(Number)
  if (cam?.length === 5 && cam.every(Number.isFinite)) {
    const [lng, lat, height, heading, pitch] = cam as [number, number, number, number, number]
    v.setCamera({ lng, lat, height, heading, pitch, roll: 0 })
    touring.value = false
  } else {
    v.setCamera(pose(shots[0]!))
  }
  // Hands on the map stop the tour
  const stopTour = () => (touring.value = false)
  container.value.addEventListener('pointerdown', stopTour)
  container.value.addEventListener('wheel', stopTour, { passive: true })
  let shot = 0
  let shotAt = performance.now()
  let flying = false
  resumeTour = () => {
    touring.value = true
    flying = true
    shot = 0
    v.flyTo({ ...pose(shots[0]!) }, { duration: 2_500 }).finally(() => {
      flying = false
      shotAt = performance.now()
    })
  }
  loading.value = false

  const step = () => {
    frame = requestAnimationFrame(step)
    const now = performance.now()
    if (touring.value && !flying) {
      // Hold on a shot (turning slowly round it), then glide to the next
      const t = (now - shotAt) / 1000
      if (t > HOLD_S + MOVE_S) {
        shot = (shot + 1) % shots.length
        shotAt = now
      }
      const a = shots[shot]!
      if (t <= HOLD_S) v.setCamera(pose(a, t * SPIN))
      else {
        const b = shots[(shot + 1) % shots.length]!
        const f = smooth(0, 1, (t - HOLD_S) / MOVE_S)
        const from = pose(a, HOLD_S * SPIN)
        const to = pose(b)
        let dh = to.heading - from.heading
        dh = ((dh + 540) % 360) - 180
        v.setCamera({
          lng: from.lng + (to.lng - from.lng) * f,
          lat: from.lat + (to.lat - from.lat) * f,
          height: Math.exp(Math.log(from.height) + (Math.log(to.height) - Math.log(from.height)) * f),
          heading: (from.heading + dh * f + 360) % 360,
          pitch: from.pitch + (to.pitch - from.pitch) * f,
          roll: 0,
        })
      }
    }
    park.tick(now / 1000)
  }
  frame = requestAnimationFrame(step)
})

onBeforeUnmount(() => {
  cancelAnimationFrame(frame)
  view?.dispose()
  view = undefined
})

</script>

<template>
  <div class="map-canvas day25">
    <div ref="container" class="map-canvas" />
    <button
      type="button"
      class="tour"
      :aria-pressed="touring"
      aria-label="Tour the playgrounds"
      @click="touring ? (touring = false) : resumeTour?.()"
    >
      🎥
    </button>
    <div v-if="loading" class="loading">Loading…</div>
  </div>
</template>

<style scoped>
.day25 {
  position: relative;
}

/* The tour button: a round wooden knob */
.tour {
  position: absolute;
  right: 16px;
  bottom: 40px;
  z-index: 10;
  width: 52px;
  height: 52px;
  border: 0;
  border-radius: 50%;
  font-size: 20px;
  background:
    repeating-radial-gradient(circle at 40% 35%, rgba(120, 70, 30, 0.12) 0 3px, transparent 3px 7px),
    radial-gradient(circle at 38% 32%, #f6dcae, #d6a465 70%, #b07a3e);
  box-shadow:
    0 4px 8px rgba(60, 35, 10, 0.45),
    inset 0 -3px 6px rgba(90, 50, 15, 0.35);
  cursor: pointer;
}

.tour[aria-pressed='true'] {
  box-shadow:
    inset 0 2px 6px rgba(60, 35, 10, 0.55),
    0 0 0 3px #fff4d8;
}

.loading {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: var(--fg-muted);
  pointer-events: none;
}

@media (max-width: 700px) {
  .tour {
    right: 8px;
    bottom: 52px;
  }
}
</style>
