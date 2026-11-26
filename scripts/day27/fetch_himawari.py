"""Day 27 (New Tool): Typhoon Champi's day at its strongest, every Himawari scan.

Himawari-9's band 13 (10.4 µm) as in Day 26 (scripts/day26/fetch_champi.py:
the same decoding of the full disk's Himawari Standard Data from NOAA's open
data on AWS), but every 10 minutes and near the sensor's own resolution (about
2 km under the satellite): 0.03° here, as fine as the video shows them from
3000 km and more, over all it sees round the storm (Day 26 averaged to
0.125°, small enough to ship to a browser; here only the video leaves the
machine). From
20:30 UTC on 19 October 2026 to 09:30 UTC on the 20th, 13 hours as the storm
(about 136°E) deepened to 902 hPa. Each pixel of the grid reads
the scan bilinearly; a missed scan (Himawari skips a few for housekeeping) is
left out, and the video follows the flow across the gap.

-> scripts/.cache/day27/b13.npz: tb (scans, lat, lng; south first; K,
   float16), their times (ISO), and the grid (west, south, step).

Usage:
    python scripts/day27/fetch_himawari.py [--workers 8]
"""

import argparse
import datetime as dt
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "day26"))
# Day 26's Himawari Standard Data: the fetch, the segments' decoding and navigation
from fetch_champi import SEGMENT_LINES, Hsd, segment  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / "scripts" / ".cache" / "day27"

WEST, EAST, SOUTH, NORTH = 115.0, 160.0, 3.0, 35.0
STEP = 0.03
START = dt.datetime(2026, 10, 19, 20, 30, tzinfo=dt.timezone.utc)
END = dt.datetime(2026, 10, 20, 9, 30, tzinfo=dt.timezone.utc)
EVERY = dt.timedelta(minutes=10)


class Grid:
    """Where each cell's middle falls on the full disk (0-based line and column, fractional)."""

    def __init__(self, nav: Hsd):
        self.width = round((EAST - WEST) / STEP)
        self.height = round((NORTH - SOUTH) / STEP)
        lon = WEST + STEP * (np.arange(self.width) + 0.5)
        lat = SOUTH + STEP * (np.arange(self.height) + 0.5)
        line, column = nav.line_column(*np.meshgrid(lat, lon, indexing="ij"))
        self.line = line - 1
        self.column = column - 1
        lo, hi = int(self.line.min()), int(self.line.max()) + 2
        self.segments = list(range(lo // SEGMENT_LINES + 1, hi // SEGMENT_LINES + 2))

    def resample(self, segments: list[Hsd]) -> np.ndarray:
        first = segments[0].first_line - 1
        tb = np.concatenate([s.brightness() for s in segments]).astype(np.float32)
        tb = np.nan_to_num(tb, nan=300.0)
        return cv2.remap(
            tb,
            self.column.astype(np.float32),
            (self.line - first).astype(np.float32),
            cv2.INTER_LINEAR,
            borderMode=cv2.BORDER_REPLICATE,
        )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workers", type=int, default=8)
    args = parser.parse_args()

    times = []
    t = START
    while t <= END:
        times.append(t)
        t += EVERY
    grid = Grid(segment(START, 4))
    print(f"{grid.width} x {grid.height}, segments {grid.segments}, {len(times)} scans")

    cache = CACHE / f"b13_{STEP}"
    cache.mkdir(parents=True, exist_ok=True)

    def scan(t: dt.datetime) -> np.ndarray | None:
        path = cache / f"{t:%Y%m%d_%H%M}.npy"
        if path.exists():
            return np.load(path)
        try:
            tb = grid.resample([segment(t, s) for s in grid.segments])
        except Exception as e:  # noqa: BLE001 (a scan that isn't there)
            print(f"  {t:%Y-%m-%d %H:%M} missing ({e})")
            return None
        np.save(path, tb.astype(np.float16))
        print(f"  {t:%Y-%m-%d %H:%M}")
        return tb

    with ThreadPoolExecutor(args.workers) as pool:
        scans = list(pool.map(scan, times))
    kept = [(t, s) for t, s in zip(times, scans) if s is not None]
    tb = np.stack([s for _, s in kept]).astype(np.float16)
    np.savez(
        CACHE / "b13.npz",
        tb=tb,
        times=np.array([t.strftime("%Y-%m-%dT%H:%MZ") for t, _ in kept]),
        grid=np.array([WEST, SOUTH, STEP]),
    )
    print(f"tb {tb.shape}, {float(tb.min()):.0f} - {float(tb.max()):.0f} K")


if __name__ == "__main__":
    main()
