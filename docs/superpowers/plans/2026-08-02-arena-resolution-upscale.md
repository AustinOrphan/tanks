# Arena Resolution Upscale Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move all four shipped arenas from `cellSize 2` to `cellSize 2/3` by a 3× upscale that changes **no geometry, no spawn position and no seeded outcome** — so that later levels can author walls two-thirds of a tank wide.

**Architecture:** Each old cell becomes a 3×3 block of new cells covering the identical world span. Wall cells fill their block; a spawn letter takes the block's **centre** sub-cell, whose world centre is exactly the old cell's centre. Claim coordinates remap `[c,r] → [3c+1, 3r+1]`. Nothing about wall thickness changes in this plan — every wall stays 2.0 wide, now expressed as 3 cells instead of 1. Thinning is a later, per-level design edit.

**Tech Stack:** TypeScript, vitest, JSON data validated at module load. No new dependencies.

## Global Constraints

- `src/sim/` imports nothing from `three`, `howler`, or the DOM. `purity.test.ts` scans raw text **including strings and test titles**.
- `AGENTS.md` is a **symlink** to `CLAUDE.md`; edit `CLAUDE.md` only (`tools/instructions.test.ts` pins the link).
- No `Co-Authored-By` or tool-attribution trailers.
- **Commit before any mutation experiment.** `git checkout -- FILE` cannot tell your finished work from deliberate breakage; it has destroyed real work three times in this repo.
- Write commit messages from `git diff --stat` / `git show`, never from recollection.
- State denominators. "33 of 33 cell references (population: every `from`/`to` in all 27 claims)", never a bare count.
- **This plan's headline claim is that nothing observable changed.** Any step that "fixes" a number rather than preserving it is a defect in the transform — stop and report, do not re-pin.

## Scope

**In:** the 3× upscale of `arena-01`..`arena-04`, claim-coordinate remapping, notes-prose remapping, and the pins that move as a consequence.

**Out:** the clearance/traversability rule, the killability rule, barriers, one-way ledges, thinning any actual wall, and any new level. Each lands separately, on top of this.

**The alternative that was considered and rejected, recorded so it is not re-litigated:**
`cellSize` is per-arena and the validator requires only `> 0`, so arenas of *different*
resolutions can ship side by side — demonstrated, with screenshots, by running a `2/3`
board as level 5 alongside the four `cellSize 2` levels. That would let new levels be
authored at `2/3` while existing ones stay untouched, avoiding this entire plan. It was
rejected because levels would visibly disagree about wall thickness, which reads as
inconsistency rather than variety. Noted because it remains the cheap escape hatch if this
migration proves more expensive than expected.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `tools/upscale-arenas.mjs` | one-time transform, committed as the record of what was done | 2 |
| `src/sim/config/data/arenas.json` | the upscaled grids, remapped claims, remapped prose | 2, 3 |
| `src/sim/arena.test.ts` | wall-count and AABB assertions for `ARENA_01` | 4 |
| `src/sim/cell-mapping.test.ts` | cell and spawn population pins | 4 |
| `src/sim/arena-validation.test.ts` | cover-ratio `EXPECTED` table | 4 |
| `src/sim/resolution.test.ts` | **new** — pins the properties that make this a no-op | 2 |
| `CLAUDE.md` / `AGENTS.md` | what `cellSize` now is and why | 5 |

---

### Task 1: Capture the baseline you must reproduce

Nothing is changed in this task. Its only output is the set of numbers Task 5 must match.

**Files:** none modified. Write results to the task report file.

- [ ] **Step 1: Record the seeded baselines**

```bash
cd /home/dev/src/tanks/.claude/worktrees/ai-vocabulary
npm test 2>&1 | grep -E "Tests |Test Files"
npx vitest run src/sim/ai/pacifist.test.ts --reporter=basic 2>&1 | grep -E "Tests |×"
```

- [ ] **Step 2: Record a trace fingerprint over all four arenas**

Create `tools/baseline/trace.test.ts` (temporary — deleted in Task 5).

**It must live under `tools/`, NOT `src/sim/`.** `purity.test.ts` scans every file under
`src/sim/` and rejects `node:crypto` twice over — "reaches a Node builtin" and "forbidden
non-determinism". Verified: the identical probe fails 2 purity tests in `src/sim/` and
passes under `tools/`. Vitest picks up `tools/**` tests already (`tools/gallery/args.test.ts`
runs today).

