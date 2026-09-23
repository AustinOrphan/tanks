/**
 * Sweep an AI tunable across values and report what each one does to target selection
 * (issue #359).
 *
 *   npm run ai:sweep -- --values 0.5,1,1.5,2,3 --seeds 1-20 --ticks 1800
 *
 * WHY A PATCH-AND-RESTORE SWEEP, rather than passing the value in. `decideCommitment` reads
 * `configFor(tank.kind)`, and `configFor` returns from a catalog `src/sim/config/roster.ts`
 * resolves ONCE at module load from validated JSON. There is no override seam, and
 * CLAUDE.md forbids adding parallel configuration plumbing or a runtime flag to `src/sim/`.
 * So the tunable is edited on disk, measured in a FRESH process, and restored -- the same
 * shape `npm run gallery -- --sweep` uses for render constants, including its two safety
 * rules: refuse to start if the target file is already dirty, and restore in a `finally`.
 *
 * THE FIRST THING REPORTED IS WHETHER THE KNOB IS CONNECTED. A sweep whose patch never
 * reaches the simulation prints identical rows, which reads exactly like "this parameter
 * does not matter" -- a wrong conclusion that is very easy to publish. Each child also reads
 * the value back out of the resolved config and returns it, so the parent can check that the
 * process it measured actually held the value it was asked for.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { summarise, knobIsWired, parseSeeds } from './stats.mjs';
import { patchField, patchProfileField, profileIds } from './patch.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PROFILES_REL = 'src/sim/config/data/ai-profiles.json';
const PROFILES = `${ROOT}${PROFILES_REL}`;

/** Tunables this sweep knows how to patch. An unknown one is refused by name. */
const FIELDS = ['targetCommitmentTime'];

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}

const sh = (cmd, args) => execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8' });

/** Refuse to run if the file this sweep rewrites already has uncommitted changes. */
function assertClean() {
  const dirty = sh('git', ['status', '--porcelain', '--', PROFILES_REL]).trim();
  if (dirty) {
    console.error(`refusing to sweep with uncommitted changes in ${PROFILES_REL}:`);
    console.error(dirty);
    console.error('commit or stash them first -- a sweep rewrites this file and restores it after.');
    process.exit(2);
  }
}

function measure(seeds, ticks) {
  const r = spawnSync(
    process.execPath,
    [`${ROOT}node_modules/.bin/vite-node`, `${ROOT}tools/ai-sweep/measure.mjs`, '--', '--seeds', seeds, '--ticks', String(ticks)],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  if (r.status !== 0) {
    throw new Error(`measure failed (exit ${r.status}):\n${(r.stderr || '').slice(-2000)}`);
  }
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new Error(`measure printed no JSON. stderr tail:\n${(r.stderr || '').slice(-2000)}`);
  }
}

