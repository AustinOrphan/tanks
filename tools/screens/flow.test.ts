// The pure half of a real-time application capture (issue #815): the flow catalogue, the URL
// a recipe's structured inputs build, and the arithmetic behind the timing evidence. Each
// case names the way a capture could mislead that it catches.
import { describe, it, expect } from 'vitest';
import {
  CAMPAIGN_LEVEL_COUNT,
  FLOW_DRIVER_PARAMS,
  FLOW_FLAG_IDS,
  FLOW_IDS,
  TICKS_START,
  bankTicks,
  buildFlowUrl,
  campaignArenaId,
  findFlow,
  jpegDimensions,
  parseDiagnostics,
  resamplePlan,
  timingStats,
  totalTicks,
  validateFlowInputs,
} from './flow.mjs';
import { FLAG_REGISTRY } from '../../src/game/devflags';

const inputs = (over: Record<string, unknown> = {}) => ({ level: 1, seed: 7, driver: 'autoplay', flags: {}, ...over });

describe('the flow catalogue (issue #815)', () => {
  it('names the campaign round, and refuses a flow it does not know', () => {
    expect(FLOW_IDS).toEqual(['campaign-round']);
    expect(findFlow('campaign-round').storage).toEqual({});
    expect(() => findFlow('campaign-menu')).toThrow(/unknown flow 'campaign-menu'/);
  });

  it('reads the campaign the game reads: five levels, level 1 on arena-01', () => {
    expect(CAMPAIGN_LEVEL_COUNT).toBe(5);
    expect(campaignArenaId(1)).toBe('arena-01');
    expect(() => campaignArenaId(0)).toThrow(/no level 0/);
    expect(() => campaignArenaId(CAMPAIGN_LEVEL_COUNT + 1)).toThrow(/no level 6/);
  });

  it('allowlists only flags the dev-flag registry knows as booleans under the same parameter name', () => {
    // A renamed or retyped flag fails HERE, not as an unknown parameter on a captured page.
    for (const id of FLOW_FLAG_IDS) {
      const spec = (FLAG_REGISTRY as Record<string, { kind: string; param?: string }>)[id];
      expect(spec, `${id} is not a registered dev flag`).toBeDefined();
      expect(spec.kind).toBe('boolean');
      expect(spec.param ?? id).toBe(id);
    }
    for (const param of FLOW_DRIVER_PARAMS) {
      if (param === 'dev') continue; // the gate itself, not a DevFlags field
      expect(FLAG_REGISTRY, `${param} is not a registered dev flag`).toHaveProperty(param);
    }
  });
});

describe('flow inputs and the URL they build (issue #815)', () => {
  it('builds the query in a fixed order from validated fields, flags last and only when on', () => {
    expect(buildFlowUrl(inputs())).toBe('?dev=1&replay=1&level=1&seed=7&autoplay=1');
    expect(buildFlowUrl(inputs({ flags: { pp1Roles: true } }))).toBe('?dev=1&replay=1&level=1&seed=7&autoplay=1&pp1Roles=1');
    expect(buildFlowUrl(inputs({ flags: { pp1Roles: false } }))).toBe('?dev=1&replay=1&level=1&seed=7&autoplay=1');
  });

  it('refuses what the page would silently substitute: seed 0, a level past the campaign, a fraction', () => {
    expect(() => validateFlowInputs(inputs({ seed: 0 }))).toThrow(/seed must be/);
    expect(() => validateFlowInputs(inputs({ seed: 1.5 }))).toThrow(/seed must be/);
    expect(() => validateFlowInputs(inputs({ level: 0 }))).toThrow(/level must be/);
    expect(() => validateFlowInputs(inputs({ level: CAMPAIGN_LEVEL_COUNT + 1 }))).toThrow(/level must be/);
    expect(() => validateFlowInputs(inputs({ level: '1' }))).toThrow(/level must be/);
  });

  it('refuses a driver it has no policy for and a flag off the allowlist, and never a raw string', () => {
    expect(() => validateFlowInputs(inputs({ driver: 'human' }))).toThrow(/driver must be one of autoplay/);
    expect(() => validateFlowInputs(inputs({ flags: { aimRay: true } }))).toThrow(/flags\.aimRay is not a flow flag/);
    expect(() => validateFlowInputs(inputs({ flags: { pp1Roles: 'yes' } }))).toThrow(/flags\.pp1Roles must be a boolean/);
    expect(() => validateFlowInputs(inputs({ flags: ['pp1Roles'] }))).toThrow(/flags must be a plain object/);
    expect(() => validateFlowInputs(inputs({ flags: { 'pp1Roles&x': true } }))).toThrow(/not a flow flag/);
  });
});

