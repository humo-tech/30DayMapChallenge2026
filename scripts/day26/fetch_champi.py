"""Day 26 (Water): Typhoon Champi (2026) over the warm Philippine Sea.

Two sources over the western North Pacific (105-175°E, 0-45°N); the waves and
the winds come from fetch_waves.py and fetch_winds.py:

- track: IBTrACS v04r01 (NOAA NCEI), the western Pacific list. Champi's
  3-hourly fixes: position, maximum wind (JTWC, kt), central pressure (JMA,
  else JTWC; hPa), radius of maximum wind and of gale-force (34 kt) wind (nm).
- clouds: Himawari-9's band 13 (10.4 µm, the infrared "clean window") from
  NOAA's open data on AWS, the full disk's Himawari Standard Data. The few
  segments over the box are decoded here (counts -> radiance -> brightness
  temperature), averaged onto a 0.125° grid and quantized to a byte: (Tb - 180 K)
  x 2, so 0.5 K steps from 180 K (the coldest cloud tops) to 307.5 K (warm sea).
  A scene every `--every` hours, a day's 24 at a time tiled 4 across and 6
  down (north up) in a grayscale lossy WebP (quality 80: 4 MB in all, off by
  about 1 K on average; raw, they'd be 39 MB).

Also the coastlines over the box, for the map's 2D minimap of the scenes: Day
1's (public/data/day01/coastline.geojson: Overture for Japan, Natural Earth
elsewhere), clipped and simplified to about 0.03° -> coast.json.

The map works out the rest: cloud-top height from the brightness temperature,
and what kind of cloud it is.

Usage:
    python scripts/day26/fetch_champi.py [--every 1] [--res 0.125] [--workers 8]
"""

import argparse
import bz2
import csv
import datetime as dt
import io
import json
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
from PIL import Image
from shapely.geometry import box, shape

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / "scripts" / ".cache" / "day26"
OUT_DIR = ROOT / "public" / "data" / "day26"

STORM = ("2026", "CHAMPI")
WEST, EAST, SOUTH, NORTH = 105.0, 175.0, 0.0, 45.0
# The clouds: from just before Champi was named to its last fix
START = dt.datetime(2026, 10, 15, 0, tzinfo=dt.timezone.utc)
END = dt.datetime(2026, 10, 26, 18, tzinfo=dt.timezone.utc)

IBTRACS = "https://www.ncei.noaa.gov/data/international-best-track-archive-for-climate-stewardship-ibtracs/v04r01/access/csv/ibtracs.WP.list.v04r01.csv"
HIMAWARI = "https://noaa-himawari9.s3.amazonaws.com/AHI-L1b-FLDK/{t:%Y/%m/%d/%H%M}/HS_H09_{t:%Y%m%d_%H%M}_B13_FLDK_R20_S{seg:02d}10.DAT.bz2"

TB_MIN = 180.0
TB_STEP = 0.5
SEGMENT_LINES = 550
ATLAS_COLUMNS = 4
ATLAS_FRAMES = 24
WEBP_QUALITY = 80


def fetch(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=180) as res:
        return res.read()


def cached(path: Path, url: str) -> Path:
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".part")
        tmp.write_bytes(fetch(url))
        tmp.rename(path)
    return path


# --- track -------------------------------------------------------------------


def number(s: str) -> float | None:
    s = s.strip()
    return float(s) if s else None


def build_track() -> list[dict]:
    path = cached(CACHE / "ibtracs.WP.csv", IBTRACS)
    with path.open(newline="") as f:
        rows = list(csv.DictReader(f))
    rows = [r for r in rows[1:] if (r["SEASON"], r["NAME"]) == STORM]  # the second row is units
    if not rows:
        raise SystemExit(f"{STORM} not in IBTrACS")
    track = []
    for r in rows:
        t = dt.datetime.fromisoformat(r["ISO_TIME"]).replace(tzinfo=dt.timezone.utc)
        r34 = [number(r[f"USA_R34_{q}"]) for q in ("NE", "SE", "SW", "NW")]
        r34 = [x for x in r34 if x]
        track.append(
            {
                "hour": (t - START).total_seconds() / 3600,
                "lat": float(r["LAT"]),
                "lon": float(r["LON"]),
                "wind": number(r["USA_WIND"]) or number(r["TOKYO_WIND"]) or 0,
                "pressure": number(r["TOKYO_PRES"]) or number(r["USA_PRES"]),
                "rmw": number(r["USA_RMW"]),
                "r34": round(sum(r34) / len(r34)) if r34 else None,
            }
        )
    # Fill the gaps in the radii from the fixes either side (the map needs them everywhere)
    for key, fallback in (("rmw", 30), ("r34", 0)):
        known = [(p["hour"], p[key]) for p in track if p[key] is not None]
        for p in track:
            if p[key] is None:
                p[key] = round(float(np.interp(p["hour"], *zip(*known)))) if known else fallback
    return track


