// The vector paths of a PDF page (pdf.js's operator list) as polylines in viewport px.
// Kept apart from pdfArt.ts (which needs a browser) so it also runs in Node.
import type { XY } from './freehand'

// Bézier curves become this many straight pieces
const CURVE_STEPS = 8

export type Matrix = [number, number, number, number, number, number]
const mul = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
]
const apply = (m: Matrix, x: number, y: number): XY => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]

type OperatorList = { fnArray: number[]; argsArray: any[] }

/**
 * The page's paths, one entry per path drawn (its subpaths as polylines). Follows the current
 * transform through save / restore and form XObjects; drops clip-only paths and page-wide backgrounds.
 */
export function extractShapes(ops: OperatorList, OPS: Record<string, number>, viewport: Matrix, width: number, height: number): XY[][][] {
  const shapes: XY[][][] = []
  let ctm = viewport
  const stack: Matrix[] = []
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i]
    const args = ops.argsArray[i]
    if (fn === OPS.save) stack.push(ctm)
    else if (fn === OPS.restore) ctm = stack.pop() ?? ctm
    else if (fn === OPS.transform) ctm = mul(ctm, args as Matrix)
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm)
      if (args[0]) ctm = mul(ctm, args[0] as Matrix)
    } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() ?? ctm
    else if (fn === OPS.constructPath) {
      // Paths only drawn as a clip (endPath) aren't part of the picture
      if (args[0] === OPS.endPath) continue
      const data = args[1]?.[0] as ArrayLike<number> | undefined
      if (data) shapes.push(decode(data, ctm))
    }
  }
  // A background or frame covering the whole page isn't a border
  const seen = new Set<string>()
  return shapes.map((sh) => sh.filter((l) => {
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const [x, y] of l) {
      x0 = Math.min(x0, x)
      y0 = Math.min(y0, y)
      x1 = Math.max(x1, x)
      y1 = Math.max(y1, y)
    }
    return l.length > 1 && !(x1 - x0 > width * 0.95 && y1 - y0 > height * 0.95)
  })).filter((sh) => {
    // A shape both filled and stroked can come as two identical paths: keep one
    if (!sh.length) return false
    const key = sh.map((l) => `${l.length}:${l[0]!.map((v) => v.toFixed(1))}:${l[l.length >> 1]!.map((v) => v.toFixed(1))}`).join('|')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** pdf.js's path data: 0 moveTo x y, 1 lineTo x y, 2 curveTo x1 y1 x2 y2 x y, 3 quadraticCurveTo x1 y1 x y, 4 closePath */
function decode(d: ArrayLike<number>, m: Matrix): XY[][] {
  const out: XY[][] = []
  let cur: XY[] = []
  let start: XY = [0, 0]
  let last: XY = [0, 0]
  const end = () => {
    if (cur.length > 1) out.push(cur)
    cur = []
  }
  for (let i = 0; i < d.length; ) {
    switch (d[i++]) {
      case 0:
        end()
        last = start = [d[i++]!, d[i++]!]
        cur.push(apply(m, ...last))
        break
      case 1:
        last = [d[i++]!, d[i++]!]
        cur.push(apply(m, ...last))
        break
      case 2: {
        const [x1, y1, x2, y2, x, y] = [d[i++]!, d[i++]!, d[i++]!, d[i++]!, d[i++]!, d[i++]!]
        for (let s = 1; s <= CURVE_STEPS; s++) {
          const t = s / CURVE_STEPS
          const u = 1 - t
          cur.push(
            apply(
              m,
              u * u * u * last[0] + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x,
              u * u * u * last[1] + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y,
            ),
          )
        }
        last = [x, y]
        break
      }
      case 3: {
        const [x1, y1, x, y] = [d[i++]!, d[i++]!, d[i++]!, d[i++]!]
        for (let s = 1; s <= CURVE_STEPS; s++) {
          const t = s / CURVE_STEPS
          const u = 1 - t
          cur.push(apply(m, u * u * last[0] + 2 * u * t * x1 + t * t * x, u * u * last[1] + 2 * u * t * y1 + t * t * y))
        }
        last = [x, y]
        break
      }
      case 4:
        cur.push(apply(m, ...start))
        last = start
        break
      default:
        return out
    }
  }
  end()
  return out
}
