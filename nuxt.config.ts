import { cpSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { THEMES } from './app/data/themes'
import { NAVARA_PAGES } from './app/data/navara'

// Navara loads its workers via `new URL('assets/...', import.meta.url)` in pre-built
// code, which Vite neither rewrites nor emits. Copy them next to the chunks, where
// those URLs resolve. Of the data subdirectories, only the atmosphere's tables (the
// .exr ones, ~9.6 MB, and the stars) and the blue noise go along, for Day 23's sky; the
// other maps avoid the photoreal sky for its size. Clouds and the .bin copies are skipped.
const NAVARA_ASSETS = 'node_modules/@navaramap/three/dist/assets'
const NAVARA_DATA = [/^atmosphere(\/([^/]+\.exr|stars\.bin))?$/, /^noise(\/[^/]+\.bin)?$/]

function isNavaraAssetUsed(src: string): boolean {
  const path = relative(NAVARA_ASSETS, src)
  if (path === '') return true
  if (NAVARA_DATA.some((re) => re.test(path))) return true
  return !path.includes('/') && !path.endsWith('.map') && statSync(src).isFile()
}

// Switch baseURL for GitHub Pages (https://<user>.github.io/<repo>/).
// The GitHub Actions workflow sets NUXT_APP_BASE_URL=/<repo>/.
const baseURL = process.env.NUXT_APP_BASE_URL || '/'

export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },
  ssr: true,

  app: {
    baseURL,
    head: {
      htmlAttrs: { lang: 'en' },
      title: '30DayMapChallenge 2026',
      meta: [
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        {
          name: 'description',
          content: 'My maps for #30DayMapChallenge 2026',
        },
      ],
    },
  },

  css: ['~/assets/main.css'],

  nitro: {
    preset: 'github-pages',
    prerender: {
      // Prerender all 30 day pages, the bare Navara showcase pages, Days 12 and 20 on MapLibre and
      // Day 23 in plain Three.js
      routes: [
        '/',
        ...THEMES.map((t) => `/day/${t.day}`),
        ...Object.keys(NAVARA_PAGES).map((slug) => `/navara/${slug}`),
        '/day/12-maplibre',
        '/day/20-maplibre',
        '/day/23-three',
      ],
    },
  },

  hooks: {
    'nitro:build:public-assets'(nitro) {
      const dest = join(nitro.options.output.publicDir, nitro.options.runtimeConfig.app.buildAssetsDir, 'assets')
      cpSync(NAVARA_ASSETS, dest, { recursive: true, filter: isNavaraAssetUsed })
    },
  },

  typescript: {
    strict: true,
  },
})
