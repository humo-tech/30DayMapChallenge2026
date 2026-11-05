"""Day 5 (Senses: Sight): LED points on Tokyo Skytree's surface, from PLATEAU LOD3.

Downloads the PLATEAU 2025 Sumida-ku LOD3 tile that holds Tokyo Skytree (a
single-feature b3dm), decodes its Draco mesh and scatters points uniformly over
the tower's surface. The map lights them as LEDs, so they follow the model the
map draws exactly.

The points are written in the tower's own West-Up-North frame (Navara's
`geodetic` mesh placement), in decimetres, with the frame's origin at the foot
of the tower's axis. Heights are PLATEAU's: above the ellipsoid.

Usage:
    python scripts/day05/extract_skytree.py [--count 9000] [--out PATH]
"""

import argparse
import json
import math
import struct
import urllib.request
from pathlib import Path

import DracoPy
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT = ROOT / "public" / "data" / "day05" / "skytree_leds.json"
TILESET = (
    "https://assets.cms.plateau.reearth.io/assets/f2/aaaf35-d94c-4c15-affd-d9f652cd16c1/"
    "13107_sumida-ku_pref_2025_citygml_1_op_bldg_3dtiles_13107_sumida-ku_lod3/"
)
TILE = "data/4/data396.b3dm"
NAME = "東京スカイツリー"

# The feature also holds the Tokyo Solamachi complex around the tower's foot. LEDs go on the
# tower's walls: surfaces within TOWER_RADIUS (m) of the axis, or FOOT_RADIUS below
# FOOT_HEIGHT where the complex hugs the tower, steeper than FLAT (|normal . up|), plus the
# decks' and the antenna's flat tops above DECK_HEIGHT
TOWER_RADIUS = 45.0
FOOT_RADIUS = 35.0
FOOT_HEIGHT = 40.0
FLAT = 0.7
DECK_HEIGHT = 100.0
# Points sit this far (m) out from the surface, so they don't z-fight with it
LIFT = 0.4

WGS84_A = 6378137.0
WGS84_E2 = (1 / 298.257223563) * (2 - 1 / 298.257223563)


def read_b3dm(data: bytes) -> tuple[dict, np.ndarray]:
    """The batch table and the mesh's triangles in ECEF, shape (n, 3, 3)."""
    _, _, _, ftj, ftb, btj, btb = struct.unpack("<4sIIIIII", data[:28])
    batch = json.loads(data[28 + ftj + ftb : 28 + ftj + ftb + btj])
    glb = data[28 + ftj + ftb + btj + btb :]
    (json_len,) = struct.unpack("<I", glb[12:16])
    gltf = json.loads(glb[20 : 20 + json_len])
    (bin_len,) = struct.unpack("<I", glb[20 + json_len : 24 + json_len])
    bin_ = glb[28 + json_len : 28 + json_len + bin_len]

    tris = []
    for prim in gltf["meshes"][0]["primitives"]:
        view = gltf["bufferViews"][prim["extensions"]["KHR_draco_mesh_compression"]["bufferView"]]
        start = view.get("byteOffset", 0)
        mesh = DracoPy.decode(bin_[start : start + view["byteLength"]])
        tris.append(np.asarray(mesh.points, dtype=float)[np.asarray(mesh.faces)])
    tri = np.vstack(tris)
    # glTF is Y-up; 3D Tiles is Z-up, relative to the CESIUM_RTC center
    center = np.array(gltf["extensions"]["CESIUM_RTC"]["center"])
    return batch, center + np.stack([tri[..., 0], -tri[..., 2], tri[..., 1]], -1)


