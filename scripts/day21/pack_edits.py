"""Pack the daily counts (count_edits.py) into the binaries the Day 21 map plays back.

One gzipped .bin per region (the page inflates it with DecompressionStream; named .bin, not
.gz, so dev servers don't send it as Content-Encoding: gzip), struct of arrays, sorted by time, little-endian:
  uint16 x[N], uint16 y[N]   cell on the region's grid (lon0 + x * res, lat0 + y * res: its SW corner)
  uint16 t[N]                time bin since 2025-11-01 00:00 UTC (bins of `hours` h)
  uint8  n[N]                edits in the cell in that bin, round(log2(count) * 16)
  uint8  mix[N]              high nibble: created / count * 15, low nibble: deleted / count * 15
plus a JSON beside it with the grid, the bins, and the daily totals (created, modified, deleted).

    scripts/.venv/bin/python scripts/day21/pack_edits.py --counts ~/osm-day-counts
"""
import argparse
import datetime as dt
import glob
import gzip
import json
import os

import numpy as np
import shapely

SEQ0, DAY0 = 4799, dt.date(2025, 11, 1)
OUT = os.path.join(os.path.dirname(__file__), '..', '..', 'public', 'data', 'day21')

# The fine grids in count_edits.py
JP_FINE = dict(lon0=122.0, lat0=20.0, res=0.005)
WORLD_FINE = dict(lon0=-180.0, lat0=-90.0, res=0.05)

# Japan, roughly: a hand-drawn ring through the seas round it (lon, lat), so that the box's
# share of Korea, Russia and China stays out. Takes in the outlying islands from Yonaguni to
# Minamitorishima and Okinotorishima
JAPAN_RING = [
    (122.6, 23.8), (122.6, 26.2), (126.5, 28.8), (127.8, 31.3), (128.6, 33.6), (129.05, 34.25),
    (129.2, 34.8), (129.6, 34.9), (130.6, 35.4), (131.6, 36.9), (134.0, 38.0), (138.0, 40.8),
    (139.2, 42.9), (140.8, 45.8), (142.4, 45.8), (148.3, 45.75), (149.3, 45.55), (147.5, 42.5),
    (144.0, 36.0), (155.0, 27.5), (155.0, 23.5), (142.5, 23.5), (136.6, 19.9), (135.5, 19.9),
    (131.0, 23.8),
]


def pack(name, days, key, fine, factor, hours, ring=None):
    xs, ys, ts, cs = [], [], [], []
    daily = []
    area = shapely.Polygon(ring) if ring else None
    for day, path in days:
        d = np.load(path)
        cells, counts = d[f'{key}_cells'], d[f'{key}_counts'].astype(np.int64)
        if area is not None:
            inside = shapely.contains_xy(
                area, fine['lon0'] + (cells[:, 0] + 0.5) * fine['res'], fine['lat0'] + (cells[:, 1] + 0.5) * fine['res']
            )
            cells, counts = cells[inside], counts[inside]
        daily.append(counts.sum(0).tolist())
        # Coarsen: fine cells -> `factor`-wide cells, hours -> `hours`-long bins
        k = np.stack([cells[:, 0] // factor, cells[:, 1] // factor, day * (24 // hours) + cells[:, 2] // hours], 1)
        u, inv = np.unique(k, axis=0, return_inverse=True)
        c = np.zeros((len(u), 3), np.int64)
        np.add.at(c, inv.ravel(), counts)
        xs.append(u[:, 0]), ys.append(u[:, 1]), ts.append(u[:, 2]), cs.append(c)
    x, y, t, c = (np.concatenate(a) for a in (xs, ys, ts, cs))
    order = np.lexsort((y, x, t))
    x, y, t, c = x[order], y[order], t[order], c[order]
    total = c.sum(1)
    n = np.clip(np.round(np.log2(total) * 16), 0, 255).astype(np.uint8)
    mix = (np.round(c[:, 0] / total * 15).astype(np.uint8) << 4) | np.round(c[:, 2] / total * 15).astype(np.uint8)
    assert x.max() < 65536 and y.max() < 65536 and t.max() < 65536

    os.makedirs(OUT, exist_ok=True)
    with gzip.open(os.path.join(OUT, f'{name}.bin'), 'wb', 9) as f:
        for a, dtype in ((x, '<u2'), (y, '<u2'), (t, '<u2'), (n, 'u1'), (mix, 'u1')):
            f.write(a.astype(dtype).tobytes())
    meta = {
        'start': DAY0.isoformat(),
        'days': len(days),
        'hours': hours,
        'count': int(len(x)),
        'grid': {'lon0': fine['lon0'], 'lat0': fine['lat0'], 'res': round(fine['res'] * factor, 6)},
        'daily': daily,
        'source': 'OpenStreetMap daily replication diffs (planet.openstreetmap.org), node edits',
    }
    with open(os.path.join(OUT, f'{name}.json'), 'w') as f:
        json.dump(meta, f, separators=(',', ':'))
    size = os.path.getsize(os.path.join(OUT, f'{name}.bin'))
    print(f'{name}: {len(x):,} entries, {size / 1e6:.1f} MB gzipped, {int(c.sum()):,} edits')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--counts', required=True)
    ap.add_argument('--jp-factor', type=int, default=2, help='Japan cell = this many 0.005 deg cells')
    ap.add_argument('--jp-hours', type=int, default=1)
    ap.add_argument('--world-factor', type=int, default=5, help='world cell = this many 0.05 deg cells')
    ap.add_argument('--world-hours', type=int, default=24)
    a = ap.parse_args()
    days = []
    for p in sorted(glob.glob(os.path.join(a.counts, '*.npz'))):
        seq = int(os.path.basename(p).split('.')[0])
        days.append((seq - SEQ0, p))
    # Only a run of consecutive days from the start (the download may still be under way)
    days = [d for i, d in enumerate(days) if d[0] == i]
    pack('japan', days, 'jp', JP_FINE, a.jp_factor, a.jp_hours, JAPAN_RING)
    pack('world', days, 'world', WORLD_FINE, a.world_factor, a.world_hours)


if __name__ == '__main__':
    main()
