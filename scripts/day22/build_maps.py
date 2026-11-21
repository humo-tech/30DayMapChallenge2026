"""Day 22 (Projections): two "designer" maps, and the ties that pin them to the globe.

A designer's map is thinned and bent on purpose: coastlines smoothed, small islands
dropped, Tokyo blown up, Okinawa moved into a box, Greenland shrunk. No formula
gives you that map from latitude and longitude, so to put a pin on it the page fits
one (a thin-plate spline, per frame) to tie points: places the designer's map and
the real map share (where three borders meet, capes along the coast).

This script plays the designer. For each map it

1. loads real borders (Japan: Overture Maps prefectures cut to the coast of Day 1;
   world: Natural Earth 1:50m countries),
2. bends them ("deform", the designer's free hand, which the page never sees),
   thins them hard and rounds them off, and writes the result as plain SVG,
3. writes the ties, the real borders (for the page to know which prefecture /
   country a point is in, and to draw them over the art) and the pins (capitals).

Outputs, in public/data/day22/:

    japan.svg / world.svg     the art: one <path> per prefecture / country
    japan.json / world.json   frames + ties, real regions, pins

Usage:
    python scripts/day22/build_maps.py [--release 2026-10-21.0]

Natural Earth files are downloaded into scripts/day22/.cache the first time.
"""

import argparse
import json
import math
import urllib.request
from pathlib import Path

import duckdb
import numpy as np
import shapely
from shapely.geometry import LineString, MultiPolygon, Point, Polygon, shape
from shapely.ops import linemerge, polygonize, unary_union

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "public" / "data" / "day22"
CACHE = Path(__file__).resolve().parent / ".cache"
DAY01_LAND = ROOT / "public" / "data" / "day01" / "land.geojson"
NE_URL = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/{}.geojson"
DEFAULT_RELEASE = "2026-10-21.0"

# ---------------------------------------------------------------------------
# Base projections (the page has the same ones, in app/maps/lib/freehand.ts).
# Both give "degree-like" units; the ties take it from there.


def mercator(lng, lat, frame):
    lat = np.clip(lat, -85, 85)
    return np.asarray(lng, float), np.degrees(np.log(np.tan(np.pi / 4 + np.radians(lat) / 2)))


def natural_earth(lng, lat, frame):
    lam = np.asarray(lng, float) - frame["lng0"] + frame.get("shift", 0)
    if frame.get("wrap", True):
        lam = (lam + 180) % 360 - 180
    l, p = np.radians(lam), np.radians(lat)
    p2 = p * p
    p4 = p2 * p2
    x = l * (0.870700 - 0.131979 * p2 + p4 * (-0.013791 + p4 * (0.003971 * p2 - 0.001529 * p4)))
    y = p * (1.007226 + p2 * (0.015085 + p4 * (-0.044475 + 0.028874 * p2 - 0.005916 * p4)))
    return np.degrees(x), np.degrees(y)


BASES = {"mercator": mercator, "naturalEarth": natural_earth}

# ---------------------------------------------------------------------------
# The designer's free hand: moves in the base plane, never shown to the page


def bulge(x, y, cx, cy, r, a):
    """Blow up a disc: a times bigger at its centre, back to 1 at its rim (no folds for a < 1.25)."""
    dx, dy = x - cx, y - cy
    s = np.hypot(dx, dy) / r
    f = np.where(s < 1, 1 + a * (1 - s * s) ** 2, 1)
    return cx + dx * f, cy + dy * f


def similar(x, y, cx, cy, k, tx=0.0, ty=0.0):
    return cx + (x - cx) * k + tx, cy + (y - cy) * k + ty


def deform(frame, lng, lat):
    x, y = BASES[frame["base"]](np.asarray(lng, float), np.asarray(lat, float), frame)
    for op in frame["ops"]:
        x, y = op(x, y)
    return x, y


def inside_poly(lng, lat, ring):
    return Polygon(ring).contains(Point(lng, lat))


