<script setup lang="ts">
// Day 11: Senses: Sound — a summer thunderstorm drifting over Tokyo at night. Lightning is seen
// at once, but its thunder travels at 343 m/s: each strike lets out a ring that spreads over the
// ground, as bright as it is loud, and only when it reaches you (the person; click anywhere, or on
// the minimap, to stand there) do you hear it rumble, about 3 s for every kilometre; a countdown
// over each strike tells how long. From past ~20 km the lightning flashes silent
import ThreeView, { Color, geodeticToVector3, vector3ToGeodetic } from '@navaramap/three'
import { DefaultPlugin, type DefaultDescriptions } from '@navaramap/three-default-plugin'
import { TileJsonPlugin } from '@navaramap/three-plugins'
import { Vector3 } from 'three'
import { AUDIBLE, RING_LIFE, SOUND_SPEED, ThunderMeshDesc, flashAt, flashEnd, frontAt, loudness, type Strike, type ThunderConfig } from './lib/ThunderMeshDesc'
import { ThunderVoice } from './lib/thunderAudio'

const NIGHT = '#05070f'
// The basemap, dim under the storm, and lit up by a flash
const DIM_TINT = '#8e97b8'
const FLASH_TINT = '#e4e0ff'
const TINT_STEPS = 24

// You stand at Tokyo Station to start with
const START = { lng: 139.767, lat: 35.681 }
// The view: from just behind you, a little above the rooftops, looking north-west, the way Kanto's
// summer storms come in: they build up over the mountains of Gunma and Saitama in the afternoon
// and drift south-east over Tokyo. It looks level, so the clouds and the bolts out to the storm
// are in view
const EYE = { back: 3_000, height: 500, heading: 320, pitch: 0, roll: 0 }
// The minimap: straight down on you, the storm's whole reach in view
const MINIMAP = { distance: 75_000, pitch: -90, roll: 0 }

// The storm cell crosses you in passes, each from somewhere in the north-west to the south-east,
// missing you by up to MISS. It moves in time-lapse (real cells drift at ~10 m/s); the light and
// the sound don't. The first pass starts close, so the first thunder isn't long in coming
const STORM_SPEED = 120 // m/s
const FIRST_FROM = 9_000
const FROM = 32_000
const TO = 26_000
const MISS = 7_000
// The shake: from a thunder louder than SHAKE_FROM (about 4 km off) up to SHAKE_PX for one
// overhead, dying out over about SHAKE_FADE s
const SHAKE_FROM = 0.25
const SHAKE_PX = 14
const SHAKE_FADE = 0.7

// Strikes fall around the cell's centre, one every STRIKE_EVERY s on average
const CELL_SIGMA = 2_500
const STRIKE_EVERY = 2.4
const CLOUD_ONLY = 0.3
// The first strike once the sound is on, this close (m): heard in 0.7-1.7 s
const CLOSE: [number, number] = [250, 600]

const M_PER_LAT = 110_950
const mPerLng = (lat: number) => 111_320 * Math.cos((lat * Math.PI) / 180)
const rnd = (a: number, b: number) => a + Math.random() * (b - a)
const gauss = () => Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random())

// (Navara's Color has no lerp: mix the sRGB channels here)
const rgbOf = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
const rampOf = (stops: string[], steps: number) =>
  Array.from({ length: steps }, (_, i) => {
    const t = i / (steps - 1)
    const [a, b] = [rgbOf(stops[0]!), rgbOf(stops[1]!)]
    const hex = a.map((c, j) => Math.round(c + (b[j]! - c) * t).toString(16).padStart(2, '0')).join('')
    return new Color().setStyle(`#${hex}`)
  })

const container = ref<HTMLDivElement>()
const minimapContainer = ref<HTMLDivElement>()
const countdowns = ref<HTMLDivElement>()
const stage = ref<HTMLDivElement>()
let view: ThreeView<DefaultDescriptions> | undefined
let minimap: ThreeView<DefaultDescriptions> | undefined
let mounted = true
function dispose() {
  view?.dispose()
  minimap?.dispose()
  view = minimap = undefined
}

// Sound: on unless turned off, but browsers only let it start from a click or a key press,
// so it waits for the first one anywhere on the page. Once it's on, the first thing heard is a
// strike close by, in front of you: its thunder comes in under 2 s
const sound = ref(true)
let voice: ThunderVoice | undefined
let soundStartedAt = 0
let closeStrikeDue = false
const onFirstGesture = () => {
  if (voice || !sound.value) return
  voice = new ThunderVoice()
  voice.playing = true
  soundStartedAt = performance.now()
  closeStrikeDue = true
}
function toggleSound() {
  // The press that just started the sound shouldn't stop it again
  if (performance.now() - soundStartedAt < 600) return
  sound.value = !sound.value
  voice ??= new ThunderVoice()
  voice.playing = sound.value
}

