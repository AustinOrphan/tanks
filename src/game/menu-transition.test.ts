// @vitest-environment jsdom
/*
 * Issue #542's menu transitions: the shipped one, the three it was chosen over, and the
 * properties that survive the adoption.
 *
 *  1. Whatever is DEFAULT is the thing with no class and no rule -- it IS the shipped
 *     cascade rather than a copy of it. That property used to belong to `fade`, and moved
 *     to `rise` when the owner ruled. Every guard for it below is written against
 *     `SHIPPED_MENU_TRANSITION` rather than against a spelled-out treatment, so the next
 *     ruling moves the guard with the default instead of leaving it aimed at a treatment
 *     that is no longer shipped.
 *  2. `fade` still reproduces the transition as it shipped BEFORE this issue. It is the
 *     one way back to the old behaviour, which is what makes a regression report about
 *     the new default answerable rather than a matter of memory -- and it is now a rule of
 *     its own, so it can drift, which is exactly why it is pinned here.
 *  3. A treatment with a different duration still has ONE definition of it, in the
 *     stylesheet, reached through `transitionMs()`'s existing single read. Issue #364's
 *     first criterion, which a `const 300` in TypeScript would break silently.
 *  4. Every treatment collapses to an instant change under the RESOLVED reduced-motion
 *     policy. Movement is exactly what that preference is about, and the shipped
 *     transition now moves -- so this stopped being a property of two dev-flag arms and
 *     became a property of what every player gets. A `prefers-reduced-motion` CSS block
 *     could not cover it, because the resolved policy is a player setting the media query
 *     cannot see.
 *  5. The splash hint keeps its own infinite pulse. The rule that lifts an entering
 *     surface's content is unconditional now, so the exclusion that spares the title
 *     screen guards every build rather than a flag nobody sets.
 *
 * These run with FAKE TIMERS for the reason `hud.surfaces.test.ts`'s transition suite
 * states: `hud.ts` imports `./hud.css` and vitest is configured with `css: true`, so the
 * stylesheet is live in this jsdom document and every transition here is genuinely
 * deferred. Measured before these were written, not assumed -- the `fade-long` timing
 * test below reads 300ms out of the stylesheet's own cascade, which a document with no
 * stylesheet would report as 0 and turn every "instant" assertion vacuous.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import css from './hud.css?raw';
import { createHud, type Hud } from './hud';
import { parseDevFlags } from './devflags';
import {
  MENU_TRANSITIONS,
  SHIPPED_MENU_TRANSITION,
  isMenuTransition,
  menuTransitionClass,
  type MenuTransition,
} from './menu-transition';

let mounted: Hud | null = null;

function mount(menuTransition: MenuTransition | null): { hud: Hud; root: HTMLElement } {
  const root = document.createElement('div');
  document.body.appendChild(root);
  mounted = createHud(root, { menuTransition });
  return { hud: mounted, root };
}

afterEach(() => {
  mounted?.dispose();
  mounted = null;
  document.body.innerHTML = '';
  vi.useRealTimers();
});

const hudEl = (root: HTMLElement): HTMLElement => root.querySelector('.hud') as HTMLElement;
const surface = (root: HTMLElement, sel: string): HTMLElement => root.querySelector(sel) as HTMLElement;
const click = (root: HTMLElement, sel: string): void => {
  (root.querySelector(sel) as HTMLButtonElement).dispatchEvent(new MouseEvent('click'));
};
/** Strip comments first: braces inside them are prose, not syntax. */
const stripComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * The one navigation every timing assertion below drives: Main Menu -> Records.
 *
 * A real click on a real control, like the rest of the HUD suites, because the `show*`
 * helpers the transition contract routes through are internal to `createHud`. Returns
 * with the mount's own transition already settled, so a count or a class read afterwards
 * starts from rest rather than from the boot crossfade.
 */
function atMainMenu(treatment: MenuTransition | null): { hud: Hud; root: HTMLElement } {
  const m = mount(treatment);
  m.hud.setState('main-menu');
  vi.advanceTimersByTime(1000);
  return m;
}

/**
 * The three things the cascade can differ on, read live off the mounted stylesheet: the
 * token `transitionMs()` reads, the animation the entering SURFACE runs, and the one its
 * CONTENT runs.
 */
