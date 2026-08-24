---
status: completed
date: 2026-08-23
last-reviewed: 2026-08-23
scope: Separate AI perception/decision cadence from execution — held movement intent with profile-driven commitment, dodge-side hysteresis, emergency interruption, and continuous aim-error drift
implementation-issues: [222]
implementation-prs: [328]
supersedes: []
superseded-by: []
---
# AI decision commitment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An AI tank perceives, decides, then commits — instead of re-deciding its movement
direction every tick. Movement intent is held for a profile-controlled window, the dodge
side is sticky, genuine emergencies still interrupt, and aim error drifts continuously
rather than stepping at each jitter bucket.

**Architecture:** The hold is applied CENTRALLY in `decideAi` (`src/sim/ai/index.ts`) as a
wrapper over whatever the behaviour function returned, not inside each of
brown/grey/teal, and NOT inside `dangerAvoidMove`. New per-tank state rides on `Tank`
alongside the existing `aiState`/`aiTimer`/`aimTicks`, returned through `AiDecision` and
written back by `stepAi` — the established "decisions are pure, the dispatcher writes
back" split. Aim smoothing is a pure change to `aimJitter`'s interpolation with no new
state.

**Tech Stack:** TypeScript, Vitest, the existing seeded pure-hash RNG recipe
(`nextRng(world.seed + tank.id * PRIME + bucket)`). No new dependencies.

**Spec:** issue #222 (problem, direction, five acceptance criteria). Related but
explicitly OUT of scope: #223 (difficulty-aware hazard perception — blocked, see
Residuals), #224 (wall-aware evasive movement — the planned next branch).

## Measured baseline (this branch point, `e7afc9c`)

Every number below was produced by the two harnesses in `src/sim/ai/`, run by this plan's
author at `e7afc9c` before any edit. Method is each harness's own header comment;
population is stated with each figure. Re-measure with the SAME harnesses after the final
tree — do not carry these forward by hand.

`engagement.measure.test.ts` (60 seeds/arena, 3-minute cap, pacifist player):

```
arena1: losses=59/60 freeWins=1 timeouts=0 medianTicks=1705 minesPerGame=2.67
arena3: losses=60/60 freeWins=0 timeouts=0 medianTicks=1837 minesPerGame=1.45
```

`commitment.measure.test.ts` (Task 1 — 60 seeds per arena/policy, every live tick).
Reversal = adjacent-tick pair whose movement intents differ by more than 90 degrees:

| row | kind | reversals | turnP95 | aimStepMed | aimStepP95 | aimHoldMed |
| --- | --- | --- | --- | --- | --- | --- |
| a1/pacifist | grey | 5.82% (3367/57823) | 113.9° | 4.86° | 12.20° | 0.16° |
| a1/pacifist | teal | 4.34% (2860/65828) | 81.5° | 4.05° | 17.54° | 0.11° |
| a1/shooter | grey | 12.05% (5126/42524) | 176.2° | 5.08° | 12.11° | 0.15° |
| a1/shooter | teal | 7.35% (3671/49928) | 150.1° | 4.01° | 23.19° | 0.11° |
| a3/pacifist | grey | 4.15% (3224/77756) | 83.8° | 4.42° | 10.20° | 0.17° |
| a3/pacifist | olive | 1.85% (3103/167872) | 61.1° | 4.29° | 10.87° | 0.12° |
| a3/shooter | grey | 13.93% (8712/62529) | 180.0° | 4.10° | 9.92° | 0.15° |
| a3/shooter | olive | 4.95% (10246/206972) | 89.5° | 4.39° | 10.86° | 0.13° |

Brown is stationary (`desiredMove` always zero), so it contributes 0 movement pairs in
every row — its reversal cells are `NaN (0/0)` by construction, not a measurement gap.

