// A stylesheet is not typechecked and no unit test reads it, so a syntax error in it
// ships green. Two have: `.hud-shells--hidden` lost its closing brace, which silently
// swallowed the ENTIRE losing-a-life vignette (verified in a browser: .hud-damage
// computed position:static, inset:auto, opacity:1, background:none -- the feature was
// dead on main); and a merge left `.hud-phase` unclosed, which killed the round banner.
//
// Both were invisible to `npm test` and to `tsc`. This is the cheapest guard that would
// have caught either.
// @vitest-environment jsdom
import { afterEach, describe, it, expect } from 'vitest';
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
 * Split a shorthand value into its top-level components, so `max(a, env(b))` counts as
 * ONE component rather than splitting on the whitespace inside it. A naive
 * `.split(/\s+/)` turns the topbar's four-part padding into eight fragments and makes
 * every positional assertion meaningless.
 */
function splitShorthand(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of value.trim()) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (depth === 0 && /\s/.test(ch)) {
      if (cur) out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
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

/**
 * A single `var(--name)` or `var(--name, fallback)` reference, whole.
 *
 * Anchored: a value that merely CONTAINS a reference -- `1px solid var(--x)` -- is not one
 * this resolver handles, and falls through to the `var(` check in `resolved` rather than
 * being half-substituted.
 */
const VAR_REFERENCE = /^var\(\s*(--[A-Za-z0-9_-]+)\s*(?:,\s*([\s\S]*?))?\s*\)$/;

/**
 * A computed value with one level of `var()` resolved. Use this, not `getComputedStyle`,
 * for any property this stylesheet tokenises.
 *
 * jsdom does NOT resolve `var()`. Measured directly: a rule of `font-size: var(--probe)`
 * against `:root { --probe: 21px }` makes `getComputedStyle(el).fontSize` read the literal
 * string `"var(--probe)"`, where a browser reads `"21px"`. The custom property itself IS
 * readable and IS inherited, through `getPropertyValue('--probe')`.
 *
 * That matters here more than it would in most suites, because these guards are computed
 * style guards on purpose -- see the button rule's own comment on the eleven ways past a
 * text-parsing draft. Tokenising a declaration breaks them in two ways, and the second is
 * far worse than the first:
 *
 *  - a numeric assertion fails LOUDLY, since `parseFloat("var(--x)")` is `NaN`;
 *  - any `.not.toBe(...)` on a tokenised property starts passing VACUOUSLY, because the
 *    literal `"var(--x)"` is unequal to every expected value. The assertion keeps
 *    reporting green while measuring nothing.
 *
 * Both were reproduced on this suite before this helper existed, by substituting five
 * tokens whose values were byte-identical to the literals they replaced: 2 of 25 cases
 * failed, and the rest of that test's assertions went quiet.
 *
 * THROWS rather than returning the unresolved string, and rather than returning `''`,
 * when a reference has no value and no fallback. A typo in a token name is then a red
 * suite instead of the same vacuous pass this helper exists to remove. One level only:
 * this stylesheet chains no tokens, and a recursive resolver would be a branch no test
 * here could kill.
 */
function resolved(el: Element, prop: keyof CSSStyleDeclaration & string): string {
  const style = getComputedStyle(el);
  const raw = String((style as unknown as Record<string, unknown>)[prop] ?? '');
  const match = VAR_REFERENCE.exec(raw.trim());
  if (!match) {
    if (raw.includes('var(')) {
      throw new Error(`resolved(${prop}): jsdom left an unresolvable reference in ${raw}`);
    }
    return raw;
  }
  const [, token, fallback] = match;
  const value = style.getPropertyValue(token).trim();
  const out = value !== '' ? value : (fallback ?? '').trim();
  if (out === '') {
    throw new Error(`resolved(${prop}): ${token} has no value and no fallback`);
  }
  if (out.includes('var(')) {
    throw new Error(`resolved(${prop}): ${token} resolves to another reference, ${out}`);
  }
  return out;
}

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
  // The `createElement('button')` sites in hud.ts today are the hull-swatch row, the
  // skin row and the accent row (built during `createHud`), the level row (built
  // here), the controller-assignment row buttons, and -- as of the versus setup pane
  // -- its Mode/Players/Map/Stock/friendly-fire/who's-playing rows. The remaining
  // setters rebuild subtrees that hold no buttons today; they are driven anyway so a
  // button added to one of them lands under this sweep instead of beside it.
  //
  // KNOWN BLIND SPOT, found by review rather than assumed away: this sweeps the DOM
  // these calls produce, not every path that can produce a button. A button created by
  // a setter not called here is invisible to the guard, and the pinned count below
  // will not notice either, because it never appears. If you add a button-building
  // path, drive it here.
  hud.setLevelSelect(2, 4);
  hud.setAchievements(new Set());
  hud.showAchievementToasts(ACHIEVEMENTS.slice(0, 1));
  // The controller assignment panel's row buttons (renderControllerRows, hud.ts): one
  // row per slot, one candidate button per slot for Keyboard/Bot/None plus one per
  // DETECTED pad -- so both setters are driven, mirroring setLevelSelect(2, 4) just
  // above, to exercise the gamepad-candidate branch too, not only the three fixed ones.
  // Bot candidates are OFF by default (`botAssignmentAllowed` -- bots may not drive a
  // player tank in the campaign without the `bots` dev flag). Turned on here so this
  // fixture still renders every candidate KIND, which is what a theming sweep wants:
  // an un-themed `.hud-controller-source-btn` should be caught whichever kind built it.
  hud.setBotAssignmentAllowed(true);
  hud.setDetectedPads([{ padIndex: 1, id: 'Test Pad' }]);
  hud.setControllers([{ kind: 'keyboard' }, { kind: 'gamepad', padIndex: 1 }]);
  // The versus setup pane's Mode/Players/Map/Stock rows and its who's-playing preview
  // are all rendered UNCONDITIONALLY at construction (renderVersusMapRow/
  // renderVersusControllerRows -- see hud.ts's own comment on why, mirroring
  // setLevelSelect/setControllers' "not gated on the panel being open" convention), so
  // they are already in the DOM with no call needed here. The pane's own default
  // player count (2) matches this fixture's 2-slot setControllers call just above, so
  // the who's-playing preview lands on the INTERACTIVE branch (real, enabled
  // candidate buttons -- see renderVersusControllerRows), not the disabled preview
  // branch a mismatched count would produce.
  //
  // The one row that IS conditional is friendly fire -- genuinely absent from the DOM
  // under the pane's FFA default (renderVersusFriendlyFireRow) -- so switching to
  // Teams here is what lands its button under this sweep at all.
  const versusTeamsBtn = root.querySelector(
    '.hud-versus-mode-row [data-mode="teams"]',
  ) as HTMLButtonElement;
  versusTeamsBtn.click();
  return {
    root,
    dispose: () => {
      hud.dispose();
      document.body.innerHTML = '';
    },
  };
}

