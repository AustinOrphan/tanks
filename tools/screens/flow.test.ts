// The pure half of a real-time application capture (issue #815): the flow catalogue, the URL
// a recipe's structured inputs build, and the arithmetic behind the timing evidence. Each
// case names the way a capture could mislead that it catches.
import { describe, it, expect } from 'vitest';
import {
  ACHIEVEMENT_IDS,
  CAMPAIGN_LEVEL_COUNT,
  FLOW_DRIVER_PARAMS,
  FLOW_FLAGS,
  FLOW_FLAG_IDS,
  FLOW_IDS,
  TICKS_START,
  bankTicks,
  buildFlowUrl,
  campaignArenaId,
  findFlow,
  jpegDimensions,
  parseDiagnostics,
  playingWindow,
  resamplePlan,
  stopsAtSample,
  timingStats,
  totalTicks,
  validateFlowInputs,
} from './flow.mjs';
import { FLAG_REGISTRY } from '../../src/game/devflags';
import { ENEMY_ROLE_CUES } from '../../src/presentation/enemy-role';
import { IDENTITY_MARKER_STYLES } from '../../src/presentation/identity-marker';
import { WRECK_EFFECTS } from '../../src/presentation/wreck';
import { ACHIEVEMENTS } from '../../src/game/achievements';

const inputs = (over: Record<string, unknown> = {}) => ({ level: 1, seed: 7, driver: 'autoplay', flags: {}, ...over });

describe('the flow catalogue (issue #815)', () => {
  it('names the campaign round, and refuses a flow it does not know', () => {
    expect(FLOW_IDS).toEqual(['campaign-round', 'coop-round', 'versus-round']);
    expect(() => findFlow('campaign-menu')).toThrow(/unknown flow 'campaign-menu'/);
  });

  it('boots with every level unlocked and every achievement already earned', () => {
    // Level Select renders one button per UNLOCKED level, so a recipe naming level 4 needs
    // four of them; `?dev=1` reads the developer namespace, hence the prefixed keys. The
    // achievements are seeded so none unlocks mid-capture and lays a toast over the board.
    const storage = findFlow('campaign-round').storage;
    expect(Object.keys(storage).sort()).toEqual(['tanks.dev.tanks.achievements.v1', 'tanks.dev.tanks.progress.v1']);
    expect(JSON.parse(storage['tanks.dev.tanks.progress.v1']).levelId)
      .toBe(`level-0${CAMPAIGN_LEVEL_COUNT}`);
    expect(JSON.parse(storage['tanks.dev.tanks.achievements.v1']).earned).toEqual([...ACHIEVEMENT_IDS]);
  });

  it('seeds the achievement ids the game actually defines', () => {
    // Read from achievements.ts, not restated here: a new achievement must be seeded the day
    // it ships, or the capture after it lands opens with a toast.
    expect(ACHIEVEMENT_IDS.length).toBeGreaterThan(10);
    expect(ACHIEVEMENT_IDS).toContain('boots-on-ground');
    expect(ACHIEVEMENT_IDS).toContain('campaigner');
    expect(ACHIEVEMENT_IDS.map((id: string) => ACHIEVEMENTS.find((a) => a.id === id)).filter(Boolean))
      .toHaveLength(ACHIEVEMENTS.length);
  });

  it('reaches the level the recipe names through Level Select, by accessible name', () => {
    // The regression this pins: a flow that pressed New Game got level one whatever the
    // recipe asked for, because `campaign-new` lands on level one by design (issue #428).
    const flow = findFlow('campaign-round');
    expect(flow.open.map((step: any) => Object.values(step)[0])).toEqual(['Space', '.hud-splash']);
    for (const level of [1, 3, 5]) {
      const clicks = flow.start({ level }).map((step: any) => step.click).filter(Boolean);
      expect(clicks).toEqual(['.hud-levelselect-open', `.hud-level-btn[aria-label="Level ${level}"]`]);
    }
    expect(flow.start({ level: 2 }).some((step: any) => step.click === '.hud-new-game')).toBe(false);
  });

  it('reads the campaign the game reads: five levels, level 1 on arena-01', () => {
    expect(CAMPAIGN_LEVEL_COUNT).toBe(5);
    expect(campaignArenaId(1)).toBe('arena-01');
    expect(() => campaignArenaId(0)).toThrow(/no level 0/);
    expect(() => campaignArenaId(CAMPAIGN_LEVEL_COUNT + 1)).toThrow(/no level 6/);
  });

  it('allowlists only flags the dev-flag registry knows, with the vocabulary it knows', () => {
    // A renamed, retyped or re-valued flag fails HERE, not as an unknown parameter on a
    // captured page. This file runs under vitest and can import the TypeScript the `.mjs`
    // flow module cannot, which is what makes the two-way pin possible.
    const vocabularies: Record<string, readonly string[]> = {
      enemyRole: ENEMY_ROLE_CUES,
      identityMarker: IDENTITY_MARKER_STYLES,
      wreck: WRECK_EFFECTS,
    };
    for (const id of FLOW_FLAG_IDS) {
      const spec = (FLAG_REGISTRY as Record<string, { kind: string; param?: string; values?: readonly string[] }>)[id];
      expect(spec, `${id} is not a registered dev flag`).toBeDefined();
      expect(spec.param ?? id).toBe(id);
      const allowed = (FLOW_FLAGS as Record<string, true | readonly string[]>)[id];
      if (allowed === true) {
        expect(spec.kind, id).toBe('boolean');
      } else {
        expect(spec.kind, id).toBe('valued');
        // Both directions: the flow offers exactly what the flag accepts.
        expect([...allowed].sort(), id).toEqual([...(vocabularies[id] ?? spec.values ?? [])].sort());
      }
    }
    for (const param of FLOW_DRIVER_PARAMS) {
      if (param === 'dev') continue; // the gate itself, not a DevFlags field
      expect(FLAG_REGISTRY, `${param} is not a registered dev flag`).toHaveProperty(param);
    }
  });
});

