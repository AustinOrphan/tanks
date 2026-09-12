// @vitest-environment jsdom
//
// The order in which `--scene game` reaches gameplay (issue #581).
//
// This is the test that did not exist. `run.mjs` drives a real browser and had no coverage
// at all, so an ordering bug that made `--scene game` fail on EVERY invocation shipped and
// stayed. It was found by three agents needing game captures on the same day, each of whom
// wrote their own driver rather than fixing the tool.
//
// The fake page below models exactly one property of the real one: the game canvas does not
// exist until Start is pressed, because `bootCanvas` runs from `session-host.ts` when a
// session is created. That is enough to make the bug reproducible in milliseconds.
import { describe, it, expect } from 'vitest';
import { enterGameplay, GAME_CANVAS, START_CAMPAIGN } from './enter-gameplay.mjs';
// The visual gate's source, read as TEXT rather than imported: verify.mjs is a CLI and calls
// `process.exit` at module load when it finds no dist argument. Reading it is what proves the
// gate uses this constant instead of its own copy.
import verifySource from '../visual/verify.mjs?raw';
import roundtripSource from '../visual/roundtrip.mjs?raw';
// The real page this selector runs against. `--scene game` loads vite's root, which serves
// this file; the gallery's OTHER scenes load tools/gallery/index.html and use a bare
// `canvas` locator, so they are unaffected by this rule either way.
import indexHtml from '../../index.html?raw';

type Call = string;

/**
 * A page that behaves like the real one on the one axis that matters, and records what was
 * asked of it in order.
 */
function fakePage(options: { splashUp?: boolean; startPresent?: boolean } = {}) {
  const { splashUp = true, startPresent = true } = options;
  const calls: Call[] = [];
  let started = false;
  return {
    calls,
    goto: async (url: string) => void calls.push(`goto ${url}`),
    waitForTimeout: async () => void calls.push('settle'),
    waitForSelector: async () => void calls.push('splash gone'),
    keyboard: { press: async (k: string) => { calls.push(`press ${k}`); if (k === 'Enter') started = true; } },
    locator: (selector: string) => ({
      first() { return this; },
      count: async () => {
        if (selector === START_CAMPAIGN) return startPresent ? 1 : 0;
        return splashUp ? 1 : 0;
      },
      click: async () => { calls.push('click start'); started = true; },
      waitFor: async () => {
        calls.push(`wait ${selector}`);
        // THE INVARIANT: no session, no canvas. A driver that waits here before pressing
        // Start waits forever, which is precisely what shipped.
        if (selector === GAME_CANVAS && !started) throw new Error('canvas never attached');
      },
    }),
  };
}

describe('enterGameplay: the order is the fix', () => {
  it('presses Start BEFORE waiting for the canvas that Start creates', async () => {
    const page = fakePage();
    await enterGameplay(page as never, { url: 'http://localhost:1/?dev=1', retryDelayMs: 0 });
    const clicked = page.calls.indexOf('click start');
    const waited = page.calls.indexOf(`wait ${GAME_CANVAS}`);
    expect(clicked, 'Start was never pressed').toBeGreaterThan(-1);
    expect(waited, 'the canvas was never awaited').toBeGreaterThan(-1);
    expect(clicked, 'waited for the canvas before starting the session that creates it')
      .toBeLessThan(waited);
  });

  it('dismisses the splash before looking for Start, since the menu is behind it', async () => {
    const page = fakePage();
    await enterGameplay(page as never, { url: 'http://localhost:1/', retryDelayMs: 0 });
    expect(page.calls.indexOf('press Space')).toBeLessThan(page.calls.indexOf('click start'));
  });

  it('falls back to Enter when no Start button is present, and still reaches the canvas', async () => {
    // A page shape the class selector does not match -- an older build, or a menu mid-
    // transition. The fallback has to leave the game actually started, not merely press a
    // key: the canvas wait below is what proves it did.
    const page = fakePage({ startPresent: false });
    await enterGameplay(page as never, { url: 'http://localhost:1/', retryDelayMs: 0 });
    expect(page.calls).toContain('press Enter');
    expect(page.calls).toContain(`wait ${GAME_CANVAS}`);
  });

  it('retries the WHOLE sequence once, not just the navigation', async () => {
    // The retry exists because a --sweep rebuilds vite between shots and any step can lose
    // that race. Wrapping only `goto` -- which is what the shape here replaced did -- leaves
    // a failed Start click fatal on the first attempt.
    let attempts = 0;
    const page = fakePage();
    const flaky = {
      ...page,
      goto: async (url: string) => {
        attempts++;
        page.calls.push(`goto ${url}`);
        if (attempts === 1) throw new Error('vite was rebuilding');
      },
    };
    const seen: string[] = [];
    await enterGameplay(flaky as never, { url: 'http://localhost:1/', retryDelayMs: 0, onRetry: (m) => seen.push(m) });
    expect(attempts, 'did not retry').toBe(2);
    expect(seen[0]).toContain('vite was rebuilding');
  });

  it('gives up after the second failure rather than looping', async () => {
    const page = fakePage();
    const broken = { ...page, goto: async () => { throw new Error('server is down'); } };
    await expect(
      enterGameplay(broken as never, { url: 'http://localhost:1/', retryDelayMs: 0 }),
    ).rejects.toThrow(/server is down/);
  });
});