# ---------------------------------------------------------------------------
# Real data


def ne(name):
    CACHE.mkdir(parents=True, exist_ok=True)
    path = CACHE / f"{name}.geojson"
    if not path.exists():
        print(f"Downloading {name}...")
        urllib.request.urlretrieve(NE_URL.format(name), path)
    return json.loads(path.read_text())


def japan_regions(release):
    """47 prefectures: Overture's territorial area (or land, for the 8 with no coast) cut to Day 1's coast."""
    cached = CACHE / f"japan-{release}.json"
    if cached.exists():
        c = json.loads(cached.read_text())
        rows, capitals = [(a, b, bytes.fromhex(w)) for a, b, w in c["rows"]], c["capitals"]
    else:
        rows, capitals = query_japan(release)
        CACHE.mkdir(parents=True, exist_ok=True)
        cached.write_text(json.dumps({"rows": [(a, b, bytes(w).hex()) for a, b, w in rows], "capitals": capitals}))

    land = [shape(f["geometry"]) for f in json.loads(DAY01_LAND.read_text())["features"]]
    land = [g for g in land if g.bounds[0] > 122 and g.bounds[2] < 154.5 and g.bounds[1] > 20 and g.bounds[3] < 46]
    land = unary_union([shapely.make_valid(g) for g in land])

    areas = [shapely.make_valid(shapely.from_wkb(bytes(w))) for _, _, w in rows]
    areas = shapely.coverage_simplify(areas, 0.0005)
    regions = []
    for (code, name, _), area in zip(rows, areas):
        g = polygons_only(area.intersection(land))
        regions.append({"id": code, "name": name.replace(" Prefecture", ""), "geom": g})
    pins = [{"name": n, "lng": round(x, 4), "lat": round(y, 4), "region": code} for code, n, x, y in capitals]
    return regions, pins


def query_japan(release):
    base = f"s3://overturemaps-us-west-2/release/{release}/theme=divisions"
    con = duckdb.connect()
    con.sql("INSTALL spatial; LOAD spatial; INSTALL httpfs; LOAD httpfs; SET s3_region='us-west-2';")
    print("Loading Overture prefectures...")
    rows = con.sql(
        f"""
        SELECT region, any_value(names.common['en']) AS name,
               ST_AsWKB(coalesce(max(geometry) FILTER (class = 'maritime'), max(geometry) FILTER (class = 'land')))
        FROM read_parquet('{base}/type=division_area/*', hive_partitioning = 1)
        WHERE country = 'JP' AND subtype = 'region'
        GROUP BY region ORDER BY region
        """
    ).fetchall()
    capitals = con.sql(
        f"""
        WITH d AS (
            SELECT id, region, subtype, names.common['en'] AS en, capital_division_ids, geometry
            FROM read_parquet('{base}/type=division/*', hive_partitioning = 1)
            WHERE country = 'JP' AND subtype IN ('region', 'locality')
        )
        SELECT r.region, c.en, ST_X(c.geometry), ST_Y(c.geometry)
        FROM d r JOIN d c ON list_contains(r.capital_division_ids, c.id)
        WHERE r.subtype = 'region' AND c.subtype = 'locality'
        ORDER BY r.region
        """
    ).fetchall()
    return [tuple(r) for r in rows], [list(c) for c in capitals]


def world_regions():
    countries = ne("ne_50m_admin_0_countries")
    places = ne("ne_10m_populated_places_simple")
    regions = []
    for f in countries["features"]:
        p = f["properties"]
        regions.append(
            {
                "id": p["ADM0_A3"],
                "name": p["NAME"],
                "continent": p["CONTINENT"],
                "color": p["MAPCOLOR7"],
                "geom": polygons_only(shapely.make_valid(shape(f["geometry"]))),
            }
        )
    tree = shapely.STRtree([r["geom"] for r in regions])
    pins = []
    for f in places["features"]:
        p = f["properties"]
        if p["featurecla"] != "Admin-0 capital":
            continue
        pt = Point(p["longitude"], p["latitude"])
        hit = tree.query(pt, predicate="intersects")
        if len(hit) == 0:
            near = tree.nearest(pt)
            if regions[near]["geom"].distance(pt) > 0.3:
                continue
            hit = [near]
        pins.append({"name": p["name"], "lng": round(p["longitude"], 4), "lat": round(p["latitude"], 4), "region": regions[hit[0]]["id"]})
    return regions, pins


