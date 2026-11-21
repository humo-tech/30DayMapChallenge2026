<script setup lang="ts">
// Day 22's Align mode: a designer's PDF (as exported from Illustrator) fitted to the real map, half
// by hand. Click a place on the art and the same place on the real map, a few times; the fit is
// straight (affine) at first, a thin-plate spline from six ties. Parts the designer moved on their
// own (an inset box, a shrunk island) get a rectangle on each side. A tie can be dragged (or nudged
// with the arrow keys) on either map. "Auto-fit" then matches the art's outlines to the real
// borders (lib/align.ts). The ties export as JSON.
import {
  FreehandProjection,
  decodeRings,
  fmtLngLat,
  fromBase,
  graticule,
  placePin,
  toBase,
  toPath,
  unjump,
  type FrameData,
  type MapData,
  type Ring,
  type XY,
} from './freehand'
import { autoFit, matchable, respace, scaleOf, toMapData, type AlignFrame, type AlignTie, type AutoFitResult, type Base } from './align'
import { loadPdf, type PdfArt } from './pdfArt'
import { usePanZoom, type Box } from './usePanZoom'

const dataURL = `${useRuntimeConfig().app.baseURL}data/day22`

type RefName = 'japan' | 'world'
type Part = AlignFrame & { refRect?: [number, number, number, number] }

const REFS: Record<RefName, { minSize: number; nodeEps: number; grid: number; step: number; lat: [number, number] }> = {
  japan: { minSize: 0.05, nodeEps: 0.004, grid: 1, step: 0.05, lat: [23, 46] },
  world: { minSize: 0.6, nodeEps: 0.04, grid: 15, step: 0.5, lat: [-60, 80] },
}

const art = shallowRef<PdfArt>()
const refName = ref<RefName>('japan')
const center = ref(150) // the world map's central meridian
const refData = shallowRef<MapData>()
const hand = ref<AlignTie[]>([])
const auto = shallowRef<AlignTie[]>([])
const parts = ref<Part[]>([{ name: 'main' }])
const pending = ref<{ art?: XY; ll?: XY }>({})
const selected = ref<number>()
const tool = ref<'tie' | 'part-art' | 'part-ref'>('tie')
const draftBox = ref<[number, number, number, number]>()
const busy = ref<string>()
const result = shallowRef<AutoFitResult>()
const error = ref<string>()
const show = reactive({ real: true, pins: true, grid: false, ties: true })
const cursor = ref<XY | null>()

const base = computed<Base>(() => (refName.value === 'japan' ? { base: 'mercator' } : { base: 'naturalEarth', lng0: center.value, wrap: true }))
const mainFrame = computed(() => ({ name: 'main', ...base.value }) as FrameData)

// ---- The real map

const refCache = new Map<RefName, Promise<MapData>>()
watch(
  refName,
  async (r) => {
    let p = refCache.get(r)
    if (!p) refCache.set(r, (p = fetch(`${dataURL}/${r}.json`).then((res) => res.json() as Promise<MapData>)))
    const d = await p
    if (refName.value === r) refData.value = d
  },
  { immediate: true },
)
const realRings = computed(() => refData.value?.regions.map((r) => decodeRings(r.rings, refData.value!.quantum)) ?? [])

/** The real map in the base projection; its content units are (x, -y) of the base plane */
const refMap = computed(() => {
  const f = mainFrame.value
  const fills: XY[][] = []
  const lines: XY[][] = []
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const rings of realRings.value) {
    for (const r of rings) {
      const pts = r.map(([lng, lat]) => {
        const [x, y] = toBase(f, lng, lat)
        x0 = Math.min(x0, x)
        x1 = Math.max(x1, x)
        y0 = Math.min(y0, -y)
        y1 = Math.max(y1, -y)
        return [x, -y] as XY
      })
      const split = unjump([[...pts, pts[0]!]], 90)
      if (split.length === 1) fills.push(pts)
      lines.push(...split)
    }
  }
  return {
    fill: fills.map((p) => 'M' + p.map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`).join('L') + 'Z').join(''),
    lines: lines.map((l) => 'M' + l.map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`).join('L')).join(''),
    box: { x0, y0, w: x1 - x0, h: y1 - y0 } as Box,
  }
})
const refPoint = (ll: XY): XY => {
  const [x, y] = toBase(mainFrame.value, ll[0], ll[1])
  return [x, -y]
}

