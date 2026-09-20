import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { audioContextOverrideSource } from './audio-context.mjs';

/**
 * Issue #860. Page-side source, so the same stand-in treatment as the WebGL overrides in
 * `tools/screens/steps.test.ts`: run it against a fake `window` and assert what it leaves
 * behind. Both spellings matter -- Howler reads `AudioContext` and falls back to
 * `webkitAudioContext`, so removing one and leaving the other still hands it a constructor
 * to block in.
 */
describe('audio-context.mjs: removing the AudioContext constructor before boot', () => {
  function apply(win: Record<string, unknown>) {
    new Function('window', audioContextOverrideSource())(win);
    return win;
  }

  it('removes both spellings the audio stack looks for', () => {
    const win = apply({ AudioContext: function real() {}, webkitAudioContext: function alsoReal() {} });
    expect('AudioContext' in win, 'the prefixed-free constructor survived').toBe(false);
    expect('webkitAudioContext' in win, 'the webkit constructor survived').toBe(false);
  });

  it('leaves `in` reporting absent, not merely undefined', () => {
    // `engine.ts` reaches the null path through `window.AudioContext || window.webkitAudioContext`
    // being falsy, but Howler's own probe is a `typeof AudioContext !== 'undefined'` guard on the
    // GLOBAL. Assigning undefined would satisfy the first and, in a real page, still leave a
    // declared global for the second. Deleting is what makes both agree.
    const win = apply({ AudioContext: function real() {} });
    expect(Object.keys(win)).toEqual([]);
  });

  it('is inert on a host that never had one', () => {
    expect(() => apply({})).not.toThrow();
  });

  it('leaves OfflineAudioContext alone, which is what the audio tool renders through', () => {
    // `tools/audio/render.mjs` builds an `OfflineAudioContext` and would produce silently
    // wrong output, not an obvious failure, if this override reached it.
    const win = apply({ AudioContext: function real() {}, OfflineAudioContext: function offline() {} });
    expect('OfflineAudioContext' in win, 'the offline constructor was removed too').toBe(true);
  });
});

/**
 * Issue #877. The override used to live in the screens harness and only `capture.mjs`
 * installed it, so every other browser tool still built two real `AudioContext`s at boot --
 * ~40 s on a host whose audio service never connects, which is longer than Playwright's 30 s
 * navigation default. This is the sweep that keeps the rest installed.
 *
 * DISCOVERED, not listed. The table below is checked against every `tools/**\/*.mjs` that
 * creates a browser page or context, and a file in neither column fails the first test. That
 * is the part that earns its place: the review of #877 listed nine tools by inspection and
 * missed `tools/visual/hit-sweep.mjs`, the hit-target driver that navigates separately from
 * `verify.mjs`'s own two page paths -- the same shape of miss issues #781 and #844 each hit
 * in that file. A hand-maintained list would have shipped that gap again.
 *
 * WHAT IS AND IS NOT MUTATION-MEASURED. This sweep reads each tool as TEXT, so Vitest's
 * dependency graph relates it to none of them, and `tools/mutate` refuses an entry whose
 * declared tests do not reach the file it mutates -- such an entry could only ever report
 * SURVIVES. Four of the ten therefore carry a manifest entry, in the test file that already
 * IMPORTS the module: `screens/capture.mjs`, `screens/record.mjs`, `bench/runs.mjs` and
 * `visual/hit-sweep.mjs`. The other six are CLI entry points that call `main()` at the top
 * level, so importing one from a test would run it; they are covered by this sweep and by a
 * manual control (delete the install, watch the sweep fail), not by the harness. Giving them
 * a main-guard is issue #881.
 */
const TOOLS = fileURLToPath(new URL('..', import.meta.url));

/** Every tool file that creates a browser surface, as a path relative to `tools/`. */
function browserDrivers(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.mjs') && /\.new(Page|Context)\(/.test(readFileSync(full, 'utf8'))) {
        found.push(relative(TOOLS, full).split(sep).join('/'));
      }
    }
  };
  walk(TOOLS);
  return found.sort();
}

/**
 * Tools that navigate to the app, with the EXACT line each install site must be, leading
 * spaces included.
 *
 * Pinning the whole line rather than "contains the call" is what makes the install
 * unconditional. `if (process.env.WEDGED) await page.addInitScript(...)` and an indented
 * block wrap both change the line, and a substring check accepts either -- which would let
 * one machine photograph a page with an audio stack and another photograph a page without,
 * the exact divergence these gates exist to catch. `tools/screens/capture.test.ts` pins its
 * indentation for the same reason, and records that the guard DID once ship wrapped in an
 * environment check before the indent was pinned.
 */
