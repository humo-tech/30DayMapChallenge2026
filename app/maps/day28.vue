<script setup lang="ts">
// Day 28: Senses: Feeling — Hokkaido and the drift ice of the Sea of Okhotsk on 1 March 2025, to be
// felt with a finger. The map moves by what the finger is on: the sea is heavy and drags behind,
// the ice is slick and slides on when let go, snow is soft and crunches, forest brushes, a town
// sticks and lurches (ゴゴゴ), and slopes push back on the way up. Each answers in sound, in a
// buzz in the hand (phones), and in the marks left on the ground: ripples, scratches, furrows.
// Navara: the real sun of that morning over the terrain, the satellite image of the day draped on.
// Data: scripts/day28/build_feel.py
import ThreeView, { Color, geodeticToVector3, vector3ToGeodetic } from '@navaramap/three'
import { DefaultPlugin, type DefaultDescriptions } from '@navaramap/three-default-plugin'
import { Vector3 } from 'three'
import { loadGround, type Ground, type Material } from './lib/feelGround'
import { Slider } from './lib/feelPhysics'
import { FeelVoice } from './lib/feelAudio'
import { Haptics } from './lib/feelHaptics'
import { BONES, HandInput, type HandFrame } from './lib/feelHand'

const baseURL = useRuntimeConfig().app.baseURL
const dataBase = `${baseURL}data/day28`

// The morning of the image: Terra crosses Hokkaido at about half past ten (JST)
const WHEN = new Date('2025-03-01T01:30:00Z')
const MODIS =
  'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/2025-03-01/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg'
const REEARTH_TERRAIN = 'https://terrain.reearth.land/cesium-mesh/ellipsoid/{z}/{x}/{y}.terrain'

// Off Abashiri: the drift ice, the town, the frozen lagoons, the snowfields and forests behind
const START = { lng: 144.15, lat: 43.92 }
const DISTANCE = 95_000
const PITCH = -52
const M_PER_DEG_LAT = 110_950

const query = useRoute().query
const container = ref<HTMLDivElement>()
const marksEl = ref<HTMLCanvasElement>()
const loading = ref(true)
const sound = ref(true)
let view: ThreeView<DefaultDescriptions> | undefined
let voice: FeelVoice | undefined
let haptics: Haptics | undefined
let hand: HandInput | undefined
// The hand: off, starting (camera and model loading), on, or refused
const handState = ref<'off' | 'starting' | 'on' | 'failed'>('off')

async function toggleHand() {
  if (hand || handState.value === 'starting') {
    hand?.stop()
    hand = undefined
    handState.value = 'off'
    return
  }
  handState.value = 'starting'
  const h = new HandInput()
  try {
    await h.start()
  } catch (e) {
    console.warn('Day 28: no hand input', e)
    h.stop()
    handState.value = 'failed'
    return
  }
  if (handState.value !== 'starting') return h.stop()
  hand = h
  handState.value = 'on'
}
let frame = 0

watch(sound, (on) => {
  if (voice) voice.muted = !on
})

// --- Marks left on the ground ---
type Mark = { kind: Material | 'dust'; lng: number; lat: number; h: number; born: number; size: number; trail?: number }
// Trails are strings of points; a new trail starts when the finger lifts or changes ground
const LIFE: Record<Mark['kind'], number> = { sea: 1.8, ice: 7, lake: 7, snow: 14, forest: 1.2, town: 0.8, dust: 0.9 }

