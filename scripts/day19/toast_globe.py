"""Day 19: the land for a globe of toast, and where the photos of the slice sit on it.

The toast's burnt Japan is pinned to the real one by its burnt patches (Hokkaido, Tohoku, the
middle of Honshu, Chugoku, Kyushu): a similarity transform from the frames' pixels
(scripts/day19/prepare_photos.py) to an orthographic projection centred on Japan (the globe as
a camera straight above sees it, so the slice stays square on the screen), by least squares.

The land (Day 1's land.geojson: Overture's Japan, Natural Earth's world) is drawn as a mask and
blurred three ways, one per channel, for the shader to toast it with: R crisp (the coast itself),
G a little (a line along it), B a lot (the golden halo round each coast). Once over the whole
globe (equirectangular), and once in the frames' own pixels, finer, for the slice.

    scripts/.venv/bin/python scripts/day19/toast_globe.py

Over the photos also Japan alone (blurred as G: the coast to pick out on the toast), the slice's
outline in the last photo (pale toast on a white plate: wherever it's redder than blue), and Japan
blurred wide (where the heat comes off the toast), as slice.png's R, G and B.

-> public/data/day19/toast.json, land_globe.png, land_bread.png, slice.png
"""

import json
import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "public" / "data" / "day19"
LAND = ROOT / "public" / "data" / "day01" / "land.geojson"

# Burnt patches on the toast (frame pixels, the last frame) and the places they stand for
CONTROL = [
    ((735, 435), (142.9, 43.4)),  # Hokkaido
    ((690, 580), (140.7, 39.3)),  # Tohoku
    ((585, 700), (137.0, 35.5)),  # Chubu and Kansai
    ((465, 740), (133.0, 34.8)),  # Chugoku
    ((355, 790), (130.9, 32.6)),  # Kyushu
]
FRAME = 1200  # the frames' size (px), as prepare_photos.py makes them
# The projection's centre (lng, lat): about the middle of the frames
CENTER = (138.0, 38.6)

GLOBE = (4096, 2048)
# Blur (px) per channel: crisp, the line, the halo; for the globe and for the slice
GLOBE_SIGMA = (0.8, 2.5, 12)
BREAD_SIGMA = (1.2, 5, 30)
SUPERSAMPLE = 2

# Japan blurred this wide (px) for the heat off it
HEAT_SIGMA = 22
# The slice in the last photo: within this box (px), redder than blue by this much
SLICE_BOX = (217, 170, 992, 1004)
SLICE_RED = 30



def ortho(lng: float, lat: float) -> tuple[float, float]:
    """Orthographic projection round CENTER, on the unit sphere"""
    lo, la = math.radians(lng - CENTER[0]), math.radians(lat)
    la0 = math.radians(CENTER[1])
    return math.cos(la) * math.sin(lo), math.cos(la0) * math.sin(la) - math.sin(la0) * math.cos(la) * math.cos(lo)


def unortho(x: float, y: float) -> tuple[float, float]:
    rho = math.hypot(x, y)
    if rho == 0:
        return CENTER
    c = math.asin(min(rho, 1.0))
    la0 = math.radians(CENTER[1])
    lat = math.asin(math.cos(c) * math.sin(la0) + y * math.sin(c) * math.cos(la0) / rho)
    lng = math.atan2(x * math.sin(c), rho * math.cos(c) * math.cos(la0) - y * math.sin(c) * math.sin(la0))
    return CENTER[0] + math.degrees(lng), math.degrees(lat)


def fit() -> tuple[float, float, float, float]:
    """(a, c, tx, ty) with ortho = [a -c; c a] (x, -y) + t, from frame pixels (x right, y down)"""
    rows, rhs = [], []
    for (x, y), (lng, lat) in CONTROL:
        mx, my = ortho(lng, lat)
        u, v = x, -y
        rows += [[u, -v, 1, 0], [v, u, 0, 1]]
        rhs += [mx, my]
    a, c, tx, ty = np.linalg.lstsq(np.array(rows, float), np.array(rhs), rcond=None)[0]
    return float(a), float(c), float(tx), float(ty)


def rings() -> list[tuple[list, list]]:
    """Each land polygon as (exterior, holes), lng/lat"""
    out = []
    for f in json.loads(LAND.read_text())["features"]:
        g = f["geometry"]
        polys = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]
        out += [(p[0], p[1:]) for p in polys]
    return out


def draw(size: tuple[int, int], polygons, to_px) -> Image.Image:
    im = Image.new("L", size, 0)
    d = ImageDraw.Draw(im)
    for ext, holes in polygons:
        pts = [to_px(lng, lat) for lng, lat in ext]
        if len(pts) > 2:
            d.polygon(pts, fill=255)
        for h in holes:
            pts = [to_px(lng, lat) for lng, lat in h]
            if len(pts) > 2:
                d.polygon(pts, fill=0)
    return im


def in_japan(ring: list) -> bool:
    """Japan's own land, not its neighbours': by where the polygon's middle is"""
    lng = sum(p[0] for p in ring) / len(ring)
    lat = sum(p[1] for p in ring) / len(ring)
    if not (122.5 < lng < 154 and 24 < lat < 45.6):
        return False
    # Jeju and Korea's southern islands; the Kurils past Nemuro
    if (lng < 127.5 and lat > 33.0) or (lng < 128.9 and lat > 33.9):
        return False
    return not (lng > 145.9 and lat > 43.4)


