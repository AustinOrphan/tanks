# Plan — shared attempts: co-op's default win/lose model, replacing the shared pool

Status: adopted 2026-08-16, implemented on branch `coop-attempts`.

Adopted, verbatim (owner, 2026-08-16 08:00): "lives are more like shared attempts. If
all players in co op die, then a life/attempt is lost. If one player dies, the
remaining can continue on and if they clear the level, all players spawn in on the
next level. Maybe toggle this too."

Provenance: read against CLAUDE.md, `docs/superpowers/plans/2026-08-15-coop-semantics.md`
(the shipped shared-pool model this replaces as default), `src/sim/world.ts`
(`resolveStatusCoop`, `stepRespawns`, `resetArena`), `src/game/devflags.ts`
(`FLAG_REGISTRY`) and `src/game/loop.ts`'s lives/HUD wiring. The "maybe toggle this
too" is answered the same way every other feel/behavior switch in this file already
is: a `World` construction switch (`coopAttempts`), never a runtime flag read inside
`src/sim/`, flipped by a dev flag (`coopPool`) that restores the old model byte-for-byte.

## The design

**`World.coopAttempts: boolean`, default TRUE**, same pattern as `corpseBlocksShells`/
`muzzleClearsTanks`: a construction-time switch, `cloneWorld`-copied,
`ReplayMeta`-recorded (`replayMetaFor`), threaded through `createWorldFor` as a new
trailing optional parameter and closed over in `levels.ts`'s campaign branch as
`!flags.coopPool` — never read as a live flag inside `src/sim/`. The sandbox branch
does not thread it at all: the sandbox is always single-player, so `resolveStatusCoop`
is structurally unreachable there and the field stays at its default, inert (pinned in
`levels.test.ts`).

**`?dev=1&coopPool=1`** (new `DevFlags` field, `FLAG_REGISTRY` entry, `docs/dev-flags.md`
regenerated via `npm run devflags:doc`) sets `coopAttempts: false`, restoring the shipped
shared-pool model from the 2026-08-15 plan exactly as it shipped.

