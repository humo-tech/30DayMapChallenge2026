"""Day 14 (Borgesian map): Mt. Fuji's summit crater from VIRTUAL SHIZUOKA's 2021 laser survey.

Reads the survey's 500-level map sheets round the crater (400 m x 300 m each, JGD2011 plane
zone VIII), from the open data bucket s3://virtual-shizuoka:

- Grid: the 0.5 m DEM. Built into the surface the aerial photo is draped on, and the slopes
  the points' facing comes from.
- Ortho: the 20 cm aerial photos the points were colored from, mosaicked into one texture,
  and the shadows the points' colors are lifted out of.
- Ground: the laser points (LAS 1.2, RGB per point, ~97 points/m2), all of them, into a
  quadtree the map loads only as much of as the camera needs (see "Points" below).

Everything is in the crater's own West-Up-North frame (Navara's `geodetic` mesh placement),
with the origin on the crater floor. Heights are the survey's (above sea level) and are used
as they are: Navara puts GSI's DEM, which is above sea level too, on the ellipsoid, so both
stand on the same ground.

Points
------
A quadtree of LEVELS levels over the extent, from 400 m nodes down to 12.5 m ones. Each point
draws a random number and goes to the first level whose share of all points it falls under
(SHARES: 0.1%, then 0.4% in all, 1.6%, ...), into that level's node under it. So a node holds
~12,000 points whatever its level, and a node together with the nodes above it is an even
thinning of the survey, ~4 times as dense as its parent's. The deepest level is every point:
~10 cm apart.

The laser was shot from above, so the points fall evenly per m2 of map, not of ground: a wall
standing at 75-90 degrees holds a fifth of the points per m2 of its face that the floor does.
Each level's share is raised by up to 5 times where the ground is steep, to even that out.
Their colors come from the photos taken from above too, which see the walls edge-on and in
shadow: each point also gets how far its color is lifted out of the shadows, for the overcast
light later on, from how dark the photo is round it.

Past the crater's rim the levels stop at MAX_LEVEL_OUT.

Outputs (public/data/day14/):
    crater.json          origin, the quadtree's layout, sizes
    crater_surface.bin   the surface grid's vertices, int16 x, y, z (dm), rows north to south
    crater_ortho.jpg     the aerial photo over the same extent, north up
    tiles/<level>/<row>-<col>.bin   (~2 GB in all; not in the repository: see the page)
        header, 32 bytes: float32 min x, y, z, max x, y, z (m); uint32 count;
                          uint8 children (bits: NW, NE, SW, SE); 3 spare bytes
        per point, 12 bytes: uint16 x, y, z (0-65535 across the bounds);
                             uint8 r, g, b, up (255 = flat), lift (0-255: x1-x3), spare

Usage:
    python scripts/day14/extract_crater.py
"""

import argparse
import io
import json
import math
import shutil
import struct
import urllib.request
import zipfile
from pathlib import Path

import numpy as np
from PIL import Image
from pyproj import Transformer

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / "scripts" / ".cache" / "day14"
OUT = ROOT / "public" / "data" / "day14"
BUCKET = "https://virtual-shizuoka.s3.amazonaws.com/2021/LP"

# Map sheets 08ME35<row><col>: the 5000-level sheet 35 of ME is x 20000-24000, y -69000--72000,
# split 10 x 10 into 500-level sheets (400 m east, 300 m south each)
ROWS = range(3, 8)
COLS = range(1, 4)
X0 = 20000 + 400 * COLS[0]
X1 = 20000 + 400 * (COLS[-1] + 1)
Y1 = -69000 - 300 * ROWS[0]  # north edge
Y0 = -69000 - 300 * (ROWS[-1] + 1)  # south edge

# The crater: its floor's centre (plane coords, m), and how far out its rim lies
CRATER = (20960.0, -70680.0)
RIM_R = 480.0

DEM_STEP = 0.5
SURFACE_STEP = 4.0  # m between the draped surface's vertices
ORTHO_STEP = 0.4  # m per texel of the photo (the survey's is 0.2)

# The quadtree: the root nodes' size (m), and the share of all points down to each level
ROOT_SIZE = 400.0
SHARES = [0.001, 0.004, 0.016, 0.064, 0.256, 1.0]
LEVELS = len(SHARES)
MAX_LEVEL_OUT = 3
# Steep ground keeps up to this many times more points, to make up for the laser's angle
MAX_TILT_KEEP = 5.0
# Shadows: cells (m) the photo's local brightness is taken over, and the most a color is lifted by
LIFT_CELL = 5.0
MAX_LIFT = 3.0

WGS84_A = 6378137.0
WGS84_E2 = (1 / 298.257223563) * (2 - 1 / 298.257223563)
TO_LNGLAT = Transformer.from_crs(6676, 4326, always_xy=True)


