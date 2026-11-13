"""Day 13 (Interaction): Shibuya's streets, buildings and coffee shops from Overture Maps.

Reads three Overture themes straight from S3 with DuckDB, over a box around Shibuya
Station, and writes them to `public/data/day13/`:

- `streets.json`: the walkable street network as a graph. Every road segment (not
  motorways, not underground) is cut at its connectors, so each edge runs from one
  junction to the next; only the largest connected part is kept, so every street can
  be reached from every other. Railways come along, to draw only.
- `buildings.geojson`: footprints with a height (m): Overture's, or from the floor
  count, or a guess.
- `coffee.json`: coffee shops (Overture's `coffee_shop` / `coffee_roastery`, and
  `cafe`s with coffee in their name), duplicates within a few metres merged.

Usage:
    python scripts/day13/extract_shibuya.py [--release 2026-10-21.0] [--out DIR]
"""

import argparse
import json
import math
import re
from collections import defaultdict
from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT = ROOT / "public" / "data" / "day13"
DEFAULT_RELEASE = "2026-10-21.0"

# Around Shibuya Station: Dōgenzaka and Udagawachō to the west, Miyashita Park and
# Shibuya Stream to the east, about 1.5 km each way
BBOX = dict(xmin=139.6935, xmax=139.7105, ymin=35.6505, ymax=35.6655)
# Segments are read from a little further out, so streets that cross the edge are whole
MARGIN = 0.002

NOT_WALKABLE = {"motorway"}
FLOOR_M = 3.5
DEFAULT_HEIGHT = 9.0
COFFEE_NAME = re.compile(r"coffee|espresso|roast|珈琲|コーヒー|喫茶|カフェ", re.I)
DUPLICATE_M = 12.0

M_PER_LAT = 110_950.0
M_PER_LNG = 111_320.0 * math.cos(math.radians((BBOX["ymin"] + BBOX["ymax"]) / 2))


def metres(a, b):
    return math.hypot((b[0] - a[0]) * M_PER_LNG, (b[1] - a[1]) * M_PER_LAT)


def inside(p):
    return BBOX["xmin"] <= p[0] <= BBOX["xmax"] and BBOX["ymin"] <= p[1] <= BBOX["ymax"]


def in_box(margin: float) -> str:
    return (
        f"bbox.xmax >= {BBOX['xmin'] - margin} AND bbox.xmin <= {BBOX['xmax'] + margin}"
        f" AND bbox.ymax >= {BBOX['ymin'] - margin} AND bbox.ymin <= {BBOX['ymax'] + margin}"
    )


def round_pt(p):
    return [round(p[0], 6), round(p[1], 6)]


def cut(coords, ats):
    """Splits a line at fractions `ats` of its length; returns the pieces."""
    lengths = [0.0]
    for a, b in zip(coords, coords[1:]):
        lengths.append(lengths[-1] + metres(a, b))
    total = lengths[-1]

    def point_at(d):
        for i in range(1, len(lengths)):
            if lengths[i] >= d:
                span = lengths[i] - lengths[i - 1]
                t = (d - lengths[i - 1]) / span if span else 0.0
                a, b = coords[i - 1], coords[i]
                return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
        return list(coords[-1])

    pieces = []
    for at0, at1 in zip(ats, ats[1:]):
        d0, d1 = at0 * total, at1 * total
        piece = [point_at(d0)]
        piece += [list(c) for c, d in zip(coords, lengths) if d0 < d < d1]
        piece.append(point_at(d1))
        pieces.append(piece)
    return pieces


