"""Day 2 (Lines): extract Japan's Shinkansen lines from Overture Maps.

Reads rail segments (`transportation` theme, `segment` type, subtype `rail`)
around Japan, then traces each line from one terminal to the other: the
segments form a track graph (double tracks, crossovers, depot spurs and all)
and each line is the shortest path through it between its terminal stations.
The output is one LineString per line, ordered start → end, so the map can run
pulses along it.

Full Shinkansen lines are routed over segments named "…新幹線…" (or
"…Shinkansen…": a few are romanized) only. The
mini-Shinkansen (Yamagata, Akita) run on conventional lines, so they are routed
over the whole rail network. Segments of class `unknown` (lines under
construction or planned, e.g. the Chuo Shinkansen) are left out.

The S3 scan takes a while, so the raw segments are cached in
`scripts/.cache/day02_rail.parquet`; pass `--refresh` to fetch them again.

Usage:
    python scripts/day02/extract_shinkansen.py [--release 2026-10-21.0]
        [--tolerance 0.0002] [--refresh] [--out PATH]
"""

import argparse
import heapq
import json
import math
from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT = ROOT / "public" / "data" / "day02" / "shinkansen.geojson"
CACHE = ROOT / "scripts" / ".cache" / "day02_rail.parquet"
DEFAULT_RELEASE = "2026-10-21.0"

# Rough bbox around Japan
JAPAN_BBOX = dict(xmin=122.0, xmax=154.0, ymin=20.0, ymax=46.0)

# Terminal stations (lng, lat)
STATIONS = {
    "東京": (139.7671, 35.6812),
    "大宮": (139.6237, 35.9064),
    "高崎": (139.0126, 36.3226),
    "新大阪": (135.5005, 34.7334),
    "博多": (130.4206, 33.5897),
    "鹿児島中央": (130.5413, 31.5839),
    "武雄温泉": (130.0215, 33.1937),
    "長崎": (129.8706, 32.7521),
    "新青森": (140.6936, 40.8270),
    "新函館北斗": (140.6486, 41.9045),
    "新潟": (139.0612, 37.9122),
    "敦賀": (136.0745, 35.6453),
    "福島": (140.4589, 37.7543),
    "新庄": (140.3062, 38.7621),
    "盛岡": (141.1366, 39.7016),
    "秋田": (140.1257, 39.7170),
}

# (name, English name, from, to, mini-Shinkansen)
LINES = [
    ("東海道新幹線", "Tokaido", "東京", "新大阪", False),
    ("山陽新幹線", "Sanyo", "新大阪", "博多", False),
    ("九州新幹線", "Kyushu", "博多", "鹿児島中央", False),
    ("西九州新幹線", "Nishi-Kyushu", "武雄温泉", "長崎", False),
    ("東北新幹線", "Tohoku", "東京", "新青森", False),
    ("北海道新幹線", "Hokkaido", "新青森", "新函館北斗", False),
    ("上越新幹線", "Joetsu", "大宮", "新潟", False),
    ("北陸新幹線", "Hokuriku", "高崎", "敦賀", False),
    ("山形新幹線", "Yamagata", "福島", "新庄", True),
    ("秋田新幹線", "Akita", "盛岡", "秋田", True),
]

# Track nodes within this distance of a terminal can start/end its line
TERMINAL_RADIUS_M = 1500

QUERY = """
SELECT
    id,
    names.primary AS name,
    class,
    ST_AsText(geometry) AS wkt
FROM read_parquet($src, hive_partitioning = 1)
WHERE subtype = 'rail'
  AND bbox.xmin BETWEEN $xmin AND $xmax
  AND bbox.ymin BETWEEN $ymin AND $ymax
"""


def haversine(a: tuple[float, float], b: tuple[float, float]) -> float:
    lng1, lat1, lng2, lat2 = map(math.radians, (*a, *b))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lng2 - lng1) / 2) ** 2
    return 2 * 6_371_008.8 * math.asin(math.sqrt(h))


def parse_linestring(wkt: str) -> list[tuple[float, float]]:
    body = wkt[wkt.index("(") + 1 : wkt.rindex(")")]
    return [tuple(map(float, p.split()[:2])) for p in body.split(",")]  # type: ignore[misc]