def to_geodetic(ecef: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """ECEF -> longitude, latitude (degrees), ellipsoidal height (m)."""
    x, y, z = np.moveaxis(ecef, -1, 0)
    lng = np.arctan2(y, x)
    p = np.hypot(x, y)
    lat = np.arctan2(z, p * (1 - WGS84_E2))
    for _ in range(6):
        n = WGS84_A / np.sqrt(1 - WGS84_E2 * np.sin(lat) ** 2)
        h = p / np.cos(lat) - n
        lat = np.arctan2(z, p * (1 - WGS84_E2 * n / (n + h)))
    return np.degrees(lng), np.degrees(lat), h


def to_ecef(lng: float, lat: float, h: float) -> np.ndarray:
    lng, lat = math.radians(lng), math.radians(lat)
    n = WGS84_A / math.sqrt(1 - WGS84_E2 * math.sin(lat) ** 2)
    return np.array(
        [
            (n + h) * math.cos(lat) * math.cos(lng),
            (n + h) * math.cos(lat) * math.sin(lng),
            (n * (1 - WGS84_E2) + h) * math.sin(lat),
        ]
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--count", type=int, default=9000, help="LED points to scatter")
    parser.add_argument("--seed", type=int, default=5)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()

    print(f"Downloading {TILE}...")
    with urllib.request.urlopen(TILESET + TILE) as res:
        batch, tri = read_b3dm(res.read())
    if batch.get("gml:name") != [NAME]:
        raise SystemExit(f"{TILE} no longer holds {NAME} alone: {batch.get('gml:name')}")

    # The axis: the antenna's top is a thin mast, so its centroid is the axis
    _, _, vh = to_geodetic(tri.reshape(-1, 3))
    top = tri.reshape(-1, 3)[vh > vh.max() - 5]
    axis_lng, axis_lat, _ = to_geodetic(top.mean(0))
    foot = float(vh.min())
    origin = to_ecef(float(axis_lng), float(axis_lat), foot)

    # Rows: west, up, north at the origin
    lng, lat = math.radians(axis_lng), math.radians(axis_lat)
    east = np.array([-math.sin(lng), math.cos(lng), 0])
    north = np.array([-math.sin(lat) * math.cos(lng), -math.sin(lat) * math.sin(lng), math.cos(lat)])
    up = np.cross(east, north)
    wun = np.stack([-east, up, north])

    local = (tri - origin) @ wun.T
    normal = np.cross(local[:, 1] - local[:, 0], local[:, 2] - local[:, 0])
    area = 0.5 * np.linalg.norm(normal, axis=1)
    centroid = local.mean(1)
    height = centroid[:, 1]
    radial = np.hypot(centroid[:, 0], centroid[:, 2])
    flat = np.abs(normal[:, 1]) / np.maximum(2 * area, 1e-9) > FLAT
    wall = ~flat & (radial < np.where(height < FOOT_HEIGHT, FOOT_RADIUS, TOWER_RADIUS))
    deck = flat & (height > DECK_HEIGHT) & (radial < TOWER_RADIUS)
    area = np.where(wall | deck, area, 0)

    # Uniform over those surfaces: pick triangles by area, then a point inside each
    rng = np.random.default_rng(args.seed)
    picks = rng.choice(len(local), args.count, p=area / area.sum())
    u, v = rng.random((2, len(picks)))
    flip = u + v > 1
    u[flip], v[flip] = 1 - u[flip], 1 - v[flip]
    t = local[picks]
    pts = t[:, 0] + u[:, None] * (t[:, 1] - t[:, 0]) + v[:, None] * (t[:, 2] - t[:, 0])

    radial = np.hypot(pts[:, 0], pts[:, 2])[:, None]
    pts[:, [0, 2]] *= (radial + LIFT) / np.maximum(radial, 1e-6)
    pts = pts[np.argsort(pts[:, 1])]  # bottom to top

    out = {
        "attribution": "PLATEAU (MLIT), 2025 Sumida-ku building model LOD3",
        "origin": {"lng": round(float(axis_lng), 7), "lat": round(float(axis_lat), 7), "height": round(foot, 2)},
        "top": round(float(vh.max() - foot), 1),
        "frame": "west-up-north, decimetres",
        "points": np.round(pts * 10).astype(int).ravel().tolist(),
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(out, separators=(",", ":")))
    print(f"{len(pts)} points, {out['top']} m tall, foot at {out['origin']} -> {args.out}")


if __name__ == "__main__":
    main()
