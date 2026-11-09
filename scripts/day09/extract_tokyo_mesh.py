"""Day 9 (Urban-rural): Tokyo by night and by day, on the 1 km grid.

Covers mainland Tokyo (the islands are left out). Both populations come from
MLIT's people-flow open data (全国の人流オープンデータ, 1 km grid, from Agoop's
mobile phone location data), for weekdays (dayflag 1) in the latest month the
data has:

- night: people present 01:00-04:00 (timezone 1);
- day: people present 11:00-14:00 (timezone 0).

Cells are written compactly as their south-west corner and the two
populations; the map builds the squares.

Usage:
    python scripts/day09/extract_tokyo_mesh.py [--month 2021-12]
"""

import argparse
import csv
import io
import json
import re
import urllib.request
import zipfile
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / "scripts" / ".cache" / "day09"
OUT_DIR = ROOT / "public" / "data" / "day09"

# Prefecture code -> resource id of monthly_mdp_mesh1km_<code> in
# https://www.geospatial.jp/ckan/dataset/mlit-1km-fromto
PREFECTURES = {
    "13": "3b69ffab-2fb8-4901-9cf3-9da2c19e3351",  # Tokyo
}
FLOW_URL = "https://www.geospatial.jp/ckan/dataset/8fd79f08-00e6-4d14-9c89-e3bdca66af11/resource/{id}/download/monthly_mdp_mesh1km_{code}.zip"
WEEKDAY = "1"
DAYTIME, NIGHT = "0", "1"
# Ōshima-machi (13361) and on are the Izu and Ogasawara islands
FIRST_ISLAND_CITY = 13360


def fetch(code: str) -> Path:
    path = CACHE / f"monthly_mdp_mesh1km_{code}.zip"
    if not path.exists():
        url = FLOW_URL.format(id=PREFECTURES[code], code=code)
        print(f"downloading {url}")
        CACHE.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(url) as res:
            path.write_bytes(res.read())
    return path


def months_of(path: Path, code: str) -> set[str]:
    """The months ("YYYY-MM") a prefecture's file has."""
    with zipfile.ZipFile(path) as z:
        found = (re.fullmatch(rf"{code}/(\d{{4}})/(\d{{2}})/monthly_mdp_mesh1km\.csv\.zip", n) for n in z.namelist())
        return {f"{m[1]}-{m[2]}" for m in found if m}


def read_month(path: Path, code: str, month: str, cells: dict[str, list[int]]) -> None:
    """Adds the prefecture's weekday [night, day] populations for the month to `cells`."""
    year, mm = month.split("-")
    with zipfile.ZipFile(path) as outer:
        with zipfile.ZipFile(io.BytesIO(outer.read(f"{code}/{year}/{mm}/monthly_mdp_mesh1km.csv.zip"))) as inner:
            (csv_name,) = inner.namelist()
            text = inner.read(csv_name).decode("utf-8-sig")
    for r in csv.DictReader(io.StringIO(text)):
        if r["dayflag"] != WEEKDAY or r["timezone"] not in (NIGHT, DAYTIME):
            continue
        if code == "13" and int(r["citycode"]) >= FIRST_ISLAND_CITY:
            continue
        # A cell left out at one time (too few people) counts as 0 there
        cells[r["mesh1kmid"]][0 if r["timezone"] == NIGHT else 1] = int(r["population"])


def cell_corner(code: str) -> tuple[float, float]:
    """(west, south) of an 8-digit standard (1 km) mesh code."""
    p, q = int(code[0:2]), int(code[2:4])
    s1, s2 = int(code[4]), int(code[5])
    t1, t2 = int(code[6]), int(code[7])
    return q + 100 + s2 * 7.5 / 60 + t2 * 45 / 3600, p / 1.5 + s1 * 5 / 60 + t1 * 30 / 3600


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--month", help="YYYY-MM (default: the latest every prefecture has)")
    args = parser.parse_args()

    paths = {code: fetch(code) for code in PREFECTURES}
    month = args.month or max(set.intersection(*(months_of(p, c) for c, p in paths.items())))

    populations: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    for code, path in paths.items():
        read_month(path, code, month, populations)

    cells = []
    for code in sorted(populations):
        night, day = populations[code]
        w, s = cell_corner(code)
        cells.append([round(w, 6), round(s, 6), night, day])

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "tokyo_mesh.json").write_text(
        json.dumps(
            {
                "attribution": f"MLIT people-flow open data (Agoop), weekdays in {month}",
                # Cell size in degrees (lng, lat), and the columns of each cell
                "cell": [45 / 3600, 30 / 3600],
                "columns": ["west", "south", "night (01-04)", "day (11-14)"],
                "cells": cells,
            },
            separators=(",", ":"),
        )
    )

    total_night = sum(c[2] for c in cells)
    total_day = sum(c[3] for c in cells)
    top = max(cells, key=lambda c: c[3])
    print(f"{month}: {len(cells)} cells, night {total_night:,}, day {total_day:,}; busiest by day {top} -> {OUT_DIR}")


if __name__ == "__main__":
    main()
