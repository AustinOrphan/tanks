---
status: superseded
date: 2026-08-02
last-reviewed: 2026-08-22
scope: Historical first stretch for the superseded fixed eleven-level arena sequence
implementation-issues: [298]
implementation-prs: []
supersedes: []
superseded-by: ["docs/superpowers/specs/2026-08-22-project-direction.md"]
---
# Difficulty Curve, Stretch 1 — Implementation Plan

> [!NOTE]
> Superseded by [Public prototype and campaign
> direction](../specs/2026-08-22-project-direction.md). This plan depends on the retired
> fixed-placement decision and contains pre-upscale arena geometry; preserve it as design
> and implementation history, not as executable current work.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the game a taught opening — two new levels of stationary browns before anything moves — and make the teaching order a rule the build enforces.

**Architecture:** Two new arenas are prepended to `config/data/arenas.json`, which renumbers the four existing levels to slots 3–6 (array order IS level order). `createArenaWorld` is first decoupled from `ARENAS[0]` so every seeded measurement keeps its meaning. Then `firstMission` — authored per tank and read by nothing today — becomes two load-time checks in `validateArenas`.

**Tech Stack:** TypeScript, vitest, JSON data validated at module load. No new dependencies.

## Global Constraints

- `src/sim/` imports nothing from `three`, `howler`, or the DOM. `src/sim/purity.test.ts` scans raw text **including strings and test titles**.
- `AGENTS.md` is a **symlink** to `CLAUDE.md`; edit `CLAUDE.md` only, and never replace the link with a copy (`tools/instructions.test.ts` fails if you do).
- No `Co-Authored-By` or tool-attribution trailers in commit messages.
- Every new assertion must be able to fail. Before adding one, name the production change that breaks it, apply that change, watch it fail, revert.
- **Commit before running any mutation experiment.** The revert step is `git checkout -- FILE`, which cannot distinguish your finished work from the deliberate breakage. This has destroyed real work three times in this repo.
- Write commit messages from `git diff --stat` / `git show`, never from recollection. If a message names a file, that file must be in the diff.
- State denominators: "32 of 36 (population: all 36 single-cell moves)", never a bare count.

**Scope note:** this stretch is levels 1–2 ONLY. The arc's levels 3–5 and 9–10 are deliberately deferred until levels 1–2 have been played. After this plan the sequence is **six** levels: two new, then arena-01, arena-02, arena-03, arena-04 at slots 3, 4, 5, 6.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/sim/arena.ts` | `createArenaWorld` stops meaning `ARENAS[0]` | 1 |
| `src/sim/config/data/arenas.json` | gains `arena-00a`, `arena-00b` at the front | 2 |
| `src/sim/config/data/tank-defs.json` | `firstMission` retuned to the new slots | 3 |
| `src/sim/config/validate.ts` | the two `firstMission` checks | 3 |
| `src/sim/config/arenas.ts` | passes the firstMission map into `validateArenas` | 3 |
| `src/sim/config/validate.test.ts` | negative controls for both checks | 3 |
| `src/sim/arena-validation.test.ts` | `EXPECTED_CLAIMS` + cover-ratio rows | 2 |
| `src/sim/cell-mapping.test.ts` | cell and spawn population pins | 2 |
| `CLAUDE.md` / `AGENTS.md` | the curve, and what `ARENAS[0]` now means | 4 |

---

### Task 1: Decouple the standard test arena from level 1

`ARENAS[0]` means two things today: *the first level the player sees* and *the standard test arena*. Task 2 changes the first. Everything that means the second must stop reading position.

**Files:**
- Modify: `src/sim/arena.ts:163-165`
- Read (classify, do not necessarily change): the 18 files listed in Step 1

**Interfaces:**
- Consumes: `arenaById(id: string): ArenaDefinition` from `src/sim/config/arenas.ts` (already exported, already imported by `arena.ts`).
- Produces: `createArenaWorld(seed?: number, unarmedTrigger?: UnarmedTrigger): World` — unchanged signature, now built from `arenaById('arena-01')`.

- [ ] **Step 1: Record the baseline you must not change**

Before touching anything, capture the two numbers this task must preserve:

```bash
cd /home/dev/src/tanks/.claude/worktrees/ai-vocabulary
npx vitest run src/sim/ai/pacifist.test.ts src/sim/determinism.test.ts --reporter=basic 2>&1 | tail -5
```

Write the pass counts into the task report file. Then list every consumer:

```bash
grep -rn "ARENAS\[0\]\|createArenaWorld\|ARENA_01" src/ tools/ --include=*.ts
```

Classify each hit in the report as **POSITION** (genuinely means "the first level" — level select, `levels.ts` `start`, progression) or **BOARD** (means "the standard 11x9 test arena"). Do not guess: read the surrounding code. Expect ~18 files.

- [ ] **Step 2: Write the failing test**

Add to `src/sim/arena.test.ts`:

```typescript
it('createArenaWorld builds arena-01 BY NAME, not whatever happens to be first', () => {
  // The two meanings of ARENAS[0] split here. Dozens of tests and the AI's headline
  // pacifist metric call createArenaWorld meaning "that specific 11x9 board"; the
  // difficulty curve puts new tutorial levels in front of it. Reading position would
  // have silently repointed every one of those measurements at a two-brown board.
  const named = loadArena(arenaById('arena-01'));
  const built = createArenaWorld(42);
  expect(built.walls.length).toBe(named.walls.length);
  expect(built.tanks.map((t) => t.kind).sort()).toEqual(named.tanks.map((t) => t.kind).sort());
  // The discriminating assertion: it must NOT track ARENAS[0] once that differs.
  expect(ARENAS[0].id).toBe('arena-01'); // true today; Task 2 makes it false
});
```

Add `arenaById` to the imports from `./config/arenas` and `ARENAS` from `./arena` if absent.

- [ ] **Step 3: Run it — it passes today, which is the point**

```bash
npx vitest run src/sim/arena.test.ts -t "BY NAME" --reporter=basic
```

Expected: PASS. This test cannot fail until Task 2 lands, so it is a *tripwire*, not proof. Note that explicitly in the report — do not claim it as verification.

- [ ] **Step 4: Make the change**

In `src/sim/arena.ts`, replace the body of `createArenaWorld`:

```typescript
export function createArenaWorld(seed?: number, unarmedTrigger?: UnarmedTrigger): World {
  return createWorldFor(arenaById('arena-01'), seed, unarmedTrigger);
}
```

Update its doc comment. It currently says it means "level 1" for dozens of tests. It now means *that specific board*, which is what those tests actually depend on — level 1 becomes a two-brown tutorial in Task 2.

- [ ] **Step 5: Prove the baseline is unchanged**

```bash
npm test 2>&1 | grep -E "Tests |Test Files"
```

Expected: identical pass count to Step 1. If any seeded measurement moved, the decoupling was wrong — stop and report, do not update the expected numbers.

- [ ] **Step 6: Commit**

```bash
git add src/sim/arena.ts src/sim/arena.test.ts
git commit -m "arena: createArenaWorld names arena-01 instead of reading ARENAS[0]"
```

---

### Task 2: Author levels 1 and 2, and renumber

**Files:**
- Modify: `src/sim/config/data/arenas.json` (prepend two entries)
- Modify: `src/sim/arena-validation.test.ts` (`EXPECTED_CLAIMS`, cover-ratio `EXPECTED`)
- Modify: `src/sim/cell-mapping.test.ts` (two population pins)

**Interfaces:**
- Consumes: the arena schema — `id`, `cols`, `rows`, `cellSize`, `legend`, `grid`, `notes`, `claims` — validated by `validateArenas`.
- Produces: arena ids `arena-00a` and `arena-00b` at array indices 0 and 1. Array order IS level order.

**Both boards below are already verified** against `validateArenas` and `structuralFailures`: they load, have no sealed pockets, and no enemy holds a line to the player spawn. Use them as given.

- [ ] **Step 1: Add level 1**

Prepend to the `arenas` array in `src/sim/config/data/arenas.json`:

```json
{
  "id": "arena-00a",
  "cols": 9, "rows": 7, "cellSize": 2,
  "legend": { "#": "solid", "x": "destructible" },
  "grid": [
    ".........",
    "..B...B..",
    ".........",
    "...###...",
    ".........",
    "....P....",
    "........."
  ],
  "notes": [
    "Level 1. Two browns, one wall, nothing that moves and nothing that breaks. The whole lesson is that the mouse aims, the click fires, and a shell kills -- there is no tutorial text anywhere in the game, so the board has to be simple enough that the only thing left to discover is the control.",
    "The row-3 block exists ONLY to satisfy the universal no-spawn-sightline rule. Both browns' lines to (4, 5) cross row 3 at columns 3 and 5, which is why it spans columns 3-5 rather than sitting centred: at 9 wide, a narrower block leaves both lines grazing its corners.",
    "9x7 is the smallest board the game ships, and deliberately so: the player should be able to see everything at once."
  ],
  "claims": []
}
```

- [ ] **Step 2: Add level 2**

Immediately after it:

```json
{
  "id": "arena-00b",
  "cols": 9, "rows": 7, "cellSize": 2,
  "legend": { "#": "solid", "x": "destructible" },
  "grid": [
    ".........",
    "..B...B..",
    ".....#.#.",
    "...##....",
    ".........",
    "....P....",
    "........."
  ],
  "notes": [
    "Level 2. Same two browns, more wall. Neither has a direct line from the player spawn but both are reachable by a ricochet, so the first shot of the level is a bank -- which is the lesson.",
    "It is NOT machine-checked, and that is deliberate rather than an oversight. A `bankOnly` claim was specified and withdrawn: zero direct lines requires full enclosure, which trips the sealed-pocket rule (measured: a fully walled brown gives 1 of 59 cells with a direct line and 58 of 59 breachable cells reachable), and the weaker 'few direct lines' form fails on the player's single ricochet -- the walls that deny the direct line deny the bounce leg too. See the spec's withdrawal section.",
    "So this level's lesson rests on design judgement and must be PLAYED to be validated. Levels 3-5 of the arc are deliberately not built until it has been."
  ],
  "claims": []
}
```

- [ ] **Step 3: Run the generic runner — it should pass unaided**

```bash
npx vitest run src/sim/arena-validation.test.ts --reporter=basic
```

Expected: FAIL, on `EXPECTED_CLAIMS` and the cover-ratio table only — both are set-equality tables keyed by arena id, so a new arena must be declared in them. The per-arena structural and claim tests should PASS for both new boards. If a structural test fails, the grid is wrong: stop and report.

- [ ] **Step 4: Declare the new arenas in both tables**

In `src/sim/arena-validation.test.ts`, add to `EXPECTED_CLAIMS`:

```typescript
  'arena-00a': {},
  'arena-00b': {},
```

An empty object is correct and meaningful: both levels declare zero claims, and the table asserts that exactly.

Then run this one-off to get the real cover-ratio numbers rather than guessing them:

```bash
npx vitest run src/sim/arena-validation.test.ts -t "recomputes every quoted count" --reporter=basic 2>&1 | grep -E "expected|unseen"
```

Add the two rows the failure names to the `EXPECTED` table in that describe block.

- [ ] **Step 5: Move the population pins**

`src/sim/cell-mapping.test.ts` asserts totals across all arenas plus the fixture. Both boards are 9x7 = 63 cells with 3 spawns each (2 brown + 1 player).

```bash
npx vitest run src/sim/cell-mapping.test.ts --reporter=basic 2>&1 | grep -E "expected"
```

Update `expect(checked).toBe(...)` and `expect(spawnsChecked).toBe(...)` to the numbers the failures name, and update the arithmetic in the comments above each — they spell out the population and must stay true.

- [ ] **Step 6: Verify the whole gate**

```bash
npm test 2>&1 | grep -E "Tests |Test Files"
npm run build 2>&1 | tail -1
```

Expected: all pass. The pacifist and determinism suites must still pass unchanged — Task 1 is what makes that true, and this step is where it is proven.

- [ ] **Step 7: Prove the new pins can fail**

Commit first (the constraint at the top of this plan), then:

```bash
git add -A && git commit -m "levels: a taught opening -- two brown-only boards ahead of arena-01"
python3 -c "
import json;p='src/sim/config/data/arenas.json';d=json.load(open(p))
a=[x for x in d['arenas'] if x['id']=='arena-00a'][0]
a['grid'][3]='.........'
json.dump(d,open(p,'w'),indent=2,ensure_ascii=False);open(p,'a').write('\n')"
npx vitest run src/sim/arena-validation.test.ts --reporter=basic 2>&1 | grep -E "×|→" | head -4
git checkout -- src/sim/config/data/arenas.json
```