def polygons_only(g):
    parts = [p for p in getattr(g, "geoms", [g]) if isinstance(p, (Polygon, MultiPolygon))]
    polys = [q for p in parts for q in getattr(p, "geoms", [p])]
    return MultiPolygon(polys)


# ---------------------------------------------------------------------------
# The art


def chaikin(coords, closed, n=2):
    pts = np.asarray(coords, float)
    for _ in range(n):
        if closed:
            a, b = pts[:-1], np.roll(pts[:-1], -1, axis=0)
            q, r = 0.75 * a + 0.25 * b, 0.25 * a + 0.75 * b
            pts = np.empty((2 * len(a), 2))
            pts[0::2], pts[1::2] = q, r
            pts = np.vstack([pts, pts[:1]])
        else:
            a, b = pts[:-1], pts[1:]
            q, r = 0.75 * a + 0.25 * b, 0.25 * a + 0.75 * b
            mid = np.empty((2 * len(a), 2))
            mid[0::2], mid[1::2] = q, r
            pts = np.vstack([pts[:1], mid[1:-1], pts[-1:]])
    return pts


def frame_of(frames, lng, lat):
    """The frame a point falls in; None for the ones left off the map."""
    for i, f in enumerate(frames):
        if f.get("domain") is None or inside_poly(lng, lat, f["domain"]):
            return i if "base" in f else None
    return None


