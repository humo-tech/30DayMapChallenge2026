"""Day 1 (Points): build global land polygons and coastlines.

- Japan:     Overture Maps `base/land` (subtype `land`, classes `land` / `islet`),
             clipped to Japan's territorial area from Overture `divisions`.
             The land data is cut into 1-degree tiles, so the tiles are
             unioned first; otherwise the coastline would show the tile grid.
- Elsewhere: Natural Earth 1:50m Admin 0 Countries (Japan excluded). Download
             and unzip it beforehand:
             https://www.naturalearthdata.com/http//www.naturalearthdata.com/download/50m/cultural/ne_50m_admin_0_countries.zip

Writes two GeoJSON files:

- land.geojson      Polygons (for a fill)
- coastline.geojson LineStrings of the coast only (no national borders and no
                    antimeridian / south-pole cut lines)

Usage:
    python scripts/day01/extract_coastline.py --ne PATH/TO/ne_50m_admin_0_countries
        [--release 2026-10-21.0] [--tolerance 0.002] [--out-dir DIR]
"""

import argparse
import json
from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT_DIR = ROOT / "public" / "data" / "day01"
DEFAULT_RELEASE = "2026-10-21.0"
NE_SHP = "ne_50m_admin_0_countries.shp"
# Covers every Japanese island, Okinotorishima to Minamitorishima
JAPAN_BBOX = dict(xmin=122.0, xmax=154.5, ymin=20.0, ymax=46.0)
MIN_AREA = 1e-6  # deg², ~0.01 km²; drops rocks and specks before the union


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--ne",
        type=Path,
        required=True,
        help=f"unzipped Natural Earth directory containing {NE_SHP} (or the .shp itself)",
    )
    parser.add_argument("--release", default=DEFAULT_RELEASE)
    parser.add_argument(
        "--tolerance",
        type=float,
        default=0.002,
        help="simplification tolerance for Japan in degrees (~200 m at 0.002)",
    )
    parser.add_argument("--out-dir", type=Path, default=DEFAULT_OUT_DIR)
    args = parser.parse_args()

    ne_shp = args.ne / NE_SHP if args.ne.is_dir() else args.ne
    if not ne_shp.exists():
        parser.error(f"{ne_shp} not found")
    base = f"s3://overturemaps-us-west-2/release/{args.release}"

    con = duckdb.connect()
    con.sql("INSTALL spatial; LOAD spatial; INSTALL httpfs; LOAD httpfs;")
    con.sql("SET s3_region = 'us-west-2';")

    print("Fetching and unioning Overture land tiles for Japan (takes a few minutes)...")
    con.execute(
        f"""
        CREATE TABLE japan AS
        WITH territory AS (
            SELECT geometry AS geom
            FROM read_parquet('{base}/theme=divisions/type=division_area/*', hive_partitioning = 1)
            WHERE country = 'JP' AND subtype = 'country' AND class = 'maritime'
        ),
        land AS (
            SELECT ST_Union_Agg(ST_MakeValid(geometry)) AS geom
            FROM read_parquet('{base}/theme=base/type=land/*', hive_partitioning = 1)
            WHERE subtype = 'land' AND class IN ('land', 'islet')
              AND bbox.xmax > $xmin AND bbox.xmin < $xmax
              AND bbox.ymax > $ymin AND bbox.ymin < $ymax
              AND ST_Area(geometry) > $min_area
        )
        SELECT ST_GeomFromWKB(ST_AsWKB(ST_SimplifyPreserveTopology(
            ST_Intersection(land.geom, territory.geom), $tolerance
        ))) AS geom
        FROM land, territory
        """,
        {**JAPAN_BBOX, "min_area": MIN_AREA, "tolerance": args.tolerance},
    )

    # Both sources are WGS84 lon/lat but tag it differently (OGC:CRS84 vs
    # EPSG:4326), which DuckDB refuses to mix; the WKB round trips drop the tag.
    print("Loading Natural Earth countries...")
    con.sql(
        f"""
        CREATE TABLE world AS
        SELECT ST_GeomFromWKB(ST_AsWKB(ST_Union_Agg(ST_MakeValid(geom)))) AS geom
        FROM ST_Read('{ne_shp}')
        WHERE ADM0_A3 <> 'JPN'
        """
    )

    # NE splits polygons at the antimeridian and closes Antarctica along
    # lat -90; those cut lines are not coast, so erase them from the outline.
    cuts = (
        "ST_Buffer(ST_GeomFromText("
        "'MULTILINESTRING((180 -90, 180 90), (-180 -90, -180 90), (-180 -90, 180 -90))'"
        "), 1e-6)"
    )
    outputs = {
        "land.geojson": "SELECT geom FROM japan UNION ALL SELECT geom FROM world",
        "coastline.geojson": f"""
            SELECT ST_Boundary(geom) AS geom FROM japan
            UNION ALL
            SELECT ST_Difference(ST_Boundary(geom), {cuts}) FROM world
        """,
    }

    args.out_dir.mkdir(parents=True, exist_ok=True)
    for name, query in outputs.items():
        rows = con.sql(
            f"""
            SELECT ST_AsGeoJSON(d.geom)
            FROM (SELECT unnest(ST_Dump(geom)) AS d FROM ({query}))
            WHERE NOT ST_IsEmpty(d.geom)
            """
        ).fetchall()
        features = []
        for (geom,) in rows:
            geometry = json.loads(geom)
            geometry["coordinates"] = round_coords(geometry["coordinates"])
            features.append({"type": "Feature", "properties": {}, "geometry": geometry})
        collection = {
            "type": "FeatureCollection",
            "attribution": f"Overture Maps Foundation ({args.release}); Natural Earth",
            "features": features,
        }
        out = args.out_dir / name
        out.write_text(json.dumps(collection, separators=(",", ":")))
        print(f"{len(features)} features -> {out}")


def round_coords(coords):
    if isinstance(coords[0], (int, float)):
        return [round(c, 4) for c in coords]
    return [round_coords(c) for c in coords]


if __name__ == "__main__":
    main()