describe('resolved(): the token-aware computed style this suite reads', () => {
  const injected: HTMLStyleElement[] = [];

  function probe(rules: string, cls = 'probe'): HTMLElement {
    const style = document.createElement('style');
    style.textContent = rules;
    document.head.appendChild(style);
    // Tracked, and only these are removed. `hud.ts`'s own `import './hud.css'` puts the
    // real stylesheet in this same document at module scope -- a blanket
    // `head.querySelectorAll('style').forEach(remove)` deletes it and takes the other
    // twenty-five cases down with it. Observed, not theorised.
    injected.push(style);
    const el = document.createElement('div');
    el.className = cls;
    document.body.appendChild(el);
    return el;
  }

  afterEach(() => {
    while (injected.length > 0) injected.pop()?.remove();
    document.body.innerHTML = '';
  });

  it('records the jsdom behaviour this helper exists for', () => {
    // The premise, asserted rather than assumed: if jsdom ever starts resolving var(),
    // this case fails and the helper below can be deleted.
    const el = probe(':root { --probe-size: 21px } .probe { font-size: var(--probe-size) }');
    expect(getComputedStyle(el).fontSize).toBe('var(--probe-size)');
    expect(getComputedStyle(el).getPropertyValue('--probe-size')).toBe('21px');
  });

  it('passes a plain literal through untouched', () => {
    const el = probe('.probe { font-size: 21px }');
    expect(resolved(el, 'fontSize')).toBe('21px');
  });

  it('resolves a reference to the token value', () => {
    const el = probe(':root { --probe-size: 21px } .probe { font-size: var(--probe-size) }');
    expect(resolved(el, 'fontSize')).toBe('21px');
  });

  it('FOLLOWS a change in the token value, which is what makes it a measurement', () => {
    // The discriminating control. A helper that merely stripped the `var()` wrapper, or
    // returned a constant, would pass every case above and fail this one.
    const el = probe(':root { --probe-size: 11px } .probe { font-size: var(--probe-size) }');
    expect(resolved(el, 'fontSize')).toBe('11px');
    expect(resolved(el, 'fontSize')).not.toBe('21px');
  });

  it('uses the declared fallback when the token is absent', () => {
    const el = probe('.probe { font-size: var(--missing, 13px) }');
    expect(resolved(el, 'fontSize')).toBe('13px');
  });

  it('prefers the token over the fallback when BOTH are present', () => {
    // Added because a mutation survived: swapping the precedence so the fallback wins kept
    // all 35 other cases green. No case had a defined token AND a differing fallback, so
    // the rule that decides between them was never measured. A stylesheet that tokenises
    // with fallbacks -- `var(--radius-md, 10px)` -- would then be read at its fallback,
    // reporting the OLD literal however the token was retuned.
    const el = probe(':root { --probe-size: 21px } .probe { font-size: var(--probe-size, 99px) }');
    expect(resolved(el, 'fontSize')).toBe('21px');
  });

  it('THROWS on a token with no value and no fallback, instead of passing vacuously', () => {
    // Returning `''` here would restore the exact failure this helper removes: a
    // `.not.toBe(...)` against `''` reports green while measuring nothing.
    const el = probe('.probe { font-size: var(--missing) }');
    expect(() => resolved(el, 'fontSize')).toThrow(/no value and no fallback/);
  });

  it('THROWS on a chained token rather than returning a second reference', () => {
    const el = probe(
      ':root { --a: var(--b); --b: 9px } .probe { font-size: var(--a) }',
    );
    expect(() => resolved(el, 'fontSize')).toThrow(/another reference/);
  });

  it('THROWS when a reference is embedded in a larger value it cannot resolve', () => {
    const el = probe(':root { --w: 2px } .probe { outline: var(--w) solid #7fd0ff }');
    expect(() => resolved(el, 'outline')).toThrow(/unresolvable reference/);
  });

  it('records the OTHER jsdom trap: a tokenised shorthand leaves its longhands unset', () => {
    // Measured. With `outline: var(--w) solid #7fd0ff`, jsdom keeps the reference on the
    // SHORTHAND (`outline` reads `"var(--w) solid #7fd0ff"`) but never expands it, so
    // `outlineWidth` reads its initial `"medium"` -- no reference for `resolved` to catch
    // and nothing to signal that the declaration was dropped. A guard that reads the
    // longhand of a tokenised shorthand is therefore measuring the initial value, not the
    // stylesheet. Tokenise the focus ring's longhands individually, not `outline`.
    const el = probe(':root { --w: 2px } .probe { outline: var(--w) solid #7fd0ff }');
    expect(getComputedStyle(el).outlineWidth).toBe('medium');
    expect(resolved(el, 'outlineWidth')).toBe('medium');
  });

  it('never returns a string that still contains `var(`', () => {
    // The property every downstream assertion depends on. Whatever comes back is either a
    // real value or an exception -- never something that compares unequal to everything.
    const el = probe(
      ':root { --probe-size: 21px } .probe { font-size: var(--probe-size); color: #123456 }',
    );
    for (const prop of ['fontSize', 'color'] as const) {
      expect(resolved(el, prop)).not.toContain('var(');
    }
  });
});

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
      // losing a life -- '--hud-damage-color' is the variable hud.ts's signalPlayerDeath
      // tints (death-pulse issue #200); without it the vignette is stuck on whatever
      // the default red resolves to no matter what colour is passed in.
      '.hud-damage', '.hud-damage--hit', '.hud-lives--hit', '--hud-damage-color',
      '.hud-shells', '.hud-shells--hidden', // dev shell count
      '.hud-count', '.hud-count--hidden', '.hud-count--pop', // round-start countdown
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
      '.hud-panel-mute', '.hud-panel-volume', '.hud-scheme-toggle', '.hud-firemode-toggle',
      '.hud-haptics-toggle', // the settings row's controls
      '.hud-levels', '.hud-level-btn', '.hud-level-btn--locked', // level select buttons
      // the level select PANEL: without the hidden rules it covers everything from load,
      // and without the open button's hidden rule it shows outside the title screen
      '.hud-levelselect', '.hud-levelselect--hidden', '.hud-levelselect-open--hidden',
      // Continue/New Game split: without these hidden rules both show at once, or the
      // retired single action button shows alongside them at title
      '.hud-continue--hidden', '.hud-new-game--hidden', '.hud-action--hidden',
      // stats: without the hidden rules the page covers everything from load
      '.hud-stats', '.hud-stats--hidden', '.hud-stats-open', '.hud-stats-open--hidden',
      '.hud-danger', '.hud-danger--armed', '.hud-attempt-summary', '.hud-attempt-summary--hidden',
      // coop's kill tally: without the hidden rule it shows on every panel, not just
      // win/lose (mirrors .hud-attempt-summary exactly)
      '.hud-coop-kills', '.hud-coop-kills--hidden',
      // versus's kill/death tally (n-player arc PR 4): same rationale as coop's line
      // just above -- without the hidden rule it shows on every panel, not just win/lose
      '.hud-versus-results', '.hud-versus-results--hidden',
      // paint shop: hidden rules + the selection ring, the pane's only current-colour signal
      '.hud-customize', '.hud-customize--hidden', '.hud-customize-open--hidden',
      '.hud-swatch', '.hud-swatch--selected',
      // the live preview's fixed size -- without it the canvas falls back to the HTML
      // default replaced-element size (300x150), and the section label styling
      '.hud-preview', '.hud-customize-section',
      // the rotate cluster: without its own row rule the four buttons stack vertically
      // (a <div> of block children), and without the icon size rule the svg falls back
      // to 300x150 and the pane is four enormous glyphs
      '.hud-preview-rotate', '.hud-rotate-btn', '.hud-rotate-icon',
      // the accent row's own flex/gap -- without it the swatches touch edge-to-edge,
      // unlike every other row in the pane (.hud-swatches, .hud-skins)
      '.hud-accents',
      // skins: the border is the pane's only current-skin signal
      '.hud-skin', '.hud-skin--selected',
      // achievements: hidden rules, the earned/locked contrast, and the toast rail
      '.hud-achievements', '.hud-achievements--hidden', '.hud-achievements-open--hidden',
      '.hud-achievement', '.hud-achievement--earned', '.hud-toasts', '.hud-toast',
      // controller assignment panel (docs/superpowers/plans/2026-08-17-controller-
      // assignment.md): hidden rules, the row layout, the disconnected dimming, and the
      // per-candidate selection ring, the row's only current-source signal
      '.hud-controllers', '.hud-controllers--hidden', '.hud-controllers-open--hidden',
      '.hud-controller-rows', '.hud-controller-row', '.hud-controller-row-label',
      '.hud-controller-row-current', '.hud-controller-row-current--disconnected',
      '.hud-controller-source-btn', '.hud-controller-source-btn--selected',
      // versus setup pane (docs/superpowers/specs/2026-08-21-versus-setup-menu-
      // design.md): hidden rules, the row/option-button layout, the selection ring,
      // and the friendly-fire toggle -- the who's-playing preview reuses the
      // controller-assignment selectors just above rather than duplicating them.
      '.hud-versus-open--hidden', '.hud-versus-setup', '.hud-versus-setup--hidden',
      '.hud-versus-row', '.hud-versus-mode-row', '.hud-versus-players-row',
      '.hud-versus-map-row', '.hud-versus-stock-row', '.hud-versus-option-btn',
      '.hud-versus-option-btn--selected', '.hud-versus-friendlyfire-btn',
      '.hud-versus-assignment-note', '.hud-versus-assignment-note--hidden',
      // issue #280: the who's-playing preview's own side-by-side override of the
      // controller-assignment selectors just above -- without these two, the preview
      // falls back to their vertical list, unchanged from before the issue.
      '.hud-versus-setup .hud-controller-rows', '.hud-versus-setup .hud-controller-row',
      // Task 5b (a versus session's title screen): the Campaign button's hidden rule
      // -- without it every versus session would show it permanently, even at
      // non-title states.
      '.hud-campaign-open--hidden',
      // Task 6's in-match stock readout (spec §3a): the topbar strip's hidden rule
      // (without it the strip -- with whatever stale entries it last held -- shows on
      // every panel, not just playing/paused) and its per-entry layout, the row's only
      // rule (without it the entries stack vertically like a bare <div>'s children).
      '.hud-versus-stocks', '.hud-versus-stocks--hidden', '.hud-versus-stock-entry',
      // issue #282: the campaign Lives/Enemies stats' hidden rule -- without it, both
      // show through on every versus-session state, not just the ones this file's own
      // hud.test.ts happens to construct a fixture for.
      '.hud-campaign-stat--hidden',
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
    // 37 since the accent (skin colour) row landed: 32 (31 [29 [27 + the Pause and Mine
    // buttons] + the Fire button and the aim-scheme toggle] + the fire-mode toggle) + 5
    // for ACCENTS.length -- one swatch button per accent entry, same as the hull row.
    // The count moving is the prompt to check the new buttons are themed, which is why
    // it is pinned exactly -- and it did exactly that here.
    // 42 since the preview's rotate cluster landed: 38 + its four icon buttons, which
    // are themed by `.hud-rotate-btn` and would show as stock grey browser buttons in
    // the middle of the pane without it.
    // 46 since the level select panel and the Continue/New Game split landed: 42 + the
    // Levels open button, its own panel's Back button, Continue and New Game.
    // 47 since two-tone (issue #137) landed: every SKINS entry builds a button in the
    // skin row (hud.ts:641, `for (const skin of SKINS)`), so a seventh skin is a
    // seventh button.
    // 48 since the haptics toggle (issue #112's deferred HUD control) landed: 47 + the
    // toggle beside the fire-mode toggle in the settings row.
    // 58 since the controller assignment panel landed (docs/superpowers/plans/
    // 2026-08-17-controller-assignment.md): 48 + 2 static (.hud-controllers-open,
    // .hud-controllers-back) + 8 row buttons from THIS fixture's setDetectedPads/
    // setControllers calls above -- 2 slots x (Keyboard/Bot/None + 1 detected pad at
    // padIndex 1) = 2 x 4 = 8. A different fixture (slot/pad count) would pin a
    // different number; this one is the sweep's actual denominator, not a general claim
    // about every possible assignment. The Bot candidate is only present because the
    // fixture calls setBotAssignmentAllowed(true); without it the campaign default drops
    // one button per slot and this is 56.
    // 86 since the versus setup pane landed (docs/superpowers/specs/2026-08-21-versus-
    // setup-menu-design.md): 58 + 28, measured (not derived) against THIS fixture --
    // 3 static (.hud-versus-open, .hud-versus-start, .hud-versus-back) + 2 Mode
    // (FFA/Teams) + 3 Players (2/3/4) + 6 Map (versusMapChoices(2) -> arena-01..05,
    // all 5 pass `suitable` at 2 players today, measured via versusBoardCatalog() --
    // plus Random) + 5 Stock (1-5) + 1 friendly-fire toggle (present only because
    // this fixture switches the pane to Teams -- see mountEveryButton's own comment;
    // absent under the pane's FFA default, and this would be 85 without that click)
    // + 8 who's-playing PREVIEW row buttons. That preview reuses the exact
    // renderControllerRowsInto machinery the row above counts: the pane's default
    // player count (2) matches THIS fixture's own 2-slot setControllers call, so it
    // lands on the INTERACTIVE branch (2 slots x 4 candidates, same arithmetic as the
    // real Controllers panel's 8 above) rather than the disabled preview branch a
    // mismatched count would produce -- a fixture with a different pane player count
    // or a different setControllers slot count would pin a different number here too.
    // 3 + 2 + 3 + 6 + 5 + 1 + 8 = 28.
    // 87 since Task 5b's Campaign button landed: 86 + 1 static button
    // (.hud-campaign-open), rendered unconditionally at construction (same convention
    // as every other title-panel button here) and hidden via CSS class rather than
    // removed from the DOM -- this fixture never calls setSessionKind('versus'), so it
    // stays hidden throughout, exactly like .hud-continue/.hud-new-game/
    // .hud-versus-open above ALREADY are counted here whether shown or not.
    expect(buttons.length).toBe(87);
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
    const panel = ['hud-stats-open', 'hud-achievements-open', 'hud-customize-open', 'hud-levelselect-open'];
    const back = ['hud-stats-back', 'hud-customize-back', 'hud-achievements-back', 'hud-levelselect-back'];

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

  it('lets the settings row wrap, since five controls no longer fit a phone width', () => {
    // Review measured this in real chromium at hud.css's own named phone widths: four
    // controls fit 393px exactly (rowWidth 393.0); adding the haptics toggle made it
    // 448.5, clipped at both edges and unpannable under the body's overflow:hidden +
    // the panel's touch-action: pan-y. `flex-wrap: wrap` is what folds it instead.
    // Breaks if the declaration is dropped from `.hud-panel-settings`.
    const row = document.createElement('div');
    row.className = 'hud-panel-settings';
    document.body.appendChild(row);
    expect(getComputedStyle(row).flexWrap).toBe('wrap');
    document.body.innerHTML = '';
  });

  it('lays out the accent row like its siblings, not as one touching strip', () => {
    // `.hud-accents` shipped with NO layout rule of its own -- `.hud-swatches` and
    // `.hud-skins` both set `display: flex; gap: ...`, but the accent row (a THIRD,
    // separate container in hud.ts, reusing `.hud-swatch` for its buttons) had neither,
    // so it resolved to the browser default (`display: block`, `gap: normal`) and its
    // circular swatches rendered edge-to-edge as one solid strip -- unlike every other
    // row in the same pane. Measured directly: before the fix, `getComputedStyle` on a
    // bare `.hud-accents` div reports `display: block`. Presence-only checks (the
    // selector list above) cannot see this: `.hud-accents` matching zero rules and
    // `.hud-accents` matching a rule with no layout declarations look identical to
    // `toContain`.
    const swatches = document.createElement('div');
    swatches.className = 'hud-swatches';
    const accents = document.createElement('div');
    accents.className = 'hud-accents';
    document.body.appendChild(swatches);
    document.body.appendChild(accents);

    const swatchesStyle = getComputedStyle(swatches);
    const accentsStyle = getComputedStyle(accents);
    expect(accentsStyle.display).toBe('flex');
    expect(accentsStyle.display).toBe(swatchesStyle.display);
    expect(accentsStyle.gap).toBe(swatchesStyle.gap);

    document.body.innerHTML = '';
  });

  it('lays out the versus stock readout as a row, and its hidden rule actually hides it', () => {
    // Same class of gap the accent-row test above exists for: the presence-only sweep
    // cannot tell "no rule" from "a rule with no layout declarations" -- both make
    // `.hud-versus-stocks` match `toContain`. Without `display: flex` here, per-slot
    // entries (block-level <span>s once hud.ts sets a className on them) would each
    // take the full topbar row width and stack vertically instead of sitting in one
    // compact strip. Without the `--hidden` rule resolving to `display: none`, the
    // strip -- and whatever stale entries it last held -- would stay visible outside
    // playing/paused, which is exactly the state gate this feature is bound to (spec
    // §3a). Breaks if either rule is deleted or the hidden rule loses its declaration.
    const row = document.createElement('div');
    row.className = 'hud-versus-stocks';
    document.body.appendChild(row);
    expect(getComputedStyle(row).display).toBe('flex');

    row.classList.add('hud-versus-stocks--hidden');
    expect(getComputedStyle(row).display).toBe('none');

    document.body.innerHTML = '';
  });

  it("lays the versus setup's who's-playing preview out side by side, distinct from the standalone Controllers panel's own vertical list (issue #280)", () => {
    // The versus pane's who's-playing preview reuses .hud-controller-rows/
    // .hud-controller-row VERBATIM from the standalone Controllers panel
    // (renderControllerRowsInto, hud.ts) -- same classes, same DOM shape, scoped only
    // by the .hud-versus-setup ancestor (renderVersusControllerRows' own doc
    // comment). The presence-only sweep above cannot tell "the versus pane inherited
    // the base vertical list" from "the versus pane got its own side-by-side
    // override" -- both make '.hud-versus-setup .hud-controller-rows' match
    // `toContain`. This asserts the RESOLVED style actually differs between the two
    // contexts, and differs in the specific way issue #280 asked for.
    const controllers = document.createElement('div');
    controllers.className = 'hud-controllers';
    const controllersRows = document.createElement('div');
    controllersRows.className = 'hud-controller-rows';
    controllers.appendChild(controllersRows);

    const versus = document.createElement('div');
    versus.className = 'hud-versus-setup';
    const versusRows = document.createElement('div');
    versusRows.className = 'hud-controller-rows';
    versus.appendChild(versusRows);

    document.body.append(controllers, versus);

    const controllersStyle = getComputedStyle(controllersRows);
    const versusStyle = getComputedStyle(versusRows);

    // The standalone panel keeps the base rule's vertical, capped-and-scrolling list
    // -- "completely unaffected" is issue #280's own bar for this panel.
    expect(controllersStyle.flexDirection).toBe('column');
    expect(controllersStyle.flexWrap).toBe('nowrap');
    // Deliberately "some cap", not the literal 58vh: what issue #280 needs to hold is
    // that the standalone panel still caps and scrolls its own list, not what the base
    // rule happens to cap it AT. Pinning the value would make an unrelated retune of
    // .hud-controller-rows fail an issue-#280 test. It still discriminates: the versus
    // pane's override sets `none`, which this rejects.
    expect(controllersStyle.maxHeight).not.toBe('none');
    expect(controllersStyle.maxHeight).not.toBe('');
    expect(controllersStyle.overflowY).toBe('auto');

    // The versus pane's own preview goes side by side, wrapping, instead.
    expect(versusStyle.flexDirection).toBe('row');
    expect(versusStyle.flexWrap).toBe('wrap');
    // Neutralized, not inherited -- a SECOND, nested scroll region a few rows tall
    // inside .hud-versus-setup, which already scrolls the whole pane end to end,
    // would be two overlapping scrollbars for what is at most a 2x2 grid. See the
    // scoped rule's own comment in hud.css.
    expect(versusStyle.maxHeight).toBe('none');
    expect(versusStyle.overflowY).toBe('visible');
    // jsdom's cssstyle does not resolve `vw` to a pixel value (same limitation this
    // file's own doc comment already names for `max()`/`env()`), but it DOES keep the
    // specified value verbatim, which is enough to tell "a definite width is set" from
    // "none is" -- the standalone panel's row has no width rule at all and reports the
    // browser default `auto`. Without this container's own definite width, the row
    // rule below folds unevenly well above the 760px breakpoint -- measured directly
    // in Chromium at 700px with 2 slots, before this existed: fit-content resolved the
    // container narrower than the viewport and the pair stacked into ONE column
    // instead of sitting side by side. See the scoped rule's own comment in hud.css.
    expect(controllersStyle.width).toBe('auto');
    expect(versusStyle.width).toBe('92vw');

    document.body.innerHTML = '';
  });

  it('forces the who\'s-playing preview to two definite-width columns below the phone breakpoint (issue #280)', () => {
    // jsdom's window is a fixed 1024px wide, so `@media (max-width: 760px)` never
    // matches here -- this can only be a TEXT assertion, the same reasoning (and the
    // same limitation) as `keeps the narrow-viewport rules the phone layout needs`
    // below. The geometry this rule actually produces -- a clean 2x2 at 375px and
    // 320px, no clipping or overlap even with a long gamepad-id candidate label, and
    // one row for 2/3/4 players at 1280px and other desktop widths -- was verified
    // directly in Chromium against the real running app (not jsdom), including the
    // `700px` fit-content trap the scoped rows rule's own comment documents.
    const src = stripComments(css);
    const idx = src.indexOf('.hud-versus-setup .hud-controller-row {');
    expect(idx, 'the narrow-viewport row rule is gone').toBeGreaterThan(-1);
    // Anchored on the SELECTOR's own index, not a positional split on the media query
    // text: the topbar block (line ~170) opens the SAME `@media (max-width: 760px)`
    // query first, and `src.split(...)​[1]` -- the pattern the narrow-viewport test
    // below uses -- would silently resolve to THAT block instead of this one.
    const mediaIdx = src.lastIndexOf('@media (max-width: 760px)', idx);
    expect(mediaIdx, 'the row rule is not inside a 760px query').toBeGreaterThan(-1);
    expect(
      idx - mediaIdx,
      'the nearest preceding 760px query is too far away to be the one wrapping this rule',
    ).toBeLessThan(400);

    const block = src.slice(idx, src.indexOf('}', idx));
    expect(block, 'lost the explicit two-column width').toContain('flex: 0 1 40vw');
    expect(block, 'lost the shrink override a long pad-id label needs').toContain(
      'min-width: 0',
    );
    expect(
      block,
      "lost border-box, so the 40vw budget stops accounting for the row's own padding/border",
    ).toContain('box-sizing: border-box');
  });

  it('centres the win/lose/pause/title panel text, so a wrapped heading does not read as left-shifted (issue #151)', () => {
    // `.hud-title` is 56px/900: at phone widths a two- or three-digit level number
    // ("Level 12 cleared!") does not fit one line and wraps. A wrapped block-level
    // heading with no declared width takes the FULL flex-item width -- fit-content
    // collapses to the container's available width once max-content exceeds it -- so
    // the browser's default `text-align: left` flushed both lines against the left
    // edge while `.hud-subtitle` and `.hud-action`, short enough to never wrap, stayed
    // shrink-to-fit and genuinely centred beside it. Measured in real Chromium against
    // the production DOM (390x844, "Level 3 cleared!", a Range over each wrapped
    // line's text node rather than the block's own line box, which always spans the
    // full container width regardless of glyph extent): before this fix the two lines'
    // glyph runs centred 99.6px and 89.2px off the 195px viewport centre; after,
    // within 0.1px of it. `.hud-achievements` and `.hud-levelselect` already carry
    // `text-align: center` for the same reason (see `still carries the rules the
    // features depend on` above) -- `.hud-panel` did not.
    //
    // Breaks if `text-align: center` is removed (or renamed) on `.hud-panel`.
    const panel = document.createElement('div');
    panel.className = 'hud-panel';
    document.body.appendChild(panel);
    expect(getComputedStyle(panel).textAlign).toBe('center');
    document.body.innerHTML = '';
  });

  it('gives the preview canvas an explicit size', () => {
    // A real browser falls a sizeless <canvas> back to 300x150 (the HTML
    // replaced-element default) -- jsdom does not model that (a bare canvas here
    // reports 'auto'/'auto', not '300px'/'150px'), so this cannot compare against that
    // fallback the way the accent-row test next door compares against `display: block`.
    // What it CAN prove under jsdom is the positive: the rule resolves to the exact
    // pixel size render/preview.ts's camera framing assumes, distinguishing "rule
    // exists but sets nothing" from "rule sets the real values" -- the presence-only
    // check above cannot tell those apart.
    const preview = document.createElement('canvas');
    preview.className = 'hud-preview';
    document.body.appendChild(preview);
    const previewStyle = getComputedStyle(preview);

    expect(previewStyle.width).toBe('260px');
    expect(previewStyle.height).toBe('190px');

    document.body.innerHTML = '';
  });

  it('keeps the preview canvas out of the browser gesture system', () => {
    // The preview is a turntable (render/preview-controls.ts): a touch drag on it has
    // to reach pointermove, and left at the default the browser claims it as a scroll
    // and sends pointercancel instead -- measured on the GAME canvas at 16px of
    // horizontal travel, which is the whole reason index.html carries the same rule.
    //
    // index.html's `canvas { touch-action: none }` does cover this element today, and
    // index-html.test.ts guards it -- but that rule's own comment scopes its REASON to
    // the board's thumbstick, so narrowing it to `#app canvas` some day is an edit
    // nothing would flag. This asserts the requirement where the element is defined.
    //
    // Computed, not text-matched: this resolves the CASCADE onto a real element, so it
    // still holds if the declaration moves to another selector that covers the canvas,
    // and it fails if a later rule overrides it. jsdom does implement both of these
    // properties (measured: a `.hud-preview` canvas reports 'none'/'none' here) --
    // `touch-action` is the one that had to be checked, since cssstyle drops properties
    // it does not model and would then report '' whatever the sheet said.
    const preview = document.createElement('canvas');
    preview.className = 'hud-preview';
    document.body.appendChild(preview);
    const style = getComputedStyle(preview);

    expect(style.touchAction, 'a drag on the preview can be stolen as a scroll').toBe('none');
    // Not gesture handling, but the same class of defect: a drag on a canvas is a text
    // selection on desktop unless this says otherwise.
    expect(style.userSelect, 'a drag selects the panel text instead of turning the tank').toBe(
      'none',
    );
    // It is a turntable, so it should look draggable before it is dragged.
    expect(style.cursor).toBe('grab');

    document.body.innerHTML = '';
  });

  it('shows focus on the preview, which is now in the tab order', () => {
    // hud.ts gives the canvas tabindex="0" for the keyboard scheme. A focusable
    // control whose focus ring is invisible is worse than one that cannot be focused:
    // the keyboard user cannot tell where they are.
    const src = stripComments(css);
    expect(src, 'the preview has no focus ring').toContain('.hud-preview:focus-visible');
    const start = src.indexOf('.hud-preview:focus-visible {');
    expect(src.slice(start, src.indexOf('}', start))).toContain('outline:');
  });

  it('lays the rotate cluster out as one row, with the pair gap on the third button', () => {
    // Two separate defects, both invisible to the presence check above. A <div> whose
    // children are <button> elements lays them out inline-ish rather than as a row with
    // a gap, so without `display: flex` they touch; and the extra margin that groups the
    // pairs has to land on the THIRD child, which is what makes the cluster read as
    // hull-pair / turret-pair rather than four identical buttons.
    const cluster = document.createElement('div');
    cluster.className = 'hud-preview-rotate';
    const made: HTMLButtonElement[] = [];
    for (let i = 0; i < 4; i++) {
      const b = document.createElement('button');
      b.className = 'hud-rotate-btn';
      cluster.appendChild(b);
      made.push(b);
    }
    document.body.appendChild(cluster);
    const row = getComputedStyle(cluster);
    expect(row.display).toBe('flex');
    expect(parseFloat(row.gap)).toBeGreaterThan(0);
    const margins = made.map((b) => parseFloat(getComputedStyle(b).marginLeft) || 0);
    expect(margins[2], 'the pairs are not separated').toBeGreaterThan(parseFloat(row.gap));
    expect([margins[0], margins[1], margins[3]]).toEqual([0, 0, 0]);
    document.body.innerHTML = '';
  });

  it('keeps the rotate buttons out of the browser gesture system, and sized to be hit', () => {
    // Same class of defect as the canvas rule next door, for the same reason: these are
    // HOLD-to-repeat buttons, so a press the browser claims as the start of a scroll
    // sends pointercancel and takes the hold with it.
    const b = document.createElement('button');
    b.className = 'hud-rotate-btn';
    document.body.appendChild(b);
    const style = getComputedStyle(b);
    expect(style.touchAction, 'a hold on a rotate button can be stolen as a scroll').toBe('none');
    expect(style.cursor).toBe('pointer');
    // A tap target, not a text button. Stated as a floor, because the exact size is a
    // layout choice and 34px is already a documented compromise on a 260px pane.
    expect(parseFloat(style.width)).toBeGreaterThanOrEqual(32);
    expect(parseFloat(style.height)).toBeGreaterThanOrEqual(32);

    // The icon inside it needs its OWN size, and this is the assertion that says so: an
    // <svg> with a viewBox and no CSS size falls back to the replaced-element default
    // (300x150 in a real browser), which would put four enormous glyphs in the middle of
    // the pane. The presence check above cannot see it -- `.hud-rotate-icon` matching a
    // rule that only sets `pointer-events` reads identically to `toContain` -- and a
    // mutation deleting exactly those two declarations SURVIVED the whole suite until
    // this was added.
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('class', 'hud-rotate-icon');
    b.appendChild(icon);
    const iconStyle = getComputedStyle(icon);
    expect(parseFloat(iconStyle.width), 'the icon has no explicit width').toBeGreaterThan(0);
    expect(parseFloat(iconStyle.height), 'the icon has no explicit height').toBeGreaterThan(0);
    // ...and it must not swallow the press that the BUTTON is listening for.
    expect(iconStyle.pointerEvents).toBe('none');
    document.body.innerHTML = '';
  });

  it('shows focus on the rotate buttons, which are in the tab order by default', () => {
    const src = stripComments(css);
    expect(src, 'the rotate buttons have no focus ring').toContain('.hud-rotate-btn:focus-visible');
    const start = src.indexOf('.hud-rotate-btn:focus-visible {');
    expect(src.slice(start, src.indexOf('}', start))).toContain('outline:');
  });

  it('shows focus on every control the roving tabindex can land on, generically', () => {
    // hud.ts's onNavKeyDown (issue #115) moves real DOM focus between whatever
    // `button, [tabindex]` finds -- which by construction covers every button this or a
    // future panel adds, not a maintained list. The ring has to be equally generic, or a
    // new button would navigate to silently and show no ring at all.
    //
    // TEXT only, like the two focus-visible checks above and for the same reason stated
    // there: jsdom's `getComputedStyle` does not recompute a dynamic pseudo-class --
    // measured directly, a bare `button:focus { outline: 3px solid blue }` rule in a
    // live `<style>` reports `outlineStyle: 'none'` after a real `.focus()`, even though
    // `btn.matches(':focus')` correctly reports `true` at the same moment. So a
    // computed-style assertion here would report EVERY focus-visible rule in this file
    // as absent whether it is wired or not, which is worse than reading the text -- the
    // same shape of gap this file's own doc comment names for `max()`/`env()`.
    const src = stripComments(css);
    expect(src, 'no generic focus-visible rule for HUD buttons').toContain(
      '.hud button:focus-visible',
    );
    const start = src.indexOf('.hud button:focus-visible');
    const block = src.slice(start, src.indexOf('}', start));
    expect(block).toContain('outline:');
    // ...and it must not also ring a panel CONTAINER (`.hud-panel` and its four
    // siblings, all `tabindex="-1"`), which programmatic focus lands on for every
    // panel-open transition and which already declare their own `:focus { outline:
    // none }` -- a ring here would fight that, and `[tabindex]` is exactly as specific
    // as a class, so a bare `.hud [tabindex]` would win the fight.
    expect(block, 'the generic rule rings a panel container too').toContain(
      ':not([tabindex="-1"])',
    );
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

  it('keeps the HUD clear of display cutouts and the home-indicator strip', () => {
    // TEXT assertions, and the reason is measured rather than assumed: jsdom's cssstyle
    // drops any declaration whose value it cannot parse, and it parses neither `max()`
    // nor `env()`. Probed in this environment -- a rule
    // `padding: max(12px, env(safe-area-inset-top)) 18px` computes to paddingTop "0",
    // while a plain `padding: 12px 18px` computes to "12px". So a computed-style
    // assertion here would report the safe-area rule as ABSENT whether it is there or
    // not, which is worse than reading the text.
    //
    // What this can still catch is the regression that happens: the rules being deleted
    // or the selectors renamed out from under them. The real check is a notched device,
    // and nobody has run one.
    const src = stripComments(css);
    const topbar = src.slice(src.indexOf('.hud-topbar {'));
    const topbarRule = topbar.slice(0, topbar.indexOf('}'));
    // Top for portrait (status bar / Dynamic Island), left and right for landscape,
    // where the score row runs under the camera housing. Bottom is deliberately absent:
    // nothing in the topbar is near it.
    for (const side of ['top', 'left', 'right']) {
      expect(topbarRule, `the topbar ignores the ${side} inset`).toContain(
        `env(safe-area-inset-${side})`,
      );
    }
    // ...and each inset on the side it is FOR. The presence checks above are exactly
    // the "close to worthless" shape CLAUDE.md names, and it was not hypothetical here:
    // swapping `env(safe-area-inset-right)` and `env(safe-area-inset-left)` in the
    // shorthand -- so each pads the opposite edge -- passed all 17 tests in this file.
    // Measured in Chromium at 844x390 with the notch on the left (inset-left 59px),
    // shipped computes `12px 18px 12px 59px` and swapped computes `12px 59px 12px 18px`:
    // the score row stays under the camera housing and gains dead space on the far side.
    //
    // The shorthand is top/right/bottom/left, so the position IS the meaning.
    const paddingDecl = topbarRule
      .split(';')
      .map((d) => d.trim())
      .find((d) => d.startsWith('padding:') && d.includes('env('));
    expect(paddingDecl, 'the topbar has no safe-area padding declaration at all').toBeDefined();
    const sides = splitShorthand(paddingDecl!.slice('padding:'.length));
    // Four components, not two or three: a shorthand with fewer mirrors its opposite
    // edge, which would silently give the left inset to the right side.
    expect(sides, `not a four-part shorthand: ${paddingDecl}`).toHaveLength(4);
    expect(sides[0], 'top').toContain('env(safe-area-inset-top)');
    expect(sides[1], 'right').toContain('env(safe-area-inset-right)');
    expect(sides[2], 'bottom is deliberately plain').not.toContain('env(');
    expect(sides[3], 'left').toContain('env(safe-area-inset-left)');

    const touch = src.slice(src.indexOf('.hud-touch {'));
    const touchRule = touch.slice(0, touch.indexOf('}'));
    // Fire and Mine sit in the home-indicator swipe strip at `bottom: 14px`. These are
    // LONGHANDS, so pair each property with its own inset for the same reason as above
    // -- `right: max(14px, env(safe-area-inset-bottom))` contains both strings and would
    // pass a presence check.
    for (const side of ['right', 'bottom']) {
      const decl = touchRule
        .split(';')
        .map((d) => d.trim())
        .find((d) => d.startsWith(`${side}:`) && d.includes('env('));
      expect(decl, `the touch row ignores the ${side} inset`).toBeDefined();
      expect(decl, `${side} is padded by the wrong inset`).toContain(
        `env(safe-area-inset-${side})`,
      );
    }
  });

  it('lets no later rule quietly override the safe-area insets', () => {
    // The trap this shape exists to remove, and it was live: BOTH narrow-viewport
    // blocks used to set `padding` on .hud-topbar as a shorthand. A shorthand in a
    // later @media wins outright, so writing the insets into the base rule alone would
    // have dropped them on every viewport under 760px -- phones, which is the entire
    // population the feature is for. The blocks now retune two custom properties and
    // the padding is declared in ONE place.
    //
    // Not a style rule: it is the only thing standing between "the insets are written"
    // and "the insets apply".
    const blocks: Array<{ selector: string; body: string }> = [];
    const rule = /([^{}]+)\{([^{}]*)\}/g; // innermost blocks only, so @media prelude is skipped
    let m: RegExpExecArray | null;
    const src = stripComments(css);
    while ((m = rule.exec(src)) !== null) blocks.push({ selector: m[1].trim(), body: m[2] });
    // The scan is worth nothing if the regex matched nothing.
    expect(blocks.length).toBeGreaterThan(40);

    const targeting = (cls: string): typeof blocks =>
      // `(?![\w-])` so `.hud-topbar--hidden` and `.hud-touch--hidden` are not this rule.
      blocks.filter((b) =>
        b.selector.split(',').some((s) => new RegExp(`\\${cls}(?![\\w-])`).test(s)),
      );

    const setsPadding = targeting('.hud-topbar').filter((b) =>
      /(^|;)\s*padding(-top|-right|-bottom|-left)?\s*:/.test(b.body),
    );
    expect(
      setsPadding.map((b) => b.selector),
      'more than one rule sets .hud-topbar padding: the narrow-viewport blocks retune --hud-topbar-pad-*',
    ).toHaveLength(1);
    expect(setsPadding[0].body).toContain('env(safe-area-inset-top)');

    const setsOffsets = targeting('.hud-touch').filter((b) =>
      /(^|;)\s*(right|bottom)\s*:/.test(b.body),
    );
    expect(setsOffsets.map((b) => b.selector)).toHaveLength(1);
    expect(setsOffsets[0].body).toContain('env(safe-area-inset-bottom)');
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
