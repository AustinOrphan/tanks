import { describe, it, expect } from 'vitest';
import { arenaById, createWorldFor } from '../sim/arena';
import { cloneWorld, stepInputs, type World } from '../sim/world';
import type { InputState } from '../sim/types';
import { COUNTDOWN_TICKS } from '../sim/constants';
import type { AppLocation } from './app-state';
import {
  diagnosticsReport,
  formatDiagnostics,
  type DiagnosticsInput,
  type SessionDiagnostics,
} from './dev-diagnostics';
import {
  DIAGNOSTICS_FORMAT,
  DIAGNOSTICS_SCHEMA,
  diagnosticsExport,
  replayExport,
  screenshotExport,
  surfaceName,
  type RoundDiagnostics,
} from './dev-exports';
import {
  checkTrace,
  createRecordingInput,
  replayMetaFor,
  replayTrace,
  type ReplayMeta,
  type ReplayTrace,
} from './replay';

const SESSION: SessionDiagnostics = {
  seed: 918273645,
  arenaId: 'arena-04',
  mode: 'campaign',
  humanPlayers: 1,
  bots: 0,
  quality: 'high',
};

const ROUND: RoundDiagnostics = { tick: 480, roundStartTick: 1, surface: 'gameplay/playing' };

function input(overrides: Partial<DiagnosticsInput> = {}): DiagnosticsInput {
  return {
    path: '/tanks/',
    // A requested flag the model changes and a parameter it does not know, so `notes` and
    // `unknownParams` are not empty and a file that dropped them would differ.
    search: '?dev=1&quality=low&bogus=1',
    hash: '',
    build: { commit: 'abc1234', known: true },
    session: SESSION,
    ...overrides,
  };
}

/** The same rebuild `replay.test.ts` uses: every meta field threaded through. */
function worldFor(meta: ReplayMeta): World {
  return createWorldFor(arenaById(meta.arenaId), meta.seed, {
    lives: meta.lives,
    rules: {
      unarmedTrigger: meta.unarmedTrigger,
      corpseBlocksShells: meta.corpseBlocksShells,
      muzzleClearsTanks: meta.muzzleClearsTanks,
      coopAttempts: meta.coopAttempts,
      mode: meta.mode,
      friendlyFire: meta.friendlyFire,
      aiTargetPerception: meta.aiTargetPerception,
    },
  });
}

/** A seeded input script that varies every field, so a dropped or repeated tick replays differently. */
function scripted(seed: number): { sample(): InputState[] } {
  let s = seed >>> 0;
  return {
    sample(): InputState[] {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      const a = (s % 1000) / 1000;
      return [{ move: { x: a * 2 - 1, y: 1 - a }, aim: { x: 10 * a, y: -7 * a }, fire: (s & 8) !== 0, mine: (s & 16) !== 0 }];
    },
  };
}

/** Steps a real world `ticks` times through a recorder, as the driver does. */
function recordedRun(ticks: number, limit?: number): { trace: ReplayTrace; live: World; events: number } {
  const start = createWorldFor(arenaById('arena-01'), 777, { lives: 3 });
  const rec = createRecordingInput(scripted(99), replayMetaFor(start, 'arena-01', false), limit);
  let live = start;
  let events = 0;
  for (let i = 0; i < ticks; i++) {
    const result = stepInputs(live, rec.sample());
    live = result.world;
    events += result.events.length;
  }
  return { trace: rec.trace(), live, events };
}

describe('surfaceName names the route or the gameplay phase', () => {
  it('prefixes each with where it came from', () => {
    expect(surfaceName({ kind: 'route', route: { kind: 'main-menu' } })).toBe('route/main-menu');
    expect(
      surfaceName({ kind: 'gameplay', session: {}, phase: { kind: 'paused' } } as unknown as AppLocation),
    ).toBe('gameplay/paused');
  });
});

