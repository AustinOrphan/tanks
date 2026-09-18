// The `flow` producer adapter (issue #815): the argv it builds, the gates it judges a
// recording by, and the schema-v1 result it hands the shared runner. Each gate is driven both
// ways from one fixture report taken from a real recording; the negative control for every
// assertion flips exactly one field.
import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error -- plain-node tooling module, intentionally dependency-free.
import { buildFlowArguments, judgeFlowReport, runFlow, SIMULATION_TICK_RATE } from './flow-adapter.mjs';
// @ts-expect-error -- plain-node tooling module, intentionally dependency-free.
import { validateProducerResult } from './producer.mjs';
// @ts-expect-error -- plain-node tooling module, intentionally dependency-free.
import { validateRecipe } from './schema.mjs';

const SHA = 'f'.repeat(40);

function recipe(over: Record<string, any> = {}): Record<string, any> {
  return validateRecipe({
    schemaVersion: 1,
    recipeVersion: 1,
    id: 'test.flow.round',
    producer: { kind: 'flow', scenarioId: 'campaign-round' },
    fixture: { id: 'campaign-round', seed: 7 },
    variant: { level: 1, driver: 'autoplay', flags: {} },
    viewport: { width: 1280, height: 800, devicePixelRatio: 1 },
    profile: { visual: 'host-gpu', motion: 'full', capability: 'headless-desktop', reducedMotion: false },
    schedule: { kind: 'realtime', durationSeconds: 4 },
    playback: { rate: 1, intendedFps: 30 },
    artifacts: [{ format: 'mp4', filename: 'capture.mp4' }],
    expectations: { events: [], allowUnexpectedEvents: true },
    title: 'A test flow',
    description: 'A test flow recipe.',
    altText: 'A test flow recipe.',
    timeoutMs: 120_000,
    outputBudgetBytes: 200_000_000,
    ...over,
  });
}

async function fixtureReport(): Promise<any> {
  return JSON.parse(await readFile(new URL('./test-fixtures/flow-report.json', import.meta.url), 'utf8'));
}

const source = { commitSha: SHA };
const byKind = (assertions: any[]) => Object.fromEntries(assertions.map((a) => [a.kind, a]));

describe('buildFlowArguments (issue #815)', () => {
  it('builds the recorder argv from the recipe, flags only when on, in the allowlist order', () => {
    expect(buildFlowArguments(recipe(), 'tmp/capture-1/producer')).toEqual([
      '--flow', 'campaign-round', '--level', '1', '--seed', '7', '--driver', 'autoplay',
      '--seconds', '4', '--fps', '30', '--w', '1280', '--h', '800', '--dpr', '1', '--visual', 'host-gpu',
      '--stop', 'window',
      '--dist', 'dist', '--out', 'tmp/capture-1/producer', '--report', 'tmp/capture-1/producer/producer.json',
      '--timeout', '120000',
    ]);
    // A recipe that stops at the round's end says so; the default is the whole window.
    const roundEnd = recipe({ schedule: { kind: 'realtime', durationSeconds: 4, stop: 'round-end' } });
    expect(buildFlowArguments(roundEnd, 'tmp/x')).toContain('round-end');
    const on = buildFlowArguments(recipe({ variant: { level: 2, driver: 'autoplay', flags: { pp1Roles: true } } }), 'tmp/x');
    expect(on.slice(0, 10)).toEqual(['--flow', 'campaign-round', '--level', '2', '--seed', '7', '--driver', 'autoplay', '--flag', 'pp1Roles']);
    const off = buildFlowArguments(recipe({ variant: { level: 2, driver: 'autoplay', flags: { pp1Roles: false } } }), 'tmp/x');
    expect(off).not.toContain('--flag');
  });

  it('refuses another producer, another schedule, and an output path outside tmp/', () => {
    const screen = recipe();
    screen.producer.kind = 'screen';
    expect(() => buildFlowArguments(screen, 'tmp/x')).toThrow(/cannot capture producer 'screen'/);
    const ticks = recipe();
    ticks.schedule = { kind: 'frames', frameCount: 2 };
    expect(() => buildFlowArguments(ticks, 'tmp/x')).toThrow(/realtime schedules only/);
    for (const bad of ['../tmp/x', '/tmp/x', 'tmp/../x', 'artifacts/x', 'tmp/x;rm']) {
      expect(() => buildFlowArguments(recipe(), bad), bad).toThrow(/isolated relative tmp\/ path/);
    }
  });
});

