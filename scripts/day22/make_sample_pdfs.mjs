// Day 22: the sample "designer's PDFs" for the page's Align mode, printed from the art that
// build_maps.py writes (public/data/day22/{japan,world}.svg), as vector PDF, the way a map
// exported from Illustrator comes. The drop shadow is left off (it would be rasterised).
//   node scripts/day22/make_sample_pdfs.mjs      (PW_CHANNEL=chrome to use the installed Chrome)
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

const require = createRequire(import.meta.url)
const { chromium } = (() => {
  try { return require('playwright') } catch { return require(require.resolve('playwright', { paths: [process.env.PLAYWRIGHT_DIR ?? '/opt/node-tools/node_modules'] })) }
})()

const dir = 'public/data/day22'
const browser = await chromium.launch({ channel: process.env.PW_CHANNEL })
const page = await browser.newPage()
for (const name of ['japan', 'world']) {
  const svg = readFileSync(`${dir}/${name}.svg`, 'utf8').replace(/ filter="url\(#art-shadow\)"/, '')
  const [, w, h] = svg.match(/viewBox="0 0 (\d+) (\d+)"/)
  await page.setContent(`<style>@page{margin:0}html,body{margin:0}svg{display:block}</style>${svg}`)
  await page.pdf({ path: `${dir}/sample-${name}.pdf`, width: `${w}px`, height: `${h}px`, printBackground: true, pageRanges: '1' })
  console.log(`${dir}/sample-${name}.pdf`)
}
await browser.close()
