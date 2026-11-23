"""Day 24 (Network): which HELLO CYCLING station to which, guessed from how full they were.

The GBFS feed has no trips, only each station's counts every 5 minutes. A ride shows up as
one bike fewer in some dock and, a while later, one more in another; this pairs them up.

1. Occupancy: bikes in docks, i.e. minus `num_docks_available` (a step in it is a bike
   leaving or arriving). `num_bikes_available` is not used: about a quarter of its steps
   come with no change in the docks (a bike reserved, or out of service, while it stays put).
2. Events: every step between snapshots in a JST day, at stations in a box round the area
   (wider than the map, so rides crossing its edge still find their other end).
3. Candidate rides: a bike that left and one that arrived, if the ride fits between the
   snapshots: at most 20 km/h, at least 8 km/h plus 20 minutes of dawdling, within 8 km
   (straight line x 1.25). Stations within 200 m are one place; a bike back to its own place
   (a round trip, or a flicker in the counts) is allowed but not drawn. A bike may also stay
   unpaired (a truck, a ride out of the box, a dock that miscounted).
   Each candidate's cost is a negative log-likelihood: its length on a lognormal, its minutes
   on a normal round the time at a typical speed.
4. Two ways to pair them, both giving expected bikes per candidate:
   - ensemble: the transport problem (min-cost flow, an LP; its vertex solution is whole
     bikes) solved again and again with the typical length, its spread and the typical
     speed drawn at random, and averaged (Monte Carlo over the assumptions);
   - gravity: the doubly constrained gravity model (Wilson's entropy maximising trip
     distribution), i.e. entropy-regularised optimal transport with exp(-cost) as the
     deterrence, solved by Sinkhorn's scaling; being unpaired is one more choice for each
     bike, of fixed weight.

Output: scripts/.cache/day24/flows_<area>_<date>_<method>.json (the stations, and expected
bikes per place pair per half hour of leaving), and a preview image next to it.

Usage:
    python scripts/day24/infer_flows.py makuhari 2026-10-19 [--method ensemble|gravity|both]

The day's snapshots (two UTC folders per JST day) are synced into scripts/.cache/day24/status
the first time. S3 credentials come from the usual AWS credential chain.
"""

import argparse
import json
import subprocess
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import duckdb
import numpy as np
from PIL import Image, ImageDraw
from scipy.optimize import linprog
from scipy.sparse import coo_matrix, csr_matrix

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / "scripts" / ".cache" / "day24"
S3 = "s3://humo-tech-data/hellocycling/gbfs"

# centre (lat, lon), half-width of the matching box and of the preview, km
AREAS = {
    "makuhari": (35.648, 140.042, 6.0, 3.5),
    "asaka": (35.800, 139.590, 6.0, 4.0),
    "nakano": (35.700, 139.660, 5.0, 3.0),
}

DETOUR = 1.25  # ride length / straight line
V_MAX = 20.0  # km/h
V_MIN = 8.0  # km/h, plus DAWDLE
DAWDLE = 20.0  # min
MAX_KM = 8.0
STEP = 5.0  # min between snapshots
CLUSTER_KM = 0.2  # stations this close (several at one station square) count as one place
# the assumptions: typical ride length (median, log spread) and speed
RIDE_KM = 2.0
RIDE_SIGMA = 0.7
V_TYPICAL = 12.0  # km/h
# and how far the ensemble draws them
ENSEMBLE_RUNS = 40
RIDE_KM_RANGE = (1.2, 3.0)
RIDE_SIGMA_RANGE = (0.5, 0.9)
V_TYPICAL_RANGE = (9.0, 15.0)
UNPAIRED = 3.5  # per bike left unpaired, each side
SELF = 3.0  # a bike back to its own place
BIN = 30  # min, for the output


def sync_status(utc_day: date) -> Path:
    out = CACHE / "status" / utc_day.isoformat()
    if not out.exists() or len(list(out.glob("*.parquet"))) < 280:
        out.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            ["aws", "s3", "sync", f"{S3}/station_status/{utc_day.isoformat()}/", str(out), "--quiet"],
            check=True,
        )
    return out


def station_info(day: date) -> Path:
    """The weekly station_information snapshot on or before the day."""
    out = CACHE / f"info_{day.isoformat()}.parquet"
    if not out.exists():
        for back in range(0, 15):
            d = (day - timedelta(days=back)).isoformat()
            ls = subprocess.run(
                ["aws", "s3", "ls", f"{S3}/station_information/{d}/"], capture_output=True, text=True
            ).stdout.split()
            files = sorted(f for f in ls if f.endswith(".parquet"))
            if files:
                subprocess.run(
                    ["aws", "s3", "cp", f"{S3}/station_information/{d}/{files[-1]}", str(out), "--quiet"],
                    check=True,
                )
                break
        else:
            raise SystemExit(f"no station_information within two weeks before {day}")
    return out


