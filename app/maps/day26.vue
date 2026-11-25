<script setup lang="ts">
// Day 26: Water — the sea under Typhoon Champi (October 2026), hour by hour from 15 to 26
// October, the camera going along with the storm. The sea as Day 12's fluid, stirred by the
// waves of ECMWF's wave model at the time (every 3 hours, blended between), lighter the more
// power they carry: the storm whips up its own sea as it goes; and colored by the sea's
// temperature (NOAA OISST, a day at a time, blended between): across the warm Philippine Sea it
// grows to a super typhoon, and leaves the sea a few degrees cooler behind it (its cold wake),
// then weakens over cooler water past Okinawa. The land in relief, tinted by height; the storm's
// track on the sea; in the corner, a minimap: Himawari-9's infrared scene itself, flat.
// (The first take, the storm's clouds in 3D, is shelved on the hidden page /day/26-clouds.)
// Data: scripts/day26/fetch_champi.py, fetch_waves.py, fetch_sst.py
import ThreeView, { Color, TERRARIUM_ELEVATION_DECODER, geodeticToVector3 } from '@navaramap/three'
import { DefaultPlugin, type DefaultDescriptions } from '@navaramap/three-default-plugin'
import { TileJsonPlugin } from '@navaramap/three-plugins'
import type GUI from 'lil-gui'
import { Vector3 } from 'three'
import { LimbGlowMeshDesc, type LimbGlowConfig } from './lib/LimbGlowMeshDesc'
import { StarfieldMeshDesc, type StarfieldConfig } from './lib/StarfieldMeshDesc'
import { HimawariMinimap } from './lib/himawariMinimap'
import { WaveFluidMeshDesc, type WaveFluidConfig } from './lib/WaveFluidMeshDesc'
import { loadChampiScenes, loadSst, loadWaves, stormAt } from './lib/typhoon'
import { TrackMeshDesc, type TrackConfig } from './lib/typhoonTrack'

const dataBase = `${useRuntimeConfig().app.baseURL}data/day26`

// Day 12's night
const NIGHT = '#03060f'
const LAND_TINT = new Color().setStyle('#5d6680')
// The land's relief: Mapterhorn's DEM (Terrarium), 12 times taller than life, lit by a sun from the
// south-west, about 30° up over the Philippine Sea
const MAPTERHORN = 'https://tiles.mapterhorn.com/{z}/{x}/{y}.webp'
const TERRAIN_EXAGGERATION = 12
const SUN_AT = new Date('2026-10-20T07:00:00Z')
// The land's tints by height (m, as in life): green lowlands, yellow-green hills, brown mountains,
// pale peaks; the sea (0 m in the DEM) left clear, for the waves and the basemap
const LAND_TINTS: [number, [number, number, number, number]][] = [
  [0.5, [0, 0, 0, 0]],
  [1, [0.17, 0.33, 0.2, 1]],
  [600, [0.32, 0.42, 0.2, 1]],
  [1800, [0.52, 0.42, 0.25, 1]],
  [3500, [0.76, 0.7, 0.6, 1]],
]
const BLOOM = 0.5

// The sea's temperature as the fluid's color: navy where it's too cool to feed a typhoon, through
// teal at the 26.5 °C it needs, to orange and red over the warm pool. (A texel's byte is
// (°C + offset) x scale, as fetch_sst.py writes it)
const sstTint = (offset: number, scale: number) => /* glsl */ `
  vec3 tint(float texel) {
    float t = texel * 255.0 / ${scale.toFixed(4)} - ${offset.toFixed(4)};
    vec3 c = vec3(0.04, 0.1, 0.28);
    c = mix(c, vec3(0.06, 0.26, 0.52), smoothstep(18.0, 23.0, t));
    c = mix(c, vec3(0.08, 0.5, 0.6), smoothstep(23.0, 26.5, t));
    c = mix(c, vec3(0.36, 0.72, 0.5), smoothstep(26.5, 27.6, t));
    c = mix(c, vec3(0.93, 0.8, 0.34), smoothstep(27.6, 28.7, t));
    c = mix(c, vec3(0.96, 0.52, 0.22), smoothstep(28.7, 29.6, t));
    return mix(c, vec3(0.86, 0.22, 0.2), smoothstep(29.6, 30.6, t));
  }
`

// Hours of the storm a second
const RATE = 3.5
// The camera, from the storm: this far back, this high an angle, looking this way
const VIEW = { distance: 2_400_000, pitch: -48, heading: 335 }
const MIN_HEIGHT = 200_000

