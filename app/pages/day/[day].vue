<script setup lang="ts">
import { defineAsyncComponent } from 'vue'
import { THEMES, CHALLENGE_YEAR, getTheme, formatDisplayDate } from '~/data/themes'
import { loadMap } from '~/composables/useMapRegistry'
import { SUBTITLES } from '~/data/subtitles'

const route = useRoute()
const day = Number(route.params.day)
const theme = getTheme(day)

if (!theme) {
  throw createError({ statusCode: 404, statusMessage: 'Not Found', fatal: true })
}

const subtitle = SUBTITLES[day]

useHead({
  title: `Day ${day}: ${theme.title}${subtitle ? ` — ${subtitle}` : ''} | 30DayMapChallenge ${CHALLENGE_YEAR}`,
})

const loader = loadMap(day)
// Maps are browser-only (WebGL): skip SSR and mount on the client only
const MapContent = loader ? defineAsyncComponent(loader) : null

const prev = day > 1 ? day - 1 : null
const next = day < THEMES.length ? day + 1 : null
</script>

<template>
  <div v-if="theme" class="map-page">
    <div class="map-content">
      <ClientOnly v-if="MapContent">
        <component :is="MapContent" />
      </ClientOnly>
      <div v-else class="placeholder">
        <div class="big">Coming soon</div>
        <div class="sub">The Day {{ day }} map hasn't been made yet.</div>
      </div>
    </div>

    <header class="map-header" :class="{ pending: !MapContent }">
      <div class="nav">
        <NuxtLink to="/">← Home</NuxtLink>
        <span class="spacer" />
        <NuxtLink v-if="prev" :to="`/day/${prev}`">‹ Prev</NuxtLink>
        <NuxtLink v-if="next" :to="`/day/${next}`">Next ›</NuxtLink>
      </div>
      <h1>Day {{ day }}: {{ theme.title }}</h1>
      <p v-if="subtitle" class="subtitle">{{ subtitle }}</p>
      <div class="date">{{ formatDisplayDate(day) }}, {{ CHALLENGE_YEAR }}</div>
      <p v-if="theme.description" class="desc">{{ theme.description }}</p>
    </header>
  </div>
</template>
