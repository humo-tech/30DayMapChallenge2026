"""Day 23 (Senses: Taste): the prefectures, and how much of each autumn flavour they ship.

1. Prefectures: Overture Maps' 47 prefectures cut to Day 1's coast (the same as Day 22,
   from its cache), projected to km (Lambert conformal conic over Japan), the far-off islands
   (Ogasawara, Daito, Minamitorishima, Okinotorishima) and the specks left off, then thinned
   hard and rounded off the way Day 22's map art is (one coverage, so neighbours still share
   their borders), and shrunk a little for a groove between neighbours.
2. Harvest: MAFF's 令和7年産 (2025) figures from e-Stat, per prefecture:
     くり かき 日本なし ぶどう りんご   出荷量 (shipped), 第1報 (preliminary)
     かんしょ                            収穫量 (harvested; no 出荷量 is published)
   Only the main producing prefectures (主産県) are surveyed in these years; the rest are null.

Output: public/data/day23/japan.json (the prefectures shrunk for the grooves, with each one's
heap point; the land whole, for the grooves' floor; the cover hiding the basemap's Japan; the
harvest)

Usage:
    python scripts/day23/build_data.py

The e-Stat files are downloaded into scripts/.cache/day23 the first time. Day 22's Overture
cache is used if it is there (else Overture is queried, see scripts/day22/build_maps.py).
"""

import json
import re
import sys
import urllib.request
from pathlib import Path

import numpy as np
import openpyxl
import shapely
from pyproj import Transformer
from shapely.geometry import LineString, MultiPolygon, Polygon, box
from shapely.ops import linemerge, polygonize, polylabel, unary_union

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "public" / "data" / "day23" / "japan.json"
CACHE = ROOT / "scripts" / ".cache" / "day23"
sys.path.insert(0, str(ROOT / "scripts" / "day22"))
from build_maps import DEFAULT_RELEASE, chaikin, japan_regions, polygons_only  # noqa: E402

ESTAT = "https://www.e-stat.go.jp/stat-search/file-download?statInfId={}&fileKind=0"

# key: (statInfId, sheet, which number after the prefecture's name is the figure (0-based))
HARVEST = {
    "kuri": ("000040423317", "くり", 4),  # 栽培面積, 結果樹面積, 10a当たり収量, 収穫量, 出荷量
    "kaki": ("000040423317", "かき", 4),
    "nashi": ("000040401294", "日本なし", 4),
    "budou": ("000040401294", "ぶどう", 4),
    "ringo": ("000040444651", "りんご", 4),
    "kansho": ("000040469082", None, 2),  # 作付面積, 10a当たり収量, 収穫量
}
MEASURE = {k: "shipped" for k in HARVEST} | {"kansho": "harvested"}

PREFS = (
    "北海道 青森 岩手 宮城 秋田 山形 福島 茨城 栃木 群馬 埼玉 千葉 東京 神奈川 新潟 富山 石川 福井 山梨 長野 "
    "岐阜 静岡 愛知 三重 滋賀 京都 大阪 兵庫 奈良 和歌山 鳥取 島根 岡山 広島 山口 徳島 香川 愛媛 高知 福岡 "
    "佐賀 長崎 熊本 大分 宮崎 鹿児島 沖縄"
).split()

# Thinning, as Day 22's map art does it (without its bending): drop the small islands (km²,
# unless it's a prefecture's largest), thin hard (km) and round the corners off
MIN_ISLAND = 50
SIMPLIFY = 4.5
# Each prefecture is shrunk by this much (km), leaving a groove between it and its neighbours
INSET = 1.2
# How far past the real coast the cover over the basemap's Japan reaches (km)
COVER = 6
# Left off: Ogasawara, the Daito islands, Minamitorishima, Okinotorishima
FAR = [box(140.5, 20, 160, 32.5), box(130.5, 20, 140.5, 27)]

LCC = Transformer.from_crs("EPSG:4326", "+proj=lcc +lat_1=33 +lat_2=44 +lat_0=36 +lon_0=137 +units=km", always_xy=True)


def norm(v):
    return re.sub(r"[\s　]", "", str(v)) if v is not None else ""


