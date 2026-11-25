"""Day 26 (Water): the sea surface temperature under Typhoon Champi.

NOAA's OISST v2.1, daily on its 0.25° grid, from 13 to 28 October 2026 (a
couple of days either side of the storm), over the same box as the waves
(fetch_waves.py): 100°E-130°W, 5°S-48°N. OISST's longitudes run 0-360°, so
the box is one cut across 180°.

Each day is one grayscale WebP (lossless), north up: (°C + 2) x 6, a byte, so
steps of 1/6 °C from -2 °C to 40.3 °C; land and sea ice 255. The map blends
them hour by hour (each day's value at its noon: it's a daily mean).

Usage:
    python scripts/day26/fetch_sst.py
"""

import datetime as dt
import json
import urllib.request
from pathlib import Path

import h5py
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / "scripts" / ".cache" / "day26" / "oisst"
OUT_DIR = ROOT / "public" / "data" / "day26" / "sst"

OISST = "https://www.ncei.noaa.gov/data/sea-surface-temperature-optimum-interpolation/v2.1/access/avhrr/{ym}/oisst-avhrr-v02r01.{ymd}.nc"
DAYS = (dt.date(2026, 10, 13), dt.date(2026, 10, 28))
# (east past 180°: 230 is 130°W)
WEST, EAST, SOUTH, NORTH = 100.0, 230.0, -5.0, 48.0
STEP = 0.25
OFFSET = 2.0
SCALE = 6.0
LAND = 255


def day_file(day: dt.date) -> Path:
    url = OISST.format(ym=day.strftime("%Y%m"), ymd=day.strftime("%Y%m%d"))
    path = CACHE / url.rsplit("/", 1)[1]
    if not path.exists():
        CACHE.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(url, timeout=300) as res:
            path.write_bytes(res.read())
    return path


def main() -> None:
    days = [DAYS[0] + dt.timedelta(days=i) for i in range((DAYS[1] - DAYS[0]).days + 1)]
    # OISST's cell centres: 0.125°, 0.375°, ... east, and from 89.875°S north
    i0 = round((WEST + STEP / 2 - 0.125) / STEP)
    i1 = round((EAST - STEP / 2 - 0.125) / STEP)
    j0 = round((SOUTH + STEP / 2 + 89.875) / STEP)
    j1 = round((NORTH - STEP / 2 + 89.875) / STEP)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for old in OUT_DIR.glob("*.webp"):
        old.unlink()
    size = 0
    low, high = 99.0, -99.0
    for k, day in enumerate(days):
        with h5py.File(day_file(day), "r") as f:
            v = f["sst"]
            raw = v[0, 0, j0 : j1 + 1, i0 : i1 + 1]
            sst = raw * v.attrs["scale_factor"][0] + v.attrs["add_offset"][0]
            land = raw == v.attrs["_FillValue"][0]
        low, high = min(low, sst[~land].min()), max(high, sst[~land].max())
        q = np.clip(np.rint((sst + OFFSET) * SCALE), 0, 254).astype(np.uint8)
        q[land] = LAND
        path = OUT_DIR / f"{k:02d}.webp"
        # North up: OISST's rows run from the south
        Image.fromarray(q[::-1], "L").save(path, "WEBP", lossless=True, quality=100, method=6)
        size += path.stat().st_size
    meta = {
        "days": [d.isoformat() for d in days],
        "width": i1 - i0 + 1,
        "height": j1 - j0 + 1,
        # The first column's and the first (north) row's cell centres
        "lng0": 0.125 + i0 * STEP,
        "lat0": -89.875 + j1 * STEP,
        "step": STEP,
        "offset": OFFSET,
        "scale": SCALE,
        "land": LAND,
        "source": "NOAA OISST v2.1",
    }
    (OUT_DIR / "sst.json").write_text(json.dumps(meta, indent=2) + "\n")
    print(f"{len(days)} days, {meta['width']} x {meta['height']}, {low:.1f}-{high:.1f} °C; {size / 1e6:.2f} MB")


if __name__ == "__main__":
    main()
