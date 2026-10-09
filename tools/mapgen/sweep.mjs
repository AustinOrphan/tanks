import { evaluateVersusBoard } from '../../src/sim/versus-board';
import { versusSpawnClearanceFailures } from '../../src/sim/versus-spawns';
import { loadArena } from '../../src/sim/arena';
import { measureBoard } from './measure';
import { RULESETS } from './rulesets.mjs';
import { writeBoardPng } from './render.mjs';
import { expressiveRange, renderExpressiveRange } from './expressive-range.mjs';
import { seedRange } from './lib.mjs';
import { THREE_PLAYER_SPREAD_CEILING, passesSpreadGate } from './spread-gate.mjs';

/**
 * Generate boards from every ruleset over a seed sample, filter them through the SHIPPED
 * acceptance rules, measure the survivors, and print one row per (ruleset, player count).
 *
 * THE THREE TIERS STAY SEPARATE, and the order matters:
 *
 *   1. GENERATE -- the ruleset's own rules build a board from a seed.
 *   2. ACCEPT   -- `evaluateVersusBoard` and `versusSpawnClearanceFailures`, unchanged and
 *                  unextended, say pass or fail. The ACCEPT RATE is reported per ruleset,
 *                  because a ruleset that needs 40 draws to land one board is a different
 *                  proposition from one that lands 9 in 10, even if their boards measure
 *                  the same.
 *   3. MEASURE  -- the quality tier ranks the boards that passed.
 *   4. SPREAD   -- at three players only, the one ruled gate fed by a quality measure
 *                  (issue #820): `passesSpreadGate` in `spread-gate.mjs` refuses a board whose
 *                  spawn-path spread is over the ceiling derived from the shipped boards. It
 *                  runs after the shipped tier, on boards that tier accepted, and a refused seed
 *                  is reported, not retried. Tiers 1-3 are unchanged by it, and no other quality
 *                  measure gates anything (see that module's header for why this one does).
 *
 * Acceptance is never used as a score. `versus-board.ts` says of its own criteria that 0 of
 * 15 shipped (arena, N) combinations fail them; a generator tuned to maximise pass rate
 * converges on "not broken", which every ruleset here already is.
 *
 *   npx vite-node tools/mapgen/sweep.mjs                 # table over the default seeds
 *   npx vite-node tools/mapgen/sweep.mjs --seeds 40      # a wider sample
 *   npx vite-node tools/mapgen/sweep.mjs --seeds 30 --seed-offset 30   # a DISJOINT second sample
 *   npx vite-node tools/mapgen/sweep.mjs --png DIR       # also write one board per ruleset
 *   npx vite-node tools/mapgen/sweep.mjs --axes a,b      # pick the expressive-range axes
 *
 * THE TABLE IS MEANS, AND A MEAN HIDES A GENERATOR'S WHOLE PROBLEM: a ruleset that emits one
 * board twenty times and a ruleset that emits twenty different boards print the same row.
 * The expressive-range block after the table is the fix (issue #822) -- per-axis spread, and
 * how much of a fixed two-axis grid each ruleset's sample actually reaches.
 */

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const SEEDS = Number(arg('--seeds', '20'));
const SEED_OFFSET = Number(arg('--seed-offset', '0'));
const COUNTS = process.argv.includes('--variants') ? [4] : [2, 3, 4];
const PNG_DIR = arg('--png', null);
/**
 * `--variants` sweeps ONE RULE AT A TIME instead of comparing rulesets: each ruleset declares
 * a short list of single-knob variants, and the table shows which measures that knob actually
 * moves. A rule whose whole parameter range leaves every column flat is not a rule, and this
 * is how that gets found out before it is written into a specification.
 */
const VARIANTS = process.argv.includes('--variants');

/** The acceptance tier: the shipped rules, called exactly as the shipped catalog sweep calls them. */
function accepts(arena, n) {
  const verdict = evaluateVersusBoard(arena, n);
  if (!verdict.suitable) return { ok: false, why: reasonFor(verdict) };
  const { tanks } = loadArena(arena, n, 'ffa');
  const positions = tanks.filter((t) => t.kind === 'player').map((t) => t.pos);
  const failures = versusSpawnClearanceFailures(
    arena.grid, arena.cols, arena.rows, arena.cellSize, arena.legend, positions,
  );
  return failures.length ? { ok: false, why: 'clearance' } : { ok: true, why: '' };
}

/** Which criterion refused it -- so a low accept rate says WHICH rule the ruleset fights. */
function reasonFor(v) {
  if (!v.distinctSpawns) return 'distinct-spawns';
  if (!v.allPairsConcealed) return 'concealment';
  if (!v.roomOk) return 'room';
  if (!v.egressOk) return v.fatalEscapes > 0 ? 'fatal-escape' : 'egress';
  return 'unknown';
}

const mean = (xs) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : NaN);
const f = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '  --');

const rows = [];
const jobs = [];
for (const key of Object.keys(RULESETS)) {
  const ruleset = RULESETS[key];
  if (VARIANTS) {
    for (const v of ruleset.variants ?? [{ label: 'default', opts: {} }]) {
      jobs.push({ label: `${key} ${v.label}`, generate: (s) => ruleset.generate(s, v.opts) });
    }
  } else {
    jobs.push({ label: key, generate: (s) => ruleset.generate(s) });
  }
}

