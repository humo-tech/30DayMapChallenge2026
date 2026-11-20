# 30DayMapChallenge 2026

My maps for [#30DayMapChallenge 2026](https://30daymapchallenge.com/2026/). Built with Nuxt 4 + Vue + TypeScript and deployed to GitHub Pages.

## Development

Requires Node.js 24 (LTS) and pnpm.

```bash
pnpm install
pnpm dev        # http://localhost:3000
pnpm generate   # static site output (.output/public)
```

## Structure

| Path | Description |
| --- | --- |
| `app/data/themes.ts` | The 30 daily themes (day, title, description) |
| `app/pages/index.vue` | Home page (dates and themes) |
| `app/pages/day/[day].vue` | Day page (theme + full-screen map) |
| `app/maps/dayXX.vue` | **The map for each day** (`day01.vue` – `day30.vue`) |
| `app/composables/useMapRegistry.ts` | Detects which days have a map file |

## Adding a map for a day

1. Create e.g. `app/maps/day02.vue` (copy `day01.vue` as a starting point).
2. Push. The home page flips that day from "Coming soon" to "Published" automatically.

All 30 day pages are prerendered up front. Days without an `app/maps/dayXX.vue` show a "Coming soon" page.

### Thumbnails

The home page shows a thumbnail per day. Drop an image at `app/assets/thumbs/dayXX.jpg` (or `.webp` / `.png`, 16:10 recommended) and it appears on the card; days without one show a placeholder with the day number.

`scripts/capture_thumbs.mjs` can take screenshots of the running maps with Playwright (`pnpm dev`, then `node scripts/capture_thumbs.mjs [day ...]`).

### Adding map libraries

Install what each day needs:

```bash
pnpm add deck.gl @deck.gl/core @deck.gl/layers   # deck.gl
pnpm add three @types/three                      # Three.js
```

Maps are browser-only (WebGL), so they render inside `<ClientOnly>` in `[day].vue`. Import a library only from the relevant `dayXX.vue` and it will be code-split into that day's chunk.

## Data preparation scripts

Scripts that build each day's data live in `scripts/dayXX/`, outside the Nuxt app. Their output goes to `public/data/dayXX/`, which is served at `<baseURL>data/dayXX/...`.

```bash
python3 -m venv scripts/.venv
scripts/.venv/bin/pip install -r scripts/requirements.txt
scripts/.venv/bin/python scripts/day01/extract_tottori.py   # --release 2026-10-21.0
```

| Script | Output |
| --- | --- |
| `scripts/day01/extract_tottori.py` | Overture Maps places named "鳥取" / "とっとり" / "TOTTORI" → `public/data/day01/tottori_places.geojson` |
| `scripts/day01/extract_pref_boundaries.py` | Prefecture land borders (Tottori's flagged) → `public/data/day01/pref_boundaries.geojson` |
| `scripts/day01/extract_coastline.py --ne <dir>` | Global land polygons and coastlines (Japan: Overture, elsewhere: Natural Earth 1:50m) → `public/data/day01/land.geojson`, `coastline.geojson` |
| `scripts/day04/extract_stations.py` | HELLO CYCLING stations and capacities from the GBFS `station_information` snapshot on S3 (AWS credentials required) → `public/data/day04/stations.geojson` |
| `scripts/day05/extract_skytree.py` | LED points scattered over Tokyo Skytree's walls, from its PLATEAU 2025 Sumida-ku LOD3 tile (Draco mesh) → `public/data/day05/skytree_leds.json` |
| `scripts/day09/extract_tokyo_mesh.py` | Mainland Tokyo on the 1 km grid: weekday late-night (01–04) and midday (11–14) people in the latest month (2021-12) of MLIT's people-flow open data → `public/data/day09/tokyo_mesh.json` |
| `scripts/day12/fetch_waves.py` | Significant wave height, mean direction and mean period of ECMWF's IFS wave model (open data, 0.25°) for the latest run, as raw float16 → `public/data/day12/waves.bin` (+ `waves.json`) |
| `scripts/day13/extract_shibuya.py` | Around Shibuya Station from Overture Maps: the walkable street network as a graph (cut at its connectors, largest connected part), building footprints with heights, and coffee shops → `public/data/day13/streets.json`, `buildings.geojson`, `coffee.json` |
| `scripts/day15/extract_harajuku.py` | Around Harajuku from Overture Maps' own PMTiles (base, transportation, buildings): only the nine z14 tiles (four z13 for the ground) and only the features the style draws and the few properties it reads, as two small PMTiles of 1.4 MB in all → `public/data/day15/harajuku.pmtiles`, `harajuku-base.pmtiles` |
| `scripts/day16/extract_course.py <gpx>` | The Kobe Marathon's course from my watch's GPS track (Garmin Connect GPX), its shape only (no times, heart rate or elevation), simplified → `public/data/day16/course.json`; the GPX stays out of the repository |
| `scripts/day16/scatter_homes.py` | Where the runners might come from (an impression): homes scattered around the towns in `scripts/day16/hometowns.json`, redrawn until on land (Day 1's `land.geojson`) → `public/data/day16/homes.json` |
| `scripts/day16/prepare_photo.py <photo> <name> --blur x,y,w,h` | A photo from the race with bib names and faces blurred, shrunk to 900 px, saved without metadata → `public/data/day16/photos/<name>.jpg`; the original stays out of the repository |
| `scripts/day18/null_fuji.py` | Mt. Fuji cut out of GSI's DEM inside an outline of its foot and the hole filled from its edge (the ground as if it had never been there), the mountain's own heights and aerial photo, and the Tokaido Shinkansen's westbound track past it from Overture Maps → `public/data/day18/fuji.json`, `fuji_null.bin`, `fuji_heights.bin`, `fuji_ortho.jpg` |
| `scripts/day19/prepare_photos.py <photo dir>` | My photos of a slice of bread with Japan cut out of foil over it, buttered and toasted, each warped so the slice sits in the same place (its corners in `scripts/day19/corners.json`), shrunk, saved without metadata; and squares of the plain slice's crumb and of the toast's browned surface made to tile, for the globe of toast → `public/data/day19/frames/NN.jpg`, `frames.json`, `crumb.jpg`, `toasted.jpg`; the originals stay out of the repository |
| `scripts/day19/toast_globe.py` | The toast's burnt Japan pinned to the real one (a similarity transform from the photos to an orthographic projection round Japan); Day 1's land as a mask blurred three ways, over the globe and over the photos; Japan's own coast, the slice's outline and where the heat comes off Japan → `public/data/day19/toast.json`, `land_globe.png`, `land_bread.png`, `slice.png` |

## Deployment (GitHub Pages)

1. Create a GitHub repository and push to `main`.
2. In **Settings → Pages → Source**, select **GitHub Actions**.
3. `.github/workflows/deploy.yml` runs on every push to `main` and publishes the site.

`NUXT_APP_BASE_URL` is set from the repository name in the workflow (`https://<user>.github.io/<repo>/`). If you use a user site (`<user>.github.io`), set it to `/`.
