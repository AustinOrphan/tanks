# Arenas as Data Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the three shipped arenas out of TypeScript literals into a validated JSON file whose entries carry their own machine-checkable design claims, so adding a level is editing data.

**Architecture:** Arenas become the third family in `src/sim/config/` (after tanks and walls), resolved through the existing `createCatalog`. A load-time validator (`validate.ts`) does cheap structural checks and throws naming the exact JSON path; an expensive geometry runner (`src/sim/arena-claims.ts`, which may import the AI layer) verifies each arena's declared claims from the test layer. `arena.ts` keeps every export it has today, so no consumer changes.

**Tech Stack:** TypeScript (strict, `noUnusedLocals`), Vitest, Vite, Three.js (render only). JSON via `resolveJsonModule` (already enabled).

## Global Constraints

- **`src/sim/` is pure**: no imports from `three`, `howler`, or the DOM. `src/sim/purity.test.ts` enforces this by scanning every file under `src/sim/`, including new ones. It scans *strings too* — a test title containing `window` fails the guard.
- **Determinism**: the sim is a pure function of its inputs. No `Math.random`, no wall-clock. Arena data is static, imported at build time.
- **TDD, and prove the gap**: write the failing test, watch it fail for the right reason, then implement. A test that never failed proves nothing.
- **Every assertion must be able to fail.** Before adding one, name the production change that would break it.
- **State denominators**: "4 of 4 enemy spawns (population: every spawn in ARENA_02)", never a bare count.
- **A guard is worth what its own tests prove**: every validator check and every claim type needs a negative control that fails without it.
- **Commits carry no `Co-Authored-By` or tool-attribution trailers.**
- Gate before every commit: `npm test` (runs `tsc --noEmit && vitest run`).
- Node floor `^20.19.0 || ^22.13.0 || >=24.0.0`.
- Branch: `arenas-as-data`, off `main` at `adb15a7`. Spec: `docs/superpowers/specs/2026-08-01-arenas-as-data-design.md`.

## File Structure

| File | Responsibility |
|---|---|
| `src/sim/config/arena-types.ts` (create) | `ArenaDefinition`, `ArenaClaim` union, `SPAWN_LETTERS` (single source of the spawn-letter map) |
| `src/sim/config/validate.ts` (modify) | Add `validateArenaShape` + `validateArenas`, reusing existing primitives |
| `src/sim/config/validate.test.ts` (modify) | Negative controls for every new check |
| `src/sim/config/data/arenas.json` (create) | The three shipped arenas: grid, notes, claims |
| `src/sim/config/arenas.ts` (create) | `createCatalog` over the validated definitions; exports `ARENAS`, `arenaById` |
| `src/sim/config/arena-fixtures.ts` (create) | Test-only fixtures, incl. the 15×11 variable-size arena |
| `src/sim/arena.ts` (modify) | Keeps all existing exports; grids now come from the catalog; imports `SPAWN_LETTERS` |
| `src/sim/arena-claims.ts` (create) | The geometry runner: evaluates claims, renders annotated boards. May import `ai/targeting` |
| `src/sim/arena-claims.test.ts` (create) | Runner meta-tests: deliberately false claims must fail |
| `src/sim/arena-validation.test.ts` (modify) | Runs the generic runner over every arena; the two bespoke describe blocks are deleted |
| `src/sim/sandbox.test.ts` (modify) | Asserts generated sandbox output passes `validateArenaShape` |
| `tools/gl/harness.ts` (modify) | Renders the 15×11 fixture, proving per-level refit |
| `CLAUDE.md` / `AGENTS.md` (modify) | Architecture note; kept byte-identical to each other |

---

### Task 1: Arena schema types and the structural validator

**Files:**
- Create: `src/sim/config/arena-types.ts`
- Modify: `src/sim/config/validate.ts`
- Test: `src/sim/config/validate.test.ts`

**Interfaces:**
- Consumes: `fail`, `isRecord`, `num`, `nonNegInt`, `str`, `oneOf`, `exactKeys` (module-private in `validate.ts`); `WallKind`, `TankKind` from `src/sim/types.ts`.
- Produces: `ArenaDefinition`, `ArenaClaim`, `SPAWN_LETTERS` from `arena-types.ts`; `validateArenaShape(arena: unknown, file: string, path: string): ArenaShape` and `validateArenas(raw: unknown, file?: string): ArenaDefinition[]` from `validate.ts`.

- [ ] **Step 1: Create the types**

```typescript
// src/sim/config/arena-types.ts
import type { TankKind, WallKind } from '../types';

/**
 * Spawn letters, the SINGLE source. `arena.ts` imports this rather than keeping
 * its own copy: the validator must reject a grid character no loader can resolve,
 * and two tables would drift. Wall characters live in each arena's `legend`; `.`
 * is open floor.
 */
export const SPAWN_LETTERS: Record<string, TankKind> = {
  P: 'player',
  B: 'brown',
  G: 'grey',
  T: 'teal',
  O: 'olive',
};

/** The geometry half of a definition -- what a bare `Arena` already is. */
export interface ArenaShape {
  cols: number;
  rows: number;
  cellSize: number;
  legend: Record<string, WallKind>;
  grid: string[];
}

/**
 * A machine-checkable statement of design intent, verified by the runner in
 * src/sim/arena-claims.ts. Every claim carries `why`: the rationale travels with
 * the property it protects, so porting a grid cannot strand it.
 */
export type ArenaClaim =
  | { type: 'sightlineAfterBreach'; from: [number, number]; sees: boolean; why: string }
  | {
      type: 'lane';
      from: [number, number];
      to: [number, number];
      intact: 'blocked' | 'open';
      breached: 'blocked' | 'open';
      why: string;
    }
  | { type: 'spawnBlockRobust'; nudge: number; why: string };

export interface ArenaDefinition extends ArenaShape {
  id: string;
  notes: string[];
  claims: ArenaClaim[];
}
```

- [ ] **Step 2: Write the failing negative controls**

Append to `src/sim/config/validate.test.ts` (it already has `corrupt`, `Mutable`):

