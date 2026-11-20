// Capture thumbnails of the published maps into app/assets/thumbs/dayXX.webp-compatible PNG/JPG.
// Usage: pnpm dev (in another terminal), then
//   node scripts/capture_thumbs.mjs [day ...] [--base http://localhost:3000] [--wait 8000]
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const args = process.argv.slice(2)
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args.splice(i, 2)[1] : def
}
const base = opt('base', 'http://localhost:3000').replace(/\/$/, '')
const wait = Number(opt('wait', 8000))
const days = args.length ? args.map(Number) : Array.from({ length: 30 }, (_, i) => i + 1)

mkdirSync('app/assets/thumbs', { recursive: true })
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })

for (const day of days) {
  const res = await page.goto(`${base}/day/${day}`, { waitUntil: 'load' }).catch(() => null)
  if (!res || !res.ok()) continue
  const hasCanvas = await page.waitForSelector('canvas', { timeout: 5000 }).then(() => true).catch(() => false)
  if (!hasCanvas) { console.log(`day${day}: no map, skipped`); continue }
  await page.waitForTimeout(wait)
  const file = `app/assets/thumbs/day${String(day).padStart(2, '0')}.jpg`
  await page.screenshot({ path: file, type: 'jpeg', quality: 80 })
  console.log(`day${day}: ${file}`)
}
await browser.close()
