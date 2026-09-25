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
import { summarise, knobIsWired, parseSeeds, groupRows, foldToProfiles, profileCoverage } from './stats.mjs';
import { patchField, patchProfileField, profileIds, readProfileField } from './patch.mjs';

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
  // Every profile's SHIPPED value, read before anything is patched. This is what the profiles
  // a `--profile` run leaves alone must still read back as.
  const authored = profileIds(original);
  const shipped = Object.fromEntries(
    authored.map((id) => [id, readProfileField(original, id, field)]).filter(([, v]) => v !== null),
  );
  const scope = profile === null ? `${expected} profile(s)` : `profile ${profile} only`;
  console.log(`sweeping ${field} over ${values.join(', ')} -- ${scope}, seeds ${seeds}, ${ticks} ticks each\n`);

  const rows = [];
  /** The raw per-child payloads, kept so the per-profile tables can be built after the loop. */
  const byValue = [];
  try {
    for (const value of values) {
      const { patched, count } = apply(original, value);
      if (count !== expected) throw new Error(`patched ${count} of ${expected} profiles for ${value}`);
      writeFileSync(PROFILES, patched);
      const raw = measure(seeds, ticks);
      // The child's own read-back, over EVERY profile. If any entry disagrees with what this
      // run asked for, the patch did not reach the simulation the way it was meant to and the
      // numbers from that process are about the wrong configuration.
      //
      // This used to read one profile, which proved a patch landed only when all of them moved
      // together and left `--profile` with no read-back at all. Asserting the whole map checks
      // both halves of a single-profile run: the named profile moved, and the other seven did
      // not -- a patch that leaked into a neighbour is exactly the failure that would make a
      // "personality difference" really a global rebalance.
      if (field === 'targetCommitmentTime') {
        for (const [id, observed] of Object.entries(raw.observedCommitmentByProfile ?? {})) {
          const want = profile === null || id === profile ? value : shipped[id];
          if (want !== undefined && observed !== want) {
            throw new Error(
              `${field}=${value}: profile ${id} should have read ${want} and the simulation read ${observed}`,
            );
          }
        }
      }
      rows.push(summarise({ value, changes: raw.changes, aiTicks: raw.aiTicks, pressureSamples: raw.pressureSamples }));
      byValue.push({ value, raw });
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
  // Per-profile attribution (issue #908). A pooled row cannot say WHICH tank changed its
  // habits, and with `--profile` one profile in eight moved -- diluted by whatever share of
  // AI-ticks it owns. These tables divide by each profile's own denominator instead.
  const perValue = byValue.map(({ value, raw }) => {
    const profileByKind = raw.profileByKind ?? {};
    const folded = foldToProfiles(raw.ticksByKind ?? {}, raw.sharedByKind ?? {}, profileByKind);
    return {
      value,
      byKind: groupRows({ changes: raw.changes, ticksByGroup: raw.ticksByKind ?? {}, sharedByGroup: raw.sharedByKind ?? {} }),
      byProfile: groupRows({
        changes: raw.changes,
        ticksByGroup: folded.ticks,
        sharedByGroup: folded.shared,
        groupOf: (c) => profileByKind[c.kind],
      }),
      coverage: profileCoverage(authored, [...new Set(Object.values(profileByKind))], folded.ticks),
    };
  });

  if (perValue.length > 0) {
    // Coverage first, and from the LAST value rather than a union: every child ran the same
    // seeds, so the sets agree, and reading one is what makes a disagreement visible as a
    // wrong-looking table rather than hidden by a merge.
    const cov = perValue[perValue.length - 1].coverage;
    console.log(`\nprofile coverage: ${cov.covered.length} of ${authored.length} authored profile(s) measured`);
    if (cov.unreachable.length > 0) {
      console.log(
        `  no tank kind carries: ${cov.unreachable.join(', ')}`
        + ' -- widening --seeds cannot reach these; their value is unfalsifiable until a kind adopts one.',
      );
    }
    if (cov.silent.length > 0) {
      console.log(`  carried by a kind but absent from these seeds: ${cov.silent.join(', ')} -- widen --seeds.`);
    }
    for (const { value, byProfile } of perValue) {
      console.log(`\n  ${field}=${value} per profile:`);
      for (const r of byProfile) {
        console.log(
          `    ${r.group.padEnd(18)} ticks ${String(r.aiTicks).padStart(7)}`
          + `  expiry-switches ${String(r.switchesOnExpiry).padStart(5)}`
          + `  per1k ${String(r.switchesOnExpiryPer1kTicks).padStart(7)}`
          + `  span p50 ${String(r.spanTicks.p50).padStart(5)}  max ${String(r.spanTicks.max).padStart(5)}`
          + `  shared p50 ${String(r.sharedTarget.p50).padStart(6)} (n ${r.sharedTarget.n})`,
        );
      }
    }
  }

  // Into `tmp/`, which .gitignore already covers. A generated result at the repository root
  // is one `git add -A` away from being committed as if it were source.
  mkdirSync(`${ROOT}tmp`, { recursive: true });
  const out = arg('out', 'tmp/ai-sweep.json');
  writeFileSync(
    `${ROOT}${out}`,
    `${JSON.stringify({ field, profile, seeds, ticks, shipped, rows, wired, perValue }, null, 2)}\n`,
  );
  console.log(`wrote ${out}`);
}

main();
