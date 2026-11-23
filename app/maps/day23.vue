<script setup lang="ts">
// Day 23: Senses: Taste — autumn's flavours heaped on Japan itself: each prefecture's 2025 crop of
// apples, persimmons, pears, grapes, chestnuts and sweet potatoes, one piece of fruit per so many
// tonnes shipped, dropped onto it in the low sun of an October afternoon. Navara: the prefectures
// as matte stone slabs on a light world map under the sky, lit like food on a table (the sun
// low, a cool fill), the sun's cascaded shadows off the heaps telling one prefecture's from the
// next, and ambient occlusion in their hollows. It renders only while something moves. (The same in plain
// Three.js, on a wooden jigsaw of Japan: the hidden page /day/23-three.)
// Data: scripts/day23/build_data.py
import ThreeView, { Color, vector3ToGeodetic } from '@navaramap/three'
import { DefaultPlugin, type DefaultDescriptions } from '@navaramap/three-default-plugin'
import { TileJsonPlugin } from '@navaramap/three-plugins'
import { FRUIT_KEYS, makeFruits, type Fruit, type FruitKey } from './lib/harvestFruits'
import { buildHeaps, landOf, prefAt, type Placement, type Ring } from './lib/harvestHeaps'
import { HarvestHeapsMeshDesc, type HarvestHeapsConfig } from './lib/HarvestHeapsMeshDesc'
import { HarvestLandMeshDesc, type HarvestLandConfig } from './lib/HarvestLandMeshDesc'
import { toPlan } from './lib/japanLcc'
import { Color as ThreeColor, Vector3 } from 'three'

type Item = { measure: 'shipped' | 'harvested'; national: number; values: (number | null)[]; source: string }
type Pref = { code: number; name: string; polygons: Ring[][]; heap: [number, number] }
type Data = { prefs: Pref[]; land: Ring[][]; cover: Ring[][]; items: Record<FruitKey, Item> }
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
// Tonnes per piece: one scale for all of them together, and one per kind on its own (so the
// biggest heap of each is a few hundred pieces)
const UNIT_ALL = 500
const UNIT: Record<FruitKey, number> = { ringo: 1000, kaki: 100, nashi: 50, budou: 100, kuri: 10, kansho: 500 }
const MODES: Mode[] = ['all', ...FRUIT_KEYS]

// km per model unit: a piece is ~16 km across
const SIZE = 8
// Early afternoon in late October in Japan (13:30 JST): the sun in the south-south-west, low
// enough for long shadows off the heaps
const DATE = new Date('2025-10-25T04:30:00Z')
// Cycling through the kinds until someone picks one (s per kind)
const CYCLE_S = 9
// A quiet backdrop for the fruit: a light world map under the sky, Japan in pale stone; the sun's
// colour from the atmosphere, the fill cool
const BACKGROUND = '#08090b'
const EXPOSURE = 2.2
const LAND = '#b5a892'
// The prefectures' slabs, thick enough to stand up off the map; the grooves between them (2.4 km,
// from build_data.py) floored with the land whole, lower down
const SLAB = 5_000
const GROOVE_FLOOR = 3_000
const LAND_FLOOR = '#968a77'
// The basemap's sea, for the cover over its own Japan (papers-light)
const MAP_SEA = '#bfbfbf'
const FILL = { color: '#c4cede', intensity: 1.0 }
// The map isn't lit and the slabs and fruit are: a stronger sun keeps them as bright as the map
const SUN_INTENSITY = 1.5


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
let view: ThreeView<DefaultDescriptions> | undefined
let frame = 0

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

/**
 * The camera: looking at the middle of Japan, on a wide screen from the south-east (the
 * archipelago running across it), on a tall one from the south-west (up it)
 */
function cameraFor(aspect: number) {
  const t = Math.min(1, Math.max(0, (1.3 - aspect) / 0.7))
  const lerp = (a: number, b: number) => a + (b - a) * t
  const bearing = (lerp(150, 215) * Math.PI) / 180 // from the target to the camera
  const up = (lerp(40, 44) * Math.PI) / 180
  const dist = lerp(1_380_000, 2_500_000)
  const offset = new Vector3(Math.sin(bearing) * Math.cos(up), Math.cos(bearing) * Math.cos(up), Math.sin(up)).multiplyScalar(dist)
  return { target: { lng: lerp(137.1, 136.0), lat: lerp(36.3, 35.6), height: 0 }, offset }
}
// ?camera=lng,lat,height(km),heading,pitch sets the camera instead (for a close look, or a thumbnail)
const cameraParam = (useRoute().query.camera as string | undefined)?.split(',').map(Number)

