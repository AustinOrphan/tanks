---
status: completed
date: 2026-08-21
last-reviewed: 2026-08-22
scope: VS setup UI, session boot flow, map selection, stock configuration, and HUD readout
implementation-issues: [228]
implementation-prs: [262]
supersedes: []
superseded-by: []
---

# Versus Setup Menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps
> use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Versus button on the title screen opening a setup pane (mode, players 2-4,
map incl. Random, stock, friendly fire, who's-playing), which on Start reboots the
session into a versus match; match end returns to the pane with selections intact; and
an in-match, identity-tinted, non-blocking per-player stock readout.

**Architecture:** The shipped design is one-value-per-session (`levels.ts:138-150`,
`loop.ts:636`), so the pane never mutates a running session: Start disposes the current
`GameHandle` and boots a new one through the existing `startGameWith(canvas, uiRoot,
deps)` seam, with deps derived for the chosen `VersusConfig`. A small versus-flavoured
`LevelSystem` serves the chosen arena (or a seeded random pick from the
`versusBoardCatalog`-passing set). The one deliberate sim change is a **defaulted**
stock parameter on `loadArena`/`createWorldFor`; the campaign path never passes it, so
`BASELINE_HASH` cannot move. The stock readout is a one-way HUD projection
(`setVersusStocks`) in the mold of `setVersusResults`.

**Tech Stack:** TypeScript, vitest, the existing hud/loop/boot seams. No new deps.

**Spec:** `docs/superpowers/specs/2026-08-21-versus-setup-menu-design.md` (owner rulings
§1, in-match readout §3a). Prior versus rulings: the six plan docs cited in §6 of the
2026-08-21 design-input digest; format order is stock-only here.

## Global Constraints

- **`src/sim/` changes limited to the defaulted stock init parameter** (Task 1). The
  golden trace gate must pass byte-identical: campaign-coop never passes the new param.
- Simulation stays authoritative; HUD/render consume state and `SimEvent[]` one-way.
  The stock readout reads `Tank.stockRemaining`; nothing feeds back.
- `src/main.ts` stays wiring-only. Reboot orchestration lives in `boot.ts` (testable
  with fakes); loop/hud reach it only through injected callbacks.
- Setup selections are session-state only — no new store, no persistence (same posture
  as controller assignment: "no seventh store").
- Established panel discipline: open/close callbacks fire once per actual transition;
  REPLACE-never-append row rendering; roving tabindex; every new class added to
  `hud.css.test.ts`'s pinned selector list and the pinned button count moved
  deliberately (currently `expect(buttons.length).toBe(58)` at `hud.css.test.ts:297`).
- Dev flags `?dev=1&mode=…&players=…` keep working unchanged. Retirement is decided
  per-flag in the PR body (ship-or-delete note), not silently.
- Every new assertion names the change that makes it fail; prove-the-gap before
  claiming a test closes anything. `npm test` + `npm run build` green at every commit;
  HUD-visible changes need screenshot evidence in the PR (`npm run visual` at the end).
- Branch `feat/versus-setup-menu` (spec committed at its tip). PR title = squash
  message; no attribution trailers.

## Verified interfaces this plan builds against

(Verified on `e8872eb`, 2026-08-21.)

- `startGameWith(canvas: HTMLCanvasElement, uiRoot: HTMLElement, deps: GameDeps):
  GameHandle` — `loop.ts:612`; `GameHandle = { dispose(): void }` — `loop.ts:229`;
  `GameDeps` — `loop.ts:103`; `createBrowserDeps(): GameDeps` — `loop.ts:569`.
- `boot(deps: BootDeps)` — `src/boot.ts`; `BootDeps = { root, bootCanvas, startGame:
  (canvas, uiRoot) => GameHandle, host, reportError }`; main.ts passes `startGame`
  (`loop.ts:608`, the createBrowserDeps wrapper).
- `createLevelSystem(flags, run)` — `levels.ts` (mode/friendlyFire/coopPool closed over
  at construction); `LevelSystem.world(level, seed, unarmedTrigger, lives, playerCount)`
  → `createWorldFor(arena, seed, unarmedTrigger, lives, corpseBlocksShells,
  muzzleClearsTanks, playerCount, coopAttempts, mode, friendlyFire)` — `arena.ts:411`.
- `loadArena(arena, playerCount = 1, mode = 'campaign-coop', seed?)` — `arena.ts:191`;
  stock stamped at `arena.ts:287` (P1) and `arena.ts:336` (co-players) from
  `VERSUS_STOCK` (`constants.ts:122`, sourced from `data/balance.json` `versusStock: 3`).
- `versusBoardCatalog(arenas = ARENA_DEFS, playerCounts = [2,3,4])` —
  `versus-board.ts:230`; `ARENAS`/`ARENA_DEFS`/`arenaById` — `arena.ts:33-43` (5 shipped
  arenas).
- Assignment: `deriveInitialAssignment(playerCount, botSlots)` — `assignment.ts:29`;
  `botAssignmentAllowed(mode, campaignBotsEnabled)` — `assignment.ts:88` (versus always
  allows bots); Controllers panel rows — `hud.ts:1131-1199` (`renderControllerRows`),
  click-to-assign via `onReassignSlot(slot, source)` (`hud.ts:274`).
- Panel template: `showControllers` — `hud.ts:1184-1199`; `setState` chokepoint closes
  all panes per transition — `hud.ts:1585-1601`; per-state button visibility toggles —
  e.g. `hud.ts:1645`.
- Results line: `setVersusResults(data | null)` — `hud.ts:164`; visible only win/lose —
  `hud.ts:1658-1660`; loop dispatch — `loop.ts:1189-1191`.
- Identity colours: `IDENTITY_RING_COLORS` — `entities.ts:76`; `TEAM_COLORS` —
  `entities.ts:98`; `teamOf(slot) = slot % 2` (versus-modes plan).
- Test prior art: controller-panel block `hud.test.ts:1221` (transition-guarded
  open/close 1350, replace-rows 1311, heading branch 1323); pinned button count
  `hud.css.test.ts:297`; pinned selector list `hud.css.test.ts:190-230`.

## File structure

- `src/game/versus-config.ts` (new): `VersusConfig` type + `pickVersusArena` (random
  resolution) + `versusMapChoices` (catalog filter). Pure, node-testable.
- `src/game/levels.ts` (modify): `createVersusLevelSystem(config, run)` beside
  `createLevelSystem` — same `LevelSystem` shape, single arena, threads stock.
- `src/sim/arena.ts` (modify): defaulted `stock` param on `loadArena` + `createWorldFor`.
- `src/boot.ts` (modify): session manager — restartable session + `requestVersusSession`
  + retained `lastVersusConfig`.
- `src/game/loop.ts` (modify): wire hud pane callbacks, versus-session end-state flow,
  stock readout driver; `GameDeps` gains two optional fields (below).
- `src/game/hud.ts` + `hud.css` (modify): Versus title button, setup pane, stock
  readout element; new HUD interface methods.
- Tests beside each: `versus-config.test.ts` (new), `levels.test.ts`, `arena` coverage
  via `src/sim/versus-modes.test.ts` (follow its fixtures), `boot.test.ts`,
  `hud.test.ts`, `hud.css.test.ts`, `loop.test.ts`.

---

### Task 1: Sim — defaulted per-match stock

**Files:**
- Modify: `src/sim/arena.ts` (loadArena signature ~:191, stamping sites :287, :336;
  createWorldFor ~:411)
- Test: `src/sim/versus-modes.test.ts` (follow its existing ffa fixtures)

**Interfaces:**
- Produces: `loadArena(arena, playerCount = 1, mode = 'campaign-coop', seed?, stock:
  number = VERSUS_STOCK)`; `createWorldFor(arena, seed?, unarmedTrigger?, lives = LIVES,
  corpseBlocksShells?, muzzleClearsTanks?, playerCount = 1, coopAttempts?, mode?,
  friendlyFire?, stock?: number)` threading it. Trailing + defaulted, same precedent as
  `mode`/`seed` (the comment at arena.ts:194-206 is the pattern to extend).

- [ ] **Step 1: Write the failing test** (in `versus-modes.test.ts`, reusing its ffa
  world fixture shape):

```ts
it('a versus world built with an explicit stock stamps it on every player tank', () => {
  const w = createWorldFor(ARENA_01, 7, undefined, 3, undefined, undefined, 3, undefined, 'ffa', undefined, 5);
  const players = w.tanks.filter((t) => t.kind === 'player');
  expect(players.length).toBe(3);
  for (const t of players) expect(t.stockRemaining).toBe(5);
});
it('omitting stock keeps the shipped VERSUS_STOCK default — the defaulted-param negative control', () => {
  const w = createWorldFor(ARENA_01, 7, undefined, 3, undefined, undefined, 2, undefined, 'ffa');
  for (const t of w.tanks.filter((t) => t.kind === 'player')) {
    expect(t.stockRemaining).toBe(VERSUS_STOCK);
  }
});
// Fails if: the param is accepted but not threaded to BOTH stamping sites (P1 at
// pass 1a AND co-players at pass 1b) — the 3-player fixture covers both sites.
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/sim/versus-modes.test.ts`
  (compile error: argument count). 
- [ ] **Step 3: Implement** — add the trailing defaulted param to both functions;
  replace `VERSUS_STOCK` at arena.ts:287 and :336 with the param (default keeps the
  constant). Extend the arena.ts:194 doc-comment pattern with one sentence for `stock`.
- [ ] **Step 4: Verify pass + the sim gates** — `npx vitest run src/sim` green, then
  the golden trace: `npm test` green AND confirm the trace/baseline test passes
  untouched (name the test file in your report; do not regenerate any baseline).
- [ ] **Step 5: Commit** — `sim: loadArena/createWorldFor accept a defaulted per-match stock`

### Task 2: VersusConfig + versus level system

**Files:**
- Create: `src/game/versus-config.ts`
- Modify: `src/game/levels.ts`
- Test: `src/game/versus-config.test.ts` (new), `src/game/levels.test.ts`

**Interfaces:**
- Consumes: Task 1's `createWorldFor` 11-arg form; `versusBoardCatalog`, `ARENA_DEFS`,
  `arenaById`.
- Produces:

```ts
// versus-config.ts
export interface VersusConfig {
  mode: 'ffa' | 'teams';
  players: 2 | 3 | 4;
  /** Shipped arena id, or 'random' — resolved per match build, not per session. */
  arenaId: string | 'random';
  stock: number;           // 1..5, default VERSUS_STOCK
  friendlyFire: boolean;   // meaningful only for teams
}
/** Arena ids offerable at this player count: catalog entries passing all three
 *  versus-board criteria. Today that is all 5 at every N in 2..4 (15/15). */
export function versusMapChoices(players: number): string[];
/** Resolve 'random' to a concrete arena id using the provided seed (deterministic:
 *  same seed, same pick — no Math.random). Concrete ids pass through unchanged. */
export function pickVersusArena(config: VersusConfig, seed: number): string;

// levels.ts
export function createVersusLevelSystem(config: VersusConfig, run: RunStore): LevelSystem;
```

- [ ] **Step 1: Failing tests.** `versus-config.test.ts`: `versusMapChoices(2|3|4)`
  equals the catalog's passing ids (derive expected from `versusBoardCatalog` directly —
  and assert non-empty, the negative control for a broken filter); `pickVersusArena` is
  deterministic (same seed → same id), distributes (two different seeds that pick
  differently — find a pair by measurement and pin the literals), and passes concrete
  ids through. `levels.test.ts`: `createVersusLevelSystem` builds a world with the
  config's mode/players/stock on the chosen arena; with `arenaId:'random'`, two systems
  given different run-seeds can build different arenas (pin measured seed literals);
  stock/friendlyFire reach the world (`w.tanks[player].stockRemaining === config.stock`).
  Name in comments: each fails if the config field is dropped on the floor between
  `world()` and `createWorldFor`.
