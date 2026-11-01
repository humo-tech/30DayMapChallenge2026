<script setup lang="ts">
import { THEMES, CHALLENGE_YEAR, formatDisplayDate } from '~/data/themes'
import { hasMap } from '~/composables/useMapRegistry'

useHead({ title: `30DayMapChallenge ${CHALLENGE_YEAR}` })

const items = THEMES.map((t) => ({ ...t, done: hasMap(t.day) }))
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
