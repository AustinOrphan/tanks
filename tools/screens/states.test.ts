// The screen-state catalogue and the `screen` capture producer (issue #561).
//
// The catalogue is data that a browser harness executes, so a malformed entry does not
// fail here -- it fails ten minutes later as a Playwright timeout with no useful name on
// it. These are the guards that turn that into a named failure at unit speed.
import { describe, it, expect } from 'vitest';
import {
  SCREEN_STATES,
  SCREEN_STATE_IDS,
  STEP_KINDS,
  WEBGL_MODES,
  findScreenState,
} from './states.mjs';
import { buildScreenArguments } from '../capture/screen-adapter.mjs';
import { CAPTURE_RECIPES } from '../capture/registry.mjs';

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