describe('resamplePlan: hold the last frame at a constant rate (issue #815)', () => {
  const every = (count: number, stepSeconds: number, start = 10) => Array.from({ length: count }, (_, i) => start + i * stepSeconds);

  it('takes every other 60 fps frame for a 30 fps output, holding nothing', () => {
    const plan = resamplePlan({ timestamps: every(120, 1 / 60), fps: 30, frameCount: 60 });
    expect(plan.sources).toHaveLength(60);
    expect(plan.sources.slice(0, 4)).toEqual([0, 2, 4, 6]);
    expect(plan.heldFrames).toBe(0);
    expect(plan.maxConsecutiveHold).toBe(0);
    expect(plan.uniqueFramesUsed).toBe(60);
    expect(plan.sourceFrames).toBe(120);
  });

  it('repeats the last frame across a gap, and reports the repeats rather than smoothing them', () => {
    // 60 fps for 1 s, then nothing for 0.5 s, then 60 fps again. The slot at 1.000 s still finds a
    // fresh frame (0.983 s), so the gap holds the 14 slots after it, and 61 distinct frames are used.
    const timestamps = [...every(60, 1 / 60, 0), ...every(60, 1 / 60, 1.5)];
    const plan = resamplePlan({ timestamps, fps: 30, frameCount: 75 });
    expect(plan.sources).toHaveLength(75);
    expect(plan.heldFrames).toBe(14);
    expect(plan.maxConsecutiveHold).toBe(14);
    expect(plan.uniqueFramesUsed).toBe(61);
  });

  it('never picks a frame from the future, and pads the tail when the last frame lands early', () => {
    const plan = resamplePlan({ timestamps: [0, 0.1, 0.2], fps: 10, frameCount: 5 });
    expect(plan.sources).toEqual([0, 1, 2, 2, 2]);
    expect(plan.tailPadMs).toBeCloseTo(300, 5);
    expect(plan.coveredMs).toBeCloseTo(200, 5);
  });

  it('produces exactly frameCount slots however many frames arrived', () => {
    for (const count of [1, 7, 500]) {
      expect(resamplePlan({ timestamps: every(count, 0.01), fps: 60, frameCount: 90 }).sources).toHaveLength(90);
    }
  });

  it('refuses no frames, a descending clock, or a degenerate rate', () => {
    expect(() => resamplePlan({ timestamps: [], fps: 30, frameCount: 1 })).toThrow(/at least one frame/);
    expect(() => resamplePlan({ timestamps: [1, 0.5], fps: 30, frameCount: 1 })).toThrow(/must ascend/);
    expect(() => resamplePlan({ timestamps: [0], fps: 0, frameCount: 1 })).toThrow(/fps > 0/);
    expect(() => resamplePlan({ timestamps: [0], fps: 30, frameCount: 0 })).toThrow(/positive frameCount/);
  });
});

describe('timingStats: the clamp is the contract (issue #815)', () => {
  it('reads a steady 60 fps as unclamped', () => {
    const stats = timingStats(Array.from({ length: 61 }, (_, i) => i * (1000 / 60)));
    expect(stats.frames).toBe(61);
    expect(stats.fps).toBeCloseTo(60, 6);
    expect(stats.clampedFrames).toBe(0);
    expect(stats.simTimeLostMs).toBe(0);
    expect(stats.gapMaxMs).toBeCloseTo(1000 / 60, 6);
  });

  it('counts a gap past 250 ms as a clamped frame and the excess as simulated time lost', () => {
    const stats = timingStats([0, 16, 32, 432, 448]);
    expect(stats.clampedFrames).toBe(1);
    expect(stats.simTimeLostMs).toBe(150);
    expect(stats.gapMaxMs).toBe(400);
    // The negative control: the same gap under a looser clamp is not lost time.
    expect(timingStats([0, 16, 32, 432, 448], 500).clampedFrames).toBe(0);
  });

  it('gives nulls, not NaN, for fewer than two samples', () => {
    expect(timingStats([]).fps).toBeNull();
    expect(timingStats([5]).gapP95Ms).toBeNull();
    expect(timingStats([5]).clampedFrames).toBe(0);
  });
});

