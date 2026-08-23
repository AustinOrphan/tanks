---
status: completed
date: 2026-07-31
last-reviewed: 2026-08-23
scope: Linear level progression, a second hand-authored arena, a parameterized dev sandbox, disarm-as-sim-data, and arena registry validation.
implementation-issues: []
implementation-prs: [43]
supersedes: []
superseded-by: []
---
# Maps pass 1: linear progression, a second level, and a parameterized dev sandbox

Approved 2026-07-31. Decisions taken with the user: linear progression now (level-select
menu is a separate, later todo); the dev sandbox holds a player plus one of each enemy
kind with their weapons disabled, parameterized by query; ONE new hand-authored level;
procedural generation of real levels deferred until map-validation tooling has proved
itself.

## What ships

1. **Linear progression.** Clearing a level advances to the next with lives carried
   over; clearing the last level shows the final win screen; Game Over resets to level 1.
   The win panel reads "Level N cleared" with a Next button; the HUD shows `Level N/M`.
   `?dev=1&level=2` jumps to a level directly.
2. **`ARENA_02`.** Hand-authored, same 11x9 grid as level 1 — deliberately: the renderer
   sizes its ground plane from the arena at construction, and per-level renderer rebuild
   touches the riskiest wiring in the codebase (`loop.ts` composition). Variable arena
   sizes are OUT OF SCOPE this pass.
3. **Dev sandbox.** `?dev=1&level=sandbox`: open 11x9 floor (boundary walls only),
   player + one of each enemy kind, all enemies disarmed. Knobs, parsed only in
   `game/devflags.ts`: `tanks=brown,grey,teal,...` (any multiset), `disarmed=0` to
   re-arm, `walls=random:N` for N seeded interior obstacles. Never in the shipped
   sequence.
4. **Disarm as sim data.** `Tank.disarmed?: boolean`; the AI's fire and mine decisions
   respect it. Optional field, so no fixture churn; deterministic and replay-safe. One
   flag covers both shells and mines (user's choice).
5. **Registry validation suite.** Every arena in `ARENAS` (and sandbox output) must:
   load clean, have exactly one player spawn and at least one enemy (shipped arenas),
   have every open cell mutually reachable (flood fill — catches sealed pockets), and
   have a player-to-enemy path.

## Architecture

- `src/sim/arena.ts`: `ARENAS: Arena[]` (shipped order), `createWorldFor(arena, seed?,
  unarmedTrigger?)`; `createArenaWorld` delegates to it with `ARENAS[0]` so existing
  callers and tests are untouched.
- `src/sim/sandbox.ts`: pure `buildSandbox(opts)` -> `{walls, tanks, spawns}`. Options
  are plain data; the QUERY PARSING lives in the game layer. Runtime flags never enter
  `src/sim/` — parsed results enter as world-construction data, the same route `seed`
  takes today.
- `src/game/`: the level index lives here, not in the sim (the sim is
  one-arena-per-world). `loop.ts`'s injected `createWorld` becomes arena-aware;
  `state.ts` gains the advance/reset transitions; the HUD gains the level line.

## Out of scope

Variable arena dimensions, per-tank sandbox positioning, procedural real levels,
level-select menu, separate canFire/canMine flags.