- [ ] **Step 2: Run to verify failure** (module missing / method missing).
- [ ] **Step 3: Implement.** `versusMapChoices` filters `versusBoardCatalog()` rows for
  the player count where all three booleans hold. `pickVersusArena` uses the seed via
  the sim's existing deterministic helper (grep `mulberry32` / `deriveSeed` in `src/` —
  reuse, don't hand-roll a new PRNG in game code). `createVersusLevelSystem`: a
  `LevelSystem` whose `start` is a single synthetic level, `bounds` reads the resolved
  arena (careful: for `'random'` the bounds of different picks differ — resolve the
  arena id ONCE per `world()` call from the seed it is handed, and have `bounds`
  resolve with the same seed the first build will use; document this coupling), and
  `world(level, seed, unarmedTrigger, lives, playerCount)` calls `createWorldFor(
  arenaById(pickVersusArena(config, seed)), seed, unarmedTrigger, lives, corpseBlock,
  muzzleInside, config.players, undefined, config.mode, config.friendlyFire,
  config.stock)` — copy the corpseBlock/muzzleInside sourcing from
  `createLevelSystem`'s own body so dev flags keep their meaning.
- [ ] **Step 4: Verify green** — `npx vitest run src/game/versus-config.test.ts src/game/levels.test.ts`, then `npm test`.
- [ ] **Step 5: Commit** — `feat(game): VersusConfig, map choices, and a versus level system`

