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

The home page shows a thumbnail per day. Drop an image at `app/assets/thumbs/dayXX.webp` (or `.jpg` / `.png`; 640×400 — the cards show it at most ~330 CSS px wide) and it appears on the card; days without one show a placeholder with the day number.

`scripts/capture_thumbs.mjs` captures every published map with Playwright (uses the preinstalled one if the project has none) at 1280×800 and saves it halved to 640×400 WebP (averaged in linear light, so fine bright detail doesn't dim; quality 0.85, encoded by the browser). `pnpm dev` can fail on the Navara wasm import, so use the static build:

```bash
pnpm generate
python3 -m http.server -d .output/public 4173 &
node scripts/capture_thumbs.mjs [day ...] --base http://localhost:4173
```

Set `PW_CHANNEL=chrome` to launch the installed Google Chrome instead of Playwright's own browser. Set `PW_GL=gpu` to draw on the GPU instead of SwiftShader (needed for heavy scenes such as Day 25, which lose their WebGL context in software).

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
| `scripts/day21/fetch_diffs.py --cache <dir>` | OpenStreetMap's daily replication diffs (osmChange, every edit worldwide in a UTC day) for 2025-11-01 – 2026-10-31: 365 files, about 31 GB, kept outside the repository |
| `scripts/day21/count_edits.py --cache <dir> --out <dir>` | Every node in each diff (created / modified / deleted, at its position) counted on fine grids by UTC hour: Japan's 0.005° cells and the world's 0.05° cells, one `.npz` per day |
| `scripts/day21/pack_edits.py --counts <dir>` | The counts coarsened to points for the zoomed-out views — Japan (inside a rough outline) on 0.01° cells per hour, the world on 0.25° cells per day — sorted by time and gzipped → `public/data/day21/japan.bin`, `world.bin` (+ `.json` with the grid and daily totals) |
| `scripts/day24/infer_flows.py <area> <day>` | HELLO CYCLING rides guessed from the GBFS `station_status` 5-minute snapshots on S3 (bikes in docks stepping down at one station and up at another): the transport problem solved 40 times over random assumptions and averaged, and the doubly constrained gravity model (Sinkhorn) → `scripts/.cache/day24/flows_<area>_<day>_<method>.json` (+ a preview image) |
| `scripts/day24/export_flows.py <area> <day> ...` | The guessed flows with an end in the map's box, by hour of leaving, as 8-byte records, and each station's bikes in docks per 5 minutes → `public/data/day24/<area>.json`, `<area>_<day>_<method>.bin`, `<area>_<day>_docked.bin` |
| `scripts/day24/fetch_rain.py <day> ...` | JMA's 10-minute precipitation at AMeDAS Chiba for those days → `public/data/day24/rain.json` |
| `scripts/day25/fetch_osm.py` | Everything OpenStreetMap has around Komazawa Olympic Park (Overpass API) → `scripts/.cache/day25/komazawa.json` |
| `scripts/day25/build_park.py` | The park as a plan for a wooden toy, in metres round its middle: outline, areas (pitches, playgrounds, lawns, …), buildings, paths as surfaces, the jogging, cycling and family courses as loops, white lines on the pitches, the stadium's track and stands, and trees planted in the green (OSM has hardly any) → `public/data/day25/park.json` |
| `scripts/day26/fetch_champi.py` | Typhoon Champi (2026): its track from IBTrACS, and Himawari-9's band 13 (10.4 µm) hour by hour from 15 to 26 October, decoded from the full disk's Himawari Standard Data on AWS to brightness temperature on a 0.125° grid (105–175°E, 0–45°N), a day's 24 scenes to a WebP; and Day 1's coastlines clipped to that box for the 2D minimap → `public/data/day26/champi.json`, `clouds-NN.webp`, `coast.json` |
| `scripts/day26/fetch_waves.py` | The waves under Champi from ECMWF's open data (IFS wave model: height, direction, period), every 3 hours from 15 to 26 October 2026 (each run's analysis and its +3 h forecast), from the archive on Google Cloud, cut to 100–180°E, 5°S–48°N at 0.25°, a scene per lossless WebP (a byte each) → `public/data/day26/waves/NNN.webp`, `waves.json` |
| `scripts/day26/fetch_winds.py` | For the shelved first take (`/day/26-clouds`, the storm's clouds in 3D): the winds round Champi from ECMWF's open data (IFS: u, v at 850 and 200 hPa), every 3 hours (the 00z and 12z runs' analyses and +3/6/9 h forecasts), cut to 100–180°E, 5°S–48°N at 0.5°, a scene per lossless WebP (850 hPa over 200 hPa, a byte each) → `public/data/day26/winds/NNN.webp`, `winds.json` |
| `scripts/day26/fetch_sst.py` | The sea surface temperature under Champi (NOAA OISST v2.1, daily, 13–28 October 2026), over the waves' box (100°E–130°W, 5°S–48°N, 0.25°), a day per lossless grayscale WebP ((°C + 2) × 6 a byte) → `public/data/day26/sst/NN.webp`, `sst.json` |
| `scripts/day27/fetch_himawari.py` | Himawari-9's band 13 every 10 minutes near its own resolution (0.03°, 115–160°E, 3–35°N) round Typhoon Champi from 20:30 UTC on 19 October to 09:30 UTC on 20 October 2026, decoded as in Day 26 → `scripts/.cache/day27/b13.npz` |
| `scripts/day27/fetch_terrain.py` | Mapterhorn's DEM (Terrarium tiles, z6) over 110–160°E, 5°S–40°N, onto a 0.02° grid, for the land in Day 27's video → `scripts/.cache/day27/terrain.npz` |
| `scripts/day27/render.py` | Day 27's video: the scans raised into cloud and raymarched frame by frame over the sea (Day 12's fluid stirred by Day 26's waves, colored by its temperature), the land and the track, under the air, in OpenGL shaders (ModernGL, no window; `scripts/day27/shaders/`), between scans along their optical flow, piped into ffmpeg (imageio-ffmpeg's) → `public/data/day27/champi.mp4` (`--no-clouds`: `champi-noclouds.mp4`); `--still HH:MM` for one frame |

## Deployment (GitHub Pages)

1. Create a GitHub repository and push to `main`.
2. In **Settings → Pages → Source**, select **GitHub Actions**.
3. `.github/workflows/deploy.yml` runs on every push to `main` and publishes the site.

`NUXT_APP_BASE_URL` is set from the repository name in the workflow (`https://<user>.github.io/<repo>/`). If you use a user site (`<user>.github.io`), set it to `/`.
