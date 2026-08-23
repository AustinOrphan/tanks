---
status: active
date: 2026-08-23
last-reviewed: 2026-08-23
scope: Dedicated VS arena catalog contract (validated data family) plus deterministic per-entry suitability validators
implementation-issues: [270]
implementation-prs: []
supersedes: []
superseded-by: []
---
# VS arena catalog contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A dedicated, validated VS arena catalog (stable IDs + declared support metadata)
that VS selection reads, with deterministic geometry validators and diagnostics naming
the exact entry, player count, mode, variant, and failed rule (issue #270).

**Architecture:** A fourth validated-data family (`versus-catalog.json` +
`validateVersusCatalog` + a `createCatalog` loader) declares what each VS map advertises;
a new pure-sim rules module (`versus-catalog-rules.ts`) proves every declaration against
the real geometry machinery (`evaluateVersusBoard`, `buildVariantGrid`, `loadArena`);
`versus-config.ts`'s selection functions switch from live `versusBoardCatalog()` sweeps to
reading the declarations, with resolution translating a catalog entry id to its underlying
arena id at the Start boundary and rejecting unsupported (mode, players) combinations.

**Tech Stack:** TypeScript, vitest, existing sim config validation primitives
(`src/sim/config/validate.ts`), `tools/mutate` manifest.

**Spec:** GitHub issue #270 (contract + validators; arenas themselves are #271–#273, the
selector UI is #274). Binding context: `docs/superpowers/plans/2026-08-17-versus-board-rules.md`
(the three suitability criteria), `docs/superpowers/plans/2026-08-17-versus-map-variants.md`
(seeded destructible variants, fraction 0.4), `docs/superpowers/specs/2026-08-21-versus-setup-menu-design.md`
(owner ruling 2: shipped arenas + Random stay offered).

## Global Constraints

- `src/sim/` stays pure: no DOM, wall clock, Math.random, or runtime flags.
- Entity/arena/campaign/balance configuration is validated data; extend
  `src/sim/config/validate.ts`, do not build parallel plumbing.
- `arenas.json` is NOT touched (its shape feeds the replay data fingerprint).
- Campaign ordering stays independent: nothing here reads `campaign.json`.
- The shipped menu behaviour must not regress: five arenas + Random at every N in
  {2,3,4}, identical choice order, identical `pickVersusArena` draws for a given seed.
- The migrated entries' ids EQUAL their arena ids (contract allows them to differ; a
  synthetic test proves the translation path).
- `id: "random"` is rejected by the schema — it is the menu's reserved sentinel.
- Every new assertion needs a named negative control; key checks get mutation evidence.

## File structure

- Create `src/sim/config/versus-catalog-types.ts` — `VersusCatalogEntry`, `VersusMode`,
  `VERSUS_VARIANT_KINDS`.
- Create `src/sim/config/data/versus-catalog.json` — 5 migrated entries.
- Modify `src/sim/config/validate.ts` — add `validateVersusCatalog`.
- Create `src/sim/config/versus-catalog.ts` — validated load + `versusCatalogEntryById`.
- Create `src/sim/versus-catalog-rules.ts` — deterministic geometry validators.
- Create `src/sim/versus-catalog-rules.test.ts` — shipped sweep + synthetic negatives.
- Modify `src/sim/config/validate.test.ts` — schema negative controls.
- Modify `src/game/versus-config.ts`, `src/game/hud.ts` — selection reads the catalog.
- Modify `src/game/versus-config.test.ts` — parity pins, mode filter, rejection.
- Modify `tools/mutate/manifest.json` — mutation evidence for the new gates.
- Modify `docs/superpowers/backlog.md` — narrow the "map selection" spike line.

---

### Task 1: Schema, data, and validated loader

**Files:**
- Create: `src/sim/config/versus-catalog-types.ts`
- Create: `src/sim/config/data/versus-catalog.json`
- Modify: `src/sim/config/validate.ts` (append after `validateCampaign`)
- Create: `src/sim/config/versus-catalog.ts`
- Test: `src/sim/config/validate.test.ts`, `src/sim/config/versus-catalog.test.ts`

