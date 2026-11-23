<script setup lang="ts">
// Day 23: Senses: Taste, in plain Three.js (the hidden page /day/23-three) — autumn's flavours heaped on a wooden jigsaw of Japan: each prefecture's
// 2025 crop of apples, persimmons, pears, grapes, chestnuts and sweet potatoes, one piece of fruit
// per so many tonnes shipped, dropped onto its piece of the puzzle.
// Plain Three.js. Data: scripts/day23/build_data.py
import {
  ACESFilmicToneMapping,
  BufferGeometry,
  CanvasTexture,
  Color,
  DirectionalLight,
  DynamicDrawUsage,
  ExtrudeGeometry,
  Fog,
  HemisphereLight,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  PCFShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  PMREMGenerator,
  Quaternion,
  Raycaster,
  RepeatWrapping,
  Scene,
  Shape,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { FRUIT_KEYS, makeFruits, type Fruit, type FruitKey } from './lib/harvestFruits'
import { buildHeaps, landOf, type Placement, type Ring } from './lib/harvestHeaps'

type Item = { measure: 'shipped' | 'harvested'; national: number; values: (number | null)[]; source: string }
type Pref = { code: number; name: string; polygons: Ring[][]; heap: [number, number] }
type Data = { prefs: Pref[]; items: Record<FruitKey, Item> }
type Mode = 'all' | FruitKey

const dataBase = `${useRuntimeConfig().app.baseURL}data/day23`

const NAMES: Record<FruitKey, [string, string]> = {
  ringo: ['Apple', 'Apples'],
  kaki: ['Persimmon', 'Persimmons'],
  nashi: ['Japanese pear', 'Japanese pears'],
  budou: ['Grapes', 'Grapes'],
  kuri: ['Chestnut', 'Chestnuts'],
  kansho: ['Sweet potato', 'Sweet potatoes'],
}
// Tonnes per piece: one scale for all of them together, and one per kind on its own, set by eye
// so no kind looks scarce or swamped next to the others (persimmons, pears and bunches of grapes,
// big and round, read as more than their count: about half as many as the rest)
const UNIT_ALL = 500
const UNIT: Record<FruitKey, number> = { ringo: 400, kaki: 200, nashi: 200, budou: 200, kuri: 10, kansho: 500 }
const MODES: Mode[] = ['all', ...FRUIT_KEYS]

// km per model unit: a piece is ~16 km across
const SIZE = 8
const BOARD = 7 // the puzzle's thickness, km
const TABLE = '#2a1b12'
// The run of the heaps: how far a piece falls (km) and for how long (s)
const FALL = 260
const FALL_S = 0.55
const LEAVE_S = 0.5
// Plan y (km) of 30.5°N, below which the camera doesn't try to fit the islands in
const SOUTH = -610
// Cycling through the kinds until someone picks one (s per kind)
const CYCLE_S = 9

// Region tints of the puzzle pieces (light woods), by prefecture code
const REGION_TINT: [number, string][] = [
  [1, '#e3c79a'], // Hokkaido
  [7, '#dcb98a'], // Tohoku
  [14, '#e6cfa4'], // Kanto
  [23, '#d8b583'], // Chubu
  [30, '#e2c496'], // Kinki
  [35, '#d5b07e'], // Chugoku
  [39, '#e4c99c'], // Shikoku
  [47, '#dab886'], // Kyushu, Okinawa
]
const tintOf = (code: number) => REGION_TINT.find(([last]) => code <= last)![1]

// ?flavour=all|ringo|kaki|... picks one to show and holds it there
const picked = useRoute().query.flavour as Mode | undefined
const container = ref<HTMLDivElement>()
const mode = ref<Mode>(picked && MODES.includes(picked) ? picked : 'all')
const cycling = ref(mode.value === 'all' && !picked)
// On a phone the controls fold away behind one button
const controlsOpen = ref(true)
const loading = ref(true)
const hover = ref<{ x: number; y: number; pref: number } | undefined>()
const data = shallowRef<Data>()
let setMode: ((m: Mode, byHand?: boolean) => void) | undefined
let dispose: (() => void) | undefined

const fmt = (n: number) => n.toLocaleString('en-US')
const unitLabel = computed(() => {
  if (mode.value === 'all') return `Each piece = ${fmt(UNIT_ALL)} t`
  const k = mode.value
  const piece = k === 'budou' ? 'bunch of grapes' : NAMES[k][0].toLowerCase()
  return `Each ${piece} = ${fmt(UNIT[k])} t ${data.value?.items[k].measure ?? 'shipped'}`
})
const hoverRows = computed(() => {
  const d = data.value
  if (!d || !hover.value) return []
  const keys = mode.value === 'all' ? FRUIT_KEYS : [mode.value]
  return keys
    .map((k) => ({ k, name: NAMES[k][1], v: d.items[k].values[hover.value!.pref] }))
    .filter((r) => r.v != null && (r.v > 0 || mode.value !== 'all'))
})

/** Pieces of each kind on each prefecture, in mode `m` */
function countsFor(d: Data, m: Mode) {
  return d.prefs.map((_, i) => {
    const c: Partial<Record<FruitKey, number>> = {}
    for (const k of m === 'all' ? FRUIT_KEYS : [m]) c[k] = Math.round((d.items[k].values[i] ?? 0) / (m === 'all' ? UNIT_ALL : UNIT[k]))
    return c
  })
}

/** Light wood grain, to tile over the puzzle's top (one tile = 220 km) */
function woodTexture() {
  const c = document.createElement('canvas')
  c.width = c.height = 512
  const g = c.getContext('2d')!
  g.fillStyle = '#ffffff'
  g.fillRect(0, 0, 512, 512)
  for (let i = 0; i < 90; i++) {
    const y0 = Math.random() * 512
    g.strokeStyle = `rgba(120, 80, 40, ${0.04 + Math.random() * 0.08})`
    g.lineWidth = 0.6 + Math.random() * 2.2
    g.beginPath()
    for (let x = -10; x <= 522; x += 8) {
      const y = y0 + 6 * Math.sin(x / 70 + i) + 3 * Math.sin(x / 23 + i * 2)
      if (x < 0) g.moveTo(x, y)
      else g.lineTo(x, y)
    }
    // Wrap vertically, so the tile repeats without a seam
    g.stroke()
    g.save()
    g.translate(0, y0 > 256 ? -512 : 512)
    g.stroke()
    g.restore()
  }
  const t = new CanvasTexture(c)
  t.colorSpace = SRGBColorSpace
  t.wrapS = t.wrapT = RepeatWrapping
  t.repeat.set(1 / 220, 1 / 220)
  t.anisotropy = 8
  return t
}

onMounted(async () => {
  const el = container.value!
  const renderer = new WebGLRenderer({ antialias: true })
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  renderer.setClearColor(new Color(TABLE))
  renderer.toneMapping = ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.05
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = PCFShadowMap
  el.appendChild(renderer.domElement)

  const scene = new Scene()
  scene.fog = new Fog(TABLE, 3500, 7000)
  const pmrem = new PMREMGenerator(renderer)
  const envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
  scene.environment = envMap
  scene.environmentIntensity = 0.45

  const camera = new PerspectiveCamera(30, 1, 10, 20000)
  const controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.maxPolarAngle = 1.25
  controls.minDistance = 120
  controls.maxDistance = 6000
  controls.screenSpacePanning = false
  controls.zoomToCursor = true

  // Autumn afternoon sun from the south-west, low enough for long shadows off the heaps
  scene.add(new HemisphereLight('#fff1dc', '#3a2418', 0.9))
  const sun = new DirectionalLight('#ffe2b8', 2.6)
  sun.position.set(-900, 1400, 700)
  sun.castShadow = true
  sun.shadow.mapSize.set(4096, 4096)
  Object.assign(sun.shadow.camera, { left: -1500, right: 1500, top: 1500, bottom: -1500, near: 100, far: 4500 })
  sun.shadow.bias = -0.0004
  sun.shadow.normalBias = 1.5
  scene.add(sun, sun.target)

  let disposed = false
  let frame = 0
  dispose = () => {
    disposed = true
    cancelAnimationFrame(frame)
    observer.disconnect()
    controls.dispose()
    scene.traverse((o) => {
      if (o instanceof Mesh) {
        o.geometry.dispose()
        const m = o.material as MeshStandardMaterial
        m.map?.dispose()
        m.dispose()
      }
    })
    envMap.dispose()
    pmrem.dispose()
    renderer.dispose()
    renderer.domElement.remove()
  }

  // Refits the camera to the new shape, once the data is in
  let fit: (() => void) | undefined
  const resize = () => {
    const { clientWidth: w, clientHeight: h } = el
    renderer.setSize(w, h)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
    fit?.()
  }
  const observer = new ResizeObserver(resize)
  observer.observe(el)
  resize()

  const d = (await fetch(`${dataBase}/japan.json`).then((r) => r.json())) as Data
  if (disposed) return
  data.value = d
  loading.value = false

  // Plan (km, x east, y north) -> world (x east, y up, z south)
  const table = new Mesh(new PlaneGeometry(30000, 30000).rotateX(-Math.PI / 2), new MeshStandardMaterial({ color: TABLE, roughness: 0.95 }))
  table.receiveShadow = true
  scene.add(table)

  // The puzzle: one piece per prefecture, its top bevelled, all cut from the same light wood
  const wood = woodTexture()
  const pieces = d.prefs.map((p) => {
    const geoms = p.polygons.map((rings) => {
      const shape = new Shape(rings[0]!.map(([x, y]) => new Vector2(x, y)))
      shape.holes = rings.slice(1).map((h) => new Shape(h.map(([x, y]) => new Vector2(x, y))))
      return new ExtrudeGeometry(shape, { depth: BOARD - 0.8, bevelEnabled: true, bevelThickness: 0.8, bevelSize: 0.7, bevelSegments: 2, curveSegments: 1 })
    })
    const g = mergeGeometries(geoms)!
    geoms.forEach((q) => q.dispose())
    g.rotateX(-Math.PI / 2) // plan y (north) -> -z, extrusion -> up
    const m = new Mesh(g, new MeshStandardMaterial({ color: tintOf(p.code), map: wood, roughness: 0.7 }))
    m.castShadow = m.receiveShadow = true
    m.userData.pref = d.prefs.indexOf(p)
    scene.add(m)
    return m
  })

  // The fruit: one instanced draw per kind, as many instances as its biggest showing needs
  const fruits = makeFruits()
  const land = landOf(d.prefs)
  const parts = Object.fromEntries(FRUIT_KEYS.map((k) => [k, fruits[k].parts])) as Record<FruitKey, Fruit['parts']>
  const heapsFor = new Map<Mode, Placement[]>()
  const heaps = (m: Mode) => {
    if (!heapsFor.has(m)) heapsFor.set(m, buildHeaps(d.prefs, land, countsFor(d, m), { size: SIZE, parts, board: BOARD, seed: 23 + MODES.indexOf(m) }))
    return heapsFor.get(m)!
  }
  const capacity = Object.fromEntries(FRUIT_KEYS.map((k) => [k, 0])) as Record<FruitKey, number>
  for (const m of MODES) {
    const counts = countsFor(d, m)
    for (const k of FRUIT_KEYS) capacity[k] = Math.max(capacity[k], counts.reduce((a, c) => a + (c[k] ?? 0), 0))
  }
  const meshes = Object.fromEntries(
    FRUIT_KEYS.map((k) => {
      const f = fruits[k]
      const mat = new MeshPhysicalMaterial({ vertexColors: true, roughness: f.roughness, clearcoat: f.clearcoat, clearcoatRoughness: 0.25 })
      const mesh = new InstancedMesh(f.geometry, mat, capacity[k])
      mesh.instanceMatrix.setUsage(DynamicDrawUsage)
      mesh.castShadow = mesh.receiveShadow = true
      mesh.frustumCulled = false
      mesh.count = 0
      scene.add(mesh)
      return [k, mesh]
    }),
  ) as Record<FruitKey, InstancedMesh<BufferGeometry, MeshPhysicalMaterial>>

  // Each piece's resting pose, and the pieces showing now with the clock they run on
  const rest = (p: Placement) => {
    const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), p.yaw)
    const tilt = new Quaternion().setFromAxisAngle(new Vector3(Math.cos(p.tiltDir), 0, Math.sin(p.tiltDir)), p.tilt)
    return { pos: new Vector3(p.x, BOARD + p.h, -p.y), rot: tilt.multiply(q), scale: p.scale * SIZE }
  }
  type Shown = { p: Placement; mesh: InstancedMesh; index: number; pose: ReturnType<typeof rest> }
  let shown: Shown[] = []
  let phase: 'drop' | 'leave' | 'still' = 'still'
  let phaseStart = 0
  let nextMode: Mode | undefined

  const m4 = new Matrix4()
  const v = new Vector3()
  const s = new Vector3()
  const show = (m: Mode) => {
    const used = Object.fromEntries(FRUIT_KEYS.map((k) => [k, 0])) as Record<FruitKey, number>
    shown = heaps(m).map((p) => ({ p, mesh: meshes[p.key], index: used[p.key]++, pose: rest(p) }))
    for (const k of FRUIT_KEYS) meshes[k].count = used[k]
  }
  const pose = (x: Shown, t: number) => {
    // Dropping: hidden until its turn, falling with gravity, then a little squash as it lands
    // Leaving: shrinking away, the tops of the heaps first
    let fall = 0
    let k = 1
    let squash = 0
    if (phase === 'drop') {
      const u = (t - x.p.delay) / FALL_S
      if (u < 0) k = 0
      else if (u < 1) fall = FALL * (1 - u * u)
      else squash = Math.max(0, 1 - (u - 1) * 4) * Math.sin((u - 1) * 4 * Math.PI) * 0.12
    } else if (phase === 'leave') {
      k = 1 - Math.min(1, Math.max(0, (t - (1 - x.p.delay / 3) * 0.25) / (LEAVE_S * 0.5)))
    }
    v.copy(x.pose.pos)
    v.y += fall
    const sc = x.pose.scale * k
    s.set(sc * (1 + squash * 0.5), sc * (1 - squash), sc * (1 + squash * 0.5))
    m4.compose(v, x.pose.rot, s)
    x.mesh.setMatrixAt(x.index, m4)
  }

  setMode = (m, byHand = false) => {
    if (byHand) cycling.value = false
    if (m === mode.value && phase !== 'leave') return
    mode.value = m
    nextMode = m
    phase = 'leave'
    phaseStart = performance.now() / 1000
  }

  // Camera: on a wide screen from the south, Japan across it; on a tall one from the south-west,
  // looking up the archipelago. Fitted to the main islands: Amami and Okinawa are left off the edge
  const outline = d.prefs.flatMap((p) => p.polygons.flatMap((rings) => rings[0]!)).filter(([, y]) => y > SOUTH)
  const ndc3 = new Vector3()
  const box = (pos: Vector3, at: Vector3) => {
    camera.position.copy(pos)
    camera.lookAt(at)
    camera.updateMatrixWorld()
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity]
    for (const [x, y] of outline) {
      ndc3.set(x, BOARD, -y).project(camera)
      x0 = Math.min(x0, ndc3.x)
      x1 = Math.max(x1, ndc3.x)
      y0 = Math.min(y0, ndc3.y)
      y1 = Math.max(y1, ndc3.y)
    }
    return { x0, y0, x1, y1 }
  }
  const target = new Vector3()
  fit = () => {
    const t = Math.min(1, Math.max(0, (1.3 - camera.aspect) / 0.7))
    const dir = new Vector3(0.2, 0.42, 0.88).lerp(new Vector3(-0.55, 0.5, 0.67), t).normalize()
    target.set(100, 0, -100)
    let dist = 3000
    for (let i = 0; i < 4; i++) {
      const b = box(target.clone().addScaledVector(dir, dist), target)
      // Room above for the heaps, and below for the controls on a phone
      const scale = Math.max((b.x1 - b.x0) / 1.9, (b.y1 - b.y0) / (t > 0.5 ? 1.45 : 1.6))
      // Centre the box (moving the target along the screen's axes on the ground), then scale
      const right = new Vector3().setFromMatrixColumn(camera.matrixWorld, 0)
      const up = new Vector3().setFromMatrixColumn(camera.matrixWorld, 1).setY(0).normalize()
      const halfH = dist * Math.tan((camera.fov * Math.PI) / 360)
      target.addScaledVector(right, ((b.x0 + b.x1) / 2) * halfH * camera.aspect)
      target.addScaledVector(up, ((b.y0 + b.y1) / 2 - (t > 0.5 ? 0.02 : -0.06)) * halfH * 1.5)
      dist *= scale
    }
    camera.position.copy(target).addScaledVector(dir, dist)
    controls.target.copy(target)
    controls.update()
  }
  fit()

  // Hover: which prefecture is under the pointer
  const ray = new Raycaster()
  const ndc = new Vector2()
  const onMove = (e: PointerEvent) => {
    const r = renderer.domElement.getBoundingClientRect()
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
    ray.setFromCamera(ndc, camera)
    const hit = ray.intersectObjects(pieces, false)[0]
    hover.value = hit ? { x: e.clientX - r.left, y: e.clientY - r.top, pref: hit.object.userData.pref as number } : undefined
  }
  renderer.domElement.addEventListener('pointermove', onMove)
  renderer.domElement.addEventListener('pointerleave', () => (hover.value = undefined))

  nextMode = mode.value
  phase = 'leave'
  phaseStart = performance.now() / 1000 - LEAVE_S
  let cycleFrom = performance.now()

  const tick = (nowMs: number) => {
    frame = requestAnimationFrame(tick)
    const now = nowMs / 1000
    if (cycling.value && phase === 'still' && nowMs - cycleFrom > CYCLE_S * 1000) {
      setMode!(MODES[(MODES.indexOf(mode.value) + 1) % MODES.length]!)
    }
    let t = now - phaseStart
    if (phase === 'leave' && t >= LEAVE_S) {
      show(nextMode!)
      phase = 'drop'
      phaseStart = now
      t = 0
    }
    if (phase !== 'still') {
      for (const x of shown) pose(x, t)
      for (const k of FRUIT_KEYS) meshes[k].instanceMatrix.needsUpdate = true
      const last = shown.reduce((a, x) => Math.max(a, x.p.delay), 0)
      if (phase === 'drop' && t > last + FALL_S + 0.3) {
        phase = 'still'
        cycleFrom = nowMs
      }
    }
    controls.update()
    renderer.render(scene, camera)
  }
  frame = requestAnimationFrame(tick)
})

