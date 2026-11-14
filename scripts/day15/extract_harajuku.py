"""Day 15 (Inside out): a small PMTiles of Harajuku, cut from Overture Maps' own.

Overture's archives carry the whole world, and a viewer that reads them as they are
downloads tens of MB before it draws Harajuku: a z14 tile over Tokyo is ~1.3 MB for the
roads alone, most of it each feature's provenance, names, access rules and the like.
This reads the three themes the map needs from Overture's S3 by range requests, keeps
the tiles around Harajuku and only the few properties the style reads, and writes two
small PMTiles:

- `harajuku.pmtiles`: z14. Roads (`segment`: class, subtype) and buildings (`building`:
  `h` height in m, `c` a colour number 0-15 from the id).
- `harajuku-base.pmtiles`: z13, the most detailed the base theme goes. The ground
  (`land`, `land_use`: subtype) and water (`water`: subtype).

Writes both to `public/data/day15/`.

Usage:
    pip install pmtiles
    python scripts/day15/extract_harajuku.py [--release 2026-10-21.0] [--radius 2]
"""

import argparse
import gzip
import json
import math
import urllib.request

import mapbox_vector_tile as mvt
from pathlib import Path

from pmtiles.reader import Reader
from pmtiles.tile import Compression, TileType, zxy_to_tileid
from pmtiles.writer import write

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT = ROOT / "public" / "data" / "day15" / "harajuku.pmtiles"
DEFAULT_RELEASE = "2026-10-21.0"
S3 = "https://overturemaps-extras-us-west-2.s3.us-west-2.amazonaws.com/tiles"

# Jingūmae, between Yoyogi Park and Omotesandō
CENTRE = (139.7055, 35.6685)
ZOOM = 14
BASE_ZOOM = 13

# What the style reads, per layer; the rest of Overture's properties are dropped
KEEP = {
    "segment": ("class", "subtype"),
    "land": ("subtype",),
    "land_use": ("subtype",),
    "water": ("subtype",),
}
FLOOR_M = 3.2
DEFAULT_HEIGHT = 8.0


def tile_of(lng: float, lat: float, z: int) -> tuple[int, int]:
    n = 2**z
    x = int((lng + 180) / 360 * n)
    y = int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n)
    return x, y


def tile_bounds(z: int, x: int, y: int) -> tuple[float, float, float, float]:
    n = 2**z
    lng = lambda tx: tx / n * 360 - 180
    lat = lambda ty: math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * ty / n))))
    return lng(x), lat(y + 1), lng(x + 1), lat(y)


class RangeSource:
    """PMTiles' byte source over HTTP range requests."""

    def __init__(self, url: str):
        self.url = url

    def __call__(self, offset: int, length: int) -> bytes:
        req = urllib.request.Request(self.url, headers={"Range": f"bytes={offset}-{offset + length - 1}"})
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.read()


def slim(raw: bytes, keep: set[str]) -> bytes:
    """Overture's tile cut down to the `keep` layers, each feature to its few properties."""
    if raw[:2] == b"\x1f\x8b":
        raw = gzip.decompress(raw)
    out = []
    for name, layer in mvt.decode(raw, default_options={"y_coord_down": True}).items():
        if name not in keep:
            continue
        feats = []
        for f in layer["features"]:
            p = f["properties"]
            if name == "building":
                if p.get("is_underground"):
                    continue
                h = p.get("height") or (p["num_floors"] * FLOOR_M if p.get("num_floors") else DEFAULT_HEIGHT)
                props = {"h": round(float(h), 1), "c": int(str(p.get("id", "0"))[0], 16)}
            else:
                props = {k: p[k] for k in KEEP[name] if k in p}
            feats.append({"geometry": f["geometry"], "properties": props})
        if feats:
            out.append({"name": name, "features": feats})
    if not out:
        return b""
    return mvt.encode(out, default_options={"y_coord_down": True, "extents": 4096})


def build(out: Path, release: str, zoom: int, tiles_xy: list[tuple[int, int]], themes: dict[str, set[str]]) -> None:
    """One PMTiles of `tiles_xy` at `zoom`, the layers of each theme in `themes` joined in each
    tile (a vector tile is a protobuf, and two concatenated are one tile with both their layers)."""
    readers = {t: Reader(RangeSource(f"{S3}/{release}/{t}.pmtiles")) for t in themes}
    tiles: dict[int, bytes] = {}
    for x, y in tiles_xy:
        parts = []
        for t, layers in themes.items():
            raw = readers[t].get(zoom, x, y)
            if raw is not None:
                parts.append(slim(raw, layers))
        data = b"".join(parts)
        if data:
            tiles[zxy_to_tileid(zoom, x, y)] = gzip.compress(data, 9)
            print(f"z{zoom}/{x}/{y}: {len(tiles[zxy_to_tileid(zoom, x, y)]) / 1e3:.0f} kB")
    xs = [x for x, _ in tiles_xy]
    ys = [y for _, y in tiles_xy]
    west, south, _, _ = tile_bounds(zoom, min(xs), max(ys))
    _, _, east, north = tile_bounds(zoom, max(xs), min(ys))
    out.parent.mkdir(parents=True, exist_ok=True)
    with write(out) as w:
        for tid in sorted(tiles):
            w.write_tile(tid, tiles[tid])
        w.finalize(
            {
                "tile_type": TileType.MVT,
                "tile_compression": Compression.GZIP,
                "min_zoom": zoom,
                "max_zoom": zoom,
                "min_lon_e7": int(west * 1e7),
                "min_lat_e7": int(south * 1e7),
                "max_lon_e7": int(east * 1e7),
                "max_lat_e7": int(north * 1e7),
                "center_zoom": zoom,
                "center_lon_e7": int(CENTRE[0] * 1e7),
                "center_lat_e7": int(CENTRE[1] * 1e7),
            },
            {
                "name": "Harajuku (Overture Maps)",
                "attribution": "© Overture Maps Foundation, © OpenStreetMap contributors and others",
                "vector_layers": [{"id": n, "fields": {}} for layers in themes.values() for n in sorted(layers)],
            },
        )
    print(f"{out.name}: {len(tiles)} tiles, {out.stat().st_size / 1e6:.2f} MB")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--release", default=DEFAULT_RELEASE)
    ap.add_argument("--radius", type=int, default=1, help="z14 tiles each way from the centre tile")
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT.parent)
    args = ap.parse_args()

    cx, cy = tile_of(*CENTRE, ZOOM)
    r = args.radius
    city = [(x, y) for x in range(cx - r, cx + r + 1) for y in range(cy - r, cy + r + 1)]
    base = sorted({(x // 2, y // 2) for x, y in city})
    build(args.out / "harajuku.pmtiles", args.release, ZOOM, city, {"transportation": {"segment"}, "buildings": {"building"}})
    build(args.out / "harajuku-base.pmtiles", args.release, BASE_ZOOM, base, {"base": {"land", "land_use", "water"}})


if __name__ == "__main__":
    main()