// Sets up a view with the dim basemap and the thunder over it. The flashes light the basemap up:
// `setTint` takes it from dim to the flash's color
async function setUp(el: HTMLElement, listenerSize: number, attribution: boolean) {
  const v = new ThreeView<DefaultDescriptions>({
    container: el,
    backgroundColor: new Color().setStyle(NIGHT),
    animation: true,
    defaultAttribution: attribution,
  })
  v.addPlugin(new DefaultPlugin())
  const tilejson = new TileJsonPlugin()
  v.addPlugin(tilejson)
  await v.init()
  v.registerMesh('thunder', ThunderMeshDesc)
  const bloom = v.addEffect({ selectiveBloom: { strength: 1.5, radius: 0.6, threshold: 0 } })

  const basemap = await tilejson.addSource({
    type: 'raster-tile',
    url: 'https://papers.reearth.land/styles/papers-dark/tilejson.json',
  })
  const tints = rampOf([DIM_TINT, FLASH_TINT], TINT_STEPS)
  let tint = -1
  const basemapLayer = v.addLayer({ type: 'raster', source: basemap, raster: { color: tints[0]! } })
  const setTint = (light: number) => {
    const t = Math.round(Math.min(1, light) * (TINT_STEPS - 1))
    if (t === tint) return
    tint = t
    basemapLayer.update({ type: 'raster', source: basemap, raster: { color: tints[t]! } })
  }

  // (typed separately: the view's mesh config union only knows the DefaultPlugin descriptors)
  const thunderConfig: ThunderConfig = { effectIds: [bloom.id], thunder: { listenerSize } }
  const thunder = v.addMesh<ThunderMeshDesc>(thunderConfig)
  return { v, thunder, setTint }
}

