<script setup lang="ts">
import { THEMES, CHALLENGE_YEAR, formatDisplayDate, dayKey } from '~/data/themes'
import { hasMap } from '~/composables/useMapRegistry'

useHead({ title: `30DayMapChallenge ${CHALLENGE_YEAR}` })

// Thumbnails: app/assets/thumbs/dayXX.(webp|jpg|png). Days without one fall back to a placeholder.
const thumbs = import.meta.glob<string>('../assets/thumbs/day*.{webp,jpg,jpeg,png}', {
  eager: true,
  import: 'default',
})

function thumbFor(day: number): string | undefined {
  const key = dayKey(day)
  const path = Object.keys(thumbs).find((p) => new RegExp(`/${key}\\.\\w+$`).test(p))
  return path ? thumbs[path] : undefined
}

const items = THEMES.map((t) => ({ ...t, done: hasMap(t.day), thumb: thumbFor(t.day) }))
const doneCount = items.filter((i) => i.done).length
</script>

<template>
  <main class="container">
    <header class="hero">
      <h1>#30DayMapChallenge {{ CHALLENGE_YEAR }}</h1>
      <p>
        {{ doneCount }} / {{ THEMES.length }} maps published ·
        <a href="https://30daymapchallenge.com/2026/" target="_blank" rel="noopener">Official site</a>
      </p>
    </header>

    <ul class="grid">
      <li v-for="item in items" :key="item.day">
        <NuxtLink :to="`/day/${item.day}`" class="card" :class="{ pending: !item.done }">
          <div class="card-thumb">
            <img v-if="item.thumb" :src="item.thumb" :alt="`Day ${item.day}: ${item.title}`" loading="lazy" decoding="async" />
            <span v-else class="card-thumb-day">{{ item.day }}</span>
          </div>
          <div class="card-head">
            <span>Day {{ item.day }} · {{ formatDisplayDate(item.day) }}</span>
            <span class="badge" :class="item.done ? 'done' : 'soon'">{{ item.done ? 'Published' : 'Coming soon' }}</span>
          </div>
          <div class="card-title">{{ item.title }}</div>
        </NuxtLink>
      </li>
    </ul>
  </main>
</template>
