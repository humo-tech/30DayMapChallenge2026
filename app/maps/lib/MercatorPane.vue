<script setup lang="ts">
// Day 22: the same places on a plain Web Mercator map (MapLibre GL JS), beside the freehand map
// to compare. A click here picks a place for both maps; a place picked on the freehand map gets
// its pin here too (and the map pans to it if it's out of view).
import * as maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
// MapLibre finds its worker next to its own module, which Vite's bundling moves: point it there
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'
import { fmtLngLat, type Ring } from './freehand'

maplibregl.setWorkerUrl(workerUrl)

type Place = { name: string; lng: number; lat: number }

const props = defineProps<{
  view: 'japan' | 'world'
  pins: Place[]
  picked?: { lng: number; lat: number; key: number }
  imagery: 'papers' | 'bluemarble'
  /** The grid warped onto the freehand map, drawn here as lines: its finest step in degrees */
  grid?: number
  /** The real borders the freehand map is fitted to (prefectures or countries), lng / lat */
  borders: Ring[]
}>()
const emit = defineEmits<{ pick: [lng: number, lat: number] }>()

const SEA = '#cfe4ea'
// The freehand maps' extents: Japan with the Nansei Islands, the world centred on 150°E
const JAPAN: [[number, number], [number, number]] = [
  [122.5, 24],
  [146, 45.8],
]
const WORLD = { center: [150, 15] as [number, number] }

const el = ref<HTMLDivElement>()
let map: maplibregl.Map | undefined
let marker: maplibregl.Marker | undefined
let observer: ResizeObserver | undefined
// Until the map's been moved by hand, a change of size frames it again
let moved = false

const borderLines = (rings: Ring[]): GeoJSON.Feature => ({
  type: 'Feature',
  properties: {},
  geometry: { type: 'MultiLineString', coordinates: rings.map((r) => [...r, r[0]!]) },
})

const geojson = (pins: Place[]): GeoJSON.FeatureCollection => ({
  type: 'FeatureCollection',
  features: pins.map((p) => ({ type: 'Feature', properties: { name: p.name }, geometry: { type: 'Point', coordinates: [p.lng, p.lat] } })),
})

// The grid, as in scripts/day22/make_grid.py: lines at the finest step, 1°, 5° and 10°, the equator and
// the prime meridian heavier, the 10° squares shaded alternately (lightly, over the basemap).
// Mercator stops short of the poles.
const GRID_LAT = 85
function gridLines(step: number): GeoJSON.FeatureCollection {
  const level = (v: number) => (v === 0 ? 'axis' : v % 10 === 0 ? '10' : v % 5 === 0 ? '5' : v % 1 === 0 ? '1' : 'fine')
  const n = Math.round(1 / step) // integer steps, so 0.2° adds up exactly
  const features: GeoJSON.Feature[] = []
  for (let i = -180 * n; i <= 180 * n; i++) {
    const lng = i / n
    features.push({ type: 'Feature', properties: { level: level(lng) }, geometry: { type: 'LineString', coordinates: [[lng, -GRID_LAT], [lng, GRID_LAT]] } })
  }
  for (let i = -GRID_LAT * n; i <= GRID_LAT * n; i++) {
    const lat = i / n
    features.push({ type: 'Feature', properties: { level: level(lat) }, geometry: { type: 'LineString', coordinates: [[-180, lat], [0, lat], [180, lat]] } })
  }
  return { type: 'FeatureCollection', features }
}
function gridCells(): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = []
  for (let i = 0; i < 36; i++) {
    for (let j = 0; j < 18; j++) {
      if ((i + j) % 2 === 0) continue
      const [w, n] = [-180 + i * 10, 90 - j * 10]
      const [s, e] = [Math.max(n - 10, -GRID_LAT), w + 10]
      const top = Math.min(n, GRID_LAT)
      features.push({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, top], [w, top], [w, s]]] } })
    }
  }
  return { type: 'FeatureCollection', features }
}

function showGrid(m: maplibregl.Map) {
  const v = props.grid ? 'visible' : 'none'
  for (const id of ['grid-cells', 'grid-lines']) m.setLayoutProperty(id, 'visibility', v)
}

/** Light lines on Blue Marble, ink on the light maps */
function showBorderColor(m: maplibregl.Map) {
  m.setPaintProperty('borders', 'line-color', props.imagery === 'bluemarble' ? '#ffffff' : '#1d3557')
}

