import { evaluateVersusBoard } from '../../src/sim/versus-board';
import { versusSpawnClearanceFailures } from '../../src/sim/versus-spawns';
import { loadArena } from '../../src/sim/arena';
import { measureBoard } from './measure';
import { RULESETS } from './rulesets.mjs';
import { writeBoardPng } from './render.mjs';

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
 *
 * Acceptance is never used as a score. `versus-board.ts` says of its own criteria that 0 of
 * 15 shipped (arena, N) combinations fail them; a generator tuned to maximise pass rate
 * converges on "not broken", which every ruleset here already is.
 *
 *   npx vite-node tools/mapgen/sweep.mjs                 # table over the default seeds
 *   npx vite-node tools/mapgen/sweep.mjs --seeds 40      # a wider sample
 *   npx vite-node tools/mapgen/sweep.mjs --png DIR       # also write one board per ruleset
 */

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const SEEDS = Number(arg('--seeds', '20'));
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
  const { walls, tanks } = loadArena(arena, n, 'ffa');
  void walls;
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
  for (let s = 1; s <= SEEDS; s++) boards.push({ seed: s, arena: job.generate(s) });

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