const GUARDED: Record<string, string[]> = {
  // FOUR spaces where every other one-site tool has two: issue #881 wrapped this file's
  // whole body in `main()`, so its own two became four. The line is pinned, not the call,
  // which is why that re-indent had to be noticed here rather than passing silently.
  'audio/render.mjs': ['    await page.addInitScript(audioContextOverrideSource());'],
  'bench/runs.mjs': ['  await context.addInitScript(audioContextOverrideSource());'],
  'gallery/run.mjs': ['  await page.addInitScript(audioContextOverrideSource());'],
  'screens/capture.mjs': ['    await page.addInitScript(audioContextOverrideSource());'],
  'screens/record.mjs': ['    await context.addInitScript(audioContextOverrideSource());'],
  'uikit/forced-colors.mjs': ['    await page.addInitScript(audioContextOverrideSource());'],
  'uikit/primitive-states.mjs': ['  await page.addInitScript(audioContextOverrideSource());'],
  'visual/hit-sweep.mjs': ['  await context.addInitScript(audioContextOverrideSource());'],
  'visual/roundtrip.mjs': ['  await page.addInitScript(audioContextOverrideSource());'],
  // TWO, and that is the point of listing sites rather than counting calls: the clearance
  // sweep builds its own context and the board sweep builds a bare page, and a guard on one
  // of them advertises coverage of both.
  'visual/verify.mjs': [
    '    await context.addInitScript(audioContextOverrideSource());',
    '        await page.addInitScript(audioContextOverrideSource());',
  ],
};

/** Tools that never navigate to the app, each carrying its reason in the source. */
const EXCLUDED = [
  'baseline/beacon-check.mjs',
  'baseline/run.mjs',
  'gl/idle-cost.mjs',
  'gl/run.mjs',
  'hud/strip-width.mjs',
];

const INSTALL = 'addInitScript(audioContextOverrideSource())';
/** Creations, installs and navigations, in source order. */
const EVENT = /(\w+)\.new(Page|Context)\(|addInitScript\(audioContextOverrideSource\(\)\)|\.goto\(/g;

function lineOf(src: string, index: number) {
  return src.slice(0, index).split('\n').length;
}

/** Every navigation whose surface had not been given the override yet. */
function unguardedNavigations(src: string): string[] {
  const unguarded: string[] = [];
  let guarded = false;
  for (const match of src.matchAll(EVENT)) {
    if (match[0].startsWith('addInitScript')) {
      guarded = true;
    } else if (match[0] === '.goto(') {
      if (!guarded) unguarded.push(`line ${lineOf(src, match.index ?? 0)}`);
    } else {
      // A page made from a context inherits that context's init scripts; anything made
      // straight from the browser is a fresh surface and starts unguarded again.
      const inherits = match[1] === 'context' && match[2] === 'Page';
      if (!inherits) guarded = false;
    }
  }
  return unguarded;
}

describe('the AudioContext override reaches every tool that boots the app', () => {
  it('classifies every tool file that creates a browser surface', () => {
    const discovered = browserDrivers();
    // Non-vacuity: if the walk stopped finding files, every other assertion here would pass
    // by having nothing to check.
    expect(discovered.length, 'the walk found no browser tools at all').toBeGreaterThan(10);
    expect(discovered).toEqual([...Object.keys(GUARDED), ...EXCLUDED].sort());
  });

  it.each(Object.entries(GUARDED))(
    '%s installs the override, unconditionally, before every navigation',
    (file, sites) => {
      const src = readFileSync(join(TOOLS, file), 'utf8');
      const lines = src.split('\n');
      for (const site of sites) {
        expect(
          lines.filter((line) => line === site).length,
          `${file}: expected exactly one line \`${site.trim()}\` at ${site.length - site.trimStart().length} spaces`,
        ).toBe(1);
      }
      // Every occurrence has to BE one of the pinned lines, so a conditional or re-indented
      // copy elsewhere in the file cannot make up the count.
      expect(src.split(INSTALL).length - 1, `${file}: an install site that is not one of the pinned lines`)
        .toBe(sites.length);
      expect(unguardedNavigations(src), `${file}: navigates before the override is installed`).toEqual([]);
    },
  );

  it.each(EXCLUDED)('%s is left alone, and says why', (file) => {
    const src = readFileSync(join(TOOLS, file), 'utf8');
    expect(src.includes(INSTALL), `${file}: installs an override it is listed as not needing`).toBe(false);
    // A bare absence is indistinguishable from an oversight, which is how
    // `tools/baseline/beacon-check.mjs` sat in #877's table as "unverified".
    expect(src, `${file}: no recorded reason for skipping the override`).toMatch(
      /NO AudioContext override here, deliberately \(issue #877\)/,
    );
  });
});
