---
status: completed
date: 2026-08-15
last-reviewed: 2026-08-23
scope: Quantized multiplayer aim input and tick identity for simulation events
implementation-issues: []
implementation-prs: [171]
supersedes: []
superseded-by: []
---
# Plan — multiplayer-determinism frontier: `InputState.aim` quantization and `SimEvent` tick identity

Status: adopted 2026-08-15, implemented on branch `mp-frontier`.

Provenance: a read-only investigation against the checkout at `origin/main`
(`cbd06f1`), scoped to what `docs/research/multiplayer.md` names as "the actual
frontier of the determinism work" now that PR #165 closed the transcendental-math
question. Both design decisions below (the quantization boundary, the tick-stamping
shape) follow from evidence already in the tree rather than from a preference needing
adjudication, and the plan is reproduced verbatim below as adjudicated.

**Correction to the plan's residuals section**, found while implementing: its closing
bullet, "Shipped Safari and iOS remain untested by anything, including PR #165's
engines matrix," is stale as of this plan's own commit. PR #168's `engines.yml` CI run
on its merge (run `31862528280`, jobs `Safari (safaridriver, real macOS)` and `iOS
Simulator (beacon, Mobile Safari)`) measured real shipped Safari 26.5.2 and iOS 18.7
(Simulator) — both `MATCH`ed `BASELINE_HASH` (`324aa9b5…`) and `VENDORED_ANGLE_HASH`
(`a4fdbbfb…`), with the expected native-`ANGLE_HASH` `MISMATCH` (the known,
non-vendored cross-engine divergence). That fact lives in the CI run, not the PR body
text, which only claimed local chromium+mock verification before merge — `CLAUDE.md`
and `docs/superpowers/backlog.md` were never updated with the post-merge CI result and
still read "untested" at `cbd06f1`; that is their staleness, not a correction owed to
either file by this plan. The standing residual this frontier still stands on is
narrower than the plan's text below states: a **physical iOS device**, not "shipped
Safari and iOS" broadly — the Simulator and real macOS Safari are now both covered in
CI, and the one-URL beacon check (`npm run trace:browser -- --beacon`) makes the
physical-device gap a manual, not a missing, check.

---

# Implementation Plan: InputState.aim Quantization and SimEvent Tick Identity

Read-only investigation against this checkout; `docs/research/multiplayer.md` and `CLAUDE.md` read via `git show origin/main:<path>`. Both items below are scoped to what multiplayer.md names as "the actual frontier of the determinism work" now that PR #165 closed the transcendental-math question.

## Item 1 — `InputState.aim` quantization

**The mechanism, read directly.** `src/render/renderer.ts:100-109`'s `screenToGround` computes NDC from `canvas.getBoundingClientRect()` (`rect.width`/`rect.height`) and unprojects against the ground plane — canvas-size-dependent exactly as multiplayer.md says. Only two of `aim`'s four producers in `src/input/input.ts` go through it: mouse move (`onMouseMove:173`) and touch `point` scheme (`applyAimGesture:240`). The other two are already canvas-independent: touch `stick` scheme (`applyAimGesture:244-250`) and gamepad (`src/input/gamepad.ts:150-156`) both project `playerPos + normalize(dir) * AIM_PROJECTION_UNITS` — pure world-space math, no DOM. `sample()` (`input.ts:411-444`) is the single point where all four converge into one `InputState`.

**The existing "1e-12 grid" is unrelated.** `src/sim/ai/targeting.ts:628` snaps `detCos`/`detSin` output in `bestEscapeDirection`'s mine-flee sampling so axis directions come out exact for a 6-decimal test comparison — an AI-internal precision fix, never touches `InputState.aim`, confirmed the only such site in `src/sim/`.

**Decision: quantize in the game layer, inside `input.ts`'s `sample()`, not in `stepInputs`/`driveTank`.**

