"""Day 25: Komazawa Olympic Park as a plan for a wooden toy, from the OpenStreetMap cache
(fetch_osm.py) → public/data/day25/park.json.

Everything is in metres on a local plane round the middle of the park (x east, y north;
equirectangular, fine over a kilometre), rounded to 0.1 m:

- the park's outline,
- areas: pitches (with their sport), the stadium and its field, the playgrounds, the dog run,
  the paddling pool, gardens, lawns, woods, the plaza, the grand stairs, car parks, ...
- buildings with a height (the tower 40 m, the gymnasium, the indoor arena, the small ones),
- paths with a kind (jogging, cycling, family course, footway, service road, steps),
- the jogging, cycling and family courses as closed loops (for the runners and riders),
- trees: OSM has hardly any, so they are planted here: densely in the woods, sparsely on the
  lawns, and between the paths everywhere else, each with a kind for the seasons (cherry,
  zelkova, ginkgo, maple, evergreen).

    scripts/.venv/bin/python scripts/day25/build_park.py
"""

import json
import math
from pathlib import Path

import numpy as np
import shapely
import shapely.affinity
from shapely.geometry import LineString, MultiPolygon, Point, Polygon
from shapely.ops import linemerge, unary_union

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "scripts" / ".cache" / "day25" / "komazawa.json"
OUT = ROOT / "public" / "data" / "day25" / "park.json"

PARK = 27620248
# The middle of the park: the origin of the plane
LNG0, LAT0 = 139.6609, 35.6252
MX = 111_320 * math.cos(math.radians(LAT0))
MY = 110_950

# Path widths (m) by kind, for the trees to keep off them
WIDTH = {"jog": 5, "cycle": 4, "family": 3, "footway": 3, "path": 2, "pedestrian": 6, "service": 5, "steps": 4, "cycleway": 3}
# How wide each kind of path is drawn on the toy (m): wider than life, so they read from afar
DRAWN = {"jog": 6.5, "cycle": 5.5, "family": 4.5, "walk": 4.0}
# A 400 m track: the straights, the inside radius and the eight lanes (m)
TRACK = (84.39, 36.5, 9.8)
# Tree spacing (m) by where they grow
SPACING = {"wood": 8.0, "lawn": 32.0, "rest": 12.5}
SEED = 25


def xy(lng, lat):
    return ((lng - LNG0) * MX, (lat - LAT0) * MY)


def to_plan(e):
    return [xy(p["lon"], p["lat"]) for p in e["geometry"]]


def r1(v):
    return round(v, 1)


def ring(coords):
    return [[r1(x), r1(y)] for x, y in coords]


def polys(g):
    if g.is_empty:
        return []
    if isinstance(g, Polygon):
        return [g]
    if isinstance(g, MultiPolygon):
        return list(g.geoms)
    return [p for p in getattr(g, "geoms", []) if isinstance(p, Polygon)]


def poly_out(p):
    return [ring(p.exterior.coords)] + [ring(i.coords) for i in p.interiors]


def area_kind(t):
    """What an area is in the toy, from its tags (None: not drawn)"""
    lei = t.get("leisure")
    if lei == "pitch":
        return "pitch"
    if lei == "stadium":
        return "stadium"
    if lei in ("playground", "dog_park", "garden", "bird_hide", "swimming_pool", "bleachers"):
        return lei
    if lei == "water_park":
        return "pool"
    if lei == "track":
        return "cycletrack"
    if lei == "sports_centre" and not t.get("building"):
        return "pitch"
    if t.get("landuse") == "grass":
        return "lawn"
    if t.get("landuse") == "forest" or t.get("natural") == "wood":
        return "wood"
    if t.get("place") == "square":
        return "plaza"
    if t.get("area:highway") == "steps":
        return "stairs"
    if t.get("amenity") == "parking":
        return "parking"
    return None


def path_kind(t):
    name = t.get("name", "")
    if "ジョギング" in name:
        return "jog"
    if "ファミリー" in name:
        return "family"
    if "サイクリング" in name:
        return "cycle"
    hw = t.get("highway")
    if hw in ("footway", "path", "pedestrian", "service", "steps", "cycleway"):
        return hw
    return None


def loop(lines):
    """The longest closed ring the course's ways make (nodes snapped to 0.5 m)"""
    merged = shapely.set_precision(unary_union(lines), 0.5)
    if merged.geom_type == "MultiLineString":
        merged = linemerge(merged)
    parts = list(getattr(merged, "geoms", [merged]))
    rings = [p for p in parts if p.is_ring]
    if rings:
        return max(rings, key=lambda r: r.length)
    # Not quite closed: close the longest
    best = max(parts, key=lambda r: r.length)
    return LineString(list(best.coords) + [best.coords[0]])