def build_graph(lines: list[list[tuple[float, float]]]) -> dict[tuple[float, float], dict[tuple[float, float], float]]:
    """Every vertex is a node; segments share the OSM nodes they meet at."""
    graph: dict[tuple[float, float], dict[tuple[float, float], float]] = {}
    for coords in lines:
        for a, b in zip(coords, coords[1:]):
            if a == b:
                continue
            d = haversine(a, b)
            graph.setdefault(a, {})[b] = d
            graph.setdefault(b, {})[a] = d
    return graph


def shortest_path(graph, sources: set, targets: set) -> list[tuple[float, float]] | None:
    """Multi-source Dijkstra: the shortest track path from any source node to any target node."""
    dist = {s: 0.0 for s in sources}
    prev: dict = {}
    heap = [(0.0, s) for s in sources]
    heapq.heapify(heap)
    while heap:
        d, node = heapq.heappop(heap)
        if d > dist[node]:
            continue
        if node in targets:
            path = [node]
            while path[-1] in prev:
                path.append(prev[path[-1]])
            return path[::-1]
        for nxt, w in graph[node].items():
            nd = d + w
            if nd < dist.get(nxt, math.inf):
                dist[nxt] = nd
                prev[nxt] = node
                heapq.heappush(heap, (nd, nxt))
    return None


def fetch_segments(release: str, refresh: bool) -> None:
    if CACHE.exists() and not refresh:
        return
    src = f"s3://overturemaps-us-west-2/release/{release}/theme=transportation/type=segment/*"
    con = duckdb.connect()
    con.sql("INSTALL spatial; LOAD spatial; INSTALL httpfs; LOAD httpfs;")
    con.sql("SET s3_region = 'us-west-2';")
    print("Fetching rail segments around Japan (takes 15+ minutes)...")
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    con.execute(f"COPY ({QUERY}) TO '{CACHE}' (FORMAT parquet)", {**JAPAN_BBOX, "src": src})


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--release", default=DEFAULT_RELEASE)
    parser.add_argument(
        "--tolerance",
        type=float,
        default=0.0002,
        help="simplification tolerance in degrees (~20 m at 0.0002)",
    )
    parser.add_argument("--refresh", action="store_true", help="re-fetch the segments from S3")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()

    fetch_segments(args.release, args.refresh)
    con = duckdb.connect()
    con.sql("INSTALL spatial; LOAD spatial;")
    rows = con.execute(
        """
        SELECT coalesce(name LIKE '%新幹線%' OR name ILIKE '%shinkansen%', false), wkt
        FROM read_parquet($p)
        WHERE class <> 'unknown' AND wkt LIKE 'LINESTRING%'
        """,
        {"p": str(CACHE)},
    ).fetchall()
    print(f"{len(rows)} rail segments")
    rail = build_graph([parse_linestring(wkt) for _, wkt in rows])
    shinkansen = build_graph([parse_linestring(wkt) for named, wkt in rows if named])

    features = []
    for name, name_en, start, end, mini in LINES:
        graph = rail if mini else shinkansen
        sources = {n for n in graph if haversine(n, STATIONS[start]) <= TERMINAL_RADIUS_M}
        targets = {n for n in graph if haversine(n, STATIONS[end]) <= TERMINAL_RADIUS_M}
        path = shortest_path(graph, sources, targets)
        if path is None:
            print(f"  {name}: no track path from {start} to {end}, skipped")
            continue
        wkt = "LINESTRING(" + ",".join(f"{x} {y}" for x, y in path) + ")"
        (simplified,) = con.execute(
            "SELECT ST_AsText(ST_SimplifyPreserveTopology(ST_GeomFromText($w), $t))",
            {"w": wkt, "t": args.tolerance},
        ).fetchone()
        coords = parse_linestring(simplified)
        length_km = sum(haversine(a, b) for a, b in zip(path, path[1:])) / 1000
        print(f"  {name}: {start} → {end}, {length_km:.0f} km, {len(coords)} vertices")
        features.append(
            {
                "type": "Feature",
                "id": len(features),
                "properties": {
                    "name": name,
                    "name_en": f"{name_en} Shinkansen",
                    "from": start,
                    "to": end,
                    "length_km": round(length_km, 1),
                    "mini": mini,
                },
                "geometry": {"type": "LineString", "coordinates": [[round(x, 5), round(y, 5)] for x, y in coords]},
            }
        )

    collection = {
        "type": "FeatureCollection",
        "attribution": f"Overture Maps Foundation ({args.release})",
        "features": features,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(collection, ensure_ascii=False, separators=(",", ":")))
    print(f"{len(features)} features -> {args.out}")


if __name__ == "__main__":
    main()
