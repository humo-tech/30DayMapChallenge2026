"""Day 26 (Water): the winds round Typhoon Champi, from ECMWF's open data.

The IFS model's wind (u, v: east and north, m/s) at two levels: 850 hPa (about
1.5 km up, where the air spirals in) and 200 hPa (about 12 km, where it fans
out over the tops), every 3 hours from 15 to 26 October 2026: the 00z and 12z
runs' analyses (step 0) and their 3, 6 and 9-hour forecasts in between (the
06z and 18z runs have no such fields in the open data), from the archive on
Google Cloud (CC BY 4.0). Cut to 100-180°E, 5°S-48°N, and thinned to 0.5°
(the clouds only drift with it).

Each scene is one RGB WebP (lossless), north up, the 850 hPa wind over the 200
hPa one (twice as tall as the box): u, v a byte each, (m/s / 0.75) + 128, so
±96 m/s (blue unused: no alpha, which a canvas would premultiply). The map
drifts the clouds' detail with it, the low clouds with the one, the high with
the other.

Usage:
    python scripts/day26/fetch_winds.py [--workers 4]
"""

import argparse
import datetime as dt
import json
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
# The same times as the waves, their fetch (with retries) and Day 12's GRIB decoding
from fetch_waves import END, EVERY, START, decode, fetch  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / "scripts" / ".cache" / "day26" / "winds"
OUT_DIR = ROOT / "public" / "data" / "day26" / "winds"

BASE = "https://storage.googleapis.com/ecmwf-open-data/{date}/{run}z/ifs/0p25/oper/{date}{run}0000-{step}h-oper-fc"
FIELDS = [("u", "850"), ("v", "850"), ("u", "200"), ("v", "200")]
WEST, EAST, SOUTH, NORTH = 100.0, 180.0, -5.0, 48.0
THIN = 2
SCALE = 0.75


def scene(t: dt.datetime) -> np.ndarray:
    """u850, v850, u200, v200 at t over the box, (lat, lng, 4), north first, every 0.5°."""
    cached = CACHE / f"{t:%Y%m%d%H}.npy"
    if cached.exists():
        return np.load(cached)
    run = t.replace(hour=t.hour // 12 * 12)
    step = int((t - run).total_seconds() // 3600)
    base = BASE.format(date=f"{run:%Y%m%d}", run=f"{run:%H}", step=step)
    entries = [json.loads(line) for line in fetch(base + ".index").decode().splitlines() if line.strip()]
    fields = []
    for param, level in FIELDS:
        entry = next(e for e in entries if e["param"] == param and e.get("levelist") == level)
        values, grid = decode(fetch(base + ".grib2", (entry["_offset"], entry["_length"])))
        j0 = round((grid["lat0"] - NORTH) / grid["dlon"])
        j1 = round((grid["lat0"] - SOUTH) / grid["dlon"])
        i0 = round((WEST + 180) / grid["dlon"])
        i1 = min(round((EAST + 180) / grid["dlon"]), values.shape[1] - 1)
        fields.append(values[j0 : j1 + 1 : THIN, i0 : i1 + 1 : THIN])
    data = np.stack(fields, axis=-1)
    CACHE.mkdir(parents=True, exist_ok=True)
    np.save(cached, data)
    print(f"  {t:%Y-%m-%d %H}:00 (run {run:%d %H}z +{step}h)")
    return data


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workers", type=int, default=4)
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
        q = np.clip(np.rint(np.nan_to_num(data) / SCALE) + 128, 0, 255).astype(np.uint8)
        blue = np.full(q.shape[:2] + (1,), 128, np.uint8)
        stacked = np.concatenate([np.concatenate([q[..., 0:2], blue], -1), np.concatenate([q[..., 2:4], blue], -1)])
        path = OUT_DIR / f"{i:03d}.webp"
        Image.fromarray(stacked, "RGB").save(path, "WEBP", lossless=True, quality=100, method=6)
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
        "step": 0.25 * THIN,
        "fields": ["u850", "v850", "u200", "v200"],
        "scale": SCALE,
        "source": "ECMWF open data, IFS (CC BY 4.0)",
    }
    (OUT_DIR / "winds.json").write_text(json.dumps(meta, indent=2) + "\n")
    speed = np.hypot(np.stack(scenes)[..., 2], np.stack(scenes)[..., 3]).max()
    print(f"{len(times)} scenes, {w} x {h}; 200 hPa up to {speed:.0f} m/s; {size / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