const container = ref<HTMLDivElement>()
const controls = ref<HTMLDivElement>()
const minimapCanvas = ref<HTMLCanvasElement>()
// The minimap's shape: the scenes' box, width over height (°)
const minimapAspect = ref(1.5)
const loading = ref(true)
const playing = ref(true)
// The sea colored by its temperature, or (off) by the waves' power, as on Day 12
const sstOn = ref(true)
const hour = ref(0)
const span = ref<[number, number]>([0, 1])
const start = ref(0)
const pressure = ref(0)
let view: ThreeView<DefaultDescriptions> | undefined
let gui: GUI | undefined

// "21 Oct 06:00 UTC"
const when = computed(() => {
  const d = new Date(start.value + hour.value * 3_600_000)
  const day = d.getUTCDate()
  const month = d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })
  return `${day} ${month} ${String(d.getUTCHours()).padStart(2, '0')}:00 UTC`
})

onMounted(async () => {
  const champi = await loadChampiScenes(dataBase)
  const start0 = Date.parse(champi.meta.clouds.start)
  const [waves, sst, coast] = await Promise.all([
    loadWaves(dataBase, start0),
    loadSst(dataBase, start0),
    fetch(`${dataBase}/coast.json`).then((r) => r.json() as Promise<[number, number][][]>),
  ])
  if (!container.value) return
  const { meta } = champi
  start.value = start0
  minimapAspect.value = meta.clouds.width / meta.clouds.height
  span.value = [0, (meta.clouds.frames - 1) * meta.clouds.every]
  // ?hour= starts there (hours since 15 Oct 00 UTC), ?play=0 holds it, ?sst=0 shows Day 12's colors
  const query = useRoute().query
  if (query.hour) hour.value = Math.min(span.value[1], Math.max(0, Number(query.hour) || 0))
  if (query.play === '0') playing.value = false
  if (query.sst === '0') sstOn.value = false

  const v = new ThreeView<DefaultDescriptions>({
    container: container.value,
    backgroundColor: new Color().setStyle(NIGHT),
    animation: true,
    pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
  })
  view = v
  v.addPlugin(new DefaultPlugin())
  const tilejson = new TileJsonPlugin()
  v.addPlugin(tilejson)
  await v.init()
  if (view !== v) return
  v.registerMesh('limbGlow', LimbGlowMeshDesc)
  v.registerMesh('starfield', StarfieldMeshDesc)
  v.registerMesh('waveFluid', WaveFluidMeshDesc)
  v.registerMesh('typhoonTrack', TrackMeshDesc)
  v.globe.color = new Color().setStyle(NIGHT)
  const bloom = v.addEffect({ selectiveBloom: { strength: BLOOM, radius: 0.5, threshold: 0 } })

  const limbGlow: LimbGlowConfig = { limbGlow: { color: new Color().setStyle('#3f8cff'), intensity: 0.7, scaleHeight: 80_000 } }
  v.addMesh<LimbGlowMeshDesc>(limbGlow)
  const starfield: StarfieldConfig = { starfield: {} }
  v.addMesh<StarfieldMeshDesc>(starfield)
  // The land in relief: the terrain first, its hillshade's normals so the sun lights it, then the
  // basemap draped over it (the sea beyond the waves, the borders) and the land's tints by height
  const dem = v.addSource({
    type: 'raster-dem',
    url: MAPTERHORN,
    elevationDecoder: TERRARIUM_ELEVATION_DECODER(),
    tileSize: 512,
    // (seen from a couple of thousand km, finer tiles show nothing more and cost a lot)
    maxZoom: 8,
  })
  v.addLayer({ type: 'terrain', source: dem, terrain: { exaggeration: TERRAIN_EXAGGERATION } })
  v.addLayer({ type: 'raster', source: dem, hillshade: {} })
  v.atmosphere.date = SUN_AT
  v.addLight({ ambient: { intensity: 0.45 } })
  v.addLight({ sun: { intensity: 2.2 } })
  const basemap = await tilejson.addSource({
    type: 'raster-tile',
    url: 'https://papers.reearth.land/styles/papers-dark/tilejson.json',
  })
  v.addLayer({ type: 'raster', source: basemap, raster: { color: LAND_TINT } })
  v.addLayer({
    type: 'raster',
    source: dem,
    elevationHeatmap: {
      minHeight: LAND_TINTS[0]![0],
      maxHeight: LAND_TINTS.at(-1)![0],
      colorStops: new Float32Array(LAND_TINTS.map(([h]) => h)),
      colorMap: new Float32Array(LAND_TINTS.flatMap(([, c]) => c)),
    },
  })

  // The sea: Day 12's fluid, stirred by the waves at the hour, colored by the sea's temperature
  waves.at(hour.value)
  sst.at(hour.value)
  const fluidConfig: WaveFluidConfig = {
    effectIds: [bloom.id],
    waveFluid: { grid: waves.grid, tint: { texture: sst.texture, box: sst.box, glsl: sstTint(sst.meta.offset, sst.meta.scale) } },
  }
  const fluid = v.addMesh<WaveFluidMeshDesc>(fluidConfig).ref
  watch(sstOn, (on) => (fluid.tintMix = on ? 1 : 0), { immediate: true })

  // The storm's track
  const trackConfig: TrackConfig = { typhoonTrack: { track: meta.track } }
  const track = v.addMesh<TrackMeshDesc>(trackConfig).ref

  // The camera looks at the storm from VIEW, and then goes along with it, however it's been moved
  // (only once that's taken: till then the camera reads as where it was before)
  let followed = stormAt(meta.track, hour.value)
  let placed = false
  v.camera.on('move', () => (placed = true))
  const pole = geodeticToVector3({ lng: 0, lat: 90, height: 0 }).normalize()
  // ?view=distance(km),pitch,heading sets it up otherwise
  const asked = String(query.view ?? '').split(',').map(Number)
  const view0 = asked.length === 3 && asked.every(Number.isFinite) ? { distance: asked[0]! * 1000, pitch: asked[1]!, heading: asked[2]! } : VIEW
  v.setCamera({ lng: followed.lon, lat: followed.lat, height: 0, ...view0, roll: 0 })

  if (query.gui === '1') {
    const { default: GUI } = await import('lil-gui')
    gui = new GUI({ container: controls.value, title: 'Parameters', width: 280 })
    const bloomHandle = bloom as unknown as { update(u: { selectiveBloom: { strength: number } }): void }
    gui.add({ bloom: BLOOM }, 'bloom', 0, 2, 0.05).onChange((x: number) => bloomHandle.update({ selectiveBloom: { strength: x } }))
  }

  // (made once its canvas is in the page: it shows once loading is done)
  let minimap: HimawariMinimap | undefined
  let last = performance.now()
  v.on('preUpdate', () => {
    const now = performance.now()
    const dt = Math.min(0.1, (now - last) / 1000)
    last = now
    if (playing.value) {
      hour.value += dt * RATE
      if (hour.value > span.value[1]) hour.value = span.value[0]
    }
    if (waves.at(hour.value)) fluid.updateGrid(waves.grid.data)
    sst.at(hour.value)
    fluid.step(dt, v.camera.raw)
    track.tick(hour.value)
    if (minimapCanvas.value) (minimap ??= new HimawariMinimap(minimapCanvas.value, champi, coast)).draw(hour.value)
    const storm = stormAt(meta.track, hour.value)
    pressure.value = Math.round(storm.pressure)
    // Along with the storm: where the camera is from the storm (how far, which way, how high an
    // angle, in the storm's own east, north, up) is kept as the storm moves, so it goes on
    // looking at it however far it goes; turned or zoomed by hand, it keeps that too
    const at = v.camera.positionGeographic
    const moved = storm.lon !== followed.lon || storm.lat !== followed.lat
    if (placed && (moved || at.height < MIN_HEIGHT)) {
      const from = geodeticToVector3({ lng: followed.lon, lat: followed.lat, height: 0 })
      const up = geodeticToVector3({ lng: followed.lon, lat: followed.lat, height: 1 }).sub(from).normalize()
      const east = new Vector3().crossVectors(pole, up).normalize()
      const north = new Vector3().crossVectors(up, east)
      const { x, y, z } = v.camera.positionECEF
      const rel = new Vector3(x, y, z).sub(from)
      const distance = Math.max(rel.length(), MIN_HEIGHT)
      // (the way the camera looks at the storm: from it, back along rel)
      const heading = ((Math.atan2(-rel.dot(east), -rel.dot(north)) * 180) / Math.PI + 360) % 360
      const pitch = (-Math.asin(Math.min(1, Math.max(-1, rel.dot(up) / rel.length()))) * 180) / Math.PI
      v.setCamera({ lng: storm.lon, lat: storm.lat, height: 0, distance, heading, pitch, roll: 0 })
    }
    followed = storm
  })

  v.attribution?.add([
    {
      attributionHtml:
        'Waves: <a href="https://www.ecmwf.int/en/forecasts/datasets/open-data">ECMWF open data</a> (IFS), CC BY 4.0 · Sea surface temperature: <a href="https://www.ncei.noaa.gov/products/optimum-interpolation-sst">NOAA OISST v2.1</a> · Track: <a href="https://www.ncei.noaa.gov/products/international-best-track-archive">IBTrACS v04r01</a> · Minimap: Himawari-9 (JMA) via <a href="https://registry.opendata.aws/noaa-himawari/">NOAA open data on AWS</a> · Terrain: <a href="https://mapterhorn.com">Mapterhorn</a>',
    },
  ])
  loading.value = false
})