The deciding evidence is the golden trace's import graph, not a preference. `tools/baseline/trace.ts` imports only `src/sim/arena` and `src/sim/world` and calls `step(w, { move: d, aim: d, ... })` directly with `d = { x: Math.cos(t/37), y: Math.sin(t/41) }` (`trace.ts:69-72`) — raw, non-grid-aligned floats, never touching `src/input/`. If quantization lived inside `stepInputs`/`driveTank`, these values would round on the way in and change the resulting `turretAngle` trajectory (part of `traceText()`'s hashed output, `k.turretAngle.toFixed(9)`), moving `BASELINE_HASH` (`324aa9b5…`). Quantizing in `input.ts` is categorically invisible to the trace — that file isn't in its import graph — so the hash prediction is structural, not a coincidence of current values. (I have not run the suite to confirm this — it follows from reading the two files' import graphs and call sites, and should be the first thing the implementer verifies.)

This also matches the replay architecture: `src/game/replay.ts`'s `createRecordingInput` wraps `inner.sample()` and records exactly what it returns (`encodeInput`, full float64 precision, JSON round-trips exactly). Quantizing inside `sample()` means the recorder captures the already-canonical value for free, with no separate change to `replay.ts`.

Three honest limits on what this buys, so the PR body doesn't overclaim:
- **Hash-unchanged is not behavior-unchanged.** The trace stays byte-identical because it bypasses `input.ts` entirely — it does not prove live single-player aim is unaffected. Live aim *is* now grid-snapped; that's the point, and it's a real (if imperceptible) change to the player's turret trajectory that the trace cannot see either way.
- **This fixes no observable bug today.** There is no transport and no second peer. Under the current lossless path (JSON round-trips float64 exactly, per the replay encoder), quantization isn't required for anything that can happen today. It becomes required the moment a compact/lossy wire format is chosen — this PR is forward-prep, not a live desync fix.
- **It does not reconcile two different windows' aim points.** Two peers with different canvas sizes still produce different world points for the same screen intent, and don't need to agree — each peer only needs its own value to be identical whether it feeds local simulation or gets serialized for transmission. Quantizing at the source (before it forks into those two paths) is what guarantees that, not cross-peer unification.