Expected: removing level 1's only wall produces a `spawn sightline` structural failure naming a brown, proving the board's one wall is load-bearing and the runner sees the new arenas. Record the real output in the report.

---

### Task 3: Make `firstMission` a rule

`firstMission` is authored per tank and **nothing reads it**. Two checks turn the teaching order into a property the build enforces.

**Files:**
- Modify: `src/sim/config/data/tank-defs.json` (retune five values)
- Modify: `src/sim/config/validate.ts` (add the checks to `validateArenas`)
- Modify: `src/sim/config/arenas.ts` (supply the firstMission map)
- Modify: `src/sim/config/validate.test.ts` (negative controls)

**Interfaces:**
- Consumes: `validateArenas(raw: unknown, file?: string)` at `validate.ts:322`; `GAME_TANK_DEFS: Record<TankKind, TankDefinition>` from `roster.ts:38`; `SPAWN_LETTERS: Record<string, TankKind>` from `arena-types.ts`.
- Produces: `validateArenas(raw: unknown, file: string | undefined, firstMissionByKind: Partial<Record<TankKind, number>>): ArenaDefinition[]`.

**The parameter is not optional and must not be an import.** `roster.ts` imports `validate.ts`, so `validate.ts` importing `roster.ts` is a cycle. Passing the map in from `arenas.ts` (which may import `roster.ts` freely — nothing imports `arenas.ts` from there) keeps the dependency one-way, and lets the negative controls pass synthetic maps.

- [ ] **Step 1: Retune the values**

In `src/sim/config/data/tank-defs.json`, set `firstMission` to the slot each tank now debuts in. After Task 2 the sequence is six levels: `arena-00a`, `arena-00b`, `arena-01`, `arena-02`, `arena-03`, `arena-04`.

| tank | firstMission | debuts in |
|---|---|---|
| player | 0 | exempt — in every level |
| brown | 1 | arena-00a |
| grey | 3 | arena-01 |
| teal | 3 | arena-01 |
| olive | 5 | arena-03 |
| green | 6 | arena-04 |

Note grey and teal share slot 3: arena-01 introduces both at once. That is exactly the mis-ordering the arc is meant to fix, and it stays true until levels 3–5 are built. Say so in the JSON comment-free way available — put it in the task report, and Task 4 records it in `CLAUDE.md`.

- [ ] **Step 2: Write the failing tests**

Add to `src/sim/config/validate.test.ts`:

```typescript
describe('firstMission is enforced against the level sequence', () => {
  const shape = {
    cols: 3, rows: 3, cellSize: 2,
    legend: { '#': 'solid' },
    notes: ['fixture'], claims: [],
  };
  const lvl = (id: string, grid: string[]) => ({ ...shape, id, grid });

  it('rejects a tank appearing BEFORE its firstMission', () => {
    expect(() => validateArenas(
      { arenas: [lvl('a', ['...', '.P.', 'G..'])] },
      'fixture.json',
      { player: 0, grey: 2 },
    )).toThrow(/grey.*firstMission 2.*level 1/);
  });

  it('accepts the same tank at or after its firstMission', () => {
    expect(() => validateArenas(
      { arenas: [lvl('a', ['...', '.P.', 'B..']), lvl('b', ['...', '.P.', 'G..'])] },
      'fixture.json',
      { player: 0, brown: 1, grey: 2 },
    )).not.toThrow();
  });

  it('rejects a firstMission naming a level that does NOT contain the tank', () => {
    // The floor alone is satisfied here -- grey appears at level 2, which is >= 2.
    // What fails is that level 2 must be grey's actual DEBUT, or the number is fiction.
    expect(() => validateArenas(
      { arenas: [lvl('a', ['...', '.P.', 'B..']), lvl('b', ['...', '.P.', 'B..'])] },
      'fixture.json',
      { player: 0, brown: 1, grey: 2 },
    )).toThrow(/grey.*firstMission 2.*does not contain/);
  });

  it('does not check a debut beyond the end of the sequence', () => {
    // green debuts at 6; a two-level fixture cannot satisfy that and must not be
    // required to. Only the floor applies out here.
    expect(() => validateArenas(
      { arenas: [lvl('a', ['...', '.P.', 'B..'])] },
      'fixture.json',
      { player: 0, brown: 1, green: 6 },
    )).not.toThrow();
  });
});
```

