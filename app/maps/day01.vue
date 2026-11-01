<script setup lang="ts">
// Day 1: Points — MapLibre GL JS sample (major cities in Japan)
import maplibregl from 'maplibre-gl'
import type { StyleSpecification } from 'maplibre-gl'

const container = ref<HTMLDivElement>()
let map: maplibregl.Map | undefined

const style: StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution: '© OpenStreetMap contributors',
    },
  },
  layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
}

const cities: Array<[string, number, number]> = [
  ['Sapporo', 141.3544, 43.0621],
  ['Sendai', 140.8719, 38.2682],
  ['Tokyo', 139.6917, 35.6895],
  ['Nagoya', 136.9066, 35.1815],
  ['Osaka', 135.5023, 34.6937],
  ['Hiroshima', 132.4553, 34.3853],
  ['Fukuoka', 130.4017, 33.5904],
  ['Naha', 127.6809, 26.2124],
]

onMounted(() => {
  map = new maplibregl.Map({
    container: container.value!,
    style,
    center: [137, 36],
    zoom: 4.5,
  })

  map.on('load', () => {
    map!.addSource('cities', {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: cities.map(([name, lng, lat]) => ({
          type: 'Feature',
          properties: { name },
          geometry: { type: 'Point', coordinates: [lng, lat] },
        })),
      },
    })
    map!.addLayer({
      id: 'cities',
      type: 'circle',
      source: 'cities',
      paint: {
        'circle-radius': 8,
        'circle-color': '#e53935',
        'circle-stroke-color': '#fff',
        'circle-stroke-width': 2,
      },
    })
  })
})

onBeforeUnmount(() => map?.remove())
</script>

<template>
  <div ref="container" class="map-canvas" />
</template>
