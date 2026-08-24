---
status: superseded
date: 2026-08-21
last-reviewed: 2026-08-23
scope: Authoritative VS setup, session configuration, match exit, and stock-readout decisions
implementation-issues: [228]
implementation-prs: [262]
supersedes: []
superseded-by: ["docs/superpowers/specs/2026-08-23-ui-ux-direction.md"]
---

# Spec — versus setup menu

**Adopted 2026-08-21** (owner rulings via in-session Q&A, recorded the same day). Closes
the versus spike's open item 5 (`docs/superpowers/backlog.md` §"Spike: the rest of versus
mode") and answers item 6's *menu* half for v1: the shipped-arena list plus Random, with
seeded variants — whole-board procedural generation stays unbuilt and out of scope.

## 1. Owner rulings (binding)

1. **Entry**: a **Versus** button on the title screen opens a **versus setup pane**, built
   on the established panel open/back machinery (the pattern Controllers/Customize use).
   Not a fork inside the New Game flow; campaign flow is untouched.
2. **Map choice v1**: the shipped arenas offered through `versusBoardCatalog`
   (`src/sim/versus-board.ts:230`) — all 15 of 15 (arena, N) combinations pass its three
   criteria today — plus a **Random** option. Seeded destructible **variants stay always
   on**, exactly as `loadArena` already wires them for versus modes with a seed.
3. **V1 options**: **mode** (FFA / Teams), **players** (2–4), **map** (5 arenas +
   Random), **friendly fire** (visible only when Teams is selected), **bot fill** for
   empty slots (via the existing assignment machinery — `botAssignmentAllowed` already
   permits bots in versus), and a **stock count selector** (default `VERSUS_STOCK` = 3).
4. **Exit flow**: match end (or Quit from a versus match) returns to the **setup pane
   with the previous selections intact** — rematch-friendly. Title is one more Back away.
   Selections are session-state only (no seventh store; same posture as controller
   assignment).

## 2. Architecture — reboot on confirm

The shipped design is one-value-per-session by explicit comment (`levels.ts:138-150`:
mode/friendlyFire/coopPool are closed over at `createLevelSystem` construction;
`loop.ts:636` reads players once at `startGameWith`). The menu does **not** fight this:

- **Confirm tears down the running session and boots a new one** through the existing
  injectable seam (`startGameWith(canvas, uiRoot, deps: GameDeps)`), with a
  `VersusConfig` translated into the same shape `deps.devFlags` carries today (mode,
  players, friendlyFire, seed) plus the two new fields below. No mid-session mutation of
  mode/players is introduced anywhere.
- **New plumbing, minimal**: (a) an arena-selection input — today the only arena chooser
  is the campaign's `arenaById(level.arenaId)`; versus needs "this arena, not a campaign
  level" threaded to `createWorldFor`. (b) a per-match **stock** — `VERSUS_STOCK` is a
  constant stamped at `arena.ts:287,336`; a menu-selected stock needs a **defaulted**
  init parameter flowing `createWorldFor → loadArena`-adjacent tank construction.
  Defaulted means the campaign path is untouched: `BASELINE_HASH` only ever drives
  campaign-coop and must not move. This is the spec's one deliberate `src/sim/` change;
  everything else is game/HUD layer.
- **Random map** draws uniformly from the catalog's passing entries for the chosen
  player count using the session seed path (no `Math.random` in game code; the seed
  derivation that already feeds `nextSeed()` is the source).
- **Dev flags stay honest**: `?dev=1&mode=…&players=…` keeps working during the
  transition; the menu supersedes it as the player-facing path. Retiring the flags is
  the registry's own ship-or-delete decision, taken per flag in the PR that ships this —
  not silently.

## 3. The pane

Follows the Controllers panel template exactly (open guarded on actual transition,
focus-the-pane, REPLACE-never-append rendering, `hud.css.test.ts` pinned selector list +
button count moved deliberately):

- Rows: Mode (FFA | Teams) · Players (2 | 3 | 4) · Map (Arena 1–5 | Random, filtered by
  `versusBoardCatalog` for the chosen player count) · Stock (1–5, default 3) · Friendly
  fire (Teams only) · a **Who's playing** row set reusing `renderControllerRows`'
  machinery (keyboard / pad / **bot** / none per slot) · Start · Back.
- Changing Players re-filters the map list and re-derives slot rows; selections persist
  in pane-local state for the session (ruling 4).
- Match end in versus: the existing results line (`setVersusResults`) shows as today;
  Continue/Back from the end state returns to the setup pane (ruling 4), not the title.

## 3a. In-match stock display (owner addition, 2026-08-21)

Per-player stock counts must be visible **during** a versus match without blocking the
view of play:

- A compact per-slot readout (one entry per active slot: slot identity + remaining
  stock), rendered in the HUD's existing top-bar region — the screen edge the layout
  already reserves — never as an overlay on the arena.
- Identity is carried the same way the rest of the identity system carries it: each
  entry is tinted with its slot's `IDENTITY_RING_COLORS` entry (teams: `TEAM_COLORS`),
  so the readout matches the rings players already watch.
- It is a one-way projection: driven from loop state (`Tank.stockRemaining` per
  player-kind tank), updated when stocks change — a new `setVersusStocks(stocks |
  null)` HUD setter in the mold of `setVersusResults`; `null` hides it entirely, so
  campaign sessions never show it. Visible only in the `playing`/`paused` states of a
  versus session.
- Size/placement is a feel call made against a real render (gallery/screenshot
  evidence in the PR), with the constraint stated by the owner as binding: it must not
  block the screen.

## 4. Testing

- Panel behavior: copy the controller-panel test shapes (`hud.test.ts:1221` block) —
  open/close fire once per transition, re-render replaces rows, roving tabindex reaches
  the new controls, button-count pin moves deliberately.
- Config plumbing: a test through `startGameWith` proving a versus config produces a
  world with the chosen mode/players/arena/stock (and that omitting stock yields
  `VERSUS_STOCK` — the defaulted-param negative control).
- Sim change: the stock init parameter gets its own test at the sim boundary; golden
  trace must be byte-identical (campaign path untouched — run the trace gate).
- Every new assertion names the change that makes it fail; mutation evidence per repo
  rule for any new test claimed to close a gap.

## 5. Out of scope (deliberate)

Timed / best-of-N / first-to-N formats (format-order ruling: stock shipped first; the
selector here is stock count only, not format). Whole-board procedural generation.
Persisting setup selections across page loads. Retiring the versus dev flags (decided
per-flag in the shipping PR, not assumed). "Press A to join" — assignment stays the
click-to-assign machinery. Spawn-animation choice in the pane (picker UI is its own
deferred design).