// ---- The fit

const proj = computed(() => {
  const a = art.value
  if (!a) return null
  try {
    return new FreehandProjection(toMapData(parts.value, [...hand.value, ...auto.value], base.value, a.width, a.height))
  } catch {
    return null // three ties in a line, say
  }
})
const handInMain = computed(() => hand.value.filter((t) => !parts.value.some((p, i) => i > 0 && inBox(t.art, p.boxPx))).length)
const fitted = computed(() => !!proj.value && proj.value.fitted(proj.value.frames.length - 1))

const inBox = (p: XY, b?: [number, number, number, number]) =>
  !!b && p[0] >= b[0] && p[0] <= b[0] + b[2] && p[1] >= b[1] && p[1] <= b[1] + b[3]

/** The real borders, a point about every art unit and a half, through the fit */
const realOnArt = computed(() => {
  const p = proj.value
  const a = art.value
  if (!p || !a || !fitted.value || !show.real) return ''
  const step = (1.5 * Math.max(a.width, a.height)) / 1600 / scaleOf(hand.value)
  const lines: XY[][] = []
  for (const rings of realRings.value) {
    for (const r of respace(rings, step)) lines.push(...p.line([...r, r[0]!]))
  }
  return toPath(unjump(lines, a.width / 4))
})

const gridOnArt = computed(() => {
  const p = proj.value
  const a = art.value
  if (!p || !a || !fitted.value || !show.grid) return ''
  const s = REFS[refName.value]
  const lng: [number, number] = refName.value === 'japan' ? [120, 152] : [center.value - 180, center.value + 180]
  return toPath(unjump(graticule(p, lng, s.lat, s.grid, s.step), a.width / 4))
})

// The art's shapes by region (once the auto-fit has told them apart), for keeping pins on them
const shapeRings = computed(() => {
  const m = new Map<string, Ring[]>()
  const a = art.value
  result.value?.shapeRegions.forEach((id, i) => {
    if (id && a) m.set(id, [...(m.get(id) ?? []), ...a.shapes[i]!])
  })
  return m
})

const pins = computed(() => {
  const p = proj.value
  if (!p || !fitted.value || !show.pins || !refData.value || !art.value) return []
  const unit = Math.max(art.value.width, art.value.height) / 1600
  return refData.value.pins
    .map((pin) => {
      const raw = p.project(pin.lng, pin.lat)
      if (!raw) return null
      return { ...pin, xy: placePin(raw, shapeRings.value.get(pin.region), undefined, 20 * unit, 1.5 * unit).xy }
    })
    .filter((x) => x !== null)
})

// ---- Panes

const artEl = ref<HTMLDivElement>()
const refEl = ref<HTMLDivElement>()

const nearHand = (p: XY, k: number, side: 'art' | 'ref') =>
  hand.value.findIndex((t) => {
    const q = side === 'art' ? t.art : refPoint(t.ll)
    return Math.hypot(q[0] - p[0], q[1] - p[1]) < 9 / k
  })

/** Moves a hand tie on one side: its place on the art, or on the real map (content units of that pane) */
function moveTie(i: number, side: 'art' | 'ref', q: XY) {
  const t = hand.value[i]
  if (!t) return
  hand.value[i] = side === 'art' ? { ...t, art: q } : { ...t, ll: fromBase(mainFrame.value, q[0], -q[1]) }
}

// Dragging a hand tie: held where it was pressed (it doesn't jump to the pointer), the fit (and
// the borders and pins drawn with it) redone once a frame as it moves
let grab: { i: number; side: 'art' | 'ref'; dx: number; dy: number } | undefined
let grabTo: XY | undefined
let grabFrame = 0
function dragTies(side: 'art' | 'ref', k: () => number) {
  return {
    onDragStart: (p: XY) => {
      if (tool.value !== 'tie') return false
      const i = nearHand(p, k(), side)
      if (i < 0) return false
      const t = hand.value[i]!
      const q = side === 'art' ? t.art : refPoint(t.ll)
      grab = { i, side, dx: q[0] - p[0], dy: q[1] - p[1] }
      selected.value = i
      pending.value = {}
      return true
    },
    onDrag: (p: XY) => {
      if (!grab) return
      grabTo = [p[0] + grab.dx, p[1] + grab.dy]
      grabFrame ||= requestAnimationFrame(() => {
        grabFrame = 0
        if (grab && grabTo) moveTie(grab.i, grab.side, grabTo)
      })
    },
    onDragEnd: () => {
      if (grab && grabTo) moveTie(grab.i, grab.side, grabTo)
      grab = grabTo = undefined
    },
  }
}