def to_art(regions, frames, size, margin, min_area, tolerance, micro_area):
    """Bend, scale to px, thin and round off. Returns the art per region plus what the ties need."""
    # 1. Each island to its frame, bent; islands in no frame are left off
    bent = []  # per region: list of (frame, Polygon in the bent base plane, real Polygon)
    for r in regions:
        parts = []
        for poly in r["geom"].geoms:
            rp = poly.representative_point()
            fi = frame_of(frames, rp.x, rp.y)
            if fi is None:
                continue
            f = frames[fi]

            def bend(ring):
                c = np.asarray(ring.coords)
                x, y = deform(f, c[:, 0], c[:, 1])
                return np.column_stack([x, y])

            q = Polygon(bend(poly.exterior), [bend(h) for h in poly.interiors])
            parts.append((fi, q, poly))
        bent.append(parts)

    # 2. To px: the bent map (and the inset boxes) fitted into `size` wide
    boxes = [f["box"] for f in frames if f.get("box")]
    allg = unary_union([q for parts in bent for _, q, _ in parts] + [shapely.box(*b) for b in boxes])
    x0, y0, x1, y1 = allg.bounds
    k = (size - 2 * margin) / (x1 - x0)
    width, height = size, round((y1 - y0) * k + 2 * margin)

    def px(x, y):
        return (np.asarray(x) - x0) * k + margin, (y1 - np.asarray(y)) * k + margin

    for f in frames:
        f["px"] = (x0, y1, k, margin)
        if f.get("box"):
            bx0, by0, bx1, by1 = f["box"]
            (ax0, ax1), (ay1, ay0) = px([bx0, bx1], [by0, by1])
            f["boxPx"] = [round(ax0, 1), round(ay0, 1), round(ax1 - ax0, 1), round(ay1 - ay0, 1)]

    def to_px_poly(q):
        def ring(c):
            c = np.asarray(c.coords)
            x, y = px(c[:, 0], c[:, 1])
            return np.column_stack([x, y])

        return Polygon(ring(q.exterior), [ring(h) for h in q.interiors])

    # 3. Drop specks; a region left with nothing big enough becomes a dot
    art_raw, micro = [], {}
    for r, parts in zip(regions, bent):
        polys = [(fi, shapely.make_valid(to_px_poly(q)), real) for fi, q, real in parts]
        polys = [(fi, p, real) for fi, p, real in polys if not p.is_empty]
        keep = [p for _, p, _ in polys if p.area >= min_area]
        if not keep and polys:
            big = max(polys, key=lambda t: t[1].area)
            if big[1].area < micro_area:
                c = big[1].representative_point()
                micro[r["id"]] = ((round(c.x, 1), round(c.y, 1)), big[2].representative_point())
                art_raw.append(MultiPolygon())
                continue
            keep = [big[1]]
        art_raw.append(polygons_only(unary_union(keep)) if keep else MultiPolygon())

    # 4. Thin (shared borders stay shared) and round off, arc by arc so neighbours still meet
    simple = shapely.coverage_simplify(art_raw, tolerance)
    lines = unary_union([g.boundary for g in simple if not g.is_empty])
    arcs = linemerge(lines)
    arcs = list(getattr(arcs, "geoms", [arcs]))
    smooth = [LineString(chaikin(a.coords, a.is_ring)) for a in arcs]
    faces = list(polygonize(unary_union(smooth)))
    tree = shapely.STRtree(simple)
    art = [[] for _ in regions]
    for face in faces:
        if face.area < 0.5:
            continue
        # The region it overlaps most (rounding off moves edges, so a single point inside can miss)
        hit = [(simple[i].intersection(face).area, i) for i in tree.query(face, predicate="intersects")]
        if hit and max(hit)[0] > 0.5 * face.area:
            art[max(hit)[1]].append(face)
    art = [polygons_only(unary_union(a)) if a else MultiPolygon() for a in art]

    nodes = set()
    for a in arcs:
        if not a.is_ring:
            nodes.add(tuple(np.round(a.coords[0], 3)))
            nodes.add(tuple(np.round(a.coords[-1], 3)))
    return {"art": art, "simple": simple, "micro": micro, "bent": bent, "px": px, "width": width, "height": height, "nodes": nodes}


def build_ties(regions, frames, res, spacing):
    """Ties: (real lng/lat, art px). Corners where borders meet, then points along every edge."""
    px = res["px"]
    ties = [[] for _ in frames]
    # Real vertices with where the free hand put them, per region and frame
    real_pts = []
    for r, parts in zip(regions, res["bent"]):
        for fi, q, real in parts:
            c = np.vstack([np.asarray(real.exterior.coords)] + [np.asarray(h.coords) for h in real.interiors])
            x, y = deform(frames[fi], c[:, 0], c[:, 1])
            X, Y = px(x, y)
            real_pts.append((r["id"], fi, c, np.column_stack([X, Y])))

    def nearest_real(region_id, p):
        best = None
        for rid, fi, ll, xy in real_pts:
            if rid != region_id:
                continue
            d = np.hypot(xy[:, 0] - p[0], xy[:, 1] - p[1])
            i = int(np.argmin(d))
            if best is None or d[i] < best[0]:
                best = (d[i], fi, ll[i])
        return best

    taken = [[] for _ in frames]

    def add(fi, ll, p):
        for q in taken[fi]:
            if math.hypot(q[0] - p[0], q[1] - p[1]) < spacing:
                return
        taken[fi].append(p)
        ties[fi].append([round(float(ll[0]), 5), round(float(ll[1]), 5), round(float(p[0]), 2), round(float(p[1]), 2)])

    # Nodes first (they come out exact), then samples along the rounded-off edges
    ids = [r["id"] for r in regions]
    for node in sorted(res["nodes"]):
        for i, g in enumerate(res["simple"]):
            if not g.is_empty and g.distance(Point(node)) < 1e-6:
                b = nearest_real(ids[i], node)
                if b and b[0] < 2:
                    add(b[1], b[2], node)
                break
    for i, g in enumerate(res["art"]):
        for poly in g.geoms:
            for ring in [poly.exterior, *poly.interiors]:
                n = max(3, int(ring.length / spacing))
                for t in np.linspace(0, ring.length, n, endpoint=False):
                    p = ring.interpolate(t)
                    b = nearest_real(ids[i], (p.x, p.y))
                    if b:
                        add(b[1], b[2], (p.x, p.y))
    for xy, c in res["micro"].values():
        fi = frame_of(frames, c.x, c.y)
        if fi is not None:
            add(fi, (c.x, c.y), xy)
    return ties