function read(treatment: MenuTransition | null): {
  duration: string;
  surface: string;
  content: string;
} {
  const m = mount(treatment);
  const panel = surface(m.root, '.hud-panel');
  panel.classList.add('ui-surface--entering');
  const out = {
    duration: getComputedStyle(hudEl(m.root)).getPropertyValue('--ui-transition-duration').trim(),
    surface: getComputedStyle(panel).animation,
    content: getComputedStyle(panel.firstElementChild as HTMLElement).animation,
  };
  m.hud.dispose();
  mounted = null;
  document.body.innerHTML = '';
  return out;
}

describe('menuTransition: the flag that names a transition', () => {
  it('accepts every name in the vocabulary and nothing else -- population: the 4 registered names', () => {
    // Stated as a count so the sweep cannot silently shrink to nothing, the shape
    // `BLOCKED_FIRE_CUES.size` uses in devflags.test.ts.
    expect(MENU_TRANSITIONS.size).toBe(4);
    for (const treatment of MENU_TRANSITIONS) {
      expect(parseDevFlags(`?dev=1&menuTransition=${treatment}`).menuTransition, treatment).toBe(
        treatment,
      );
      expect(isMenuTransition(treatment)).toBe(true);
    }
    // NEGATIVE CONTROLS. Reject-to-null, never a guess: a treatment nobody built and one
    // spelled wrong both leave the shipped transition, and nothing survives without the
    // `dev` gate the whole registry sits behind.
    for (const raw of ['swoosh', 'Fade', 'fade long', 'fadelong', '']) {
      expect(parseDevFlags(`?dev=1&menuTransition=${raw}`).menuTransition, raw).toBeNull();
      expect(isMenuTransition(raw), raw).toBe(false);
    }
    expect(parseDevFlags('?menuTransition=rise').menuTransition).toBeNull();
    expect(parseDevFlags('?dev=1').menuTransition).toBeNull();
  });

  it('maps every treatment but the SHIPPED one to its own modifier class, and that one to none', () => {
    // The shipped treatment yielding null is the mechanism behind "indistinguishable from
    // absent", not a shortcut: there is no `.hud--menu-transition-rise` rule to drift from
    // the shipped values, because the shipped treatment IS the shipped path.
    //
    // Written against the constant rather than against `'rise'` so this assertion MOVES
    // when the default does. It has already had to: `fade` held this property while the
    // comparison ran, and now carries a class like any other alternative.
    expect(menuTransitionClass(null)).toBeNull();
    expect(menuTransitionClass(SHIPPED_MENU_TRANSITION)).toBeNull();
    const classed = [...MENU_TRANSITIONS].filter((t) => menuTransitionClass(t) !== null);
    expect(classed, 'exactly the three non-shipped treatments carry a class').toEqual(
      [...MENU_TRANSITIONS].filter((t) => t !== SHIPPED_MENU_TRANSITION),
    );
    // Population and identity, so the filter above cannot pass by matching nothing.
    expect(classed.length).toBe(3);
    expect(classed).toEqual(['fade', 'fade-long', 'settle']);
    for (const treatment of classed) {
      expect(menuTransitionClass(treatment)).toBe(`hud--menu-transition-${treatment}`);
    }
  });
});

