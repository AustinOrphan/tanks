# Arenas as data: validated JSON grids with declarative design claims

Approved 2026-08-01. The successor to the 2026-07-31 maps pass, which deferred variable
arena dimensions "until map-validation tooling has proved itself" — this is that tooling.
Unblocked by PR #53 (per-level render refit), which deleted the fixed-board-size test and
gave `levels.ts` a per-level `bounds()`.

Decisions taken with the user: the driver is a **foundation for authored content**, not a
consistency port — adding a level should be editing data with fast feedback. Design intent
becomes **declarative claims in the JSON**, verified by one generic runner, so a new level
costs no hand-written TypeScript. Variable dimensions are **proven by a test fixture and
the gl harness**, not by resizing shipped levels. The authoring loop is **vitest plus a
readable diagnostic report** — no new CLI. Arenas join the existing config module as its
third family, in a **single ordered file**.

## What ships

1. **`src/sim/config/data/arenas.json`** — an ordered array; array order IS level order, so
   there is no parallel index to drift. Each entry: `id`, `cols`, `rows`, `cellSize`,
   `legend`, `grid`, `notes`, `claims`. `ARENA_01/02/03` port unchanged in content.
2. **`validateArenas()`** in `src/sim/config/validate.ts`, reusing `exactKeys`/`oneOf`/
   `nonNegInt` and the same negative-control discipline as the tank and profile validators.
3. **The claim vocabulary** — three types, each derived from a bespoke test that exists
   today, plus a generic runner that verifies every arena's own claims.
4. **A differently-sized fixture arena** (15×11), exported from a test-support module
   (`src/sim/config/arena-fixtures.ts`) so both the vitest suites and the gl harness import
   the same definition. It runs through `validateArenas` and the claim runner, and the gl
   harness renders it in a real browser — the proof that per-level refit really handles a
   different board. It is never in `ARENAS`, so it cannot reach the shipped sequence.
5. **`arena.ts` keeps every export it has today** (`loadArena`, `createWorldFor`,
   `arenaBounds`, `ARENAS`, and `ARENA_01/02/03` as named lookups), so no consumer outside
   it changes: `levels.ts`, the gl harness, the gallery and dozens of tests are untouched.

## Schema

```json
{ "arenas": [
  { "id": "arena-01",
    "cols": 11, "rows": 9, "cellSize": 2,
    "legend": { "#": "solid", "x": "destructible" },
    "grid": ["...........", "..#.....#..", "..#.B.G.#.."],
    "notes": ["Centre block sits on the Teal->player line, so Teal must bank.",
              "Col-5 row-5 is cover depth: without it both direct lines graze corners."],
    "claims": [{ "type": "spawnBlockRobust", "nudge": 0.1,
                 "why": "The col-5 row-5 cell exists to make both browns' blocks chords, not tangencies." }] } ] }
```

The `grid` carries BOTH wall characters (mapped by `legend`) and spawn letters (`P`, `B`,
`G`, `T`, `O`), exactly as today: `loadArena` resolves spawn letters through its own
`SPAWN_KINDS` table, and `legend` covers walls only. `.` is open floor.

`notes` is deliberate. The roster port lost a load-bearing comment (BANK_SHOT_AIM is
descriptive, not a gate) and review had to catch it. Arena rationale is longer and
harder-won, so it travels WITH the data instead of being stranded in a file that no longer
holds the grid. Each claim additionally carries its own `why`, attaching rationale to the
property it protects.

Splitting to one file per arena later is mechanical — every element already has its
identity. Starting there would put `import.meta.glob` inside the pure sim to solve a
problem with three instances of it.

## Claim vocabulary

Points are named as an author thinks: a grid cell `[col, row]`, or `"player"` resolving to
the player spawn.

