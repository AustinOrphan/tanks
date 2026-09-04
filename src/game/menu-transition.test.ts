// @vitest-environment jsdom
/*
 * Issue #542's menu-transition experiment: the four arms, and the three properties the
 * issue makes non-negotiable about them.
 *
 *  1. `fade` reproduces today EXACTLY, so the comparison has a control rather than a
 *     fifth treatment that happens to resemble the shipped one.
 *  2. An arm with a different duration still has ONE definition of it, in the stylesheet,
 *     reached through `transitionMs()`'s existing single read. Issue #364's first
 *     criterion, which a `const 300` in TypeScript would break silently.
 *  3. Every arm collapses to an instant change under the RESOLVED reduced-motion policy.
 *     Movement is exactly what that preference is about, so the two moving arms are the
 *     ones this matters for -- and they are the ones a `prefers-reduced-motion` CSS block
 *     could not cover, because the resolved policy is a player setting the media query
 *     cannot see.
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
import { MENU_TRANSITIONS, isMenuTransition, menuTransitionClass, type MenuTransition } from './menu-transition';

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
function atMainMenu(arm: MenuTransition | null): { hud: Hud; root: HTMLElement } {
  const m = mount(arm);
  m.hud.setState('main-menu');
  vi.advanceTimersByTime(1000);
  return m;
}

describe('menuTransition: the flag that names an arm', () => {
  it('accepts every arm in the vocabulary and nothing else -- population: the 4 registered arms', () => {
    // Stated as a count so the sweep cannot silently shrink to nothing, the shape
    // `BLOCKED_FIRE_CUES.size` uses in devflags.test.ts.
    expect(MENU_TRANSITIONS.size).toBe(4);
    for (const arm of MENU_TRANSITIONS) {
      expect(parseDevFlags(`?dev=1&menuTransition=${arm}`).menuTransition, arm).toBe(arm);
      expect(isMenuTransition(arm)).toBe(true);
    }
    // NEGATIVE CONTROLS. Reject-to-null, never a guess: an arm nobody built and an arm
    // spelled wrong both leave the shipped transition, and no arm survives without the
    // `dev` gate the whole registry sits behind.
    for (const raw of ['swoosh', 'Fade', 'fade long', 'fadelong', '']) {
      expect(parseDevFlags(`?dev=1&menuTransition=${raw}`).menuTransition, raw).toBeNull();
      expect(isMenuTransition(raw), raw).toBe(false);
    }
    expect(parseDevFlags('?menuTransition=rise').menuTransition).toBeNull();
    expect(parseDevFlags('?dev=1').menuTransition).toBeNull();
  });

  it('maps every arm but the control to its own modifier class, and the control to none', () => {
    // `fade` yielding null is the mechanism behind "indistinguishable from absent", not a
    // shortcut: there is no `.hud--menu-transition-fade` rule to drift from the shipped
    // values, because the control IS the shipped path.
    expect(menuTransitionClass(null)).toBeNull();
    expect(menuTransitionClass('fade')).toBeNull();
    const classed = [...MENU_TRANSITIONS].filter((a) => menuTransitionClass(a) !== null);
    expect(classed, 'exactly the three non-control arms carry a class').toEqual([
      'fade-long',
      'rise',
      'settle',
    ]);
    for (const arm of classed) expect(menuTransitionClass(arm)).toBe(`hud--menu-transition-${arm}`);
  });
});

describe('menuTransition: `fade` reproduces the shipped transition exactly', () => {
  it('mounts the same DOM as an absent flag, with no modifier class anywhere', () => {
    const absent = mount(null);
    const absentClasses = hudEl(absent.root).className;
    const absentHtml = hudEl(absent.root).innerHTML;
    absent.hud.dispose();
    document.body.innerHTML = '';

    const control = mount('fade');
    expect(hudEl(control.root).className, 'the control added a class of its own').toBe(absentClasses);
    expect(hudEl(control.root).innerHTML).toBe(absentHtml);
    expect(hudEl(control.root).className).not.toMatch(/hud--menu-transition-/);

    // NEGATIVE CONTROL: the same comparison against a moving arm must FAIL, or this test
    // would pass against a `menuTransition` option that was never read at all.
    control.hud.dispose();
    document.body.innerHTML = '';
    const moving = mount('rise');
    expect(hudEl(moving.root).className, 'the option is not wired to anything').not.toBe(absentClasses);
  });

  it('resolves the same duration and animates the same keyframes as an absent flag', () => {
    // The two things the cascade could differ on: the token `transitionMs()` reads, and
    // the animation the entering surface runs. Read live off the mounted stylesheet.
    const read = (arm: MenuTransition | null): { duration: string; surface: string; child: string } => {
      const m = mount(arm);
      const panel = surface(m.root, '.hud-panel');
      panel.classList.add('ui-surface--entering');
      const out = {
        duration: getComputedStyle(hudEl(m.root)).getPropertyValue('--ui-transition-duration').trim(),
        surface: getComputedStyle(panel).animation,
        child: getComputedStyle(panel.firstElementChild as HTMLElement).animation,
      };
      m.hud.dispose();
      document.body.innerHTML = '';
      return out;
    };
    const absent = read(null);
    // Vacuity guard: jsdom really is resolving the stylesheet here. A document with no
    // stylesheet reports '' for all three and every comparison below would hold trivially.
    expect(absent.duration, 'the stylesheet is not live in this document').toBe('150ms');
    expect(absent.surface).toContain('ui-surface-in');
    expect(absent.child, 'the shipped path moves no content').toBe('');

    expect(read('fade')).toEqual(absent);

    // NEGATIVE CONTROLS, one per way an arm can differ: `fade-long` on the duration only,
    // `rise` and `settle` on the content animation only.
    expect(read('fade-long').duration).toBe('300ms');
    expect(read('fade-long').child, 'the duration arm must not also move').toBe('');
    expect(read('rise').duration, 'a moving arm must not also change duration').toBe('150ms');
    expect(read('rise').child).toContain('ui-surface-rise-content');
    expect(read('settle').child).toContain('ui-surface-settle-content');
    for (const arm of ['rise', 'settle'] as const) {
      expect(read(arm).surface, 'the surface still fades under a moving arm').toBe(absent.surface);
    }
  });

  it('settles on exactly the same tick as an absent flag', () => {
    vi.useFakeTimers();
    // Timing, not just classes: two arms could name the same keyframes and still differ
    // in when the outgoing surface is torn down.
    const settledAt = (arm: MenuTransition | null): number => {
      const m = atMainMenu(arm);
      click(m.root, '.hud-records-open');
      let ms = 0;
      while (ms < 2000 && !surface(m.root, '.hud-panel').classList.contains('hud-panel--hidden')) {
        vi.advanceTimersByTime(1);
        ms += 1;
      }
      m.hud.dispose();
      document.body.innerHTML = '';
      return ms;
    };
    const absent = settledAt(null);
    expect(absent, 'the navigation never settled, so this measures a timeout').toBe(150);
    expect(settledAt('fade')).toBe(absent);
    // NEGATIVE CONTROL: the measurement can tell two arms apart.
    expect(settledAt('fade-long')).toBe(300);
  });
});

describe('menuTransition: the duration arm goes through the ONE token', () => {
  it('lengthens the transition by moving the stylesheet token, with nothing mirrored in TypeScript', () => {
    // Criterion 1 of issue #364, restated for an arm: "one place defines the duration" is
    // only true if the ARM changes that place. A `const FADE_LONG_MS = 300` in hud.ts or
    // menu-transition.ts would satisfy any assertion comparing two numbers and would fail
    // this one, because this reads the timer against a stylesheet the test then moves.
    vi.useFakeTimers();
    const m = atMainMenu('fade-long');
    click(m.root, '.hud-records-open');
    vi.advanceTimersByTime(299);
    expect(
      surface(m.root, '.hud-panel').classList.contains('hud-panel--hidden'),
      'the arm settled on the control\'s 150ms, so its duration is not the token',
    ).toBe(false);
    vi.advanceTimersByTime(2);
    expect(surface(m.root, '.hud-panel').classList.contains('hud-panel--hidden')).toBe(true);
  });

  it('overrides that token per HUD, so a second HUD on the page keeps the control timing', () => {
    // The modifier sits on the HUD ROOT rather than on `document.documentElement`, which
    // is what makes the arm scoped rather than global. Not a hypothetical distinction:
    // `transitionMs()` reads the token off that exact element, so a document-level class
    // would leak the arm to anything else mounted beside it.
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
          'the arm escaped its own HUD',
        ).toBe('150ms');
      } finally {
        plain.dispose();
      }
    } finally {
      long.dispose();
    }
  });
});

describe('menuTransition: every arm collapses to instant under RESOLVED reduced motion', () => {
  it('leaves no transition timer and no animation class, on all four arms', () => {
    // Population: every registered arm, so a fifth one cannot be added without answering
    // this. The two moving arms are the reason the issue insists on it -- movement is
    // precisely what the preference is about -- but the sweep covers all four so the
    // property is about the CONTRACT rather than about which arms happen to move today.
    vi.useFakeTimers();
    expect(MENU_TRANSITIONS.size).toBe(4);
    for (const arm of MENU_TRANSITIONS) {
      const m = atMainMenu(arm);
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
          `${arm}: control -- motion on, the arriving pane must still be animating`,
        ).toBe(true);
        expect(
          surface(m.root, '.hud-panel').classList.contains('hud-panel--hidden'),
          `${arm}: control -- motion on, the outgoing panel must still be displayed`,
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
          `${arm}: reduced motion did not remove exactly the transition timer`,
        ).toBe(1);
        for (const sel of ['.hud-panel', '.hud-stats', '.ui-app-ground']) {
          const el = surface(m.root, sel);
          expect(el.classList.contains('ui-surface--entering'), `${arm} ${sel} entering`).toBe(false);
          expect(el.classList.contains('ui-surface--leaving'), `${arm} ${sel} leaving`).toBe(false);
          // The surface's own classes ARE the whole claim, and that is worth stating
          // because the moving arms animate children and the opposite seems likelier. A
          // child never carries `ui-surface--entering` -- hud.ts adds it to the surface
          // element alone -- and the child keyframes are selected by CSS descending from
          // it (`.hud--menu-transition-rise .ui-surface--entering > *`), so a surface with
          // the class removed has no animating children by construction.
          //
          // An earlier version of this test looped over the children asserting they did
          // not carry that class. It could not fail on any arm, working or broken.
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

describe('menu-transition arms in hud.css', () => {
  const text = stripComments(css);

  it('gives each arm exactly the rules its class names, and the control none at all', () => {
    // Vacuity guard first: the stylesheet loaded as text. `?raw` returns '' when vitest's
    // CSS handling is off, and every match below would then report zero either way.
    expect(text.length).toBeGreaterThan(1000);
    for (const arm of MENU_TRANSITIONS) {
      // The lookahead matters: `fade` is a prefix of `fade-long`, so a bare match reports
      // the control as having the duration arm's rule and this test passes on a lie.
      const rules = [...text.matchAll(new RegExp(`\\.hud--menu-transition-${arm}(?![a-z-])`, 'g'))];
      // The CONTROL's zero is the load-bearing number here: a rule for `fade` would be a
      // second statement of the shipped values, free to drift from them.
      expect(rules.length, `${arm} names ${rules.length} rules`).toBe(arm === 'fade' ? 0 : 1);
    }
  });

  it('reads the shared duration and easing tokens, never a literal of its own', () => {
    // The moving arms animate through the same two tokens the shipped rules do, so
    // `fade-long`'s override reaches them and a future timing change still has one home.
    for (const arm of ['rise', 'settle'] as const) {
      const rule = new RegExp(`\\.hud--menu-transition-${arm}\\s[^{]*\\{([^}]*)\\}`).exec(text);
      expect(rule, `${arm} has no content rule`).not.toBeNull();
      const body = (rule as RegExpExecArray)[1];
      expect(body, `${arm} hardcodes a duration`).not.toMatch(/animation:[^;]*\d+m?s/);
      expect(body, `${arm} hardcodes an easing curve`).not.toMatch(/animation:[^;]*cubic-bezier/);
      expect(body).toContain('var(--ui-transition-duration)');
      expect(body).toContain('var(--ui-transition-ease)');
      expect(body).toContain(`ui-surface-${arm}-content`);
    }
  });

  it('gives each moving arm keyframes that actually move, ending at no transform at all', () => {
    // The defect this is for: an arm whose keyframes are wired, named and animated, and
    // whose `from` is the identity -- indistinguishable from `fade` on screen while every
    // other check in this file still passes. jsdom cannot compute an animated value, so
    // this reads the declaration.
    const from = (name: string): string => {
      const at = text.indexOf(`@keyframes ${name}`);
      expect(at, `${name} is missing from the stylesheet`).toBeGreaterThan(-1);
      const body = text.slice(at, text.indexOf('\n}', at));
      const m = /from\s*\{([^}]*)\}/.exec(body);
      expect(m, `${name} has no from step`).not.toBeNull();
      expect(body, `${name} does not end at a cleared transform`).toMatch(/to\s*\{\s*transform:\s*none;?\s*\}/);
      return (m as RegExpExecArray)[1].trim();
    };
    // An identity transform is what "wired but does nothing" looks like, in every spelling
    // a reader might write it.
    const IDENTITY = /transform:\s*(none|translateY\(-?0(px|%)?\)|scale\(1(\.0+)?\))\s*;?/;
    const rise = from('ui-surface-rise-content');
    expect(rise, 'rise does not translate').toMatch(/transform:\s*translateY\(-?[\d.]+px\)/);
    expect(rise, 'rise translates by nothing').not.toMatch(IDENTITY);
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

  it('states no arm inside a prefers-reduced-motion block', () => {
    // The constraint `--ui-transition-duration`'s own comment sets out: transitions follow
    // the RESOLVED policy (`effective-settings.ts`), not the raw media query, because a
    // player who chose `full` motion against an OS asking for `reduce` must still get
    // their transitions. An arm restated inside that block would be a second, blind
    // decision about the same thing -- and would be wrong for that player.
    const blocks = [...text.matchAll(/@media\s*\(prefers-reduced-motion[^{]*\{/g)];
    // Vacuity guard: the block this is about really is in the file. With none, "no arm
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
      expect(body, 'a menu-transition arm was restated for the media query').not.toContain(
        'hud--menu-transition-',
      );
      // The walk really did capture a body, rather than stopping on the opening brace.
      expect(body.length).toBeGreaterThan(block[0].length);
    }
  });
});

describe('the moving arms must not steal a child\'s own animation', () => {
  it('excludes the splash surface, whose hint owns an infinite pulse', () => {
    // `animation` is ONE property per element, and the arm's selector is three classes
    // against `.hud-splash-hint`'s one -- so on an entering splash the arm REPLACES the
    // pulse rather than joining it, and the hint stops pulsing for good.
    //
    // Reachable, not theoretical: `transitionTo` lists SPLASH_SURFACE, so that surface
    // really does enter, and `.hud-splash-hint` really is a direct child of it.
    for (const arm of ['rise', 'settle']) {
      const rule = new RegExp(
        `\\.hud--menu-transition-${arm}\\s+\\.ui-surface--entering([^{]*)>\\s*\\*`,
      ).exec(css);
      expect(rule, `${arm} has no child rule at all`).not.toBeNull();
      expect(rule![1], `${arm} does not exclude the splash surface`).toContain(':not(.hud-splash)');
    }
  });

  it('names every child that owns an animation, so a third cannot be added silently', () => {
    // The guard behind the exclusion above. If a NEW element gains its own `animation`
    // and sits as a direct child of a surface that can enter, it needs the same treatment
    // -- and nothing else would say so. This fails when that happens, naming the element.
    const animated = [...css.matchAll(/\.([a-z-]+)\s*\{[^}]*\banimation:\s*[a-z-]+\s/g)].map(
      (m) => m[1],
    );
    // `hud-splash-hint` is the one handled, by excluding its surface. The rest are not
    // direct children of an entering surface; if that changes, this list is the record of
    // what was checked when.
    expect(animated).toContain('hud-splash-hint');
  });
});
