"""Download OSM's daily replication diffs (osmChange) for a range of days.

Each file holds every edit made worldwide in one UTC day. Sequence 4799 is
2025-11-01; one sequence per day after that.

    scripts/.venv/bin/python scripts/day21/fetch_diffs.py --cache ~/osm-day-diffs
"""
import argparse
import datetime as dt
import os
import urllib.request
from concurrent.futures import ThreadPoolExecutor

BASE = 'https://planet.openstreetmap.org/replication/day'
SEQ0, DAY0 = 4799, dt.date(2025, 11, 1)


def seq_path(seq: int) -> str:
    s = f'{seq:09d}'
    return f'{s[0:3]}/{s[3:6]}/{s[6:9]}'


def fetch(seq: int, cache: str) -> str:
    out = os.path.join(cache, f'{seq}.osc.gz')
    if os.path.exists(out):
        return out
    tmp = out + '.part'
    urllib.request.urlretrieve(f'{BASE}/{seq_path(seq)}.osc.gz', tmp)
    os.replace(tmp, out)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--cache', required=True)
    ap.add_argument('--start', default='2025-11-01')
    ap.add_argument('--end', default='2026-10-31')
    ap.add_argument('--jobs', type=int, default=6)
    a = ap.parse_args()
    os.makedirs(a.cache, exist_ok=True)
    d0, d1 = dt.date.fromisoformat(a.start), dt.date.fromisoformat(a.end)
    seqs = [SEQ0 + (d0 - DAY0).days + i for i in range((d1 - d0).days + 1)]
    with ThreadPoolExecutor(a.jobs) as ex:
        for i, p in enumerate(ex.map(lambda s: fetch(s, a.cache), seqs)):
            print(f'{i + 1}/{len(seqs)} {p}', flush=True)


if __name__ == '__main__':
    main()
