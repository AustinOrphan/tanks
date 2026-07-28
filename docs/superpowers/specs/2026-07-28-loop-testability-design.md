# Making `src/game/loop.ts` testable

**Status:** design, awaiting approval. Not yet implemented.
**Base commit:** `97e4242` (main, 34 test files / 511 tests).
**Method:** 68 mutations applied across three enumeration slices; three designs built
independently and each adversarially verified by a separate agent that *built* it rather than
read it. Claims below are labelled **measured** (a command was run and its output read) or
**reasoned** (read from source, not executed).

## Summary

`loop.ts` has no test file, and **65 of 68 applied mutations survive the full CI gate**
(`tsc --noEmit` clean and 511/511 green). The three that are caught are caught by
`noUnusedLocals`, not by any test, and each has a `tsc`-clean equivalent that survives.

The fix splits the file three ways: `frame.ts` (pure accumulator maths, no dependencies),
`driver.ts` (owns the rAF chain with an injected clock, and is where composition gets pinned),
and `loop.ts` (constructs the real collaborators; keeps `startGame(canvas, uiRoot)` so
`main.ts` is untouched, and adds an injectable `startGameWith` taking a *complete* dependency
set so no test can silently reach real howler).

The single most important finding is in §3.4: **the refactor creates a new seam that
reproduces the very blindness it cures.** Driver tests inject fake hooks, so they cannot see
whether `loop.ts` wires the real collaborators into them. Seven mutations there were measured
surviving — including one rated equal in severity to `while (false && acc >= DT)` — and were
closed only by tests that pump the injected clock's captured rAF callback through the real
`startGameWith`. Any implementation that skips those is not worth doing.

Two constraints bound the work. `main.ts` wraps `startGame` in a `try/catch` to render a
"no WebGL" page, which works only because the renderer is constructed eagerly and
synchronously inside the call (§4). And a bare module-scope reference to `window` in the
dependency literal makes `loop.ts` throw on import outside jsdom — measured, not predicted.

---

## Provenance

> Sections 1–4 synthesise three independently-built and independently-verified prototypes (minimal-surface, max-testability, repo-idiomatic), all built and swept at `97e4242`. I re-measured the load-bearing numbers myself in this worktree at `97cb2c6` (`git diff --stat origin/main -- src/` is empty; `npx vitest run --reporter=dot` → **Test Files 34 passed (34) / Tests 511 passed (511)** — the same baseline the three slices used, on two commits further along). Everything below is labelled **measured** (a command was run and its output read) or **reasoned** (read from source, not executed). The grafted design in section 2 has **not** itself been built or swept; its projected numbers are stated as projections.

---

## 1. THE HOLE — what `loop.ts` admits today

### 1.1 The headline, with its denominator

**68 mutations were applied to `src/game/loop.ts` and `src/main.ts` across three enumeration slices. 65 survive the full CI gate — `tsc --noEmit` clean *and* `vitest` 511/511 green. 3 are caught, all by `tsc`'s `noUnusedLocals`, and 0 by any test.**

The three `tsc`-only kills are `M-W-14` (the `onStartRestart` handler dropped, which orphans `resetWorld`), `M-LC-01` and `M-LC-04` (the raw guard/cancel deletions, which orphan `running` and `raf`). Each was re-expressed as a `tsc`-clean equivalent — `M-LC-01b`, `M-LC-04b` — and those survive. `M-W-15` (title branch emptied) is the direct evasion of `M-W-14`'s incidental compiler guard, and it survives; that guard also evaporates the moment `resetWorld` gains a second caller.

**Arithmetic disagreement, reported rather than smoothed.** The three slices self-report 23 + 27 + 17 = 67 applied and 23 + 26 + 15 = 64 surviving. I counted the distinct ids in the catalog myself: M-TS 23, M-C 6, M-W 14 (no `M-W-14`), M-L 6, M-LC 13, M-MT 3 = **65 surviving ids**, which reconciles with 68 applied only if the lifecycle slice applied 18, not 17 — its own prose says "the 11 mutations the task enumerated" while listing 12 of them (guard, in-frame reschedule, initial kick, cancel, *six* teardown calls, `{once:true}`, try/catch). The headline 65/68 is right; that slice's self-count is off by one against the ids it actually produced.

### 1.2 Per-class breakdown of the 65 survivors

Classified by the catalog's own bracketed tags; I counted these myself and they sum to 65.

| Class | Survivors | What the class is | Worst member |
|---|---|---|---|
| lifecycle | 16 | rAF chain, `dispose()`, `resetWorld`, the `running`/handle pair, `main.ts` teardown wiring | `M-LC-02` — loop runs exactly one frame and stops forever |
| timestep | 14 | `dtReal` derivation, the 0.25 s spiral clamp, the accumulator, the drain loop | `M-TS-01` — `while (false && acc >= DT)`, the canonical hole; 0.0 ticks/s measured at 60/144/30 Hz in a standalone replica |
| wiring | 11 | HUD channel subscriptions, `sm.onChange`, `audio.unlock`, HUD stats, the render `dt` argument | `M-W-15` — Start button does nothing; `M-W-09` — game plays under a permanent title overlay |
| listeners | 9 | `window` keydown/resize registration and removal, the two `onKey` guards, `{once:true}` | `M-L-03` — arena stays stretched/cropped for the whole session after any resize |
| interpolation | 8 | the `alpha` expression, `prev`/`curr` bookkeeping, the render argument order | `M-TS-18` — every entity lerped between its spawn pose and its live pose |
| construction | 7 | renderer sizing, director player id, `screenToGround` argument order, the seed, `main.ts`'s try/catch | `M-C-05` — no tank is id 0, so the player never hears their own cannon |