```typescript
import { validateArenas, validateArenaShape } from './validate';

const GOOD_ARENA = {
  id: 'test-01',
  cols: 4, rows: 3, cellSize: 2,
  legend: { '#': 'solid' },
  grid: ['.B..', '.#..', '..P.'],
  notes: ['a note'],
  claims: [],
};

describe('validateArenas', () => {
  it('accepts a well-formed arena file and returns it intact', () => {
    expect(validateArenas({ arenas: [GOOD_ARENA] })).toEqual([GOOD_ARENA]);
  });

  it('rejects a grid whose row count disagrees with rows', () => {
    const bad = corrupt({ arenas: [GOOD_ARENA] }, (c) => {
      ((c.arenas as Mutable[])[0] as Mutable).rows = 4;
    });
    expect(() => validateArenas(bad)).toThrow(/arenas\[0\]\.grid.*3 rows.*declares 4/);
  });

  it('rejects a row whose length disagrees with cols', () => {
    const bad = corrupt({ arenas: [GOOD_ARENA] }, (c) => {
      ((c.arenas as Mutable[])[0] as Mutable).grid = ['.B..', '.#.', '..P.'];
    });
    expect(() => validateArenas(bad)).toThrow(/arenas\[0\]\.grid\[1\].*length 3.*declares 4/);
  });

  it('rejects a grid character that is neither legend, spawn letter, nor floor', () => {
    const bad = corrupt({ arenas: [GOOD_ARENA] }, (c) => {
      ((c.arenas as Mutable[])[0] as Mutable).grid = ['.B..', '.Z..', '..P.'];
    });
    expect(() => validateArenas(bad)).toThrow(/arenas\[0\]\.grid\[1\]\[1\].*"Z"/);
  });

  it('rejects a legend value that is not a WallKind', () => {
    const bad = corrupt({ arenas: [GOOD_ARENA] }, (c) => {
      ((c.arenas as Mutable[])[0] as Mutable).legend = { '#': 'squishy' };
    });
    expect(() => validateArenas(bad)).toThrow(/arenas\[0\]\.legend\["#"\].*WallKind/);
  });

  it('rejects zero or one player spawns, and demands an enemy', () => {
    const none = corrupt({ arenas: [GOOD_ARENA] }, (c) => {
      ((c.arenas as Mutable[])[0] as Mutable).grid = ['.B..', '.#..', '....'];
    });
    expect(() => validateArenas(none)).toThrow(/exactly one player spawn.*found 0/);
    const two = corrupt({ arenas: [GOOD_ARENA] }, (c) => {
      ((c.arenas as Mutable[])[0] as Mutable).grid = ['.B..', '.#..', '.PP.'];
    });
    expect(() => validateArenas(two)).toThrow(/exactly one player spawn.*found 2/);
    const noEnemy = corrupt({ arenas: [GOOD_ARENA] }, (c) => {
      ((c.arenas as Mutable[])[0] as Mutable).grid = ['....', '.#..', '..P.'];
    });
    expect(() => validateArenas(noEnemy)).toThrow(/at least one enemy/);
  });

  it('rejects duplicate ids', () => {
    expect(() => validateArenas({ arenas: [GOOD_ARENA, GOOD_ARENA] }))
      .toThrow(/duplicate id "test-01"/);
  });

  it('rejects an empty arena list, a non-array, and a non-object root', () => {
    expect(() => validateArenas({ arenas: [] })).toThrow(/at least one arena/);
    expect(() => validateArenas({ arenas: 'nope' })).toThrow(/must be an array/);
    expect(() => validateArenas(null)).toThrow(/root.*object/);
  });

  it('rejects an unknown claim type and a malformed claim', () => {
    const badType = corrupt({ arenas: [GOOD_ARENA] }, (c) => {
      ((c.arenas as Mutable[])[0] as Mutable).claims = [{ type: 'vibes', why: 'x' }];
    });
    expect(() => validateArenas(badType)).toThrow(/arenas\[0\]\.claims\[0\]\.type.*"vibes"/);
    const noWhy = corrupt({ arenas: [GOOD_ARENA] }, (c) => {
      ((c.arenas as Mutable[])[0] as Mutable).claims = [
        { type: 'spawnBlockRobust', nudge: 0.1 },
      ];
    });
    expect(() => validateArenas(noWhy)).toThrow(/arenas\[0\]\.claims\[0\].*"why"/);
  });

  it('rejects a claim cell outside the grid, or a sightline claim not on an enemy spawn', () => {
    const oob = corrupt({ arenas: [GOOD_ARENA] }, (c) => {
      ((c.arenas as Mutable[])[0] as Mutable).claims = [
        { type: 'sightlineAfterBreach', from: [9, 9], sees: true, why: 'x' },
      ];
    });
    expect(() => validateArenas(oob)).toThrow(/arenas\[0\]\.claims\[0\]\.from.*outside the grid/);
    const notSpawn = corrupt({ arenas: [GOOD_ARENA] }, (c) => {
      ((c.arenas as Mutable[])[0] as Mutable).claims = [
        { type: 'sightlineAfterBreach', from: [0, 0], sees: true, why: 'x' },
      ];
    });
    expect(() => validateArenas(notSpawn))
      .toThrow(/arenas\[0\]\.claims\[0\]\.from.*enemy spawn/);
  });
});

describe('validateArenaShape', () => {
  it('accepts a bare Arena (no id/notes/claims) -- the sandbox path', () => {
    const { id, notes, claims, ...shape } = GOOD_ARENA;
    void id; void notes; void claims;
    expect(validateArenaShape(shape, 'sandbox', 'sandbox')).toEqual(shape);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/sim/config/validate.test.ts`
Expected: FAIL — `validateArenas is not a function` / import error.

- [ ] **Step 4: Implement the validators**

Append to `src/sim/config/validate.ts` (add the import at the top):

