<script setup lang="ts">
// Day 15: Inside out — Harajuku through the looking-glass. Day 10's pastel plush map of Overture Maps' PMTiles,
// now on Navara, and then it goes wrong: the picture ripples like water (a post effect), clocks melt in the
// air, a looking-glass hangs over the corner, and the city has a twin hanging from the sky. The
// camera falls up into it: the world turns over, and the twin stands on its feet while the real
// city hangs overhead
//
// Navara reads PMTiles natively, but Overture's own archives cost too much for that (z14 tiles
// of ~1 MB a theme over Tokyo: Day 10 went to MapLibre over it). scripts/day15/extract_harajuku.py
// cuts a 1.5 MB pair of its own: only the tiles round here, and the properties the style reads
import ThreeView, { Color, type Layer } from '@navaramap/three'
import { DefaultPlugin, type DefaultDescriptions } from '@navaramap/three-default-plugin'
import { PASTELS } from './lib/plushStyle'
import { WarpEffectDesc, type WarpConfig } from './lib/WarpEffectDesc'
import { MeltingClocksMeshDesc, type Clock, type MeltingClocksConfig } from './lib/MeltingClocksMeshDesc'

const baseURL = useRuntimeConfig().app.baseURL
const route = useRoute()
// A touch screen, or a narrow one
const IS_PHONE = matchMedia('(pointer: coarse)').matches || window.innerWidth <= 768
const dataBase = `${baseURL}data/day15`

// Jingūmae, between Yoyogi Park and Omotesandō
const CENTRE = { lng: 139.7055, lat: 35.6685 }
const M_LNG = 111_320 * Math.cos((CENTRE.lat * Math.PI) / 180)
const M_LAT = 110_950

const GROUND = '#c8ecbc'
const SKY = '#ffe4ee'
const STITCH = '#ffffff'
const hex = (s: string) => new Color().setStyle(s)

// Land use as patchwork, as in Day 10
const LAND: Record<string, string> = {
  forest: '#9fe0c8',
  grass: PASTELS.mint,
  shrub: '#a8e8bd',
  wetland: '#bfe6ee',
  sand: '#fff0c4',
}
const LAND_USE: Record<string, string> = {
  park: '#a8e8bd',
  recreation: '#c2eeaa',
  horticulture: '#9fe0c8',
  managed: '#b4e6cc',
  agriculture: '#d2f2b0',
  cemetery: PASTELS.lavender,
  residential: '#fbe8c8',
  developed: PASTELS.lilac,
  education: PASTELS.lemon,
  medical: '#ffd0d8',
  religious: PASTELS.peach,
  pedestrian: '#ffd6e2',
  transportation: '#e4dcf6',
  construction: '#fbe8a2',
  military: '#d6e4c6',
}
const WATER = Object.fromEntries(
  ['river', 'lake', 'pond', 'canal', 'ocean', 'reservoir', 'water', 'stream', 'basin', 'lagoon'].map((s) => [s, PASTELS.sky]),
)
const SWEETS = [PASTELS.pink, PASTELS.peach, PASTELS.lemon, PASTELS.sky, PASTELS.lavender, PASTELS.lilac, PASTELS.cream, PASTELS.mint]

// Road widths (px at the camera's distance), by class
const ROAD_W: Record<string, number> = {
  motorway: 9,
  trunk: 8.5,
  primary: 8,
  secondary: 7,
  tertiary: 6,
  residential: 4.5,
  unclassified: 4.5,
  living_street: 4,
  service: 3,
}
const MAJOR = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary'])
const FOOT = new Set(['footway', 'steps', 'path', 'cycleway', 'bridleway', 'pedestrian', 'crosswalk', 'sidewalk', 'track'])

// The twin city hangs from this height (m)
const CEILING = 900

