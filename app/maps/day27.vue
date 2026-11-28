<script setup lang="ts">
// Day 27: New tool — not a web map but a video: Typhoon Champi's day at its strongest (20
// October 2026), 13 hours of it in 24 s, every Himawari-9 scan (10 minutes,
// about 3 km) raised into cloud and raymarched frame by frame in OpenGL shaders driven from
// Python (ModernGL), over Day 12's fluid stirred by ECMWF's waves and colored by the sea's
// temperature, the land in relief, Champi's track, under the air, the sun held mid-afternoon; piped
// into ffmpeg. A second take without the clouds, to see the sea under them: the button swaps to
// it at the same moment.
// Render: scripts/day27/render.py (data: scripts/day27/fetch_himawari.py, fetch_terrain.py, and Day 26's)
const baseURL = useRuntimeConfig().app.baseURL
const SRC = { clouds: `${baseURL}data/day27/champi.mp4`, sea: `${baseURL}data/day27/champi-noclouds.mp4` }

const video = ref<HTMLVideoElement>()
const clouds = ref(true)

// The other take, from where this one is
watch(clouds, async (on) => {
  const v = video.value
  if (!v) return
  const at = v.currentTime
  v.src = on ? SRC.clouds : SRC.sea
  await new Promise((resolve) => v.addEventListener('loadedmetadata', resolve, { once: true }))
  v.currentTime = at
  await v.play().catch(() => {})
})
</script>

<template>
  <div class="map-canvas day27">
    <video ref="video" :src="SRC.clouds" autoplay muted loop playsinline preload="auto" />
    <div class="controls">
      <button
        type="button"
        class="toggle"
        :aria-pressed="clouds"
        :aria-label="clouds ? 'Hide the clouds' : 'Show the clouds'"
        @click="clouds = !clouds"
      >
        <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
          <path
            d="M6 15.5h8.2a3.3 3.3 0 0 0 .4-6.6 4.6 4.6 0 0 0-8.9 1.2A2.7 2.7 0 0 0 6 15.5z"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linejoin="round"
          />
        </svg>
      </button>
    </div>
    <div class="credit">
      Clouds: Himawari-9 (JMA) via <a href="https://registry.opendata.aws/noaa-himawari/">NOAA open data on AWS</a> ·
      Waves, winds: <a href="https://www.ecmwf.int/en/forecasts/datasets/open-data">ECMWF open data</a> (IFS), CC BY 4.0 ·
      Sea surface temperature: <a href="https://www.ncei.noaa.gov/products/optimum-interpolation-sst">NOAA OISST v2.1</a> ·
      Track: <a href="https://www.ncei.noaa.gov/products/international-best-track-archive">IBTrACS v04r01</a> ·
      Terrain: <a href="https://mapterhorn.com">Mapterhorn</a>
    </div>
  </div>
</template>

<style scoped>
.day27 {
  position: relative;
  background: #000;
}

video {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

/* Matches the page's header panel */
.controls {
  position: absolute;
  right: 12px;
  bottom: 36px;
  z-index: 10;
  padding: 6px;
  background: rgba(15, 20, 25, 0.82);
  backdrop-filter: blur(6px);
  border: 1px solid var(--border);
  border-radius: 10px;
}

.toggle {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  padding: 0;
  color: var(--fg);
  background: none;
  border: 0;
  border-radius: 7px;
  cursor: pointer;
}

.toggle:hover {
  color: var(--accent);
}

.toggle[aria-pressed='true'] {
  color: var(--bg);
  background: var(--accent);
}

.credit {
  position: absolute;
  right: 0;
  bottom: 0;
  padding: 2px 8px;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.75);
  background: rgba(0, 0, 0, 0.45);
}

.credit a {
  color: inherit;
}
</style>