const artPZ = usePanZoom(artEl, {
  ...dragTies('art', () => artPZ.view.value.k),
  content: () => art.value && { x0: 0, y0: 0, w: art.value.width, h: art.value.height },
  maxZoom: 40,
  rectMode: () => tool.value === 'part-art',
  onRect: (a, b) => {
    draftBox.value = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1])]
    tool.value = 'part-ref'
  },
  onClick: (p) => {
    if (tool.value !== 'tie' || !art.value) return
    const i = nearHand(p, artPZ.view.value.k, 'art')
    if (i >= 0) return void (selected.value = i)
    selected.value = undefined
    pending.value = { ...pending.value, art: p }
    addTie()
  },
  onHover: (p) => {
    const pr = proj.value
    cursor.value = p && pr && fitted.value ? pr.invert(p[0], p[1]) : undefined
  },
})

const refPZ = usePanZoom(refEl, {
  ...dragTies('ref', () => refPZ.view.value.k),
  content: () => (refData.value ? refMap.value.box : undefined),
  maxZoom: 60,
  rectMode: () => tool.value === 'part-ref',
  onRect: (a, b) => {
    const box = draftBox.value
    if (!box) return
    const [x0, x1] = [Math.min(a[0], b[0]), Math.max(a[0], b[0])]
    const [y0, y1] = [Math.min(a[1], b[1]), Math.max(a[1], b[1])]
    // The rectangle's corners and edge midpoints on the globe, and the box round them
    const lls = [x0, (x0 + x1) / 2, x1].flatMap((x) => [y0, (y0 + y1) / 2, y1].map((y) => fromBase(mainFrame.value, x, -y)))
    const lo: XY = [Math.min(...lls.map((p) => p[0])), Math.min(...lls.map((p) => p[1]))]
    const hi: XY = [Math.max(...lls.map((p) => p[0])), Math.max(...lls.map((p) => p[1]))]
    parts.value.push({
      name: `part ${parts.value.length}`,
      boxPx: box,
      domain: [lo, [hi[0], lo[1]], hi, [lo[0], hi[1]]],
      refRect: [x0, y0, x1 - x0, y1 - y0],
    })
    draftBox.value = undefined
    tool.value = 'tie'
  },
  onClick: (p) => {
    if (tool.value !== 'tie' || !art.value) return
    const i = nearHand(p, refPZ.view.value.k, 'ref')
    if (i >= 0) return void (selected.value = i)
    selected.value = undefined
    pending.value = { ...pending.value, ll: fromBase(mainFrame.value, p[0], -p[1]) }
    addTie()
  },
})

watch(refMap, () => nextTick(refPZ.fit))

function addTie() {
  const { art: a, ll } = pending.value
  if (!a || !ll) return
  hand.value.push({ art: a, ll: [ll[0], ll[1]] })
  pending.value = {}
}

function removeSelected() {
  if (selected.value === undefined) return
  hand.value.splice(selected.value, 1)
  selected.value = undefined
}

function removePart(i: number) {
  parts.value.splice(i, 1)
  parts.value.forEach((p, j) => j > 0 && (p.name = `part ${j}`))
}

function onKey(e: KeyboardEvent) {
  if ((e.target as Element).closest('input, textarea')) return
  if (e.key === 'Escape') {
    pending.value = {}
    tool.value = 'tie'
    draftBox.value = undefined
    selected.value = undefined
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && selected.value !== undefined) {
    e.preventDefault()
    removeSelected()
  } else if (e.key.startsWith('Arrow') && selected.value !== undefined) {
    // Nudge the selected tie a screen pixel (ten with Shift): on the art, or on the real map with Alt
    e.preventDefault()
    const side = e.altKey ? 'ref' : 'art'
    const t = hand.value[selected.value]!
    const step = (e.shiftKey ? 10 : 1) / (side === 'art' ? artPZ.view.value.k : refPZ.view.value.k)
    const [dx, dy] = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key] ?? [0, 0]
    const q = side === 'art' ? t.art : refPoint(t.ll)
    moveTie(selected.value, side, [q[0] + dx! * step, q[1] + dy! * step])
  } else if (e.key === 'z' && (e.metaKey || e.ctrlKey) && hand.value.length) {
    e.preventDefault()
    hand.value.pop()
  }
}