- [ ] **Step 3: Run them and watch them fail**

```bash
npx vitest run src/sim/config/validate.test.ts -t "firstMission is enforced" --reporter=basic
```

Expected: FAIL — `validateArenas` takes two arguments today, so the third is ignored and nothing throws.

- [ ] **Step 4: Implement**

In `src/sim/config/validate.ts`, change the signature and add the checks after the per-arena loop that already exists in `validateArenas`:

```typescript
export function validateArenas(
  raw: unknown,
  file = 'arenas.json',
  firstMissionByKind: Partial<Record<TankKind, number>> = {},
): ArenaDefinition[] {
```

After the arenas are validated and before returning, add:

```typescript
  // The teaching order, enforced. `firstMission` is authored per tank in tank-defs.json
  // and was read by nothing until the difficulty curve; these two checks are what stop it
  // drifting back into decoration. The map is a PARAMETER rather than an import because
  // roster.ts imports this module -- importing it back would be a cycle.
  //
  // The player is exempt: firstMission 0, present in every level by definition.
  const debutOf = new Map<TankKind, number>();
  for (const [i, arena] of arenas.entries()) {
    const level = i + 1; // 1-based: array order IS level order
    for (const row of arena.grid) {
      for (const ch of row) {
        const kind = SPAWN_LETTERS[ch];
        if (!kind || kind === 'player') continue;
        if (!debutOf.has(kind)) debutOf.set(kind, level);
        const floor = firstMissionByKind[kind];
        if (floor !== undefined && level < floor) {
          fail(file, `arenas[${i}]`,
            `contains ${kind}, whose firstMission ${floor} is later than level ${level}`);
        }
      }
    }
  }
  // The converse. Without it the number is fiction: a tank could carry firstMission 3 and
  // first appear at 9, satisfying the floor while documenting an order nobody follows.
  // Only checked where the sequence is long enough to contain the debut.
  for (const [kind, floor] of Object.entries(firstMissionByKind) as Array<[TankKind, number]>) {
    if (kind === 'player' || floor < 1 || floor > arenas.length) continue;
    if (debutOf.get(kind) !== floor) {
      fail(file, `arenas[${floor - 1}]`,
        `${kind} has firstMission ${floor}, but that level does not contain it ` +
        `(actual debut: ${debutOf.get(kind) ?? 'never'})`);
    }
  }
```

- [ ] **Step 5: Wire the real map in**

In `src/sim/config/arenas.ts`:

```typescript
import { GAME_TANK_DEFS } from './roster';

const FIRST_MISSION = Object.fromEntries(
  Object.entries(GAME_TANK_DEFS).map(([kind, def]) => [kind, def.firstMission]),
) as Partial<Record<TankKind, number>>;
```

and pass `FIRST_MISSION` as the third argument to the existing `validateArenas(arenasJson)` call. Add the `TankKind` type import.

- [ ] **Step 6: Run everything**

```bash
npx tsc --noEmit
npm test 2>&1 | grep -E "Tests |Test Files"
```

Expected: all pass. If the real data throws at load, the retune in Step 1 is wrong — the error names the arena and the tank, so fix the data, not the rule.

- [ ] **Step 7: Prove the rule bites on real data**

Commit first, then mutate the shipped file:

```bash
git add -A && git commit -m "config: enforce firstMission against the level sequence"
python3 -c "
import json,collections;p='src/sim/config/data/tank-defs.json'
d=json.load(open(p),object_pairs_hook=collections.OrderedDict);d['grey']['firstMission']=1
json.dump(d,open(p,'w'),indent=2,ensure_ascii=False);open(p,'a').write('\n')"
npx vitest run src/sim/config/validate.test.ts --reporter=basic 2>&1 | grep -E "×|→|does not contain" | head -3
git checkout -- src/sim/config/data/tank-defs.json
```

Expected: setting grey's `firstMission` to 1 fails the debut-is-real check, because level 1 is a brown-only board. Record the real output.

---

### Task 4: Documentation and the final gate