def haversine_km(lat1, lon1, lat2, lon2):
    p1, p2 = np.radians(lat1), np.radians(lat2)
    a = np.sin((p2 - p1) / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(np.radians(lon2 - lon1) / 2) ** 2
    return 6371.0 * 2 * np.arcsin(np.sqrt(a))


def load_events(day: date, lat0: float, lon0: float, half_km: float):
    folders = [sync_status(day - timedelta(days=1)), sync_status(day)]
    info = station_info(day)
    dlat = half_km / 111.0
    dlon = half_km / (111.0 * np.cos(np.radians(lat0)))
    start = datetime(day.year, day.month, day.day, tzinfo=timezone(timedelta(hours=9)))

    con = duckdb.connect()
    stations = con.execute(
        """
        SELECT station_id, name, lat, lon, try_cast(vehicle_capacity AS INTEGER) AS cap
        FROM read_parquet($info)
        WHERE lat BETWEEN $la0 AND $la1 AND lon BETWEEN $lo0 AND $lo1
        ORDER BY station_id
        """,
        {"info": str(info), "la0": lat0 - dlat, "la1": lat0 + dlat, "lo0": lon0 - dlon, "lo1": lon0 + dlon},
    ).fetchall()
    ids = [s[0] for s in stations]
    con.execute("CREATE TABLE st AS SELECT unnest($ids) AS station_id", {"ids": ids})

    globs = [str(f / "*.parquet") for f in folders]
    # minutes since JST midnight; keep the last snapshot before it for the first step
    events = con.execute(
        """
        WITH s AS (
            SELECT station_id,
                   date_diff('second', $start::timestamptz,
                       strptime(regexp_extract(filename, '(\\d{14})\\.parquet', 1), '%Y%m%d%H%M%S')::timestamp
                       AT TIME ZONE 'UTC') / 60.0 AS t,
                   -num_docks_available AS o
            FROM read_parquet($globs, filename = true)
            WHERE station_id IN (SELECT station_id FROM st)
        ), d AS (
            SELECT station_id, t, o - lag(o) OVER w AS dd, t - lag(t) OVER w AS gap
            FROM s WHERE t > -10 AND t < 1440
            WINDOW w AS (PARTITION BY station_id ORDER BY t)
        )
        SELECT station_id, t, dd::INTEGER, gap FROM d WHERE dd <> 0 AND t >= 0 ORDER BY t
        """,
        {"start": start.isoformat(), "globs": globs},
    ).fetchall()
    return stations, events


def places(lat, lon):
    """Union stations within CLUSTER_KM of each other."""
    n = len(lat)
    parent = list(range(n))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i in range(n):
        near = np.nonzero(haversine_km(lat[i], lon[i], lat, lon) < CLUSTER_KM)[0]
        for j in near:
            parent[find(j)] = find(i)
    return np.array([find(i) for i in range(n)])



def candidates(stations, events):
    index = {s[0]: i for i, s in enumerate(stations)}
    lat = np.array([s[2] for s in stations])
    lon = np.array([s[3] for s in stations])
    place = places(lat, lon)

    dep = np.array([(index[sid], t, -dd) for sid, t, dd, _ in events if dd < 0])
    arr = np.array([(index[sid], t, dd) for sid, t, dd, _ in events if dd > 0])
    d_st, d_t, d_n = dep[:, 0].astype(int), dep[:, 1], dep[:, 2]
    a_st, a_t, a_n = arr[:, 0].astype(int), arr[:, 1], arr[:, 2]

    rows, cols = [], []
    a_order = np.argsort(a_t, kind="stable")
    a_ts = a_t[a_order]
    max_lag = MAX_KM / V_MIN * 60 + DAWDLE + STEP
    for k in range(len(d_t)):
        lo, hi = np.searchsorted(a_ts, [d_t[k], d_t[k] + max_lag], side="left")
        cand = a_order[lo:hi]
        lag = a_t[cand] - d_t[k]
        km = haversine_km(lat[d_st[k]], lon[d_st[k]], lat[a_st[cand]], lon[a_st[cand]]) * DETOUR
        same = place[a_st[cand]] == place[d_st[k]]
        ok = same | (
            (km <= MAX_KM) & (km / V_MAX * 60 <= lag + STEP) & (lag - STEP <= km / V_MIN * 60 + DAWDLE)
        )
        rows.extend([k] * int(ok.sum()))
        cols.extend(cand[ok])
    rows, cols = np.array(rows), np.array(cols)
    km = haversine_km(lat[d_st[rows]], lon[d_st[rows]], lat[a_st[cols]], lon[a_st[cols]]) * DETOUR
    return {
        "place": place,
        "d_st": d_st, "d_t": d_t, "d_n": d_n,
        "a_st": a_st, "a_t": a_t, "a_n": a_n,
        "rows": rows, "cols": cols, "km": km, "lag": a_t[cols] - d_t[rows],
        "same": place[a_st[cols]] == place[d_st[rows]],
    }


def cost(c, ride_km=RIDE_KM, sigma=RIDE_SIGMA, v=V_TYPICAL):
    mu = np.log(ride_km)
    lk = np.log(np.maximum(c["km"], 0.05))
    # minus its minimum (at exp(mu - sigma^2)), so the likeliest length costs 0
    length = lk + (lk - mu) ** 2 / (2 * sigma**2) - (mu - sigma**2 / 2)
    expect = c["km"] / v * 60
    spread = STEP + 0.3 * expect
    timing = (c["lag"] - expect) ** 2 / (2 * spread**2)
    return np.where(c["same"], SELF, length + timing)


def solve_lp(c, w):
    n_arc, n_dep, n_arr = len(w), len(c["d_n"]), len(c["a_n"])
    arc = np.arange(n_arc)
    A = coo_matrix(
        (
            np.ones(2 * n_arc + n_dep + n_arr),
            (
                np.concatenate([c["rows"], n_dep + c["cols"], np.arange(n_dep), n_dep + np.arange(n_arr)]),
                np.concatenate([arc, arc, n_arc + np.arange(n_dep), n_arc + n_dep + np.arange(n_arr)]),
            ),
        ),
        shape=(n_dep + n_arr, n_arc + n_dep + n_arr),
    ).tocsr()
    obj = np.concatenate([w, np.full(n_dep + n_arr, UNPAIRED)])
    res = linprog(obj, A_eq=A, b_eq=np.concatenate([c["d_n"], c["a_n"]]), bounds=(0, None), method="highs-ds")
    if res.status != 0:
        raise SystemExit(res.message)
    return np.rint(res.x[:n_arc])


def solve_ensemble(c, seed=24):
    rng = np.random.default_rng(seed)
    total = np.zeros(len(c["rows"]))
    for _ in range(ENSEMBLE_RUNS):
        w = cost(
            c,
            ride_km=np.exp(rng.uniform(*np.log(RIDE_KM_RANGE))),
            sigma=rng.uniform(*RIDE_SIGMA_RANGE),
            v=rng.uniform(*V_TYPICAL_RANGE),
        )
        total += solve_lp(c, w)
    return total / ENSEMBLE_RUNS


def solve_gravity(c, iters=5000, tol=1e-6):
    """Sinkhorn on exp(-cost) as the deterrence. Being unpaired is one more choice for every
    bike, of fixed weight exp(-UNPAIRED) and with no total of its own to meet."""
    a, b = c["d_n"], c["a_n"]
    K = csr_matrix((np.exp(-cost(c)), (c["rows"], c["cols"])), shape=(len(a), len(b)))
    KT = K.T.tocsr()
    ku = np.exp(-UNPAIRED)
    u, v = np.ones(len(a)), np.ones(len(b))
    for it in range(iters):
        u = a / (K @ v + ku)
        v = b / (KT @ u + ku)
        if it % 50 == 0 and np.abs(u * (K @ v + ku) - a).sum() / a.sum() < tol:
            break
    rows = np.repeat(np.arange(len(a)), np.diff(K.indptr))
    return K.data * u[rows] * v[K.indices], (rows, K.indices)


def to_flows(c, x, order=None):
    """Expected bikes per place pair per BIN of leaving; own-place returns kept apart."""
    rows, cols = (c["rows"], c["cols"]) if order is None else order
    out, own = {}, 0.0
    for r, col, n in zip(rows, cols, x):
        if n <= 1e-4:
            continue
        i, j = int(c["d_st"][r]), int(c["a_st"][col])
        if c["place"][i] == c["place"][j]:
            own += n
            continue
        key = (i, j, int(c["d_t"][r] // BIN))
        out[key] = out.get(key, 0.0) + n
    flows = [{"from": i, "to": j, "bin": t, "n": round(n, 3)} for (i, j, t), n in sorted(out.items())]
    return flows, own


def preview(path: Path, stations, flows, lat0, lon0, half_km, hours, label):
    """Panels by time of day: lines from blue (left) to orange (arrived), by expected bikes."""
    size, pad = 700, 10
    kx = size / (2 * half_km / (111.0 * np.cos(np.radians(lat0))))
    ky = size / (2 * half_km / 111.0)

    def xy(i):
        return ((stations[i][3] - lon0) * kx + size / 2, (lat0 - stations[i][2]) * ky + size / 2)

    panels = []
    for h0, h1 in hours:
        img = Image.new("RGB", (size, size), (16, 18, 24))
        over = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        dr = ImageDraw.Draw(over)
        for i in range(len(stations)):
            x, y = xy(i)
            dr.ellipse([x - 1.5, y - 1.5, x + 1.5, y + 1.5], fill=(120, 120, 130, 255))
        od = {}
        for f in flows:
            if h0 * 60 <= f["bin"] * BIN < h1 * 60:
                od[(f["from"], f["to"])] = od.get((f["from"], f["to"]), 0) + f["n"]
        for (i, j), n in sorted(od.items(), key=lambda e: e[1]):
            (x0, y0), (x1, y1) = xy(i), xy(j)
            seg = 12
            for s in range(seg):
                u0, u1 = s / seg, (s + 1) / seg
                col = tuple(int(p + (q - p) * (u0 + u1) / 2) for p, q in zip((70, 150, 255), (255, 150, 60)))
                dr.line(
                    [(x0 + (x1 - x0) * u0, y0 + (y1 - y0) * u0), (x0 + (x1 - x0) * u1, y0 + (y1 - y0) * u1)],
                    fill=col + (int(min(255, 255 * min(1.0, n * 0.5))),),
                    width=max(1, int(round(np.sqrt(n) * 1.5))),
                )
        img.paste(over, (0, 0), over)
        ImageDraw.Draw(img).text((8, 8), f"{label}  {h0:02d}-{h1:02d}h  {sum(od.values()):.0f} bikes", fill=(220, 220, 220))
        panels.append(img)
    out = Image.new("RGB", (len(panels) * (size + pad) - pad, size), (0, 0, 0))
    for i, p in enumerate(panels):
        out.paste(p, (i * (size + pad), 0))
    out.save(path)


def report(stations, c, flows, own, label):
    moved = sum(f["n"] for f in flows)
    left = c["d_n"].sum()
    lat = np.array([s[2] for s in stations])
    lon = np.array([s[3] for s in stations])
    km = np.array([haversine_km(lat[f["from"]], lon[f["from"]], lat[f["to"]], lon[f["to"]]) * DETOUR for f in flows])
    w = np.array([f["n"] for f in flows])
    order = np.argsort(km)
    cum = np.cumsum(w[order]) / w.sum()
    q = [km[order][np.searchsorted(cum, p)] for p in (0.25, 0.5, 0.75)]
    print(f"[{label}] left {left:.0f}: paired {moved:.0f} ({moved / left:.0%}), own place {own:.0f}, "
          f"unpaired {left - moved - own:.0f};  ride km p25/50/75 {np.round(q, 2)}")
    od = {}
    for f in flows:
        od[(f["from"], f["to"])] = od.get((f["from"], f["to"]), 0) + f["n"]
    for (i, j), n in sorted(od.items(), key=lambda e: -e[1])[:8]:
        print(f"   {n:5.1f}  {stations[i][1]} -> {stations[j][1]}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("area", choices=AREAS)
    parser.add_argument("day", type=date.fromisoformat, help="JST day, e.g. 2026-10-19")
    parser.add_argument("--method", choices=["ensemble", "gravity", "both"], default="both")
    args = parser.parse_args()

    lat0, lon0, half_km, view_km = AREAS[args.area]
    stations, events = load_events(args.day, lat0, lon0, half_km)
    c = candidates(stations, events)
    print(f"{len(stations)} stations, {len(events)} steps, {len(c['rows'])} candidate rides")

    methods = ["ensemble", "gravity"] if args.method == "both" else [args.method]
    CACHE.mkdir(parents=True, exist_ok=True)
    for m in methods:
        if m == "ensemble":
            flows, own = to_flows(c, solve_ensemble(c))
        else:
            x, order = solve_gravity(c)
            flows, own = to_flows(c, x, order)
        stem = f"flows_{args.area}_{args.day.isoformat()}_{m}"
        (CACHE / f"{stem}.json").write_text(
            json.dumps(
                {
                    "stations": [{"id": s[0], "name": s[1], "lat": s[2], "lon": s[3], "cap": s[4]} for s in stations],
                    "bin_minutes": BIN,
                    "flows": flows,
                },
                ensure_ascii=False,
                separators=(",", ":"),
            )
        )
        label = f"{args.area} {args.day} {m}"
        preview(CACHE / f"{stem}.png", stations, flows, lat0, lon0, view_km, [(5, 10), (10, 17), (17, 21), (21, 24)], label)
        report(stations, c, flows, own, label)


if __name__ == "__main__":
    main()