// The tour, in s of the round: the camera's bearing from the centre (deg), its distance (m) and
// height (m), its pitch (deg, up positive) and its roll (deg)
type Key = { t: number; bearing: number; dist: number; height: number; pitch: number; roll: number }
const KEYS: Key[] = [
  { t: 0, bearing: 0, dist: 700, height: 620, pitch: -42, roll: 0 },
  { t: 30, bearing: 90, dist: 650, height: 560, pitch: -40, roll: 0 },
  { t: 44, bearing: 150, dist: 450, height: 520, pitch: -5, roll: 20 },
  { t: 56, bearing: 190, dist: 380, height: 540, pitch: 30, roll: 180 },
  { t: 86, bearing: 290, dist: 600, height: 520, pitch: 24, roll: 180 },
  { t: 98, bearing: 340, dist: 620, height: 560, pitch: -12, roll: 330 },
  { t: 110, bearing: 360, dist: 700, height: 620, pitch: -42, roll: 360 },
]
const ROUND_S = 110
// The page's wobble, and its pitch while the world turns over (s into the round)
const FALL: [number, number][] = [
  [38, 58],
  [94, 108],
]

// Clocks over the city: east and north of the centre and up (m), their size, melt and pace
const CLOCKS: Clock[] = [
  { at: [-260, -120, 190], size: 120, melt: 0.85, pace: -9, rim: '#ffb3c8', face: '#fff5e4' },
  { at: [180, 260, 300], size: 90, melt: 0.7, pace: 14, rim: '#aed8ff', face: '#fffbe0' },
  { at: [330, -150, 150], size: 140, melt: 1.0, pace: -5, rim: '#d5c3ff', face: '#fff5e4' },
  { at: [-120, 380, 240], size: 100, melt: 0.6, pace: 21, rim: '#b6eecd', face: '#fff9ec' },
  { at: [20, -420, 340], size: 80, melt: 0.9, pace: -17, rim: '#ffcfa6', face: '#fffbe0' },
  { at: [-420, 200, 120], size: 70, melt: 0.75, pace: 11, rim: '#f5c2ee', face: '#fff5e4' },
  { at: [60, 40, 560], size: 150, melt: 0.95, pace: -3, rim: '#fff0a0', face: '#fff5e4' },
]

// Said in the looking-glass: written backwards
const VERSES = [
  'Something here is not quite right.',
  'Which way is up?',
  'The clocks run backwards, and fast.',
  'The city hangs from the sky.',
  'This is the other side.',
  'Look again.',
]

const container = ref<HTMLDivElement>()
const mirror = ref<HTMLCanvasElement>()
const ripple = ref<SVGFETurbulenceElement>()
const touring = ref(true)
const steady = ref(false)
const flash = ref(false)
const verse = ref(0)
let view: ThreeView<DefaultDescriptions> | undefined
let setTouring: ((on: boolean) => void) | undefined
let stepThrough: (() => void) | undefined
let stopFrames: (() => void) | undefined

// Cubic Hermite through the keys, with Catmull-Rom tangents scaled by the keys' spacing in time
function sample(time: number): Key {
  const t = ((time % ROUND_S) + ROUND_S) % ROUND_S
  let i = 0
  while (i < KEYS.length - 2 && KEYS[i + 1]!.t <= t) i++
  const k = (j: number) => KEYS[Math.min(Math.max(j, 0), KEYS.length - 1)]!
  const [k0, k1, k2, k3] = [k(i - 1), k(i), k(i + 1), k(i + 2)]
  const dt = k2.t - k1.t
  const u = Math.min((t - k1.t) / dt, 1)
  const h00 = 2 * u ** 3 - 3 * u ** 2 + 1
  const h10 = u ** 3 - 2 * u ** 2 + u
  const h01 = -2 * u ** 3 + 3 * u ** 2
  const h11 = u ** 3 - u ** 2
  const lerp = (f: (k: Key) => number) => {
    const m1 = k0 === k1 ? 0 : ((f(k2) - f(k0)) / (k2.t - k0.t)) * dt
    const m2 = k3 === k2 ? 0 : ((f(k3) - f(k1)) / (k3.t - k1.t)) * dt
    return h00 * f(k1) + h10 * m1 + h01 * f(k2) + h11 * m2
  }
  return {
    t,
    bearing: lerp((k) => k.bearing),
    dist: lerp((k) => k.dist),
    height: lerp((k) => k.height),
    pitch: lerp((k) => k.pitch),
    roll: lerp((k) => k.roll),
  }
}

