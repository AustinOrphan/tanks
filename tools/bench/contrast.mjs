/**
 * The browser-CI render cost contrast (issue #738, part of #721): does the `low` quality preset
 * still cost clearly less than `high` on the machine that ran them?
 *
 * It reads the reports `tools/bench/runs.mjs` wrote, all from ONE run of that command, and compares
 * frame RATES within that run: frames measured per second of the measurement window. It never
 * compares an absolute figure with a number written here, because a runner's speed is not this
 * repository's to pin.
 *
 * THE RULE: the slowest `low` run must draw at least `MIN_FRAME_RATIO` times as many frames per
 * second as the fastest `high` run. Comparing the worst of one arm with the best of the other means
 * one lucky or unlucky run cannot carry the verdict either way.
 *
 * WHERE 1.15 COMES FROM, measured before it was chosen (issue #738 asks for exactly that order):
 * - A GitHub `ubuntu-latest` runner, software GL, 1280x800, 5 runs per arm: `low` drew 246 frames in
 *   every run, `high` 174-180. The rule's ratio there was about 1.37.
 * - A 4 GB development box, same setup, 3 runs per arm: `low` 326-342, `high` 234-247, about 1.32.
 * - With `low` given `high`'s settings, the two arms differ only by noise. `high`'s own fastest run
 *   against its slowest was 1.03 on the runner and 1.06 on the box, so a ratio of 1.15 separates a
 *   real contrast from none with room on both sides.
 *
 * WHAT IT DOES NOT MEASURE. Why `low` is cheaper: on both machines turning antialiasing off moved
 * frame rate far more than the shadow map did. Nor does it say anything about a phone. Software GL
 * rasterizes on the CPU, and its figures describe the machine that ran it, never a device budget.
 * #288 owns that.
 *
 * ARMS OTHER THAN THE PLAIN PRESETS (an override arm, say) are printed beside `high` for reading,
 * and asserted on nothing: the fill-and-rim-lights arm cleared `high` by 9 frames on the runner and
 * by one frame on the development box, which is not a margin to fail a build on.
 */
import { BENCH_REPORT_SCHEMA } from '../../src/game/bench';

export const MIN_FRAME_RATIO = 1.15;

/** Fewer runs per asserted arm than this and the worst-of-one-arm rule has nothing to work with. */
export const MIN_RUNS = 3;

const OVERRIDE_FIELDS = ['shadowMapSize', 'antialias', 'pixelRatioCap', 'fillRimLights'];

/** The arm a report ran, as `runs.mjs` names arms: `high`, `low`, `high+fillRimLights=false`. */
export function armOf(report) {
  const overrides = report.render?.overrides ?? {};
  const set = OVERRIDE_FIELDS.filter((f) => overrides[f] !== null && overrides[f] !== undefined).map((f) => `${f}=${overrides[f]}`);
  return [report.session.quality, ...set].join('+');
}

/** Frames per second of the measurement window. */
export function frameRate(report) {
  return report.frames.count / (report.measuredMs / 1000);
}

/**
 * Parse and check one report. Returns `{ run }` or `{ refusal }` naming the file and the reason.
 */
export function readRun(name, text) {
  let report;
  try {
    report = JSON.parse(text);
  } catch (error) {
    return { refusal: `${name}: not JSON (${error.message})` };
  }
  if (report?.schema !== BENCH_REPORT_SCHEMA) {
    return { refusal: `${name}: report schema ${JSON.stringify(report?.schema)}, this check reads ${BENCH_REPORT_SCHEMA}` };
  }
  if (report.phase !== 'done') return { refusal: `${name}: phase is ${JSON.stringify(report.phase)}, not "done"` };
  if (report.workload?.id !== 'versus-bots') return { refusal: `${name}: workload is ${JSON.stringify(report.workload?.id)}, not "versus-bots"` };
  if (!(report.frames?.count > 0) || !(report.measuredMs > 0)) return { refusal: `${name}: measured no frames` };
  return {
    run: {
      name,
      arm: armOf(report),
      rate: frameRate(report),
      frames: report.frames.count,
      sitting: JSON.stringify([report.build?.commit, report.page?.userAgent, report.page?.devicePixelRatio, report.page?.viewport]),
    },
  };
}

