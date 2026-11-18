"""Day 18 (Null): Mt. Fuji seen from the Tokaido Shinkansen, and the same view without it.

- Track: the Tokaido Shinkansen's westbound line past Mt. Fuji, from Overture Maps (east of
  Shin-Fuji to the tunnels past the Fuji River), resampled every STEP m, with the height the
  window rides at and where the tunnels are.
- Fuji: the mountain cut out of GSI's DEM inside a hand-drawn outline of its foot (between the
  Fuji Five Lakes, Hakone, Ashitaka and the Fuji River). Its elevations are dropped as no-data,
  and the hole is filled from its edge alone (a Laplace fill: the smoothest ground that meets
  the land round it), which is the ground as if the mountain had never been there. The two are
  blended over BLEND m inside the outline so the ground has no crease at the edge.

The page builds a Fuji-less terrain from GSI's DEM tiles as they come in, with the fill and
the blend's weight from fuji.bin; the mountain itself is a separate mesh over it, from its own
heights and aerial photo, so it can go at a moment's notice.

Outputs (public/data/day18/):
    fuji.json         the grids' layout, the track, and the whole line from Mishima to Shizuoka
    fuji_null.bin     on the coarse grid (z FILL_Z): uint16 fill height (dm), then uint8 weight
                      (0-255: how much of the ground is the fill), rows north to south
    fuji_heights.bin  on the mesh grid (z MESH_Z): uint16 height (dm) of the mountain, 0 outside
                      the outline, rows north to south
    fuji_ortho.jpg    GSI's seamless aerial photo over the mesh grid, north up

Usage:
    python scripts/day18/null_fuji.py [--release 2026-10-21.0]
"""

import argparse
import io
import json
import math
import urllib.request
from pathlib import Path

import duckdb
import numpy as np
import shapely
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / "scripts" / ".cache" / "day18"
OUT = ROOT / "public" / "data" / "day18"
GSI = "https://cyberjapandata.gsi.go.jp/xyz"
DEFAULT_RELEASE = "2026-10-21.0"

# Mt. Fuji's foot, drawn by eye on the DEM's relief: the edge of its smooth cone, round the
# lakes to the north, the Gotemba side to the east, north of Mt. Ashitaka (kept) to the south,
# and the Fuji River's hills to the west
OUTLINE = [
    (138.601, 35.436), (138.628, 35.464), (138.683, 35.484), (138.738, 35.492),
    (138.786, 35.486), (138.827, 35.472), (138.855, 35.447), (138.875, 35.419),
    (138.917, 35.391), (138.934, 35.358), (138.937, 35.318), (138.927, 35.285),
    (138.889, 35.265), (138.834, 35.254), (138.779, 35.260), (138.745, 35.223),
    (138.714, 35.192), (138.663, 35.187), (138.621, 35.198), (138.587, 35.234),
    (138.566, 35.285), (138.558, 35.335), (138.565, 35.380), (138.580, 35.414),
]
BLEND = 2500.0  # m inside the outline over which the ground turns from the DEM to the fill
MESH_Z = 12  # the mountain's mesh: GSI's DEM at z12 (~31 m here)
FILL_Z = 10  # the fill and its weight, smooth: z10 (~125 m) is plenty
ORTHO_Z = 13  # the mountain's photo (~16 m)

# The ride: westbound, from east of Shin-Fuji to the tunnels past the Fuji River. Overture's
# segments of the westbound track, east to west
TRACK_SEGMENTS = ["53852544", "7c793ec0", "4e0f37c2"]
RIDE_FROM, RIDE_TO = 138.765, 138.585  # longitude
STEP = 20.0  # m between the track's points
LINE_STEP = 200.0  # m between the points of the whole line (Mishima to Shizuoka), for the minimap
WINDOW = 12.0  # m: the window over the ground (an embankment or a viaduct, and the car)


def tile(kind: str, z: int, x: int, y: int) -> bytes | None:
    ext = "png" if kind == "dem_png" else "jpg"
    path = CACHE / kind / f"{z}/{x}/{y}.{ext}"
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            urllib.request.urlretrieve(f"{GSI}/{kind}/{z}/{x}/{y}.{ext}", path)
        except urllib.error.HTTPError as e:
            if e.code != 404:
                raise
            path.write_bytes(b"")  # no tile (the sea)
    data = path.read_bytes()
    return data or None