**Grid: decimal, not power-of-two, value 0.01.** `Math.round`, `*`, and `/` on doubles are IEEE-754 exactly-specified operations (unlike `sin`/`cos`/`hypot`, which is exactly why PR #165 had to vendor those) — a decimal grid via `Math.round(v / GRID) * GRID` is already bit-identical across V8/SpiderMonkey/JSC with no vendoring needed, and mirrors the existing `1e-12` idiom at `targeting.ts:628`. Power-of-two would only matter for a future fixed-point wire encoding, which doesn't exist yet. 0.01 world units is a feel value, not a measured perceptual threshold — pin it by reference (not by a hardcoded expected trajectory), validate by eye later if a wire format's bit budget wants revisiting, in the same spirit CLAUDE.md gives `TANK_TURN_RATE` and friends under "Numbers that are feel, not measurement." `Math.round(NaN/g)*g` and the `Infinity` case both stay non-finite, so `driveTank`'s existing `Number.isFinite` guard on `aimDir` (`world.ts:196`) still catches an unlaid-out-canvas NaN exactly as today — quantization doesn't reopen that bug.

**Home for the constant: `src/input/touch.ts`, next to `AIM_PROJECTION_UNITS` (`touch.ts:103`).** That file is already imported by both `input.ts` and `gamepad.ts`, so this adds zero new import edges. (Considered `src/sim/constants.ts` alongside `PLAYER_TURRET_TURN_RATE`/`AI_AIM_SPREAD` for the pin-discipline precedent, but rejected: the sim never consumes this constant in this design, and hosting it there for a hypothetical future consumer is exactly the architect-for-absent-consumers move CLAUDE.md's dev-flag doctrine warns against.)

**File-level changes:**
- `src/input/touch.ts`: add `export const AIM_GRID = 0.01;` near `AIM_PROJECTION_UNITS`, with a comment naming `PLAYER_TURRET_TURN_RATE`/`AI_AIM_SPREAD` as the numbers its magnitude is checked against.
- `src/input/input.ts`: import `AIM_GRID`, add a small `quantizeAim(v: Vec2): Vec2` helper, apply it once inside `sample()`'s return (`aim: quantizeAim(aim)`), covering all four producers at the one boundary.

**Red-first test plan:**
1. `src/input/touch.test.ts` — add `expect(AIM_GRID).toBe(0.01)`, matching the `AI_AIM_SPREAD`/`PLAYER_TURRET_TURN_RATE` pin style in `constants.test.ts`.
2. `src/input/input.test.ts` — write against *current* (unquantized) behavior first and watch it fail: (a) two mouse positions whose unprojected floats differ by less than `AIM_GRID/2` must produce a bit-identical `sample().aim` — fails today since raw floats differ; (b) `sample().aim.x`/`.y` are exact multiples of `AIM_GRID` — check this holds across mouse, touch-point, touch-stick and gamepad paths, since the single `sample()`-boundary fix is what makes it universal rather than mouse-only. Then implement and confirm both pass.
3. `tools/baseline/trace.test.ts`, `src/sim/step-inputs.test.ts`, `src/sim/step-pipeline.test.ts` — no changes; the implementer runs these to confirm `BASELINE_HASH` is unchanged, per the import-graph argument above.
4. `src/game/replay.test.ts` — no change needed; its fakes construct `InputState` literals directly, bypassing `sample()`.

`tools/mutate/manifest.json` has 0 of its 13 entries targeting `input.ts`, `touch.ts`, `gamepad.ts` or `constants.ts` — no known interaction there.

## Item 2 — `SimEvent` tick identity for rollback dedup

**Key finding: the sim already carries this.** `stepInputs` (`src/sim/world.ts:339-356`) increments `draft.tick` *before* running the stage block that populates `events`, then returns both in the same `StepResult`. So `result.world.tick` already is the tick that produced `result.events` — true today, for every call, including resimulation from a rolled-back snapshot (since `draft.tick = original.tick + 1` regardless of which world was stepped). No sim change is needed to *establish* tick identity for a batch.

**Where it actually gets lost: `src/game/driver.ts`'s per-frame flatten.** A catch-up frame can run `plan.ticks > 1` (`driver.ts:100-105`), and the loop does `for (const ev of result.events) frameEvents.push(ev)` — discarding `result.world.tick` on every push. This happens in ordinary single-player play today (a slow frame, a backgrounded tab), not only under a future rollback. It's the one place identity needs to be *preserved through*, not invented.

**Decision: stamp each event with its tick at the point of loss (`driver.ts`), not by adding `tick` to the `SimEvent` union in `src/sim/events.ts`, and not by returning a `{tick, events}[]` envelope from the driver to consumers.**

- `SimEvent` union unchanged means `src/sim/events.ts` and every emit call site (`bullets.ts`, `mines.ts`, `world.ts`, `collision.ts`) stay untouched — zero risk to the many sim-side tests that construct/compare `SimEvent` literals via `toEqual` against `result.events` directly.
- The discriminator between "stamp the field" and "envelope the return" is structural typing: define `type FrameEvent = SimEvent & { tick: number }` in `driver.ts`. Because `FrameEvent` is a strict structural superset of `SimEvent`, a `FrameEvent[]` is assignable everywhere a `SimEvent[]` is expected (verified — the six consumer signatures are all plain `SimEvent[]`: `renderer.ts:15`'s `render`, `render/particles.ts:5`'s `spawn`, `audio/director.ts:5`'s `handle`, `game/haptics.ts:58`'s `handle`, `game/state.ts:16`'s `onEvents`, `game/loop.ts:659`'s `onFrameEvents`). An envelope (`{tick, events}[]`) would *not* satisfy those signatures and would force changing all six — this PR does not need that yet. The implementer should confirm the assignment with `tsc --noEmit` after writing it, not just take the structural-typing argument on faith.
- `driver.test.ts` compares `h.hapticsSaw[0]` against `h.directed[0]` via `toEqual` (`driver.test.ts:273,292`) — both sides are views of the *same* internally-stamped batch, so adding a field to both equally leaves these green. Before landing, spot-check the other five consumers' own unit tests (`particles.test.ts`, `audio/director.test.ts`, `haptics.test.ts`, `state.test.ts`, `loop.test.ts`) for any exact-key-set or `toStrictEqual`/`JSON.stringify` comparison against a hand-built `SimEvent` literal lacking `tick` — none of those files change under this design (they construct events directly, bypassing `driver.ts`), but the check is cheap and worth doing before claiming zero impact.

**Confront directly: nothing reads `tick` yet.** This PR makes events tick-identifiable and stops there — no consumer gains dedup logic, because dedup only matters once rollback replays a tick a second time, and rollback doesn't exist (no transport, no rollback buffer, no peer protocol). That's acceptable specifically because: the item is greenlit (has an owner, unlike CLAUDE.md's "flag with no owner" problem), the PR body should say in plain words that the field is unread pending the netcode layer, and the pinning test (below) asserts the *value* is correct, not just present — so it's checkable machinery, not decoration.

**File-level changes:**
- `src/game/driver.ts`: add `export type FrameEvent = SimEvent & { tick: number };`. Change `frameEvents`'s declared type to `FrameEvent[]`. Change the flatten line to `for (const ev of result.events) frameEvents.push({ ...ev, tick: result.world.tick });`.

**Red-first test plan.** The naive version — assert `.tick` is merely present — only kills the "forgot to stamp" mutation, not "stamp every event with the frame's *final* tick" (i.e. `curr.tick` instead of `result.world.tick` per-step). Kill both: build on `driver.test.ts`'s existing `firedByPlayer()`-style helper (it already handles getting a fresh world past the countdown phase to produce real fire events — reuse that setup rather than a fresh-world frame, which emits nothing for the first ~180 ticks) and drive a catch-up frame with `plan.ticks ≥ 3` by advancing the fake clock more than 3 ticks in one `raf.fire()` call. Assert a *relative* property, not an absolute tick number: an event captured mid-frame carries `.tick` strictly less than `driver.world.tick` after that frame, or — with two fire-producing frame segments — that two events land on different ticks within the same frame's `events` array. Either form discriminates the missing-field and the wrong-tick mutations without depending on countdown length or cooldown timing. Write it against the unmutated `push(ev)` code first (fails: `tick` is `undefined`), then against a `push({...ev, tick: curr.tick})` mutant (fails: every event in the frame reports the same, final tick), then implement the real fix.

**What stays untouched, and why:**
- `tools/baseline/trace.test.ts`: `traceText()` reads only `w.tanks`/`w.status`/`w.tick`, never `events` (confirmed by reading `trace.ts:69-77`), and the trace's import graph never reaches `src/game/driver.ts`. `BASELINE_HASH` cannot move — this one is a categorical, not probabilistic, claim, since the changed file isn't in the trace's dependency graph.
- `src/sim/step-inputs.test.ts`, `step-pipeline.test.ts`, `determinism.test.ts`: exercise `src/sim/` directly, never `driver.ts`.
- `src/game/replay.ts`/`replay.test.ts`: the recorded format is `EncodedInput` (inputs), never `SimEvent`/`FrameEvent` — the recorder taps `input.sample()`, a completely different seam from the one this item touches. The recorded trace format does not change.
- Manifest: 0 of 13 `tools/mutate/manifest.json` entries target `driver.ts` or `events.ts`.

## What these two do NOT unblock

Naming the honest remaining distance to netcode, for the PR body:

- **Transport.** No signalling, no WebRTC, no wire format — multiplayer.md's blocker 1 (server infrastructure) and open question 6 (who owns/pays for signalling) are untouched.
- **Rollback buffer and dedup logic.** Item 2 makes events identifiable; nothing consumes that identity to skip a re-emitted burst/sound/haptic. That's the future netcode layer's job.
- **Peer protocol.** No message shapes, no serialization format for `InputState` or events — Item 1's grid picks a magnitude but doesn't decide bits-per-axis or a frame format.
- **`InputState.move` is not quantized.** Gamepad and touch-stick `move` are continuous (`deadzoneVector`/`stickVector`) and share the same wire-canonicalization argument `aim` does; this PR doesn't touch it. Named residual, not an oversight.
- **The one-`P` validator hard-fail** (`config/validate.ts:257`), **win/lose semantics for co-op/versus**, **second-player representation** (`TankKind` vs. a `controlledBy` field, multiplayer.md open question 2), and **the four AI sites that take the first player** (`ai/brown.ts`, `ai/grey.ts`, `ai/teal.ts`, `ai/targeting.ts`) are all still exactly as multiplayer.md describes them — neither item touches any of them.
- **Shipped Safari and iOS** remain untested by anything, including PR #165's engines matrix — still the standing residual on the cross-engine math question these two items build on top of.

No genuine fork requiring the user was found; both design decisions (quantization boundary, tick-stamping shape) follow from evidence already in the tree (the trace's import graph, `StepResult`'s existing tick field, and the six consumers' actual signatures) rather than from a preference that needs adjudicating.