**Interfaces:**
- Consumes: `fail`, `isRecord`, `str`, `posInt`, `oneOf`, `exactKeys` from `validate.ts`;
  `createCatalog` from `catalog.ts`; `ARENA_DEFS` from `arenas.ts`.
- Produces: `VersusCatalogEntry { id, arenaId, displayName, intent, preview, players:
  number[], modes: VersusMode[], spawnPolicy: 'maximin', variants: VersusVariantKind[] }`;
  `validateVersusCatalog(raw: unknown, knownArenaIds: ReadonlySet<string>, file?):
  VersusCatalogEntry[]`; `VERSUS_CATALOG: readonly VersusCatalogEntry[]`;
  `versusCatalogEntryById(id: string): VersusCatalogEntry`.

- [ ] **Step 1: Write the types file**

```ts
// src/sim/config/versus-catalog-types.ts
export type VersusMode = 'ffa' | 'teams';
export const VERSUS_MODES: readonly VersusMode[] = ['ffa', 'teams'];
export const VERSUS_PLAYER_COUNTS: readonly number[] = [2, 3, 4];
export const VERSUS_VARIANT_KINDS = ['seeded-destructible'] as const;
export type VersusVariantKind = (typeof VERSUS_VARIANT_KINDS)[number];
export const VERSUS_SPAWN_POLICIES = ['maximin'] as const;
export type VersusSpawnPolicy = (typeof VERSUS_SPAWN_POLICIES)[number];

export interface VersusCatalogEntry {
  /** Stable VS id — the selection namespace. NEVER 'random' (reserved sentinel). */
  id: string;
  /** The arena geometry this entry plays on (must exist in arenas.json). */
  arenaId: string;
  displayName: string;
  /** One-line gameplay intent note (selector copy, #274). */
  intent: string;
  /** Preview reference token consumed by the selector (#274). */
  preview: string;
  /** Supported player counts — non-empty strictly-increasing subset of {2,3,4}. */
  players: number[];
  /** Supported modes — non-empty, unique. */
  modes: VersusMode[];
  /** The spawn placement policy the entry is validated under. */
  spawnPolicy: VersusSpawnPolicy;
  /** Advertised variant generators (may be empty = fixed board only). */
  variants: VersusVariantKind[];
}
```

- [ ] **Step 2: Write failing schema tests** in `src/sim/config/validate.test.ts` — a
  `describe('validateVersusCatalog', ...)` block. A local `validEntry()` factory returns
  the arena-01 entry; each negative control mutates ONE field. Cases (each
  `expect(() => validateVersusCatalog(...)).toThrow(/<path or message fragment>/)`):
  valid catalog passes and returns 5 entries; missing top-level `entries`; unknown
  top-level key; entry missing a key (incomplete); entry with an unknown key; `id: ''`;
  `id: 'random'` (reserved); duplicate ids; `arenaId` not in `knownArenaIds`; empty
  `displayName` / `intent` / `preview`; `players: []`; `players: [5]`; `players: [3, 2]`
  (order); `players: [2, 2]` (dup); `modes: []`; `modes: ['ffa', 'ffa']`;
  `modes: ['solo']`; `spawnPolicy: 'grid'`; `variants: ['procedural']`;
  `variants: ['seeded-destructible', 'seeded-destructible']` (dup).

- [ ] **Step 3: Run to verify failure** — `npx vitest run src/sim/config/validate.test.ts`
  fails with "validateVersusCatalog is not exported".

- [ ] **Step 4: Implement `validateVersusCatalog`** in `validate.ts`, following
  `validateCampaign`'s shape exactly: `exactKeys(file, 'catalog', v, ['entries'])`;
  per-entry `exactKeys` over the nine fields; `str` non-empty checks; `id === 'random'`
  → `fail(file, path, "id 'random' is reserved for the menu sentinel")`; duplicate-id
  `Set`; `players` strictly increasing with every element via
  `oneOf(...VERSUS_PLAYER_COUNTS)`; `modes`/`variants` uniqueness + `oneOf`; `arenaId`
  membership in `knownArenaIds`.

