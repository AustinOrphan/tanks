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
  ENTRY_MODES,
  GAMEPAD_FIXTURES,
  findScreenState,
} from './states.mjs';
import { buildScreenArguments, runScreenState, pageErrorAssertion } from '../capture/screen-adapter.mjs';
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
    // holds the pad VALUES (`tools/screens/steps.mjs`, which throws on an unknown fixture).
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

  it('reaches the RECOVERABLE match-failure overlay through a transient failure, not a fatal one (issue #700)', () => {
    // Since #669, breaking the context after boot (`probe-blocked`) is a typed, FATAL failure
    // and lands on the full page, so a state that waited for `.hud-alert` behind it timed out.
    // Negative controls: restoring `probe-blocked` fails the mode assertion, and dropping the
    // Retry wait lets a capture of the pre-#685 overlay pass as this one.
    const state = findScreenState('screen.startup.match-failed')!;
    const breaks = state.steps.filter((s: any) => 'breakWebgl' in s).map((s: any) => s.breakWebgl);
    expect(breaks).toEqual(['match-build-fails']);
    const waits = state.steps.filter((s: any) => 'waitVisible' in s).map((s: any) => s.waitVisible);
    expect(waits).toContain('.hud-alert');
    expect(waits).toContain('.hud-alert-retry');
    expect(state.measure).toContain('.hud-alert-retry');
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
    // a full capture run to notice.
    //
    // TWO KINDS OF EXEMPTION, kept apart because they are different claims. The first three
    // have NO UI to reach: the boot failure screens REPLACE the page before a splash exists,
    // and the no-script card never boots at all. The last two are the opposite -- what they
    // photograph is precisely what the other states press past (issue #841), so dismissing
    // it would destroy the subject rather than reveal it.
    const noSplashNeeded = new Set([
      'screen.startup.unsupported-render',
      'screen.startup.probe-blocked',
      // Issue #781: the same kind as the two above, one step earlier. The entry bundle never
      // runs at all, so there is no application to draw a splash -- the inline guard in
      // index.html replaces the page instead.
      'screen.startup.entry-refused',
      'screen.startup.entry-unparseable',
      'screen.no-script',
      'screen.launch',
      'screen.boot-loading',
    ]);
    for (const state of SCREEN_STATES) {
      const dismisses = state.steps.some((s) => s.press === 'Space');
      expect(dismisses, `${state.id} never leaves the Launch splash`).toBe(!noSplashNeeded.has(state.id));
    }
  });

  it('keeps the two pre-UI states pre-UI, rather than merely undismissed', () => {
    // The exemption above only says these do not press Space. This says what they ARE, so a
    // state that quietly grew a click sequence could not keep the exemption: the launch
    // splash is reached on a fresh load with no save, and the holding card is reached by
    // never letting the module run at all.
    const launch = SCREEN_STATES.find((s) => s.id === 'screen.launch');
    expect(Object.keys(launch.storage), 'a seeded save is not a first load').toEqual([]);
    expect(launch.boot, 'the launch splash needs a booted page').toBe('done');
    const holding = SCREEN_STATES.find((s) => s.id === 'screen.boot-loading');
    expect(holding.boot, 'the holding card is gone the moment boot runs').toBe('holding');
    // And nothing else holds the module: `boot: 'holding'` photographs a page with no
    // application in it, which is the wrong picture for every other state in the file.
    const held = SCREEN_STATES.filter((s) => s.boot === 'holding').map((s) => s.id);
    expect(held).toEqual(['screen.boot-loading']);
    // And both declare that they have no menu, which is what keeps the visual gate's hit
    // sweep off them -- it reads "no controls measured" as a failed surface otherwise.
    expect([launch.menu, holding.menu]).toEqual(['none', 'none']);
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
     *
     * `prodSave` IS THE ONE EXCEPTION, and it is the whole point of that flag (issue #249): a
     * developer session that has deliberately asked for the production save reads the
     * unprefixed keys, so a state carrying it must seed those. Written as "gate AND NOT
     * prodSave" rather than as a state-id allow-list, because the rule is a property of the
     * query string -- the same one `selectStorageNamespace` implements -- and an allow-list
     * would need editing every time such a state is added.
     */
    for (const state of SCREEN_STATES) {
      const keys = Object.keys(state.storage);
      if (keys.length === 0) continue;
      const gated = state.query.includes('dev=1') && !state.query.includes('prodSave=1');
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

describe('the entry-failure states (issue #781)', () => {
  it('declares a known entry mode on every state, and a failing one on exactly two', () => {
    for (const state of SCREEN_STATES) {
      expect(ENTRY_MODES, `${state.id} has an unknown entry mode`).toContain((state as any).entry);
    }
    const failing = SCREEN_STATES.filter((s: any) => s.entry !== 'ok').map((s: any) => s.id);
    expect(failing).toEqual(['screen.startup.entry-refused', 'screen.startup.entry-unparseable']);
    // The control the issue asks for, at catalogue level: every OTHER state is a normal load,
    // so none of them can be photographing a failure card. Measured rather than assumed --
    // a state that quietly gained a failing entry would change what it photographs with no
    // other signal, because the flag acts on the request before the page exists.
    const cardWatchers = SCREEN_STATES
      .filter((s: any) => s.measure.some((m: string) => m.includes('boot-entry-failure-card')))
      .map((s: any) => s.id);
    expect(cardWatchers).toEqual(failing);
  });

  it('does not measure the holding card, which these two states REMOVE rather than hide', () => {
    // `screen.no-script` can measure `#boot-loading` because scripting off leaves the static
    // markup in place. Here the card's own code runs `app.innerHTML = ''` first, so the
    // element is gone -- and `measuredElementsAssertion` fails any selector matching nothing,
    // correctly. Measured on a real capture before this was written: 4/5 visible, the fifth
    // reporting `present: false`.
    for (const id of ['screen.startup.entry-refused', 'screen.startup.entry-unparseable']) {
      const state = findScreenState(id)!;
      expect(state.measure, `${id} measures the removed holding card`).not.toContain('#boot-loading');
      expect(state.measure).toContain('#boot-entry-failure-card button');
    }
  });

  it('excuses an uncaught error ONLY for the unparseable entry, and names it as expected', () => {
    const errors = ["SyntaxError: Unexpected token ';'"];

    // The subject of that state IS the uncaught error, so the capture is of a page working
    // as designed rather than one falling over.
    const excused = pageErrorAssertion(errors, 'unparseable');
    expect(excused.passed).toBe(true);
    expect(excused.diagnostic).toMatch(/expected page error/);
    expect(excused.details.errors).toEqual(errors);

    // THE CONTROL, and the reason the exemption is keyed on the mode rather than a flag: its
    // own SIBLING does not get it. A refused entry never runs any script, so an uncaught
    // error there is a real defect and must still fail.
    expect(pageErrorAssertion(errors, 'refused').passed).toBe(false);
    expect(pageErrorAssertion(errors, 'ok').passed).toBe(false);
    expect(pageErrorAssertion(errors, undefined).passed).toBe(false);

    // And the exemption is not a blanket pass: with no errors it still reports the clean case.
    expect(pageErrorAssertion([], 'unparseable').diagnostic).toBe('no uncaught page errors');
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

  it('refuses a capability that disagrees with the state it names (issue #844)', () => {
    // The touchscreen lives on the STATE, because the layout sweep reads the catalogue and
    // never sees a recipe. That makes the two able to disagree, and a disagreement is silent
    // in the worst way: a `headless-touch` recipe pointed at a desktop state captures the
    // desktop pane -- a perfectly good-looking Settings screenshot -- and files it as touch
    // evidence. `control-relevance.ts` OMITS `touchScheme` and `fireMode` without a
    // touchscreen, so the two frames differ by two missing controls and nothing else flags it.
    const desktopStateTouchRecipe = recipeFor('screen.settings');
    desktopStateTouchRecipe.profile = { ...desktopStateTouchRecipe.profile, capability: 'headless-touch' };
    expect(() => buildScreenArguments(desktopStateTouchRecipe, 'tmp/f.png')).toThrow(/disagrees with state/);

    // And the other direction, which is the likelier accident: a touch state whose recipe was
    // copied from a desktop one and never had its capability changed.
    const touchStateDesktopRecipe = recipeFor('screen.settings.touch');
    touchStateDesktopRecipe.profile = { ...touchStateDesktopRecipe.profile, capability: 'headless-desktop' };
    expect(() => buildScreenArguments(touchStateDesktopRecipe, 'tmp/f.png')).toThrow(/disagrees with state/);

    // The pairing that is correct stays accepted, so this is a refusal and not a ban.
    expect(() => buildScreenArguments(recipeFor('screen.settings.touch'), 'tmp/f.png')).not.toThrow();
    expect(() => buildScreenArguments(recipeFor('screen.settings'), 'tmp/f.png')).not.toThrow();
  });

  it('gives exactly the states that declare a touchscreen the controls that need one', () => {
    // The population, stated: of the screen catalogue, only the states below declare `touch`.
    // A state that quietly gained or lost it would change what its capture shows without any
    // other signal, because the flag reaches Playwright's context rather than the page.
    const touchStates = SCREEN_STATES.filter((s: any) => s.touch === true).map((s: any) => s.id);
    expect(touchStates).toEqual(['screen.settings.touch']);

    // And it is measured, not merely rendered: the two controls that exist only with a
    // touchscreen are in the state's `measure` list, so the capture's report carries the
    // difference rather than leaving it to whoever looks at the PNG.
    const touch = SCREEN_STATES.find((s: any) => s.id === 'screen.settings.touch') as any;
    expect(touch.measure).toContain('.hud-scheme-toggle');
    expect(touch.measure).toContain('.hud-firemode-toggle');
    const desktop = SCREEN_STATES.find((s: any) => s.id === 'screen.settings') as any;
    expect(desktop.measure).not.toContain('.hud-scheme-toggle');
  });
});