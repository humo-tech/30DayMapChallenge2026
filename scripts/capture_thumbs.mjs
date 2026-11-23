// Capture thumbnails of the published maps into app/assets/thumbs/dayXX.webp (640x400: the cards
// show them at most ~330 CSS px wide, so this covers 2x screens).
// Usage: pnpm dev (in another terminal), then
//   node scripts/capture_thumbs.mjs [day ...] [--base http://localhost:3000] [--wait 8000]
// Note: `pnpm dev` can fail on the Navara wasm import; `pnpm generate` + a static server
// (e.g. `python3 -m http.server -d .output/public 4173`, --base http://localhost:4173) works.
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'

// Resolve Playwright from the project, or fall back to a global install.
const require = createRequire(import.meta.url)
const { chromium } = (() => {
  try { return require('playwright') } catch { return require(require.resolve('playwright', { paths: [process.env.PLAYWRIGHT_DIR ?? '/opt/node-tools/node_modules'] })) }
})()

const args = process.argv.slice(2)
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args.splice(i, 2)[1] : def
}
const base = opt('base', 'http://localhost:3000').replace(/\/$/, '')
const wait = Number(opt('wait', 8000))
const THUMB_W = 640
const THUMB_H = 400
// Days captured at another URL (Day 22: the freehand map alone, without the Mercator map beside,
// with its ties and the real borders; Day 23: all the flavours, held rather than cycling on)
const PATHS = { 22: '/day/22?compare=off&ties=on&real=on', 23: '/day/23?flavour=all' }
const days = args.length ? args.map(Number) : Array.from({ length: 30 }, (_, i) => i + 1)

mkdirSync('app/assets/thumbs', { recursive: true })
const browser = await chromium.launch({ channel: process.env.PW_CHANNEL, args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] })
// Exactly twice the thumbnail, so it halves cleanly
const page = await browser.newPage({ viewport: { width: THUMB_W * 2, height: THUMB_H * 2 } })

for (const day of days) {
  const res = await page.goto(`${base}${PATHS[day] ?? `/day/${day}`}`, { waitUntil: 'load' }).catch(() => null)
  if (!res || !res.ok()) continue
  const hasCanvas = await page.waitForSelector('canvas, .map-content img, .map-content svg', { timeout: 30000 }).then(() => true).catch(() => false)
  if (!hasCanvas) { console.log(`day${day}: no map, skipped`); continue }
  await page.waitForTimeout(wait)
  // Hide the day header overlay so only the map is captured
  await page.addStyleTag({ content: '.map-header { display: none !important }' })
  const file = `app/assets/thumbs/day${String(day).padStart(2, '0')}.webp`
  // Halve and encode in the page itself (canvas -> WebP), so no image library is needed. Each
  // 2x2 block is averaged in linear light: averaging sRGB values dims fine bright detail
  const png = (await page.screenshot({ type: 'png' })).toString('base64')
  const webp = await page.evaluate(async ({ png, w, h, quality }) => {
    const img = new Image()
    img.src = `data:image/png;base64,${png}`
    await img.decode()
    const big = document.createElement('canvas')
    big.width = w * 2
    big.height = h * 2
    big.getContext('2d').drawImage(img, 0, 0, w * 2, h * 2)
    const src = big.getContext('2d').getImageData(0, 0, w * 2, h * 2).data
    const toLin = new Float32Array(256).map((_, i) => {
      const v = i / 255
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
    })
    const toSrgb = (l) => Math.round(255 * (l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055))
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const ctx = c.getContext('2d')
    const out = ctx.createImageData(w, h)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4
        for (let k = 0; k < 3; k++) {
          let sum = 0
          for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) sum += toLin[src[((y * 2 + dy) * w * 2 + x * 2 + dx) * 4 + k]]
          out.data[o + k] = toSrgb(sum / 4)
        }
        out.data[o + 3] = 255
      }
    }
    ctx.putImageData(out, 0, 0)
    return c.toDataURL('image/webp', quality).split(',')[1]
  }, { png, w: THUMB_W, h: THUMB_H, quality: 0.85 })
  writeFileSync(file, Buffer.from(webp, 'base64'))
  console.log(`day${day}: ${file}`)
}
await browser.close()
