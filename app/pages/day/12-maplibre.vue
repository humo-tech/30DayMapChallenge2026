<script setup lang="ts">
// A hidden page (linked from nowhere, not indexed): Day 12's map made on MapLibre GL JS instead
// of Navara, under the same header as the day's page
import { defineAsyncComponent } from 'vue'
import { CHALLENGE_YEAR, formatDisplayDate, getTheme } from '~/data/themes'
import { SUBTITLES } from '~/data/subtitles'

const day = 12
const theme = getTheme(day)!
const subtitle = SUBTITLES[day]

useHead({
  title: `Day ${day}: ${theme.title} — ${subtitle} (MapLibre GL JS) | 30DayMapChallenge ${CHALLENGE_YEAR}`,
  meta: [{ name: 'robots', content: 'noindex' }],
})

// Maps are browser-only (WebGL): skip SSR and mount on the client only
const MapContent = defineAsyncComponent(() => import('~/maps/day12-maplibre.vue'))
</script>

<template>
  <div class="map-page">
    <div class="map-content">
      <ClientOnly>
        <component :is="MapContent" />
      </ClientOnly>
    </div>

    <header class="map-header">
      <div class="nav">
        <NuxtLink to="/">← Home</NuxtLink>
        <span class="spacer" />
        <NuxtLink :to="`/day/${day}`">Navara version ›</NuxtLink>
      </div>
      <h1>Day {{ day }}: {{ theme.title }}</h1>
      <p class="subtitle">{{ subtitle }} <span class="engine">· MapLibre GL JS</span></p>
      <div class="date">{{ formatDisplayDate(day) }}, {{ CHALLENGE_YEAR }}</div>
      <p v-if="theme.description" class="desc">{{ theme.description }}</p>
    </header>
  </div>
</template>

<style scoped>
.engine {
  font-weight: 400;
  opacity: 0.7;
}
</style>
