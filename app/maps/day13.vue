<script setup lang="ts">
// Day 13: Interactions — a coffee crawl round Shibuya, played on a Navara map. You walk the
// streets, and only the streets (Overture's road network round the station, as a graph:
// lib/streetWalk.ts), with the arrow keys or WASD, or by dragging on a touch screen. Every
// coffee shop Overture knows of here has a coffee mark; stand at its door on the street and
// push towards it to go in, for points. An arrow at your feet points the way to the nearest
// shop you haven't been in yet
import ThreeView, { Color, geodeticToVector3, type Layer } from '@navaramap/three'
import { DefaultPlugin, type DefaultDescriptions } from '@navaramap/three-default-plugin'
import { Vector3 } from 'three'
import { CoffeeWalkMeshDesc, type CoffeeWalkConfig } from './lib/CoffeeWalkMeshDesc'
import { coffeeMarks } from './lib/coffeeMarks'
import {
  DOOR_REACH,
  buildGraph,
  doorPushed,
  doorsOf,
  positionOf,
  startAt,
  walk,
  type Door,
  type StreetData,
  type Vec,
} from './lib/streetWalk'

const dataBase = `${useRuntimeConfig().app.baseURL}data/day13`

// Latte: foam for the ground, milk for the streets, the buildings roasted darker the taller
const SKY = '#f4ece1'
const GROUND = '#e6d8c4'
const STREET = '#fffcf6'
const CASING = '#cdb59a'
const PATH = '#f6ead9'
const STEPS = '#a88466'
const RAIL = '#8d7766'
const BUILDING_LOW = '#e2cfb6'
const BUILDING_HIGH = '#8a6248'

// Street widths (px, at the starting zoom), by Overture class or subclass
const WIDTHS: Record<string, number> = {
  trunk: 26,
  primary: 24,
  secondary: 22,
  tertiary: 18,
  link: 16,
  residential: 13,
  unclassified: 13,
  living_street: 13,
  pedestrian: 13,
  service: 9,
  alley: 8,
  driveway: 7,
  parking_aisle: 7,
  crosswalk: 13,
}
const PATH_CLASSES = new Set(['footway', 'sidewalk', 'crosswalk', 'steps', 'path', 'cycleway', 'bridleway'])
const PATH_WIDTH = 6

// You start in the middle of the scramble crossing: the busiest junction near here
const START = { lng: 139.70045, lat: 35.65948 }
// Walking pace (m/s): quick, for a game; Shift to hurry
const WALK = 16
const HURRY = 32
// The camera follows from behind and above: heading turns with Q / E or a mouse drag, the
// distance with the wheel
const CAMERA = { heading: 0, pitch: -52, distance: 170 }
const DISTANCE: [number, number] = [50, 480]
const PITCH: [number, number] = [-88, -22]
const TURN_DEG_S = 90

// Going in: push at a door this long (s), then the walker steps in, stays a while and comes
// out with a coffee
const PUSH_S = 0.18
const STEP_IN_S = 0.35
const STAY_S = 0.55
const STEP_OUT_S = 0.35
const POINTS = 100
// Doors are hinted at from this far (m)
const HINT_M = 28
// Buildings in the way are cut down to this (m) over CUT_DOWN_S s, clearing the line of sight
// by CUT_CLEAR_M m each way. One cut down stays down while it's anywhere near the way (CUT_KEEP
// times the clearance), and for CUT_HOLD_S s after, then rises again over CUT_UP_S s: so a
// building at the edge of the view doesn't bob up and down as you walk. They're looked at
// again at most every CUT_EVERY_S s
const PLINTH_M = 4
const CUT_DOWN_S = 0.3
const CUT_UP_S = 0.8
const CUT_CLEAR_M = 8
const CUT_KEEP = 4
const CUT_HOLD_S = 3
const CUT_EVERY_S = 1 / 15

const container = ref<HTMLDivElement>()
const popups = ref<HTMLDivElement>()
const visitedCount = ref(0)
const shopCount = ref(0)
const score = ref(0)
const touch = ref(false)
const played = ref(false)
// The stick on a touch screen, where the finger landed and how far it has moved (px)
const stickUi = reactive({ on: false, x: 0, y: 0, dx: 0, dy: 0 })
const STICK_PX = 50
let view: ThreeView<DefaultDescriptions> | undefined
let teardown: (() => void) | undefined