Reversal sources (the same harness's transition rollup, all kinds per row):

| row | n | top buckets |
| --- | --- | --- |
| a1/shooter | 8797 | `bullet->bullet` 40.6%, `seek->bullet` 18.6%, `bullet->seek` 17.9%, `seek->seek` 12.5% |
| a3/shooter | 18958 | `bullet->bullet` 48.2%, `seek->seek` 18.3%, `seek->bullet` 14.6%, `bullet->seek` 13.9% |
| a1/pacifist | 6227 | `seek->seek` 30.6%, `seek<->mine` 42.1%, `bullet->bullet` 10.8% |
| a3/pacifist | 6327 | `seek->seek` 57.1%, `seek<->mine` 27.7%, `bullet->bullet` 6.6% |

**What that says.** Three distinct mechanisms, needing two distinct remedies:

1. `bullet->bullet` (the largest single bucket under fire) is `dangerAvoidMove`'s
   perpendicular side choice, `vdot(rel, perpA) >= 0 ? perpA : perpB`. As the tank
   crosses the shell's axis, `rel` changes sign and the dodge reverses by exactly 180°.
   That is the "oscillates between nearly equivalent choices" the issue names, and it
   wants HYSTERESIS.
2. `seek<->bullet` and `seek<->mine` are a dodge starting or ending — a branch change.
   Wants a HOLD.
3. `seek->seek` is the distance band (approach vs. retreat blend, near-opposite vectors)
   and the `WANDER_TICKS` boundary. Also wants a HOLD.

`turnMed` is 0.0° in every row: the median tick does not turn at all. The distribution is
bimodal — hold, hold, hold, 180° flip — which is exactly the issue's "noisy input rather
than a tank perceiving, deciding, and then committing".

For aim: `AI_AIM_SPREAD` is 0.08 rad = 4.58°, per-profile `spread = 4.58° / aimAccuracy`
(grey 0.6 -> 7.6°, teal 0.65 -> 7.0°). The measured contrast is the defect: the aim target
moves a median 4.0–5.4° on the one tick in `AI_JITTER_TICKS` (20) that crosses a bucket
boundary, versus 0.11–0.18° on every other tick — roughly a 30x step. The tail matters
more than the median: `aimStepP95` reaches 23.19° (teal, a1/shooter), and the AI turret
slews at `aiTurnRate` 2.5 rad/s = 2.39°/tick, so a P95 step takes ~10 ticks to absorb and
is genuinely visible. A blended percentile CANNOT show this (boundaries are 1-in-20 of all
pairs, so they hide at exactly the P95 an unsplit column reports) — which is why Task 1's
harness splits the two columns.

## Resolved before implementation (review findings)

Three questions were settled against the code before Task 3 was written, because each
would otherwise have been decided silently while implementing:

1. **`avoid` is THREADED, not recomputed.** `AiDecision` gains `avoid: Vec2 | null` and the
   behaviour functions return the value they already hold in a local. The alternative —
   recomputing `dangerAvoidMove` inside `decideAi` with "the same" perceived radii — would
   have rested on an assumption that is only true for grey and teal (brown never calls it
   at all), and would have paid a second O(walls) wheel probe every tick to re-derive a
   number the caller already had. Threading removes the assumption instead of testing it.
2. **The `mine` gate keeps its CURRENT meaning and is deliberately not re-pointed at the
   committed intent.** Both grey and teal gate mine-laying on `!avoid`. That reads as "is
   there a live hazard near me right now", not "am I dodging this tick", and it stays
   correct under a hold: a tank riding out a committed heading with a shell inbound still
   should not be dropping ordnance. The consequence to watch is the converse case — a
   held dodge continuing after `avoid` goes null now permits a mine — so `minesPerGame`
   (baseline 2.67 / 1.45) is a REQUIRED comparison in Task 6, and a material move there is
   a finding to report, not a balance detail to absorb.
3. **New `Tank` fields do not move `BASELINE_HASH` by themselves.** `traceText`
   (`tools/baseline/trace.ts`) samples only `pos.x`, `pos.y`, `turretAngle` and `alive`
   per tank, plus a per-run `status`/`tick` line — not the whole `Tank`. So the re-pin is
   attributable entirely to changed BEHAVIOUR, which is what the MOVED entry must argue.

Also confirmed: `pacifist.test.ts` asserts `freeWins / SEEDS <= MAX_FREE_WIN_RATE` with
`MAX_FREE_WIN_RATE = 0.05` and `SEEDS = 60` — an UPPER bound, i.e. at most 3 free wins in
60. A commitment window makes the AI slower to re-aim at a moving player, which pushes
free wins toward that bound, so this is the gate most likely to break. Note its method
differs from the engagement harness (5-minute cap there, 3-minute here), so the
harness's `freeWins=1/60` is NOT this gate's headroom — run the gate itself.

## Measured result (final tree)

Both harnesses re-run on the final tree by the same method as the baseline above.

| row | kind | reversals before → after | turnP95 before → after |
| --- | --- | --- | --- |
| a1/pacifist | grey | 5.82% → 1.71% | 113.9° → 0.0° |
| a1/pacifist | teal | 4.34% → 1.55% | 81.5° → 0.0° |
| a1/shooter | grey | 12.05% → 1.67% | 176.2° → 0.0° |
| a1/shooter | teal | 7.35% → 1.39% | 150.1° → 0.0° |
| a3/pacifist | grey | 4.15% → 1.94% | 83.8° → 0.0° |
| a3/pacifist | olive | 1.85% → 1.36% | 61.1° → 0.0° |
| a3/shooter | grey | 13.93% → 1.78% | 180.0° → 0.0° |
| a3/shooter | olive | 4.95% → 1.42% | 89.5° → 0.0° |

`bullet->bullet` falls from 40.6% (a1/shooter) and 48.2% (a3/shooter) to 1.0-5.6% of a much
smaller total; the remainder is overwhelmingly `seek->seek` (74.7-88.5%), which is a genuine
re-decision at window expiry rather than an oscillation. Aim: `aimStepMed` 4.0-5.4° → 0.12-0.17°,
at or below the within-bucket median of 0.23-0.32°.

**One aim residual is NOT closed, and it is not jitter.** Teal's `aimStepP95` stays at
9.85-19.96° while every other kind falls to 0.39-0.82°. Teal is the only measured kind routed
to `tealDecision`, the one implementation that ALTERNATES preferred shot type, on a
`BANK_PREFER_TICKS` (120) cycle that is an exact multiple of `AI_JITTER_TICKS` (20) -- so every
bank/direct switch lands on a boundary tick and is counted in the aim-step column. Verified
against the roster: of the four measured kinds only teal (MOBILE_MINE_LAYER) both carries
`bankShotWeight > 0` AND routes to the alternating implementation; grey's DEFENSIVE_BASIC
carries 0.1 but `greyDecision` never reads it, and brown prefers direct with a fallback rather
than alternating. That is a different firing SOLUTION, not aim error -- an un-held AIM intent,
where this work holds movement only. Issue #222's direction does say "hold aim and movement
intents", so AC2 is partially, not fully, closed.

Balance (60-seed engagement harness, the pinned method): losses and free wins unchanged
(a1 59/60 & 1; a3 60/60 & 0). `medianTicks` 1705 → 1561 (a1, -8.4%) and 1837 → 1937 (a3, +5.4%).
`minesPerGame` 2.67 → 2.88 and 1.45 → 1.85 (+8%/+28%). PARTLY ATTRIBUTED by a later
occupancy measurement: the risk this plan flagged before implementing -- a held dodge keeping
`!avoid` true more of the time and letting mines through -- is RULED OUT, because the fraction
of moving ticks with a live escape moved only 12.7% → 12.5% (a1/pacifist) and 3.3% → 3.4%
(a3/pacifist), which cannot produce a 28% rise. The remaining candidate is
`mineThreatensPlayer` being satisfied more often (committed movement carries a tank around the
player more effectively); that is named but NOT measured. The `mine` gate's meaning therefore
stays unchanged on evidence rather than on preference.

## MID-EXECUTION CORRECTION (2026-08-23): the bullet dodge is sign-blind

The first implementation of Task 3 shipped the emergency rule exactly as this plan
specified it — break the hold when `vdot(held, avoid) < AI_COMMIT_EMERGENCY_DOT`. Measuring
showed that rule defeating the very thing it sits inside.

`dangerAvoidMove`'s bullet branch returns one of two EXACT OPPOSITE perpendiculars, choosing
by the side the tank currently sits on. That choice flips the instant the tank crosses the
shell's axis — while both perpendiculars remain equally good ways out of the corridor. With
a signed comparison, every such flip scored `dot = -1` and read as an emergency, so the hold
broke on precisely the oscillation it exists to stop. A second path did the same at every
window expiry, where hysteresis compared the flipped perpendicular against the held one and
saw a 180-degree difference rather than the same decision.

Measured with the hold in but the sign still significant: overall reversals did fall
(grey a3/shooter 13.93% -> 9.46%), but `bullet->bullet` ROSE from 40.6% to 68.5% of all
reversals under a shooting player, and grey's 95th-percentile turn stayed pinned at exactly
180.0 degrees — the hold was working everywhere except the largest single bucket.

The correction, in both the emergency test and the hysteresis test: for a BULLET escape
compare `|dot|`, not `dot`, against `AI_COMMIT_DODGE_ALIGN_DOT` (0.5, i.e. within 60 degrees
of the perpendicular axis). A mine escape keeps the signed test, because there the opposite
direction is into the blast rather than an equally good way out. That distinction needs the
escape's KIND at the commitment layer, which is why `AiDecision` carries `avoidKind`
alongside `avoid`.

After the correction, `turnP95` is 0.0 degrees in every measured row and `bullet->bullet`
falls to 1.0-5.6% of a much smaller total. The plan's original Task 3 test list could not
have caught this: its bullet cases only ever exercised `dot = +1` or `dot = -1` against a
threshold of 0, where signed and absolute comparisons agree on the answer.

## Global Constraints

- `src/sim/` stays pure and deterministic: no DOM, Three.js, wall clock, or runtime
  flags. `TICK_HZ = 60`/`DT = 1/60` unchanged.
- Every new random draw uses the house recipe — a pure hash of
  `(world.seed, tank.id, tick bucket)` via `nextRng`, never threaded PRNG state and never
  `Math.random`. This plan adds NO new draw: the commitment window is deterministic and
  the aim change re-uses `aimJitter`'s existing stream.
- **`dangerAvoidMove` and the rest of `targeting.ts`'s shared geometry stay stateless.**
  Its own doc comment is explicit ("the noise lives at the caller, never in the shared
  geometry") because `decidePlayerInput` reuses it and must never touch `world.seed`. The
  hold therefore lives at the CALLER (`decideAi`), never in the shared helper.
- `BASELINE_HASH` WILL move. That is expected and is not a determinism failure — AC4 is
  satisfied by re-pinning under the MOVED protocol already used twice in
  `tools/baseline/trace.ts` (lines 34 and 71 are the format), with measured exposure
  justifying the move. Say this explicitly in the PR so "the trace changed" does not read
  as a contradiction of "fixed seed still produces the same trace".
- Use the existing validated catalog path for the new profile field
  (`config/types.ts` + `config/validate.ts` + `data/ai-profiles.json`); do not create
  parallel configuration plumbing.
- Every new assertion needs a production mutation or negative fixture that makes it fail.
  State the swept population beside every count.

---

### Task 1: The decision-stability measurement harness

**Files:**
- Create: `src/sim/ai/commitment.measure.test.ts` (already written on this branch —
  review it, do not rewrite it)

**Interfaces:**
- Produces: the before/after table this whole plan is measured with. No production
  imports depend on it.

- [ ] **Step 1: Review the harness against `engagement.measure.test.ts`'s conventions** —
  `describe.skip` by default, method pinned in a header comment, populations printed
  beside every figure.
- [ ] **Step 2: Confirm it is skipped in the committed form** —
  `grep -n '^describe' src/sim/ai/commitment.measure.test.ts` must show `describe.skip`.
  A harness that runs in CI would add ~45s to every test run for numbers nothing gates on.
- [ ] **Step 3: Run it and keep the output** — flip the skip, run
  `npx vitest run src/sim/ai/commitment.measure.test.ts --testTimeout=3600000`,
  save the table, flip the skip back, and confirm `git status` is clean of that flip.
- [ ] **Step 4: Commit** — `ai: decision-stability measurement harness for issue #222`.

---

### Task 2: Continuous aim-error drift (AC2)

**Files:**
- Modify: `src/sim/ai/targeting.ts` (`aimJitter`, :607)
- Test: `src/sim/ai/targeting.test.ts`

**Interfaces:**
- Consumes: existing `nextRng`, `AI_JITTER_TICKS`.
- Produces: `aimJitter(world, tank, spread)` — same signature, same call sites
  (brown/grey/teal each call it unchanged), continuous in `world.tick`.

- [ ] **Step 1: Write the failing tests** in `src/sim/ai/targeting.test.ts`:

```ts
it('drifts continuously across a jitter bucket boundary rather than stepping', () => {
  // The boundary tick is the one that used to step. Sweep every tick across two
  // whole buckets and assert the largest adjacent-tick change is small relative to
  // the spread -- with the OLD implementation the boundary tick alone is a full
  // independent redraw, which this bound rejects.
  const spread = 0.08;
  let maxStep = 0;
  let prev = aimJitter(worldAtTick(0), tank, spread);
  for (let t = 1; t <= AI_JITTER_TICKS * 2; t++) {
    const cur = aimJitter(worldAtTick(t), tank, spread);
    maxStep = Math.max(maxStep, Math.abs(cur - prev));
    prev = cur;
  }
  // A single bucket traverses at most 2*spread over AI_JITTER_TICKS ticks; allow
  // generous headroom for the easing's steepest segment and still reject a redraw.
  expect(maxStep).toBeLessThan((2 * spread) / 4);
});

it('still spans the full +/- spread envelope over many buckets (difficulty is not silently narrowed)', () => {
  // Negative control for the test above: an implementation that "smooths" by
  // collapsing toward zero would pass the continuity test and gut the AI's aim
  // error. Sample bucket ENDPOINTS, where the value is exactly one draw.
  const spread = 0.08;
  const ends: number[] = [];
  for (let b = 0; b < 200; b++) ends.push(aimJitter(worldAtTick(b * AI_JITTER_TICKS), tank, spread));
  expect(Math.max(...ends)).toBeGreaterThan(spread * 0.9);
  expect(Math.min(...ends)).toBeLessThan(-spread * 0.9);
});

it('is a pure function of (seed, tank id, tick) -- same inputs, same answer', () => {
  // Guards the house recipe: no threaded state, so any caller at any order agrees.
  expect(aimJitter(worldAtTick(37), tank, 0.08)).toBe(aimJitter(worldAtTick(37), tank, 0.08));
});
```

- [ ] **Step 2: Run to verify they fail** —
  `npx vitest run src/sim/ai/targeting.test.ts -t 'drifts continuously'` → FAIL.
- [ ] **Step 3: Implement** in `targeting.ts`, replacing `aimJitter`'s body and extending
  its doc comment with the measured justification from this plan's baseline table:

```ts
export function aimJitter(world: World, tank: Tank, spread: number): number {
  const bucket = Math.floor(world.tick / AI_JITTER_TICKS);
  const draw = (b: number): number => nextRng(world.seed + tank.id * 7919 + b).value * 2 - 1;
  // Interpolate from THIS bucket's draw toward the NEXT one across the bucket, so the
  // perceived aim error drifts instead of teleporting. Measured before this change:
  // the target moved a median 4.0-5.4deg on a boundary tick against 0.11-0.18deg on
  // every other tick, with a P95 boundary step of 23.19deg -- ~10 ticks of
  // AI_TURRET_TURN_RATE slew to absorb, which is the visible twitch issue #222 names.
  //
  // Smoothstep, not a linear ramp, for a reason that is about the DISTRIBUTION and not
  // about looks: its zero slope at both ends makes the value linger near each bucket's
  // own draw, so the marginal spread stays close to the uniform +/-spread the profile
  // is tuned for. A linear lerp spends its time mid-blend, quietly narrowing effective
  // aim error -- i.e. making every enemy MORE accurate -- which would be a silent
  // difficulty change smuggled in as a smoothing fix.
  const t = (world.tick % AI_JITTER_TICKS) / AI_JITTER_TICKS;
  const eased = t * t * (3 - 2 * t);
  const a = draw(bucket);
  const b = draw(bucket + 1);
  return (a + (b - a) * eased) * spread;
}
```

- [ ] **Step 4: Run to verify pass** — `npx vitest run src/sim/ai/targeting.test.ts`.
- [ ] **Step 5: Measure the difficulty side effect** — this changes effective aim error,
  which is a balance knob. Run `engagement.measure.test.ts` (flip skip, run, flip back)
  and compare `losses`/`freeWins`/`medianTicks` against this plan's baseline. Record the
  delta in the PR. If `medianTicks` moves by more than ~10%, STOP and report it for an
  owner call rather than silently retuning `AI_AIM_SPREAD` — the anchor is owner-tuned.
- [ ] **Step 6: Commit** — `ai: aim error drifts across its jitter bucket instead of stepping`.

---

### Task 3: Held movement intent with hysteresis and emergency interrupt (AC1)

**Files:**
- Modify: `src/sim/types.ts` (two optional `Tank` fields)
- Modify: `src/sim/ai/decision.ts` (`AiDecision` gains the write-back pair)
- Modify: `src/sim/ai/index.ts` (`decideAi` applies the hold; `stepAi` writes it back)
- Modify: `src/sim/constants.ts` (two new tuning constants)
- Create: `src/sim/ai/commitment.ts` (the hold itself — a focused, directly testable unit)
- Test: `src/sim/ai/commitment.test.ts`

**Interfaces:**
- Consumes: `dangerAvoidMove`, `wallBlocksStep` (must be EXPORTED from `targeting.ts` —
  it is currently module-private), `AiDecision`.
- Produces, and later tasks/tests use these exact names:
  - `Tank.aiIntent?: Vec2` — the committed movement direction (absent = nothing held)
  - `Tank.aiIntentTicks?: number` — ticks of commitment remaining
  - `AiDecision.nextIntent: Vec2 | null`, `AiDecision.nextIntentTicks: number`
  - `commitMove(world, tank, cfg, candidate: Vec2, avoid: Vec2 | null): { move: Vec2; nextIntent: Vec2 | null; nextIntentTicks: number }`
  - `AI_COMMIT_HYSTERESIS_DOT`, `AI_COMMIT_EMERGENCY_DOT` in `constants.ts`

- [ ] **Step 1: Write the failing tests** in a new `src/sim/ai/commitment.test.ts`. Each
  bullet is one `it`, and each names the mutation that makes it fail:

```ts
// 1. HOLDS: given a live commitment and a candidate pointing the opposite way, the
//    returned move is the HELD direction and nextIntentTicks decrements by exactly 1.
//    (Fails if the hold is dropped: the candidate would come straight through.)
// 2. EXPIRES: at nextIntentTicks 0 the candidate is adopted and the window re-arms to
//    the profile's commitment ticks. (Fails if the window never re-arms.)
// 3. HYSTERESIS: a candidate within AI_COMMIT_HYSTERESIS_DOT of the held direction does
//    NOT replace it even at expiry -- the held vector is returned by identity, so a
//    near-equivalent choice cannot churn. Negative control in the same test: a candidate
//    just OUTSIDE the threshold IS adopted, so the assertion cannot pass vacuously.
// 4. EMERGENCY -- WALL: a held direction that wallBlocksStep now rejects is abandoned
//    immediately, mid-window. (Fails if emergencies are not checked.)
// 5. EMERGENCY -- THREAT: with a fresh avoid direction more than 90 degrees from the
//    held one (dot < AI_COMMIT_EMERGENCY_DOT), the hold breaks and the avoid direction
//    is taken this tick, not next window.
// 6. NOT AN EMERGENCY: a fresh avoid direction only mildly off the held one (dot above
//    the threshold) does NOT break the hold -- issue #222's "without making every shell
//    or wall contact an immediate full reversal". This is the test that fails if the
//    emergency rule is written as "any avoid direction breaks the hold".
//    MUST use a MINE escape fixture, not a bullet one: the bullet branch returns one of
//    two exact opposite perpendiculars, so dot(held, avoid) there is only ever ~+1 or
//    ~-1 and can never land in the "mildly off" band this case is about. Written against
//    a bullet fixture, this test would assert on an unreachable state.
// 7. PROFILE-DRIVEN (AC3): two configs whose commitmentTime differs produce different
//    re-armed nextIntentTicks, asserted against Math.round(commitmentTime * TICK_HZ),
//    not against a hardcoded number.
// 8. STATIONARY: a zero candidate with nothing held returns a zero move and holds
//    nothing -- brown must not acquire an intent it can never act on.
```

- [ ] **Step 2: Run to verify they fail** — `npx vitest run src/sim/ai/commitment.test.ts`
  → FAIL (module does not exist).
- [ ] **Step 3: Add the constants** to `src/sim/constants.ts`, each with a doc comment
  giving its value in degrees and what it buys:

```ts
/**
 * How close a fresh movement candidate must be to the one already committed for the two
 * to count as THE SAME decision (a dot product between unit headings, so 0.866 is 30
 * degrees). Inside this cone the held direction is kept even at window expiry, which is
 * what stops the AI oscillating between nearly equivalent choices -- measured before
 * this existed: 40.6% of all reversals under fire were `bullet->bullet`, the dodge
 * perpendicular swapping sides as the tank crossed the shell's axis.
 */
export const AI_COMMIT_HYSTERESIS_DOT = 0.866;
/**
 * How badly a newly required dodge must disagree with the committed direction before it
 * counts as an EMERGENCY and interrupts the commitment mid-window (again a dot between
 * unit headings; 0 is 90 degrees). Deliberately NOT "any dodge breaks the hold": that
 * would restore the per-tick re-decision this whole mechanism removes. A held direction
 * that still carries the tank broadly out of the corridor rides out the window.
 */
export const AI_COMMIT_EMERGENCY_DOT = 0.0;
```

- [ ] **Step 4: Export `wallBlocksStep`** from `targeting.ts` (change `function` to
  `export function`) so the emergency check uses the SAME probe the dodge vetting uses
  rather than a second copy that can drift.
- [ ] **Step 5: Implement `src/sim/ai/commitment.ts`:**

```ts
/**
 * The commitment layer: an AI tank perceives and decides on its own cadence, then
 * COMMITS, instead of re-deciding its heading every tick (issue #222).
 *
 * Applied centrally by `decideAi` over whatever the behaviour function returned, rather
 * than inside brown/grey/teal (one implementation, one set of tests, and a new behaviour
 * gets it for free) and rather than inside `dangerAvoidMove` (whose own doc comment
 * requires it to stay stateless shared geometry -- `decidePlayerInput` reuses it and must
 * never touch `world.seed`).
 *
 * Deterministic: the window is a plain countdown, not a draw, so this adds no RNG stream
 * and cannot desync any existing one.
 */
export function commitMove(
  world: World,
  tank: Tank,
  cfg: ResolvedTankConfig,
  candidate: Vec2,
  avoid: Vec2 | null,
): { move: Vec2; nextIntent: Vec2 | null; nextIntentTicks: number } {
  const held = tank.aiIntent ?? null;
  const ticks = tank.aiIntentTicks ?? 0;
  // A tank with no movement intent at all (brown) holds nothing: an intent it can never
  // act on would be state that only ever misleads a reader.
  if (!held && detHypot(candidate.x, candidate.y) < VEC_EPS) {
    return { move: candidate, nextIntent: null, nextIntentTicks: 0 };
  }
  if (held && ticks > 0 && !emergencyBreaks(world, tank, held, avoid)) {
    return { move: held, nextIntent: held, nextIntentTicks: ticks - 1 };
  }
  const commitTicks = Math.round(cfg.ai.commitmentTime * TICK_HZ);
  // Hysteresis at the adoption moment: a candidate inside the cone IS the held decision,
  // so keep the held vector rather than nudging it every window.
  const keep = held !== null && vdot(held, candidate) >= AI_COMMIT_HYSTERESIS_DOT;
  const move = keep ? held : candidate;
  return { move, nextIntent: move, nextIntentTicks: commitTicks };
}

/**
 * An emergency is a held direction that has stopped being safe -- not merely a tick on
 * which some threat exists. Two causes, both read from the same helpers the dodge itself
 * uses so the two can never disagree: the held heading now walks into a wall (moveTank
 * would cancel the move entirely and pin the tank), or a dodge is required and the held
 * heading points more than AI_COMMIT_EMERGENCY_DOT away from it.
 */
function emergencyBreaks(world: World, tank: Tank, held: Vec2, avoid: Vec2 | null): boolean {
  if (wallBlocksStep(world, tank, held)) return true;
  return avoid !== null && vdot(held, avoid) < AI_COMMIT_EMERGENCY_DOT;
}
```

- [ ] **Step 6: Thread it through** — in `decision.ts` add
  `nextIntent: Vec2 | null; nextIntentTicks: number` to `AiDecision`; in `index.ts` have
  `decideAi` call `commitMove` on the behaviour's result and `stepAi` write
  `tank.aiIntent`/`tank.aiIntentTicks` back beside the existing `aiState`/`aiTimer`
  writes. `idleDecision` returns `nextIntent: null, nextIntentTicks: 0`.
  `decideAi` needs the tick's `avoid` value for the emergency check — recompute it with
  the same perceived radii the behaviour used (`estimationError`/`profileHazardSpread`),
  which is free of new draws because those are pure per-bucket hashes.
- [ ] **Step 7: Run** `npx vitest run src/sim/ai/` — expect brown/grey/teal/dispatch
  fixtures to FAIL where they assert a per-tick heading. Update each one deliberately,
  and for every fixture you touch write down in the commit body WHY the new expectation
  is right; a fixture updated because "it broke" is how a real regression ships.
- [ ] **Step 8: Commit** — `ai: hold movement intent for a profile-driven commitment window`.

---

### Task 4: The `commitmentTime` profile field (AC3)

**Files:**
- Modify: `src/sim/config/types.ts` (`AIProfileBalance`)
- Modify: `src/sim/config/validate.ts` (`PROFILE_FIELDS`, resolution + range check)
- Modify: `src/sim/config/data/ai-profiles.json` (all 8 profiles)
- Test: `src/sim/config/validate.test.ts`, `src/sim/config/roster.test.ts`
- Check: `src/sim/config/difficulty.ts` and `difficulty.test.ts`

**Interfaces:**
- Produces: `AIProfileBalance.commitmentTime: number` (seconds), required, read by
  `commitMove` as `Math.round(commitmentTime * TICK_HZ)`.

- [ ] **Step 1: Write the failing validator tests** — a profile missing
  `commitmentTime` fails to load with a message naming the profile and the field; a
  negative value fails (a negative window would re-arm to a negative countdown and
  disable the hold silently); an unknown extra key still fails.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Add the field** to `PROFILE_FIELDS`, to `AIProfileBalance` with a doc
  comment in the file's established voice, and resolve it with `num(...)` plus an
  explicit non-negative check.
- [ ] **Step 4: Author the eight values** in `ai-profiles.json`. Commitment is a
  PERSONALITY axis, so it must not simply track difficulty — pair a long window with
  decisiveness, a short one with skittishness, and say so in the PR:

```
STATIC_BASIC      0.30   (stationary; the field is inert for it -- see step 6)
DEFENSIVE_BASIC   0.20   (grey: jumpy, re-evaluates often -- the worst reverser measured)
DEFENSIVE_ROCKET  0.25
MOBILE_MINE_LAYER 0.30   (teal)
OFFENSIVE_ASSAULT 0.40   (commits hard to a charge)
RICOCHET_SNIPER   0.30   (stationary; inert)
OFFENSIVE_ELITE   0.35
BERSERKER_ROCKET  0.50   (never second-guesses itself)
```

- [ ] **Step 5: Prove AC3 is observable** — a test that two profiles differing ONLY in
  `commitmentTime` produce different re-arm windows through the real `decideAi`, not just
  through `commitMove` in isolation.
- [ ] **Step 6: Check `difficulty.ts`** — `tankDifficultyBreakdown` deliberately scores
  only fields the sim actually reads, and gates terms by behaviour (see its doc comment on
  three separate instances of that bug class). Decide and DOCUMENT one of: (a) commitment
  is not a monotonic threat axis, so it is not scored — with a comment saying so; or
  (b) it is scored, gated to non-STATIONARY behaviours (brown's `desiredMove` is always
  zero, so its commitment is genuinely inert). Check whether `difficulty.test.ts` has a
  completeness guard requiring every profile field to be scored; if it does, (a) needs an
  explicit exclusion entry rather than silence.
- [ ] **Step 7: Run** `npm run verify:quick`. **Commit** — `ai: profile-driven commitment window`.

---

### Task 5: Bot-driven player tanks (scope decision — cut if large)

**Files:**
- Modify: `src/sim/ai/player-profile.ts` (`PlayerAiState`, `decidePlayerInput`)
- Test: `src/sim/ai/player-profile.test.ts`

The same visible defect applies to bots driving PLAYER slots in VS, which reach
`dangerAvoidMove` through `decidePlayerInput`. That path deliberately does NOT use the
world-seed hash — it carries its own `PlayerAiState` and an injected `rnd` stream (see
that module's header comment) — so the commitment state has a natural home in
`PlayerAiState` rather than on `Tank`.

- [ ] **Step 1: Decide and record.** Extend `commitMove`'s logic to `decidePlayerInput`
  via `PlayerAiState`, OR file a follow-up issue and state the residual in the PR body.
  Do NOT leave it unmentioned: a VS bot that still jitters while campaign enemies do not
  is a visible inconsistency, and issue #222's AC1 says "a tank", not "an enemy tank".
- [ ] **Step 2:** If extending, mirror Task 3's eight test cases against the
  `PlayerAiState` seam. **Commit** separately so it can be reverted independently.

---

### Task 6: Re-measure, re-pin the trace, and gate

- [ ] **Step 1: Re-run both harnesses** on the final tree (flip skip, run, flip back,
  confirm `git status` clean of the flip each time) and build the before/after table.
  Expected direction: reversal percentages fall substantially in every row; `turnP95`
  falls well below 180°; `aimStepMed` approaches `aimHoldMed`. If reversals do NOT fall,
  the hold is not reaching the decision — diagnose before proceeding.
- [ ] **Step 2: Re-run `engagement.measure.test.ts`** and compare
  `losses`/`freeWins`/`medianTicks`/`minesPerGame` to the baseline. Watch
  `pacifist.test.ts`'s free-win boundary specifically: a commitment window makes the AI
  slower to re-aim at a dodging player, which can push free wins up. If the pacifist gate
  fails, that is a real balance finding, not a flaky test.
- [ ] **Step 3: Re-pin `BASELINE_HASH`** in `tools/baseline/trace.ts` following the MOVED
  protocol (the entries at :34 and :71 are the format). Justify with measured exposure —
  how many AI decisions in the traced population actually changed — not merely "the AI
  changed".
- [ ] **Step 4: Add mutation manifest entries** in `tools/mutate/manifest.json`, each
  measured and proven KILLED via `npm run mutate -- --only <id>` (use the
  `mutation-check` skill for format and protocol):
  - `ai-commit-no-hold` — `commitMove`'s hold branch returns `candidate` instead of `held`
  - `ai-commit-any-threat-breaks` — `emergencyBreaks` returns true for any non-null `avoid`
  - `ai-commit-no-hysteresis` — the `keep` test is forced false
  - `ai-aim-jitter-step` — `aimJitter`'s `eased` is forced to 0 (restores the step)
- [ ] **Step 5: Normal-speed footage (AC5).** Issue #222 requires before/after footage,
  not a screenshot. Capture via the `visual-check` skill / `npm run trace:browser`, host
  on the `pr-media` branch, and embed both clips in the PR body.
- [ ] **Step 6: High-risk gate.** From a clean candidate worktree run
  `npm run verify:full`, captured with `> log 2>&1; echo $?` — never piped through
  `tail`/`grep`, which launders the exit code and truncates the evidence. Plus the golden
  trace and `pacifist.test.ts` explicitly.
- [ ] **Step 7: PR.** Title: `Hold AI movement intent for a profile-driven commitment window`
  (the title is the complete squash message; no trailers, no attribution). Body: `Closes
  #222`, the before/after table with populations, the `BASELINE_HASH` MOVED justification,
  the AC4 note (re-pinning satisfies determinism, it does not contradict it), the Task 2
  difficulty delta, and every residual below. Stamp this plan `status: completed` with the
  PR number. Push at every task boundary.

## Residuals to state in the PR

- **#223 is blocked, not deferred by choice.** Its acceptance criteria are written against
  "the AI difficulty selected for a VS bot", and no such selection exists: `difficulty.ts`
  is a SCORING model that rates authored profiles, not a selectable preset, and #267 (VS
  bot difficulty in setup/session config) is open and unstarted. #223 also asks how a
  preset should COMPOSE with each tank's profile "rather than replacing tank identity",
  which its own text frames as a design decision. Needs #267 or an owner ruling before it
  can be planned.
- **#224 is the planned next branch** and is deliberately untouched here: it changes what a
  dodge IS (wall-aware escape search), while this changes how long one is HELD. Landing
  them together would make one trace re-pin answer for two behaviour changes.
- Whatever Task 5 decides about bot-driven player tanks.
- `bestEscapeDirection`'s 16-sample wheel can still pick adjacent samples on consecutive
  windows; the hold masks this rather than fixing it, and #224 owns the escape search.