```typescript
import { describe, it } from 'vitest';
import { ARENAS, createWorldFor } from '../../src/sim/arena';
import { step } from '../../src/sim/world';
import { createHash } from 'node:crypto';

describe('baseline', () => {
  it('fingerprint', () => {
    const h = createHash('sha256');
    for (let a = 0; a < ARENAS.length; a++) {
      for (let seed = 1; seed <= 6; seed++) {
        let w = createWorldFor(ARENAS[a], seed);
        for (let t = 0; t < 2500 && w.status === 'playing'; t++) {
          const d = { x: Math.cos(t / 37), y: Math.sin(t / 41) };
          w = step(w, { move: d, aim: d, fire: t % 23 === 0, mine: t % 311 === 0 }).world;
          if (t % 100 === 0) {
            h.update(w.tanks.map((k) =>
              `${k.pos.x.toFixed(9)},${k.pos.y.toFixed(9)},${k.turretAngle.toFixed(9)},${k.alive}`).join('|'));
          }
        }
        h.update(`|${a}:${seed}:${w.status}:${w.tick}|`);
      }
    }
    console.log(`BASELINE ${h.digest('hex')}`);
  }, 300_000);
});
```

Run it and record the full hash in the report:

```bash
npx vitest run tools/baseline/trace.test.ts --reporter=basic 2>&1 | grep BASELINE
```

- [ ] **Step 3: Record per-arena geometry**

```bash
npx vitest run src/sim/arena-validation.test.ts -t "recomputes every quoted count" --reporter=basic 2>&1 | tail -3
python3 -c "
import json
d=json.load(open('src/sim/config/data/arenas.json'))
for a in d['arenas']:
    print(a['id'], a['cols'], 'x', a['rows'], '@', a['cellSize'], ' claims', len(a['claims']))"
```

- [ ] **Step 4: Commit the probe as WIP**

It is committed deliberately, not left dirty: the Global Constraints require a commit before
any mutation experiment, and Task 2 runs a transform over the same tree. Task 5 re-runs the
probe and then deletes it, so it never reaches the final branch. Record its path and the
baseline hash in the report.

```bash
git add tools/baseline/trace.test.ts
git commit -m "wip: baseline trace probe, deleted once the upscale is verified"
```

---

### Task 2: The transform

**Files:**
- Create: `tools/upscale-arenas.mjs`
- Create: `src/sim/resolution.test.ts`
- Modify: `src/sim/config/data/arenas.json`

**Interfaces:**
- Produces: every arena at `cols*3`, `rows*3`, `cellSize: 0.6666666666666666`. Claim cells remapped `[c,r] → [3c+1, 3r+1]`. Spawn letters in the centre sub-cell of their block.

- [ ] **Step 1: Write the transform**

Create `tools/upscale-arenas.mjs`:

```javascript
/**
 * ONE-TIME 3x upscale of every shipped arena: cellSize 2 -> 2/3.
 *
 * Committed as the record of exactly what was done to the data, not as a tool anyone
 * runs again. Re-running it on already-upscaled data would produce 9x, so it refuses
 * unless every arena is still at cellSize 2.
 *
 * Why 3 and not 2: an ODD factor keeps every old cell centre as a new cell centre, so
 * spawns do not move and no seeded outcome changes. An even factor puts the old centre
 * on a boundary between two new cells. Verified in src/sim/resolution.test.ts.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const N = 3;
const PATH = 'src/sim/config/data/arenas.json';
const SPAWN = /[PBGTON]/;

const data = JSON.parse(readFileSync(PATH, 'utf8'));
for (const a of data.arenas) {
  if (a.cellSize !== 2) {
    console.error(`${a.id} is at cellSize ${a.cellSize}, not 2 — refusing to upscale twice.`);
    process.exit(1);
  }
}

const mid = (N - 1) / 2; // 1 for N=3: the centre sub-cell

for (const a of data.arenas) {
  const grid = [];
  for (const row of a.grid) {
    for (let sr = 0; sr < N; sr++) {
      let out = '';
      for (const ch of row) {
        if (!SPAWN.test(ch)) { out += ch.repeat(N); continue; }
        // A spawn letter must NOT be duplicated: one letter, one tank. It takes the
        // block's centre sub-cell; the other eight become plain floor.
        for (let sc = 0; sc < N; sc++) out += (sr === mid && sc === mid) ? ch : '.';
      }
      grid.push(out);
    }
  }
  a.grid = grid;
  a.cols *= N;
  a.rows *= N;
  a.cellSize = 2 / N;
  for (const c of a.claims) {
    for (const key of ['from', 'to', 'enemy']) {
      if (Array.isArray(c[key])) c[key] = [c[key][0] * N + mid, c[key][1] * N + mid];
    }
  }
}

writeFileSync(PATH, JSON.stringify(data, null, 2) + '\n');
console.log(data.arenas.map((a) => `${a.id} -> ${a.cols}x${a.rows} @ ${a.cellSize}`).join('\n'));
```

