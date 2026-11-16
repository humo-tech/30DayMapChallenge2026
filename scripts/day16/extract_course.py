"""Day 16 (Collaborative map): the Kobe Marathon's course, from my watch's GPS track.

Reads a GPX file (Garmin Connect's export) and keeps only the shape of the course: no
times, heart rate, cadence or elevation. The track is simplified (Douglas-Peucker,
`--tolerance` m) and written as [lng, lat] pairs from the start (by Kobe City Hall) to
the finish (Meriken Park) to `public/data/day16/course.json`. The GPX itself stays out
of the repository.

Usage:
    python scripts/day16/extract_course.py activity.gpx [--tolerance 4] [--out DIR]
"""

import argparse
import json
import math
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT = ROOT / "public" / "data" / "day16"
GPX_NS = {"g": "http://www.topografix.com/GPX/1/1"}


def to_metres(points: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """Equirectangular around the track's mean latitude: plenty over a city."""
    lat0 = math.radians(sum(lat for _, lat in points) / len(points))
    k = 6_371_000 * math.pi / 180
    return [(lng * k * math.cos(lat0), lat * k) for lng, lat in points]


def simplify(xy: list[tuple[float, float]], tolerance: float) -> list[int]:
    """Douglas-Peucker; the indices kept. Iterative, as the track has ~15k points."""
    keep = {0, len(xy) - 1}
    stack = [(0, len(xy) - 1)]
    while stack:
        i, j = stack.pop()
        (ax, ay), (bx, by) = xy[i], xy[j]
        dx, dy = bx - ax, by - ay
        length = math.hypot(dx, dy)
        worst, at = 0.0, -1
        for k in range(i + 1, j):
            px, py = xy[k]
            if length == 0:
                dist = math.hypot(px - ax, py - ay)
            else:
                dist = abs(dy * (px - ax) - dx * (py - ay)) / length
            if dist > worst:
                worst, at = dist, k
        if worst > tolerance:
            keep.add(at)
            stack += [(i, at), (at, j)]
    return sorted(keep)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("gpx", type=Path)
    parser.add_argument("--tolerance", type=float, default=4.0, help="simplification tolerance (m)")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()

    track = ET.parse(args.gpx).getroot()
    points = [(float(p.get("lon")), float(p.get("lat"))) for p in track.iterfind(".//g:trkpt", GPX_NS)]
    kept = [points[i] for i in simplify(to_metres(points), args.tolerance)]

    args.out.mkdir(parents=True, exist_ok=True)
    out = args.out / "course.json"
    out.write_text(json.dumps([[round(lng, 6), round(lat, 6)] for lng, lat in kept], separators=(",", ":")))
    print(f"{len(points)} points -> {len(kept)} -> {out.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
