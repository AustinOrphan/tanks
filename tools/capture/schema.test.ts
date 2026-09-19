import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain-node tooling module, intentionally dependency-free.
import { producerForKind } from './producers.mjs';
// @ts-expect-error -- plain-node tooling module, intentionally dependency-free.
import { readFileSync } from 'node:fs';
import { CAPTURE_RECIPES, createRegistry } from './registry.mjs';
// @ts-expect-error -- plain-node tooling module, intentionally dependency-free.
import { canonicalStringify, recipeHash, validateRecipe } from './schema.mjs';

function recipe(index = 0): Record<string, any> {
  return structuredClone(CAPTURE_RECIPES[index].recipe);
}

/** A valid flow recipe (issue #815), built from a gallery one so every shared field is real. */
function flowRecipe(): Record<string, any> {
  const flow = recipe();
  flow.id = 'test.flow.round';
  flow.producer = { kind: 'flow', scenarioId: 'campaign-round' };
  flow.fixture = { id: 'campaign-round', seed: 7 };
  flow.variant = { level: 1, driver: 'autoplay', flags: {} };
  flow.profile = { visual: 'host-gpu', motion: 'full', capability: 'headless-desktop', reducedMotion: false };
  flow.schedule = { kind: 'realtime', durationSeconds: 2 };
  flow.playback = { rate: 1, intendedFps: 30 };
  flow.artifacts = [{ format: 'mp4', filename: 'capture.mp4' }];
  flow.expectations = { events: [], allowUnexpectedEvents: true };
  flow.timeoutMs = 120_000;
  return flow;
}

function reverseKeys(value: any): any {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).reverse().map((key) => [key, reverseKeys(value[key])]));
  }
  return value;
}

