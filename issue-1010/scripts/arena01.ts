// #1010 shared helpers: the BEFORE arena-01 (read from git at the base commit, validated by the
// tree's own validateArenas) and the three candidate AFTER grids (criterion 4's cell order).
//
// Read-only. Imports the repository's own modules from ROOT, writes nothing in the tree.
// ROOT defaults to the current directory, so run every script from the tree being measured:
//   cd <tree> && npx vite-node /Users/austinorphan/.claude/jobs/8fe9c2c6/tmp/w1010/<script>.ts
// BASE_REF (default c200cf62, the commit #1010 was re-verified against) names the BEFORE data.
import { execFileSync } from 'node:child_process';

export const ROOT = process.env.TANKS_ROOT ?? process.cwd();
export const BASE_REF = process.env.BASE_REF ?? 'c200cf62';

const { validateArenas } = await import(`${ROOT}/src/sim/config/validate.ts`);

export type Grid = string[];
export interface ArenaDef {
  id: string; cols: number; rows: number; cellSize: number;
  legend: Record<string, 'solid' | 'destructible'>; grid: Grid;
  notes?: unknown; claims?: unknown;
}

/** Spawn cells on the BASE grid, [row, col]. Asserted against the grid, not trusted. */
export const BASE_SPAWNS = { B: [7, 13], G: [7, 19], T: [10, 16], P: [22, 16] } as const;
export type Candidate = 'brown' | 'teal' | 'grey';
/** Criterion 4's order: brown's current cell (smallest edit), then teal's, then grey's. */
export const CANDIDATES: readonly Candidate[] = ['brown', 'teal', 'grey'];
const KEEP: Record<Candidate, keyof typeof BASE_SPAWNS> = { brown: 'B', teal: 'T', grey: 'G' };

export function baseArena01(): ArenaDef {
  const json = execFileSync('git', ['-C', ROOT, 'show', `${BASE_REF}:src/sim/config/data/arenas.json`], {
    encoding: 'utf8',
  });
  const a = (validateArenas(JSON.parse(json)) as ArenaDef[]).find((d) => d.id === 'arena-01');
  if (!a) throw new Error(`arena-01 missing at ${BASE_REF}`);
  for (const [letter, [r, c]] of Object.entries(BASE_SPAWNS)) {
    if (a.grid[r][c] !== letter) throw new Error(`base grid: expected ${letter} at row ${r} col ${c}, found ${a.grid[r][c]}`);
  }
  return a;
}

function setCell(grid: Grid, r: number, c: number, ch: string): Grid {
  const next = grid.slice();
  next[r] = next[r].slice(0, c) + ch + next[r].slice(c + 1);
  return next;
}

/** The kept cell is re-lettered `B`; the other two enemy letters become `.`. Walls and P untouched. */
export function candidateGrid(base: Grid, keep: Candidate): Grid {
  let g = base;
  for (const letter of ['B', 'G', 'T'] as const) {
    const [r, c] = BASE_SPAWNS[letter];
    g = setCell(g, r, c, letter === KEEP[keep] ? 'B' : '.');
  }
  return g;
}

/** Enemy spawn letters read as floor; P kept. Criterion 2's comparison form. */
export function asFloor(grid: Grid): Grid {
  return grid.map((row) => row.replace(/[BGTONY]/g, '.'));
}

/** Criteria 1 and 2 as plain checks, so a wrong candidate fails loudly before anything is measured. */
export function shapeFailures(grid: Grid, base: Grid): string[] {
  const out: string[] = [];
  const count = (ch: string) => grid.join('').split(ch).length - 1;
  if (count('B') !== 1) out.push(`B count ${count('B')}`);
  if (count('P') !== 1) out.push(`P count ${count('P')}`);
  for (const ch of ['G', 'T', 'O', 'N', 'Y']) if (count(ch) !== 0) out.push(`${ch} count ${count(ch)}`);
  if (asFloor(grid).join('\n') !== asFloor(base).join('\n')) out.push('walls or P differ from base');
  return out;
}

/** Which candidate a grid is, or null. Used to label the tree's own arena-01. */
export function whichCandidate(grid: Grid, base: Grid): Candidate | 'base' | null {
  if (grid.join('\n') === base.join('\n')) return 'base';
  for (const c of CANDIDATES) if (grid.join('\n') === candidateGrid(base, c).join('\n')) return c;
  return null;
}

/** Selects an arena-01 state by name: base | tree | brown | teal | grey. */
export async function arena01State(name: string): Promise<ArenaDef> {
  const base = baseArena01();
  if (name === 'base') return base;
  if (name === 'tree') {
    const { arenaById } = await import(`${ROOT}/src/sim/arena.ts`);
    return arenaById('arena-01') as ArenaDef;
  }
  if ((CANDIDATES as readonly string[]).includes(name)) {
    const grid = candidateGrid(base.grid, name as Candidate);
    const fails = shapeFailures(grid, base.grid);
    if (fails.length) throw new Error(`candidate ${name}: ${fails.join('; ')}`);
    return { ...base, grid };
  }
  throw new Error(`unknown arena-01 state '${name}' (base | tree | ${CANDIDATES.join(' | ')})`);
}

export function argValue(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}