- [ ] **Step 2: Write the test that makes this a no-op claim, before running it**

Create `src/sim/resolution.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { ARENA_DEFS } from './config/arenas';
import { loadArena } from './arena';

// What makes a 3x upscale safe, pinned so nobody "tidies" it to an even factor.
describe('the arena resolution', () => {
  it('is 2/3 on every shipped arena', () => {
    for (const a of ARENA_DEFS) expect(a.cellSize, a.id).toBeCloseTo(2 / 3, 12);
  });

  it('places every spawn on a coordinate the old cellSize-2 grid also had', () => {
    // THE property the migration rests on. An old cell c at cellSize 2 had its centre at
    // 2c+1; the centre sub-cell of its 3x3 block is at (3c+1.5)*(2/3), which float64
    // rounds to exactly 2c+1. An even upscale cannot do this -- the old centre lands on a
    // boundary BETWEEN two new cells -- which is why the factor is 3 and not 2.
    for (const a of ARENA_DEFS) {
      for (const s of loadArena(a).spawns) {
        for (const v of [s.pos.x, s.pos.y]) {
          expect(Number.isInteger((v - 1) / 2), `${a.id} spawn at ${v}`).toBe(true);
        }
      }
    }
  });

  it('keeps float64 exact across the whole coordinate range boards use', () => {
    // Not a mathematical guarantee -- 2/3 is not representable in binary -- but an
    // empirical property of float64 rounding, so it is checked rather than assumed.
    // Population: cells 0..59, covering the largest shipped board (15*3 = 45 cols).
    for (let c = 0; c < 60; c++) {
      expect((3 * c + 1 + 0.5) * (2 / 3), `cell ${c}`).toBe((c + 0.5) * 2);
    }
  });
});
```

- [ ] **Step 3: Run it — the first two fail, the third passes**

```bash
npx vitest run src/sim/resolution.test.ts --reporter=basic
```

Expected: `cellSize` and spawn tests FAIL (data still at 2), float64 test PASSES. That
third test passing *before* the transform is what proves the factor choice is sound rather
than lucky.

- [ ] **Step 4: Apply the transform**

```bash
git add -A && git commit -m "wip: resolution pins before the upscale"
node tools/upscale-arenas.mjs
```

- [ ] **Step 5: Read back what it wrote**

Do not trust the exit code.

```bash
python3 -c "
import json
d=json.load(open('src/sim/config/data/arenas.json'))
for a in d['arenas']:
    spawns=[(c,r,ch) for r,row in enumerate(a['grid']) for c,ch in enumerate(row) if ch in 'PBGTON']
    print(f\"{a['id']}: {a['cols']}x{a['rows']} @ {a['cellSize']}  spawns={len(spawns)}  claims={len(a['claims'])}\")
    assert a['cols'] % 3 == 0 and a['rows'] % 3 == 0
    for s in spawns: assert s[0] % 3 == 1 and s[1] % 3 == 1, f'spawn off centre: {s}'
print('every spawn sits on a block centre')"
npx vitest run src/sim/resolution.test.ts --reporter=basic
```

Expected: all three resolution tests now pass; spawn counts unchanged from Task 1.

---

### Task 3: Remap the prose

