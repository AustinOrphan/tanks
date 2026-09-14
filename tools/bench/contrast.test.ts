// Issue #738: the render cost contrast check, on fixture reports built by src/game/bench.ts's own
// buildBenchReport, so a change to the report's shape reaches these tests.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { BENCH_REPORT_SCHEMA, buildBenchReport, type BenchRenderOverrides, type FrameRecorder } from '../../src/game/bench';
import { MIN_FRAME_RATIO, MIN_RUNS, armOf, contrastVerdict, frameRate, readRun, runContrast } from './contrast.mjs';

const NO_OVERRIDES: BenchRenderOverrides = { shadowMapSize: null, antialias: null, pixelRatioCap: null, fillRimLights: null };

/** A finished versus-bots report that measured `frames` frames in 60 s at `quality`. */
function report(quality: string, frames: number, overrides: Partial<BenchRenderOverrides> = {}): Record<string, any> {
  const recorder: FrameRecorder = {
    frame: () => {},
    phase: 'done',
    samples: () => [{ intervalMs: 300, workMs: 8 }],
    simulatedTicks: 2000,
    measuredMs: 60_000,
  };
  const built = buildBenchReport({
    workload: 'versus-bots',
    recorder,
    session: { seed: 7, arenaId: 'arena-01', mode: 'ffa', humanPlayers: 0, bots: 4, quality },
    pixelRatioCap: 2,
    renderOverrides: { ...NO_OVERRIDES, ...overrides },
    preview: null,
    page: { search: '', viewport: { width: 1280, height: 800 }, devicePixelRatio: 1, userAgent: 'HeadlessChrome' },
    build: { commit: 'abc1234', known: true },
  });
  const parsed = JSON.parse(JSON.stringify(built));
  parsed.frames.count = frames;
  return parsed;
}

const runOf = (name: string, r: Record<string, unknown>) => readRun(name, JSON.stringify(r)).run;

/** The runner's measured spread: high 174-180 frames, low 246, five runs each. */
const RUNNER = [
  ...[174, 179, 179, 180, 179].map((f, i) => runOf(`r${i + 1}-high.json`, report('high', f))),
  ...[246, 246, 246, 246, 246].map((f, i) => runOf(`r${i + 1}-low.json`, report('low', f))),
];