def sheets() -> list[str]:
    return [f"08ME35{r}{c}" for r in ROWS for c in COLS]


def fetch(kind: str, sheet: str) -> Path:
    path = CACHE / kind / f"{sheet}.zip"
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        print(f"  downloading {kind}/{sheet}")
        urllib.request.urlretrieve(f"{BUCKET}/{kind}/08/ME/35/{sheet}.zip", path)
    return path


def read_member(path: Path, suffix: str) -> bytes:
    with zipfile.ZipFile(path) as z:
        (name,) = [n for n in z.namelist() if n.lower().endswith(suffix)]
        return z.read(name)


def to_ecef(lng, lat, h):
    lng, lat = np.radians(lng), np.radians(lat)
    n = WGS84_A / np.sqrt(1 - WGS84_E2 * np.sin(lat) ** 2)
    return np.stack(
        [
            (n + h) * np.cos(lat) * np.cos(lng),
            (n + h) * np.cos(lat) * np.sin(lng),
            (n * (1 - WGS84_E2) + h) * np.sin(lat),
        ],
        -1,
    )


class Frame:
    """Plane coords (zone VIII) and heights -> the crater's West-Up-North frame (m)."""

    def __init__(self, x: float, y: float, h: float):
        lng, lat = TO_LNGLAT.transform(x, y)
        self.lng, self.lat, self.height = float(lng), float(lat), float(h)
        self.origin = to_ecef(lng, lat, h)
        lo, la = math.radians(lng), math.radians(lat)
        east = np.array([-math.sin(lo), math.cos(lo), 0.0])
        north = np.array([-math.sin(la) * math.cos(lo), -math.sin(la) * math.sin(lo), math.cos(la)])
        up = np.array([math.cos(la) * math.cos(lo), math.cos(la) * math.sin(lo), math.sin(la)])
        self.wun = np.stack([-east, up, north])

    def __call__(self, x, y, h) -> np.ndarray:
        lng, lat = TO_LNGLAT.transform(x, y)
        return (to_ecef(lng, lat, h) - self.origin) @ self.wun.T


def build_dem() -> np.ndarray:
    """The 0.5 m DEM over the whole extent, rows north to south."""
    w, h = round((X1 - X0) / DEM_STEP), round((Y1 - Y0) / DEM_STEP)
    z = np.full((h, w), np.nan, dtype=np.float32)
    for sheet in sheets():
        a = np.loadtxt(io.BytesIO(read_member(fetch("Grid", sheet), ".txt")))
        i = np.floor((Y1 - a[:, 1]) / DEM_STEP).astype(int)
        j = np.floor((a[:, 0] - X0) / DEM_STEP).astype(int)
        z[i, j] = a[:, 2]
    if np.isnan(z).any():
        raise SystemExit(f"DEM has {np.isnan(z).sum()} holes")
    return z