The grids and claim coordinates are machine-transformed. The `notes` are not — they contain
roughly 22 coordinate references across the four arenas (`(4, 1)`, `column 5`, `row 4`),
every one of which now names the wrong cell.

**Files:** Modify `src/sim/config/data/arenas.json` (`notes` only)

- [ ] **Step 1: Find every coordinate mention**

```bash
python3 -c "
import json, re
d=json.load(open('src/sim/config/data/arenas.json'))
for a in d['arenas']:
    for i,n in enumerate(a['notes']):
        for m in re.finditer(r'\(\d+,\s*\d+\)|column \d+|row \d+|columns \d+-\d+|rows \d+-\d+', n):
            print(f\"{a['id']} note[{i}]: {m.group(0)}\")"
```

- [ ] **Step 2: Rewrite each one by hand**

The mapping is `old -> old*3 + 1` for a single cell coordinate, and a *range* of old columns
`a-b` becomes `3a` to `3b+2`. Do this by reading each sentence and asking what it is
claiming, not by regex: several notes say things like "the bar's solid cells at columns 5, 7
and 9", where the sentence means *those walls*, which are now three-cell runs.

Prefer rewriting the sentence to name the feature rather than restating coordinates where
the coordinate was incidental. A note that says "the row-4 bar" is clearer than one that
says "the row-12-to-14 bar", and it stops being wrong the next time resolution changes.

- [ ] **Step 3: Verify no stale coordinate survives**

Re-run Step 1's script. Every remaining coordinate must be one you deliberately rewrote.
Cross-check three at random against the actual grid — read the cell out of `grid[row][col]`
and confirm it is what the sentence says it is.

- [ ] **Step 4: Commit**

```bash
git add src/sim/config/data/arenas.json
git commit -m "arenas: 3x upscale to cellSize 2/3, with claims and prose remapped"
```

---

### Task 4: Move the pins that legitimately move

Cell *counts* change (9× the cells); geometry does not. Each pin below must move for the
right reason — because the grid is finer, never because a measurement drifted.

**Files:** `src/sim/cell-mapping.test.ts`, `src/sim/arena.test.ts`, `src/sim/arena-validation.test.ts`

- [ ] **Step 1: See what fails**

```bash
npm test 2>&1 | grep -E "×|→" | head -20
```

- [ ] **Step 2: Cell and spawn totals**

`cell-mapping.test.ts` pins total cells and total spawns across all arenas plus the fixture.
**Spawns must NOT change** — if `spawnsChecked` moved, the transform duplicated or dropped a
spawn and Task 2 is wrong. Cells become 9× per shipped arena (the fixture is untouched).
Update the numbers and the arithmetic in the comments above them, which spell out the
population.

- [ ] **Step 3: Wall counts and AABBs**

`arena.test.ts` asserts `ARENA_01`'s solid/destructible cell counts and specific wall
extents. Counts become 9× per wall cell; the boundary-ring thickness becomes `cellSize`
(now 2/3, was 2), so ring-relative assertions change. **Extents of interior walls in world
units must not change** — those are the geometry, and if one moved, report it rather than
updating it.

- [ ] **Step 4: Cover ratios**