onBeforeUnmount(() => {
  setMode = undefined
  dispose?.()
  dispose = undefined
})
</script>

<template>
  <div class="map-canvas day23">
    <div ref="container" class="map-canvas" />
    <div class="controls" :class="{ folded: !controlsOpen }">
      <div class="seg" role="group" aria-label="Flavour">
        <button v-for="m in MODES" :key="m" type="button" :aria-pressed="mode === m" @click="setMode?.(m, true)">
          {{ m === 'all' ? 'All' : NAMES[m][0] }}
        </button>
      </div>
      <div class="unit">{{ unitLabel }}</div>
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
    <div v-if="hover && data" class="tip" :style="{ left: `${hover.x}px`, top: `${hover.y}px` }">
      <strong>{{ data.prefs[hover.pref]!.name }}</strong>
      <div v-for="r in hoverRows" :key="r.k" class="row">
        <span>{{ r.name }}</span><span>{{ fmt(r.v!) }} t</span>
      </div>
      <div v-if="hoverRows.length === 0" class="row none">Not among the main growers</div>
    </div>
    <div v-if="loading" class="loading">Loading…</div>
    <div class="attribution">
      <a href="https://www.maff.go.jp/j/tokei/kouhyou/sakumotu/sakkyou_kazyu/index.html" target="_blank" rel="noopener">農林水産省 作物統計（令和7年産）</a>
      · © <a href="https://overturemaps.org/">Overture Maps Foundation</a> · ©
      <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors
    </div>
  </div>
