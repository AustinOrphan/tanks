// The screen-state catalogue and the `screen` capture producer (issue #561).
//
// The catalogue is data that a browser harness executes, so a malformed entry does not
// fail here -- it fails ten minutes later as a Playwright timeout with no useful name on
// it. These are the guards that turn that into a named failure at unit speed.
import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SCREEN_STATES,
  SCREEN_STATE_IDS,
  STEP_KINDS,
  WEBGL_MODES,
  GAMEPAD_FIXTURES,
  findScreenState,
} from './states.mjs';
import { buildScreenArguments, runScreenState } from '../capture/screen-adapter.mjs';
import { CAPTURE_RECIPES } from '../capture/registry.mjs';
import { DEVELOPER_KEY_PREFIX } from '../../src/game/storage';

const STABLE_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

describe('the screen-state catalogue', () => {
  it('gives every state a unique, stable, screen-prefixed ID', () => {
    // Stable-ID shaped because `tools/capture/schema.mjs` validates `producer.scenarioId`
    // against this list with the same rule it applies to gallery moments; a state whose ID
    // the schema would reject could never be captured through the framework at all.
    for (const state of SCREEN_STATES) {
      expect(STABLE_ID.test(state.id), `${state.id} is not a stable ID`).toBe(true);
      expect(state.id.startsWith('screen.'), `${state.id} is not screen-prefixed`).toBe(true);
    }
    expect(new Set(SCREEN_STATE_IDS).size, 'two states share an ID').toBe(SCREEN_STATES.length);
  });

  it('describes every state, because the description is what a reviewer reads beside the picture', () => {
    for (const state of SCREEN_STATES) {
      expect(state.title.length, `${state.id} has no title`).toBeGreaterThan(0);
      expect(state.description.length, `${state.id} has no description`).toBeGreaterThan(20);
    }
  });

  it('uses only known step kinds, one per step', () => {
    // A step with two keys, or a misspelled one, is the failure mode this shape exists to
    // make impossible: the runner refuses it, and this catches it before a browser starts.
    for (const state of SCREEN_STATES) {
      for (const step of state.steps) {
        const keys = Object.keys(step);
        expect(keys, `${state.id}: ${JSON.stringify(step)}`).toHaveLength(1);
        expect(STEP_KINDS, `${state.id}: unknown step '${keys[0]}'`).toContain(keys[0]);
      }
    }
  });

  it('names a known gamepad fixture on every step that installs one', () => {
    // `GAMEPAD_FIXTURES` is the contract between this pure-data module and the runner that
    // holds the pad VALUES (`tools/screens/run.mjs`, which throws on an unknown fixture).
    // Without this the two could only disagree at capture time, in a browser, on a machine
    // that may not be the one that edited the state -- and an export nothing checks is an
    // export nothing keeps true.
    const named = SCREEN_STATES.flatMap((state: any) =>
      state.steps.filter((s: any) => 'fakeGamepads' in s).map((s: any) => s.fakeGamepads),
    );
    expect(named.length, 'no state installs a fixture: this guard would measure nothing').toBeGreaterThan(0);
    for (const fixture of named) expect(GAMEPAD_FIXTURES).toContain(fixture);
    // The control: the list must be capable of saying no.
    expect(GAMEPAD_FIXTURES).not.toContain('no-such-fixture');
  });

  it('uses only known capability and scripting modes', () => {
    for (const state of SCREEN_STATES) {
      expect(WEBGL_MODES, `${state.id}`).toContain(state.webgl);
      expect(['on', 'off'], `${state.id}`).toContain(state.javascript);
      for (const step of state.steps) {
        if ('breakWebgl' in step) expect(WEBGL_MODES, `${state.id}`).toContain(step.breakWebgl);
      }
    }
  });

  it('measures something on every state, and never an empty selector', () => {
    // A capture with nothing measured is a picture with no caption: it proves the page did
    // not crash and nothing else. The measurement half is the part that has actually
    // caught things, so a state that skips it is a state that is not really covered.
    for (const state of SCREEN_STATES) {
      expect(state.measure.length, `${state.id} measures nothing`).toBeGreaterThan(0);
      for (const selector of state.measure) {
        expect(typeof selector === 'string' && selector.trim().length > 0).toBe(true);
      }
    }
  });

  it('reaches a rendered UI past the Launch splash, or is a state that has no UI to reach', () => {
    // The splash covers everything until a key dismisses it, so a state that expects HUD
    // markup and never presses one photographs the splash instead -- a mistake that costs
    // a full capture run to notice. The exemptions are exact: the boot failure screens
    // REPLACE the page before a splash exists, and the no-script card never boots at all.
    const noSplashNeeded = new Set([
      'screen.startup.unsupported-render',
      'screen.startup.probe-blocked',
      'screen.no-script',
    ]);
    for (const state of SCREEN_STATES) {
      const dismisses = state.steps.some((s) => s.press === 'Space');
      expect(dismisses, `${state.id} never leaves the Launch splash`).toBe(!noSplashNeeded.has(state.id));
    }
  });

  it('findScreenState answers for every ID and refuses anything else', () => {
    for (const id of SCREEN_STATE_IDS) expect(findScreenState(id)?.id).toBe(id);
    expect(findScreenState('screen.not-a-state')).toBeNull();
  });

  it('seeds the DEVELOPER key namespace on every state whose URL carries the dev gate', () => {
    /*
     * Issue #245 selects the namespace from `location.search` at boot, so a `?dev=1` page
     * persists behind `tanks.dev.` and cannot see a production save at all. A state that
     * carried the gate and seeded unprefixed keys would boot a FIRST-TIME player -- no
     * Continue, no Levels grid -- and its recipe's own clicks would then time out.
     *
     * MEASURED: that is exactly what the five ending states did on their first run, and it
     * is the kind of thing that looks like a broken recipe rather than a namespace rule.
     *
     * Both directions, so a state cannot seed the wrong half either way.
     */
    for (const state of SCREEN_STATES) {
      const keys = Object.keys(state.storage);
      if (keys.length === 0) continue;
      const gated = state.query.includes('dev=1');
      for (const key of keys) {
        expect(
          key.startsWith(DEVELOPER_KEY_PREFIX),
          `${state.id} seeds '${key}' but ${gated ? 'IS' : 'is NOT'} behind the dev gate`,
        ).toBe(gated);
      }
    }
  });

  it('pins the developer prefix this module spells by hand', () => {
    // states.mjs imports nothing by design, so `MID_CAMPAIGN_DEV` writes 'tanks.dev.' as a
    // literal. This is what stops that literal rotting if storage.ts ever renames it.
    const dev = SCREEN_STATES.find((s) => s.id === 'screen.ending.mission-clear');
    expect(Object.keys(dev!.storage).every((k) => k.startsWith(DEVELOPER_KEY_PREFIX))).toBe(true);
    expect(DEVELOPER_KEY_PREFIX).toBe('tanks.dev.');
  });

  it('ships a capture recipe for every state, and no recipe for a state that is gone', () => {
    // Both directions, the same rule the capture README's table is held to. A state with
    // no recipe cannot be captured through the framework, and a recipe naming a deleted
    // state fails registry construction at import time -- which takes every capture with
    // it, not just that one.
    const recipeStates = CAPTURE_RECIPES
      .filter((entry: any) => entry.recipe.producer.kind === 'screen')
      .map((entry: any) => entry.recipe.producer.scenarioId);
    expect(recipeStates.slice().sort()).toEqual([...SCREEN_STATE_IDS].sort());
  });
});