```typescript
import type { ArenaClaim, ArenaDefinition, ArenaShape } from './arena-types';
import { SPAWN_LETTERS } from './arena-types';

const SHAPE_FIELDS = ['cols', 'rows', 'cellSize', 'legend', 'grid'] as const;
const DEFINITION_ARENA_FIELDS = [...SHAPE_FIELDS, 'id', 'notes', 'claims'] as const;
const WALL_KINDS = ['solid', 'destructible'] as const;

function posInt(file: string, path: string, v: unknown): number {
  const n = nonNegInt(file, path, v);
  if (n === 0) fail(file, path, 'must be greater than zero');
  return n;
}

/**
 * The geometry half: dimensions, legend, grid, spawn counts. Split out from
 * validateArenas so the SANDBOX -- which generates a bare Arena programmatically
 * and has no id/notes/claims -- can be held to the same structural bar.
 */
export function validateArenaShape(raw: unknown, file: string, path: string): ArenaShape {
  if (!isRecord(raw)) fail(file, path, 'must be an object');
  const cols = posInt(file, `${path}.cols`, raw.cols);
  const rows = posInt(file, `${path}.rows`, raw.rows);
  const cellSize = num(file, `${path}.cellSize`, raw.cellSize);
  if (cellSize <= 0) fail(file, `${path}.cellSize`, 'must be greater than zero');

  if (!isRecord(raw.legend)) fail(file, `${path}.legend`, 'must be an object');
  const legend: Record<string, WallKind> = {};
  for (const [ch, kind] of Object.entries(raw.legend)) {
    if (ch.length !== 1) fail(file, `${path}.legend["${ch}"]`, 'key must be a single character');
    if (ch === '.' || ch in SPAWN_LETTERS) {
      fail(file, `${path}.legend["${ch}"]`, 'collides with floor or a spawn letter');
    }
    legend[ch] = oneOf(file, `${path}.legend["${ch}"]`, kind, WALL_KINDS, 'WallKind');
  }

  if (!Array.isArray(raw.grid)) fail(file, `${path}.grid`, 'must be an array of strings');
  if (raw.grid.length !== rows) {
    fail(file, `${path}.grid`, `has ${raw.grid.length} rows but the arena declares ${rows}`);
  }
  let players = 0;
  let enemies = 0;
  const grid = raw.grid.map((row, r) => {
    const line = str(file, `${path}.grid[${r}]`, row);
    if (line.length !== cols) {
      fail(file, `${path}.grid[${r}]`, `has length ${line.length} but the arena declares ${cols}`);
    }
    for (let c = 0; c < line.length; c++) {
      const ch = line[c];
      if (ch === '.') continue;
      if (ch in legend) continue;
      const kind = SPAWN_LETTERS[ch];
      if (!kind) {
        fail(file, `${path}.grid[${r}][${c}]`,
          `${JSON.stringify(ch)} is neither floor, a legend character, nor a spawn letter`);
      }
      if (kind === 'player') players++;
      else enemies++;
    }
    return line;
  });
  if (players !== 1) fail(file, path, `must have exactly one player spawn, found ${players}`);
  if (enemies < 1) fail(file, path, 'must have at least one enemy spawn');

  return { cols, rows, cellSize, legend, grid };
}

const CLAIM_FIELDS: Record<ArenaClaim['type'], readonly string[]> = {
  sightlineAfterBreach: ['type', 'from', 'sees', 'why'],
  lane: ['type', 'from', 'to', 'intact', 'breached', 'why'],
  spawnBlockRobust: ['type', 'nudge', 'why'],
};
const BLOCK_STATES = ['blocked', 'open'] as const;

function cell(file: string, path: string, v: unknown, shape: ArenaShape): [number, number] {
  if (!Array.isArray(v) || v.length !== 2) fail(file, path, 'must be a [col, row] pair');
  const c = nonNegInt(file, `${path}[0]`, v[0]);
  const r = nonNegInt(file, `${path}[1]`, v[1]);
  if (c >= shape.cols || r >= shape.rows) {
    fail(file, path, `[${c}, ${r}] is outside the grid (${shape.cols}x${shape.rows})`);
  }
  return [c, r];
}

function enemySpawnCell(file: string, path: string, v: unknown, shape: ArenaShape): [number, number] {
  const [c, r] = cell(file, path, v, shape);
  const kind = SPAWN_LETTERS[shape.grid[r][c]];
  if (!kind || kind === 'player') {
    fail(file, path, `[${c}, ${r}] must hold an enemy spawn, found ${JSON.stringify(shape.grid[r][c])}`);
  }
  return [c, r];
}

function validateClaim(file: string, path: string, v: unknown, shape: ArenaShape): ArenaClaim {
  if (!isRecord(v)) fail(file, path, 'must be an object');
  const type = oneOf(file, `${path}.type`, v.type,
    Object.keys(CLAIM_FIELDS) as ArenaClaim['type'][], 'claim type');
  exactKeys(file, path, v, CLAIM_FIELDS[type]);
  const why = str(file, `${path}.why`, v.why);
  if (why.trim() === '') fail(file, `${path}.why`, 'must not be empty');
  switch (type) {
    case 'sightlineAfterBreach':
      return { type, from: enemySpawnCell(file, `${path}.from`, v.from, shape),
        sees: bool(file, `${path}.sees`, v.sees), why };
    case 'lane':
      return { type, from: cell(file, `${path}.from`, v.from, shape),
        to: cell(file, `${path}.to`, v.to, shape),
        intact: oneOf(file, `${path}.intact`, v.intact, BLOCK_STATES, 'block state'),
        breached: oneOf(file, `${path}.breached`, v.breached, BLOCK_STATES, 'block state'), why };
    case 'spawnBlockRobust': {
      const nudge = num(file, `${path}.nudge`, v.nudge);
      if (nudge <= 0) fail(file, `${path}.nudge`, 'must be greater than zero');
      return { type, nudge, why };
    }
  }
}

export function validateArenas(raw: unknown, file = 'arenas.json'): ArenaDefinition[] {
  if (!isRecord(raw)) fail(file, 'root', 'must be an object with an "arenas" array');
  if (!Array.isArray(raw.arenas)) fail(file, 'root.arenas', 'must be an array');
  if (raw.arenas.length === 0) fail(file, 'root.arenas', 'must hold at least one arena');

  const seen = new Set<string>();
  return raw.arenas.map((entry, i) => {
    const path = `arenas[${i}]`;
    if (!isRecord(entry)) fail(file, path, 'must be an object');
    exactKeys(file, path, entry, DEFINITION_ARENA_FIELDS);
    const shape = validateArenaShape(entry, file, path);
    const id = str(file, `${path}.id`, entry.id);
    if (seen.has(id)) fail(file, path, `duplicate id ${JSON.stringify(id)}`);
    seen.add(id);
    if (!Array.isArray(entry.notes)) fail(file, `${path}.notes`, 'must be an array of strings');
    const notes = entry.notes.map((n, j) => str(file, `${path}.notes[${j}]`, n));
    if (!Array.isArray(entry.claims)) fail(file, `${path}.claims`, 'must be an array');
    const claims = entry.claims.map((c, j) => validateClaim(file, `${path}.claims[${j}]`, c, shape));
    return { id, ...shape, notes, claims };
  });
}
```

Note: `WallKind` must be added to the existing `import type { TankKind } from '../types';` line at the top of `validate.ts`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/sim/config/validate.test.ts`
Expected: PASS, all controls green.

- [ ] **Step 6: Full gate and commit**

```bash
npm test
git add src/sim/config/arena-types.ts src/sim/config/validate.ts src/sim/config/validate.test.ts
git commit -m "config: arena schema types and the structural arena validator

ArenaDefinition/ArenaClaim/SPAWN_LETTERS join the config module, and
validate.ts gains validateArenaShape (the geometry half, so the programmatic
sandbox can be held to the same bar) and validateArenas (the file: ids, notes,
claims). Every check has a negative control, per the discipline the tank and
profile validators already carry."
```

---

### Task 2: Port the three grids to JSON and serve them through the catalog

**Files:**
- Create: `src/sim/config/data/arenas.json`, `src/sim/config/arenas.ts`
- Modify: `src/sim/arena.ts`, `src/sim/config/index.ts`
- Test: existing suites are the net (`npm test`)

**Interfaces:**
- Consumes: `validateArenas` (Task 1), `createCatalog` from `./catalog`.
- Produces: `ARENA_DEFS: ArenaDefinition[]`, `ARENAS_FROM_DATA: ArenaShape[]`, `arenaById(id: string): ArenaDefinition` from `config/arenas.ts`. `arena.ts` keeps `Arena`, `ARENA_01`, `ARENA_02`, `ARENA_03`, `ARENAS`, `CURRENT_ARENA`, `arenaBounds`, `loadArena`, `createWorldFor`, `createArenaWorld` unchanged in name and type.

- [ ] **Step 1: Create the data file with the three grids ported verbatim**

Copy the grid strings EXACTLY from `src/sim/arena.ts` (do not retype them; a single changed character is a gameplay change). `notes` carries the design rationale currently in the comments above each literal. `claims` stays `[]` here — Task 4 fills it.

```json
{
  "arenas": [
    {
      "id": "arena-01",
      "cols": 11, "rows": 9, "cellSize": 2,
      "legend": { "#": "solid", "x": "destructible" },
      "grid": [
        "...........",
        "..#.....#..",
        "..#.B.G.#..",
        ".....T.....",
        "..x..#..x..",
        ".....#..#..",
        "..#.....#..",
        "..#..P..#..",
        "..........."
      ],
      "notes": [
        "Hand-designed slice arena. Player bottom (row 7), Brown+Grey+Teal across the top (rows 2-3).",
        "The centre solid block (col 5, row 4) sits on the Teal->player line, so Teal must bank a ricochet off a side wall.",
        "The solid cell at (col 8, row 5) is the bank-shot reflector: a shell from Teal can clear the centre block through the row-4 gap, bank off its west face, and reach the player through rows 6-7.",
        "Cover depth (col 5, row 5): with the row-4 block alone, Brown's and Grey's lines to the player spawn were exactly tangent to its corners -- a knife edge where a 0.1-unit nudge gave one of them a clear 10-unit lane. The second cell turns that graze into a real chord."
      ],
      "claims": []
    },
    {
      "id": "arena-02",
      "cols": 11, "rows": 9, "cellSize": 2,
      "legend": { "#": "solid", "x": "destructible" },
      "grid": [
        "...........",
        "...........",
        ".B...#...G.",
        ".T...#...B.",
        "x#xxx#xxx#x",
        ".....#.....",
        "..#.....#..",
        ".....P.....",
        "..........."
      ],
      "notes": [
        "Reshaped in the 2026-07-31 balance pass: row 4 is a FULL destructible barrier with solid anchors (cols 1, 5, 9), so the halves START sealed -- tanks cannot cross and shells cannot pass until someone blasts a hole. Breaching the bar IS the level.",
        "Four enemies against level 1's three."
      ],
      "claims": []
    },
    {
      "id": "arena-03",
      "cols": 11, "rows": 9, "cellSize": 2,
      "legend": { "#": "solid", "x": "destructible" },
      "grid": [
        "...........",
        ".O.......O.",
        ".x..BGB..x.",
        "...#...#...",
        "..#..#..#..",
        ".....#.....",
        "..#..x..#..",
        ".....P.....",
        "..........."
      ],
      "notes": [
        "The rocket debut: two Olives (DEFENSIVE_ROCKET, one rocket in flight) flank high behind destructible shields, with a brown-grey-brown trio behind solid cover.",
        "Each flank column (1 and 9) is open floor top-to-bottom EXCEPT the olive's shield, so blasting a shield opens that vertical lane end-to-end, both ways. The shield is the level's trade, one per flank.",
        "The row-3/row-4 anchors deny the olives any diagonal into the player half. The browns' spawn lines are shut by a REAL CHORD through the row-4/row-5 centre pillar -- the row-5 cell exists for ARENA_01's reason: with row 4 alone, a breached centre peek left both brown lines blocked only by a corner tangency.",
        "The centre peek 'x' (row 6) is breachable mid-field cover on the centre axis, not a spawn-line blocker."
      ],
      "claims": []
    }
  ]
}
```

- [ ] **Step 2: Create the catalog module**

```typescript
// src/sim/config/arenas.ts
import { createCatalog } from './catalog';
import type { ArenaDefinition } from './arena-types';
import { validateArenas } from './validate';
import arenasJson from './data/arenas.json';

