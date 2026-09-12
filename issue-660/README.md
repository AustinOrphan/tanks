# Issue #660 — one weight, one size, across four shapes

## `normalisations-overlaid.png`

The three candidate normalisations, drawn from the real geometry and superimposed at scale.
Grey disc is the tank (r 0.50); thin rings are the solid ring these replace (0.65–0.80).

| | triangle's edges | triangle's corners |
| --- | --- | --- |
| **A** shared circumradius | **0.44** — inside the tank, the hull ate them | level with the circle |
| **B** shared mean radius | 0.59 — clear | **1.17** — 2.35× the tank, dominates |
| **C** shared apothem | 0.88 — level | ~1.76 — 3.5× the tank |

A triangle cannot match a circle on both axes at once. Both formulas produce a number that
is equal and does not look it.

## `mean-vs-tuned.png`

B against the shipped answer: sizes tuned per shape against a CONSTRAINT — every edge clears
the tank by at least 0.05, corners as close to level as that allows. Circle 0.880, square
0.930, triangle 1.100, starburst 0.990.

## `game-camera-progression.png`

Three rows at the real camera: shipped, mean-radius, tuned. The middle row is where the
triangle takes over; the bottom is the balance.

## The ink correction, separately

`bandGeometry` places both edges at the same vertex ANGLES, so a polygon's edges are chords
and the perpendicular gap between them is the gap between apothems, `band * cos(PI/n)`:
circle 0.1497, square 0.1061, **triangle 0.0750**. Four shapes drawn to one number, read at
four weights. Dividing by `cos(PI/n)` equalises them.