# ---------------------------------------------------------------------------
# A thin-plate spline, to check the ties (the page fits its own)


def tps_fit(src, dst, lam):
    n = len(src)
    mean, scale = src.mean(0), src.std() or 1
    s = (src - mean) / scale
    d2 = ((s[:, None] - s[None]) ** 2).sum(-1)
    K = np.where(d2 > 0, 0.5 * d2 * np.log(d2 + 1e-300), 0) + lam * np.eye(n)
    P = np.hstack([np.ones((n, 1)), s])
    A = np.zeros((n + 3, n + 3))
    A[:n, :n], A[:n, n:], A[n:, :n] = K, P, P.T
    b = np.zeros((n + 3, 2))
    b[:n] = dst
    return mean, scale, s, np.linalg.solve(A, b)


def tps_eval(m, pts):
    mean, scale, s, w = m
    q = (pts - mean) / scale
    d2 = ((q[:, None] - s[None]) ** 2).sum(-1)
    U = np.where(d2 > 0, 0.5 * d2 * np.log(d2 + 1e-300), 0)
    return U @ w[:-3] + w[-3] + q[:, :1] * w[-2] + q[:, 1:] * w[-1]


def check(name, frames, ties, pins, res, regions, lam):
    models = []
    for f, t in zip(frames, ties):
        if not t:
            models.append(None)
            continue
        t = np.asarray(t)
        x, y = BASES[f["base"]](t[:, 0], t[:, 1], f)
        models.append(tps_fit(np.column_stack([x, y]), t[:, 2:], lam))
    art = {r["id"]: g for r, g in zip(regions, res["art"])}
    errs, outside = [], []
    for p in pins:
        fi = frame_of(frames, p["lng"], p["lat"])
        if fi is None:
            continue
        f = frames[fi]
        bx, by = BASES[f["base"]](np.array([p["lng"]]), np.array([p["lat"]]), f)
        q = tps_eval(models[fi], np.column_stack([bx, by]))[0]
        x, y = deform(f, p["lng"], p["lat"])
        X, Y = res["px"](x, y)
        errs.append(math.hypot(q[0] - X, q[1] - Y))
        if errs[-1] > 3:
            print(f"  {p['name']} ({frames[fi]['name']}): {errs[-1]:.1f} px off")
        g = art.get(p["region"])
        if g is not None and not g.is_empty and not g.contains(Point(q)):
            outside.append((p["name"], round(g.distance(Point(q)), 1)))
    print(f"{name}: ties per frame {[len(t) for t in ties]}; pins vs the free hand: "
          f"median {np.median(errs):.2f} px, max {max(errs):.2f} px; outside their region: {len(outside)} {outside[:12]}")


# ---------------------------------------------------------------------------
# Output


def svg_path(g):
    out = []
    for poly in g.geoms:
        for ring in [poly.exterior, *poly.interiors]:
            c = np.asarray(ring.coords)[:-1]
            out.append("M" + "L".join(f"{x:.1f} {y:.1f}" for x, y in c) + "Z")
    return "".join(out)


def mix(hex_color, white):
    c = [int(hex_color[i : i + 2], 16) for i in (1, 3, 5)]
    return "#" + "".join(f"{round(v + (255 - v) * white):02x}" for v in c)


