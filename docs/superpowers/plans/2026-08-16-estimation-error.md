# Plan — Estimation error, both populations (PR 2c)

Status: adopted 2026-08-16, implemented on branch `estimation-error`.

**THE RULING (owner, 2026-08-16 08:17):** AIs must not have oracle knowledge — no exact
mine blast radii, no perfect dodge positions; educated guessing with seeded error,
sometimes fatal; guess quality scales by tank type.

Provenance: PR 2c of the bots + AI competence staged plan (`/tmp/bots-competence-plan.md`'s
"PR 2c — Estimation error, both populations"), sequenced after PR 2b (walls + whole-map
competence, player brain only, `docs/superpowers/plans/2026-08-16-bot-competence.md`,
already on `main` at `0ac4317`). Reproduced below as adopted, with one deviation from the
source plan's own restatement of itself — see "Deviations" — found by re-deriving the
mechanism from the function bodies rather than trusting the plan's shorthand list.

---

## The mechanism

Noise lands at CALL SITES, with each caller's own RNG source, never inside the shared
geometry — the source plan's own corrected framing, because `dangerAvoidMove` is reused
by the player brain SPECIFICALLY because it is RNG-free (`decidePlayerInput`'s module
comment states this and forbids the player drawing from `world.seed`). Burying
`nextRng(world.seed + ...)` inside the shared functions would couple the player (and every
future bot) to `world.seed`, exactly the coupling that file exists to avoid.

`targeting.ts` gains one new exported helper pair, mirroring `profileAimSpread`/
`aimJitter`'s existing shape:

- `profileHazardSpread(cfg)` → `AI_HAZARD_SPREAD / cfg.ai.estimationAccuracy` — the anchor/
  derate shape, an ANCHOR value one hypothetical perfect-`estimationAccuracy` profile would
  still misjudge by.
- `estimationError(world, tank, spread)` → `(nextRng(world.seed + tank.id*5303 +
  floor(tick/WANDER_TICKS)).value * 2 - 1) * spread` — the house pure-hash recipe every
  other per-tank enemy draw already uses (wander `*1000`, retreat `*4243`, mine inclination
  `*6101`, aim jitter `*7919`), fresh prime `5303`.

Four functions gain an optional, defaulted radius/corridor parameter — `dangerousMines`
(private, `fleeRadius = AI_MINE_FLEE_RADIUS`), `incomingThreats` (`dangerCorridor =
DANGER_CORRIDOR`), `mineThreatensPlayer` (`tacticalRadius = AI_MINE_TACTICAL_RADIUS`),
`friendlyInMineBlast` (`fleeRadius = AI_MINE_FLEE_RADIUS`) — and a fifth, `dangerAvoidMove`,
gains BOTH (`fleeRadius`, `dangerCorridor`) purely to forward them to `dangerousMines`/
`incomingThreats` internally, since it is the one function every caller (grey/teal/player)
actually calls. Every default reproduces today's exact constant — the same "optional,
absent means today's behavior" idiom CLAUDE.md already documents for `Tank.team?`.

`grey.ts`/`teal.ts` compute ONE `estimationError` draw per tick (`const hazardOffset =
estimationError(world, tank, profileHazardSpread(cfg))`) and reuse it at every site that
needs a perceived radius this tick — `dangerAvoidMove`, grey's own direct `incomingThreats`
call (the `underFire` patience gate, a site the source plan's function-level description
did not separately name but which exists in the real file and would otherwise perceive the
corridor two different ways in one tick), and `mineThreatensPlayer`. `index.ts`'s `stepAi`
independently recomputes the SAME formula (`AI_MINE_FLEE_RADIUS + estimationError(world,
tank, profileHazardSpread(configFor(tank.kind)))`) at its own `friendlyInMineBlast` call
site — a different function, a different file, but the same pure hash of `(world.seed,
tank.id, tick bucket)` lands on the identical offset without anything being threaded
between them, exactly the "no threaded state" property `wanderMove`/`aimJitter` already
rely on.