// A soft two-note chime on going in; browsers allow sound only after a key press or a tap
let audio: AudioContext | undefined
function chime() {
  audio ??= new AudioContext()
  const t = audio.currentTime
  ;[784, 1175].forEach((hz, i) => {
    const osc = audio!.createOscillator()
    const gain = audio!.createGain()
    osc.type = 'sine'
    osc.frequency.value = hz
    gain.gain.setValueAtTime(0, t + i * 0.09)
    gain.gain.linearRampToValueAtTime(0.12, t + i * 0.09 + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.001, t + i * 0.09 + 0.6)
    osc.connect(gain).connect(audio!.destination)
    osc.start(t + i * 0.09)
    osc.stop(t + i * 0.09 + 0.65)
  })
}

const mix = (a: string, b: string, t: number) => {
  const [x, y] = [a, b].map((hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)))
  return new Color().setStyle(`rgb(${x!.map((c, i) => Math.round(c + (y![i]! - c) * t)).join(',')})`)
}
const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x))
const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x))

onMounted(async () => {
  touch.value = matchMedia('(pointer: coarse)').matches
  const v = new ThreeView<DefaultDescriptions>({
    container: container.value!,
    backgroundColor: new Color().setStyle(SKY),
    animation: true,
  })
  view = v
  v.addPlugin(new DefaultPlugin())
  const [streets, buildings, coffee] = await Promise.all([
    fetch(`${dataBase}/streets.json`).then((r) => r.json() as Promise<StreetData>),
    fetch(`${dataBase}/buildings.geojson`).then((r) => r.json() as Promise<GeoJSON.FeatureCollection>),
    fetch(`${dataBase}/coffee.json`).then((r) => r.json() as Promise<{ shops: { name: string; at: [number, number] }[] }>),
    v.init(),
  ])
  if (view !== v) return // unmounted while initializing
  v.registerMesh('coffeeWalk', CoffeeWalkMeshDesc)

  const g = buildGraph(streets)
  const shops = coffee.shops.map((s) => ({ name: s.name, at: g.toLocal(s.at[0], s.at[1]) }))
  const doors = doorsOf(
    g,
    shops.map((s) => s.at),
  )
  shopCount.value = shops.length
  const visited = new Set<number>()

  // The camera is driven from here: the view's own controls are off
  v.camera.options = { enableSpin: false, enableTilt: false, enableZoom: false }
  const cam = { ...CAMERA }

  // A morning sun, from the south-east, and plenty of fill
  v.atmosphere.date = new Date('2026-11-13T00:30:00Z')
  v.addLight({ ambient: { intensity: 1.1 } })
  v.addLight({ sun: { intensity: 1.6 } })

  v.addLayer({ type: 'terrain', ellipsoid: {} })
  v.globe.color = new Color().setStyle(GROUND)

  // Streets: the footpaths under the roads, the roads cased
  const lines = (keep: (cls: string) => boolean): GeoJSON.FeatureCollection => ({
    type: 'FeatureCollection',
    features: streets.edges
      .filter((e) => keep(e.class))
      .map((e) => ({ type: 'Feature', properties: { class: e.class }, geometry: { type: 'LineString', coordinates: e.line } })),
  })
  const paths = v.addSource({ type: 'geojson', data: lines((c) => PATH_CLASSES.has(c)) })
  const roads = v.addSource({ type: 'geojson', data: lines((c) => !PATH_CLASSES.has(c)) })
  const rails = v.addSource({
    type: 'geojson',
    data: {
      type: 'FeatureCollection',
      features: streets.rails.map((line) => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: line } })),
    },
  })
  // Widths are on screen: they follow the camera's distance, re-evaluated when it settles
  let widthScale = 1
  const streetLayers: Layer[] = []
  const styleStreets = (layer: Layer, width: (cls: string) => number, color: (cls: string) => Color, dash: (cls: string) => number[]) => {
    layer.on('featureUpdated', ({ evaluator }) => {
      evaluator.evaluate(
        ({ properties }) => {
          const cls = String(properties?.['class'] ?? '')
          return { width: width(cls) * widthScale, color: color(cls), dashArray: dash(cls) }
        },
        { filters: ['class'] },
      )
    })
    streetLayers.push(layer)
  }
  const pathColor = new Color().setStyle(PATH)
  const stepsColor = new Color().setStyle(STEPS)
  const streetColor = new Color().setStyle(STREET)
  const casingColor = new Color().setStyle(CASING)
  styleStreets(
    v.addLayer({ type: 'vector', source: paths, polyline: { color: pathColor, width: PATH_WIDTH, clampToGround: true } }),
    (cls) => (cls === 'crosswalk' ? WIDTHS.crosswalk! : PATH_WIDTH),
    (cls) => (cls === 'steps' ? stepsColor : cls === 'crosswalk' ? streetColor : pathColor),
    (cls) => (cls === 'steps' ? [0.5, 0.5] : cls === 'crosswalk' ? [0.35, 0.35] : []),
  )
  styleStreets(
    v.addLayer({ type: 'vector', source: roads, polyline: { color: casingColor, width: 8, clampToGround: true } }),
    (cls) => (WIDTHS[cls] ?? 9) + 4,
    () => casingColor,
    () => [],
  )
  styleStreets(
    v.addLayer({ type: 'vector', source: roads, polyline: { color: streetColor, width: 6, clampToGround: true } }),
    (cls) => WIDTHS[cls] ?? 9,
    () => streetColor,
    () => [],
  )
  v.addLayer({
    type: 'vector',
    source: rails,
    polyline: { color: new Color().setStyle(RAIL), width: 3, dashArray: [2, 1.5], clampToGround: true },
  })

  // Buildings, roasted darker the taller. Those that stand between the camera and you are cut
  // down to their ground floor, so Shibuya's towers don't hide the street
  const blocks = buildings.features.map((f, i) => {
    const h = Number((f.properties as { h?: number } | null)?.h ?? 9)
    f.properties = { i }
    const ring = (f.geometry as GeoJSON.MultiPolygon).coordinates.flatMap((poly) => poly[0] ?? [])
    const pts = ring.map(([lng, lat]) => g.toLocal(lng!, lat!))
    const c = { x: pts.reduce((a, p) => a + p.x, 0) / pts.length, y: pts.reduce((a, p) => a + p.y, 0) / pts.length }
    return { c, r: Math.max(...pts.map((p) => Math.hypot(p.x - c.x, p.y - c.y))), h }
  })
  const heights = blocks.map((b) => b.h)
  const shades = heights.map((h) => mix(BUILDING_LOW, BUILDING_HIGH, smooth(Math.log2(h / 6) / 5)))
  // 0: standing, 1: cut down; eased towards what's in the way
  const cut = new Float32Array(blocks.length)
  // When each was last in the way (s)
  const inWayAt = new Float64Array(blocks.length).fill(-Infinity)
  const buildingLayer = v.addLayer({
    type: 'vector',
    source: v.addSource({ type: 'geojson', data: buildings }),
    polygon: { color: new Color().setStyle(BUILDING_LOW), clampToGround: false },
  })
  buildingLayer.on('featureUpdated', ({ evaluator }) => {
    evaluator.evaluate(
      ({ properties }) => {
        const i = Number(properties?.['i'])
        const h = heights[i] ?? 9
        return { height: 0, extrudedHeight: lerp(h, Math.min(h, PLINTH_M), cut[i] ?? 0), color: shades[i] }
      },
      { filters: ['i'] },
    )
  })
  // Whether each building is in the way of the camera's view of `p`: within the corridor from
  // `p` back to the camera, and taller than the line of sight over it
  const inTheWay = (p: Vec, i: number, clear: number) => {
    const b = blocks[i]!
    const h = (cam.heading * Math.PI) / 180
    const back = { x: -Math.sin(h), y: -Math.cos(h) }
    const pitch = (-cam.pitch * Math.PI) / 180
    const [far, high] = [cam.distance * Math.cos(pitch), cam.distance * Math.sin(pitch)]
    const v = { x: b.c.x - p.x, y: b.c.y - p.y }
    const along = v.x * back.x + v.y * back.y
    const across = Math.abs(v.x * back.y - v.y * back.x)
    if (along < -b.r * 0.5 || along > far + b.r || across > b.r + clear) return false
    return b.h > ((along - b.r) / far) * high - clear
  }

  // The coffee marks, over everything
  const marks = coffeeMarks()
  const shopSource = v.addSource({
    type: 'geojson',
    data: {
      type: 'FeatureCollection',
      features: shops.map((s, i) => ({ type: 'Feature', properties: { i }, geometry: { type: 'Point', coordinates: coffee.shops[i]!.at } })),
    },
  })
  const shopLayer = v.addLayer({
    type: 'vector',
    source: shopSource,
    billboard: {
      url: marks.fresh,
      size: 36,
      sizeInMeters: false,
      anchor: 'bottom',
      clampToGround: false,
      depthTest: false,
      declutter: false,
    },
  })
  shopLayer.on('featureUpdated', ({ evaluator }) => {
    evaluator.evaluate(({ properties }) => ({ image: visited.has(Number(properties?.['i'])) ? marks.visited : marks.fresh }), {
      filters: ['i'],
    })
  })

  const walkConfig: CoffeeWalkConfig = { coffeeWalk: {}, geodetic: { ...g.origin, height: 0 } }
  const walkMesh = v.addMesh<CoffeeWalkMeshDesc>(walkConfig).ref

  v.attribution?.add([
    {
      attributionHtml:
        '© <a href="https://overturemaps.org/">Overture Maps Foundation</a> · © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    },
  ])

  // Input: keys, or on a touch screen a stick wherever the finger lands; a mouse drag turns
  // and tilts the camera, the wheel zooms
  const keys = new Set<string>()
  const KEYS: Record<string, [number, number]> = {
    ArrowUp: [0, 1],
    KeyW: [0, 1],
    ArrowDown: [0, -1],
    KeyS: [0, -1],
    ArrowLeft: [-1, 0],
    KeyA: [-1, 0],
    ArrowRight: [1, 0],
    KeyD: [1, 0],
  }
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    if (KEYS[e.code] || ['KeyQ', 'KeyE', 'ShiftLeft', 'ShiftRight'].includes(e.code)) {
      keys.add(e.code)
      e.preventDefault()
    }
  }
  const onKeyUp = (e: KeyboardEvent) => keys.delete(e.code)
  const onBlur = () => keys.clear()
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  window.addEventListener('blur', onBlur)

  let stick: { id: number; x: number; y: number; dx: number; dy: number } | undefined
  let drag: { id: number; x: number; y: number } | undefined
  const el = container.value!
  const onPointerDown = (e: PointerEvent) => {
    if (e.pointerType === 'mouse') {
      if (e.button === 0 || e.button === 2) drag = { id: e.pointerId, x: e.clientX, y: e.clientY }
    } else if (!stick) {
      stick = { id: e.pointerId, x: e.clientX, y: e.clientY, dx: 0, dy: 0 }
      const box = el.getBoundingClientRect()
      Object.assign(stickUi, { on: true, x: e.clientX - box.left, y: e.clientY - box.top, dx: 0, dy: 0 })
    }
    el.setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: PointerEvent) => {
    if (drag?.id === e.pointerId) {
      cam.heading = (cam.heading - (e.clientX - drag.x) * 0.3 + 360) % 360
      cam.pitch = clamp(cam.pitch - (e.clientY - drag.y) * 0.2, ...PITCH)
      drag.x = e.clientX
      drag.y = e.clientY
    } else if (stick?.id === e.pointerId) {
      stick.dx = e.clientX - stick.x
      stick.dy = e.clientY - stick.y
      const l = Math.max(1, Math.hypot(stick.dx, stick.dy) / STICK_PX)
      Object.assign(stickUi, { dx: stick.dx / l, dy: stick.dy / l })
    }
  }
  const onPointerUp = (e: PointerEvent) => {
    if (drag?.id === e.pointerId) drag = undefined
    if (stick?.id === e.pointerId) {
      stick = undefined
      stickUi.on = false
    }
  }
  let settle = 0
  const onWheel = (e: WheelEvent) => {
    e.preventDefault()
    cam.distance = clamp(cam.distance * Math.exp(e.deltaY * 0.0015), ...DISTANCE)
    settle = performance.now() + 250
  }
  const noMenu = (e: Event) => e.preventDefault()
  el.addEventListener('pointerdown', onPointerDown)
  el.addEventListener('pointermove', onPointerMove)
  el.addEventListener('pointerup', onPointerUp)
  el.addEventListener('pointercancel', onPointerUp)
  el.addEventListener('wheel', onWheel, { passive: false })
  el.addEventListener('contextmenu', noMenu)
  teardown = () => {
    window.removeEventListener('keydown', onKeyDown)
    window.removeEventListener('keyup', onKeyUp)
    window.removeEventListener('blur', onBlur)
  }

  // The way the input points, on the map: up the screen is the way the camera looks
  const inputDir = (): Vec | null => {
    let [rx, fy] = [0, 0]
    for (const k of keys) {
      const d = KEYS[k]
      if (d) [rx, fy] = [rx + d[0], fy + d[1]]
    }
    if (stick && Math.hypot(stick.dx, stick.dy) > 14) [rx, fy] = [stick.dx, -stick.dy]
    const l = Math.hypot(rx, fy)
    if (l < 1e-6) return null
    const h = (cam.heading * Math.PI) / 180
    const [fx, fn] = [Math.sin(h), Math.cos(h)]
    return { x: (fy * fx + rx * Math.cos(h)) / l, y: (fy * fn - rx * Math.sin(h)) / l }
  }

  const walker = startAt(g, g.toLocal(START.lng, START.lat))
  let focus = positionOf(g, walker)
  let stride = 0
  let swing = 0
  let push = 0
  // Going in: the door, and how long since it began
  let entering: { door: Door; t: number; from: Vec } | undefined

  const popupAt: { el: HTMLDivElement; at: Vec; t: number }[] = []
  const goIn = (door: Door, now: number) => {
    visited.add(door.shop)
    visitedCount.value = visited.size
    score.value += POINTS
    played.value = true
    shopLayer.forceUpdate()
    walkMesh.burst(door.point, cam.distance / 60, now)
    walkMesh.carrying = true
    chime()
    const p = document.createElement('div')
    p.innerHTML = `<b>+${POINTS}</b><span></span>`
    p.querySelector('span')!.textContent = shops[door.shop]!.name
    popups.value?.append(p)
    popupAt.push({ el: p, at: door.point, t: now })
  }

  let last = performance.now() / 1000
  let cutAt = 0
  v.on('preUpdate', () => {
    const now = performance.now() / 1000
    const dt = Math.min(0.1, now - last)
    last = now
    if (keys.has('KeyQ')) cam.heading = (cam.heading + TURN_DEG_S * dt) % 360
    if (keys.has('KeyE')) cam.heading = (cam.heading - TURN_DEG_S * dt + 360) % 360

    const input = inputDir()
    let p = positionOf(g, walker)
    let facing = walker.facing
    let inside = 0
    let moved = 0
    if (entering) {
      // In along the way in, a while inside, and back out onto the street
      const e = entering
      e.t += dt
      const into = e.door.into ?? facing
      const doorstep = { x: e.door.point.x + into.x * 3, y: e.door.point.y + into.y * 3 }
      if (e.t < STEP_IN_S) {
        const k = smooth(e.t / STEP_IN_S)
        p = { x: lerp(e.from.x, doorstep.x, k), y: lerp(e.from.y, doorstep.y, k) }
        inside = k
        facing = into
        moved = 3 * dt
      } else if (e.t < STEP_IN_S + STAY_S) {
        p = doorstep
        inside = 1
      } else {
        const k = smooth((e.t - STEP_IN_S - STAY_S) / STEP_OUT_S)
        p = { x: lerp(doorstep.x, e.door.point.x, k), y: lerp(doorstep.y, e.door.point.y, k) }
        inside = 1 - k
        facing = { x: -into.x, y: -into.y }
        moved = 3 * dt
        if (k >= 1) {
          entering = undefined
          walker.facing = facing
        }
      }
      if (e.t >= STEP_IN_S && e.t - dt < STEP_IN_S) goIn(e.door, now)
    } else {
      const door = doorPushed(
        g,
        walker,
        input,
        doors.filter((d) => !visited.has(d.shop)),
      )
      if (door) {
        // Pushing at a door: a moment, and in you go
        push += dt
        walker.moving = 0
        if (door.into) walker.facing = door.into
        if (push >= PUSH_S) {
          push = 0
          entering = { door, t: 0, from: p }
          walker.edge = door.edge
          walker.s = door.s
        }
      } else {
        push = 0
        const before = p
        walk(g, walker, input, (keys.has('ShiftLeft') || keys.has('ShiftRight') ? HURRY : WALK) * dt)
        p = positionOf(g, walker)
        moved = Math.hypot(p.x - before.x, p.y - before.y)
      }
      facing = walker.facing
    }

    // The walker, big enough to be seen from the camera
    const scale = Math.min(cam.distance / 22, 12)
    stride += (moved / (0.75 * scale)) * Math.PI
    swing = lerp(swing, moved > 0 ? 1 : 0, 1 - Math.exp(-dt * 12))
    walkMesh.setWalker(p, facing, scale, stride, swing, inside)

    // The door hints, and the arrow to the nearest shop not yet been in when none is in reach
    const near: { point: Vec; into: Vec | null; near: number; d: number }[] = []
    let nearest: { d: number; at: Vec } | undefined
    for (const d of doors) {
      if (visited.has(d.shop)) continue
      const dist = Math.hypot(d.point.x - p.x, d.point.y - p.y)
      if (dist < HINT_M) near.push({ point: d.point, into: d.into, near: 1 - clamp((dist - DOOR_REACH) / (HINT_M - DOOR_REACH), 0, 1), d: dist })
      if (!nearest || dist < nearest.d) nearest = { d: dist, at: d.point }
    }
    near.sort((a, b) => a.d - b.d)
    const hintScale = cam.distance / 30
    walkMesh.setHints(entering ? [] : near, hintScale, now)
    const guide = nearest && nearest.d > HINT_M && !entering ? { x: (nearest.at.x - p.x) / nearest.d, y: (nearest.at.y - p.y) / nearest.d } : null
    walkMesh.setGuide(p, guide, hintScale, now)
    walkMesh.tick(now)

    // The camera eases after the walker
    const k = 1 - Math.exp(-dt * 6)
    focus = { x: lerp(focus.x, p.x, k), y: lerp(focus.y, p.y, k) }
    v.setCamera({ ...g.toLngLat(focus), height: 0, distance: cam.distance, heading: cam.heading, pitch: cam.pitch, roll: 0 })

    // Buildings in the way sink, the rest rise again
    if (now - cutAt >= CUT_EVERY_S) {
      const elapsed = now - cutAt
      cutAt = now
      let changed = false
      for (let i = 0; i < blocks.length; i++) {
        if (inTheWay(focus, i, cut[i]! > 0 ? CUT_CLEAR_M * CUT_KEEP : CUT_CLEAR_M)) inWayAt[i] = now
        const down = now - inWayAt[i]! < CUT_HOLD_S
        const next = down ? Math.min(1, cut[i]! + elapsed / CUT_DOWN_S) : Math.max(0, cut[i]! - elapsed / CUT_UP_S)
        if (next !== cut[i]) {
          cut[i] = next
          changed = true
        }
      }
      if (changed) buildingLayer.forceUpdate()
    }

    // Streets re-widened once a zoom settles
    const scaleNow = CAMERA.distance / cam.distance
    if (settle && performance.now() > settle && Math.abs(scaleNow / widthScale - 1) > 0.05) {
      settle = 0
      widthScale = clamp(scaleNow, 0.35, 2.5)
      for (const layer of streetLayers) layer.forceUpdate()
    }
  })

  // The points rise and fade over where they were won
  const at = new Vector3()
  v.on('preRender', () => {
    const box = popups.value
    if (!box) return
    const now = performance.now() / 1000
    const [w, h] = [box.clientWidth, box.clientHeight]
    for (let i = popupAt.length - 1; i >= 0; i--) {
      const p = popupAt[i]!
      const t = (now - p.t) / 1.6
      if (t >= 1) {
        p.el.remove()
        popupAt.splice(i, 1)
        continue
      }
      at.copy(geodeticToVector3({ ...g.toLngLat(p.at), height: 0 })).project(v.camera.raw)
      const x = ((at.x + 1) / 2) * w
      const y = ((1 - at.y) / 2) * h - 60 - 50 * smooth(t)
      p.el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%) scale(${0.8 + 0.4 * smooth(t * 4)})`
      p.el.style.opacity = String(t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3)
    }
  })
})

onBeforeUnmount(() => {
  teardown?.()
  view?.dispose()
  view = undefined
  void audio?.close()
  audio = undefined
})
</script>

<template>
  <div class="map-canvas day13">
    <div ref="container" class="map-canvas" />
    <div ref="popups" class="popups" />
    <div v-if="stickUi.on" class="stick" :style="{ left: `${stickUi.x}px`, top: `${stickUi.y}px` }">
      <div class="knob" :style="{ transform: `translate(${stickUi.dx}px, ${stickUi.dy}px)` }" />
    </div>
    <div class="hud">
      <div class="count">☕ {{ visitedCount }} <small>/ {{ shopCount }}</small></div>
      <div class="score">{{ score.toLocaleString() }} pt</div>
    </div>
    <div class="keys" :class="{ played }">
      <template v-if="touch">Drag to walk · push towards ☕ to drop in</template>
      <template v-else>
        <kbd>←</kbd><kbd>↑</kbd><kbd>↓</kbd><kbd>→</kbd> / <kbd>WASD</kbd> walk · push towards ☕ to drop in ·
        <kbd>Shift</kbd> hurry · <kbd>Q</kbd><kbd>E</kbd> / drag turn · wheel zoom
      </template>
    </div>
  </div>
</template>

<style scoped>
.day13 {
  position: relative;
  overflow: hidden;
  touch-action: none;
  user-select: none;
}

/* Matches the page's header panel */
.hud {
  position: absolute;
  top: 12px;
  right: 12px;
  z-index: 10;
  padding: 8px 14px;
  text-align: right;
  color: var(--fg);
  background: rgba(15, 20, 25, 0.82);
  backdrop-filter: blur(6px);
  border: 1px solid var(--border);
  border-radius: 10px;
  font-variant-numeric: tabular-nums;
}

.hud .count {
  font-size: 20px;
  font-weight: 700;
}

.hud .count small {
  font-size: 13px;
  font-weight: 400;
  color: var(--fg-muted);
}

.hud .score {
  font-size: 13px;
  color: var(--accent);
}

.keys {
  position: absolute;
  left: 50%;
  bottom: 28px;
  z-index: 10;
  transform: translateX(-50%);
  max-width: calc(100vw - 24px);
  padding: 6px 12px;
  font-size: 12px;
  color: var(--fg);
  text-align: center;
  background: rgba(15, 20, 25, 0.72);
  border-radius: 8px;
  pointer-events: none;
  transition: opacity 1.5s 2s;
}

/* Out of the way once you've got the hang of it */
.keys.played {
  opacity: 0;
}

.keys kbd {
  display: inline-block;
  min-width: 1.5em;
  margin: 0 1px;
  padding: 0 4px;
  font: inherit;
  font-size: 11px;
  border: 1px solid rgba(255, 255, 255, 0.35);
  border-radius: 4px;
}

.stick {
  position: absolute;
  z-index: 6;
  width: 100px;
  height: 100px;
  margin: -50px 0 0 -50px;
  border: 2px solid rgba(74, 44, 26, 0.45);
  border-radius: 50%;
  background: rgba(255, 250, 242, 0.35);
  pointer-events: none;
}

.stick .knob {
  position: absolute;
  left: 30px;
  top: 30px;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: rgba(210, 84, 58, 0.85);
}

.popups {
  position: absolute;
  inset: 0;
  z-index: 5;
  overflow: hidden;
  pointer-events: none;
}

/* Added from the script: scoped styles don't reach them */
.popups :deep(div) {
  position: absolute;
  top: 0;
  left: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  white-space: nowrap;
  color: #4a2c1a;
  text-shadow: 0 0 4px #fff, 0 0 2px #fff;
}

.popups :deep(b) {
  font-size: 26px;
  font-weight: 800;
  color: #d2543a;
}

.popups :deep(span) {
  font-size: 13px;
  font-weight: 600;
}

/* On a phone the header panel takes the top: the score goes to the bottom, the keys above it */
@media (max-width: 600px) {
  .hud {
    top: auto;
    right: auto;
    bottom: 12px;
    left: 12px;
  }

  .keys {
    bottom: 84px;
  }
}
</style>
