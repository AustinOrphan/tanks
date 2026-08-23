---
status: active
date: 2026-08-23
last-reviewed: 2026-08-23
scope: Deterministic triggered-warning phase between any mine trigger and blast expansion, tick-owned, with idempotent triggers
implementation-issues: [275]
implementation-prs: []
supersedes: []
superseded-by: []
---
# Mine triggered-warning phase Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Armed mines get an explicit deterministic warning phase between ANY lethal
trigger (proximity entry, fuse expiry, shell hit) and blast expansion, lasting a named
exact number of simulation ticks, with idempotent triggers and first-credit preserved
(issue #275; presentation is #276, tuning is #277).

**Architecture:** A `triggerMine(world, mine, events, credit?)` seam replaces every
direct `detonateMine` entry: it stamps the mine `triggered` with a tick countdown
(`MINE_WARNING_TICKS`) and the eventual blast credit, emits a new `mine-triggered`
SimEvent once, and is a no-op on re-entry. `stepMines` counts the warning down and calls
the unchanged `detonateMine` at zero. Owner-clear arming, blast expansion, and the
existing `mine-armed`/`mine-detonate` events are untouched.

**Tech Stack:** TypeScript, vitest, `tools/mutate` manifest, `tools/baseline` golden trace.

**Spec:** GitHub issue #275 (behavioural contract) under epic #233. Code context:
`src/sim/mines.ts` (`stepMines`, `detonateMine`, fuse via dt-decremented `timer`),
`src/sim/bullets.ts:193` (the shell trigger call), `src/sim/constants.ts`
(`MINE_TIMER` from balance.json, `MINE_BLAST_EXPAND_TICKS = 5` hardcoded "feel value").

## Global Constraints

- Sim purity; ticks own the transition (a tick countdown, never wall-clock, never dt
  drift — the countdown decrements once per `stepMines` call).
- `MINE_WARNING_TICKS = 30` (500 ms at 60 Hz) — provisional reaction window, documented
  as #277's tuning target. Named in `balance.json` `mines.warningTicks` and surfaced
  through `constants.ts`, the same one-import-site treatment every mines timing already
  gets; pinned by test like `MINE_BLAST_EXPAND_TICKS`.
- Triggers are idempotent: a triggered mine ignores fuse expiry, further proximity, and
  further shells; the FIRST trigger's credit is what the blast carries (a shell trigger
  keeps `{source:'shell', ownerId}` through the warning).
- Owner-clear arming (`mine-armed`) is unchanged; unarmed-mine policy
  (`world.unarmedTrigger`) gates ENTRY to the warning exactly as it gated detonation.
