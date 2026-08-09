// A stylesheet is not typechecked and no unit test reads it, so a syntax error in it
// ships green. Two have: `.hud-shells--hidden` lost its closing brace, which silently
// swallowed the ENTIRE losing-a-life vignette (verified in a browser: .hud-damage
// computed position:static, inset:auto, opacity:1, background:none -- the feature was
// dead on main); and a merge left `.hud-phase` unclosed, which killed the round banner.
//
// Both were invisible to `npm test` and to `tsc`. This is the cheapest guard that would
// have caught either.
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import css from './hud.css?raw';
import { createHud } from './hud';
import { ACHIEVEMENTS } from './achievements';

// `?raw` returns an EMPTY STRING unless `test.css` is enabled in vite.config -- vitest
// stubs CSS imports by default. That is not a harmless miss: every assertion below would
// pass vacuously against "". The "loads as text at all" case exists to catch exactly
// that, and it did catch it before the config was fixed.

/** Strip comments first: `{` and `}` inside them are prose, not syntax. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Four properties every themed button in the HUD sets and a browser-default one does
 * not. Chosen by measurement, not taste, but state the measurement precisely: all 27
 * buttons differ from a bare `<button>` on THIRTEEN properties, and these are four of
 * those thirteen. The other nine are longhand expansions of the same two declarations
 * (`background` and `border-color`'s four sides, `border-image`, `text-indent`), so
 * asserting them would restate these rather than add reach.
 *
 * What the measurement rules OUT is the useful half: `padding` and `font-weight` are
 * NOT in the intersection -- `.hud-swatch` sets neither and `.hud-level-btn` no
 * padding -- so requiring either would fail on buttons that are correctly themed.
 */
const THEMED_PROPS = ['backgroundColor', 'color', 'borderRadius', 'cursor'] as const;

/** Every button the mounted HUD can show, with each subtree-rebuilding setter driven. */
function mountEveryButton(): { root: HTMLElement; dispose: () => void } {
  // No <style> injection here on purpose. `hud.ts` does `import './hud.css'`, and
  // vitest applies it at module scope, so the real stylesheet is already live. An
  // earlier draft injected the text itself, which LOOKED harmless and was not:
  // deleting that import from hud.ts -- which ships a completely unstyled HUD to
  // every player -- left all of these tests green, because the injection supplied
  // what production had stopped supplying. Relying on the import puts it under the
  // guard. (`css` is still imported above; the text-level tests read it.)
  const root = document.createElement('div');
  document.body.appendChild(root);
  const hud = createHud(root);
  // The three `createElement('button')` sites in hud.ts today are the swatch row and
  // the skin row (both built during `createHud`) and the level row (built here). The
  // other setters rebuild subtrees that hold no buttons today; they are driven anyway
  // so a button added to one of them lands under this sweep instead of beside it.
  //
  // KNOWN BLIND SPOT, found by review rather than assumed away: this sweeps the DOM
  // these calls produce, not every path that can produce a button. A button created by
  // a setter not called here is invisible to the guard, and the pinned count below
  // will not notice either, because it never appears. If you add a button-building
  // path, drive it here.
  hud.setLevelSelect(2, 4);
  hud.setAchievements(new Set());
  hud.showAchievementToasts(ACHIEVEMENTS.slice(0, 1));
  return {
    root,
    dispose: () => {
      hud.dispose();
      document.body.innerHTML = '';
    },
  };
}