def facing_up(dem: np.ndarray) -> np.ndarray:
    """How much the ground faces up (cos of its slope), over 2 m, on the DEM's grid."""
    k = 4  # 2 m blocks
    h, w = dem.shape
    coarse = dem[: h // k * k, : w // k * k].reshape(h // k, k, w // k, k).mean((1, 3))
    gy, gx = np.gradient(coarse, DEM_STEP * k)
    up = 1 / np.sqrt(1 + gx**2 + gy**2)
    return np.repeat(np.repeat(up, k, 0), k, 1)


def grid_index(x, y, step: float, shape):
    i = np.clip(((Y1 - y) / step).astype(int), 0, shape[0] - 1)
    j = np.clip(((x - X0) / step).astype(int), 0, shape[1] - 1)
    return i, j


def build_ortho() -> Image.Image:
    """The aerial photos, mosaicked over the extent at ORTHO_STEP, north up."""
    w, h = round((X1 - X0) / ORTHO_STEP), round((Y1 - Y0) / ORTHO_STEP)
    mosaic = Image.new("RGB", (w, h))
    for sheet in sheets():
        path = fetch("Ortho", sheet)
        tfw = [float(v) for v in read_member(path, ".tfw").split()]
        img = Image.open(io.BytesIO(read_member(path, ".tif"))).convert("RGB")
        # The world file gives the centre of the top-left pixel
        left = tfw[4] - tfw[0] / 2
        top = tfw[5] - tfw[3] / 2
        sw, sh = round(img.width * tfw[0] / ORTHO_STEP), round(img.height * -tfw[3] / ORTHO_STEP)
        mosaic.paste(img.resize((sw, sh), Image.LANCZOS), (round((left - X0) / ORTHO_STEP), round((Y1 - top) / ORTHO_STEP)))
    return mosaic


def shadow_lift(ortho: Image.Image) -> np.ndarray:
    """
    How far to lift colors out of the sun's shadows, per LIFT_CELL cell: the photo's brightness
    there (blurred) against that of the sunlit ground.
    """
    w, h = math.ceil((X1 - X0) / LIFT_CELL), math.ceil((Y1 - Y0) / LIFT_CELL)
    luma = np.asarray(ortho.convert("L").resize((w, h), Image.BOX), dtype=float)
    for _ in range(2):  # 3 x 3 box blur, twice
        luma = sum(np.roll(np.roll(luma, a, 0), b, 1) for a in (-1, 0, 1) for b in (-1, 0, 1)) / 9
    sunlit = np.percentile(luma, 60)
    return np.clip(sunlit / np.maximum(luma, 1), 1, MAX_LIFT)


def read_las(sheet: str):
    """All of one sheet's laser points: plane x, y, height, and 8-bit RGB."""
    data = read_member(fetch("Ground", sheet), ".las")
    offset, = struct.unpack("<I", data[96:100])
    fmt = data[104] & 0x3F
    rec, = struct.unpack("<H", data[105:107])
    count, = struct.unpack("<I", data[107:111])
    scale = np.array(struct.unpack("<3d", data[131:155]))
    shift = np.array(struct.unpack("<3d", data[155:179]))
    if fmt not in (2, 3):
        raise SystemExit(f"{sheet}: point format {fmt}, expected 2 or 3 (RGB)")
    rgb_at = {2: 20, 3: 28}[fmt]
    recs = np.frombuffer(data, np.uint8, count * rec, offset).reshape(count, rec)
    xyz = recs[:, :12].copy().view("<i4") * scale + shift
    rgb = (recs[:, rgb_at : rgb_at + 6].copy().view("<u2") >> 8).astype(np.uint8)
    return xyz, rgb


# A point while it's sorted into the tree: crater frame (m), color, facing, lift
STAGED = np.dtype([("p", "<f4", 3), ("c", "u1", 4), ("lift", "u1")])


def node_size(level: int) -> float:
    return ROOT_SIZE / 2**level


def stage_points(frame: Frame, up: np.ndarray, lift: np.ndarray, staging: Path, seed: int) -> tuple[int, float]:
    """Sorts every sheet's points into their level and node, appended to staging files."""
    rng = np.random.default_rng(seed)
    shares = np.array(SHARES)
    total = 0
    for sheet in sheets():
        xyz, rgb = read_las(sheet)
        total += len(xyz)
        facing = up[grid_index(xyz[:, 0], xyz[:, 1], DEM_STEP, up.shape)]
        tilt = 1 / np.clip(facing, 1 / MAX_TILT_KEEP, 1)
        # The first level whose (tilted) share the point's draw falls under
        r = rng.random(len(xyz))
        level = np.full(len(xyz), LEVELS, dtype=np.int8)
        for lv in reversed(range(LEVELS)):
            level[r < np.minimum(shares[lv] * tilt, 1)] = lv
        rim = np.hypot(xyz[:, 0] - CRATER[0], xyz[:, 1] - CRATER[1]) > RIM_R
        level[rim & (level > MAX_LEVEL_OUT)] = LEVELS  # past the rim, not that deep
        keep = level < LEVELS
        xyz, rgb, level, facing = xyz[keep], rgb[keep], level[keep], facing[keep]

        staged = np.zeros(len(xyz), dtype=STAGED)
        staged["p"] = frame(xyz[:, 0], xyz[:, 1], xyz[:, 2])
        staged["c"][:, :3] = rgb
        staged["c"][:, 3] = np.round(facing * 255)
        staged["lift"] = np.round((lift[grid_index(xyz[:, 0], xyz[:, 1], LIFT_CELL, lift.shape)] - 1) / (MAX_LIFT - 1) * 255)
        for lv in range(LEVELS):
            m = level == lv
            size = node_size(lv)
            row = ((Y1 - xyz[m, 1]) // size).astype(int)
            col = ((xyz[m, 0] - X0) // size).astype(int)
            key = row * 10_000 + col
            order = np.argsort(key, kind="stable")
            keys, starts = np.unique(key[order], return_index=True)
            pts = staged[m][order]
            for k, a, b in zip(keys, starts, list(starts[1:]) + [len(pts)]):
                path = staging / str(lv) / f"{k // 10_000}-{k % 10_000}.bin"
                path.parent.mkdir(parents=True, exist_ok=True)
                with open(path, "ab") as f:
                    pts[a:b].tofile(f)
        print(f"  {sheet}: {keep.sum():,} of {len(keep):,} points", flush=True)
    return total, total / ((X1 - X0) * (Y1 - Y0))


def write_tiles(staging: Path, out: Path) -> dict:
    """Quantizes each staged node into its tile file, with its bounds and which children it has."""
    stats = {}
    for lv in range(LEVELS):
        sizes = []
        for path in sorted((staging / str(lv)).glob("*.bin")):
            row, col = map(int, path.stem.split("-"))
            pts = np.fromfile(path, dtype=STAGED)
            lo, hi = pts["p"].min(0), pts["p"].max(0)
            span = np.maximum(hi - lo, 1e-3)
            children = 0
            for bit, (dr, dc) in enumerate(((0, 0), (0, 1), (1, 0), (1, 1))):
                if (staging / str(lv + 1) / f"{row * 2 + dr}-{col * 2 + dc}.bin").exists():
                    children |= 1 << bit
            recs = np.zeros(len(pts), dtype=[("p", "<u2", 3), ("c", "u1", 4), ("lift", "u1"), ("pad", "u1")])
            recs["p"] = np.round((pts["p"] - lo) / span * 65535)
            recs["c"] = pts["c"]
            recs["lift"] = pts["lift"]
            dest = out / str(lv) / path.name
            dest.parent.mkdir(parents=True, exist_ok=True)
            with open(dest, "wb") as f:
                f.write(struct.pack("<6fIB3x", *lo, *hi, len(pts), children))
                recs.tofile(f)
            sizes.append(len(pts))
        stats[lv] = {"nodes": len(sizes), "points": int(sum(sizes)), "mean": round(float(np.mean(sizes)))}
        print(f"  level {lv}: {stats[lv]}")
    return stats


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=14)
    args = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)

    print("DEM")
    dem = build_dem()
    up = facing_up(dem)
    ci = round((Y1 - CRATER[1]) / DEM_STEP)
    cj = round((CRATER[0] - X0) / DEM_STEP)
    floor = float(dem[ci - 40 : ci + 40, cj - 40 : cj + 40].min())
    frame = Frame(*CRATER, floor)
    print(f"  crater floor {floor:.1f} m at {frame.lng:.6f}, {frame.lat:.6f}; rim {dem.max():.1f} m")

    # The draped surface: every SURFACE_STEP of the DEM, edges included
    k = round(SURFACE_STEP / DEM_STEP)
    rows = np.arange(0, dem.shape[0] + 1, k).clip(max=dem.shape[0] - 1)
    cols = np.arange(0, dem.shape[1] + 1, k).clip(max=dem.shape[1] - 1)
    gy = Y1 - (rows + 0.5) * DEM_STEP
    gx = X0 + (cols + 0.5) * DEM_STEP
    sx, sy = np.meshgrid(gx, gy)
    surface = frame(sx, sy, dem[np.ix_(rows, cols)])
    np.round(surface * 10).astype("<i2").tofile(OUT / "crater_surface.bin")

    print("ortho")
    ortho = build_ortho()
    ortho.save(OUT / "crater_ortho.jpg", quality=85, optimize=True)
    lift = shadow_lift(ortho)

    print("points")
    staging = CACHE / "staging"
    shutil.rmtree(staging, ignore_errors=True)
    total, density = stage_points(frame, up, lift, staging, args.seed)
    tiles = OUT / "tiles"
    shutil.rmtree(tiles, ignore_errors=True)
    stats = write_tiles(staging, tiles)
    shutil.rmtree(staging)

    # The root nodes' corners in the crater frame (approximately: the frame is turned a little
    # from the plane grid), for laying out nodes before they're loaded
    meta = {
        "origin": {"lng": round(frame.lng, 7), "lat": round(frame.lat, 7), "height": round(floor, 2)},
        "surface": {"cols": len(cols), "rows": len(rows)},
        "rim": round(float(dem.max()) - floor, 1),
        "maxLift": MAX_LIFT,
        "tree": {
            # West and north (m, in the frame) of the extent's north-west corner
            "west": round(CRATER[0] - X0, 2),
            "north": round(Y1 - CRATER[1], 2),
            "rootSize": ROOT_SIZE,
            "rows": math.ceil((Y1 - Y0) / ROOT_SIZE),
            "cols": math.ceil((X1 - X0) / ROOT_SIZE),
            # How far apart (m) the points lie, on flat ground, down to each level
            "spacing": [round(1 / math.sqrt(density * s), 3) for s in SHARES],
            "rimRadius": RIM_R,
            "maxLevelOut": MAX_LEVEL_OUT,
            "levels": stats,
        },
    }
    (OUT / "crater.json").write_text(json.dumps(meta, indent=1) + "\n")
    print(f"{total:,} points surveyed")
    print(json.dumps(meta))


if __name__ == "__main__":
    main()