### Task 3: Boot session manager

**Files:**
- Modify: `src/boot.ts`, `src/main.ts` (wiring only), `src/game/loop.ts` (GameDeps
  fields + createBrowserDeps override hook)
- Test: `src/boot.test.ts` (follow its existing fake-based style)

**Interfaces:**
- Consumes: `VersusConfig` (Task 2); `GameHandle.dispose()`.
- Produces:

```ts
// GameDeps additions (loop.ts:103), both optional so every existing test/caller compiles:
requestVersusSession?: (config: VersusConfig) => void; // boot-provided; hud Start calls it
initialVersusConfig?: VersusConfig | null;             // boot-provided; pane opens pre-filled

// boot.ts: BootDeps.startGame widens to
startGame: (canvas, uiRoot, versus?: { config: VersusConfig } | null) => GameHandle;
```

Boot keeps `let handle: GameHandle` and `let lastVersusConfig: VersusConfig | null`.
`requestVersusSession(config)`: `lastVersusConfig = config; handle.dispose();
handle = deps.startGame(canvas, uiRoot, { config })`. The pagehide teardown
disposes the CURRENT handle (read via closure, not a stale capture — this is the bug
the test below exists to catch). `main.ts` passes a wrapper that builds versus deps:
`(canvas, uiRoot, versus) => startGameWith(canvas, uiRoot, versusAwareDeps(versus))`
where `versusAwareDeps` = `createBrowserDeps()` with, when versus is present:
`levels: createVersusLevelSystem(versus.config, run)`, `devFlags` widened with
`{ mode: versus.config.mode, players: versus.config.players, friendlyFire:
versus.config.friendlyFire }`, `initialVersusConfig: versus.config`, and
`requestVersusSession` threaded from boot. Add a `versusAwareDeps` factory IN
`loop.ts` (exported, testable) rather than logic in main.ts.