function frame(m: maplibregl.Map) {
  moved = false
  if (props.view === 'japan') {
    m.fitBounds(JAPAN, { padding: 16, duration: 0 })
  } else {
    // All the way round (bounds a full 360° wide don't fit): a 512 px world at zoom 0
    const zoom = Math.log2((m.getContainer().clientWidth * 0.98) / 512)
    m.jumpTo({ center: WORLD.center, zoom: Math.max(0, zoom) })
  }
}

function markerElement() {
  const e = document.createElement('div')
  e.className = 'day22-marker'
  // MapLibre places the marker with a transform: the drop animates the inside
  e.innerHTML =
    '<div class="drop"><span class="tag"></span><svg viewBox="-9 -27 18 28" width="22" height="34"><ellipse cx="0" cy="0" rx="5" ry="2" fill="#1d3557" opacity="0.25"/>' +
    '<path d="M0 0C-1.5-5-8-10.5-8-17A8 8 0 0 1 8-17C8-10.5 1.5-5 0 0Z" fill="#3a5bd9" stroke="#fff" stroke-width="1.2"/><circle cx="0" cy="-17" r="3" fill="#fff"/></svg></div>'
  return e
}

function showPicked() {
  const m = map
  if (!m) return
  const p = props.picked
  if (!p) {
    marker?.remove()
    marker = undefined
    return
  }
  // A new element each time, so the drop animation plays again
  marker?.remove()
  const e = markerElement()
  e.querySelector('.tag')!.textContent = fmtLngLat(p.lng, p.lat)
  marker = new maplibregl.Marker({ element: e, anchor: 'bottom' }).setLngLat([p.lng, p.lat]).addTo(m)
  if (!m.getBounds().contains([p.lng, p.lat])) m.easeTo({ center: [p.lng, p.lat], duration: 600 })
}

onMounted(() => {
  const m = new maplibregl.Map({
    container: el.value!,
    style: {
      version: 8,
      sources: {
        // Re:Earth Papers, light (as on Days 3 and 9); its attribution comes with the TileJSON
        papers: { type: 'raster', url: 'https://papers.reearth.land/styles/papers-light/tilejson.json', tileSize: 512 },
        // The same Blue Marble as the freehand map's, in Web Mercator tiles
        bluemarble: {
          type: 'raster',
          tiles: [
            'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg',
          ],
          tileSize: 256,
          maxzoom: 8,
          attribution: 'Blue Marble: <a href="https://earthdata.nasa.gov/gibs">NASA GIBS</a>',
        },
      },
      layers: [
        { id: 'sea', type: 'background', paint: { 'background-color': SEA } },
        { id: 'papers', type: 'raster', source: 'papers', layout: { visibility: props.imagery === 'papers' ? 'visible' : 'none' } },
        { id: 'bluemarble', type: 'raster', source: 'bluemarble', layout: { visibility: props.imagery === 'bluemarble' ? 'visible' : 'none' } },
      ],
    },
    center: [137, 36],
    zoom: 3,
    attributionControl: { compact: true },
    dragRotate: false,
    pitchWithRotate: false,
  })
  map = m
  m.touchZoomRotate.disableRotation()
  m.getCanvas().style.cursor = 'crosshair'
  frame(m)

  m.on('load', () => {
    m.addSource('grid-lines', { type: 'geojson', data: gridLines(props.grid ?? 0.5) })
    m.addSource('grid-cells', { type: 'geojson', data: gridCells() })
    // Over the basemap, so the coasts still show
    m.addLayer({ id: 'grid-cells', type: 'fill', source: 'grid-cells', paint: { 'fill-color': '#c9b88f', 'fill-opacity': 0.22 } })
    m.addLayer({
      id: 'grid-lines',
      type: 'line',
      source: 'grid-lines',
      paint: {
        'line-color': ['match', ['get', 'level'], 'axis', '#96141e', '10', '#c2272d', '5', '#546476', '1', '#a09680', '#cdc5b2'],
        'line-width': ['match', ['get', 'level'], 'axis', 2.5, '10', 1.6, '5', 1.4, 1],
        // The finest and 1° lines only once they're far enough apart
        // (zoom outermost: MapLibre allows it nowhere else)
        'line-opacity': [
          'interpolate',
          ['linear'],
          ['zoom'],
          1.5,
          ['match', ['get', 'level'], 'fine', 0, '1', 0, 1],
          3,
          ['match', ['get', 'level'], 'fine', 0.2, 1],
          4.5,
          1,
        ],
      },
    })
    gridStep = props.grid ?? 0.5
    showGrid(m)
    // The same borders as the freehand map's, on top of the basemap and the grid
    m.addSource('borders', { type: 'geojson', data: borderLines(props.borders) })
    m.addLayer({
      id: 'borders',
      type: 'line',
      source: 'borders',
      layout: { 'line-join': 'round' },
      paint: {
        'line-color': '#1d3557',
        'line-opacity': 0.7,
        'line-width': ['interpolate', ['linear'], ['zoom'], 2, 0.6, 8, 1.4],
      },
    })
    showBorderColor(m)
    m.addSource('pins', { type: 'geojson', data: geojson(props.pins) })
    m.addLayer({
      id: 'pins',
      type: 'circle',
      source: 'pins',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, 2.5, 6, 4.5, 10, 6],
        'circle-color': '#e5484d',
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 1.2,
      },
    })
    const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 8, className: 'day22-popup' })
    m.on('mouseenter', 'pins', (e) => {
      const f = e.features?.[0]
      if (!f) return
      const [lng, lat] = (f.geometry as GeoJSON.Point).coordinates as [number, number]
      popup.setLngLat([lng, lat]).setHTML(`<strong>${f.properties.name}</strong><br>${fmtLngLat(lng, lat)}`).addTo(m)
    })
    m.on('mouseleave', 'pins', () => popup.remove())
    showPicked()
  })

  m.on('click', (e) => {
    const ll = e.lngLat.wrap()
    emit('pick', ll.lng, ll.lat)
  })

  m.on('movestart', (e) => {
    if (e.originalEvent) moved = true
  })
  observer = new ResizeObserver(() => {
    m.resize()
    if (!moved) frame(m)
  })
  observer.observe(el.value!)
})