const cameraAt = (k: Key) => {
  const b = (k.bearing * Math.PI) / 180
  return {
    lng: CENTRE.lng + (k.dist * Math.sin(b)) / M_LNG,
    lat: CENTRE.lat + (k.dist * Math.cos(b)) / M_LAT,
    height: k.height,
    heading: k.bearing + 180,
    pitch: k.pitch,
    roll: k.roll,
  }
}

onMounted(async () => {
  const v = new ThreeView<DefaultDescriptions>({
    container: container.value!,
    backgroundColor: hex(SKY),
    animation: true,
  })
  view = v
  v.addPlugin(new DefaultPlugin())
  await v.init()
  if (view !== v) return // unmounted while initializing

  v.addLight({ ambient: { intensity: 2.2 } })
  v.addLight({ sun: { intensity: 0.7 } })
  v.addLayer({ type: 'terrain', ellipsoid: {} })
  v.globe.color = hex(GROUND)
  v.setCamera(cameraAt(sample(Number(route.query.t) || 0)))

  const base = v.addSource({ type: 'vector-tile', url: `${dataBase}/harajuku-base.pmtiles`, maxZoom: 13 })
  const city = v.addSource({ type: 'vector-tile', url: `${dataBase}/harajuku.pmtiles`, maxZoom: 14 })

  // Felt patches, sewn on the ground, and the water as satin
  const felt = (layers: string[], colors: Record<string, string>) => {
    const cache = Object.fromEntries(Object.entries(colors).map(([k, c]) => [k, hex(c)]))
    const layer = v.addLayer({ type: 'vector', source: base, sourceLayers: layers, polygon: { color: hex(GROUND), clampToGround: true } })
    layer.on('featureUpdated', ({ evaluator }) => {
      evaluator.evaluate(
        ({ properties }) => {
          const c = cache[String(properties?.['subtype'] ?? '')]
          return c ? { color: c } : { show: false }
        },
        { filters: ['subtype'] },
      )
    })
    return layer
  }
  felt(['land'], LAND)
  felt(['land_use'], LAND_USE)
  felt(['water'], WATER)

  // Roads: pink piping, lavender fabric, a lemon stitch down the big ones; rails in candy stripes
  const piping = hex(PASTELS.pink)
  const fabric = hex('#d9c2ff')
  const lemon = hex('#fff6b8')
  const roadLayer = (color: Color, width: (cls: string) => number, show: (cls: string, subtype: string) => boolean, dash: number[] = []) => {
    const layer: Layer = v.addLayer({
      type: 'vector',
      source: city,
      sourceLayers: ['segment'],
      polyline: { color, width: 4, clampToGround: true, dashArray: dash },
    })
    layer.on('featureUpdated', ({ evaluator }) => {
      evaluator.evaluate(
        ({ properties }) => {
          const cls = String(properties?.['class'] ?? '')
          const subtype = String(properties?.['subtype'] ?? 'road')
          return show(cls, subtype) ? { width: width(cls), color } : { show: false }
        },
        { filters: ['class', 'subtype'] },
      )
    })
    return layer
  }
  const isRoad = (cls: string, subtype: string) => subtype === 'road' && !FOOT.has(cls)
  const w = (cls: string) => ROAD_W[cls] ?? 3.5
  roadLayer(piping, (c) => w(c) + 2, isRoad)
  roadLayer(fabric, w, isRoad)
  roadLayer(lemon, () => 1.2, (c, s) => isRoad(c, s) && MAJOR.has(c), [3, 2])
  roadLayer(hex('#ff9fb6'), () => 4, (_c, s) => s === 'rail')
  roadLayer(hex(STITCH), () => 2.6, (_c, s) => s === 'rail', [1, 1])

  // Buildings in sweets, and above them, hanging from the sky, the same ones upside down
  const colors = SWEETS.map(hex)
  const buildings = (hang: boolean) => {
    const layer = v.addLayer({
      type: 'vector',
      source: city,
      sourceLayers: ['building'],
      polygon: { color: colors[0]!, clampToGround: false },
    })
    layer.on('featureUpdated', ({ evaluator }) => {
      evaluator.evaluate(
        ({ properties }) => {
          const h = Number(properties?.['h'] ?? 8)
          const color = colors[Number(properties?.['c'] ?? 0) % colors.length]!
          // The twin: the roofs at the bottom, the ground floors against the sky
          return hang ? { height: CEILING - h, extrudedHeight: CEILING, color } : { height: 0, extrudedHeight: h, color }
        },
        { filters: ['h', 'c'] },
      )
    })
    return layer
  }
  buildings(false)
  buildings(true)

  v.attribution?.add([
    {
      attributionHtml:
        '© <a href="https://overturemaps.org/">Overture Maps Foundation</a> · © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors and others',
    },
  ])

  // Clocks, melting in the air
  v.registerMesh('meltingClocks', MeltingClocksMeshDesc)
  const clocksConfig: MeltingClocksConfig = {
    meltingClocks: { clocks: CLOCKS },
    geodetic: { lng: CENTRE.lng, lat: CENTRE.lat, height: 0 },
  }
  const clocks = v.addMesh<MeltingClocksMeshDesc>(clocksConfig)

  // The picture itself rippling like water (a post effect: the page's panels stay as they are)
  v.registerEffect('warp', WarpEffectDesc)
  const warpConfig: WarpConfig = { warp: {} }
  const warp = v.addEffect<WarpEffectDesc>(warpConfig)

  const page = container.value!.closest<HTMLElement>('.map-page')
  page?.classList.add('day15-page')
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
  steady.value = reduced

  // ?t=<s> starts the tour that far in, for tuning a phase without waiting for it
  const startAt = Number(route.query.t) || 0
  let clock: number | undefined = performance.now() - startAt * 1000
  let tourTime = startAt
  const falling = (t: number) => Math.max(...FALL.map(([a, b]) => Math.sin(Math.PI * Math.min(Math.max((t - a) / (b - a), 0), 1)) ** 2))
  let flipped = false
  v.on('preUpdate', () => {
    const now = performance.now() / 1000
    if (clock !== undefined) {
      tourTime = (performance.now() - clock) / 1000
      v.setCamera(cameraAt(sample(tourTime)))
    }
    clocks.ref.tick(now)
    // The harder the more the world is falling; calm on a phone, and off when steady
    const calm = steady.value ? 0 : IS_PHONE ? 0.6 : 1
    warp.ref.setWarp(calm, calm * falling(tourTime))
    // The page turns over with the world: its panels hang upside down while the camera is
    const roll = sample(tourTime).roll % 360
    const over = roll > 100 && roll < 260
    if (over !== flipped) {
      flipped = over
      page?.classList.toggle('day15-flipped', over)
    }
  })

  // The looking-glass shows the map as it is now, reversed
  let frame = 0
  let last = 0
  const draw = (ms: number) => {
    frame = requestAnimationFrame(draw)
    if (ms - last < 45) return
    last = ms
    const t = ms / 1000
    ripple.value?.setAttribute('baseFrequency', `${(0.012 + 0.004 * Math.sin(t * 0.7)).toFixed(5)} ${(0.02 + 0.006 * Math.cos(t * 0.9)).toFixed(5)}`)
    const src = container.value?.querySelector('canvas')
    const dst = mirror.value
    if (src && dst && src.width > 0) {
      const ctx = dst.getContext('2d')!
      // The middle of the view, in the mirror's own proportions
      const aspect = dst.width / dst.height
      const sh = src.height * 0.8
      const sw = Math.min(sh * aspect, src.width)
      ctx.save()
      ctx.scale(-1, 1)
      ctx.drawImage(src, (src.width - sw) / 2, (src.height - sh) / 2, sw, sh, -dst.width, 0, dst.width, dst.height)
      ctx.restore()
    }
    verse.value = Math.floor(t / 9) % VERSES.length
  }
  frame = requestAnimationFrame(draw)
  stopFrames = () => {
    cancelAnimationFrame(frame)
    page?.classList.remove('day15-page', 'day15-flipped')
  }

  const grab = () => touring.value && setTouring?.(false)
  for (const type of ['pointerdown', 'wheel', 'touchstart'] as const) {
    container.value?.addEventListener(type, grab, { passive: true })
  }
  setTouring = (on) => {
    touring.value = on
    if (!on) {
      clock = undefined
      return
    }
    const resumeAt = tourTime
    v.flyTo(cameraAt(sample(resumeAt)), { duration: 2500, easing: 'cubicInOut' }).then((ok) => {
      if (ok && touring.value && view === v) clock = performance.now() - resumeAt * 1000
    })
  }
  // Through the looking-glass: into the middle of the fall
  stepThrough = () => {
    flash.value = true
    setTimeout(() => (flash.value = false), 900)
    touring.value = true
    clock = performance.now() - 40 * 1000
  }
})