describe('the selectors', () => {
  it('matches the campaign entry by class, never by label', () => {
    // The old selector matched `button` on /start|play/i across the whole document, so it
    // resolved to the Versus pane's hidden `.hud-versus-start` -- a pane that is not open
    // winning the search. Both halves of this selector name a class AND exclude that
    // class's own hidden modifier, so a hidden button cannot win.
    expect(START_CAMPAIGN).toContain('.hud-continue:not(.hud-continue--hidden)');
    expect(START_CAMPAIGN).toContain('.hud-new-game:not(.hud-new-game--hidden)');
    expect(START_CAMPAIGN, 'a label match can drift onto another surface').not.toMatch(/start|play/i);
    expect(START_CAMPAIGN, 'the Versus pane must not be reachable from here').not.toContain('versus');
  });

  it('picks the gameplay canvas by structure, so a new HUD canvas cannot win it', () => {
    // Was `canvas:not(.hud-preview)`. That denylist was written when the Customize preview
    // broke a bare `canvas` selector, and it broke AGAIN when issue #274 gave each versus
    // map card a board schematic: the visual gate's probe reported a 132x108 buffer with no
    // WebGL context while every screenshot check on the same run passed. A rule that has to
    // be amended for each canvas the page grows is the defect, not the list's contents.
    //
    // `bootCanvas` appends the gameplay canvas directly to `#app`; every HUD canvas is
    // nested inside the HUD element beside it. Asserted as the shape rather than as the
    // string, plus the string, so a rewrite that happens to keep the same effect passes and
    // a return to exclusion does not.
    expect(GAME_CANVAS).toBe('#app > canvas');
    expect(GAME_CANVAS, 'a denylist cannot keep up with the canvases a page grows').not.toContain(
      ':not(',
    );

    // The rule, exercised against a DOM shaped like the real page: one gameplay canvas as a
    // direct child of `#app`, and two HUD canvases nested beside it.
    const app = document.createElement('div');
    app.id = 'app';
    const hud = document.createElement('div');
    const preview = document.createElement('canvas');
    preview.className = 'hud-preview';
    const schematic = document.createElement('canvas');
    schematic.className = 'hud-versus-map-canvas';
    hud.append(preview, schematic);
    const game = document.createElement('canvas');
    // HUD FIRST, which is the order the real page has and the reason a bare `canvas`
    // selector ever went wrong: the route UI is built before a session exists.
    app.append(hud, game);
    document.body.appendChild(app);

    expect(document.querySelector(GAME_CANVAS)).toBe(game);
    expect(document.querySelectorAll(GAME_CANVAS)).toHaveLength(1);

    // ...and on a page where no match has started there is no gameplay canvas at all, which
    // is the property issue #428 needed: match NOTHING rather than report a live context for
    // some other canvas.
    game.remove();
    expect(document.querySelector(GAME_CANVAS)).toBeNull();
    document.body.innerHTML = '';
  });

  it('names an element the shipped page actually has', () => {
    // The fixture above proves the RULE; this proves the rule is about the real page. Both
    // users of this selector drive vite's root, which serves index.html, and `bootCanvas`
    // appends the gameplay canvas to `document.getElementById('app')` (main.ts -> boot.ts ->
    // session-host.ts). A selector rooted at an id the page does not have would match
    // nothing and time out in a browser rather than fail here.
    const id = /#([A-Za-z][\w-]*)\s*>/.exec(GAME_CANVAS);
    expect(id, 'the selector is no longer rooted at an id').not.toBeNull();
    expect(indexHtml).toMatch(new RegExp(`id="${(id as RegExpExecArray)[1]}"`));
    // Not `<div id="app">`: issue #640 made it a `<main>`, and an id selector does not care.
    // Pinned as the negative so a future tag change cannot quietly invalidate this case.
    expect(GAME_CANVAS, 'the selector must not depend on the root element tag').not.toMatch(
      /^[a-z]+#/,
    );
  });

  it('is the only definition: both visual tools import it rather than spelling their own', () => {
    // THREE files asked this question and all three had their own copy, which is why the
    // rule was wrong in every copy at once -- twice. Asserted against SOURCE because both
    // are CLIs that call `process.exit` at module load, so importing either here would end
    // the run.
    //
    // roundtrip.mjs is in this list because it is where the SECOND failure hid: the visual
    // gate failed first, its step gated the round trip out, and the round trip's own copy of
    // the denylist -- plus a literal `canvases <= 2` headcount -- was only reached once the
    // first was fixed. One rule, checked in one place, is what stops that sequence.
    for (const [name, source] of [
      ['verify.mjs', verifySource],
      ['roundtrip.mjs', roundtripSource],
    ] as const) {
      expect(source, `${name} does not import the shared selector`).toContain(
        "from '../gallery/enter-gameplay.mjs'",
      );
      expect(source, `${name} grew its own canvas selector again`).not.toMatch(
        /querySelector(All)?\(\s*['"`]canvas:/,
      );
      expect(source, `${name} grew its own canvas denylist again`).not.toContain('canvas:not(');
    }
    // ...and the round trip must not go back to a literal canvas headcount: the page owns a
    // variable number now (one Customize preview plus one schematic per offered map), so a
    // fixed total is a number that goes stale rather than a property.
    expect(roundtripSource, 'the round trip pinned a literal canvas total again').not.toMatch(
      /canvases\s*>\s*\d/,
    );
  });

  // NOT MUTATION-COVERED, and the gap is stated rather than left to be discovered. An entry
  // mutating either CLI is REFUSED by the harness -- `tools/mutate/run.mjs` checks that a
  // declared test can reach the file it mutates, and vitest's dependency graph relates
  // nothing to verify.mjs or roundtrip.mjs: this file reads them with `?raw`, which is not a
  // module edge, and a real import is impossible because both call `process.exit` at load
  // when they find no dist argument. The assertions above are therefore the whole of the
  // unit-level protection for a rule whose real exercise needs a browser. Making them
  // mutable would mean gating each CLI's `main()` behind an invoked-directly check, which is
  // a change to two tools' entry points and is not this issue's.
  
});
