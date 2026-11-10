<script setup lang="ts">
// Day 10: Prompting only — a style for Overture Maps' own PMTiles, made start to finish in a chat:
// pastel and plush, after Day 8 (see lib/plushStyle.ts). MapLibre GL JS reads the archives
// straight from Overture's S3 by range requests. Day 8's giant teddy bears sit in the parks (Three.js, in
// a custom layer) and watch the camera circle slowly over Harajuku
import * as maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
// MapLibre finds its worker next to its own module, which Vite's bundling moves: point it there
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'
import { Protocol } from 'pmtiles'
import { MIN_ZOOM, plushStyle } from './lib/plushStyle'
import { parkBears } from './lib/parkBears'

maplibregl.setWorkerUrl(workerUrl)

// Harajuku: the camera circles Jingūmae, between Yoyogi Park and Omotesandō, once in ORBIT_S
const CENTRE: [number, number] = [139.7055, 35.6685]
const ZOOM = 16
const PITCH = 62
const ORBIT_S = 180

const container = ref<HTMLDivElement>()
let map: maplibregl.Map | undefined
let bears: ReturnType<typeof parkBears> | undefined
let frame = 0

const touring = ref(true)
let setTouring: ((on: boolean) => void) | undefined

onMounted(() => {
  const protocol = new Protocol()
  maplibregl.addProtocol('pmtiles', protocol.tile)

  const m = new maplibregl.Map({
    container: container.value!,
    style: plushStyle(),
    center: CENTRE,
    zoom: ZOOM,
    pitch: PITCH,
    bearing: 0,
    minZoom: MIN_ZOOM,
    maxPitch: 75,
  })
  map = m

  // The orbit turns the bearing only while touring; `clock` maps performance.now() onto its angle
  let clock: number | undefined
  const turn = () => {
    if (clock !== undefined) m.setBearing((((performance.now() - clock) / 1000 / ORBIT_S) * 360) % 360)
    frame = requestAnimationFrame(turn)
  }
  setTouring = (on) => {
    touring.value = on
    if (!on) {
      clock = undefined
      return
    }
    // Back over Harajuku, then on round from the bearing it is at
    m.easeTo({ center: CENTRE, zoom: ZOOM, pitch: PITCH, duration: 2500 })
    m.once('moveend', () => {
      if (touring.value && map === m) clock = performance.now() - (m.getBearing() / 360) * ORBIT_S * 1000
    })
  }
  m.once('load', () => {
    // Among the buildings, under the park names
    bears = parkBears(CENTRE)
    m.addLayer(bears, 'park-labels')
    clock = performance.now()
    turn()
  })

  // Grabbing the map stops the tour and hands it over
  const grab = () => touring.value && setTouring?.(false)
  for (const type of ['pointerdown', 'wheel', 'touchstart'] as const) {
    container.value?.addEventListener(type, grab, { passive: true })
  }
})

onBeforeUnmount(() => {
  cancelAnimationFrame(frame)
  setTouring = undefined
  map?.remove()
  map = undefined
  bears?.dispose()
  bears = undefined
  maplibregl.removeProtocol('pmtiles')
})
</script>

<template>
  <div class="map-canvas day10">
    <div ref="container" class="map-canvas" />
    <button type="button" class="tour" :aria-pressed="touring" @click="setTouring?.(!touring)">
      {{ touring ? '❚❚ Stop tour' : '▶ Play tour' }}
    </button>
  </div>
</template>

<style scoped>
.day10 {
  position: relative;
}

/* Matches the page's header panel */
.tour {
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

.tour:hover {
  color: var(--accent);
}
</style>
