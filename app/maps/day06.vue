<script setup lang="ts">
// Day 6: Vintage — GSI's seamless aerial photo of Kanto aging into an old sepia print:
// it yellows in from the edges, gets crumpled, and tears; then time rewinds and it starts over.
// Plain Three.js: the map is a sheet of paper here, not a globe.
import {
  DataTexture,
  DataUtils,
  DoubleSide,
  CanvasTexture,
  Color,
  HalfFloatType,
  LinearFilter,
  Mesh,
  PerspectiveCamera,
  PlaneGeometry,
  RGFormat,
  Scene,
  ShaderMaterial,
  Spherical,
  Vector3,
  WebGLRenderer,
} from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import common from './lib/shaders/vintageCommon.glsl?raw'
import paperVert from './lib/shaders/vintagePaper.vert.glsl?raw'
import paperFrag from './lib/shaders/vintagePaper.frag.glsl?raw'
import deskVert from './lib/shaders/vintageDesk.vert.glsl?raw'
import deskFrag from './lib/shaders/vintageDesk.frag.glsl?raw'

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

function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// The crumple as a height map over the sheet (R: height, G: how worn the crease is).
// Old-map folds (two across, one down the middle) plus a crowd of shorter random creases, each a
// kinked ridge or valley that fades out along its length. Heights are shifted to start at 0 so
// the sheet rests on the desk.
function crumpleTexture(aspect: number, size = 1024): DataTexture {
  const h = new Float32Array(size * size)
  const wear = new Float32Array(size * size)
  const rand = mulberry32(6)
  type Crease = { cx: number; cy: number; dx: number; dy: number; half: number; reach: number; amp: number }
  const creases: Crease[] = [
    { cx: aspect / 3, cy: 0.5, dx: 0, dy: 1, half: 0.8, reach: 0.2, amp: 0.012 },
    { cx: (aspect * 2) / 3, cy: 0.5, dx: 0, dy: 1, half: 0.8, reach: 0.2, amp: -0.012 },
    { cx: aspect / 2, cy: 0.5, dx: 1, dy: 0, half: aspect, reach: 0.22, amp: 0.01 },
  ]
  for (let i = 0; i < 260; i++) {
    const a = rand() * Math.PI
    creases.push({
      cx: -0.05 + rand() * (aspect + 0.1),
      cy: -0.05 + rand() * 1.1,
      dx: Math.cos(a),
      dy: Math.sin(a),
      half: 0.04 + rand() * 0.2,
      reach: 0.02 + rand() * 0.07,
      amp: (rand() < 0.5 ? -1 : 1) * (0.001 + rand() * 0.004),
    })
  }
  const WEAR_W = 0.003
  for (const c of creases) {
    // Only visit the pixels within reach of the crease's segment
    const ex = Math.abs(c.dx) * c.half + c.reach
    const ey = Math.abs(c.dy) * c.half + c.reach
    const i0 = Math.max(0, Math.floor(((c.cx - ex) / aspect) * size))
    const i1 = Math.min(size - 1, Math.ceil(((c.cx + ex) / aspect) * size))
    const j0 = Math.max(0, Math.floor((c.cy - ey) * size))
    const j1 = Math.min(size - 1, Math.ceil((c.cy + ey) * size))
    for (let j = j0; j <= j1; j++) {
      const py = (j + 0.5) / size - c.cy
      for (let i = i0; i <= i1; i++) {
        const px = ((i + 0.5) / size) * aspect - c.cx
        const across = Math.abs(px * -c.dy + py * c.dx)
        const along = Math.abs(px * c.dx + py * c.dy)
        if (across >= c.reach || along >= c.half) continue
        const tail = Math.min(1, (c.half - along) / (c.half * 0.5))
        const fade = tail * tail * (3 - 2 * tail)
        const r = 1 - across / c.reach
        h[j * size + i]! += c.amp * r * r * fade
        if (across < WEAR_W) {
          const k = (1 - across / WEAR_W) * fade * Math.min(1, Math.abs(c.amp) / 0.012) ** 2
          wear[j * size + i] = Math.max(wear[j * size + i]!, k)
        }
      }
    }
  }
  let min = Infinity
  for (const v of h) min = Math.min(min, v)
  const data = new Uint16Array(size * size * 2)
  for (let k = 0; k < size * size; k++) {
    data[k * 2] = DataUtils.toHalfFloat(h[k]! - min)
    data[k * 2 + 1] = DataUtils.toHalfFloat(wear[k]!)
  }
  const tex = new DataTexture(data, size, size, RGFormat, HalfFloatType)
  tex.magFilter = LinearFilter
  tex.minFilter = LinearFilter
  tex.needsUpdate = true
  return tex
}

const smooth = (a: number, b: number, t: number) => {
  const x = Math.min(1, Math.max(0, (t - a) / (b - a)))
  return x * x * (3 - 2 * x)
}

// One round of the story (s): fresh photo -> yellowing -> crumpled (a sudden scrunch, then
// smoothed out a little) -> torn; a pause; then time rewinds
const ROUND_S = 30
function story(t: number) {
  const back = 1 - smooth(24, 29, t)
  const scrunch = smooth(8, 9.2, t)
  return {
    sepia: smooth(1.5, 10, t) * back,
    crumple: scrunch * (1 - 0.35 * smooth(9.2, 12, t)) * back,
    tear: smooth(11.5, 16, t) * back,
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
  const height = crumpleTexture(aspect)

  // Uniforms shared by the paper and the desk (its shadow follows the tear)
  const uAspect = { value: aspect }
  const uTear = { value: 0 }
  const uCrumple = { value: 0 }
  const paper = new Mesh(
    new PlaneGeometry(aspect, 1, Math.round(400 * aspect), 400).translate(aspect / 2, 0.5, 0),
    new ShaderMaterial({
      vertexShader: common + paperVert,
      fragmentShader: common + paperFrag,
      side: DoubleSide,
      uniforms: {
        uAspect,
        uTear,
        uCrumple,
        uMap: { value: map },
        uHeight: { value: height },
        uTexel: { value: [1 / height.image.width, 1 / height.image.height] },
        uSepia: { value: 0 },
        uRelief: { value: 2.5 },
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
    new ShaderMaterial({ vertexShader: common + deskVert, fragmentShader: common + deskFrag, uniforms: { uAspect, uTear, uCrumple } }),
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
    uTear.value = s.tear
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
