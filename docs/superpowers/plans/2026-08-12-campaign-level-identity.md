# Plan — Issue #154: campaign data owns level identity and ordering

Status: adopted 2026-08-12, implemented in the PR that carries this file.

Provenance: produced by a scoping pass over the tree at 084b88c — five parallel
inventory sweeps (sim/config, game runtime, test intent, tools, persistence+docs;
101 positional-assumption sites catalogued), three competing designs, nine
adversarial judgements (three lenses per design), and a synthesis that re-verified
the winner's claims against the real tree. Line numbers below were verified at
084b88c and MUST be re-derived before editing — counts are a property of the tree
at the moment you run them.

Decisions taken at adoption (the plan's open questions, resolved for this PR):

1. The `tanks.run.v1` -> `v2` bump ships as planned. Losing an in-flight run
   (position + that attempt's lives) is a one-time, narrow regression, flagged in
   the PR body for Austin's reversal; permanent progress is untouched.
2. The frozen-table silent-drop (a legacy clear whose arena later leaves the
   campaign reads as never-cleared) stays SILENT, matching every other store's
   corrupt-data convention.
3. No extra level-id/arena-id namespace guard beyond the `/^\d+$/` rejection —
   not required by the issue, not raised by any judge.
4. The commit split stays as written: Step 3 is one coupled cutover commit,
   Step 4 (`progress.ts`) is its own.


## How this plan was built

Winner on mean score: **"Issue #154: campaign data owns level identity and ordering, arenas become content referenced by id"** (6.3/10 mean across satisfies-issue 6, guard-integrity 7, migration-reality 6). I re-read that design's own text against the real tree rather than trusting the verdict summaries — `git`/`grep` confirmed its stated line numbers, its `RunStore`/`LevelSystem` retyping, and its `campaign.json` shape. Two corrections to my own earlier reading, stated because getting them wrong would have produced a wrong plan: the winner (not the third design) is the one that retypes `RunStore` to string ids, retypes `LevelSystem` around `CampaignLevel` objects, retypes `loop.ts`'s `level` local, and renames `ReplayMeta.level` to `arenaId` — I initially conflated it with the third design's much smaller "loop.ts needs zero changes" alternative and corrected that against the verbatim text before writing anything below. Second: the guard-integrity reviewer's "fatal" claim that Step 1 breaks `tools/mutate/manifest.json`'s `replay-recorder-wraps-the-raw-controller` entry **does** apply to the winner (I confirmed the entry's `find` string matches `src/game/loop.ts:522` byte-for-byte today, and the winner's own Step 1 changes that exact line) — this is real and Step 3 below fixes it in the same commit.

Every `fatal_flaw` raised against the winner is fixed below (RUN_KEY migration ambiguity, the mutate-manifest break, and `progress.ts`'s reorder-unsafety). Two ideas are grafted from the runners-up where a judge named a specific weakness the winner's own text doesn't close: an injectable campaign-levels parameter on `createLevelSystem` (from the first design, praised by its own guard-integrity review, 7/10) so a reordered fixture can prove `levels.ts` resolves through campaign data and not `ARENAS` position; and the "interned CampaignLevel objects in `makeDeps`" technique (present in the winner's own Step 3, kept and detailed here since it's what keeps `loop.test.ts`'s ~30 call sites untouched).

---

## Decision

Campaign ordering and player-facing level identity move into a new `CampaignDefinition` owned by `src/sim/config/campaign.ts`, riding the same `createCatalog`/`validate.ts` machinery every other entity family in that directory uses (CLAUDE.md: "new families should ride `createCatalog` rather than invent parallel plumbing"). Arenas stop being consulted by position anywhere a *level* is meant; `ARENAS`/`ARENA_DEFS` keep meaning exactly what they mean today — a catalog of reusable boards, looked up by id — and `arenas.json`'s own array order stops being level order.

`ActiveRun.currentLevelId` (already a bare `string` per issue #153/run.ts's own "pending #154" doc comment) becomes a real `CampaignLevel.id` instead of a stringified `ARENAS` index. `progress.ts`'s `highestCleared` — the issue's own required outcome #4 names this explicitly, and all three satisfies-issue reviews independently flagged it as unmet by every design's literal text — is made reorder-safe too: it stops being a bare positional ordinal and is derived, on every read, from a persisted stable level id.

## Data model

**New: `src/sim/config/campaign-types.ts`**
```ts
export interface CampaignLevel {
  readonly id: string;      // player-facing level identity. Opaque — compared for
                             // equality only, never parsed. Order comes only from
                             // position in CampaignDefinition.levels.
  readonly arenaId: string; // validated at load to name a real arenaById() entry.
}
export interface CampaignDefinition {
  readonly id: string;
  readonly levels: readonly CampaignLevel[];
}
```

**New: `src/sim/config/data/campaign.json`** — one `CampaignDefinition` object, not wrapped in a `campaigns` array (deliberate YAGNI: nothing needs a second shipped campaign yet; a `campaigns.json` wrapper is an additive escape hatch later, not a breaking change to these two interfaces). Mirrors the 5 shipped arenas 1:1, same order, on day one — verified via `grep '"id"' src/sim/config/data/arenas.json`, which returns `arena-01`..`arena-05` in exactly that order:
```json
{
  "id": "main",
  "levels": [
    { "id": "level-01", "arenaId": "arena-01" },
    { "id": "level-02", "arenaId": "arena-02" },
    { "id": "level-03", "arenaId": "arena-03" },
    { "id": "level-04", "arenaId": "arena-04" },
    { "id": "level-05", "arenaId": "arena-05" }
  ]
}
```

**`src/sim/config/validate.ts`**, add `validateCampaign` next to `validateArenas`:
```ts
export function validateCampaign(
  raw: unknown,
  knownArenaIds: ReadonlySet<string>,
  file = 'campaign.json',
): CampaignDefinition
```
Checks, each failing via the file's existing `fail(file, path, message)` path-naming helper (verified present at `validate.ts:40`) and `exactKeys` (verified at `validate.ts:99`): root `exactKeys(['id','levels'])`; `id` non-empty string; `levels` non-empty array; each entry `exactKeys(['id','arenaId'])`; entry `id` non-empty string, unique across the array (Set-based, mirrors the arenas validator's own duplicate-id check), and **must not match `/^\d+$/`** — reserved so a legacy numeric-string persisted value can never collide with a real level id, failing with a message naming that reason; entry `arenaId` non-empty string present in `knownArenaIds` (injected by parameter, not imported live — `arenas.ts` already imports `validateArenas` from this file, so importing `arenaById` back would cycle). `knownArenaIds` is passed in as `new Set(ARENA_DEFS.map(a => a.id))` by the one caller.

**New: `src/sim/config/campaign.ts`** (mirrors `src/sim/config/arenas.ts` exactly — verified that file's real shape: `ARENA_DEFS`, a `createCatalog` instance, `arenaById` with its own throw-on-miss):
```ts
import { createCatalog } from './catalog';
import type { CampaignDefinition, CampaignLevel } from './campaign-types';
import { validateCampaign } from './validate';
import { ARENA_DEFS } from './arenas';
import campaignJson from './data/campaign.json';

export const CAMPAIGN: CampaignDefinition =
  validateCampaign(campaignJson, new Set(ARENA_DEFS.map((a) => a.id)));
export const CAMPAIGN_LEVELS: readonly CampaignLevel[] = CAMPAIGN.levels;

const BY_ID = createCatalog<string, CampaignLevel, CampaignLevel>(
  Object.fromEntries(CAMPAIGN_LEVELS.map((l) => [l.id, l])),
  (id, defs) => defs[id],
);

export function campaignLevelById(id: string): CampaignLevel {
  const found = BY_ID.get(id);
  if (!found) throw new Error(`Unknown campaign level id: ${id}`);
  return found;
}

export const FIRST_CAMPAIGN_LEVEL: CampaignLevel = CAMPAIGN_LEVELS[0];
```
No `campaignLevelIndex`/`nextCampaignLevel` sim-level ordinal helpers — the winner's own text drops these deliberately (they'd throw on the sandbox's synthetic `'sandbox'` level id, which is never in this catalog, and once `loop.ts` works off its own session's `levels` array they have no caller — "a generator nothing calls rots").

`src/sim/arena.ts` re-exports `CAMPAIGN`, `CAMPAIGN_LEVELS`, `campaignLevelById`, `FIRST_CAMPAIGN_LEVEL`, and the two types, matching the precedent already there for `ARENAS`/`arenaById` (verified: `arena.ts:1-22` already imports `ARENA_DEFS, arenaById` from `./config/arenas` and re-exports `ARENAS`). This keeps `src/game/`'s import surface at `from '../sim/arena'`, unchanged in shape.

**`src/game/run.ts`** — `RunStore`'s public shape moves from number to string:
```ts
export const RUN_KEY = 'tanks.run.v2'; // was v1 — see Migration
interface RunStore {
  active(): ActiveRun | null;
  startNewRun(startLevelId: string): ActiveRun;
  advanceLevel(levelId: string, livesRemaining: number): void;
  setLivesRemaining(lives: number): void;
  endRun(): void;
}
```
`ActiveRun.currentLevelId: string` — unchanged TS type, new meaning: a real `CampaignLevel.id` verbatim, never resolved against campaign data inside this file (that stays run.ts's only architectural rule: it is a pure key-value store and never imports `campaign.ts`, exactly the layering #154 exists to establish — `levels.ts` is the one place a string id becomes a `CampaignLevel`). `levelIdFromIndex`/`levelIndexFromId` (`run.ts:81-92`, whose own doc comments call themselves "the minimal string that satisfies the shape... pending #154") are **deleted**, not reimplemented. `startNewRun` throws on a non-string/empty argument (a programmer-error contract — unlike the old numeric index there is no safe value it can compute on its own). `advanceLevel` keeps its existing no-op-on-bad-input style (silent return), matching its siblings (`run.ts:217-218`).

**`src/game/levels.ts`** — `LevelSystem` retyped around `CampaignLevel` objects, not numbers:
```ts
interface LevelSystem {
  readonly levels: readonly CampaignLevel[]; // replaces `count: number`
  readonly start: CampaignLevel;             // was number
  readonly tracksProgress: boolean;
  readonly isDevJump: boolean;
  world(level: CampaignLevel, seed: number, unarmedTrigger?: UnarmedTrigger, lives?: number): World;
  bounds(level: CampaignLevel): { width: number; height: number; cellSize: number };
}
export function createLevelSystem(
  flags: DevFlags,
  run: RunStore,
  campaignLevels: readonly CampaignLevel[] = CAMPAIGN_LEVELS, // GRAFTED — see Steps
): LevelSystem
```
**Invariant that both branches must uphold, and that the loop.ts helpers below depend on**: `start` is always reference-equal to some element of `levels`, never a freshly-constructed lookalike.

Sandbox branch (`levels.ts:44-66`): builds one synthetic `CampaignLevel { id: 'sandbox', arenaId: FIRST_CAMPAIGN_LEVEL.arenaId }` (was `ARENAS[0]`, verified at `levels.ts:54` — same value, decoupled framing), returns `levels: [sandboxLevel]`, `start: sandboxLevel`; `world`/`bounds` resolve via `arenaById(sandboxLevel.arenaId)` or ignore it entirely for the sandbox world, exactly as today.

Real branch: `levels: campaignLevels`; `start` getter — dev-jump clamps into `campaignLevels` by position (same clamp semantics as today's `Math.min(jump-1, ARENAS.length-1)` at `levels.ts:88`, resolving to an object instead of an index); else `campaignLevels.find(l => l.id === active.currentLevelId) ?? campaignLevels[0]` — the untrusted-persisted-string-to-domain-object lookup, WITH graceful fallback, lives here, never via the throwing `campaignLevelById`. `world`/`bounds` resolve via `arenaById(level.arenaId)`.

**`src/game/loop.ts`** — the `level` local (`loop.ts:420`) is retyped `CampaignLevel`. Two local helpers replace the shared `level + 1` arithmetic CLAUDE.md already names as playing three unrelated roles, computed against **this session's own list** (`deps.levels.levels`), never the global `CAMPAIGN_LEVELS` catalog directly — the sandbox's synthetic `'sandbox'` id is not a member of that catalog and `campaignLevelIndex`-style lookups against it would throw:
```ts
function ordinalOf(l: CampaignLevel): number { return deps.levels.levels.indexOf(l) + 1; }
function nextInSession(l: CampaignLevel): CampaignLevel | null {
  const i = deps.levels.levels.indexOf(l);
  return i >= 0 && i + 1 < deps.levels.levels.length ? deps.levels.levels[i + 1] : null;
}
```
Every `deps.levels.count` site (10 occurrences, verified by `grep -n "deps.levels.count" src/game/loop.ts`: 554, 693, 736, 793, 800, 970, 1020, 1032, 1062, 1063 — this population moves the moment the file changes, so re-run the grep before implementing rather than trusting this list) → `deps.levels.levels.length`. Every `level + 1` site (8 occurrences, verified: 693, 695, 736, 1019, 1025, 1032, 1036, 1062) → `ordinalOf(level)` (HUD display ordinal at 736/1062, `progress.recordCleared`'s role at 1019, `achievements.ts`'s `clearedLevel` milestone at 1025) or `nextInSession(level)` (the "is there a next level" checks at 693/1032, and the switch target at 695/1036). The win branch's `advanceLevel`/`endRun` choice (`loop.ts:1032-1038`) simplifies to:
```ts
const next = nextInSession(level);
if (next === null) deps.run.endRun();
else deps.run.advanceLevel(next.id, driver.world.lives);
```
dropping the separate `isFinalLevel` boolean. `deps.run.startNewRun(startLevel)` at `loop.ts:784` becomes `deps.run.startNewRun(startLevel.id)` (`startLevel` is `deps.levels.start`, now a `CampaignLevel`). The literal `0` at `loop.ts:819` (`startNewRun(0)`) becomes `deps.levels.levels[0].id`, and `switchTo(0, ...)` at `loop.ts:821` becomes `switchTo(deps.levels.levels[0], ...)`. `onLevelSelect`'s handler (`loop.ts:800-805`) keeps `picked` as the bare 0-based index HUD's `for` loop already hands it (verified `hud.ts:1417-1429` operates on opaque ordinals, no change needed there), bounds-checks it against `deps.levels.levels.length`, then resolves `deps.levels.levels[picked]` before calling `switchTo`. `deps.progress.recordCleared(level + 1)` at `loop.ts:1019` becomes `deps.progress.recordCleared(level)` — passing the `CampaignLevel` object itself (see the `progress.ts` redesign below; this is a deliberate departure from the winner's literal `progress.ts`-unchanged text, justified in Migration).

`recorder?.begin(replayMetaFor(world, level))` at `loop.ts:522` and `loop.ts:720` become `replayMetaFor(world, level.arenaId)`.

**`src/game/replay.ts`** — `ReplayMeta.level: number` becomes `ReplayMeta.arenaId: string`; `replayMetaFor(world, arenaId)` takes the arena id directly. Deliberate: a trace names the ARENA it actually built, never a campaign level id re-resolved through (possibly since-edited) `campaign.json` at rebuild time — a level can be re-pointed to a different arena later, and a trace must keep reproducing the exact geometry it was recorded against. `simDataFingerprint`'s doc comment (`replay.ts` around line 123-127) gains one line stating `campaign.json` is deliberately NOT a 5th hashed file, and why: campaign order changes which arena a position resolves to, not any single arena's own trajectory, and the fingerprint's job is "would this build's data reproduce the same run from an already-resolved arena," not "did the position→arena mapping stay the same."

**`src/game/progress.ts`** — the fix for the fatal flaw every satisfies-issue review raised (verified against issue #154's own text via `gh issue view 154`: required outcome #4 reads *"Permanent progression and active-run state reference stable campaign-level identities rather than assuming `ARENAS[index]` is the permanent definition of Level N"* — `highestCleared` is exactly the permanent-progression half of that sentence, and no design's literal text fixes it). See Migration for the full mechanism; interface stays:
```ts
export interface ProgressStore {
  highestCleared(): number;          // unchanged return type — zero ripple into
                                      // achievements.ts or loop.ts's call sites
  recordCleared(level: CampaignLevel): void; // was recordCleared(level: number)
  reset(): void;
}
export function createProgressStore(
  storage: Storage,
  campaignLevels: readonly CampaignLevel[] = CAMPAIGN_LEVELS,
): ProgressStore
```

## Migration

**`RUN_KEY`: bump `tanks.run.v1` → `tanks.run.v2`, and only that — no read-time translation of old data.** This is the one place this plan deliberately does NOT follow the "translate legacy data" instinct, and the reason is load-bearing: the migration-reality review that scored the winner highest (7/10, the best single-lens score across all 9 verdicts) verified this exact path end-to-end — under a bump, a stale `tanks.run.v1` record is simply invisible (`active()` returns `null`, as if no run had started), never misresolved. The SAME review's fatal flaw was that the winner's own text also *blessed* a no-bump alternative ("Either choice is defensible... feel free to skip the bump") and that alternative provably resolves a real save (`currentLevelId:'3'`) to `FIRST_CAMPAIGN_LEVEL` (level-01) while showing Continue as available and carrying a stale, mismatched life count — landing the player in a level-1 world with leftover lives from level 4. **This plan removes that alternative entirely.** The bump is the only sanctioned path. Consequence, stated plainly: an in-flight run (position + remaining lives for that attempt) is lost for any player who has one when this ships. Permanent progress (a separate, unbumped key, see below) is untouched — unlocked levels stay unlocked, New Game and Continue-from-level-1-equivalent keep working immediately. `SAVE_KEYS` needs no code edit (it imports `RUN_KEY` from `run.ts`, verified at `save.ts:6,51`); `save.test.ts`'s own pinned literal array (verified at `save.test.ts:21,43`, exactly 2 occurrences of `'tanks.run.v1'`) must move to `'tanks.run.v2'` — this SHOULD go red under the bump and stay green after the edit; that's the guard working, not a workaround. As a small hygiene addition beyond the winner's text (named "secondary, lower-severity" in that same review but easy and worth doing): `createRunStore` best-effort removes the orphaned `tanks.run.v1` key on construction (`try { storage.removeItem('tanks.run.v1'); } catch {}`), so it doesn't sit as permanently inert dead data in every returning player's `localStorage`.

**`PROGRESS_KEY` stays `tanks.progress.v1`; the stored VALUE format changes in place, with an eager, permanent, one-time write-back.** This is a deliberate departure from the "always bump on format change" instinct above, for a concrete reason: `save.test.ts` has ~20 fixtures using the literal `'tanks.progress.v1'` and the raw string `'3'` (verified by `grep -n "tanks.progress" src/game/save.test.ts`), and `save.ts` treats every key as an opaque string — those fixtures test `save.ts`'s pass-through behaviour, not `progress.ts`'s interpretation of the value, so they need zero changes either way. More importantly, a same-key migration is *safe here* in a way the run.ts case was not, because of two properties together: (1) old and new formats are structurally undconfusable (`JSON.parse` of a legacy value like `"3"` yields a `number`; the new format is always an object — no regex ambiguity like `run.ts`'s digit-string check had to guard against), and (2) the translation writes back **eagerly, at the moment it is first read**, so a legacy value is translated exactly once per browser and never re-interpreted against a later, possibly-reordered campaign.

The one gap that write-back-on-first-read does NOT close by itself: a player who never opens the game between #154 shipping and some future PR reordering the campaign would have their legacy value translated for the first time *after* the reorder, against the wrong order — this is the exact class of bug that sank the first design's `normalizeLevelId`. This plan closes it with a second, independent mechanism: legacy translation goes through a **frozen table**, not through live `CAMPAIGN_LEVELS`:
```ts
// A snapshot of what ordinal position N named, in ARENA identity, at the commit
// that added campaign.json. NEVER re-derived from CAMPAIGN_LEVELS, which is free
// to reorder after this ships — that is the whole point of the table.
const LEGACY_ORDINAL_ARENA_IDS: readonly string[] =
  ['arena-01', 'arena-02', 'arena-03', 'arena-04', 'arena-05']; // verified: this is
  // arenas.json's real id order today, via `grep '"id"' src/sim/config/data/arenas.json`
```
Legacy ordinal N translates to `LEGACY_ORDINAL_ARENA_IDS[N-1]` (an **arena** id, frozen forever) and THEN to `CAMPAIGN_LEVELS.find(l => l.arenaId === thatArenaId)?.id ?? null` (a **level** id, resolved against whatever the campaign looks like *right now*, at read time — which is correct even if reordered, since we're asking "where does arena-03 live today," not "what sat at position 3"). This is safe no matter how long the stale value sits on disk or how many reorders happen in between, because the table encodes identity (an arena id), never position. If a future PR removes an arena from the campaign entirely (not just reorders it), the lookup returns `undefined` and the legacy clear is dropped — same "corrupt data reads as reset" convention every other store already uses; this is a genuine, small residual and is named in Risks.

`highestCleared()` is **recomputed from the stored id on every call** (`CAMPAIGN_LEVELS.findIndex(l => l.id === storedId) + 1`, or 0 if not found), never cached as a number — this is what makes it correct after a future reorder: the id anchors to what was actually cleared, and its numeric position naturally updates to match wherever that level currently sits. `recordCleared(level: CampaignLevel)` generalizes today's `Math.max(shadow, level, read())` (`progress.ts:50`) into "keep whichever of {current shadow, the newly-cleared level, a fresh disk read} sits latest in the CURRENT campaign order" — same two-tab-safety property, expressed over ids instead of raw integers.

**The regression test that proves this is real, not assumed** (the standing "prove the gap before writing the test" rule): construct `createProgressStore(storage, reorderedFixtureLevels)` where `reorderedFixtureLevels` is a hand-built list with `arena-03` moved to position 1. Seed storage with the legacy bare value `"3"` (meaning "cleared through arena-03" under the ORIGINAL order). Construct the store and read `highestCleared()`: it must resolve via the frozen table to arena-03's id, then report **arena-03's position in the reordered fixture** (1), not "3" and not arena-03's old position. Revert the fix to a naive "translate N against whatever `CAMPAIGN_LEVELS` currently is, with no frozen table" and this test must fail — that is the falsifiable version of the property Design A's reviewers found unproven.

## Ordered steps (each keeps `npm test` green before the next starts)

1. **Pure addition.** `src/sim/config/campaign-types.ts`, `validateCampaign` + its negative-control tests in `validate.test.ts` (missing/empty `levels`, duplicate level id, bare-digit level id rejected — with a fixture proving the `/^\d+$/` guard actually fires, unknown `arenaId` rejected, and one fixture whose level order deliberately does NOT match `ARENA_DEFS`'s id order, asserting the returned `CampaignDefinition` preserves the INPUT order verbatim — this is the proof that campaign order and arena-catalog order are independent knobs, and it belongs here rather than waiting for a later step since it needs nothing but the validator). `src/sim/config/data/campaign.json`, `src/sim/config/campaign.ts`, `campaign.test.ts` (pin `CAMPAIGN.id === 'main'`, `CAMPAIGN_LEVELS.length === 5`, `CAMPAIGN_LEVELS[0].id === 'level-01'`, the set of `CAMPAIGN_LEVELS.map(l=>l.arenaId)` equals the set of `ARENA_DEFS` ids — a deliberate pin forcing a conscious edit the day an arena joins the catalog but not the campaign, or vice versa — `campaignLevelById` throws on an unknown id). Re-export from `src/sim/arena.ts`. Nothing consumes any of this yet; gate green by construction.

2. **`src/game/replay.ts` + `replay.test.ts`.** Rename `ReplayMeta.level` → `arenaId`; update `loop.ts`'s two `replayMetaFor(world, level)` call sites (`loop.ts:522, 720`) to `replayMetaFor(world, level.arenaId)` — this can land BEFORE `level` is retyped, since at this point `level` is still the pre-existing number and only the second argument's *expression* changes to `ARENAS[level].id` for now (it becomes `level.arenaId` naturally once Step 3 retypes `level`; doing it here first, against the still-numeric `level`, keeps this step's diff small and independently green). **In the same commit**, fix `tools/mutate/manifest.json`'s `replay-recorder-wraps-the-raw-controller` entry: its `find` string (verified byte-identical to `loop.ts:522` today: `"    ? createRecordingInput(effectiveInput, replayMetaFor(world, level))"`) must be updated to match the new line, and its `replace` string likewise. Verify with `npm run mutate -- --only replay-recorder-wraps-the-raw-controller` before moving on — this is the guard-integrity fatal flaw fix, and it is verifiable directly rather than by inspection. Update `loop.test.ts`'s 3 `.meta.level` reads (verified at lines 3605, 3612, 3632 today — re-grep before editing) to `.meta.arenaId`.

3. **The cutover (one coupled commit — `run.ts`, `levels.ts`, `loop.ts`, and their test files are mutually type-coupled and cannot land as three independently-green commits without a throwaway shim).**
   - `run.ts`: bump `RUN_KEY`, delete `levelIdFromIndex`/`levelIndexFromId`, retype `RunStore` to string ids, add the best-effort `tanks.run.v1` cleanup. `run.test.ts`: delete the `levelIdFromIndex`/`levelIndexFromId` describe block (verified at `run.test.ts:19-31`); rewrite the remaining ~13 `currentLevelId` fixtures (verified count via `grep -c currentLevelId src/game/run.test.ts`) from digit strings to real ids; add a test proving a stale `tanks.run.v1` record is invisible after construction (`active()` returns `null`) and that the orphaned key is gone from storage afterward.
   - `levels.ts`: retype `LevelSystem`, both branches, plus the injected `campaignLevels` parameter (default `CAMPAIGN_LEVELS`) grafted from the first design specifically to make the next test possible. `levels.test.ts`: rewrite `count`/`world`/`bounds` expectations against `CAMPAIGN_LEVELS`; add the invariant test `expect(sys.levels.includes(sys.start)).toBe(true)` for BOTH branches (sandbox and real) — nothing else would catch a future regression here, and it would surface only as `ordinalOf` silently returning 0, not a crash; **add the reordered-fixture regression test** — construct `createLevelSystem(flags, run, [CAMPAIGN_LEVELS[1], CAMPAIGN_LEVELS[0], ...CAMPAIGN_LEVELS.slice(2)])` (arena-02 and arena-01 swapped) and assert `sys.world(sys.levels[0], seed)` equals `createWorldFor(arenaById('arena-02'), seed)` — **not** arena-01. This is the assertion that actually fails if `levels.ts` ever reverts to indexing `ARENAS` by position; a mechanical swap of the old `ARENAS[i]` pin to `CAMPAIGN_LEVELS[i]` alone would stay numerically green under that exact regression, since today's shipped order is still 1:1.
   - `loop.ts`: retype `level`, add `ordinalOf`/`nextInSession`, rewrite the 10 `deps.levels.count` sites and 8 `level + 1` sites (re-grep both counts fresh before editing — CLAUDE.md's own convention: counts are a property of the tree at the moment you run them), collapse the win-branch `isFinalLevel` logic, fix the two `startNewRun`/`switchTo` literal-`0` sites, fix `recordCleared(level)`. `loop.test.ts`: rewrite `makeDeps`'s fake `LevelSystem` to build a small array of **interned** (built-once, reused-by-reference) synthetic `CampaignLevel` objects, with the fake's `start`/`world`/`bounds`/run-decorator indexing into that array via `Array.indexOf`/`findIndex`, translating id↔ordinal internally — this is what keeps the ~30+ existing `makeDeps({levelCount: N, savedRun: {level: N, lives: M}, ...})` call sites and every `rec.levelBuilds`/`rec.runAdvances` assertion untouched, since those stay expressed in plain numbers. Fix the 9 `currentLevelId: '<digit>'` fixtures (verified at lines 2060, 2076, 2091, 2116, 2156, 2240, 2262, 2334, 2348) to reference the interned array's real ids instead of digit-string literals. Fix the 3 hardcoded `'tanks.run.v1'` literals (verified at lines 335, 1991, 1993 — these are NOT the same as the 9 `currentLevelId` sites and are easy to miss since they concern the storage key, not the persisted value) to `'tanks.run.v2'`.
   - Run `npm test` (`tsc --noEmit && vitest run`) and confirm green before proceeding.

4. **`progress.ts` cutover.** Rewrite as specified in Data model/Migration: `recordCleared(level: CampaignLevel)`, the frozen `LEGACY_ORDINAL_ARENA_IDS` table, eager write-back on first read of a legacy value, the injected `campaignLevels` parameter. `progress.test.ts`: rewrite `recordCleared` call sites to pass `CampaignLevel` fixtures; add the reordered-fixture regression test from Migration (prove the gap first — revert the frozen table to a live `CAMPAIGN_LEVELS` lookup, confirm the new test fails, then restore); add a legacy-format test seeding `"3"` directly and asserting `highestCleared() === 3` immediately after construction AND that storage now holds the new object shape (read the raw string back and assert it does not parse to a bare number — reading back what was actually written, not trusting a zero exit). Update `loop.ts:1019`'s call site if not already covered by Step 3 (it is — both land in the same review pass regardless of literal commit boundaries, but keep them as separable diffs since `loop.ts` doesn't need `progress.ts`'s internals, only its new `recordCleared` signature).

5. **Achievements hardening (optional but recommended, small).** `achievements.test.ts:209`'s `ARENAS.reduce(...)` demolition-threshold sum moves to summing destructible walls over `CAMPAIGN_LEVELS.map(l => arenaById(l.arenaId))`. Numerically identical today (campaign mirrors `ARENA_DEFS` 1:1), so this closes a latent staleness gap (an arena shipped but never placed in the campaign would otherwise silently inflate the assumed playthrough count) rather than fixing an active defect.

6. **Prose-only cleanup, any order, lowest priority.** `devflags.ts`'s `level` flag doc comment: "index into ARENAS" → "index into CAMPAIGN_LEVELS." `arenas.ts:6-9`'s "array order is level order" comment: no longer true, becomes "array order is catalog order; campaign order lives in `campaign.ts`." `render/framing.test.ts:258`'s failure message: "a level was added" → "an arena was added" (the assertion itself, `ARENAS.length === 5`, correctly stays scoped to the raw catalog and needs no logic change). CLAUDE.md's "each `.v1`" sentence about the six `tanks.*` keys needs an edit in the same PR that lands the `RUN_KEY` bump (five of six stay `.v1`, one becomes `.v2`) — flagged here since this plan is read-only and cannot make that edit itself.

7. **Full gate + explicit re-verification.** `npm test`, `npm run mutate`, and `tools/baseline/trace.test.ts` specifically — confirm `BASELINE_HASH` is unchanged (expected: `ARENA_DEFS`/`ARENAS` content and order are untouched by every step above) rather than asserting it from the design alone.

## Pins that move, and what replaces each guarantee

- `run.ts:23` `RUN_KEY` literal `'tanks.run.v1'` → `'tanks.run.v2'` — the guarantee it protected ("the format of `currentLevelId` is a stringified `ARENAS` index") is retired outright; the new guarantee ("a stale v1 record is invisible, not misresolved") is proven by the new construction-time test in Step 3.
- `run.ts:81-92` (`levelIdFromIndex`/`levelIndexFromId`) — deleted; no successor function, because callers now pass real ids directly.
- `run.test.ts`'s round-trip test over `[0, 1, 7, 42]` — deleted with the functions it tested.
- `save.test.ts:21,43` — `'tanks.run.v1'` → `'tanks.run.v2'`; this test is DESIGNED to go red on a key rename, so its failure under the unmigrated diff is the guard working.
- `loop.test.ts:335,1991,1993` — same key literal, found by direct grep, not named in any design's own inventory; missing this leaves `savedRun`/`savedKeys` fixtures silently seeding a key the real store no longer reads (a false "no active run," not a compile error).
- `loop.test.ts`'s 9 `currentLevelId: '<digit>'` sites and 3 `.meta.level` sites — become real-id and `.meta.arenaId` respectively; population re-grepped fresh in Steps 2 and 3 rather than trusted from this document.
- `levels.ts:54,86,88,91,96,97` (the file's entire `ARENAS`-index surface) → `campaignLevels`/`arenaById(level.arenaId)`. The OLD guarantee ("this function resolves the Nth arena") is replaced by "this function resolves the Nth *campaign level*'s arena," proven by the new reordered-fixture test, not by the mechanically-swapped-but-numerically-identical old pin alone.
- `levels.test.ts:27,36` — move to campaign-based expected values AND gain the reordered-fixture injection test; the mechanical move alone would stay green under a regression to raw `ARENAS` indexing (today's 1:1 mapping hides it), so the injection test is what makes the guard real.
- `loop.ts`'s 10 `deps.levels.count` sites and 8 `level + 1` sites — replaced by `deps.levels.levels.length` and `ordinalOf(level)`/`nextInSession(level)` respectively, now three distinct expressions instead of one shared one, so a future divergence between arena order and campaign order becomes a type-level distinction rather than a coincidence.
- `replay.ts`'s `ReplayMeta.level: number` → `arenaId: string`, and the `tools/mutate/manifest.json` entry that names the call site it lives inside — fixed together in Step 2, verified via `npm run mutate -- --only <id>`, not merely inspected.
- `progress.ts`'s `highestCleared` — the guarantee "a returning player's unlock count is correct" no longer depends on the campaign never being reordered; it is proven by the frozen-table migration test in Step 4, which is a genuinely NEW property (nothing in any of the three original designs' own text proves this — it was the fatal flaw all three left standing).
- `arena-validation.test.ts:16-17` — explicitly NOT touched (verified its describe header scopes it to "EVERY shipped arena... New arenas added to ARENAS get all of this for free," unrelated to campaign order); the equivalent campaign-order claim lives in the new `campaign.test.ts` instead.

## Explicitly out of scope

Matches issue #154's own "Out of scope" section, re-verified via `gh issue view 154` rather than assumed: finalizing the complete campaign level count; finalizing the placement of every existing arena (this PR ships `campaign.json` as a 1:1 mirror of today's order — no reordering happens here); designing post-eleven content; adding player-facing names/thumbnails/mastery records to `CampaignLevel` (the type stays `{id, arenaId}` only, exactly as the issue's own sketch allows extending additively later). Also out of scope, named explicitly rather than silently dropped: arena reuse (one arena at two campaign positions) — `CampaignLevel.id === arenaId`-shaped 1:1 assumption is baked into today's `campaign.json`, though the type itself (`id` and `arenaId` as separate fields) already supports it once a real second-position use case exists; a `campaigns.json`-wrapping multi-campaign shape (the single-object root is a deliberate YAGNI call, reversible without touching `CampaignLevel`/`CampaignDefinition`); JSON-file-based `firstMission`-by-campaign-position validation (the difficulty-curve spec's `docs/superpowers/specs/2026-08-02-difficulty-curve-design.md:87` line describing this is, per the backlog's own spike, not implemented in the tree today regardless of #154).

## Open questions only Austin can settle

1. **Losing an in-flight run is an accepted, deliberate regression of this PR** (see Migration) — confirm that's acceptable, since it's a real, if narrow and one-time, player-facing UX hit at the moment this ships, distinct from #154's own required outcomes.
2. **Does the frozen `LEGACY_ORDINAL_ARENA_IDS` table's silent-drop behaviour (a legacy clear whose arena has since been removed from the campaign entirely is treated as "never cleared") need a louder signal** — e.g., a console warning in dev builds — or is silent-degrade-to-reset consistent enough with every other store's existing convention that no signal is warranted? This plan defaults to silent, matching the rest of the codebase, but it is a real (if narrow) loss of permanent progress under a scenario #154 itself makes newly possible (removing an arena from the campaign).
3. **Is a `CampaignLevel` id namespace collision with a future arena id worth guarding beyond the `/^\d+$/` check** — e.g., should `validateCampaign` also reject a level id equal to any known arena id, to keep the two namespaces visibly distinct in tooling/debugging output? Not required by the issue and not raised by any judge; flagged only because it's a one-line addition if wanted.
4. **Timing**: this plan is one coupled cutover commit (Step 3) plus a separate, smaller `progress.ts` commit (Step 4) — confirm that split is acceptable, versus wanting all persisted-state changes (`run.ts` + `progress.ts`) in one review pass since they're thematically the same migration even though they're not type-coupled to each other.

## Files touched (for the implementer's own tracking — not a promise; re-derive before treating as final per CLAUDE.md's "counts are a property of the tree at the moment you run them")

New: `src/sim/config/campaign-types.ts`, `src/sim/config/campaign.ts`, `src/sim/config/campaign.test.ts`, `src/sim/config/data/campaign.json`.
Changed (production): `src/sim/config/validate.ts`, `src/sim/arena.ts`, `src/game/run.ts`, `src/game/levels.ts`, `src/game/loop.ts`, `src/game/replay.ts`, `src/game/progress.ts`, `tools/mutate/manifest.json`, `src/game/devflags.ts` (comment only), `src/sim/config/arenas.ts` (comment only).
Changed (tests): `src/sim/config/validate.test.ts`, `src/game/run.test.ts`, `src/game/levels.test.ts`, `src/game/loop.test.ts`, `src/game/replay.test.ts`, `src/game/progress.test.ts`, `src/game/save.test.ts`, `src/game/achievements.test.ts` (optional hardening), `src/render/framing.test.ts` (wording only).
Doc: `CLAUDE.md` (the "each `.v1`" sentence, and its "Adding a level moves more pins than the level file" checklist gains a bullet for `campaign.json`/`CAMPAIGN_LEVELS`, since a new arena joining the catalog and a new level joining the campaign are now two separate, consciously-linked edits).