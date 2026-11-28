<script setup lang="ts">
// Day 28: Senses: Feeling — the world map in the colours of the face in front of it. The map has a
// palette for each of six moods; the face's expression (MediaPipe's face blendshapes) weighs
// them, and the globe wears the mix: calm is a school atlas, a smile turns it sunny, a frown
// rainy, a scowl molten, surprise neon, closed eyes night with its cities lit. The face itself is
// never shown: a plush mask follows it. Turning the head turns the globe. Without a camera the plush
// acts the moods out by itself.
// Data: Natural Earth (scripts/day28/build_world.py)
import ThreeView, { Color } from '@navaramap/three'
import { Color as ThreeColor, Vector3 } from 'three'
import { DefaultPlugin, type DefaultDescriptions } from '@navaramap/three-default-plugin'
import { blend, moodsOf, MOODS, only, ROLES, type Mood, type Role, type Weights } from './lib/moodPalette'
import { FaceInput } from './lib/faceMood'
import { demoFace, drawPlush } from './lib/plushMask'
import { KEYS, MoodRecolorEffectDesc, type MoodRecolorConfig } from './lib/MoodRecolorEffectDesc'

const baseURL = useRuntimeConfig().app.baseURL
const dataBase = `${baseURL}data/day28`

// The globe, seen whole, turning slowly (°/s) when no one is turning it
const START = { lng: 138, lat: 22 }
// How much of the screen's narrower side the globe spans, and the most it ever does (a surprise
// jumps it closer, joy bounces it: never so far it leaves the screen)
const FILL = 0.8
const FILL_MAX = 0.92
const EARTH_R = 6_371_000
const SPIN = 3
const IDLE_S = 6
// The head turns it too, in front of the camera: look left or right and it spins that way (°/s at
// a full turn), look up or down and it tips to the north or south (° of latitude at a full nod),
// with a dead zone round straight ahead, where it goes on turning by itself
const HEAD_SPIN = 70
const HEAD_TILT = 45
const DEAD = 0.18

const container = ref<HTMLDivElement>()
const faceEl = ref<HTMLCanvasElement>()
// ?mood= holds the plush's demo on one mood (for stills)
const holdQuery = useRoute().query.mood as string | undefined
const hold = MOODS.includes(holdQuery as Mood) ? (holdQuery as Mood) : undefined
// What the face reads as: the strongest mood now, and how strongly (0-1)
const reading = ref<{ mood: Mood; share: number }>({ mood: 'calm', share: 1 })
const MOOD_NAMES: Record<Mood, string> = {
  calm: 'Calm',
  happy: 'Happy',
  sad: 'Sad',
  angry: 'Angry',
  surprised: 'Surprised',
  sleepy: 'Sleepy',
}
const loading = ref(true)
let view: ThreeView<DefaultDescriptions> | undefined
const unmount: (() => void)[] = []
let frame = 0

// The camera: off (the plush acts by itself), starting, on, or refused
const camState = ref<'off' | 'starting' | 'on' | 'failed'>('off')
let face: FaceInput | undefined
async function toggleCamera() {
  if (face || camState.value === 'starting') {
    face?.stop()
    face = undefined
    camState.value = 'off'
    return
  }
  camState.value = 'starting'
  const f = new FaceInput()
  try {
    await f.start()
  } catch (e) {
    console.warn('Day 28: no camera', e)
    f.stop()
    camState.value = 'failed'
    return
  }
  if (camState.value !== 'starting') return f.stop()
  face = f
  camState.value = 'on'
}

