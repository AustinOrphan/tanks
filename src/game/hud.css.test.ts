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
 *
 * `background`, the SHORTHAND, replaced `backgroundColor` when the stylesheet was
 * tokenised (issue #321), and the reason is the jsdom behaviour `resolved` documents:
 * jsdom keeps a `var()` reference on the shorthand a rule actually writes and never
 * expands it into the longhands, so `backgroundColor` reads its initial
 * `rgba(0, 0, 0, 0)` on every button whose fill is now `background: var(--hud-quiet-fill)`
 * -- identical to a bare button, which made this sweep report 62 false positives. Reading
 * the property the stylesheet writes is what keeps the question "does this look themed".
 */
const THEMED_PROPS = ['background', 'color', 'borderRadius', 'cursor'] as const;

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

  it('declares no design token it never references', () => {
    // A token used ZERO times claims more than the "a literal used once stays a literal"
    // rule the token block itself states -- it names a role the stylesheet does not have
    // anywhere. Four were shipped that way in the first draft of issue #321's token block
    // (control sizing and both animation durations) and this is what would have caught
    // them.
    //
    // The inertness reduction that proves the token layer moves no pixel is structurally
    // BLIND to this: an unused token expands to nothing, so byte-identical stays
    // byte-identical however many dead names are added. This is the assertion that is not.
    const root = /\n:root \{([\s\S]*?)\n\}/.exec(stripComments(css));
    expect(root, 'the :root token block must exist').not.toBeNull();
    const declared = [...(root as RegExpExecArray)[1].matchAll(/(--[a-z0-9-]+):/g)].map((m) => m[1]);
    // Vacuity guard: a regex that stopped matching would make the loop below trivially true.
    expect(declared.length).toBeGreaterThan(20);

    const unused = declared.filter((name) => !css.includes(`var(${name})`));
    expect(unused, 'declared but never referenced').toEqual([]);
  });

  it('still carries the rules the features depend on', () => {
    // Presence, not styling -- a rule silently deleted in a merge is the other half of
    // the failure mode above. Population: the selectors whose absence disables a
    // shipped feature or a dev overlay.
    for (const sel of [
      // The primitives (issue #321). Every quiet control, every primary action and every
      // choice control in the HUD now resolves its base through these, so deleting one
      // does not disable one feature -- it unstyles a class of control across every
      // panel at once. `.ui-selectable--on` in particular is the ONLY current-choice
      // signal for the hull swatches, the accent swatches, the skins, the controller
      // sources and the versus options; four separate rules said so before it existed.
      '.ui-btn', '.ui-btn--slab', '.ui-btn--sm', '.ui-btn--primary', '.ui-btn--danger',
      '.ui-selectable', '.ui-selectable--on',
      // The disabled-reason line. Without it the two reasons in the HUD render at body
      // size and full opacity, reading as content rather than as an aside.
      '.ui-hint',
      // The application backdrop (issue #317). Without the base rule the menu is drawn
      // over the live arena again; without the hidden rule an opaque ground covers the
      // game from load and never leaves. The felt pair is the ruling's switchable
      // alternative -- present here so a merge that drops it is a red test rather than a
      // development flag that silently does nothing.
      '.ui-app-ground', '.ui-app-ground--hidden',
      '.ui-app-ground--felt', '.ui-app-ground--felt::after',
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
      '.hud-panel-volume', // the settings row's slider; its buttons are `.ui-btn--sm`
                           // now and have no rule of their own to be present
      '.hud-levels', '.hud-level-btn', '.hud-level-btn--locked', // level select buttons
      // ...and the reason a locked one is locked: without the hidden rule it explains a
      // state the player has already left
      '.hud-levels-note--hidden',
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
      // paint shop: hidden rules, and the swatch's own size/shape (its ring is the
      // shared `.ui-selectable` above)
      '.hud-customize', '.hud-customize--hidden', '.hud-customize-open--hidden',
      '.hud-swatch',
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
      // skins: the button's own padding; base and ring both come from the primitives
      '.hud-skin',
      // achievements: hidden rules, the earned/locked contrast, and the toast rail
      '.hud-achievements', '.hud-achievements--hidden', '.hud-achievements-open--hidden',
      '.hud-achievement', '.hud-achievement--earned', '.hud-toasts', '.hud-toast',
      // controller assignment panel (docs/superpowers/plans/2026-08-17-controller-
      // assignment.md): hidden rules, the row layout, the disconnected dimming, and the
      // per-candidate button's own size
      '.hud-controllers', '.hud-controllers--hidden', '.hud-controllers-open--hidden',
      '.hud-controller-rows', '.hud-controller-row', '.hud-controller-row-label',
      '.hud-controller-row-current', '.hud-controller-row-current--disconnected',
      '.hud-controller-source-btn',
      // versus setup pane (docs/superpowers/specs/2026-08-21-versus-setup-menu-
      // design.md): hidden rules, the row/option-button layout, and the friendly-fire
      // toggle.
      '.hud-versus-open--hidden', '.hud-versus-setup', '.hud-versus-setup--hidden',
      '.hud-versus-row', '.hud-versus-mode-row', '.hud-versus-players-row',
      '.hud-versus-map-row', '.hud-versus-stock-row', '.hud-versus-option-btn',
      // `.hud-versus-assignment-note` is deliberately ABSENT from this list as of issue
      // #260, and both of its rules are gone from the stylesheet. It was listed for its
      // `--hidden` modifier, which was the only rule it ever had of its own; the note is
      // unconditional now (devices really are assigned at Start, for every slot), so
      // that rule would be dead. Its LOOK was always `.ui-hint`, which is swept above.
      // issue #260: the who's-playing block's OWN classes. It used to reuse the
      // controller-assignment selectors above and override them under a
      // `.hud-versus-setup` scope; it renders per-slot ROLE cards now, so the grid,
      // the derived device line and the two refusal notes are all its own. Without
      // the first two, the cards fall back to a vertical list -- the exact layout
      // regression issue #280 exists to prevent.
      // `.hud-versus-assignment-note--hidden` is deliberately ABSENT: the note is
      // unconditional now, so a rule for it would be dead.
      '.hud-versus-slot-rows', '.hud-versus-slot-row', '.hud-versus-slot-label',
      '.hud-versus-slot-device', '.hud-versus-slot-reason',
      '.hud-versus-slot-reason--hidden', '.hud-versus-start-reason--hidden',
      // issue #260: the kit's FIRST disabled-button treatment. Before this, nothing in
      // hud.css matched `:disabled` at all, so a refused Start rendered identically to a
      // live one -- caught by photographing the built app, not by any assertion here.
      '.ui-btn:disabled',
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

  it('paints the application ground OPAQUE, and at the tuned value -- both measured, not read', () => {
    // The load-bearing property is opacity, not the hex. Issue #317's other half stops
    // Quit from rebuilding the board, so whatever world the player abandoned is still
    // behind this layer when the menu appears -- a scrim here, instead of a ground,
    // would put a paused explosion under the New Game button. A transparent or
    // translucent value fails the first assertion.
    //
    // The exact value is pinned second because the token block's own rule says a token
    // whose VALUE changes is a visual change that owes its own evidence; this is where
    // that change is caught. `#14161c`, the renderer's clear colour, is NOT this value
    // on purpose: composited under `--hud-scrim-panel` (rgba(20, 24, 30, 0.55)) it gives
    // #14171d, a one-value change in one channel, and an opening panel would then change
    // nothing on screen. See the token's own comment.
    //
    // Read through `resolved`: the rule writes `background: var(--hud-app-ground)`, and
    // jsdom hands back that literal string -- an assertion on the raw computed value
    // would pass against any hex at all.
    const el = document.createElement('div');
    el.className = 'ui-app-ground';
    document.body.appendChild(el);

    const background = resolved(el, 'background');
    expect(background, 'the application ground is not opaque').toMatch(/^#[0-9a-f]{6}$/i);
    expect(background).toBe('#181c24');
    document.body.innerHTML = '';
  });

  it('hides the ground with display, not with a colour -- the dead-CSS half', () => {
    // `.ui-app-ground--hidden` carrying no declaration is the exact failure
    // `.hud-splash--hidden` has its own note about: the class goes on, the element
    // stays painted, and an opaque ground covers the game from load and never leaves.
    // Measured against the SAME element with the modifier removed, so a rule that hid
    // everything unconditionally would fail the control.
    const el = document.createElement('div');
    el.className = 'ui-app-ground ui-app-ground--hidden';
    document.body.appendChild(el);
    expect(getComputedStyle(el).display).toBe('none');
    el.className = 'ui-app-ground';
    expect(getComputedStyle(el).display, 'the ground is hidden even unmodified').not.toBe('none');
    document.body.innerHTML = '';
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

    // Read through `resolved`, not `getComputedStyle`: three of these four properties are
    // tokenised, and jsdom hands back the literal `var(--hud-text)` for them. That string
    // is unequal to the bare button's value, so this sweep would report every button as
    // themed -- including a genuinely unstyled one -- while measuring nothing.
    const buttons = Array.from(root.querySelectorAll('button'));
    const unstyled = buttons
      .map((b) => {
        const bareProps = THEMED_PROPS.filter((p) => resolved(b, p) === resolved(bare, p));
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
    // who's-playing ROLE buttons: 2 slots (the pane's default player count) x
    // [Human/Bot/Off] = 6. This no longer depends on the fixture's setControllers call
    // at all -- the block used to render the session's DEVICE assignment through
    // renderControllerRowsInto, so its count moved with the session's slot count and
    // with how many pads were detected. Roles are a property of the pane's own retained
    // setup (issue #260), so only the pane's player count can move this number.
    // 3 + 2 + 3 + 6 + 5 + 1 + 6 = 26.
    // 86 since issue #260 replaced that 8-button device preview (2 slots x
    // [Keyboard/Bot/None + 1 detected pad]) with these 6: 88 - 8 + 6.
    // It was 88 since issue #271's vs-duel-01 joined the N=2 map offer, adding one map
    // button to the versus pane this fixture renders, and 87 when Task 5b's Campaign
    // button landed: 86 + 1 static button
    // (.hud-campaign-open), rendered unconditionally at construction (same convention
    // as every other title-panel button here) and hidden via CSS class rather than
    // removed from the DOM -- this fixture never calls setSessionKind('versus'), so it
    // stays hidden throughout, exactly like .hud-continue/.hud-new-game/
    // .hud-versus-open above ALREADY are counted here whether shown or not.
    expect(buttons.length).toBe(86);
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

  it('groups every button under a primitive, or names it as a deliberate exception', () => {
    // What replaces "a new button joins by adding its selector to the group". The guard
    // above asks whether a button LOOKS themed; this one asks whether it is themed from
    // the shared source, which is the property that stops the next sibling drifting.
    //
    // The exceptions are the four control kinds that are genuinely not the quiet button:
    // each has a fill and a shape of its own that `.ui-btn` would hand it only to be
    // overridden. Listing them here is the point -- a fifth one has to be argued for in
    // this list rather than appearing by omission.
    const { root, dispose } = mountEveryButton();
    const EXCEPTIONS = [
      'hud-swatch', // the colour circles: their background IS the colour they offer
      'hud-rotate-btn', // the preview's icon buttons: outlined, 34px, their own fill
      'hud-mute', // the topbar mute: a yellow state chip, not a quiet control
      'hud-pause-btn', 'hud-fire-btn', 'hud-mine-btn', // the on-screen driving controls
    ];
    const strays = Array.from(root.querySelectorAll('button'))
      .filter((b) => !b.classList.contains('ui-btn'))
      .filter((b) => !EXCEPTIONS.some((cls) => b.classList.contains(cls)))
      .map((b) => Array.from(b.classList).join('.'));
    expect(strays).toEqual([]);

    // ...and the exception list is not allowed to go stale in the other direction: a
    // class listed here that no longer names a button in the fixture is a name nobody
    // has to justify any more, and should leave the list.
    const unused = EXCEPTIONS.filter((cls) => root.querySelector(`button.${cls}`) === null);
    expect(unused, 'exception named for a button the HUD no longer renders').toEqual([]);

    dispose();
  });

  it('keeps each size of quiet control to ONE size, which is what the modifier is for', () => {
    // `.ui-btn` alone makes a button look themed, so the guard above stays green if a
    // control loses `--slab` or `--sm` -- only its padding and corner radius change, and
    // both of those come from the modifier. This measures the group against ITSELF
    // rather than against a number, so retuning a size is free and losing one is not.
    const { root, dispose } = mountEveryButton();
    const shape = (sel: string): string => {
      const el = root.querySelector(sel);
      expect(el, `${sel} is not in the fixture`).not.toBeNull();
      return `${resolved(el!, 'padding')} / ${resolved(el!, 'borderRadius')}`;
    };
    // The slab a panel stacks, and the small control a row lays out in a line.
    const slab = ['.hud-quit', '.hud-stats-open', '.hud-achievements-open',
      '.hud-customize-open', '.hud-levelselect-open', '.hud-controllers-open',
      '.hud-versus-open', '.hud-campaign-open', '.hud-stats-back', '.hud-customize-back',
      '.hud-achievements-back', '.hud-levelselect-back', '.hud-controllers-back',
      '.hud-versus-back', '.hud-reset-stats', '.hud-reset-progress'];
    const small = ['.hud-panel-mute', '.hud-scheme-toggle', '.hud-firemode-toggle',
      '.hud-haptics-toggle', '.hud-versus-friendlyfire-btn'];
    for (const sel of slab) expect(shape(sel), sel).toBe(shape(slab[0]));
    for (const sel of small) expect(shape(sel), sel).toBe(shape(small[0]));
    // Without this the two loops above would both pass on a stylesheet that gave every
    // button in the HUD one shape, which is the opposite of what the modifiers exist for.
    expect(shape(slab[0])).not.toBe(shape(small[0]));

    // The primary action is its own shape again, shared by all four of its buttons.
    const primary = ['.hud-action', '.hud-continue', '.hud-new-game', '.hud-versus-start'];
    for (const sel of primary) expect(shape(sel), sel).toBe(shape(primary[0]));
    expect(shape(primary[0])).not.toBe(shape(slab[0]));

    dispose();
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
    expect(resolved(accents, 'gap')).toBe(resolved(swatches, 'gap'));

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

  it('draws a refused button as refused, on more channels than colour alone (issue #260)', () => {
    // A RESOLVED-STYLE assertion, not a presence check: this file's own sweep above can
    // only say the selector exists. What made this rule necessary was a screenshot of the
    // built app -- `disabled` was set on Start and it still rendered bright green with its
    // raised shadow, indistinguishable from a live primary button.
    //
    // Negative control: the enabled twin below must differ on every channel asserted, so
    // a rule that accidentally applied to all buttons fails here rather than passing.
    const live = document.createElement('button');
    live.className = 'ui-btn ui-btn--primary';
    const refused = document.createElement('button');
    refused.className = 'ui-btn ui-btn--primary';
    refused.disabled = true;
    document.body.append(live, refused);

    const l = getComputedStyle(live);
    const r = getComputedStyle(refused);

    // Three channels, so neither hue alone nor opacity alone carries the whole signal.
    expect(r.opacity).not.toBe(l.opacity);
    expect(r.cursor).toBe('not-allowed');
    expect(r.cursor).not.toBe(l.cursor);
    // The raised shadow is what makes the primary button read as pressable at all; a
    // flattened one is a SHAPE difference, which survives a forced-colors theme (#368)
    // that would flatten the hue difference away.
    expect(l.boxShadow, 'the live control lost its raised shadow').not.toBe('none');
    expect(r.boxShadow, 'the refused control still stands off the surface').toBe('none');

    document.body.innerHTML = '';
  });

  it("lays the versus setup's who's-playing cards out side by side, distinct from the standalone Controllers panel's own vertical list (issue #280)", () => {
    // Issue #280's contract, re-pinned on issue #260's classes. The two blocks used to
    // share .hud-controller-rows and be told apart only by a `.hud-versus-setup`
    // ancestor scope; the versus pane has its own .hud-versus-slot-rows now. That
    // makes the presence sweep above even weaker as evidence than before -- a
    // `.hud-versus-slot-rows` rule that simply forgot `flex-direction: row` would
    // still match `toContain` -- so this asserts the RESOLVED style, and asserts that
    // it still differs from the standalone panel in the specific way #280 asked for.
    const controllers = document.createElement('div');
    controllers.className = 'hud-controllers';
    const controllersRows = document.createElement('div');
    controllersRows.className = 'hud-controller-rows';
    controllers.appendChild(controllersRows);

    const versus = document.createElement('div');
    versus.className = 'hud-versus-setup';
    const versusRows = document.createElement('div');
    versusRows.className = 'hud-versus-slot-rows';
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

    // The versus pane's own cards go side by side, wrapping, instead.
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

  it('forces the who\'s-playing cards to two definite-width columns below the phone breakpoint (issue #280)', () => {
    // jsdom's window is a fixed 1024px wide, so `@media (max-width: 760px)` never
    // matches here -- this can only be a TEXT assertion, the same reasoning (and the
    // same limitation) as `keeps the narrow-viewport rules the phone layout needs`
    // below. The geometry this rule actually produces -- a clean 2x2 at 375px and
    // 320px, no clipping or overlap even with a long gamepad-id candidate label, and
    // one row for 2/3/4 players at 1280px and other desktop widths -- was verified
    // directly in Chromium against the real running app (not jsdom), including the
    // `700px` fit-content trap the scoped rows rule's own comment documents.
    const src = stripComments(css);
    // lastIndexOf, not indexOf: `.hud-versus-slot-row {` also names the card's own BASE
    // rule earlier in the file (outside any media query). The narrow-viewport override
    // is the last of the two, and the media-proximity assertion below is what proves
    // this really landed on the one inside the query rather than on the base rule.
    const idx = src.lastIndexOf('.hud-versus-slot-row {');
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
    // `gap` is tokenised, so `parseFloat(getComputedStyle(...).gap)` is NaN here and every
    // comparison below it would fail loudly rather than measure the layout.
    const rowGap = parseFloat(resolved(cluster, 'gap'));
    expect(rowGap).toBeGreaterThan(0);
    const margins = made.map((b) => parseFloat(resolved(b, 'marginLeft')) || 0);
    expect(margins[2], 'the pairs are not separated').toBeGreaterThan(rowGap);
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
    // A tap target, and now held to the REAL floor. This guard read `>= 32` while the
    // button was a 34px literal, described in hud.css as a compromise on a 260px pane.
    // Issue #352 measured that compromise and found it unnecessary: the cluster is
    // `4W + 30` wide, so 44px comes to 206px inside the same 260px pane and stays on ONE
    // row down to the 280px Galaxy Fold cover screen, clearing it by 37px.
    //
    // ASSERTED ON THE DECLARATION, not on the computed value, and the reason is a jsdom
    // limit rather than a preference: `.hud-rotate-btn` now takes `--hud-control-min`
    // (issue #321's primitive) instead of a literal, and jsdom does not substitute
    // `var()` in getComputedStyle -- `style.width` comes back empty and `parseFloat` NaN.
    // The same limit is why this file's token block says a rendered height "is not
    // measurable in this suite at all". So the floor is pinned in two halves that a
    // regression cannot pass separately: the rule must REFER to the token, and the token
    // must BE the floor. The rendered 44px itself is measured in a real browser, which is
    // what issue #352's captures are for.
    const rotateRule = /\n\.hud-rotate-btn \{([\s\S]*?)\n\}/.exec(stripComments(css));
    expect(rotateRule, '.hud-rotate-btn must still be a rule this can read').not.toBeNull();
    const rotateBody = (rotateRule as RegExpExecArray)[1];
    expect(rotateBody, 'the rotate button must size itself from the control floor')
      .toMatch(/width:\s*var\(--hud-control-min\)\s*;/);
    expect(rotateBody).toMatch(/height:\s*var\(--hud-control-min\)\s*;/);
    expect(stripComments(css), 'and the floor itself must still be 44px')
      .toMatch(/--hud-control-min:\s*44px\s*;/);

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

/*
 * Issue #364's first acceptance criterion: ONE place defines the transition duration and
 * easing, and no screen carries its own copy. The duration half is proved behaviourally
 * in `hud.test.ts` (move the token, the timer moves with it). Easing has no TypeScript
 * consumer at all -- CSS performs it -- so this is where its half lives.
 *
 * Asserted against the SHORTHAND and the source text rather than through `resolved()`,
 * which was the first attempt and measures nothing here. Probed in this file before
 * writing: jsdom does not expand `animation`, so `animationDuration` reads `"auto"` and
 * `animationTimingFunction` reads `"ease"` -- both jsdom's own defaults, identical
 * whether the stylesheet says 150ms/cubic-bezier or was never loaded. An assertion on
 * those longhands would have passed against a deleted rule.
 */
describe('hud.css: the one application-transition definition (issue #364)', () => {
  const CONTRACT_RULES = ['.ui-surface--entering', '.ui-surface--leaving'];

  it('gives both contract rules their duration and easing from the tokens, live', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const hud = createHud(root);
    try {
      const el = root.querySelector('.hud-panel') as HTMLElement;
      for (const cls of ['ui-surface--entering', 'ui-surface--leaving']) {
        el.className = `hud-panel ${cls}`;
        const shorthand = getComputedStyle(el).animation;
        // Vacuity guard: a deleted or renamed rule leaves this empty, and every
        // `toContain` below would then be asserting about "".
        expect(shorthand, `${cls} matched no rule`).not.toBe('');
        expect(shorthand, `${cls} does not read the duration token`).toContain(
          'var(--ui-transition-duration)',
        );
        expect(shorthand, `${cls} does not read the easing token`).toContain(
          'var(--ui-transition-ease)',
        );
      }
      // The tokens themselves resolve, so the references above are not pointing at names
      // that were never declared.
      const rootStyle = getComputedStyle(document.documentElement);
      expect(rootStyle.getPropertyValue('--ui-transition-duration').trim()).toMatch(
        /^[\d.]+m?s$/,
      );
      expect(rootStyle.getPropertyValue('--ui-transition-ease').trim()).not.toBe('');
    } finally {
      hud.dispose();
      document.body.innerHTML = '';
    }
  });

  it('declares the duration and the easing exactly once each, and nowhere as a literal', () => {
    // "No screen has its own copy" is a claim about the whole stylesheet, which the live
    // check above cannot make -- it only looks at the two rules it already knows about.
    const text = stripComments(css);
    for (const token of ['--ui-transition-duration', '--ui-transition-ease']) {
      const declarations = [...text.matchAll(new RegExp(`${token}\\s*:`, 'g'))];
      expect(declarations.length, `${token} is declared more than once`).toBe(1);
    }
    // Every rule that animates an application surface must go through the tokens. A
    // second copy would most naturally arrive as a literal duration inside one of these.
    for (const selector of CONTRACT_RULES) {
      const rule = new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`).exec(text);
      expect(rule, `${selector} is missing from the stylesheet`).not.toBeNull();
      const body = (rule as RegExpExecArray)[1];
      expect(body, `${selector} hardcodes a duration`).not.toMatch(/animation:[^;]*\d+m?s/);
      expect(body, `${selector} hardcodes an easing curve`).not.toMatch(
        /animation:[^;]*cubic-bezier/,
      );
      expect(body).toContain('var(--ui-transition-duration)');
      expect(body).toContain('var(--ui-transition-ease)');
    }
  });
});

describe('a leaving surface stops eating clicks meant for the one arriving', () => {
  it('takes its DESCENDANTS out of hit testing, not only itself', () => {
    // `pointer-events` is inherited, so `.ui-surface--leaving { pointer-events: none }`
    // reads as though it covers the whole subtree. It does not: a descendant with its own
    // explicit `pointer-events: auto` -- and this stylesheet has more than a dozen --
    // overrides an INHERITED none. The rule's comment claimed the outgoing screen "must
    // not eat a click meant for what is arriving underneath", and nothing checked it.
    //
    // Found by a real click, not by reading: driving the production build with the
    // duration slowed so the crossfade was long enough to click through, Playwright
    // refused the Back button with "<button class=... hud-firemode-toggle> from
    // <div class='hud-panel ui-surface--leaving'> subtree intercepts pointer events".
    const root = document.createElement('div');
    document.body.appendChild(root);
    const hud = createHud(root);
    try {
      const panel = root.querySelector('.hud-panel') as HTMLElement;
      const settings = root.querySelector('.hud-panel-settings') as HTMLElement;
      expect(settings, 'fixture drifted: no descendant with its own pointer-events').not.toBeNull();

      // NEGATIVE CONTROL: with the surface not leaving, the descendant is clickable --
      // otherwise this test would pass against a stylesheet that disabled it always.
      expect(getComputedStyle(settings).pointerEvents, 'control: settings should be clickable').toBe('auto');

      panel.classList.add('ui-surface--leaving');
      expect(getComputedStyle(panel).pointerEvents, 'the leaving surface itself').toBe('none');
      expect(
        getComputedStyle(settings).pointerEvents,
        'a control inside the leaving surface can still eat the click',
      ).toBe('none');
    } finally {
      hud.dispose();
      document.body.innerHTML = '';
    }
  });
});

// ---------------------------------------------------------------------------
// Hover (issue #392). TEXT, not computed style, for the reason the focus-visible checks
// above state at length: jsdom does not recompute a dynamic pseudo-class, so a
// getComputedStyle assertion here would report every hover rule in the file as absent
// whether it is wired or not. The BROWSER measurement is the other half and lives in the
// PR, taken the way #392's own gap table was: each control asked `matches(':hover')`
// before its computed style was diffed, with `.hud-rotate-btn` as the positive control.
// ---------------------------------------------------------------------------

describe('hover treatment on the UI kit primitives (issue #392)', () => {
  const src = stripComments(css);
  /** The text of the one `@media (hover: hover)` block, brace-matched from its opener. */
  const hoverBlock = (): string => {
    const at = src.indexOf('@media (hover: hover)');
    expect(at, 'no @media (hover: hover) block').toBeGreaterThan(-1);
    let depth = 0;
    for (let i = src.indexOf('{', at); i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1);
    }
    throw new Error('unterminated @media (hover: hover) block');
  };

  it('gives every primitive a hover rule -- the five #392 measured as having none', () => {
    // Named individually rather than counted: a count passes when one selector is
    // deleted and another duplicated, which is the shape of the gap this closes.
    const block = hoverBlock();
    for (const sel of [
      '.ui-btn:hover',
      '.ui-btn--primary:hover',
      '.ui-btn--danger:hover',
      '.ui-selectable:not(.ui-selectable--on):hover',
      '.ui-selectable--on:hover',
    ]) {
      expect(block, `${sel} has no hover rule`).toContain(sel);
    }
    // `--slab` and `--sm` are deliberately absent: they set geometry only and inherit
    // `.ui-btn`'s fill, so a rule of their own would be a second place to change one
    // colour. Measured in the browser: both move with the base rule.
    expect(block).not.toContain('.ui-btn--slab:hover');
    expect(block).not.toContain('.ui-btn--sm:hover');
  });

  it('scopes EVERY hover rule behind the pointer query, so a tap cannot stick', () => {
    // The correctness half. A touch device reports a tap as a hover and holds it until
    // the next tap lands elsewhere, so an unguarded rule leaves a control looking
    // permanently pointed-at. Asserted over the whole file rather than the block: a rule
    // added OUTSIDE the media query is exactly the mistake this must catch.
    const outside = src.replace(hoverBlock(), '');
    const stray = [...outside.matchAll(/^[^@}\n][^{\n]*:hover[^{\n]*\{/gm)].map((m) => m[0].trim());
    // `.hud-rotate-btn:hover` predates #392 and is named in that issue's Boundaries as
    // out of scope, so it is the one permitted exception -- pinned by name so a SECOND
    // unguarded rule is a failure rather than joining a growing allowlist.
    expect(stray.map((s) => s.replace(/\s*\{$/, ''))).toEqual(['.hud-rotate-btn:hover']);
  });

  it('never engages on a disabled control', () => {
    // #392's second criterion. Disabled is the real HTML attribute here (hud.ts sets
    // `btn.disabled = true` for locked levels), so every hover selector must carry
    // `:not(:disabled)` -- a rule that forgets it repaints a control the player cannot
    // activate, which reads as "this is available" and is worse than no hover at all.
    const rules = [...hoverBlock().matchAll(/([^{}]+):hover([^{}]*)\{/g)].map((m) => `${m[1]}:hover${m[2]}`.trim());
    expect(rules.length, 'no hover rules found to check').toBeGreaterThan(0);
    for (const r of rules) expect(r, `${r} can engage on a disabled control`).toContain(':not(:disabled)');
  });

  it('keeps hover, focus and selected on three different properties', () => {
    // #392's third criterion, and the one a screenshot cannot settle. If hover moved
    // `border-color` on a selected control it would erase the white ring that is the
    // ONLY signal of which choice is current; if it moved `outline-color` it would be
    // indistinguishable from the focus ring. So: fill for buttons, border for the
    // unselected selectable, and a box-shadow ring for the selected one.
    const block = hoverBlock();
    expect(block).not.toContain('outline');
    const on = block.slice(block.indexOf('.ui-selectable--on:hover'));
    const onBody = on.slice(on.indexOf('{'), on.indexOf('}'));
    expect(onBody, 'the selected ring is repainted by hover').not.toContain('border-color');
    expect(onBody, 'the selected control gets no hover feedback at all').toContain('box-shadow');
  });

  it('no shipped control is both primary and selectable -- the assumption the ring rests on', () => {
    // `.ui-btn--primary` owns `box-shadow` for its raised slab, and the selected-hover
    // ring above would flatten it. That is safe only while no control carries both
    // classes, so this measures it against the REAL hud rather than trusting the four
    // call sites to stay as they are.
    const hud = createHud(document.body);
    try {
      const both = [...document.querySelectorAll('.ui-btn--primary.ui-selectable')]
        .map((e) => e.className);
      expect(both, 'a primary control is selectable; the hover ring would flatten its slab').toEqual([]);
    } finally {
      hud.dispose();
      document.body.innerHTML = '';
    }
  });
});

describe('forced-colors conformance (issue #368)', () => {
  const src = stripComments(css);

  /**
   * The text of the one `@media (forced-colors: active)` block, brace-matched.
   *
   * TEXT, not `getComputedStyle`. jsdom does not evaluate `@media (forced-colors: active)`
   * at all -- it never matches, so every declaration inside is unreachable to the computed
   * cascade and an assertion on one would read the UNFORCED value and pass while measuring
   * nothing. That is a stronger version of the `var()` hole `resolved()` exists for, and it
   * is why the pixels are evidenced in a real browser instead
   * (`tools/uikit/forced-colors.mjs`). What this file owns is that the rules are PRESENT,
   * scoped, and say what the contract says.
   */
  const forcedBlock = (): string => {
    const at = src.indexOf('@media (forced-colors: active)');
    expect(at, 'no @media (forced-colors: active) block').toBeGreaterThan(-1);
    let depth = 0;
    for (let i = src.indexOf('{', at); i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1);
    }
    throw new Error('unterminated @media (forced-colors: active) block');
  };

  it('gives every state its distinction on a channel forcing does not replace', () => {
    const block = forcedBlock();
    // Named individually rather than counted, for the reason the hover sweep gives: a
    // count survives one selector being deleted and another duplicated.
    //
    // Each pair below is a MEASURED collapse (see the block's own comment) and the
    // property that repairs it. Colour is deliberately not asserted for any of them --
    // the whole point is that the agent has taken colour away.
    for (const [selector, property] of [
      ['.ui-btn', 'border'],                 // a control with no edge, once its fill flattens
      ['.ui-selectable', 'border-style'],    // unselected: transparent is forced OPAQUE
      ['.ui-selectable--on', 'border-style'], // chosen: solid against the unselected dotted
      ['.ui-btn--primary', 'border-width'],  // one primary per region, redrawn as weight
      ['.ui-btn--danger', 'border-style'],   // destructive, whose red is gone
    ] as const) {
      const at = block.indexOf(`${selector} {`);
      expect(at, `${selector} has no forced-colors rule`).toBeGreaterThan(-1);
      const body = block.slice(at, block.indexOf('}', at));
      expect(body, `${selector} must carry ${property}`).toContain(property);
    }
  });

  it('the selected ring is distinguished by SHAPE, not only by a system colour', () => {
    // The load-bearing half, and the reason it is asserted separately: `.hud-swatch` opts
    // out of colour forcing below, so on a swatch the ring's colour is whatever was
    // authored -- which on a light high-contrast theme can land on a light Canvas. The
    // dotted/solid difference is unaffected by that opt-out, so it is the channel that
    // holds in both cases. A contract that signalled selection by colour alone would pass
    // the rule sweep above and still lose the ring on the one element that opted out.
    const block = forcedBlock();
    const off = block.slice(block.indexOf('.ui-selectable {'));
    const offBody = off.slice(0, off.indexOf('}'));
    const on = block.slice(block.indexOf('.ui-selectable--on {'));
    const onBody = on.slice(0, on.indexOf('}'));
    expect(offBody).toContain('dotted');
    expect(onBody).toContain('solid');
    // ...and they must not be the same style, which is the whole distinction.
    expect(offBody.includes('dotted') && onBody.includes('dotted')).toBe(false);
  });

  it('opts out of colour forcing in exactly ONE place, and says why', () => {
    // Criterion 5: `forced-color-adjust` is a scoped semantic necessity, never a wholesale
    // opt-out. Asserted over the WHOLE file rather than the block, because a second use
    // added anywhere else is exactly the drift this must catch -- and `none` applied to a
    // container would silently take every descendant out of forcing with it.
    const uses = [...src.matchAll(/forced-color-adjust\s*:\s*([a-z-]+)/g)].map((m) => m[1]);
    expect(uses, 'forced-color-adjust is used more than once').toEqual(['none']);
    const block = forcedBlock();
    const at = block.indexOf('forced-color-adjust');
    const rule = block.lastIndexOf('{', at);
    const selector = block.slice(block.lastIndexOf('}', rule) + 1, rule).trim();
    expect(selector, 'the opt-out must be on the swatch alone').toBe('.hud-swatch');
  });

  it('confines EVERY forced-colors declaration to the block, so normal rendering cannot move', () => {
    // The claim the PR makes about risk, made checkable. A system-colour keyword or a
    // `forced-color-adjust` outside the query would change what ordinary players see --
    // and `ButtonBorder`/`Highlight` are ordinary colours to a browser that is not
    // forcing, so such a rule would apply silently rather than error.
    const outside = src.replace(forcedBlock(), '');
    for (const keyword of ['ButtonBorder', 'Highlight', 'CanvasText', 'GrayText', 'forced-color-adjust']) {
      expect(outside, `${keyword} appears outside the forced-colors block`).not.toContain(keyword);
    }
  });

  it('does not take the focus ring away, which the browser already forces correctly', () => {
    // Measured rather than assumed (tools/uikit/forced-colors.mjs): the outline survives
    // forcing with its width and offset intact and its colour replaced by a system one --
    // `rgba(0,230,255,0.8)` on dark, `rgba(5,0,73,0.8)` on light. So the correct amount of
    // CSS here is NONE, and this pins that absence: a well-meaning `outline: none` or a
    // re-declared focus colour inside the block would be a regression, not an improvement.
    const block = forcedBlock();
    expect(block).not.toContain('outline');
    expect(block).not.toContain(':focus');
  });
});