watch(
  () => props.view,
  () => map && frame(map),
)
watch(
  () => props.pins,
  (pins) => (map?.getSource('pins') as maplibregl.GeoJSONSource | undefined)?.setData(geojson(pins)),
)
watch(() => props.picked, showPicked)
watch(
  () => props.borders,
  (rings) => (map?.getSource('borders') as maplibregl.GeoJSONSource | undefined)?.setData(borderLines(rings)),
)
let gridStep = 0
watch(
  () => props.grid,
  (step) => {
    if (!map?.getLayer('grid-lines')) return
    // Lines at the new step (0.2° for Japan, 0.5° for the world)
    if (step && step !== gridStep) {
      gridStep = step
      ;(map.getSource('grid-lines') as maplibregl.GeoJSONSource).setData(gridLines(step))
    }
    showGrid(map)
  },
)
watch(
  () => props.imagery,
  (im) => {
    if (!map?.isStyleLoaded()) return
    map.setLayoutProperty('papers', 'visibility', im === 'papers' ? 'visible' : 'none')
    map.setLayoutProperty('bluemarble', 'visibility', im === 'bluemarble' ? 'visible' : 'none')
    if (map.getLayer('borders')) showBorderColor(map)
  },
)

onBeforeUnmount(() => {
  observer?.disconnect()
  map?.remove()
  map = undefined
})
</script>

<template>
  <div ref="el" class="mercator-map" />
</template>

<style scoped>
.mercator-map {
  width: 100%;
  height: 100%;
  background: #cfe4ea;
}
</style>

<style>
/* Made by script, so not scoped */
.day22-marker {
  pointer-events: none;
}

.day22-marker .drop {
  display: flex;
  flex-direction: column;
  align-items: center;
  animation: day22-drop 0.55s cubic-bezier(0.3, 0.7, 0.4, 1.2) both;
}

.day22-marker .tag {
  margin-bottom: 4px;
  padding: 4px 9px;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  color: #4a607a;
  background: rgba(255, 255, 255, 0.94);
  border-radius: 6px;
  box-shadow: 0 2px 8px rgba(29, 53, 87, 0.2);
}

.day22-marker svg {
  display: block;
}

@keyframes day22-drop {
  from {
    transform: translateY(-36px);
    opacity: 0;
  }
  40% {
    opacity: 1;
  }
}

.day22-popup .maplibregl-popup-content {
  padding: 4px 9px;
  font-size: 12px;
  line-height: 1.35;
  color: #1d3557;
  border-radius: 6px;
}
</style>