onMounted(async () => {
  const d = (await fetch(`${dataBase}/japan.json`).then((r) => r.json())) as Data
  if (!container.value) return // unmounted while loading
  data.value = d

  const v = new ThreeView<DefaultDescriptions>({
    container: container.value,
    backgroundColor: new Color().setStyle(BACKGROUND),
    // Only when something changes: the heaps moving, the camera, a resize
    animation: false,
    shadow: true,
    pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
  })
  view = v
  const plugin = new DefaultPlugin()
  const tilejson = new TileJsonPlugin()
  v.addPlugin(plugin)
  v.addPlugin(tilejson)
  await v.init()
  if (view !== v) return // unmounted while initializing
  v.registerMesh('harvestHeaps', HarvestHeapsMeshDesc)
  v.registerMesh('harvestLand', HarvestLandMeshDesc)
  v.atmosphere.date = DATE

  // Navara's sky, sun and stars. From this far off the atmosphere's haze would wash the fruit
  // out: keep the sky, drop the haze. The sun's shadows reach across the whole of Japan (3
  // cascades are enough at this distance); a cool fill; ambient occlusion between the pieces
  const scene = plugin.addDefaultPhotorealScene()
  v.toneMappingExposure = EXPOSURE
  scene.aerialPerspective.update({ aerialPerspective: { inscatter: false } })
  scene.sun.update({
    sun: {
      intensity: SUN_INTENSITY,
      castShadow: true,
      shadowFar: 4_000_000,
      shadowMapSize: v.isMobileOptimized() ? 2048 : 4096,
      shadowCascadeCount: 3,
      shadowLambda: 0.9,
      shadowNormalBias: 3,
    },
  })
  v.addLight({ ambient: { intensity: FILL.intensity, color: new Color().setStyle(FILL.color) } })
  v.addEffect({ ssao: { radius: 12_000, intensity: 2.5, samples: 16 } })

  // The world, light and without labels: the basemap Navara's own examples use (Re:Earth Papers),
  // credited from its TileJSON
  const basemap = await tilejson.addSource({ type: 'raster-tile', url: 'https://papers.reearth.land/styles/papers-light/tilejson.json' })
  if (view !== v) return
  v.addLayer({ type: 'raster', source: basemap })

  const landConfig: HarvestLandConfig = {
    harvestLand: {
      prefs: d.prefs.map((p) => p.polygons),
      color: new ThreeColor(LAND),
      thickness: SLAB,
      land: d.land,
      floorColor: new ThreeColor(LAND_FLOOR),
      floorHeight: GROOVE_FLOOR,
      cover: d.cover,
      coverColor: new ThreeColor(MAP_SEA),
    },
  }
  v.addMesh<HarvestLandMeshDesc>(landConfig)

  v.attribution?.add([
    {
      attributionHtml:
        'Harvest: <a href="https://www.maff.go.jp/j/tokei/kouhyou/sakumotu/sakkyou_kazyu/index.html">農林水産省 作物統計（令和7年産）</a> · Prefectures: © <a href="https://overturemaps.org/">Overture Maps Foundation</a>, © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    },
  ])

  if (cameraParam?.length === 5 && cameraParam.every(Number.isFinite)) {
    const [lng, lat, height, heading, pitch] = cameraParam as [number, number, number, number, number]
    v.setCamera({ lng, lat, height: height * 1000, heading, pitch, roll: 0 })
  } else {
    const { target, offset } = cameraFor(container.value.clientWidth / container.value.clientHeight)
    v.lookAt(target, offset)
  }
  loading.value = false

  // The heaps, worked out for each showing the first time it's needed
  const land = landOf(d.prefs)
  const heapsFor = new Map<Mode, Placement[]>()
  const heaps = (m: Mode) => {
    if (!heapsFor.has(m)) {
      // Off the slabs (into a groove or the sea) a piece drops to the map, a slab's thickness down
      const opts = { size: SIZE, parts, board: SLAB / 1000, seed: 23 + MODES.indexOf(m) }
      heapsFor.set(m, buildHeaps(d.prefs, land, countsFor(d, m), opts))
    }
    return heapsFor.get(m)!
  }
  // Plain, matte fruit: the pared-down map makes the real skins look out of place
  const fruits = makeFruits('plain')
  const parts = Object.fromEntries(FRUIT_KEYS.map((k) => [k, fruits[k].parts])) as Record<FruitKey, Fruit['parts']>
  const capacity = Object.fromEntries(FRUIT_KEYS.map((k) => [k, 0])) as Record<FruitKey, number>
  for (const m of MODES) {
    const counts = countsFor(d, m)
    for (const k of FRUIT_KEYS) capacity[k] = Math.max(capacity[k], counts.reduce((a, c) => a + (c[k] ?? 0), 0))
  }
  const config: HarvestHeapsConfig = { harvestHeaps: { fruits, capacity, size: SIZE * 1000, base: SLAB } }
  const heapMesh = v.addMesh<HarvestHeapsMeshDesc>(config).ref

  let next: Mode | undefined = mode.value
  let settledAt = performance.now()
  setMode = (m, byHand = false) => {
    if (byHand) cycling.value = false
    if (m === mode.value && next === undefined) return
    mode.value = m
    next = m
    heapMesh.leave()
  }

  // Our own clock, since the view only renders on changes: moving heaps ask it for a frame
  const step = () => {
    frame = requestAnimationFrame(step)
    const now = performance.now()
    heapMesh.tick(now / 1000)
    if (heapMesh.busy) {
      settledAt = now
      return
    }
    if (next !== undefined) {
      heapMesh.show(heaps(next))
      next = undefined
    } else if (cycling.value && now - settledAt > CYCLE_S * 1000) {
      setMode!(MODES[(MODES.indexOf(mode.value) + 1) % MODES.length]!)
    }
  }
  frame = requestAnimationFrame(step)

  // Hover: which prefecture is under the pointer (its slab, or its fruit: what the depth buffer
  // holds there, since there's no terrain or globe surface to pick)
  const el = container.value
  el.addEventListener('pointermove', (e) => {
    const r = el.getBoundingClientRect()
    const hit = v.pickDepthPosition(e.clientX, e.clientY)
    const g = hit && vector3ToGeodetic(hit)
    const at = g ? prefAt(land, ...toPlan(g.lng, g.lat)) : -1
    hover.value = at >= 0 ? { x: e.clientX - r.left, y: e.clientY - r.top, pref: at } : undefined
  })
  el.addEventListener('pointerleave', () => (hover.value = undefined))
})

onBeforeUnmount(() => {
  cancelAnimationFrame(frame)
  setMode = undefined
  view?.dispose()
  view = undefined
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