def scatter(region, spacing, rng):
    """Jittered grid over `region`, thinned so no two are closer than 0.75 × spacing"""
    if region.is_empty:
        return []
    x0, y0, x1, y1 = region.bounds
    xs = np.arange(x0, x1, spacing)
    ys = np.arange(y0, y1, spacing * 0.87)
    pts = []
    for j, y in enumerate(ys):
        for x in xs:
            px = x + (spacing / 2 if j % 2 else 0) + rng.normal(0, spacing * 0.28)
            py = y + rng.normal(0, spacing * 0.28)
            pts.append((px, py))
    pts = np.array(pts)
    inside = shapely.contains_xy(region, pts[:, 0], pts[:, 1])
    pts = pts[inside]
    keep = []
    cell = {}
    min_d = spacing * 0.75
    for p in pts[rng.permutation(len(pts))]:
        cx, cy = int(p[0] // min_d), int(p[1] // min_d)
        ok = True
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for q in cell.get((cx + dx, cy + dy), []):
                    if (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 < min_d**2:
                        ok = False
        if ok:
            keep.append(p)
            cell.setdefault((cx, cy), []).append(p)
    return keep


def main():
    data = json.loads(SRC.read_text())
    ways = {e["id"]: e for e in data["elements"] if e["type"] == "way" and "geometry" in e}
    park = Polygon(to_plan(ways[PARK])).buffer(0)
    inner = park.buffer(1)

    areas, buildings, paths = [], [], []
    jog, cyc, fam = [], [], []
    tree_rows, osm_trees = [], []
    for e in ways.values():
        if e["id"] == PARK:
            continue
        t = e.get("tags", {})
        coords = to_plan(e)
        if len(coords) < 2:
            continue
        line = LineString(coords)
        closed = coords[0] == coords[-1] and len(coords) > 3
        # Kirin-san Parking (Giraffe Parking) runs a little past the park's edge: cut it to the park
        if t.get("name") == "きりんさんパーキング" and closed:
            coords = list(Polygon(coords).intersection(park).exterior.coords)
        elif not inner.contains(line):
            continue
        if t.get("building") or t.get("man_made") == "tower":
            if not closed:
                continue
            name = t.get("name", "")
            if t.get("man_made") == "tower":
                kind, h = "tower", float(t.get("height", 40))
            elif name == "駒沢体育館":
                kind, h = "gym", 18
            elif name == "屋内球技場":
                kind, h = "arena", 14
            elif t.get("building") == "roof":
                kind, h = "roof", 9
            else:
                kind, h = "house", 6
            p = Polygon(coords).buffer(0)
            if p.area < 8:
                continue
            buildings.append({"kind": kind, "name": name, "h": h, "ring": ring(p.exterior.coords)})
            continue
        if t.get("natural") == "tree_row":
            tree_rows.append(line)
            continue
        k = area_kind(t)
        if k and closed:
            p = Polygon(coords).buffer(0)
            item = {"kind": k, "rings": poly_out(p)}
            if t.get("sport"):
                item["sport"] = t["sport"].split(";")[0]
            if t.get("name"):
                item["name"] = t["name"]
            # The soccer pitch inside the stadium is its field
            if k == "pitch" and park.contains(p) and Polygon(to_plan(ways[229538469])).contains(p.centroid):
                item["kind"] = "field"
            areas.append((p.area, item, p))
            continue
        pk = path_kind(t)
        if pk:
            paths.append({"kind": pk, "line": ring(line.coords)})
            if pk == "jog":
                jog.append(line)
            elif pk == "cycle":
                cyc.append(line)
            elif pk == "family":
                fam.append(line)
    for e in data["elements"]:
        if e["type"] == "node" and e.get("tags", {}).get("natural") == "tree":
            p = Point(xy(e["lon"], e["lat"]))
            if park.contains(p):
                osm_trees.append(p)

    # Big areas first, so smaller ones draw over them
    areas.sort(key=lambda a: -a[0])

    # Where trees may not grow: paths, pitches, buildings, the plaza, water...
    blocked = []
    for p in paths:
        blocked.append(LineString(p["line"]).buffer(WIDTH.get(p["kind"], 3) / 2 + 2.5))
    for _, item, poly in areas:
        if item["kind"] not in ("wood", "lawn", "bird_hide"):
            blocked.append(poly.buffer(2.5))
    for b in buildings:
        blocked.append(Polygon(b["ring"]).buffer(4))
    blocked = unary_union(blocked)
    ground = park.buffer(-3).difference(blocked)
    woods = unary_union([poly for _, it, poly in areas if it["kind"] in ("wood", "bird_hide")])
    lawns = unary_union([poly for _, it, poly in areas if it["kind"] == "lawn"])

    rng = np.random.default_rng(SEED)
    pts = []
    for zone, region in (
        ("wood", ground.intersection(woods)),
        ("lawn", ground.intersection(lawns).difference(woods)),
        ("rest", ground.difference(woods).difference(lawns)),
    ):
        pts += [(p, zone) for p in scatter(region, SPACING[zone], rng)]
    for row in tree_rows:
        n = max(2, int(row.length // 9))
        pts += [(np.array(row.interpolate(i / (n - 1), normalized=True).coords[0]), "row") for i in range(n)]
    pts += [(np.array(p.coords[0]), "osm") for p in osm_trees]

    # Kinds: cherries along the jogging course, ginkgo in the rows, the rest mixed
    jog_loop = loop(jog)
    cyc_loop = loop(cyc)
    fam_loop = loop(fam)
    trees = []
    for p, zone in pts:
        near_jog = jog_loop.distance(Point(p)) < 16
        u = rng.random()
        if zone == "row":
            kind = "ginkgo"
        elif near_jog and u < 0.5:
            kind = "cherry"
        elif zone == "wood":
            kind = "evergreen" if u < 0.45 else "zelkova" if u < 0.8 else "maple"
        else:
            kind = "zelkova" if u < 0.35 else "evergreen" if u < 0.6 else "cherry" if u < 0.72 else "maple" if u < 0.86 else "ginkgo"
        size = float(np.clip(rng.normal(1.0, 0.16), 0.65, 1.4)) * (0.8 if zone == "lawn" else 1.0)
        trees.append([r1(p[0]), r1(p[1]), kind, round(size, 2)])

    # The paths as surfaces, one per kind (the courses drawn over the footways)
    surfaces = {}
    for kind in ("walk", "family", "cycle", "jog"):
        lines = [LineString(p["line"]) for p in paths if (p["kind"] if p["kind"] in DRAWN else "walk") == kind]
        g = unary_union([l.buffer(DRAWN[kind] / 2, quad_segs=4) for l in lines]).intersection(park.buffer(-1))
        surfaces[kind] = [poly_out(q) for q in polys(g.simplify(0.3)) if q.area > 4]

    # The stadium: a 400 m track round its football pitch, and the stands the rest of it
    stadium_poly = Polygon(to_plan(ways[229538469])).buffer(0)
    field = next(poly for _, it, poly in areas if it["kind"] == "field")
    rect = list(field.minimum_rotated_rectangle.exterior.coords)
    (ax, ay), (bx, by), (cx2, cy2) = rect[0], rect[1], rect[2]
    long_side = (bx - ax, by - ay) if math.dist(rect[0], rect[1]) > math.dist(rect[1], rect[2]) else (cx2 - bx, cy2 - by)
    angle = math.atan2(long_side[1], long_side[0])
    c = field.centroid
    straight, radius, lanes = TRACK
    track_outer = shapely.affinity.rotate(
        shapely.affinity.translate(LineString([(-straight / 2, 0), (straight / 2, 0)]).buffer(radius + lanes, quad_segs=24), c.x, c.y),
        angle, origin=(c.x, c.y), use_radians=True,
    )
    stands = stadium_poly.difference(track_outer.buffer(5))
    stadium = {
        "center": [r1(c.x), r1(c.y)],
        "angle": round(angle, 4),
        "track": list(TRACK),
        "stands": [poly_out(q) for q in polys(stands.simplify(0.5)) if q.area > 20],
    }
    areas = [a for a in areas if a[1]["kind"] not in ("stadium", "field", "bleachers")]

    # White lines on the pitches: a border just inside, and on the football pitches (no sport,
    # or soccer) a halfway line and a centre circle
    lines = []
    for _, it, poly in areas:
        if it["kind"] != "pitch" or poly.area < 300:
            continue
        inner = poly.buffer(-2.5, join_style="mitre")
        if inner.is_empty:
            continue
        marks = [inner.difference(inner.buffer(-0.7, join_style="mitre"))]
        if it.get("sport") in (None, "soccer"):
            r = list(inner.minimum_rotated_rectangle.exterior.coords)
            a, b, c2, d2 = r[0], r[1], r[2], r[3]
            if math.dist(a, b) > math.dist(b, c2):
                half = LineString([((a[0] + b[0]) / 2, (a[1] + b[1]) / 2), ((c2[0] + d2[0]) / 2, (c2[1] + d2[1]) / 2)])
            else:
                half = LineString([((b[0] + c2[0]) / 2, (b[1] + c2[1]) / 2), ((d2[0] + a[0]) / 2, (d2[1] + a[1]) / 2)])
            mid = half.interpolate(0.5, normalized=True)
            marks.append(half.buffer(0.35, cap_style="flat"))
            marks.append(mid.buffer(9.5).exterior.buffer(0.35))
        lines += [poly_out(q) for q in polys(unary_union(marks).intersection(inner).simplify(0.1))]

    out = {
        "center": [LNG0, LAT0],
        "park": poly_out(park),
        "areas": [it for _, it, _ in areas],
        "buildings": buildings,
        "paths": paths,
        "surfaces": surfaces,
        "lines": lines,
        "stadium": stadium,
        "loops": {"jog": ring(jog_loop.coords), "cycle": ring(cyc_loop.coords), "family": ring(fam_loop.coords)},
        "trees": trees,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    kinds = {}
    for t in trees:
        kinds[t[2]] = kinds.get(t[2], 0) + 1
    print(f"park {park.area / 1e4:.1f} ha, {len(out['areas'])} areas, {len(buildings)} buildings, {len(paths)} paths")
    print(f"jogging loop {jog_loop.length:.0f} m, cycling loop {cyc_loop.length:.0f} m, family course {fam_loop.length:.0f} m")
    print(f"{len(trees)} trees {kinds}")
    print(f"{OUT.stat().st_size / 1e3:.0f} KB → {OUT}")


if __name__ == "__main__":
    main()
