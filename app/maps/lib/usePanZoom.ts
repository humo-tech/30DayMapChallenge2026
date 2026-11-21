// Pan and zoom for an SVG over a box of content (Day 22): drag to pan, wheel or pinch to zoom,
// a click (press and release without moving) reported in content units. Optionally, a drag can
// draw a rectangle instead of panning, or move something the press landed on.
import type { Ref } from 'vue'
import type { XY } from './freehand'

export type Box = { x0: number; y0: number; w: number; h: number }

export type PanZoomOptions = {
  content: () => Box | undefined
  onClick?: (p: XY, e: PointerEvent) => void
  onHover?: (p: XY | null) => void
  /** While true, a drag draws a rectangle (reported to onRect) instead of panning */
  rectMode?: () => boolean
  onRect?: (a: XY, b: XY) => void
  /**
   * A press here may start dragging something (a marker) instead of the view: return true to
   * take it, and get the moves (onDrag) and the release (onDragEnd), in content units
   */
  onDragStart?: (p: XY) => boolean
  onDrag?: (p: XY) => void
  onDragEnd?: () => void
  /** Presses on these are left alone (pins, markers) */
  ignore?: (target: Element) => boolean
  maxZoom?: number
}

export function usePanZoom(el: Ref<HTMLElement | undefined>, opts: PanZoomOptions) {
  const size = ref({ w: 1, h: 1 })
  // The content point at the element's top-left, and screen px per content unit
  const view = ref({ x: 0, y: 0, k: 1 })
  const rect = ref<{ a: XY; b: XY }>()

  const viewBox = computed(() => `${view.value.x} ${view.value.y} ${size.value.w / view.value.k} ${size.value.h / view.value.k}`)
  const toContent = (sx: number, sy: number): XY => [view.value.x + sx / view.value.k, view.value.y + sy / view.value.k]
  const toScreen = (p: XY): XY => [(p[0] - view.value.x) * view.value.k, (p[1] - view.value.y) * view.value.k]

  const fitK = () => {
    const c = opts.content()
    return c ? Math.min(size.value.w / c.w, size.value.h / c.h) : 1
  }

  function fit() {
    const c = opts.content()
    if (!c) return
    const { w, h } = size.value
    const k = fitK() * 0.96
    view.value = { k, x: c.x0 + c.w / 2 - w / 2 / k, y: c.y0 + c.h / 2 - h / 2 / k }
  }

  function zoomAt(sx: number, sy: number, factor: number) {
    const f = fitK()
    const k = Math.min(f * (opts.maxZoom ?? 16), Math.max(f * 0.5, view.value.k * factor))
    const [ax, ay] = toContent(sx, sy)
    view.value = { k, x: ax - sx / k, y: ay - sy / k }
  }

  const pointers = new Map<number, { x: number; y: number }>()
  let press: { x: number; y: number; t: number; moved: boolean; rect: boolean } | undefined
  let pinch: { d: number; cx: number; cy: number } | undefined
  let dragging = false

  function local(e: PointerEvent | WheelEvent) {
    const r = el.value!.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  function onDown(e: PointerEvent) {
    const target = e.target as Element
    // Controls inside keep their clicks (capturing the pointer would take them)
    if (target.closest('button, a, input, label') || opts.ignore?.(target)) return
    el.value!.setPointerCapture(e.pointerId)
    const p = local(e)
    pointers.set(e.pointerId, p)
    if (pointers.size === 1 && opts.onDragStart?.(toContent(p.x, p.y))) {
      dragging = true
      press = undefined
      return
    }
    press = pointers.size === 1 ? { ...p, t: performance.now(), moved: false, rect: !!opts.rectMode?.() } : undefined
    pinch = undefined
    rect.value = undefined
  }

  function onMove(e: PointerEvent) {
    const p = local(e)
    if (dragging) {
      if (pointers.has(e.pointerId)) opts.onDrag?.(toContent(p.x, p.y))
      return
    }
    const prev = pointers.get(e.pointerId)
    if (prev) {
      if (pointers.size === 1 && press) {
        if (Math.hypot(p.x - press.x, p.y - press.y) > 4) press.moved = true
        if (press.rect) {
          if (press.moved) rect.value = { a: toContent(press.x, press.y), b: toContent(p.x, p.y) }
        } else {
          view.value = { ...view.value, x: view.value.x - (p.x - prev.x) / view.value.k, y: view.value.y - (p.y - prev.y) / view.value.k }
        }
      }
      pointers.set(e.pointerId, p)
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()] as [{ x: number; y: number }, { x: number; y: number }]
        const d = Math.hypot(a.x - b.x, a.y - b.y)
        const cx = (a.x + b.x) / 2
        const cy = (a.y + b.y) / 2
        if (pinch) {
          view.value = { ...view.value, x: view.value.x - (cx - pinch.cx) / view.value.k, y: view.value.y - (cy - pinch.cy) / view.value.k }
          zoomAt(cx, cy, d / pinch.d)
        }
        pinch = { d, cx, cy }
      }
    }
    if (e.pointerType === 'mouse') opts.onHover?.(toContent(p.x, p.y))
  }

  function onUp(e: PointerEvent) {
    pointers.delete(e.pointerId)
    if (dragging) {
      dragging = false
      opts.onDragEnd?.()
      return
    }
    if (pointers.size < 2) pinch = undefined
    if (press) {
      const p = local(e)
      if (press.rect && rect.value) opts.onRect?.(rect.value.a, rect.value.b)
      else if (!press.moved && performance.now() - press.t < 500) opts.onClick?.(toContent(p.x, p.y), e)
    }
    rect.value = undefined
    press = undefined
  }

  function onWheel(e: WheelEvent) {
    const p = local(e)
    zoomAt(p.x, p.y, Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015)))
  }

  const onLeave = () => opts.onHover?.(null)

  let observer: ResizeObserver | undefined
  onMounted(() => {
    const node = el.value!
    size.value = { w: node.clientWidth, h: node.clientHeight }
    observer = new ResizeObserver(() => {
      const before = size.value
      size.value = { w: node.clientWidth, h: node.clientHeight }
      // Keep the middle where it was
      const { x, y, k } = view.value
      view.value = { k, x: x + (before.w - size.value.w) / 2 / k, y: y + (before.h - size.value.h) / 2 / k }
    })
    observer.observe(node)
  })
  onBeforeUnmount(() => observer?.disconnect())

  return {
    size,
    view,
    viewBox,
    rect,
    fit,
    fitK,
    toContent,
    toScreen,
    handlers: { onDown, onMove, onUp, onWheel, onLeave },
  }
}