/**
 * The verdict for a set of runs from one sitting. `pass` is true only when both asserted arms have
 * at least `MIN_RUNS` runs and the slowest `low` run reaches `ratio` times the fastest `high` run.
 */
export function contrastVerdict(runs, ratio = MIN_FRAME_RATIO) {
  const rates = (arm) => runs.filter((r) => r.arm === arm).map((r) => r.rate);
  const high = rates('high');
  const low = rates('low');
  if (high.length < MIN_RUNS || low.length < MIN_RUNS) {
    return { pass: false, reason: `needs at least ${MIN_RUNS} runs each of high and low; got ${high.length} high, ${low.length} low` };
  }
  const highFastest = Math.max(...high);
  const lowSlowest = Math.min(...low);
  const measured = lowSlowest / highFastest;
  return {
    pass: measured >= ratio,
    measured,
    ratio,
    highFastest,
    lowSlowest,
    reason:
      measured >= ratio
        ? `the slowest low run drew ${measured.toFixed(2)}x the fastest high run's frame rate, at least ${ratio}x`
        : `the slowest low run drew only ${measured.toFixed(2)}x the fastest high run's frame rate, under ${ratio}x: low no longer costs clearly less than high`,
  };
}

/**
 * The command: read every `*.json` under `dir`, check the contrast, print a table. Returns the exit
 * code: 0 the contrast holds, 1 it does not or the reports were refused, 2 no directory named.
 */
export function runContrast(args, io, fs) {
  const [dir] = args;
  if (!dir) {
    io.error('usage: npm run bench:contrast -- <directory of runs.mjs reports>');
    return 2;
  }
  const names = fs.readdir(dir).filter((n) => n.endsWith('.json')).sort();
  const runs = [];
  const refusals = [];
  for (const name of names) {
    const result = readRun(name, fs.read(`${dir}/${name}`));
    if (result.refusal) refusals.push(result.refusal);
    else runs.push(result.run);
  }
  if (refusals.length > 0) {
    io.error(`Refused ${refusals.length} of ${names.length} report(s):`);
    for (const r of refusals) io.error(`- ${r}`);
    return 1;
  }
  if (new Set(runs.map((r) => r.sitting)).size > 1) {
    io.error('These reports are not one build, browser, pixel ratio and viewport, so they are not compared.');
    return 1;
  }
  const arms = [...new Set(runs.map((r) => r.arm))].sort();
  const highRates = runs.filter((r) => r.arm === 'high').map((r) => r.rate);
  const highMedian = highRates.length > 0 ? [...highRates].sort((a, b) => a - b)[Math.ceil(highRates.length / 2) - 1] : null;
  io.log('| arm | runs | frames per run | frames/s slowest-fastest | vs high (median run) | asserted |');
  io.log('| --- | --- | --- | --- | --- | --- |');
  for (const arm of arms) {
    const armRuns = runs.filter((r) => r.arm === arm);
    const rates = armRuns.map((r) => r.rate).sort((a, b) => a - b);
    const median = rates[Math.ceil(rates.length / 2) - 1];
    const vsHigh = highMedian === null ? '--' : `${(median / highMedian).toFixed(2)}x`;
    io.log(
      `| ${arm} | ${armRuns.length} | ${armRuns.map((r) => r.frames).join(', ')} | ${rates[0].toFixed(2)}-${rates[rates.length - 1].toFixed(2)} | ${vsHigh} | ${arm === 'high' || arm === 'low' ? 'yes' : 'no, for reading'} |`,
    );
  }
  const verdict = contrastVerdict(runs);
  io.log('');
  io.log(`${verdict.pass ? 'PASS' : 'FAIL'}: ${verdict.reason}.`);
  io.log('Software GL on this machine only; not a device frame-time budget.');
  return verdict.pass ? 0 : 1;
}
