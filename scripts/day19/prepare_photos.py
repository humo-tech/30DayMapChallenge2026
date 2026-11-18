"""Day 19: the photos of the slice of bread, from a plain slice through the foil stencil of Japan
and the oven to the toast, each warped so the slice sits in the same place (its four corners,
scripts/day19/corners.json, onto one rectangle), shrunk, and saved without metadata. And from the
first (the plain slice), a square of its crumb, and from the last (the toast), a square of its
browned surface where it's toasted right through, each made to tile, as light and shade only
(each pixel over the blurred square round it): for the globe of toast to be made of.

    scripts/.venv/bin/python scripts/day19/prepare_photos.py <photo dir>

-> public/data/day19/frames/NN.jpg (in the order they were taken), frames.json, crumb.jpg, toasted.jpg
The originals stay out of the repository.
"""

import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter, ImageOps

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "public" / "data" / "day19"
CORNERS = Path(__file__).with_name("corners.json")

# The frame (px) and the slice in it: about as tall as it is wide, with a margin of plate round it
SIZE = 1200
BREAD = {"x0": 220, "y0": 200, "x1": 980, "y1": 1000}
QUALITY = 82

# Squares that tile: where in the photo (px, as shown), every how many px they repeat, how far past
# that their edges are blended in, the blur they're taken over, the value their own tone is saved at
# (out of 255), and their size saved (px)
CRUMB = {"at": (1000, 1000), "tile": 768, "overlap": 256, "blur": 48, "unit": 128, "size": 512}
# (the toasted surface glints with butter: room above its own tone for that)
TOASTED = {"at": (2240, 580), "tile": 280, "overlap": 80, "blur": 90, "unit": 80, "size": 256}


def homography(src: list[tuple[float, float]], dst: list[tuple[float, float]]) -> np.ndarray:
    """The 3x3 matrix taking each src point to its dst point"""
    a, b = [], []
    for (x, y), (u, v) in zip(src, dst):
        a.append([x, y, 1, 0, 0, 0, -u * x, -u * y])
        a.append([0, 0, 0, x, y, 1, -v * x, -v * y])
        b += [u, v]
    h = np.linalg.solve(np.array(a, float), np.array(b, float))
    return np.append(h, 1).reshape(3, 3)


def tiling(photo: Image.Image, at: tuple[int, int], tile: int, overlap: int, blur: float, unit: int, size: int) -> Image.Image:
    x, y = at
    lum = np.asarray(photo.crop((x, y, x + tile + overlap, y + tile + overlap)).convert("L")).astype(float)
    # Light and shade only: each pixel over its surroundings, so the shader gives the color
    soft = np.asarray(Image.fromarray(lum.astype(np.uint8)).filter(ImageFilter.GaussianBlur(blur))).astype(float)
    detail = lum / np.maximum(soft, 1)
    # Tile: the strip past each edge faded in over the strip inside the other
    w = np.linspace(0, 1, overlap)
    t = detail[:, :tile].copy()
    t[:, :overlap] = detail[:, :overlap] * w + detail[:, tile:] * (1 - w)
    out = t[:tile].copy()
    out[:overlap] = t[:overlap] * w[:, None] + t[tile:] * (1 - w[:, None])
    img = Image.fromarray(np.clip(out * unit, 0, 255).astype(np.uint8))
    return img.resize((size, size), Image.Resampling.LANCZOS)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("photos", type=Path)
    args = ap.parse_args()

    corners = {k: v for k, v in json.loads(CORNERS.read_text()).items() if not k.startswith("_")}
    (OUT / "frames").mkdir(parents=True, exist_ok=True)
    b = BREAD
    target = [(b["x0"], b["y0"]), (b["x1"], b["y0"]), (b["x1"], b["y1"]), (b["x0"], b["y1"])]
    for i, name in enumerate(sorted(corners)):
        im = ImageOps.exif_transpose(Image.open(args.photos / name)).convert("RGB")
        w, h = im.size
        src = [(x / 1000 * w, y / 1000 * h) for x, y in corners[name]]
        # PIL wants the map from the output back to the photo
        m = homography(target, src)
        m = (m / m[2, 2]).flatten()[:8]
        out = im.transform((SIZE, SIZE), Image.Transform.PERSPECTIVE, tuple(m), Image.Resampling.BICUBIC)
        out.save(OUT / "frames" / f"{i:02d}.jpg", quality=QUALITY, optimize=True, progressive=True)
        print(f"{i:02d} {name}")

    first = ImageOps.exif_transpose(Image.open(args.photos / sorted(corners)[0])).convert("RGB")
    tiling(first, **CRUMB).save(OUT / "crumb.jpg", quality=90)
    last = ImageOps.exif_transpose(Image.open(args.photos / sorted(corners)[-1])).convert("RGB")
    tiling(last, **TOASTED).save(OUT / "toasted.jpg", quality=90)

    meta = {"count": len(corners), "size": SIZE, "bread": {k: v / SIZE for k, v in BREAD.items()}}
    (OUT / "frames.json").write_text(json.dumps(meta, indent=1) + "\n")


if __name__ == "__main__":
    main()