def write_svg(path, res, regions, frames, colors, title, sea):
    w, h = res["width"], res["height"]
    out = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}">',
        f"<title>{title}</title>",
        "<defs>"
        '<filter id="art-shadow" x="-5%" y="-5%" width="110%" height="110%">'
        '<feDropShadow dx="0" dy="2.5" stdDeviation="2" flood-color="#284b63" flood-opacity="0.28"/>'
        "</filter></defs>",
        f'<rect id="sea" width="{w}" height="{h}" fill="{sea}"/>',
    ]
    for f in frames:
        if f.get("boxPx"):
            x, y, bw, bh = f["boxPx"]
            out.append(
                f'<rect class="inset" x="{x}" y="{y}" width="{bw}" height="{bh}" rx="14" '
                f'fill="{mix(sea, 0.25)}" stroke="#ffffff" stroke-width="2" stroke-dasharray="6 5"/>'
            )
    out.append('<g id="land" filter="url(#art-shadow)" stroke="#ffffff" stroke-width="1.4" stroke-linejoin="round">')
    for r, g in zip(regions, res["art"]):
        if not g.is_empty:
            out.append(f'<path id="{r["id"]}" fill="{colors[r["id"]]}" d="{svg_path(g)}"/>')
    for rid, ((x, y), _) in res["micro"].items():
        out.append(f'<circle id="{rid}" cx="{x}" cy="{y}" r="3.2" fill="{colors[rid]}"/>')
    out.append("</g></svg>")
    path.write_text("\n".join(out))


def encode_rings(g, q):
    """Rings as [x0, y0, dx, dy, ...] in units of 1/q degree."""
    rings = []
    for poly in polygons_only(g).geoms:
        for ring in [poly.exterior, *poly.interiors]:
            c = np.round(np.asarray(ring.coords)[:-1] * q).astype(int)
            d = np.vstack([c[:1], np.diff(c, axis=0)])
            d = d[np.any(d != 0, axis=1) | (np.arange(len(d)) == 0)]
            if len(d) >= 3:
                rings.append(d.ravel().tolist())
    return rings


def frame_json(f, ties):
    keys = ("name", "base", "lng0", "shift", "wrap", "domain", "boxPx")
    out = {k: f[k] for k in keys if f.get(k) is not None}
    if "base" in f:
        out["ties"] = ties
    else:
        out["off"] = True  # what falls in here is left off the map
    return out


def write_json(path, res, regions, frames, ties, pins, q, lam, real_tol):
    data = {
        "width": res["width"],
        "height": res["height"],
        "lambda": lam,
        "frames": [frame_json(f, t) for f, t in zip(frames, ties)],
        "quantum": q,
        "regions": [
            {"id": r["id"], "name": r["name"], "rings": encode_rings(r["geom"].simplify(real_tol), q)} for r in regions
        ],
        "pins": pins,
    }
    path.write_text(json.dumps(data, separators=(",", ":"), ensure_ascii=False))


# ---------------------------------------------------------------------------
# The two maps

JAPAN_COLORS = {  # by region of Japan (chiho)
    "hokkaido": "#9fd4b6", "tohoku": "#c4e29c", "kanto": "#f7c294", "chubu": "#f6dc8c",
    "kinki": "#f3a3a4", "chugoku": "#c3b3e6", "shikoku": "#a9c2f0", "kyushu": "#f0b0d0",
}
CHIHO = ["hokkaido"] + ["tohoku"] * 6 + ["kanto"] * 7 + ["chubu"] * 9 + ["kinki"] * 7 + ["chugoku"] * 5 + ["shikoku"] * 4 + ["kyushu"] * 8

WORLD_COLORS = {
    "Asia": "#f7c294", "Europe": "#c3b3e6", "Africa": "#f6dc8c", "North America": "#9fd4b6",
    "South America": "#f3a3a4", "Oceania": "#f0b0d0", "Seven seas (open ocean)": "#f0b0d0", "Antarctica": "#e8eef0",
}


