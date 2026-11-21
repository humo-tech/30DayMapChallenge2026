// A designer's PDF (as exported from Illustrator) for Day 22's Align mode: the first page
// rendered to an image, and its vector paths (one shape per path drawn), both in "art units" (the page scaled
// so its long side is ART_SIZE). The shapes are what the automatic fit matches to real borders.
import { GlobalWorkerOptions, OPS, getDocument } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { XY } from './freehand'
import { extractShapes, type Matrix } from './pdfPaths'

GlobalWorkerOptions.workerSrc = workerUrl

export const ART_SIZE = 1600
// The image is rendered this many times finer than art units, so it stays sharp zoomed in
const IMAGE_SCALE = 2.5

export type PdfArt = { name: string; width: number; height: number; image: string; shapes: XY[][][] }

export async function loadPdf(source: ArrayBuffer, name: string): Promise<PdfArt> {
  const doc = await getDocument({ data: new Uint8Array(source) }).promise
  const page = await doc.getPage(1)
  const base = page.getViewport({ scale: 1 })
  const scale = ART_SIZE / Math.max(base.width, base.height)
  const viewport = page.getViewport({ scale })
  const width = Math.round(viewport.width)
  const height = Math.round(viewport.height)

  // The picture
  const hi = page.getViewport({ scale: scale * IMAGE_SCALE })
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(hi.width)
  canvas.height = Math.round(hi.height)
  await page.render({ canvas, viewport: hi }).promise
  const blob = await new Promise<Blob>((ok, ko) => canvas.toBlob((b) => (b ? ok(b) : ko(new Error('render failed'))), 'image/png'))
  const image = URL.createObjectURL(blob)

  const shapes = extractShapes(await page.getOperatorList(), OPS, viewport.transform as Matrix, width, height)
  await doc.loadingTask.destroy()
  return { name, width, height, image, shapes }
}
