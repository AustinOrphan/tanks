/**
 * Compares a set of benchmark reports taken on ONE device in ONE sitting (issue #737, part of
 * #721). The procedure in docs/superpowers/plans/2026-09-14-device-benchmark-procedure.md says
 * how to take them; `tools/bench/summarize.mjs` is the command.
 *
 * Each report is the JSON `__tanks.bench()` returns (`src/game/bench.ts`'s `BenchReport`). A
 * report is REFUSED, never guessed at, when:
 * - its `schema` is not `BENCH_REPORT_SCHEMA`, the version this reader was written for;
 * - its measurement window has not closed (`phase` other than `done`), or measured no frames;
 * - a field this summary reads is missing or of the wrong type;
 * - its page query is not its workload's own query, plus only the sweep flags in `ARM_FLAGS`.
 *
 * A SET is refused when its reports differ in anything that makes them different sittings or
 * devices: the workload, the user agent, the device pixel ratio, the viewport, the build, and
 * for a session workload the seed, mode and player counts. What is left to differ is the arm:
 * the quality preset and the render overrides, which is what a sweep varies.
 *
 * WHAT THE RATIOS MEAN. Every ratio divides one arm's figure by the BASELINE arm's figure from
 * the same set, the baseline being the arm of the first report named. Both come from the same
 * device and sitting, so the ratio says how much that arm's setting moved this device's frame
 * times. It is not a frame-time budget, and a ratio from one device says nothing about another.
 * The absolute milliseconds are printed because #288 records them for the device measured;
 * they are this device's figures only.
 */
import { BENCH_REPORT_SCHEMA } from '../../src/game/bench';

/**
 * The query parameters a report may carry beyond its workload's own query: the quality preset
 * and the four single-setting render overrides (`src/game/devflags.ts`, issues #734 and #735).
 */
export const ARM_FLAGS = ['quality', 'shadowMapSize', 'antialias', 'pixelRatioCap', 'fillRimLights'];

/** The override fields a session report's `render.overrides` carries, in label order. */
const OVERRIDE_FIELDS = ['shadowMapSize', 'antialias', 'pixelRatioCap', 'fillRimLights'];

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNumber = (v) => typeof v === 'number' && Number.isFinite(v);

/** The value at a dotted path, or undefined when any step is missing. */
function at(value, path) {
  let node = value;
  for (const key of path.split('.')) {
    if (!isObject(node)) return undefined;
    node = node[key];
  }
  return node;
}

/** The fields every report must carry, with the check each must pass. */
const REQUIRED = [
  ['workload.id', (v) => typeof v === 'string'],
  ['workload.subject', (v) => v === 'session' || v === 'preview'],
  ['workload.query', (v) => typeof v === 'string'],
  ['frames.count', isNumber],
  ['frames.p50', isNumber],
  ['frames.p95', isNumber],
  ['frames.p99', isNumber],
  ['frames.over16_7', isNumber],
  ['frames.over33_3', isNumber],
  ['work.p95', isNumber],
  ['render.pixelRatioCap', isNumber],
  ['render.effectivePixelRatio', isNumber],
  ['page.search', (v) => typeof v === 'string'],
  ['page.userAgent', (v) => typeof v === 'string'],
  ['page.devicePixelRatio', isNumber],
  ['page.viewport.width', isNumber],
  ['page.viewport.height', isNumber],
  ['build.commit', (v) => typeof v === 'string'],
];

/** The further fields a session workload's report must carry. */
const REQUIRED_SESSION = [
  ['session.quality', (v) => typeof v === 'string'],
  ['session.seed', isNumber],
  ['session.mode', (v) => typeof v === 'string' || v === null],
  ['session.humanPlayers', isNumber],
  ['session.bots', isNumber],
];

/**
 * Where the page query breaks the workload's own: a workload parameter missing or changed, or
 * a parameter that is neither the workload's nor one of the `allowed` sweep flags. Empty when
 * the query is the workload's, plus allowed sweep flags only.
 */
export function queryMismatches(workloadQuery, pageSearch, allowed = ARM_FLAGS) {
  const want = new URLSearchParams(workloadQuery);
  const got = new URLSearchParams(pageSearch);
  const problems = [];
  for (const [key, value] of want) {
    if (got.get(key) !== value) problems.push(`${key} is ${JSON.stringify(got.get(key))}, the workload's is ${JSON.stringify(value)}`);
  }
  for (const key of new Set(got.keys())) {
    if (want.has(key) || allowed.includes(key)) continue;
    problems.push(
      ARM_FLAGS.includes(key)
        ? `${key} is a sweep flag this workload's renderer ignores`
        : `${key} is neither the workload's nor a sweep flag`,
    );
  }
  return problems;
}

/**
 * Parse and check one report. Returns `{ run }` for a report this summary can read, or
 * `{ refusal }` naming the file and every reason it cannot.
 */