- [ ] **Step 1: Failing tests** (`boot.test.ts`, fakes): requesting a versus session
  disposes the old handle exactly once and starts a new one with the config; a second
  request disposes the second handle (not the first — the stale-capture control);
  pagehide after a reboot disposes the CURRENT handle; `lastVersusConfig` is handed to
  the next session's start call. Comment each with the wiring mutation it kills.
- [ ] **Step 2: Verify failure.** — `npx vitest run src/boot.test.ts`
- [ ] **Step 3: Implement** boot manager + `versusAwareDeps` + main.ts one-line wrapper.
- [ ] **Step 4: Green**: boot + loop + full `npm test` (loop.test.ts must stay green —
  the new GameDeps fields are optional).
- [ ] **Step 5: Commit** — `feat(boot): restartable sessions — versus reboot seam with retained config`

### Task 4: HUD — the versus setup pane

**Files:**
- Modify: `src/game/hud.ts`, `src/game/hud.css`
- Test: `src/game/hud.test.ts`, `src/game/hud.css.test.ts`

**Interfaces:**
- Consumes: `VersusConfig`, `versusMapChoices`; the Controllers row machinery
  (`renderControllerRows`, `onReassignSlot`) for the who's-playing rows.
- Produces (on the HUD interface):

```ts
onVersusOpen(cb: () => void): void;                 // Versus title button clicked
onVersusStart(cb: (config: VersusConfig) => void): void; // Start clicked, pane's config
showVersusSetup(show: boolean, initial?: VersusConfig | null): void;
```

