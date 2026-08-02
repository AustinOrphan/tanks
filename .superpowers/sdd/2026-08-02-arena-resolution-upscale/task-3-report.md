# Task 3 report: remap the `notes` prose

Scope: `src/sim/config/data/arenas.json`, `notes` arrays only. Base commit `bb1523e`.

## 0. Population

The brief's own regex (`\(\d+,\s*\d+\)|column \d+|row \d+|columns \d+-\d+|rows \d+-\d+`)
run against the base commit's `notes` finds **29** matches (arena-01: 6, arena-02: 1,
arena-03: 2, arena-04: 20 — note the brief's headline count of "roughly 22" for arena-04
and "32" overall was an estimate, not a re-run of the script). That regex also **misses
real stale coordinates** written in hyphenated form (`row-4`, `column-11`), the
`columns 4 and 10` / `columns 5, 7 and 9` list forms, and the `NxM` board-dimension
notation (`11x9`, `15x11`) — none of which match `column \d+` or `row \d+` literally.

I hand-scanned every note sentence (not just regex hits) and treated the true population
as **every stale old-resolution reference in the notes prose**, which is larger than the
regex population. Counting every distinct old-resolution number I found and fixed (single
cells, ranges, hyphenated forms, list forms, and the two board-dimension pairs), across
all four arenas' notes:

- arena-01: 4 notes touched, all 4 rewritten (dropped 6 stale numbers, replaced with
  feature names — 0 numeric coordinates remain)
- arena-02: 1 note touched (1 stale row + 1 stale 3-item column list, replaced with
  feature language)
- arena-03: 3 notes touched (dropped/converted 7 stale numbers across a column pair, a
  row pair with slash notation, and a single row)
- arena-04: 7 of 8 notes touched (note[7] has no coordinate content and was left alone);
  converted or feature-named roughly 30 stale tokens including the two `NxM` board-size
  numbers, `row-4`/`column-11` hyphenated forms, and the `columns 5, 7 and 9` list

Population for "population of coordinate mentions across all four arenas' notes, by the
brief's own regex": 29. Population by hand-scan (what I actually found and fixed,
including forms the regex misses): approximately 44 individual stale tokens. I did not
keep a token-by-token tally as I went (many were rewritten as ranges or dropped in favor
of feature names, so a single old sentence sometimes maps to zero new numbers), so this
second figure is an estimate from re-reading my own diff, not a count from a script —
treat it as an order of magnitude, not an exact denominator.

## 1. Before / after table

### arena-01 (4 of 4 notes changed)

| # | Before | After |
|---|---|---|
| 0 | "Player bottom (row 7), Brown+Grey+Teal across the top (rows 2-3)" | "Player at the bottom, Brown+Grey+Teal across the top" — feature-named, dropped |
| 1 | "The centre solid block (col 5, row 4)" | "The centre pillar" — feature-named, dropped |
| 2 | "The solid cell at (col 8, row 5) ... through the row-4 gap ... through rows 6-7" | "The east pillar ... by going around it ... reach the player beyond" — feature-named, dropped |
| 3 | "Cover depth (col 5, row 5): with the row-4 block alone ... The second cell" | "Cover depth: the centre pillar's lower tier. With the upper tier alone ... The lower tier" — feature-named (upper/lower tier), dropped |

### arena-02 (1 of 2 notes changed)

| # | Before | After |
|---|---|---|
| 0 | "row 4 is a FULL destructible barrier with solid anchors (cols 1, 5, 9)" | "the bar is a FULL destructible barrier with three solid anchors" — feature-named, dropped |

### arena-03 (3 of 4 notes changed)