# --- Himawari Standard Data ------------------------------------------------------


class Hsd:
    """One segment of one band: its header blocks, decoded, and its counts."""

    def __init__(self, raw: bytes):
        buf = io.BytesIO(raw)
        blocks = {}
        header_length = None
        while header_length is None or buf.tell() < header_length:
            start = buf.tell()
            number_, length = np.frombuffer(buf.read(3), dtype=np.dtype([("n", "u1"), ("len", "<u2")]))[0]
            blocks[int(number_)] = raw[start : start + int(length)]
            if number_ == 1:
                header_length = int(np.frombuffer(blocks[1][70:74], "<u4")[0])
            buf.seek(start + int(length))
        b2, b3, b5, b7 = blocks[2], blocks[3], blocks[5], blocks[7]
        self.columns, self.lines = (int(x) for x in np.frombuffer(b2[5:9], "<u2"))
        self.sub_lon = float(np.frombuffer(b3[3:11], "<f8")[0])
        self.cfac, self.lfac = (int(x) for x in np.frombuffer(b3[11:19], "<u4"))
        self.coff, self.loff = (float(x) for x in np.frombuffer(b3[19:27], "<f4"))
        self.h, self.req, self.rpol = (float(x) for x in np.frombuffer(b3[27:51], "<f8"))
        self.wavelength = float(np.frombuffer(b5[5:13], "<f8")[0])  # µm
        self.error_count, self.outside_count = (int(x) for x in np.frombuffer(b5[15:19], "<u2"))
        self.gain, self.offset = (float(x) for x in np.frombuffer(b5[19:35], "<f8"))
        (self.c0, self.c1, self.c2, _, _, _, self.c, self.planck, self.boltzmann) = (
            float(x) for x in np.frombuffer(b5[35:107], "<f8")
        )
        self.first_line = int(np.frombuffer(b7[5:7], "<u2")[0])
        self.counts = np.frombuffer(raw[header_length:], "<u2").reshape(self.lines, self.columns)

    def brightness(self) -> np.ndarray:
        """Brightness temperature (K); NaN off the disk (space, ~70 K) and where the count is bad."""
        radiance = self.counts * self.gain + self.offset  # W m-2 sr-1 µm-1
        lam = self.wavelength * 1e-6
        with np.errstate(invalid="ignore", divide="ignore"):
            te = (self.planck * self.c / (self.boltzmann * lam)) / np.log(
                2 * self.planck * self.c**2 / (lam**5 * radiance * 1e6) + 1
            )
        tb = self.c0 + self.c1 * te + self.c2 * te**2
        tb[(self.counts == self.error_count) | (self.counts == self.outside_count) | (radiance <= 0) | (tb < 150)] = np.nan
        return tb

    def line_column(self, lat: np.ndarray, lon: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """Full-disk line and column (1-based, fractional) of each point (JMA's navigation)."""
        phi = np.radians(lat)
        c_lat = np.arctan(self.rpol**2 / self.req**2 * np.tan(phi))
        e2 = (self.req**2 - self.rpol**2) / self.req**2
        rl = self.rpol / np.sqrt(1 - e2 * np.cos(c_lat) ** 2)
        dlon = np.radians(lon - self.sub_lon)
        r1 = self.h - rl * np.cos(c_lat) * np.cos(dlon)
        r2 = -rl * np.cos(c_lat) * np.sin(dlon)
        r3 = rl * np.sin(c_lat)
        rn = np.sqrt(r1**2 + r2**2 + r3**2)
        x = np.degrees(np.arctan2(-r2, r1))
        y = np.degrees(np.arcsin(-r3 / rn))
        return self.loff + y * 2.0**-16 * self.lfac, self.coff + x * 2.0**-16 * self.cfac


def segment(t: dt.datetime, seg: int) -> Hsd:
    return Hsd(bz2.decompress(fetch(HIMAWARI.format(t=t, seg=seg))))


class CloudGrid:
    """The grid's cells, each the mean of SUB x SUB nearest pixels inside it."""

    SUB = 5

    def __init__(self, res: float, nav: Hsd):
        self.width = round((EAST - WEST) / res)
        self.height = round((NORTH - SOUTH) / res)
        n = self.SUB
        fine = res / n
        lon = WEST + fine * (np.arange(self.width * n) + 0.5)
        lat = SOUTH + fine * (np.arange(self.height * n) + 0.5)
        line, column = nav.line_column(*np.meshgrid(lat, lon, indexing="ij"))
        self.line = np.rint(line).astype(int)
        self.column = np.rint(column).astype(int) - 1
        lo, hi = self.line.min(), self.line.max()
        self.segments = list(range((lo - 1) // SEGMENT_LINES + 1, (hi - 1) // SEGMENT_LINES + 2))

    def resample(self, segments: list[Hsd]) -> np.ndarray:
        first = segments[0].first_line
        tb = np.concatenate([s.brightness() for s in segments])
        fine = tb[self.line - first, self.column]
        n = self.SUB
        with np.errstate(invalid="ignore"):
            cells = np.nanmean(fine.reshape(self.height, n, self.width, n), axis=(1, 3))
        return cells


def build_clouds(every: int, res: float, workers: int) -> tuple[np.ndarray, dict]:
    times = []
    t = START
    while t <= END:
        times.append(t)
        t += dt.timedelta(hours=every)

    # The grid's pixels, from the first scene's navigation (the same for every scene)
    nav = segment(START, 4)
    grid = CloudGrid(res, nav)
    print(f"clouds: {grid.width} x {grid.height}, segments {grid.segments}, {len(times)} scenes")

    cache = CACHE / "clouds" / f"{res}"
    cache.mkdir(parents=True, exist_ok=True)

    def scene(t: dt.datetime) -> np.ndarray:
        path = cache / f"{t:%Y%m%d_%H%M}.npy"
        if path.exists():
            return np.load(path)
        cells = grid.resample([segment(t, s) for s in grid.segments])
        np.save(path, cells)
        print(f"  {t:%Y-%m-%d %H:%M}")
        return cells

    with ThreadPoolExecutor(workers) as pool:
        scenes = list(pool.map(scene, times))
    tb = np.stack(scenes)
    # Gaps (a missed scan): the scene either side
    for i in range(len(tb)):
        bad = np.isnan(tb[i])
        if bad.any():
            near = tb[max(0, i - 1)] if i > 0 else tb[i + 1]
            tb[i][bad] = near[bad]
    q = np.clip(np.rint((np.nan_to_num(tb, nan=300.0) - TB_MIN) / TB_STEP), 0, 255).astype(np.uint8)
    meta = {
        "start": START.isoformat().replace("+00:00", "Z"),
        "every": every,
        "frames": len(times),
        "width": grid.width,
        "height": grid.height,
        "west": WEST,
        "south": SOUTH,
        "step": res,
        "tbMin": TB_MIN,
        "tbStep": TB_STEP,
        "atlas": {"columns": ATLAS_COLUMNS, "frames": ATLAS_FRAMES, "files": (len(times) + ATLAS_FRAMES - 1) // ATLAS_FRAMES},
    }
    return q, meta


def write_atlases(q: np.ndarray) -> None:
    """A day's scenes at a time, tiled left to right, top to bottom, each north up."""
    frames, h, w = q.shape
    for f, first in enumerate(range(0, frames, ATLAS_FRAMES)):
        block = q[first : first + ATLAS_FRAMES]
        rows = (ATLAS_FRAMES + ATLAS_COLUMNS - 1) // ATLAS_COLUMNS
        atlas = np.zeros((rows * h, ATLAS_COLUMNS * w), np.uint8)
        for i, scene in enumerate(block):
            y, x = divmod(i, ATLAS_COLUMNS)
            atlas[y * h : (y + 1) * h, x * w : (x + 1) * w] = scene[::-1]
        Image.fromarray(atlas).save(OUT_DIR / f"clouds-{f:02d}.webp", "WEBP", quality=WEBP_QUALITY, method=6)


def build_coast() -> list[list[list[float]]]:
    """Day 1's coastlines over the box, simplified: lines of [lng, lat]."""
    src = json.loads((ROOT / "public" / "data" / "day01" / "coastline.geojson").read_text())
    clip = box(WEST, SOUTH, EAST, NORTH)
    lines = []
    for f in src["features"]:
        g = shape(f["geometry"]).intersection(clip).simplify(0.03)
        for part in getattr(g, "geoms", [g]):
            if part.geom_type == "LineString" and part.length > 0.1:
                lines.append([[round(x, 2), round(y, 2)] for x, y in part.coords])
    return lines


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--every", type=int, default=1, help="hours between cloud scenes")
    parser.add_argument("--res", type=float, default=0.125, help="cloud grid (°)")
    parser.add_argument("--workers", type=int, default=8)
    args = parser.parse_args()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    track = build_track()
    clouds, cloud_meta = build_clouds(args.every, args.res, args.workers)

    write_atlases(clouds)
    coast = build_coast()
    (OUT_DIR / "coast.json").write_text(json.dumps(coast, separators=(",", ":")))
    meta = {
        "name": "Champi",
        "track": track,
        "clouds": cloud_meta,
    }
    (OUT_DIR / "champi.json").write_text(json.dumps(meta, separators=(",", ":")))
    webp = sum(p.stat().st_size for p in OUT_DIR.glob("clouds-*.webp"))
    print(f"track: {len(track)} fixes; clouds: {webp / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
