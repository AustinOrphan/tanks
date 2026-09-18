# Board Forge — prototype source

A phone-friendly editor for Tanks! versus arenas: paint a board with a thumb, watch it
measured live against the eight shipped boards, roll one from the `spines` rule set, and
export it as a grid or an `arenas.json` entry.

**This branch exists only so the source survives.** It is an orphan branch with no history in
common with `main`, and nothing here is built, tested, linted or shipped. The tool is
deliberately *not* part of this repository — see issue #825, which defers it to the product
version and carries the feature list as its specification.

## Why it is here rather than in `main`

It was written as a published Claude Artifact, and its working copy lived in a scratch
directory that is deleted with the session that made it. One copy in one place is not storage.
This branch is the second copy.

## What it does

- Touch painting on a cell grid: solid, destructible, erase, and spawn markers.
- Symmetry while painting: mirror on either axis or both, and radial ×2, ×3, ×4, ×6, with the
  inscribed circle drawn for N > 2 because a rectangle cannot hold N-fold symmetry outside it.
  "Fold board" stamps one sector over the rest, so an existing board can be re-symmetrised.
- Board sizes: the four shipped sizes as presets, plus ± steppers from 11×9 to 61×45 that keep
  whatever still fits rather than blanking the board.
- Live measurement against the calibration bands from `tools/mapgen/calibrate.mjs`: wall
  fraction, destructible share of wall mass, tank-legal area, corridor share, open ground,
  bottleneck width, direct-view fraction, bank-shot offer, rotational asymmetry.
- A verdict line covering reachability and opening shots, including the one-bounce line that
  `allPairsConcealed` does not check.
- Boards saved to the artifact's own store, so they persist and can be read back into the repo.

## The part that must be fixed before it is a real tool

**Every measurement here is a re-port, and a port drifts.** The page reimplements the
tank-legal lattice, the solid-run merge, `reflectSweep` and the measures in browser JavaScript
at reduced resolution — a coarser lattice and 180 rays rather than 720 — for phone speed. The
UI says so on screen. A product version must run the real `src/sim` modules, the same ones
`tools/mapgen/measure.ts` imports, rather than a second copy free to disagree with the game.
The same goes for the spawn derivation, which approximates `pickVersusSpawnCell`, and for the
verdict, which approximates `evaluateVersusBoard`.

**Spawn placement is a what-if.** The game derives every versus spawn from the board's
geometry and ignores the authored letter's position entirely — moving `P` from one corner to
the other produces byte-identical starts (measured; see `tools/mapgen/lib.mjs`). Hand-placed
spawns answer "how would this board measure if players started here", which is the right
question while authoring and the wrong one for predicting a match. The page distinguishes the
two modes and draws them differently.

## Running it

It is a single self-contained HTML file with no build step, but it expects the Claude Artifact
runtime for one thing only: `claude.use("db")`, for saving boards. Opened as a plain local
file it works fully except that saving is disabled and says so.
