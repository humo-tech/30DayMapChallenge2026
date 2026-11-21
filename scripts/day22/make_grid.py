"""Day 22: test cards for the warp — plate carrée grids that show how much each part is stretched.

    public/data/day22/grid-3600x1800.png    the world: 10 px per degree, lines every 0.5°,
                                            10° squares shaded, labels every 10°
    public/data/day22/grid-japan.png        Japan (121–151°E, 22–47°N) on a 10800-wide base:
                                            30 px per degree, lines every 0.2°, 1° squares
                                            shaded, labels every 2°

Lines at the finest step (faint), then 1°, 5° (navy) and 10° (red), the equator and the prime
meridian heavier.

Usage:
    python scripts/day22/make_grid.py
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "public" / "data" / "day22"

PAPER = (247, 244, 236)
SHADE = (234, 227, 210)
FINE = (205, 197, 178)
LEVELS = [  # (every, colour, width): drawn after the finest lines, coarser on top
    (1, (160, 150, 128), 1),
    (5, (84, 100, 118), 2),
    (10, (194, 39, 45), 2),
]
AXES = ((150, 20, 30), 3)  # the equator and the prime meridian
LABEL = (60, 60, 60)

GRIDS = [
    # name, bbox (west, south, east, north), px per degree, finest step, shaded square, label every, font size
    ("grid-3600x1800.png", (-180, -90, 180, 90), 10, 0.5, 10, 10, 13),
    ("grid-japan.png", (121, 22, 151, 47), 30, 0.2, 1, 2, 10),
]


def make(name, bbox, k, step, square, label_every, font_size):
    west, south, east, north = bbox
    w, h = (east - west) * k, (north - south) * k
    img = Image.new("RGB", (w, h), PAPER)
    d = ImageDraw.Draw(img)
    x_of = lambda lng: round((lng - west) * k)
    y_of = lambda lat: round((north - lat) * k)

    # Squares shaded alternately (by their place on the globe, so the pattern doesn't depend on the crop)
    for i in range(int((east - west) / square)):
        for j in range(int((north - south) / square)):
            lng, lat = west + i * square, north - j * square
            if (round(lng / square) + round(lat / square)) % 2:
                d.rectangle([x_of(lng), y_of(lat), x_of(lng + square) - 1, y_of(lat - square) - 1], fill=SHADE)

    def meridian(lng, colour, width):
        x = x_of(lng)
        d.rectangle([x - width // 2, 0, x - width // 2 + width - 1, h - 1], fill=colour)

    def parallel(lat, colour, width):
        y = y_of(lat)
        d.rectangle([0, y - width // 2, w - 1, y - width // 2 + width - 1], fill=colour)

    # Integer steps so 0.2° adds up exactly
    n_fine = round(1 / step)
    for i in range(round((east - west) * n_fine) + 1):
        meridian(west + i / n_fine, FINE, 1)
    for i in range(round((north - south) * n_fine) + 1):
        parallel(south + i / n_fine, FINE, 1)
    for every, colour, width in LEVELS:
        for lng in range(west, east + 1):
            if lng % every == 0:
                meridian(lng, colour, width)
        for lat in range(south, north + 1):
            if lat % every == 0:
                parallel(lat, colour, width)
    if west <= 0 <= east:
        meridian(0, *AXES)
    if south <= 0 <= north:
        parallel(0, *AXES)

    font = ImageFont.load_default(size=font_size)
    first = lambda a: -(-a // label_every) * label_every
    for lng in range(first(west), east, label_every):
        for lat in range(first(south) + label_every, north + 1, label_every):
            if abs(lat) >= 90:
                continue
            x, y = x_of(lng) + 3, y_of(lat) + 2
            ns = f"{abs(lat)}°{'N' if lat > 0 else 'S' if lat < 0 else ''}"
            ew = f"{abs(lng)}°{'E' if lng > 0 else 'W' if lng < 0 else ''}"
            d.text((x, y), ns, fill=LABEL, font=font)
            d.text((x, y + font_size + 2), ew, fill=LABEL, font=font)

    path = OUT / name
    img.save(path, optimize=True)
    print(f"{path}: {w} x {h}, {path.stat().st_size / 1024:.0f} KB")


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for g in GRIDS:
        make(*g)


if __name__ == "__main__":
    main()
