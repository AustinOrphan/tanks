// Issue #737: the benchmark summarizer, on fixture reports.
//
// The fixtures are built by `src/game/bench.ts`'s own `buildBenchReport`, then serialized as the
// console's `JSON.stringify(__tanks.bench())` would, so a change to the report's shape reaches
// these tests rather than a hand-written copy of it. Each fixture then changes only what a test
// is about.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import {
  BENCH_REPORT_SCHEMA,
  BENCH_WORKLOADS,
  buildBenchReport,
  type BenchReport,
  type BenchRenderOverrides,
  type BenchWorkloadId,
  type FrameRecorder,
} from '../../src/game/bench';
import { armLabel, lowerMedian, queryMismatches, readReport, runSummarize, sittingMismatches, summarizeRuns } from './summary.mjs';

const NO_OVERRIDES: BenchRenderOverrides = { shadowMapSize: null, antialias: null, pixelRatioCap: null, fillRimLights: null };

const doneRecorder: FrameRecorder = {
  frame: () => {},
  phase: 'done',
  samples: () => [
    { intervalMs: 16, workMs: 4 },
    { intervalMs: 17, workMs: 5 },
  ],
  simulatedTicks: 120,
  measuredMs: 60_000,
};

interface FixtureOptions {
  readonly workload?: BenchWorkloadId;
  readonly quality?: string;
  readonly overrides?: Partial<BenchRenderOverrides>;
  readonly extraQuery?: string;
  readonly frames?: Partial<BenchReport['frames']>;
  readonly workP95?: number;
  readonly userAgent?: string;
}

/** A finished report for `workload`, as the page publishes it. */
function fixture(options: FixtureOptions = {}): Record<string, unknown> {
  const workload = options.workload ?? 'versus-bots';
  const session = BENCH_WORKLOADS[workload].subject === 'session';
  const report = buildBenchReport({
    workload,
    recorder: doneRecorder,
    session: session
      ? { seed: 7, arenaId: null, mode: 'ffa', humanPlayers: 0, bots: 4, quality: options.quality ?? 'high' }
      : null,
    pixelRatioCap: 2,
    renderOverrides: session ? { ...NO_OVERRIDES, ...options.overrides } : null,
    preview: session ? null : { antialias: true, pixelRatioCap: 2, shadowMap: true, keyShadowMapSize: 1024 },
    page: {
      search: BENCH_WORKLOADS[workload].query + (options.extraQuery ?? ''),
      viewport: { width: 412, height: 915 },
      devicePixelRatio: 2.625,
      userAgent: options.userAgent ?? 'Mozilla/5.0 (Linux; Android 14; Pixel 7a)',
    },
    build: { commit: 'a4b42c4', known: true },
  });
  const frames = { ...report.frames, ...options.frames };
  const work = { ...report.work, p95: options.workP95 ?? report.work.p95 };
  return JSON.parse(JSON.stringify({ ...report, frames, work }));
}

const text = (value: unknown): string => JSON.stringify(value, null, 2);

function capture(): { io: { log: (s: string) => void; error: (s: string) => void }; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { log: (s) => out.push(s), error: (s) => err.push(s) }, out, err };
}