def decode_dem(data: bytes | None) -> np.ndarray:
    """GSI's PNG elevation: (r * 2^16 + g * 2^8 + b) cm, two's complement; (128, 0, 0) is no data."""
    if data is None:
        return np.zeros((256, 256))
    a = np.asarray(Image.open(io.BytesIO(data)).convert("RGB")).astype(np.int64)
    v = a[..., 0] * 65536 + a[..., 1] * 256 + a[..., 2]
    v = np.where(v >= 2**23, v - 2**24, v) * 0.01
    v[v == -(2**23) * 0.01] = 0  # no data: the sea
    return v


def world_px(lng, lat, z: int):
    """Web Mercator pixel coordinates at zoom z (256 px tiles)."""
    n = 256 * 2**z
    lat = np.radians(lat)
    return (np.asarray(lng) + 180) / 360 * n, (1 - np.log(np.tan(lat) + 1 / np.cos(lat)) / math.pi) / 2 * n


def lnglat(x, y, z: int):
    n = 256 * 2**z
    return np.asarray(x) / n * 360 - 180, np.degrees(np.arctan(np.sinh(math.pi * (1 - 2 * np.asarray(y) / n))))


class Grid:
    """A pixel-aligned window at zoom z over the outline's bounds (and a margin)."""

    def __init__(self, z: int, margin: float = 0.02):
        lng0, lat0, lng1, lat1 = shapely.Polygon(OUTLINE).bounds
        x0, y0 = world_px(lng0 - margin, lat1 + margin, z)
        x1, y1 = world_px(lng1 + margin, lat0 - margin, z)
        self.z, self.x0, self.y0 = z, int(x0), int(y0)
        self.cols, self.rows = int(x1) - self.x0 + 1, int(y1) - self.y0 + 1

    def mosaic(self, kind: str, decode) -> np.ndarray:
        tx0, ty0 = self.x0 // 256, self.y0 // 256
        tx1, ty1 = (self.x0 + self.cols - 1) // 256, (self.y0 + self.rows - 1) // 256
        rows = [np.hstack([decode(tile(kind, self.z, x, y)) for x in range(tx0, tx1 + 1)]) for y in range(ty0, ty1 + 1)]
        m = np.vstack(rows)
        ox, oy = self.x0 - tx0 * 256, self.y0 - ty0 * 256
        return m[oy : oy + self.rows, ox : ox + self.cols]

    def centres(self):
        """The pixels' centres' longitudes and latitudes."""
        x, y = np.meshgrid(self.x0 + np.arange(self.cols) + 0.5, self.y0 + np.arange(self.rows) + 0.5)
        return lnglat(x, y, self.z)

    def layout(self) -> dict:
        return {"z": self.z, "x0": self.x0, "y0": self.y0, "cols": self.cols, "rows": self.rows}


def metres_inside(grid: Grid) -> np.ndarray:
    """How far each pixel lies inside the outline (m), 0 outside it."""
    lng, lat = grid.centres()
    lat0 = float(np.mean([p[1] for p in OUTLINE]))
    kx, ky = 111_320 * math.cos(math.radians(lat0)), 110_950
    outline = shapely.Polygon([(x * kx, y * ky) for x, y in OUTLINE])
    points = shapely.points(lng * kx, lat * ky)
    inside = shapely.contains(outline, points)
    return np.where(inside, shapely.distance(outline.exterior, points), 0.0)


