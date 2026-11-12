"""Day 12 (Power): the world's ocean waves, from ECMWF's open data.

Takes three fields of the IFS wave model (ECWAM) on its global 0.25° grid,
from one run's analysis step (or a forecast step):

- swh: significant height of combined wind waves and swell (m);
- mwd: mean wave direction (° clockwise from north, the way they come FROM);
- mwp: mean wave period (s).

Only those three messages are downloaded (byte ranges, from the run's
.index). They are written as one raw little-endian float16 binary, the three
fields interleaved per cell (swh, mwd, mwp), row by row from the north
(90°N) to the south and each row from 180°W eastward. Land and sea ice are
-1 in all three (NaN can't be told apart reliably in a shader). The map
uploads it to the GPU as it is, and interpolates there.

Usage:
    python scripts/day12/fetch_waves.py [--date 20261111] [--run 00] [--step 0]
"""

import argparse
import datetime as dt
import json
import urllib.error
import urllib.request
from pathlib import Path

import eccodes
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / "scripts" / ".cache" / "day12"
OUT_DIR = ROOT / "public" / "data" / "day12"

BASE = "https://data.ecmwf.int/forecasts/{date}/{run}z/ifs/0p25/wave/{date}{run}0000-{step}h-wave-fc"
PARAMS = ["swh", "mwd", "mwp"]


def fetch(url: str, byte_range: tuple[int, int] | None = None) -> bytes:
    req = urllib.request.Request(url)
    if byte_range:
        start, length = byte_range
        req.add_header("Range", f"bytes={start}-{start + length - 1}")
    with urllib.request.urlopen(req, timeout=120) as res:
        return res.read()


def latest_run() -> tuple[str, str]:
    """The newest 00z/12z run whose wave index is already up."""
    now = dt.datetime.now(dt.timezone.utc)
    for hours_back in range(0, 72, 12):
        t = now - dt.timedelta(hours=hours_back)
        run = "12" if t.hour >= 12 else "00"
        date = t.strftime("%Y%m%d")
        try:
            fetch(BASE.format(date=date, run=run, step=0) + ".index", (0, 1))
            return date, run
        except urllib.error.HTTPError:
            continue
    raise SystemExit("No recent run found on data.ecmwf.int")


def download(date: str, run: str, step: int) -> dict[str, bytes]:
    base = BASE.format(date=date, run=run, step=step)
    entries = [json.loads(line) for line in fetch(base + ".index").decode().splitlines() if line.strip()]
    messages = {}
    for param in PARAMS:
        cached = CACHE / f"{date}{run}-{step}h-{param}.grib2"
        if not cached.exists():
            entry = next(e for e in entries if e["param"] == param)
            CACHE.mkdir(parents=True, exist_ok=True)
            cached.write_bytes(fetch(base + ".grib2", (entry["_offset"], entry["_length"])))
            print(f"downloaded {param}: {cached.stat().st_size / 1e6:.1f} MB")
        messages[param] = cached.read_bytes()
    return messages


def decode(message: bytes) -> tuple[np.ndarray, dict]:
    """The field as a (lat, lng) array, north first, 180°W first; missing as NaN."""
    gid = eccodes.codes_new_from_message(message)
    try:
        ni = eccodes.codes_get(gid, "Ni")
        nj = eccodes.codes_get(gid, "Nj")
        lon0 = eccodes.codes_get(gid, "longitudeOfFirstGridPointInDegrees")
        lat0 = eccodes.codes_get(gid, "latitudeOfFirstGridPointInDegrees")
        lat1 = eccodes.codes_get(gid, "latitudeOfLastGridPointInDegrees")
        dlon = eccodes.codes_get(gid, "iDirectionIncrementInDegrees")
        missing = eccodes.codes_get(gid, "missingValue")
        values = eccodes.codes_get_values(gid).reshape(nj, ni)
    finally:
        eccodes.codes_release(gid)
    values = np.where(values == missing, np.nan, values)
    if lat0 < lat1:
        values = values[::-1]
    # Start each row at 180°W
    lon0 = ((lon0 + 180) % 360) - 180
    shift = int(round((lon0 + 180) / dlon))
    values = np.roll(values, shift, axis=1)
    return values, {"width": ni, "height": nj, "lat0": max(lat0, lat1), "dlon": dlon}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--date", help="Run date, YYYYMMDD (default: the latest run)")
    parser.add_argument("--run", default="00", choices=["00", "12"])
    parser.add_argument("--step", type=int, default=0, help="Forecast step (h)")
    args = parser.parse_args()
    date, run = (args.date, args.run) if args.date else latest_run()

    messages = download(date, run, args.step)
    fields, grid = [], None
    for param in PARAMS:
        values, g = decode(messages[param])
        assert grid is None or g == grid, f"{param} is on another grid: {g}"
        grid = g
        fields.append(values)
    data = np.stack(fields, axis=-1)
    data[np.isnan(data).any(axis=-1)] = -1
    data = data.astype("<f2")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "waves.bin").write_bytes(data.tobytes())
    valid = dt.datetime.strptime(date + run, "%Y%m%d%H") + dt.timedelta(hours=args.step)
    meta = {
        **grid,
        "lng0": -180.0,
        "params": PARAMS,
        "type": "float16",
        "missing": -1,
        "time": valid.strftime("%Y-%m-%dT%H:%MZ"),
        "source": "ECMWF open data, IFS wave model (CC BY 4.0)",
    }
    (OUT_DIR / "waves.json").write_text(json.dumps(meta, indent=2) + "\n")
    swh = fields[0]
    print(f"{grid['width']}x{grid['height']}, valid {meta['time']}: swh up to {np.nanmax(swh):.1f} m, {np.isnan(swh).mean():.0%} land/ice")
    print(f"wrote {OUT_DIR / 'waves.bin'} ({data.nbytes / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