// ---- Files

const pdfInput = ref<HTMLInputElement>()
const jsonInput = ref<HTMLInputElement>()

async function openPdf(data: ArrayBuffer, name: string) {
  busy.value = 'Reading the PDF…'
  error.value = undefined
  try {
    const a = await loadPdf(data, name)
    if (art.value) URL.revokeObjectURL(art.value.image)
    art.value = a
    hand.value = []
    auto.value = []
    parts.value = [{ name: 'main' }]
    pending.value = {}
    result.value = undefined
    await nextTick()
    artPZ.fit()
  } catch (e) {
    error.value = `Couldn't read that PDF (${(e as Error).message})`
  } finally {
    busy.value = undefined
  }
}

async function pickPdf(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0]
  if (f) await openPdf(await f.arrayBuffer(), f.name)
  ;(e.target as HTMLInputElement).value = ''
}

async function onDrop(e: DragEvent) {
  const f = e.dataTransfer?.files[0]
  if (f?.type === 'application/pdf') await openPdf(await f.arrayBuffer(), f.name)
  else if (f?.name.endsWith('.json')) importJson(await f.text())
}

async function sample(r: RefName) {
  refName.value = r
  center.value = 150
  await openPdf(await (await fetch(`${dataURL}/sample-${r}.pdf`)).arrayBuffer(), `sample-${r}.pdf`)
}

function exportJson() {
  const a = art.value
  if (!a) return
  const data = toMapData(parts.value, [...hand.value, ...auto.value], base.value, a.width, a.height)
  const out = {
    format: 'freehand-projection',
    version: 1,
    source: a.name,
    reference: refName.value,
    width: a.width,
    height: a.height,
    base: base.value,
    parts: parts.value,
    hand: hand.value,
    auto: auto.value,
    lambda: data.lambda,
    frames: data.frames,
  }
  const url = URL.createObjectURL(new Blob([JSON.stringify(out)], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `${a.name.replace(/\.pdf$/i, '')}.freehand.json`
  link.click()
  URL.revokeObjectURL(url)
}

function importJson(text: string) {
  try {
    const d = JSON.parse(text)
    if (d.format !== 'freehand-projection') throw new Error('not a freehand-projection file')
    if (art.value && (Math.abs(d.width - art.value.width) > 1 || Math.abs(d.height - art.value.height) > 1)) {
      throw new Error(`made for a ${d.width} × ${d.height} page`)
    }
    refName.value = d.reference
    if (d.base?.lng0 !== undefined) center.value = d.base.lng0
    parts.value = d.parts
    hand.value = d.hand
    auto.value = d.auto ?? []
    result.value = undefined
  } catch (e) {
    error.value = `Couldn't load those ties (${(e as Error).message})`
  }
}

async function pickJson(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0]
  if (f) importJson(await f.text())
  ;(e.target as HTMLInputElement).value = ''
}

// ---- Auto-fit

async function runAutoFit() {
  const a = art.value
  if (!a || !fitted.value || !refData.value) return
  const s = REFS[refName.value]
  const kept = matchable(realRings.value, s.minSize)
  busy.value = 'Auto-fit…'
  try {
    const res = await autoFit({
      frames: parts.value,
      hand: hand.value,
      base: base.value,
      width: a.width,
      height: a.height,
      shapes: a.shapes,
      regions: refData.value.regions.map((r, i) => ({ id: r.id, rings: kept[i]! })),
      nodeEps: s.nodeEps,
      onProgress: (i, n) => (busy.value = `Auto-fit ${i} / ${n}…`),
    })
    auto.value = res.ties
    result.value = res
  } finally {
    busy.value = undefined
  }
}

function clearAll() {
  hand.value = []
  auto.value = []
  parts.value = [{ name: 'main' }]
  pending.value = {}
  result.value = undefined
}

const status = computed(() => {
  if (busy.value) return busy.value
  if (error.value) return error.value
  if (!art.value) return 'Open a PDF exported from Illustrator (or drop it here), or try a sample.'
  if (tool.value === 'part-art') return 'Drag a rectangle round the part on the art: an inset box, or a part moved on its own.'
  if (tool.value === 'part-ref') return 'Now drag a rectangle round the same part on the real map.'
  if (pending.value.art) return 'Now click the same place on the real map.'
  if (pending.value.ll) return 'Now click the same place on the art.'
  if (selected.value !== undefined) {
    return `Tie ${selected.value + 1}: drag it on either map, or nudge it with the arrow keys (on the real map with ⌥ / Alt, ten times with ⇧). Delete removes it.`
  }
  if (handInMain.value < 3) return `Click a place on the art, then the same place on the real map (${handInMain.value} of 3 to start).`
  const r = result.value
  const n = `${hand.value.length} hand ties${auto.value.length ? ` + ${auto.value.length} automatic` : ''}`
  if (r) return `${n} · ${r.identified} shapes recognised, ${r.nodes} junctions matched. Add a tie where it's still off, and auto-fit again.`
  return `${n} · ${handInMain.value < 6 ? 'a straight fit (six ties for a curved one)' : 'fitted'}. Auto-fit matches the outlines.`
})

const scale = (pz: { view: Ref<{ k: number }> }) => 1 / pz.view.value.k

onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  cancelAnimationFrame(grabFrame)
  if (art.value) URL.revokeObjectURL(art.value.image)
})
</script>