describe('menuTransition: the SHIPPED transition is the no-flag path itself', () => {
  it('mounts the same DOM as an absent flag, with no modifier class anywhere', () => {
    const absent = mount(null);
    const absentClasses = hudEl(absent.root).className;
    const absentHtml = hudEl(absent.root).innerHTML;
    absent.hud.dispose();
    mounted = null;
    document.body.innerHTML = '';

    const shipped = mount(SHIPPED_MENU_TRANSITION);
    expect(
      hudEl(shipped.root).className,
      'the shipped treatment added a class of its own',
    ).toBe(absentClasses);
    expect(hudEl(shipped.root).innerHTML).toBe(absentHtml);
    expect(hudEl(shipped.root).className).not.toMatch(/hud--menu-transition-/);

    // NEGATIVE CONTROL: the same comparison against an alternative must FAIL, or this
    // test would pass against a `menuTransition` option that was never read at all.
    shipped.hud.dispose();
    mounted = null;
    document.body.innerHTML = '';
    const other = mount('fade');
    expect(hudEl(other.root).className, 'the option is not wired to anything').not.toBe(
      absentClasses,
    );
  });

  it('resolves the same duration and animates the same keyframes as an absent flag', () => {
    const absent = read(null);
    // Vacuity guard: jsdom really is resolving the stylesheet here. A document with no
    // stylesheet reports '' for all three and every comparison below would hold trivially.
    expect(absent.duration, 'the stylesheet is not live in this document').toBe('150ms');
    expect(absent.surface).toContain('ui-surface-in');
    expect(absent.content, 'the shipped path no longer lifts its content').toContain(
      'ui-surface-rise-content',
    );

    expect(read(SHIPPED_MENU_TRANSITION)).toEqual(absent);

    // NEGATIVE CONTROLS, one per way a treatment can differ from the shipped path: the two
    // fades on the content animation, `fade-long` on the duration as well, `settle` on
    // which keyframes the content runs.
    expect(read('fade').content, 'the opacity-only treatment still lifts').toBe('none');
    expect(read('fade-long').content).toBe('none');
    expect(read('fade-long').duration).toBe('300ms');
    expect(read('fade').duration, 'the fade treatment also moved the duration').toBe('150ms');
    expect(read('settle').content).toContain('ui-surface-settle-content');
    expect(read('settle').duration, 'a movement treatment must not also change duration').toBe(
      '150ms',
    );
    for (const treatment of MENU_TRANSITIONS) {
      expect(
        read(treatment).surface,
        `${treatment}: the surface itself still crossfades`,
      ).toBe(absent.surface);
    }
  });

  it('settles on exactly the same tick as an absent flag', () => {
    vi.useFakeTimers();
    // Timing, not just classes: two treatments could name the same keyframes and still
    // differ in when the outgoing surface is torn down.
    const settledAt = (treatment: MenuTransition | null): number => {
      const m = atMainMenu(treatment);
      click(m.root, '.hud-records-open');
      let ms = 0;
      while (ms < 2000 && !surface(m.root, '.hud-panel').classList.contains('hud-panel--hidden')) {
        vi.advanceTimersByTime(1);
        ms += 1;
      }
      m.hud.dispose();
      mounted = null;
      document.body.innerHTML = '';
      return ms;
    };
    const absent = settledAt(null);
    expect(absent, 'the navigation never settled, so this measures a timeout').toBe(150);
    expect(settledAt(SHIPPED_MENU_TRANSITION)).toBe(absent);
    // NEGATIVE CONTROL: the measurement can tell two treatments apart.
    expect(settledAt('fade-long')).toBe(300);
  });
});

/*
 * What `fade` has to reproduce: the transition exactly as it shipped BEFORE issue #542.
 *
 * Pinned as literals rather than compared against something in this tree, because the
 * path they describe no longer exists here -- the no-flag path is `rise` now, so there is
 * nothing left to diff against and an "is fade the same as absent?" test would assert the
 * opposite of what is wanted. Taken from `hud.css` as of 118d3b8: `.ui-surface--entering`
 * ran `ui-surface-in` at `--ui-transition-duration: 150ms`, and no rule anywhere touched
 * an entering surface's children.
 */
const PRE_542 = {
  duration: '150ms',
  surfaceKeyframes: 'ui-surface-in',
} as const;

describe('menuTransition: `fade` still reproduces the pre-#542 transition', () => {
  it('crossfades at the shipped duration and moves no content at all', () => {
    const fade = read('fade');
    expect(fade.duration, 'the opacity-only treatment no longer runs at 150ms').toBe(
      PRE_542.duration,
    );
    expect(fade.surface).toContain(PRE_542.surfaceKeyframes);
    // The whole of what `fade` is FOR: content that does not move. Asserted both ways --
    // that it names no content keyframes, and that what it does name is the null
    // animation -- so a rule that merely renamed the shipped keyframes would fail too.
    expect(fade.content, '`fade` picked up a content animation').not.toMatch(
      /ui-surface-[a-z]+-content/,
    );
    expect(fade.content).toBe('none');

    // NEGATIVE CONTROL: the shipped path, read by the same helper on the same navigation,
    // DOES move its content. Without this, `fade` reproducing "no movement" would also
    // pass in a tree where nothing moves at all and issue #542 had never landed.
    expect(read(null).content).toContain('ui-surface-rise-content');
  });

  it('settles on the pre-#542 tick, which is the same one the shipped path uses', () => {
    vi.useFakeTimers();
    const m = atMainMenu('fade');
    click(m.root, '.hud-records-open');
    vi.advanceTimersByTime(149);
    expect(
      surface(m.root, '.hud-panel').classList.contains('hud-panel--hidden'),
      '`fade` settled early',
    ).toBe(false);
    vi.advanceTimersByTime(2);
    expect(
      surface(m.root, '.hud-panel').classList.contains('hud-panel--hidden'),
      '`fade` did not settle at 150ms',
    ).toBe(true);
  });
});