</template>

<style scoped>
.day23 {
  position: relative;
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
  max-width: calc(100% - 24px);
}

/* Matches the page's header panel */
.seg,
.unit,
.tip {
  background: rgba(15, 20, 25, 0.82);
  backdrop-filter: blur(6px);
  border: 1px solid var(--border);
  border-radius: 10px;
}

.seg {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  overflow: hidden;
}

.seg button {
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
  color: #1a0e06;
  background: linear-gradient(135deg, #ffb35c, #e0661a);
}

.seg button:not([aria-pressed='true']):hover {
  color: var(--accent);
}

.unit {
  padding: 4px 10px;
  font-size: 12px;
  color: var(--fg-muted);
}

.tip {
  position: absolute;
  z-index: 11;
  transform: translate(14px, 14px);
  padding: 6px 10px;
  min-width: 160px;
  font-size: 12px;
  color: var(--fg);
  pointer-events: none;
}

.tip .row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-variant-numeric: tabular-nums;
}

.tip .none {
  color: var(--fg-muted);
}

.loading {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: var(--fg-muted);
  pointer-events: none;
}

.attribution {
  position: absolute;
  right: 6px;
  bottom: 4px;
  font-size: 11px;
  color: var(--fg-muted);
}

.attribution a {
  color: inherit;
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
  }

  .fold {
    display: block;
  }

  .controls.folded .seg,
  .controls.folded .unit {
    display: none;
  }
}
</style>