onBeforeUnmount(() => {
  gui?.destroy()
  gui = undefined
  view?.dispose()
  view = undefined
})
</script>

<template>
  <div class="map-canvas day26">
    <div ref="container" class="map-canvas" />
    <div ref="controls" class="controls" />
    <figure v-if="!loading" class="minimap">
      <canvas ref="minimapCanvas" :style="{ aspectRatio: minimapAspect }" />
      <figcaption>Himawari-9 IR</figcaption>
    </figure>
    <div v-if="!loading" class="timeline">
      <button type="button" class="play" :aria-label="playing ? 'Pause' : 'Play'" @click="playing = !playing">
        {{ playing ? '❚❚' : '▶' }}
      </button>
      <input
        v-model.number="hour"
        type="range"
        :min="span[0]"
        :max="span[1]"
        step="0.25"
        aria-label="Time"
        @pointerdown="playing = false"
      />
      <span class="when">{{ when }}</span>
      <span class="hpa">{{ pressure }} hPa</span>
      <button
        type="button"
        class="toggle"
        :aria-pressed="sstOn"
        :aria-label="sstOn ? 'Color the sea by the waves' : 'Color the sea by its temperature'"
        @click="sstOn = !sstOn"
      >
        <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
          <path d="M8 3.5a2 2 0 0 1 4 0v7.2a4 4 0 1 1-4 0z" fill="none" stroke="currentColor" stroke-width="1.8" />
          <circle cx="10" cy="14" r="1.8" fill="currentColor" />
        </svg>
      </button>
    </div>
    <div v-if="loading" class="loading">Loading…</div>
  </div>