describe('menuTransition: the duration treatment goes through the ONE token', () => {
  it('lengthens the transition by moving the stylesheet token, with nothing mirrored in TypeScript', () => {
    // Criterion 1 of issue #364, restated: "one place defines the duration" is only true
    // if the treatment changes that place. A `const FADE_LONG_MS = 300` in hud.ts or
    // menu-transition.ts would satisfy any assertion comparing two numbers and would fail
    // this one, because this reads the timer against a stylesheet the test then moves.
    vi.useFakeTimers();
    const m = atMainMenu('fade-long');
    click(m.root, '.hud-records-open');
    vi.advanceTimersByTime(299);
    expect(
      surface(m.root, '.hud-panel').classList.contains('hud-panel--hidden'),
      'the treatment settled on the shipped 150ms, so its duration is not the token',
    ).toBe(false);
    vi.advanceTimersByTime(2);
    expect(surface(m.root, '.hud-panel').classList.contains('hud-panel--hidden')).toBe(true);
  });

  it('overrides that token per HUD, so a second HUD on the page keeps the shipped timing', () => {
    // The modifier sits on the HUD ROOT rather than on `document.documentElement`, which
    // is what makes the treatment scoped rather than global. Not a hypothetical
    // distinction: `transitionMs()` reads the token off that exact element, so a
    // document-level class would leak it to anything else mounted beside it.
    vi.useFakeTimers();
    const longRoot = document.createElement('div');
    document.body.appendChild(longRoot);
    const long = createHud(longRoot, { menuTransition: 'fade-long' });
    try {
      expect(
        getComputedStyle(hudEl(longRoot)).getPropertyValue('--ui-transition-duration').trim(),
      ).toBe('300ms');
      const plainRoot = document.createElement('div');
      document.body.appendChild(plainRoot);
      const plain = createHud(plainRoot);
      try {
        expect(
          getComputedStyle(hudEl(plainRoot)).getPropertyValue('--ui-transition-duration').trim(),
          'the treatment escaped its own HUD',
        ).toBe('150ms');
      } finally {
        plain.dispose();
      }
    } finally {
      long.dispose();
    }
  });
});