describe('capture recipe schema', () => {
  it('validates every registered recipe and keeps the shipped IDs intentional', () => {
    expect(CAPTURE_RECIPES.map((entry: any) => entry.recipe.id)).toEqual([
      'gallery.fire.still',
      'gallery.ai-tracking.normal',
      'gallery.ricochet.still',
      'gallery.drive.normal',
      'gallery.ai-last-seen.normal',
      // The `screen` producer's states (issue #561). Pinned like the gallery ones: this
      // list is what makes ADDING a recipe a deliberate act rather than a side effect.
      'screen.main-menu',
      'screen.main-menu.fresh',
      'screen.levels',
      'screen.records.stats',
      'screen.records.stats.empty',
      'screen.records.achievements',
      'screen.settings',
      'screen.settings.controller-layout',
      'screen.customize',
      'screen.versus-setup',
      'screen.versus-setup.selected',
      'screen.versus-setup.teams',
      'screen.versus-setup.map-replaced',
      'screen.about',
      'screen.about.document',
      'screen.devtools',
      'screen.devtools.config',
      'screen.devtools.config.sandbox',
      'screen.devtools.production-save',
      'screen.devtools.actions',
      'screen.devtools.diagnostics',
      'screen.devtools.controller-selftest',
      'screen.confirm.new-campaign',
      'screen.startup.unsupported-render',
      'screen.startup.probe-blocked',
      'screen.startup.match-failed',
      'screen.no-script',
      'screen.pause.versus',
      'screen.pause.campaign',
      'screen.controllers',
      'screen.controllers.pads',
      'screen.ending.mission-clear',
      'screen.ending.campaign-over',
      'screen.ending.mission-clear.played',
      'screen.ending.campaign-over.played',
      'screen.ending.campaign-complete',
      'screen.ending.practice-cleared',
      'screen.ending.practice-failed',
      // The `flow` producer's matched pair (issue #815): the two halves differ in one field,
      // variant.flags.pp1Roles, which is the point of shipping them as a pair.
      'flow.campaign-round.pp1roles-off',
      'flow.campaign-round.pp1roles-on',
      // ...and the same pair on the first board holding every kind the arm touches.
      'flow.campaign-roster.pp1roles-off',
      'flow.campaign-roster.pp1roles-on',
      // Issue #841: the two pre-UI routes and the live practice round, appended in the
      // order recipes.json carries them.
      'screen.launch',
      'screen.boot-loading',
      'screen.practice',
    ]);
    for (const entry of CAPTURE_RECIPES) expect(validateRecipe(entry.recipe)).toBe(entry.recipe);
  });

  it('ships more than one recipe of each media kind, on distinct scenarios', () => {
    // Not catalogue trivia. With one still and one clip, "the still path works" and "this
    // one recipe works" are the same statement, and a pipeline coupled to `fire` or to
    // `ai-tracking` -- a hardcoded scenario ID, a tick that only that moment reaches --
    // would look exactly like a pipeline that works. Distinct SCENARIOS are what make the
    // second recipe evidence rather than a copy: two stills of the same moment would
    // satisfy a bare count and prove nothing.
    const kinds = new Map<string, Set<string>>();
    for (const entry of CAPTURE_RECIPES) {
      const kind = entry.recipe.schedule.kind === 'still' ? 'still' : 'temporal';
      if (!kinds.has(kind)) kinds.set(kind, new Set());
      kinds.get(kind)!.add(entry.recipe.producer.scenarioId);
    }
    expect([...kinds.keys()].sort()).toEqual(['still', 'temporal']);
    for (const [kind, scenarios] of kinds) {
      // AT LEAST two, which is the invariant this test's own title states. An exact `2`
      // was a snapshot of the catalogue on the day it was written, and it turns every
      // later recipe into an unrelated red -- issue #372's ai-last-seen clip hit it as
      // the third temporal scenario. Still compared as a string so a failure names the
      // kind and what was wrong with it rather than printing a bare `1`.
      const enough = scenarios.size >= 2 ? 'multiple' : `only ${scenarios.size}`;
      expect(`${kind}: ${enough} scenario(s)`).toBe(`${kind}: multiple scenario(s)`);
    }
  });

  it('documents every registry entry in README.md, and documents no entry it does not ship', () => {
    // The registry table in README.md is hand-maintained and had no guard: adding
    // `gallery.ai-last-seen.normal` found it silently out of date the moment the fifth
    // recipe landed. Both directions, because a row for a deleted recipe misleads exactly
    // as much as a missing row for a live one. Negative control: dropping the new row from
    // the table reds this with the ID named -- verified live and reverted.
    const documentation = readFileSync(new URL('./README.md', import.meta.url), 'utf8');
    const rows = [...documentation.matchAll(/^\| `([a-z0-9.-]+)` \| /gm)].map((m) => m[1]);
    expect(rows.sort()).toEqual(CAPTURE_RECIPES.map((entry: any) => entry.recipe.id).sort());
  });

  it('rejects duplicate IDs instead of making lookup order decide which recipe runs', () => {
    const a = recipe();
    const b = recipe(1);
    b.id = a.id;
    expect(() => createRegistry([a, b])).toThrow(/duplicate capture recipe ID/);
  });

  it('hashes canonical content independently of object-key insertion order', () => {
    const original = recipe(1);
    const reordered = reverseKeys(original);
    expect(JSON.stringify(original)).not.toBe(JSON.stringify(reordered)); // the control really reordered it
    expect(canonicalStringify(original)).toBe(canonicalStringify(reordered));
    expect(recipeHash(original)).toBe(recipeHash(reordered));
  });

  it('rejects unknown producer kinds and clearly refuses recognized unimplemented kinds', () => {
    const unknown = recipe();
    unknown.producer.kind = 'shell';
    expect(() => validateRecipe(unknown)).toThrow(/must be one of moment, screen, flow, replay/);

    // `replay` only. `screen` was in this list until issue #561 implemented it, and `flow`
    // until issue #815 did; it is the case this loop exists to describe: a kind starts as a
    // name the schema accepts and the registry refuses, and graduates to one both accept.
    // Leaving one here would assert that a producer with a real adapter is unimplemented.
    for (const kind of ['replay']) {
      const future = recipe();
      future.producer.kind = kind;
      future.variant = {};
      expect(() => validateRecipe(future)).not.toThrow(); // contract shape is extensible
      expect(() => producerForKind(kind)).toThrow(new RegExp(`'${kind}'.*not implemented`));
    }

    // ...and the graduated kind, which now validates its scenario the way `moment` does.
    const screen = recipe();
    screen.producer.kind = 'screen';
    screen.producer.scenarioId = 'screen.main-menu';
    screen.variant = {};
    expect(() => validateRecipe(screen)).not.toThrow();
    expect(() => producerForKind('screen')).not.toThrow();

    const madeUp = recipe();
    madeUp.producer.kind = 'screen';
    madeUp.producer.scenarioId = 'screen.not-a-state';
    madeUp.variant = {};
    expect(() => validateRecipe(madeUp)).toThrow(/is not a known screen state/);

    // ...and the flow producer (issue #815), which validates its flow the same way and its
    // structured inputs through the flow module's own allowlist.
    expect(() => validateRecipe(flowRecipe())).not.toThrow();
    expect(() => producerForKind('flow')).not.toThrow();
    const noSuchFlow = flowRecipe();
    noSuchFlow.producer.scenarioId = 'campaign-menu';
    expect(() => validateRecipe(noSuchFlow)).toThrow(/is not a known flow/);
    const offList = flowRecipe();
    offList.variant.flags = { aimRay: true };
    expect(() => validateRecipe(offList)).toThrow(/variant\.flags\.aimRay.*not a flow flag/);
  });

  it('rejects invalid producer options instead of forwarding arbitrary gallery arguments', () => {
    const command = recipe();
    command.variant.command = 'node';
    expect(() => validateRecipe(command)).toThrow(/variant\.command.*not an allowed field/);

    // A screen recipe still carries an EMPTY variant: which screen it is lives in
    // `producer.scenarioId`, and the state's own definition owns the seeding and the
    // steps. A route smuggled in here is refused like any other unknown field.
    const future = recipe();
    future.producer.kind = 'screen';
    future.producer.scenarioId = 'screen.main-menu';
    future.variant = { route: '/title' };
    expect(() => validateRecipe(future)).toThrow(/variant\.route.*not an allowed field/);

    const view = recipe();
    view.variant.view = 'whatever-the-cli-accepts';
    expect(() => validateRecipe(view)).toThrow(/variant\.view/);
  });

  it('rejects command-like machine values and unsafe artifact paths', () => {
    const scenario = recipe();
    scenario.producer.scenarioId = 'ai-tracking;rm-rf';
    expect(() => validateRecipe(scenario)).toThrow(/producer\.scenarioId.*stable ID/);

    const fixture = recipe();
    fixture.fixture.id = '$(touch-owned)';
    expect(() => validateRecipe(fixture)).toThrow(/fixture\.id.*stable ID/);

    for (const filename of ['../capture.png', 'nested/capture.png', '$(touch).png', 'capture.json']) {
      const artifact = recipe();
      artifact.artifacts[0].filename = filename;
      expect(() => validateRecipe(artifact), filename).toThrow(/artifacts/);
    }
  });

  it('rejects invalid still and fixed-tick schedules', () => {
    const negativeTick = recipe();
    negativeTick.schedule.tick = -1;
    expect(() => validateRecipe(negativeTick)).toThrow(/schedule\.tick/);

    const invalidAlpha = recipe();
    invalidAlpha.schedule.alpha = 1;
    expect(() => validateRecipe(invalidAlpha)).toThrow(/schedule\.alpha/);

    for (const [field, value] of [['step', 0], ['subdivisions', 0], ['tickRate', 0]] as const) {
      const temporal = recipe(1);
      temporal.schedule[field] = value;
      expect(() => validateRecipe(temporal), field).toThrow(new RegExp(`schedule\\.${field}`));
    }

    const mismatchedPlayback = recipe(1);
    mismatchedPlayback.playback.intendedFps = 30;
    expect(() => validateRecipe(mismatchedPlayback)).toThrow(/fixed schedule rate/);

    const frameScheduled = recipe(1);
    frameScheduled.producer.kind = 'screen';
    frameScheduled.producer.scenarioId = 'screen.main-menu';
    frameScheduled.variant = {};
    frameScheduled.schedule = { kind: 'frames', frameCount: 12 };
    frameScheduled.playback.intendedFps = 24;
    expect(() => validateRecipe(frameScheduled)).not.toThrow();

    frameScheduled.schedule.frameCount = 0;
    expect(() => validateRecipe(frameScheduled)).toThrow(/schedule\.frameCount/);
  });

  it('rejects non-JSON canonical values rather than hashing implementation accidents', () => {
    expect(() => canonicalStringify({ bad: undefined })).toThrow(/not a JSON value/);
    expect(() => canonicalStringify({ bad: Number.NaN })).toThrow(/non-finite/);
  });
});

