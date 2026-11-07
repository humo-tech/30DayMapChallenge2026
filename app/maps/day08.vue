<script setup lang="ts">
// Day 8: Utopia — a 2 km loop through a pastel plush world, ridden first person on a smart
// trainer (Web Bluetooth FTMS, Chrome): its power drives the speed and the road's gentle slopes
// are sent back as resistance. Without a trainer it rides itself, ↑ / ↓ to change the power.
import {
  CylinderGeometry,
  DirectionalLight,
  Fog,
  Group,
  HemisphereLight,
  Mesh,
  NeutralToneMapping,
  PCFShadowMap,
  PerspectiveCamera,
  Scene,
  SphereGeometry,
  TorusGeometry,
  Vector3,
  WebGLRenderer,
} from 'three'
import { COURSE_M, Course } from './lib/utopiaCourse'
import { FOG, PASTELS, buildWorld, disposeTree, makeBear } from './lib/utopiaWorld'
import { Trainer, hasWebBluetooth, type TrainerData } from './lib/ftms'

// Rider and bike (kg), air and tyres
const MASS = 83
const CRR = 0.004
const CDA = 0.32
const RHO = 1.225
const G = 9.81
const EYE = 1.55
const DEMO_W = 170

const container = ref<HTMLDivElement>()
const hud = reactive({ power: 0, cadence: undefined as number | undefined, speed: 0, grade: 0, lap: 1, lapM: 0, lapTime: 0 })
const demoPower = ref(DEMO_W)
const trainerName = ref('')
const controllable = ref(false)
const connecting = ref(false)
const error = ref('')
const bluetooth = ref(false)
let trainer: Trainer | undefined
let dispose: (() => void) | undefined

const course = new Course()

