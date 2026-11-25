<script setup lang="ts">
// A hidden page (linked from nowhere, not indexed): Day 26's first take, shelved: Typhoon Champi's
// clouds in 3D over the waves (see docs/day26-clouds.md), under the same header as the day's page
import { defineAsyncComponent } from 'vue'
import { CHALLENGE_YEAR, formatDisplayDate, getTheme } from '~/data/themes'
import { SUBTITLES } from '~/data/subtitles'

const day = 26
const theme = getTheme(day)!
const subtitle = SUBTITLES[day]

useHead({
  title: `Day ${day}: ${theme.title} — ${subtitle} (3D clouds) | 30DayMapChallenge ${CHALLENGE_YEAR}`,
  meta: [{ name: 'robots', content: 'noindex' }],
})

// Maps are browser-only (WebGL): skip SSR and mount on the client only
const MapContent = defineAsyncComponent(() => import('~/maps/day26-clouds.vue'))
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
        <NuxtLink :to="`/day/${day}`">Day {{ day }} ›</NuxtLink>
      </div>
      <h1>Day {{ day }}: {{ theme.title }}</h1>
      <p class="subtitle">{{ subtitle }} <span class="engine">· 3D clouds (shelved)</span></p>
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