onBeforeUnmount(() => {
  stopFrames?.()
  stopFrames = undefined
  stepThrough = undefined
  setTouring = undefined
  view?.dispose()
  view = undefined
})
</script>

<template>
  <div class="map-canvas day15">
    <div ref="container" class="map-canvas" />

    <svg class="defs" width="0" height="0" aria-hidden="true" focusable="false">
      <!-- The looking-glass's surface, liquid -->
      <filter id="day15-ripple" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">
        <feTurbulence ref="ripple" type="fractalNoise" baseFrequency="0.012 0.02" numOctaves="2" seed="3" result="noise" />
        <feDisplacementMap in="SourceGraphic" in2="noise" scale="16" xChannelSelector="R" yChannelSelector="B" />
      </filter>
    </svg>

    <div class="controls">
      <button type="button" class="chip" :aria-pressed="touring" @click="setTouring?.(!touring)">
        {{ touring ? '❚❚ Stop tour' : '▶ Play tour' }}
      </button>
      <button type="button" class="chip" :aria-pressed="steady" @click="steady = !steady">
        {{ steady ? '〰 Wobble' : '— Steady' }}
      </button>
    </div>

    <button type="button" class="glass" aria-label="Step through the looking-glass" title="Step through" @click="stepThrough?.()">
      <span class="glass-frame">
        <canvas ref="mirror" width="300" height="420" />
        <span class="glass-shine" />
      </span>
    </button>

    <p :key="verse" class="verse" lang="en">{{ VERSES[verse] }}</p>
    <div class="flash" :class="{ on: flash }" />
  </div>
