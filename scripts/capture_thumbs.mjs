// Capture thumbnails of the published maps into app/assets/thumbs/dayXX.jpg.
// Usage: pnpm dev (in another terminal), then
//   node scripts/capture_thumbs.mjs [day ...] [--base http://localhost:3000] [--wait 8000]
// Note: `pnpm dev` can fail on the Navara wasm import; `pnpm generate` + a static server
// (e.g. `python3 -m http.server -d .output/public 4173`, --base http://localhost:4173) works.
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'

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
const days = args.length ? args.map(Number) : Array.from({ length: 30 }, (_, i) => i + 1)

mkdirSync('app/assets/thumbs', { recursive: true })
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })

for (const day of days) {
  const res = await page.goto(`${base}/day/${day}`, { waitUntil: 'load' }).catch(() => null)
  if (!res || !res.ok()) continue
  const hasCanvas = await page.waitForSelector('canvas, .map-content img', { timeout: 30000 }).then(() => true).catch(() => false)
  if (!hasCanvas) { console.log(`day${day}: no map, skipped`); continue }
  await page.waitForTimeout(wait)
  // Hide the day header overlay so only the map is captured
  await page.addStyleTag({ content: '.map-header { display: none !important }' })
  const file = `app/assets/thumbs/day${String(day).padStart(2, '0')}.jpg`
  await page.screenshot({ path: file, type: 'jpeg', quality: 80 })
  console.log(`day${day}: ${file}`)
}
await browser.close()