onMounted(async () => {
  const ground = await loadGround(dataBase)
  if (!container.value) return
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2)
  const v = new ThreeView<DefaultDescriptions>({
    container: container.value,
    backgroundColor: new Color().setStyle('#0b1220'),
    animation: true,
    shadow: true,
    segments: 40,
    pixelRatio,
  })
  view = v
  const plugin = new DefaultPlugin()
  v.addPlugin(plugin)
  await v.init()
  if (view !== v) return
  // The finger moves the map, not the camera's own controls
  v.camera.options = { enableSpin: false, enableTilt: false, enableZoom: false }
  v.atmosphere.date = WHEN

  const scene = plugin.addDefaultPhotorealScene()
  scene.sun.update({ sun: { castShadow: true, shadowFar: 400_000 } })
  v.toneMappingExposure = 1.3

  const terrain = v.addSource({ type: 'quantized-mesh', url: REEARTH_TERRAIN, maxZoom: 18, requestVertexNormals: true })
  v.addLayer({ type: 'terrain', source: terrain, terrain: { castShadow: true, receiveShadow: true } })
  const imagery = v.addSource({ type: 'raster-tile', url: MODIS, maxZoom: 9 })
  v.addLayer({ type: 'raster', source: imagery })
  v.attribution?.add([
    { attribution: '© Re:Earth Terrain', attributionUrl: 'https://terrain.reearth.land/' },
    { attributionHtml: 'Image: MODIS Terra, 1 Mar 2025, <a href="https://earthdata.nasa.gov/gibs">NASA GIBS</a>' },
    {
      attributionHtml:
        'Ground: <a href="https://esa-worldcover.org/">ESA WorldCover 2021</a> · <a href="https://spacedata.copernicus.eu/collections/copernicus-digital-elevation-model">Copernicus DEM</a>',
    },
  ])

  // --- The camera: looking down at a point on the ground from a fixed distance ---
  const cam = (query.camera as string | undefined)?.split(',').map(Number)
  const centre = cam?.length === 2 && cam.every(Number.isFinite) ? { lng: cam[0]!, lat: cam[1]! } : { ...START }
  const { west, east, south, north } = ground.meta
  let shake = [0, 0]
  const place = () => {
    centre.lng = Math.min(east - 0.6, Math.max(west + 0.6, centre.lng))
    centre.lat = Math.min(north - 0.4, Math.max(south + 0.4, centre.lat))
    const mx = M_PER_DEG_LAT * Math.cos((centre.lat * Math.PI) / 180)
    v.setCamera({
      lng: centre.lng + (shake[0]! * mPerPx()) / mx,
      lat: centre.lat + (shake[1]! * mPerPx()) / M_PER_DEG_LAT,
      height: 0,
      distance: DISTANCE,
      heading: 0,
      pitch: PITCH,
      roll: 0,
    })
  }
  // Metres per CSS pixel across the screen at its centre
  const mPerPx = () => (2 * DISTANCE * Math.tan(((v.camera.fov ?? 60) * Math.PI) / 360)) / container.value!.clientHeight
  const sinPitch = Math.sin((-PITCH * Math.PI) / 180)
  place()

  // --- The finger: a pointer (touch, mouse, pen), or a pinching hand in front of the camera ---
  const slider = new Slider()
  let finger: { x: number; y: number } | undefined
  let holder: number | 'hand' | undefined
  const el = container.value
  haptics = new Haptics(el)
  const press = (who: number | 'hand', x: number, y: number) => {
    if (holder !== undefined) return
    holder = who
    finger = { x, y }
    slider.grab()
    if (!voice) {
      voice = new FeelVoice()
      voice.muted = !sound.value
    }
    voice.resume()
    trail++
  }
  const moveTo = (who: number | 'hand', x: number, y: number) => {
    if (who !== holder || !finger) return
    // Screen y runs down, the map's north up
    slider.drag(x - finger.x, -(y - finger.y) / sinPitch)
    finger = { x, y }
  }
  const lift = (who: number | 'hand') => {
    if (who !== holder) return
    holder = undefined
    slider.release()
    trail++
  }
  el.addEventListener('pointerdown', (e) => {
    if (holder !== undefined) return
    el.setPointerCapture(e.pointerId)
    press(e.pointerId, e.clientX, e.clientY)
  })
  el.addEventListener('pointermove', (e) => moveTo(e.pointerId, e.clientX, e.clientY))
  el.addEventListener('pointerup', (e) => lift(e.pointerId))
  el.addEventListener('pointercancel', (e) => lift(e.pointerId))
  let handFrame: HandFrame | undefined
  const readHand = () => {
    const rect = el.getBoundingClientRect()
    handFrame = hand?.read(rect.width, rect.height)
    if (!handFrame) return lift('hand')
    const x = rect.left + handFrame.at[0]
    const y = rect.top + handFrame.at[1]
    if (handFrame.pinched) {
      if (holder === undefined) press('hand', x, y)
      else moveTo('hand', x, y)
    } else lift('hand')
  }

  // Where on the ground a point of the screen is: the terrain under it, or (off the tiles yet)
  // reckoned from the centre
  const groundAt = (x: number, y: number) => {
    const rect = el.getBoundingClientRect()
    const p = v.pickTerrainPosition(x, y)
    if (p) return vector3ToGeodetic(p)
    const m = mPerPx()
    return {
      lng: centre.lng + ((x - rect.left - rect.width / 2) * m) / (M_PER_DEG_LAT * Math.cos((centre.lat * Math.PI) / 180)),
      lat: centre.lat - ((y - rect.top - rect.height / 2) * m) / sinPitch / M_PER_DEG_LAT,
    }
  }

  // --- Marks ---
  const marks: Mark[] = []
  let trail = 0
  const canvas = marksEl.value!
  const ctx = canvas.getContext('2d')!
  const at = new Vector3()
  const project = (m: { lng: number; lat: number; h: number }) => {
    at.copy(geodeticToVector3({ lng: m.lng, lat: m.lat, height: m.h }) as unknown as Vector3).project(v.camera.raw)
    if (at.z > 1) return undefined
    return [((at.x + 1) / 2) * canvas.clientWidth, ((1 - at.y) / 2) * canvas.clientHeight] as const
  }

  // --- Each frame ---
  let last = performance.now()
  let lastMaterial: Material | undefined
  let lastGlide: Material | undefined
  let lastAmount = 0
  let lastHeight: number | undefined
  let travelled = 0 // px since the last grain
  let nextGrain = 20
  let hum = 0 // s since the last buzz of a continuous ground
  let shakeAmp = 0
  const step = () => {
    frame = requestAnimationFrame(step)
    const now = performance.now()
    const dt = Math.min(0.05, (now - last) / 1000)
    last = now
    const t = now / 1000
    if (hand) readHand()
    else handFrame = undefined

    const rect = el.getBoundingClientRect()
    const fx = finger?.x ?? rect.left + rect.width / 2
    const fy = finger?.y ?? rect.top + rect.height / 2
    const g = groundAt(fx, fy)
    const under = ground.at(g.lng, g.lat)
    const slope = ground.slope(g.lng, g.lat)
    const m = mPerPx()

    // The map moves: in small steps, so a stiff spring stays steady
    const before = [...slider.pos]
    let slip = 0
    const n = Math.ceil(dt / 0.004)
    for (let i = 0; i < n; i++) {
      const ev = slider.step(dt / n, { material: under.material, amount: under.amount, slope }, 1 / m)
      slip = Math.max(slip, ev.slip ?? 0)
    }
    const dx = slider.pos[0]! - before[0]!
    const dy = slider.pos[1]! - before[1]!
    centre.lng += (dx * m) / (M_PER_DEG_LAT * Math.cos((centre.lat * Math.PI) / 180))
    centre.lat += (dy * m) / M_PER_DEG_LAT
    shakeAmp *= Math.exp(-dt * 14)
    shake = [(Math.random() * 2 - 1) * shakeAmp, (Math.random() * 2 - 1) * shakeAmp]
    place()

    // How the ground answers, while the finger is on it and moving over it
    const held = holder !== undefined
    const speed = slider.speed
    const mat = under.material
    // Let go on ice, the map slides on under where the finger was, and that still scratches
    const gliding = !held && finger !== undefined && (mat === 'ice' || mat === 'lake') && speed > 25
    const going = held || gliding ? Math.min(1, speed / 900) : 0
    voice?.set(mat, going)
    const mark = (kind: Mark['kind'], size = 1) =>
      marks.push({ kind, lng: g.lng, lat: g.lat, h: under.height, born: t, size, trail })
    if (held) {
      if (mat !== lastMaterial) {
        trail++
        if (mat === 'sea' || (mat === 'ice' && under.amount < 0.5)) {
          voice?.splash(0.6 + going)
          haptics?.buzz(60)
          mark('sea', 1.4)
        }
      }
      const dist = speed * dt
      travelled += dist
      hum += dt
      if (slip > 0) {
        voice?.thud(0.4 + slip * 0.6)
        haptics?.buzz(25 + slip * 45)
        shakeAmp = 3 + slip * 7
        mark('dust', 0.6 + slip)
      }
      if (dist > 0.2) {
        switch (mat) {
          case 'sea':
            if (travelled > 28) mark('sea'), (travelled = 0)
            if (hum > 0.22 && going > 0.05) haptics?.buzz(30 + going * 90), (hum = 0)
            break
          case 'ice':
          case 'lake':
            mark(mat)
            // A floe's edge, or now and then a squeak as it runs
            if (Math.abs(under.amount - lastAmount) > 0.3 || Math.random() < going * dt * 1.5) {
              voice?.squeak(0.5 + going)
              haptics?.buzz(8)
            }
            break
          case 'snow':
            mark('snow')
            if (travelled > nextGrain) {
              voice?.crunch(0.5 + going)
              haptics?.buzz(9 + going * 10)
              travelled = 0
              nextGrain = 14 + Math.random() * 16
            }
            break
          case 'forest':
            if (travelled > nextGrain) {
              voice?.twig()
              haptics?.buzz(5)
              mark('forest', 0.6 + Math.random() * 0.6)
              travelled = 0
              nextGrain = 6 + Math.random() * 14
            }
            break
          case 'town':
            // A judder while it runs: ゴゴゴ
            if (hum > 0.07 && going > 0.03) haptics?.buzz(14), (hum = 0)
            break
        }
      }
      // Every 100 m of height crossed: a tick
      if (lastHeight !== undefined && Math.floor(under.height / 100) !== Math.floor(lastHeight / 100)) {
        voice?.tick()
        haptics?.buzz(4)
      }
    } else if (gliding) {
      if (mat !== lastGlide) trail++
      mark(mat)
    }
    lastGlide = gliding ? mat : undefined
    lastMaterial = held ? mat : undefined
    lastAmount = under.amount
    lastHeight = held ? under.height : undefined

    draw(t, held ? { x: fx - rect.left, y: fy - rect.top, mat, going } : undefined)
  }

  // --- Drawing the marks ---
  const draw = (t: number, touch?: { x: number; y: number; mat: Material; going: number }) => {
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    if (canvas.width !== Math.round(w * pixelRatio) || canvas.height !== Math.round(h * pixelRatio)) {
      canvas.width = Math.round(w * pixelRatio)
      canvas.height = Math.round(h * pixelRatio)
    }
    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
    ctx.clearRect(0, 0, w, h)
    // Forget what has faded
    let k = 0
    for (const m of marks) if (t - m.born < LIFE[m.kind]) marks[k++] = m
    marks.length = k

    // Trails: furrows in the snow, scratches on the ice
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    const trails = new Map<number, { kind: Material; pts: [number, number, number][] }>()
    for (const m of marks) {
      if (m.kind !== 'snow' && m.kind !== 'ice' && m.kind !== 'lake') continue
      const p = project(m)
      if (!p) continue
      let tr = trails.get(m.trail!)
      if (!tr || tr.kind !== m.kind) trails.set(m.trail!, (tr = { kind: m.kind, pts: [] }))
      tr.pts.push([p[0], p[1], 1 - (t - m.born) / LIFE[m.kind]])
    }
    for (const tr of trails.values()) {
      const pts = tr.pts
      for (let i = 1; i < pts.length; i++) {
        const [x0, y0] = pts[i - 1]!
        const [x1, y1, life] = pts[i]!
        const a = Math.min(1, life * 1.5)
        if (tr.kind === 'snow') {
          // A furrow: its shadowed floor, and the snow pushed up on its sunny lip
          ctx.strokeStyle = `rgba(70, 90, 130, ${0.55 * a})`
          ctx.lineWidth = 7
          ctx.beginPath()
          ctx.moveTo(x0, y0)
          ctx.lineTo(x1, y1)
          ctx.stroke()
          ctx.strokeStyle = `rgba(255, 255, 255, ${0.8 * a})`
          ctx.lineWidth = 2
          ctx.beginPath()
          ctx.moveTo(x0 - 1, y0 - 3.5)
          ctx.lineTo(x1 - 1, y1 - 3.5)
          ctx.stroke()
        } else {
          // A scratch: thin and bright
          ctx.strokeStyle = `rgba(220, 245, 255, ${0.9 * a})`
          ctx.lineWidth = 1.3
          ctx.shadowColor = 'rgba(160, 220, 255, 0.9)'
          ctx.shadowBlur = 6
          ctx.beginPath()
          ctx.moveTo(x0, y0)
          ctx.lineTo(x1, y1)
          ctx.stroke()
          ctx.shadowBlur = 0
        }
      }
    }

    for (const m of marks) {
      const age = (t - m.born) / LIFE[m.kind]
      if (m.kind === 'sea') {
        const p = project(m)
        if (!p) continue
        // Ripples: two rings spreading, flattened as the ground is seen at a slant
        for (const lag of [0, 0.25]) {
          const a = age - lag
          if (a <= 0) continue
          const r = (8 + 70 * Math.sqrt(a)) * m.size
          ctx.strokeStyle = `rgba(200, 230, 255, ${0.55 * (1 - a) ** 1.5})`
          ctx.lineWidth = 1.6
          ctx.beginPath()
          ctx.ellipse(p[0], p[1], r, r * sinPitch, 0, 0, Math.PI * 2)
          ctx.stroke()
        }
      } else if (m.kind === 'forest') {
        // Snow shaken off the boughs: a little puff that drifts down
        const p = project(m)
        if (!p) continue
        for (let i = 0; i < 6; i++) {
          const ang = (i / 6) * Math.PI * 2 + m.born * 7
          const r = 4 + 14 * age * m.size
          ctx.fillStyle = `rgba(255, 255, 255, ${0.85 * (1 - age)})`
          ctx.beginPath()
          ctx.arc(p[0] + Math.cos(ang) * r, p[1] + Math.sin(ang) * r * 0.6 + 10 * age * age, 1.6, 0, Math.PI * 2)
          ctx.fill()
        }
      } else if (m.kind === 'dust') {
        // A town lurching: a puff of grit
        const p = project(m)
        if (!p) continue
        for (let i = 0; i < 10; i++) {
          const ang = (i / 10) * Math.PI * 2 + m.born * 13
          const r = (6 + 30 * Math.sqrt(age)) * m.size
          ctx.fillStyle = `rgba(190, 175, 155, ${0.7 * (1 - age)})`
          ctx.beginPath()
          ctx.arc(p[0] + Math.cos(ang) * r, p[1] + Math.sin(ang) * r * sinPitch, 2.2 * (1 - age) + 0.8, 0, Math.PI * 2)
          ctx.fill()
        }
      }
    }

    // The hand, as its bones, lit up while it pinches
    if (handFrame) {
      const pts = handFrame.points.map(([x, y]) => [x, y] as const)
      const on = handFrame.pinched
      ctx.lineCap = 'round'
      // Its shadow on the ground first, cast north-west (up and left) by the morning sun in the
      // south-east, and closer under the hand as it pinches down onto the map
      for (const [shadow, colour, width] of [
        [true, 'rgba(10, 20, 40, 0.28)', 9],
        [false, on ? 'rgba(255, 244, 214, 0.95)' : 'rgba(255, 255, 255, 0.75)', 4],
      ] as const) {
        const ox = shadow ? -(22 - handFrame.closure * 12) : 0
        const oy = shadow ? -(16 - handFrame.closure * 9) : 0
        ctx.strokeStyle = colour
        ctx.lineWidth = width
        ctx.beginPath()
        for (const [a, b] of BONES) {
          ctx.moveTo(pts[a]![0] + ox, pts[a]![1] + oy)
          ctx.lineTo(pts[b]![0] + ox, pts[b]![1] + oy)
        }
        ctx.stroke()
        ctx.fillStyle = colour
        for (const [x, y] of pts) {
          ctx.beginPath()
          ctx.arc(x + ox, y + oy, width * 0.9, 0, Math.PI * 2)
          ctx.fill()
        }
      }
    }

    // The fingertip on the ground: pressed in, a little wider the faster it goes
    if (touch) {
      const r = 16 + touch.going * 6
      const grd = ctx.createRadialGradient(touch.x, touch.y, r * 0.2, touch.x, touch.y, r * 1.6)
      grd.addColorStop(0, 'rgba(255, 255, 255, 0.0)')
      grd.addColorStop(0.55, 'rgba(255, 255, 255, 0.22)')
      grd.addColorStop(1, 'rgba(255, 255, 255, 0)')
      ctx.fillStyle = grd
      ctx.beginPath()
      ctx.ellipse(touch.x, touch.y, r * 1.6, r * 1.6 * sinPitch, 0, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  loading.value = false
  frame = requestAnimationFrame(step)
})

onBeforeUnmount(() => {
  cancelAnimationFrame(frame)
  hand?.stop()
  hand = undefined
  voice?.dispose()
  voice = undefined
  haptics?.dispose()
  haptics = undefined
  view?.dispose()
  view = undefined
})
</script>

<template>
  <div class="map-canvas day28">
    <div ref="container" class="map-canvas" />
    <canvas ref="marksEl" class="marks" />
    <div class="controls">
      <button
        type="button"
        class="toggle"
        :aria-pressed="handState === 'on'"
        :class="{ busy: handState === 'starting', failed: handState === 'failed' }"
        aria-label="Move the map with your hand (camera)"
        @click="toggleHand"
      >
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M18 11V6a2 2 0 0 0-4 0v5M14 10V4a2 2 0 0 0-4 0v6M10 10.5V6a2 2 0 0 0-4 0v8" />
          <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />
        </svg>
      </button>
      <button type="button" class="toggle" :aria-pressed="sound" aria-label="Sound" @click="sound = !sound">
        <svg v-if="sound" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M11 5 6 9H2v6h4l5 4V5z" />
          <path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14" />
        </svg>
        <svg v-else viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M11 5 6 9H2v6h4l5 4V5z" />
          <path d="m22 9-6 6M16 9l6 6" />
        </svg>
      </button>
    </div>
    <div v-if="loading" class="loading">Loading…</div>
  </div>
</template>

<style scoped>
.day28 {
  position: relative;
  touch-action: none;
}

.marks {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}

/* Matches the page's header panel */
.controls {
  display: flex;
  gap: 4px;
  position: absolute;
  right: 12px;
  bottom: 36px;
  z-index: 10;
  padding: 6px;
  background: rgba(15, 20, 25, 0.82);
  backdrop-filter: blur(6px);
  border: 1px solid var(--border);
  border-radius: 10px;
}

.toggle {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  padding: 0;
  color: var(--fg);
  background: none;
  border: 0;
  border-radius: 7px;
  cursor: pointer;
}

.toggle:hover {
  color: var(--accent);
}

.toggle.busy {
  animation: pulse 1s ease-in-out infinite;
}

.toggle.failed {
  color: var(--fg-muted);
  opacity: 0.5;
}

@keyframes pulse {
  50% {
    opacity: 0.35;
  }
}

.toggle[aria-pressed='true'] {
  color: var(--bg);
  background: var(--accent);
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
