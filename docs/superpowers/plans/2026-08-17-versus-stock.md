# Plan — Versus stock, safe respawn, and spawn protection (movement only)

Status: adopted 2026-08-17, implemented on branch `versus-stock`.

Provenance: closes the first three of the six questions raised in
`docs/superpowers/backlog.md`'s "Spike: the rest of versus mode -- stock/lives, respawn,
spawn protection, setup UI, maps" (raised alongside
`docs/superpowers/plans/2026-08-17-versus-spawns.md`, PR #188, which built
`pickVersusSpawnCell` specifically so a later respawn increment could reuse it, and
deliberately stopped at initial placement). A directive settled the three questions that
spike could not answer from the tree alone: match-format order is **stock first**, then
timed, then best-of-N, then first-to-N-kills (only stock is built here -- no scaffolding
for the other three); spawn protection is "a brief period of invincibility on respawn
where shots can't be fired and mines can't be placed by the recently respawned character
-- only movement"; respawn placement should target "the most isolated/safest spawn
point". Read against `docs/superpowers/plans/2026-08-17-versus-modes.md` (PR 4 of the
n-player arc, which explicitly rejected a stock counter as out of scope for itself, not
as a permanent ruling) and `docs/superpowers/plans/2026-08-15-coop-semantics.md` (the
per-tank respawn/shield machinery this PR reuses rather than duplicates).

---

## Part 1 -- Stock

**A new balance.json key, not a new mechanism.** `VERSUS_STOCK` (`constants.ts`, sourced
from `data/balance.json`'s new `versusStock` field, default 3) follows the exact
derivation convention `LIVES`/`data.lives` already uses -- one authoritative JSON entry,
one derived export, one pin in `constants.test.ts`. It is deliberately a SEPARATE key
from `lives`: campaign-coop's `world.lives` is a shared, per-ROUND pool; versus stock is
tracked per TANK and never shared.

**`Tank.stockRemaining?: number`** -- a tank field, not a parallel `Map<tankId, number>`
on `World`, per the brief's own steer: it clones with the tank for free, since
`cloneWorld`'s `cloneTank` already spreads every field of `Tank` (`{...t, ...}`) with no
per-field allowlist to extend. Stamped only by `loadArena`, only for player-kind tanks in
`mode === 'ffa' || mode === 'teams'` (both PASS 1a for P1 and PASS 1b's versus branch for
co-players) -- the same "optional, versus-only, stamped once at spawn" shape `Tank.team`
already established. A hand-built fixture `Tank` that never sets this field is not an
edge case to special-case around: `isVersusEliminated`'s `stockRemaining ?? 0` reads it
as already-zero-stock, which is exactly today's pre-stock single-life behaviour --
verified directly, not assumed: every pre-existing dispatch test in
`versus-modes.test.ts` (built before this PR, without the field) stayed green unchanged.

**The win condition changes SHAPE, not just its bookkeeping.** The brief named the exact
failure this is reviewed hardest for: counting bare `alive` ends a stock match on the
first death. `isVersusEliminated(t) = !t.alive && (t.stockRemaining ?? 0) === 0`
(`world.ts`) is the corrected predicate -- a player awaiting a scheduled respawn is dead
right now but not eliminated. `applyVersusStock` (new, mirrors `resolveStatusCoop`'s POOL
MODE tally exactly in shape) walks this tick's `tank-destroyed` events, decrements the
dying tank's own stock, and schedules a respawn (`RESPAWN_DELAY_TICKS` out -- reused, not
a new delay constant, since versus's respawn timing is not a new feel value) if any
remains. It runs before either `resolveStatusFfa` or `resolveStatusTeams` counts who
remains, so a stock-exhausted death is reflected in the SAME tick's elimination count.
Idempotency-guarded on `respawnAtTick !== undefined`, identical to the POOL MODE
precedent, so a corpse already tallied cannot be charged twice.

`resolveStatusFfa`/`resolveStatusTeams` now count NON-ELIMINATED players/teams, not alive
ones. **Proving the gap, not asserting it**: reverting either function's filter back to
bare `t.alive` was applied by hand, the affected test file re-run, and the mutation
reverted -- three separate real runs, numbers below.

- `resolveStatusFfa`'s `remaining` filter reverted to `t.alive`: **2 of 25** in
  `versus-modes.test.ts` fail. The two are the N=2 regression test built specifically to
  discriminate the two rules, and a mutual-kill-with-stock-remaining test. An N=3 draft
  of the regression test was tried FIRST, against the file as it stood before the
  mutual-kill test existed (24 tests total): that mutation failed only **1 of 24** (the
  mutual-kill test), and the N=3 regression test itself was NOT among the failures --
  i.e. it did not discriminate. With 3+ players, a single death still leaves 2+ tanks
  ALIVE either way, so an alive-count and an eliminated-count agree by coincidence; only
  N=2 (where the naive rule fires the instant the first of two players dies) tells them
  apart. Left in this file's own test comments as a recorded false start, since it is
  the concrete version of the exact defect class the brief warned about.
- `resolveStatusTeams`'s `teamsRemaining` filter reverted to `t.alive`: **1 of 25**
  fails -- the teams analogue of the same N=2 shape (one player per team); a 4-player
  teams fixture with one death per team does not discriminate for the identical reason
  the N=3 FFA case did not.

**Kept, not fixed:** the pre-existing simultaneous-wipe gap (`resolveStatusFfa`/
`resolveStatusTeams` resolve a same-tick mutual final elimination to `'lose'`, not a
`'draw'`) is unchanged -- it is a named residual from the modes PR, not something this
PR's brief asked to close, and reproducing it under the new stock-aware logic (both
tanks reaching zero stock the same tick) is pinned directly in `versus-modes.test.ts`.