onMounted(async () => {
  if (!container.value) return
  const v = new ThreeView<DefaultDescriptions>({
    container: container.value,
    backgroundColor: new Color().setStyle('#e9edf1'),
    animation: true,
    // Each tile's mesh in this many strips a side (the default, 10, leaves the whole globe's edge
    // visibly polygonal; as in Day 17)
    segments: 48,
    pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
  })
  view = v
  v.addPlugin(new DefaultPlugin())
  await v.init()
  if (view !== v) return
  // Flat and unlit: only an even white light, so every part keeps its key colour exactly
  v.addLight({ ambient: { intensity: 1 } })
  const key = (k: keyof typeof KEYS) => new Color().setStyle(KEYS[k])
  // The globe as a surface (the ellipsoid), for the countries to drape on and to write depth
  v.addLayer({ type: 'terrain', ellipsoid: {} })
  v.globe.color = key('ocean')
  // The camera's height above the ground at which the whole globe fits the screen, across and
  // down (a phone held upright is narrower than it is tall)
  const fitHeight = (fill = FILL) => {
    const el = container.value!
    const tanHalf = Math.tan((v.camera.raw.fov * Math.PI) / 360) * Math.min(1, el.clientWidth / Math.max(1, el.clientHeight))
    const angle = Math.atan(tanHalf * fill)
    return EARTH_R / Math.sin(angle) - EARTH_R
  }
  v.setCamera({ ...START, height: fitHeight(), heading: 0, pitch: -90, roll: 0 })

  // The countries, draped on the globe in their four shades (ice apart), and the lakes
  const shades = [key('landA'), key('landB'), key('landC'), key('landD'), key('ice')]
  const countries = v.addSource({ type: 'geojson', url: `${dataBase}/countries.geojson` })
  const countryLayer = v.addLayer({ type: 'vector', source: countries, polygon: { color: shades[0]!, clampToGround: true } })
  countryLayer.on('featureUpdated', ({ evaluator }) => {
    evaluator.evaluate(({ properties }) => ({ color: shades[Number(properties?.['k'] ?? 0)] ?? shades[0]! }), { filters: ['k'] })
  })
  const lakes = v.addSource({ type: 'geojson', url: `${dataBase}/lakes.geojson` })
  v.addLayer({ type: 'vector', source: lakes, polygon: { color: key('water'), clampToGround: true } })

  // The lines stand a little off the globe (draped lines vanish from this far): the graticule,
  // rivers, then coasts and borders on top
  const lines = v.addSource({ type: 'geojson', url: `${dataBase}/lines.geojson` })
  const LINES: Record<string, { color: Color; width: number; height: number }> = {
    grid: { color: key('grid'), width: 0.8, height: 1_000 },
    river: { color: key('water'), width: 1, height: 2_000 },
    border: { color: key('border'), width: 0.9, height: 3_000 },
    coast: { color: key('border'), width: 1.3, height: 3_000 },
  }
  for (const [kind, style] of Object.entries(LINES)) {
    const layer = v.addLayer({
      type: 'vector',
      source: lines,
      polyline: { color: style.color, width: style.width, clampToGround: false, maxWidth: 200_000, height: style.height },
    })
    layer.on('featureUpdated', ({ evaluator }) => {
      evaluator.evaluate(({ properties }) => (properties?.['kind'] === kind ? { show: true, color: style.color } : { show: false }), {
        filters: ['kind'],
      })
    })
  }

  // The biggest cities, by size: shown only at night, as lights (see MoodRecolorEffectDesc)
  const cities = v.addSource({ type: 'geojson', url: `${dataBase}/cities.geojson` })
  const cityColor = key('city')
  const cityLayer = v.addLayer({
    type: 'vector',
    source: cities,
    point: { color: cityColor, size: 4, sizeInMeters: false, clampToGround: false, height: 8_000, offsetDepth: false, declutter: false },
  })
  cityLayer.on('featureUpdated', ({ evaluator }) => {
    evaluator.evaluate(({ properties }) => ({ color: cityColor, size: 2.5 + Math.sqrt(Number(properties?.['pop'] ?? 0) / 1e6) * 1.6 }), {
      filters: ['pop'],
    })
  })

  v.attribution?.add([{ attributionHtml: 'Map data: <a href="https://www.naturalearthdata.com/">Natural Earth</a>' }])

  // Hands on the globe stop it turning for a while
  let idleFrom = 0
  const touched = () => (idleFrom = performance.now() + IDLE_S * 1000)
  container.value.addEventListener('pointerdown', touched)
  container.value.addEventListener('wheel', touched, { passive: true })

  // --- Wearing a mix of palettes: painted over the key colours ---
  v.registerEffect('moodRecolor', MoodRecolorEffectDesc)
  const recolorConfig: MoodRecolorConfig = { moodRecolor: {} }
  const recolor = v.addEffect<MoodRecolorEffectDesc>(recolorConfig).ref
  // (three's colours, for the effect's uniforms: Navara's Color is another class)
  const pal = Object.fromEntries(ROLES.map((k) => [k, new ThreeColor()])) as Record<Role, ThreeColor>
  const paint = (w: Weights) => {
    const colors = blend(w)
    for (const k of ROLES) pal[k].setRGB(...colors[k], 'srgb')
    recolor.setPalette(pal)
  }

  // --- The face, and the moods it shows ---
  const panel = faceEl.value!
  const pctx = panel.getContext('2d')!
  let shown: Weights = only('calm')
  let headTurn = 0
  let lastLabel = 0
  // What the head, the hands and the spin move; and the surprise's springy zoom
  let base = { ...START, height: fitHeight() }
  // A new shape of screen (a phone turned, a window resized): fit the globe again
  let nearest = fitHeight(FILL_MAX)
  const refit = () => {
    base.height = fitHeight()
    nearest = fitHeight(FILL_MAX)
  }
  window.addEventListener('resize', refit)
  unmount.push(() => window.removeEventListener('resize', refit))
  let zoom = 1
  let zoomV = 0
  const globeAt = new Vector3()
  let last = performance.now()
  const start = last
  const step = () => {
    frame = requestAnimationFrame(step)
    const now = performance.now()
    const dt = Math.min(0.1, (now - last) / 1000)
    last = now
    const t = (now - start) / 1000

    // The panel, sized to its box
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const W = Math.round(panel.clientWidth * dpr)
    const H = Math.round(panel.clientHeight * dpr)
    if (panel.width !== W || panel.height !== H) {
      panel.width = W
      panel.height = H
    }
    const seen = face?.read()
    let shapes: Record<string, number>
    if (face?.ready) {
      // The camera's picture, mirrored; blurred whole whenever no face is found in it, so a face
      // the landmarker misses is never shown bare
      pctx.save()
      pctx.filter = seen ? 'none' : 'blur(14px)'
      pctx.translate(W, 0)
      pctx.scale(-1, 1)
      pctx.drawImage(face.video, 0, 0, W, H)
      pctx.restore()
      if (seen) {
        const m = (p: [number, number]): [number, number] => [(1 - p[0]) * W, p[1] * H]
        const top = m(seen.top)
        const chin = m(seen.chin)
        const a = m(seen.right)
        const b = m(seen.left)
        const faceH = Math.hypot(chin[0] - top[0], chin[1] - top[1])
        drawPlush(
          pctx,
          {
            x: (top[0] + chin[0]) / 2,
            y: (top[1] + chin[1]) / 2 - faceH * 0.04,
            r: faceH * 0.7,
            roll: Math.atan2(b[1] - a[1], b[0] - a[0]),
            yaw: -seen.yaw,
            pitch: seen.pitch,
          },
          seen.shapes,
        )
        shapes = seen.shapes
      } else shapes = {}
    } else {
      // No camera: the plush on its own, acting the moods out, on the sky of the moment
      const demo = demoFace(t, hold)
      const [r, g, b] = blend(shown).sky.map((x) => Math.round(x * 255))
      pctx.fillStyle = `rgb(${r}, ${g}, ${b})`
      pctx.fillRect(0, 0, W, H)
      drawPlush(pctx, { x: W / 2, y: H * 0.54, r: H * 0.36, roll: demo.roll, yaw: demo.yaw, pitch: demo.pitch }, demo.shapes)
      shapes = demo.shapes
    }

    // The map follows the face, eased over a quarter of a second
    const want = moodsOf(shapes)
    const ease = 1 - Math.exp(-dt / 0.25)
    shown = Object.fromEntries(MOODS.map((m) => [m, shown[m] + (want[m] - shown[m]) * ease])) as Weights
    paint(shown)
    // The label: ten times a second is plenty
    if (now - lastLabel > 100) {
      lastLabel = now
      const top = MOODS.reduce((a, m) => (shown[m] > shown[a] ? m : a), 'calm' as Mood)
      reading.value = { mood: top, share: shown[top] }
    }
    // The globe: turned by the head when there is one in front of the camera, else turning west to
    // east by itself; left to the hands while they turn it, and a while after
    const past = (x: number) => Math.sign(x) * Math.max(0, Math.abs(x) - DEAD) / (1 - DEAD)
    const head = seen ? { turn: past(seen.yaw), nod: past(seen.pitch) } : { turn: 0, nod: 0 }
    headTurn += (head.turn - headTurn) * (1 - Math.exp(-dt / 0.3))
    const steering = seen && Math.abs(headTurn) > 0.02
    if (now <= idleFrom) {
      const at = v.camera.positionGeographic
      base = { lng: at.lng, lat: at.lat, height: at.height }
    } else {
      // Looking to one's left (the nose to the right of the unmirrored picture: yaw > 0) shows the
      // west; on its own it spins faster in a temper, slower when sad, and hardly at all asleep
      const rate = steering ? -headTurn * HEAD_SPIN : SPIN * (1 + 2.5 * shown.angry - 0.5 * shown.sad - 0.85 * shown.sleepy)
      base.lng += rate * dt
      if (seen) {
        // Looking up (the nose higher up the face: pitch < 0) tips the north towards one
        const want = Math.max(-65, Math.min(65, START.lat - head.nod * HEAD_TILT))
        base.lat += (want - base.lat) * (1 - Math.exp(-dt / 0.6))
      }

      // The mood's body language, over that: a surprise jumps it closer (on a spring, so it
      // overshoots), joy bounces it, sadness shrinks it and sinks it low in the frame, temper shakes it, and
      // sleep nods it from side to side
      zoomV += ((1 - 0.32 * shown.surprised - zoom) * 120 - zoomV * 11) * dt
      zoom += zoomV * dt
      const bounce = 0.08 * shown.happy * Math.abs(Math.sin(t * 5.5))
      const shake = shown.angry
      v.setCamera({
        lng: base.lng + (Math.random() - 0.5) * 0.9 * shake,
        lat: base.lat + (Math.random() - 0.5) * 0.9 * shake,
        height: Math.max(nearest, base.height * zoom * (1 - bounce) * (1 + 0.25 * shown.sad)),
        heading: 0,
        pitch: -90 + 5 * shown.sad,
        roll: 12 * shown.sleepy * Math.sin(t * 0.9) + (Math.random() - 0.5) * 3 * shake,
      })
    }

    // The air's glow and the stars, round where the globe is on screen
    const cam = v.camera.raw
    const c = globeAt.set(0, 0, 0).project(cam)
    const e = v.camera.positionECEF
    const dist = Math.hypot(e.x, e.y, e.z)
    const radius = Math.tan(Math.asin(Math.min(1, 6_371_000 / dist))) / Math.tan((v.camera.raw.fov * Math.PI) / 360) / 2
    const glow = 0.55 * shown.calm + 1.1 * shown.happy + 0.3 * shown.sad + (1.2 + 0.35 * Math.sin(t * 13)) * shown.angry + shown.surprised + 0.45 * shown.sleepy
    const stars = shown.sleepy + 0.15 * shown.calm + 0.3 * shown.surprised
    // The cities show only at night, lit
    const lit = shown.sleepy
    recolor.setSky(c.x * 0.5 + 0.5, c.y * 0.5 + 0.5, radius, container.value!.clientWidth / container.value!.clientHeight, glow, stars, lit, t)
  }
  loading.value = false
  frame = requestAnimationFrame(step)
})