/**
 * The shipped arenas, in PLAY ORDER -- array order is level order, so there is no
 * parallel index to drift. Validated at load: a bad edit is a boot failure naming
 * the exact path (arenas[2].grid[4]), never a silently malformed board.
 */
export const ARENA_DEFS: ArenaDefinition[] = validateArenas(arenasJson);

const BY_ID = createCatalog<string, ArenaDefinition, ArenaDefinition>(
  Object.fromEntries(ARENA_DEFS.map((a) => [a.id, a])),
  (id, defs) => defs[id],
);

/** Lookup by id, for tests and tooling that name an arena rather than index it. */
export function arenaById(id: string): ArenaDefinition {
  const found = BY_ID.get(id);
  if (!found) throw new Error(`Unknown arena id: ${id}`);
  return found;
}
```

- [ ] **Step 3: Point `arena.ts` at the catalog, keeping every export**

In `src/sim/arena.ts`: delete the three `export const ARENA_0N: Arena = {...}` literals and their comment blocks (the rationale now lives in `notes`), delete the module-private `SPAWN_KINDS` table, and replace with:

```typescript
import { ARENA_DEFS, arenaById } from './config/arenas';
import { SPAWN_LETTERS } from './config/arena-types';

// Grids, notes and design claims live in config/data/arenas.json, validated at load
// (config/validate.ts). These named exports stay so every consumer -- levels.ts, the
// gl harness, the gallery, dozens of tests -- is untouched by the move.
export const ARENA_01: Arena = arenaById('arena-01');
export const ARENA_02: Arena = arenaById('arena-02');
export const ARENA_03: Arena = arenaById('arena-03');
export const ARENAS: Arena[] = ARENA_DEFS;
```

Replace every use of the old `SPAWN_KINDS` inside `loadArena` with `SPAWN_LETTERS`. Leave `arenaBounds`, `loadArena`, `createWorldFor`, `createArenaWorld`, `CURRENT_ARENA` and the `Arena` interface exactly as they are.

- [ ] **Step 4: Export the new surface from the config index**

Append to `src/sim/config/index.ts`:

```typescript
export { ARENA_DEFS, arenaById } from './arenas';
export { SPAWN_LETTERS, type ArenaClaim, type ArenaDefinition, type ArenaShape } from './arena-types';
export { validateArenas, validateArenaShape } from './validate';
```

- [ ] **Step 5: Prove the port is faithful, then run the full gate**

Run the one-time fidelity check in the working tree (NOT committed — keeping the literals would recreate the duplicate source of truth this change removes). Save the pre-port literals from git and deep-compare:

```bash
git show HEAD:src/sim/arena.ts > /tmp/arena-before.ts
node -e "
const fs=require('fs');
const before=fs.readFileSync('/tmp/arena-before.ts','utf8');
const after=JSON.parse(fs.readFileSync('src/sim/config/data/arenas.json','utf8'));
// Pull each grid literal out of the old TS and compare string-for-string.
const grids=[...before.matchAll(/grid:\s*\[([^\]]*)\]/g)].map(m=>
  [...m[1].matchAll(/'([^']*)'/g)].map(s=>s[1]));
const ok=grids.every((g,i)=>JSON.stringify(g)===JSON.stringify(after.arenas[i].grid));
console.log('grids identical:', ok, '| arenas compared:', grids.length);
if(!ok) process.exit(1);
"
npm test
```

Expected: `grids identical: true | arenas compared: 3`, then the full suite green — `determinism.test.ts` replays seeded games on `ARENAS[0]`, so a single drifted cell would change trajectories and fail. Record both outputs for the PR body.

- [ ] **Step 6: Commit**

```bash
git add src/sim/config/data/arenas.json src/sim/config/arenas.ts src/sim/config/index.ts src/sim/arena.ts
git commit -m "config: the shipped arenas move to validated JSON

The three grids port verbatim into config/data/arenas.json with their design
rationale as notes; config/arenas.ts resolves them through createCatalog, and
arena.ts keeps every export it had, so no consumer changes. SPAWN_LETTERS is
now the single source of the spawn-letter map (validator and loader shared it
by copy before). Fidelity: grids string-identical to the pre-port literals,
and the seeded determinism suite replays unchanged."
```

---

### Task 3: The claim runner and its meta-tests

**Files:**
- Create: `src/sim/arena-claims.ts`, `src/sim/arena-claims.test.ts`
- Modify: `src/sim/arena-validation.test.ts` (its two geometry rules move into the extracted helper)
- Test: `src/sim/arena-claims.test.ts`

**Interfaces:**
- Consumes: `loadArena`, `Arena` from `./arena`; `lineOfSight` from `./ai/targeting`; `ArenaClaim` from `./config/arena-types`.
- Produces: `claimFailures(arena: Arena, claims: ArenaClaim[]): string[]`, `structuralFailures(arena: Arena): string[]`, and `renderBoard(arena: Arena, marks: ReadonlyArray<[number, number]>): string` from `arena-claims.ts`.

**Why `structuralFailures` is extracted here:** the two geometry rules that apply to
EVERY arena — no solid-sealed pockets, no enemy sightline to the player spawn — live
inline in `arena-validation.test.ts`'s `describe.each` today, so nothing can hand them a
deliberately broken arena. The spec requires a negative control per universal rule
(Task 5 supplies the bad fixtures). Extract once and call it from both places; two
implementations of the same rule would drift.

- [ ] **Step 1: Write the failing meta-tests**

```typescript
// src/sim/arena-claims.test.ts
import { describe, it, expect } from 'vitest';
import { claimFailures, renderBoard, structuralFailures } from './arena-claims';
import { arenaById } from './config/arenas';
import type { ArenaClaim } from './config/arena-types';

// A guard is worth what its own tests prove: the purity guard passed four of five
// known-bad probes before it got a meta-test. So every claim type is fed a
// deliberately FALSE claim here and must be reported as a failure. The TRUE
// counterpart of each is the control -- without it, a runner that reports
// everything as broken would also pass.
const A03 = arenaById('arena-03');

describe('claimFailures reports a false claim of each type', () => {
  it('sightlineAfterBreach: the true expectation passes, the inverted one fails', () => {
    // ARENA_03 opens NO spawn-to-spawn sightline when everything is breached.
    const truth: ArenaClaim = {
      type: 'sightlineAfterBreach', from: [1, 1], sees: false, why: 'measured',
    };
    const lie: ArenaClaim = { ...truth, sees: true };
    expect(claimFailures(A03, [truth])).toEqual([]);
    expect(claimFailures(A03, [lie])).toHaveLength(1);
    expect(claimFailures(A03, [lie])[0]).toMatch(/sightlineAfterBreach/);
  });

  it('lane: the true expectation passes, the inverted one fails', () => {
    // The olive's flank column: blocked while the shield stands, open once breached.
    const truth: ArenaClaim = {
      type: 'lane', from: [1, 1], to: [1, 7],
      intact: 'blocked', breached: 'open', why: 'measured',
    };
    const lie: ArenaClaim = { ...truth, intact: 'open' };
    expect(claimFailures(A03, [truth])).toEqual([]);
    expect(claimFailures(A03, [lie])).toHaveLength(1);
    expect(claimFailures(A03, [lie])[0]).toMatch(/intact/);
  });

  it('spawnBlockRobust: passes at the measured nudge, fails at an absurd one', () => {
    const truth: ArenaClaim = { type: 'spawnBlockRobust', nudge: 0.1, why: 'measured' };
    // 6 units is half the board: no arena keeps every spawn blocked under that.
    const lie: ArenaClaim = { ...truth, nudge: 6 };
    expect(claimFailures(A03, [truth])).toEqual([]);
    expect(claimFailures(A03, [lie]).length).toBeGreaterThan(0);
  });

  it('quotes the claim\'s why and draws the board, so a failure says WHICH cell', () => {
    const lie: ArenaClaim = {
      type: 'lane', from: [1, 1], to: [1, 7],
      intact: 'open', breached: 'open', why: 'the shield is the trade',
    };
    const [failure] = claimFailures(A03, [lie]);
    expect(failure).toContain('the shield is the trade');
    expect(failure).toContain('*'); // the annotated board marks the claim's cells
  });

  it('an arena with no claims reports nothing', () => {
    expect(claimFailures(A03, [])).toEqual([]);
  });
});

describe('structuralFailures covers the universal rules', () => {
  it('reports nothing for a shipped arena', () => {
    // The control: without it, a function that returned failures for EVERYTHING
    // would also satisfy the negative controls in Task 5.
    expect(structuralFailures(A03)).toEqual([]);
  });
});

describe('renderBoard', () => {
  it('marks the requested cells and preserves the grid otherwise', () => {
    const board = renderBoard(A03, [[1, 1]]);
    const lines = board.trim().split('\n');
    expect(lines).toHaveLength(A03.rows);
    expect(lines[1][1]).toBe('*');
    expect(lines[7]).toContain('P'); // untouched rows still read as the grid
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/sim/arena-claims.test.ts`
Expected: FAIL — cannot resolve `./arena-claims`.

- [ ] **Step 3: Implement the runner**

```typescript
// src/sim/arena-claims.ts
import type { Arena } from './arena';
import { loadArena } from './arena';
import type { Vec2, Wall } from './types';
import { lineOfSight } from './ai/targeting';
import type { ArenaClaim } from './config/arena-types';

/**
 * Evaluates an arena's declared design claims (config/arena-types.ts) against the
 * sim's OWN geometry -- lineOfSight, the same function the AI uses -- so a claim
 * means exactly what the game means by it.
 *
 * Test-facing: it imports the AI layer, which is why it lives here rather than in
 * config/ (that module stays free of AI dependencies). Nothing in the shipped
 * bundle imports this.
 */

/** The world-space centre of a grid cell, matching loadArena's spawn placement. */
function cellCentre(arena: Arena, [c, r]: readonly [number, number]): Vec2 {
  return { x: (c + 0.5) * arena.cellSize, y: (r + 0.5) * arena.cellSize };
}

function breach(walls: Wall[]): Wall[] {
  return walls.map((w) => (w.kind === 'destructible' ? { ...w, destroyed: true } : w));
}

/** The grid with `marks` overwritten as `*`, for failure messages. */
export function renderBoard(arena: Arena, marks: ReadonlyArray<[number, number]>): string {
  const rows = arena.grid.map((row) => [...row]);
  for (const [c, r] of marks) rows[r][c] = '*';
  return rows.map((row) => row.join('')).join('\n');
}

/**
 * A cell a tank could EVER stand on: open now, or openable by demolition. The
 * 2026-07-31 balance pass made ARENA_02's middle bar a full destructible barrier --
 * the halves START sealed and the level is about breaching it -- so plain-open
 * connectivity is a design choice, not an invariant. SOLID-sealed pockets remain
 * forbidden: no amount of play opens those.
 */
function isBreachable(arena: Arena, r: number, c: number): boolean {
  const kind = arena.legend[arena.grid[r][c]];
  return !kind || kind === 'destructible';
}

/** 4-neighbour flood fill over breachable cells. */
function reachable(arena: Arena): { open: number; reached: number } {
  const { rows, cols } = arena;
  const seen = Array.from({ length: rows }, () => Array(cols).fill(false));
  let open = 0;
  let start: [number, number] | null = null;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (isBreachable(arena, r, c)) {
        open++;
        if (!start) start = [r, c];
      }
    }
  }
  if (!start) return { open, reached: 0 };
  const seenStack: Array<[number, number]> = [start];
  seen[start[0]][start[1]] = true;
  let reachedCount = 0;
  while (seenStack.length) {
    const [r, c] = seenStack.pop()!;
    reachedCount++;
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nr = r + dr;
      const nc = c + dc;
      if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
      if (seen[nr][nc] || !isBreachable(arena, nr, nc)) continue;
      seen[nr][nc] = true;
      seenStack.push([nr, nc]);
    }
  }
  return { open, reached: reachedCount };
}

/**
 * The rules EVERY arena obeys, whatever it claims: no solid-sealed pockets, and no
 * enemy holding a straight line to the player spawn at spawn (Brown never moves, so
 * such a line is a death sentence three seconds into the level).
 *
 * Extracted from arena-validation.test.ts so a deliberately broken fixture can be
 * fed to it -- inline rules in a describe.each can only ever see arenas that exist.
 */
export function structuralFailures(arena: Arena): string[] {
  const failures: string[] = [];
  const { open, reached } = reachable(arena);
  if (reached !== open) {
    failures.push(
      `sealed pocket: ${reached} of ${open} breachable cells reachable\n${renderBoard(arena, [])}`,
    );
  }
  const { walls, spawns } = loadArena(arena);
  const player = spawns.find((s) => s.kind === 'player');
  if (!player) return [...failures, 'no player spawn'];
  for (const enemy of spawns.filter((s) => s.kind !== 'player')) {
    if (lineOfSight(enemy.pos, player.pos, walls)) {
      failures.push(
        `spawn sightline: ${enemy.kind} at (${enemy.pos.x}, ${enemy.pos.y}) sees the player spawn`,
      );
    }
  }
  return failures;
}

export function claimFailures(arena: Arena, claims: ArenaClaim[]): string[] {
  const { walls, spawns } = loadArena(arena);
  const breached = breach(walls);
  const player = spawns.find((s) => s.kind === 'player');
  if (!player) return ['no player spawn: the structural validator should have caught this'];
  const failures: string[] = [];

  for (const claim of claims) {
    switch (claim.type) {
      case 'sightlineAfterBreach': {
        const from = cellCentre(arena, claim.from);
        const sees = lineOfSight(from, player.pos, breached);
        if (sees !== claim.sees) {
          failures.push(
            `sightlineAfterBreach at [${claim.from}]: expected sees=${claim.sees}, measured ${sees}\n` +
            `  why: ${claim.why}\n${renderBoard(arena, [claim.from])}`,
          );
        }
        break;
      }
      case 'lane': {
        const a = cellCentre(arena, claim.from);
        const b = cellCentre(arena, claim.to);
        const states = {
          intact: lineOfSight(a, b, walls) ? 'open' : 'blocked',
          breached: lineOfSight(a, b, breached) ? 'open' : 'blocked',
        } as const;
        for (const phase of ['intact', 'breached'] as const) {
          if (states[phase] !== claim[phase]) {
            failures.push(
              `lane [${claim.from}]->[${claim.to}] ${phase}: expected ${claim[phase]}, measured ${states[phase]}\n` +
              `  why: ${claim.why}\n${renderBoard(arena, [claim.from, claim.to])}`,
            );
          }
        }
        break;
      }
      case 'spawnBlockRobust': {
        const offsets: Vec2[] = [
          { x: claim.nudge, y: 0 }, { x: -claim.nudge, y: 0 },
          { x: 0, y: claim.nudge }, { x: 0, y: -claim.nudge },
        ];
        for (const enemy of spawns.filter((s) => s.kind !== 'player')) {
          for (const off of offsets) {
            const target = { x: player.pos.x + off.x, y: player.pos.y + off.y };
            if (lineOfSight(enemy.pos, target, walls)) {
              failures.push(
                `spawnBlockRobust: ${enemy.kind} at (${enemy.pos.x}, ${enemy.pos.y}) sees the player ` +
                `nudged by (${off.x}, ${off.y}) -- the block is a tangency, not a chord\n` +
                `  why: ${claim.why}\n${renderBoard(arena, [])}`,
              );
            }
          }
        }
        break;
      }
    }
  }
  return failures;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/sim/arena-claims.test.ts`
Expected: PASS. If `sightlineAfterBreach`'s truth case fails, the measured value is the truth — fix the TEST's expectation, not the runner, and note the measurement.

- [ ] **Step 5: Rewire the universal rules to the extracted helper**

In `src/sim/arena-validation.test.ts`, replace the two geometry `it` blocks inside the
`describe.each` — "has every breachable cell reachable from every other" and "denies
every enemy a straight line to the player spawn" — with one that delegates, and delete
the now-unused local `isBreachable` / `reachableOpenCells` helpers:

```typescript
import { structuralFailures } from './arena-claims';

it('obeys every universal structural rule', () => {
  expect(structuralFailures(a).join('\n')).toBe('');
});
```

Keep the "loads, with exactly one player spawn and at least one enemy" test as it is.

- [ ] **Step 6: Verify nothing was weakened**

Run: `npx vitest run src/sim/arena-validation.test.ts src/sim/arena-claims.test.ts`
Expected: PASS. Then prove the rewired rule still bites: temporarily add a solid wall
sealing a corner of `arena-01` in `arenas.json` (e.g. change `grid[1]` to `"##.....#.."`),
re-run, confirm the sealed-pocket failure names it, and restore.

- [ ] **Step 7: Full gate and commit**

```bash
npm test
git add src/sim/arena-claims.ts src/sim/arena-claims.test.ts src/sim/arena-validation.test.ts
git commit -m "sim: the arena claim runner, with a negative control per claim type

claimFailures evaluates an arena's declared design claims against the sim's own
lineOfSight, and renders the annotated board on failure so a red test names the
cell that betrayed the design. Each of the three claim types is proven by a
deliberately false claim that must fail beside its true control."
```

---

### Task 4: Author the shipped arenas' claims and retire the bespoke tests

**Files:**
- Modify: `src/sim/config/data/arenas.json`, `src/sim/arena-validation.test.ts`

**Interfaces:**
- Consumes: `claimFailures` (Task 3), `ARENA_DEFS` (Task 2).
- Produces: nothing new — this task moves assertions from TypeScript into data.

- [ ] **Step 1: Measure before claiming**

Do NOT assume a claim holds. Write a throwaway probe, run it, and record the output:

```bash
cat > /tmp/probe.test.ts <<'EOF'
import { it } from 'vitest';
import { ARENA_DEFS } from '../src/sim/config/arenas';
import { claimFailures } from '../src/sim/arena-claims';
it('probe', () => {
  for (const a of ARENA_DEFS) {
    const robust = claimFailures(a, [{ type: 'spawnBlockRobust', nudge: 0.1, why: 'probe' }]);
    console.log(a.id, 'spawnBlockRobust@0.1:', robust.length === 0 ? 'HOLDS' : `${robust.length} failures`);
  }
});
EOF
cp /tmp/probe.test.ts src/sim/probe.test.ts && npx vitest run src/sim/probe.test.ts; rm src/sim/probe.test.ts
```

Record which arenas hold. Claim `spawnBlockRobust` ONLY where it measurably holds; where it does not, that is a finding to report in the PR, not a claim to write.

- [ ] **Step 2: Write the claims into `arenas.json`**

`arena-03`'s claims, porting its bespoke describe block exactly (the lane endpoints come from the olive spawns at cells [1,1] and [9,1], each to its own column at the player's row 7):

```json
"claims": [
  { "type": "lane", "from": [1, 1], "to": [1, 7],
    "intact": "blocked", "breached": "open",
    "why": "The olive's shield is the ONLY wall on its flank column: breaching opens the lane end-to-end both ways -- the player can hunt up it, the olive's rockets command it down." },
  { "type": "lane", "from": [9, 1], "to": [9, 7],
    "intact": "blocked", "breached": "open",
    "why": "The mirrored flank: one shield per side is the level's trade." },
  { "type": "sightlineAfterBreach", "from": [1, 1], "sees": false,
    "why": "Unlike level 2, breaching opens NO spawn-to-spawn line here: the trade is lanes for mobile tanks, not spawn lines." },
  { "type": "sightlineAfterBreach", "from": [9, 1], "sees": false, "why": "Mirrored olive: same rule." },
  { "type": "sightlineAfterBreach", "from": [4, 2], "sees": false, "why": "Trio brown: the centre pillar keeps its line shut after the peek is breached." },
  { "type": "sightlineAfterBreach", "from": [5, 2], "sees": false, "why": "Trio grey: same pillar." },
  { "type": "sightlineAfterBreach", "from": [6, 2], "sees": false, "why": "Trio brown, mirrored." },
  { "type": "spawnBlockRobust", "nudge": 0.1,
    "why": "The row-5 chord-maker exists for this: with row 4 alone, both browns' post-breach blocks were a single-point corner tangency that a 0.1-unit player nudge opened into a full lane. Found by slab math in review." }
]
```

`arena-02`'s claims, porting its "destructible trade" block (upper pair at row 2 opens, lower pair at row 3 stays shut):

```json
"claims": [
  { "type": "sightlineAfterBreach", "from": [1, 2], "sees": true,
    "why": "Blowing the bar's inner end opens the UPPER pair's lane -- the trade the level is built around. Fails if a solid outer end went missing or the trade stopped existing." },
  { "type": "sightlineAfterBreach", "from": [9, 2], "sees": true, "why": "The mirrored upper lane." },
  { "type": "sightlineAfterBreach", "from": [1, 3], "sees": false,
    "why": "The LOWER pair stays shielded by the bar's solid anchors however much is destroyed." },
  { "type": "sightlineAfterBreach", "from": [9, 3], "sees": false, "why": "Mirrored lower lane." }
]
```

`arena-01`: add `{ "type": "spawnBlockRobust", "nudge": 0.1, "why": "..." }` **only if Step 1 measured it holding.**

- [ ] **Step 3: Replace the bespoke blocks with the generic runner**

In `src/sim/arena-validation.test.ts`: delete the two describe blocks `"ARENA_02's destructible trade"` and `"ARENA_03's flank-lane trade"` entirely, and add:

```typescript
import { ARENA_DEFS } from './config/arenas';
import { claimFailures } from './arena-claims';

// Design intent lives WITH the data now (config/data/arenas.json `claims`), verified
// here by one generic runner. The two hand-written describe blocks this replaces --
// ARENA_02's destructible trade and ARENA_03's flank lanes -- are re-expressed as
// claims, which is the migration's own proof: same properties, no bespoke geometry.
describe.each(ARENA_DEFS.map((a) => ({ id: a.id, arena: a })))('$id claims', ({ arena }) => {
  it('every declared design claim holds', () => {
    expect(claimFailures(arena, arena.claims).join('\n\n')).toBe('');
  });
});

it('the shipped arenas declare design claims, not just structure', () => {
  // Guards the migration itself: if a port dropped the claims, the runner above
  // would pass vacuously on empty arrays. Population: all 3 shipped arenas.
  const claimed = ARENA_DEFS.filter((a) => a.claims.length > 0);
  expect(claimed.length).toBeGreaterThanOrEqual(2); // arena-02 and arena-03 at minimum
});
```

- [ ] **Step 4: Run and verify**

Run: `npx vitest run src/sim/arena-validation.test.ts`
Expected: PASS. A failure prints the annotated board and the claim's `why`.

- [ ] **Step 5: Prove the claims can fail**

Flip one character in a claim (e.g. `arena-02`'s first `"sees": true` → `false`), re-run, confirm it fails naming that arena, then restore. Record the output.

- [ ] **Step 6: Full gate and commit**

```bash
npm test
git add src/sim/config/data/arenas.json src/sim/arena-validation.test.ts
git commit -m "arenas: design intent becomes data, and the bespoke tests retire

ARENA_02's destructible trade and ARENA_03's flank lanes are re-expressed as
declarative claims on the arenas themselves, verified by the generic runner --
same properties, same pass/fail, zero hand-written geometry left. The
spawnBlockRobust claim turns ARENA_03's corner-tangency defect, caught by slab
math in review, into a property every claiming arena is checked against."
```

---

### Task 5: The 15×11 fixture, and negative controls for the universal rules

**Files:**
- Create: `src/sim/config/arena-fixtures.ts`
- Modify: `src/sim/arena-validation.test.ts`, `src/sim/sandbox.test.ts`

**Interfaces:**
- Consumes: `validateArenas`, `validateArenaShape` (Task 1), `claimFailures` (Task 3), `sandboxArena` from `./sandbox`.
- Produces: `WIDE_ARENA`, `SEALED_POCKET_ARENA`, `OPEN_SIGHTLINE_ARENA` (all `ArenaDefinition`) from `config/arena-fixtures.ts`. `WIDE_ARENA` is also imported by the gl harness (Task 6); the two broken fixtures are the negative controls for `structuralFailures` (Task 3).

- [ ] **Step 1: Create the fixture**

```typescript
// src/sim/config/arena-fixtures.ts
import type { ArenaDefinition } from './arena-types';
import { validateArenas } from './validate';

/**
 * A deliberately NON-11x9 arena. It exists to prove the per-level render refit
 * (PR #53) and every size-generic code path really handle a different board --
 * the maps spec deferred variable dimensions until tooling could check them.
 *
 * TEST-ONLY: never in ARENAS, so it cannot reach the shipped sequence. It runs
 * through the same validator as the shipped file, so it cannot rot into
 * something the real pipeline would reject.
 */
export const WIDE_ARENA: ArenaDefinition = validateArenas(
  {
    arenas: [
      {
        id: 'fixture-wide',
        cols: 15, rows: 11, cellSize: 2,
        legend: { '#': 'solid', x: 'destructible' },
        grid: [
          '...............',
          '.B...........G.',
          '...............',
          '....#####......',
          '...............',
          '......x........',
          '...............',
          '......###......',
          '...............',
          '.......P.......',
          '...............',
        ],
        notes: ['15x11 fixture: proves per-level refit and every size-generic path.'],
        claims: [
          {
            type: 'sightlineAfterBreach', from: [1, 1], sees: true,
            why: 'The wide board leaves the flanks open: breaching changes nothing for this spawn.',
          },
        ],
      },
    ],
  },
  'arena-fixtures.ts',
)[0];

/**
 * DELIBERATELY BROKEN fixtures: the negative controls for the universal geometry
 * rules (src/sim/arena-claims.ts structuralFailures). Each is structurally VALID --
 * it passes validateArenas, so it reaches the geometry rules at all -- and violates
 * exactly one rule. A guard is worth what its own tests prove.
 */
export const SEALED_POCKET_ARENA: ArenaDefinition = validateArenas(
  {
    arenas: [{
      id: 'fixture-sealed',
      cols: 5, rows: 5, cellSize: 2,
      legend: { '#': 'solid' },
      // The B in the top-left is walled off by solids: no play opens it.
      grid: ['B#...', '##...', '.....', '..P..', '.....'],
      notes: ['Negative control: a solid-sealed pocket must be reported.'],
      claims: [],
    }],
  },
  'arena-fixtures.ts',
)[0];

export const OPEN_SIGHTLINE_ARENA: ArenaDefinition = validateArenas(
  {
    arenas: [{
      id: 'fixture-sightline',
      cols: 5, rows: 5, cellSize: 2,
      legend: { '#': 'solid' },
      // Brown and the player share a column with nothing between them.
      grid: ['..B..', '.....', '.....', '.....', '..P..'],
      notes: ['Negative control: an enemy holding a straight line to the player spawn.'],
      claims: [],
    }],
  },
  'arena-fixtures.ts',
)[0];
```

- [ ] **Step 2: Write the failing tests**

Append to `src/sim/arena-validation.test.ts`:

```typescript
import { WIDE_ARENA, SEALED_POCKET_ARENA, OPEN_SIGHTLINE_ARENA } from './config/arena-fixtures';
import { arenaBounds } from './arena';
import { structuralFailures } from './arena-claims';

describe('variable arena dimensions', () => {
  it('a 15x11 arena loads, validates, and is NOT the shipped size', () => {
    expect(WIDE_ARENA.cols).toBe(15);
    expect(WIDE_ARENA.rows).toBe(11);
    expect(arenaBounds(WIDE_ARENA)).toEqual({ width: 30, height: 22 });
    // The point of the fixture: it differs from every shipped arena.
    for (const a of ARENA_DEFS) expect(arenaBounds(a)).not.toEqual(arenaBounds(WIDE_ARENA));
  });

  it('the structural rules and the claim runner both handle it', () => {
    // structuralFailures, not the old local flood-fill helper: Task 3 extracted
    // and deleted that. Size-generic by construction -- it reads cols/rows off
    // the arena it is given.
    expect(structuralFailures(WIDE_ARENA)).toEqual([]);
    expect(claimFailures(WIDE_ARENA, WIDE_ARENA.claims)).toEqual([]);
  });

  it('loads into a world with the spawns its grid declares', () => {
    const { spawns } = loadArena(WIDE_ARENA);
    expect(spawns.filter((s) => s.kind === 'player')).toHaveLength(1);
    expect(spawns.filter((s) => s.kind !== 'player')).toHaveLength(2);
  });

  it('is never in the shipped sequence', () => {
    expect(ARENA_DEFS.map((a) => a.id)).not.toContain('fixture-wide');
  });
});

describe('the universal rules have negative controls', () => {
  // Without these, structuralFailures could return [] unconditionally and every
  // shipped arena would still look validated. The spec requires one bad fixture
  // per universal rule (population: both geometry rules; the spawn-count rule is
  // controlled at the validator level in validate.test.ts).
  it('a solid-sealed pocket is reported', () => {
    expect(structuralFailures(SEALED_POCKET_ARENA)[0]).toMatch(/sealed pocket/);
  });

  it('an enemy with a straight line to the player spawn is reported', () => {
    expect(structuralFailures(OPEN_SIGHTLINE_ARENA)[0]).toMatch(/spawn sightline/);
  });
});
```

Append to `src/sim/sandbox.test.ts`:

```typescript
import { validateArenaShape } from './config/validate';

it('the generated sandbox passes the same structural validator as a shipped arena', () => {
  // The sandbox is programmatic (query-parameterised, so it can never be a static
  // file), but it must clear the same bar: one player, an enemy, a legal grid.
  const arena = sandboxArena({ tanks: ['brown', 'grey', 'teal'], walls: 4, seed: 7 });
  expect(() => validateArenaShape(arena, 'sandbox', 'sandbox')).not.toThrow();
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run src/sim/arena-validation.test.ts src/sim/sandbox.test.ts`
Expected: FAIL — cannot resolve `./config/arena-fixtures`.

- [ ] **Step 4: Run to verify they pass**

After Step 1's file exists: `npx vitest run src/sim/arena-validation.test.ts src/sim/sandbox.test.ts`
Expected: PASS. If the fixture's claim measures differently, correct the FIXTURE's expectation to the measured truth and note it.

- [ ] **Step 5: Full gate and commit**

```bash
npm test
git add src/sim/config/arena-fixtures.ts src/sim/arena-validation.test.ts src/sim/sandbox.test.ts
git commit -m "arenas: a 15x11 fixture proves variable dimensions

The maps spec deferred variable arena sizes until tooling could check them; the
fixture is that check, running through the same validator, structural suite and
claim runner as a shipped arena while never entering ARENAS. The sandbox's
generated output now clears the same structural bar."
```

---

### Task 6: The gl harness renders the 15×11 board

**Files:**
- Modify: `tools/gl/harness.ts`

**Interfaces:**
- Consumes: `WIDE_ARENA` (Task 5), `createWorldFor`, `arenaBounds` from `src/sim/arena`; the harness's existing `check(name, fn)` (returns `string | null`), `fresh()`, `groundOf(ctx)`, `framedBounds(w, h, boundary)`.

- [ ] **Step 1: Add the check**

Append to `tools/gl/harness.ts`:

```typescript
import { WIDE_ARENA } from '../../src/sim/config/arena-fixtures';
import { createWorldFor } from '../../src/sim/arena';

check('the ground refits to a NON-shipped board size (15x11)', () => {
  // vitest cannot construct a WebGLRenderer, so per-level refit can only be
  // proven in a real browser. Without this, "variable dimensions work" rests on
  // geometry tests that never build a scene.
  const { width: w, height: h } = arenaBounds(WIDE_ARENA);
  const boundary = WIDE_ARENA.cellSize;
  const want = framedBounds(w, h, boundary);
  const ctx = fresh(createWorldFor(WIDE_ARENA));
  const g = groundOf(ctx);
  if (!g) { ctx.dispose(); return 'no PlaneGeometry mesh in the scene'; }
  const p = g.geometry.parameters;
  const centre = { x: g.position.x, z: g.position.z };
  ctx.dispose();
  if (p.width !== want.width || p.height !== want.height) {
    return `ground is ${p.width}x${p.height}, framed area for 15x11 is ${want.width}x${want.height}`;
  }
  if (Math.abs(centre.x - w / 2) > 1e-9 || Math.abs(centre.z - h / 2) > 1e-9) {
    return `ground centre (${centre.x}, ${centre.z}), arena centre (${w / 2}, ${h / 2})`;
  }
  return null;
});
```

If `fresh()` takes no world argument, first widen it to `fresh(world = createArenaWorld())` and leave every existing call site unchanged.

- [ ] **Step 2: Run the browser harness**

Run: `npm run test:gl`
Expected: all checks pass, including the new one. If it fails on ground SIZE, the refit is genuinely incomplete — that is a real finding about PR #53's coverage; report it rather than weakening the check.

- [ ] **Step 3: Commit**

```bash
npm test && npm run test:gl
git add tools/gl/harness.ts
git commit -m "gl: prove the ground refits to a non-shipped board size

vitest cannot construct a WebGLRenderer, so per-level refit could only be
claimed, not shown. The browser harness now builds a world from the 15x11
fixture and checks the ground plane's size and centring against it."
```

---

### Task 7: Documentation

**Files:**
- Modify: `CLAUDE.md`, `AGENTS.md`

**Interfaces:** none — documentation only.

- [ ] **Step 1: Add the architecture note**

In `CLAUDE.md`, in the "Architecture invariants" section, extend the entity-config paragraph:

```markdown
**Arenas are data too.** Grids, design rationale (`notes`) and machine-checkable
design `claims` live in `config/data/arenas.json`, validated at load by
`validateArenas` — a bad edit is a boot failure naming `arenas[2].grid[4]`.
`arena.ts` keeps every export it always had; `SPAWN_LETTERS` (config/arena-types.ts)
is the single source of the spawn-letter map. Three claim types —
`sightlineAfterBreach`, `lane`, `spawnBlockRobust` — are verified by
`src/sim/arena-claims.ts` from the test layer (it imports the AI's `lineOfSight`,
so it must never be imported by `config/`). Adding a level is editing JSON: the
generic runner picks up its claims automatically, and `npx vitest watch
src/sim/arena-validation.test.ts` is the authoring loop. `spawnBlockRobust` exists
because ARENA_03 once shipped a corner tangency a 0.1-unit nudge opened —
nudged-player probes are now automatic for any arena that claims it.
```

- [ ] **Step 2: Keep the two files identical and gate**

```bash
cp CLAUDE.md AGENTS.md
cmp CLAUDE.md AGENTS.md && echo identical
npm test
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md AGENTS.md
git commit -m "docs: arenas are data, and how to author one"
```

---

## Final verification

- [ ] `npm test` — full suite green (tsc + vitest)
- [ ] `npm run build` — production build clean
- [ ] `npm run test:gl` — browser harness green, including the 15×11 refit check
- [ ] Confirm no consumer outside `arena.ts` changed: `git diff --stat origin/main...HEAD` should show no edits to `src/game/levels.ts`, `src/render/`, or the gallery
- [ ] PR body records: the fidelity output from Task 2 Step 5, the `spawnBlockRobust` measurement from Task 4 Step 1 (including any arena where it does NOT hold), and the claim-can-fail proof from Task 4 Step 5