def slice_mask(photo: Path) -> Image.Image:
    rgb = np.asarray(Image.open(photo)).astype(float)
    mask = Image.fromarray(((rgb[:, :, 0] - rgb[:, :, 2] > SLICE_RED) * 255).astype(np.uint8))
    box = Image.new("L", mask.size, 0)
    box.paste(255, SLICE_BOX)
    mask = Image.fromarray(np.minimum(np.asarray(mask), np.asarray(box)))
    mask = mask.filter(ImageFilter.GaussianBlur(4)).point(lambda v: 255 if v > 128 else 0)
    # Fill the burnt spots: everything the outside can't reach
    ImageDraw.floodfill(mask, (0, 0), 128)
    mask = mask.point(lambda v: 0 if v == 128 else 255)
    return mask.filter(ImageFilter.GaussianBlur(1.5))


def channels(mask: Image.Image, sigmas, wrap: bool) -> Image.Image:
    """The mask blurred once per channel; `wrap` carries the blur across the left and right edges"""
    out = []
    w, h = mask.size
    for s in sigmas:
        if wrap:
            pad = int(s * 4) + 2
            src = Image.new("L", (w + 2 * pad, h))
            src.paste(mask.crop((w - pad, 0, w, h)), (0, 0))
            src.paste(mask, (pad, 0))
            src.paste(mask.crop((0, 0, pad, h)), (pad + w, 0))
            out.append(src.filter(ImageFilter.GaussianBlur(s)).crop((pad, 0, pad + w, h)))
        else:
            out.append(mask.filter(ImageFilter.GaussianBlur(s)))
    return Image.merge("RGB", out)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    a, c, tx, ty = fit()
    s2 = a * a + c * c
    print(f"{6371 * math.sqrt(s2):.2f} km a frame px, turned {math.degrees(math.atan2(c, a)):.1f} deg")

    def frame_px(lng: float, lat: float) -> tuple[float, float]:
        mx, my = ortho(lng, lat)
        mx, my = mx - tx, my - ty
        return (a * mx + c * my) / s2, -(-c * mx + a * my) / s2

    def frame_geo(x: float, y: float) -> tuple[float, float]:
        return unortho(a * x - c * -y + tx, c * x + a * -y + ty)

    for (x, y), (lng, lat) in CONTROL:
        px, py = frame_px(lng, lat)
        print(f"  ({x}, {y}) -> ({px:.0f}, {py:.0f})")

    polygons = rings()

    # The globe
    W, H = GLOBE[0] * SUPERSAMPLE, GLOBE[1] * SUPERSAMPLE
    mask = draw((W, H), polygons, lambda lng, lat: ((lng + 180) / 360 * W, (90 - lat) / 180 * H))
    mask = mask.resize(GLOBE, Image.Resampling.BOX)
    channels(mask, GLOBE_SIGMA, wrap=True).save(OUT / "land_globe.png", optimize=True)

    # The slice: only the land near the frame
    corners = [frame_geo(x, y) for x in (-FRAME / 2, FRAME * 1.5) for y in (-FRAME / 2, FRAME * 1.5)]
    lo0, lo1 = min(p[0] for p in corners), max(p[0] for p in corners)
    la0, la1 = min(p[1] for p in corners), max(p[1] for p in corners)
    near = [(e, h) for e, h in polygons if any(lo0 < lng < lo1 and la0 < lat < la1 for lng, lat in e)]
    S = FRAME * SUPERSAMPLE
    mask = draw((S, S), near, lambda lng, lat: tuple(v * SUPERSAMPLE for v in frame_px(lng, lat)))
    mask = mask.resize((FRAME, FRAME), Image.Resampling.BOX)
    channels(mask, BREAD_SIGMA, wrap=False).save(OUT / "land_bread.png", optimize=True)
    japan = [(e, h) for e, h in near if in_japan(e)]
    japan_mask = draw((S, S), japan, lambda lng, lat: tuple(v * SUPERSAMPLE for v in frame_px(lng, lat)))
    japan_mask = japan_mask.resize((FRAME, FRAME), Image.Resampling.BOX)
    japan_line = japan_mask.filter(ImageFilter.GaussianBlur(BREAD_SIGMA[1]))
    last = sorted((OUT / "frames").glob("*.jpg"))[-1]
    heat = japan_mask.filter(ImageFilter.GaussianBlur(HEAT_SIGMA))
    heat = heat.point(lambda v: min(255, v * 3))
    Image.merge("RGB", [japan_line, slice_mask(last), heat]).save(OUT / "slice.png", optimize=True)

    center = frame_geo(FRAME / 2, FRAME / 2)
    meta = {
        # ortho (unit sphere, round `projection`) = [a -c; c a] (u, -v) + t, for the frames' uv (0-1, v down)
        "frame": {"a": a * FRAME, "c": c * FRAME, "tx": tx, "ty": ty},
        "projection": {"lng": CENTER[0], "lat": CENTER[1]},
        "center": {"lng": round(center[0], 4), "lat": round(center[1], 4)},
        # The frame's width on the ground at its middle (m)
        "width": round(math.sqrt(s2) * FRAME * 6_371_000),
    }
    (OUT / "toast.json").write_text(json.dumps(meta, indent=1) + "\n")
    print(meta)


if __name__ == "__main__":
    main()
