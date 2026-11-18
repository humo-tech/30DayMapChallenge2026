<script setup lang="ts">
// Day 19: Senses: Smell — a slice of bread with Japan cut out of foil over it, buttered and
// toasted, photo by photo; the toast's burnt Japan pinned to the real one, its coast picked out,
// warm off the toaster, and then the camera pulls back and the slice turns into a whole globe of
// toast.
// Photos: scripts/day19/prepare_photos.py; the land and where the photos sit: toast_globe.py
import ThreeView, { Color } from '@navaramap/three'
import { DefaultPlugin, type DefaultDescriptions } from '@navaramap/three-default-plugin'
import { Color as ThreeColor, LinearFilter, SRGBColorSpace, TextureLoader, type Texture } from 'three'
import { LimbGlowMeshDesc, type LimbGlowConfig } from './lib/LimbGlowMeshDesc'
import { ToastGlobeMeshDesc, type ToastGlobeConfig } from './lib/ToastGlobeMeshDesc'

const baseURL = useRuntimeConfig().app.baseURL
const dataBase = `${baseURL}data/day19`

// A warm dark round it all, like the inside of the toaster, and the glow of its heat
const BACKGROUND = '#1b120c'
const GLOW = '#ffa040'
// A long lens: the photo stays near enough flat on the globe
const FOV = 24

// The run, in s. The photos flip by (the plain slice held a little longer); the plate goes, the
// coast lights up, then the camera pulls back as the globe comes up round the slice and the slice
// melts into it; the globe turns, and the screen goes dark before it all starts over
const FIRST = 0.9
const FLIP = 0.4
const PLATE = [6.4, 7.6]
const EDGE = [7.4, 8.6]
const PULL = [9.0, 16.5]
const GLOBE = [9.6, 11.8]
const MELT = [11.2, 13.8]
// The heat coming off the toast once it's out
const HEAT = [5.4, 6.6]
const SPIN = 13.0 // the globe starts turning
const END = 27.5
const FADE = 1.2
// Turning, deg/s of longitude at full speed (westward, over Asia rather than the open Pacific);
// the view drifts south as it goes
const SPIN_SPEED = -4.5
const SPIN_LAT = 22

type Meta = { count: number; bread: { x0: number; y0: number; x1: number; y1: number } }
type LngLat = { lng: number; lat: number }
type Toast = { frame: { a: number; c: number; tx: number; ty: number }; projection: LngLat; center: LngLat; width: number }

const route = useRoute()
const container = ref<HTMLDivElement>()
const dark = ref(1)
let view: ThreeView<DefaultDescriptions> | undefined

const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x))
const ramp = ([a, b]: number[], t: number) => smooth((t - a!) / (b! - a!))

async function loadData() {
  const json = <T,>(name: string) => fetch(`${dataBase}/${name}`).then((r) => r.json() as Promise<T>)
  const [meta, toast] = await Promise.all([json<Meta>('frames.json'), json<Toast>('toast.json')])
  const loader = new TextureLoader()
  const pad = (i: number) => String(i).padStart(2, '0')
  const [land, breadLand, crumb, toasted, slice, ...frames] = await Promise.all([
    loader.loadAsync(`${dataBase}/land_globe.png`),
    loader.loadAsync(`${dataBase}/land_bread.png`),
    loader.loadAsync(`${dataBase}/crumb.jpg`),
    loader.loadAsync(`${dataBase}/toasted.jpg`),
    loader.loadAsync(`${dataBase}/slice.png`),
    ...Array.from({ length: meta.count }, (_, i) => loader.loadAsync(`${dataBase}/frames/${pad(i)}.jpg`)),
  ])
  frames.forEach((t, i) => {
    t.colorSpace = SRGBColorSpace
    // Only the last one is seen from far off: the rest need no mipmaps
    t.generateMipmaps = i === frames.length - 1
    if (!t.generateMipmaps) t.minFilter = LinearFilter
    t.anisotropy = 8
  })
  return { meta, toast, land, breadLand, crumb, toasted, slice, frames: frames as Texture[] }
}

/** The camera's height (m) to see `extent` m across the screen's narrower side, looking straight down */
function heightFor(extent: number): number {
  const aspect = window.innerWidth / window.innerHeight
  const half = Math.atan(Math.tan(((FOV / 2) * Math.PI) / 180) * Math.min(aspect, 1))
  return extent / 2 / Math.tan(half)
}
/** ... and to see the whole globe, with a margin */
function heightForGlobe(): number {
  const aspect = window.innerWidth / window.innerHeight
  const half = Math.atan(Math.tan(((FOV / 2) * Math.PI) / 180) * Math.min(aspect, 1))
  const r = 6_371_000
  return r / Math.sin(half * 0.8) - r
}