**Files:**
- Modify: `CLAUDE.md`, then copy to `AGENTS.md`

- [ ] **Step 1: Record the curve**

Add to `CLAUDE.md`, near the arenas-as-data section:

```markdown
**Levels are a taught curve, and `firstMission` enforces it.** Array order in
`arenas.json` IS level order. Each tank's `firstMission` (tank-defs.json) is checked
twice at load: no level may contain a tank whose `firstMission` is later, and the level
numbered `firstMission` must actually contain it, so the number cannot be fiction. The
map is passed INTO `validateArenas` as a parameter rather than imported, because
`roster.ts` imports `validate.ts` and the reverse would be a cycle.

`ARENAS[0]` no longer means "the standard test arena" — level 1 is a two-brown tutorial.
`createArenaWorld` names `arena-01` explicitly, which is what the AI's pacifist metric and
dozens of tests actually depend on. Anything meaning "that specific 11x9 board" must use
the name; only genuine first-level logic reads position.

**The arc is eleven levels; six exist.** Levels 3-5 and 9-10 are unbuilt, so grey and teal
still share a debut at arena-01 and green's `firstMission` is 6 rather than 11. Building
those stretches moves the numbers, and the debut-is-real check fails loudly if the retune
is forgotten. See `docs/superpowers/specs/2026-08-02-difficulty-curve-design.md`.

**Nothing automated can tell you whether a level teaches.** The difficulty probes are a
floor check only — both bots ignore cover, which biases them against exactly the enemies
the curve is built around (green scores 28/30 against the shooting bot because it exists
to punish players who hide, and the bot never hides). A `bankOnly` claim was specified and
withdrawn as geometrically impossible; the spec records why. Levels 1-2 must be PLAYED
before 3-5 are built.
```

- [ ] **Step 2: Sync and verify byte-identical**

```bash
# AGENTS.md is a SYMLINK to CLAUDE.md -- editing CLAUDE.md is the whole job.
git ls-files -s AGENTS.md   # expect mode 120000
```

- [ ] **Step 3: Full gate**

```bash
npm test 2>&1 | grep -E "Tests |Test Files"
npm run build 2>&1 | tail -1
npm run test:gl 2>&1 | grep -E "FAIL|all [0-9]+ GL"
```

`test:gl` matters here: two new board sizes (9x7) reach the per-level render refit for the first time. Expected: all 32 GL checks pass.

- [ ] **Step 4: Measure the two new levels**

Write a temporary probe (delete before committing) that runs 40 seeded pacifist games on each of the six levels and reports free wins, player deaths, timeouts and median time-to-kill — the same shape used for arena-04. Record the table in the task report.

The floor to check: **a level whose enemies never kill a wandering pacifist in 40 seeds is not applying pressure.** Level 1 is expected to be the least lethal board in the game by a wide margin; that is correct, not a failure. Report the numbers; do not tune the boards to hit a target.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md AGENTS.md
git commit -m "docs: the taught curve, and what ARENAS[0] stops meaning"
```

---

## Self-Review

**Spec coverage.** Renumber-not-rewrite → Task 2. Full arc designed, first stretch built → scope note, Task 2. `firstMission` enforced at load → Task 3. Opening is two levels → Task 2. Decoupling `createArenaWorld` → Task 1. No new claim type → explicit in Task 2's notes and the spec. Population pins move → Task 2 Steps 4–5. Playability floor probe → Task 4 Step 4. Renumbering fidelity → Task 1 Steps 1 and 5.

**Gap accepted deliberately:** the spec's arc has grey debuting at 3 and teal at 6. With levels 3–5 unbuilt, both debut together at arena-01, so this stretch cannot honour that separation. Task 3 Step 1 states it and Task 4 records it in `CLAUDE.md` rather than letting it pass silently.

**Placeholders:** none. Both grids are verified, both validator checks are written out, every expected failure names what it should say.

**Type consistency:** `validateArenas(raw, file, firstMissionByKind)` is used identically in Task 3 Steps 2, 4 and 5. `arenaById(id: string): ArenaDefinition` matches `arenas.ts:19`. `GAME_TANK_DEFS: Record<TankKind, TankDefinition>` matches `roster.ts:38`. `SPAWN_LETTERS` is already imported by `validate.ts:13`.
