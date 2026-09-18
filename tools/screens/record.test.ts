// The recorder's I/O shell (issue #815): its argv, the launch arguments a visual profile
// maps to, the tick-sample summary, and that every resource is released when a recording
// fails before or after the browser is up. The measurements themselves are `flow.test.ts`'s.
import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  launchArgumentsFor,
  parseRecordArgs,
  recordFlow,
  simulationFromSamples,
} from './record.mjs';

const ARGV = [
  '--flow', 'campaign-round', '--level', '1', '--seed', '7', '--driver', 'autoplay',
  '--seconds', '4', '--fps', '30', '--w', '1280', '--h', '800', '--dpr', '1', '--visual', 'host-gpu',
  '--stop', 'window',
  '--dist', 'dist', '--out', 'tmp/x', '--report', 'tmp/x/producer.json', '--timeout', '120000',
];

describe('parseRecordArgs (issue #815)', () => {
  it('reads the adapter\'s argv into validated inputs and a whole frame count', () => {
    const options = parseRecordArgs(ARGV);
    expect(options.flow.id).toBe('campaign-round');
    expect(options.inputs).toEqual({ level: 1, seed: 7, driver: 'autoplay', flags: {} });
    expect(options.frameCount).toBe(120);
    expect(options.viewport).toEqual({ width: 1280, height: 800, devicePixelRatio: 1 });
    expect(parseRecordArgs([...ARGV, '--flag', 'pp1Roles']).inputs.flags).toEqual({ pp1Roles: true });
    expect(options.stop).toBe('window');
    expect(parseRecordArgs(ARGV.map((a) => (a === 'window' ? 'round-end' : a))).stop).toBe('round-end');
  });

  it('refuses an unknown option, a missing value, a repeated option, a bad flag and a fractional frame count', () => {
    expect(() => parseRecordArgs([...ARGV, '--query', 'x=1'])).toThrow(/unknown option --query/);
    expect(() => parseRecordArgs(ARGV.slice(0, -1))).toThrow(/--timeout needs a value/);
    expect(() => parseRecordArgs([...ARGV, '--seed', '8'])).toThrow(/--seed given twice/);
    expect(() => parseRecordArgs([...ARGV, '--flag', 'aimRay'])).toThrow(/--flag aimRay is not a flow flag/);
    expect(() => parseRecordArgs(ARGV.map((a) => (a === '4' ? '0.25' : a)))).toThrow(/whole frame count/);
    expect(() => parseRecordArgs(ARGV.map((a) => (a === 'host-gpu' ? 'metal' : a)))).toThrow(/--visual must be one of/);
    expect(() => parseRecordArgs(ARGV.map((a) => (a === 'window' ? 'first-kill' : a)))).toThrow(/--stop must be one of/);
    expect(() => parseRecordArgs(['stray'])).toThrow(/unexpected argument 'stray'/);
  });
});

describe('launchArgumentsFor (issue #815)', () => {
  it('maps software-gl to SwiftShader and host-gpu to the platform\'s GPU backend', () => {
    expect(launchArgumentsFor('software-gl')).toEqual(['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox']);
    expect(launchArgumentsFor('host-gpu', 'darwin')).toEqual(['--ignore-gpu-blocklist', '--use-angle=metal']);
    expect(launchArgumentsFor('host-gpu', 'linux')).toEqual(['--ignore-gpu-blocklist']);
    expect(() => launchArgumentsFor('metal')).toThrow(/unknown visual profile 'metal'/);
  });
});