**`resolveStatusCoop` (`src/sim/world.ts`) branches on `world.coopAttempts`,
after the shared ~4-line win check** (unchanged: all enemies dead wins regardless of
which players are alive or dead, decided before either branch's death handling):

- **`coopAttempts === false` (POOL MODE):** the shipped `resolveStatusCoop` body, moved
  into an `if (!world.coopAttempts) { ...; return; }` block with its statements
  byte-untouched — the per-event tally, `pendingRespawn` guard and all.
- **`coopAttempts === true` (ATTEMPTS MODE, the default):** state-based, not event-based,
  deliberately mirroring the pre-existing 1P body's own `if (player && !player.alive)`
  shape rather than pool mode's per-event tally: `noneStanding = players.length > 0 &&
  players.every(t => !t.alive)`. If a survivor is still up, this is a no-op — no lives
  decrement, no `respawnAtTick`, the corpse simply stays down. Once nobody is standing,
  `world.lives -= 1` (once, regardless of how many death events landed this tick or how
  many earlier ticks contributed to the wipe — see the "two different ticks" test
  below); if lives remain, `resetArena(world)` — the single-player death experience,
  generalized to "nobody is left standing, so there is no partner's board left to
  protect"; if not, `status = 'lose'`.

No idempotency guard is needed the way pool mode's `respawnAtTick !== undefined` check
is: the moment `noneStanding` goes true, the function resolves it synchronously in the
same call — either `resetArena` revives every tank before returning (so `noneStanding`
reads false again on the very next call), or `world.status` leaves `'playing'` entirely
(so `resolveStatus`'s own top-of-function guard skips this function on every later
call). Neither leaves a window where the same wipe could be counted twice.

**`stepRespawns`/the shield machinery are untouched and are naturally inert in attempts
mode** — verified, not merely asserted: attempts mode never sets `respawnAtTick`, so
`stepRespawns` (still called unconditionally by `stepInputs` at `countPlayerTanks(draft)
>= 2`) finds nothing to revive on every tick. No second gate was added; the same
mechanism that makes `stepRespawns` a no-op at `playerCount < 2` (nothing ever schedules
it) makes it a no-op in attempts mode too (nothing ever schedules it there either).
Pinned by driving a real 2-player world 300 ticks (5s, well past `RESPAWN_DELAY_TICKS`'s
120) through `stepInputs` with one player dead and confirming it never revives, plus a
direct `stepRespawns` call on the same corpse confirming it, too, is a no-op absent a
scheduled tick.

**Win is unchanged**: the shared prefix already ran before either branch, and does not
inspect player alive state at all — a dead partner does not block a win, and does not
get revived by one (pinned directly: a dead A, an already-dead enemy, `resolveStatus`
still returns `'win'` with A left dead).

**A level clear reviving everyone** ("if they clear the level, all players spawn in on
the next level") falls out of existing machinery rather than needing new code:
`switchTo` → `buildWorld` → `deps.levels.world(...)` always constructs a brand-new world
via `loadArena`, which starts every tank alive by construction. This is verified through
the real `startGameWith` wiring in `loop.test.ts` (not merely asserted): a coop session
with a dead P2 that clears the level, then a real "Next Level" click
(`hud.onStartRestart`), produces a **new** world object (not the same one revived) with
both players alive — proven to actually depend on the rebuild by a mutation check during
this session (making `switchTo` skip the rebuild broke both the attempts-mode and the
explicit `coopPool=1` version of this test).

**`resetArena` needed no changes.** It already iterates `world.tanks.length` and indexes
`world.spawns[i]` for every tank — players and enemies alike — so the only question was
whether the index invariant (`world.tanks[i] <-> world.spawns[i]`) holds at coop's
player counts. Verified directly against real `createWorldFor`-built worlds at N=2 and
N=4 (real walls, real enemy roster, real spawns array from a shipped arena): every tank
lands back on its own `spawns[i]` cell, alive, with walls restored and
bullets/mines/blasts cleared.

**Cross-mode leftover cleanup was considered and is unnecessary, by construction, not
merely by assumption.** In attempts mode `respawnAtTick`/`shieldUntilTick` are never
set, so there is nothing to clear. Could a `resetArena` call in attempts mode ever run
while a POOL-mode respawn is pending? No: pool mode has no full-wipe branch that calls
`resetArena` at all (verified directly — a full wipe with pool lives remaining schedules
per-tank respawns instead, and walls/bullets are provably left untouched), so the two
modes' machinery can never interact within a single call. A mid-run flag flip is not
possible either (the flag is read once, at world construction, in `levels.ts`'s
closure), so no cross-mode leftover state is reachable.

## Red-first test plan, with counts

Every piece below was written test-first against the shipped pre-`coopAttempts` code and
made green by the implementation, per this repo's own "prove the gap before writing the
test" rule. Two mutation-proofs were also run live during this session (not merely
claimed): flipping the `noneStanding` early-return to a constant `false` broke 3 of the
new attempts-mode tests, and flipping the `resetArena`-vs-`lose` branch condition to
always take the `resetArena` side broke the zero-lives lose test — both reverted via the
editor, not `git checkout`, so no work was at risk. Separately, two of the new fixtures
(the multi-tank `coopWorld` helper and the 1P regression world) initially crashed
`resetArena` with an undefined `spawns[i]` read, because their hand-built `spawns`
arrays were one entry short of their `tanks` arrays — a test-fixture bug, not a
production one, caught immediately by the first run and fixed by adding the missing
spawn entries before any assertion was evaluated.

New file `src/sim/coop-attempts.test.ts` (17 tests, all passing):

- **attempts-mode death, no decrement, no respawn** (1 test) — a lone death leaves
  `lives`, `alive`, `pos` and `status` all untouched, and `respawnAtTick` stays
  `undefined`.
- **survivor-carries** (2 tests) — a still-alive partner is untouched by the other's
  death; a dead partner does not block a win (the win check ignores dead players).
- **full-wipe-with-lives** (3 tests) — exactly one life spent for a simultaneous
  two-player death; exactly one life spent when the wipe completes across two
  *different* ticks (state-based, not event-counted); `resetArena`'s full effect set
  (players AND the enemy revived at their own spawn cells, wall restored, bullets/
  mines/blasts cleared, `roundStartTick` advanced past the current tick).
- **full-wipe-at-zero** (1 test) — drains to 0, `status: 'lose'`, a `'lose'` event
  pushed, and explicitly **no** `resetArena` effect (corpses stay exactly where they
  fell, the damaged wall stays damaged).
- **no `respawnAtTick` stamped on the wipe path either** (1 test).
- **`stepRespawns` inertness** (1 test) — both through the real `stepInputs` pipeline
  over 300 ticks and via a direct call on the same corpse.
- **1P regression** (1 test) — `resolveStatus`'s existing `countPlayerTanks(world) >= 2`
  guard is untouched; a 1-player world with `coopAttempts: true` still runs the original
  1P body (decrement, `resetArena` at lives > 0).
- **pool-mode regression, re-proven against an explicit `coopAttempts: false` world**
  (3 tests) — the single-death-schedules-a-respawn rule and the simultaneous-double-
  death-at-pool-2 split, both still true when pool mode is explicitly selected; plus a
  new check that pool mode's full-wipe case has **no** `resetArena` branch at all (walls/
  bullets are left untouched, both tanks get their own scheduled respawn instead).
- **`World.coopAttempts` defaults** (2 tests) — `createWorld` defaults to `true` when
  omitted and carries it through `cloneWorld`/`stepInputs`; an explicit `false` is
  honored the same way.
- **`resetArena` at N=2 and N=4** (2 tests, one per player count) — real
  `createWorldFor`-built worlds (real arena, real enemy roster), a full wipe with lives
  remaining, asserting the index invariant and every effect listed above holds at both
  counts.

`src/game/levels.test.ts` (+5 tests): `coopPool` reaching `world.coopAttempts` through
`createLevelSystem`'s closure (composition, not unit — the same distinction the existing
`corpseBlock`/`muzzleInside` block draws), independence from the other two playtest
flags, a real two-player build, and confirmation the sandbox branch does **not** wire it
(the field stays at its default there, since `createSandboxWorld` never sees it).

`src/game/devflags.test.ts` (+3 tests): `coopPool` needs `dev=1` like every other flag;
is off by default even with `players=2`; is not part of the playtest bundle. The
generic, pre-existing "every boolean flag independently settable" sweep and the
`registryKeyMismatch(FLAG_REGISTRY, DEV_FLAGS_OFF)` completeness check both picked up
`coopPool` automatically — no edits needed there, which is the point of that guard.

`src/game/loop.test.ts` (+2 tests, "shared-attempts ruling" describe block): a coop
session with a dead P2 that clears the level, verified through the real `startGameWith`
wiring — the "Next Level" click produces a genuinely new world (not the same one
revived) with both players alive — under the default (attempts) and again under
`coopPool=1` (a P2 corpse mid-respawn-wait, `respawnAtTick` set, is also cleared by the
fresh build). The second test required one honest fix to the test file's own fake
`levels.world()` harness: it built coop worlds via the real `createWorldFor` already
(needed for the N-player foundation's `controlledBy` claims) but did not thread
`coopPool` through as an argument, so it silently built every fake coop world at the new
default regardless of the flag under test — fixed by reading `opts.devFlags?.coopPool`
the same way the real `levels.ts` closure does.

`src/game/replay.ts`/`replay.test.ts` (+1 field, +1 test): `ReplayMeta` gained
`coopAttempts`, `replayMetaFor` reads it off the world, and the round-trip rebuild in
both `replay.test.ts`'s `worldFor` helper and `loop.test.ts`'s replay-trace rebuild
thread it through — the same "ALL meta fields thread through" convention those files
already state for `corpseBlocksShells`/`muzzleClearsTanks`.

**Flag wiring + registry**: `coopPool` is a `DevFlags` field with a `FLAG_REGISTRY`
entry — the `Record<keyof DevFlags, FlagSpec>` annotation makes a missing entry a
compile error, so `npx tsc --noEmit` is itself part of this guard. `docs/dev-flags.md`
was regenerated via `npm run devflags:doc` and `tools/devflags/doc.test.ts` (which
compares the committed file against what the renderer produces right now) passes.

## Pool-mode regression: the shipped tests, byte-unchanged — and the finding

Per instruction, `src/sim/coop-respawn.test.ts` was **not edited**. **3 of its 22 tests
now fail**, unmodified, against the implementation above:

- `a single player death drains the pool by 1 and schedules a respawn, without reviving
  immediately`
- `simultaneous double death at pool 2: one revives, the other stays down permanently`
- `a respawn scheduled on an EARLIER tick survives a LATER death that drains the pool
  to 0`

The other 19 (including, non-obviously, `does not stamp a respawn a second time...` and
`simultaneous double death at pool 1...`) still pass — the first because its only
observable death is a single player's, which is a no-op in both models; the second
because a shared pool of 1 reaches `lives: 0` either way, by coincidence of arithmetic,
not by design.

**Root cause, named precisely**: all three failures build their world via a bare
`twoPlayerWorld` helper that calls `createWorld({...})` with no `coopAttempts` field —
which, under the new default, silently starts testing attempts-mode semantics instead of
the pool-mode semantics the assertions were written against. This is the direct,
structural consequence of `coopAttempts` defaulting to `true` at the `createWorld`
primitive itself (the literal instruction: "same pattern as corpseBlocksShells... DEFAULT
TRUE"), the same layer every one of these tests constructs its fixtures at. It is not a
new failure mode for this codebase — `muzzleClearsTanks` flipped an existing shipped
default the same way when it landed, and every fixture that needed the *old* behavior
was updated at the time to pass `muzzleClearsTanks: false` explicitly (visible today in
`bullets.test.ts`'s literal `muzzleClearsTanks: true`/`false` fixtures). The same fix
would apply here — one field added to `twoPlayerWorld` — but is deliberately not applied
in this PR, per instruction, so this paragraph is that instruction's residual rather than
an oversight.

The pool-mode BEHAVIOR itself was not left unverified: `coop-attempts.test.ts`'s "POOL
MODE, explicitly requested" block reproduces the same claims (single death schedules a
respawn; simultaneous death at pool 2 splits into one revival and one permanent corpse)
against worlds that explicitly set `coopAttempts: false`, and both pass. What is left
unverified by construction is only the literal claim "the pre-existing file needs zero
edits to keep passing," which this session's evidence contradicts.

**Why this is a different case from the guard-first split's first two uses.**
`resolveStatus`'s guard-first branch on `countPlayerTanks(world) >= 2` (the 2026-08-15
plan) and this PR's second guard-first inside `resolveStatusCoop` both kept every
*existing* test green the moment they landed, because the new branch only ever served
*new* inputs (N&ge;2-tank worlds) that no pre-existing test constructed — there was
nothing for the new code to change out from under. This time that assumption breaks: the
new default is selected by the SAME discriminator (`coopAttempts`, defaulting `true`) at
the SAME construction primitive (`createWorld`) that `coop-respawn.test.ts`'s own
N&ge;2-tank fixtures already used, before this field existed. So the new branch does not
serve only new inputs — it silently re-serves an EXISTING test's inputs under new
semantics. That is the precise reason "guard-first, existing tests stay green" — true
twice before in this file's own history — was the wrong prior to carry into this change,
and it is why report-not-edit is the correct call rather than a shortcut: the tension is
structural, not a mistake to route around.

**The trivial remedy, named for the owner rather than applied.** Adding one field,
`coopAttempts: false`, to `coop-respawn.test.ts`'s `twoPlayerWorld` helper would make all
22 of its tests pass again while still testing exactly what they always tested (pool
mode) — the identical fix `muzzleClearsTanks`'s own default flip received at the time it
landed. This was deliberately NOT applied, per the explicit instruction not to edit that
file. If the owner wants it applied, it is a one-line, low-risk change; if the owner
wants `coop-respawn.test.ts` left exactly as shipped with 3 known-red tests as a
permanent marker, that is also a coherent, defensible choice. Either way it is a decision
for the owner to make, not one this session should make unilaterally by either editing
the file or asserting the residual away.

## Gate

All run explicitly, in order, after committing (`tools/mutate` refuses to run against
uncommitted changes to files it mutates):

- `npx tsc --noEmit`: exit 0.
- `npm test` (`tsc --noEmit && vitest run`): **exit 1** (checked directly, not read off a
  piped command whose exit code a `tail` would have swallowed) — 2502 passed, 3 failed
  (the `coop-respawn.test.ts` residual above), 2 skipped, of 2507 tests total, across
  113 test files (111 passed — including `player-profile.test.ts`, which has 1 skipped
  test but is not itself a skipped file; 1 file fully skipped,
  `ai/engagement.measure.test.ts`; 1 failed, `coop-respawn.test.ts`). The failure is the
  reported, expected residual, not a regression discovered after the fact — the same 3
  failures were observed both before and after the mutation-manifest/build/trace steps
  below, and before/after the loop.test.ts harness fix.
- `npm run mutate`: exit 0 — 13/13 manifest entries ran, 11 killed, 2 survives (both
  declared as such: `skins-ensure-contrast-pole-clamp`, an equivalent mutant, and
  `preview-drops-the-rotate-buttons`), 0 mismatches against declared outcomes. One entry
  (`preview-drops-the-rotate-buttons`) targets `src/render/preview.ts`, which this PR
  also touched (adding `coopAttempts: true` to the fixture `World` literal
  `previewWorld()` returns) — it ran and reported its declared SURVIVES outcome
  unaffected, since the manifest's find/replace targets a different line in that file.
- `npm run build` (`tsc --noEmit && vite build`): exit 0.
- `npm run portability`: exit 0.
- `npx vitest run tools/baseline/trace.test.ts` (the golden trace, explicitly, per
  instruction): exit 0, **hash unmoved** —
  `324aa9b5d369ec6abc61f73e8e454de67b5fbf365f4b0df2eedf2c01add33bb5`, matching the
  5-arena baseline pinned in CLAUDE.md. Expected structurally: the trace drives exactly
  one player, `countPlayerTanks` is 1 on every tick, and `resolveStatusCoop` (in either
  mode) is never entered.

## HUD

The NUMBER is checked and correct, no change made: `hud.ts` shows
`Lives: <span class="hud-lives">3</span>` and "Out of lives." on the lose panel;
`refreshStats` feeds it straight from `w.lives`, which in attempts mode already IS the
attempt count the ruling describes. Nothing in the shipped strings claims per-player
lives or implies per-death loss, so no copy needed changing.

**One real gap found, not fixed — a design decision, not a "smallest honest change".**
`signalPlayerDeath()` (`hud.ts:1523`) unconditionally flashes `.hud-lives` with
`hud-lives--hit` (a "you just lost one" cue) every time it runs, and `loop.ts`
(`onFrameEvents`, line 848) calls it whenever `isPlayerDeath(events, playerId)` — the
TRACKED player (slot 0) — dies THIS frame, regardless of coop mode. In attempts mode, a
solo P1 death (survivor continues, `world.lives` untouched) still fires this flash: the
lives counter visibly reddens as if an attempt was spent when it was not. This is new
exposure from this PR, not a pre-existing bug — under the shipped pool model every
tracked-player death also decremented the pool 1:1, so the flash and the number always
agreed; attempts mode breaks that correlation for the survivor-carries case specifically.
Not fixed here: whether the flash should be suppressed for a no-cost solo death, replaced
with a different "teammate down" cue, or left as-is (arguably still a legible "you were
hit" signal, just not a "you lost a life" one) is a feel/product call, the same class of
decision this file's own "Deferred, named explicitly" precedent (shield visual indicator,
respawn audio cue) leaves for the owner rather than guessing. Dev-flag-only and unshipped
today (`?dev=1&players=2`), so not blocking — named here so it is not silently missed.

## Deviations from the brief

- **`coop-respawn.test.ts`**: not edited, 3 of 22 tests fail unmodified — see the
  dedicated section above. This is the one instruction-level deviation from a fully
  green `npm test`, and it is deliberate, not an oversight.
- **`loop.test.ts`'s fake `levels.world()` harness**: one line added (threading
  `opts.devFlags?.coopPool` into the fake coop-world builder's `createWorldFor` call) —
  not itself part of the shipped game, but needed for the new `coopPool=1` loop-level
  test to exercise what it claims to exercise rather than silently passing against the
  wrong mode.
- Everything else in the brief (default flip, branch dispatch, dev flag + registry +
  doc regen, `ReplayMeta`, `resetArena` verification at N=2/N=4, HUD check, red-first
  counts, full gate) was implemented and verified as specified, with no other scope
  changes.

## Commits

`git log` on branch `coop-attempts`, off `origin/main` at `ba3d61d` — see the branch's
own history for the exact SHA and message; not reproduced here since this file is
committed alongside the work it describes and would otherwise need updating on every
amend.
