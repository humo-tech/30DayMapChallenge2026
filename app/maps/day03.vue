<script setup lang="ts">
// Day 3: Polygons — Chiba-kun, Chiba Prefecture's mascot whose silhouette is the prefecture, laid over Navara's standard basemap
import ThreeView, { Color } from '@navaramap/three'
import { DefaultPlugin, type DefaultDescriptions } from '@navaramap/three-default-plugin'
import { TileJsonPlugin } from '@navaramap/three-plugins'
import { LimbGlowMeshDesc, type LimbGlowConfig } from './lib/LimbGlowMeshDesc'
import { StarfieldMeshDesc, type StarfieldConfig } from './lib/StarfieldMeshDesc'

const baseURL = useRuntimeConfig().app.baseURL
// The prefecture borders are Day 1's
const dataBase = `${baseURL}data/day03`
const day01Base = `${baseURL}data/day01`

const SPACE = '#060b1c'
const BORDER = new Color().setStyle('#9a9a9a')

// Chiba-kun red is process CMYK (0, 100, 75, 0); ink is K100's rich black
const PART_COLORS: Record<string, Color> = {
  body: new Color().setStyle('#e60039'),
  eye: new Color().setStyle('#ffffff'),
  ink: new Color().setStyle('#231815'),
}

// The camera loops: out in space -> close in on Chiba-kun -> he blinks -> back out to space
const SPACE_VIEW = { lng: 140.25, lat: 35.45, distance: 15_000_000, heading: 0, pitch: -90, roll: 0 }
const CHIBA_VIEW = { lng: 140.25, lat: 35.45, distance: 250_000, heading: 0, pitch: -55, roll: 0 }
const FLIGHT_MS = 5000
const SPACE_HOLD_MS = 1500
const BLINK_MS = 3000
const BLINK_PERIOD_MS = 1000

const container = ref<HTMLDivElement>()
let view: ThreeView<DefaultDescriptions> | undefined
let timer: ReturnType<typeof setTimeout> | undefined

const wait = (ms: number) => new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))

onMounted(async () => {
  const v = new ThreeView<DefaultDescriptions>({
    container: container.value!,
    backgroundColor: new Color().setStyle(SPACE),
  })
  view = v
  v.addPlugin(new DefaultPlugin())
  const tilejson = new TileJsonPlugin()
  v.addPlugin(tilejson)
  await v.init()
  if (view !== v) return // unmounted while initializing
  v.registerMesh('limbGlow', LimbGlowMeshDesc)
  v.registerMesh('starfield', StarfieldMeshDesc)

  v.setCamera({ ...SPACE_VIEW, height: 0 })

  // (typed separately: the view's mesh config union only knows the DefaultPlugin descriptors)
  const limbGlow: LimbGlowConfig = { limbGlow: { color: new Color().setStyle('#5b86ff'), intensity: 0.8, scaleHeight: 80_000 } }
  v.addMesh<LimbGlowMeshDesc>(limbGlow)
  const starfield: StarfieldConfig = { starfield: {} }
  v.addMesh<StarfieldMeshDesc>(starfield)

  // The basemap Navara's own examples use (Re:Earth Papers Light); the plugin credits it from the TileJSON
  const basemap = await tilejson.addSource({
    type: 'raster-tile',
    url: 'https://papers.reearth.land/styles/papers-light/tilejson.json',
  })
  if (view !== v) return
  v.addLayer({ type: 'raster', source: basemap })

  // Prefecture borders, added before Chiba-kun so he draws over them
  const borders = v.addSource({ type: 'geojson', url: `${day01Base}/pref_boundaries.geojson` })
  v.addLayer({ type: 'vector', source: borders, polyline: { color: BORDER, width: 1, clampToGround: true } })

  // Chiba-kun: body, eye white and ink are disjoint, so one layer holds them all
  let shown = true
  const chibakun = v.addSource({ type: 'geojson', url: `${dataBase}/chibakun.geojson` })
  const chibakunLayer = v.addLayer({
    type: 'vector',
    source: chibakun,
    polygon: { color: PART_COLORS.body, clampToGround: true },
  })
  chibakunLayer.on('featureUpdated', ({ evaluator }) => {
    evaluator.evaluate(
      ({ properties }) => ({ color: PART_COLORS[String(properties?.['part'])] ?? PART_COLORS.body, show: shown }),
      { filters: ['part'] },
    )
  })
  const setShown = (s: boolean) => {
    shown = s
    chibakunLayer.forceUpdate()
  }

  v.attribution?.add([
    {
      attributionHtml:
        'チーバくん © 千葉県 · © <a href="https://overturemaps.org/">Overture Maps Foundation</a> · © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    },
  ])

  const fly = (to: typeof CHIBA_VIEW) => v.flyTo(to, { duration: FLIGHT_MS, easing: 'cubicInOut' })
  // A flight resolves false when the user grabs the camera: hand it over and stop looping
  while (view === v) {
    await wait(SPACE_HOLD_MS)
    if (view !== v || !(await fly(CHIBA_VIEW))) return
    for (let t = 0; t < BLINK_MS; t += BLINK_PERIOD_MS / 2) {
      setShown(!shown)
      await wait(BLINK_PERIOD_MS / 2)
      if (view !== v) return
    }
    setShown(true)
    if (!(await fly(SPACE_VIEW))) return
  }
})

onBeforeUnmount(() => {
  clearTimeout(timer)
  view?.dispose()
  view = undefined
})
</script>

<template>
  <div ref="container" class="map-canvas" />
</template>
