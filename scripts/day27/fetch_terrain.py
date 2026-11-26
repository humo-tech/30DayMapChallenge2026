"""Day 27 (New Tool): the land round Typhoon Champi, for the video's relief.

Mapterhorn's DEM (Terrarium-encoded WebP tiles, as Day 26 draped it in
Navara), z6 (about 1 km a pixel here; seen from a thousand km, finer shows
nothing more), over 110-160°E, 5°S-40°N: the Philippines, Taiwan, the
Ryukyus, the Marianas. Decoded (R x 256 + G + B / 256 - 32768 m) and taken
from Web Mercator onto a 0.02° grid. The sea is 0 m in the DEM.

-> scripts/.cache/day27/terrain.npz: elevation (lat, lng; south first; m,
   float16) and the grid (west, south, step).

Usage:
    python scripts/day27/fetch_terrain.py [--workers 8]
"""

import argparse
import io
import math
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / "scripts" / ".cache" / "day27"

URL = "https://tiles.mapterhorn.com/{z}/{x}/{y}.webp"
Z = 6
TILE = 512
WEST, EAST, SOUTH, NORTH = 110.0, 160.0, -5.0, 40.0
STEP = 0.02


def tile_xy(lon: float, lat: float) -> tuple[float, float]:
    """Fractional tile coordinates at Z."""
    n = 2**Z
    y = (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n
    return (lon + 180) / 360 * n, y


def tile(x: int, y: int) -> np.ndarray:
    path = CACHE / "terrain" / f"{Z}_{x}_{y}.webp"
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        # (the server turns away Python's default User-Agent)
        req = urllib.request.Request(URL.format(z=Z, x=x, y=y), headers={"User-Agent": "30DayMapChallenge2026 (day27)"})
        try:
            with urllib.request.urlopen(req, timeout=60) as res:
                path.write_bytes(res.read())
        except urllib.error.HTTPError as e:
            # (no tile: open sea)
            if e.code != 404:
                raise
            return np.zeros((TILE, TILE), np.float32)
    rgb = np.asarray(Image.open(io.BytesIO(path.read_bytes())).convert("RGB")).astype(np.float32)
    return rgb[..., 0] * 256 + rgb[..., 1] + rgb[..., 2] / 256 - 32768


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workers", type=int, default=8)
    args = parser.parse_args()

    x0, y0 = (int(math.floor(v)) for v in tile_xy(WEST, NORTH))
    x1, y1 = (int(math.floor(v)) for v in tile_xy(EAST, SOUTH))
    xs, ys = range(x0, x1 + 1), range(y0, y1 + 1)
    with ThreadPoolExecutor(args.workers) as pool:
        tiles = dict(zip([(x, y) for y in ys for x in xs], pool.map(lambda xy: tile(*xy), [(x, y) for y in ys for x in xs])))
    mosaic = np.zeros((len(ys) * TILE, len(xs) * TILE), np.float32)
    for (x, y), t in tiles.items():
        mosaic[(y - y0) * TILE : (y - y0 + 1) * TILE, (x - x0) * TILE : (x - x0 + 1) * TILE] = t
    print(f"{len(tiles)} tiles, {mosaic.shape[1]} x {mosaic.shape[0]}")

    w = round((EAST - WEST) / STEP)
    h = round((NORTH - SOUTH) / STEP)
    lon = WEST + STEP * (np.arange(w) + 0.5)
    lat = SOUTH + STEP * (np.arange(h) + 0.5)
    lon2, lat2 = np.meshgrid(lon, lat)
    n = 2**Z
    tx = (lon2 + 180) / 360 * n
    ty = (1 - np.arcsinh(np.tan(np.radians(lat2))) / np.pi) / 2 * n
    px = ((tx - x0) * TILE - 0.5).astype(np.float32)
    py = ((ty - y0) * TILE - 0.5).astype(np.float32)
    elev = cv2.remap(mosaic, px, py, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0)
    elev = np.maximum(elev, 0)
    np.savez(CACHE / "terrain.npz", elevation=elev.astype(np.float16), grid=np.array([WEST, SOUTH, STEP]))
    print(f"{w} x {h}, land {np.mean(elev > 0.5) * 100:.1f}%, up to {elev.max():.0f} m")


if __name__ == "__main__":
    main()
