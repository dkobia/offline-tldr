#!/usr/bin/env bash
# Regenerates the committed extension icon PNGs from the icon SVGs.
# Run after editing images/offline-tldr-icon.svg or images/offline-tldr-icon-16.svg.
# Requires rsvg-convert (brew install librsvg).
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p images/icons

# 16 px comes from the hand-tuned small variant; larger sizes from the icon mark.
rsvg-convert -w 16 -h 16 images/offline-tldr-icon-16.svg -o images/icons/icon-16.png
rsvg-convert -w 32 -h 32 images/offline-tldr-icon.svg -o images/icons/icon-32.png
rsvg-convert -w 48 -h 48 images/offline-tldr-icon.svg -o images/icons/icon-48.png
rsvg-convert -w 128 -h 128 images/offline-tldr-icon.svg -o images/icons/icon-128.png

echo "rendered images/icons/icon-{16,32,48,128}.png"
