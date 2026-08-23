---
status: active
date: 2026-08-23
last-reviewed: 2026-08-23
scope: Continuous hull clearance for VS spawn candidates (walls, boundaries, pairwise), with diagnostics and shipped-behaviour parity
implementation-issues: [225]
implementation-prs: []
supersedes: []
superseded-by: []
---
# VS spawn clearance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** VS spawn candidates guarantee continuous hull clearance — from every intact
wall AABB, from the arena boundary, and pairwise from already-placed spawns — with a
diagnostic function naming any violation and total (no-throw) degradation when a board
cannot satisfy the rule (issue #225).

> **CORRECTED DURING EXECUTION (2026-08-23).** The original plan claimed shipped boards
> could not feel the bound and demanded byte-identical parity, derived from "shipped
> arenas are `cellSize 2`". Measured: shipped arenas are **`cellSize 2/3`** (the
> arena-geometry spec's 3x upscale landed in PR #75), and the pre-fix picker really does
> anchor arena-01's 2-player P1 at (0.333, 0.333) — a 0.5-radius hull overlapping the
> boundary by 0.167. The issue's clipping premise is live on shipped boards, spawns are
> SUPPOSED to move, and the parity constraint below is replaced by: (a) the shipped
> sweep measures 0 clearance violations post-filter, and (b) `versus-board`'s
> 15-of-15 suitability sweep (separation, full concealment, room) still passes on the
> moved spawns — both re-measured live by the suites, not asserted here.

**Architecture:** A clearance predicate inside `versus-spawns.ts` filters the candidate
pools of `pickVersusSpawnCell` and `pickVersusSpawnSet` before the existing LOS/maximin
ranking (which is preserved untouched over the filtered pool). An exported
`versusSpawnClearanceFailures` diagnostic reports violations for already-picked
positions — the function #270's `spawn-clearance` catalog seam consumes once both PRs
land. Fallback: an emptied pool degrades to the unfiltered pool (same total posture as
the existing zero-candidate fallback); CI-time validation is what makes that unreachable
for advertised combinations.

**Tech Stack:** TypeScript, vitest, `tools/mutate` manifest.

**Spec:** GitHub issue #225. Binding context:
`docs/superpowers/specs/2026-08-02-arena-geometry-design.md` (the 0.65 free-point
clearance threshold this margin aligns with),
`docs/superpowers/plans/2026-08-17-versus-spawns.md` (picker structure and total-degradation
posture), `docs/superpowers/plans/2026-08-18-versus-p1-maximin.md` (P1 in the maximin set).

## Global Constraints

- `src/sim/` purity; no throw on any picker path (total functions, graceful degradation).
- REPLACED (see correction above): shipped spawns MOVE off walls and boundaries — that is
  the fix. The binding constraints are 0 measured violations on all 15 shipped
  combinations post-filter, `versus-board` suitability still 15 of 15, and every moved
  test pin updated deliberately with its re-measured value named in the change.
- Margin: `VERSUS_SPAWN_CLEARANCE_MARGIN = 0.15`, derived as the geometry spec's 0.65
  free-point threshold minus `TANK_RADIUS` (0.5). Configurable as a parameter with this
  default — not a balance.json field (no caller needs runtime configuration; a data field
  would touch the validated-balance schema for nothing).
- Wall clearance measures INTACT walls including destructibles (a destructible blocks a
  hull at the instant of spawning); variant semantics come free because every caller
  already passes the match-start (variant-applied) grid.
- Existing LOS hard filter and geodesic maximin are applied AFTER invalid candidates are
  removed, unchanged.
- Every new assertion needs a named negative control; key checks get mutation evidence.

---

### Task 1: Clearance predicate, margin constant, and the diagnostic function

**Files:**
- Modify: `src/sim/versus-spawns.ts`
- Test: `src/sim/versus-spawns.test.ts` (append a clearance describe-block)

**Interfaces:**
- Produces: `VERSUS_SPAWN_CLEARANCE_MARGIN = 0.15`;
  `hasSpawnClearance(centre: Vec2, walls: readonly Wall[], boundsW: number, boundsH:
  number, avoid: readonly Vec2[], margin?: number): boolean` (module-private predicate,
  exercised through the exported functions);
  `versusSpawnClearanceFailures(grid: string[], cols: number, rows: number, cellSize:
  number, legend: Record<string, WallKind>, positions: readonly Vec2[], margin?:
  number): string[]` — one line per violation:
  `spawn[i] at (x, y): <wall|boundary> clearance <d> < <required>` or
  `spawn[i]..spawn[j]: pairwise distance <d> < <required>`.

- [ ] **Step 1: Failing tests.** Fixtures at `cellSize 1` (so cell centres sit 0.5 from
  adjacent wall faces, under the 0.65 requirement — the discriminating regime shipped
  boards never enter):
  - wall: a position 0.5 from a wall AABB fails naming the wall distance; the same
    position with the wall absent passes (negative control).
  - boundary: a centre 0.5 from the arena edge fails as `boundary`; a centre 0.65+ in
    passes.
  - destructible-at-match-start: a position 0.5 from an intact destructible fails; on a
    variant grid with that cell removed the same position passes.
  - pairwise: two positions 1.0 apart fail as a pair (< 1.15); 1.2 apart pass.
  - determinism: same inputs twice → deep-equal failure lists.
  - clean case: a roomy fixture returns `[]`.
- [ ] **Step 2: Run to verify failure** (function not exported).
- [ ] **Step 3: Implement.** Point-to-AABB distance (`max(min-x-x, x-max-x, 0)` per axis,
  hypot of the two), boundary distance `min(x, y, W-x, H-y)`, pairwise Euclidean; wall
  requirement `TANK_RADIUS + margin`, pairwise requirement `2*TANK_RADIUS + margin`.
  `wallsForQuery` builds the AABBs (already includes intact destructibles).
- [ ] **Step 4: Green; `npm run verify:quick`.**
- [ ] **Step 5: Commit** `vs-clearance: hull-clearance predicate and diagnostics` and push.

### Task 2: Filter the candidate pools; parity and degradation proofs

**Files:**
- Modify: `src/sim/versus-spawns.ts` (`pickVersusSpawnCell`, `pickVersusSpawnSet`)
- Test: `src/sim/versus-spawns.test.ts`

**Interfaces:**
- Consumes: Task 1's predicate.
- Produces: both pickers gain a trailing `opts?: { clearanceMargin?: number | null }`
  (default `VERSUS_SPAWN_CLEARANCE_MARGIN`; `null` disables the filter — the parity
  control's seam and nothing else's). Candidate eligibility: open floor AND wall/boundary
  clearance AND pairwise clearance vs `avoid`. If the clearance-eligible pool is EMPTY,
  fall back to the unfiltered pool (the existing degradation posture; never throw).
  `pickVersusSpawnSet`'s anchor candidates get the wall/boundary test (no `avoid` yet);
  the greedy chain and relax passes inherit everything through `pickVersusSpawnCell`.

- [ ] **Step 1: Failing tests.**
  - cramped corridor (`cellSize 2/3`, a 2-cell corridor): every centre is 0.333 from a
    wall, so the filtered pool is empty and the picker returns the same cell the
    UNfiltered ranking picks (degradation, not a throw) while
    `versusSpawnClearanceFailures` on the result is non-empty (the loud half).
  - corner: a candidate cell diagonal to two walls at `cellSize 1` is rejected while an
    interior cell wins despite a worse maximin score at margin default; with
    `clearanceMargin: null` the corner cell wins (proves the filter, not the ranking,
    decides).
  - pairwise: with an `avoid` position 1.0 from the best cell at `cellSize 1`, the pick
    moves to a compliant cell; `clearanceMargin: null` restores the old pick.
  - parity sweep: for all 15 shipped (arena, N) combinations,
    `pickVersusSpawnSet(...)` equals `pickVersusSpawnSet(..., { clearanceMargin: null })`
    cell-for-cell (byte-identical shipped behaviour), and
    `versusSpawnClearanceFailures` over the real `loadArena` positions is `[]` — the
    0-of-15 measurement with its denominator stated.
  - variant sweep: 5 arenas × 5 pinned seeds × N=4 through `buildVariantGrid` at the
    shipped fraction — clearance failures `[]` on every draw (75 draws, denominator
    stated).
- [ ] **Step 2: Run to verify failures.**
- [ ] **Step 3: Implement** the pool filtering in both pickers.
- [ ] **Step 4: Green; `npm run verify:quick`** (the full suite guards the respawn path
  (`world.ts`) and `isVariantSuitable`, both of which call `pickVersusSpawnCell`).
- [ ] **Step 5: Commit** `vs-clearance: filter spawn candidates on hull clearance` and push.

### Task 3: Mutation evidence, docs, full verification, PR

- [ ] **Step 1: Mutation evidence** (mutation-check skill; expected KILLED): (a) wall
  requirement `TANK_RADIUS + margin` → `margin` (killed by the corner/wall fixture);
  (b) pairwise requirement `2*TANK_RADIUS + margin` → `TANK_RADIUS + margin` (killed by
  the pairwise fixture); (c) the empty-pool fallback condition inverted so the filter is
  never applied (killed by the corner fixture's default-margin case).
- [ ] **Step 2: `npm run docs:check`** (this plan's metadata).
- [ ] **Step 3: `npm run verify:full`** from the clean candidate tree (sim change: high
  risk); recompute the 15-combination parity and 75-draw counts at the final tree.
- [ ] **Step 4: PR** — title `Enforce hull clearance for VS spawn candidates`, body with
  populations/denominators, mutation results, the #270-seam follow-up note, `Closes #225`.
  No attribution trailers. Record CI; merging is the owner's.