**Why every one of them survives, mechanically.** `grep -rn "game/loop\|startGame\|from './loop'" src/` returns exactly three hits — `src/main.ts:2`, `src/main.ts:11`, and the definition at `src/game/loop.ts:21` (I ran this; output above is complete). Nothing imports `main.ts`. **No test executes a line of either file.** `loop.ts` and `main.ts` are 2 of 8 modules under `src/` with no sibling test file (the others: `render/renderer.ts`, `render/scene.ts`, `render/canvas.ts`, `render/particles.ts`, `sim/ai/decision.ts`, `sim/ai/index.ts` — I enumerated these; note `render/framing.ts` now *has* a test, so CLAUDE.md's list is one commit stale).

### 1.3 The subset that is not worth pinning

Of the 65, the enumerators proved or measured these equivalent, near-equivalent, or unreachable — a test for them would advertise coverage of something no player can see: `M-TS-02` (`>=`→`>`; tick counts identical to baseline over 3600 frames on four clock models), `M-TS-17` and `M-TS-20` individually (each provably absorbed; only the *pair* is observable), `M-TS-21`, `M-W-06`, `M-W-10`, `M-W-11`, `M-L-04`, `M-C-01` within a single session, `M-MT-13`, and the four shutdown-path mutations `M-LC-01b/04b/05/06` individually (the guard and the cancel each independently halt the loop; only the compound `M-LC-16` is observable). `M-W-12` is a half-equivalent: unkillable by any startup assertion, because lives and live enemies are both 3 at t=0 (measured) *and* the HUD markup hardcodes `Lives: 3` / `Enemies: 3` (`hud.ts:23-24`).

### 1.4 Classes nobody enumerated

The union of the three slices' stated unswept classes, plus what verification found afterwards. **The 65 must not be read as "everything in `loop.ts`".**

1. **The adapter seam the refactor itself creates.** Not a class the enumerators could see — it does not exist yet. Measured after the fact: 12 of 14 mutations of the `DriverHooks` adapter literal survive a design whose driver tests inject fakes. See §3.4; this is the section's most consequential omission.
2. **Compound / multi-site mutations.** All three slices applied single-edit mutations except `M-W-03`, `M-LC-16` and one two-site hoist. A single-edit sweep is structurally blind to the `M-TS-17`+`M-TS-20` class, which it proved by finding exactly one such pair by hand.
3. **Ordering permutations inside `dispose()`.** 6 calls, 15 adjacent-swap pairs, **0 tried**. Only deletions were applied.
4. **Duplicated calls** (a collaborator constructed or disposed twice) — never applied.
5. **Constant perturbations**: `DT` itself, clamp values beyond the four tried, `* 2` versus other factors.
6. **The `browserDeps` / `createBrowserDeps` factory literal.** Found only during verification: nothing gets past `createRenderer` under jsdom, so a swap of `createInput` ↔ `createHud` inside that object survives every test any of the three designs wrote. This is the residual the refactor concentrates rather than eliminates.
7. **`updateHudStats` dropped from the post-refactor `onSimulated` hook** — player-visible (lives and enemies-remaining freeze for the whole game), no catalog id, measured surviving all 571 tests of one prototype.
8. **`main.ts`'s own body.** It runs at module scope against `document.getElementById('app')` and is not importable. `M-MT-13/14/15` are unpinned by all three designs.
9. **Mutations to the collaborators** (`hud.ts`, `state.ts`, `director.ts`, `scene.ts`, `entities.ts`, `particles.ts`) and **to the test files themselves** (no negative control on the fakes, in any design bar one).
10. **`vite build` and the bundle-portability CI step.** Never run by any slice (machine limits). Nothing in this document speaks to it.
11. **`renderer.dispose()` idempotency.** `createRenderer` cannot be constructed under jsdom, so the one collaborator whose double-dispose behaviour matters is unmeasured. **Do not write an "idempotent dispose" test until this is closed.**
12. **Observed pixels.** No slice ran the game in a browser. Every claim about what a player *sees* is read from `render/particles.ts:112-123` and `render/entities.ts:121-234`, not observed.

---

## 2. ARCHITECTURE — three modules, exact signatures

The split is the approved one. Each interface below is taken from whichever prototype verified strongest on that specific seam, and the provenance is named. **The grafted combination has not been built; per-file provenance is measured, the combination is reasoned.**

### 2.1 `src/game/frame.ts` — pure accumulator maths

*Base: repo-idiomatic (`Math.floor` tick count). Grafted: `renderAlpha` as a separate named function, from minimal-surface.*

```ts
import { DT } from '../sim/constants';

/** Frames longer than this are credited as this, so a stall cannot spiral. */
export const MAX_FRAME_DT = 0.25;

export interface FramePlan {
  /** Real seconds credited to this frame, after the clamp. Feeds particles.update. */
  readonly dt: number;
  /** Whole sim ticks this frame owes. */
  readonly ticks: number;
  /** Accumulator left over after those ticks; always in [0, DT). */
  readonly acc: number;
}

export function planFrame(acc: number, dtReal: number): FramePlan;
export function renderAlpha(acc: number, simulating: boolean): number;
```

**Depends on:** `DT` from `../sim/constants`. Nothing else — no DOM, no `three`, no `howler`, no clock.

**Why `Math.floor(filled / DT)` and not a drain loop.** `M-TS-06` (`acc -= DT` deleted) is an *infinite loop*, not a wrong number: a driver test pumping a fake rAF through a real `step()` would **hang the vitest run** rather than fail it. Two prototypes solved this by adding `MAX_TICKS_PER_FRAME = 240` to the loop condition — new production behaviour that is unreachable in situ (the 0.25 s clamp permits at most 15 ticks), so its own guard test can only be reached through `frame.ts`'s pure API. The `Math.floor` form **dissolves** the mutation: there is no decrement to delete. Verified structurally by repo-idiomatic's verifier (`grep -n "while" src/game/driver.ts src/game/frame.ts` → no match, exit 1) and behaviourally by both other verifiers (0 timeouts across 74 and 68 mutations respectively, with the guard in place).

**The cost, re-measured by me rather than relayed.** I re-ran the equivalence comparison between the shipped `while (acc >= DT) acc -= DT` drain and `Math.floor`, over 3600 frames on five clock models (`i*1000/60`; accumulating ideal 60 Hz; deterministic ±1 ms jitter; 144 Hz; a drifty 17/16 ms alternation) — **18,000 frames, `framesDiffering = 0`, `tickTotalDelta = 0`, `maxAccDelta = 0.000e+0`.** But I also found a residual the original comparison did not report: **on the clamped-stall path the two forms are not bit-identical.** A 0.25/0.5/2/60 s stall gives 15 ticks under both, with the drain leaving `acc = 4.857e-17` and the floor form leaving `acc = 0` — an alpha difference of ~2.9e-15. Interleaving twelve 2 s stalls into a 60 Hz stream: tick totals identical (3768 both), 0 differing frames, `maxAccDelta` grew to **6.592e-16** and never flipped a tick boundary. **This is a sample over 6 clock models, not a proof of float equivalence.** Minimal-surface explicitly declined `Math.floor` on exactly this ground and called it the most arguable line in its diff; I am overruling that with the wider measurement, and the residual above is the honest price.

**Why `renderAlpha` is a separate function.** Minimal-surface measured that extracting it with `acc` as a *named parameter* turns `M-TS-14` (`alpha → 0`) and `M-TS-15` (`alpha → 1`) into compile errors under the repo's existing `noUnusedLocals`: `src/game/frame.ts(59,29): error TS6133: 'acc' is declared but its value is never read.` Two silent runtime defects become `tsc` failures for free. Per CLAUDE.md, a guard is worth what its own tests prove: the negative control is `frame.test.ts`'s `renderAlpha` value tests, which kill `M-TS-16` (`DT / acc`) — a mutation `tsc` does **not** catch, because `acc` stays referenced.

**`M-TS-16` needs asserting at the value, not downstream.** `entities.sync` does `Math.min(1, Math.max(0, alpha))` (`src/render/entities.ts:227`), and `Math.min(1, Math.max(0, Infinity)) === 1` (verified in node). The render layer silently absorbs both `DT/acc`'s `Infinity` and `M-TS-03`'s unbounded alpha (max 300 measured at 30 Hz). **Any test asserting a rendered entity position instead of the alpha argument misses both.**

### 2.2 `src/game/driver.ts` — the frame loop, clock and rAF injected

*Base: repo-idiomatic (real `step` imported, not injected — mirroring `step-pipeline.test.ts` using the real pipeline). Grafted: getters on the `Driver` handle, and the two lifecycle assertions from the lifecycle slice.*

```ts
import { step, type World } from '../sim/world';
import type { InputState } from '../sim/types';
import type { SimEvent } from '../sim/events';
import type { GameState } from './state';
import { planFrame, renderAlpha } from './frame';

export interface RafScheduler {
  request(cb: (now: number) => void): number;
  cancel(handle: number): void;
}

/** The slice of GameStateMachine the driver uses. `state` is read LIVE -- see below. */
export interface DriverStateMachine {
  readonly state: GameState;
  onEvents(events: SimEvent[]): void;
}

export interface DriverDeps {
  /** Monotonic milliseconds. `performance.now` in the browser. */
  now(): number;
  raf: RafScheduler;
  input: { sample(): InputState };
  renderer: {
    render(prev: World, curr: World, alpha: number, events: SimEvent[], dt: number): void;
  };
  director: { handle(events: SimEvent[]): void };
  stateMachine: DriverStateMachine;
  /** The world to start on. `reset` replaces it. */
  world: World;
  /** Once per SIMULATING frame, after events are routed. loop.ts refreshes HUD stats here. */
  onSimulated(world: World): void;
}

export interface Driver {
  /** MUST be implemented as a getter -- see constraint (b). */
  readonly world: World;
  /** The pose the last render interpolated FROM. MUST be a getter. */
  readonly prevWorld: World;
  start(): void;
  stop(): void;
  /** Fresh round: prev = curr = world, accumulator dropped. */
  reset(world: World): void;
}

export function createDriver(deps: DriverDeps): Driver;
```

**Depends on:** `frame.ts`, the real `step`/`World` from `../sim/world`, and types only from `../sim/types`, `../sim/events`, `./state`. **No DOM, no `three`, no `howler`.**

**Enforcement note.** `src/sim/purity.test.ts` scans **only** `src/sim/` (I read its loader). `frame.ts` and `driver.ts` sit under `src/game/`, so nothing guards their DOM-freedom by construction. What does guard it: `frame.test.ts` and `driver.test.ts` carry **no** `@vitest-environment` pragma and therefore run under `vitest.config.ts`'s global `environment: 'node'`, where any DOM reference is a `ReferenceError`. That is a real, falsifiable guard — and it is why `loop.test.ts` alone carries `// @vitest-environment jsdom`, exactly as `hud.test.ts:1` and `input.test.ts:1` already do.

**The double read of `sm.state` is preserved and pinned, not tidied.** `deps.stateMachine.state` is read at the drain gate and again for alpha, with `onEvents` between them — and `onEvents` can flip `playing → win/lose` inside that gap, so on the frame a game ends alpha must be 1, not `acc/DT`. All three prototypes carry a comment saying so and all three applied the tempting hoist as a mutation; all three measured it **KILLED** by the end-of-game alpha test, and repo-idiomatic's verifier additionally measured that the **one-site** hoist (introduce the const, leave the second read live) correctly **SURVIVES** and must be kept as the negative control. Minimal-surface's verifier watched the two-site hoist survive its own suite *before* that test existed.

#### Constraint (b): `world` / `prevWorld` must be getters

Measured by me in isolation (`/tmp/probe_getter.mjs`): with `let curr` reassigned after construction, a returned object literal `{ world: curr }` reports `tick: 0` after a bump; `{ get world() { return curr; } }` reports `tick: 1`. **A plain property snapshots the reference at construction, so every restart assertion reads the pre-restart world and passes for the wrong reason.** `tsc` gives no help — `readonly world: World` is satisfied by either form. The interface above therefore carries the requirement in a comment, and the `reset()` test in §3.2 is what makes a plain-property implementation fail.

### 2.3 `src/game/loop.ts` — construction, wiring, teardown

*Base: max-testability (`GameDeps` of **factories**, not instances — the decision that buys the most coverage). Grafted: repo-idiomatic's `HostWindow` idea with max-testability's correct overloads; the complete-non-optional-deps rule from the lifecycle slice.*

```ts
/** Only what loop.ts needs from `window`, so a test can record exact (type, fn) pairs. */
export interface HostWindow {
  readonly innerWidth: number;
  readonly innerHeight: number;
  addEventListener(type: 'keydown', fn: (e: KeyboardEvent) => void): void;
  addEventListener(type: 'resize', fn: (e: Event) => void): void;
  removeEventListener(type: 'keydown', fn: (e: KeyboardEvent) => void): void;
  removeEventListener(type: 'resize', fn: (e: Event) => void): void;
}

/**
 * COMPLETE and NON-OPTIONAL. Every field required: an optional dep lets a test that
 * forgot one fall silently through to real howler (measured: createAudioEngine IS
 * constructible under jsdom, so the fall-through would not fail loudly) or to the
 * real requestAnimationFrame.
 */
export interface GameDeps {
  readonly createRenderer: (
    canvas: HTMLCanvasElement,
    worldWidth: number,
    worldHeight: number,
    boundary: number,
  ) => Renderer3D;
  readonly createInput: (
    target: HTMLElement,
    screenToGround: (clientX: number, clientY: number) => Vec2,
  ) => InputController;
  readonly createAudio: () => AudioEngine;
  /** playerId is REQUIRED here even though createAudioDirector defaults it. See below. */
  readonly createDirector: (engine: AudioEngine, playerId: number) => AudioDirector;
  readonly createStateMachine: () => GameStateMachine;
  readonly createHud: (root: HTMLElement) => Hud;
  readonly createWorld: (seed: number) => World;
  /** Monotonic ms for the frame loop. */
  readonly now: () => number;
  /** Wall-clock ms, used ONLY to derive world seeds. Separate from `now` on purpose. */
  readonly wallMs: () => number;
  readonly raf: RafScheduler;
  readonly host: HostWindow;
}

export interface GameHandle {
  dispose(): void;
}

export function deriveSeed(wallMs: number): number;
export function isMuteHotkey(e: KeyboardEvent): boolean;

/** A FUNCTION, not a const -- see constraint (a). */
export function createBrowserDeps(): GameDeps;

export function startGame(canvas: HTMLCanvasElement, uiRoot: HTMLElement): GameHandle;
export function startGameWith(
  canvas: HTMLCanvasElement,
  uiRoot: HTMLElement,
  deps: GameDeps,
): GameHandle;
```

`startGame`'s whole body is `return startGameWith(canvas, uiRoot, createBrowserDeps());`.

**Depends on:** `driver.ts`, `../sim/arena` (`CURRENT_ARENA`, `arenaBounds`, `createArenaWorld`), and — **only inside `createBrowserDeps`** — `render/renderer`, `input/input`, `audio/engine`, `audio/manifest`, `audio/director`, `./state`, `./hud`.

**Why factories and not instances.** This is the single decision that separates max-testability (59 of 65 catalog ids killed, the highest measured) from minimal-surface (52 of 65). Keeping the *call sites* — and therefore their **arguments** — inside the tested function is the only way `M-C-02`/`M-C-03` (renderer sizing), `M-C-04` (director id), `M-C-06` (`screenToGround` x/y) and `M-C-01` (seed) are reachable at all. Minimal-surface measured all four **SURVIVING** its instance-based deps and named it the design's main residual. Injecting `createWorld` additionally converts `M-W-11` and `M-W-12` from "unkillable at startup" into kills, via a deliberately **asymmetric** fixture world (3 lives, 2 live enemies) that breaks the 3/3 tie the real HUD and the real arena both produce.

**`createDirector`'s required `playerId` makes `M-C-05` a compile error, not a test target.** Measured independently by two builds: `error TS2554: Expected 2 arguments, but got 1.` `createAudioDirector`'s own default is `DEFAULT_PLAYER_ID = 0`, and no live tank is id 0 (measured ids 4, 5, 7, 16), so the default is a silent wrong answer. Note the consequence honestly: **no test pins `M-C-05` afterwards** — the compiler does.

#### Constraint (a): no bare `window` at module scope

**Measured by me** (`/tmp/probe_win.mjs`, node): an object literal `{ w: window }` evaluated at module scope throws `ReferenceError: window is not defined`; `{ get w() { return globalThis.window; } }` does not (it yields `undefined` under node). Repo-idiomatic's verifier measured the real consequence — a probe test importing its refactored `./loop` under vitest's default `node` environment **died on import** — and origin/main's `loop.ts` has no such problem because it touches `window` only *inside* `startGame`.

**The fix, stated explicitly: `createBrowserDeps` is a `function`, not an exported `const`.** Nothing in the module's top-level evaluation touches the global. Belt and braces, inside the function body the host is read as `globalThis.window` rather than as the bare identifier, so a mis-call under node yields a typed `undefined` at the use site instead of a `ReferenceError` at import. **I compiled this**: a probe file returning `{ host: globalThis.window, raf: { request: (cb) => requestAnimationFrame(cb), cancel: (h) => cancelAnimationFrame(h) }, now: () => performance.now() }` against exactly the `HostWindow` and `RafScheduler` interfaces above gives `npx tsc --noEmit` **exit 0 with no output** (I read back the empty output, not just the exit code). Real `window` *is* assignable to `HostWindow` as declared.

#### Constraint (c): `startGameWith` must compile under `noUnusedParameters: true`

`tsconfig.json` sets both `noUnusedLocals` and `noUnusedParameters`. **Measured by me**: a throwaway `src/game/__probe_np.ts` with an unused parameter produces `error TS6133: 'canvas' is declared but its value is never read.` — the option is live.

The factory design resolves this **for free, and this is a second reason to prefer it over instance injection.** Inside `startGameWith`, both parameters are genuinely read: `deps.createRenderer(canvas, …)`, `deps.createInput(canvas, …)`, `deps.createHud(uiRoot)`. Minimal-surface, which injects finished instances, was *forced* to drop both parameters and ship `startGameWith(deps)` — it says so explicitly, citing `noUnusedParameters` — which is precisely why its `M-C-02`/`M-C-03`/`M-C-06` survive. I verified the positive case compiles: a probe `twoParams(canvas: HTMLCanvasElement, root: HTMLElement)` that reads both is `tsc`-clean.

### 2.4 Projected coverage, and what the three verifications disagreed about

**Projection, not a measurement.** Of the 65 catalog ids: ~56 killed by a test, 3 by `tsc` (`M-TS-14`, `M-TS-15` via TS6133; `M-C-05` via TS2554), and 6 not killed — `M-TS-06` (structurally dissolved, not killed), `M-TS-21`, `M-W-06`, `M-MT-13/14/15`. **The highest number any *built* design achieved is 59 of 65** (max-testability), and its verifier separately measured 12 of 14 new-seam mutations surviving it. Nobody has built the graft; treat the projection as a hypothesis to be swept, not a result.

Where the three disagreed:

| Question | Disagreement | Resolution here |
|---|---|---|
| Drain loop or `Math.floor`? | minimal-surface kept the loop + a `MAX_TICKS_PER_FRAME=240` guard, explicitly refusing `Math.floor` because it could only *sample* float parity; repo-idiomatic used `Math.floor` and sampled parity across 4 clock models | `Math.floor`, on my own wider 6-model re-measurement — **with the clamped-stall residual (`acc` differs by 4.86e-17) reported, which the original comparison did not surface** |
| Is `M-W-06` killable? | max-testability killed its analogue (`SETWORLD-ACC`); repo-idiomatic measured `RESET-ACC-DROP` **SURVIVING** and declined it as unreachable | Declined. `reset` is reachable only from win/lose, and the driver's non-simulating branch already zeroes `acc` on every such frame |
| `M-C-05`: test kill or compile error? | minimal-surface constructs the director inside `startGameWith` and kills it at the injected `engine.play` boundary; the other two make `playerId` required and kill it with TS2554 | Compile error — with the caveat that a compiler guard means no test pins it |
| `M-TS-20` | minimal-surface and repo-idiomatic both left it **SURVIVING** as equivalent | Killed — minimal-surface's own verifier measured that `prev === curr` asserted **after a real game ends mid-run** kills it, while the same assertion scoped to a title frame from boot does not |
| `M-MT-13` (`{once:true}`) | all three agree it is defensive, not load-bearing, for the collaborators that *could* be measured; `renderer.dispose()` double-call is unmeasured everywhere | Left unpinned. Do not write an idempotency test |

---

## 3. WHAT EACH TEST PINS

Legend: "catalog ids" are from the 65. Ids marked ° pin a contract but no player-visible defect (the mutation is documented equivalent) — kept because the assertion can still fail, flagged so nobody counts them as defect coverage.

### 3.1 `src/game/frame.test.ts` — pure, `environment: node`

| Test name | Kills | Production change that makes it fail |
|---|---|---|
| banks a short frame instead of ticking | (boundary guard) | `Math.ceil` in place of `Math.floor` — any dt > 0 would tick |
| ticks once when the accumulator reaches EXACTLY one step | M-TS-02 | `Math.floor(filled / DT - 1e-9)` — the floor-form of `>=`→`>`. Test comment must say this is a float boundary a browser clock essentially never hits (measured 20 of 3600 vsync frames, each recovered next frame) |
| runs the WHOLE debt on a slow frame, not one tick of it | M-TS-03 | `Math.min(1, Math.floor(filled / DT))` — permanent slow motion on any machine below 60 fps |
| carries the leftover into the next frame | M-TS-07 | `const rest = 0` |
| starts from the accumulator it is given | M-TS-04 (frame half of M-TS-01, M-TS-13) | `const filled = acc + 0 * dt` |
| leaves the accumulator strictly below one step, at every dt tried | (the invariant M-TS-16 exploits) | `const rest = filled` |
| caps a long stall at MAX_FRAME_DT worth of ticks | M-TS-08, M-TS-10 | clamp `0.25 → 2.5`, or deleted: a 2 s frame runs 120 ticks instead of 15 |
| is a ceiling, not a floor: an ordinary frame passes through untouched | M-TS-11 | `dtReal < MAX_FRAME_DT ? MAX_FRAME_DT : dtReal` — 15 ticks every frame |
| does not clamp below one step | M-TS-09 | clamp `0.25 → 0.005` — 18 ticks/s at 60 Hz |
| cannot be walked backwards by a non-monotonic clock | M-TS-13 | drop the `dtReal < 0 ? 0` arm — acc walks negative and never ticks again |
| renderAlpha is the fraction of a step the leftover fills | M-TS-16 | `DT / acc` → `Infinity` at acc 0. **`tsc` catches M-TS-14/M-TS-15 (TS6133) before they reach here; this test is that guard's negative control** |
| renderAlpha is 1 when not simulating | M-TS-17° | `: 1` → `: 0`. Alone this is equivalent (`lerp(a,a,t) === a`); it is the cheap half of the observable M-TS-17+20 pair |

### 3.2 `src/game/driver.test.ts` — fake rAF + fake clock, **real `step`**, `environment: node`

| Test name | Kills | Production change that makes it fail |
|---|---|---|
| steps the sim on a playing frame | M-TS-01, M-TS-04, M-TS-13 (one shared observable) | `for (let i = 0; i < 0 && i < plan.ticks; i++)` — the frozen-arena hole, green on the full gate today |
| runs the whole tick debt of a slow frame | M-TS-03 (composed) | cap the drain at one tick per frame. Must drive dt > DT; a steady-60 Hz test cannot see it |
| does not step while not playing, but still renders | (state gate; no catalog id) | `if (true)` in place of the `state === 'playing'` gate |
| reports the live world once per simulating frame | (no catalog id) | delete `deps.onSimulated(curr)` — lives and enemies-remaining freeze for the whole game |
| hands the director the player shell it just fired, with its position | (routing; no catalog id) | delete `deps.director.handle(frameEvents)`. **Discriminated by `ownerId` and `pos`, never by presence** |
| feeds terminal events to the state machine | (routing; no catalog id) | delete `deps.stateMachine.onEvents(frameEvents)` — the sim wins and the HUD never hears it |
| passes this frame's events to the renderer, and an empty list when there were none | (particles feed) | pass a stale or empty array to `renderer.render` |
| renders FROM the pre-tick pose TO the post-tick pose | M-TS-18, M-TS-19, M-TS-22 | `prev = curr` deleted from the drain; or moved after `curr = result.world`; or `render(curr, prev, …)`. **All three type-check.** M-TS-19 leaves alpha correct — alpha coverage alone leaves it alive |
| advances prev with curr across frames, one tick apart | M-TS-18 (across frames) | prev frozen at the spawn pose |
| renders at the fraction of a tick the accumulator is holding | M-TS-16 at the renderer boundary | alpha wired to 0/1/`DT/acc`. **Assert the alpha argument, not an entity position** (`entities.ts:227` clamps to [0,1]) |
| renders curr's pose after a game ends mid-run | the M-TS-17+M-TS-20 **pair** — one kill, not two | both else-branch halves. Asserts `alpha === 1` **and** `prev === curr` on a frame reached by actually playing then winning. Scoping this to a title frame from boot makes the `prev === curr` half unfalsifiable — measured |
| renders the frame that ENDS the game at a full alpha | the double-read hazard (no catalog id) | hoist `const isPlaying` **and use it at both reads**. The one-site form must stay as a control: it survives, correctly |
| passes the CLAMPED real dt to the renderer | M-TS-23, driver half of M-TS-08/M-TS-10 | pass `0` — every explosion freezes at its spawn point forever and the pool never recycles (`particles.ts:115`) |
| schedules nothing until start(), then schedules the first frame | M-LC-03 (driver half) | drop the initial kick. `noUnusedLocals` does **not** catch it — the recursive reschedule counts as a read |
| reschedules itself, so there is a second frame and a third | M-LC-02 | drop the in-frame `raf.request` — the loop runs exactly one frame forever |
| cancels the handle it issued MOST RECENTLY, not a stale one | M-LC-04b, M-LC-05 | `raf.cancel` dropped, or the handle never reassigned inside the frame. **A render-count-after-dispose test kills neither** |
| does nothing when an already-queued callback fires after stop() | M-LC-01b, M-LC-06 | drop `running = false`, or neutralise `if (!running) return`. Requires the fake rAF to hand the callback back so the test can invoke it by hand |
| reset() simulates the world it was handed, not the one that finished | M-W-07 (driver half) | `reset` not replacing `curr`. **Also the test that fails if `Driver.world` is a plain property instead of a getter** — constraint (b) |

### 3.3 `src/game/loop.test.ts` — `// @vitest-environment jsdom`, fake collaborators via `startGameWith`

| Test name | Kills | Production change that makes it fail |
|---|---|---|
| sizes the renderer with arena width, height and cell size, in that order | M-C-02, M-C-03 | transpose width/height (ARENA_01 is 22×18 world units, so the board sits off-centre with walls hanging off the felt), or pass 0 for the boundary. Both `number`; `tsc` blind. Guard against vacuity by asserting `width !== height` first |
| aims through screenToGround with clientX then clientY | M-C-06 | `screenToGround(y, x)`. Assert with distinct values (13/71); equal arguments would be a tautology |
| gives the audio director the PLAYER tank's id | M-C-04 | `t.kind !== 'player'`. Assert against the created world's actual player id **and** that it is not 0 (the director's fallback). M-C-05 is TS2554, not a test kill |
| seeds each world from the wall clock, so two sessions differ | M-C-01 | `deriveSeed(deps.wallMs())` → `1`. Needs the injected wall clock; nothing else can see it |
| deriveSeed maps distinct readings to distinct seeds | M-C-01 (unit) | `() => 1`, or dropping the xor mix. **No "never returns 0" assertion** — `nextRng` adds `0x6d2b79f5` before mixing, so 0 is not degenerate and that assertion would pin nothing |
| the Start button actually starts the game | M-W-15, M-W-05 (title half) | empty the title branch (highest-value construction kill), or invert `sm.state === 'title'` — the game then starts on a second world the title screen never showed. Also assert exactly one world was built |
| the Mute button toggles the engine and reports the engine's answer back | M-W-01, M-W-13, one leg of M-W-03 | delete the `onMuteToggle` registration, or drop `hud.setMuted(...)` — "a muted game and a broken game look identical" |
| the volume slider reaches setVolume, and nothing else does | M-W-02, one leg of M-W-03 | delete the `onVolumeChange` registration |
| start/restart does not touch mute or volume | M-W-03 | permute the three HUD registrations. **`tsc` is structurally blind**: all three are `(cb: () => void) => void` |
| unlocks the audio context from the start click | M-W-04 | delete `audio.unlock()`. No audible difference today (`public/audio/` ships only `.gitkeep`); the observable is the engine call |
| subscribes the HUD to state changes | M-W-09, M-W-10° | delete the `sm.onChange` registration — the sim runs under a permanent title overlay and no win/lose screen appears |
| starts the music when play begins, and not before | M-W-08 | delete `if (s === 'playing') audio.startMusic()` |
| Play Again simulates a FRESH world, not the one that just ended | M-W-07, M-W-05 (terminal half) | `resetWorld` no longer building a world. **Assert world identity / tick, never `curr.status`** — see rejected list |
| reports lives and enemies to their own setters once the counts diverge | M-W-12, M-W-11° | swap the two setters; or delete the initial `updateHudStats`. Requires the **asymmetric** injected world (3 lives, 2 live enemies) — at 3/3 the swap is invisible |
| registers the M hotkey and the resize handler | M-L-03, M-L-05 | delete either `addEventListener`; both survive `noUnusedLocals` today because `dispose` still references the handlers |
| isMuteHotkey ignores auto-repeat | M-L-01 | drop `if (e.repeat) return` — holding M toggles ~30×/s and lands on the repeat count's parity |
| isMuteHotkey ignores keys aimed at a focused control | M-L-02 | drop the `closest('input,button,select,textarea')` guard. Ranked last; the reachable case is narrow today |
| resizes the renderer with width then height | M-L-06, M-L-03 | `resize(innerHeight, innerWidth)` — inverted `camera.aspect` at boot and on every resize. Use a 1024×768 fake host; a square host makes it a tautology |
| dispose releases every collaborator it built | M-LC-09, M-LC-10, M-LC-11, M-LC-12 | delete any one of `input`/`renderer`/`audio`/`hud` `.dispose()`. **The fake renderer's `dispose` must record the call** — minimal-surface measured M-LC-10 surviving because its fake's dispose was a no-op stub |
| removes the EXACT keydown and resize listeners it added | M-LC-07, M-LC-08 | delete either `removeEventListener`. Compare `(type, fn)` identity: a "called twice" count survives swapping which one is dropped |
| dispose stops the frame loop | M-LC-16 (precondition) | delete `driver.stop()` from dispose — the rAF chain renders into a disposed WebGL context for the life of the tab |
| kicks the rAF loop synchronously during startGame | M-LC-03 (loop half) | delete `driver.start()` — the canvas stays at its clear colour under a working-looking HUD |

### 3.4 `src/game/loop.test.ts` — **COMPOSITION: the seam the refactor creates**

**This is not a footnote.** It is CLAUDE.md's documented failure — *"unit files call sim stages directly, so they cannot see composition"* — reappearing at a new seam. `driver.test.ts` injects fake hooks, so **it cannot see whether `loop.ts` wires the real collaborators into them.** The adapter literal `loop.ts` passes to `createDriver` is production code that no unit test in either file executes. Measured on a built prototype: **12 of 14 mutations of that adapter survived a suite of 60 tests that killed 59 of 65 catalog ids** (population: the 14 the verifier wrote; not an exhaustive enumeration). One of them — `isSimulating: () => false` — is the exact analogue of `while (false && acc >= DT)`: frozen arena, dead HUD, no audio, no particles, full gate green.

The fix is four tests that pump the **injected clock's captured rAF callback through the real `startGameWith`**, with the real `step` and real `createGameStateMachine`, asserting at the *fake collaborator* boundary.

| Test name | Kills (new-seam, no catalog ids) | Production change that makes it fail |
|---|---|---|
| Start, then N frames of the injected clock, advances the REAL world by whole ticks | `isSimulating` inverted; `isSimulating: () => false` | `isSimulating: () => false` in loop.ts's adapter, or `() => sm.state !== 'playing'`. The world's tick stays 0 instead of advancing by `floor(elapsed/DT)` |
| each tick gets a freshly sampled input from the injected controller | `sampleInput` constant | `sampleInput: () => NEUTRAL_INPUT` — the game ignores the player entirely. Assert the fake's sample **count equals the tick count**, not merely > 0 |
| the events those ticks produced reach BOTH the audio director and the state machine | director routing dropped; `sm.onEvents` dropped | drop either target from the `routeEvents` adapter. Compare the ordered arrays each sink received against the events read off the fake renderer, discriminated by `ownerId` |
| the renderer the loop built receives prev one tick behind curr, with the live alpha and dt | render body emptied; render args swapped | `render: () => {}` in the adapter, or transposing prev/curr there. Reintroduces M-TS-22 one layer up, where `driver.test.ts` cannot see it |

**Reported disagreement on the seventh.** The task brief states all seven flipped to KILLED with four composition tests. The one built measurement I have says otherwise: after that verifier added six composition tests, `LOOP-ONSIM-NO-HUD` — *delete `updateHudStats(world)` from the `onSimulated` hook* — **survived all 571 tests**, and it is player-visible (lives and enemies-remaining never change during play). So a **fifth** test is required, and until it is built and that mutation re-run, the seventh must be treated as open:

| Test name | Kills | Production change that makes it fail |
|---|---|---|
| the HUD's counters follow the world under real frames | `updateHudStats` dropped from `onSimulated` | delete `updateHudStats(world)` from the adapter. Must pump frames until a count **changes** (a kill or a death) and assert the fake HUD's setter log — a startup-only assertion is the M-W-11/M-W-12 tautology again |

### 3.5 `src/game/loop.test.ts` — the `main.ts` seam

Covered in section 4; the three tests are "throws synchronously when there is no WebGL", "leaks no window listener, no document listener and no DOM when construction fails", and "startGame delegates to startGameWith with the real browser dependencies".

### 3.6 Rejected as unfalsifiable

Each of these appeared in a proposed plan; each was **measured** to pass under the mutation it claimed to pin, and no production change breaks it as scoped.

1. **`expect(px + (cx - px) * call.alpha).toBeCloseTo(cx, 12)`** in "renders curr's pose while not simulating" (repo-idiomatic). In a rig whose world was never stepped, `prev` and `curr` are the same object, so `px === cx` and the identity holds for **every** alpha including 0. Measured: the test fails only on its `alpha === 1` clause, and deleting the lerp clause left the pair still killed. **No production change breaks it.**
2. **`expect(call.prev).toBe(call.curr)` scoped to a title-screen frame from boot** (minimal-surface). Measured: "PROBE prev===curr only (title from boot)" **SURVIVED** M-TS-20; the mid-run variant killed it. Rejected in that scoping only — §3.2 keeps the mid-run form.
3. **Play Again asserted via `curr.status`.** Measured: "PROBE status-only assertion" **SURVIVED** a mutation where the fresh world is built but never handed to the driver, because against an already-won fixture the fresh world instantly wins too. Rejected; §3.3 asserts world identity/tick instead.
4. **"Lives shows 3 / Enemies shows 3" after `startGame` against the real HUD.** Tautology against both the fixture (measured lives = 3, 3 alive enemies) and the hardcoded markup (`hud.ts:23-24`); passes with the initial `updateHudStats` deleted **and** with the two setters swapped.
5. **"The title panel is visible after `startGame`" against the real HUD.** `createHud` self-calls `setState('title')` at `hud.ts:105` and the machine starts at `'title'`, so it passes with `loop.ts`'s call deleted. (Against an injected fake HUD it *is* falsifiable — that is the M-W-10° annotation — but it then pins a contract, not a defect.)
6. **"`renderer.resize` was called once during `startGame`"** as a pin for M-L-04. `createScene` already sizes itself at construction (`scene.ts:112-115`), so this pins a redundant call; the mutant is near-equivalent and arguably the more correct of the two.
7. **"`dispose()` is idempotent."** Not unfalsifiable — **unverified**. Double-dispose was measured safe for `input`, `hud` and `audio`, but `renderer.dispose()` could not be measured at all (`createRenderer` cannot be constructed under jsdom). Writing it would assert something nobody has checked.

**Killable but pinning no player-visible defect — deliberately declined:** dedicated assertions for M-TS-21 (idle `acc = 0`; unreachable on the shipped paths) and M-W-06 / `RESET-ACC-DROP` (defence-in-depth only). Both are expected to remain survivors, and that is the honest outcome rather than decorative coverage. M-TS-02 is pinned but its test must carry the comment that it asserts a float boundary a real clock essentially never lands on.

---

## 4. THE MAIN.TS CONSTRAINT

### 4.1 What must be preserved

`src/main.ts` does not change — not one byte. All three prototypes measured `git diff --stat origin/main -- src/main.ts` **empty** after their refactor, with `git status --porcelain` listing `src/game/loop.ts` as the only modified tracked file. `startGame(canvas, uiRoot): { dispose(): void }` keeps its exact signature, so `main.ts:11` and `main.ts:14` compile unchanged.

The property `main.ts` depends on is narrow and load-bearing: **a `WebGLRenderer` constructed without WebGL support throws, and `main.ts`'s only failure detector is a synchronous `try`/`catch` around `startGame`.** If that throw is deferred by so much as a microtask, the visitor gets the bare page background and the reason only in devtools — indistinguishable from a broken deploy, which is exactly what the comment at `main.ts:6-9` says the block exists to prevent.

Four constraints, each **measured** by the lifecycle slice's probes rather than argued:

1. **`createRenderer` must be called synchronously inside the same call `main.ts` wraps.** With construction deferred into a later `start()`, a `main.ts`-shaped try/catch reports `catch fired at construction = false` and the throw escapes to the later call; deferred into `requestAnimationFrame`, `outer catch fired = false`. Measured twice, in two deferral shapes.
2. **`createRenderer` must stay the FIRST collaborator constructed.** Instrumented add/removeEventListener counts: shipped order (renderer first) → threw = true, **0** leaked window listeners, **0** leaked document listeners, `root.childElementCount = 1` (the canvas, which `main.ts`'s `root.innerHTML = ''` clears). Renderer last → threw = true, **4** leaked window listeners, **3** leaked document listeners, `childElementCount = 2`, all unreachable because `startGame` never returned a dispose handle.
3. **`startGame` must keep throwing, not return an error result.**
4. **The dep set must be complete and non-optional.** `createAudioEngine` **is** constructible under jsdom (measured), so a test that forgot a dep would fall through to real `howler` without failing loudly.

### 4.2 What preserves it in this design

`startGame`'s entire body is `return startGameWith(canvas, uiRoot, createBrowserDeps());` — an ordinary synchronous call, so a throw propagates straight out into `main.ts`'s catch. `createBrowserDeps()` **constructs nothing**: it returns an object literal of function references plus arrow-wrapped clock/rAF/host accessors. No renderer, no `AudioContext`, no listener, no DOM node exists when it returns — and, per constraint (a), it touches no global at module-evaluation time either. Inside `startGameWith`, `deps.createRenderer(...)` is the first statement after computing arena bounds, at the function's top level, before every other factory, before any `addEventListener`, and before `driver.start()` (which only issues `raf.request`; `createDriver` schedules nothing).

### 4.3 How it is verified

Three tests under `// @vitest-environment jsdom`, calling the **real** `startGame`, plus two negative controls:

- **Positive control.** `expect(canvas.getContext('webgl2')).toBeNull()` passes, so the environment genuinely is a no-WebGL browser; `expect(() => startGame(canvas, root)).toThrow()` passes, with `THREE.WebGLRenderer: Error creating WebGL context.` in captured stderr. Because a synchronous `try`/`catch` is the mechanism that catches it, "synchronously, in the caller frame" is established by the test's own mechanism rather than asserted separately. Measured in all three prototypes independently.
- **Negative control for deferral.** `M-DEFER-LAZY`: wrap the entire construction in `queueMicrotask` and return a lazy dispose. Measured **KILLED** — it fails both the throws test and the leak test.
- **Negative control for ordering.** `M-ORDER-RENDERER-LAST`: move `createAudio`/`createHud` above `createRenderer`. Measured **KILLED**, against a test asserting 0 window listeners added, 0 document listeners added, and `root.childElementCount === 0` after the throw.

**Two corrections to the proposals, from verification — reported rather than smoothed:**

1. Minimal-surface's stated negative control for the throws test was `M-STARTGAME-DEFER` (only `createRenderer` deferred, with a definite-assignment `!`). Its verifier measured that test at **kill-count 0 across all 68 mutations**: the mutation is killed by the *leak* test instead, because the deferred `renderer` is still dereferenced by `onResize`, so `startGame` throws a `TypeError` anyway. The throws test **is** falsifiable — `M-DEFER-LAZY` kills it — but its published proof was mis-attributed. Use `M-DEFER-LAZY`.
2. The first version of the ordering test wrapped only `window.addEventListener` and the mutation **SURVIVED**: the leaking registrations from `createAudioEngine`/`createHud` land on `document` and on the DOM, not on `window`. The `document` half and the `childElementCount` check are load-bearing, not decorative. That is a measured correction, not a prediction.

`tsc` gives no help on any of this — `M-DEFER-LAZY` and `M-STARTGAME-DEFER` both type-check cleanly (definite assignment satisfies the compiler), so these tests are the only thing standing between a plausible refactor and the silent deletion of the no-WebGL error page.

### 4.4 Residuals, stated plainly

- **`main.ts`'s own body remains untested.** `M-MT-13` (`{once:true}` dropped), `M-MT-14` (try/catch removed) and `M-MT-15` (the whole `pagehide` registration dropped — which reverts `main.ts` to the exact state its own comment records as a shipped bug) are **unpinned** by all three designs and by this one. Closing them requires `main.ts` to become importable; it runs at module scope against `document.getElementById('app')`, and that change is outside the approved architecture.
- **The `createBrowserDeps` literal is a second unpinned seam.** Only `createRenderer` and `createWorld` are ever executed by any test — the throw comes out of the first factory, so nothing downstream is reached. A swap of `createInput` ↔ `createHud` inside that object survives every test proposed here. The refactor concentrates the untestable surface into ~20 lines instead of leaving it spread across 156; it does not eliminate it. Closing it needs a headless GL context in CI, which this repo does not have.
- **`vite build` and the bundle-portability CI step were never run** by any slice or by me. Nothing in sections 1–4 speaks to whether a non-test `.ts` helper under `src/` reaches the bundle.

---

## 5. RESIDUAL

### 5A. Will not pin — judged equivalent, unreachable, or contract-only

Each with the evidence that justifies the refusal. Writing a test for any of these would be the decorative coverage CLAUDE.md forbids.

| Id | Why not pinned | Evidence |
|---|---|---|
| `M-TS-21` (idle-branch `acc = 0`) | Unreachable in the shipped flow: entry to 'playing' is title→`startPlaying` (acc already 0) or win/lose→`reset()` (which zeroes it), and the leftover is `< DT` regardless | Source-reading argument by the timestep enumerator, **not executed**; repo-idiomatic's verifier applied it and measured **SURVIVED** |
| `M-W-06` / `RESET-ACC-DROP` | Same shape: `reset` is reachable only from win/lose, and every non-simulating frame already zeroes `acc` | repo-idiomatic verifier measured **SURVIVED**; deliberate |
| `M-W-10` (initial `hud.setState`) | `createHud` self-calls `setState('title')` at `hud.ts:105`, and the machine starts at 'title' | Equivalent per the construction enumerator; repo-idiomatic verifier measured **SURVIVED** |
| `M-W-11` (initial `updateHudStats`) | HUD markup hardcodes "Lives: 3"/"Enemies: 3" and the fixture is 3/3 | Enumerator: "NONE OBSERVABLE at startup". minimal-surface's kill was measured real *only* against a `lives = 2` fixture |
| `M-L-04` (initial `onResize()`) | `createScene` self-sizes at `scene.ts:112-115`; the mutant is arguably the more correct of the two | Near-equivalent per the listener enumerator. **Contested** — see §3; L18 is shaped to leave it alive |
| `M-C-05` | Compile error under the required `playerId` | `error TS2554: Expected 2 arguments, but got 1`, measured in two worktrees. Counted as a compiler kill, never a test kill |
| `M-TS-06` | Structurally inexpressible: no drain decrement exists to delete | repo-idiomatic verifier grepped for `while`/in-loop decrement (zero hits) and applied the nearest analogue → **KILLED in 2 s, no hang**. The inexpressibility itself is a **claim about the shape of the code, not a measurement** |
| `M-W-14` | Pre-refactor it was the one mutation `tsc` caught, via `noUnusedLocals` on `resetWorld`. **Post-refactor status unswept** — no agent applied it after the refactor, and that guard is incidental (it evaporates the moment `resetWorld` gains a second caller; `M-W-15` already evades it) | Stated, not measured |
| `M-TS-02` | Pinned, but as **arithmetic**, not as a defect: measured tick counts identical to baseline over 3600 frames on four clock models (3600/3600, 3599/3599, 3599/3599, 1500/1500), with `acc === DT` hit on 20 of 3600 vsync frames and recovered next frame. The test comment must say so |
| `M-TS-20` alone | **Contested.** Expect the kill with the non-degenerate fixture; if it survives, it moves here and is reported as residual rather than claimed |

### 5B. Should pin — out of scope for this change

| What | Why it survives | What closing it needs |
|---|---|---|
| `M-MT-13`, `M-MT-14`, `M-MT-15` | `main.ts` runs at module scope against `document.getElementById('app')`; unimportable, no test file | `main.ts` taking an injected root and a `startGame` reference. Explicitly outside the approved architecture |
| The `browserDeps()` object literal | Only `createWorld` (via `deriveSeed` + `vi.setSystemTime`) and the throw path are reachable from a test; which factory each other field holds, and the bodies of `now`, `raf` and `window`, are exercised only through `startGame`, which cannot get past `createRenderer` without a GPU. A swap of two same-shaped factories inside it would survive | A headless GL context in CI, which this repo does not have. **This is reasoned, not measured** — nobody applied a factory-swap mutation. The refactor concentrates the untestable surface into ~20 lines instead of spreading it across 156; it does not eliminate it |
| `renderer.dispose()` idempotency (double-call) | `createRenderer` cannot be constructed under jsdom, so three's `WebGLRenderer` teardown is the one collaborator whose idempotency was never measured | Same GL-context gap. **Do not assert `dispose()` is idempotent** until it is closed — the double-dispose probe covered `input`, `hud`, `audio` only (each "OK (no throw)") |
| `dispose()` call **ordering** | 6 calls, 15 adjacent-swap pairs, **0 applied by anyone** | A sweep, plus a decision about whether order is load-bearing at all |
| Order of `director.handle` vs `sm.onEvents` | Deletions swept (post-refactor); the swap never applied | One mutation; probably equivalent, but unswept means unknown |
| Compound mutations generally | Every sweep was single-edit except `M-LC-16` and `M-W-03`. The class is non-empty by construction (`M-TS-17`+`M-TS-20`) | A compound sweep, whose population needs defining before it means anything |
| `vite build` / bundle portability | **No agent ran it.** In particular, `src/game/fakes.test-support.ts` is a non-`.test` file under `src/` that `tsconfig` typechecks and nothing in the production graph imports; how the bundler treats it is unverified | §6 step 8 |
| Everything a player would actually see | **No agent opened a browser.** All tick-rate and alpha figures come from standalone node replicas of `loop.ts:108-139`; all particle and interpolation behaviour is read from `particles.ts:112-123` and `entities.ts:121-234` | Manual play, or a screenshot harness |

### 5C. Behaviour no design attempted

- **`input.sample()` cadence** is pinned only implicitly (the drain calls it per tick). max-testability proposed a dedicated test; this design folds it into "steps the sim on a playing frame" by asserting the sample count. If the implementer cannot make that assertion fail, split it out rather than leaving it decorative.
- **`frameEvents.push` placement** (inside vs outside the drain) and the `frameEvents.length > 0` guard: enumerated only *after* the refactor, by one design agent, never against shipped `loop.ts`.
- **The AI-coupling trap.** minimal-surface's director test drove 450 real ticks with the player firing and needed two explicit degeneracy guards, because a count-based first version measured `3 === 3` and could not discriminate. This design instead uses a hand-built fixture (a player shell one tick from contact), so the test is hermetic. If the implementer reaches for a long AI run, they inherit the coupling and must carry the guards.

---

## 6. IMPLEMENTATION ORDER

Each numbered step is: **apply the mutation, watch it survive (or hang, or fail wrongly), write the test, watch the mutation die.** Never write a test whose target mutation has not first been observed surviving — CLAUDE.md's "prove the gap before writing the test", and three separate verifications each caught at least one assertion that would have shipped decorative had this order been skipped.

**Step 0 — baseline and the equivalence harness.**
Re-measure `npx tsc --noEmit` (expect exit 0) and `npx vitest run --reporter=dot` (expect 34 files / 511 tests at `97cb2c6`). Then write the standalone comparison of `planFrame`'s closed form against the shipped `while (acc >= DT) acc -= DT` over the four clock models × 3600 frames and the four stall values, and **read back its output** — the claim to be reproduced is `framesDiffering=0, maxAccDelta=0, maxAlphaDelta=0`. Keep the script and its output in the branch as evidence, not as a test. If it does not reproduce, stop and fall back to the subtraction loop plus `MAX_TICKS_PER_FRAME = 240` (minimal-surface's shape, which its own verifier measured turns `M-TS-06` into a 0.4 s failure rather than a hang).

**Step 1 — the main.ts contract, written FIRST, against the unmodified loop.ts.**
L23 and L25 need only the real `startGame`, whose signature is unchanged, so they can be written before any refactor and must stay green through all of it. Write them, watch them pass, and confirm the captured stderr really says `THREE.WebGLRenderer: Error creating WebGL context.` — if it does not, the environment is not the no-WebGL browser the test assumes and the test proves nothing. (L24 needs `factoryOrder`, so it waits for step 5.)

**Step 2 — `frame.ts`.**
In order: `Math.min(1, …)` (survives — nothing imports frame.ts yet) → write "runs the WHOLE debt" → dies. Then `rest = 0` → `M-TS-07`. Then `acc + dt*2` → `M-TS-04`/`M-TS-05`. Then `alpha: 0`, `alpha: 1`, `alpha: DT/rest` → the alpha test; confirm each is killed by the **test** and not by `tsc`, and if `tsc` fires first, rewrite the mutation to the tsc-evading form before believing the kill. Then clamp → 2.5, clamp deleted, ceiling→floor, clamp → 0.005 → the four clamp tests. Then `Math.floor(filled/DT - 1e-9)` → `M-TS-02`, with the "a real clock essentially never lands here" comment. Then drop the `< 0` arm → the non-monotonic test.

**Step 3 — `driver.ts`, the advance and interpolation half.**
`for (let i = 0; i < 0 && …)` first — the canonical hole — watch it survive the whole suite including everything from step 2, then write "steps the sim on a playing frame" and watch it die. This is the single most important survive-then-die observation in the plan. Then, one at a time: delete `last = now` (`M-TS-12`); `if (true)` for the gate; delete `prev = curr` from the drain, move it after the step, swap the render args (`M-TS-18`/`19`/`22`); alpha at the renderer boundary — **assert the alpha argument, never a rendered position** (`entities.ts:227` clamps, re-measured here); `plan.dt` → `0` (`M-TS-23`).

**Step 4 — `driver.ts`, the routing, lifecycle and reset half.**
Delete `director.handle`, then `sm.onEvents`, then `onSimulated` — each individually, each watched surviving before its test is written; `onSimulated` is the one minimal-surface's suite measured SURVIVING, so do not skip it. Then the two shutdown assertions, and check the split holds: neutralise the `running` guard and confirm the *cancelled-id* test does **not** catch it, then leave `handle` stale and confirm the *after-stop* test does **not** catch it. If either test catches both mutations, one of them is doing less than it appears. Then the hoisted-`isPlaying` mutation → "renders the frame that ENDS the game at a full alpha". Then `reset` stops assigning `curr`.

**Step 5 — `loop.ts` rewrite behind `startGameWith`, then wiring.**
Rewrite, confirm `tsc` clean and step 1's tests still green, then work down the enumerator's ranking: `M-W-15` → L01; `M-W-09` → L05; `M-W-07` → L08; `M-W-05` → L07/L08; `M-W-03` (permute the three same-shaped HUD channels — `tsc` is structurally blind to the whole family) → L02/L03; `M-W-01`, `M-W-02`, `M-W-13`, `M-W-08`, `M-W-04`.

**Step 6 — construction and listeners.**
`M-C-02`, `M-C-03`, `M-C-06`, `M-C-04` (and confirm `M-C-05` is `TS2554`, not a test kill); `M-C-01` via `vi.setSystemTime` plus the `deriveSeed` unit; `M-L-03`, `M-L-05`, `M-L-06` (through the recorded listener — then apply `M-L-04` and **confirm it survives**, since the whole point of that construction is to leave it alive), `M-L-01`, `M-L-02`; then drop `hud.setMuted` from `onKey` and confirm L16 catches it. Then `M-LC-07`/`M-LC-08` by identity, `M-LC-09..12` one at a time (give the fake renderer a real recording `dispose`, or `M-LC-10` will appear killed when it is not — measured), `M-LC-03` loop half, `driver.stop()` deletion. Finally L24 with `factoryOrder`.

**Step 7 — the two contested and the two composition items.**
Apply `M-TS-20` alone against the non-degenerate fixture. If it dies, say so with the fixture named. **If it survives, move it to §5A and do not claim it** — three agents disagreed here and the fixture is the whole difference. Then L09: pump a frame past a kill, apply the setter swap and the empty `onSimulated` body, confirm both die.

**Step 8 — the gate, re-measured rather than relayed.**
`npx tsc --noEmit` (exit 0, no output); `npx vitest run --reporter=dot` (511 + new, no pre-existing test modified); `npm run build` — **nobody has run this** — and inspect whether `fakes.test-support.ts` reaches the bundle; `git diff --stat origin/main -- src/main.ts` (must be empty); `git status --porcelain` (only `src/game/loop.ts` modified, plus the new files). Then a final full mutation sweep with its own harness, restoring and byte-comparing the file after every run, and report the result **with its denominator and its unswept classes** — the numbers in §3 are a projection, and the PR body must carry the measured ones instead.