- [ ] **Step 5: Author `versus-catalog.json`** — 5 entries, ids equal to arena ids,
  json order `arena-01`..`arena-05` (pins choice-order parity), each with
  `players: [2,3,4]`, `modes: ["ffa","teams"]`, `spawnPolicy: "maximin"`,
  `variants: ["seeded-destructible"]`, `preview` = the arena id, `displayName` =
  `Arena 1`..`Arena 5` (parity with hud's `arenaLabel`), and a short measured-fact
  intent line (destructible density / board size, from the map-variants plan's table).

- [ ] **Step 6: Write the loader** `src/sim/config/versus-catalog.ts`:

```ts
import rawCatalog from './data/versus-catalog.json';
import { validateVersusCatalog } from './validate';
import { createCatalog } from './catalog';
import { ARENA_DEFS } from './arenas';
import type { VersusCatalogEntry } from './versus-catalog-types';

export const VERSUS_CATALOG: readonly VersusCatalogEntry[] = validateVersusCatalog(
  rawCatalog, new Set(ARENA_DEFS.map((a) => a.id)),
);
const byId = createCatalog(VERSUS_CATALOG, (e: VersusCatalogEntry) => e);
export function versusCatalogEntryById(id: string): VersusCatalogEntry { return byId.get(id); }
```

  plus `src/sim/config/versus-catalog.test.ts`: loads 5 entries; ids are
  `arena-01`..`arena-05` in order; `versusCatalogEntryById('arena-03')` round-trips;
  unknown id throws.

- [ ] **Step 7: Run** `npx vitest run src/sim/config --maxWorkers=2` — all pass; then
  `npm run verify:quick`.

- [ ] **Step 8: Commit** `vs-catalog: validated catalog data family with stable ids`
  and push the branch.

### Task 2: Geometry rules — declared support, connectivity, diagnostics

**Files:**
- Create: `src/sim/versus-catalog-rules.ts`
- Test: `src/sim/versus-catalog-rules.test.ts`

**Interfaces:**
- Consumes: `VersusCatalogEntry` (types), `arenaById` + `ArenaDefinition` from
  `./arena`, `evaluateVersusBoard`, `MIN_OPEN_FLOOR_PER_PLAYER` from `./versus-board`,
  `loadArena` from `./arena`.
- Produces: `versusCatalogEntryFailures(entry, opts?): string[]` and
  `versusCatalogFailures(entries?, opts?): string[]`;
  `VersusCatalogRuleOptions { arenaFor?, variantSeeds?, clearanceRule? }`;
  diagnostic format
  `` `${entry.id} (${entry.arenaId}) N=${n} mode=${mode} variant=${variant}: ${rule}: ${detail}` ``
  with `N=any mode=any` for entry-level failures. Rules named: `spawn-count`,
  `opening-sightlines`, `room`, `connectivity`, `variant-coverage`, `spawn-clearance`.

- [ ] **Step 1: Failing tests** — shipped sweep block: for every `VERSUS_CATALOG` entry,
  `versusCatalogEntryFailures(entry)` returns `[]`; population pinned
  (`expect(VERSUS_CATALOG.length).toBe(5)` with a comment naming the denominator:
  5 entries × N∈{2,3,4} × 2 modes = 30 declared combinations). Synthetic negatives
  (fixtures in the `versus-board.test.ts` idiom — plain `ArenaDefinition` literals,
  `arenaFor` seam maps a fake `arenaId` to them): an open 10×10 room entry declaring
  N=4 yields an `opening-sightlines` failure whose message contains the entry id, `N=4`,
  each declared mode, `variant=authored`; a pillar-room entry (39 open cells) declaring
  N=4 yields `room`; a two-chamber board split by a full solid wall with spawn letters
  both sides yields `connectivity` naming the unreachable cell.

- [ ] **Step 2: Run to verify failure** (module does not exist).

- [ ] **Step 3: Implement.** Declared support: per declared `n`,
  `const v = evaluateVersusBoard(arena, n)`; emit `spawn-count`
  (`${v.spawnCount} of ${n} spawn cells distinct`), `opening-sightlines`
  (`${v.concealedPairs} of ${v.totalPairs} spawn pairs concealed`), `room`
  (`${v.openFloorPerPlayer.toFixed(2)} open-floor cells per player < ${MIN_OPEN_FLOOR_PER_PLAYER}`)
  for whichever criteria fail — once per declared mode (geometry is mode-independent;
  evaluate once per n, emit per mode). Connectivity: BFS from the `P` cell over
  4-connected cells whose legend kind is not `solid` (destructibles are breachable,
  so they count as eventually-traversable); every player position from
  `loadArena(arena, n, 'ffa')` must map (`Math.floor(pos/cellSize)`) to a reached cell;
  failure detail names the spawn's cell coordinates.

- [ ] **Step 4: Run tests to green**, then `npm run verify:quick`.

- [ ] **Step 5: Commit** `vs-catalog: declared-support and connectivity validators` and push.

### Task 3: Geometry rules — variant coverage and the clearance hook

**Files:**
- Modify: `src/sim/versus-catalog-rules.ts`
- Test: `src/sim/versus-catalog-rules.test.ts`

**Interfaces:**
- Consumes: `buildVariantGrid`, `DESTRUCTIBLE_REMOVAL_FRACTION` from `./versus-variants`.
- Produces: `VARIANT_VALIDATION_SEEDS = [1, 2, 3, 4, 5] as const` (pinned, deterministic);
  `SpawnClearanceRule = (ctx: { arena: ArenaDefinition; grid: string[]; playerCount:
  number; positions: readonly { x: number; y: number }[] }) => string[]` — the #225
  consumption seam, absent by default.

- [ ] **Step 1: Failing tests.** Variant coverage: an entry declaring
  `seeded-destructible` on a fixture with zero destructible cells fails
  `variant-coverage` with `N=any mode=any variant=seeded-destructible` and "0
  destructible cells"; shipped sweep stays `[]` (5 entries × 3 Ns × 5 pinned seeds = 75
  ungated draws at fraction 0.4 — the map-variants plan measured 0 failures in 1500
  draws at this fraction, so 0 is the expected margin, not a hope); determinism control:
  two runs of `versusCatalogEntryFailures` on the same entry are deep-equal. Clearance
  hook: an injected rule returning one failure surfaces as `spawn-clearance` carrying
  the entry id and N; with no rule injected, the same fixture yields no
  `spawn-clearance` line.

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement.** For each declared variant kind `seeded-destructible`:
  count destructible cells (legend kind `destructible`); zero → entry-level failure.
  Else per declared n × `VARIANT_VALIDATION_SEEDS`:
  `const vg = buildVariantGrid(arena.grid, arena.cols, arena.rows, arena.legend, seed, DESTRUCTIBLE_REMOVAL_FRACTION)`
  (confirm the real signature before calling);
  `const v = evaluateVersusBoard({ ...arena, grid: vg }, n)`; require
  `distinctSpawns && allPairsConcealed` (NOT `roomOk` — floor count is
  monotone-nondecreasing under destructible removal, proven in the map-variants plan);
  failure detail names the seed. `variant=seeded-destructible seed=${seed}` in the
  diagnostic. Clearance: if `opts.clearanceRule` present, call once per declared n on
  the authored grid with the real picked positions; wrap each returned string as a
  `spawn-clearance` failure.

- [ ] **Step 4: Run tests to green**, then `npm run verify:quick`.

- [ ] **Step 5: Commit** `vs-catalog: variant coverage and the #225 clearance seam` and push.

### Task 4: Selection reads the catalog; unsupported combos rejected

**Files:**
- Modify: `src/game/versus-config.ts`, `src/game/hud.ts`
- Test: `src/game/versus-config.test.ts` (and hud tests if the map row's test pins change)

**Interfaces:**
- Consumes: `VERSUS_CATALOG`, `versusCatalogEntryById` (Task 1).
- Produces: `versusMapChoices(players: number, mode: VersusMode, entries: readonly
  VersusCatalogEntry[] = VERSUS_CATALOG): string[]` (entry ids);
  `pickVersusArena(config, seed)` unchanged signature, draws from the new choices;
  `resolveVersusConfig(config, seed)` now ALSO: looks up the concrete entry (unknown id
  → throw), rejects unsupported combos
  (`versus-config: map '<id>' does not support N=<players> mode=<mode>`), and
  translates entry id → `entry.arenaId` so `levels.ts`/`replayMetaFor` keep receiving
  a real arena id. Identity pass-through preserved when nothing changes (loop.test.ts
  H1/H2 rely on it).

- [ ] **Step 1: Failing tests.** Parity pin: `versusMapChoices(n, 'ffa')` returns
  exactly `['arena-01','arena-02','arena-03','arena-04','arena-05']` for every N in
  {2,3,4} (the pre-change list, same order). Mode filter: synthetic entries where one
  declares only `['ffa']` — excluded under `'teams'`, included under `'ffa'` (the
  negative control for the mode predicate). Player filter: an entry declaring `[2]`
  excluded at N=3. Rejection: `resolveVersusConfig` with a concrete id whose entry
  does not support the config's (mode, players) throws with the exact message; unknown
  id throws. Translation: a synthetic entry `id: 'vs-fixture', arenaId: 'arena-02'`
  resolves to a config carrying `arenaId: 'arena-02'` (requires an `entries` seam on
  `resolveVersusConfig` or routing via `versusCatalogEntryById` — inject the lookup,
  mirroring the existing `rows` seam idiom). Identity: a concrete supported config
  whose entry id equals its arenaId returns the SAME object. Determinism: for one
  pinned seed, `pickVersusArena({...random config}, seed)` returns the same literal id
  as the pre-change implementation (compute once from the old code path before
  changing it, then pin the literal).
- [ ] **Step 2: Run to verify failures.**
- [ ] **Step 3: Implement in `versus-config.ts`.** Delete `defaultCatalogRows`/cache and
  the `versusBoardCatalog` import (the pane no longer pays a 15-`loadArena` sweep —
  note this in the module doc). Rewrite `versusMapChoices` as the declared filter.
  Extend `resolveVersusConfig` per the interface block.
- [ ] **Step 4: Update `hud.ts`.** `renderVersusMapRow` passes
  `versusConfigState.mode`; verify what re-renders on mode change today — the mode
  button handler must now also re-render the map row (choices can differ per mode),
  and if the selected map drops out of the new choice list, reset selection to
  `'random'` (mirror whatever the players-change path already does; if it does not
  handle invalidation, add the same reset there — with all five shipped entries
  declaring both modes and all Ns, no shipped interaction changes).
- [ ] **Step 5: Run the full game-layer suites**
  `npx vitest run src/game --maxWorkers=2`, fix pins the map row/versus-config change
  legitimately moves (each moved pin named in the commit body), then `npm run verify:quick`.
- [ ] **Step 6: Commit** `vs-catalog: selection reads the dedicated catalog and rejects
  unsupported combos` and push.

### Task 5: Mutation evidence, docs, full verification, PR

**Files:**
- Modify: `tools/mutate/manifest.json`, `docs/superpowers/backlog.md`, this plan's header.

- [ ] **Step 1: Mutation evidence** (use the mutation-check skill; follow the manifest
  format). Candidates, each expected KILLED: (a) `versusMapChoices` mode predicate →
  `true` (killed by the mode-filter test); (b) variant sweep drops
  `allPairsConcealed` from its conjunction (killed by the open-room seeded fixture);
  (c) `resolveVersusConfig` support check removed (killed by the rejection test). Run
  `npm run mutate -- --only <id>` per new entry; any SURVIVES means the target is dead
  or the test vacuous — fix before claiming coverage.
- [ ] **Step 2: Backlog narrowing.** `docs/superpowers/backlog.md` §"Spike: the rest of
  versus mode" item 6: narrow the "map selection" half to note the dedicated catalog
  contract now exists (#270); procedural generation remains the open half.
- [ ] **Step 3: Docs check** — `npm run docs:check` (this plan document's metadata must
  validate).
- [ ] **Step 4: Full verification** — this diff touches `src/sim/`: high risk. From a
  clean candidate tree, `npm run verify:full`. Also re-run the two measured headline
  numbers (choices parity, sweep population) after the final tree state.
- [ ] **Step 5: PR** — title `Create the dedicated VS arena catalog contract and
  validators`, body: what/why, the measured populations with denominators (30 declared
  combinations, 75 seeded draws at fraction 0.4, 5 entries), mutation results, and
  `Closes #270`. No attribution trailers. Push and record CI state; merging is the
  owner's.