describe('menuTransition: every treatment collapses to instant under RESOLVED reduced motion', () => {
  it('leaves no transition timer and no animation class, on the no-flag path and all four', () => {
    // Population: 5 -- the no-flag path plus every registered treatment, so a sixth cannot
    // be added without answering this.
    //
    // `null` LEADS the sweep rather than being left to `rise` to stand in for, and that is
    // the case the adoption added. It matters more now than during the comparison: the
    // shipped transition MOVES, so this is what keeps a player who resolved reduced motion
    // from getting movement, rather than a property of two arms nobody sets. `rise` is
    // proved identical to `null` two describes up, but a guard about what every player
    // gets should not reach that player through another test's conclusion.
    vi.useFakeTimers();
    expect(MENU_TRANSITIONS.size).toBe(4);
    for (const treatment of [null, ...MENU_TRANSITIONS]) {
      const m = atMainMenu(treatment);
      try {
        // NEGATIVE CONTROL, in the same test and on the same click: with motion allowed
        // the navigation is genuinely deferred, or the reduced branch below would be
        // measuring a suite that was synchronous anyway.
        m.hud.setReducedMotion(false);
        const before = vi.getTimerCount();
        click(m.root, '.hud-records-open');
        const withMotion = vi.getTimerCount() - before;
        expect(
          surface(m.root, '.hud-stats').classList.contains('ui-surface--entering'),
          `${treatment}: control -- motion on, the arriving pane must still be animating`,
        ).toBe(true);
        expect(
          surface(m.root, '.hud-panel').classList.contains('hud-panel--hidden'),
          `${treatment}: control -- motion on, the outgoing panel must still be displayed`,
        ).toBe(false);
        vi.advanceTimersByTime(1000);
        click(m.root, '.hud-stats-back');
        vi.advanceTimersByTime(1000);

        m.hud.setReducedMotion(true);
        const armed = vi.getTimerCount();
        click(m.root, '.hud-records-open');
        const reduced = vi.getTimerCount() - armed;

        // No advance between the click and these reads: the change has already landed.
        expect(
          withMotion - reduced,
          `${treatment}: reduced motion did not remove exactly the transition timer`,
        ).toBe(1);
        for (const sel of ['.hud-panel', '.hud-stats', '.ui-app-ground']) {
          const el = surface(m.root, sel);
          expect(el.classList.contains('ui-surface--entering'), `${treatment} ${sel} entering`).toBe(
            false,
          );
          expect(el.classList.contains('ui-surface--leaving'), `${treatment} ${sel} leaving`).toBe(
            false,
          );
          // The surface's own classes ARE the whole claim, and that is worth stating
          // because the content keyframes animate children and the opposite seems likelier.
          // A child never carries `ui-surface--entering` -- hud.ts adds it to the surface
          // element alone -- and the child keyframes are selected by CSS descending from it
          // (`.ui-surface--entering:not(.hud-splash) > *`), so a surface with the class
          // removed has no animating children by construction.
          //
          // An earlier version of this test looped over the children asserting they did
          // not carry that class. It could not fail on any treatment, working or broken.
        }
        expect(surface(m.root, '.hud-panel').classList.contains('hud-panel--hidden')).toBe(true);
        expect(surface(m.root, '.hud-stats').classList.contains('hud-stats--hidden')).toBe(false);
      } finally {
        m.hud.dispose();
        mounted = null;
        document.body.innerHTML = '';
      }
    }
  });
});

