<script setup lang="ts">
// Day 6: Vintage — GSI's seamless aerial photo of Kanto aging into an old sepia print:
// it crumples and yellows in from the edges; then time rewinds and it starts over.
// Plain Three.js: the map is a sheet of paper here, not a globe.
import {
  DataUtils,
  DoubleSide,
  CanvasTexture,
  Color,
  HalfFloatType,
  LinearFilter,
  Mesh,
  OrthographicCamera,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  Spherical,
  Vector3,
  WebGLRenderer,
  WebGLRenderTarget,
} from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import common from './lib/shaders/vintageCommon.glsl?raw'
import paperVert from './lib/shaders/vintagePaper.vert.glsl?raw'
import paperFrag from './lib/shaders/vintagePaper.frag.glsl?raw'
import deskVert from './lib/shaders/vintageDesk.vert.glsl?raw'
import deskFrag from './lib/shaders/vintageDesk.frag.glsl?raw'
import crumpleFrag from './lib/shaders/vintageCrumple.frag.glsl?raw'

const TILE_URL = 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg'
const ZOOM = 10
// Kanto: from the Izu peninsula's root and Chichibu out to Choshi, Sagami Bay up to Nikko
const BBOX = { west: 138.55, south: 34.85, east: 141.0, north: 37.0 }
const DESK = '#1a110a'

const container = ref<HTMLDivElement>()
const autoCamera = ref(true)
let setAutoCamera: ((on: boolean) => void) | undefined
let dispose: (() => void) | undefined

// Web Mercator pixel coordinates at ZOOM
const worldPx = 256 * 2 ** ZOOM
const lngToPx = (lng: number) => ((lng + 180) / 360) * worldPx
const latToPx = (lat: number) => {
  const s = Math.sin((lat * Math.PI) / 180)
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * worldPx
}

function loadImage(url: string): Promise<HTMLImageElement | undefined> {
  return new Promise((resolve) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => resolve(undefined) // a missing tile stays sea-blue
    img.src = url
  })
}

// The tiles covering BBOX, stitched and cropped onto one canvas
async function stitch(): Promise<HTMLCanvasElement> {
  const x0 = lngToPx(BBOX.west)
  const x1 = lngToPx(BBOX.east)
  const y0 = latToPx(BBOX.north)
  const y1 = latToPx(BBOX.south)
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(x1 - x0)
  canvas.height = Math.round(y1 - y0)
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#1d3446'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  const jobs: Promise<void>[] = []
  for (let ty = Math.floor(y0 / 256); ty <= Math.floor(y1 / 256); ty++) {
    for (let tx = Math.floor(x0 / 256); tx <= Math.floor(x1 / 256); tx++) {
      const url = TILE_URL.replace('{z}', String(ZOOM)).replace('{x}', String(tx)).replace('{y}', String(ty))
      jobs.push(loadImage(url).then((img) => img && ctx.drawImage(img, tx * 256 - x0, ty * 256 - y0)))
    }
  }
  await Promise.all(jobs)
  return canvas
}

// The crumple, baked once on the GPU into a height map (see vintageCrumple.frag.glsl), and its
// lowest point, so the sheet can rest on the desk
function bakeCrumple(renderer: WebGLRenderer, aspect: number, size = 1024): { target: WebGLRenderTarget; min: number } {
  const target = new WebGLRenderTarget(size, size, { type: HalfFloatType, magFilter: LinearFilter, minFilter: LinearFilter, depthBuffer: false })
  const quad = new Mesh(
    new PlaneGeometry(2, 2),
    new ShaderMaterial({
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: common + crumpleFrag,
      uniforms: { uAspect: { value: aspect } },
    }),
  )
  renderer.setRenderTarget(target)
  renderer.render(quad, new OrthographicCamera())
  renderer.setRenderTarget(null)
  quad.geometry.dispose()
  quad.material.dispose()
  const pixels = new Uint16Array(size * size * 4)
  renderer.readRenderTargetPixels(target, 0, 0, size, size, pixels)
  let min = Infinity
  for (let k = 0; k < pixels.length; k += 4) min = Math.min(min, DataUtils.fromHalfFloat(pixels[k]!))
  return { target, min }
}

const smooth = (a: number, b: number, t: number) => {
  const x = Math.min(1, Math.max(0, (t - a) / (b - a)))
  return x * x * (3 - 2 * x)
}

// One round of the story (s): from the start the photo slowly crumples as it yellows; a pause;
// then time rewinds
const ROUND_S = 30
function story(t: number) {
  const back = 1 - smooth(24, 29, t)
  // Easing out: the crumpling shows from the first seconds and settles in
  const crumpling = 1 - (1 - Math.min(1, Math.max(0, (t - 0.5) / 14))) ** 3
  return {
    sepia: smooth(1.5, 10, t) * back,
    crumple: 0.8 * crumpling * back,
    camera: smooth(4, 13, t) * back,
  }
}

