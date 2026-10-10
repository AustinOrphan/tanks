#!/bin/sh
# Compose the ordnance-fire frames as #1018 published them: per tick, the 320x330+300+130 crop of
# the shipped, --enemyRole both, and --enemyRole both --motion reduced runs, side by side.
# Usage: compose-ordnance.sh <shipped dir> <both dir> <reduced dir> <out dir>
set -eu
a="$1"; b="$2"; c="$3"; out="$4"
mkdir -p "$out"
for t in 40 52 79 92; do
  f="frame-00$t.png"
  ffmpeg -v error -y -i "$a/$f" -i "$b/$f" -i "$c/$f" -filter_complex \
    "[0:v]crop=320:330:300:130[a];[1:v]crop=320:330:300:130[b];[2:v]crop=320:330:300:130[c];[a][b][c]hstack=inputs=3" \
    "$out/ordnance-fire-t$t.png"
  echo "wrote $out/ordnance-fire-t$t.png"
done
