#!/bin/sh
# Derived figures for the #1040 evidence: nearest-neighbour enlargements of the measured frames
# (no new pixels). Run from this folder: sh scripts/crops.sh [folder]
set -eu
D=${1:-.}
for m in shape ring; do
  for f in cue footprints; do
    ffmpeg -loglevel error -y -i "$D/$m-$f.png" -vf "crop=400:110:120:190,scale=800:220:flags=neighbor" "$D/$m-$f-band-2x.png"
  done
  ffmpeg -loglevel error -y -i "$D/$m-footprints.png" -vf "crop=110:90:215:190,scale=660:540:flags=neighbor" "$D/$m-footprints-slot1-6x.png"
  ffmpeg -loglevel error -y -i "$D/$m-cue.png" -vf "crop=110:90:215:190,scale=660:540:flags=neighbor" "$D/$m-cue-slot1-6x.png"
done
