import { THEMES } from './app/data/themes'

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

  css: ['maplibre-gl/dist/maplibre-gl.css', '~/assets/main.css'],

  nitro: {
    preset: 'github-pages',
    prerender: {
      // Prerender all 30 day pages
      routes: ['/', ...THEMES.map((t) => `/day/${t.day}`)],
    },
  },

  typescript: {
    strict: true,
  },
})
