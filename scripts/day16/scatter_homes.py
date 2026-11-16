"""Day 16 (Collaborative map): where the Kobe Marathon's runners might come from.

An impression, not a survey. `hometowns.json` (next to this script) lists towns with how
many runners each gives (`count`) and how far around it they live (`spread`, km): mostly
Kobe, then the rest of Hyogo and Osaka, thinning out across Japan from Sapporo (read off
a T-shirt) to Naha, and a few from abroad. Each runner's home is scattered around its town
(a Gaussian) with a fixed seed, drawn again until it lands on land, by Day 1's
`land.geojson` (Japan from Overture, elsewhere Natural Earth), so nobody lives in the sea.

Writes `{"towns": [name, ...], "homes": [[lng, lat, town index], ...]}` to
`public/data/day16/homes.json`.

Usage:
    python scripts/day16/scatter_homes.py [--seed 1116] [--out DIR]
"""

import argparse
import json
import math
import random
from pathlib import Path

from shapely import STRtree
from shapely.geometry import Point, shape

ROOT = Path(__file__).resolve().parents[2]
HOMETOWNS = Path(__file__).with_name("hometowns.json")
LAND = ROOT / "public" / "data" / "day01" / "land.geojson"
DEFAULT_OUT = ROOT / "public" / "data" / "day16"
# Draws per runner before giving up on land and keeping the town itself
TRIES = 200


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--seed", type=int, default=1116)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()

    land = [shape(f["geometry"]) for f in json.loads(LAND.read_text())["features"]]
    tree = STRtree(land)

    def on_land(lng: float, lat: float) -> bool:
        p = Point(lng, lat)
        return any(land[i].contains(p) for i in tree.query(p))

    rng = random.Random(args.seed)
    homes = []
    towns = json.loads(HOMETOWNS.read_text())
    for t, town in enumerate(towns):
        lng0, lat0, spread = town["lng"], town["lat"], town["spread"]
        for _ in range(town["count"]):
            for _ in range(TRIES):
                # km to degrees
                lat = lat0 + rng.gauss(0, spread) / 111
                lng = lng0 + rng.gauss(0, spread) / (111 * math.cos(math.radians(lat0)))
                if on_land(lng, lat):
                    break
            else:
                print(f"{town['name']}: no land drawn, kept the town")
                lng, lat = lng0, lat0
            homes.append([round(lng, 5), round(lat, 5), t])

    args.out.mkdir(parents=True, exist_ok=True)
    out = args.out / "homes.json"
    out.write_text(json.dumps({"towns": [t["name"] for t in towns], "homes": homes}, separators=(",", ":")))
    print(f"{len(homes)} homes -> {out.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