| # | Before | After |
|---|---|---|
| 1 | "Each flank column (1 and 9)" | "Each flank column (4 and 28)" — kept, corrected (matches the `lane` claims' columns) |
| 2 | "The row-3/row-4 anchors ... row-4/row-5 centre pillar -- the row-5 cell exists for ARENA_01's reason: with row 4 alone" | "The north anchors ... the centre pillar -- the pillar's lower tier exists for ARENA_01's reason: with its upper tier alone" — feature-named, dropped |
| 3 | "The centre peek 'x' (row 6)" | "The centre peek 'x' (rows 18-20)" — kept, corrected (single old row -> 3-row range) |

### arena-04 (7 of 8 notes changed)

| # | Before | After |
|---|---|---|
| 0 | "not 11x9: 15x11" | "not 33x27: 45x33" — kept, corrected (matches `cols`/`rows` fields) |
| 1 | "across row 1, behind the row-4 bar ... down column 13 ... the solid column-11 wall" | "across row 4, behind the bar ... down column 40 ... the solid east wall" — row/column kept & corrected, "row-4 bar" and "column-11 wall" feature-named |
| 2 | "The green at (3, 1) ... columns 2-10, rows 5-10 ... row-4 bar ... Column 3 and not 4: from column 4" | "The green at (10, 4) ... one broad region, NOT a tidy corner ... the bar ... Column 10 and not 13: from column 13" — spawn coordinate and the two design-decision columns kept & corrected; the region bounding box feature-named (see §3); coverage counts (35/151, 29, 20, 44) left untouched (see §4) |
| 3 | "Cell (7, 7) ... row-4 bar's shadow ... teal at (13, 4) ... row-5 corridor ... Cell (9, 7), two cells east ... column-11 wall ... column 8's gap" | "Cell (22, 22) ... bar's shadow ... teal at (40, 13) ... corridor below the bar ... Cell (28, 22), six cells east ... east wall ... the bar's gap at column 25" — load-bearing cell coordinates kept & corrected (they equal the `lane` claims' `to`/`from` fields); "row-5 corridor" and "column-11 wall" feature-named; "two cells" corrected to "six cells" (2 old cells = 6 new cells) |
| 4 | "row-4 bar is porous (open at columns 0-2, 6, 8, 12-14) and breachable at columns 4 and 10; the column-11 wall is solid throughout (rows 4, 6, 7, 8) ... row 5 above it or rows 9-10 below it ... rows 0-3" | "The bar is porous, solid only in alternating segments, and breachable at columns 13 and 31; the east wall is solid throughout except for one corridor gap ... the corridor above it or the open rows below its south end ... north of the bar" | feature-named the detailed porosity/row enumeration (see §3); kept & corrected the two breach columns (13, 31), which are load-bearing (match the two breach `lane` claims) |
| 5 | "Blowing the bar at column 10 ... brown at (10, 1) a line down to row 9 ... solid cells at columns 5, 7 and 9" | "Blowing the bar at column 31 ... brown at (31, 4) a line down to row 28 ... the bar's solid anchors" — breach column, spawn coordinate and target row kept & corrected; the three-item blocker-column list feature-named (this is the brief's own worked example) |
| 6 | "destructible at (6, 6) ... teal at (13, 4) a line onto (5, 7)" | "destructible at (19, 19) ... teal at (40, 13) a line onto (16, 22)" — kept, corrected (all three match `lane` claim endpoints) |
| 7 | (unchanged — no coordinate content, see §4) | (unchanged) |

## 2. Grid lookups proving the new coordinates (6+ across 3+ arenas)

```
$ python3 -c "
import json
d = json.load(open('src/sim/config/data/arenas.json'))
g = {a['id']: a['grid'] for a in d['arenas']}
checks = [
  ('arena-01', 13, 16, 'centre pillar upper tier -> should be solid'),
  ('arena-01', 16, 25, 'east pillar reflector -> should be solid'),
  ('arena-02', 13, 16, 'bar middle anchor -> should be solid'),
  ('arena-03', 4, 28, 'east olive spawn -> should be O'),
  ('arena-03', 19, 16, 'centre peek destructible -> should be x'),
  ('arena-04', 4, 10, 'green (letter N) spawn -> should be N'),
  ('arena-04', 12, 31, 'bar east breach point -> should be destructible x'),
  ('arena-04', 20, 34, 'east wall -> should be solid'),
]
for id_,r,c,label in checks:
    print(id_, f'grid[{r}][{c}] =', repr(g[id_][r][c]), '--', label)
"
arena-01 grid[13][16] = '#' -- centre pillar upper tier -> should be solid
arena-01 grid[16][25] = '#' -- east pillar reflector -> should be solid
arena-02 grid[13][16] = '#' -- bar middle anchor -> should be solid
arena-03 grid[4][28] = 'O' -- east olive spawn -> should be O
arena-03 grid[19][16] = 'x' -- centre peek destructible -> should be x
arena-04 grid[4][10] = 'N' -- green (letter N) spawn -> should be N
arena-04 grid[12][31] = 'x' -- bar east breach point -> should be destructible x
arena-04 grid[20][34] = '#' -- east wall -> should be solid
```

All 8 match. (30 such checks were actually run before writing the final text; these 8
are a representative sample spanning all 4 arenas.) Note the green spawn is grid letter
`N`, not `G` — `G` is already taken by grey; `sandbox.ts` documents this ("`N` because
grey already holds `G`").

## 3. Feature-naming rewrites (coordinate not load-bearing)

- **arena-01 note[0]**: player/spawn rows were pure scene-setting, not referenced by any
  claim or test. Rewritten to "Player at the bottom, Brown+Grey+Teal across the top."
- **arena-01 notes[1]-[3]**: "centre solid block"/"the second cell" already named the
  feature; the parenthetical coordinates were redundant with the naming. Introduced
  consistent "centre pillar" / "upper tier" / "lower tier" / "east pillar" vocabulary
  that survives future resolution changes.
- **arena-02 note[0]**: "solid anchors (cols 1, 5, 9)" — the sentence's content is "the
  bar has three fixed choke points," not the specific columns. Rewritten to "three solid
  anchors."
- **arena-03 note[2]**: "row-3/row-4 anchors" is a two-tier wall structure the sentence
  only needs to say "denies diagonal fire" — renamed to "the north anchors."
- **arena-04 note[1], [3], [4]**: "row-4 bar" / "column-11 wall" renamed to "the bar" /
  "the east wall" throughout, once introduced. These aren't just imprecise — the old
  numbers are now **actively false** for the current grid (there is no wall at new column
  11; `grid[20][11] == '.'`), so this wasn't optional polish.
- **arena-04 note[2]**: "one broad region across columns 2-10, rows 5-10" — I did **not**
  attempt to state new bounds. The bounding box of unseen cells is a computed property of
  line-of-sight raycasting against the new, finer grid; I have no way to verify a new
  bounding box by reading `grid[row][col]`, and guessing one would be exactly the kind of
  unverified claim this task exists to avoid. Rewritten to "one broad region, NOT a tidy
  corner," which stays true without asserting geometry I haven't computed.
- **arena-04 note[4]**: the itemized porosity list ("open at columns 0-2, 6, 8, 12-14")
  and the wall's per-row solidity list ("rows 4, 6, 7, 8") were compressed to "porous,
  solid only in alternating segments" / "solid throughout except for one corridor gap" —
  the itemization added detail the sentence doesn't need to make its point (bar=breachable,
  wall=flank-only), and each one would otherwise expand into an unwieldy multi-range list
  under 3x.
- **arena-04 note[5]**: "the bar's solid cells at columns 5, 7 and 9" — this is the exact
  sentence the task brief quotes as its worked example. Rewritten to "the bar's solid
  anchors."

## 4. Known residuals — explicitly NOT fixed, and why

**A. Claims' `why` text still carries old-resolution coordinates.** The task scope was
"notes only," and I kept to that. But while cross-checking the notes I found the `claims`
arrays' `why` prose (which I was told not to touch) has the **same problem** — e.g.
arena-04 `claims[0].why` says "the bar's solid cell at column 3" and "column 4," but that
claim's own `from` field is `[10, 4]` (new resolution) and the corresponding note (which
I did fix) now correctly says "Column 10 and not 13." Other examples: `claims[1].why`
says "column 7" (should read as new-resolution 22), `claims[3-5].why` say "row 6"/"row
7"/"row 8" for the east wall (should be new-resolution ranges). **This is very likely an
oversight in how "notes only" was scoped** — the orchestrating brief probably didn't
realize the claims' prose has the identical defect. I did not touch it per the explicit
instruction, but it should not be read as fixed.

**B. arena-04's coverage statistics are stale and are Task 4's job, not mine.**
"35 of the 151 open cells," "29 cells," "20 of those," "20 of the 35," and (in note[7])
"35/86 = 40.7%," "41/83 = 49.4%," "30/88 = 34.1%" are all old-resolution
line-of-sight-simulation outputs. I verified two of these are literally pinned by
currently-failing tests:

```
$ npx vitest run src/sim/arena-validation.test.ts
 × the cover ratio each arena quotes in its notes > recomputes every quoted count...
   → arena-01: expected { unseen: 288, open: 774 } to deeply equal { unseen: 35, open: 86 }
 × green's bank reach, which is why it is in level 4 > reaches 29 cells...
   → expected { bankOnly: 275, open: 1359 } to deeply equal { bankOnly: 29, open: 151 }
```

These two tests are 2 of the 14 pre-existing failures. I cannot recompute correct values
by reading the grid (they require running the AI's line-of-sight raycaster), and the
brief explicitly told me not to fix the 14 failures. Left byte-identical.

**C. The "44 cells" figure (arena-04 note[2])**, describing the *rejected* column-4
sniper placement, is not pinned by any test (only the shipped column-10 placement's stats
are tested) and I have no way to recompute it either. Left as-is; flagging that unlike (B)
it may not get fixed by Task 4 since no test currently depends on it.

## 5. Grids, claims, cellSize — byte-identical to Task 2's output

```
$ git diff --stat bb1523e -- src/sim/config/data/arenas.json
 src/sim/config/data/arenas.json | 30 +++++++++++++++---------------
 1 file changed, 15 insertions(+), 15 deletions(-)
```

15 changed lines. Every changed line is a string inside a `notes` array — confirmed by
inspecting the diff hunks: each hunk is bounded by a `"notes": [` context line and the
changed lines are the note strings themselves. No `grid`, `claims`, `cellSize`, `cols`,
or `rows` line appears in the diff.

## 6. Test failure count, before and after

Before (baseline at `bb1523e`, re-run from a clean tree):
```
Test Files  6 failed | 64 passed | 1 skipped (71)
     Tests  14 failed | 1208 passed | 1 skipped (1223)
```

After (with the notes edits applied):
```
Test Files  6 failed | 64 passed | 1 skipped (71)
     Tests  14 failed | 1208 passed | 1 skipped (1223)
```

Identical: same 6 failing files, same 14 failing tests, same 1208 passing. `npx tsc
--noEmit` exits 0 both before and after (JSON-only change, no type surface affected).

## Commit

```
git commit -m "arenas: remap old-resolution coordinates in notes prose to the 3x grid"
```