## Part 2 -- Respawn cell

**`World.arenaGeometry?: ArenaGeometry`** (new, `types.ts`) is the piece the versus-spawns
PR left unbuilt: `pickVersusSpawnCell` needs the grid's own CHARACTERS (open-floor
cells, legend) to search, and `World.walls` alone cannot answer that -- it only carries
already-merged AABBs, and a former enemy spawn letter is real floor but produces no wall
entry at all. `loadArena` now returns `arenaGeometry: { cols, rows, cellSize, grid,
legend }` (a fresh object, not `arena` itself, so a future field added to `Arena` for an
unrelated reason does not silently leak onto every `World`); `createWorld`/`cloneWorld`
carry it through. Optional, because most of the sim's own test fixtures (and
`sandbox.ts`'s dev worlds) build a `World` straight from raw tanks/walls/spawns with
nothing behind it -- `respawnPos`'s absence branch degrades to the tank's own authored
spawn, the same total no-throw posture `pickVersusSpawnCell`'s own zero-candidate
fallback already takes. `cloneWorld` copies the reference, not a deep clone: the grid
strings/legend never mutate after `loadArena` builds them (only `Wall.destroyed`, which
lives in `walls`, changes mid-round), so sharing one object across every tick's clone is
safe and free.

**`stepRespawns`' new `respawnPos` helper** (`world.ts`) decides WHERE a reviving
player-kind tank reappears: campaign-coop keeps EXACTLY today's behaviour
(`world.spawns[i]`, a fresh copy, byte-for-byte unchanged -- `coop-respawn.test.ts`'s
pre-existing pins are untouched); ffa/teams instead call `pickVersusSpawnCell` with
`avoid` = the world-space positions of every currently LIVING tank. This is "the most
isolated/safest spawn point" the directive asked for, with the same caveat
`pickVersusSpawnCell`'s own doc comment already states and this PR does not relitigate:
greedy maximin on geodesic distance is a documented APPROXIMATION of true p-dispersion,
not its optimum. Processing `world.tanks` in array order and mutating `t.alive` in place
means two same-tick revivals are handled for free -- the second tank's pick already sees
the first tank's NEW position as alive, not its stale pre-death one, with no extra
bookkeeping. **Determinism**: `pickVersusSpawnCell` draws no randomness at all (pure BFS
+ line-of-sight over positions); there is no wall clock and no seeded draw to get wrong
here, unlike most of this sim's other AI-facing surfaces.

