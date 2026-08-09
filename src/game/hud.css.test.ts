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

// `?raw` returns an EMPTY STRING unless `test.css` is enabled in vite.config -- vitest
// stubs CSS imports by default. That is not a harmless miss: every assertion below would
// pass vacuously against "". The "loads as text at all" case exists to catch exactly
// that, and it did catch it before the config was fixed.

/** Strip comments first: `{` and `}` inside them are prose, not syntax. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * The selectors hud.css actually opens a rule for, split on `,` so a grouped rule
 * counts for each of its members. Parsed rather than substring-matched: `.hud-x` is a
 * substring of `.hud-x--hidden`, so `includes()` cannot tell a styled button from one
 * that only has a modifier.
 *
 * Plain rules do not nest -- the test above enforces exactly that -- so a single
 * in-a-rule flag is enough to skip declarations, and at-rule preludes (`@media`) are
 * skipped so their nested selectors are still collected.
 */
function definedSelectors(text: string): Set<string> {
  const found = new Set<string>();
  let prelude = '';
  let inRule = false;
  for (const ch of stripComments(text)) {
    if (ch === '{') {
      const p = prelude.trim();
      if (!inRule && !p.startsWith('@')) {
        for (const sel of p.split(',')) if (sel.trim()) found.add(sel.trim());
        inRule = true;
      }
      prelude = '';
    } else if (ch === '}') {
      inRule = false;
      prelude = '';
    } else {
      prelude += ch;
    }
  }
  return found;
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
      // pause + menu: without the hidden rules, Quit/settings/levels show on EVERY panel
      '.hud-quit', '.hud-quit--hidden', '.hud-panel-settings', '.hud-panel-settings--hidden',
      '.hud-panel-mute', '.hud-panel-volume', // the panel audio pair keeps its styling
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

  it('gives every button the HUD renders a base rule of its own', () => {
    // `.hud-achievements-open` shipped with NO base rule -- only its `--hidden`
    // modifier -- so it fell through to browser default button styling while its
    // three siblings were themed.
    //
    // The presence test above could not have caught it, and adding the selector to
    // that list would not either: it uses `toContain`, and `.hud-achievements-open`
    // is a SUBSTRING of `.hud-achievements-open--hidden`. The assertion would have
    // passed on the broken file. This one parses rules instead of matching text, and
    // discounts `--modifier` classes, which is the whole of the defect: having a
    // modifier rule is exactly what made the button look styled to a grep.
    //
    // Population: every <button> in the mounted HUD -- the template's, plus the
    // swatch and skin rows, which `createHud` builds during construction -- plus the
    // level-select row. Those are all 3 `createElement('button')` sites in hud.ts;
    // only the level row needs a call to appear.
    const root = document.createElement('div');
    document.body.appendChild(root);
    const hud = createHud(root);
    hud.setLevelSelect(2, 4); // the one button-creating site construction alone misses
    const buttons = Array.from(root.querySelectorAll('button'));

    const defined = definedSelectors(css);
    const hasBaseRule = (cls: string): boolean =>
      defined.has(`.${cls}`) || [...defined].some((s) => s.startsWith(`.${cls}:`));

    const unstyled = buttons
      .map((b) => Array.from(b.classList))
      // A `--modifier` rule is not a base style. `.hud-quit--hidden` sets
      // `display: none` and says nothing about how the button looks when shown.
      .filter((classes) => !classes.some((c) => !c.includes('--') && hasBaseRule(c)))
      .map((classes) => classes.join('.'));

    hud.dispose();
    document.body.innerHTML = '';

    expect(buttons.length).toBeGreaterThan(10); // the sweep is not vacuous
    expect(unstyled).toEqual([]);
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