def shade(regions, base_of):
    """Neighbours apart: each region a step lighter than any neighbour already coloured."""
    tree = shapely.STRtree([r["geom"] for r in regions])
    steps, colors = {}, {}
    for i, r in enumerate(regions):
        near = {steps.get(regions[j]["id"]) for j in tree.query(r["geom"].buffer(0.01), predicate="intersects") if j != i}
        s = next(s for s in range(8) if s not in near)
        steps[r["id"]] = s
        colors[r["id"]] = mix(base_of(i, r), [0, 0.3, 0.55, 0.15, 0.42, 0.65, 0.07, 0.5][s])
    return colors


def inset(regions, frames, fi, lo, hi, kmax, pad=0.22):
    """Move the islands of frame fi into a box (lo, hi in the base plane), at most kmax times bigger."""
    xs, ys = [], []
    for r in regions:
        for poly in r["geom"].geoms:
            if frame_of(frames, *poly.representative_point().coords[0]) == fi:
                x, y = mercator(*np.asarray(poly.exterior.coords).T, None)
                xs += list(x)
                ys += list(y)
    (bx0, by0), (bx1, by1) = lo, hi
    k = min(kmax, (bx1 - bx0 - 2 * pad) / (max(xs) - min(xs)), (by1 - by0 - 2 * pad) / (max(ys) - min(ys)))
    cx, cy = (max(xs) + min(xs)) / 2, (max(ys) + min(ys)) / 2
    frames[fi]["ops"] = [lambda x, y: similar(x, y, cx, cy, k, (bx0 + bx1) / 2 - cx, (by0 + by1) / 2 - cy)]
    frames[fi]["box"] = (float(bx0), float(by0), float(bx1), float(by1))
    print(f"{frames[fi]['name']} inset at {k:.2f}x")