// Mini map and elevation profile, in SVG units
const MAP = 120
const mapPath = (() => {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
  for (let s = 0; s < COURSE_M; s++) {
    minX = Math.min(minX, course.x[s]!)
    maxX = Math.max(maxX, course.x[s]!)
    minZ = Math.min(minZ, course.z[s]!)
    maxZ = Math.max(maxZ, course.z[s]!)
  }
  const k = (MAP - 12) / Math.max(maxX - minX, maxZ - minZ)
  const ox = (MAP - (maxX - minX) * k) / 2
  const oz = (MAP - (maxZ - minZ) * k) / 2
  const at = (s: number) => [ox + (course.at(course.x, s) - minX) * k, oz + (course.at(course.z, s) - minZ) * k] as const
  let d = ''
  for (let s = 0; s < COURSE_M; s += 10) d += `${s ? 'L' : 'M'}${at(s).map((v) => v.toFixed(1)).join(',')}`
  return { d: `${d}Z`, at }
})()
const PROFILE_W = 180
const PROFILE_H = 40
const profile = (() => {
  let lo = Infinity, hi = -Infinity
  for (let s = 0; s < COURSE_M; s++) {
    lo = Math.min(lo, course.y[s]!)
    hi = Math.max(hi, course.y[s]!)
  }
  const at = (s: number) => [(s / COURSE_M) * PROFILE_W, PROFILE_H - 4 - ((course.height(s) - lo) / (hi - lo)) * (PROFILE_H - 10)] as const
  let d = `M0,${PROFILE_H}`
  for (let s = 0; s <= COURSE_M; s += 10) d += `L${at(s).map((v) => v.toFixed(1)).join(',')}`
  return { d: `${d}L${PROFILE_W},${PROFILE_H}Z`, at, climb: hi - lo }
})()
const dot = computed(() => mapPath.at(hud.lapM))
const profileDot = computed(() => profile.at(hud.lapM))
const lapClock = computed(() => {
  const t = Math.floor(hud.lapTime)
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`
})

// Latest trainer reading, and when it came
let reading: TrainerData = {}
let readingAt = 0

async function connect() {
  if (trainer) {
    trainer.disconnect()
    return
  }
  error.value = ''
  connecting.value = true
  const t = new Trainer()
  t.onData = (d) => {
    reading = { ...reading, ...d }
    readingAt = performance.now()
  }
  t.onDisconnect = () => {
    trainer = undefined
    trainerName.value = ''
    controllable.value = false
    reading = {}
  }
  try {
    await t.connect()
    trainer = t
    trainerName.value = t.name
    controllable.value = t.controllable
  } catch (e) {
    // Closing the chooser isn't an error worth showing
    if ((e as Error).name !== 'NotFoundError') error.value = (e as Error).message
    t.disconnect()
  } finally {
    connecting.value = false
  }
}

const onKey = (ev: KeyboardEvent) => {
  if (trainer) return
  if (ev.key === 'ArrowUp') demoPower.value = Math.min(600, demoPower.value + 10)
  else if (ev.key === 'ArrowDown') demoPower.value = Math.max(0, demoPower.value - 10)
  else return
  ev.preventDefault()
}

// The bit of the bike you can see: bars with soft grips, and a tiny bear riding on the stem
function handlebars(plush: ReturnType<typeof buildWorld>['plush']) {
  const g = new Group()
  const bar = new Mesh(new CylinderGeometry(0.016, 0.016, 0.44, 12).rotateZ(Math.PI / 2), plush(PASTELS.cream, { bump: 0.2 }))
  g.add(bar)
  for (const sx of [-1, 1]) {
    // Drops: a half loop curling down and back at each end
    const drop = new Mesh(new TorusGeometry(0.07, 0.017, 10, 24, Math.PI), plush(PASTELS.pink, { bump: 0.3 }))
    drop.rotation.set(0, Math.PI / 2, -Math.PI / 2)
    drop.position.set(sx * 0.22, -0.07, 0)
    g.add(drop)
    const hood = new Mesh(new SphereGeometry(0.03, 16, 12), plush(PASTELS.lavender, { bump: 0.3 }))
    hood.scale.set(1, 1.3, 1.5)
    hood.position.set(sx * 0.22, 0.02, -0.03)
    g.add(hood)
  }
  const stem = new Mesh(new CylinderGeometry(0.02, 0.022, 0.13, 12).rotateX(Math.PI / 2), plush(PASTELS.cream, { bump: 0.2 }))
  stem.position.set(0, -0.01, 0.07)
  g.add(stem)
  const mascot = makeBear(plush, PASTELS.peach)
  mascot.scale.setScalar(0.022)
  mascot.position.set(0, 0.008, 0.06)
  g.add(mascot)
  g.traverse((o) => {
    o.castShadow = false
    o.receiveShadow = false
  })
  return g
}

onMounted(() => {
  bluetooth.value = hasWebBluetooth()
  const el = container.value!
  const renderer = new WebGLRenderer({ antialias: true })
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  renderer.toneMapping = NeutralToneMapping
  renderer.toneMappingExposure = 0.95
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = PCFShadowMap
  el.appendChild(renderer.domElement)

  const scene = new Scene()
  scene.fog = new Fog(FOG, 180, 1400)
  const camera = new PerspectiveCamera(68, 1, 0.05, 4000)
  scene.add(camera)

  const sunDir = new Vector3(-0.5, 0.75, 0.45).normalize()
  const world = buildWorld(course, sunDir, renderer.capabilities.getMaxAnisotropy())
  scene.add(world.root)
  scene.add(new HemisphereLight('#fff2f8', '#f0e4f4', 1.15))
  const sun = new DirectionalLight('#fff3e2', 2.3)
  sun.castShadow = true
  sun.shadow.mapSize.set(2048, 2048)
  Object.assign(sun.shadow.camera, { left: -60, right: 60, top: 60, bottom: -60, near: 1, far: 400 })
  sun.shadow.bias = -0.0004
  sun.shadow.normalBias = 0.06
  sun.shadow.radius = 4
  scene.add(sun, sun.target)

  const bars = handlebars(world.plush)
  bars.position.set(0, -0.32, -0.55)
  bars.rotation.x = 0.12
  camera.add(bars)

  const resize = () => {
    const { clientWidth: w, clientHeight: h } = el
    renderer.setSize(w, h)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
  }
  const observer = new ResizeObserver(resize)
  observer.observe(el)
  resize()

  // Drag to look round; it eases back to the road when let go
  const look = { yaw: 0, pitch: 0 }
  let dragging: { x: number; y: number } | undefined
  const canvas = renderer.domElement
  const down = (ev: PointerEvent) => {
    dragging = { x: ev.clientX, y: ev.clientY }
    canvas.setPointerCapture(ev.pointerId)
  }
  const move = (ev: PointerEvent) => {
    if (!dragging) return
    look.yaw = Math.max(-2.4, Math.min(2.4, look.yaw - (ev.clientX - dragging.x) * 0.005))
    look.pitch = Math.max(-0.8, Math.min(0.8, look.pitch - (ev.clientY - dragging.y) * 0.005))
    dragging = { x: ev.clientX, y: ev.clientY }
  }
  const up = () => (dragging = undefined)
  canvas.addEventListener('pointerdown', down)
  canvas.addEventListener('pointermove', move)
  canvas.addEventListener('pointerup', up)
  canvas.addEventListener('pointercancel', up)
  window.addEventListener('keydown', onKey)

  let s = 0
  let v = 0
  let lapStart = 0
  let elapsed = 0
  let crank = 0
  let roll = 0
  let hudAt = 0
  const eye = new Vector3()
  const ahead = new Vector3()
  const smoothAhead = new Vector3()
  let last = performance.now()
  let frame = 0

  const tick = (now: number) => {
    frame = requestAnimationFrame(tick)
    const dt = Math.min(0.1, (now - last) / 1000)
    last = now
    elapsed += dt

    const grade = course.at(course.grade, s)
    const theta = Math.atan(grade / 100)
    // A trainer that's gone quiet for a few seconds counts as not pedalling
    const live = trainer && now - readingAt < 3000
    const power = trainer ? (live ? Math.max(0, reading.power ?? 0) : 0) : demoPower.value
    const cadence = trainer ? (live ? reading.cadence : undefined) : demoPower.value > 0 ? 82 + Math.sin(elapsed * 0.3) * 4 : 0
    if (trainer && reading.power === undefined && reading.speed !== undefined) {
      // Speed-only trainer: ride at its wheel speed
      v += ((live ? reading.speed / 3.6 : 0) - v) * Math.min(1, dt * 2)
    } else {
      const drive = power / Math.max(v, 1.5)
      const resist = MASS * G * (CRR * Math.cos(theta) + Math.sin(theta)) + 0.5 * RHO * CDA * v * v
      v = Math.max(0, v + ((drive - resist) / MASS) * dt)
    }
    s += v * dt
    if (s >= COURSE_M) {
      s -= COURSE_M
      hud.lap++
      lapStart = elapsed
    }
    trainer?.setGrade(grade)

    // Ride on the left of the road, eyes on a point a little way ahead
    const keepLeft = 1.3
    const tx = course.at(course.tx, s)
    const tz = course.at(course.tz, s)
    crank += ((cadence ?? 0) / 60) * Math.PI * 2 * dt
    eye.set(course.at(course.x, s) + tz * keepLeft, course.height(s) + EYE + Math.sin(crank * 2) * 0.012, course.at(course.z, s) - tx * keepLeft)
    const sa = s + 14
    ahead.set(course.at(course.x, sa) + course.at(course.tz, sa) * keepLeft, course.height(sa) + EYE - 0.35, course.at(course.z, sa) - course.at(course.tx, sa) * keepLeft)
    if (smoothAhead.lengthSq() === 0) smoothAhead.copy(ahead)
    smoothAhead.lerp(ahead, Math.min(1, dt * 6))
    camera.position.copy(eye)
    camera.lookAt(smoothAhead)

    // Lean into the bends: turn rate × speed, softened
    const t2x = course.at(course.tx, s + 6)
    const t2z = course.at(course.tz, s + 6)
    const turn = (tx * t2z - tz * t2x) / 6
    roll += (Math.max(-0.25, Math.min(0.25, -turn * v * v * 0.08)) + Math.sin(crank) * 0.006 - roll) * Math.min(1, dt * 3)
    if (!dragging) {
      look.yaw *= 1 - Math.min(1, dt * 1.5)
      look.pitch *= 1 - Math.min(1, dt * 1.5)
    }
    camera.rotateY(look.yaw)
    camera.rotateX(look.pitch)
    camera.rotateZ(roll)

    // The shadow box follows the rider
    sun.target.position.set(eye.x + tx * 30, eye.y, eye.z + tz * 30)
    sun.position.copy(sun.target.position).addScaledVector(sunDir, 200)

    world.update(elapsed)
    renderer.render(scene, camera)

    if (now - hudAt > 100) {
      hudAt = now
      hud.power = Math.round(power)
      hud.cadence = cadence === undefined ? undefined : Math.round(cadence)
      hud.speed = v * 3.6
      hud.grade = grade
      hud.lapM = s
      hud.lapTime = elapsed - lapStart
    }
  }
  frame = requestAnimationFrame(tick)

  dispose = () => {
    cancelAnimationFrame(frame)
    observer.disconnect()
    window.removeEventListener('keydown', onKey)
    disposeTree(scene)
    world.textures.forEach((t) => t.dispose())
    renderer.dispose()
    canvas.remove()
  }
})

onBeforeUnmount(() => {
  trainer?.disconnect()
  trainer = undefined
  dispose?.()
  dispose = undefined
})
</script>

<template>
  <div class="map-canvas day08">
    <div ref="container" class="map-canvas" />

    <div class="controls">
      <button
        type="button"
        class="chip"
        :disabled="!bluetooth || connecting"
        :title="bluetooth ? 'Bluetooth smart trainer (FTMS) or power meter' : 'Needs Web Bluetooth (Chrome on Mac)'"
        @click="connect"
      >
        <template v-if="connecting">Connecting…</template>
        <template v-else-if="trainerName">✕ {{ trainerName }}</template>
        <template v-else>⚡ Connect trainer</template>
      </button>
      <div v-if="trainerName" class="note">{{ controllable ? 'Slope sent to the trainer' : 'Power only (no slope control)' }}</div>
      <div v-else-if="error" class="note error">{{ error }}</div>
      <div v-else class="note">Auto ride · ↑ ↓ power</div>
    </div>

    <div class="hud">
      <div class="stat power">
        <span class="value">{{ hud.power }}</span><span class="unit">W</span>
      </div>
      <div class="stat">
        <span class="value">{{ hud.speed.toFixed(1) }}</span><span class="unit">km/h</span>
      </div>
      <div class="stat">
        <span class="value">{{ hud.cadence ?? '–' }}</span><span class="unit">rpm</span>
      </div>
      <div class="stat grade" :class="{ up: hud.grade > 0.5, down: hud.grade < -0.5 }">
        <span class="value">{{ hud.grade > 0 ? '+' : '' }}{{ hud.grade.toFixed(1) }}</span><span class="unit">%</span>
      </div>
      <div class="stat">
        <span class="value">{{ (hud.lapM / 1000).toFixed(2) }}</span><span class="unit">/ {{ COURSE_M / 1000 }} km</span>
      </div>
      <div class="stat">
        <span class="value">{{ lapClock }}</span><span class="unit">lap {{ hud.lap }}</span>
      </div>
    </div>

    <div class="course">
      <svg :viewBox="`0 0 ${MAP} ${MAP}`" :width="MAP" :height="MAP">
        <path :d="mapPath.d" class="loop" />
        <circle :cx="mapPath.at(0)[0]" :cy="mapPath.at(0)[1]" r="3" class="start" />
        <circle :cx="dot[0]" :cy="dot[1]" r="4.5" class="you" />
      </svg>
      <svg :viewBox="`0 0 ${PROFILE_W} ${PROFILE_H}`" :width="PROFILE_W" :height="PROFILE_H">
        <path :d="profile.d" class="profile" />
        <line :x1="profileDot[0]" :x2="profileDot[0]" y1="0" :y2="PROFILE_H" class="cursor" />
        <circle :cx="profileDot[0]" :cy="profileDot[1]" r="3.5" class="you" />
      </svg>
    </div>
  </div>
</template>

<style scoped>
.day08 {
  position: relative;
  user-select: none;
}

.day08 :deep(canvas) {
  cursor: grab;
  touch-action: none;
}

.controls {
  position: absolute;
  top: 12px;
  right: 12px;
  z-index: 10;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
}

/* Matches the page's header panel */
.chip,
.hud,
.course {
  background: rgba(15, 20, 25, 0.82);
  backdrop-filter: blur(6px);
  border: 1px solid var(--border);
  border-radius: 10px;
}

.chip {
  padding: 8px 14px;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  color: var(--fg);
  cursor: pointer;
}

.chip:hover:not(:disabled) {
  color: #ffb3c8;
}

.chip:disabled {
  opacity: 0.55;
  cursor: default;
}

.note {
  padding: 2px 8px;
  font-size: 12px;
  color: #5b4a63;
  background: rgba(255, 255, 255, 0.7);
  border-radius: 6px;
}

.note.error {
  color: #b0304f;
}

.hud {
  position: absolute;
  left: 12px;
  bottom: 16px;
  z-index: 10;
  display: grid;
  grid-template-columns: repeat(3, auto);
  gap: 4px 18px;
  padding: 8px 16px;
  font-variant-numeric: tabular-nums;
}

.stat {
  display: flex;
  align-items: baseline;
  gap: 3px;
  white-space: nowrap;
}

.stat .value {
  font-size: 22px;
  font-weight: 700;
  color: var(--fg);
}

.stat .unit {
  font-size: 11px;
  color: var(--fg-muted);
}

.stat.power .value {
  color: #fff0a0;
}

.grade.up .value {
  color: #ffb3c8;
}

.grade.down .value {
  color: #aed8ff;
}

.course {
  position: absolute;
  right: 12px;
  bottom: 16px;
  z-index: 10;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 8px;
}

.loop {
  fill: none;
  stroke: #d5c3ff;
  stroke-width: 3;
  stroke-linejoin: round;
}

.start {
  fill: #fff0a0;
}

.you {
  fill: #ffb3c8;
  stroke: #fff;
  stroke-width: 1.5;
}

.profile {
  fill: rgba(182, 238, 205, 0.55);
  stroke: #b6eecd;
  stroke-width: 1.5;
}

.cursor {
  stroke: rgba(255, 255, 255, 0.35);
}

@media (max-width: 760px) {
  .hud {
    gap: 2px 10px;
    padding: 6px 10px;
  }

  .stat .value {
    font-size: 16px;
  }

  .course {
    display: none;
  }
}
</style>