onMounted(async () => {
  const data = await loadData()
  if (!container.value) return // unmounted while loading

  const v = new ThreeView<DefaultDescriptions>({
    container: container.value,
    backgroundColor: new Color().setStyle(BACKGROUND),
    animation: true,
    pixelRatio: Math.min(window.devicePixelRatio || 1, 3),
  })
  view = v
  v.addPlugin(new DefaultPlugin())
  await v.init()
  if (view !== v) return // unmounted while initializing
  v.registerMesh('toastGlobe', ToastGlobeMeshDesc)
  v.registerMesh('limbGlow', LimbGlowMeshDesc)
  v.globe.color = new Color().setStyle(BACKGROUND)
  v.camera.fov = FOV

  const { center } = data.toast
  const b = data.meta.bread
  const globeConfig: ToastGlobeConfig = {
    toastGlobe: {
      land: data.land,
      breadLand: data.breadLand,
      crumb: data.crumb,
      toasted: data.toasted,
      slice: data.slice,
      frame: data.toast.frame,
      projection: data.toast.projection,
      background: new ThreeColor(BACKGROUND),
    },
  }
  const globe = v.addMesh<ToastGlobeMeshDesc>(globeConfig)
  const glowConfig: LimbGlowConfig = { limbGlow: { color: new Color().setStyle(GLOW), intensity: 0, scaleHeight: 140_000 } }
  const glow = v.addMesh<LimbGlowMeshDesc>(glowConfig)

  v.attribution?.add([
    {
      attributionHtml:
        'Land: © <a href="https://overturemaps.org/">Overture Maps Foundation</a> · <a href="https://www.naturalearthdata.com/">Natural Earth</a>',
    },
  ])

  // The photo's slice (a bit more than it) across the screen, and then the whole globe
  const near = heightFor(data.toast.width * (b.x1 - b.x0) * 1.25)
  const far = heightForGlobe()
  // The photo is turned a little off north on the map: start turned with it, so the slice sits square
  const tilt = (Math.atan2(data.toast.frame.c, data.toast.frame.a) * 180) / Math.PI
  const frameAt = (t: number) => (t < FIRST ? 0 : Math.min(1 + Math.floor((t - FIRST) / FLIP), data.frames.length - 1))

  // ?t=<s> starts that far in, and ?pause holds it there, for tuning
  const startAt = Number(route.query.t) || 0
  const paused = route.query.pause !== undefined
  const clock = performance.now() - startAt * 1000
  let shown = -1
  let glowShown = -1

  v.on('preUpdate', () => {
    const now = paused ? startAt : (performance.now() - clock) / 1000
    const t = now % END

    const k = frameAt(t)
    if (k !== shown) {
      globe.ref.setPhoto(data.frames[k]!)
      shown = k
    }
    const pull = ramp(PULL, t)
    const show = ramp(GLOBE, t)
    globe.ref.setState({ photo: 1 - ramp(MELT, t), plate: 1 - ramp(PLATE, t), globe: show, edge: ramp(EDGE, t), heat: ramp(HEAT, t) * (1 - ramp(MELT, t)) }, now)

    // Pull back (evenly in log height), and once out, turn the globe and drift south
    const height = Math.exp(Math.log(near) + (Math.log(far) - Math.log(near)) * pull)
    const spun = Math.max(t - SPIN, 0)
    const lng = center.lng + SPIN_SPEED * (spun - 2 * (1 - Math.exp(-spun / 2)))
    const lat = center.lat + (SPIN_LAT - center.lat) * ramp([SPIN, END], t)
    v.setCamera({ lng, lat, height, heading: -tilt * (1 - pull), pitch: -90, roll: 0 })

    const glowNow = Math.round(show * 50) / 100
    if (glowNow !== glowShown) {
      glow.update({ limbGlow: { intensity: glowNow } })
      glowShown = glowNow
    }
    // Dark at the very start, and again at the end before it starts over
    dark.value = Math.max(1 - smooth(t / 0.6), smooth((t - (END - FADE)) / FADE))
  })
})

onBeforeUnmount(() => {
  view?.dispose()
  view = undefined
})
</script>

<template>
  <div class="map-canvas day19">
    <div ref="container" class="map-canvas" />
    <div class="dark" :style="{ opacity: dark }" />
  </div>
</template>

<style scoped>
.day19 {
  position: relative;
}

.dark {
  position: absolute;
  inset: 0;
  z-index: 5;
  pointer-events: none;
  background: #1b120c;
}
</style>