def streets(con, src):
    rows = con.execute(
        f"""
        SELECT id, subtype, class, subclass, names.primary,
               [r.value FOR r IN coalesce(level_rules, [])] AS levels,
               connectors, ST_AsGeoJSON(geometry)
        FROM read_parquet('{src}/theme=transportation/type=segment/*', hive_partitioning = 1)
        WHERE {in_box(MARGIN)} AND subtype IN ('road', 'rail')
        """
    ).fetchall()
    print(f"  {len(rows)} segments")

    rails, edges = [], []
    for _id, subtype, cls, subclass, name, levels, connectors, geom in rows:
        coords = json.loads(geom)["coordinates"]
        if any(l < 0 for l in levels):
            continue  # under the ground: the station's concourses, the subways
        if subtype == "rail":
            if any(inside(c) for c in coords):
                rails.append([round_pt(c) for c in coords])
            continue
        if cls in NOT_WALKABLE or not connectors:
            continue
        connectors = sorted(connectors, key=lambda c: c["at"])
        ats = [c["at"] for c in connectors]
        ids = [c["connector_id"] for c in connectors]
        for (a, b), piece in zip(zip(ids, ids[1:]), cut(coords, ats)):
            if a == b or not any(inside(p) for p in piece):
                continue
            edges.append(dict(a=a, b=b, coords=piece, cls=subclass or cls, name=name))

    # Keep the largest connected part
    adjacent = defaultdict(set)
    for e in edges:
        adjacent[e["a"]].add(e["b"])
        adjacent[e["b"]].add(e["a"])
    seen, best = set(), set()
    for start in adjacent:
        if start in seen:
            continue
        part, stack = {start}, [start]
        while stack:
            for n in adjacent[stack.pop()]:
                if n not in part:
                    part.add(n)
                    stack.append(n)
        seen |= part
        if len(part) > len(best):
            best = part
    edges = [e for e in edges if e["a"] in best]

    # Junctions a street of no length joins are one junction
    parent = {}

    def find(n):
        while parent.get(n, n) != n:
            n = parent[n]
        return n

    kept = []
    for e in edges:
        if sum(metres(p, q) for p, q in zip(e["coords"], e["coords"][1:])) < 0.05:
            parent[find(e["a"])] = find(e["b"])
        else:
            kept.append(e)
    edges = kept
    for e in edges:
        e["a"], e["b"] = find(e["a"]), find(e["b"])

    index = {}
    nodes = []
    for e in edges:
        for key, end in (("a", e["coords"][0]), ("b", e["coords"][-1])):
            if e[key] not in index:
                index[e[key]] = len(nodes)
                nodes.append(round_pt(end))
    out_edges = []
    for e in edges:
        line = [round_pt(p) for p in e["coords"]]
        # Rounding can leave repeated points
        line = [p for i, p in enumerate(line) if i == 0 or p != line[i - 1]]
        if len(line) < 2:
            line = [nodes[index[e["a"]]], nodes[index[e["b"]]]]
        out_edges.append({"a": index[e["a"]], "b": index[e["b"]], "class": e["cls"], "line": line})
    print(f"  {len(nodes)} junctions, {len(out_edges)} streets, {len(rails)} railways")
    return {"bbox": BBOX, "nodes": nodes, "edges": out_edges, "rails": rails}


def buildings(con, src):
    rows = con.execute(
        f"""
        SELECT height, num_floors, ST_AsGeoJSON(geometry)
        FROM read_parquet('{src}/theme=buildings/type=building/*', hive_partitioning = 1)
        WHERE {in_box(0)} AND NOT coalesce(is_underground, false)
        """
    ).fetchall()
    features = []
    for height, floors, geom in rows:
        g = json.loads(geom)
        if g["type"] not in ("Polygon", "MultiPolygon"):
            continue
        h = height or (floors * FLOOR_M if floors else DEFAULT_HEIGHT)
        polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
        g["coordinates"] = [[[round_pt(p) for p in ring] for ring in poly] for poly in polys]
        g["type"] = "MultiPolygon"
        features.append({"type": "Feature", "properties": {"h": round(h, 1)}, "geometry": g})
    print(f"  {len(features)} buildings")
    return features


def coffee(con, src):
    rows = con.execute(
        f"""
        SELECT names.primary, taxonomy.primary, confidence, ST_X(geometry), ST_Y(geometry)
        FROM read_parquet('{src}/theme=places/type=place/*', hive_partitioning = 1)
        WHERE {in_box(0)}
          AND taxonomy.primary IN ('coffee_shop', 'coffee_roastery', 'cafe')
          AND coalesce(operating_status, 'open') = 'open'
          AND confidence >= 0.5
        ORDER BY confidence DESC
        """
    ).fetchall()
    shops = []
    for name, category, confidence, lng, lat in rows:
        if not name or (category == "cafe" and not COFFEE_NAME.search(name)):
            continue
        p = [lng, lat]
        if not inside(p):
            continue
        # The same shop from two sources: the same name, a few metres apart
        if any(s["name"].casefold() == name.casefold() and metres(s["at"], p) < DUPLICATE_M for s in shops):
            continue
        shops.append({"name": name, "at": round_pt(p)})
    print(f"  {len(shops)} coffee shops")
    return shops


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--release", default=DEFAULT_RELEASE)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()

    src = f"s3://overturemaps-us-west-2/release/{args.release}"
    con = duckdb.connect()
    con.sql("INSTALL spatial; LOAD spatial; INSTALL httpfs; LOAD httpfs;")
    con.sql("SET s3_region = 'us-west-2';")
    attribution = f"Overture Maps Foundation ({args.release})"
    args.out.mkdir(parents=True, exist_ok=True)

    def write(name, data):
        path = args.out / name
        path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")))
        print(f"  -> {path} ({path.stat().st_size / 1e6:.2f} MB)")

    print("Streets...")
    write("streets.json", {"attribution": attribution, **streets(con, src)})
    print("Buildings...")
    write(
        "buildings.geojson",
        {"type": "FeatureCollection", "attribution": attribution, "features": buildings(con, src)},
    )
    print("Coffee shops...")
    write("coffee.json", {"attribution": attribution, "shops": coffee(con, src)})


if __name__ == "__main__":
    main()
