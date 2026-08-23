---
status: completed
date: 2026-08-17
last-reviewed: 2026-08-23
scope: Free-for-all and teams mode plumbing, player placement, targeting, and friendly fire
implementation-issues: []
implementation-prs: [186]
supersedes: []
superseded-by: []
---
# Plan — Modes: FFA and teams

Status: adopted 2026-08-17, implemented on branch `versus-modes`.

Provenance: PR 4 of the 4-PR N-player arc (owner directives baked in: bots as simulated
players, ceiling to 4, FFA + teams, 1-4 controllers), from the arc design's own "PR 4 —
Modes: FFA and teams" section (`/tmp/nplayer-arc-design.md`). Read against
`docs/superpowers/plans/2026-08-16-players-n.md` (PR 1, merged as #177),
`docs/superpowers/plans/2026-08-16-bots.md` (PR 2a, merged as #179) and
`docs/superpowers/plans/2026-08-17-controllers-4.md` (PR 3, merged as #183), all already
on `main`, and against the shipped co-op semantics this PR's dispatch generalizes a
fourth way (`src/sim/world.ts`'s `resolveStatus`/`resolveStatusCoop`, the `coopAttempts`
branch). Reproduced below as adopted; owner directives dated 2026-08-15 ("Free for all
and team modes") and 2026-08-16 08:19 ("there will be a coop and a vs mode down the
line" — the mode seam is the point).

---

## PR 4 — Modes: FFA and teams

**Representation.** `World.mode: GameMode` (`'campaign-coop' | 'ffa' | 'teams'`),
non-optional on `World` but optional on `createWorld`'s init (defaulting to
`'campaign-coop'`) — the exact same shape as `corpseBlocksShells`/`muzzleClearsTanks`.
`World.friendlyFire: boolean`, same pattern, meaningful only in `'teams'` mode
(self-disabling elsewhere by construction), default `false` (protect teammates by
default; no canonical prior source was checked for tank-vs-tank team play specifically,
named as a feel choice with an escape hatch rather than asserted as "the" convention).
`Tank.team?: number`, optional, stamped once at spawn time in `loadArena`'s existing
PASS 1a (P1) / PASS 1b (co-players), only when `mode === 'teams'` — a pure
`teamOf(slot) = slot % 2` (`src/sim/arena.ts`, exported), 2 teams alternating by slot.
Uneven splits (3v1) are out of scope, named as a deferred richer mode.

**Enemies in versus modes: stripped, not repurposed.** `loadArena`'s PASS 1a skips
non-player spawn letters when `mode !== 'campaign-coop'`: enemy letters are typed
(`brown`/`grey`/`teal`/etc., each with its own weapon/behavior via `resolveTankConfig`),
so repurposing one as a bonus player slot would couple a versus session's player count
to whatever roster a level's *campaign* design happened to author. Player placement uses
the same P1-plus-ring-search machinery every other PR in this arc reaches. Direct
consequence: arena claims/validator need no change — `arena-claims.ts`'s
`sightlineAfterBreach`/`spawnBlockRobust` machinery is entirely about ENEMY spawns, and
versus modes have none.

**Win/lose: single life per round, no stock/lives system.** Rejected a Smash-style stock
counter: real added design surface (elimination-vs-death as distinct states, its own
respawn timing) no owner directive asked for, and it collides with
`stepRespawns`/`RESPAWN_DELAY_TICKS`, which exists for campaign-coop's shared pool.
`stepRespawns`'s gate in `stepInputs` tightens from `countPlayerTanks(draft) >= 2` to
`mode === 'campaign-coop' && countPlayerTanks(draft) >= 2` — functionally a no-op (only
`resolveStatusCoop` ever sets `respawnAtTick`, so the old gate already never revived
anyone outside campaign-coop), but it makes the mode boundary legible everywhere it is
checked. `resolveStatus` is a dispatch: `'ffa'`/`'teams'` route to their own functions
FIRST, `'campaign-coop'` falls through into the ORIGINAL guard-first body,
byte-untouched. FFA win = exactly one player tank alive, every other player tank dead.
Teams win = one team's players all dead, the other team has a survivor. A simultaneous
final wipeout (the last two tanks, or the last two teams, trade a kill the same tick)
resolves to `'lose'` — deliberately NO `'draw'` status: growing `World.status`'s 3-value
union touches `game/state.ts`'s win/lose branches, HUD panel copy and achievements
gating, real separately-scoped surface no owner directive asked for. Named residual, not
a silent gap.

**Team is a three-place concept — all three needed, not just damage.** Restricting the
team check to `bullets.ts` alone would leave teammates shell-safe but still
mine-vulnerable, and would leave bots unable to fight at all in versus modes.

1. **Shell damage** (`bullets.ts`, `resolveBulletHits`, the `isDamageImmune` check's
   neighborhood): gated on `t.team !== undefined && ownerTeam !== undefined &&
   t.team === ownerTeam && !world.friendlyFire` — `ownerTeam` resolved via
   `world.tanks.find(id === b.ownerId)?.team`, no new `Bullet` field (mirrors how shell
   tint already resolves owner identity at hit/render time rather than widening the
   struct).
2. **Mine-blast damage** (`mines.ts`'s `applyBlast`, the sibling site `isDamageImmune`
   already touches): identical gate, resolved via the blast's CREDIT owner (the same
   tank whose credit already decides who gets the kill), same resolution pattern.
3. **Bot targeting** (`ai/player-profile.ts`'s `isOpponent`, the seam PR 2b built for
   exactly this): mode-aware — `'campaign-coop'` is today's rule byte-for-byte
   (`other.kind !== 'player'`), `'ffa'` is any other alive player tank
   (`other.id !== subject.id`), `'teams'` is any other alive player tank on a different
   team (`other.team !== subject.team`). No new parameter on `decidePlayerInput`'s
   signature. This is the fix that lets a bot actually fight in FFA/teams — without it,
   a bot dropped into a versus match finds zero targets and wanders.

Both damage gates are self-disabling outside `'teams'` by construction — `t.team` is
only ever stamped when `mode === 'teams'`, so the `!== undefined` guard trivially never
fires elsewhere, the same "optional field, absent means today's behavior" idiom
`isDamageImmune` itself already uses. Named residual, deliberately not fixed: bots still
dodge a teammate's shell even when friendly fire is off (harmless — wastes a tick of
movement, not a bug).

**Attribution/HUD.** `loop.ts`'s `tallyCoopKills` generalizes into a mode dispatch:
`'campaign-coop'` keeps exactly today's rule (enemy kills only, AI-on-AI friendly fire
excluded); `'ffa'`/`'teams'` count a `tank-destroyed` event where BOTH victim and killer
are player-kind, crediting the killer's slot a kill and the victim's slot a death —
self-elimination (killer id === victim id, an own shell or own mine) credits a death and
a kill to NOBODY, the no-suicide-credit convention common to arena shooters. The existing
`coopKills` array is reused for both dispatch branches (a world's `mode` is fixed for its
whole life, so campaign-coop kills and versus kills never coexist in one session); a new
`versusDeaths` array is the ffa/teams-only addition, reset at the same three lifecycle
sites `coopKills` already resets at. Teams sums a per-team total from the per-slot
figures as a DERIVED reduction at HUD render time (`teamOf`, no new storage). HUD gets a
new `.hud-versus-results` line following the `.hud-coop-kills` precedent exactly (new
selector, `hud.css` rule, `hud.css.test.ts` entry) — mutually exclusive per session with
the coop line, dispatched on `driver.world.mode`.

