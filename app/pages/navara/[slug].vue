<script setup lang="ts">
import { defineAsyncComponent } from 'vue'
import { CHALLENGE_YEAR, getTheme } from '~/data/themes'
import { loadMap } from '~/composables/useMapRegistry'
import { SUBTITLES } from '~/data/subtitles'
import { NAVARA_PAGES } from '~/data/navara'

const route = useRoute()
const day = NAVARA_PAGES[String(route.params.slug)]
const theme = day ? getTheme(day) : undefined
const loader = day ? loadMap(day) : undefined

if (!day || !theme || !loader) {
  throw createError({ statusCode: 404, statusMessage: 'Not Found', fatal: true })
}

const subtitle = SUBTITLES[day]

useHead({
  title: `${subtitle ?? theme.title} | 30DayMapChallenge ${CHALLENGE_YEAR}`,
  meta: [{ name: 'robots', content: 'noindex' }],
})

// Maps are browser-only (WebGL): skip SSR and mount on the client only
const MapContent = defineAsyncComponent(loader)
</script>

<template>
  <div class="map-page">
    <div class="map-content">
      <ClientOnly>
        <component :is="MapContent" />
      </ClientOnly>
    </div>
  </div>
</template>