describe('judgeFlowReport: every gate, both ways (issue #815)', () => {
  it('passes a consistent recording of the requested round', async () => {
    const verdicts = judgeFlowReport(recipe(), await fixtureReport(), source);
    expect(verdicts.map((v) => v.kind)).toEqual([
      'flow-report-identity', 'page-errors', 'flow-config-effective', 'flow-build-identity', 'flow-world-identity',
      'flow-still-playing', 'flow-no-clamped-frames', 'flow-simulation-rate', 'flow-frame-size', 'flow-frame-count',
    ]);
    expect(verdicts.filter((v) => !v.passed)).toEqual([]);
  });

  it('fails identity when the recorder played other inputs than the recipe asked for', async () => {
    const report = await fixtureReport();
    report.producer.inputs.flags = { pp1Roles: true };
    const v = byKind(judgeFlowReport(recipe(), report, source))['flow-report-identity'];
    expect(v.passed).toBe(false);
    expect(v.diagnostic).toMatch(/recipe requested/);
    expect(v.details.reported.flags).toEqual({ pp1Roles: true });
  });

  it('fails on an uncaught page error', async () => {
    const report = await fixtureReport();
    report.producer.pageErrors = ['TypeError: boom'];
    expect(byKind(judgeFlowReport(recipe(), report, source))['page-errors'].passed).toBe(false);
  });

  it('fails config when the page refused a parameter, did not know one, or did not open developer mode', async () => {
    for (const change of [
      (d: any) => { d.requestedNotInEffect = ['seed']; },
      (d: any) => { d.unknownParams = ['pp1roles']; },
      (d: any) => { d.developerMode = false; },
    ]) {
      const report = await fixtureReport();
      change(report.producer.diagnostics);
      const v = byKind(judgeFlowReport(recipe(), report, source))['flow-config-effective'];
      expect(v.passed).toBe(false);
      expect(v.diagnostic).toMatch(/diagnostics show/);
    }
  });

  it('fails build identity for an unlabelled build and for a build from another commit, naming the rebuild', async () => {
    const unknown = await fixtureReport();
    unknown.producer.diagnostics.build = { commit: null, known: false };
    const u = byKind(judgeFlowReport(recipe(), unknown, source))['flow-build-identity'];
    expect(u.passed).toBe(false);
    expect(u.diagnostic).toContain(`VITE_BUILD_SHA=${SHA} npm run build`);
    const other = await fixtureReport();
    const o = byKind(judgeFlowReport(recipe(), other, { commitSha: 'e'.repeat(40) }))['flow-build-identity'];
    expect(o.passed).toBe(false);
    expect(o.diagnostic).toMatch(/but the checkout is/);
  });

  it('fails world identity on another seed or another arena than the level maps to', async () => {
    const seed = await fixtureReport();
    seed.producer.world.seed = 8;
    expect(byKind(judgeFlowReport(recipe(), seed, source))['flow-world-identity'].passed).toBe(false);
    const arena = await fixtureReport();
    arena.producer.world.arenaId = 'arena-05';
    const v = byKind(judgeFlowReport(recipe(), arena, source))['flow-world-identity'];
    expect(v.passed).toBe(false);
    expect(v.diagnostic).toMatch(/asked for seed 7 on arena-01/);
    // A level-2 recipe expects arena-02 from the campaign data, not whatever the report says.
    const level2 = await fixtureReport();
    level2.producer.world.arenaId = 'arena-01';
    expect(byKind(judgeFlowReport(recipe({ variant: { level: 2, driver: 'autoplay', flags: {} } }), level2, source))['flow-world-identity'].passed).toBe(false);
  });

  it('fails still-playing when the round ended inside the window or a sample saw a menu', async () => {
    const ended = await fixtureReport();
    ended.producer.readiness.surfaceAtEnd = 'not-playing';
    const e = byKind(judgeFlowReport(recipe(), ended, source))['flow-still-playing'];
    expect(e.passed).toBe(false);
    expect(e.diagnostic).toMatch(/left 'playing'/);
    const sampled = await fixtureReport();
    sampled.producer.timing.simulation.surfaces[2] = 'menu';
    expect(byKind(judgeFlowReport(recipe(), sampled, source))['flow-still-playing'].passed).toBe(false);
  });

  it('fails the clamp gate on one clamped frame, and the rate gate outside 3% of 60', async () => {
    const clamped = await fixtureReport();
    clamped.producer.timing.render.clampedFrames = 1;
    clamped.producer.timing.render.simTimeLostMs = 120;
    const c = byKind(judgeFlowReport(recipe(), clamped, source))['flow-no-clamped-frames'];
    expect(c.passed).toBe(false);
    expect(c.diagnostic).toMatch(/losing 120 ms/);
    for (const rate of [SIMULATION_TICK_RATE * 0.96, SIMULATION_TICK_RATE * 1.04, null]) {
      const slow = await fixtureReport();
      slow.producer.timing.simulation.ticksPerSecond = rate;
      expect(byKind(judgeFlowReport(recipe(), slow, source))['flow-simulation-rate'].passed, String(rate)).toBe(false);
    }
    const fine = await fixtureReport();
    fine.producer.timing.simulation.ticksPerSecond = SIMULATION_TICK_RATE * 1.02;
    expect(byKind(judgeFlowReport(recipe(), fine, source))['flow-simulation-rate'].passed).toBe(true);
    const missing = await fixtureReport();
    missing.producer.timing.simulation.available = false;
    expect(byKind(judgeFlowReport(recipe(), missing, source))['flow-simulation-rate'].diagnostic).toMatch(/replay surface was not available/);
  });

  it('fails frame size on a mismatched frame, and frame count on a short window', async () => {
    const size = await fixtureReport();
    size.producer.frames.mismatched = [{ index: 3, width: 1280, height: 720 }];
    expect(byKind(judgeFlowReport(recipe(), size, source))['flow-frame-size'].passed).toBe(false);
    const count = await fixtureReport();
    count.producer.timing.frameCount = 119;
    const v = byKind(judgeFlowReport(recipe(), count, source))['flow-frame-count'];
    expect(v.passed).toBe(false);
    expect(v.diagnostic).toMatch(/119 frames/);
  });

  it('under a round-end stop, accepts a short clip and the whole window, but never more than it', async () => {
    const roundEnd = recipe({ schedule: { kind: 'realtime', durationSeconds: 4, stop: 'round-end' } });
    const short = await fixtureReport();
    short.producer.timing.frameCount = 74;
    short.producer.timing.stop = { requested: 'round-end', reason: 'round-ended', cutAtMs: 1, playingSeconds: 2.48, droppedFrames: 12 };
    const v = byKind(judgeFlowReport(roundEnd, short, source))['flow-frame-count'];
    expect(v.passed).toBe(true);
    expect(v.diagnostic).toMatch(/74 frames.*ended after 2.48 s/);
    // The whole window is still the ceiling: a longer clip than the window is a bug, not a round.
    const over = await fixtureReport();
    over.producer.timing.frameCount = 121;
    expect(byKind(judgeFlowReport(roundEnd, over, source))['flow-frame-count'].passed).toBe(false);
    // ...and a round-end recipe still fails the surface gate if the recorder kept the panel.
    const kept = await fixtureReport();
    kept.producer.readiness.surfaceAtEnd = 'menu';
    expect(byKind(judgeFlowReport(roundEnd, kept, source))['flow-still-playing'].passed).toBe(false);
  });

  it('gates the delivered rate only when the recipe asks, against the screencast rate', async () => {
    const report = await fixtureReport();
    expect(byKind(judgeFlowReport(recipe(), report, source))['flow-delivered-rate']).toBeUndefined();
    const gated = recipe({ variant: { level: 1, driver: 'autoplay', flags: {}, minimumDeliveredFps: 45 } });
    expect(byKind(judgeFlowReport(gated, report, source))['flow-delivered-rate'].passed).toBe(true);
    const slow = await fixtureReport();
    slow.producer.timing.screencast.fps = 28.4;
    const v = byKind(judgeFlowReport(gated, slow, source))['flow-delivered-rate'];
    expect(v.passed).toBe(false);
    expect(v.diagnostic).toMatch(/delivered 28.4 frames per second under ANGLE/);
  });
});