onMounted(async () => {
  const el = container.value!
  const renderer = new WebGLRenderer({ antialias: true })
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  renderer.setClearColor(new Color(DESK))
  el.appendChild(renderer.domElement)

  const scene = new Scene()
  const camera = new PerspectiveCamera(30, 1, 0.01, 50)
  const controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.maxPolarAngle = 1.35
  controls.minDistance = 0.3
  controls.maxDistance = 6

  let disposed = false
  let crumpleTarget: WebGLRenderTarget | undefined
  dispose = () => {
    disposed = true
    cancelAnimationFrame(frame)
    observer.disconnect()
    controls.dispose()
    scene.traverse((o) => {
      if (o instanceof Mesh) {
        o.geometry.dispose()
        const m = o.material as ShaderMaterial
        for (const u of Object.values(m.uniforms)) (u.value as { dispose?: () => void })?.dispose?.()
        m.dispose()
      }
    })
    crumpleTarget?.dispose()
    renderer.dispose()
    renderer.domElement.remove()
  }

  const resize = () => {
    const { clientWidth: w, clientHeight: h } = el
    renderer.setSize(w, h)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
  }
  const observer = new ResizeObserver(resize)
  observer.observe(el)
  resize()
  let frame = 0

  const canvas = await stitch()
  if (disposed) return
  const aspect = canvas.width / canvas.height
  const map = new CanvasTexture(canvas)
  map.anisotropy = renderer.capabilities.getMaxAnisotropy()
  const crumple = bakeCrumple(renderer, aspect)
  crumpleTarget = crumple.target

  // Uniforms shared by the paper and the desk (for its shadow)
  const uAspect = { value: aspect }
  const uCrumple = { value: 0 }
  const paper = new Mesh(
    new PlaneGeometry(aspect, 1, Math.round(400 * aspect), 400).translate(aspect / 2, 0.5, 0),
    new ShaderMaterial({
      vertexShader: common + paperVert,
      fragmentShader: common + paperFrag,
      side: DoubleSide,
      uniforms: {
        uAspect,
        uCrumple,
        uMap: { value: map },
        uHeight: { value: crumple.target.texture },
        uHeightMin: { value: crumple.min },
        uTexel: { value: [1 / crumple.target.width, 1 / crumple.target.height] },
        uSepia: { value: 0 },
        uRelief: { value: 2.6 },
        // Light from the north-west, high up (paper space: x east, y north, z up)
        uLight: { value: new Vector3(-0.4, 0.5, 0.75).normalize() },
      },
    }),
  )
  // Paper space -> world: lying on the desk (y up), north toward -z, centered
  paper.rotation.x = -Math.PI / 2
  paper.position.set(-aspect / 2, 0, 0.5)
  scene.add(paper)

  const desk = new Mesh(
    new PlaneGeometry(14, 14).rotateX(-Math.PI / 2),
    new ShaderMaterial({ vertexShader: common + deskVert, fragmentShader: common + deskFrag, uniforms: { uAspect, uCrumple } }),
  )
  scene.add(desk)

  // Camera: from straight above with the photo filling the screen, back and down to a view
  // of the whole sheet on the desk
  const halfTan = Math.tan((camera.fov * Math.PI) / 360)
  const pose = (k: number, t: number) => {
    const fill = Math.min(1, aspect / camera.aspect) / (2 * halfTan)
    const whole = Math.max(1, aspect / camera.aspect) / (2 * halfTan)
    const drift = 0.08 * Math.sin(t * 0.25) * k
    return new Vector3().setFromSpherical(
      new Spherical(fill * 0.97 + (whole * 1.2 - fill * 0.97) * k, 0.001 + 0.75 * k, 0.22 * k + drift),
    )
  }

  // Grabbing the camera hands it over; turning auto back on eases it home
  let blendFrom: Vector3 | undefined
  let blend = 1
  const grab = () => autoCamera.value && setAutoCamera?.(false)
  for (const type of ['pointerdown', 'wheel', 'touchstart'] as const) {
    renderer.domElement.addEventListener(type, grab, { passive: true })
  }
  setAutoCamera = (on) => {
    autoCamera.value = on
    if (on) {
      blendFrom = camera.position.clone()
      blend = 0
    }
  }

  let t = 0
  let last = performance.now()
  const tick = (now: number) => {
    frame = requestAnimationFrame(tick)
    t = (t + Math.min(0.1, (now - last) / 1000)) % ROUND_S
    last = now
    const s = story(t)
    paper.material.uniforms.uSepia!.value = s.sepia
    uCrumple.value = s.crumple
    if (autoCamera.value) {
      const target = pose(s.camera, t)
      if (blendFrom) {
        blend = Math.min(1, blend + 0.012)
        target.lerp(blendFrom, 1 - smooth(0, 1, blend))
        if (blend >= 1) blendFrom = undefined
      }
      camera.position.copy(target)
      camera.lookAt(0, 0, 0)
      controls.target.set(0, 0, 0)
    } else {
      controls.update()
    }
    renderer.render(scene, camera)
  }
  frame = requestAnimationFrame(tick)
})

onBeforeUnmount(() => {
  setAutoCamera = undefined
  dispose?.()
  dispose = undefined
})
</script>

<template>
  <div class="map-canvas day06">
    <div ref="container" class="map-canvas" />
    <div class="controls">
      <button type="button" class="chip" :aria-pressed="autoCamera" @click="setAutoCamera?.(!autoCamera)">
        {{ autoCamera ? '❚❚ Stop camera' : '▶ Auto camera' }}
      </button>
    </div>
    <div class="attribution">
      <a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">出典：国土地理院（シームレス空中写真）</a>
    </div>
  </div>
</template>

<style scoped>
.day06 {
  position: relative;
}

.controls {
  position: absolute;
  top: 12px;
  right: 12px;
  z-index: 10;
}

/* Matches the page's header panel */
.chip {
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

.chip:hover {
  color: var(--accent);
}

.attribution {
  position: absolute;
  right: 0;
  bottom: 0;
  padding: 2px 6px;
  font-size: 11px;
  background: rgba(255, 255, 255, 0.7);
}

.attribution a {
  color: #333;
}
</style>
