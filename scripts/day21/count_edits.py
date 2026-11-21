"""Count the node edits in each daily diff (fetch_diffs.py) on fine grids, one .npz per day.

Every node in a diff is one edit: created (version 1), modified, or deleted (visible=false,
still at its last position). Ways and relations carry no positions of their own, so a way
whose tags alone changed doesn't show; anything drawn or moved does, through its nodes.

Two grids per day, each binned by UTC hour and kind of edit:
  jp:    0.005 deg cells (about 500 m) over 122-154 E, 20-46 N
  world: 0.05 deg cells (about 5 km) everywhere

    scripts/.venv/bin/python scripts/day21/count_edits.py --cache ~/osm-day-diffs --out ~/osm-day-counts
"""
import argparse
import glob
import os
from multiprocessing import Pool

import numpy as np
import osmium

JP = dict(lon0=122.0, lat0=20.0, lon1=154.0, lat1=46.0, res=0.005)
WORLD_RES = 0.05


class Nodes(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.lon, self.lat, self.hour, self.kind = [], [], [], []

    def node(self, n):
        loc = n.location
        if not loc.valid():
            return
        self.lon.append(loc.lon)
        self.lat.append(loc.lat)
        self.hour.append(n.timestamp.hour)
        # 0 created, 1 modified, 2 deleted
        self.kind.append(2 if not n.visible else 0 if n.version == 1 else 1)


def bin_counts(ix, iy, hour, kind):
    """Unique (ix, iy, hour) rows with counts per kind."""
    key = np.stack([ix, iy, hour], axis=1)
    uniq, inv = np.unique(key, axis=0, return_inverse=True)
    counts = np.zeros((len(uniq), 3), np.uint32)
    np.add.at(counts, (inv.ravel(), kind), 1)
    return uniq.astype(np.int32), counts


def process(args):
    path, out = args
    dst = os.path.join(out, os.path.basename(path).replace('.osc.gz', '.npz'))
    if os.path.exists(dst):
        return dst
    h = Nodes()
    h.apply_file(path)
    lon = np.array(h.lon)
    lat = np.array(h.lat)
    hour = np.array(h.hour, np.int32)
    kind = np.array(h.kind, np.int32)

    jp = (lon >= JP['lon0']) & (lon < JP['lon1']) & (lat >= JP['lat0']) & (lat < JP['lat1'])
    jx = np.floor((lon[jp] - JP['lon0']) / JP['res']).astype(np.int32)
    jy = np.floor((lat[jp] - JP['lat0']) / JP['res']).astype(np.int32)
    jp_cells, jp_counts = bin_counts(jx, jy, hour[jp], kind[jp])

    wx = np.clip(np.floor((lon + 180) / WORLD_RES), 0, 360 / WORLD_RES - 1).astype(np.int32)
    wy = np.clip(np.floor((lat + 90) / WORLD_RES), 0, 180 / WORLD_RES - 1).astype(np.int32)
    w_cells, w_counts = bin_counts(wx, wy, hour, kind)

    np.savez_compressed(
        dst + '.part.npz', jp_cells=jp_cells, jp_counts=jp_counts, world_cells=w_cells, world_counts=w_counts
    )
    os.replace(dst + '.part.npz', dst)
    return dst


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--cache', required=True, help='directory of <seq>.osc.gz')
    ap.add_argument('--out', required=True)
    ap.add_argument('--jobs', type=int, default=os.cpu_count())
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    files = sorted(glob.glob(os.path.join(a.cache, '*.osc.gz')))
    with Pool(a.jobs) as pool:
        for i, p in enumerate(pool.imap_unordered(process, [(f, a.out) for f in files])):
            print(f'{i + 1}/{len(files)} {p}', flush=True)


if __name__ == '__main__':
    main()