export function readReport(name, text) {
  let report;
  try {
    report = JSON.parse(text);
  } catch (error) {
    return { refusal: `${name}: not JSON (${error.message})` };
  }
  if (!isObject(report)) return { refusal: `${name}: not a report object` };
  if (report.schema !== BENCH_REPORT_SCHEMA) {
    return {
      refusal:
        `${name}: report schema ${JSON.stringify(report.schema)}, but this summarizer reads schema ` +
        `${BENCH_REPORT_SCHEMA}. Take the report again on a build whose report matches, or update the summarizer.`,
    };
  }
  const reasons = [];
  if (report.phase !== 'done') {
    reasons.push(`phase is ${JSON.stringify(report.phase)}; read the report only once it is "done"`);
  }
  const subject = at(report, 'workload.subject');
  const required = subject === 'session' ? [...REQUIRED, ...REQUIRED_SESSION] : REQUIRED;
  for (const [path, ok] of required) {
    if (!ok(at(report, path))) reasons.push(`${path} is missing or not the expected type`);
  }
  if (isObject(report.render) && !('overrides' in report.render)) {
    reasons.push('render.overrides is missing');
  } else if (subject === 'session' && isObject(report.render) && report.render.overrides !== null) {
    if (!isObject(report.render.overrides) || OVERRIDE_FIELDS.some((f) => !(f in report.render.overrides))) {
      reasons.push('render.overrides does not carry the four override fields');
    }
  }
  if (isNumber(at(report, 'frames.count')) && report.frames.count === 0) reasons.push('measured no frames');
  if (typeof at(report, 'workload.query') === 'string' && typeof at(report, 'page.search') === 'string') {
    // The preview builds its own renderer, which neither the preset nor an override reaches, so
    // a sweep flag on a preview page would label a run by a setting it did not have.
    const allowed = subject === 'session' ? ARM_FLAGS : [];
    for (const problem of queryMismatches(report.workload.query, report.page.search, allowed)) {
      reasons.push(`the page was not the named workload: ${problem}`);
    }
  }
  if (reasons.length > 0) return { refusal: `${name}: ${reasons.join('; ')}` };
  return { run: { name, report, arm: armLabel(report) } };
}

/** What a sweep varies: the quality preset and each override in effect. */
export function armLabel(report) {
  if (report.workload.subject !== 'session') return report.workload.id;
  const overrides = report.render.overrides ?? {};
  const set = OVERRIDE_FIELDS.filter((f) => overrides[f] !== null && overrides[f] !== undefined).map(
    (f) => `${f}=${overrides[f]}`,
  );
  return [`quality=${report.session.quality}`, ...set].join(' ');
}

/** The facts that must match across a set, as `[label, value]` for one report. */
function sittingFacts(report) {
  const facts = [
    ['workload', report.workload.id],
    ['user agent', report.page.userAgent],
    ['device pixel ratio', report.page.devicePixelRatio],
    ['viewport', `${report.page.viewport.width}x${report.page.viewport.height}`],
    ['build', report.build.commit === '' ? '(unknown)' : report.build.commit],
  ];
  if (report.workload.subject === 'session') {
    facts.push(
      ['seed', report.session.seed],
      ['mode', report.session.mode],
      ['human players', report.session.humanPlayers],
      ['bots', report.session.bots],
    );
  }
  return facts;
}

/**
 * Every fact on which the runs disagree, as one line each naming the values and their files.
 * Empty when the set is one device, one build and one workload.
 */
export function sittingMismatches(runs) {
  if (runs.length === 0) return [];
  const problems = [];
  const labels = sittingFacts(runs[0].report).map(([label]) => label);
  for (const label of labels) {
    const byValue = new Map();
    for (const run of runs) {
      const fact = sittingFacts(run.report).find(([l]) => l === label);
      const key = JSON.stringify(fact ? fact[1] : undefined);
      byValue.set(key, [...(byValue.get(key) ?? []), run.name]);
    }
    if (byValue.size > 1) {
      problems.push(`${label} differs: ${[...byValue].map(([value, names]) => `${value} in ${names.join(', ')}`).join('; ')}`);
    }
  }
  return problems;
}

/** The middle value; for an even count, the lower of the two middle values, a run that happened. */
export function lowerMedian(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length / 2) - 1];
}

/**
 * Group runs into arms in first-seen order and compare each with the first. Assumes the runs
 * passed `readReport` and `sittingMismatches`.
 */