describe('the screen capture adapter', () => {
  const recipeFor = (id: string): any =>
    structuredClone(
      (CAPTURE_RECIPES.find((e: any) => e.recipe.producer.scenarioId === id) as any).recipe,
    );

  it('builds the runner arguments from the recipe, naming the state and the viewport', () => {
    const args = buildScreenArguments(recipeFor('screen.records.stats'), 'tmp/producer-dir');
    expect(args).toContain('--state');
    expect(args[args.indexOf('--state') + 1]).toBe('screen.records.stats');
    expect(args[args.indexOf('--w') + 1]).toBe('1280');
    expect(args[args.indexOf('--dpr') + 1]).toBe('2');
    // Both artifacts are named INSIDE the producer directory the framework hands over --
    // `outputRelative` is a directory, and the runner's cwd is the repository root, so a
    // bare filename would land at the root instead.
    expect(args[args.indexOf('--out') + 1]).toBe('tmp/producer-dir/frame.png');
    expect(args[args.indexOf('--report') + 1]).toBe('tmp/producer-dir/producer.json');
  });

  it('refuses an output path that could escape the capture workspace', () => {
    // The string reaches a child process's argv. Same containment rule the gallery adapter
    // applies, asserted here because a second producer is a second way to lose it.
    const recipe = recipeFor('screen.main-menu');
    for (const bad of ['../frame.png', 'tmp/../../frame.png', '/etc/frame.png', 'out/frame.png']) {
      expect(() => buildScreenArguments(recipe, bad), bad).toThrow(/isolated relative tmp\//);
    }
  });

  /**
   * Drive the real adapter with the child process stubbed -- the same `deps.runProcess`
   * seam `runGalleryMoment` offers -- so the report-reading and assertion half runs for
   * real without launching a browser.
   */
  const runWithReport = async (producer: Record<string, unknown>): Promise<any> => {
    const dir = await mkdtemp(join(tmpdir(), 'screen-adapter-'));
    try {
      await writeFile(
        join(dir, 'producer.json'),
        JSON.stringify({
          capture: { viewport: { width: 1280, height: 800, devicePixelRatio: 2 } },
          producer: { stateId: 'screen.main-menu', title: 'x', webgl: 'ok', javascript: 'on', ...producer },
        }),
      );
      await writeFile(join(dir, 'frame.png'), 'not really a png');
      return await runScreenState(
        {
          recipe: recipeFor('screen.main-menu'),
          root: process.cwd(),
          outputRelative: 'tmp/producer-dir',
          outputDirectory: dir,
          env: {},
          prerequisites: { playwright: { moduleSpecifier: 'playwright' } },
          signal: undefined,
        },
        { runProcess: async () => undefined },
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  it('reports an uncaught page error as a FAILED capture, not a saved picture of a broken screen', async () => {
    // Every state here is a screen a player can sit on. The branded failure screens REPORT
    // a failure; they do not suffer one. So an exception on the page means the capture
    // photographed something still falling over, and publishing that as a passing artifact
    // is the quiet-success failure mode the assertion channel exists to prevent.
    const clean = await runWithReport({ measurements: [{ selector: '.hud-panel', present: true }], pageErrors: [] });
    expect(clean.assertions.find((a: any) => a.kind === 'page-errors').passed).toBe(true);

    const broken = await runWithReport({
      measurements: [{ selector: '.hud-panel', present: true }],
      pageErrors: ['TypeError: undefined is not a function'],
    });
    const failed = broken.assertions.find((a: any) => a.kind === 'page-errors');
    expect(failed.passed, 'a page error was reported as a healthy capture').toBe(false);
    expect(failed.diagnostic).toContain('TypeError');
  });

  it('fails a capture whose measured selector matched nothing, but not one that is merely hidden', async () => {
    // The distinction is the whole point. Several states exist to show a control is
    // ABSENT -- a fresh save hides Continue, the no-script style hides the holding card --
    // so `visible: false` is a result, not a fault. `present: false` means the selector
    // matches nothing at all, which makes the state's report an empty caption on a
    // picture that still looks plausible.
    const hidden = await runWithReport({
      measurements: [{ selector: '.hud-continue', present: true, visible: false }],
      pageErrors: [],
    });
    expect(
      hidden.assertions.find((a: any) => a.kind === 'measured-elements-present').passed,
      'a deliberately hidden control was treated as a broken capture',
    ).toBe(true);

    const renamed = await runWithReport({
      measurements: [
        { selector: '.hud-panel', present: true },
        { selector: '.hud-renamed-away', present: false },
      ],
      pageErrors: [],
    });
    const missing = renamed.assertions.find((a: any) => a.kind === 'measured-elements-present');
    expect(missing.passed, 'a selector matching nothing passed').toBe(false);
    expect(missing.diagnostic).toContain('.hud-renamed-away');
  });

  it('refuses a report describing a different state than the recipe asked for', async () => {
    // The runner and the recipe agreeing is not something the framework checks: a mixed-up
    // report would publish one screen's picture under another screen's name and hash.
    await expect(runWithReport({ stateId: 'screen.about' })).rejects.toThrow(/reported state/);
  });

  it('refuses a recipe this producer cannot honour, rather than capturing something else', () => {
    const moment = recipeFor('screen.main-menu');
    moment.producer = { kind: 'moment', scenarioId: 'fire' };
    expect(() => buildScreenArguments(moment, 'tmp/f.png')).toThrow(/cannot capture producer/);

    const moving = recipeFor('screen.main-menu');
    moving.schedule = { kind: 'frames', frameCount: 4 };
    expect(() => buildScreenArguments(moving, 'tmp/f.png')).toThrow(/stills/);

    // Reduced motion is REQUIRED, not defaulted: a crossfade caught mid-flight is the
    // difference between a capture that reproduces and one that does not, and a recipe
    // that quietly asked for full motion would produce exactly that flake.
    const motion = recipeFor('screen.main-menu');
    motion.profile = { ...motion.profile, reducedMotion: false };
    expect(() => buildScreenArguments(motion, 'tmp/f.png')).toThrow(/reduced motion/);

    const capability = recipeFor('screen.main-menu');
    capability.profile = { ...capability.profile, capability: 'real-device' };
    expect(() => buildScreenArguments(capability, 'tmp/f.png')).toThrow(/capability profile/);
  });
});