**The `stepRespawns` gate in `stepInputs` widens.** Previously `mode === 'campaign-coop'
&& countPlayerTanks(draft) >= 2`; now that OR's `mode === 'ffa' || mode === 'teams'`,
uncoupled from player count -- a stock match can schedule a respawn at any player count,
since `applyVersusStock` (Part 1) is what sets `respawnAtTick`, not a player-count check.
The pre-existing test pinning the OLD gate (`versus-modes.test.ts`'s "stepRespawns gate
tightened to mode === campaign-coop") asserted the literal OPPOSITE of this PR's own
goal (ffa never respawning through the real pipeline) and was rewritten, not patched
around, to pin the new gate instead.

**Testing methodology note, because it cost a wrong assumption during authoring:**
position-exactness for the picked cell is asserted via a DIRECT `stepRespawns` call, not
through the full `stepInputs` pipeline. `stepMovement`'s `resolveWalls`/`separateTanks`
run immediately AFTER `stepRespawns` in the SAME tick and can nudge a freshly placed tank
off a raw cell centre when that cell sits against the boundary wall -- observed directly
while writing `versus-respawn.test.ts`: the farthest-from-a-lone-survivor cell on
`ARENA_01` at N=2 is a board corner, where the tank's hull (radius 0.5) does not fully
fit inside a 0.667-wide cell without touching the boundary, and the post-tick position
differed from the raw cell centre by exactly the 0.1667-unit overlap on both axes. That
nudge is correct, pre-existing physics (not a defect this PR introduced), so
position-exactness tests call `stepRespawns` directly (the same pattern
`coop-respawn.test.ts` already established for identical reasons), and a separate
end-to-end test proves the wiring survives `cloneWorld` and the rest of the pipeline
without asserting an exact post-physics position.

**Mutations, applied by hand, `versus-respawn.test.ts` re-run each time, then reverted:**

- `cloneWorld` with the `arenaGeometry` field dropped: **1 of 6** fails -- only the
  end-to-end (`stepInputs`) test, since the direct-`stepRespawns` tests bypass
  `cloneWorld` entirely by design.
- `respawnPos`'s mode/arenaGeometry guard forced to always take the fallback branch (as
  if every World had no `arenaGeometry`): **5 of 6** fails -- every test asserting a
  picked cell rather than the authored spawn. The one survivor is the dedicated fallback
  test itself, which asserts exactly the behaviour this mutation makes universal.

## Part 3 -- Spawn protection (movement only)

**One window, reused, not duplicated.** Damage immunity already existed
(`Tank.shieldUntilTick`, `isDamageImmune`, stamped by `stepRespawns` for
`RESPAWN_SHIELD_TICKS`); what did not exist was an ACTION lockout -- a shielded tank
could still fire and lay mines, which is exactly the abuse the directive's lockout
exists to prevent. `isActionLocked(t, tick)` (new, `types.ts`) reuses `shieldUntilTick`
rather than adding a second parallel timer, per the brief's own steer, but is a
DIFFERENT predicate from `isDamageImmune`, deliberately: it checks `shieldUntilTick`
alone and never `invincible` -- the dev playtest cheat (`?dev=1&invincible=1`) is a
permanent damage cheat with no bearing on whether a tank may act, so an invincible
player still fights normally. No concrete reason was found for the two predicates'
`shieldUntilTick` half to differ, so they share it; only the `invincible` half splits.