**`sightlineAfterBreach`** — with every destructible destroyed, whether an enemy spawn can
see the player spawn. `from` must be a cell holding an enemy spawn (the validator checks
this at load, so a claim pointing at empty floor is a boot failure, not a silent pass).
Covers ARENA_02's "opens exactly the two upper lanes" and ARENA_03's "0 of 5" in one type.

```json
{ "type": "sightlineAfterBreach", "from": [1,2], "sees": true,
  "why": "Blowing the bar's inner end is the level's trade: it opens this lane both ways." }
```

**`lane`** — a line between two points, blocked while intact and open once breached, or the
reverse. Covers ARENA_03's flank lanes.

```json
{ "type": "lane", "from": [1,1], "to": [1,7], "intact": "blocked", "breached": "open",
  "why": "The olive's shield is the only wall on its column." }
```

**`spawnBlockRobust`** — the no-spawn-sightline rule survives player-position nudges of
±`nudge`, so a block is a real chord rather than a corner tangency.

```json
{ "type": "spawnBlockRobust", "nudge": 0.1,
  "why": "ARENA_01's documented knife edge: with row 4 alone a 0.1-unit nudge opened a lane." }
```

The third type is the payoff: the tangency defect shipped in ARENA_03's first draft, caught
by slab math in review, becomes a property every arena is checked against automatically
instead of a lesson someone has to remember.

Universal rules stay universal and un-claimed: loads clean, exactly one player spawn, at
least one enemy, every breachable cell mutually reachable, and no enemy sightline to the
player spawn at spawn. Claims are only the per-arena extras. An arena with no claims is
valid.

## Validation split

**Load time** (`validateArenas`, O(cells)): dimensions are positive integers,
`grid.length === rows`, every row's length equals `cols`, every character is in the legend
or a spawn kind or `.`, legend values are real `WallKind`s, ids unique, exactly one player
spawn, at least one enemy, every claim well-formed with in-bounds cells. A bad edit is a
boot failure naming `arenas[2].grid[4]`.

**Test time** (the generic runner): flood fills, LOS sweeps, breach permutations, nudge
probes. These need `lineOfSight`, so they live in the test layer — dragging the AI layer
into `config/` to save milliseconds at boot would be a bad trade, and the purity guard
watches that boundary.

On failure the runner prints the annotated board: the offending line drawn across the grid,
spawns marked, the claim's `why` quoted. A red test says which cell betrayed the design,
not merely that a boolean flipped. `npx vitest watch` on that one file is the authoring
loop.

## Testing

- **Validator negative controls**, one per check, against corrupted copies of the shipped
  file — the discipline the tank/profile validators already carry.
- **Runner meta-tests**: a fixture arena with a deliberately FALSE claim of each of the
  three types must fail, and fixtures violating each universal rule (sealed pocket, two
  player spawns, spawn sightline) must fail. Without these, a runner that silently passes
  everything is indistinguishable from a clean board — the purity guard passed four of five
  known-bad probes before it got a meta-test.
- **Both existing bespoke describe blocks are deleted** and re-expressed as claims. That is
  itself the migration's proof: same properties, same pass/fail, no hand-written geometry
  left.
- **`sandbox.ts` stays programmatic** (it is parameterized by query flags and can never be a
  static file) and gains a test asserting its generated output passes the same structural
  validator.

## Migration fidelity

The standing net is already in place: `determinism.test.ts` replays seeded games on
`ARENAS[0]`, `arena.test.ts` asserts specific wall AABBs and counts, `levels.test.ts` builds
worlds from every entry, and the pacifist suite runs 60 seeded games. A single drifted cell
changes trajectories and fails them.

On top of that, a one-time deep-equal of the loaded catalog against the pre-port TS literals
runs in the working tree during the port, and its result is reported in the PR. It is not
committed: keeping the literals forever would recreate the duplicate source of truth this
change removes.

## Out of scope

Modding or externally-loaded maps; procedural generation; per-arena visual theming;
level-select changes; any new shipped level; resizing any shipped level. The schema should
not block the first two, but nothing here builds toward them.