/** Runs the command over named fixtures held in memory. */
function run(files: Record<string, unknown>): { code: number; out: string[]; err: string[] } {
  const { io, out, err } = capture();
  const code = runSummarize(Object.keys(files), io, (path: string) => {
    if (!(path in files)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return typeof files[path] === 'string' ? (files[path] as string) : text(files[path]);
  });
  return { code, out, err };
}

describe('the benchmark summarizer refuses a report it would misread (issue #737)', () => {
  it('refuses a report with another schema version, and summarizes nothing', () => {
    const stale = { ...fixture(), schema: BENCH_REPORT_SCHEMA + 1 };
    const result = run({ 'base.json': fixture(), 'stale.json': stale });
    expect(result.code).toBe(1);
    expect(result.out).toEqual([]);
    expect(result.err.join('\n')).toContain(
      `stale.json: report schema ${BENCH_REPORT_SCHEMA + 1}, but this summarizer reads schema ${BENCH_REPORT_SCHEMA}`,
    );
    expect(result.err[0]).toBe('Refused 1 of 2 report(s); nothing was summarized:');
  });

  it('refuses a report with no schema field at all', () => {
    const { schema: _schema, ...unversioned } = fixture();
    expect(readReport('old.json', text(unversioned)).refusal).toContain('old.json: report schema undefined');
  });

  it('accepts the report the page builds today', () => {
    expect(readReport('base.json', text(fixture()))).toEqual({
      run: expect.objectContaining({ name: 'base.json', arm: 'quality=high' }),
    });
    expect(readReport('preview.json', text(fixture({ workload: 'preview' })))).toEqual({
      run: expect.objectContaining({ arm: 'preview' }),
    });
  });

  it('refuses a report read before its measurement window closed', () => {
    const early = { ...fixture(), phase: 'measuring' };
    expect(readReport('early.json', text(early)).refusal).toBe(
      'early.json: phase is "measuring"; read the report only once it is "done"',
    );
  });

  it('refuses a report that measured no frames', () => {
    const empty = fixture({ frames: { count: 0 } });
    expect(readReport('empty.json', text(empty)).refusal).toBe('empty.json: measured no frames');
  });

  it('names each field it reads that is missing or mistyped', () => {
    const broken = fixture() as { frames: Record<string, unknown>; session: Record<string, unknown> };
    delete broken.frames.p95;
    broken.session.seed = '7';
    expect(readReport('broken.json', text(broken)).refusal).toBe(
      'broken.json: frames.p95 is missing or not the expected type; session.seed is missing or not the expected type',
    );
  });

  it('refuses a session report without its render overrides', () => {
    const noOverrides = fixture() as { render: Record<string, unknown> };
    delete noOverrides.render.overrides;
    expect(readReport('old-render.json', text(noOverrides)).refusal).toBe('old-render.json: render.overrides is missing');
    const partial = fixture() as { render: { overrides: Record<string, unknown> } };
    delete partial.render.overrides.fillRimLights;
    expect(readReport('partial.json', text(partial)).refusal).toBe(
      'partial.json: render.overrides does not carry the four override fields',
    );
  });

  it('refuses text that is not a report object', () => {
    expect(readReport('paste.txt', 'Promise {<pending>}').refusal).toMatch(/^paste\.txt: not JSON \(/);
    expect(readReport('list.json', '[]').refusal).toBe('list.json: not a report object');
  });

  it('refuses a report whose page was not the named workload', () => {
    const reseeded = fixture() as { page: { search: string } };
    reseeded.page.search = reseeded.page.search.replace('seed=7', 'seed=8');
    expect(readReport('reseeded.json', text(reseeded)).refusal).toBe(
      'reseeded.json: the page was not the named workload: seed is "8", the workload\'s is "7"',
    );
    expect(readReport('aimray.json', text(fixture({ extraQuery: '&aimRay=1' }))).refusal).toBe(
      "aimray.json: the page was not the named workload: aimRay is neither the workload's nor a sweep flag",
    );
  });

  it('refuses a sweep flag on the preview workload, whose renderer ignores it', () => {
    expect(readReport('preview-low.json', text(fixture({ workload: 'preview', extraQuery: '&quality=low' }))).refusal).toBe(
      "preview-low.json: the page was not the named workload: quality is a sweep flag this workload's renderer ignores",
    );
  });

  it('refuses a file named twice, which would count its run twice', () => {
    const { io, err } = capture();
    expect(runSummarize(['a.json', 'b.json', 'a.json'], io, () => text(fixture()))).toBe(1);
    expect(err).toEqual(['Named more than once, so its run would count twice: a.json']);
  });

  it('names a file it cannot read, and asks for a report when none is named', () => {
    const missing = run({});
    expect(missing.code).toBe(2);
    const { io, err } = capture();
    expect(runSummarize(['gone.json'], io, () => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    })).toBe(1);
    expect(err).toContain('- gone.json: cannot be read (ENOENT)');
  });
});

describe('the benchmark summarizer compares only one device, build and workload (issue #737)', () => {
  it('accepts the quality preset and each render override as what a sweep varies', () => {
    expect(queryMismatches(BENCH_WORKLOADS['versus-bots'].query, `${BENCH_WORKLOADS['versus-bots'].query}&quality=low&shadowMapSize=512&antialias=off&pixelRatioCap=1&fillRimLights=off`)).toEqual([]);
  });

  it('refuses a set taken on two devices, naming the fact and the files', () => {
    const result = run({ 'a.json': fixture(), 'b.json': fixture({ userAgent: 'Mozilla/5.0 (iPhone)' }) });
    expect(result.code).toBe(1);
    expect(result.out).toEqual([]);
    expect(result.err).toEqual([
      'These reports are not one device, build and workload, so they are not compared:',
      '- user agent differs: "Mozilla/5.0 (Linux; Android 14; Pixel 7a)" in a.json; "Mozilla/5.0 (iPhone)" in b.json',
    ]);
  });

  it('names every sitting fact that differs: pixel ratio, viewport, build, workload and session', () => {
    const runOf = (name: string, report: Record<string, unknown>) => readReport(name, text(report)).run;
    const base = fixture() as Record<string, any>;
    const other = fixture() as Record<string, any>;
    other.page.devicePixelRatio = 3;
    other.page.viewport.width = 390;
    other.build.commit = 'e15e8f9';
    other.session.bots = 3;
    const labels = sittingMismatches([runOf('a.json', base), runOf('b.json', other)]).map((m: string) => m.split(' differs')[0]);
    expect(labels).toEqual(['device pixel ratio', 'viewport', 'build', 'bots']);
    const preview = runOf('p.json', fixture({ workload: 'preview' }));
    expect(sittingMismatches([runOf('a.json', base), preview])[0]).toMatch(/^workload differs: "versus-bots" in a.json; "preview" in p.json/);
  });
});

describe('the benchmark summary (issue #737)', () => {
  const files = {
    'high-1.json': fixture({ frames: { count: 3000, p50: 16.6, p95: 20, p99: 30, over16_7: 300, over33_3: 30 }, workP95: 8 }),
    'shadow-512-1.json': fixture({
      overrides: { shadowMapSize: 512 },
      extraQuery: '&shadowMapSize=512',
      frames: { count: 3000, p50: 16.6, p95: 15, p99: 18, over16_7: 60, over33_3: 3 },
      workP95: 6,
    }),
    'high-2.json': fixture({ frames: { count: 3000, p50: 16.7, p95: 22, p99: 34, over16_7: 450, over33_3: 60 }, workP95: 9 }),
    'high-3.json': fixture({ frames: { count: 3000, p50: 16.8, p95: 26, p99: 40, over16_7: 600, over33_3: 90 }, workP95: 10 }),
  };

  it('groups runs into arms, takes the first report\'s arm as the baseline, and divides by it', () => {
    const runs = Object.entries(files).map(([name, report]) => readReport(name, text(report)).run);
    const summary = summarizeRuns(runs);
    expect(summary.baseline).toBe('quality=high');
    expect(summary.arms.map((a: { arm: string; runs: number }) => [a.arm, a.runs])).toEqual([
      ['quality=high', 3],
      ['quality=high shadowMapSize=512', 1],
    ]);
    const [high, shadow] = summary.arms;
    expect(high).toMatchObject({ p50: 16.7, p95: 22, p99: 34, p95Min: 20, p95Max: 26, p95Ratio: 1, workP95: 9, workP95Ratio: 1 });
    expect(high.over16_7Share).toBeCloseTo(0.15);
    expect(shadow).toMatchObject({ p95: 15, p95Min: 15, p95Max: 15, workP95: 6 });
    expect(shadow.p95Ratio).toBeCloseTo(15 / 22);
    expect(shadow.workP95Ratio).toBeCloseTo(6 / 9);
    expect(summary.runs.map((r: { name: string }) => r.name)).toEqual(Object.keys(files));
  });

  it('prints the sitting, the arms and every run, with the caveat that it is no budget', () => {
    const result = run(files);
    expect(result.err).toEqual([]);
    expect(result.code).toBe(0);
    const printed = result.out.join('\n');
    expect(printed).toContain('- user agent: Mozilla/5.0 (Linux; Android 14; Pixel 7a)');
    expect(printed).toContain('- build: a4b42c4');
    expect(printed).toContain('Baseline arm: `quality=high` (the arm of the first report named).');
    expect(printed).toContain('| `quality=high` | 3 | 2 | 16.7 | 22.0 | 20.0-26.0 | 34.0 | 1.00x | 15.0% | 2.0% | 9.0 | 1.00x |');
    expect(printed).toContain('| `quality=high shadowMapSize=512` | 1 | 2 | 16.6 | 15.0 | 15.0-15.0 | 18.0 | 0.68x | 2.0% | 0.1% | 6.0 | 0.67x |');
    expect(printed).toContain('| shadow-512-1.json | `quality=high shadowMapSize=512` | 3000 | 16.6 | 15.0 | 18.0 |');
    expect(printed).toContain('they are not a frame-time budget, and they say nothing about another device.');
  });

  it('labels an arm by every override in effect, in a fixed order', () => {
    const report = fixture({ quality: 'low', overrides: { fillRimLights: false, antialias: true, pixelRatioCap: 1.5 } });
    expect(armLabel(report)).toBe('quality=low antialias=true pixelRatioCap=1.5 fillRimLights=false');
  });

  it('takes the lower of the two middle runs for an even count, so the figure is a run that happened', () => {
    expect(lowerMedian([30, 10, 20, 40])).toBe(20);
    expect(lowerMedian([5])).toBe(5);
  });
});

describe('npm run bench:summarize (issue #737)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-summary-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('reads report files through the package script, first file as the baseline', () => {
    const base = join(dir, 'base.json');
    const stale = join(dir, 'stale.json');
    writeFileSync(base, text(fixture()));
    writeFileSync(stale, text({ ...fixture(), schema: BENCH_REPORT_SCHEMA + 1 }));
    const ok = spawnSync('npm', ['run', '-s', 'bench:summarize', '--', base], { encoding: 'utf8' });
    expect(ok.stderr).toBe('');
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain('Baseline arm: `quality=high`');
    const refused = spawnSync('npm', ['run', '-s', 'bench:summarize', '--', base, stale], { encoding: 'utf8' });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain(`stale.json: report schema ${BENCH_REPORT_SCHEMA + 1}`);
  }, 60_000);
});