def build_japan(release):
    regions, pins = japan_regions(release)
    m = lambda lng, lat: mercator(np.array(lng), np.array(lat), None)
    tok, osa = m(139.72, 35.72), m(135.55, 34.75)
    hak = m(140.9, 41.6)
    main = {
        "name": "main", "base": "mercator",
        "ops": [lambda x, y: bulge(x, y, *tok, 1.7, 1.15), lambda x, y: bulge(x, y, *osa, 1.3, 0.7)],
    }
    # Above a line through the Tsugaru Strait
    hokkaido = {
        "name": "hokkaido", "base": "mercator",
        "domain": [[138.0, 41.3], [140.5, 41.3], [141.0, 41.62], [147.5, 41.62], [147.5, 46.5], [138.0, 46.5]],
        "ops": [lambda x, y: similar(x, y, *hak, 0.86)],
    }
    # Okinawa, and Miyako and Yaeyama, blown up in two boxes; the Amami and Tokara Islands stay where they are
    okinawa = {"name": "okinawa", "base": "mercator", "domain": [[126.0, 25.9], [128.6, 25.9], [128.6, 27.2], [126.0, 27.2]]}
    sakishima = {"name": "sakishima", "base": "mercator", "domain": [[122.5, 23.8], [125.7, 23.8], [125.7, 25.1], [122.5, 25.1]]}
    # The rest of the south (Senkaku, Daito), Miyakejima and further south (Izu, Ogasawara): off the map
    none = {
        "name": "none",
        "domain": [[122, 20], [155, 20], [155, 34.2], [138.8, 34.2], [138.8, 29.4], [130.6, 29.4], [130.6, 27.2],
                   [128.3, 27.2], [128.3, 29.4], [122, 29.4]],
    }
    frames = [hokkaido, okinawa, sakishima, none, main]
    inset(regions, frames, 1, m(124.5, 24.2), m(128.15, 27.35), 2.4)
    inset(regions, frames, 2, m(130.4, 25.7), m(135.6, 27.95), 2.0)

    for r in regions:  # check the domains split the right islands
        for poly in r["geom"].geoms:
            c = np.asarray(poly.exterior.coords)
            fs = {frame_of(frames, x, y) for x, y in c[:: max(1, len(c) // 50)]}
            if len(fs) > 1:
                print(f"  ! {r['id']} island across frames {fs}")

    res = to_art(regions, frames, size=1000, margin=24, min_area=10, tolerance=2.2, micro_area=0)
    ties = build_ties(regions, frames, res, spacing=13)
    lam = 1e-4
    check("japan", frames, ties, pins, res, regions, lam)
    colors = shade(regions, lambda i, r: JAPAN_COLORS[CHIHO[i]])
    write_svg(OUT / "japan.svg", res, regions, frames, colors, "Japan, by a designer's free hand", "#cfe4ea")
    write_json(OUT / "japan.json", res, regions, frames, ties, pins, 10_000, lam, 0.0008)
    return res


def build_world():
    regions, pins = world_regions()
    lng0 = 150.0
    main = {"name": "main", "base": "naturalEarth", "lng0": lng0, "wrap": True}
    ne_ = lambda lng, lat: natural_earth(np.array(lng), np.array(lat), main)
    jp, eu = ne_(137.5, 36.5), ne_(12.0, 50.0)
    sg = ne_(103.8, 1.35)
    main["ops"] = [
        lambda x, y: bulge(x, y, *jp, 13, 1.0),
        lambda x, y: bulge(x, y, *eu, 19, 0.55),
        lambda x, y: bulge(x, y, *sg, 6, 0.6),
    ]
    # Greenland across the cut at 30°W: all of it on the Americas' side, shrunk towards Nares Strait
    greenland = {
        "name": "greenland", "base": "naturalEarth", "lng0": lng0, "shift": 360, "wrap": False,
        "domain": [[-57, 59], [-58.5, 64], [-60, 67], [-63, 70], [-66, 74], [-72, 76.5], [-74, 78], [-69, 80],
                   [-64.5, 81.5], [-60.9, 82.3], [-60.0, 84], [-10, 84], [-10, 63], [-40, 57.5]],
    }
    gx, gy = natural_earth(np.array(-66.0), np.array(79.0), greenland)
    greenland["ops"] = [lambda x, y: similar(x, y, gx, gy, 0.72)]
    none = {"name": "none", "domain": [[-180, -90], [180, -90], [180, -60], [-180, -60]]}
    frames = [greenland, none, main]
    regions = [r for r in regions if r["id"] not in ("ATA", "SGS")]

    for r in regions:
        for poly in r["geom"].geoms:
            c = np.asarray(poly.exterior.coords)
            fi = frame_of(frames, *poly.representative_point().coords[0])
            if fi is None:
                continue
            fs = {frame_of(frames, x, y) for x, y in c}
            lam = (c[:, 0] - lng0 + 180) % 360 - 180
            if len(fs) > 1 or (fi == 2 and lam.max() - lam.min() > 180):
                bad = [(x, y) for x, y in c if frame_of(frames, x, y) != fi][:3]
                print(f"  ! {r['id']} island across frames {fs} / the cut, e.g. {bad}")

    res = to_art(regions, frames, size=1600, margin=20, min_area=14, tolerance=1.6, micro_area=40)
    ties = build_ties(regions, frames, res, spacing=14)
    lam = 1e-4
    check("world", frames, ties, pins, res, regions, lam)
    colors = shade(regions, lambda i, r: WORLD_COLORS[r["continent"]])
    write_svg(OUT / "world.svg", res, regions, frames, colors, "The world, by a designer's free hand", "#cfe4ea")
    write_json(OUT / "world.json", res, regions, frames, ties, pins, 1000, lam, 0.01)
    return res


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--release", default=DEFAULT_RELEASE)
    ap.add_argument("--only", choices=["japan", "world"])
    a = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    if a.only != "world":
        build_japan(a.release)
    if a.only != "japan":
        build_world()
    for p in sorted(OUT.iterdir()):
        print(f"{p.name}: {p.stat().st_size / 1024:.0f} KB")


if __name__ == "__main__":
    main()