- A new `mine-triggered` SimEvent joins the union: inspect every consumer
  (render/particles, audio/director, game/haptics, game/loop) — this child adds NO
  presentation; each consumer must ignore the event explicitly-or-structurally, verified
  by their suites (#276 wires the cue).
- Golden trace: exposure is MEASURED first (Task 1), not assumed. If the hash moves, the
  re-pin follows the trace.ts MOVED-comment protocol (old hash, new hash, confirmed by
  running trace.test.ts, and an argument why only this change moves it).

---

### Task 1: Measure golden-trace and baseline exposure

- [ ] **Step 1:** Probe the golden trace run (`tools/baseline/trace.ts` logic in a
  scratch vitest file): count `mine-armed` / `mine-detonate` events and mines laid
  across the full traced run. Record the numbers.
- [ ] **Step 2:** Read how the trace text serializes world state — whether `Mine`
  objects are serialized field-by-field (a new field alone would move the hash) or only
  events/positions are hashed.
- [ ] **Step 3:** Write the findings into this plan (below) and into the eventual PR
  body. Findings decide Task 4's re-pin step.

**Findings (measured 2026-08-23, this tree):** the trace hashes sampled tank
positions/turret/alive plus final status:tick — `Mine` fields are NOT serialized, so
additive fields alone cannot move the hash. But the traced population (5 arenas × 6
seeds × 2500 ticks; driven player lays a mine every 311 ticks) contains **166 mines
laid, 150 armed, 88 `mine-detonate` events and 27 blast kills** — detonation timing
shifts by the warning duration, kills and post-blast trajectories move, so
BASELINE_HASH WILL move and Task 4's re-pin is required, justified by these counts.

### Task 2: The phase machine in `mines.ts` (TDD)

**Files:** Modify `src/sim/mines.ts`, `src/sim/types.ts` (Mine fields + SimEvent),
`src/sim/constants.ts`, `src/sim/config/data/balance.json`; test `src/sim/mines.test.ts`
(or the existing mine suite file — follow its location).

**Interfaces:**
- `Mine` gains `warningLeft: number | null` (null = not triggered) and
  `pendingCredit?: Blast['credit']`.
- `MINE_WARNING_TICKS` (constants.ts, from `balance.json` `mines.warningTicks` = 30).
- `export function triggerMine(world, mine, events, credit?): void` — no-op if
  `mine.warningLeft !== null || mine.detonated`; else stamps `warningLeft =
  MINE_WARNING_TICKS`, stores credit, pushes
  `{ type: 'mine-triggered', mineId, ownerId, pos }`.
- `SimEvent` union gains `mine-triggered` (same payload shape as `mine-armed`).
- `stepMines`: triggered mines skip arming/fuse/proximity logic entirely; decrement
  `warningLeft`; at 0 call `detonateMine(world, mine, events, mine.pendingCredit)`.
  Fuse expiry and proximity entry now call `triggerMine` instead of `detonateMine`.
- `bullets.ts:193` calls `triggerMine(world, m, events, { source: 'shell', ownerId })`.

- [ ] **Step 1: Failing tick-boundary tests**, one per acceptance criterion:
  proximity entry emits `mine-triggered` and NOT `mine-detonate` on the trigger tick;
  detonation lands exactly `MINE_WARNING_TICKS` stepMines calls later (off-by-one pinned:
  trigger at call k → `mine-detonate` at call k + 30, not k + 29 / k + 31);
  fuse expiry enters the warning (not instant detonation); a shell trigger enters the
  warning carrying shell credit through to the blast's `credit` (kill attribution
  preserved — assert the blast object's credit, not just the event); re-trigger
  idempotency (proximity + fuse + second shell during the warning: ONE `mine-triggered`,
  ONE `mine-detonate`, credit unchanged, countdown not reset — pin by asserting the
  original detonation tick); owner-clear arming unchanged (existing suite must not move);
  unarmed mines with default policy still ignore proximity (enter no warning);
  a triggered mine whose owner dies mid-warning still detonates on schedule.
- [ ] **Step 2: Run to verify failures.**
- [ ] **Step 3: Implement**; keep `detonateMine` exported and unchanged (it is the
  warning's exit, and tests/AI comments reference its semantics).
- [ ] **Step 4:** Run the full sim suite; fix consumers that break on the new union
  member; `npx tsc --noEmit`.
- [ ] **Step 5: Commit** `mines: deterministic triggered-warning phase` and push.

### Task 3: Consumer sweep and full suite

- [ ] **Step 1:** Run `src/render`, `src/audio`, `src/game` suites; for each consumer of
  mine events confirm the new event is ignored without error (explicit case or
  structural filter), adding an explicit ignore only where a switch demands
  exhaustiveness. No visual/audio cue in this child.
- [ ] **Step 2:** AI check: `grep` targeting/grey for assumptions that detonation is
  instantaneous on proximity; the warning gives dodgers MORE time, but any test pinning
  "tank inside proximity dies within N ticks" moves by +30 — update such pins
  deliberately, each named.
- [ ] **Step 3:** `npm run verify:quick` (log + exit captured); commit
  `mines: consumer sweep for the triggered event` if changes were needed, and push.

### Task 4: Trace re-pin (if Task 1 says so), mutation evidence, gates, PR

- [ ] **Step 1:** Run `trace.test.ts`. If BASELINE_HASH moved: re-pin per the MOVED
  protocol in trace.ts (old/new hash, run-confirmed, why-this-change-only argument
  citing Task 1's measurements). If it did not move, record THAT with Task 1's counts
  (e.g. "0 mine events in the traced run; field additions not serialized").
- [ ] **Step 2:** Mutation evidence (mutation-check skill; expected KILLED):
  (a) `triggerMine` loses its idempotency guard (re-trigger resets `warningLeft`) —
  killed by the countdown-not-reset pin; (b) `MINE_WARNING_TICKS` consumed as 1 —
  killed by the exact-tick boundary test; (c) `stepMines` detonates on
  `warningLeft > 0` instead of `=== 0` (or fuse path still calls `detonateMine`
  directly) — killed by the trigger-tick no-detonate assertion.
- [ ] **Step 3:** `npm run docs:check`; update this plan's findings; from the clean
  candidate tree `npm run verify:full > log; echo $?` (sim change: high risk).
- [ ] **Step 4:** PR — title `Give armed mines a deterministic triggered-warning phase`,
  body with tick contract, populations/denominators, trace verdict, mutation table,
  `Closes #275`. No attribution trailers. Record CI; merging is the owner's.
