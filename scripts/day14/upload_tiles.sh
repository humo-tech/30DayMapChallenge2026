#!/usr/bin/env bash
# Day 14: uploads the point cloud's tiles (public/data/day14/tiles, from extract_crater.py) to
# https://humo.tech/2026/day14/tiles/, gzipped: CloudFront serves them as they are, with
# Content-Encoding: gzip, and the browser's fetch inflates them.
#
# Usage: scripts/day14/upload_tiles.sh [--dryrun]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/public/data/day14/tiles"
GZ="$ROOT/scripts/.cache/day14/tiles-gz"
DEST="s3://humo-tech-web/2026/day14/tiles"

rm -rf "$GZ"
mkdir -p "$GZ"
(cd "$SRC" && find . -name '*.bin' -print0 | while IFS= read -r -d '' f; do
  mkdir -p "$GZ/$(dirname "$f")"
  gzip -9 -n -c "$f" > "$GZ/$f"
done)
echo "$(find "$GZ" -name '*.bin' | wc -l | tr -d ' ') tiles, $(du -sh "$GZ" | cut -f1) gzipped"

aws s3 sync "$GZ" "$DEST" --delete "$@" \
  --content-type application/octet-stream \
  --content-encoding gzip \
  --cache-control 'public, max-age=86400'