**Wired at the single choke point every player-kind tank's fire/mine input passes
through.** `driveTank`'s `canAct` (`world.ts`) becomes `phase === 'live' &&
!isActionLocked(player, world.tick)`, gating only the `input.fire`/`input.mine` branches
-- movement (`desiredMove`) and turret aim are set unconditionally above this line and
are untouched, matching the directive's "only movement [is unrestricted]" precisely.
Deliberately NOT `roundPhase`/`COUNTDOWN_TICKS`/`GRACE_TICKS`: that machinery is
per-WORLD (one `roundStartTick` gates every tank identically); this is per-TANK, and
reusing the world-scoped gate for an individual respawn would freeze every OTHER live
tank's fire/movement too, exactly wrong mid-fight (the same reasoning
`RESPAWN_DELAY_TICKS`/`RESPAWN_SHIELD_TICKS`'s own comment already gives for staying
separate from `roundPhase`).

**Covers bots for free, not by a second gate.** A bot-claimed slot's `InputState`
(`ai/player-profile.ts`'s `decidePlayerInput`, wired in `game/loop.ts`) is consumed
through the exact same `applyPlayerInputs -> driveTank` path a human's is -- `stepAi`
(the ENEMY AI dispatcher) skips every `kind === 'player'` tank unconditionally, and
`shieldUntilTick` is only ever stamped on player-kind tanks by `stepRespawns`, so there
is no second site to gate. Proven with a test built to be non-vacuous: a fixture puts a
real opponent in sight, past the player profile's `reactionTime`, so
`decidePlayerInput`'s OWN computed decision genuinely wants to fire (asserted directly,
`input.fire === true`, both shielded and not) before checking whether the sim still
refuses it while shielded -- a fixture that never wanted to fire anyway would pass
whether or not the gate existed at all.

**Reachable in campaign-coop's POOL mode too (`?dev=1&coopPool=1`)**, which already
respawns tanks per-tank through the same `stepRespawns` -- desirable, not incidental: it
means this feature is exercised by an existing path, and a dedicated test proves a
POOL-mode revival cannot fire on the very tick it revives, then can again once its
shield lapses.

**Mutation, applied by hand, `spawn-protection.test.ts` re-run, then reverted:**
`canAct`'s `!isActionLocked(...)` clause dropped entirely (`phase === 'live'` only):
**5 of 12** fail -- both human-path refusal tests (fire, mine), both bot-path refusal
tests (fire, mine, each paired with its own "control" test proving the identical
decision fires when unshielded), and the coop-POOL-mode reachability test. The
movement/aim/invincible/no-shield/shield-expired tests all survive unchanged, which is
the point: the mutation should touch fire/mine only, and does.

## Hash obligations

`BASELINE_HASH` (`a5458ede003c173ccc099b708f4b7d43b7537ca8a7846a87274b6376ccc311a9`) is
expected UNMOVED: single-player campaign never sets `mode` away from its
`'campaign-coop'` default, never reaches `resolveStatusFfa`/`resolveStatusTeams`, and
`stepRespawns` only ever runs for it when `countPlayerTanks(draft) >= 2` -- a branch the
trace (one player, always) cannot reach either before or after this PR. `isActionLocked`
is likewise always false along the trace's own path, since `shieldUntilTick` is only
ever stamped by a per-tank respawn the trace never triggers. See the Gate section below
for the real, run command confirming this rather than assuming it.

Adding `versusStock` to `balance.json` DOES move the replay data fingerprint (the
key-sorted FNV-1a hash of all four sim data files, `fingerprint()` in
`src/game/replay.ts`) -- expected and unrelated to `BASELINE_HASH`, which hashes sim
OUTPUT, not sim DATA. Said explicitly here so the two moving independently (one, the
other, or neither) does not read as accidental either way.

## Gate

See the PR's own evidence for the real, pasted output of `npm test`, `npm run build`,
`npm run mutate` and `npx vitest run tools/baseline/trace.test.ts`.

## Deviations and open questions

- The N=1 degenerate versus configuration (`?dev=1&mode=ffa` with `players` unset)
  resolves an immediate win the moment the round starts, same as
  `docs/superpowers/plans/2026-08-17-versus-modes.md` already named for the pre-stock
  rule -- unaffected by stock, since a lone player's own stock never has anyone else to
  out-eliminate. Not special-cased, consistent with the earlier PR's own judgment call.
- `applyVersusStock`'s idempotency guard (`respawnAtTick !== undefined`) mirrors
  `resolveStatusCoop`'s POOL MODE tally exactly, including a scenario this PR did not
  construct a dedicated test for: two `tank-destroyed` events crediting the SAME tank
  within one tick's `events` array. Whether that is reachable through the real bullet/
  mine pipelines (as opposed to `resolveStatusCoop`'s own precedent, inherited rather
  than re-derived here) was not re-investigated for this PR.

## Stays deferred, named

Spawn animation, a versus setup menu, and map selection/procedural generation -- the
three questions the backlog spike's six did not ask this PR to answer. See
`docs/superpowers/backlog.md`'s rewritten "Spike: the rest of versus mode" entry, which
strikes the three questions this PR closes and keeps these three open.