<template>
  <div class="align" @dragover.prevent @drop.prevent="onDrop">
    <div class="panes">
      <!-- The real map -->
      <div
        ref="refEl"
        class="pane ref"
        :class="{ rect: tool === 'part-ref' }"
        @pointerdown="refPZ.handlers.onDown"
        @pointermove="refPZ.handlers.onMove"
        @pointerup="refPZ.handlers.onUp"
        @pointercancel="refPZ.handlers.onUp"
        @wheel.prevent="refPZ.handlers.onWheel"
      >
        <svg v-if="refData" :viewBox="refPZ.viewBox.value">
          <path class="land" :d="refMap.fill" />
          <path class="borders" :d="refMap.lines" />
          <template v-for="(p, i) in parts" :key="i">
            <rect v-if="p.refRect" class="part" :x="p.refRect[0]" :y="p.refRect[1]" :width="p.refRect[2]" :height="p.refRect[3]" />
          </template>
          <rect
            v-if="refPZ.rect.value"
            class="part draft"
            :x="Math.min(refPZ.rect.value.a[0], refPZ.rect.value.b[0])"
            :y="Math.min(refPZ.rect.value.a[1], refPZ.rect.value.b[1])"
            :width="Math.abs(refPZ.rect.value.a[0] - refPZ.rect.value.b[0])"
            :height="Math.abs(refPZ.rect.value.a[1] - refPZ.rect.value.b[1])"
          />
          <g v-for="(t, i) in hand" :key="i" class="tie" :class="{ on: selected === i }" :transform="`translate(${refPoint(t.ll).join(' ')}) scale(${scale(refPZ)})`">
            <circle r="8" />
            <text y="3.5">{{ i + 1 }}</text>
          </g>
          <g v-if="pending.ll" class="tie pending" :transform="`translate(${refPoint(pending.ll).join(' ')}) scale(${scale(refPZ)})`">
            <circle r="8" />
            <text y="3.5">?</text>
          </g>
        </svg>
        <span class="label">Real map · {{ refName === 'japan' ? 'Overture Maps (Mercator)' : `Natural Earth, centred on ${center}°` }}</span>
      </div>

      <!-- The designer's PDF -->
      <div
        ref="artEl"
        class="pane art"
        :class="{ rect: tool === 'part-art' }"
        @pointerdown="artPZ.handlers.onDown"
        @pointermove="artPZ.handlers.onMove"
        @pointerup="artPZ.handlers.onUp"
        @pointercancel="artPZ.handlers.onUp"
        @pointerleave="artPZ.handlers.onLeave"
        @wheel.prevent="artPZ.handlers.onWheel"
      >
        <svg v-if="art" :viewBox="artPZ.viewBox.value">
          <image :href="art.image" x="0" y="0" :width="art.width" :height="art.height" />
          <path v-if="show.grid" class="grid" :d="gridOnArt" />
          <path v-if="show.real" class="real" :d="realOnArt" />
          <template v-for="(p, i) in parts" :key="i">
            <rect v-if="p.boxPx" class="part" :x="p.boxPx[0]" :y="p.boxPx[1]" :width="p.boxPx[2]" :height="p.boxPx[3]" />
          </template>
          <rect v-if="draftBox" class="part draft" :x="draftBox[0]" :y="draftBox[1]" :width="draftBox[2]" :height="draftBox[3]" />
          <rect
            v-if="artPZ.rect.value"
            class="part draft"
            :x="Math.min(artPZ.rect.value.a[0], artPZ.rect.value.b[0])"
            :y="Math.min(artPZ.rect.value.a[1], artPZ.rect.value.b[1])"
            :width="Math.abs(artPZ.rect.value.a[0] - artPZ.rect.value.b[0])"
            :height="Math.abs(artPZ.rect.value.a[1] - artPZ.rect.value.b[1])"
          />
          <g v-if="show.ties">
            <circle v-for="(t, i) in auto" :key="i" class="auto" :cx="t.art[0]" :cy="t.art[1]" :r="1.8 * scale(artPZ)" />
          </g>
          <g v-if="show.pins">
            <g v-for="p in pins" :key="p.name" class="pin" :transform="`translate(${p.xy.join(' ')}) scale(${0.55 * scale(artPZ)})`">
              <title>{{ p.name }}</title>
              <path d="M0 0C-1.5-5-8-10.5-8-17A8 8 0 0 1 8-17C8-10.5 1.5-5 0 0Z" />
              <circle cx="0" cy="-17" r="3" />
            </g>
          </g>
          <g v-for="(t, i) in hand" :key="i" class="tie" :class="{ on: selected === i }" :transform="`translate(${t.art.join(' ')}) scale(${scale(artPZ)})`">
            <circle r="8" />
            <text y="3.5">{{ i + 1 }}</text>
          </g>
          <g v-if="pending.art" class="tie pending" :transform="`translate(${pending.art.join(' ')}) scale(${scale(artPZ)})`">
            <circle r="8" />
            <text y="3.5">?</text>
          </g>
        </svg>
        <div v-else class="empty">
          <p>Drop a designer's PDF here</p>
          <div class="seg">
            <button type="button" @click="pdfInput?.click()">Open a PDF…</button>
            <button type="button" @click="sample('japan')">Sample: Japan</button>
            <button type="button" @click="sample('world')">Sample: World</button>
          </div>
        </div>
        <span v-if="art" class="label">{{ art.name }}<template v-if="cursor"> · {{ fmtLngLat(cursor[0], cursor[1]) }}</template></span>
      </div>
    </div>

    <div class="bar">
      <div class="tools">
        <div class="seg">
          <button type="button" @click="pdfInput?.click()">Open PDF…</button>
          <button type="button" :aria-pressed="refName === 'japan'" @click="refName = 'japan'">Prefectures</button>
          <button type="button" :aria-pressed="refName === 'world'" @click="refName = 'world'">Countries</button>
          <button v-if="refName === 'world'" type="button" :title="`Central meridian of the real map: ${center}°`" @click="center = center === 150 ? 0 : 150">
            {{ center === 150 ? '150°E' : '0°' }}
          </button>
        </div>
        <div class="seg">
          <button type="button" :disabled="!art" :aria-pressed="tool !== 'tie'" @click="tool = tool === 'tie' ? 'part-art' : 'tie'">Add a part</button>
          <button type="button" :disabled="!fitted || !!busy" class="go" @click="runAutoFit">Auto-fit</button>
          <button type="button" :disabled="selected === undefined" @click="removeSelected">Delete tie</button>
          <button type="button" :disabled="!hand.length && !auto.length" @click="clearAll">Clear</button>
        </div>
        <div class="seg">
          <button type="button" :aria-pressed="show.real" @click="show.real = !show.real">Real borders</button>
          <button type="button" :aria-pressed="show.grid" @click="show.grid = !show.grid">Graticule</button>
          <button type="button" :aria-pressed="show.pins" @click="show.pins = !show.pins">Pins</button>
          <button type="button" :aria-pressed="show.ties" @click="show.ties = !show.ties">Ties</button>
        </div>
        <div class="seg">
          <button type="button" :disabled="!art" @click="jsonInput?.click()">Import ties…</button>
          <button type="button" :disabled="!fitted" @click="exportJson">Export ties</button>
        </div>
        <div v-if="parts.length > 1" class="seg parts">
          <button v-for="(p, i) in parts.slice(1)" :key="i" type="button" :title="`Remove ${p.name}`" @click="removePart(i + 1)">{{ p.name }} ×</button>
        </div>
      </div>
      <p class="status" :class="{ error: !!error && !busy }">{{ status }}</p>
    </div>

    <input ref="pdfInput" type="file" accept="application/pdf" hidden @change="pickPdf" />
    <input ref="jsonInput" type="file" accept="application/json,.json" hidden @change="pickJson" />
  </div>
