export interface Theme {
  /** 1-30 (day of November) */
  day: number
  /** Official theme name */
  title: string
  /** Official description */
  description: string
}

/**
 * 2026 themes
 * https://30daymapchallenge.com/2026/
 */
export const THEMES: readonly Theme[] = [
  { day: 1, title: 'Points', description: 'A map challenge classic. Map with points.' },
  { day: 2, title: 'Lines', description: 'A map challenge classic. Map with lines.' },
  { day: 3, title: 'Polygons', description: 'A map challenge classic. Map with polygons.' },
  { day: 4, title: 'Clusters', description: 'Clusters of something. Hotspots, groups, things that gather together.' },
  { day: 5, title: 'Senses: Sight', description: 'How do you see something? Maybe map a viewshed?' },
  { day: 6, title: 'Vintage', description: 'Spin up your time machine and do a map which looks like a historical map, or maybe the theme itself should be vintage.' },
  { day: 7, title: '10 minute map', description: 'You have no more than 10 minutes to complete this map.' },
  { day: 8, title: 'Utopia', description: 'A map of something which could be.' },
  { day: 9, title: 'Urban-rural', description: 'Urban or rural. Cities and countryside.' },
  { day: 10, title: 'Prompting only', description: 'For this map, make AI work for its money and produce something from start to finish in a chat window or on the command line.' },
  { day: 11, title: 'Senses: Sound', description: 'How do you hear something? How do you map a soundscape? Noise pollution mapped?' },
  { day: 12, title: 'Power', description: 'Power as in nuclear power? Or physical power or influence? Power grid on a map? Read this the way you want, like every other prompt.' },
  { day: 13, title: 'Interactions', description: 'Interactions between things, or maybe the result would be an interactive map?' },
  { day: 14, title: 'Borgesian map', description: "A map so detailed it becomes the territory. Inspired by Borges' On Exactitude in Science." },
  { day: 15, title: 'Inside out', description: 'Inside out, upside down. Something on this map is not quite right.' },
  { day: 16, title: 'Collaborative map', description: "Do a map with a friend, colleague or a stranger. AI doesn't count as a friend :)" },
  { day: 17, title: 'Light & dark', description: 'Play with visual effects. What can you map with just light and shadows?' },
  { day: 18, title: 'NULL', description: '' },
  { day: 19, title: 'Senses: Smell', description: 'How do you map things which your nose can sense? What does a smelly map look like?' },
  { day: 20, title: 'Hexagons', description: 'Hexagons, the good old bestagons.' },
  { day: 21, title: 'OpenStreetMap', description: 'The awesome data source for mapping. You can also use this day to edit OSM.' },
  { day: 22, title: 'Projections', description: 'The different ways of representing a globe on a flat surface. What does your favourite map projection say about you?' },
  { day: 23, title: 'Senses: Taste', description: 'Food, drink or something else which you can taste.' },
  { day: 24, title: 'Network', description: 'Route network, transit network, human network or something completely different.' },
  { day: 25, title: 'Is this a map?', description: 'Stretch the limits of maps and blend your map with an artwork or some creative data visualization. When does something become a map and when does it stop being one?' },
  { day: 26, title: 'Water', description: "About 71% of the Earth's surface. That wet thing, you know?" },
  { day: 27, title: 'New tool', description: 'The challenge has always been about learning things. Try out a new tool in your mapmaking workflow.' },
  { day: 28, title: 'Senses: Feeling', description: 'The most abstract of the senses series. How would you map a feeling?' },
  { day: 29, title: 'Raster', description: 'Do something cool with pixels.' },
  { day: 30, title: 'Pen & paper', description: 'Time to wrap up the challenge by closing your laptop for a while and going back to basics. Do an analogue map with pen and paper.' },
]

export const CHALLENGE_YEAR = 2026
export const CHALLENGE_MONTH = 11

export function getTheme(day: number): Theme | undefined {
  return THEMES.find((t) => t.day === day)
}

/** "2026-11-01" */
export function formatIsoDate(day: number): string {
  return `${CHALLENGE_YEAR}-${String(CHALLENGE_MONTH).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** "Sun, Nov 1" */
export function formatDisplayDate(day: number): string {
  const d = new Date(Date.UTC(CHALLENGE_YEAR, CHALLENGE_MONTH - 1, day))
  return d.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
}

/** "day01" (matches file names under app/maps/) */
export function dayKey(day: number): string {
  return `day${String(day).padStart(2, '0')}`
}