for (const job of jobs) {
  const key = job.label;
  const boards = [];
  for (const s of seedRange(SEED_OFFSET, SEEDS)) boards.push({ seed: s, arena: job.generate(s) });

  for (const n of COUNTS) {
    const verdicts = boards.map((b) => ({ ...b, verdict: accepts(b.arena, n) }));
    const passed = verdicts.filter((b) => b.verdict.ok);
    const refusals = {};
    for (const b of verdicts) if (!b.verdict.ok) refusals[b.verdict.why] = (refusals[b.verdict.why] ?? 0) + 1;
    const ms = passed.map((b) => measureBoard(b.arena, n, `${key}-${b.seed}`));
    rows.push({
      ruleset: key,
      playerCount: n,
      drawn: boards.length,
      accepted: passed.length,
      refusals,
      m: ms,
      // Tier 4 (issue #820): of the shipped-tier accepted boards, those the spread gate passes.
      spreadPassed: ms.filter((m) => passesSpreadGate(m, n)).length,
    });
    if (PNG_DIR && n === 4 && passed.length) {
      writeBoardPng(passed[0].arena, `${PNG_DIR}/${key}-seed${passed[0].seed}.png`, { playerCount: 4, scale: 20 });
    }
  }
}

console.log('ruleset            N  acc/drawn  wall  dstr  cov  legal  corr  open  neck  rout  pMin  sprd  pts  sight  bank  rot');
for (const r of rows) {
  const g = (field, d = 2) => f(mean(r.m.map((m) => m[field])), d);
  console.log([
    r.ruleset.padEnd(17),
    String(r.playerCount),
    `${String(r.accepted).padStart(3)}/${String(r.drawn).padEnd(3)}`,
    g('wallFraction'), g('destructibleFraction'),
    f(mean(r.m.map((m) => m.coverPieces)), 0).padStart(3),
    g('legalAreaFraction'), g('corridorAreaFraction'), g('openGroundFraction'),
    g('bottleneckWidth').padStart(4), g('routeCount'),
    f(mean(r.m.map((m) => m.pathMin)), 1).padStart(4), g('pathSpread'),
    f(mean(r.m.map((m) => m.samplePoints)), 0).padStart(3),
    g('openSightFraction'), g('bankGain'), g('asymmetryRotational'),
  ].join('  '));
}
console.log();
console.log('Every figure after acc/drawn is a MEAN over the ACCEPTED boards only, so a low');
console.log('accept rate means a small denominator -- read the two together. Columns carry the');
console.log('same meanings as tools/mapgen/calibrate.mjs prints for the shipped boards.');
console.log();
for (const r of rows) {
  const why = Object.entries(r.refusals).map(([k, v]) => `${k} ${v}`).join(', ');
  if (why) console.log(`  ${r.ruleset} N=${r.playerCount} refused: ${why}`);
}

// ---- the 3-player spread gate (issue #820) ----
const threes = rows.filter((r) => r.playerCount === 3);
if (threes.length > 0) {
  console.log();
  console.log(`SPREAD GATE at N=3: pathSpread <= ${THREE_PLAYER_SPREAD_CEILING}, after the shipped tier (seeds ${SEED_OFFSET + 1}-${SEED_OFFSET + SEEDS})`);
  console.log('ruleset            shipped  +spread  refused (shipped tier; spread)          pathSpread min / median / max');
  for (const r of threes) {
    const shippedWhy = Object.entries(r.refusals).map(([k, v]) => `${k} ${v}`).join(', ') || 'none';
    const spreads = r.m.map((m) => m.pathSpread).sort((a, b) => a - b);
    const median = spreads.length ? spreads[Math.floor((spreads.length - 1) / 2)] : NaN;
    console.log([
      r.ruleset.padEnd(17),
      `${String(r.accepted).padStart(3)}/${String(r.drawn).padEnd(3)}`,
      `${String(r.spreadPassed).padStart(3)}/${String(r.drawn).padEnd(3)}`,
      `${shippedWhy}; spread ${r.accepted - r.spreadPassed}`.padEnd(38),
      `${f(spreads[0])} / ${f(median)} / ${f(spreads[spreads.length - 1])}`,
    ].join('  '));
  }
}

// ---- expressive range (issue #822) ----
// The grid is FIXED, from `SHIPPED_RANGES`, so two rulesets are scored against the same
// space. A grid scaled to each sample would be covered 100% by every ruleset including one
// that emits the same board twenty times.
const [AX, AY] = arg('--axes', 'wallFraction,openSightFraction').split(',');
console.log();
console.log(`EXPRESSIVE RANGE over a fixed ${AX} x ${AY} grid -- what the means above hide:`);
for (const r of rows) {
  if (r.m.length === 0) continue;
  const range = expressiveRange(r.m, { x: AX, y: AY, bins: 8 });
  for (const line of renderExpressiveRange(range, `${r.ruleset} N=${r.playerCount}`)) console.log(line);
}
console.log();
console.log('coverage = occupied cells / 64. entropy = how evenly the sample fills what it');
console.log('reaches, 0 = one cell, 1 = even over the whole grid. Read the axis correlation');
console.log('FIRST: on the shipped boards every candidate axis pair runs |r| 0.78-0.95, so a');
console.log('two-axis grid over them is close to one-dimensional and coverage is bounded by a');
console.log('diagonal band rather than by the ruleset. See expressive-range.mjs.');