</template>

<style scoped>
.align {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  background: #0f1419;
}

.panes {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 2fr 3fr;
  gap: 2px;
}

.pane {
  position: relative;
  overflow: hidden;
  touch-action: none;
  cursor: crosshair;
}

.pane.rect {
  cursor: cell;
}

.pane svg {
  display: block;
  width: 100%;
  height: 100%;
}

.ref {
  background: #cfe4ea;
}

.art {
  background: #e9edf0;
}

.land {
  fill: #fdfaf3;
}

.borders {
  fill: none;
  stroke: #4a607a;
  stroke-width: 0.7;
  stroke-linejoin: round;
  vector-effect: non-scaling-stroke;
}

.real {
  fill: none;
  stroke: #1d3557;
  stroke-opacity: 0.75;
  stroke-width: 0.8;
  stroke-linejoin: round;
  vector-effect: non-scaling-stroke;
}

.grid {
  fill: none;
  stroke: #1d3557;
  stroke-opacity: 0.45;
  stroke-width: 0.7;
  stroke-dasharray: 3 3;
  vector-effect: non-scaling-stroke;
}

.part {
  fill: rgba(247, 194, 148, 0.12);
  stroke: #e07b39;
  stroke-width: 1.5;
  stroke-dasharray: 6 4;
  vector-effect: non-scaling-stroke;
}