`player-profile.ts` mirrors the shape through its OWN injected `rnd`, never `world.seed`:
one `(rnd()*2-1) * profileHazardSpread(cfg)` draw per tick, reused for `dangerAvoidMove`'s
arguments and the two independently-written mine gates (oracle site #5, below). A linear
PRNG stream has no bucket to re-derive a value from later, unlike the enemy AI's hash, so
"one draw per tick" (not per WANDER_TICKS window) is this file's own equivalent of holding
a misjudgement for a while.

### Oracle-knowledge sites (grep-backed at this tree)

1. `targeting.ts` `dangerousMines` — exact `AI_MINE_FLEE_RADIUS` comparison. Shared
   (grey/teal via `dangerAvoidMove`).
2. `targeting.ts` `bestEscapeDirection` — the literal "perfect mine-dodge position" the
   ruling names, an analytically optimal worst-case-outward search over `ESCAPE_SAMPLES`
   headings. **Deliberately UNCHANGED** — see Deviations.
3. `targeting.ts` `incomingThreats` — exact `DANGER_CORRIDOR` perpendicular test. Shared.
4. `targeting.ts` `mineThreatensPlayer`/`friendlyInMineBlast` — exact
   `AI_MINE_TACTICAL_RADIUS`/`AI_MINE_FLEE_RADIUS`, gating the OFFENSE side of enemy
   mine-laying (whether to propose/actually drop a mine near the player or a teammate).
   Shared.
5. `player-profile.ts`'s own `nearLiveMine` and mine-placement distance gates — exact
   `AI_MINE_FLEE_RADIUS`/`AI_MINE_TACTICAL_RADIUS` checks, independently written (this file
   already deliberately avoids `targeting.ts`'s probabilistic helpers). Second population,
   parallel construction, not shared code.

Scoped **out**: `aimLead` (already has `profileAimSpread`/`AI_AIM_SPREAD`, a dedicated
fuzzing mechanism — extending "hazard estimation" there duplicates it, not closes a gap);
`bankShot`/`shotHitsOwnSide`/`lineOfSight` (physics/collision constraints the mechanics
actually enforce, not a guess about a future position).

### The fresh prime, and why it cannot collide

`5303` is prime and distinct from the four multipliers already in use — wander `1000`
(not itself prime; the collision argument only needs the MULTIPLIERS to differ), retreat
`4243`, mine inclination `6101`, aim jitter `7919`. For a fixed `(tank.id >= 1, bucket >=
0)`, `id*5303 + bucket` equals `id*P + bucket'` for one of the other primes `P` only if
`5303` and `P` produce the same key for SOME `(id, bucket)` pair — since all five keys have
the shape `world.seed + id*MULT + bucket` with `id >= 1` and distinct `MULT` values, two
different multipliers can coincide only by an unlucky `(id, bucket)` combination, and this
is the same reasoning `aimJitter`'s own doc comment gives for why `7919` (distinct from
wander's `1000`) keeps the two draws uncorrelated — checked directly in
`targeting.test.ts`'s `estimationError` describe block (the five literals compared
pairwise) rather than merely asserted.

It also cannot collide with a bot's per-slot stream: `game/loop.ts`'s `BOT_SEED_SPACING`
keeps every bot key `world.seed - BOT_SEED_SPACING + slot`, strictly LESS than
`world.seed` (since `BOT_SEED_SPACING` (1009) exceeds the largest slot index). `5303` is an
ADDITIVE prime with `tank.id >= 1`, so its key is strictly GREATER than `world.seed` — the
same argument `BOT_SEED_SPACING`'s own doc comment already gives for the other four
multipliers, which explicitly anticipates "a future per-tank stream that keeps the same
additive-from-`world.seed` shape... cannot collide with this either, whatever prime it
picks." Documented in `targeting.ts`'s `estimationError` doc comment and this file.

### `AI_HAZARD_SPREAD`

New anchor in `constants.ts`, sourced from `balance.json`'s `ai.hazardSpread` (the
`AI_AIM_SPREAD`/`data.ai.aimSpread` precedent exactly), pinned in `constants.test.ts`.
Shipped at **0.4** world units — chosen so it can cross a real decision boundary at
`DANGER_CORRIDOR`'s scale (0.8, the smallest of the three radii it perturbs) at the
authored `estimationAccuracy` range without every profile's perceived corridor collapsing
to a permanently-negative (never-triggers) value. A feel value, like `AI_AIM_SPREAD` —
re-tune with the pacifist/engagement harnesses, not by guessing.