</template>

<style>
/* With the world upside down, so are the panels */
.map-page.day15-page .map-header,
.map-page.day15-page .day15 .controls {
  transition: transform 1.6s cubic-bezier(0.6, 0, 0.2, 1);
}

.map-page.day15-flipped .map-header,
.map-page.day15-flipped .day15 .controls {
  transform: rotate(180deg);
}

</style>

<style scoped>
.day15 {
  position: relative;
  overflow: hidden;
}

.defs {
  position: absolute;
  pointer-events: none;
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
.chip {
  padding: 8px 14px;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  color: var(--fg);
  background: rgba(15, 20, 25, 0.82);
  backdrop-filter: blur(6px);
  border: 1px solid var(--border);
  border-radius: 10px;
  cursor: pointer;
}

.chip:hover {
  color: var(--accent);
}

/* The looking-glass: a gilded oval hanging in the air, showing the map as it is, reversed and
   in the wrong colours, rippling */
.glass {
  position: absolute;
  right: clamp(28px, 5vw, 70px);
  bottom: clamp(56px, 10vh, 100px);
  z-index: 9;
  width: clamp(120px, 19vmin, 230px);
  padding: 0;
  background: none;
  border: 0;
  cursor: pointer;
  animation: day15-bob 7s ease-in-out infinite alternate;
  filter: drop-shadow(0 10px 18px rgba(80, 30, 90, 0.35));
}

.glass-frame {
  position: relative;
  display: block;
  aspect-ratio: 300 / 420;
  padding: 7%;
  border-radius: 50% / 50%;
  background: conic-gradient(from 30deg, #fbe9a0, #b8862c, #fff3bd, #9c6a1e, #f6d77e, #b8862c, #fbe9a0);
  box-shadow:
    inset 0 0 0 2px rgba(255, 255, 255, 0.55),
    inset 0 0 12px 3px rgba(90, 50, 0, 0.55);
}

.glass-frame canvas {
  display: block;
  width: 100%;
  height: 100%;
  border-radius: 50% / 50%;
  filter: url(#day15-ripple) hue-rotate(155deg) saturate(1.5) brightness(1.08);
  box-shadow: inset 0 0 24px rgba(0, 0, 0, 0.5);
}

.glass-shine {
  position: absolute;
  inset: 7%;
  border-radius: 50% / 50%;
  pointer-events: none;
  background:
    linear-gradient(118deg, rgba(255, 255, 255, 0.55) 0 9%, rgba(255, 255, 255, 0) 24%),
    radial-gradient(ellipse at 50% 120%, rgba(213, 195, 255, 0.5), transparent 60%);
  mix-blend-mode: screen;
}

@keyframes day15-bob {
  0% {
    transform: translateY(-6px) rotate(-5deg);
  }
  100% {
    transform: translateY(8px) rotate(4deg);
  }
}

/* Written in the glass: backwards */
.verse {
  position: absolute;
  left: 50%;
  bottom: max(26px, env(safe-area-inset-bottom));
  z-index: 8;
  width: max-content;
  max-width: min(640px, 60vw);
  margin: 0;
  padding: 6px 16px;
  font: italic 600 clamp(14px, 2.2vmin, 19px) / 1.35 Georgia, 'Times New Roman', serif;
  text-align: center;
  color: #fff4c8;
  text-shadow: 0 1px 6px rgba(70, 20, 90, 0.8);
  background: rgba(70, 30, 100, 0.42);
  border-radius: 14px;
  transform: translateX(-50%) scaleX(-1);
  pointer-events: none;
  animation: day15-verse 9s ease-in-out both;
}

@keyframes day15-verse {
  0%,
  100% {
    opacity: 0;
  }
  12%,
  88% {
    opacity: 1;
  }
}

.flash {
  position: absolute;
  inset: 0;
  z-index: 20;
  pointer-events: none;
  background: #fff;
  opacity: 0;
}

.flash.on {
  animation: day15-flash 0.9s ease-out;
}

@keyframes day15-flash {
  0% {
    opacity: 1;
  }
  100% {
    opacity: 0;
  }
}

/* On a phone the header spans the top: the buttons go under it, the glass shrinks into the corner */
@media (max-width: 600px) {
  .controls {
    top: 64px;
    right: 8px;
  }

  .chip {
    padding: 6px 10px;
    font-size: 12px;
  }

  .glass {
    width: 96px;
    bottom: 60px;
    right: 24px;
  }

  .verse {
    left: 12px;
    max-width: calc(100% - 130px);
    font-size: 13px;
    transform: scaleX(-1);
    transform-origin: left center;
  }
}
</style>
