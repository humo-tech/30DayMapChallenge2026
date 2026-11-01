import type { Component } from 'vue'
import { dayKey } from '~/data/themes'

type MapLoader = () => Promise<{ default: Component }>

// Only days that have an app/maps/dayXX.vue file end up here.
// Adding the file is enough to flip a day from "Coming soon" to "Published".
const loaders = import.meta.glob<{ default: Component }>('../maps/day*.vue') as Record<string, MapLoader>

function findLoader(day: number): MapLoader | undefined {
  const key = dayKey(day)
  const path = Object.keys(loaders).find((p) => p.endsWith(`/${key}.vue`))
  return path ? loaders[path] : undefined
}

export function hasMap(day: number): boolean {
  return findLoader(day) !== undefined
}

export function loadMap(day: number): MapLoader | undefined {
  return findLoader(day)
}