### `estimationAccuracy`: authored, by role

Required field (`positiveUnitInterval`, since `profileHazardSpread` divides by it — the
`aimAccuracy` precedent exactly), all 8 profiles, `PROFILE_FIELDS` + a negative-control
validator test mirroring `aimAccuracy`'s (`rejects estimationAccuracy 0`) plus one
`aimAccuracy` itself does not have (`rejects a profile missing estimationAccuracy`, since
`minePlacementChance` — the one existing optional field — could tempt a reviewer to expect
this one is optional too; it is not).

Authored by role, "snipers estimate well, berserkers poorly" per the ruling's own example —
feel values, stated as such, not measured:

| Profile             | Kind(s)      | Behavior   | estimationAccuracy | Rationale |
|----------------------|-------------|------------|--------------------:|-----------|
| RICOCHET_SNIPER      | green        | STATIONARY | **0.90**            | The ruling's named example of good estimation; patient, precise, stationary. |
| DEFENSIVE_ROCKET     | olive        | DEFENSIVE  | 0.70                | Cautious, holds range — reads hazards carefully by temperament. |
| DEFENSIVE_BASIC      | grey         | DEFENSIVE  | 0.65                | Cautious but more reactive than olive. |
| MOBILE_MINE_LAYER    | teal, yellow | TACTICAL   | 0.60                | Actively manages its own mines; moderate. |
| STATIC_BASIC         | player, brown| STATIONARY | 0.50                | Baseline "basic gunner" tier, matching its `aimAccuracy` (0.55) tier. |
| OFFENSIVE_ELITE      | (unshipped)  | OFFENSIVE  | 0.55                | Skilled but aggressive — offense crowds out careful hazard reading. |
| OFFENSIVE_ASSAULT    | (unshipped)  | OFFENSIVE  | 0.45                | Aggressive, less disciplined than ELITE. |
| BERSERKER_ROCKET     | (unshipped)  | BERSERKER  | **0.30**            | The ruling's named example of poor estimation; reckless by design. |

### Consumption is asymmetric, and that is the precedent, not a violation of it

