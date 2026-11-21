"""Day 22: the freehand projection in Python, from the ties exported by the page's Align mode.

The same maths as app/maps/lib/freehand.ts: per frame, a base projection (Mercator or Natural
Earth) and then a thin-plate spline (or, with fewer than six ties, an affine fit) through the ties.
Positions come out in "art units" (the PDF page scaled so its long side is 1600); `--pt` gives
PDF points instead (pass the page's long side in points).

    python scripts/day22/freehand.py map.freehand.json 139.767 35.681
    python scripts/day22/freehand.py map.freehand.json --csv places.csv > placed.csv   # columns: name,lng,lat

Needs only numpy.
"""

import argparse
import csv
import json
import math
import sys

import numpy as np

DEG = math.pi / 180


def natural_earth(lam, phi):
    l, p = lam * DEG, phi * DEG
    p2 = p * p
    p4 = p2 * p2
    x = l * (0.8707 - 0.131979 * p2 + p4 * (-0.013791 + p4 * (0.003971 * p2 - 0.001529 * p4)))
    y = p * (1.007226 + p2 * (0.015085 + p4 * (-0.044475 + 0.028874 * p2 - 0.005916 * p4)))
    return x / DEG, y / DEG


def to_base(f, lng, lat):
    if f.get("base") == "mercator":
        la = max(-85.0, min(85.0, lat))
        return lng, math.log(math.tan(math.pi / 4 + la * DEG / 2)) / DEG
    # Longitude in -180..180 first, as the page does (so 330° and -30° are the same place)
    lam = ((lng + 180) % 360) - 180 - f.get("lng0", 0) + f.get("shift", 0)
    if f.get("wrap", True):
        lam = ((lam + 180) % 360) - 180
    return natural_earth(lam, lat)


def in_ring(lng, lat, ring):
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > lat) != (yj > lat) and lng < (xj - xi) * (lat - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


class Tps:
    def __init__(self, src, dst, lam):
        n = len(src)
        self.mean = src.mean(axis=0)
        self.scale = math.sqrt(((src - self.mean) ** 2).sum() / (2 * n)) or 1.0
        self.s = (src - self.mean) / self.scale
        d2 = ((self.s[:, None] - self.s[None]) ** 2).sum(-1)
        A = np.zeros((n + 3, n + 3))
        with np.errstate(divide="ignore", invalid="ignore"):
            A[:n, :n] = np.where(d2 > 0, 0.5 * d2 * np.log(d2), 0) + lam * np.eye(n)
        A[:n, n] = A[n, :n] = 1
        A[:n, n + 1 :] = self.s
        A[n + 1 :, :n] = self.s.T
        b = np.zeros((n + 3, 2))
        b[:n] = dst
        self.w = np.linalg.solve(A, b)

    def __call__(self, x, y):
        q = (np.array([x, y]) - self.mean) / self.scale
        d2 = ((self.s - q) ** 2).sum(-1)
        with np.errstate(divide="ignore", invalid="ignore"):
            u = np.where(d2 > 0, 0.5 * d2 * np.log(d2), 0)
        n = len(self.s)
        return u @ self.w[:n] + self.w[n] + q[0] * self.w[n + 1] + q[1] * self.w[n + 2]


class Affine:
    def __init__(self, src, dst):
        X = np.column_stack([src, np.ones(len(src))])
        self.m, *_ = np.linalg.lstsq(X, dst, rcond=None)

    def __call__(self, x, y):
        return np.array([x, y, 1.0]) @ self.m


class FreehandProjection:
    def __init__(self, data):
        self.frames = data["frames"]
        self.fits = []
        for f in self.frames:
            ties = f.get("ties") or []
            if len(ties) < 3:
                self.fits.append(None)
                continue
            t = np.asarray(ties, float)
            src = np.array([to_base(f, a, b) for a, b in t[:, :2]])
            if f.get("fit") == "affine":
                self.fits.append(Affine(src, t[:, 2:]))
            else:
                self.fits.append(Tps(src, t[:, 2:], f.get("lambda", data.get("lambda", 1e-4))))

    def frame_of(self, lng, lat):
        lng = ((lng + 180) % 360) - 180
        for i, f in enumerate(self.frames):
            if not f.get("domain") or in_ring(lng, lat, f["domain"]):
                return -1 if f.get("off") else i
        return -1

    def project(self, lng, lat):
        """(x, y) on the art, or None if the place is off the map"""
        i = self.frame_of(lng, lat)
        if i < 0 or self.fits[i] is None:
            return None
        x, y = self.fits[i](*to_base(self.frames[i], lng, lat))
        return float(x), float(y)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("ties", help="JSON exported by the page (Align mode, Export ties)")
    ap.add_argument("lng", type=float, nargs="?")
    ap.add_argument("lat", type=float, nargs="?")
    ap.add_argument("--csv", help="CSV with columns name,lng,lat")
    ap.add_argument("--pt", type=float, help="the PDF page's long side in points: output in points")
    a = ap.parse_args()

    data = json.load(open(a.ties))
    proj = FreehandProjection(data)
    k = a.pt / max(data["width"], data["height"]) if a.pt else 1.0

    def place(lng, lat):
        p = proj.project(lng, lat)
        return None if p is None else (round(p[0] * k, 2), round(p[1] * k, 2))

    if a.csv:
        out = csv.writer(sys.stdout)
        out.writerow(["name", "lng", "lat", "x", "y"])
        for row in csv.DictReader(open(a.csv)):
            p = place(float(row["lng"]), float(row["lat"]))
            out.writerow([row.get("name", ""), row["lng"], row["lat"], *(p or ("", ""))])
    elif a.lng is not None and a.lat is not None:
        p = place(a.lng, a.lat)
        print("off the map" if p is None else f"{p[0]} {p[1]}")
    else:
        ap.error("give lng lat, or --csv")


if __name__ == "__main__":
    main()
