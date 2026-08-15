# Plan — couch co-op foundation: `controlledBy`, spawn derivation, render/attribution seam

Status: adopted 2026-08-15, implemented on branch `coop-foundation`.

Provenance: adjudicated after a scratch prototype on branch `p2-prototype` (commit
`297bdaf`, off `origin/main` `be1bda8`) answered `docs/research/multiplayer.md` open
question 2 -- `TankKind` branching (route A) vs. an optional `controlledBy` field on
`Tank` (route B) -- in favor of route B: `tsc --noEmit` stayed clean touching only
`types.ts`/`arena.ts`, no existing `kind: 'player'` fixture needed an edit, and every
`kind === 'player'` identity check in the tree keeps matching every human-driven tank
unchanged, since `kind` itself never diverges. This plan takes that decision as given
and works out the rest of the foundation: conditional (not unconditional) stamping,
append-at-end insertion, the spawn-offset rule, the render identity seam, and the three
misattribution fixes route B's audit surfaced. Reproduced below as adjudicated, with
first-person phrasing from the working draft converted to impersonal per the project's
own scrub (`cbd06f1`, `4c2a008`).

---

Scope: identity flows end to end (sim -> render -> stats/haptics/HUD), nothing
player-visible changes in single-player, `playerCount` stays 1 everywhere at runtime.
No devflag, no second input, no UI. Adopted decisions (route B `controlledBy`,
glow/ring + shell tint later, per-player kill attribution later, programmatic P2
spawn, orchestrator's call on placement) are taken as given, not relitigated.

## 1. Sim: `controlledBy`, spawn derivation, world plumbing

**`Tank.controlledBy?: number`** -- exactly the prototype's field (`types.ts`),
optional, 0-based input-list slot. Absent on every enemy always. Present on
player-kind tanks **only when `playerCount > 1`** -- see below for why this differs
from the prototype's unconditional stamp.

**`loadArena(arena: Arena, playerCount: number = 1)`** (`src/sim/arena.ts`). PASS 1 is
split in two:

- **PASS 1a -- unchanged.** The existing `for (r) for (c))` grid scan, verbatim: ids
  assigned by spawn order, no `controlledBy` stamped. At `playerCount === 1` this is
  the *entire* function body relevant to spawns -- the returned `tanks`/`spawns`
  arrays are byte-identical to today's, not just behaviorally compatible. That is a
  deliberate, stronger claim than the prototype made (which stamped `controlledBy: 0`
  unconditionally): rather than auditing every `toEqual`-against-a-full-tank-object
  fixture in `arena.test.ts`/`world.test.ts`/`sandbox.test.ts`, conditional stamping
  makes that audit unnecessary rather than risking it. (This is *not* what protects
  `BASELINE_HASH` -- `traceText()` serializes only `pos`/`turretAngle`/`alive`, and no
  sim code reads `controlledBy` -- but it is what protects `toEqual`.)
- **PASS 1b -- new, only when `playerCount > 1`.** Stamp the PASS-1a player tank's own
  `controlledBy = 0`. Then for `i = 1..playerCount-1`, derive a spawn cell for player
  `i` and **append** a new spawn + tank (`controlledBy = i`) *after PASS 1a finishes*,
  i.e. after every enemy has already been scanned and id'd. Appending at the end --
  not interleaving at the P cell -- means every enemy's id, and therefore its seeded
  RNG stream (`ai/targeting.ts` keys off `tank.id`), is identical between
  `playerCount` 1 and >1. Only wall ids (numbered in PASS 2, already after all tanks)
  shift, which is harmless. This is the one placement choice flagged as "orchestrator's
  call, reversible" in the brief; append-at-end is the adopted choice, for the reason
  above.

**Spawn-offset rule** (same function, deterministic, pure, cellSize-aware -- the shape
a future netcode peer can recompute locally without transmitting positions):

- `cellsNeeded = Math.ceil(2 * TANK_RADIUS / cellSize)` -- the smallest integer
  cell-count whose center-to-center distance clears two hulls without overlap. At the
  shipped `cellSize` (0.6̄6, all 5 arenas) and `TANK_RADIUS = 0.5`, that's
  `ceil(1.0 / 0.6667) = 2`.
- 8 fixed candidate directions in priority order, `(Δcol, Δrow)`: **E(+1,0), S(0,+1),
  W(−1,0), N(0,−1), SE(+1,+1), SW(−1,+1), NE(+1,−1), NW(−1,−1)** -- cardinal before
  diagonal, E first (P2 conventionally "to the right" of P1).
- For each additional player, search rings at radius `cellsNeeded, 2·cellsNeeded,
  3·cellsNeeded, 4·cellsNeeded` (bounded, generous, not exhaustive), trying the 8
  directions in that fixed order at each ring; a candidate is valid iff in-bounds,
  `grid[row][col] === '.'` (excludes solid, destructible, and every other spawn letter
  in one check -- no new wall-classification logic to drift from `loadArena`'s
  existing one), and not already claimed by an earlier co-player this call.
- **Fallback if all rings exhaust:** co-locate the player at P1's own cell.
  `separateTanks` (`world.ts:152-158`) already runs every tick and already handles
  worse overlaps (three tanks ganging a fourth 0.375 units into a wall) -- this is the
  total, no-throw path, deliberately chosen over a load-time failure so a cramped
  custom/sandbox arena degrades rather than crashes.

**Measured, not assumed:** all 5 shipped arenas' P-cell neighborhoods were probed at
the actual rule distance (ring 1, `cellsNeeded=2`, all 8 directions). Result: the
**first** candidate (E) is open (`'.'`, in-bounds) in **all 5 of 5** shipped arenas --
arena-01/02/03 resolve P2 to `(row=22,col=18)`, arena-04/05 to `(row=28,col=24)`. Zero
grid edits needed, confirmed at the distance the rule actually uses (an initial pass
had checked ring-1 openness, which is the wrong distance -- corrected here). The
ring-expansion and overlap-fallback paths are therefore **unexercised by shipped
content**; they need a synthetic tiny/cramped fixture arena to test directly (see §5).

**`createWorldFor`** (`arena.ts:244`) gains a 7th trailing optional param,
`playerCount: number = 1`, threaded straight to `loadArena` -- same shape as the
existing `corpseBlocksShells`/`muzzleClearsTanks` precedent, so every positional
caller (`createArenaWorld`, `tools/baseline/trace.ts:72`'s 2-arg call,
`tools/gl/harness.ts`'s three `createArenaWorld(1)` calls, `levels.ts:134`'s 5-arg
call) is untouched. `LevelSystem.world()` (`game/levels.ts:43`) gains the matching
trailing optional param, threaded down; `loop.ts:398`'s real call site is **not**
changed to pass a non-default value -- that's the second-input-routing PR's job.
`sandbox.ts` is untouched: it builds an `Arena`, not a call to `loadArena` directly,
and nothing in this PR gives it a co-op path.

**Trace-hash argument, structural then verified:** `traceText()`'s only call
(`trace.ts:72`, `createWorldFor(ARENAS[a], seed)`) resolves `playerCount` to its
default, 1, which by construction (§ above) makes `loadArena`'s executed statements
identical to today's -- not merely "produces the same values," the same code path
runs. First thing to verify empirically: `npx vitest run tools/baseline/trace.test.ts`
and confirm `BASELINE_HASH` (`324aa9b5…`) unmoved -- mirroring exactly what the
aim-grid plan flagged as "the first thing the implementer verifies."

## 2. The `.find(kind === 'player')` audit

Grepped precisely (`tanks.find`/`spawns.find`/`tanks.filter` + `kind`, non-test `.ts`,
excluding this PR's own new code): **15 sites** carry the
`.find(t => t.kind === 'player' ...)` pattern, matching the prototype report's count
exactly.

| Site | Classification | Action |
|---|---|---|
| `world.ts:240` `applyPlayerInputs` filter | already multi-player-correct (iterates all) | none — shipped ahead of this PR |
| `world.ts:303` `enemies = filter(kind !== 'player')` | already correct (any non-player) | none |
| `world.ts:255` `applyPlayerInput` (1-arg adapter) | correct-as-P1 by design, already documented | none |
| `world.ts:302` `resolveStatus` | correct-as-P1 placeholder, semantics deferred | **comment only**: state explicitly it watches P1 only, P2 death is invisible to life/win-lose, point at multiplayer.md open Q3 |
| `ai/targeting.ts:494`, `ai/brown.ts:15`, `ai/teal.ts:30`, `ai/grey.ts:51` | correct-as-P1-preferred (finds first *alive* player; tolerant, not wrong) | **comment only** on all 4: who AI targets in co-op is balance work, later |
| `arena-claims.ts:155`, `:209` | correct-as-is — validates the *authored* grid at playerCount 1; P2's programmatic spawn isn't arena data | none (multiplayer.md open Q4, unchanged) |
| `replay.ts:255` (`replayMetaFor`'s `invincible`) | correct-as-P1 — one dev flag, one tracked tank | none |
| `loop.ts:400, 505, 642, 741` | correct-as-P1 — local-device concerns (dev invincible flag, autoplay, director/haptics id, aim-stick position) | none |
| `tools/gl/harness.ts:647`, `render/aimray.ts:46` | correct-as-P1 — dev tool / single aim ray | none |

**3 more sites, same misattribution shape, found by extending the audit from `.find`
to the event-stream's own `kind === 'player'` checks** (not in the task's 15, but the
identical bug: kind no longer uniquely identifies "the tracked player" once a second
player-kind tank exists):

- **`game/stats.ts:166`** -- `if (e.kind === 'player') { bump('deaths'); if
  (e.by.ownerId === playerId) bump('selfKills'); }`. At playerCount>1, P2 dying would
  bump P1's `deaths`/`selfKills`. Fix: `if (e.tankId === playerId)` --
  `tank-destroyed` already carries `tankId` (`events.ts:23`). Zero behavior change at
  N=1 (the only player-kind tank's id *is* `playerId`).
- **`game/haptics.ts:100`** -- identical shape, identical fix: `e.kind === 'player'`
  -> `e.tankId === playerId`.
- **`game/loop.ts:261-263`, `isPlayerDeath(events)`** -- no `playerId` in scope, so
  this isn't a one-line swap like the two above: needs a signature change,
  `isPlayerDeath(events: SimEvent[], playerId: number): boolean`, body
  `e.tankId === playerId`, called at `loop.ts:660` as
  `isPlayerDeath(events, playerId ?? -1)` (matching the existing `?? -1` idiom at
  lines 674/679). Its dedicated test (`loop.test.ts:1859-1885`) hardcodes `tankId: 1`
  in its `destroyed()` helper regardless of `kind` -- that fixture stops testing the
  right thing once the check is id-based, and needs rewriting to use **distinct**
  tankIds per case, with an explicit new case (kind `'player'`, tankId ≠ tracked
  playerId -> false) that is the actual point of the fix.

No change needed anywhere else these three files touch (`fire`/`ricochet`/`mine-*`
checks are already `ownerId === playerId`, already correct). `audio/director.ts` and
`game/state.ts` were checked and carry no kind-based check on `tank-destroyed` at all
(no-op / not consumed) -- nothing to fix there.

## 3. Render identity seam

`render/entities.ts`'s player identity is three **module-level singletons** --
`playerHex`, `playerSkinMap`, `playerSkin`, `colorGen` (`:307-315`) -- read at
`makeTank(kind)` (`:646-667`) and invalidated in `syncTanks` (`:966`, `view.gen !==
colorGen && t.kind === 'player'`). This is the piece that must change now, because
it's what makes per-player customization structurally *possible* later -- everything
else in this PR is inert plumbing, this one is load-bearing.

**Design:** replace the four singletons with a `Map<number, PlayerStyle>` keyed by
slot (`controlledBy`, defaulting `?? 0`), `PlayerStyle = { hex, skinMap, skin, scroll,
gen }`. `setPlayerStyle(hex, skin, accentHex, slot: number = 0)` -- trailing optional
param, so all 3 existing call sites (`renderer.ts:67,133`, `preview.ts:344`) keep
working unchanged, writing slot 0 exactly as today. Lookup rule, in order: **map has
this slot -> use it; slot is 0 and map has nothing -> today's roster default**
(`configFor('player').color`, `'solid'` skin -- bit-identical to current boot state);
**slot ≥ 1 and map has nothing -> a neutral placeholder swatch, distinct from P1's
default and every roster kind's color** (exact hex is a feel value, implementer's
pick, same treatment CLAUDE.md gives `TANK_TURN_RATE`; verify distinctness with a
one-line diff-against-`configFor(kind).color` test, don't hardcode a value here).
`makeTank(kind, controlledBy?)` resolves its slot's style; `syncTanks`'s rebuild
trigger becomes per-slot (`view.kind !== t.kind || (t.kind === 'player' && view.gen
!== styleFor(t.controlledBy ?? 0).gen)`).

**Shell tint needs no plumbing in this PR.** `Bullet.ownerId` already exists
(`types.ts`), and once `Tank.controlledBy` exists, a later PR's `syncBullets` can
resolve `b.ownerId -> curr.tanks.find(id) -> controlledBy -> slot tint` at the
bullet-view's creation tick, exactly mirroring how `tankViews` captures `kind`/`gen`
once. `makeBullet()`/`bulletViews` are untouched by this PR -- no seam to build, the
data is already there.

**Verification is required, not optional, and must be the browser gate, not `npm
test`.** `src/render/` is only covered by `npm run test:gl`/`npm run gallery`
(CLAUDE.md's own "known holes" section) -- vitest cannot see a P1 color regression
here. Before/after: `npm run gallery -- --elements tank --skin solid` (and whatever
swatch the existing preview test drives) must be pixel-unchanged, and `npm run
test:gl` must stay green. New coverage: a hand-built `World` with two `kind: 'player'`
tanks (`controlledBy: 0, 1`, same construction style as `step-inputs.test.ts`'s
`twoPlayerWorld` -- "not a loadable arena," built via `createWorld` directly) proves
the seam resolves two *different* styles when two slots are styled differently, and
P1-only styling leaves slot 1 on the placeholder. This is unreached by shipped
gameplay, same as the `SimEvent` tick field was when it landed -- pinned by value, not
by presence.

## 4. Replay/trace

**No `ReplayMeta` change in this PR.** Unlike the `SimEvent` tick field (which had a
real, if unwired, consumer path), `EncodedInput`/`createRecordingInput`/`replayTrace`
are fundamentally *one InputState per tick* -- a `playerCount` field on `ReplayMeta`
alone wouldn't let a 2-player replay actually round-trip; the encoding itself has to
change first. Adding it now would be exactly the "architect for an absent consumer"
move CLAUDE.md's dev-flag doctrine (and the aim-grid plan's constant-placement
reasoning) warns against. Naming it explicitly as the second-input-routing PR's job:
it will need `EncodedInput[]`-per-tick (or equivalent), `ReplayMeta.playerCount`, and
the reconstruction helper at `replay.test.ts:63-69` updated to pass it to
`createWorldFor`.

**Trace hash:** covered in §1 -- structural argument (default path executes identical
code) plus the empirical check (`BASELINE_HASH` unmoved) is the whole of what this
item needs; nothing about replay encoding is touched.

## 5. Test plan, ordered, gate-green at every step

1. `types.ts` -- add `controlledBy?`. Red-first: none needed (purely additive,
   optional); confirm `npm test` green (it will be, trivially -- nothing reads the
   field yet).
2. `arena.ts` -- `loadArena(arena, playerCount)`, spawn-offset rule, `makeTank(kind,
   controlledBy?)`. Red-first tests: (a) `loadArena(arena)` / `loadArena(arena, 1)`
   output `toEqual`s today's captured output for at least one shipped arena -- write
   this *before* touching the function, watch it pass trivially today, keep it as the
   regression pin; (b) `loadArena(arena, 2)` for each of the 5 shipped arenas asserts
   the concrete resolved P2 cell (the measured ones above) and `controlledBy: 0/1`;
   (c) a synthetic cramped fixture arena (P boxed in solid walls at ring 1 and 2)
   exercises ring-expansion and the overlap fallback -- this is the only way to reach
   that code, since no shipped arena does. Then `createWorldFor`/`createArenaWorld`/
   `levels.ts` plumbing -- no new behavior, verify existing tests untouched. Run `npx
   vitest run tools/baseline/trace.test.ts` -- confirm `BASELINE_HASH` unmoved.
3. `render/entities.ts` -- per-slot style map. Red-first: the two-player
   hand-built-`World` sync test (fails today -- there's only one slot to color). Then
   `npm run test:gl` + `npm run gallery` before/after pixel check (required, see §3).
4. `stats.ts`/`haptics.ts`/`loop.ts` -- the 3 misattribution fixes. Red-first for
   each: a two-player-tank fixture (P1 tracked, P2 not) where P2 dies; assert today's
   code wrongly bumps/vibrates/signals for P1, then apply the fix and assert it stops.
   Rewrite `loop.test.ts`'s `isPlayerDeath` describe block with distinct tankIds per
   case (§2).
5. Comment-only touches (`resolveStatus`, 4 AI files) -- no test change, `npm test`
   stays green by construction.
6. Full gate: `npm test`, `npm run build`, `npm run test:gl`, `npm run mutate`
   (checked: 1 of 13 manifest entries targets a touched file, `loop.ts`'s
   `replay-recorder-wraps-the-raw-controller`, unrelated to any line changed here --
   confirmed by reading the entry, no collision), `npm run trace:browser -- --all` if
   time allows (not required for merge per existing CI shape, but cheap confirmation).

**What stays out, named for the PR body:** second-input routing (a real devflag/UI
that sets `playerCount > 1` and threads a second `InputState`); the glow/ring and
shell-tint renderables themselves (data is ready, pixels aren't drawn); per-player
customization UI; co-op lives/win-lose semantics (`resolveStatus`'s P1-only rule,
`world.lives` shared-vs-per-player) and the attribution UI that needs it;
`ReplayMeta`/`EncodedInput` multi-input support; arena `claims`/`structuralFailures`
generalizing past one player spawn (multiplayer.md open Q4, untouched); AI targeting
sophistication for 2 humans. The backlog spike at `docs/superpowers/backlog.md:540`
("Decide `TankKind` vs a `controlledBy` field") is now answered by the adopted
decision and its line needs rewriting (not deleting -- the parent spike is still
open) in the PR that lands this.

## Forks for the owner

None found requiring adjudication. Spawn-offset rule, insertion-point (append-at-end),
conditional `controlledBy` stamping, P2 placeholder swatch, and the `ReplayMeta`
deferral are all decided above, each with a stated reason.