**Render — team color is new work, not covered by PR1's extension.** PR1's 4-entry
`IDENTITY_RING_COLORS` distinguishes *individual* players; teams mode wants the
opposite — knowing "which of 2 sides" matters more than which teammate. `TEAM_COLORS`
(2 hues, red/blue) is teams mode's alternative colour source at the SAME lookup site
PR1's per-slot lookup already lives (`entities.ts`'s ring creation inside `syncTanks`,
and `shellTintFor`), dispatched on `curr.mode === 'teams'`. Same reuse-the-mechanism,
new-colour-source shape PR1 itself used for the placeholder swatch.

**Replay: fixed, not deferred.** `mode` is not derivable from the tank array the way
`playerCount` is — a recorded FFA session replayed without it would reconstruct at the
`'campaign-coop'` default and `resolveStatus` would dispatch differently on playback
than it did live, silently producing a different win/lose outcome. `ReplayMeta` gains
`mode: GameMode` and `friendlyFire: boolean`, read directly off `world.mode`/
`world.friendlyFire` at record time (`replayMetaFor`), threaded into `createWorldFor`'s
new trailing params. `REPLAY_SCHEMA` bumps 2 → 3 — no tick-shape change, only the meta
shape.

**Flags.** `mode` (valued: `ffa`|`teams`; absent = `campaign-coop`, reject-to-null like
`quality`/`mineTrigger`) and `friendlyFire` (boolean, off by default) — both with
`FLAG_REGISTRY` entries and a regenerated `docs/dev-flags.md`. Closed over in
`levels.ts`'s campaign branch, the same treatment `corpseBlock`/`muzzleInside`/
`coopPool` already get; the sandbox branch does NOT wire either (always single-player
campaign-coop, matching `coopPool`'s own exclusion).

**File-level changes:** `sim/types.ts` (`GameMode`, `Tank.team?`), `sim/world.ts`
(`World.mode`/`friendlyFire`, `resolveStatus` dispatch, `resolveStatusFfa`/
`resolveStatusTeams`, `stepRespawns`' gate), `sim/arena.ts` (`teamOf`, mode-aware PASS
1a skip, team stamping, `createWorldFor`'s trailing params), `sim/ai/player-profile.ts`
(`isOpponent`), `sim/bullets.ts` + `sim/mines.ts` (friendly-fire gate, mirrored),
`game/devflags.ts` (`mode`, `friendlyFire`), `game/levels.ts` (closure wiring),
`game/loop.ts` (`tallyCoopKills` dispatch, `versusDeaths`, HUD dispatch), `game/replay.ts`
(`ReplayMeta.mode`/`friendlyFire`, schema bump), `game/hud.ts`/`hud.css`/
`hud.css.test.ts` (`.hud-versus-results`), `render/entities.ts` (`TEAM_COLORS`,
`teamColor`).

---

## Measured against the source design

**Trace argument, confirmed empirically at two checkpoints, not merely argued.**
`BASELINE_HASH` (`a5458ede003c173ccc099b708f4b7d43b7537ca8a7846a87274b6376ccc311a9`) was
re-run via `npx vitest run tools/baseline/trace.test.ts` after the `world.ts` change
(dispatch added) and again after the `arena.ts` change (enemy stripping + team
stamping), and a third time on the fully final tree — unmoved all three times. `mode`
defaults to `'campaign-coop'` at every existing call site that does not pass one
explicitly, including `tools/baseline/trace.ts`'s own 2-arg `createWorldFor` call, which
routes `resolveStatus`'s new dispatch into the branch containing today's byte-untouched
body.

**Red-first, denominators stated per piece (population is "the new tests added for that
piece" unless noted otherwise):**

Every count below was re-verified empirically against the pre-implementation code (not
merely inferred from a `tsc` error count) by one of two methods: a temporary
`git show <prior-commit>:<file>` swap-in of the OLD implementation with the NEW test
file, run, then restored (verified via `git diff --stat` showing zero drift); or, for
`entities.ts`, a direct mutation of the two dispatch ternaries back to their pre-PR4
form. This caught two errors in an earlier running tally — the loop.ts and arena.ts
counts below were corrected after the actual re-run disagreed with an inline estimate
made while writing the code.

- `world.ts` dispatch (`src/sim/versus-modes.test.ts`, 12 new tests): **10 of 12 red**
  against pre-PR4 `world.ts` (`createWorld`/`resolveStatus` had no `mode` field or
  dispatch at all). The 2 that passed did so vacuously — both are "still playing,
  nothing decided yet" no-op cases any reasonable dispatch agrees on.
- `arena.ts` (`arena.test.ts`, **7** new tests: 5 in the `loadArena` mode-aware describe
  block, covering enemy stripping, team stamping and the team-undefined negative
  control across all 5 shipped arenas, plus 2 more in a `createWorldFor` threading
  block): **3 of 7 red**; 4 passed vacuously (a population-count assertion, a
  campaign-coop-unchanged regression, the team-undefined negative control, and
  `createWorldFor`'s own default-args case).
- `bullets.ts` friendly fire (`bullets.test.ts`, 4 new tests: FF-off-teammate,
  FF-off-enemy, FF-on-teammate, team-undefined negative control): **1 of 4 red** — the
  gate is a no-op except the single "friendly fire off, same team" case, so only that
  one exercises genuinely new behaviour; the other 3 fixtures already matched
  pre-existing unconditional-kill behaviour.
- `mines.ts` friendly fire (`mines.test.ts`, same 4-case shape as bullets, mirrored):
  **1 of 4 red**, same reasoning.
- `isOpponent` (`player-profile.test.ts`, 3 new tests, one per mode): **2 of 3 red** —
  the campaign-coop case passed vacuously (today's rule, unchanged); ffa and teams both
  failed against the pre-PR4 kind-only predicate.
- `devflags.ts` `mode` flag (`devflags.test.ts`, 5 new tests): **5 of 5 red** (the
  `.mode` field did not exist on `DevFlags` at all); `friendlyFire`'s boolean-flag
  coverage rides the file's own existing population-derived sweep over every
  `DEV_FLAGS_OFF` boolean key, not a bespoke test, so it is not counted separately here.
- `levels.ts` composition (`levels.test.ts`, **7** new tests: 6 in the campaign-branch
  describe block, 1 more in the sandbox describe block as a negative control): **4 of 7
  red** (the mode-absent-default, friendlyFire-off-default and sandbox-exclusion cases
  passed vacuously — 3 of 7, not 4).
- `replay.ts` (`replay.test.ts`): **2** genuinely new `it` blocks (a
  `replayMetaFor`-reads-mode-and-friendlyFire case and a round-trip-through-
  `createWorldFor`-at-schema-3 case), plus 3 pre-existing `toEqual` fixtures edited to
  include the two new required `ReplayMeta` fields as collateral (not new coverage).
  Re-run against the pre-PR4 `replay.ts` (schema 2, no `mode`/`friendlyFire` on
  `ReplayMeta`): **5 of 5 touched tests red** (the 2 new plus the 3 edited).
- `tallyCoopKills` (`loop.test.ts`, **7** new tests: 2 modes (ffa/teams) x 3 cases each
  (a normal kill/death pair, a self-elimination, an accumulation mixing both) = 6,
  plus 1 shared campaign-coop non-interference test; 8 pre-existing calls updated for
  the new `deaths` parameter, unaffected in behaviour since the OLD 3-arg function
  silently ignores a 4th JS argument): re-run against the pre-PR4 3-arg
  `tallyCoopKills` (which `continue`s past any `e.kind === 'player'` victim, so it
  never touches `kills`/`deaths` for a player-vs-player event): **6 of 7 red** — the 6
  mode-loop cases; the 7th (campaign-coop non-interference) passed vacuously, since the
  old body already produced empty `kills`/`deaths` for a player-kind victim.
- `hud.ts` `setVersusResults` (`hud.test.ts`, 5 new tests mirroring the 5
  `setCoopKills` cases): **5 of 5 red** (the method did not exist).
- `loop.ts` versus HUD dispatch, end to end (`loop.test.ts`, 1 new test, added in
  review after the rest of this table was first drafted): `tallyCoopKills` and
  `setVersusResults` above are each unit-tested directly, which cannot see whether
  `onFrameEvents` still routes a real frame's kill into `setVersusResults` at all — the
  composition blindness CLAUDE.md names for the coop precedent, on its versus twin.
  Writing it also surfaced that `loop.test.ts`'s fake `levels.world()` dropped
  `devFlags.mode`/`friendlyFire` silently (never threaded into its `createWorldFor`
  call), so any versus test against it would have built a `campaign-coop` world with no
  signal anything was wrong; the fake was extended to thread both, mirroring its
  existing `coopPool` precedent, and the new test asserts `world.mode === 'ffa'` first
  to rule out that vacuous pass. **1 of 1 red** against pre-PR4 `loop.ts` (verified by a
  `git show 1a9f303:src/game/loop.ts` swap-in, restored via `git diff --stat` showing
  zero drift): failed with `TypeError: Cannot read properties of undefined (reading
  'mode')`, since `versusResultsPushes` never received a non-null push under the old
  unconditional `setCoopKills`-only dispatch.
- `entities.ts` `TEAM_COLORS`/`teamColor` (`entities.test.ts`, 3 new tests: a
  distinctness sweep plus a ring-dispatch and a shell-tint-dispatch test): the
  distinctness sweep does not depend on the dispatch and would pass either way; the two
  dispatch tests were VERIFIED red by mutation, not merely argued — the two dispatch
  ternaries were reverted to bare `identityColor(...)` calls and the suite re-run,
  confirming **2 of 2** dispatch tests fail without the mode-aware code, then restored.

**Are the three team-concept places independently tested?** Yes — each has its own
dedicated test file and fixture shape: `bullets.test.ts`'s 4-case friendly-fire block
(shell damage), `mines.test.ts`'s 4-case mirror (mine-blast damage, resolved via blast
credit rather than the raw mine owner), and `player-profile.test.ts`'s 3-mode
`isOpponent` block (bot targeting, verified via `decidePlayerInput`'s observable
movement/aim behaviour rather than by exporting the private predicate). No single test
covers more than one of the three.

**Full gate, all exit code 0:**
- `npx tsc --noEmit` — clean.
- `npm test` (`tsc --noEmit && vitest run`) — 113 files passed, 1 skipped; 2628 tests
  passed, 2 skipped; 0 failed (2627 before the review-driven `loop.test.ts` addition
  above).
- `npm run mutate` — 13/13 mutation(s) ran: 11 killed, 2 survives (both pre-existing
  declared `equivalent mutant`/expected survivors, unrelated to this PR), 0 mismatches
  vs. declared outcome. `replay-recorder-wraps-the-raw-controller`'s declared
  `expectFailures: 4` reads "4 of 253 test(s) failed" as of the final re-run (after the
  review-driven `loop.test.ts` addition above) — the scoped population moved 245 (PR3)
  -> 252 (this PR's first `loop.test.ts` additions) -> 253 (the composition test added
  in review), the numerator holding at 4 throughout, the same population-vs-count
  distinction CLAUDE.md's testing conventions section asks for.
- `npm run build` (`tsc --noEmit && vite build`) — clean.
- `npm run portability` — clean, against the built `dist/`.
- `npm audit --omit=dev --audit-level=high` — 0 vulnerabilities.
- `npm run test:gl` — 61/61 GL checks passed (transitively exercises `entities.ts`
  through `renderer.ts`/`preview.ts`, though the harness's own world is single-player
  and does not itself drive the new team-colour code path — that path's coverage is
  `entities.test.ts`'s mutation-verified headless sweep above). First two attempts hit
  a `page.waitForFunction` timeout unrelated to this PR's diff (`tools/gl/run.mjs` is
  untouched; load average was 5.18 on 4 cores from concurrent sessions on this shared
  box at the time) — a third attempt, and a manual equivalent script run outside
  `npm run`, both completed cleanly with all 61 checks passing, which is the evidence
  this is environment contention rather than a regression.
- `tools/baseline/trace.test.ts` — see the Trace argument above.

**Deviations from the source design:** none in shape. One judgment call the design left
open: FFA/teams at `playerCount === 1` (a degenerate, dev-flag-only configuration —
`?dev=1&mode=ffa` with `players` unset) satisfies "exactly one player alive" from the
moment the round starts, so `resolveStatusFfa` would resolve an immediate win on the
first `resolveStatus` call. The design does not name this case; the implementation does
not special-case it either, since "exactly one player alive, every other dead" is
vacuously true with zero others and inventing an unrequested minimum-player-count guard
was judged out of scope. Named here rather than silently patched.

**Stays deferred, named (unchanged from the source design):** mode-select UI beyond dev
flags, matchmaking, online (multiplayer.md's blockers 1/3/6, all untouched by this arc),
FFA stock/lives variant, uneven team splits, a `'draw'` status distinct from `'lose'`,
teammate-shell dodging (bots avoid harmless friendly fire — cosmetic-only, not fixed).