describe('diagnosticsExport', () => {
  it('saves Copy Diagnostics\' own record, stamped, plus the round', () => {
    // Issue #254: "diagnostic files ... match Copy Diagnostics fields". The file is compared
    // with the record `formatDiagnostics` renders, field for field, after the same JSON round
    // trip a saved file goes through.
    const file = diagnosticsExport(input(), ROUND);
    expect(JSON.parse(file.text)).toEqual({
      format: DIAGNOSTICS_FORMAT,
      schema: DIAGNOSTICS_SCHEMA,
      ...JSON.parse(JSON.stringify(diagnosticsReport(input()))),
      round: ROUND,
    });
    expect(file.type).toBe('application/json');
  });

  it('carries every value the copied text prints', () => {
    const parsed = JSON.parse(diagnosticsExport(input(), ROUND).text);
    const text = formatDiagnostics(input());
    expect(text).toContain(`- URL: ${parsed.canonicalUrl}`);
    expect(text).toContain(`- Build: ${parsed.build.commit}`);
    expect(text).toContain(`- Seed: ${parsed.session.seed}`);
    expect(text).toContain(`- Arena: ${parsed.session.arenaId}`);
    expect(text).toContain(`- Quality: ${parsed.session.quality}`);
    // The copied text renders every note and unknown parameter; the file keeps them as records.
    expect(parsed.notes).not.toEqual([]);
    for (const note of parsed.notes as Array<{ param: string }>) expect(text).toContain(`\`${note.param}\``);
    expect(parsed.unknownParams).toEqual(['bogus']);
    expect(text).toContain('- `bogus`');
  });

  it('is named for the seed and tick it describes', () => {
    expect(diagnosticsExport(input(), ROUND).fileName).toBe('tanks-diagnostics-seed918273645-tick480.json');
  });

  it('still saves a file with no session, saying so in its name and fields', () => {
    const file = diagnosticsExport(input({ session: null }), null);
    expect(file.fileName).toBe('tanks-diagnostics-no-session.json');
    const parsed = JSON.parse(file.text);
    expect(parsed.session).toBeNull();
    expect(parsed.round).toBeNull();
    expect(file.note).toContain('no session running');
  });

  it('labels an unknown build as unknown, in the file and in the note', () => {
    const file = diagnosticsExport(input({ build: { commit: '', known: false } }), ROUND);
    expect(JSON.parse(file.text).build).toEqual({ commit: '', known: false });
    expect(file.note).toContain('build unknown (not a deployed build)');
  });
});

describe('screenshotExport names the frame by what it is', () => {
  const CAPTURE = { width: 1280, height: 800, pixelRatio: 2 };

  it('names the seed, tick, drawing-buffer size and pixel ratio', () => {
    expect(screenshotExport(SESSION, ROUND, CAPTURE).fileName).toBe(
      'tanks-canvas-seed918273645-tick480-1280x800-dpr2.png',
    );
    expect(screenshotExport(null, ROUND, CAPTURE).fileName).toBe('tanks-canvas-tick480-1280x800-dpr2.png');
  });

  it('says it is the canvas only, at what size, and that the HUD is not in it', () => {
    // Issue #254: "obvious HUD semantics" and documented dimensions and DPR.
    const { note } = screenshotExport(SESSION, ROUND, { width: 960, height: 600, pixelRatio: 1.5 });
    expect(note).toContain('the game canvas only, 960x600 pixels at pixel ratio 1.5');
    expect(note).toContain('The HUD is not in it');
  });
});

describe('replayExport saves a replay only when there is one to replay', () => {
  it('saves nothing when recording is off, and names the flag that turns it on', () => {
    const result = replayExport(null);
    expect(result.kind).toBe('unavailable');
    expect(result.note).toContain('recording is off');
    expect(result.note).toContain('replay=1');
  });

  it('saves nothing when recording is on but no tick has been simulated', () => {
    // The "misleading empty replay" the issue names: a well-formed trace of zero ticks.
    const result = replayExport(recordedRun(0).trace);
    expect(result.kind).toBe('unavailable');
    expect(result.note).toContain('has not simulated a tick');
  });

  it('saves nothing when this build could not replay the trace, and says why', () => {
    const stale = { ...recordedRun(5).trace, schema: 1 };
    const result = replayExport(stale);
    expect(result.kind).toBe('unavailable');
    expect(result.note).toContain(checkTrace(stale).reason as string);
  });

  it('ROUND-TRIPS: the saved text parses into a trace that replays the recorded run', () => {
    // Issue #254: replay export "round-trips through existing replay tooling". The file's text
    // goes through JSON.parse, `checkTrace` and `replayTrace` onto a world rebuilt from its
    // meta, and must land where the live run did.
    const { trace, live, events } = recordedRun(COUNTDOWN_TICKS + 240);
    const result = replayExport(trace);
    if (result.kind !== 'file') throw new Error(`expected a file, got: ${result.note}`);
    const parsed = JSON.parse(result.text) as ReplayTrace;
    expect(checkTrace(parsed)).toEqual({ ok: true, reason: null });
    const replayed = replayTrace(parsed, worldFor(parsed.meta));
    expect(replayed.ticks).toBe(COUNTDOWN_TICKS + 240);
    expect(cloneWorld(replayed.world)).toEqual(cloneWorld(live));
    // Non-vacuous: the run has to have DONE something, or a comparison of two idle worlds
    // would pass with the inputs lost. Events rather than a final position, which a death
    // and respawn can return to spawn (replay.test.ts measured that on its own seed).
    expect(events).toBeGreaterThan(0);
    expect(replayed.events).toHaveLength(events);
  });

  it('is named for the seed, the arena and the tick count', () => {
    const result = replayExport(recordedRun(7).trace);
    expect(result.kind === 'file' && result.fileName).toBe('tanks-replay-seed777-arena-01-7ticks.json');
  });

  it('says when recording stopped at its tick limit', () => {
    const result = replayExport(recordedRun(6, 4).trace);
    expect(result.kind).toBe('file');
    expect(result.note).toContain('4 ticks');
    expect(result.note).toContain('tick limit');
    expect(replayExport(recordedRun(4, 4).trace).note).not.toContain('tick limit');
  });
});