describe('runFlow: the recorder run and the result handed to the runner (issue #815)', () => {
  async function context(over: Record<string, any> = {}) {
    const root = await mkdtemp(join(tmpdir(), 'flow-adapter-'));
    const outputDirectory = join(root, 'tmp', 'capture-1', 'producer');
    await (await import('node:fs/promises')).mkdir(outputDirectory, { recursive: true });
    return {
      recipe: recipe(),
      root,
      outputDirectory,
      outputRelative: 'tmp/capture-1/producer',
      prerequisites: { playwright: { moduleSpecifier: 'playwright' } },
      env: {},
      signal: undefined,
      ...over,
    };
  }

  const recorderThatWrites = (report: any, frames = 120) => vi.fn(async (_command: string, args: string[], options: any) => {
    const out = join(options.cwd, args[args.indexOf('--out') + 1]);
    for (let index = 0; index < frames; index++) await writeFile(join(out, `frame-${String(index).padStart(4, '0')}.png`), `frame ${index}`);
    await writeFile(join(options.cwd, args[args.indexOf('--report') + 1]), JSON.stringify(report));
    return { code: 0, stdout: '', stderr: '' };
  });

  it('spawns the recorder with the built argv and the Playwright module, and returns a valid schema-v1 result', async () => {
    const report = await fixtureReport();
    const ctx = await context();
    const runProcess = recorderThatWrites(report);
    const inspectSourceState = vi.fn(async () => ({ requestedRef: null, commitSha: SHA, dirty: false }));
    const result = await runFlow(ctx, { runProcess, inspectSourceState });
    expect(runProcess).toHaveBeenCalledOnce();
    const [command, args, options] = runProcess.mock.calls[0];
    expect(command).toBe(process.execPath);
    expect(args[0]).toBe(join(ctx.root, 'tools/screens/record.mjs'));
    expect(args.slice(1)).toEqual(buildFlowArguments(ctx.recipe, ctx.outputRelative));
    expect(options.env.PLAYWRIGHT_MODULE).toBe('playwright');
    expect(options.timeoutMs).toBe(120_000);
    expect(result.rawFrames).toHaveLength(120);
    expect(result.capture.frameSchedule).toEqual({ kind: 'frames', frameCount: 120 });
    expect(result.assertions.every((a: any) => a.passed)).toBe(true);
    expect(result.metadata.flow.flowId).toBe('campaign-round');
    expect(result.toolVersions).toEqual({ chromium: '151.0.0.0' });
    await expect(validateProducerResult(result, { recipe: ctx.recipe, outputDirectory: ctx.outputDirectory })).resolves.toBeDefined();
  });

  it('wraps a recorder failure, a missing report, and a report for another flow', async () => {
    const failing = vi.fn(async () => { throw new Error('exit code 1'); });
    await expect(runFlow(await context(), { runProcess: failing })).rejects.toThrow(/flow capture failed: exit code 1/);
    const silent = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
    await expect(runFlow(await context(), { runProcess: silent })).rejects.toThrow(/did not produce a readable producer report/);
    const other = await fixtureReport();
    other.producer.flowId = 'campaign-menu';
    await expect(runFlow(await context(), { runProcess: recorderThatWrites(other) })).rejects.toThrow(/reported flow 'campaign-menu'/);
  });

  it('carries a failed gate through as a failed assertion rather than hiding it', async () => {
    const report = await fixtureReport();
    report.producer.diagnostics.build = { commit: null, known: false };
    const result = await runFlow(await context(), {
      runProcess: recorderThatWrites(report),
      inspectSourceState: vi.fn(async () => ({ requestedRef: null, commitSha: SHA, dirty: false })),
    });
    const failed = result.assertions.filter((a: any) => !a.passed);
    expect(failed.map((a: any) => a.kind)).toEqual(['flow-build-identity']);
  });
});