describe('the render cost contrast check (issue #738)', () => {
  it('passes the spread measured on the runner', () => {
    const verdict = contrastVerdict(RUNNER);
    expect(verdict.pass).toBe(true);
    expect(verdict.measured).toBeCloseTo(246 / 180);
  });

  it('fails when low costs as much as high, as it would with high\'s settings', () => {
    const same = [
      ...[174, 179, 180].map((f, i) => runOf(`r${i + 1}-high.json`, report('high', f))),
      ...[176, 181, 178].map((f, i) => runOf(`r${i + 1}-low.json`, report('low', f))),
    ];
    const verdict = contrastVerdict(same);
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toContain('low no longer costs clearly less than high');
  });

  it('compares the slowest low run with the fastest high run, so one run cannot carry it', () => {
    // Medians would pass this set (246 against 180); the one slow low run and the one fast high run
    // put the worst case under the ratio.
    const mixed = [
      ...[180, 180, 200].map((f, i) => runOf(`r${i + 1}-high.json`, report('high', f))),
      ...[246, 246, 220].map((f, i) => runOf(`r${i + 1}-low.json`, report('low', f))),
    ];
    const verdict = contrastVerdict(mixed);
    expect(verdict.highFastest).toBeCloseTo(200 / 60);
    expect(verdict.lowSlowest).toBeCloseTo(220 / 60);
    expect(verdict.pass).toBe(false);
  });

  it('holds its ratio: a low arm just over it passes and one just under fails', () => {
    // 231 and 229 frames against 200 are 1.155x and 1.145x: clear of 1.15 on either side, so float
    // division at exactly the ratio decides nothing here.
    expect(MIN_FRAME_RATIO).toBe(1.15);
    const at = (lowFrames: number) =>
      contrastVerdict([
        ...[200, 200, 200].map((f, i) => runOf(`r${i + 1}-high.json`, report('high', f))),
        ...[lowFrames, lowFrames, lowFrames].map((f, i) => runOf(`r${i + 1}-low.json`, report('low', f))),
      ]).pass;
    expect(at(231)).toBe(true);
    expect(at(229)).toBe(false);
  });

  it('refuses a verdict with too few runs of either asserted arm', () => {
    expect(MIN_RUNS).toBe(3);
    const verdict = contrastVerdict(RUNNER.filter((r) => r.arm === 'low' || r.name === 'r1-high.json'));
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toBe(`needs at least ${MIN_RUNS} runs each of high and low; got 1 high, 5 low`);
  });

  it('names an override arm by its overrides, so it is never counted as a plain preset', () => {
    expect(armOf(report('high', 190, { fillRimLights: false }))).toBe('high+fillRimLights=false');
    expect(armOf(report('low', 246))).toBe('low');
    expect(frameRate(report('low', 246))).toBeCloseTo(4.1);
  });

  it('refuses a stale schema, an open window and a report with no frames', () => {
    expect(readRun('s.json', JSON.stringify({ ...report('high', 180), schema: BENCH_REPORT_SCHEMA + 1 })).refusal).toContain(
      `report schema ${BENCH_REPORT_SCHEMA + 1}, this check reads ${BENCH_REPORT_SCHEMA}`,
    );
    expect(readRun('o.json', JSON.stringify({ ...report('high', 180), phase: 'measuring' })).refusal).toBe('o.json: phase is "measuring", not "done"');
    expect(readRun('z.json', JSON.stringify(report('high', 0))).refusal).toBe('z.json: measured no frames');
  });
});

describe('npm run bench:contrast (issue #738)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-contrast-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('exits 0 on the runner\'s spread and 1 when low costs as much as high, printing every arm', () => {
    const write = (sub: string, files: Record<string, Record<string, unknown>>) => {
      const d = join(dir, sub);
      spawnSync('mkdir', ['-p', d]);
      for (const [name, r] of Object.entries(files)) writeFileSync(join(d, name), JSON.stringify(r));
      return d;
    };
    const holds = write('holds', {
      'r1-high.json': report('high', 180), 'r2-high.json': report('high', 174), 'r3-high.json': report('high', 179),
      'r1-low.json': report('low', 246), 'r2-low.json': report('low', 246), 'r3-low.json': report('low', 246),
      'r1-high+fillRimLights=off.json': report('high', 190, { fillRimLights: false }),
    });
    const ok = spawnSync('npm', ['run', '-s', 'bench:contrast', '--', holds], { encoding: 'utf8' });
    expect(ok.stderr).toBe('');
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain('| high+fillRimLights=false | 1 | 190 |');
    expect(ok.stdout).toContain('no, for reading');
    expect(ok.stdout).toContain('PASS: the slowest low run drew 1.37x');
    const broken = write('broken', {
      'r1-high.json': report('high', 180), 'r2-high.json': report('high', 174), 'r3-high.json': report('high', 179),
      'r1-low.json': report('low', 181), 'r2-low.json': report('low', 176), 'r3-low.json': report('low', 178),
    });
    const bad = spawnSync('npm', ['run', '-s', 'bench:contrast', '--', broken], { encoding: 'utf8' });
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain('FAIL: the slowest low run drew only 0.98x');
  }, 60_000);

  it('asks for a directory when none is named', () => {
    const err: string[] = [];
    expect(runContrast([], { log: () => {}, error: (s: string) => err.push(s) }, { readdir: () => [], read: () => '' })).toBe(2);
    expect(err[0]).toContain('usage: npm run bench:contrast');
  });
});
