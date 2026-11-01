"""Day 1 (Points): extract Overture Maps places named "鳥取" / "とっとり" / "TOTTORI".

Reads the Overture `places` theme directly from S3 with DuckDB and writes a
GeoJSON FeatureCollection of points, worldwide, in two passes:

- Around Japan: keywords matched case-insensitively against the primary name
  and every localized name (`names.common`). The bbox lets DuckDB skip most
  Parquet row groups, so this takes well under a minute.
- Elsewhere: primary name only. A worldwide scan can't skip row groups, and
  reading `names.common` (a large map column) as well made it ~4x slower.

Usage:
    python scripts/day01/extract_tottori.py [--release 2026-10-21.0] [--out PATH]
"""

import argparse
import json
from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT = ROOT / "public" / "data" / "day01" / "tottori_places.geojson"
DEFAULT_RELEASE = "2026-10-21.0"
KEYWORDS = ["鳥取", "とっとり", "tottori"]

# Rough bbox around Japan
JAPAN_BBOX = dict(xmin=122.0, xmax=154.0, ymin=20.0, ymax=46.0)

COLUMNS = """
    id,
    names.primary AS name,
    basic_category AS category,
    confidence,
    addresses[1].freeform AS address,
    ST_X(geometry) AS lng,
    ST_Y(geometry) AS lat
"""
IN_JAPAN = "bbox.xmin BETWEEN $xmin AND $xmax AND bbox.ymin BETWEEN $ymin AND $ymax"

JAPAN_QUERY = f"""
SELECT {COLUMNS}
FROM read_parquet($src, hive_partitioning = 1)
WHERE {IN_JAPAN}
  AND list_bool_or(list_transform(
        list_prepend(names.primary, map_values(names.common)),
        lambda n: regexp_matches(n, $pattern, 'i')
      ))
"""

# ILIKE rather than regexp_matches: measured several times faster on this scan
WORLD_QUERY = f"""
SELECT {COLUMNS}
FROM read_parquet($src, hive_partitioning = 1)
WHERE NOT ({IN_JAPAN})
  AND ({" OR ".join(f"names.primary ILIKE '%{k}%'" for k in KEYWORDS)})
"""


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--release", default=DEFAULT_RELEASE)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()

    src = f"s3://overturemaps-us-west-2/release/{args.release}/theme=places/type=place/*"

    con = duckdb.connect()
    con.sql("INSTALL spatial; LOAD spatial; INSTALL httpfs; LOAD httpfs;")
    con.sql("SET s3_region = 'us-west-2';")

    params = {**JAPAN_BBOX, "src": src}
    print("Searching around Japan...")
    rows = con.execute(JAPAN_QUERY, {**params, "pattern": "|".join(KEYWORDS)}).fetchall()
    print(f"  {len(rows)} places")
    print("Searching the rest of the world (takes a few minutes)...")
    world = con.execute(WORLD_QUERY, params).fetchall()
    print(f"  {len(world)} places")
    rows = sorted(rows + world)

    features = [
        {
            "type": "Feature",
            "id": i,
            "properties": {
                "overture_id": oid,
                "name": name,
                "category": category,
                "confidence": round(conf, 3) if conf is not None else None,
                "address": address,
            },
            "geometry": {"type": "Point", "coordinates": [round(lng, 6), round(lat, 6)]},
        }
        for i, (oid, name, category, conf, address, lng, lat) in enumerate(rows)
    ]
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
