"""Day 22: NASA's Blue Marble (shaded relief and bathymetry), for warping onto the freehand maps.

Plate carrée (equal latitude / longitude) images from NASA GIBS's WMS: Japan at 100 px per degree,
the world at about 11 (in 90° pieces, stitched: GIBS won't make the whole world in one go).

    public/data/day22/bluemarble-japan.jpg    121–151°E, 22–47°N
    public/data/day22/bluemarble-world.jpg    the whole world
    public/data/day22/bluemarble.json         their bounds (west, south, east, north)

Usage:
    python scripts/day22/fetch_blue_marble.py
"""

import io
import json
import time
import urllib.parse
import urllib.request
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "public" / "data" / "day22"
WMS = "https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi"
LAYER = "BlueMarble_ShadedRelief_Bathymetry"

JAPAN = {"bbox": [121, 22, 151, 47], "px_per_deg": 100}
WORLD_PIECE = 1024  # px per 90° piece: 4096 x 2048 in all


def get_map(west, south, east, north, width, height):
    q = {
        "SERVICE": "WMS",
        "REQUEST": "GetMap",
        "VERSION": "1.3.0",
        "LAYERS": LAYER,
        "CRS": "EPSG:4326",
        # WMS 1.3.0 in EPSG:4326 takes latitude first
        "BBOX": f"{south},{west},{north},{east}",
        "WIDTH": width,
        "HEIGHT": height,
        "FORMAT": "image/jpeg",
    }
    url = f"{WMS}?{urllib.parse.urlencode(q)}"
    for attempt in range(4):
        try:
            with urllib.request.urlopen(url, timeout=180) as r:
                return Image.open(io.BytesIO(r.read())).convert("RGB")
        except OSError as e:
            print(f"  retry ({e})")
            time.sleep(3 * (attempt + 1))
    raise RuntimeError(f"GIBS didn't answer: {url}")


def main():
    OUT.mkdir(parents=True, exist_ok=True)

    w, s, e, n = JAPAN["bbox"]
    k = JAPAN["px_per_deg"]
    print("Japan...")
    get_map(w, s, e, n, (e - w) * k, (n - s) * k).save(OUT / "bluemarble-japan.jpg", quality=85, optimize=True)

    print("World...")
    world = Image.new("RGB", (WORLD_PIECE * 4, WORLD_PIECE * 2))
    for row, north in enumerate((90, 0)):
        for col, west in enumerate((-180, -90, 0, 90)):
            print(f"  {west}..{west + 90}°, {north - 90}..{north}°")
            piece = get_map(west, north - 90, west + 90, north, WORLD_PIECE, WORLD_PIECE)
            world.paste(piece, (col * WORLD_PIECE, row * WORLD_PIECE))
    world.save(OUT / "bluemarble-world.jpg", quality=85, optimize=True)

    meta = {
        "source": "NASA Blue Marble: shaded relief and bathymetry (NASA GIBS)",
        "japan": {"file": "bluemarble-japan.jpg", "bbox": JAPAN["bbox"]},
        "world": {"file": "bluemarble-world.jpg", "bbox": [-180, -90, 180, 90]},
    }
    (OUT / "bluemarble.json").write_text(json.dumps(meta, indent=2))
    for f in ("bluemarble-japan.jpg", "bluemarble-world.jpg"):
        print(f"{f}: {(OUT / f).stat().st_size / 1024:.0f} KB")


if __name__ == "__main__":
    main()