def harvest():
    CACHE.mkdir(parents=True, exist_ok=True)
    out = {}
    for key, (inf_id, sheet, nth) in HARVEST.items():
        path = CACHE / f"{inf_id}.xlsx"
        if not path.exists():
            print(f"Downloading {key} ({inf_id})...")
            urllib.request.urlretrieve(ESTAT.format(inf_id), path)
        wb = openpyxl.load_workbook(path, data_only=True, read_only=True)
        ws = wb[sheet] if sheet else wb.worksheets[0]
        values, national = {}, None
        for row in ws.iter_rows(values_only=True):
            cells = [norm(v) for v in row]
            hit = next((i for i, c in enumerate(cells[:4]) if c in PREFS or c == "全国"), None)
            if hit is None:
                continue
            after = [v for v in row[hit + 1 :] if v is not None and norm(v) != ""]
            v = after[nth] if len(after) > nth else None
            v = 0 if norm(v) == "-" else v if isinstance(v, (int, float)) else None
            if cells[hit] == "全国":
                national = national if national is not None else v
            elif cells[hit] not in values:  # the prefecture table comes after any regional one
                values[cells[hit]] = v
        out[key] = {
            "measure": MEASURE[key],
            "national": national,
            "values": [values.get(p) for p in PREFS],
            "source": ESTAT.format(inf_id),
        }
        top = sorted(((v, p) for p, v in values.items() if v), reverse=True)[:3]
        print(f"{key:7s} national {national:>8}  {sum(v is not None for v in values.values())} prefs  top {top}")
    return out


def prefectures():
    regions, _ = japan_regions(DEFAULT_RELEASE)
    regions.sort(key=lambda r: r["id"])  # JP-01 ... JP-47
    far = shapely.union_all(FAR)
    to_km = lambda xy: np.column_stack(LCC.transform(xy[:, 0], xy[:, 1]))  # noqa: E731
    geoms, raw = [], []
    for r in regions:
        parts = sorted(polygons(shapely.transform(r["geom"].difference(far), to_km)), key=lambda p: -p.area)
        raw += parts
        geoms.append(MultiPolygon([p for i, p in enumerate(parts) if i == 0 or p.area >= MIN_ISLAND]))
    geoms = smooth_coverage(geoms, SIMPLIFY)
    # Under the prefectures: the land whole (the grooves' floor), and a cover a little wider than the
    # real coast and every island, to hide the basemap's own Japan
    land = polygons(unary_union(geoms).simplify(0.2))
    cover = polygons(unary_union([unary_union(raw).buffer(COVER), *land]).simplify(1.0))
    prefs = []
    for r, g in zip(regions, geoms):
        parts = sorted(polygons(g), key=lambda p: -p.area)
        heap = polylabel(parts[0], 0.5)
        # Shrunk for the groove (round joins, so the rounded corners stay round)
        parts = [q for p in parts for q in polygons(p.buffer(-INSET).simplify(0.1)) if q.area >= 5]  # no slivers off narrow necks
        prefs.append(
            {
                "code": int(r["id"].split("-")[1]),
                "name": r["name"],
                "polygons": [[ring(p.exterior)] + [r for r in map(ring, p.interiors) if len(r) >= 3] for p in parts],
                "heap": [round(heap.x, 1), round(heap.y, 1)],
            }
        )
    n = sum(len(ring_) for p in prefs for poly in p["polygons"] for ring_ in poly)
    print(f"{len(prefs)} prefectures, {sum(len(p['polygons']) for p in prefs)} polygons, {n} vertices")
    rings = lambda ps: [[ring(p.exterior)] + [r for r in map(ring, p.interiors) if len(r) >= 3] for p in ps]  # noqa: E731
    return prefs, rings(land), rings(cover)


def smooth_coverage(geoms, tolerance):
    """Thin the prefectures together (shared borders stay shared), then round off each border
    and coast arc by arc (Chaikin, twice), so neighbours still meet: Day 22's to_art, step 4."""
    simple = shapely.coverage_simplify(geoms, tolerance)
    arcs = linemerge(unary_union([g.boundary for g in simple if not g.is_empty]))
    arcs = list(getattr(arcs, "geoms", [arcs]))
    faces = polygonize(unary_union([LineString(chaikin(a.coords, a.is_ring)) for a in arcs]))
    tree = shapely.STRtree(simple)
    out = [[] for _ in geoms]
    for face in faces:
        if face.area < 1:
            continue
        # The prefecture it overlaps most (rounding moves edges, so a point inside can miss)
        hit = [(simple[i].intersection(face).area, i) for i in tree.query(face, predicate="intersects")]
        if hit and max(hit)[0] > 0.5 * face.area:
            out[max(hit)[1]].append(face)
    return [polygons_only(unary_union(a)) if a else MultiPolygon() for a in out]


def polygons(g):
    return [p for p in getattr(g, "geoms", [g]) if isinstance(p, Polygon) and not p.is_empty]


def ring(r):
    pts = np.round(np.asarray(r.coords), 1)
    keep = np.r_[True, np.any(pts[1:] != pts[:-1], axis=1)]
    return pts[keep][:-1].tolist()  # open ring


def main():
    prefs, land, cover = prefectures()
    data = {"prefs": prefs, "land": land, "cover": cover, "items": harvest()}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")))
    print(f"Wrote {OUT} ({OUT.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