describe('hud.css is syntactically whole', () => {
  it('loads as text at all', () => {
    // The guard is worth nothing if the import yields an empty string -- every
    // assertion below would pass vacuously on "".
    expect(typeof css).toBe('string');
    expect(css.length).toBeGreaterThan(500);
    expect(css).toContain('.hud-topbar');
  });

  it('has balanced braces', () => {
    const src = stripComments(css);
    const opens = (src.match(/\{/g) ?? []).length;
    const closes = (src.match(/\}/g) ?? []).length;
    expect({ opens, closes }).toEqual({ opens: closes, closes });
  });

  it('never opens a block inside a plain rule, which is how both breaks presented', () => {
    // An unclosed rule does not LOOK unclosed -- it looks like the next selector got
    // swallowed into it, which is why reading the file did not reveal either break.
    //
    // Nesting is legal for at-rules (@media wrapping @keyframes wrapping its steps), so
    // a flat depth limit rejects valid CSS. The real invariant: a PLAIN selector's block
    // contains declarations only. If a `{` appears while inside one, the rule above it
    // never closed.
    const src = stripComments(css);
    let depth = 0;
    let prelude = '';
    let plainRuleDepth: number | null = null;
    const offenders: string[] = [];
    for (const ch of src) {
      if (ch === '{') {
        const isAtRule = prelude.trim().startsWith('@');
        if (plainRuleDepth !== null && depth > plainRuleDepth - 1) {
          offenders.push(prelude.trim().slice(0, 40));
        } else if (!isAtRule) {
          plainRuleDepth = depth + 1;
        }
        depth++;
        prelude = '';
      } else if (ch === '}') {
        depth--;
        if (plainRuleDepth !== null && depth < plainRuleDepth) plainRuleDepth = null;
        prelude = '';
      } else {
        prelude += ch;
      }
    }
    expect(offenders).toEqual([]);
    expect(depth).toBe(0); // and the file ends closed
  });

  it('still carries the rules the features depend on', () => {
    // Presence, not styling -- a rule silently deleted in a merge is the other half of
    // the failure mode above. Population: the selectors whose absence disables a
    // shipped feature or a dev overlay.
    for (const sel of [
      '.hud-damage', '.hud-damage--hit', '.hud-lives--hit', // losing a life
      '.hud-shells', '.hud-shells--hidden', // dev shell count
      '.hud-phase', '.hud-banner', '.hud-banner-word', '.hud-banner-count', // round phase
      '.hud-level--hidden', // level progression: without it the empty chip always shows
      // title screen: without the hidden rule it covers the game from load and never
      // leaves; the hint's pulse is the only cue that a press is what is wanted
      '.hud-splash', '.hud-splash--hidden', '.hud-splash-title', '.hud-splash-hint',
      '.hud-topbar--hidden', // the title screen's only overlapping chrome
      // touch controls: without the hidden rule the row shows on the menu and the pause
      // panel too, and without the media query a mouse player gets buttons for keys
      '.hud-touch', '.hud-touch--hidden', '.hud-pause-btn', '.hud-mine-btn', '.hud-fire-btn',
      // the thumbs drawn back on screen: without the hidden rules a mouse player sees
      // marks for thumbs they do not have, and the marks never clear
      '.hud-touchviz', '.hud-touchviz--hidden', '.hud-stick-base', '.hud-stick-knob',
      '.hud-stick--hidden', '.hud-aimdot', '.hud-aimdot--hidden', '.hud-aimdot--fired',
      // the aim thumb's own stick under 'stick' scheme -- without the hidden rule it
      // shows fixed at the origin before any touch has landed there
      '.hud-aimstick', '.hud-aimstick--hidden',
      // pause + menu: without the hidden rules, Quit/settings/levels show on EVERY panel
      '.hud-quit', '.hud-quit--hidden', '.hud-panel-settings', '.hud-panel-settings--hidden',
      '.hud-panel-mute', '.hud-panel-volume', '.hud-scheme-toggle', // the settings row's controls
      '.hud-levels', '.hud-levels--hidden', '.hud-level-btn', '.hud-level-btn--locked', // level select
      // stats: without the hidden rules the page covers everything from load
      '.hud-stats', '.hud-stats--hidden', '.hud-stats-open', '.hud-stats-open--hidden',
      '.hud-danger', '.hud-danger--armed', '.hud-run-summary', '.hud-run-summary--hidden',
      // paint shop: hidden rules + the selection ring, the pane's only current-colour signal
      '.hud-customize', '.hud-customize--hidden', '.hud-customize-open--hidden',
      '.hud-swatch', '.hud-swatch--selected',
      // skins: the border is the pane's only current-skin signal
      '.hud-skin', '.hud-skin--selected',
      // achievements: hidden rules, the earned/locked contrast, and the toast rail
      '.hud-achievements', '.hud-achievements--hidden', '.hud-achievements-open--hidden',
      '.hud-achievement', '.hud-achievement--earned', '.hud-toasts', '.hud-toast',
    ]) {
      expect(css, `${sel} missing from hud.css`).toContain(sel);
    }
  });

  it('never lets a button fall through to browser default styling', () => {
    // `.hud-achievements-open` shipped with NO rule of its own -- only its `--hidden`
    // modifier -- so on the main menu it rendered as a stock grey browser button
    // beside three themed siblings, for as long as the feature existed.
    //
    // The presence test above could not have caught it, and listing the selector there
    // would not either: it uses `toContain`, and `.hud-achievements-open` is a
    // SUBSTRING of `.hud-achievements-open--hidden`, so the assertion passes on the
    // broken file.
    //
    // This measures the RESOLVED style against a bare <button> rather than looking for
    // a matching rule, because the defect is "looks unstyled", not "has no rule". An
    // earlier draft of this guard did parse hud.css, and adversarial review found
    // eleven ways past it -- a rule that is empty, a rule that only sets `margin-top`,
    // a rule that exists only as `:hover`/`:disabled`/`::after`, a rule scoped inside
    // an `@media` that never matches. All of those resolve to a default-looking button
    // and all of them now fail here, because jsdom applies the cascade and the
    // question asked is what the user would see.
    const { root, dispose } = mountEveryButton();
    const bare = document.createElement('button'); // same document: same UA defaults
    document.body.appendChild(bare);
    const ref = getComputedStyle(bare);

    const buttons = Array.from(root.querySelectorAll('button'));
    const unstyled = buttons
      .map((b) => {
        const cs = getComputedStyle(b);
        const bareProps = THEMED_PROPS.filter((p) => cs[p] === ref[p]);
        return { button: Array.from(b.classList).join('.'), bareProps };
      })
      .filter((r) => r.bareProps.length > 0)
      .map((r) => `${r.button} [default: ${r.bareProps.join(', ')}]`);

    // Exactly, not a lower bound: this is the sweep's denominator, and a lower bound
    // hid a real gap -- losing all 15 dynamically-built buttons still left 12 > 10.
    // If a UI change moves this number, that is the moment to check the new buttons
    // are covered, which is the whole point of pinning it.
    // 31 since the touch aim schemes landed: 29 (27 + the Pause and Mine buttons) + the
    // Fire button and the aim-scheme toggle. The count moving is the prompt to check the
    // new buttons are themed, which is why it is pinned exactly -- and it did exactly
    // that here.
    expect(buttons.length).toBe(31);
    expect(unstyled).toEqual([]);

    dispose();
  });

  it('keeps the two spacing distinctions the shared button theme flattens', () => {
    // Factoring seven near-identical rules into one group traded repetition for
    // cascade order: Quit's gap now depends on `.hud-quit { margin-top: 10px }` still
    // sitting AFTER the group that sets 2px, and on the Back buttons still being
    // outside the group that sets the panel size. Both are invisible to the guard
    // above -- it asks whether a button is themed, not whether it is themed right --
    // and a tidy-up that reorders the three blocks would silently regress either.
    // Same as above: hud.css arrives through hud.ts's own import, not an injection here.
    const styleOf = (cls: string): CSSStyleDeclaration => {
      const b = document.createElement('button');
      b.className = cls;
      document.body.appendChild(b);
      return getComputedStyle(b);
    };
    const panel = ['hud-stats-open', 'hud-achievements-open', 'hud-customize-open'];
    const back = ['hud-stats-back', 'hud-customize-back', 'hud-achievements-back'];

    // Quitting is pushed further off the action button than its neighbours are off
    // each other. Asserted as the relationship, so retuning either value is free.
    const quitGap = parseFloat(styleOf('hud-quit').marginTop);
    for (const cls of panel) {
      expect(parseFloat(styleOf(cls).marginTop), cls).toBeLessThan(quitGap);
    }
    // The panel buttons take a fixed size; the Back buttons inherit theirs.
    const inherited = getComputedStyle(document.createElement('button')).fontSize;
    for (const cls of panel) expect(styleOf(cls).fontSize, cls).not.toBe(inherited);
    for (const cls of back) expect(styleOf(cls).fontSize, cls).toBe(inherited);
    for (const cls of back) expect(parseFloat(styleOf(cls).marginTop), cls).toBe(0);

    document.body.innerHTML = '';
  });

  it('keeps the narrow-viewport rules the phone layout needs', () => {
    // Measured on a 393px-wide phone before this existed: the volume slider ran 35px
    // PAST the viewport edge and the topbar wrapped to 72px tall, eating the top of the
    // board. After, across four shapes: 320x568 36px/-10, 393x727 40px/-12,
    // 727x393 (landscape) 40px/-12, 820x1180 51px/-20 -- nothing clipped anywhere.
    //
    // A TEXT assertion, and weak on purpose -- jsdom does no layout, so nothing here can
    // measure a width. It catches the block being deleted or the selectors being
    // renamed out from under it, which is the regression that actually happens. The real
    // check is the pixel gate, which already renders a 390x844 viewport.
    const src = stripComments(css);
    expect(src, 'the narrow-viewport block is gone').toMatch(/@media\s*\(max-width:\s*760px\)/);
    // 760, not 520: a phone in LANDSCAPE is 727 wide and 393 TALL, and at 520 it got
    // none of these rules -- a 51px topbar across the shape that can least afford it.
    expect(src, 'the very-narrow block is gone').toMatch(/@media\s*\(max-width:\s*360px\)/);
    const block = src.split(/@media\s*\(max-width:\s*760px\)/)[1] ?? '';
    for (const sel of ['.hud-topbar', '.hud-stat', '.hud-mute', '.hud-volume']) {
      expect(block.slice(0, 600), `${sel} dropped out of the narrow layout`).toContain(sel);
    }
  });

  it('keeps the panels out of the browser pinch handler', () => {
    // The fix for a measured zoom TRAP, and it was pinned by nothing while the two
    // neighbouring queries both were. A two-finger gesture on the pause panel zoomed the
    // page to 5x, and because the canvas is `touch-action: none` you could not pinch back
    // out over the board -- so the zoom survived Resume and the game stayed magnified.
    //
    // pan-y, not none: these panes scroll (the achievements list is 744px of content in a
    // 430px box) and that must keep working. Verified in a browser: scale stays 1 at 8 of
    // 8 sites, and the list still scrolls.
    const src = stripComments(css);
    const rule = src.slice(0, src.indexOf('touch-action: pan-y'));
    for (const sel of ['.hud-panel', '.hud-stats', '.hud-customize', '.hud-achievements']) {
      expect(rule, `${sel} can still be pinched into a zoom trap`).toContain(sel);
    }
    expect(src, 'the pan-y rule is gone').toContain('touch-action: pan-y');
  });

  it('keeps the query that hides the touch controls from a mouse', () => {
    // Load-bearing, not defensive: setState('playing') REMOVES `.hud-touch--hidden`, so
    // this query is the ONLY thing keeping the Pause and Mine buttons off a desktop
    // screen. Measured -- deleting it left every mouse player two unexplained buttons
    // and nothing failed.
    const src = stripComments(css);
    expect(src, 'the pointer:fine query is gone').toMatch(/@media\s*\(pointer:\s*fine\)/);
    const block = src.split(/@media\s*\(pointer:\s*fine\)/)[1]?.slice(0, 200) ?? '';
    expect(block, 'the query no longer hides .hud-touch').toContain('.hud-touch');
    expect(block).toContain('display: none');
  });

  it('keeps the stacking order the overlays depend on', () => {
    // Three positioned layers with no z-index would be ordered by tree position
    // alone. Two real defects came from that: the stats page painted over the
    // topbar and ate its clicks, and unlock toasts painted UNDER the win panel
    // that is always up when a clear-gated achievement fires.
    const block = (sel: string): string =>
      stripComments(css).split(sel)[1]?.split('}')[0] ?? '';
    expect(block('.hud-topbar')).toContain('z-index: 1');
    expect(block('.hud-toasts')).toContain('z-index: 2'); // above topbar and panel
    for (const overlay of ['.hud-stats ', '.hud-customize ', '.hud-achievements ']) {
      expect(block(overlay), overlay).toContain('z-index: 0'); // under the topbar
    }
  });
});