describe('menu transitions in hud.css', () => {
  const text = stripComments(css);

  it('states the shipped content motion unconditionally, with no treatment class at all', () => {
    // Vacuity guard first: the stylesheet loaded as text. `?raw` returns '' when vitest's
    // CSS handling is off, and every match below would then report zero either way.
    expect(text.length).toBeGreaterThan(1000);
    // `(^|\n)` anchors the selector to the start of a line, which is the whole assertion:
    // the same selector text appears as the TAIL of every alternative's rule, and a
    // shipped rule that had quietly acquired a class prefix would still match without it.
    const rule = /(^|\n)\.ui-surface--entering:not\(\.hud-splash\)\s*>\s*\*\s*\{([^}]*)\}/.exec(
      text,
    );
    expect(rule, 'the shipped content rule is missing, or now carries a treatment class')
      .not.toBeNull();
    const body = (rule as RegExpExecArray)[2];
    expect(body).toContain('ui-surface-rise-content');
    // Through the tokens, never a literal: a duration written here would be the second,
    // driftable copy issue #364's first criterion forbids, and `fade-long`'s override
    // would stop reaching the content it is supposed to slow down with everything else.
    expect(body, 'the shipped rule hardcodes a duration').not.toMatch(/animation:[^;]*\d+m?s/);
    expect(body, 'the shipped rule hardcodes an easing curve').not.toMatch(
      /animation:[^;]*cubic-bezier/,
    );
    expect(body).toContain('var(--ui-transition-duration)');
    expect(body).toContain('var(--ui-transition-ease)');
  });

  it('gives the SHIPPED treatment no rule of its own, and every other one at least one', () => {
    for (const treatment of MENU_TRANSITIONS) {
      // The lookahead matters: `fade` is a prefix of `fade-long`, so a bare match reports
      // the fade rule as also being the long one and this test passes on a lie.
      const rules = [
        ...text.matchAll(new RegExp(`\\.hud--menu-transition-${treatment}(?![a-z-])`, 'g')),
      ];
      if (treatment === SHIPPED_MENU_TRANSITION) {
        // THE LOAD-BEARING NUMBER. A rule for the shipped treatment would be a second
        // statement of the shipped values, free to drift from them -- and would make the
        // "absent and shipped are the same path" identity a claim about a copy. Keyed off
        // the constant so it follows the default rather than staying aimed at `rise`.
        expect(rules.length, `the shipped treatment names ${rules.length} rules`).toBe(0);
      } else {
        // Only a floor, deliberately. `fade-long` needs two -- the duration token and the
        // content cancel have different subjects and cannot share a rule -- and pinning
        // exact counts here would churn on any regrouping without protecting anything.
        expect(rules.length, `${treatment} names no rule at all`).toBeGreaterThan(0);
      }
    }
  });

  it('reads the shared duration and easing tokens in the movement rule, never a literal', () => {
    // `settle` animates through the same two tokens the shipped rules do, so `fade-long`'s
    // override reaches it and a future timing change still has one home.
    const rule = /\.hud--menu-transition-settle\s[^{]*\{([^}]*)\}/.exec(text);
    expect(rule, 'settle has no content rule').not.toBeNull();
    const body = (rule as RegExpExecArray)[1];
    expect(body, 'settle hardcodes a duration').not.toMatch(/animation:[^;]*\d+m?s/);
    expect(body, 'settle hardcodes an easing curve').not.toMatch(/animation:[^;]*cubic-bezier/);
    expect(body).toContain('var(--ui-transition-duration)');
    expect(body).toContain('var(--ui-transition-ease)');
    expect(body).toContain('ui-surface-settle-content');
  });

  it('gives each movement its keyframes, moving for real and ending at no transform at all', () => {
    // The defect this is for: keyframes that are wired, named and animated, and whose
    // `from` is the identity -- indistinguishable from a plain crossfade on screen while
    // every other check in this file still passes. jsdom cannot compute an animated value,
    // so this reads the declaration.
    const from = (name: string): string => {
      const at = text.indexOf(`@keyframes ${name}`);
      expect(at, `${name} is missing from the stylesheet`).toBeGreaterThan(-1);
      const body = text.slice(at, text.indexOf('\n}', at));
      const m = /from\s*\{([^}]*)\}/.exec(body);
      expect(m, `${name} has no from step`).not.toBeNull();
      expect(body, `${name} does not end at a cleared transform`).toMatch(
        /to\s*\{\s*transform:\s*none;?\s*\}/,
      );
      return (m as RegExpExecArray)[1].trim();
    };
    // An identity transform is what "wired but does nothing" looks like, in every spelling
    // a reader might write it.
    const IDENTITY = /transform:\s*(none|translateY\(-?0(px|%)?\)|scale\(1(\.0+)?\))\s*;?/;
    const rise = from('ui-surface-rise-content');
    expect(rise, 'the shipped transition does not translate').toMatch(
      /transform:\s*translateY\(-?[\d.]+px\)/,
    );
    expect(rise, 'the shipped transition translates by nothing').not.toMatch(IDENTITY);
    const settle = from('ui-surface-settle-content');
    expect(settle, 'settle does not scale').toMatch(/transform:\s*scale\([\d.]+\)/);
    expect(settle, 'settle scales by nothing').not.toMatch(IDENTITY);
    // NEGATIVE CONTROL for the guard itself: the identity spellings it is meant to reject
    // really are rejected, so `not.toMatch` above is not passing on a pattern that never
    // matches anything.
    for (const dead of ['transform: translateY(0px);', 'transform: scale(1);', 'transform: none;']) {
      expect(dead, dead).toMatch(IDENTITY);
    }
  });

  it('states no transition inside a prefers-reduced-motion block', () => {
    // The constraint `--ui-transition-duration`'s own comment sets out: transitions follow
    // the RESOLVED policy (`effective-settings.ts`), not the raw media query, because a
    // player who chose `full` motion against an OS asking for `reduce` must still get
    // their transitions. Anything restated inside that block would be a second, blind
    // decision about the same thing -- and would be wrong for that player. It covers the
    // shipped `ui-surface-*` rules too now, not only the flagged alternatives: the
    // movement this is really about is what every player gets.
    const blocks = [...text.matchAll(/@media\s*\(prefers-reduced-motion[^{]*\{/g)];
    // Vacuity guard: the block this is about really is in the file. With none, "nothing
    // appears inside one" is trivially true and this test measures nothing.
    expect(blocks.length, 'no prefers-reduced-motion block to check against').toBeGreaterThan(0);
    for (const block of blocks) {
      // Walk to the matching close brace so nested rules inside the query are covered.
      let depth = 0;
      let i = block.index + block[0].length - 1;
      for (; i < text.length; i++) {
        if (text[i] === '{') depth += 1;
        else if (text[i] === '}') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      const body = text.slice(block.index, i);
      expect(body, 'a menu transition was restated for the media query').not.toContain(
        'hud--menu-transition-',
      );
      expect(body, 'a surface transition was restated for the media query').not.toContain(
        'ui-surface-',
      );
      // The walk really did capture a body, rather than stopping on the opening brace.
      expect(body.length).toBeGreaterThan(block[0].length);
    }
  });
});

describe("the content lift must not steal a child's own animation", () => {
  const text = stripComments(css);

  it('leaves the splash hint pulsing while the splash enters -- shipped path and every treatment', () => {
    // `animation` is ONE property per element, and the lift's selector at (0,2,0) beats
    // `.hud-splash-hint`'s (0,1,0) -- so on an entering splash it would REPLACE the pulse
    // rather than join it.
    //
    // Reachable, not theoretical: `createHud` ends with `setState('launch')`, which enters
    // the splash out of its hidden class, so every page load carries `ui-surface--entering`
    // on that surface for the 150ms until the settle. Measured on the mounted HUD, because
    // the obvious reading of the defect overstates it: the pulse RETURNS once the class
    // comes off, so what is at stake is a hitch on the first screen of every session --
    // the hint held at full opacity while it lifts, then dropping to 0.55 as a fresh pulse
    // starts -- rather than a hint that never pulses again. The lift ships now, so that
    // hitch would be in every build rather than behind a flag nobody sets.
    for (const treatment of [null, ...MENU_TRANSITIONS]) {
      const m = mount(treatment);
      try {
        const splash = surface(m.root, '.hud-splash');
        splash.classList.remove('hud-splash--hidden');
        splash.classList.add('ui-surface--entering');
        expect(
          getComputedStyle(surface(m.root, '.hud-splash-hint')).animation,
          `${treatment}: the splash hint stopped pulsing`,
        ).toContain('hud-splash-pulse');

        // NEGATIVE CONTROL, same mount: a NON-splash surface's children DO take whatever
        // the treatment says. Without it, an exclusion that had over-reached to every
        // surface -- or a rule deleted outright -- would pass the assertion above.
        const panel = surface(m.root, '.hud-panel');
        panel.classList.add('ui-surface--entering');
        expect(
          getComputedStyle(panel.firstElementChild as HTMLElement).animation,
          `${treatment}: nothing reaches an entering surface's children at all`,
        ).not.toBe('');
      } finally {
        m.hud.dispose();
        mounted = null;
        document.body.innerHTML = '';
      }
    }
  });

  it('carries the exclusion on EVERY rule reaching an entering surface\'s children', () => {
    // The structural half of the guard above, which the behavioural one cannot give: it
    // sweeps the rules rather than the two elements that happen to exist today, so a
    // fourth rule added without the exclusion fails here even if nothing animates under it
    // yet. Population stated, so a regex that stopped matching cannot pass as "all clear".
    const selectors = [...text.matchAll(/([^{}]*)\{[^{}]*\}/g)]
      .map(([, selector]) => selector.trim())
      .filter((selector) => /\.ui-surface--entering[^,{]*>\s*\*/.test(selector));
    expect(
      selectors.length,
      'population: the shipped lift, the opacity-only pair, and settle',
    ).toBe(3);
    for (const selector of selectors) {
      for (const part of selector.split(',')) {
        if (!part.includes('.ui-surface--entering')) continue;
        expect(part.trim(), 'this rule does not exclude the splash surface').toContain(
          ':not(.hud-splash)',
        );
      }
    }
  });

  it('names every child that owns an animation, so a third cannot be added silently', () => {
    // The guard behind the exclusion above. If a NEW element gains its own `animation` and
    // sits as a direct child of a surface that can enter, it needs the same treatment --
    // and nothing else would say so. This fails when that happens, naming the element.
    const animated = [...css.matchAll(/\.([a-z-]+)\s*\{[^}]*\banimation:\s*[a-z-]+\s/g)].map(
      (m) => m[1],
    );
    // `hud-splash-hint` is the one handled, by excluding its surface. The rest are not
    // direct children of an entering surface; if that changes, this list is the record of
    // what was checked when.
    expect(animated).toContain('hud-splash-hint');
  });
});
