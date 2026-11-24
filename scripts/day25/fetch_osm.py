"""Day 25: everything OpenStreetMap has around Komazawa Olympic Park (Overpass API), cached
as the raw Overpass JSON in scripts/.cache/day25/komazawa.json for build_park.py. `--force`
asks Overpass again.

    scripts/.venv/bin/python scripts/day25/fetch_osm.py [--force]
"""

import sys
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "scripts" / ".cache" / "day25" / "komazawa.json"
URL = "https://overpass-api.de/api/interpreter"
# south, west, north, east: the park with a few hundred metres round it
BBOX = (35.6170, 139.6530, 35.6340, 139.6720)


def main():
    if OUT.exists() and "--force" not in sys.argv:
        print(f"cached: {OUT}")
        return
    OUT.parent.mkdir(parents=True, exist_ok=True)
    q = f"[out:json][timeout:120];(nwr{BBOX};);out geom tags;".replace(" ", "")
    for attempt in range(4):
        r = requests.post(URL, data={"data": q}, headers={"User-Agent": "30DayMapChallenge-day25"}, timeout=300)
        if r.status_code == 200:
            break
        print(f"HTTP {r.status_code}, retrying")
        time.sleep(20 * (attempt + 1))
    r.raise_for_status()
    OUT.write_bytes(r.content)
    print(f"{len(r.json()['elements'])} elements, {len(r.content) / 1e6:.1f} MB → {OUT}")


if __name__ == "__main__":
    main()