onMounted(async () => {
  window.addEventListener('pointerdown', onFirstGesture, true)
  window.addEventListener('keydown', onFirstGesture, true)

  // One after the other: Navara's views share one worker pool, set up by the first
  const main = await setUp(container.value!, 44, true)
  view = main.v
  if (!mounted) return dispose() // unmounted while setting up
  const mini = await setUp(minimapContainer.value!, 26, false)
  minimap = mini.v
  if (!mounted) return dispose()
  const v = main.v

  // Where you stand; click to stand somewhere else, on the view or on the minimap. The view
  // stands just behind you, at the height of a tall tower, and takes you along
  let listener = { ...START }
  const eyeOn = (to: typeof START, heading: number) => {
    const b = (heading * Math.PI) / 180
    return {
      lng: to.lng - (EYE.back * Math.sin(b)) / mPerLng(to.lat),
      lat: to.lat - (EYE.back * Math.cos(b)) / M_PER_LAT,
      height: EYE.height,
      heading,
      pitch: EYE.pitch,
      roll: EYE.roll,
    }
  }
  v.setCamera(eyeOn(listener, EYE.heading))
  // The minimap looks straight down on you, turned the way you look
  const followOnMinimap = () => {
    mini.v.setCamera({ ...listener, height: 0, ...MINIMAP, heading: v.camera.orientation.heading ?? 0 })
  }
  mini.v.camera.options = { enableSpin: false, enableTilt: false, enableZoom: false }
  followOnMinimap()
  const standAt = (lng: number, lat: number) => {
    listener = { lng, lat }
    for (const { thunder } of [main, mini]) thunder.ref.setListener(lng, lat)
    void v.flyTo(eyeOn(listener, v.camera.orientation.heading ?? EYE.heading), { duration: 1500, easing: 'cubicInOut' })
  }
  for (const { thunder } of [main, mini]) thunder.ref.setListener(listener.lng, listener.lat)
  for (const { v: on } of [main, mini]) {
    on.on('click', (e) => {
      if (!e.map) return
      const { lng, lat } = vector3ToGeodetic(new Vector3(e.map.x, e.map.y, e.map.z))
      standAt(lng, lat)
    })
  }
  // A strike, seen from where you stand: metres east and north
  const offsetOf = (s: { lng: number; lat: number }) => ({
    x: (s.lng - listener.lng) * mPerLng(listener.lat),
    y: (s.lat - listener.lat) * M_PER_LAT,
  })

  // The storm's passes, aimed at where you stand when each one sets off
  type Pass = { origin: typeof START; from: number; dir: number; miss: number; start: number }
  const newPass = (start: number, from: number): Pass => ({
    origin: { ...listener },
    from,
    dir: rnd(-75, -15), // compass bearing it comes from, west-north-west to north
    miss: rnd(-MISS, MISS),
    start,
  })
  let pass = newPass(performance.now() / 1000, FIRST_FROM)
  // The cell's centre at `now`: along the pass, `miss` off to the side
  const cellAt = (now: number) => {
    const along = pass.from - STORM_SPEED * (now - pass.start) // >0: still coming
    const b = (pass.dir * Math.PI) / 180
    const [ux, uy] = [Math.sin(b), Math.cos(b)] // toward where it comes from
    const x = ux * along + uy * pass.miss
    const y = uy * along - ux * pass.miss
    return { lng: pass.origin.lng + x / mPerLng(pass.origin.lat), lat: pass.origin.lat + y / M_PER_LAT, along }
  }

  // A strike in the storm, or one to the ground at `near`
  const newStrike = (time: number, near?: { lng: number; lat: number }): Strike => {
    const c = cellAt(time)
    const cloudOnly = !near && Math.random() < CLOUD_ONLY
    const base = rnd(3500, 5500)
    const strokes = [0]
    const n = cloudOnly ? Math.floor(rnd(1, 3)) : Math.floor(rnd(1, 5))
    for (let i = 1; i < n; i++) strokes.push(strokes[i - 1]! + rnd(0.04, 0.16))
    return {
      lng: near?.lng ?? c.lng + (gauss() * CELL_SIGMA) / mPerLng(c.lat),
      lat: near?.lat ?? c.lat + (gauss() * CELL_SIGMA) / M_PER_LAT,
      time,
      cloudOnly,
      base,
      strokes,
      span: cloudOnly ? rnd(3000, 6000) : base * 0.8,
    }
  }

  // Strikes whose thunder is still on its way, each with a countdown over it to when you'll hear
  // it: only for those whose ring reaches you before it fades out, RING_LIFE s on (still heard
  // from farther, up to AUDIBLE, but uncounted)
  type Pending = { strike: Strike; heard: boolean; left?: number; label?: HTMLSpanElement }
  let pending: Pending[] = []
  let nextStrikeAt = performance.now() / 1000 + 1
  let last = performance.now() / 1000
  let flare = 0
  // The view shakes with a near, loud thunder
  let shake = 0

  v.on('preUpdate', () => {
    const now = performance.now() / 1000
    const dt = now - last
    last = now
    // After a pause (a hidden tab), skip ahead instead of letting everything out at once
    const stale = dt > 0.5
    if (now - nextStrikeAt > 3) nextStrikeAt = now

    if (cellAt(now).along < -TO) pass = newPass(now, FROM)
    const strike = (s: Strike) => {
      pending.push({ strike: s, heard: false })
      for (const { thunder } of [main, mini]) thunder.ref.add(s)
    }
    while (nextStrikeAt <= now) {
      strike(newStrike(nextStrikeAt))
      nextStrikeAt += -Math.log(1 - Math.random()) * STRIKE_EVERY
    }
    if (closeStrikeDue) {
      closeStrikeDue = false
      // Ahead of you, within 30° of where you look, CLOSE m off
      const b = (((v.camera.orientation.heading ?? 0) + rnd(-30, 30)) * Math.PI) / 180
      const d = rnd(...CLOSE)
      strike(
        newStrike(now + 0.3, {
          lng: listener.lng + (d * Math.sin(b)) / mPerLng(listener.lat),
          lat: listener.lat + (d * Math.cos(b)) / M_PER_LAT,
        }),
      )
    }

    // Has a ring reached you? Then you hear it
    const heading = v.camera.orientation.heading ?? 0
    let light = 0
    for (const p of pending) {
      const s = p.strike
      const t = now - s.time
      const { x, y } = offsetOf(s)
      const d = Math.hypot(x, y)
      // The flash lights the land, less the farther it is
      if (t < flashEnd(s)) light += flashAt(s, t) * Math.exp(-d / 30_000) * (s.cloudOnly ? 0.35 : 0.6)
      p.left = undefined
      if (p.heard) continue
      if (frontAt(s, t) < d) {
        const arrival = Math.hypot(d, s.cloudOnly ? s.base : 0) / SOUND_SPEED
        if (arrival <= RING_LIFE) p.left = arrival - t
        continue
      }
      p.heard = true
      if (stale || d > AUDIBLE) continue
      const h = s.cloudOnly ? s.base : 0
      const distance = Math.hypot(d, h)
      // The rumble lasts as long as the sound keeps arriving from the rest of the channel
      const spread = (s.cloudOnly ? s.span : Math.hypot(d, s.base) - d) / SOUND_SPEED
      const bearing = (Math.atan2(x, y) * 180) / Math.PI
      if (sound.value) voice?.play({ distance, spread, pan: Math.sin(((bearing - heading) * Math.PI) / 180) })
      flare = Math.max(flare, loudness(distance))
      shake = Math.max(shake, (loudness(distance) - SHAKE_FROM) / (1 - SHAKE_FROM))
    }
    pending = pending.filter((p) => {
      if (frontAt(p.strike, now - p.strike.time, p.strike.span) <= AUDIBLE) return true
      p.label?.remove()
      return false
    })
    flare *= Math.exp(-dt / 1.2)
    shake *= Math.exp(-dt / SHAKE_FADE)
    const el = stage.value
    if (el) {
      // Two sines at odd rates each way, so it rattles rather than swings; scaled up a touch
      // so the edges stay covered
      const a = shake > 0.01 ? shake : 0
      const x = a * SHAKE_PX * (Math.sin(now * 61) + Math.sin(now * 37.3)) / 2
      const y = a * SHAKE_PX * (Math.sin(now * 53.1) + Math.sin(now * 29.7)) / 2
      el.style.transform = a ? `translate(${x}px, ${y}px) rotate(${a * 0.4 * Math.sin(now * 23)}deg) scale(${1 + a * 0.03})` : ''
    }
    for (const { thunder, setTint } of [main, mini]) {
      setTint(light)
      thunder.ref.tick(now, flare)
    }
    followOnMinimap()
  })

  // The countdowns, low over where each strike came down (COUNTDOWN_HEIGHT m up)
  const at = new Vector3()
  const LABEL_TOP = 34
  const COUNTDOWN_HEIGHT = 1_000
  v.on('preRender', () => {
    const el = countdowns.value
    if (!el) return
    const camera = v.camera.raw
    const [w, h] = [el.clientWidth, el.clientHeight]
    for (const p of pending) {
      const s = p.strike
      if (p.left === undefined) {
        p.label?.remove()
        p.label = undefined
        continue
      }
      at.copy(geodeticToVector3({ lng: s.lng, lat: s.lat, height: COUNTDOWN_HEIGHT })).project(camera)
      if (at.z > 1 || Math.abs(at.x) > 1.1 || at.y < -1) {
        if (p.label) p.label.style.display = 'none'
        continue
      }
      if (!p.label) {
        p.label = document.createElement('span')
        el.append(p.label)
      }
      p.label.style.display = ''
      // Above the top of the view, it stays pinned to the top edge
      const y = Math.max(LABEL_TOP, ((1 - at.y) / 2) * h)
      p.label.style.transform = `translate(${((at.x + 1) / 2) * w}px, ${y}px) translate(-50%, -100%)`
      // As loud as it will be, as bright
      p.label.style.opacity = String(0.35 + 0.65 * Math.sqrt(loudness(p.left * SOUND_SPEED)))
      p.label.textContent = String(Math.ceil(p.left))
    }
  })

  v.attribution?.add([{ attributionHtml: 'Lightning: simulated' }])
})

onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', onFirstGesture, true)
  window.removeEventListener('keydown', onFirstGesture, true)
  voice?.dispose()
  voice = undefined
  mounted = false
  dispose()
})
</script>

<template>
  <div class="map-canvas day11">
    <div ref="stage" class="stage">
      <div ref="container" class="map-canvas" />
      <div ref="countdowns" class="countdowns" />
    </div>
    <div ref="minimapContainer" class="minimap" />
    <button type="button" class="sound" :aria-pressed="sound" @click="toggleSound">
      {{ sound ? '🔊 Sound on' : '🔇 Sound off' }}
    </button>
  </div>
</template>

<style scoped>
.day11 {
  position: relative;
  overflow: hidden;
}

/* Matches the page's header panel */
.sound {
  position: absolute;
  top: 12px;
  right: 12px;
  z-index: 10;
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

.sound:hover {
  color: var(--accent);
}

/* The view and its countdowns, shaken together */
.stage {
  position: absolute;
  inset: 0;
}

.countdowns {
  position: absolute;
  inset: 0;
  z-index: 5;
  overflow: hidden;
  pointer-events: none;
}

/* Added from the script: scoped styles don't reach them */
.countdowns :deep(span) {
  position: absolute;
  top: 0;
  left: 0;
  font-size: 18px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: #ffe2b8;
  text-shadow: 0 0 8px rgba(255, 174, 79, 0.9), 0 0 2px #000;
}

/* Bottom left, clear of the attribution */
.minimap {
  position: absolute;
  left: 12px;
  bottom: 12px;
  z-index: 10;
  width: min(280px, 38vw);
  aspect-ratio: 1;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
}
</style>
