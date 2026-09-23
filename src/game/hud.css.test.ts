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
import { devControls, DEV_PRESETS } from './dev-config';
import { isMultiset } from './dev-config-menu';
import { LITERALS } from './devtools-menu';
// hud.ts's own text, so the script-read token exemption below can prove the exemption is
// still true rather than asserting it. A TEST may read a fixture; this is the same shape
// `index-html.test.ts` uses for index.html.
import hudSource from './hud.ts?raw';
// The hull palette, because the even-row cap below is derived from how many swatches there are.
import { PALETTE } from '../presentation/customization';
// The extracted pane modules (issue #556). A pane's markup and class toggles leave hud.ts's text,
// so every source scan below that asks "what does the HUD write" reads these too.
const paneSources = import.meta.glob('./*-pane.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
import { createHud } from './hud';
import { ACHIEVEMENTS } from './achievements';
import { STOCK_CUE_MS } from '../presentation/stock-cue';

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
  // THREE slots since issue #281, matching the player count this fixture now selects
  // below -- see the comment there. A mismatch drops the who's-playing preview onto
  // its DISABLED branch, which renders a different button set and is not what this
  // sweep is for.
  hud.setControllers([{ kind: 'keyboard' }, { kind: 'gamepad', padIndex: 1 }, { kind: 'none' }]);
  // The versus setup pane's Mode/Players/Map/Stock rows and its who's-playing preview
  // are all rendered UNCONDITIONALLY at construction (renderVersusMapRow/
  // renderVersusControllerRows -- see hud.ts's own comment on why, mirroring
  // setLevelSelect/setControllers' "not gated on the panel being open" convention), so
  // they are already in the DOM with no call needed here. The pane's player count (3,
  // selected below) matches this fixture's 3-slot setControllers call just above, so
  // the who's-playing preview lands on the INTERACTIVE branch (real, enabled
  // candidate buttons -- see renderVersusControllerRows), not the disabled preview
  // branch a mismatched count would produce. THE TWO MUST MOVE TOGETHER.
  //
  // The one row that IS conditional is friendly fire -- genuinely absent from the DOM
  // under the pane's FFA default (renderVersusFriendlyFireRow) -- so switching to
  // Teams here is what lands its button under this sweep at all.
  // THREE players first, since issue #281: Teams is not offered at two ("not a distinct
  // option for two players because it is equivalent to FFA"), so the Teams button is
  // disabled at the pane's default count and clicking it does nothing -- which silently
  // took the friendly-fire toggle, and the per-slot team buttons, back out of this sweep.
  // The player count is therefore part of the fixture's route to those controls, not
  // incidental to it.
  (root.querySelector('.hud-versus-players-row [data-players="3"]') as HTMLButtonElement).click();
  const versusTeamsBtn = root.querySelector(
    '.hud-versus-mode-row [data-mode="teams"]',
  ) as HTMLButtonElement;
  expect(versusTeamsBtn.disabled, 'Teams is still refused at three players').toBe(false);
  versusTeamsBtn.click();
  return {
    root,
    dispose: () => {
      hud.dispose();
      document.body.innerHTML = '';
    },
  };
}

/**
 * How many buttons the developer configuration menu builds (issue #246).
 *
 * DERIVED FROM THE REGISTRY rather than pinned as a literal, and that is the point: the menu
 * renders one row per `FLAG_REGISTRY` entry, so a literal here would make every future
 * developer flag break a CSS test that has nothing to do with it. Derived from
 * `devControls()` and the renderer's literal TABLE -- both data -- and not from the
 * renderer's loop, so a forgotten Unset button or a dropped stepper arrow still fails.
 */