describe('flow recipes (issue #815)', () => {
  it('refuses every combination the flow producer cannot honour, at validation', () => {
    const cases: Array<[string, (r: Record<string, any>) => void, RegExp]> = [
      ['a ticks schedule', (r) => { r.schedule = { kind: 'ticks', startTick: 0, endTick: 'scenario', step: 1, subdivisions: 1, tickRate: 60 }; r.playback.intendedFps = 60; }, /schedule\.kind: must be 'realtime' for a flow/],
      ['a frames schedule', (r) => { r.schedule = { kind: 'frames', frameCount: 60 }; }, /schedule\.kind: must be 'realtime' for a flow/],
      ['a playback rate other than 1', (r) => { r.playback.rate = 2; }, /playback\.rate: must be 1 for a realtime/],
      ['a fractional frame count', (r) => { r.playback.intendedFps = 7; r.schedule.durationSeconds = 2.5; }, /whole frame count/],
      ['a window longer than the ceiling', (r) => { r.schedule.durationSeconds = 61; }, /schedule\.durationSeconds/],
      ['simulation event expectations', (r) => { r.expectations.events = [{ type: 'fire', tick: 1, count: 1 }]; }, /expectations\.events: must be empty/],
      ['a renderer it does not know', (r) => { r.profile.visual = 'metal'; }, /profile\.visual: must be one of software-gl, host-gpu/],
      ['reduced motion', (r) => { r.profile.reducedMotion = true; }, /profile\.motion/],
      ['another capability', (r) => { r.profile.capability = 'phone'; }, /profile\.capability/],
      ['a timeout the window cannot fit', (r) => { r.timeoutMs = 61_000; }, /timeoutMs: must allow the 2 s window plus 60000 ms/],
      ['a seed of 0', (r) => { r.fixture.seed = 0; }, /fixture\.seed: seed must be/],
      ['a level past the campaign', (r) => { r.variant.level = 6; }, /variant\.level: level must be/],
      ['a driver it has no policy for', (r) => { r.variant.driver = 'human'; }, /variant\.driver: driver must be/],
      ['a raw query smuggled as a field', (r) => { r.variant.query = 'dev=1'; }, /variant\.query.*not an allowed field/],
      ['an unreadable delivered-rate gate', (r) => { r.variant.minimumDeliveredFps = 0; }, /variant\.minimumDeliveredFps/],
      ['a stop policy neither the schema nor the recorder knows', (r) => { r.schedule.stop = 'first-kill'; }, /schedule\.stop: must be one of window, round-end/],
    ];
    for (const [name, change, message] of cases) {
      const flow = flowRecipe();
      change(flow);
      expect(() => validateRecipe(flow), name).toThrow(message);
    }
  });

  it('keeps realtime for the flow producer alone', () => {
    const moment = recipe(1); // a temporal gallery recipe, so artifacts already fit a clip
    moment.schedule = { kind: 'realtime', durationSeconds: 2 };
    moment.playback = { rate: 1, intendedFps: 30 };
    expect(() => validateRecipe(moment)).toThrow(/'realtime' is the flow producer's schedule/);
  });

  it('lets a flow leave the GIF out, but not the MP4, and never a still', () => {
    expect(() => validateRecipe(flowRecipe())).not.toThrow();
    const withGif = flowRecipe();
    withGif.artifacts.push({ format: 'gif', filename: 'preview.gif' });
    expect(() => validateRecipe(withGif)).not.toThrow();
    const gifOnly = flowRecipe();
    gifOnly.artifacts = [{ format: 'gif', filename: 'preview.gif' }];
    expect(() => validateRecipe(gifOnly)).toThrow(/mp4 must use the canonical filename/);
    const still = flowRecipe();
    still.artifacts = [{ format: 'png', filename: 'capture.png' }];
    expect(() => validateRecipe(still)).toThrow(/artifacts/);
    // The negative control: the gallery's temporal recipes still need both.
    const moment = recipe(1);
    moment.artifacts = [{ format: 'mp4', filename: 'capture.mp4' }];
    expect(() => validateRecipe(moment)).toThrow(/must request exactly mp4 and gif/);
  });

  it('ships the matched pair differing in exactly variant.flags.pp1Roles', () => {
    const off = CAPTURE_RECIPES.find((e: any) => e.recipe.id === 'flow.campaign-round.pp1roles-off').recipe;
    const on = CAPTURE_RECIPES.find((e: any) => e.recipe.id === 'flow.campaign-round.pp1roles-on').recipe;
    const strip = (r: any) => {
      const copy = structuredClone(r);
      delete copy.id; delete copy.title; delete copy.description; delete copy.altText;
      delete copy.variant.flags;
      return copy;
    };
    expect(strip(off)).toEqual(strip(on));
    expect(off.variant.flags).toEqual({ pp1Roles: false });
    expect(on.variant.flags).toEqual({ pp1Roles: true });
  });
});
