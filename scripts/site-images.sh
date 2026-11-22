#!/bin/sh
# Makes the website's screenshots from the README ones: each
# docs/screenshots/<name>.png becomes lossless WebPs in site/img, at full
# width and at 1000px for small screens. Needs cwebp (brew install webp).
set -eu
cd "$(dirname "$0")/.."
for png in docs/screenshots/*.png; do
  name=$(basename "$png" .png)
  cwebp -quiet -lossless -z 9 "$png" -o "site/img/$name.webp"
  cwebp -quiet -lossless -z 9 -resize 1000 0 "$png" -o "site/img/$name-1000.webp"
  echo "wrote site/img/$name.webp"
done
