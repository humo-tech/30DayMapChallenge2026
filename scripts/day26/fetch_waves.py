"""Day 26 (Water): the ocean waves under Typhoon Champi, from ECMWF's open data.

The same three fields of the IFS wave model (ECWAM) as Day 12 (swh, mwd, mwp:
significant height, mean direction, mean period) every 3 hours from 15 to 26
October 2026: each 6-hourly run's analysis (step 0) and its 3-hour forecast in
between, from the open data's archive on Google Cloud (CC BY 4.0; the same files
as on AWS, which throttles hard). Cut to 100°E-130°W (across 180°: the
global grid's two ends joined there), 5°S-48°N, on the model's 0.25° grid.

Each scene is one RGB WebP (lossless), north up: a byte each for the height
(0.1 m), the direction (where they come from, 360°/256) and the period (0.1 s);
land and sea ice 255 in all three. The map blends them hour by hour.

Usage:
    python scripts/day26/fetch_waves.py [--workers 8]
"""

import argparse
import datetime as dt
import importlib.util
import json
import time
import urllib.error
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
from PIL import Image

# Day 12's fields, GRIB decoding and fetch (under a name of its own: this module has the same)
_spec = importlib.util.spec_from_file_location("day12_fetch_waves", Path(__file__).resolve().parents[1] / "day12" / "fetch_waves.py")
day12 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(day12)
PARAMS, decode, fetch_once = day12.PARAMS, day12.decode, day12.fetch

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / "scripts" / ".cache" / "day26" / "waves"
OUT_DIR = ROOT / "public" / "data" / "day26" / "waves"

BASE = "https://storage.googleapis.com/ecmwf-open-data/{date}/{run}z/ifs/0p25/wave/{date}{run}0000-{step}h-wave-fc"
START = dt.datetime(2026, 10, 15, 0)
END = dt.datetime(2026, 10, 26, 18)
EVERY = 3
# (east past 180°: 230 is 130°W)
WEST, EAST, SOUTH, NORTH = 100.0, 230.0, -5.0, 48.0
LAND = 255


def fetch(url: str, byte_range: tuple[int, int] | None = None) -> bytes:
    """(S3 asks to slow down now and then: try again, waiting longer each time)"""
    for attempt in range(6):
        try:
            return fetch_once(url, byte_range)
        except urllib.error.HTTPError as e:
            if e.code not in (500, 503) or attempt == 5:
                raise
            time.sleep(2**attempt)
    raise AssertionError


def scene(t: dt.datetime) -> np.ndarray:
    """swh, mwd, mwp at t over the box, (lat, lng, 3), north first; NaN on land."""
    cached = CACHE / f"{t:%Y%m%d%H}.npy"
    if cached.exists():
        return np.load(cached)
    run = t.replace(hour=t.hour // 6 * 6)
    step = int((t - run).total_seconds() // 3600)
    base = BASE.format(date=f"{run:%Y%m%d}", run=f"{run:%H}", step=step)
    entries = [json.loads(line) for line in fetch(base + ".index").decode().splitlines() if line.strip()]
    fields = []
    for param in PARAMS:
        entry = next(e for e in entries if e["param"] == param)
        values, grid = decode(fetch(base + ".grib2", (entry["_offset"], entry["_length"])))
        # Rows from 90°N, columns from 180°W
        j0 = round((grid["lat0"] - NORTH) / grid["dlon"])
        j1 = round((grid["lat0"] - SOUTH) / grid["dlon"])
        # Columns from WEST to EAST, round past 180° to the grid's start again
        i0 = round((WEST + 180) / grid["dlon"])
        i1 = round((EAST + 180) / grid["dlon"])
        columns = np.arange(i0, i1 + 1) % values.shape[1]
        fields.append(values[j0 : j1 + 1][:, columns])
    data = np.stack(fields, axis=-1)
    CACHE.mkdir(parents=True, exist_ok=True)
    np.save(cached, data)
    print(f"  {t:%Y-%m-%d %H}:00 (run {run:%d %H}z +{step}h)")
    return data


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workers", type=int, default=8)
    args = parser.parse_args()

    times = []
    t = START
    while t <= END:
        times.append(t)
        t += dt.timedelta(hours=EVERY)
    with ThreadPoolExecutor(args.workers) as pool:
        scenes = list(pool.map(scene, times))

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for old in OUT_DIR.glob("*.webp"):
        old.unlink()
    size = 0
    for i, data in enumerate(scenes):
        land = np.isnan(data).any(axis=-1)
        q = np.stack(
            [
                np.clip(np.rint(np.nan_to_num(data[..., 0]) * 10), 0, 254),
                np.rint(np.nan_to_num(data[..., 1]) % 360 / 360 * 256) % 256,
                np.clip(np.rint(np.nan_to_num(data[..., 2]) * 10), 0, 254),
            ],
            axis=-1,
        ).astype(np.uint8)
        # (the height stops at 254: land is the only 255 there)
        q[land] = LAND
        path = OUT_DIR / f"{i:03d}.webp"
        Image.fromarray(q, "RGB").save(path, "WEBP", lossless=True, quality=100, method=6)
        size += path.stat().st_size
    h, w = scenes[0].shape[:2]
    meta = {
        "start": START.strftime("%Y-%m-%dT%H:%MZ"),
        "every": EVERY,
        "frames": len(times),
        "width": w,
        "height": h,
        "lat0": NORTH,
        "lng0": WEST,
        "dlon": 0.25,
        "scale": {"swh": 0.1, "mwd": 360 / 256, "mwp": 0.1},
        "land": LAND,
        "source": "ECMWF open data, IFS wave model (CC BY 4.0)",
    }
    (OUT_DIR / "waves.json").write_text(json.dumps(meta, indent=2) + "\n")
    swh = np.nanmax([np.nanmax(s[..., 0]) for s in scenes])
    print(f"{len(times)} scenes, {w} x {h}, swh up to {swh:.1f} m; {size / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
