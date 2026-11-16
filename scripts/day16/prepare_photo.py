"""Day 16 (Collaborative map): a photo from the race, ready to publish.

Blurs the given boxes (bib names, faces), shrinks the photo to `--size` px on its long
side and writes it as a JPEG without any metadata (no EXIF, so no GPS or camera) to
`public/data/day16/photos/<name>.jpg`. The original stays out of the repository.

Usage:
    python scripts/day16/prepare_photo.py photo.png name [--blur x,y,w,h ...] [--size 900]

Boxes are in the original's pixels.
"""

import argparse
from pathlib import Path

from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT = ROOT / "public" / "data" / "day16" / "photos"


def box(value: str) -> tuple[int, int, int, int]:
    x, y, w, h = (int(v) for v in value.split(","))
    return x, y, x + w, y + h


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("photo", type=Path)
    parser.add_argument("name")
    parser.add_argument("--blur", type=box, action="append", default=[], help="x,y,w,h to blur")
    parser.add_argument("--size", type=int, default=900, help="long side (px)")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()

    image = Image.open(args.photo).convert("RGB")
    for b in args.blur:
        # Strong enough that no character survives, at any size the box is
        radius = max(b[2] - b[0], b[3] - b[1]) / 6
        image.paste(image.crop(b).filter(ImageFilter.GaussianBlur(radius)), b[:2])
    image.thumbnail((args.size, args.size), Image.Resampling.LANCZOS)

    args.out.mkdir(parents=True, exist_ok=True)
    out = args.out / f"{args.name}.jpg"
    # A fresh image carries no EXIF
    image.save(out, "JPEG", quality=82, optimize=True, progressive=True)
    print(f"{image.width}x{image.height} -> {out.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