function devMenuButtons(): number {
  let n = DEV_PRESETS.length + 3; // presets, then Apply / Reset / Copy
  for (const c of devControls()) {
    if (c.control === 'toggle') n += 1;
    else if (c.control === 'select') n += 1 + (c.values?.length ?? 0); // Unset + one per value
    // A MULTISET is a pair of arrows per kind plus Unset -- its value is a list, not a point
    // on an axis -- where a plain number is one pair, Unset, and any literals beside it.
    else if (isMultiset(c)) n += (c.values?.length ?? 0) * 2 + 1;
    else n += 3 + (LITERALS[c.field]?.length ?? 0); // minus, plus, Unset, then any literals
  }
  return n;
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
    // SHORTHAND (`outline` reads `"var(--w) solid #7fd0ff"`) but never expands it, so every
    // longhand reads the value an element with NO outline rule reads -- no reference for
    // `resolved` to catch and nothing to signal that the declaration was dropped. A guard
    // that reads the longhand of a tokenised shorthand is therefore measuring the initial
    // value, not the stylesheet. Tokenise the focus ring's longhands individually, not
    // `outline`.
    //
    // Compared against a bare element rather than pinned as a literal, because the literal
    // is how jsdom PRINTS the initial value and that moved without the trap moving: jsdom 29
    // printed the initial width as `"medium"` and jsdom 30 prints `"16px"`, while both drop
    // the shorthand identically (probed on both versions, together with writing the three
    // longhands individually, which both apply: `2px` / `solid` / `rgb(127, 208, 255)`).
    // `outlineStyle` is the half that cannot be an accident of printing: the rule says
    // `solid` and `none` comes back. If jsdom ever expands a tokenised shorthand, this fails.
    const el = probe(':root { --w: 2px } .probe { outline: var(--w) solid #7fd0ff }');
    const bare = probe('', 'bare');
    expect(getComputedStyle(el).outline).toBe('var(--w) solid #7fd0ff');
    for (const prop of ['outlineWidth', 'outlineStyle', 'outlineColor'] as const) {
      expect(getComputedStyle(el)[prop], prop).toBe(getComputedStyle(bare)[prop]);
      expect(resolved(el, prop), prop).toBe(resolved(bare, prop));
    }
    expect(resolved(el, 'outlineStyle')).toBe('none');
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

    // READ BY SCRIPT, not by a rule (issue #274). A `<canvas>` cannot take a class, so the
    // board schematic's three colours are pulled out of this block by `getComputedStyle` in
    // hud.ts and handed to `drawArenaSchematic`. They are the only tokens in the file with
    // no `var()` reference and are exempted BY NAME rather than by a pattern, so a fourth
    // dead token cannot arrive under the exemption -- and each is asserted to be read from
    // hud.ts below, which is what stops this list outliving its reason.
    const READ_BY_SCRIPT = ['--hud-schematic-floor', '--hud-schematic-solid', '--hud-schematic-destructible'];
    for (const name of READ_BY_SCRIPT) {
      expect(declared, `${name} is exempted here but not declared`).toContain(name);
      expect(hudSource, `${name} is exempted as script-read but hud.ts never reads it`).toContain(
        `'${name}'`,
      );
    }

    const unused = declared.filter(
      (name) => !css.includes(`var(${name})`) && !READ_BY_SCRIPT.includes(name),
    );
    expect(unused, 'declared but never referenced').toEqual([]);
  });

  it('resolves every token the board schematic is painted from', () => {
    // The fallbacks in `schematicPaint` exist for a stylesheet that failed to load, not for
    // a token that was renamed: `fillStyle = ''` is a silent no-op that keeps the previous
    // colour, so a missing token would draw a board of one flat tone rather than throwing.
    // This is the assertion that says the shipped path never reaches a fallback.
    const probe = document.createElement('div');
    document.body.appendChild(probe);
    const style = getComputedStyle(probe);
    for (const name of ['--hud-schematic-floor', '--hud-schematic-solid', '--hud-schematic-destructible']) {
      expect(style.getPropertyValue(name).trim(), name).not.toBe('');
    }
    // Non-vacuity AND the thing the card is for: the two cover kinds must not resolve to the
    // same paint, or a schematic cannot tell permanent cover from breakable.
    expect(style.getPropertyValue('--hud-schematic-solid').trim()).not.toBe(
      style.getPropertyValue('--hud-schematic-destructible').trim(),
    );
    document.body.innerHTML = '';
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
      // The screen-reader-only class (issue #640's table captions, and issue #629's live
      // announcement line). Without the rule those are not hidden-but-read -- they are
      // VISIBLE: a caption above each Records table, and a status sentence under the toast
      // stack. The failure is a visual regression from an accessibility feature, which is
      // the direction nobody looks in. Listed here because nothing sweeps the classes the
      // HUD writes; this population is maintained by hand.
      '.ui-sr-only',
      // The controller self-test's support verdict (issue #596). Same failure as `.ui-hint`
      // above and the reason it sits beside it: a <p> with no rule takes the browser's
      // default 16px block margin, and this one repeats once per connected pad, so losing
      // the rule pushes every channel list down by a line per pad rather than disabling
      // anything outright. Nothing sweeps the classes the HUD writes -- this list is
      // maintained by hand -- so a class added without an entry here is unguarded.
      '.hud-selftest-pad-support',
      // The developer diagnostics field and its hidden rule (issue #247). The base rule makes
      // a <textarea> legible against the pane instead of a white browser default; the hidden
      // one is what keeps an empty field off the pane from load, above the two buttons that
      // fill it. Listed here because nothing sweeps the classes the HUD writes -- this
      // population is maintained by hand.
      '.hud-diag-out', '.hud-diag-out--hidden',
      // The developer namespace line and its warning modifier (issue #249). Without the base
      // rule a <p> falls to browser defaults; without the modifier the line reads the same
      // whether the session is on the real save or the developer keys, which is the ONE thing
      // that line exists to distinguish. Listed by hand, like every entry here.
      '.hud-devns', '.hud-devns--warning',
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
      // The blocked-fire capacity flash (issue #516's `hud` arm). Without the base rule
      // the line has no `opacity: 0` to return to, so the last refusal's text sits over
      // the arena for the rest of the session -- which is the permanent ammunition
      // counter #356 rules out, arrived at by deleting a rule.
      '.hud-capacity', '.hud-capacity--flash',
      '.hud-count', '.hud-count--hidden', '.hud-count--pop', // round-start countdown
      '.hud-level--hidden', // level progression: without it the empty chip always shows
      // The Practice identity chip (issue #324, step S6). Without the base rule the chip
      // is indistinguishable from the Lives/Enemies readings beside it, which is the
      // whole thing it exists to fix; without the hidden rule it announces PRACTICE over
      // a campaign run and a versus match alike.
      '.hud-practice', '.hud-practice--hidden',
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
      // pause + menu: without the hidden rules, Quit/levels show on EVERY panel
      '.hud-quit', '.hud-quit--hidden',
      // The Main Menu's three regions (issue #226). The panel's own settings ROW is gone
      // -- its controls live in the Settings pane below -- and these replaced it. Without
      // the base rules the menu is one flat column at one weight again, which is the
      // information architecture the issue exists to remove; without the hidden rules
      // every region shows on the pause and outcome panels too.
      '.hud-menu-play', '.hud-menu-utilities', '.hud-menu-footer',
      '.hud-menu-play--hidden', '.hud-menu-utilities--hidden', '.hud-menu-footer--hidden',
      // The run summary and the tertiary weight the replace-run button drops to.
      '.hud-run-summary', '.hud-run-summary--hidden', '.hud-new-game--tertiary',
      // Settings (issue #226): the pane, its hidden rule, and the section machinery.
      // `.hud-settings-section--hidden` is what makes "only sections with relevant
      // controls render" visible -- without it a section left empty by #227's capability
      // hiding renders as a heading over nothing.
      '.hud-settings', '.hud-settings--hidden', '.hud-settings-section',
      '.hud-settings-section--hidden', '.hud-settings-controls',
      '.hud-settings-volume', // the audio slider; its buttons are `.ui-btn--sm`
                              // now and have no rule of their own to be present
      // About & Legal (issue #226): the pane, its hidden rule, and the prose measure.
      '.hud-about', '.hud-about--hidden', '.hud-about-line',
      // The legal document surface (issue #117). Every class the generated data reaches:
      // the shared measure, the links row and one anchor's two parts, the disclosure row
      // and its state word, the body and its hidden rule, and one selector per block kind
      // the generator can emit (heading, paragraph, note, code, list item, table cell).
      // `.hud-legal-body--hidden` earns its place the way `.hud-splash--hidden` does: with
      // no rule behind it every document is open from the moment the pane is built.
      '.hud-about-subtitle', '.hud-about-subline', '.hud-about-links', '.hud-legal',
      '.hud-legal-link', '.hud-legal-link-hint',
      '.hud-legal-doc', '.hud-legal-toggle', '.hud-legal-toggle-state',
      '.hud-legal-body', '.hud-legal-body--hidden',
      '.hud-legal-title', '.hud-legal-source', '.hud-legal-heading', '.hud-legal-para',
      '.hud-legal-note', '.hud-legal-code', '.hud-legal-list', '.hud-legal-item',
      '.hud-legal-table', '.hud-legal-th', '.hud-legal-td',
      // The replace-run confirmation (issue #226): the file's one blocking layer.
      '.hud-confirm', '.hud-confirm--hidden', '.hud-confirm-body', '.hud-confirm-actions',
      // The match-failure alert (issue #325): the overlay, its hidden rule, and the prose
      // measure. `.hud-alert-title` is deliberately absent -- it is an `<h1>` with no rule
      // of its own, styled by the same heading defaults every pane title uses.
      '.hud-alert', '.hud-alert--hidden', '.hud-alert-body',
      // issue #685: without its rule, Retry is offered on a failure with nothing to retry
      '.hud-alert-retry--hidden',
      // Records is one Main Menu entry with two tabs (issue #226): the tab row's layout,
      // and the hidden rule that keeps the entry off the pause panel.
      '.hud-records-tabs', '.hud-records-open--hidden',
      // ...and Records' empty state: without the hidden rule the "no matches played yet"
      // line stands over a populated table, contradicting the numbers beside it (#322).
      '.hud-stats-empty--hidden',
      // ...and the campaign-run tally's: without it the run total shows on the practice
      // and versus endings, reporting a campaign they have nothing to do with.
      '.hud-run-tally', '.hud-run-tally--hidden',
      // Level select buttons. No `--locked` rule and no `--hidden` note rule since issue
      // #555: the grid draws only unlocked levels, so there is no dimmed control to style
      // and no state the note can explain that the player is not in.
      '.hud-levels', '.hud-level-btn',
      // the level select PANEL: without the hidden rules it covers everything from load,
      // and without the open button's hidden rule it shows outside the title screen
      '.hud-levelselect', '.hud-levelselect--hidden', '.hud-levelselect-open--hidden',
      // ...and the outcome panel's own way into it (issue #323): without the hidden rule
      // Choose Level stands on the pause panel, the campaign end screens and the menu.
      '.hud-choose-level--hidden',
      // ...and Pause's own contextual action (issue #261): without the hidden rule Change
      // Setup stands on every panel, including sessions with no versus setup to change.
      '.hud-change-setup--hidden',
      // Continue/New Game split: without these hidden rules both show at once, or the
      // retired single action button shows alongside them at title
      '.hud-continue--hidden', '.hud-new-game--hidden', '.hud-action--hidden',
      // stats: without the hidden rule the page covers everything from load. Its OPEN
      // button is `.hud-records-open` since issue #226 (Records is one entry, Stats is a
      // tab), swept with the other Main Menu classes above.
      '.hud-stats', '.hud-stats--hidden',
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
      // `.hud-achievements-open--hidden` is deliberately ABSENT since issue #226: there
      // is no Achievements button on the Main Menu any more, only the Achievements TAB
      // inside Records, so a rule for it would be dead.
      '.hud-achievements', '.hud-achievements--hidden',
      '.hud-achievement', '.hud-achievement--earned', '.hud-toasts', '.hud-toast',
      // issue #630: the lock's line with the label, its fixed slot (without which an earned
      // row's empty slot collapses and its title sits left of the locked ones), and the svg
      // size (without which it falls back to 300x150)
      '.hud-achievement-head', '.hud-achievement-icon', '.hud-achievement-lock',
      // controller assignment panel (docs/superpowers/plans/2026-08-17-controller-
      // assignment.md): hidden rules, the row layout, the disconnected dimming, and the
      // per-candidate button's own size
      '.hud-controllers', '.hud-controllers--hidden', '.hud-controllers-open--hidden',
      '.hud-controller-rows', '.hud-controller-row', '.hud-controller-row-label',
      '.hud-controller-row-current', '.hud-controller-row-current--disconnected',
      '.hud-controller-source-btn',
      // issue #597: the browser-boundary help line, the unsupported-pad reason line, and the
      // rule that hides the reason while every listed pad is readable
      '.hud-controllers-help', '.hud-controllers-unsupported', '.hud-controllers-unsupported--hidden',
      // versus setup pane (docs/superpowers/specs/2026-08-21-versus-setup-menu-
      // design.md): hidden rules, the row/option-button layout, and the friendly-fire
      // toggle.
      '.hud-versus-open--hidden', '.hud-versus-setup', '.hud-versus-setup--hidden',
      '.hud-versus-row', '.hud-versus-mode-row', '.hud-versus-players-row',
      '.hud-versus-map-row', '.hud-versus-stock-row', '.hud-versus-option-btn',
      // issue #694: the mode note is hidden whenever Teams is offered; without its rule the
      // empty paragraph kept `.ui-hint`'s margins in the mode row.
      '.hud-versus-mode-note--hidden',
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

  it('gives every --hidden modifier something that actually hides', () => {
    // THE SWEEP THAT SHOULD HAVE EXISTED FOUR TIMES AGO. `.hud-shells--hidden`,
    // `.hud-splash--hidden`, `.ui-app-ground--hidden` and `.hud-legal-body--hidden` each
    // carry their own note about the same failure -- the class goes on, the element stays
    // painted -- and each was pinned one at a time, by whoever was bitten. A mutation
    // emptying `.hud-alert--hidden` SURVIVED against those four cases, because a list of
    // four cannot cover a file with dozens.
    //
    // Derived from the stylesheet's own text so a modifier added tomorrow is swept without
    // anyone remembering to list it. Measured through the cascade, not by parsing: a rule
    // that is empty, that sets only a margin, or that lives in an `@media` that never
    // matches all resolve to a visible element and all fail here.
    const declared = [...new Set(
      [...stripComments(css).matchAll(/^\.([a-z0-9-]+--hidden)\s*[,{]/gm)].map((m) => m[1]),
    )];
    // Non-vacuity, and the denominator: 56 modifiers in the file today. A regex that
    // stopped matching would make the loop below trivially true.
    expect(declared.length).toBeGreaterThan(40);

    const visible: string[] = [];
    for (const cls of declared) {
      const base = cls.replace(/--hidden$/, '');
      const el = document.createElement('div');
      // BOTH classes, in the order the HUD writes them: the modifier only has to beat its
      // own base rule, and testing it alone would pass for a modifier that is simply never
      // stronger than the thing it modifies.
      el.className = `${base} ${cls}`;
      document.body.appendChild(el);
      const hidden =
        getComputedStyle(el).display === 'none' || getComputedStyle(el).visibility === 'hidden';
      if (!hidden) visible.push(cls);
      el.remove();
    }
    expect(visible, 'a --hidden modifier that leaves its element on screen').toEqual([]);
  });

  it('declares every --hidden modifier hud.ts writes, so a toggled class cannot hide nothing', () => {
    // The sweep above takes its list from the STYLESHEET, so a modifier that hud.ts toggles
    // but hud.css never declares is invisible to it. That is exactly what
    // `.hud-versus-mode-note--hidden` was (issue #694): toggled on whenever Teams is offered,
    // with no rule anywhere, so the empty note's paragraph margins stayed in the mode row.
    // This derives the list the other way round, from hud.ts's own text and, since issue #556,
    // from every extracted pane module's text as well.
    const declared = new Set([...stripComments(css).matchAll(/\.([a-z0-9-]+--hidden)\b/g)].map((m) => m[1]));
    const writtenIn = (sources: readonly string[]): string[] => [
      ...new Set(sources.flatMap((src) => [...src.matchAll(/['"`\s]([a-z][a-z0-9-]*--hidden)\b/g)].map((m) => m[1]))),
    ];
    expect(Object.keys(paneSources), 'the pane glob found nothing: panes would go unscanned').toContain('./customize-pane.ts');
    const written = writtenIn([hudSource, ...Object.values(paneSources)]);
    expect(written.length, 'the scan found almost nothing; this test would pass vacuously').toBeGreaterThan(40);
    expect(
      written.filter((cls) => !declared.has(cls)),
      'a --hidden modifier hud.ts or a pane module writes that hud.css never declares',
    ).toEqual([]);
    // Negative control: a pane source writing an undeclared modifier is caught by the same scan.
    expect(writtenIn(["el.classList.add('hud-planted--hidden');"]).filter((cls) => !declared.has(cls))).toEqual([
      'hud-planted--hidden',
    ]);
  });

  it('hides the Versus mode note while Teams is offered, through the real HUD and stylesheet', () => {
    // The sweeps above prove a rule exists and hides a bare element. This proves the note
    // itself, in the pane that toggles it, resolves to `display: none` once Teams is
    // offered at three players, and stays on screen while Teams is still refused at two.
    // Without the second half, a rule that hid the note unconditionally would also pass.
    const root = document.createElement('div');
    document.body.appendChild(root);
    const hud = createHud(root);
    try {
      hud.setState('main-menu');
      hud.showVersusSetup(true);
      const note = root.querySelector('#hud-versus-mode-note') as HTMLElement;
      const players = (n: number): HTMLButtonElement =>
        root.querySelector(`.hud-versus-players-row [data-players="${n}"]`) as HTMLButtonElement;
      players(2).click();
      expect(note.textContent, 'Teams is refused at two players, so the note says why').not.toBe('');
      expect(getComputedStyle(note).display, 'the refusal note is hidden while it is the refusal').not.toBe('none');
      players(3).click();
      expect(note.textContent, 'Teams is offered at three players').toBe('');
      expect(getComputedStyle(note).display, 'the empty note still occupies the mode row').toBe('none');
    } finally {
      hud.dispose();
      document.body.innerHTML = '';
    }
  });

  it('hides a collapsed legal document with display, not with a class that does nothing', () => {
    // Same failure as the ground above, one pane further in (issue #117). Every test that
    // asserts a document is collapsed -- in legal.test.ts and in hud.surfaces.test.ts -- reads
    // the CLASS, and the presence sweep above is satisfied by an EMPTY rule, so deleting this
    // declaration leaves ~25 KB of licence text open on the pane from the moment it is built
    // with nothing red anywhere. This is the only assertion that would notice.
    const el = document.createElement('div');
    el.className = 'hud-legal-body hud-legal-body--hidden';
    document.body.appendChild(el);
    expect(getComputedStyle(el).display).toBe('none');
    el.className = 'hud-legal-body';
    expect(getComputedStyle(el).display, 'a document is hidden even unmodified').not.toBe('none');
    document.body.innerHTML = '';
  });

  it('never centres the main axis of a pane that scrolls', () => {
    // `justify-content: center` on an `overflow-y: auto` flex column puts the overflow ABOVE
    // the scrollable area, where no scrollbar reaches it: the first screenful of a long
    // document is lost and cannot be scrolled back to. The About pane shipped exactly that --
    // harmless while it held three short lines, a defect the moment issue #117 gave it
    // documents -- so this sweeps every scroller in the file rather than pinning the one pane.
    //
    // Measured through the real elements, not by reading the stylesheet: a rule that set
    // `center` inside an `@media` block, or a later rule that re-centred, is invisible to a
    // text search and lands here.
    const { root, dispose } = mountEveryButton();
    const scrollers = Array.from(root.querySelectorAll<HTMLElement>('*')).filter(
      (el) => getComputedStyle(el).overflowY === 'auto',
    );
    // THE POPULATION IS NAMED, because the centred set below is now EMPTY and an empty
    // expectation carries no evidence of its own. `[] === []` passes just as well when
    // `mountEveryButton` stops building a pane, when a selector is renamed, or when
    // `getComputedStyle` returns nothing at all -- three ways this guard could go quiet
    // while advertising that every scroller was checked. A count (`> 3`) does not close
    // that: it survives any pane being swapped for any other. So the scrollers are pinned
    // by name, which fails if one disappears AND fails if one arrives unconsidered.
    //
    // The list is also the first thing here that has ever been WRONG and silent: the
    // comment this replaces named six scrollers, and there are eight -- `.hud-devcfg` and
    // `.hud-controller-rows` arrived after it was written, and `> 3` could not notice.
    //
    // ELEVEN is every `overflow-y: auto` DECLARATION in hud.css, counted with the anchored
    // `grep -nE '^\s+overflow(-y)?: *auto;' src/game/hud.css` -- anchored because the
    // unanchored pattern this comment used to name also matches the five prose lines that
    // discuss the property, and counted 16. Ten of the eleven are one pane each:
    // .hud-settings, .hud-about, .hud-devtools, .hud-devcfg, .hud-selftest, .hud-layout,
    // .hud-gallery, .hud-achievement-list, .hud-controller-rows, .hud-versus-setup. The
    // eleventh is the shared rule, which covered four panes when #686 wrote it and covers
    // SIX since #633 moved `.hud-levelselect` and `.hud-controllers` onto it. Sixteen panes
    // in eleven rules, and sixteen names below.
    //
    // That equality is what lets this guard claim no scrolling PANE centres its axis rather
    // than only the ones the fixture happens to build -- and if another rule is added to a
    // surface `mountEveryButton` does not mount, the two populations part and this comment is
    // the thing that has gone stale.
    expect([...new Set(scrollers.map((el) => el.className.split(' ')[0]))].sort()).toEqual([
      'hud-about',
      'hud-achievement-list',
      'hud-achievements',
      'hud-controller-rows',
      'hud-controllers',
      'hud-customize',
      'hud-devcfg',
      'hud-devtools',
      'hud-gallery',
      'hud-layout',
      'hud-levelselect',
      'hud-panel',
      'hud-selftest',
      'hud-settings',
      'hud-stats',
      'hud-versus-setup',
    ]);
    const centred = scrollers
      .filter((el) => getComputedStyle(el).justifyContent === 'center')
      .map((el) => el.className.split(' ')[0]);
    // EMPTY, and emptied one pane at a time. Each came off this list when its own change
    // made the clip reachable, and each was measured through tools/screens before and
    // after -- the pane's first child's y, which is the box that goes above the scroll
    // origin:
    //  - `.hud-about` (issue #117), at 900x500 with a legal document open: the document's
    //    top box at y = -454 under `center`, y = +388 under `flex-start`.
    //  - `.hud-versus-setup` (issue #274), at 1280x800: seven map cards pushed the Mode and
    //    Players rows above the scroll origin, unreachable.
    //  - `.hud-settings` (issue #642), at 844x390 -- a handset in landscape: the "Settings"
    //    heading at y = -64, now y = +35. `justify-content` and a new `--hud-space-5`
    //    padding moved together there, so +35 is the pair's number, not one line's.
    //  - `.hud-devtools` (issue #642), at 568x280: the heading at y = -19, now y = +35.
    //    Latent rather than reachable -- that pane's content is 318px tall, so no handset
    //    clips it today, and it was fixed before the developer shell grows into it.
    //  - `.hud-controllers` (issue #633), at 422x195 -- an 844x390 handset in landscape at
    //    200% browser zoom, which is #327's own criterion for these panes. Over
    //    `screen.controllers.pads`, so two pads are connected: `#hud-controllers-title` at
    //    y = -14, now y = +21. Its inner `.hud-controller-rows` already scrolled, which is
    //    why the LIST was reachable the whole time while the heading above it was not.
    //  - `.hud-levelselect` (issue #633), at 422x195: `#hud-levelselect-title` at y = -7,
    //    now y = +21. Reachable, not latent -- and only visible once the heading was ADDED
    //    to that state's measured set, because the pane and the grid both read positive
    //    while the title above them was off the top. `.hud-levels` inside it is still a
    //    non-wrapping row; this makes its overflow reachable, not absent.
    //
    // What still fails here, now that there is no residual to pin: any of the eight
    // scrollers above re-centring, and any ninth arriving centred. The `for` loop is the
    // first of those spelled out per pane, so a failure names which one regressed rather
    // than printing a one-element diff.
    expect(centred.sort()).toEqual([]);
    for (const fixed of [
      'hud-about',
      'hud-versus-setup',
      'hud-settings',
      'hud-devtools',
      'hud-controllers',
      'hud-levelselect',
    ]) {
      expect(centred, `${fixed} centres its main axis and clips its own overflow`).not.toContain(
        fixed,
      );
    }

    dispose();
  });

  it('keeps every menu control at the 44px touch floor (issue #686)', () => {
    // jsdom lays nothing out, so whether a control RENDERS at 44 px is measured in Chromium, by
    // `tools/visual/hit-targets.mjs` over every player-facing surface. What this pins is the
    // contract that measurement depends on, in the file an edit to it touches: take any of
    // these declarations away and a control can render under the floor again with every
    // other test here still green. Before the floor, 764 of 1016 control readings were under
    // 44 px in that sweep.
    const src = stripComments(css);
    const rule = (sel: string): string => {
      const at = src.search(new RegExp(`(^|\\n)${sel.replace(/[.]/g, '\\$&')} \\{`));
      expect(at, `no ${sel} rule`).toBeGreaterThan(-1);
      return src.slice(at, src.indexOf('}', at));
    };
    const btn = rule('.ui-btn');
    expect(btn, 'the primitive no longer floors its height').toMatch(/min-height:\s*var\(--hud-control-min\);/);
    expect(btn, 'the primitive no longer floors its width').toMatch(/min-width:\s*var\(--hud-control-min\);/);
    // Without it the two <a class="ui-btn"> links put their padding ON TOP of the floor:
    // measured 48 -> 56 px, a control grown past its design rather than raised to the floor.
    expect(btn, 'the floor is no longer the outer size').toMatch(/box-sizing:\s*border-box;/);
    // The one menu control that is not a `.ui-btn`, measured 140x16 before.
    expect(rule('.hud-settings-volume')).toMatch(/height:\s*var\(--hud-control-min\);/);
  });

  it('keeps legal table words whole unless one cannot fit the pane (issue #796)', () => {
    // jsdom lays nothing out, so the breaking itself was measured in Chromium on a built page,
    // over every legal table (privacy, credits, content licence) at 320, 390 and 1280 px:
    // `anywhere` split 21 tokens mid-word, every storage key included, and `break-word` split
    // 4, each right after a hyphen, with no table overflowing its pane under either. What
    // this pins is the declaration that measurement depends on.
    const src = stripComments(css);
    const at = src.search(/(^|\n)\.hud-legal-th,\s*\.hud-legal-td \{/);
    expect(at, 'no legal table cell rule').toBeGreaterThan(-1);
    const cells = src.slice(at, src.indexOf('}', at));
    expect(cells).toMatch(/overflow-wrap:\s*break-word;/);
    expect(cells, '`anywhere` lowers min-content to one character and squeezes the Key column').not.toMatch(/anywhere/);
  });

  it('pads a control that carries no size variant (issue #686)', () => {
    // `.hud-new-game` is `.ui-btn.ui-btn--primary` in the markup, and `--primary` is where its
    // padding comes from. With a run active the button becomes the tertiary "Start New
    // Campaign" and `hud.ts` REMOVES `--primary`; `.hud-new-game--tertiary` sets only a font
    // size and an opacity. That left the one state with no padding source at all, on the UA
    // default of about 1px 6px -- which was invisible at 19px tall and lopsided once the floor
    // made the box 44px: measured 158x44 in Chromium, ~6px of horizontal padding against 16
    // vertical. Every OTHER `.ui-btn` is padded or sized by a rule later in this file
    // (`--sm`, `--slab`, `--primary`, `.hud-skin`, `.hud-versus-option-btn`,
    // `.hud-versus-map-card`, `.hud-controller-source-btn`, and `.hud-level-btn`'s fixed
    // 44x44), so a base padding on the primitive is overridden by all of them and reaches
    // only the state that had none.
    const src = stripComments(css);
    const at = src.search(/(^|\n)\.ui-btn \{/);
    const btn = src.slice(at, src.indexOf('}', at));
    expect(btn, 'the primitive no longer pads a variant-less control').toMatch(
      /padding:\s*8px\s+20px;/,
    );
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
    // removed from the DOM -- this fixture never pushes a versus status, so it
    // stays hidden throughout, exactly like .hud-continue/.hud-new-game/
    // .hud-versus-open above ALREADY are counted here whether shown or not.
    // 89 since issue #267: three difficulty buttons on the versus pane's one bot slot
    // (`defaultSlots(2)` is `[human, bot]`). They carry `.ui-btn`/`.ui-btn--sm`, so they
    // are inside this sweep rather than falling through to browser default styling --
    // which is exactly what the sweep is for.
    // 119 since issue #261 added Change Setup, the pause panel's contextual versus action:
    // one more static panel button, rendered unconditionally at construction and hidden by
    // CSS class exactly like `.hud-choose-level` beside it, so this fixture counts it
    // without ever showing it.
    // It was 118 at issue #555, which stopped the level grid drawing locked levels: that
    // fixture's `setLevelSelect(2, 4)` used to build four buttons and now builds two (-2). The
    // fixture's ARGUMENTS are the population, so this figure moves with them -- a fixture
    // that unlocked all four would pin 120 again while measuring less.
    // It was 120 at issue #323, which added the practice end screen's Choose Level
    // (.hud-choose-level): one more static panel button, rendered unconditionally at
    // construction and hidden by CSS class like .hud-campaign-open and the
    // Continue/New Game pair above it, so this fixture counts it without ever showing it.
    // It was 119 before that; it was 117 at issue #226, up 10 from 107, and that delta was the Main Menu and Settings
    // restructure rather than the kit growing. MEASURED at this fixture's state; the
    // arithmetic is recorded so the next change re-derives instead of adjusting a literal:
    //
    //   versus pane      42  = 17 option (mode 2 + players 3 + map 7 + stock 5)
    //                         + 9 role (3 slots x Human/Bot/Off)
    //                         + 9 team (3 slots x A/B/C -- issue #281)
    //                         + 6 difficulty (2 BOT slots x Easy/Normal/Hard, issue #267)
    //                         + 1 friendly-fire toggle (Teams-only)
    //   controllers      12  = 3 slots x [Keyboard/Bot/None + 1 detected pad]
    //   everything else  66  = the panels above (54 before issue #226, +10, +1, +1, +1, -2, +1)
    //
    // The +10, itemised: OUT go the topbar Mute chip, the Main Menu's Stats button and
    // its Achievements button (-3). IN come Records, Settings and About & Legal on the
    // menu (+3), the Records tab pair repeated in BOTH the Stats and Achievements panes
    // (+4), the Settings pane's Controllers and About & Legal entries (+2), and the Back
    // buttons of Settings and About plus the confirmation's two answers (+4).
    //
    // The first +1 is issue #289's motion toggle, the first control the Settings pane's
    // Accessibility section ever held; the second is issue #540's quality toggle, which
    // put a second one beside it; the third is issue #323's Choose Level, the outcome
    // panel's own second action; and the fourth is the same issue's Practice This Level,
    // which gives the mission-clear screen a second action of its own. 119 -> 120.
    //
    // Issue #243 adds FOUR: the Main Menu's Developer Tools entry, the persistent DEV
    // badge, and the pane's Exit and Back. 120 -> 124. All four are rendered by this
    // fixture regardless of the gate -- the markup is always built and the gate only
    // toggles `--hidden` modifiers -- so they are counted here whether or not a page is
    // in developer mode, which is what keeps this number a property of the MARKUP.
    //
    // Issue #627 adds ONE: vs-tri-01 (Keystone) gained `teams` alongside `ffa`, so the
    // map row this fixture renders -- `versusMapChoices(3, 'teams')`, since it clicks
    // THREE players and then Teams above -- offers 5 campaign boards + Keystone + Random
    // where it offered 6. 124 -> 125. The new button is the same
    // `.ui-btn.ui-selectable.hud-versus-option-btn` as the six beside it, so it is themed
    // by the rule they already share, and `unstyled` stays empty -- which is the check
    // this pin exists to prompt, performed rather than assumed.
    //
    // Note what moved this number: not a UI change at all, but a CURATION ruling about
    // one board's declared modes (issue #584's asymmetric-Teams policy, applied to
    // Keystone by #627). The map row is the one row in this pane whose population is
    // read from `versus-catalog.json` rather than from a fixed option list, so catalog
    // data edits land here. That is worth knowing before the next one.
    //
    // Issue #117 adds FIVE: one disclosure toggle per legal document in the About & Legal
    // pane -- Privacy, Credits, Third-party notices, Code licence, Content licence. 125 ->
    // 130. The population is `LEGAL_DOCUMENTS.length`, generated by `npm run legal` from the
    // five markdown files at the repository root, so this figure moves when a document is
    // ADDED to `LEGAL_SOURCES` in tools/legal/parse.mjs -- not when a document's text
    // changes. Each toggle is `.ui-btn.ui-btn--sm.hud-legal-toggle` and `unstyled` stays
    // empty, which is the check this pin exists to prompt, performed rather than assumed.
    //
    // What this sweep does NOT count, stated because it is a real hole rather than an
    // omission: the same pane's two outbound links are `<a class="ui-btn">`, and this
    // selector is `'button'`. They are measured against a bare `<a>` in their own case
    // below ("themes the two outbound legal links, which are anchors and not buttons"),
    // because an `.ui-btn` that is not a `<button>` is invisible to every sweep in this
    // file and #634 is the standing example of what an unswept control costs.
    //
    // Two of the versus figures move with the fixture's player count and one with how
    // many slots are BOTS, so a fixture that picked a different count pins a different
    // number -- which is the prompt to re-measure rather than to adjust the literal.
    // Issue #325 adds ONE: the match-failure alert's single dismiss action. Rendered
    // unconditionally at construction and hidden by `--hidden` exactly like the
    // confirmation's two answers beside it, so this fixture counts it without ever showing
    // it. 130 -> 131. It carries `.ui-btn--slab` like the confirmation's, so `unstyled`
    // stays empty -- the check this pin exists to prompt, performed rather than assumed.
    // Issue #227 adds ONE: the controller-rumble toggle, beside device haptics in the
    // Controls section. 131 -> 132. It is static markup rendered unconditionally at
    // construction -- per-device hiding is a `--hidden` class this fixture never applies, so
    // the figure is a property of the MARKUP and does not move with capabilities. It carries
    // `.ui-btn--sm` like its sibling, so `unstyled` stays empty -- the check this pin exists
    // to prompt, performed rather than assumed.
    // Issue #599 adds THREE more: the Developer Tools pane's Controller Self-Test entry, and
    // the self-test pane's own Copy Report and Back. 132 -> 135. All three are static markup
    // rendered unconditionally at construction and hidden by `--hidden` like the developer
    // shell's own four, so this fixture counts them whether or not a page is in developer
    // mode. Each carries `.ui-btn--slab`, so `unstyled` stays empty. The self-test's live pad
    // rows build NO buttons at all (they are `<li>`/`<span>`), so the figure does not move
    // with connected hardware.
    // Issue #246 adds the configuration menu, whose size is a property of `FLAG_REGISTRY`
    // rather than of any markup. The two static buttons are the Developer Tools entry and
    // the pane's own Back.
    // Issue #247 adds TWO: the Developer Tools pane's Copy Diagnostics and Pin Current
    // Seed. 135 -> 137. Static markup rendered unconditionally at construction like the developer
    // shell's other entries, so this fixture counts them whether or not a page is in
    // developer mode -- their `hidden` property tracks the `developerPage` option, which an
    // injected HUD in a test does not supply, and `hidden` is not what this sweep filters on.
    // Both carry `.ui-btn--slab`, so `unstyled` stays empty. The diagnostics FIELD is a
    // <textarea>, not a button, so it moves neither figure.
    // Issue #252 adds THREE: the Developer Tools pane's Restart with Same Seed, Reroll Seed
    // and Restart Current Round. 137 -> 140. Static markup rendered unconditionally at construction
    // like the developer shell's other entries, so this fixture counts all three whether or
    // not a session is live -- their `hidden` property tracks whether a round exists, and
    // `hidden` is not what this sweep filters on. Each carries `.ui-btn--slab` and
    // `.ui-btn--danger`, so `unstyled` stays empty and the size sweep is satisfied by the
    // modifier -- the checks these pins exist to prompt, performed rather than assumed.
    // Issue #249 adds TWO: the Developer Tools pane's Use Production Save and Reset Developer
    // Data. 140 -> 142. Static markup rendered unconditionally at construction like the developer
    // shell's other entries, so this fixture counts both whether or not a page is in developer
    // mode -- their `hidden` property tracks the injected seams and the active namespace, and
    // `hidden` is not what this sweep filters on. Both carry `.ui-btn--slab` and
    // `.ui-btn--danger`, so `unstyled` stays empty and the size sweep is satisfied by the
    // modifier. The NAMESPACE line is a <p>, not a button, so it moves neither figure.
    // Issue #685 adds ONE: the match-failure alert's Retry. 142 -> 143. Static markup rendered unconditionally
    // at construction, hidden by `.hud-alert-retry--hidden` until a caller hands over a retry, and
    // `hidden` is not what this sweep filters on. It carries `.ui-btn--slab`, so `unstyled` stays empty.
    // Issue #730 adds THREE: Developer Tools' Gallery Workbench entry and the workbench pane's
    // Developer Tools and Back. 143 -> 146. Static markup, counted whether or not the page binds the
    // workbench -- the entry's `hidden` tracks that, and `hidden` is not what this sweep filters on.
    // All three carry `.ui-btn--slab`, so `unstyled` stays empty. The pane BODY's Play and Copy Link
    // are built by `gallery-workbench.ts` only while the pane is open, so this fixture never sees them.
    // Issue #254 adds THREE: Developer Tools' Download Screenshot, Download Diagnostics and Download
    // Replay. 146 -> 149. Static markup, counted whether or not the page binds `developerDownloads`
    // -- their `hidden` tracks that, and `hidden` is not what this sweep filters on. All three carry
    // `.ui-btn--slab`, so `unstyled` stays empty.
    // Issue #754 adds TEN: Settings' Controller Layout entry and the layout pane's Back in the
    // markup, and the eight `controller-layout.ts` builds into the pane body AT CONSTRUCTION --
    // Sticks, the five action rows, Cancel and Reset to Recommended. 149 -> 159. Counted whether or
    // not a controller is painted; the body's `hidden` tracks that, and `hidden` is not what this
    // sweep filters on. The entry and the eight carry `.ui-btn--sm` and Back `.ui-btn--slab`, so
    // `unstyled` stays empty.
    expect(buttons.length).toBe(159 + 2 + devMenuButtons());
    expect(unstyled).toEqual([]);

    dispose();
  });

  it('gives the legal surface one left edge that does not move with a font size', () => {
    // A MEASURED regression, not a hypothetical. The shared measure was `72ch`, and `ch`
    // resolves against the element's OWN font: with the "Documents" heading at 18px and the
    // disclosure rows at the pane's 16px, one 72ch box came out 648px and the other 691px, so
    // the heading sat 22px right of the rows it introduces. Captured at 1280x800.
    //
    // Equality alone is not the guard -- all four elements carried the identical declaration.
    // Under jsdom 29 the computed value was the declared string and a unit regex was the
    // assertion; jsdom 30 resolves `rem`, `ch` and `em` to px, so that regex could no longer
    // match anything. What is asserted instead is the property itself: give every element,
    // and its parent, a font size nothing in hud.css uses, and require the measure not to
    // move. Probed on jsdom 30 before writing this: `72ch` and `40em` move (864px -> 1116px,
    // 960px -> 1240px on an <h2> taken to 31px), `43rem` and `688px` do not. Setting the
    // parent as well keeps this honest whether a unit resolves against the element's own
    // font or the one it inherits.
    const { root, dispose } = mountEveryButton();
    const selectors = ['.hud-about-subtitle', '.hud-about-subline', '.hud-about-links', '.hud-legal'];
    const elements = selectors.map((sel) => {
      const el = root.querySelector<HTMLElement>(sel);
      expect(el, `${sel} is not in the fixture`).not.toBeNull();
      return el!;
    });
    const widths = elements.map((el) => getComputedStyle(el).maxWidth);
    for (const [i, width] of widths.entries()) {
      expect(width, `${selectors[i]} takes a different measure from its siblings`).toBe(widths[0]);
    }
    for (const el of elements) {
      el.parentElement!.style.fontSize = '31px';
      el.style.fontSize = '31px';
    }
    for (const [i, el] of elements.entries()) {
      expect(
        getComputedStyle(el).maxWidth,
        `${selectors[i]} measures in an element-font-relative unit`,
      ).toBe(widths[i]);
    }
    // Non-vacuity: an empty string would satisfy both assertions above for every selector.
    expect(widths[0]).not.toBe('');
    expect(widths[0]).not.toBe('none');

    dispose();
  });

  it('gives every control in the kit a size: a modifier, or a rule of its own', () => {
    // Issue #634. `.ui-btn` is deliberately sizeless -- its own comment says so, and size
    // comes from a `--slab`/`--sm` modifier -- so a control carrying the primitive and
    // nothing else is themed, clickable, and renders with ZERO padding.
    // `.hud-versus-role-btn` shipped exactly that way: colour, border, radius and font all
    // correct, and a hit area the height of its own text, in a row whose other two controls
    // are `--sm`.
    //
    // WHY NEITHER EXISTING SWEEP CAUGHT IT, which is why this one is derived rather than listed:
    //  - "never lets a button fall through to browser default styling" measures the RESOLVED
    //    style against a bare <button>, and `.ui-btn` supplies colour, border, radius and
    //    font. The button did not look unstyled. It looked themed and was the wrong size.
    //  - "groups every button under a primitive" checks for `.ui-btn`, which was present.
    //  - The two shape-group cases walk HAND-MAINTAINED lists, and this control was never on
    //    one. A list cannot catch the control nobody remembered to add to it.
    //
    // WHY THIS IS A CLASS/STYLESHEET CHECK AND NOT A COMPUTED-PADDING ONE, measured rather
    // than assumed: jsdom DROPS a tokenised shorthand. Probed directly, `.hud-versus-map-card`
    // declares `padding: var(--hud-space-2)` and `getComputedStyle` reports `padding: "0"` --
    // identical to a bare `.ui-btn`, and not even recoverable through `resolved()`, since
    // there is no `var(...)` left to resolve. A computed-padding sweep would therefore
    // report every tokenised control as sizeless. `.hud-level-btn` is the other shape a
    // computed check gets wrong: it sizes with `width`/`height: var(--hud-control-min)`, a
    // 44px touch target rather than padding, and has a real hit area with no padding at all.
    //
    // So the question asked is the one issue #634 states: a size MODIFIER, or a rule of the
    // control's own. Both are valid ways to have a size, and neither is invisible here.
    const SIZE_MODIFIERS = ['ui-btn--slab', 'ui-btn--sm'];
    const ownRule = (cls: string): boolean =>
      new RegExp(`(^|[,\\s])\\.${cls}\\s*(,|\\{)`, 'm').test(stripComments(css));

    const { root, dispose } = mountEveryButton();
    const controls = Array.from(root.querySelectorAll<HTMLElement>('.ui-btn'));
    // Non-vacuity, and it is the denominator: a selector that matched nothing would make the
    // assertion below pass while measuring nothing. Exactly, not a floor, for the same reason
    // the button sweep above pins its own.
    // The denominator, DERIVED rather than counted once and pinned: 130 buttons in this
    // fixture (the sweep above pins that figure and itemises it), minus the 18 that
    // deliberately do not carry the primitive -- 11 colour swatches, 4 preview-rotate icon
    // buttons, and the pause/fire/mine driving controls, each named in
    // "groups every button under a primitive" -- leaves 112. Plus the 2 `<a class="ui-btn">`
    // outbound links in About & Legal, which are `.ui-btn` without being `<button>`, and
    // which are exactly the kind of control a `button`-only sweep misses.
    //
    //   135 - (11 + 4 + 1 + 1 + 1) + 2 = 119
    //
    // 131 since issue #325's match-failure dismiss button, 132 since issue #227's
    // controller-rumble toggle, and 135 since issue #599's three (the Developer Tools entry
    // plus the self-test pane's Copy Report and Back); the 18 non-primitives and the 2
    // anchors are unchanged by any of them.
    //
    // Non-vacuity as well as arithmetic: a selector that matched nothing would make the
    // assertion below pass while measuring nothing.
    // Issue #247 adds TWO: the Developer Tools pane's Copy Diagnostics and Pin Current
    // Seed. 119 -> 121. Static markup rendered unconditionally at construction like the developer
    // shell's other entries, so this fixture counts them whether or not a page is in
    // developer mode -- their `hidden` property tracks the `developerPage` option, which an
    // injected HUD in a test does not supply, and `hidden` is not what this sweep filters on.
    // Both carry `.ui-btn--slab`, so `unstyled` stays empty. The diagnostics FIELD is a
    // <textarea>, not a button, so it moves neither figure.
    // Issue #252 adds THREE: the Developer Tools pane's Restart with Same Seed, Reroll Seed
    // and Restart Current Round. 121 -> 124. Static markup rendered unconditionally at construction
    // like the developer shell's other entries, so this fixture counts all three whether or
    // not a session is live -- their `hidden` property tracks whether a round exists, and
    // `hidden` is not what this sweep filters on. Each carries `.ui-btn--slab` and
    // `.ui-btn--danger`, so `unstyled` stays empty and the size sweep is satisfied by the
    // modifier -- the checks these pins exist to prompt, performed rather than assumed.
    // Issue #249 adds TWO: the Developer Tools pane's Use Production Save and Reset Developer
    // Data. 124 -> 126. Static markup rendered unconditionally at construction like the developer
    // shell's other entries, so this fixture counts both whether or not a page is in developer
    // mode -- their `hidden` property tracks the injected seams and the active namespace, and
    // `hidden` is not what this sweep filters on. Both carry `.ui-btn--slab` and
    // `.ui-btn--danger`, so `unstyled` stays empty and the size sweep is satisfied by the
    // modifier. The NAMESPACE line is a <p>, not a button, so it moves neither figure.
    // Issue #685 adds ONE: the match-failure alert's Retry. 126 -> 127. Static markup rendered unconditionally
    // at construction, hidden by `.hud-alert-retry--hidden` until a caller hands over a retry, and
    // `hidden` is not what this sweep filters on. It carries `.ui-btn--slab`, so `unstyled` stays empty.
    // Issue #730 adds THREE, the same three as the button sweep above: 127 -> 130, each sized by
    // `.ui-btn--slab`.
    // Issue #254 adds THREE, the same three as the button sweep above: 130 -> 133, each sized by
    // `.ui-btn--slab`.
    // Issue #754 adds TEN, the same ten as the button sweep above: 133 -> 143, nine sized by
    // `.ui-btn--sm` and the pane's Back by `.ui-btn--slab`.
    expect(controls.length).toBe(143 + 2 + devMenuButtons());

    const sizeless = controls
      .filter((el) => {
        const classes = Array.from(el.classList);
        if (classes.some((c) => SIZE_MODIFIERS.includes(c))) return false;
        return !classes.some((c) => c !== 'ui-btn' && c !== 'ui-selectable' && ownRule(c));
      })
      .map((el) => Array.from(el.classList).join('.'));
    expect(sizeless, 'an .ui-btn with no size: themed, clickable, and no hit area').toEqual([]);

    // The control on the control: the rule-lookup must be capable of saying NO, or the filter
    // above passes for every control whatever the stylesheet says.
    expect(ownRule('hud-level-btn'), 'the rule lookup cannot find a rule that exists').toBe(true);
    expect(ownRule('hud-no-such-control'), 'the rule lookup finds a rule that does not exist').toBe(
      false,
    );

    dispose();
  });

  it('themes the two outbound legal links, which are anchors and not buttons', () => {
    // The sweep above selects `'button'`, so the About & Legal pane's two `<a class="ui-btn">`
    // links are outside it -- and an `.ui-btn` that no sweep in this file reaches is exactly
    // #634's defect ("the class is a handle with nothing behind it"), one tag name further
    // out. Measured the same way, against a BARE ANCHOR rather than a bare button, because
    // the browser's own link treatment (blue, underlined) is what falls through here, and a
    // bare `<button>` would not report it.
    const { root, dispose } = mountEveryButton();
    const bare = document.createElement('a');
    bare.href = 'https://example.com';
    document.body.appendChild(bare);

    const links = Array.from(root.querySelectorAll<HTMLAnchorElement>('.hud-legal-link'));
    // Non-vacuity: `LEGAL_LINKS` is generated, and a sweep over an empty list passes while
    // measuring nothing. Two today -- the project site and the repository the privacy
    // policy sends questions to.
    expect(links.length).toBe(2);
    for (const link of links) {
      expect(link.tagName, 'an outbound destination is a link, not a button').toBe('A');
      // `cursor` is dropped from THEMED_PROPS here and nowhere else: a bare `<a href>`
      // ALREADY resolves to `pointer`, so matching the bare anchor on that property is
      // agreement rather than fall-through, and including it would fail this case for a
      // perfectly themed link. What remains -- background, colour, radius -- is measured.
      const props = THEMED_PROPS.filter((p) => p !== 'cursor');
      const bareProps = props.filter((p) => resolved(link, p) === resolved(bare, p));
      expect(bareProps, `${link.className} falls through to the browser's own link style`).toEqual(
        [],
      );
    }
    // THE UNDERLINE IS CHECKED IN THE TEXT, not in the cascade, and the reason is a
    // measured jsdom limitation rather than a preference: probed directly, a bare `<a href>`
    // and a `.hud-legal-link` BOTH report `textDecoration: 'underline'` and BOTH report
    // `textDecorationLine: 'none'` -- jsdom applies neither the shorthand nor the longhand
    // for this property, so a computed-style assertion on it is vacuous in exactly the way
    // `resolved`'s own header warns about. This substring is the only route that fails when
    // the declaration is deleted.
    expect(css).toContain('text-decoration-line: none');

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
    const panel = ['hud-records-open', 'hud-settings-open', 'hud-customize-open', 'hud-levelselect-open',
      // Issue #323's Choose Level joined the same group rule; measured with its siblings
      // so a tidy-up that drops it from the selector list shows up as a size change here
      // rather than as an untested button that merely still looks themed.
      'hud-choose-level'];
    const back = ['hud-stats-back', 'hud-customize-back', 'hud-achievements-back',
      'hud-levelselect-back', 'hud-settings-back', 'hud-about-back'];

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
      // `hud-mute` left this list with issue #226: the topbar's yellow state chip is
      // gone, and the Settings button that replaced it is an ordinary `.ui-btn--sm`.
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
    const slab = ['.hud-quit', '.hud-records-open', '.hud-settings-open',
      '.hud-customize-open', '.hud-levelselect-open', '.hud-controllers-open',
      '.hud-versus-open', '.hud-campaign-open', '.hud-stats-back', '.hud-customize-back',
      '.hud-achievements-back', '.hud-levelselect-back', '.hud-controllers-back',
      '.hud-versus-back', '.hud-settings-back', '.hud-about-back',
      '.hud-confirm-accept', '.hud-confirm-cancel'];
    // The reset pair moved here from the slab list with issue #226: they are two controls
    // in the Settings -> Data row now, not two buttons stacked under a Stats heading, and
    // a row lays out `--sm`. The About & Legal footer entry is `--sm` for the opposite
    // reason -- it is the quietest thing on the Main Menu and must not read as a peer of
    // the utility slabs above it.
    const small = ['.hud-settings-mute', '.hud-scheme-toggle', '.hud-firemode-toggle',
      '.hud-haptics-toggle', '.hud-motion-toggle', '.hud-quality-toggle',
      '.hud-versus-friendlyfire-btn', '.hud-settings-controllers',
      '.hud-settings-about', '.hud-about-open', '.hud-records-tab-stats',
      '.hud-records-tab-achievements', '.hud-reset-stats', '.hud-reset-progress',
      // Issue #117's two: a document disclosure and an outbound link, both `--sm` because
      // both lay out in a row inside a pane rather than stacking as panel slabs. Listed here
      // because this population is a hand-maintained list, not a sweep -- a `--sm` control
      // left off it is silently outside the one guard that says the modifier means one shape,
      // which is #634's defect with the class present and the RULE overriding it.
      // `.hud-legal-link` is an `<a>`, and `shape()` reads a selector rather than a tag, so
      // it belongs in the same list as the buttons it sits beside.
      '.hud-legal-toggle', '.hud-legal-link',
      // Issue #634's control, and the two it sits beside in the same slot row. The sweep
      // above says each HAS a size; these three say they have the SAME size, which is what
      // "matching its siblings in the pane" means and what a bespoke rule duplicating
      // `--sm`'s padding would have quietly failed to guarantee. The team and difficulty
      // buttons were `--sm` all along and were simply never listed -- the same omission that
      // let the role button ship sizeless, one step less harmful.
      '.hud-versus-role-btn', '.hud-versus-team-btn', '.hud-versus-difficulty-btn'];
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

  it('lets every control row wrap, since four controls do not fit a phone width', () => {
    // Review measured this in real chromium at hud.css's own named phone widths, on the
    // panel settings row these replaced: four controls fit 393px exactly (rowWidth
    // 393.0); adding a fifth made it 448.5, clipped at both edges and unpannable under
    // the body's overflow:hidden + the panel's touch-action: pan-y. `flex-wrap: wrap` is
    // what folds it instead.
    //
    // THREE rows since issue #226, not one: the Settings pane's control rows (Controls
    // carries four), and the Main Menu's own play and utility regions. All three lay
    // buttons out in a line inside the same clipped body, so all three need the same
    // declaration -- and asserting them together is what stops a new region shipping
    // without it.
    for (const cls of ['hud-settings-controls', 'hud-menu-play', 'hud-menu-utilities']) {
      const row = document.createElement('div');
      row.className = cls;
      document.body.appendChild(row);
      expect(getComputedStyle(row).flexWrap, cls).toBe('wrap');
    }
    document.body.innerHTML = '';
  });

  it('sizes every Main Menu row button from its row width variable (issue #706)', () => {
    // `menu-row-width.ts` measures the widest button and sets `--hud-menu-col` on the row;
    // this is the half that makes the buttons USE it. Read through `resolved()`, because jsdom
    // reports the literal `var(...)` otherwise. Negative control: without the rule every
    // button keeps its label's width, which is the ragged row the issue measured.
    for (const cls of ['hud-menu-play', 'hud-menu-utilities']) {
      const row = document.createElement('div');
      row.className = cls;
      row.style.setProperty('--hud-menu-col', '143px');
      const button = document.createElement('button');
      button.className = 'ui-btn ui-btn--slab';
      row.appendChild(button);
      document.body.appendChild(row);
      expect(resolved(button, 'width'), cls).toBe('143px');
    }
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
    // A definite width is set on the versus container and none on the standalone panel's
    // row, which has no width rule at all and reports the browser default `auto`. Without
    // this container's own definite width, the row rule below folds unevenly well above
    // the 760px breakpoint -- measured directly in Chromium at 700px with 2 slots, before
    // this existed: fit-content resolved the container narrower than the viewport and the
    // pair stacked into ONE column instead of sitting side by side. See the scoped rule's
    // own comment in hud.css.
    //
    // jsdom 29 kept `92vw` verbatim; jsdom 30 resolves `vw` against its own window, so the
    // expected value is DERIVED from `window.innerWidth` rather than pinned as `942.08px`,
    // which would pin this harness's 1024px window instead of the stylesheet. Still fails
    // if the declaration is deleted (`auto`) or retuned to any other viewport fraction.
    expect(controllersStyle.width).toBe('auto');
    expect(versusStyle.width).toMatch(/^[\d.]+px$/);
    expect(parseFloat(versusStyle.width)).toBeCloseTo((92 * window.innerWidth) / 100, 2);

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

  it('holds every map card to one height: every intent tier clamps and reserves the SAME number of lines', () => {
    // The owner report this answers: "the teams unavailable copy changes the size of the map
    // selection previews when it shouldn't". The note was not the cause -- toggling it alone
    // was measured in Chromium to move nothing. Grid rows are equal-height and a card's
    // height follows how far its intent wraps, so swapping which boards a row offers resized
    // the cards beside them (122.4px at two players, 140.1px at three, at 1280x800).
    //
    // A TEXT assertion, for the reason the who's-playing case gives: jsdom's window is a
    // fixed 1024px and never matches a media query, and jsdom has no layout, so neither the
    // tiers nor the resulting heights can be computed here. Measured in real Chromium
    // instead -- every card one height per viewport, identical at two, three and four
    // players, and zero cards clipping at 414 / 393 / 375 / 360 / 352 / 344 / 320.
    //
    // What this pins is the AGREEMENT, tier by tier, because that is the half a future edit
    // breaks silently: the clamp caps a long intent and the min-height floors a short one,
    // and they have to name the same number of lines. A clamp of 4 against a reserve of 2
    // would leave a three-line card shorter than its neighbours while still looking like a
    // clamp is in place.
    const src = stripComments(css);

    const tiers: { clamp: number; reserve: number }[] = [];
    for (let i = src.indexOf('.hud-versus-map-intent {'); i !== -1;
         i = src.indexOf('.hud-versus-map-intent {', i + 1)) {
      const block = src.slice(i, src.indexOf('}', i));
      const clamp = /-webkit-line-clamp:\s*(\d+)/.exec(block);
      const reserve = /min-height:\s*calc\(1\.35em\s*\*\s*(\d+)\)/.exec(block);
      expect(clamp, `tier ${tiers.length}: lost the line clamp`).not.toBeNull();
      expect(reserve, `tier ${tiers.length}: lost the reserved height`).not.toBeNull();
      // The standard property beside the prefixed one, so no tier depends on a vendor prefix.
      expect(block, `tier ${tiers.length}: lost the unprefixed line-clamp`)
        .toMatch(/[^-]line-clamp:\s*\d+/);
      tiers.push({ clamp: Number(clamp![1]), reserve: Number(reserve![1]) });
    }

    for (const [i, t] of tiers.entries()) {
      expect(t.clamp, `tier ${i} clamps and reserves different line counts`).toBe(t.reserve);
    }

    // THREE tiers, and the sequence is NOT monotonic -- that is the rule, not an oversight.
    // The line count tracks the TEXT COLUMN beside the 74px canvas, which jumps when the card
    // layout changes rather than sliding with the viewport: 138px in a 240px desktop grid
    // column, 288px in the single full-width column below 760px, and 218px once the viewport
    // itself is narrow enough to squeeze that. Sorting these numbers would break what they
    // encode. Each was measured, not chosen.
    expect(tiers.map((t) => t.clamp), 'the intent tiers changed').toEqual([4, 2, 3]);

    // The narrowest tier exists because the middle one was derived on a 390px phone and
    // shipped: at 320px the column is 218px and four of seven cards clipped, each needing
    // 45px of intent with 30 available.
    const narrowest = src.lastIndexOf('.hud-versus-map-intent {');
    const query = src.lastIndexOf('@media (max-width:', narrowest);
    expect(query, 'the narrowest intent rule is not inside a media query').toBeGreaterThan(-1);
    expect(src.slice(query, narrowest), 'the narrowest tier is not the 340px one')
      .toMatch(/@media \(max-width: 340px\)/);
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

  /**
   * The three focus-visible cases above assert that a ring EXISTS -- each looks for
   * `outline:` inside a block. None of them can see what the ring is made of, because
   * every one of them resolves to the same three tokens, so a ring narrowed to 1px or
   * recoloured to something that disappears against the pane would leave all three green
   * (issue #921).
   *
   * The direction fixes both: "2-3 px high-contrast outer ring with offset, never
   * indicated by color change alone" (2026-08-23-ui-ux-direction.md, section 6). 2px sits
   * at the bottom of that range, so moving to 3px is a deliberate edit here and in the
   * stylesheet together; 1px is out of the range entirely, and 0 offset makes it an inner
   * ring rather than the outer one the direction asks for.
   *
   * TEXT, like every other focus assertion in this file and for the reason stated on the
   * generic case: jsdom does not recompute a dynamic pseudo-class, so a computed-style
   * read would report every focus-visible rule here as absent whether it is wired or not.
   */
  it('pins what the focus ring is made of, not only that there is one', () => {
    const src = stripComments(css);
    expect(src, 'the focus width token is gone or is no longer 2px')
      .toMatch(/--hud-focus-width:\s*2px\s*;/);
    expect(src, 'the focus colour token is gone or is no longer the light blue')
      .toMatch(/--hud-focus-color:\s*#7fd0ff\s*;/i);
    expect(src, 'the focus offset token is gone or is no longer 2px')
      .toMatch(/--hud-focus-offset:\s*2px\s*;/);

    // ...and the tokens must still be what the rings are drawn FROM. Pinning the values
    // while a rule hard-codes `outline: 1px solid grey` beside them would be a guard on
    // three declarations nothing reads.
    expect(src, 'no rule draws its outline from the focus tokens').toContain(
      'outline: var(--hud-focus-width) solid var(--hud-focus-color);',
    );
    expect(src, 'no rule offsets its outline from the focus token').toContain(
      'outline-offset: var(--hud-focus-offset);',
    );
  });

  /**
   * Issue #957, out of #633's audit. `--hud-control-touch` is the 56px floor for the
   * ON-SCREEN DRIVING CONTROLS, and it is a different number from the 44px menu floor
   * `--hud-control-min` sets, because these three sit at the screen edge under a thumb.
   *
   * NOTHING ASSERTED IT, and nothing could. `hit-sweep.mjs` skips `.hud-touch` by rule --
   * correctly, since 44 is the wrong number for these -- and until `screen.practice.touch`
   * landed beside this, no catalogue state put the controls on a screen at all. So the
   * token could have been lowered, or the three rules could have stopped reading it, with
   * every required check green.
   *
   * The floor holds today: measured in a touch context on a live round, 56x56, 66.2x56 and
   * 69.5x56 at 320x568, 390x844 and 640x400@2x, all fully on screen. This is the guard, not
   * the fix.
   *
   * TEXT, like the focus case above and for the reason this file's own doc comment gives:
   * jsdom resolves a tokenised property to the literal `var(...)` string, so a
   * computed-style read here would measure nothing.
   */
  it('keeps the driving controls on their own 56px floor, separate from the menu one', () => {
    const src = stripComments(css);
    expect(src, 'the driving-control token is gone or is no longer 56px')
      .toMatch(/--hud-control-touch:\s*56px\s*;/);
    // ...and it is not quietly the same number as the menu floor, which is what a later
    // tidy-up would most likely do to it.
    expect(src, 'the menu floor moved off 44px').toMatch(/--hud-control-min:\s*44px\s*;/);

    // The controls must still take their size FROM the token. Pinning the value while a rule
    // hard-codes 44px beside it would guard a declaration nothing reads -- the same trap the
    // focus case above names.
    //
    // FOUND BY SCANNING every rule that reads the token, not by matching the first block with
    // this selector list. There are two such blocks -- one sets `pointer-events: auto` and the
    // sizing one comes 25 lines later -- and a first-match regex asserted against the wrong
    // one, which is how this test first failed.
    const sizing = [...src.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .map((m) => ({ selector: m[1].trim(), body: m[2] }))
      .filter(({ body }) => body.includes('var(--hud-control-touch)'));
    expect(sizing.length, 'no rule sizes anything from the driving-control floor').toBeGreaterThan(0);
    for (const { selector, body } of sizing) {
      expect(body, `${selector} reads the touch floor but not for its width`)
        .toMatch(/min-width:\s*var\(--hud-control-touch\)\s*;/);
      expect(body, `${selector} reads the touch floor but not for its height`)
        .toMatch(/min-height:\s*var\(--hud-control-touch\)\s*;/);
      for (const control of ['.hud-pause-btn', '.hud-fire-btn', '.hud-mine-btn']) {
        expect(selector, `${control} is no longer sized by the touch floor`).toContain(control);
      }
    }
  });

  it('keeps the narrow-viewport rules the phone layout needs', () => {
    // Measured on a 393px-wide phone before this existed: the volume slider ran 35px
    // PAST the viewport edge and the topbar wrapped to 72px tall, eating the top of the
    // board. After, across four shapes: 320x568 36px/-10, 393x727 40px/-12,
    // 727x393 (landscape) 40px/-12, 820x1180 51px/-20 -- nothing clipped anywhere.
    //
    // The slider and the mute chip are no longer IN this bar (issue #226 moved both to
    // Settings), so the two selectors that sized them here are gone with them. What is
    // left is what the bar still carries: its own padding and gap, and the stat text.
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
    for (const sel of ['.hud-topbar', '.hud-stat']) {
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

  it('places the toast rail and capacity flash from the topbar row, not a guessed height', () => {
    // Issue #687. jsdom lays nothing out, so where these land is measured in a real browser:
    // `tools/visual/verify.mjs`'s clearance pass, five viewports with and without a 59px top
    // inset, which failed all five inset cases against the old `top: 64px` / `top: 56px`.
    // What this guards is the structure that pass relies on, in the file a CSS edit touches:
    // take any of these away and an overlay's `top` stops being a distance below the bar.
    const src = stripComments(css);
    const rule = (sel: string): string => {
      const at = src.search(new RegExp(`(^|\\n)${sel.replace(/[.~]/g, '\\$&')} \\{`));
      expect(at, `no ${sel} rule`).toBeGreaterThan(-1);
      return src.slice(at, src.indexOf('}', at));
    };
    const hud = rule('.hud');
    expect(hud, 'the HUD root is not a grid').toMatch(/display:\s*grid;/);
    expect(hud, 'the topbar row is not sized by the topbar').toMatch(/grid-template-rows:\s*auto\s/);
    const topbar = rule('.hud-topbar');
    expect(topbar).toMatch(/grid-row:\s*1;/);
    // An absolutely positioned bar leaves row 1 empty, and both overlays slide under it.
    expect(topbar, 'the topbar is out of flow, so it sizes no row').not.toMatch(/position:\s*absolute/);
    for (const overlay of ['.hud-toasts', '.hud-capacity']) {
      expect(rule(overlay), `${overlay} is not placed under the topbar row`).toMatch(/grid-row:\s*2;/);
    }
    // Issue #702: in landscape the board starts under the bar (y 48 under a 52px bar at
    // 844x390), so under the bar is on the arena. The flash moves up into the bar's row there.
    const landscape = src.match(/@media \(orientation: landscape\) \{\s*\.hud-capacity \{([^}]*)\}/);
    expect(landscape, 'no landscape rule moves the capacity flash into the topbar row').not.toBeNull();
    // Both lines: an absolutely positioned child's `auto` end line is the grid's padding edge,
    // so `grid-row: 1` alone spans the whole HUD and centres the flash on the board.
    expect(landscape?.[1], 'the landscape flash is not confined to the topbar row').toMatch(
      /grid-row:\s*1\s*\/\s*2;/,
    );
    // With the bar hidden, row 2 starts at the display edge, where a cutout still is.
    expect(rule('.hud-topbar--hidden ~ .hud-toasts')).toMatch(
      /top:\s*max\(var\(--hud-safe-inset\),\s*env\(safe-area-inset-top\)\);/,
    );
  });
});

/*
 * The Practice identity chip's one visual claim (issue #324, step S6).
 *
 * The chip exists because a Practice topbar and a Campaign topbar were byte-identical
 * before it -- measured, on the built app, at every captured viewport width. A chip that
 * matched `.hud-stat` exactly would leave them very nearly identical again, so what is
 * asserted is the DIFFERENCE from its neighbours rather than a literal value: same row,
 * different weight and a ground of its own.
 *
 * The weight is read through `resolved()`, never `getComputedStyle` directly, because it
 * is a token. Measured in this jsdom, before writing the case: the raw longhand comes
 * back as the literal string "var(--hud-weight-strong)", and `Number()` of that is NaN --
 * so every numeric comparison against it is false whatever the stylesheet says. The
 * background needs no such help (jsdom resolves the literal rgba pair, measured as
 * "rgba(255, 255, 255, 0.14)" against `.hud-stat`'s "rgba(0, 0, 0, 0)"), and it is read
 * through the same helper only so both halves of the case read the same way.
 */
describe('hud.css: a column header is not a row header (issue #629)', () => {
  /*
   * A REGRESSION THIS SUITE LET THROUGH ONCE, which is why it is pinned here rather than
   * left to a picture.
   *
   * Both data tables shipped their column headers as <td>. Issue #629 made them
   * <th scope="col"> so they actually head their columns -- as <td> they named nothing and
   * every figure beneath them was announced bare. But each table already had a `th` rule,
   * written for the ROW headers: left-aligned, its own padding, heavier, dimmed. Applying
   * that to a column header pulled "Lifetime" and "Level attempt" out of alignment with
   * the numerals underneath them.
   *
   * Nothing caught it. The unit suite passed, the mutation sweep passed, and the visual
   * gate passed -- it photographs the ARENA, not the Records pane. It was found by
   * diffing a before/after capture, and the diff is a thing a person has to remember to
   * do; this assertion is not.
   *
   * So the contract is stated by POSITION rather than by tag: a row header is left-flush
   * against the labels it belongs to, a column header sits right-flush over its numerals,
   * exactly as the <td> it replaced did. An accessibility fix to a shipped layout should
   * be invisible on screen, and "invisible" is checkable.
   */
  const TABLES = [
    { table: '.hud-stats-table', label: 'stats' },
    { table: '.hud-versus-results', label: 'versus results' },
  ] as const;

  it('aligns every column header with the data column it heads', () => {
    for (const { table, label } of TABLES) {
      const head = document.createElement('table');
      head.className = table.slice(1);
      head.innerHTML =
        '<thead><tr><td></td><th scope="col">Col</th></tr></thead>'
        + '<tbody><tr><th scope="row">Row</th><td>1</td></tr></tbody>';
      document.body.appendChild(head);
      const colHead = head.querySelector('thead th') as HTMLElement;
      const rowHead = head.querySelector('tbody th') as HTMLElement;
      const dataCell = head.querySelector('tbody td') as HTMLElement;

      expect(resolved(colHead, 'textAlign'), `${label}: column header alignment`)
        .toBe(resolved(dataCell, 'textAlign'));
      expect(resolved(colHead, 'paddingLeft'), `${label}: column header padding`)
        .toBe(resolved(dataCell, 'paddingLeft'));
      // The negative control. Without it every assertion above is satisfied by deleting
      // the row-header rule and letting all three cells share one look, which would trade
      // this regression for a different one.
      expect(resolved(rowHead, 'textAlign'), `${label}: row header still reads left`)
        .not.toBe(resolved(dataCell, 'textAlign'));
      head.remove();
    }
  });
});

describe('hud.css: the Practice chip reads as an identity, not a fourth stat', () => {
  it('carries a heavier weight and a ground its neighbours do not, live', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const hud = createHud(root);
    try {
      const chip = root.querySelector('.hud-practice') as HTMLElement;
      const stat = root.querySelector('.hud-campaign-stat') as HTMLElement;
      expect(chip, 'the topbar has no Practice chip').not.toBeNull();
      // Vacuity guard: both sides must resolve to a real weight, or the inequality below
      // is comparing two empty strings.
      expect(resolved(stat, 'fontWeight')).toMatch(/^\d+$/);
      expect(resolved(chip, 'fontWeight')).toMatch(/^\d+$/);
      expect(
        Number(resolved(chip, 'fontWeight')),
        'the chip is no heavier than the readings beside it',
      ).toBeGreaterThan(Number(resolved(stat, 'fontWeight')));
      // ...and a ground, which is what makes it read as a badge rather than as a word in
      // the row. `.hud-stat` sets none, so this is the one property that separates them
      // even in a forced-colours palette that flattens the weight.
      expect(resolved(chip, 'backgroundColor')).not.toBe(resolved(stat, 'backgroundColor'));
      expect(resolved(chip, 'backgroundColor')).not.toBe('');
    } finally {
      hud.dispose();
      root.remove();
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
describe('hud.css: every animation answers to the resolved motion policy (issue #631)', () => {
  /*
   * THE GUARD THAT LETS THIS ROT, closed.
   *
   * Before this, the only assertion about reduced motion in the whole suite was an
   * EXCLUSION -- menu-transition.test.ts checking that transitions were NOT restated for
   * the media query. Nothing said what the reduced-motion rules must CONTAIN, so an
   * animation added tomorrow was outside them by default and no test objected. Three
   * already were: `hud-aimdot-fire`, `hud-toast-in` and `hud-count-pop` ran at full
   * strength for every player whatever either preference said, and neither the media query
   * nor the resolved policy touched them.
   *
   * So this sweeps the population instead: every rule that starts an animation must either
   * be answered under `.hud--reduced-motion` or be named below with a reason. Same shape as
   * the button-primitive sweep above -- a new member has to be argued for in the exception
   * list rather than joining by omission.
   *
   * IT READS THE STYLESHEET TEXT, NOT COMPUTED STYLE, and that is not laziness. jsdom
   * applies no `@media` rules to computed style at all and resolves a keyframe name held in
   * a custom property to the literal `var(...)` string on every element -- both measured
   * while writing this. A `getComputedStyle` version of this test would have passed on the
   * broken stylesheet, which is the failure mode it exists to prevent.
   */
  const text = stripComments(css);

  /** Selectors that start an animation, paired with the animation they start. */
  function animationSites(): { selector: string; name: string }[] {
    const out: { selector: string; name: string }[] = [];
    for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = m[1].trim();
      if (selector.startsWith('@') || selector.includes('%')) continue;
      // A rule UNDER the motion class is the answer, not another question. Without this
      // the sweep reports its own fixes as gaps -- which it did on the first run, and is
      // worth keeping as a comment because the shape recurs: a population scan that also
      // matches the remedy will always look unfixable.
      if (selector.includes('hud--reduced-motion')) continue;
      const decl = /(?:^|;)\s*animation(?:-name)?\s*:\s*([^;]+)/.exec(m[2]);
      if (!decl) continue;
      const value = decl[1].trim();
      if (value === 'none') continue;
      const name = value.split(/\s+/).find((t) => /^[a-z][\w-]*$/i.test(t) && t !== 'none');
      if (name) out.push({ selector, name });
    }
    return out;
  }

  it('finds the animation population it is about', () => {
    // Vacuity guard. Every assertion below is a filter over this list, and all of them pass
    // trivially on an empty one -- which a regex that stopped matching would quietly give.
    const sites = animationSites();
    expect(sites.length, 'no animation sites parsed out of hud.css').toBeGreaterThan(6);
    expect(sites.some((s) => s.selector.includes('hud-count--pop'))).toBe(true);
  });

  it('answers every animation under the resolved policy, or names it as an exception', () => {
    // Handled by DURATION rather than by selector: `transitionMs()` returns 0 under the
    // resolved policy, and at 0 the entering class is added and removed inside one task, so
    // these keyframes never run. Their own comments in hud.css set this out at length
    // (issue #364), and restating them here would be the second place to keep in step.
    const EXCEPTIONS = [
      'ui-surface--entering',
      'ui-surface--leaving',
      'hud--menu-transition-',
    ];
    const answered = new Set(
      [...text.matchAll(/\.hud--reduced-motion\s+([^{,]+)\{/g)]
        .map((m) => m[1].trim().replace(/^\./, '').split(/[\s:>]/)[0]),
    );
    const unanswered = animationSites()
      .filter(({ selector }) => !EXCEPTIONS.some((e) => selector.includes(e)))
      .filter(({ selector }) => {
        const cls = selector.replace(/^\./, '').split(/[\s:>,]/)[0];
        return !answered.has(cls);
      })
      .map(({ selector, name }) => `${selector} -> ${name}`);
    expect(unanswered, 'animations no motion preference can reach').toEqual([]);
  });

  it('never answers an animation by cancelling a cue that rests invisible', () => {
    // `.hud-capacity` and `.hud-count` sit at `opacity: 0` between plays, so `animation:
    // none` on them does not calm the cue -- it deletes it. Both are redefined to a
    // motionless keyframe set instead, keeping the opacity ramp that IS the message. The
    // shipped stylesheet got this right for the capacity flash and its comment says why;
    // this makes it a rule rather than a habit.
    for (const cls of ['hud-capacity--flash', 'hud-count--pop']) {
      const rule = new RegExp(`\\.hud--reduced-motion\\s+\\.${cls}\\s*\\{([^}]*)\\}`).exec(text);
      expect(rule, `${cls} has no reduced-motion answer`).not.toBeNull();
      expect(rule![1], `${cls} is cancelled, so the cue never appears at all`)
        .not.toMatch(/animation\s*:\s*none/);
      expect(rule![1], `${cls} does not select a motionless keyframe set`)
        .toMatch(/animation-name\s*:\s*[\w-]+--still/);
    }
  });

  it('defines every --still keyframe set it selects', () => {
    // The failure this catches is silent: an `animation-name` pointing at a keyframe set
    // that does not exist leaves the element with NO animation, which for `.hud-capacity`
    // and `.hud-count` means an invisible cue rather than a still one.
    const selected = [...text.matchAll(/animation-name\s*:\s*([\w-]+--still)/g)].map((m) => m[1]);
    expect(selected.length, 'no motionless keyframe sets are selected').toBeGreaterThan(1);
    for (const name of selected) {
      expect(text, `@keyframes ${name} is selected but never defined`)
        .toContain(`@keyframes ${name}`);
    }
  });
});

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

  it('declares the duration and the easing in named places only, and nowhere as a literal', () => {
    // "No screen has its own copy" is a claim about the whole stylesheet, which the live
    // check above cannot make -- it only looks at the two rules it already knows about.
    //
    // WHY THIS IS NO LONGER A BARE COUNT OF ONE. Issue #542's `fade-long` is a selectable
    // alternative whose entire content is a longer duration, so it has to declare one.
    // Counting declarations would have forced that number into TypeScript instead, which
    // is precisely the drift issue #364's first criterion forbids. So the check moved from
    // HOW MANY to WHERE: the base declaration, plus every rule allowed to move it, named
    // exactly. A screen that gives itself a copy still fails, and so does an alternative
    // nobody listed here.
    const text = stripComments(css);
    /** Every `selector { ... }` block's selector text, for the blocks declaring `token`. */
    const declaringSelectors = (token: string): string[] => {
      const out: string[] = [];
      // Innermost blocks only, which is what `[^{}]*` on both sides buys: an `@media` or
      // `@keyframes` wrapper can never match as the selector of a body containing braces,
      // so a nested rule is attributed to its own selector rather than to its wrapper.
      for (const [, selector, body] of text.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
        if (new RegExp(`${token}\\s*:`).test(body)) out.push(selector.trim());
      }
      return out;
    };
    expect(declaringSelectors('--ui-transition-ease'), 'the easing has one home').toEqual([
      ':root',
    ]);
    // The base, then the ONE alternative whose whole content is the duration. The shipped
    // transition is absent from this list because it declares nothing -- it lifts the
    // entering content at the base value, which is what "the default has no rule of its
    // own" means here -- and `settle` is absent because it moves at that same value. Only
    // `fade-long` touches the clock, which is what keeps it separable from the movements.
    expect(declaringSelectors('--ui-transition-duration')).toEqual([
      ':root',
      '.hud--menu-transition-fade-long',
    ]);
    // Vacuity guard: the scanner really does find declarations, and really does reject a
    // selector it was not told about. Without this, a regex that matched nothing would
    // make both assertions above pass against an empty list.
    expect(declaringSelectors('--ui-transition-duration').length).toBeGreaterThan(1);
    expect(declaringSelectors('--no-such-token-anywhere')).toEqual([]);
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
      // `.hud-menu-play` since issue #226, which retired `.hud-panel-settings`. Any
      // descendant of the panel that sets `pointer-events: auto` for itself will do; this
      // is the Main Menu's play region, and it is the control the measured Playwright
      // failure would land on today.
      const settings = root.querySelector('.hud-menu-play') as HTMLElement;
      expect(settings, 'fixture drifted: no descendant with its own pointer-events').not.toBeNull();

      // NEGATIVE CONTROL: with the surface not leaving, the descendant is clickable --
      // otherwise this test would pass against a stylesheet that disabled it always.
      expect(getComputedStyle(settings).pointerEvents, 'control: the region should be clickable').toBe('auto');

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
    // No exceptions. `.hud-rotate-btn:hover` predated #392 and was the one permitted stray
    // until #633 moved it inside the query; the list is empty now, so any unguarded rule,
    // including that one returning, is a failure.
    expect(stray.map((s) => s.replace(/\s*\{$/, ''))).toEqual([]);
  });

  it('keeps the rotate buttons\' hover behind the pointer query, and their press outside it (issue #633)', () => {
    // The rotate buttons are hold-to-repeat touch controls, so a hover left unguarded
    // sticks on the last one tapped. Negative controls: moving the hover rule back out of
    // the block fails the first assertion; moving `:active` into it fails the second,
    // and a press would stop showing on touch.
    const block = hoverBlock();
    expect(block).toContain('.hud-rotate-btn:hover:not(:disabled)');
    expect(block).not.toContain('.hud-rotate-btn:active');
    expect(src.replace(block, '')).toMatch(/\n\.hud-rotate-btn:active \{/);
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

  it('opts out of colour forcing only on the swatch and the selected check\'s two layers', () => {
    // Criterion 5: `forced-color-adjust` is a scoped semantic necessity, never a wholesale
    // opt-out. Asserted over the WHOLE file rather than the block, because a use added
    // anywhere else is exactly the drift this must catch -- and `none` applied to a
    // container would silently take every descendant out of forcing with it.
    //
    // Named, not counted. Three uses, each with its reason in the stylesheet: the swatch,
    // whose colour IS the content, and the selected check's disc and glyph (issue #630),
    // which must be opaque where the forced Highlight carries an alpha. The two check layers
    // are pseudo-elements, so they have no descendants to take out of forcing.
    const uses = [...src.matchAll(/forced-color-adjust\s*:\s*([a-z-]+)/g)].map((m) => m[1]);
    expect(uses, 'forced-color-adjust must only ever be none').toEqual(['none', 'none', 'none']);
    const block = forcedBlock();
    const selectors: string[] = [];
    for (let at = block.indexOf('forced-color-adjust'); at > -1; at = block.indexOf('forced-color-adjust', at + 1)) {
      const rule = block.lastIndexOf('{', at);
      selectors.push(block.slice(block.lastIndexOf('}', rule) + 1, rule).trim());
    }
    expect(selectors, 'an opt-out is on something other than the swatch and the check').toEqual([
      '.ui-selectable--on::before',
      '.ui-selectable--on::after',
      '.hud-swatch',
    ]);
  });

  it('paints the selected check\'s disc OPAQUE, keeping plain Highlight only as the fallback', () => {
    // Issue #630. The emulated forced Highlight carries an alpha (measured 0.8 in both schemes),
    // and a disc painted with it let the control show through -- the owner's "translucent
    // check". Relative colour syntax with the alpha omitted INHERITS the origin's alpha, so the
    // `/ 1` is the load-bearing part; the plain keyword must come first, as the fallback an
    // engine without relative colour syntax keeps.
    const block = forcedBlock();
    const at = block.indexOf('.ui-selectable--on::before {');
    expect(at, 'the forced disc rule is missing').toBeGreaterThan(-1);
    const body = block.slice(at, block.indexOf('}', at));
    const opaque = body.indexOf('rgb(from Highlight r g b / 1)');
    expect(opaque, 'the disc is not forced opaque').toBeGreaterThan(-1);
    const fallback = body.indexOf('background: Highlight;');
    expect(fallback, 'no plain Highlight fallback').toBeGreaterThan(-1);
    expect(fallback, 'the fallback must come before the opaque value it falls back from').toBeLessThan(opaque);
  });

  it('gives the opted-out swatch a boundary the opt-out cannot take away', () => {
    // The cost of `forced-color-adjust: none`, paid back. With the swatch's own colours no
    // longer forced, `.ui-selectable`'s base ring keeps its authored `transparent` -- so an
    // unchosen near-white swatch had NO boundary at all against a light theme's white
    // Canvas. Every computed reading was correct while that was true, because a transparent
    // border is exactly what the unforced stylesheet asks for; it was found by looking at
    // the capture. A system keyword still resolves inside an opted-out subtree, which is
    // what makes the repair possible without touching the fill.
    const block = forcedBlock();
    const at = block.indexOf('.hud-swatch:not(.ui-selectable--on) {');
    expect(at, 'the unchosen swatch has no explicit boundary').toBeGreaterThan(-1);
    const body = block.slice(at, block.indexOf('}', at));
    expect(body).toContain('border-color');
    // A SYSTEM keyword, not an authored one: an authored colour here would be exactly the
    // hue dependency the opt-out already forces this element to live without.
    expect(body).toMatch(/CanvasText|ButtonText|Highlight/);
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

/*
 * Issue #630's selected check: a disc with a check at the chosen control's corner, so the current
 * choice no longer rests on a 2px ring alone. jsdom computes no pseudo-element styles, so these
 * read the stylesheet TEXT, and the pixels are evidenced in a real browser on the PR.
 */
describe('hud.css: the selected check (issue #630)', () => {
  const src = stripComments(css);
  /** Every innermost rule in `text` as [selectors, body], selectors split on commas. */
  const rulesIn = (text: string): Array<[string[], string]> =>
    [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [
      m[1].split(',').map((s) => s.trim()),
      m[2],
    ]);
  const bodiesFor = (selector: string): string[] =>
    rulesIn(src).filter(([sels]) => sels.includes(selector)).map(([, body]) => body);
  const px = (body: string, property: string): number => {
    const m = body.match(new RegExp(`(?:^|[;\\s])${property}:\\s*(-?[\\d.]+)px`));
    expect(m, `no ${property} in px`).not.toBeNull();
    return Number(m![1]);
  };

  it('draws the check on the CHOSEN control only', () => {
    // A pseudo-element on `.ui-selectable` without `--on` would put a check on every choice in
    // every row, which reads as "all selected" -- the failure the check exists to prevent.
    const pseudoSelectors = rulesIn(src)
      .flatMap(([sels]) => sels)
      .filter((s) => s.includes('ui-selectable') && /::(before|after)/.test(s));
    expect(pseudoSelectors.length, 'no selected-check pseudo-elements found').toBeGreaterThanOrEqual(2);
    for (const s of pseudoSelectors) {
      expect(s, `${s} draws a check on a control that is not chosen`).toContain('.ui-selectable--on');
    }
  });

  it('is a real layer that takes no pointer, with the check cut from a mask', () => {
    const disc = bodiesFor('.ui-selectable--on::before').join(';');
    expect(disc).toMatch(/content:\s*''/);
    expect(disc).toMatch(/position:\s*absolute/);
    // The disc overhangs its neighbour by 8px; if it took pointer events it would swallow the
    // press meant for that neighbour's corner.
    expect(disc, 'the disc would take clicks meant for the control or its neighbour').toMatch(
      /pointer-events:\s*none/,
    );
    const glyph = bodiesFor('.ui-selectable--on::after').join(';');
    expect(glyph).toMatch(/(^|[;\s])mask:\s*url\(/);
  });

  it('never keys the check on hover or focus, which keep their own properties', () => {
    const keyed = rulesIn(src)
      .flatMap(([sels]) => sels)
      .filter((s) => /::(before|after)/.test(s) && s.includes('ui-selectable') && /:(hover|focus)/.test(s));
    expect(keyed).toEqual([]);
  });

  it('insets a map card\'s check on both axes, where every other control carries it outside', () => {
    // A map card meets its scroll pane's edges; outside the corner the disc was clipped at the
    // pane's top on all 7 cards, and the owner ruled for "entirely inset ... both horizontally
    // and vertically". Negative offsets are the rejected placement.
    for (const layer of ['::before', '::after']) {
      const body = bodiesFor(`.hud-versus-map-card.ui-selectable--on${layer}`).join(';');
      expect(px(body, 'top'), `map card ${layer} protrudes above the card`).toBeGreaterThanOrEqual(0);
      expect(px(body, 'right'), `map card ${layer} protrudes past the card's right edge`).toBeGreaterThanOrEqual(0);
    }
    // ...and the default really is outside the corner, so the map-card rule is an exception and
    // not a restatement.
    const base = bodiesFor('.ui-selectable--on::before').join(';');
    expect(px(base, 'top')).toBeLessThan(0);
  });
});

/*
 * Issue #230's stock-loss cue arms (`?dev=1&stockCue=`). The HUD re-attaches a cue still running
 * after the strip is rebuilt, using STOCK_CUE_MS to decide whether it is still running and a
 * negative `animation-delay` to resume it. Both halves only work if the stylesheet agrees, and a
 * stylesheet is not typechecked -- so the agreement is pinned here.
 */
describe('hud.css: the stock-loss cue arms (issue #230)', () => {
  const src = stripComments(css);
  // Every animated cue element, as the HUD renders it: the badge, the struck number and the new
  // number dropping in behind it, the pip that just emptied, and that pip's burst ring.
  const CUE_RULES = [
    '.hud-stock-cue--badge',
    '.hud-stock-cue--struck',
    '.hud-stock-count.hud-stock-cue',
    '.hud-stock-pip.hud-stock-cue',
    '.hud-stock-pip.hud-stock-cue::after',
    // Issue #230's `marks` arm, held to the same bar as the three above.
    '.hud-stock-mark.hud-stock-cue',
  ];

  /** The body of the rule whose selector is exactly `selector`, at the start of a line. */
  function ruleBody(selector: string): string {
    const at = src.indexOf(`\n${selector} {`);
    expect(at, `${selector} has a rule`).toBeGreaterThan(-1);
    const open = src.indexOf('{', at);
    return src.slice(open + 1, src.indexOf('}', open));
  }

  it('runs for exactly STOCK_CUE_MS -- the token the cues use is the constant the HUD expires them by', () => {
    // Fails if either side moves alone: a retuned token would leave the HUD dropping a cue that
    // is still on screen (or re-attaching one that has finished), and a retuned constant the same.
    const token = /--hud-duration-slow:\s*(\d+)ms/.exec(src);
    expect(token, '--hud-duration-slow is declared in ms').not.toBeNull();
    expect(Number((token as RegExpExecArray)[1])).toBe(STOCK_CUE_MS);
    for (const selector of CUE_RULES) {
      expect(ruleBody(selector), selector).toMatch(/animation:[^;]*var\(--hud-duration-slow\)/);
    }
  });

  it('fills both ways, so a cue resumed with a negative delay lands on its elapsed frame', () => {
    // Without `both`, a negative delay still starts the animation part-way through, but the
    // frames before it are unstyled for one paint, and the resting state after it snaps back.
    for (const selector of CUE_RULES) {
      expect(ruleBody(selector), selector).toMatch(/animation:[^;]*\bboth\b/);
    }
  });

  it('passes the resumed delay to the pip\'s burst ring, which does not inherit it by default', () => {
    expect(ruleBody('.hud-stock-pip.hud-stock-cue::after')).toMatch(/animation-delay:\s*inherit/);
  });

  it('asks for the BUNDLED faces first, in both token stacks (issue #326)', () => {
    // The whole reason these are bundled: `system-ui` and `ui-monospace` resolve to a
    // different face per platform, and text METRICS move with the face. The screen gate's
    // first CI run disagreed on 38 of 42 states, and 154 of 154 differences were box
    // geometry. Unguarded until now -- nothing in this file asserted a font stack at all.
    const text = stripComments(css);
    const sans = /--hud-font:\s*([^;]+);/.exec(text)?.[1] ?? '';
    const mono = /--hud-font-mono:\s*([^;]+);/.exec(text)?.[1] ?? '';
    expect(sans, 'the sans stack no longer leads with Plex').toMatch(/^'IBM Plex Sans'/);
    expect(mono, 'the mono stack no longer leads with Plex').toMatch(/^'IBM Plex Mono'/);
    // The fallbacks STAY. A woff2 that fails to load should leave the HUD readable; it
    // simply stops being metric-identical, which is a degradation and not a break.
    expect(sans).toContain('system-ui');
    expect(mono).toContain('monospace');
    // And nothing still asks for a bare platform stack: six declarations used to.
    expect(text, 'a bare ui-monospace declaration is back')
      .not.toMatch(/font-family:\s*ui-monospace/);
  });

  it('wraps every choice row, so none of them can overflow the narrowest viewport', () => {
    // MEASURED, and this one was already happening rather than a future risk. At 320x568 -- the
    // smallest viewport the required `visual` gate sweeps -- six 44px hull swatches at a 12px
    // gap were 324px wide in a 320px viewport: the row sat at x=-2 with one swatch clipped off
    // each edge, and `.hud-customize` reported clientWidth 320 against scrollWidth 322. That is
    // the two-axis scrolling #327's criterion forbids by name, and the pane carries
    // `touch-action: pan-y`, so a touch player could not reach the clipped swatches by any
    // gesture.
    //
    // All three rows, not just the one that overflowed: they are the same shape, and `.hud-skins`
    // was already wrapping, which is what made the other two look deliberate rather than missed.
    for (const row of ['.hud-swatches', '.hud-skins', '.hud-accents']) {
      expect(ruleBody(row), `${row} cannot wrap`).toMatch(/flex-wrap:\s*wrap/);
    }
  });

  it('splits the six hull swatches into two even rows, not five and a stranded one', () => {
    // MEASURED on the real build at 320x568 with the cap defeated, which is what makes the
    // breakpoint a measurement rather than a guess: at 324px and wider all six swatches share
    // one line; at 323px and below they fall to 5 + 1, and the lone swatch reads as a rendering
    // fault rather than a layout. A swatch is `--hud-control-min` (44px) at a `--hud-space-4`
    // (12px) gap, so six are 6x44 + 5x12 = 324px -- the same 324 the edge sits at -- and three
    // are 3x44 + 2x12 = 156px. Capping the row at 156px turns 5 + 1 into 3 + 3.
    const at = src.indexOf('@media (max-width: 323px)');
    expect(at, 'the even-row cap is gone, or its breakpoint moved off the measured 324px edge')
      .toBeGreaterThan(-1);
    const block = src.slice(at, src.indexOf('\n}', at));
    expect(block, 'the cap no longer names the hull swatch row').toMatch(/\.hud-swatches\s*\{/);
    // Derived from the tokens rather than spelled `156px`: the arithmetic is only true while the
    // swatch and the gap are the sizes it assumes, and a literal would go quietly wrong the
    // first time either token is retuned.
    expect(block, 'the cap stopped tracking the swatch and gap tokens')
      .toMatch(/max-width:\s*calc\(3 \* var\(--hud-control-min\) \+ 2 \* var\(--hud-space-4\)\)/);

    // THE NEGATIVE HALF, and it guards a mistake that was actually made rather than a
    // hypothetical one: the first draft of this rule capped `.hud-accents` alongside the
    // swatches, and measuring showed it turning a clean single row of five into 3 + 2. Five
    // accents are 5x44 + 4x12 = 268px, which fits a 320px line with room to spare -- there is
    // no lone item there to rescue, so the cap would be pure damage.
    expect(block, 'the cap now also squeezes the accent row, which fits a 320px line intact')
      .not.toMatch(/\.hud-accents/);

    // The count the whole derivation rests on. A seventh hull colour needs 7x44 + 6x12 = 380px
    // and reopens the lone swatch across 324px-380px, which a 323px cap does not reach, so
    // adding one has to fail here rather than ship looking broken on a phone.
    expect(PALETTE.length, 'the hull palette changed size; re-derive the cap breakpoint').toBe(6);
  });

  it('lets the level grid wrap, which is the guard against a seventh campaign level', () => {
    // Nothing observable depends on this today and that is the point of writing it down.
    // Measured at 320px by cloning buttons onto the real pane: 5 buttons are 260px and fit,
    // 6 are 314px and fit, 7 are 368px and are CLIPPED AT BOTH ENDS -- the row is centred, so
    // it loses level 1 off the left edge as well as level 7 off the right. `.hud-levelselect`
    // has no `overflow` property, so those are unreachable. `campaign.json` is not pinned at
    // five anywhere.
    expect(ruleBody('.hud-levels'), 'the level grid can no longer wrap').toMatch(/flex-wrap:\s*wrap/);
    // And it is still a row: `flex-direction: column` would "fix" the overflow by stacking five
    // buttons vertically, which is a different layout, not this guard.
    expect(ruleBody('.hud-levels'), 'the level grid stopped being a row').not.toMatch(/flex-direction:\s*column/);
  });

  it('makes the control primitive INHERIT the family, which a <button> otherwise refuses', () => {
    // The gap the bundling left. A <button>'s UA stylesheet sets `font` as a shorthand --
    // family, size and weight in one declaration -- and that beats the family every other
    // element inherits from `.hud`. MEASURED on the built page after #864 landed: 269 of the
    // 271 elements carrying `.ui-btn` computed `font-family: Arial`, the two exceptions being
    // the `<a class="ui-btn">` links, which are not buttons. So every control in the game was
    // still resolving its face per platform, which is exactly what bundling removed elsewhere.
    expect(ruleBody('.ui-btn'), 'the control primitive no longer inherits its family')
      .toMatch(/font-family:\s*inherit/);
    // FAMILY only. `font: inherit` would drag size and weight along and flatten the control
    // scale -- a primary slab is 20px where a tertiary is 15px.
    expect(ruleBody('.ui-btn'), 'the primitive inherits the whole font shorthand')
      .not.toMatch(/font:\s*inherit/);
  });

  it('declares a face for every weight the SHIPPED stacks ask for, so nothing is synthesised', () => {
    // Plex Sans's axis ends at 700 and Plex Mono ships no variable build. A weight outside
    // what is declared is synthesised by the engine, per engine -- which is the variance
    // this change removes, reintroduced by a single number.
    const text = stripComments(css);
    const faces = [...text.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1]);
    expect(faces.length, 'the @font-face block is gone').toBeGreaterThanOrEqual(3);
    const sansFace = faces.find((f) => f.includes("'IBM Plex Sans'")) ?? '';
    expect(sansFace, 'the sans face is no longer the variable range').toMatch(/font-weight:\s*100 700/);
    const monoWeights = faces.filter((f) => f.includes("'IBM Plex Mono'"))
      .map((f) => /font-weight:\s*(\d+)/.exec(f)?.[1] ?? '').sort();
    expect(monoWeights, 'the declared mono weights moved').toEqual(['400', '600']);
    // Every weight the HUD asks for must be inside 100-700, or the engine invents it.
    for (const w of [...text.matchAll(/font-weight:\s*(\d{3})\b/g)].map((m) => Number(m[1]))) {
      expect(w, `font-weight ${w} is outside Plex's axis`).toBeLessThanOrEqual(700);
    }
    // And the two weight tokens still express a DIFFERENCE. Clamping both to 700 would
    // have satisfied the loop above while making `strong` mean nothing.
    const normal = Number(/--hud-weight-normal:\s*(\d+)/.exec(text)?.[1]);
    const strong = Number(/--hud-weight-strong:\s*(\d+)/.exec(text)?.[1]);
    expect(strong, 'strong is no longer stronger than normal').toBeGreaterThan(normal);
  });

  it('leaves the shipped tokens alone, and scopes every typeface arm to .hud (issue #865)', () => {
    // The criterion this pins: with the flag absent, the computed stacks are what `main` had.
    // An arm that reached `:root` would repaint anything outside the HUD that inherits these,
    // and would still be inherited after `dispose()` -- which is the reason `menuTransition`
    // puts its treatment on the HUD root too.
    const text = stripComments(src);
    const arms = [...text.matchAll(/(\.hud\.hud-font--[a-z]+)\s*\{([^}]*)\}/g)];
    expect(arms.length, 'the population: typeface arm rules').toBe(2);
    for (const [, selector, body] of arms) {
      expect(selector, 'an arm is not scoped to the HUD root').toMatch(/^\.hud\.hud-font--/);
      // Only the sans moves. Neither alternate ships a monospace companion, so every mono
      // readout stays Plex and is a fixed reference when two arm captures are compared.
      expect(body, `${selector} moves the mono token`).not.toMatch(/--hud-font-mono/);
      expect(body, `${selector} does not set the sans token`).toMatch(/--hud-font:/);
    }
    // And no arm declares itself at `:root`, where it would leak past the HUD.
    expect(text, 'a typeface arm reaches :root').not.toMatch(/:root[^{]*\{[^}]*hud-font--/);
  });

  it('fetches an alternate face only when its arm asks for it (issue #865)', () => {
    // A `@font-face` is declared, not downloaded: the file is requested when a MATCHED rule
    // asks for the family. So the guarantee is structural -- the only rules naming these two
    // families are the arm classes, which nothing wears unless the flag put them there.
    //
    // Structural here, and verified in a real browser on the issue: this test cannot see a
    // network request.
    const text = stripComments(src);
    // Rules only, with the @font-face declarations removed: what remains that NAMES one of
    // these families is a rule asking a browser to fetch it.
    const rules = [...text.replace(/@font-face\s*\{[^}]*\}/g, '').matchAll(/([^{}]+)\{([^}]*)\}/g)];
    expect(rules.length, 'the population: stylesheet rules outside @font-face')
      .toBeGreaterThan(100);
    for (const family of ["'Atkinson Hyperlegible'", "'Inter'"]) {
      const asking = rules.filter(([, , body]) => body.includes(family));
      expect(asking.length, `${family} is asked for by no rule, so its arm cannot work`).toBe(1);
      for (const [, selector] of asking) {
        expect(selector.trim(), `${family} is asked for outside an arm class`)
          .toMatch(/\.hud\.hud-font--/);
      }
    }
  });

  it('draws no cue state with `background`, which forced colours drops', () => {
    // The #230 mockups measured this: with a background fill, a filled pip and a hollow one were
    // identical under forced colours. Every rule whose selector names a stock-cue class.
    const rules = [...src.matchAll(/([^{}]*hud-stock-[^{}]*)\{([^}]*)\}/g)];
    expect(rules.length, 'the population: rules naming a stock-cue class').toBeGreaterThanOrEqual(CUE_RULES.length);
    for (const [, selector, body] of rules) {
      expect(body, selector.trim()).not.toMatch(/background/);
    }
  });

  it('gives every cue a reduced-motion form, keyed off the resolved policy class', () => {
    for (const selector of CUE_RULES) {
      expect(ruleBody(`.hud--reduced-motion ${selector}`), selector).toMatch(/animation-name:\s*[\w-]+--still/);
    }
  });
});

/**
 * No state may speak in hue alone (issue #926, criterion 3 of issue #327).
 *
 * WHY A SWEEP AND NOT ANOTHER PIN. Every non-colour guard in this file is per-instance: the
 * stock marks, the shape treatments, the spawn ring. Not one of them would notice the NEXT
 * state shipped with colour as its only channel, and issue #630 records that no contrast or
 * luminance assertion exists anywhere in `src/` or `tools/`. This turns the one-off audit sweep
 * that produced issue #327's split into a standing gate.
 *
 * IT FAILS CLOSED, which is the whole design. The population is every rule carrying a `--`
 * modifier or a state pseudo-class -- not a list of the modifiers someone judged to be states.
 * A new modifier therefore joins the swept set automatically, and if its rule is colour-only it
 * fails until a person either gives the state a second channel or writes it into the allowlist
 * below with a reason. The opposite shape -- enumerating the modifiers that count -- is what
 * lets a new state join by omission, which is the failure mode this exists to prevent.
 */
describe('hud.css: no state is carried by colour alone (issue #926)', () => {
  const text = stripComments(css);

  /** Properties whose whole contribution is hue. A control that changes only these is invisible
   *  in greyscale, under forced colours, and to a player with a colour-vision difference. */
  const COLOUR_PROPS = new Set([
    'color', 'background', 'background-color', 'border-color', 'border-top-color',
    'border-bottom-color', 'border-left-color', 'border-right-color', 'outline-color',
    'fill', 'stroke', 'text-decoration-color', 'caret-color', 'accent-color',
    'column-rule-color', 'text-emphasis-color',
  ]);

  /**
   * A PATTERN IS A SECOND CHANNEL, so a background that paints one is not colour-only. Measured:
   * `.ui-app-ground--felt` and `.hud-versus-map-canvas--random` both declare nothing but
   * `background`, and both are `repeating-linear-gradient` -- visible texture that survives
   * greyscale. A plain `linear-gradient` between two hues is NOT a pattern and stays colour.
   */
  const paintsAPattern = (value: string): boolean => /repeating-(linear|radial|conic)-gradient|url\(/i.test(value);

  /** A custom property is whatever its value is: `--hud-font` is a typeface, not a colour. */
  const isColourValue = (value: string): boolean =>
    /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|color-mix\(|\btransparent\b|\bcurrentcolor\b/i.test(value) ||
    /var\(--[a-z0-9-]*(color|bg|ink|tint|shade|accent|gold|danger)/i.test(value);

  /**
   * The forced-colors block is the ANSWER, not another question. Rules inside it exist to give
   * the system palette back to states that would otherwise vanish, so sweeping them reports the
   * remedy as the defect -- the same trap the reduced-motion sweep above records hitting on its
   * first run. Measured: without this, `.hud-swatch:not(.ui-selectable--on)` is reported for
   * declaring only `border-color: CanvasText`, which is precisely the fix issue #351 landed.
   */
  const forcedColorsBlock = ((): [number, number] => {
    const start = text.indexOf('@media (forced-colors: active)');
    expect(start, 'the forced-colors block is gone; this sweep would report its rules').toBeGreaterThan(-1);
    let depth = 0;
    for (let i = text.indexOf('{', start); i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}' && --depth === 0) return [start, i];
    }
    throw new Error('the forced-colors block is unclosed');
  })();

  interface StateRule {
    readonly selector: string;
    readonly declarations: readonly { prop: string; value: string }[];
  }

  /** Every rule whose selector carries a modifier or a state pseudo-class, outside forced colours. */
  function stateRules(): StateRule[] {
    const out: StateRule[] = [];
    for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = m[1].trim().replace(/\s+/g, ' ');
      if (selector.startsWith('@') || /^\d+%/.test(selector) || selector === 'from' || selector === 'to') continue;
      const at = m.index ?? 0;
      if (at > forcedColorsBlock[0] && at < forcedColorsBlock[1]) continue;
      const stateful = /--[a-z0-9-]+/.test(selector) ||
        /:hover|:focus|:active|:checked|:disabled|\[aria-pressed|\[aria-current|\[disabled/.test(selector);
      if (!stateful) continue;
      const declarations = [...m[2].matchAll(/(?:^|;)\s*(--[a-z0-9-]+|[a-z-]+)\s*:\s*([^;]+)/g)]
        .map((d) => ({ prop: d[1], value: d[2].trim() }));
      if (declarations.length === 0) continue;
      out.push({ selector, declarations });
    }
    return out;
  }

  const isColourOnly = (rule: StateRule): boolean =>
    rule.declarations.every(({ prop, value }) => {
      if (paintsAPattern(value)) return false;
      if (prop.startsWith('--')) return isColourValue(value);
      return COLOUR_PROPS.has(prop);
    });

  /**
   * The reviewed exceptions, each with the second channel that makes it one. `reinforcedBy` is
   * asserted against the tree below, so an entry whose reason stops being true FAILS rather than
   * sitting here as a stale excuse -- an allowlist nobody rechecks is how the per-instance pins
   * this replaces went stale in the first place.
   */
  const ALLOWED: Record<string, { why: string; reinforcedBy?: RegExp; source?: 'css' | 'hud' }> = {
    // POINTER AFFORDANCES. Hover and press feedback answer "where is my cursor", which a player
    // using a pointer can already see, and neither conveys state that has to be decoded. They
    // also cannot be reached without a pointer at all, so no keyboard or pad user depends on
    // reading them. The control's real state is carried by its own `--on`/`--active` rule.
    '.ui-btn:hover:not(:disabled)': { why: 'pointer hover feedback, not state' },
    '.ui-btn--primary:hover:not(:disabled)': { why: 'pointer hover feedback, not state' },
    '.ui-btn--danger:hover:not(:disabled)': { why: 'pointer hover feedback, not state' },
    '.ui-selectable:not(.ui-selectable--on):hover:not(:disabled)': { why: 'pointer hover feedback, not state' },
    '.hud-rotate-btn:hover:not(:disabled)': { why: 'pointer hover feedback, not state' },
    '.hud-rotate-btn:active': { why: 'momentary press feedback, not state' },

    // THE SELECTED RING, reinforced by a drawn check. `.ui-selectable--on::after` paints a 20px
    // badge with `content: ''`, so selection is a SHAPE appearing beside the control as well as
    // a white border -- issue #630's treatment, which this entry is pinned to.
    '.ui-selectable--on': {
      why: 'the ::after check badge draws selection as a shape',
      reinforcedBy: /\.ui-selectable--on::after\s*\{[^}]*content:\s*''/,
      source: 'css',
    },

    // A VARIANT, not a state: a danger button is always one, and its label says what it does
    // ("Reset stats"). Nothing changes here in response to the player.
    '.ui-btn--danger': { why: 'a permanent variant whose label carries the meaning' },

    // STATES WHOSE TEXT CHANGES WITH THEM. Each is pinned to the line in hud.ts that writes the
    // other channel, so deleting the relabel fails here as well as wherever it is tested.
    '.hud-mute--active': {
      why: 'the label flips Mute/Muted and aria-pressed flips with it',
      reinforcedBy: /settingsMuteBtn\.textContent = `\$\{muted \? 'Muted' : 'Mute'\}/,
      source: 'hud',
    },
    '.hud-danger--armed': {
      why: 'arming relabels the same button "Really reset?"',
      reinforcedBy: /armedLabel = 'Really reset\?'/,
      source: 'hud',
    },
    '.hud-shells--full': {
      why: 'the element reads "shells N/cap", so the cap is a number on screen',
      reinforcedBy: /shellsEl\.textContent = `shells \$\{info\.inFlight\}\/\$\{info\.cap\}`/,
      source: 'hud',
    },

    // DEVELOPER-ONLY SURFACES, behind ?dev=1 and never in front of a player. They are also
    // notes whose TEXT is the message; the colour grades it.
    '.hud-devcfg-note--rejected': { why: 'a developer pane, and the note text is the message' },
    '.hud-devcfg-note--gate-closed': { why: 'a developer pane, and the note text is the message' },
    '.hud-devcfg-note--bundle-forced, .hud-devcfg-note--context-inert, .hud-devcfg-note--inverted-default':
      { why: 'a developer pane, and the note text is the message' },
    '.hud-selftest-channel--down .hud-selftest-channel-fill':
      { why: 'a developer pane, and the fill bar states the value by width' },
  };

  it('finds the state-rule population it is about', () => {
    // Vacuity guard, in the shape the reduced-motion sweep above uses: every assertion below is
    // a filter over this list and all of them pass trivially on an empty one, which a regex that
    // stopped matching would quietly produce.
    const rules = stateRules();
    expect(rules.length, 'no state rules parsed out of hud.css').toBeGreaterThan(100);
    expect(rules.some((r) => r.selector === '.ui-selectable--on'), 'the selected ring is not in the sweep').toBe(true);
    expect(rules.some((r) => r.selector.includes(':hover')), 'no hover rule is in the sweep').toBe(true);
  });

  it('gives every state a channel besides hue, or names it as a reviewed exception', () => {
    const offenders = stateRules().filter(isColourOnly).map((r) => r.selector).filter((s) => !(s in ALLOWED));
    expect(offenders, 'a state changes colour and nothing else; give it a second channel or review it into ALLOWED').toEqual([]);
  });

  it('keeps the allowlist honest: every entry is still colour-only, and still reinforced', () => {
    // BOTH DIRECTIONS. An entry that no longer matches any rule is dead weight that makes the
    // list look more considered than it is; an entry whose stated second channel has been
    // deleted is worse, because it excuses a state that has genuinely become colour-only.
    const colourOnly = new Set(stateRules().filter(isColourOnly).map((r) => r.selector));
    for (const selector of Object.keys(ALLOWED)) {
      expect(colourOnly.has(selector), `${selector} is no longer a colour-only state rule; drop its ALLOWED entry`).toBe(true);
    }
    for (const [selector, entry] of Object.entries(ALLOWED)) {
      if (!entry.reinforcedBy) continue;
      const haystack = entry.source === 'hud' ? hudSource : text;
      expect(haystack, `${selector} is allowed because "${entry.why}", and that is no longer in the tree`)
        .toMatch(entry.reinforcedBy);
    }
  });
});

/**
 * No reduced-motion cue is carried by colour alone either (issue #924).
 *
 * THE SHAPE `no state is carried by colour alone` ABOVE CANNOT SEE. That sweep reads RULES, and
 * the rule applying a cue declares `animation-name`, which is not a colour property -- so it
 * passes while the keyframes it points at change nothing but hue. `hud-lives-pulse--still` was
 * exactly that: `color` and `transform: none`, and the stylesheet conceded it in a comment for
 * as long as the rule existed.
 *
 * A CHANNEL IS A PROPERTY WHOSE VALUE CHANGES, which is the whole subtlety here and the reason
 * a property-name check is not enough. Every `--still` set declares `transform: none` at every
 * step -- that is what makes it the reduced variant -- so counting declared property NAMES reads
 * the cancelled movement as a second channel and passes all nine sets, the broken one included.
 * Measured both ways while writing this: by name, 0 offenders; by varying value, exactly 1, and
 * it was the one the tree already admitted to.
 */
describe('hud.css: no reduced-motion cue is carried by colour alone (issue #924)', () => {
  const text = stripComments(css);

  /** The body of the rule whose selector is exactly `selector`, at the start of a line. */
  const bodyOf = (selector: string): string => {
    const at = text.indexOf(`\n${selector} {`);
    expect(at, `${selector} has a rule`).toBeGreaterThan(-1);
    const open = text.indexOf('{', at);
    return text.slice(open + 1, text.indexOf('}', open));
  };

  const COLOUR_PROPS = new Set([
    'color', 'background', 'background-color', 'border-color', 'outline-color', 'fill', 'stroke',
    'text-decoration-color', 'caret-color', 'accent-color',
  ]);

  /**
   * Every `--still` keyframe set in `source`, with the properties whose value actually varies.
   *
   * Takes its source so the classifier can be pointed at a SYNTHETIC known-bad set below. The
   * real tree cannot serve as that control: the moment the defect is fixed the control passes,
   * which is how a fixture aimed at a broken shipped rule deletes itself.
   */
  function stillSets(source: string = text): { name: string; varying: string[] }[] {
    const out: { name: string; varying: string[] }[] = [];
    for (const m of source.matchAll(/@keyframes\s+([\w-]+--still)\s*\{/g)) {
      const open = m.index + m[0].length - 1;
      let depth = 0;
      let close = -1;
      for (let i = open; i < source.length; i++) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}' && --depth === 0) { close = i; break; }
      }
      expect(close, `@keyframes ${m[1]} is unclosed`).toBeGreaterThan(-1);
      const values = new Map<string, Set<string>>();
      for (const step of source.slice(open + 1, close).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        for (const d of step[2].matchAll(/(?:^|;)\s*([a-z-]+)\s*:\s*([^;]+)/g)) {
          const seen = values.get(d[1]) ?? new Set<string>();
          seen.add(d[2].trim());
          values.set(d[1], seen);
        }
      }
      out.push({
        name: m[1],
        varying: [...values].filter(([, seen]) => seen.size > 1).map(([prop]) => prop).sort(),
      });
    }
    return out;
  }

  it('finds the reduced-motion keyframe population it is about', () => {
    // Vacuity guard: every assertion below filters this list and passes trivially on an empty
    // one, which a regex that stopped matching would quietly produce.
    const sets = stillSets();
    expect(sets.length, 'no --still keyframe sets parsed out of hud.css').toBeGreaterThan(6);
    expect(sets.map((s) => s.name)).toContain('hud-lives-pulse--still');
  });

  it('gives every reduced-motion cue a channel besides hue', () => {
    const offenders = stillSets()
      .filter(({ varying }) => varying.length > 0 && varying.every((p) => COLOUR_PROPS.has(p)))
      .map(({ name }) => name);
    expect(offenders, 'a reduced-motion cue changes colour and nothing else').toEqual([]);
  });

  it('gives every reduced-motion cue SOMETHING that changes, since a still set that varies nothing is not a cue', () => {
    // The other way a `--still` set goes wrong, and the one a colour check alone would pass: a
    // set that declares only `transform: none` at every step animates nothing at all, so the cue
    // it replaces simply disappears under reduced motion. `.hud-damage--hit` is cancelled with
    // `animation: none` precisely because it is pure movement; anything that keeps a keyframe
    // set is claiming to still say something.
    for (const { name, varying } of stillSets()) {
      expect(varying.length, `${name} varies nothing, so the cue it replaces is gone`).toBeGreaterThan(0);
    }
  });

  it('reads a cancelled transform as no channel at all, rather than as a second one', () => {
    // A SYNTHETIC known-bad set, and it has to be synthetic: this is the exact shape
    // `hud-lives-pulse--still` had before the ring was added, so pointing the control at the
    // real tree would have made the fix delete its own guard. Every `--still` set carries
    // `transform: none` at every step -- that is what makes it the reduced variant -- so a
    // classifier counting declared property NAMES calls the cancelled movement a channel and
    // passes the one set that has none.
    const broken = `@keyframes hud-synthetic-pulse--still {
      0%, 100% { color: var(--hud-text); transform: none; }
      50% { color: #ff6a6a; transform: none; }
    }`;
    expect(stillSets(broken).map((s) => s.varying)).toEqual([['color']]);

    // And the other way, so the rule is not merely "ignore transform": a transform that really
    // moves IS a channel, which is why the non-reduced sets are not swept here at all.
    const moving = `@keyframes hud-synthetic-move--still {
      0%, 100% { color: var(--hud-text); transform: none; }
      50% { color: #ff6a6a; transform: scale(1.5); }
    }`;
    expect(stillSets(moving).map((s) => s.varying)).toEqual([['color', 'transform']]);
  });

  it('rings the life counter, which is the channel that survives forced colours and greyscale', () => {
    // Pinned specifically rather than left to the sweep, because WHICH channel matters here.
    // The counter is `display: inline-block`, so a `font-weight` step would reflow its
    // neighbours -- movement reintroduced by the fix for movement -- and an `opacity` blink is
    // the wrong answer to a reduced-motion preference. An outline is drawn outside the box and
    // takes no layout space, and `currentColor` is repainted by the system under forced colours
    // rather than dropped, so it survives that combination too.
    const still = stillSets().find((s) => s.name === 'hud-lives-pulse--still');
    expect(still?.varying, 'the life-loss pulse no longer rings the digit').toContain('outline-width');
    // The style and colour live on the rule, or `outline-width` animates against `none` and
    // draws nothing at all.
    const applied = bodyOf('.hud--reduced-motion .hud-lives--hit');
    expect(applied, 'the outline has no style to open into').toMatch(/outline:\s*0\s+solid\s+currentColor/);
    expect(applied, 'the ring sits on the glyph instead of around it').toMatch(/outline-offset:/);
  });
});