def laplace_fill(z: np.ndarray, hole: np.ndarray, sweeps: int = 300) -> np.ndarray:
    """Fills the hole with the smoothest surface that meets the ground round it (coarse to fine)."""
    rows, cols = z.shape
    if min(rows, cols) <= 16:
        out = z.copy()
        out[hole] = z[~hole].mean() if (~hole).any() else 0
    else:
        # Half the size: a coarse pixel is known when all four under it are
        r2, c2 = rows // 2 * 2, cols // 2 * 2
        zc = z[:r2, :c2].reshape(r2 // 2, 2, c2 // 2, 2).mean((1, 3))
        hc = hole[:r2, :c2].reshape(r2 // 2, 2, c2 // 2, 2).any((1, 3))
        coarse = laplace_fill(zc, hc, sweeps)
        up = np.repeat(np.repeat(coarse, 2, 0), 2, 1)
        out = z.copy()
        guess = np.pad(up, ((0, rows - r2), (0, cols - c2)), mode="edge")
        out[hole] = guess[hole]
    for _ in range(sweeps):
        p = np.pad(out, 1, mode="edge")
        avg = (p[:-2, 1:-1] + p[2:, 1:-1] + p[1:-1, :-2] + p[1:-1, 2:]) / 4
        out[hole] = avg[hole]
    return out


def smoothstep(x):
    x = np.clip(x, 0, 1)
    return x * x * (3 - 2 * x)


def build_fuji():
    """The mountain's heights on the mesh grid, and the fill and its weight on the coarse grid."""
    mesh = Grid(MESH_Z)
    dem = mesh.mosaic("dem_png", decode_dem)
    inside = metres_inside(mesh)
    hole = inside > 0
    fill = laplace_fill(dem, hole)
    weight = smoothstep(inside / BLEND)
    print(f"  mesh grid {mesh.cols} x {mesh.rows}, {hole.sum()} pixels in the outline")
    print(f"  removed: up to {np.max(dem - fill):.0f} m, the fill {fill[hole].min():.0f}-{fill[hole].max():.0f} m")

    # The coarse grid's fill and weight, each the mean over the mesh pixels under it
    coarse = Grid(FILL_Z)
    s = 2 ** (MESH_Z - FILL_Z)
    lng, lat = coarse.centres()
    mx, my = world_px(lng, lat, MESH_Z)
    j = np.clip((mx - mesh.x0).astype(int), 0, mesh.cols - 1)
    i = np.clip((my - mesh.y0).astype(int), 0, mesh.rows - 1)
    # A box mean of s x s round each sample, from cumulative sums
    def box(a):
        c = np.pad(a, ((1, 0), (1, 0))).cumsum(0).cumsum(1)
        i0, i1 = np.clip(i - s // 2, 0, mesh.rows), np.clip(i + s // 2, 0, mesh.rows)
        j0, j1 = np.clip(j - s // 2, 0, mesh.cols), np.clip(j + s // 2, 0, mesh.cols)
        return (c[i1, j1] - c[i0, j1] - c[i1, j0] + c[i0, j0]) / np.maximum((i1 - i0) * (j1 - j0), 1)
    coarse_fill = box(fill)
    coarse_weight = box(weight)
    print(f"  fill grid {coarse.cols} x {coarse.rows}")

    heights = np.where(hole, np.clip(dem, 0.1, None), 0)
    return mesh, heights, coarse, coarse_fill, coarse_weight


def build_ortho(mesh: Grid) -> Image.Image:
    """GSI's seamless photo at ORTHO_Z over the mesh grid's extent."""
    s = 2 ** (ORTHO_Z - mesh.z)
    g = Grid.__new__(Grid)
    g.z, g.x0, g.y0, g.cols, g.rows = ORTHO_Z, mesh.x0 * s, mesh.y0 * s, mesh.cols * s, mesh.rows * s

    def decode(data):
        if data is None:
            return np.zeros((256, 256, 3), np.uint8)
        return np.asarray(Image.open(io.BytesIO(data)).convert("RGB"))

    return Image.fromarray(g.mosaic("seamlessphoto", decode))


def build_track(release: str) -> dict:
    """The westbound track over the ride, every STEP m: longitude, latitude, height; and its tunnels."""
    con = duckdb.connect()
    con.sql("INSTALL spatial; LOAD spatial; INSTALL httpfs; LOAD httpfs;")
    con.sql("SET s3_region = 'us-west-2'; SET geometry_always_xy = true;")
    src = f"s3://overturemaps-us-west-2/release/{release}"
    rows = con.sql(
        f"""
        SELECT id, ST_AsGeoJSON(geometry), rail_flags
        FROM read_parquet('{src}/theme=transportation/type=segment/*', hive_partitioning = 1)
        WHERE bbox.xmin < 139.0 AND bbox.xmax > 138.3 AND bbox.ymin < 35.25 AND bbox.ymax > 34.9
          AND subtype = 'rail' AND names.primary = '東海道新幹線'
        """
    ).fetchall()
    by_id = {r[0][:8]: r for r in rows}

    # The segments in a row, each point with whether it's in a tunnel
    kx, ky = 111_320 * math.cos(math.radians(35.15)), 110_950
    pts, tunnel = [], []
    for key in TRACK_SEGMENTS:
        _, geom, flags = by_id[key]
        co = np.array(json.loads(geom)["coordinates"])
        d = np.r_[0, np.cumsum(np.hypot(np.diff(co[:, 0]) * kx, np.diff(co[:, 1]) * ky))]
        frac = d / d[-1]
        spans = [f["between"] or [0, 1] for f in flags or [] if "is_tunnel" in f["values"]]
        if pts:
            co, frac = co[1:], frac[1:]
        pts.extend(co.tolist())
        tunnel.extend(any(a <= t <= b for a, b in spans) for t in frac)
    pts, tunnel = np.array(pts), np.array(tunnel, float)

    # Resampled every STEP m over the ride
    d = np.r_[0, np.cumsum(np.hypot(np.diff(pts[:, 0]) * kx, np.diff(pts[:, 1]) * ky))]
    start = np.interp(RIDE_FROM, pts[::-1, 0], d[::-1])
    end = np.interp(RIDE_TO, pts[::-1, 0], d[::-1])
    s = np.arange(start, end, STEP)
    lng, lat = np.interp(s, d, pts[:, 0]), np.interp(s, d, pts[:, 1])
    tun = np.interp(s, d, tunnel) > 0.5

    # The ground under it (GSI's DEM at z14), and a track that rides over its dips (rivers, roads)
    # and is smooth: the highest ground within 300 m, averaged over 600 m
    z = 14
    x, y = world_px(lng, lat, z)
    cache: dict[tuple[int, int], np.ndarray] = {}
    ground = []
    for px, py in zip(x, y):
        key = (int(px // 256), int(py // 256))
        if key not in cache:
            cache[key] = decode_dem(tile("dem_png", z, *key))
        ground.append(cache[key][int(py % 256), int(px % 256)])
    ground = np.array(ground)
    # In a tunnel the DEM is the hill over it: run straight from portal to portal instead
    k = np.arange(len(ground))
    ground[tun] = np.interp(k[tun], k[~tun], ground[~tun])
    w = int(300 / STEP)
    padded = np.pad(ground, w, mode="edge")
    high = np.array([padded[k : k + 2 * w + 1].max() for k in range(len(ground))])
    kernel = np.ones(2 * w + 1) / (2 * w + 1)
    rail = np.convolve(np.pad(high, w, mode="edge"), kernel, mode="valid")
    print(f"  track {s[-1] - s[0]:.0f} m, {len(s)} points, {tun.sum()} in tunnels, ground {ground.min():.0f}-{ground.max():.0f} m")

    # The whole line through the region, coarser, for the minimap
    every = np.arange(0, d[-1], LINE_STEP)
    line = [[round(a, 5), round(b, 5)] for a, b in zip(np.interp(every, d, pts[:, 0]), np.interp(every, d, pts[:, 1]))]

    return {
        "line": line,
        "step": STEP,
        "points": [[round(a, 6), round(b, 6), round(h + WINDOW, 1)] for a, b, h in zip(lng, lat, rail)],
        "tunnels": runs(tun),
    }


def runs(flags: np.ndarray) -> list[list[int]]:
    """[first, last] indices of each run of True."""
    out, start = [], None
    for k, f in enumerate(flags):
        if f and start is None:
            start = k
        if not f and start is not None:
            out.append([start, k - 1])
            start = None
    if start is not None:
        out.append([start, len(flags) - 1])
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--release", default=DEFAULT_RELEASE)
    args = parser.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)

    print("Fuji...")
    mesh, heights, coarse, fill, weight = build_fuji()
    (OUT / "fuji_heights.bin").write_bytes(np.round(heights * 10).astype("<u2").tobytes())
    (OUT / "fuji_null.bin").write_bytes(
        np.round(fill * 10).clip(0, 65535).astype("<u2").tobytes() + np.round(weight * 255).astype(np.uint8).tobytes()
    )
    print("Photo...")
    build_ortho(mesh).save(OUT / "fuji_ortho.jpg", quality=85)
    print("Track...")
    track = build_track(args.release)

    meta = {
        "attribution": f"Track: Overture Maps Foundation ({args.release}); DEM, photo: GSI",
        "mesh": mesh.layout(),
        "fill": coarse.layout(),
        "track": track,
    }
    (OUT / "fuji.json").write_text(json.dumps(meta, ensure_ascii=False, separators=(",", ":")))
    for p in sorted(OUT.iterdir()):
        print(f"  -> {p} ({p.stat().st_size / 1e6:.2f} MB)")


if __name__ == "__main__":
    main()
