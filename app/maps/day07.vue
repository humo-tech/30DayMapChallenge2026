<script setup lang="ts">
// Day 7: 10 minute map — a 10 minute run round Aobanomori Park, Chiba, as Garmin drew it
const baseURL = useRuntimeConfig().app.baseURL
</script>

<template>
  <div class="map-canvas day07">
    <img :src="`${baseURL}data/day07/run.png`" alt="Garmin map of a 2.20 km, 9:59 run round Aobanomori Park, Chiba" />
  </div>
</template>

<style scoped>
.day07 {
  display: flex;
  align-items: center;
  justify-content: center;
  background: #000;
}

.day07 img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}
</style>
