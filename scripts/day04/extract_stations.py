"""Day 4 (Cluster): HELLO CYCLING stations from their GBFS station_information.

Reads the latest snapshot of the GBFS feed (stored as Parquet on S3) and writes
one Point per station with its capacity (`vehicle_capacity`, a string in GBFS
here, cast to an integer). The map clusters them in the browser, so nothing
else is kept: the file stays small.

S3 credentials come from the usual AWS credential chain (env, ~/.aws, SSO).

Usage:
    python scripts/day04/extract_stations.py [--src S3_URL] [--out PATH]
"""

import argparse
import json
from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT = ROOT / "public" / "data" / "day04" / "stations.geojson"
DEFAULT_SRC = "s3://humo-tech-data/hellocycling/gbfs/station_information/latest/latest.parquet"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--src", default=DEFAULT_SRC)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()

    con = duckdb.connect()
    con.sql("INSTALL httpfs; LOAD httpfs;")
    con.sql("CREATE SECRET (TYPE s3, PROVIDER credential_chain);")

    rows = con.execute(
        """
        SELECT lon, lat, coalesce(try_cast(vehicle_capacity AS INTEGER), 0) AS capacity
        FROM read_parquet($src)
        WHERE lon IS NOT NULL AND lat IS NOT NULL
        ORDER BY try_cast(station_id AS BIGINT), station_id
        """,
        {"src": args.src},
    ).fetchall()

    features = [
        {
            "type": "Feature",
            "properties": {"capacity": capacity},
            # ~1 m precision
            "geometry": {"type": "Point", "coordinates": [round(lon, 5), round(lat, 5)]},
        }
        for lon, lat, capacity in rows
    ]
    collection = {"type": "FeatureCollection", "features": features}

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(collection, separators=(",", ":")))
    total = sum(f["properties"]["capacity"] for f in features)
    print(f"{len(features)} stations, capacity {total} -> {args.out}")


if __name__ == "__main__":
    main()