Pane content (rows, matching §3 of the spec): Mode FFA|Teams · Players 2|3|4 · Map
(`versusMapChoices(players)` + Random) · Stock 1-5 (default 3) · Friendly fire
(rendered only when Teams selected) · who's-playing rows (REUSE `renderControllerRows`
against the chosen player count — do not fork it; if its current signature assumes the
session's `playerCount`, parameterize it) · Start (`.hud-versus-start`) · Back
(`.hud-versus-back`). Pane-local state persists for the session; `showVersusSetup`
with `initial` seeds it. Changing Players re-filters Map and re-renders rows
(REPLACE-never-append). New classes: `.hud-versus-open`, `.hud-versus-setup`, plus
per-row classes — every one added to the pinned selector list, and the pinned button
count at `hud.css.test.ts:297` moved to its measured new value with the breakdown
comment updated (state the delta and why).

- [ ] **Step 1: Failing tests** (copy the controller-panel block shapes,
  `hud.test.ts:1221`): open/close callbacks fire once per actual transition; Versus
  button visible at `title` only; pane's Start fires `onVersusStart` with exactly the
  selections made (change mode→teams, players→3, map→second entry, stock→5, toggle
  friendly fire; assert the emitted config object); friendly-fire row absent under FFA,
  present under Teams; Players change re-renders map choices (REPLACE — assert row
  count, not appended duplicates); `showVersusSetup(true, initial)` pre-fills; roving
  tabindex reaches Start and Back. Each comment names the mutation it kills (e.g.
  emitting defaults instead of selections; appending rows).
- [ ] **Step 2: Verify failure.** — `npx vitest run src/game/hud.test.ts`
- [ ] **Step 3: Implement** pane + CSS following `showControllers`
  (hud.ts:1184-1199) and `setState`'s close-all discipline (hud.ts:1589-1601 — add the
  pane there). Then update `hud.css.test.ts` pinned lists/count.
- [ ] **Step 4: Green** — hud + hud.css suites, then `npm test`.
- [ ] **Step 5: Commit** — `feat(hud): versus setup pane — mode, players, map, stock, friendly fire, who's-playing`

### Task 5: Loop wiring — entry, start, and return-to-setup

**Files:**
- Modify: `src/game/loop.ts`
- Test: `src/game/loop.test.ts`

**Interfaces:**
- Consumes: Task 3's `requestVersusSession`/`initialVersusConfig` deps; Task 4's HUD
  methods.
- Produces: the shipped flow — title Versus button → pane; Start → dispose+reboot; in
  a versus session, match end (win/lose) offers return-to-setup which reopens the pane
  (no reboot until Start again).

Wiring in `startGameWith`: `hud.onVersusOpen(() => hud.showVersusSetup(true,
deps.initialVersusConfig ?? null))`; `hud.onVersusStart((config) =>
deps.requestVersusSession?.(config))`. For a versus session (`deps.initialVersusConfig`
present), the end-state UI path that today returns to title instead calls
`hud.showVersusSetup(true, deps.initialVersusConfig)` — find the existing win/lose →
title transition the versus results line shares (loop.ts:1189-1191 dispatch region and
the hud state machine around it) and branch on the session being versus. Dev-flag
sessions (`?dev=1&mode=ffa` without the menu) have no `initialVersusConfig` and keep
today's behavior exactly.

- [ ] **Step 1: Failing tests** (loop.test.ts, existing harness style): the Versus
  button path opens the pane with the retained config; Start invokes
  `requestVersusSession` with the pane's config (inject a spy through GameDeps); in a
  versus-dep session the win-state's back path shows the setup pane instead of bare
  title; a campaign session never calls `requestVersusSession` and never shows the
  pane uninvited (negative control). Name the wiring mutation each kills.
- [ ] **Step 2: Verify failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Green** — `npx vitest run src/game/loop.test.ts`, then `npm test`.
- [ ] **Step 5: Commit** — `feat(loop): versus entry, reboot-on-start, and return-to-setup wiring`

### Task 6: In-match stock readout (spec §3a)

**Files:**
- Modify: `src/game/hud.ts`, `src/game/hud.css`, `src/game/loop.ts`
- Test: `src/game/hud.test.ts`, `src/game/hud.css.test.ts`, `src/game/loop.test.ts`

**Interfaces:**
- Produces: `setVersusStocks(stocks: { slot: number; stock: number; team?: number }[]
  | null): void` on the HUD interface — `null` hides (campaign never shows it).

