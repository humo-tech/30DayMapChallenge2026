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

## Deployment (GitHub Pages)

1. Create a GitHub repository and push to `main`.
2. In **Settings → Pages → Source**, select **GitHub Actions**.
3. `.github/workflows/deploy.yml` runs on every push to `main` and publishes the site.

`NUXT_APP_BASE_URL` is set from the repository name in the workflow (`https://<user>.github.io/<repo>/`). If you use a user site (`<user>.github.io`), set it to `/`.
