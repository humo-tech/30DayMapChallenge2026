"""Day 1 (Points): extract Japanese prefecture borders from Overture Maps.

Reads the Overture `divisions` theme (`division_boundary`, land borders between
`region` = prefecture divisions) and writes a simplified GeoJSON of
LineStrings. Borders touching Tottori Prefecture get `tottori: true`.

Usage:
    python scripts/day01/extract_pref_boundaries.py [--release 2026-10-21.0]
        [--tolerance 0.0005] [--out PATH]
"""

import argparse
import json
from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT = ROOT / "public" / "data" / "day01" / "pref_boundaries.geojson"
DEFAULT_RELEASE = "2026-10-21.0"
TOTTORI_REGION = "JP-31"  # ISO 3166-2 code of Tottori Prefecture


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--release", default=DEFAULT_RELEASE)
    parser.add_argument(
        "--tolerance",
        type=float,
        default=0.0005,
        help="simplification tolerance in degrees (~50 m at 0.0005)",
    )
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()

    base = f"s3://overturemaps-us-west-2/release/{args.release}/theme=divisions"

    con = duckdb.connect()
    con.sql("INSTALL spatial; LOAD spatial; INSTALL httpfs; LOAD httpfs;")
    con.sql("SET s3_region = 'us-west-2';")

    rows = con.execute(
        f"""
        WITH tottori AS (
            SELECT id
            FROM read_parquet('{base}/type=division/*', hive_partitioning = 1)
            WHERE country = 'JP' AND subtype = 'region' AND region = $region
        )
        SELECT
            b.id,
            list_has_any(b.division_ids, (SELECT list(id) FROM tottori)) AS tottori,
            ST_AsGeoJSON(ST_SimplifyPreserveTopology(b.geometry, $tolerance)) AS geom
        FROM read_parquet('{base}/type=division_boundary/*', hive_partitioning = 1) b
        WHERE b.country = 'JP'
          AND b.subtype = 'region'
          AND b.class = 'land'
        ORDER BY b.id
        """,
        {"region": TOTTORI_REGION, "tolerance": args.tolerance},
    ).fetchall()

    features = []
    for oid, tottori, geom in rows:
        geometry = json.loads(geom)
        geometry["coordinates"] = round_coords(geometry["coordinates"])
        features.append(
            {
                "type": "Feature",
                "properties": {"overture_id": oid, "tottori": bool(tottori)},
                "geometry": geometry,
            }
        )
    collection = {
        "type": "FeatureCollection",
        "attribution": f"Overture Maps Foundation ({args.release})",
        "features": features,
    }

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(collection, ensure_ascii=False, separators=(",", ":")))
    n_tottori = sum(f["properties"]["tottori"] for f in features)
    print(f"{len(features)} borders ({n_tottori} touching Tottori) -> {args.out}")


def round_coords(coords):
    if isinstance(coords[0], (int, float)):
        return [round(c, 5) for c in coords]
    return [round_coords(c) for c in coords]


if __name__ == "__main__":
    main()