describe('co-op is its own named capture (issue #359)', () => {
  const coop = (over: Record<string, unknown> = {}) => inputs({ players: 3, ...over });

  it('is a flow, because co-op is a campaign round with company rather than a versus round', () => {
    expect(FLOW_IDS).toContain('coop-round');
  });

  it('asks for the player slots even with no mode, which is what makes it co-op at all', () => {
    // The bug this pins: `players` used to be emitted only alongside `mode`, so every co-op
    // request recorded a ONE-player campaign round -- which looks exactly like a correct
    // capture, and would have been filed as evidence of target distribution across players
    // that were never on the board.
    const url = buildFlowUrl(coop({ bots: 2, flags: { aiContact: true } }));
    expect(url).toContain('players=3');
    expect(url).toContain('bots=2');
    expect(url).not.toContain('mode=');
    expect(url).toBe('?dev=1&replay=1&level=4&seed=7&players=3&bots=2&autoplay=1&aiContact=1'.replace('level=4', 'level=1'));
  });

  it('still refuses a half-specified versus round', () => {
    // `players` alone became legal; `mode` alone did not. A versus recipe that loses its
    // player count would otherwise play the board with one tank and no stock strip.
    expect(() => validateFlowInputs(inputs({ mode: 'ffa' }))).toThrow(/mode needs players/);
  });

  it('keys `bots` to the player slots, not to the versus mode', () => {
    expect(() => validateFlowInputs(inputs({ bots: 2 }))).toThrow(/bots needs players/);
    expect(() => validateFlowInputs(coop({ bots: 4 }))).toThrow(/bots must be a whole number in \[0, 3\]/);
    expect(buildFlowUrl(coop({ bots: 3 }))).toContain('bots=3');
  });
});