describe('simulationFromSamples (issue #815)', () => {
  const sample = (ticks: number | null, now: number, surface = 'playing') => ({ ticks, now, surface });

  it('rates ticks against page-side time, banking a reset', () => {
    const s = simulationFromSamples([sample(0, 0), sample(60, 1000), sample(120, 2000), sample(15, 3000), sample(75, 4000)]);
    expect(s.available).toBe(true);
    // World 1 ran 0 to 120; world 2 was first seen at 15 and reached 75: 120 + 75 over 4 s.
    expect(s.ticks).toBe(195);
    expect(s.seconds).toBe(4);
    expect(s.ticksPerSecond).toBeCloseTo(48.75, 6);
    expect(s.resets).toBe(1);
    expect(s.surfaces).toEqual(['playing', 'playing', 'playing', 'playing', 'playing']);
  });

  it('reports the surface it saw even when the replay surface is missing, and no rate from one sample', () => {
    expect(simulationFromSamples([sample(null, 0, 'menu')])).toMatchObject({ available: false, ticksPerSecond: null, surfaces: ['menu'] });
    expect(simulationFromSamples([sample(3, 0)])).toMatchObject({ available: true, ticksPerSecond: null });
  });
});

describe('recordFlow releases what it opened (issue #815)', () => {
  function fakes(failAt: 'launch' | 'goto' | 'never') {
    const server = { address: () => ({ port: 4321 }), close: vi.fn((cb: () => void) => cb()) };
    const context = { newPage: vi.fn(async () => page), close: vi.fn(async () => {}) };
    const page = {
      on: vi.fn(),
      goto: vi.fn(async () => { if (failAt === 'goto') throw new Error('net::ERR_CONNECTION_REFUSED'); }),
      evaluate: vi.fn(async () => { throw new Error('the fake page cannot be driven'); }),
      keyboard: { press: vi.fn(async () => {}) },
    };
    const browser = { newContext: vi.fn(async () => context), close: vi.fn(async () => {}), version: () => '0.0.0' };
    const chromium = { launch: vi.fn(async () => { if (failAt === 'launch') throw new Error('no chromium'); return browser; }) };
    return { server, browser, context, chromium };
  }

  async function options() {
    const dist = await mkdtemp(join(tmpdir(), 'flow-dist-'));
    await writeFile(join(dist, 'index.html'), '<!doctype html>');
    return { ...parseRecordArgs(ARGV), dist, out: join(dist, 'out'), report: join(dist, 'out', 'producer.json') };
  }

  it('closes the server when the browser fails to launch', async () => {
    const f = fakes('launch');
    await expect(recordFlow(await options(), { serve: async () => f.server, loadChromium: async () => f.chromium })).rejects.toThrow(/no chromium/);
    expect(f.server.close).toHaveBeenCalledOnce();
    expect(f.browser.close).not.toHaveBeenCalled();
  });

  it('closes the context, the browser and the server when the page cannot be reached', async () => {
    const f = fakes('goto');
    await expect(recordFlow(await options(), { serve: async () => f.server, loadChromium: async () => f.chromium })).rejects.toThrow(/ERR_CONNECTION_REFUSED/);
    expect(f.context.close).toHaveBeenCalledOnce();
    expect(f.browser.close).toHaveBeenCalledOnce();
    expect(f.server.close).toHaveBeenCalledOnce();
  });

  it('reads every option it was given, so none is undefined at the recording', async () => {
    // The regression this pins: `stop` was parsed, passed and used, but left out of
    // `recordFlow`'s own destructuring, so it was `undefined` at the line that reads it --
    // past every point the fakes below reach, and only visible in a real capture.
    const source = await (await import('node:fs/promises')).readFile(new URL('./record.mjs', import.meta.url), 'utf8');
    const destructured = /const \{ ([^}]+) \} = options;/.exec(source)?.[1] ?? '';
    const taken = new Set(destructured.split(',').map((name) => name.trim()));
    for (const name of Object.keys(parseRecordArgs(ARGV))) {
      expect(taken.has(name), `recordFlow never reads options.${name}`).toBe(true);
    }
  });

  it('refuses to start without a built page', async () => {
    const dist = await mkdtemp(join(tmpdir(), 'flow-nodist-'));
    const f = fakes('never');
    await expect(recordFlow({ ...parseRecordArgs(ARGV), dist, out: join(dist, 'out'), report: join(dist, 'out', 'r.json') }, { serve: async () => f.server, loadChromium: async () => f.chromium }))
      .rejects.toThrow(/no index.html under/);
    expect(f.chromium.launch).not.toHaveBeenCalled();
  });
});
