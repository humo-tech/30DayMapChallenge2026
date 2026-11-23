"""Day 24 (Network): the rain those days, for the map to rain with.

JMA's 10-minute observations at the AMeDAS station Chiba (千葉, the nearest to Makuhari, 8 km
east), from its past-weather pages: precipitation (mm) in each 10 minutes of the JST day, 144
of them, the first for 00:00-00:10. No precipitation ("--") is 0; quality marks are dropped.

Output: public/data/day24/rain.json

Usage:
    python scripts/day24/fetch_rain.py 2026-11-16 2026-11-17
"""

import argparse
import json
import re
import urllib.request
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "public" / "data" / "day24" / "rain.json"
PREC_NO, BLOCK_NO = 45, 47682  # 千葉
URL = "https://www.data.jma.go.jp/stats/etrn/view/10min_s1.php?prec_no={p}&block_no={b}&year={y}&month={m}&day={d}&view="


def tenminutes(day: date) -> list[float]:
    url = URL.format(p=PREC_NO, b=BLOCK_NO, y=day.year, m=day.month, d=day.day)
    html = urllib.request.urlopen(url, timeout=30).read().decode("utf-8")
    values = []
    for row in re.findall(r'<tr class="mtx"[^>]*>(.*?)</tr>', html, re.S):
        cells = [re.sub(r"<[^>]+>", "", c).strip() for c in re.findall(r"<td[^>]*>(.*?)</td>", row, re.S)]
        if not cells or not re.fullmatch(r"\d{1,2}:\d{2}", cells[0]):
            continue
        # time, pressure (station, sea level), precipitation, ...
        v = re.sub(r"[^\d.]", "", cells[3])
        values.append(float(v) if v else 0.0)
    if len(values) != 144:
        raise SystemExit(f"{day}: {len(values)} rows, not 144")
    return values


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("days", nargs="+", type=date.fromisoformat)
    args = parser.parse_args()

    out = {"station": "Chiba (AMeDAS)", "minutes": 10, "days": {}}
    for day in args.days:
        v = tenminutes(day)
        out["days"][day.isoformat()] = v
        print(f"{day}: {sum(v):.1f} mm, raining {sum(1 for x in v if x > 0) * 10} min")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, separators=(",", ":")))
    print(f"-> {OUT}")


if __name__ == "__main__":
    main()