HUD: a compact strip in the existing top-bar region (`.hud-versus-stocks`), one entry
per element: `P{slot+1}` + stock count, tinted `IDENTITY_RING_COLORS[slot]` (teams:
`TEAM_COLORS[team]`) via inline style from the SAME exported constants (import them —
duplicating the hex values is the drift the test below kills). Visible only while a
versus session is `playing`/`paused` (wire into `setState`'s visibility toggles).
Loop: after each sim step in a versus session, derive
`stocks = playerTanks.map(t => ({ slot: t.controlledBy ?? 0, stock: t.stockRemaining ?? 0, team: t.team }))`
and call `setVersusStocks` only when the derived array CHANGED (compare a joined key —
the readout must not thrash the DOM every tick; assert call count in the test).
Campaign sessions call it with `null` once at start.

- [ ] **Step 1: Failing tests.** hud: `setVersusStocks(null)` hides; entries render one
  per slot with the count text; the tint is byte-derived from `IDENTITY_RING_COLORS`
  (import the constant in the test and assert the computed style — kills hardcoded-hex
  drift); teams entries use `TEAM_COLORS[team]`; hidden at title/win/lose states.
  loop: stock loss (drive the existing versus kill fixture in loop.test.ts's style)
  updates the readout; unchanged ticks do NOT re-invoke the setter (spy call-count —
  the no-thrash control); campaign session → one `null` call, never entries. css test:
  classes pinned, button count unchanged (no new buttons — assert that explicitly in
  the commit message if true).
- [ ] **Step 2: Verify failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Green** — hud + loop + css suites, then `npm test`.
- [ ] **Step 5: Commit** — `feat(hud): in-match per-player stock readout, identity-tinted`

### Task 7: Gates, evidence, bookkeeping, PR

- [ ] **Step 1: Full gates on the final tree**: `npm test`, `npm run build`,
  `npm run test:gl`, `npm run visual` (needs dist; playwright is installed in this
  worktree). Record exact counts.
- [ ] **Step 2: Visual evidence**: screenshots of (a) the setup pane at title, (b) an
  ffa match with the stock readout visible, (c) teams with team tints — use the
  gallery's `--scene game` path with `?dev=1` versus flags or a manual dev-server
  screenshot via the visual tool's machinery; state which. The readout must visibly
  NOT overlap the arena (the owner's binding constraint) — say so against the actual
  pixels, not the CSS.
- [ ] **Step 3: Backlog** (`docs/superpowers/backlog.md`, keep `tools/backlog.test.ts`
  green): strike versus spike item 5 (setup menu — CLOSED by this PR, cite the spec);
  annotate item 6 that the MENU half (shipped-arena choice + Random with variants) is
  closed, whole-board procedural generation remains open; update the "Why 4-6 belong
  together" paragraph accordingly.
- [ ] **Step 4: Dev-flag notes**: in the PR body, one line per versus flag
  (mode/players/friendlyFire/bots) — kept, with the menu as the player-facing path
  (retirement deferred to the owner's per-flag ruling; do not delete registry entries).
- [ ] **Step 5: PR** — title:
  `Versus setup menu: title entry, reboot-on-start sessions, map choice with variants, and an in-match stock readout`
  Body: what landed per task, gate counts, the three screenshots, spec/backlog links,
  residuals (selections not persisted across reloads — by ruling; timed/best-of-N
  formats deferred; whole-board procgen open; dev-flag retirement pending). No
  attribution trailers. Do not merge — required checks + owner-visible evidence first.

## Self-review notes

- Spec coverage: §1 rulings → Tasks 3-5 (entry/reboot/return), Task 2+4 (map choice,
  options), Task 1+2 (stock); §2 architecture → Tasks 2-3; §3 pane → Task 4; §3a
  readout → Task 6; §4 testing → embedded per task; §5 out-of-scope respected (no
  format selector, no persistence, no procgen).
- Placeholders: the deliberately-measured items (seed literals for random-pick tests,
  the new pinned button count, the win→setup branch point) are pin-by-measurement
  protocol with the test forcing the value, same discipline as the moment-scenes plan.
- Type consistency: `VersusConfig` fields identical across Tasks 2-6;
  `requestVersusSession`/`initialVersusConfig` names identical in Tasks 3 and 5;
  `setVersusStocks` shape identical in Task 6's hud and loop halves.