describe('bankTicks: ticks sum across world rebuilds (issue #815)', () => {
  it('adds monotonic samples and banks a reset', () => {
    let state = bankTicks(TICKS_START, 100);
    state = bankTicks(state, 250);
    expect(totalTicks(state)).toBe(250);
    state = bankTicks(state, 12); // a lost life: the trace restarted
    expect(totalTicks(state)).toBe(262);
    state = bankTicks(state, 60);
    expect(totalTicks(state)).toBe(310);
  });

  it('refuses a sample that is not a whole tick count', () => {
    expect(() => bankTicks(TICKS_START, -1)).toThrow(/whole number/);
    expect(() => bankTicks(TICKS_START, null as never)).toThrow(/whole number/);
  });
});

describe('jpegDimensions (issue #815)', () => {
  const jpeg = (width: number, height: number, withSof = true) => {
    const app0 = [0xff, 0xe0, 0x00, 0x04, 0x00, 0x00];
    const sof = withSof ? [0xff, 0xc0, 0x00, 0x0b, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x01, 0x01] : [];
    return new Uint8Array([0xff, 0xd8, ...app0, ...sof, 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]);
  };

  it('reads the declared size from the start-of-frame segment', () => {
    expect(jpegDimensions(jpeg(1280, 800))).toEqual({ width: 1280, height: 800 });
    expect(jpegDimensions(jpeg(2560, 1600))).toEqual({ width: 2560, height: 1600 });
  });

  it('refuses bytes that are not a JPEG, or a JPEG with no frame', () => {
    expect(() => jpegDimensions(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toThrow(/missing SOI/);
    expect(() => jpegDimensions(jpeg(1, 1, false))).toThrow(/no start-of-frame/);
  });
});

describe('parseDiagnostics: the page\'s own account (issue #815)', () => {
  const sha = 'a'.repeat(40);
  const report = [
    '## Tanks! session diagnostics',
    '',
    '- URL: /?dev=1&replay=1&level=1&seed=7&autoplay=1&pp1Roles=1',
    `- Build: ${sha}`,
    '- Developer mode: on',
    '- Session: none simulating (no seed to report)',
    '',
    '### In effect without being requested',
    '',
    '- `sandboxDisarmed`: requested (absent), effective `true` — inverted-default',
  ].join('\n');

  it('reads the build, the mode, and the three parameter sections', () => {
    const parsed = parseDiagnostics(report);
    expect(parsed.build).toEqual({ commit: sha, known: true });
    expect(parsed.developerMode).toBe(true);
    expect(parsed.url).toBe('/?dev=1&replay=1&level=1&seed=7&autoplay=1&pp1Roles=1');
    expect(parsed.requestedNotInEffect).toEqual([]);
    expect(parsed.inEffectUnrequested).toEqual(['sandboxDisarmed']);
    expect(parsed.unknownParams).toEqual([]);
  });

  it('reads a refused parameter and an unknown one from their sections, and an unlabelled build as unknown', () => {
    const refused = report.replace(`- Build: ${sha}`, '- Build: unknown (not a deployed build)')
      + '\n\n### Requested, but not in effect\n\n- `seed`: requested `0`, effective `null` — rejected'
      + '\n\n### Parameters this build does not know\n\n- `pp1roles`';
    const parsed = parseDiagnostics(refused);
    expect(parsed.build).toEqual({ commit: null, known: false });
    expect(parsed.requestedNotInEffect).toEqual(['seed']);
    expect(parsed.unknownParams).toEqual(['pp1roles']);
    expect(parsed.inEffectUnrequested).toEqual(['sandboxDisarmed']);
  });

  it('refuses text that is not the report', () => {
    expect(() => parseDiagnostics('')).toThrow(/not a Tanks! session diagnostics/);
    expect(() => parseDiagnostics(null as never)).toThrow(/not a Tanks! session diagnostics/);
  });
});