.part.draft {
  stroke: #c2272d;
}

.auto {
  fill: #0f9d8a;
}

.tie circle {
  fill: #ffffff;
  stroke: #3a5bd9;
  stroke-width: 2;
}

.tie circle {
  cursor: grab;
}

.tie text {
  font-size: 10px;
  font-weight: 700;
  text-anchor: middle;
  fill: #3a5bd9;
  pointer-events: none;
}

.tie.on circle {
  fill: #3a5bd9;
}

.tie.on text {
  fill: #ffffff;
}

.tie.pending circle {
  stroke: #c2272d;
  animation: blink 0.9s ease-in-out infinite alternate;
}

.tie.pending text {
  fill: #c2272d;
}

@keyframes blink {
  to {
    opacity: 0.35;
  }
}

.pin path {
  fill: #e5484d;
  stroke: #ffffff;
  stroke-width: 1.2;
}

.pin circle {
  fill: #ffffff;
}

.label {
  position: absolute;
  left: 8px;
  bottom: 6px;
  padding: 2px 8px;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: #1d3557;
  background: rgba(255, 255, 255, 0.8);
  border-radius: 4px;
  pointer-events: none;
}

.empty {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: #4a607a;
  border: 2px dashed #b7c4cf;
  margin: 16px;
  border-radius: 12px;
  cursor: default;
}

.empty p {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}

.bar {
  padding: 8px 12px 10px;
  background: rgba(15, 20, 25, 0.96);
  border-top: 1px solid var(--border);
}

.tools {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.go:not(:disabled) {
  color: #4dffa8 !important;
}

.status {
  margin: 6px 2px 0;
  font-size: 12px;
  color: var(--fg-muted);
}

.status.error {
  color: #ff8a8a;
}

@media (max-width: 700px) {
  .panes {
    grid-template-columns: 1fr;
    grid-template-rows: 2fr 3fr;
  }

  .art {
    order: -1;
  }
}
</style>