onBeforeUnmount(() => {
  cancelAnimationFrame(frame)
  unmount.forEach((f) => f())
  face?.stop()
  face = undefined
  view?.dispose()
  view = undefined
})
</script>

<template>
  <div class="map-canvas day28">
    <div ref="container" class="map-canvas" />
    <figure class="face" :class="{ live: camState === 'on' }">
      <canvas ref="faceEl" />
      <figcaption class="reading" :class="reading.mood" aria-live="polite">
        {{ MOOD_NAMES[reading.mood] }} <span>{{ Math.round(reading.share * 100) }}%</span>
      </figcaption>
      <button
        type="button"
        class="cam"
        :aria-pressed="camState === 'on'"
        :class="{ busy: camState === 'starting', failed: camState === 'failed' }"
        aria-label="Use the camera: your expression colours the map (your face is covered by the plush)"
        @click="toggleCamera"
      >
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M23 7l-7 5 7 5V7z" />
          <rect x="1" y="5" width="15" height="14" rx="2" />
        </svg>
      </button>
    </figure>
    <div v-if="loading" class="loading">Loading…</div>
  </div>
</template>

<style scoped>
.day28 {
  position: relative;
}

.face {
  position: absolute;
  right: 12px;
  bottom: 36px;
  z-index: 10;
  width: 300px;
  aspect-ratio: 4 / 3;
  margin: 0;
  overflow: hidden;
  border: 3px solid #fff8ee;
  border-radius: 18px;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.35);
}

.face canvas {
  display: block;
  width: 100%;
  height: 100%;
}

.reading {
  position: absolute;
  left: 8px;
  top: 8px;
  padding: 3px 10px 4px;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.02em;
  color: #5a3a24;
  background: rgba(255, 248, 238, 0.9);
  border-radius: 999px;
  pointer-events: none;
}

.reading span {
  font-weight: 500;
  opacity: 0.7;
}

.cam {
  position: absolute;
  right: 8px;
  bottom: 8px;
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  padding: 0;
  color: #5a3a24;
  background: rgba(255, 248, 238, 0.9);
  border: 0;
  border-radius: 50%;
  cursor: pointer;
}

.cam[aria-pressed='true'] {
  color: #fff;
  background: #e05a6a;
}

.cam.busy {
  animation: pulse 1s ease-in-out infinite;
}

.cam.failed {
  opacity: 0.45;
}

@keyframes pulse {
  50% {
    opacity: 0.4;
  }
}

@media (max-width: 700px) {
  .face {
    width: 168px;
    right: 8px;
    bottom: 40px;
  }
}

.loading {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: var(--fg-muted);
  pointer-events: none;
}
</style>