</template>

<style scoped>
.day26 {
  position: relative;
}

.controls {
  position: absolute;
  top: 12px;
  right: 12px;
  z-index: 10;
}

/* Matches the page's header panel */
.timeline {
  position: absolute;
  left: 50%;
  bottom: 36px;
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 10px;
  width: min(640px, calc(100% - 24px));
  padding: 6px 10px;
  transform: translateX(-50%);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  color: var(--fg);
  background: rgba(15, 20, 25, 0.82);
  backdrop-filter: blur(6px);
  border: 1px solid var(--border);
  border-radius: 10px;
}

.timeline input {
  flex: 1;
  min-width: 60px;
  accent-color: var(--accent);
}

.timeline button {
  width: 30px;
  height: 30px;
  padding: 0;
  font: inherit;
  font-size: 14px;
  color: var(--fg);
  background: none;
  border: 0;
  border-radius: 7px;
  cursor: pointer;
}

.timeline button:hover {
  color: var(--accent);
}

/* (a drawn icon, centred) */
.timeline .toggle {
  display: grid;
  place-items: center;
  font-size: 17px;
  line-height: 1;
}

.timeline .toggle[aria-pressed='true'] {
  color: var(--bg);
  background: var(--accent);
}

.when {
  min-width: 108px;
}

.hpa {
  min-width: 64px;
  color: var(--fg-muted);
}

.minimap {
  position: absolute;
  left: 12px;
  bottom: 36px;
  z-index: 10;
  margin: 0;
  padding: 4px;
  background: rgba(15, 20, 25, 0.82);
  border: 1px solid var(--border);
  border-radius: 10px;
}

/* (as tall as the scenes' box is, for its width) */
.minimap canvas {
  display: block;
  width: 280px;
  border-radius: 7px;
}

.minimap figcaption {
  position: absolute;
  left: 10px;
  top: 7px;
  font-size: 10px;
  color: rgba(255, 255, 255, 0.7);
  pointer-events: none;
}

.loading {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: var(--fg-muted);
  pointer-events: none;
}

@media (max-width: 560px) {
  .hpa {
    display: none;
  }

  /* Above the timeline */
  .minimap {
    bottom: 92px;
  }

  .minimap canvas {
    width: 164px;
  }
}
</style>
