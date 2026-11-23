"""Day 24 (Network): the guessed rides, packed for the map.

Reads what infer_flows.py left in scripts/.cache/day24 for each day and method, keeps the
flows with an end in the map's box, sums them by hour of leaving, drops the faintest (under
MIN_BIKES expected bikes: the gravity model spreads a little over a great many pairs) and
writes them as fixed-size records:

    uint16 from, uint16 to (station indices), uint8 hour (JST), uint8 0,
    uint16 expected bikes x 1000                                    (little-endian, 8 bytes)

And how full each of those stations was through each day, from the 5-minute snapshots (the
last one in each 5 minutes, carried forward): bikes in docks, i.e. its capacity less its free
docks, as uint8 per station per 5 minutes (288 a row, a row per station).

Output: public/data/day24/<area>.json (the stations in use, [lng, lat], their capacities, and
per day and method its file and totals), public/data/day24/<area>_<day>_<method>.bin and
public/data/day24/<area>_<day>_docked.bin

Usage:
    python scripts/day24/export_flows.py makuhari 2026-10-19 2026-10-26
"""

import argparse
import json
import math
import struct
from datetime import date, timedelta
from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / "scripts" / ".cache" / "day24"
OUT = ROOT / "public" / "data" / "day24"

# centre (lat, lon) and half-width (km) of the map's box
VIEW = {
    "makuhari": (35.648, 140.042, 4.0),
    "asaka": (35.800, 139.590, 4.5),
    "nakano": (35.700, 139.660, 3.5),
}
METHODS = ("ensemble", "gravity")
MIN_BIKES = 0.005


def docked_bytes(day: date, stations: dict[str, int], caps: list[int]) -> bytes:
    """Bikes in docks per station per 5 minutes of the JST day, uint8, a row per station."""
    folders = [CACHE / "status" / (day - timedelta(days=1)).isoformat(), CACHE / "status" / day.isoformat()]
    con = duckdb.connect()
    con.execute("CREATE TABLE st AS SELECT unnest($ids) AS station_id, unnest($idx) AS i", {"ids": list(stations), "idx": list(stations.values())})
    rows = con.execute(
        """
        WITH s AS (
            SELECT station_id, num_docks_available AS free,
                   date_diff('minute', $start::timestamp,
                       strptime(regexp_extract(filename, '(\\d{14})\\.parquet', 1), '%Y%m%d%H%M%S')) AS m
            FROM read_parquet($globs, filename = true)
            WHERE station_id IN (SELECT station_id FROM st)
        )
        SELECT i, m // 5 AS k, arg_max(free, m) FROM s JOIN st USING (station_id)
        WHERE m >= 0 AND m < 1440 GROUP BY ALL
        """,
        {"start": f"{day - timedelta(days=1)} 15:00:00", "globs": [str(f / "*.parquet") for f in folders]},
    ).fetchall()
    grid = [[None] * 288 for _ in caps]
    for i, k, free in rows:
        grid[i][k] = free
    out = bytearray()
    for i, row in enumerate(grid):
        last = next((f for f in row if f is not None), caps[i])
        for f in row:
            last = last if f is None else f
            out.append(max(0, min(255, caps[i] - last)))
    return bytes(out)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("area", choices=VIEW)
    parser.add_argument("days", nargs="+")
    args = parser.parse_args()

    lat0, lon0, half = VIEW[args.area]
    kx = 111.0 * math.cos(math.radians(lat0))

    def inside(s):
        return abs(s["lat"] - lat0) * 111.0 < half and abs(s["lon"] - lon0) * kx < half

    stations: dict[str, int] = {}  # station id -> index in the output
    coords: list[list[float]] = []
    caps: list[int] = []
    runs = {}
    OUT.mkdir(parents=True, exist_ok=True)
    for day in args.days:
        for method in METHODS:
            src = CACHE / f"flows_{args.area}_{day}_{method}.json"
            if not src.exists():
                print(f"{src.name}: not there yet, skipped")
                continue
            data = json.loads(src.read_text())
            st = data["stations"]
            per_hour = 60 // data["bin_minutes"]
            hourly: dict[tuple[str, str, int], float] = {}
            for f in data["flows"]:
                a, b = st[f["from"]], st[f["to"]]
                if not (inside(a) or inside(b)):
                    continue
                key = (a["id"], b["id"], f["bin"] // per_hour)
                hourly[key] = hourly.get(key, 0.0) + f["n"]
                for s in (a, b):
                    if s["id"] not in stations:
                        stations[s["id"]] = len(coords)
                        coords.append([round(s["lon"], 5), round(s["lat"], 5)])
                        caps.append(int(s["cap"] or 0))
            total = sum(hourly.values())
            kept = sorted((k, n) for k, n in hourly.items() if n >= MIN_BIKES)
            name = f"{args.area}_{day}_{method}.bin"
            with open(OUT / name, "wb") as out:
                for (a, b, hour), n in kept:
                    out.write(struct.pack("<HHBBH", stations[a], stations[b], hour, 0, min(65535, round(n * 1000))))
            runs[f"{day}_{method}"] = {"file": name, "flows": len(kept), "bikes": round(total, 1)}
            print(f"{name}: {len(kept)} flows, {sum(n for _, n in kept):.0f} of {total:.0f} bikes")

    docked = {}
    for day in args.days:
        name = f"{args.area}_{day}_docked.bin"
        (OUT / name).write_bytes(docked_bytes(date.fromisoformat(day), stations, caps))
        docked[day] = name

    (OUT / f"{args.area}.json").write_text(
        json.dumps(
            {"center": [lon0, lat0], "stations": coords, "capacity": caps, "runs": runs, "docked": docked},
            separators=(",", ":"),
        )
    )
    print(f"{len(coords)} stations -> {OUT / f'{args.area}.json'}")


if __name__ == "__main__":
    main()