describe('a versus recording says how many slots the computer drives (issue #359)', () => {
  const versus = (over: Record<string, unknown> = {}) =>
    inputs({ mode: 'ffa', players: 4, ...over });

  it('puts `bots` after `players`, because it is bounded by it', () => {
    expect(buildFlowUrl(versus({ bots: 3 })))
      .toBe('?dev=1&replay=1&level=1&seed=7&mode=ffa&players=4&bots=3&autoplay=1');
  });

  it('keeps absent and zero distinct, because an all-human board is a real request', () => {
    // Absent leaves the session's own default alone; `bots=0` asks for no computer players
    // at all. Collapsing them would make it impossible to record the second on purpose.
    expect(buildFlowUrl(versus())).not.toContain('bots');
    expect(buildFlowUrl(versus({ bots: 0 }))).toContain('bots=0');
  });

  it('refuses more bots than there are slots, rather than letting the page clamp', () => {
    // `devflags.ts` clamps `bots` against the resolved player count instead of rejecting it.
    // That is right for a URL a person typed and wrong for a recipe: the clamp would record a
    // different session than the one named, and the report would describe the request.
    expect(() => validateFlowInputs(versus({ bots: 5 }))).toThrow(/bots must be a whole number in \[0, 4\]/);
    expect(() => validateFlowInputs(versus({ bots: -1 }))).toThrow(/bots must be/);
    expect(() => validateFlowInputs(versus({ bots: 1.5 }))).toThrow(/bots must be/);
  });

  it('refuses `bots` without a versus session to put them in', () => {
    expect(() => validateFlowInputs(inputs({ bots: 2 }))).toThrow(/bots needs players/);
  });

  it('offers the contact overlay, which is what makes the selection visible at all', () => {
    // A versus recording without it is tanks moving around: the committed opponent and the
    // reason for each change are drawn only by `aiContact`.
    expect(FLOW_FLAG_IDS).toContain('aiContact');
    expect(buildFlowUrl(versus({ bots: 3, flags: { aiContact: true } })))
      .toBe('?dev=1&replay=1&level=1&seed=7&mode=ffa&players=4&bots=3&autoplay=1&aiContact=1');
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

  it('carries a valued flag as its own value, and a switch as a bare 1', () => {
    expect(buildFlowUrl(inputs({ flags: { enemyRole: 'both' } })))
      .toBe('?dev=1&replay=1&level=1&seed=7&autoplay=1&enemyRole=both');
    // Two cues at once, which is what issue #773's evidence list asks to see: a role cue and
    // an owner cue on the same board, to judge whether they stay distinct.
    expect(buildFlowUrl(inputs({ flags: { enemyRole: 'both', identityMarker: 'roof' } })))
      .toBe('?dev=1&replay=1&level=1&seed=7&autoplay=1&enemyRole=both&identityMarker=roof');
    expect(buildFlowUrl(inputs({ flags: { pp1Roles: true, enemyRole: 'flare' } })))
      .toBe('?dev=1&replay=1&level=1&seed=7&autoplay=1&pp1Roles=1&enemyRole=flare');
  });

  it('refuses a driver it has no policy for and a flag off the allowlist, and never a raw string', () => {
    expect(() => validateFlowInputs(inputs({ driver: 'human' }))).toThrow(/driver must be one of autoplay/);
    expect(() => validateFlowInputs(inputs({ flags: { aimRay: true } }))).toThrow(/flags\.aimRay is not a flow flag/);
    expect(() => validateFlowInputs(inputs({ flags: { pp1Roles: 'yes' } }))).toThrow(/flags\.pp1Roles must be a boolean/);
    // A valued flag takes ITS OWN values: the page reads anything else as absent, so a
    // capture would record the arm it asked for and show the board without it.
    expect(() => validateFlowInputs(inputs({ flags: { enemyRole: 'barrel' } }))).toThrow(/flags\.enemyRole must be one of/);
    expect(() => validateFlowInputs(inputs({ flags: { enemyRole: true } }))).toThrow(/flags\.enemyRole must be one of/);
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

describe('playingWindow: where a recording stops (issue #815)', () => {
  const s = (surface: string, atMs: number) => ({ surface, atMs, ticks: 1, now: atMs });

  it('under `window`, keeps every sample and names the surface that left play', () => {
    const samples = [s('playing', 0), s('playing', 250), s('menu', 500)];
    const w = playingWindow(samples, 'window');
    expect(w.samples).toHaveLength(3);
    expect(w.stopReason).toBe('window');
    expect(w.cutAtMs).toBeNull();
    // Recorded, not hidden: the adapter's still-playing gate is what refuses this.
    expect(w.endedAs).toBe('menu');
  });

  it('under `round-end`, cuts at the last playing sample and says why', () => {
    const w = playingWindow([s('playing', 0), s('playing', 250), s('playing', 500), s('menu', 750)], 'round-end');
    expect(w.samples.map((x) => x.atMs)).toEqual([0, 250, 500]);
    expect(w.stopReason).toBe('round-ended');
    expect(w.cutAtMs).toBe(500);
    expect(w.endedAs).toBe('menu');
  });

  it('under `round-end`, a round that lasted the whole window is not cut', () => {
    const w = playingWindow([s('playing', 0), s('playing', 250)], 'round-end');
    expect(w.samples).toHaveLength(2);
    expect(w.stopReason).toBe('window');
    expect(w.cutAtMs).toBeNull();
    expect(w.endedAs).toBeNull();
  });

  it('refuses a policy it does not know', () => {
    expect(() => playingWindow([s('playing', 0)], 'first-kill')).toThrow(/unknown stop policy 'first-kill'/);
  });
});

describe('stopsAtSample: whether a poll ends the recording (issue #815)', () => {
  it('ends a round-end recording the moment play stops, and never a window one', () => {
    expect(stopsAtSample('round-end', 'playing')).toBe(false);
    expect(stopsAtSample('round-end', 'menu')).toBe(true);
    expect(stopsAtSample('round-end', 'not-playing')).toBe(true);
    // A `window` recording runs its window out; the adapter's still-playing gate judges it.
    expect(stopsAtSample('window', 'menu')).toBe(false);
    expect(stopsAtSample('window', 'playing')).toBe(false);
  });

  it('refuses a policy it does not know, rather than recording on', () => {
    expect(() => stopsAtSample('first-kill', 'menu')).toThrow(/unknown stop policy 'first-kill'/);
  });
});

/**
 * THE VERSUS FLOW (issue #234's normal-speed review).
 *
 * `?dev=1&mode=ffa` keeps the CAMPAIGN level system (loop.ts), so this flow takes the same
 * Level Select route the campaign one does and the `level` input keeps meaning what it means
 * everywhere else. What changes is the SHAPE of the session: the stock strip is on and
 * `players` tanks share the board.
 */
describe('the versus flow (issue #234)', () => {
  const vs = (over: Record<string, unknown> = {}) =>
    ({ level: 4, seed: 7, driver: 'autoplay', flags: {}, mode: 'ffa', players: 4, ...over });

  it('carries the session shape in the URL, before the driver and the flags', () => {
    expect(buildFlowUrl(vs())).toBe('?dev=1&replay=1&level=4&seed=7&mode=ffa&players=4&autoplay=1');
    expect(buildFlowUrl(vs({ flags: { identityMarker: 'shape' } })))
      .toBe('?dev=1&replay=1&level=4&seed=7&mode=ffa&players=4&autoplay=1&identityMarker=shape');
  });

  it('leaves the campaign URL untouched, which is the regression that matters', () => {
    // The versus parameters are ABSENT rather than defaulted, so every existing recipe and
    // every existing manifest still builds the same query it always did.
    expect(buildFlowUrl({ level: 1, seed: 7, driver: 'autoplay', flags: {} }))
      .toBe('?dev=1&replay=1&level=1&seed=7&autoplay=1');
  });

  it('refuses half a versus round, which is the failure that would look like a success', () => {
    // `mode` alone plays the board with one tank and no stock strip -- still refused.
    expect(() => validateFlowInputs(vs({ players: undefined }))).toThrow(/mode needs players/);
    // `players` alone is campaign co-op, and since issue #359 that is a legal request with a
    // flow of its own (`coop-round`) rather than a malformed versus round. What still stops a
    // versus RECIPE losing its mode is the flow's own `start`, which waits on
    // `.hud-versus-stocks` -- an element a campaign session never shows.
    expect(() => validateFlowInputs(vs({ mode: undefined }))).not.toThrow();
    expect(findFlow('versus-round').start({ level: 1 }).some(
      (step: Record<string, unknown>) => String(step.waitVisible ?? '').includes('hud-versus-stocks'),
    ), 'the versus flow no longer proves it is versus-shaped').toBe(true);
  });

  it('holds players and mode to the page own ranges, not a superset', () => {
    for (const bad of [1, 5, 0, 2.5, '4']) {
      expect(() => validateFlowInputs(vs({ players: bad })), String(bad)).toThrow(/players must be/);
    }
    for (const bad of ['coop', 'campaign', '', 'FFA']) {
      expect(() => validateFlowInputs(vs({ mode: bad })), String(bad)).toThrow(/mode must be one of/);
    }
  });

  it('waits for the stock strip, so a mode that was ignored fails instead of recording', () => {
    // The strip is the only element that says the session really is versus-shaped. Without
    // this step a dropped `mode` would record a campaign board under a versus recipe id.
    const steps = findFlow('versus-round').start({ level: 4 });
    expect(steps.at(-1)).toEqual({ waitVisible: '.hud-versus-stocks:not(.hud-versus-stocks--hidden)' });
    expect(steps.some((s: Record<string, string>) => s.click === '.hud-levelselect-open')).toBe(true);
    expect(steps.some((s: Record<string, string>) => s.click === '.hud-level-btn[aria-label="Level 4"]')).toBe(true);
  });

  it('seeds the same progress and achievements the campaign flow does', () => {
    // Level Select renders one button per unlocked level, and an achievement unlocking
    // mid-capture lays a toast over the board. Both flows pay the same price for the same
    // route, so they seed the same keys.
    const versus = findFlow('versus-round');
    const campaign = findFlow('campaign-round');
    expect(Object.keys(versus.storage).sort()).toEqual(Object.keys(campaign.storage).sort());
  });
});