function main() {
  const field = arg('field', 'targetCommitmentTime');
  if (!FIELDS.includes(field)) {
    console.error(`unknown field '${field}'; this sweep knows: ${FIELDS.join(', ')}`);
    process.exit(2);
  }
  const values = String(arg('values', '0.5,1,1.5,2,3')).split(',').map((v) => Number(v.trim()));
  if (values.some((v) => !Number.isFinite(v) || v < 0)) {
    console.error('--values must be non-negative numbers');
    process.exit(2);
  }
  // Issue #908: vary ONE profile while the other seven hold, which is what shows a
  // personality difference rather than a global rebalance. Absent, every profile moves
  // together, which is what #359 needed and is still the default.
  const profile = arg('profile', null);
  const seeds = arg('seeds', '1-20');
  parseSeeds(seeds); // fail here, with the bad spec named, rather than inside every child
  const ticks = Number(arg('ticks', 1800));

  assertClean();
  const original = readFileSync(PROFILES, 'utf8');
  if (profile !== null && !profileIds(original).includes(profile)) {
    console.error(`unknown profile '${profile}'; ${PROFILES_REL} has: ${profileIds(original).join(', ')}`);
    process.exit(2);
  }
  const apply = (text, value) =>
    profile === null ? patchField(text, field, value) : patchProfileField(text, profile, field, value);
  const expected = apply(original, 0).count;
  if (expected === 0) {
    console.error(
      profile === null
        ? `no "${field}" found in ${PROFILES_REL}`
        : `no "${field}" on profile ${profile} in ${PROFILES_REL}`,
    );
    process.exit(2);
  }
  const scope = profile === null ? `${expected} profile(s)` : `profile ${profile} only`;
  console.log(`sweeping ${field} over ${values.join(', ')} -- ${scope}, seeds ${seeds}, ${ticks} ticks each\n`);

  const rows = [];
  try {
    for (const value of values) {
      const { patched, count } = apply(original, value);
      if (count !== expected) throw new Error(`patched ${count} of ${expected} profiles for ${value}`);
      writeFileSync(PROFILES, patched);
      const raw = measure(seeds, ticks);
      // The child's own read-back. If this disagrees, the patch did not reach the simulation
      // and every number from that process is about the wrong configuration.
      // The child reads ONE profile's resolved value back, so this only proves the patch
      // landed when every profile moved together. With --profile the child may legitimately
      // report a profile that was deliberately left alone, so the check that the patch is
      // real is the count above plus `knobIsWired` over the rows.
      if (profile === null && raw.observedCommitmentTime !== value && field === 'targetCommitmentTime') {
        throw new Error(`asked for ${field}=${value} but the simulation read ${raw.observedCommitmentTime}`);
      }
      rows.push(summarise({ value, changes: raw.changes, aiTicks: raw.aiTicks, pressureSamples: raw.pressureSamples }));
      const r = rows[rows.length - 1];
      console.log(
        `  ${field}=${String(value).padEnd(5)} changes ${String(r.changes).padStart(5)}`
        + `  per1k ${String(r.changesPer1kTicks).padStart(7)}`
        + `  expiry-switches ${String(r.switchesOnExpiry).padStart(5)}`
        + `  span p50 ${String(r.spanTicks.p50).padStart(5)}  max ${String(r.spanTicks.max).padStart(5)}`
        + `  pressure p50 ${String(r.pressure.p50).padStart(6)}`,
      );
    }
  } finally {
    writeFileSync(PROFILES, original);
    const after = sh('git', ['status', '--porcelain', '--', PROFILES_REL]).trim();
    console.log(after ? `\nWARNING: left modified\n${after}` : `\nrestored ${PROFILES_REL}`);
  }

  const wired = knobIsWired(rows);
  console.log(
    `\nverdict: ${wired.verdict} -- ${wired.totalExpirySwitches} expiry-switch(es) across ${wired.rows} rows`
    + `, ${wired.distinctSignatures} distinct span signature(s)`,
  );
  if (wired.verdict === 'no-signal') {
    console.log(
      `too few expiry switches (< ${wired.minExpirySwitches}) for this parameter to have acted on.`
      + ' Identical rows here say NOTHING about it: widen --seeds or --ticks and run again.',
    );
    process.exitCode = 1;
  } else if (wired.verdict === 'dead-knob') {
    console.log(
      'there WAS signal and every row is still identical. Do not report this as "the parameter'
      + ' does not matter" -- check that the measure watches the code path the patch changes.',
    );
    process.exitCode = 1;
  }
  // Into `tmp/`, which .gitignore already covers. A generated result at the repository root
  // is one `git add -A` away from being committed as if it were source.
  mkdirSync(`${ROOT}tmp`, { recursive: true });
  const out = arg('out', 'tmp/ai-sweep.json');
  writeFileSync(`${ROOT}${out}`, `${JSON.stringify({ field, seeds, ticks, rows, wired }, null, 2)}\n`);
  console.log(`wrote ${out}`);
}

main();