`arena-validation.test.ts`'s `EXPECTED` table counts open cells. Denominators go up ~9×.
The *ratios* should stay close to their old values — a large ratio shift means sightlines
changed, which this transform must not do. Record old and new ratios side by side in the
report and comment on any that moved more than a point.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "tests: move the population pins the finer grid legitimately moves"
```

---

### Task 5: Prove nothing observable changed

**Files:** delete `tools/baseline/trace.test.ts` at the end.

- [ ] **Step 1: Re-run the fingerprint**

```bash
npx vitest run tools/baseline/trace.test.ts --reporter=basic 2>&1 | grep BASELINE
```

Expected: **byte-identical** to Task 1's hash. This is the plan's headline claim. If it
differs, the transform changed the game — stop, report, and do not proceed. Likely causes,
in order: a spawn not on a block centre, a claim cell mis-remapped, or a wall run that
gained or lost a cell at a board edge.

- [ ] **Step 2: Re-run the pacifist metric**

```bash
npx vitest run src/sim/ai/pacifist.test.ts --reporter=basic 2>&1 | grep -E "Tests |×"
```

Expected: identical to Task 1. The free-win rate is the AI's headline number and it runs on
`arena-01`; an unchanged rate is independent corroboration of Step 1.

- [ ] **Step 3: Full gate, including the browser**

```bash
npx tsc --noEmit
npm test 2>&1 | grep -E "Tests |Test Files"
npm run build 2>&1 | tail -1
npm run test:gl 2>&1 | grep -E "FAIL|all [0-9]+ GL"
```

`test:gl` matters: the per-level refit now frames boards at a non-integer `cellSize`, which
the renderer has never done in a shipped level. Expected: all 32 GL checks pass.

- [ ] **Step 4: Look at it**

Screenshot each of the four levels and compare against the same shot on `main`. Geometry
should be pixel-comparable; only the wall seam lines differ, because a 2.0 wall is now three
1-cell segments rather than one.

```bash
node /home/dev/.claude/jobs/34bc5380/tmp/shoot.mjs 5231 '?dev=1&level=1&seed=7' /tmp/after-1.png
```

(The screenshot helper loads Playwright from the stash path `tools/gl/run.mjs` uses; a bare
`import 'playwright'` fails on this box.)

- [ ] **Step 5: Delete the probe and commit**

```bash
rm -r tools/baseline
git add -A && git commit -m "verify: the upscale reproduces every seeded baseline exactly"
```

---

### Task 6: Documentation

**Files:** `CLAUDE.md`, then copy to `AGENTS.md`

- [ ] **Step 1: Record what cellSize now means**

```markdown
**`cellSize` is 2/3, and wall thickness is no longer corridor width.** Every shipped arena
was upscaled 3x from `cellSize 2` (PR: arena resolution). A wall is one cell — 0.667, two
thirds of a tank — so mazes are authorable; existing boards kept their 2.0 walls, now
expressed as 3-cell runs. Thinning any specific wall is a per-level design edit, not part
of the migration.

**The factor is 3 because it is ODD.** An old cell centre `2c+1` is the centre of the new
block's middle sub-cell, so spawns do not move and every seeded outcome is preserved —
proven by a trace hash over 4 arenas x 6 seeds, byte-identical before and after. An even
factor puts the old centre on a boundary between two new cells and re-baselines everything
seeded. `resolution.test.ts` pins this, including the float64 check that `(3c+1.5)*(2/3)`
really does round to exactly `2c+1` across the coordinate range boards use — `2/3` is not
representable in binary, so that is an empirical property, not a guarantee.

Arenas may legally differ in `cellSize` — the validator requires only `> 0`, and a `2/3`
board was demonstrated running alongside `cellSize 2` boards. Shipped levels are kept at one
resolution for visual consistency, not because mixing is unsupported.
```

- [ ] **Step 2: Sync and gate**

```bash
# AGENTS.md is a SYMLINK to CLAUDE.md -- editing CLAUDE.md is the whole job.
git ls-files -s AGENTS.md   # expect mode 120000
npm test 2>&1 | grep -E "Tests |Test Files"
git add CLAUDE.md AGENTS.md && git commit -m "docs: cellSize 2/3, and why the upscale factor is odd"
```

---

## Self-Review

**Spec coverage.** 3× upscale → Task 2. Spawn preservation → Task 2 Step 2, verified Task 5
Step 1. Interior geometry unchanged → Task 4 Steps 3–4 and Task 5. Baselines reported as
before/after → Tasks 1 and 5. Barriers, clearance, killability, ledges → explicitly out of
scope, each landing on top of this.

**Deliberate omission:** the spec calls for a transform test asserting tile-for-tile wall
coverage identity. That is subsumed by the trace fingerprint in Task 5 Step 1, which is
strictly stronger — it covers walls, spawns, collision, AI draws and outcomes together. A
tile-coverage test would also have to special-case the boundary ring, whose thickness
legitimately changes with `cellSize`, and a test with a special case for the one thing that
does change is a test that would have passed had the transform been wrong there.

**Placeholders:** none. The transform is complete, the three resolution tests are written
out, and every expected failure states what it should say.

**Type consistency:** `ARENA_DEFS` and `loadArena` match their current signatures.
`tools/upscale-arenas.mjs` is plain ESM under `tools/`, matching `tools/gl/run.mjs`.