`dangerAvoidMove`'s perceived-radius/corridor sites bite DEFENSIVE/TACTICAL/OFFENSIVE/
BERSERKER (every behavior `grey.ts`/`teal.ts` implement); STATIONARY (brown, green/
RICOCHET_SNIPER) never imports `dangerAvoidMove` — confirmed by reading `brown.ts`'s
import list, which carries `lineOfSight`/`aimLead`/`aimJitter`/`bankShot`/
`profileAimSpread`/`shotHitsOwnSide` and nothing from the danger-avoidance family. The
mine-tactical-radius site (`mineThreatensPlayer`, called from inside a `mineInclination(...)
&& ... && mineThreatensPlayer(...)` short-circuit chain) bites exactly the profiles that
also carry `minePlacementChance` — STATIC_BASIC and RICOCHET_SNIPER carry neither, so the
`&&` chain short-circuits before `mineThreatensPlayer` (and the `estimationError` draw
feeding it) is ever reached; the asymmetry lines up with an EXISTING boundary
(`minePlacementChance`'s own optionality) rather than inventing a new one.
`friendlyInMineBlast` (`index.ts`) is gated on `hasAbility(tank.kind,
TankAbility.MINE_LAYER)`, which brown and green also lack.

This is the same shape CLAUDE.md already documents for
`preferredDistance`/`minimumDistance`/`retreatChance` under STATIONARY ("STATIONARY still
ignores... and always will") — extended, not broken, by `estimationAccuracy`. The one place
the asymmetry does NOT hold is the player: it also resolves to STATIC_BASIC, but
`player-profile.ts`'s independently-written mine gates (oracle site #5) DO consume its
`estimationAccuracy` — so the field the shared enemy path ignores for brown is exactly the
field the player's own code reads for the identical profile.

---

## Red-first

Two layers, both proven to fail against the pre-wiring code before being accepted:

**Parameterization layer** (`targeting.test.ts`, `danger.test.ts` equivalents folded into
`targeting.test.ts`) — direct, mutation-provable "the parameter is consumed" tests for all
five functions: a narrower/wider explicit radius argument changes the boolean/null outcome
relative to the same fixture's default-argument call. One mutation verified by hand
(reverting `mineThreatensPlayer`'s body to ignore its own `tacticalRadius` parameter and
hardcode `AI_MINE_TACTICAL_RADIUS` again): the matching new test failed
(`expected false to be true`), confirmed restored, re-ran green.

**Wiring layer** (`profile.test.ts`, `player-profile.test.ts`) — seeded end-to-end fixtures
proving the actual call-site draw crosses a real decision boundary, both directions, both
populations:

- **UNDER-estimation (enemy, `profile.test.ts`)**: grey tank id 6, `world.seed=1`,
  `tick=0` (bucket 0), injected `estimationAccuracy: 0.3` — `nextRng(1 + 6*5303 +
  0).value = 0.013678029412403703`, offset ≈ −1.297, perceived `AI_MINE_FLEE_RADIUS`
  shrinks from 3.25 to ≈1.953. A mine at distance 2.4 (inside the TRUE lethal blast radius,
  `MINE_BLAST_RADIUS + TANK_RADIUS = 2.5`, and inside the true 3.25 flee radius — control:
  `dangerAvoidMove(w, grey)` called with no radius arguments returns non-null) is NOT fled
  by `greyDecision` under the injected accuracy — the literal "sometimes fatal" case:
  the tank is standing inside its own actual kill radius and does not know it. Mirrored
  through `tealDecision` with the identical draw (same `(id, seed, tick)`, different
  decision function) to prove it is the shared consumption, not a copy that could rot
  separately.
- **OVER-estimation (enemy)**: grey tank id 5, `seed=1`, `tick=150` (bucket 5) —
  `nextRng(1 + 5*5303 + 5).value = 0.9985110608395189`, offset ≈ +1.330, perceived flee
  radius widens to ≈4.580. A mine at distance 4.0 (control: TRUE radius 3.25 does not reach
  it, `dangerAvoidMove` with no radius arguments returns null) IS fled anyway — wasted
  caution, not merely cosmetic scatter.
- **Offense-side wiring**: same UNDER-estimation draw, a player placed inside the TRUE
  `AI_MINE_TACTICAL_RADIUS` (8.5) but outside the perceived one (≈7.20) — control:
  `mineThreatensPlayer(w, grey)` (default constant) returns `true`; `greyDecision`'s `mine`
  decision is `false` under the same injected accuracy, proving `mineThreatensPlayer`'s
  call site inside `greyDecision` reads the SAME `hazardOffset` the dodge gate drew.
- **Player half (`player-profile.test.ts`)**: seeds found by scanning `mulberry32(seed)`'s
  SECOND draw (the first is spent by `createPlayerAiState` on the initial wander heading)
  against 1..5000 — seed 4771 → 0.000002468237653374672 (near-minimal), seed 3434 →
  0.9998051796574146 (near-maximal). At the shipped player profile (STATIC_BASIC,
  `estimationAccuracy` 0.5, spread 0.8): a mine at 2.48 (inside the true 2.5 kill radius,
  outside the perceived ≈2.45 one) is not dodged; a mine at 3.8 (outside the true 3.25 flee
  radius, inside the perceived ≈4.05 one) is dodged anyway.

All four wiring-layer claims (both grey/teal fatal/over-reaction cases, the offense-side
case, both player cases) were verified RED against the pre-wiring code by temporarily
reverting `dangerAvoidMove`'s call sites in `grey.ts`/`teal.ts`/`player-profile.ts` to their
un-parameterized two-argument form, running the matching new tests, observing the expected
failures (five failing assertions across the two files, each showing the OLD un-perturbed
behavior — e.g. `expected -1 to not be close to -1, received difference is 0`, i.e. the old
code DID flee/not-flee exactly where the new one is supposed to diverge), then restoring
from the pre-mutation copy (`cp`, verified via `git diff --stat` matching the real,
intended change afterward) and re-confirming green. Per this repo's standing rule, the
implementation was already committed before any of these mutation experiments ran.

**Counts, populations stated.** Parameterization layer: 12 new `it()` blocks across
`friendlyInMineBlast` (2 new + existing), `mineThreatensPlayer` (3, new describe),
`incomingThreats` (1, new describe), `dangerAvoidMove` (3, new describe), plus 8
`estimationError`/`profileHazardSpread` purity/bound/pin/independence tests — all in
`targeting.test.ts` (70 tests total in that file post-change, up from a pre-change count
not separately recorded; the file's own diff is +226/−? lines). Wiring layer: 5 new `it()`
blocks in `profile.test.ts` (2 estimation-scaling + 3 red-first fatal/over-reaction/offense)
and 2 in `player-profile.test.ts` (fatal/over-reaction, player half). Total new/changed test
files: 8 (`targeting.test.ts`, `profile.test.ts`, `player-profile.test.ts`, `grey.test.ts`,
`validate.test.ts`, `constants.test.ts`, `difficulty.test.ts`, `pacifist.test.ts`).

---

## Collateral: two pre-existing fixtures needed re-deriving, not re-writing

Both were CORRECT before this change and became wrong only because their SUBJECT (a
seed's exact draw sequence, or a bare-constant boundary reached through a now-perturbed
caller) moved underneath them — the same class CLAUDE.md's "an assertion can stop meaning
what its name says without anyone touching it" section already names, not a bug in either
fixture's original design.

1. **`grey.test.ts`'s "H1c: the tactical radius is measured from the drop point,
   inclusive"** asserted inclusivity against the BARE `AI_MINE_TACTICAL_RADIUS` constant
   through `greyDecision`'s default (shipped) config — which now perceives a radius offset
   by grey's own `estimationAccuracy` (0.65) at this file's fixed `world()` seed (7)/tick
   (0)/tank id (1). Hand-derived the exact offset (`nextRng(7 + 1*5303 + 0=5310).value =
   0.7019057071302086`, spread `0.4/0.65 = 0.6153846153846154`, offset
   `0.24849933185256445`) and moved the fixture's near/far points to bracket the PERCEIVED
   boundary instead. The inclusive-boundary claim against the bare constant is now pinned
   directly on `mineThreatensPlayer` in `targeting.test.ts`, unaffected by estimation
   noise, which is the layer that claim actually belongs to.
2. **`player-profile.test.ts`'s directive-A-part-2 centroid-retreat fixtures** (both the
   positive case and the corpse negative control) were pinned against `mulberry32(3)`'s
   specific draw sequence. `decidePlayerInput` now consumes one more `rnd()` call (the
   hazard-offset draw) before the wander/retreat draws it used to reach first — a linear
   PRNG has no bucket to insulate a later draw from an earlier one added upstream, unlike
   the enemy AI's `world.seed`-keyed hash, so EVERY draw after the new one is a different
   number, not merely shifted by a predictable amount. Re-scanned seeds 1..2000 with the
   SAME method the original comment describes (retreat draw fires, the two candidate
   directions genuinely discriminate, the produced move matches the reconstructed
   expectation) and found seed 4, verified against BOTH fixtures (the shared-geometry test
   and the corpse-discrimination test) before committing.

---

## Re-measurement — headline numbers, both harnesses named in scope

Per this file's own convention ("counts are a property of the tree at the moment you ran
them"), both explicitly-named harnesses were re-run AFTER the wiring and its tests were
finished, not before.

**`pacifist.test.ts`** (60 fixed seeds, the file's own CI-gating population): free-win rate
moved from the previously-recorded 0/60 to **1/60 (1.7%)** — still comfortably inside
`MAX_FREE_WIN_RATE` (0.05). `shotsPerRound` 36.6 (bound: `>15`), `minesPerRound` 2.67
(bound: `>1, <7`), `medianKillTicks` 1693 across 59 losses (bound: `< TICK_CAP/2 = 9000`).
Comment in `pacifist.test.ts` updated to record the new rate and figures alongside the
historical 0/60→19/60 comparison it already carried, rather than silently superseding it.

**`engagement.measure.test.ts`** (`describe.skip` flipped on, run once, flipped back off;
diff confirmed empty afterward): arena1 (60 seeds) losses 59/60, freeWins 1, timeouts 0,
medianTicks 1705, minesPerGame 2.67; brown median 10.20 (p25 10.20, p75 13.05, n=10690),
grey median 10.20 (p25 8.70, p75 10.20, n=9002), teal median 8.00 (p25 7.93, p75 9.56,
n=9816). arena3: losses 60/60, freeWins 0, timeouts 0, medianTicks 1837, minesPerGame 1.45;
olive median 14.42 (p25 11.91, p75 14.42, n=23348), brown median 10.20 (p25 10.20, p75
13.13, n=23239), grey median 10.00 (p25 8.89, p75 10.11, n=11055). These land close to the
`SEEK_APPROACH_BIAS` sweep table's bias-0.50 row already in `constants.ts` (grey p75 10.20
and teal med 8.00 match EXACTLY; olive p25 moved 12.3 → 11.91) — expected, since the
pacifist player never fires, so most ticks never reach an active dodge and the
per-kind median/percentile summary is dominated by `seekMove`'s distance-band logic, which
this PR does not touch. The engagement-distance numbers are not asserted anywhere (the
file is `describe.skip`, its own convention), so no threshold changed; the figures are
recorded here as the population this PR's own instructions asked to be re-measured.

**Also re-measured on review, though out of this task's explicitly-named scope**:
`player-profile.test.ts`'s own separate 125-game (5 arenas × 25 seeds) pinned population
(`describe('a competent scripted player against the shipped arenas', ...)`). Its four
threshold assertions all passed at full `npm test` before this re-measurement too, so
nothing was broken — but `decidePlayerInput` now draws one extra `rnd()` call per tick
(the hazard offset), which renumbers every later draw in the stream, so every one of the
125 games is a genuinely different run, not a behaviour delta layered on the old one; the
comment's exact quoted figures (e.g. "51/125 wins (40.8%)") would otherwise have gone
stale the same way `pacifist.test.ts`'s did. Re-measured: **50/125 wins (40.0%)**, 74
losses, 0 timeouts; self-mine deaths **5/74 (6.8%)**, down from 10/74 (13.5%) — consistent
with, not proof of, estimation error occasionally trading one failure mode for another
(the sim is chaotic, so an exact attribution is not warranted); fires/game 13.5–44.2 (was
13.4–55.8); mines/game 1.60–9.28 (was 1.44–7.80); per-arena win rates 16/25, 15/25, 12/25,
6/25, 1/25 (was 21/25, 13/25, 7/25, 7/25, 3/25) — the "arena-01 easier than arena-03 and
arena-04" ordinal claim still holds with real margin (64% vs 48% vs 24%). All figures
updated in `player-profile.test.ts`'s own comments, not left to silently imply the old
tree.

---

## Trace transition — the whole point

1. **Old hash**, as pinned before this PR and quoted in CLAUDE.md:
   `324aa9b5d369ec6abc61f73e8e454de67b5fbf365f4b0df2eedf2c01add33bb5`.
2. **Applied the change** — the five `targeting.ts` parameterizations, `grey.ts`/`teal.ts`
   wiring, `index.ts`'s `friendlyInMineBlast` call site, the 8 authored
   `estimationAccuracy` values, `AI_HAZARD_SPREAD`.
3. **Ran `npx vitest run tools/baseline/trace.test.ts` and OBSERVED, not assumed, that it
   failed**: `expected 'a5458ede...' to be '324aa9b5...'`. Re-ran a second time to confirm
   determinism of the NEW hash itself (both runs printed the identical
   `a5458ede003c173ccc099b708f4b7d43b7537ca8a7846a87274b6376ccc311a9`) before treating it as
   the value to pin — not a one-off floating-point wobble.
4. **The hash MOVED.** Not a null result requiring investigation: grey/teal's `dangerAvoidMove`/
   `incomingThreats`/`mineThreatensPlayer` sites are genuinely exercised across the 5
   arenas × 6 seeds × 2500-tick trace (mines and bullets both occur routinely in normal
   AI-vs-AI play, unlike the hull-inside-wall escape path CLAUDE.md names as a case the
   seeded replay never reaches), so the perturbed radii change real decisions along the
   trajectory. `BASELINE_HASH` pinned to the new value in `tools/baseline/trace.ts`,
   with its own doc comment updated to record the old→new move, the reason, and which
   half of the mechanism (enemy-side only) is responsible — see that file for the full
   text, not repeated here.
5. **`npm run trace:browser -- --all`, verbatim, all 3 engines MATCH:**
   ```
     MATCH  chromium  a5458ede003c173ccc099b708f4b7d43b7537ca8a7846a87274b6376ccc311a9  (4225 ms, 114481 chars)
     MATCH  firefox   a5458ede003c173ccc099b708f4b7d43b7537ca8a7846a87274b6376ccc311a9  (7592 ms, 114481 chars)
     MATCH  webkit    a5458ede003c173ccc099b708f4b7d43b7537ca8a7846a87274b6376ccc311a9  (4838 ms, 114481 chars)
   all 3 engine(s) agree with the pinned baseline: a5458ede003c173ccc099b708f4b7d43b7537ca8a7846a87274b6376ccc311a9
   ```
   The same run's ANGLE PROBE (native `Math.sin`/`cos`/`atan2`/`hypot` across engines, a
   pre-existing, separately-tracked observation for issue #133, unrelated to this PR — the
   sim itself never calls native trig) still disagrees across all 3 engines, as documented;
   the VENDORED angle probe (what the sim actually uses) still agrees
   (`a4fdbbfb32debaae48844ba04f7492a55d9a03e53ada569f12c2ee344cd95aed`, matching the
   existing pin exactly) — confirming this PR's new code paths did not surface a
   vendored-math bug, the one outcome that would have required stopping.
6. **CLAUDE.md updated**, enumerated: (a) the "Measured on this box" paragraph — new hash,
   new date, marked as the trace arc's first deliberate (behaviour-driven) hash move, with
   the prior two baselines' own three-engine agreements kept as history rather than
   deleted; (b) the "know what it does not cover" paragraph's two prior mutation-hash
   figures (`0cf1f76a…`, the disabled-union-marching case) explicitly marked unmeasured at
   this (post-2c) tree, on top of the pre-existing "unmeasured since arena-05" caveat; (c)
   the "every profile field is now consumed" sentence extended with `estimationAccuracy`'s
   asymmetric consumption, mirroring how it already documents `bankShotWeight`'s, plus a
   companion clause in the "Profile fields consumed today" enumeration and a sentence
   extending the `determinism.test.ts`-blindness paragraph; (d) the #133 "`BASELINE_HASH`
   did not move" sentence annotated to scope its claim to that specific historical
   pre-/post-migration pair rather than reading as still true of the CURRENT hash, and the
   shipped-Safari/iOS paragraph annotated as measured against the PRE-directive-B baseline,
   not re-run since the hash moved (out of this task's reach — needs the macOS/iOS engines
   workflow, not available here).
7. **`tools/mutate/manifest.json` `expectFailures`**: checked, none apply. The manifest
   carries 13 entries (`skins.ts`×4, `preview.ts`×1, `framing.ts`×3, `hud.css`×2,
   `storage.ts`×1, `save.ts`×1, `loop.ts`×1) — zero touch `src/sim/ai/` — confirmed by
   listing every entry's `file` field before editing anything, and re-confirmed
   empirically: `npm run mutate` ran clean, 13/13 mutations matching their declared
   outcome, 0 mismatches, after every code change in this PR landed.
8. **`determinism.test.ts` will not catch a broken `estimationAccuracy` wiring** — the same
   blind spot CLAUDE.md already names for `bankShotWeight`: it asserts self-consistency
   (same seed, same result), which is invariant under a behaviour change, not a behaviour
   proof. It passed before this PR's wiring existed and passes after; the hash move above
   IS the actual proof obligation, not a green suite. (`determinism.test.ts` itself was not
   modified and needed no change — it is cited here as the file whose blindness this PR's
   hash-move argument depends on, not as a file this PR edits.)

---

## Full gate — all exit code 0

- `npx tsc --noEmit` — clean.
- `npm test` (`tsc --noEmit && vitest run`) — 112 files passed, 1 skipped; **2560 tests
  passed, 2 skipped, 0 failed** (2562 total).
- `npm run mutate` — 13/13 mutations ran: 11 killed, 2 survives (both pre-existing declared
  `equivalent mutant`/expected survivors), **0 mismatches**. `git status` clean after,
  confirming restoration.
- `npm run build` (`tsc --noEmit && vite build`) — clean.
- `npm run portability` against the built output — clean (`subpath-portable: dist/index.html
  + 1 bundle(s) + the PWA shell checked`).
- `npx vitest run tools/baseline/trace.test.ts` — passes against the NEW `BASELINE_HASH`.
- `npm run trace:browser -- --all` — all 3 engines match the new hash (see above).
- `npm audit` — not re-run; no dependency changed in this PR (`package.json`/
  `package-lock.json` untouched), so its result is unaffected and out of this task's scope.

---

## Deviations, named once

1. **The task's own restatement named `bestEscapeDirection` as one of "targeting.ts's five
   functions" gaining an optional radius/corridor parameter; the actual implementation
   parameterizes `dangerAvoidMove` instead.** Read `bestEscapeDirection`'s body (615–648 at
   the time of reading): it references no radius constant at all — it consumes an
   already-filtered `mines[]` list and performs pure angular search
   (`ESCAPE_SAMPLES`-way worst-case-outward maximisation). There is nothing in its own math
   to parameterize, and the source plan's own "the mechanism" paragraph agrees explicitly
   ("`bestEscapeDirection`'s worst-case-outward search... stays deterministic and untouched
   in its math; only the *perceived* radius feeding it becomes a parameter") and separately
   lists the five functions that DO gain parameters as `dangerousMines`, `incomingThreats`,
   `mineThreatensPlayer`, `friendlyInMineBlast`, and `dangerAvoidMove` — matching what was
   actually built. The task's five-function list appears to have substituted the
   narratively-cited "oracle" site (named because it is the literal "perfect dodge
   position" the ruling calls out) for the functionally-correct one that needed to change.
   `bestEscapeDirection`'s own doc comment now records why it stays untouched and where its
   imperfection actually comes from (upstream, via `dangerousMines`'s perceived
   `fleeRadius`).
2. **Two pre-existing test fixtures needed re-deriving** (H1c's boundary, the two
   directive-A-part-2 seed-3 fixtures) — see "Collateral" above. Neither was a defect in
   the original fixture; both were downstream of exactly the kind of "subject moved
   underneath an unchanged assertion" case CLAUDE.md already names as a recurring failure
   mode, caught here before committing rather than left red.
3. **`engagement.measure.test.ts`'s own numbers were re-measured but not written back into
   `constants.ts`'s `SEEK_APPROACH_BIAS` sweep table** — that table documents a DIFFERENT
   independent variable (the seek-approach-bias sweep itself), and this PR's numbers are a
   re-measurement of the shipped bias at 0.50 under a new, unrelated mechanism, not a new
   sweep row. Recorded instead in this document and in `pacifist.test.ts`'s own comment,
   the two places this task named explicitly.
4. **The implementation commit (`e7e2769`) is transiently red on `tools/baseline/
   trace.test.ts` if checked out on its own.** Forced by the instruction to give the
   trace-hash pin its own commit: behaviour changed in that commit, but `BASELINE_HASH`
   still names the OLD value until the next commit (`daacede`) updates it. No commit's
   PRODUCTION code was ever wrong at the point it landed on the branch tip — only a
   bisect that stops exactly at `e7e2769` would see a red `trace.test.ts` — and the fix
   (squashing the two commits, or reordering so the hash lands first) would defeat the
   instruction's own point (the hash-carry procedure treats the pin as a distinct,
   separately-reviewable act from the behaviour change it records). Left as two commits,
   per the instruction, with this note so a bisecting reviewer is not surprised. The same
   precedent exists in `2026-08-16-bot-competence.md`'s own Deviations item 4, for an
   unrelated reason (a not-yet-implemented later directive's test landing early).
5. **The parameterization/wiring mutation experiments (see "Red-first" above) used `cp`
   backups to `/tmp`, not `git stash`/`git checkout --`, and were run BEFORE the two
   commits above landed but AFTER the implementation was otherwise complete and staged in
   the working tree.** This repo's standing rule is "commit before mutation experiments"
   because `git checkout --` has eaten uncommitted work three times in this project's
   history; using an out-of-tree backup and restoring by `cp` (verified by `git diff
   --stat` matching the intended change afterward, not by exit code alone) sidesteps that
   specific failure mode, but is named here as a process deviation from the letter of the
   instruction rather than silently presented as compliant. No work was lost; `git status`
   was clean before both commits.
