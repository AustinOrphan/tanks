---
status: completed
date: 2026-08-15
last-reviewed: 2026-08-23
scope: Shared co-op lives, per-player respawn and shields, kill attribution, and run exclusion
implementation-issues: []
implementation-prs: [175]
supersedes: []
superseded-by: []
---
# Plan — couch co-op semantics + attribution: shared lives, per-tank respawn, kill tally

Status: adopted 2026-08-15, implemented on branch `coop-semantics`.

Provenance: adjudicated as the semantics layer the couch co-op foundation and
input-routing plans (`docs/superpowers/plans/2026-08-15-coop-foundation.md`,
`-coop-input-routing.md`) deliberately deferred — `resolveStatus`'s P1-only rule, the
shared `world.lives` pool, and per-player attribution. Every decision the commissioning
brief flagged as open was resolved before implementation started, refining within the
brief's adopted defaults rather than reopening them: the discriminator
(`countPlayerTanks`), the respawn fields' absolute-tick convention, the two feel
constants' values, `resolveStatus`'s guard-first split, run-store exclusion, and
attribution's home. One default was REFINED rather than merely applied — adopted
default 3's one-sentence rule ("a run must not end while the partner is alive") is
extended one step further for simultaneous death: a respawn already scheduled on an
earlier tick must be honored even when a later, different death drains the shared pool
to 0 first (the `pendingRespawn` guard, not the pool alone — see §"`resolveStatus`:
guard-first" below for the walkthrough at pool 2 and at pool 1). Reproduced below as
adopted, already in the project's impersonal phrasing.

---

Read: CLAUDE.md, `docs/superpowers/plans/2026-08-15-coop-foundation.md`, `-coop-input-routing.md`, `src/sim/world.ts`, `src/sim/round.ts`, `src/game/loop.ts`, `src/game/stats.ts`, `src/game/hud.ts` (+ `hud.css`/`hud.css.test.ts`, `src/sim/events.ts`, `src/sim/types.ts`, `src/sim/bullets.ts`, `src/sim/mines.ts`, `src/render/particles.ts`, `src/audio/director.ts`, `src/game/state.ts`). Both prior plans are already implemented on this branch (`Tank.controlledBy`, per-slot spawn, `coopActive`/`slots` wiring in `loop.ts`) — this plan is the semantics layer they deliberately deferred (`resolveStatus`'s P1-only rule, shared `world.lives`, per-player attribution).

## Discriminator

`countPlayerTanks(world) = world.tanks.filter(t => t.kind === 'player').length`, a new pure helper in `world.ts` — not a `world.playerCount` field. Matches the established convention (`replayMetaFor` derives playerCount off `world.tanks` rather than storing it) and can't desync from the tank array. Used in exactly two places: `resolveStatus`'s branch guard, and `stepInputs`'s gate for the new respawn stage.

## The hard problem: death without `resetArena`

**`resetArena` today** (`world.ts:265-294`): repositions **every** tank (player and enemy) to its spawn, revives all, restores every destroyed wall, clears `world.bullets`/`world.mines`/`world.blasts`, and resets `roundStartTick` (re-arms countdown/grace for everyone). It is whole-board and would erase a live partner's fight. Coop needs per-tank revival that leaves the rest of the world — enemies, wall damage, the partner's mines and bullets — untouched.

**New per-tank fields on `Tank`** (`types.ts`, optional like `controlledBy`/`invincible`, absent ⇒ every existing fixture stays valid):
- `respawnAtTick?: number` — absolute tick this corpse revives on. Set only by `resolveStatus`'s coop branch, cleared by the stage that resolves it.
- `shieldUntilTick?: number` — absolute tick until which the tank is damage-immune. Set only at the moment of revival, no explicit clear (self-expires by comparison, same idiom as `roundPhase`'s elapsed-based checks — no stray cleanup code).

Both are **absolute tick numbers**, not decrementing counters, deliberately mirroring `world.roundStartTick`'s own convention rather than `fireCooldown`'s — it sidesteps the fractional-decrement class of bug `constants.ts` already warns about for seconds-based counters, and the anchor-after-`tick += 1` discipline `round.ts` documents applies here too: `resolveStatus` runs after `draft.tick += 1`, so `respawnAtTick = world.tick + N` and a later tick's `world.tick >= respawnAtTick` land exactly N ticks apart.

**New constants** (`constants.ts`, feel values, same treatment as `TANK_TURN_RATE`/`MINE_BLAST_EXPAND_TICKS` — tests pin behavior against the constant, not a hardcoded result, so retuning is a one-line edit):
- `RESPAWN_DELAY_TICKS = 120` (2.0s) — corpse-to-revival window.
- `RESPAWN_SHIELD_TICKS = 90` (1.5s) — post-revival damage immunity.

**Why not reuse `GRACE_TICKS`/`roundPhase`** (the machinery CLAUDE.md flags as intact-at-0): rejected, and worth stating why rather than silently skipped. `roundPhase` is **world-scoped** — one `roundStartTick` drives every tank's phase uniformly. Reusing it for an individual respawn would freeze the *surviving* partner's fire/movement too, which is exactly wrong: they're mid-fight. Per-tank state is the only fit. The round-**start** countdown is unaffected and still correct as-is — it's global by design and applies once at game start to both players; only mid-round respawns need the new per-tank shield.

**What the shield is actually for** — broader than AI camping. Skipping `resetArena` means the shield is the only thing standing in for *everything* that reset used to guarantee safe: wall state is unrestored (a breach stays a breach), and the returning tank rematerializes into a board that may still have the partner's shells in flight, an active blast, or a live mine nearby, in addition to `arena-01`/`arena-04`'s no-sightline spawn guarantee holding only for arenas that declare `sightlineAfterBreach` (arena-02 does not) and never having been checked at all for P2's programmatically-derived cell. The shield absorbs all of that in one mechanism rather than four.

**`isDamageImmune(t: Tank, tick: number): boolean`** lives in `types.ts`, not `world.ts` — `world.ts` already imports `bullets.ts`/`mines.ts`, so a helper in `world.ts` would be a circular import (the exact reason `round.ts` gives for its own placement, cited directly). Body: `t.invincible === true || (t.shieldUntilTick !== undefined && tick < t.shieldUntilTick)`. Replaces `bullets.ts:236`'s `if (!t.invincible)` and `mines.ts:129`'s `if (t.invincible) continue` — both already have `world` in scope (`resolveBulletHits(world, events)`, `applyBlast(world, blast, events)`), confirmed by reading both signatures, so `world.tick` is available at both call sites. Value-identical at N=1: `shieldUntilTick` is only ever set by the coop respawn stage, so it's always `undefined` in single-player, and the OR collapses to today's `t.invincible` check.

**Per-tank revival — deliberately a *shorter* field list than `resetArena`'s.** Reset: `pos`, `bodyAngle`, `turretAngle`, `alive = true`, `desiredMove`, `fireCooldown = 0`, `mineCooldown = 0`, `aiState`/`aiTimer`/`aimTicks`, using `world.spawns[idx]` at the tank's own array index — the same `world.tanks[i] ↔ world.spawns[i]` invariant `resetArena`'s own comment documents, which the foundation plan's append-at-end insertion preserves for P2 too. **Do not touch `activeMineIds`, and do not clear `world.mines`/`world.bullets`/`world.blasts`.** `resetArena` clears mines board-wide *and* zeroes every tank's `activeMineIds` together, as one atomic reset; a per-tank respawn that zeroed `activeMineIds` while that tank's own mines are still live in `world.mines` would desync the count `dropMine`'s cap check reads, letting the revived tank exceed its mine cap. Shells have no equivalent problem (`playerShellsInFlight` counts `world.bullets` by `ownerId`, no tank-side array) — this is mines-specific and is the one correctness fix that isn't just carrying `resetArena`'s pattern forward.

**`stepRespawns(world, events)`** — new stage, revives any player tank whose `respawnAtTick` has arrived, emits `respawn`. Called from `stepInputs` **before** `applyPlayerInputs`, gated: `if (countPlayerTanks(draft) >= 2) stepRespawns(draft, events);`. Running first means a tank that crosses its revival tick gets that same tick's input rather than sitting inert one extra frame — a deliberate, stated improvement on `resetArena`'s incidental one-tick lag, not an accident. At N=1 this new line **always executes but the guard is always false** — an honest distinction from `resolveStatus`'s treatment below: this is a value-identical no-op (cheap boolean, touches nothing when false), not a "never even called" structural no-op, and the plan should say so precisely rather than overclaim.

## `resolveStatus`: guard-first, original body untouched

Strongest form of the trace claim, matching how the foundation plan protected PASS 1a — **not** a refactored version that happens to produce the same values, the literal existing statements:

```
export function resolveStatus(world: World, events: SimEvent[]): void {
  if (world.status !== 'playing') return;
  if (countPlayerTanks(world) >= 2) { resolveStatusCoop(world, events); return; }
  // everything below is today's body, byte-for-byte, unmodified
  const player = world.tanks.find((t) => t.kind === 'player');
  ...
}
```

`resolveStatusCoop` duplicates the ~4-line win check (accepted duplication — it's what keeps the 1P branch a literal no-diff) then:

```
for (const e of events) {
  if (e.type !== 'tank-destroyed' || e.kind !== 'player') continue;
  const tank = world.tanks.find(t => t.id === e.tankId);
  if (!tank || tank.respawnAtTick !== undefined) continue;
  world.lives = Math.max(0, world.lives - 1);
  if (world.lives > 0) tank.respawnAtTick = world.tick + RESPAWN_DELAY_TICKS;
}
const players = world.tanks.filter(t => t.kind === 'player');
const noneStanding = players.every(t => !t.alive);
const pendingRespawn = players.some(t => t.respawnAtTick !== undefined);
if (noneStanding && !pendingRespawn) { world.status = 'lose'; events.push({ type: 'lose' }); }
```

**Adopted default 3's refinement, walked through against simultaneous deaths** (this is the actual content of "a run must not end while the partner is alive," extended one step further):
- Pool 2, both die same tick, processed in event order: first decrement 2→1 (>0, schedules a respawn), second decrement 1→0 (not >0, no respawn — permanent corpse). `noneStanding` is true (both currently dead) but `pendingRespawn` is true too → **not** lose. One player revives in 2s, the other has spent the shared pool and stays down for the rest of the round. Emergent, correct, and worth naming explicitly since it's not literally what the one-sentence refinement says but follows from it.
- Pool 1, both die same tick: both decrements land on 0, neither schedules → `noneStanding && !pendingRespawn` → lose. A shared pool of 1 genuinely can't survive two simultaneous deaths.
- The reason `pendingRespawn` (not just `world.lives > 0`) is the second half of the guard: a tank can have a respawn already scheduled from an *earlier* tick while the pool drops to 0 from a *different*, later death — that scheduled respawn was already paid for and must be honored. Checking the pool alone would wrongly call `lose` mid-window.

Win check runs before either branch's death handling (already true today — "a mutual kill is a win... decided ahead of the death branch," generalizes unchanged). Adopted default 5, unchanged.

## SimEvent and its six consumers

`{ type: 'respawn'; tankId: number; controlledBy: number; pos: Vec2 }` — payload carries `controlledBy` directly so consumers don't need a tank lookup, matching why `tank-destroyed` carries `kind` inline.

Disposition, decided rather than left inert (an unwired 11th variant is exactly the "architect for an absent consumer" move both prior plans reject):
- **`render/particles.ts`**: wire now. One `case 'respawn': burst(ev.pos.x, ev.pos.y, ...)` alongside the existing `fire`/`explosion`/`wall-destroyed` cases — reuses the existing `burst()` primitive, no new asset, genuinely free.
- **`audio/director.ts`**: **defer**, explicitly. Every existing case plays a pre-registered engine asset (`engine.play('cannon')` etc.); a respawn cue needs either a *new* synthesized sound (real work, a feel decision nobody's heard yet) or repurposing an existing one (risks a death-adjacent sound like `ping`/`mine-arm` reading as the wrong thing on revival). Not free the way the particle burst is — named as a deferred item, not silently skipped.
- **`game/haptics.ts`**: no wiring. Same deferred bucket as mine-detonate's distance cue — haptics has no per-player attribution machinery yet (P1-only `setPlayerPosition`), and building it just for respawn isn't this PR's job.
- **`game/state.ts`**: checked, no-op — it only switches on `win`/`lose`.
- **`render/renderer.ts`**: checked, no-op — it doesn't switch on events at all (confirmed: no `events.` handling in the file); `entities.sync` already reveals a revived tank every frame purely from `alive`/`pos`, no event dependency.
- **`game/loop.ts`**: no direct handling of `respawn` — the kill-tally attribution below reads `tank-destroyed`, not `respawn`.

**Named as one deferred bundle for before this ships to real players** (not blocking the dev-flagged PR): a persistent shield visual indicator (glow/pulse while `shieldUntilTick` is active) and the audio cue above. Without either, a `?dev=1&coop=1` session is functionally correct but a silent revive-then-briefly-invincible reads as a bug to anyone who doesn't know the mechanism — acceptable behind a dev flag, not acceptable shipped.

## Run-store interaction

Today, `isPlayerDeath` (loop.ts:278) checks `tankId === playerId` — P1's id only — and `campaignActive()` (loop.ts:504) is `tracksProgress && !isDevJump && !inPractice`, with no `coop` term. Two consequences if left as-is: P2 dying never calls `setLivesRemaining` even though it drains the same shared `world.lives`, and `bootLives` (loop.ts:473) adopts the real run's stale `livesRemaining` on a coop boot exactly like a non-jumped campaign session would.

**Decision: coop is run-excluded, identically to practice/dev-jump/sandbox — the simpler, safer call the task itself flags.** Two edits, both one term added, both mirroring `isDevJump`'s existing treatment exactly:
- `campaignActive()` → `tracksProgress && !isDevJump && !inPractice && !coopActive`.
- `bootLives`'s ternary condition gains `&& !coopActive` (coop boots with fresh `LIVES` from `balance.json`, same as a dev jump).

Coop is dev-flag-only today, unshipped, with no menu path — writing a shared-pool count into the single-player-shaped `RunState.livesRemaining` field would be writing data whose meaning hasn't been decided (does P2's death count against the solo player's progress if coop is later abandoned mid-run?). Excluding it now costs nothing and avoids corrupting real persisted campaign state with semantics nobody's designed yet; a future "ship coop for real" PR can revisit deliberately.

## Attribution: results-screen kill tally

**Not `stats.ts`** — adopted default 4 keeps lifetime stats P1-scoped, and `StatCounts` has no per-player axis; bolting one on would conflate two orthogonal dimensions (metric vs. player) in one shape. Instead: a small `loop.ts`-local array, `let coopKills: number[] = [];` (index = slot), populated by a new pure helper called from `onFrameEvents` alongside the existing `deps.stats.record(...)` call:

```
function tallyCoopKills(events: SimEvent[], world: World, into: number[]): void {
  for (const e of events) {
    if (e.type !== 'tank-destroyed' || e.kind === 'player') continue; // enemy kills only
    const killer = world.tanks.find(t => t.id === e.by.ownerId);
    if (killer?.kind !== 'player') continue; // AI friendly fire doesn't count as a "kill"
    const slot = killer.controlledBy ?? 0;
    into[slot] = (into[slot] ?? 0) + 1;
  }
}
```

Gated on `countPlayerTanks(driver.world) >= 2` for whether the HUD line shows at all — deriving off the world rather than the `coopActive` flag, consistent with `replayMetaFor`'s own stated convention (they're kept in lockstep by construction anyway: sandbox exclusion means `coopActive` and the world's real player count never diverge). **Per-attempt scope, resetting at both `deps.stats.startAttempt()` call sites** (loop.ts:828, :1186) — mirrors `attempt`'s own lifecycle exactly, since it feeds the same win/lose panel.

**HUD**: `hud.setCoopKills(counts: number[] | null)`, new `statsData`-adjacent module state, a `renderCoopKillLine()` twin of `renderAttemptSummary()` (hud.ts:785-795), toggled by the identical `s !== 'win' && s !== 'lose'` hidden-class pattern (hud.ts:1310). New `.hud-coop-kills` element in the win/lose panel template next to `.hud-attempt-summary` (hud.ts:451), new `.hud-coop-kills`/`.hud-coop-kills--hidden` rules in `hud.css` mirroring `.hud-attempt-summary` (hud.css:722-728), and both selectors added to `hud.css.test.ts`'s selector-presence list (hud.css.test.ts:185) — CLAUDE.md's own rule ("any new stylesheet wants the same treatment") applied literally. Copy: `P1: ${counts[0] ?? 0} · P2: ${counts[1] ?? 0}` — plain template literal; there is no i18n layer anywhere in this codebase to interact with, confirmed by the absence of one in every string-building site read (`pct()`, `renderAttemptSummary`, `STAT_ROWS`).

## Red-first test plan, ordered, gate-green at each step

1. **`types.ts`** — `respawnAtTick?`/`shieldUntilTick?` on `Tank`, purely additive. `npm test` green trivially.
2. **`constants.ts`** — `RESPAWN_DELAY_TICKS`/`RESPAWN_SHIELD_TICKS`. No behavior yet.
3. **`world.ts`** — `countPlayerTanks`, `stepRespawns`, `resolveStatusCoop`, the `resolveStatus` guard-split. Red-first: (a) a hand-built 2-player `World` (mirroring `step-inputs.test.ts`'s `twoPlayerWorld`) where one player dies — assert `respawnAtTick` gets stamped, pool decrements, tank stays `alive:false` until the tick arrives, then revives at its own `spawns[idx]` cell with `shieldUntilTick` set; (b) simultaneous double-death at pool 2 and at pool 1, asserting the two divergent outcomes above; (c) the pending-respawn-survives-a-later-zero-pool case explicitly, since it's the least obvious branch; (d) `players.length < 2` regression: feed a 1-player and a 0-player world through `resolveStatus`, `toEqual` captured pre-change output. Then run `npx vitest run tools/baseline/trace.test.ts` — confirm `BASELINE_HASH` unmoved (structural: the coop branch is never entered at N=1; `stepRespawns` is called but its guard is always false, value-identical not code-identical, state this distinction).
4. **`types.ts`** — `isDamageImmune`, and its two call sites in `bullets.ts`/`mines.ts`. Red-first: a shielded tank (`shieldUntilTick` in the future) survives a direct shell hit and a blast that would otherwise kill it; an expired shield (`shieldUntilTick` in the past) does not protect. Existing `invincible` tests must stay green unmodified (value-identical fixture).
5. **`events.ts`** — `respawn` variant. Touches the canonical union pin (the "10-kind" count in its own comment becomes 11) — update that comment.
6. **`render/particles.ts`** — `case 'respawn'`. Red-first: assert a burst at `ev.pos` on a `respawn` event, discriminated (not presence-only) per CLAUDE.md's own stated convention.
7. **`game/loop.ts`** — `campaignActive()`/`bootLives` gain `!coopActive`; `coopKills` local state + `tallyCoopKills` + reset at both `startAttempt()` sites. Red-first: (a) a coop session where P2 dies must NOT call `deps.run.setLivesRemaining`; (b) a coop boot with an existing real run in progress gets fresh `LIVES`, not the run's stale count; (c) an enemy killed by P2's shell increments `coopKills[1]`, not `coopKills[0]`; (d) an AI-on-AI friendly-fire kill increments neither slot.
8. **`hud.ts`/`hud.css`/`hud.css.test.ts`** — `.hud-coop-kills` line, mirroring the attempt-summary precedent exactly. Red-first: `setCoopKills([3,5])` + win state renders `"P1: 3 · P2: 5"`; `setCoopKills(null)` keeps the line hidden even at win/lose (1P sessions).
9. **Full gate**: `npm test`, `npm run build`, `npm run test:gl`, `npm run mutate`, `npx vitest run tools/baseline/trace.test.ts`.

**Residual, not verified in this session — flag rather than assert clean**: AI retargeting behavior at the exact tick a tracked-dead tank revives (whether `targeting.ts`/`decision.ts` hold a stale reference or cleanly reacquire) was not read this session; needs its own red-first check, not an assumption of safety. P2's derived spawn cell has no `sightlineAfterBreach`/`spawnBlockRobust` claim coverage (named already in the input-routing plan as multiplayer.md open Q4, unchanged by this plan). A coop life pool leaving wall damage unrestored across every respawn is an intended consequence of not calling `resetArena` (it's what avoids erasing the partner's progress) but is a real difficulty/feel shift from single-player's always-fresh-board convention — worth the owner knowing it's a deliberate tradeoff baked into the shared-pool design, not an oversight.

*(Closed by the implementing PR, branch `coop-semantics`: probed via `src/sim/coop-respawn.test.ts`'s "AI retargeting at the exact revival tick" block. No Tank object reference is ever cached across ticks in `ai/brown.ts`/`ai/grey.ts`/`ai/teal.ts`/`ai/index.ts` — every decision function does a fresh `world.tanks.find` against the current world, so reacquisition is clean by construction. What DOES carry across a target swap are two scalar fields on the enemy tank, `aimTicks` and `aiState`, neither reset by a change in which player `.find` returns — proven reachable: an enemy pre-set one tick short of its reaction threshold fires at a just-revived tank on the very first tick, confirmed via a real `fire` event through `stepInputs`. Not a player-safety bug: `RESPAWN_SHIELD_TICKS` (90) exceeds the longest roster `reactionTime` (48 ticks) by a wide margin, verified in the same fixture — the shielded tank survives the full span while an otherwise-identical unshielded twin dies well within it. Not fixed, per the instruction to fix only if actually broken.)*

## Deferred, named explicitly

Shield visual indicator; respawn audio cue; per-player-customization UI (already deferred by the foundation plan); a P2-specific gamepad toast (already deferred by the input-routing plan); AI awareness/targeting sophistication toward two humans; extending `structuralFailures`/arena `claims` to P2's programmatic spawn (multiplayer.md Q4); coop touching the real campaign run in any form (this PR excludes it wholesale, a future "ship it" PR decides the real interaction). `docs/research/multiplayer.md`'s open question 3 ("write the rule down before touching `resolveStatus`") is answered by this plan — its entry should be closed/rewritten in the implementing PR, same rule the backlog file already enforces elsewhere in this repo.

*(Closed in the implementing PR: `docs/research/multiplayer.md`'s open question 3 carries an additive, dated "ANSWERED for co-op" note for exactly this plan's decisions; versus is left explicitly open there, since this plan's shared-pool design assumes AI enemies remain the only opposing side.)*

## Forks for the owner

None required — every decision the brief flagged as open (shared-pool mechanics under simultaneous death, the discriminator, run-store exclusion, attribution's home, event wiring) is resolved above with a stated reason, per the instruction to refine within the adopted defaults rather than reopen them. The two numeric constants (`RESPAWN_DELAY_TICKS = 120`, `RESPAWN_SHIELD_TICKS = 90`) are feel values in CLAUDE.md's own explicit sense — picked by the same reasoning as `TANK_TURN_RATE`, cheap to retune by editing the constant since tests pin behavior against it rather than a hardcoded tick count, not something requiring the owner's sign-off before implementation starts.
