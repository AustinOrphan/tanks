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

  it('excludes the HUD preview canvas, which exists from page load', () => {
    expect(GAME_CANVAS).toBe('canvas:not(.hud-preview)');
  });
});