export function summarizeRuns(runs) {
  const arms = new Map();
  for (const run of runs) arms.set(run.arm, [...(arms.get(run.arm) ?? []), run]);
  const rows = [...arms].map(([arm, armRuns]) => {
    const pick = (fn) => lowerMedian(armRuns.map((r) => fn(r.report)));
    const p95s = armRuns.map((r) => r.report.frames.p95);
    return {
      arm,
      runs: armRuns.length,
      effectivePixelRatio: pick((r) => r.render.effectivePixelRatio),
      p50: pick((r) => r.frames.p50),
      p95: pick((r) => r.frames.p95),
      p99: pick((r) => r.frames.p99),
      p95Min: Math.min(...p95s),
      p95Max: Math.max(...p95s),
      over16_7Share: pick((r) => r.frames.over16_7 / r.frames.count),
      over33_3Share: pick((r) => r.frames.over33_3 / r.frames.count),
      workP95: pick((r) => r.work.p95),
    };
  });
  const base = rows[0];
  return {
    facts: runs.length > 0 ? sittingFacts(runs[0].report) : [],
    baseline: base ? base.arm : null,
    arms: rows.map((row) => ({
      ...row,
      p95Ratio: row.p95 / base.p95,
      workP95Ratio: base.workP95 === 0 ? null : row.workP95 / base.workP95,
    })),
    runs: runs.map((r) => ({
      name: r.name,
      arm: r.arm,
      frames: r.report.frames.count,
      p50: r.report.frames.p50,
      p95: r.report.frames.p95,
      p99: r.report.frames.p99,
    })),
  };
}

const ms = (v) => v.toFixed(1);
const ratio = (v) => (v === null ? '--' : `${v.toFixed(2)}x`);
const percent = (v) => `${(v * 100).toFixed(1)}%`;

function table(header, rows) {
  return [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.join(' | ')} |`)];
}

/** The summary as Markdown: the sitting's facts, one row per arm, one row per run, the caveats. */
export function renderSummary(summary) {
  return [
    '# Benchmark comparison',
    '',
    ...summary.facts.map(([label, value]) => `- ${label}: ${value}`),
    '',
    `Baseline arm: \`${summary.baseline}\` (the arm of the first report named).`,
    '',
    '## Arms',
    '',
    ...table(
      ['arm', 'runs', 'DPR', 'p50 ms', 'p95 ms', 'p95 range ms', 'p99 ms', 'p95 vs baseline', '>16.7 ms', '>33.3 ms', 'work p95 ms', 'work p95 vs baseline'],
      summary.arms.map((a) => [
        `\`${a.arm}\``,
        String(a.runs),
        String(a.effectivePixelRatio),
        ms(a.p50),
        ms(a.p95),
        `${ms(a.p95Min)}-${ms(a.p95Max)}`,
        ms(a.p99),
        ratio(a.p95Ratio),
        percent(a.over16_7Share),
        percent(a.over33_3Share),
        ms(a.workP95),
        ratio(a.workP95Ratio),
      ]),
    ),
    '',
    'An arm with several runs shows each figure\'s median run (the lower middle one for an even count) and the',
    'range of its runs\' p95. A ratio whose arm range overlaps the baseline\'s range is within this sitting\'s',
    'run-to-run spread.',
    '',
    '## Runs',
    '',
    ...table(
      ['report', 'arm', 'frames', 'p50 ms', 'p95 ms', 'p99 ms'],
      summary.runs.map((r) => [r.name, `\`${r.arm}\``, String(r.frames), ms(r.p50), ms(r.p95), ms(r.p99)]),
    ),
    '',
    'Every figure above is from this one device, build and sitting. The ratios compare arms within this set;',
    'they are not a frame-time budget, and they say nothing about another device.',
    '',
  ].join('\n');
}

/**
 * The command: summarize the reports at `paths`, printing to `io`. Returns the exit code:
 * 0 summarized, 1 a report or the set was refused, 2 no reports named.
 */
export function runSummarize(paths, io, readText) {
  if (paths.length === 0) {
    io.error('usage: npm run bench:summarize -- <baseline report.json> [more reports.json ...]');
    return 2;
  }
  const runs = [];
  const refusals = [];
  const repeated = [...new Set(paths.filter((path, i) => paths.indexOf(path) !== i))];
  if (repeated.length > 0) {
    io.error(`Named more than once, so its run would count twice: ${repeated.join(', ')}`);
    return 1;
  }
  for (const path of paths) {
    let text;
    try {
      text = readText(path);
    } catch (error) {
      refusals.push(`${path}: cannot be read (${error.code ?? error.message})`);
      continue;
    }
    const result = readReport(path, text);
    if (result.refusal) refusals.push(result.refusal);
    else runs.push(result.run);
  }
  if (refusals.length > 0) {
    io.error(`Refused ${refusals.length} of ${paths.length} report(s); nothing was summarized:`);
    for (const refusal of refusals) io.error(`- ${refusal}`);
    return 1;
  }
  const mismatches = sittingMismatches(runs);
  if (mismatches.length > 0) {
    io.error('These reports are not one device, build and workload, so they are not compared:');
    for (const mismatch of mismatches) io.error(`- ${mismatch}`);
    return 1;
  }
  io.log(renderSummary(summarizeRuns(runs)));
  return 0;
}
