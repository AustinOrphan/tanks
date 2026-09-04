// @vitest-environment jsdom
/*
 * Issue #552's ruling: `spare-chips` is the gameplay topbar, and the five other arms stay
 * selectable behind `?dev=1&topbar=`. These are the properties that keep that true.
 *
 *  1. The SHIPPED arm departs from nothing. It is not a description of the bar that has
 *     to be kept in step with it -- it is the absence of every override, so the default
 *     cannot drift from the thing every player sees. Guarded against
 *     `SHIPPED_TOPBAR_TREATMENT` rather than a spelled-out name, so the ruling MOVED that
 *     guard from `full` to `spare-chips` instead of leaving it aimed at an arm that no
 *     longer holds the property -- the shape `menu-transition.test.ts` arrived at when
 *     `rise` took it from `fade` (#549).
 *  2. `full` reproduces the PRE-RULING bar, character for character, at every session.
 *     It is now the arm carrying every restoration, and it is how anyone gets today's bar
 *     back; an arm that only approximately restored it would make a regression report
 *     unanswerable. The expected markup below was measured against `origin/main`.
 *  3. No arm adds a class or a stylesheet rule. The arms differ in what the bar SAYS, so
 *     they show and hide with the `--hidden` modifiers the bar already has; an arm that
 *     restyled a chip would make `full` a lookalike rather than the bar itself.
 *  4. What each arm actually reads on screen, per session kind, as one table.
 *  5. The two versus shapes are kept apart. A setup-pane match runs a ONE-level system
 *     and has never shown a level chip, before the ruling or after; only `?dev=1&mode=ffa`,
 *     which runs the campaign level system, has one, and the shipped bar drops it as a
 *     DESIGN choice -- the `VS` chip takes that slot. Issue #552's fifth question assumed
 *     the shipped versus bar carried `Level: 1/5` and it did not; that claim was measured
 *     false and retracted.
 *
 * The bar is read the way a player sees it -- the topbar's visible children, in order --
 * rather than by asserting class names, because what is being compared is the READING.
 * `hud.ts` imports `./hud.css` and vitest is configured with `css: true`, so the `--hidden`
 * rules are live in this document; the first case in the readings block fails outright if
 * they are not, which is what stops every other reading here from silently including
 * hidden chips.
 */
import { afterEach, describe, expect, it } from 'vitest';
import css from './hud.css?raw';
import { createHud, type GameplayStatus, type Hud } from './hud';
import { parseDevFlags } from './devflags';
import {
  MODE_CHIP_LABELS,
  SHIPPED_TOPBAR_TREATMENT,
  TOPBAR_TREATMENTS,
  isTopbarTreatment,
  topbarDepartures,
  type TopbarDepartures,
  type TopbarTreatment,
} from './topbar-treatment';

let mounted: Hud | null = null;

/** A HUD on the `playing` surface: the stock strip is in-match chrome and shows nowhere else. */
function mount(topbar: TopbarTreatment | null): { hud: Hud; root: HTMLElement } {
  const root = document.createElement('div');
  document.body.appendChild(root);
  mounted = createHud(root, { topbar });
  mounted.setState('playing');
  return { hud: mounted, root };
}

function unmount(): void {
  mounted?.dispose();
  mounted = null;
  document.body.innerHTML = '';
}

afterEach(unmount);

const hudEl = (root: HTMLElement): HTMLElement => root.querySelector('.hud') as HTMLElement;
const barEl = (root: HTMLElement): HTMLElement => root.querySelector('.hud-topbar') as HTMLElement;

/**
 * The topbar as it reads on screen: every child the cascade is actually showing, in
 * order, joined by ` | `.
 *
 * The stock strip is joined from its own spans because it renders one element per slot
 * with no separator between them, so its raw `textContent` reads `P1 3P2 3`.
 */
function reading(root: HTMLElement): string {
  const parts: string[] = [];
  for (const child of Array.from(barEl(root).children) as HTMLElement[]) {
    if (getComputedStyle(child).display === 'none') continue;
    const raw = child.classList.contains('hud-versus-stocks')
      ? Array.from(child.children)
          .map((entry) => entry.textContent ?? '')
          .join(' ')
      : (child.textContent ?? '');
    const text = raw.replace(/\s+/g, ' ').trim();
    if (text !== '') parts.push(text);
  }
  return parts.join(' | ');
}

/**
 * The topbar's markup, normalised for comparison against the pre-ruling capture below.
 *
 * Exactly three normalisations, and each is an absence of meaning rather than a place to
 * hide a difference:
 *
 *  - HTML COMMENTS are stripped. They render nothing, and the markup gained a comment
 *    about `hud-enemy-stat` that a player cannot see.
 *  - WHITESPACE between elements is collapsed, because the template's indentation is not
 *    a reading either.
 *  - `hud-enemy-stat` is dropped from the class attribute. It is the handle applyStatus
 *    needs to hide that one stat, added by this change; the case below in "adds no class
 *    and no stylesheet rule" proves it matches nothing in `hud.css`, so removing it from
 *    the comparison removes a name and never a rule.
 *
 * Everything else -- element order, every other class including every `--hidden`
 * modifier, every text node, the stock strip's inline colours -- has to match exactly.
 */
function markup(root: HTMLElement): string {
  return barEl(root)
    .outerHTML.replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+/g, ' ')
    .replace(/ hud-enemy-stat/g, '')
    .trim();
}

/**
 * The four sessions the arms are read at. `campaign` and `practice` are the two board
 * kinds; the two versus entries are the SHAPES a versus session comes in, and they differ
 * on exactly the field question 5 was about -- the length of the level sequence.
 */
const SESSIONS = {
  campaign: { kind: 'campaign', mission: 1, missions: 5, lives: 3, enemies: 3 },
  practice: { kind: 'practice', mission: 1, missions: 5, lives: 3, enemies: 3 },
  /** `?dev=1&mode=ffa`: a real versus world ON the campaign level system, so `1/5` is true. */
  'versus-on-campaign-levels': {
    kind: 'versus',
    mission: 1,
    missions: 5,
    stocks: [
      { slot: 0, stock: 3 },
      { slot: 1, stock: 3 },
    ],
  },
  /** The setup pane's own match: one synthetic level, so the chip has never been shown. */
  'versus-setup-match': {
    kind: 'versus',
    mission: 1,
    missions: 1,
    stocks: [
      { slot: 0, stock: 3 },
      { slot: 1, stock: 3 },
    ],
  },
} satisfies Record<string, GameplayStatus>;

type SessionName = keyof typeof SESSIONS;

const SESSION_NAMES = Object.keys(SESSIONS) as SessionName[];

/**
 * WHAT EACH ARM SAYS, at each of the four sessions. The comparison the ruling was made
 * from, written down, with `spare-chips` now the column every player sees.
 *
 * The chips read `Campaign`/`Practice`/`VS` here and render uppercase -- `.hud-practice`
 * sets `text-transform`, which a jsdom `textContent` does not apply.
 */
const READINGS: Record<TopbarTreatment, Record<SessionName, string>> = {
  full: {
    campaign: 'Lives: 3 | Enemies: 3 | Level: 1/5',
    practice: 'Practice | Lives: 3 | Enemies: 3 | Level: 1/5',
    'versus-on-campaign-levels': 'Level: 1/5 | P1 3 P2 3',
    'versus-setup-match': 'P1 3 P2 3',
  },
  spare: {
    campaign: 'Lives: 3 | Level: 1',
    practice: 'Practice | Lives: 3 | Level: 1',
    'versus-on-campaign-levels': 'Level: 1 | P1 3 P2 3',
    'versus-setup-match': 'P1 3 P2 3',
  },
  'mode-chips': {
    campaign: 'Campaign | Lives: 3 | Enemies: 3 | Level: 1/5',
    practice: 'Practice | Lives: 3 | Enemies: 3 | Level: 1/5',
    'versus-on-campaign-levels': 'VS | P1 3 P2 3',
    'versus-setup-match': 'VS | P1 3 P2 3',
  },
  'spare-chips': {
    campaign: 'Campaign | Lives: 3 | Level: 1',
    practice: 'Practice | Lives: 3 | Level: 1',
    'versus-on-campaign-levels': 'VS | P1 3 P2 3',
    'versus-setup-match': 'VS | P1 3 P2 3',
  },
  'enemies-only': {
    campaign: 'Lives: 3 | Level: 1/5',
    practice: 'Practice | Lives: 3 | Level: 1/5',
    'versus-on-campaign-levels': 'Level: 1/5 | P1 3 P2 3',
    'versus-setup-match': 'P1 3 P2 3',
  },
  'denominator-only': {
    campaign: 'Lives: 3 | Enemies: 3 | Level: 1',
    practice: 'Practice | Lives: 3 | Enemies: 3 | Level: 1',
    'versus-on-campaign-levels': 'Level: 1 | P1 3 P2 3',
    'versus-setup-match': 'P1 3 P2 3',
  },
};

/**
 * THE PRE-RULING BAR, as `origin/main` renders it -- the four topbars `full` has to
 * reproduce.
 *
 * MEASURED, not transcribed: `origin/main`'s `hud.ts` was checked out beside this one and
 * mounted through `createHud` at each of the four sessions on the `playing` surface, and
 * these are the `markup()` strings that came back. Recording an implementation's output
 * is normally the thing to avoid, but this is a recording of a bar that no longer exists
 * in the tree, which is exactly what `full` claims to restore and the only way to hold it
 * to that claim.
 */
const PRE_RULING_TOPBAR: Record<SessionName, string> = {
  campaign:
    '<div class="hud-topbar"> <div class="hud-stat hud-practice hud-practice--hidden">Practice</div> <div class="hud-stat hud-campaign-stat">Lives: <span class="hud-lives">3</span></div> <div class="hud-stat hud-campaign-stat">Enemies: <span class="hud-enemies">3</span></div> <div class="hud-stat hud-level">Level: <span class="hud-level-num">1/5</span></div> <div class="hud-shells hud-shells--hidden"></div> <div class="hud-versus-stocks hud-versus-stocks--hidden"></div> </div>',
  practice:
    '<div class="hud-topbar"> <div class="hud-stat hud-practice">Practice</div> <div class="hud-stat hud-campaign-stat">Lives: <span class="hud-lives">3</span></div> <div class="hud-stat hud-campaign-stat">Enemies: <span class="hud-enemies">3</span></div> <div class="hud-stat hud-level">Level: <span class="hud-level-num">1/5</span></div> <div class="hud-shells hud-shells--hidden"></div> <div class="hud-versus-stocks hud-versus-stocks--hidden"></div> </div>',
  'versus-on-campaign-levels':
    '<div class="hud-topbar"> <div class="hud-stat hud-practice hud-practice--hidden">Practice</div> <div class="hud-stat hud-campaign-stat hud-campaign-stat--hidden">Lives: <span class="hud-lives">3</span></div> <div class="hud-stat hud-campaign-stat hud-campaign-stat--hidden">Enemies: <span class="hud-enemies">3</span></div> <div class="hud-stat hud-level">Level: <span class="hud-level-num">1/5</span></div> <div class="hud-shells hud-shells--hidden"></div> <div class="hud-versus-stocks"><span class="hud-versus-stock-entry" style="color: rgb(63, 208, 255);">P1 3</span><span class="hud-versus-stock-entry" style="color: rgb(255, 138, 30);">P2 3</span></div> </div>',
  'versus-setup-match':
    '<div class="hud-topbar"> <div class="hud-stat hud-practice hud-practice--hidden">Practice</div> <div class="hud-stat hud-campaign-stat hud-campaign-stat--hidden">Lives: <span class="hud-lives">3</span></div> <div class="hud-stat hud-campaign-stat hud-campaign-stat--hidden">Enemies: <span class="hud-enemies">3</span></div> <div class="hud-stat hud-level hud-level--hidden">Level: <span class="hud-level-num"></span></div> <div class="hud-shells hud-shells--hidden"></div> <div class="hud-versus-stocks"><span class="hud-versus-stock-entry" style="color: rgb(63, 208, 255);">P1 3</span><span class="hud-versus-stock-entry" style="color: rgb(255, 138, 30);">P2 3</span></div> </div>',
};

describe('topbar: the flag that names an arm', () => {
  it('accepts every name in the vocabulary and nothing else -- population: the 6 registered arms', () => {
    // Stated as a count so the sweep cannot silently shrink to nothing, the shape
    // `MENU_TRANSITIONS.size` and `BLOCKED_FIRE_CUES.size` already use.
    expect(TOPBAR_TREATMENTS.size).toBe(6);
    for (const arm of TOPBAR_TREATMENTS) {
      expect(parseDevFlags(`?dev=1&topbar=${arm}`).topbar, arm).toBe(arm);
      expect(isTopbarTreatment(arm), arm).toBe(true);
    }
    // NEGATIVE CONTROLS. Reject-to-null, never a guess: an arm nobody built, an arm named
    // in the issue's first draft but not built (`spare-labelled`), a near-miss spelling,
    // and the wrong case all leave the shipped bar -- and nothing survives without the
    // `dev` gate the whole registry sits behind.
    for (const raw of ['sparse', 'spare-labelled', 'modechips', 'Full', '']) {
      expect(parseDevFlags(`?dev=1&topbar=${raw}`).topbar, raw).toBeNull();
      expect(isTopbarTreatment(raw), raw).toBe(false);
    }
    expect(parseDevFlags('?topbar=spare').topbar).toBeNull();
    expect(parseDevFlags('?dev=1').topbar).toBeNull();
  });

  it('gives the SHIPPED arm no departures at all, and every other arm at least one', () => {
    // The mechanism behind "indistinguishable from absent", not a shortcut: there is no
    // row that restates the shipped bar, so the default cannot drift from it. This is the
    // property the ruling MOVED -- `full` held it while the comparison ran.
    expect(topbarDepartures(null)).toEqual(topbarDepartures(SHIPPED_TOPBAR_TREATMENT));
    expect(Object.values(topbarDepartures(SHIPPED_TOPBAR_TREATMENT))).toEqual([
      false,
      false,
      false,
    ]);

    const changed = [...TOPBAR_TREATMENTS].filter((arm) =>
      Object.values(topbarDepartures(arm)).some(Boolean),
    );
    expect(changed, 'exactly the five non-shipped arms change something').toEqual(
      [...TOPBAR_TREATMENTS].filter((arm) => arm !== SHIPPED_TOPBAR_TREATMENT),
    );
    // Population and identity, so the filter above cannot pass by matching nothing.
    expect(changed.length).toBe(5);
    expect(changed).toEqual([
      'full',
      'spare',
      'mode-chips',
      'enemies-only',
      'denominator-only',
    ]);
  });

  it('keeps the two single-removal arms genuinely single, measured against `full`', () => {
    // The arm NAMES describe removals from the pre-ruling bar, because that is the
    // vocabulary the ruling was made in; the departures table is keyed off the shipped
    // bar, which is the opposite end. So the property those names promise is stated where
    // it belongs -- as the distance from `full` -- rather than being read off the table's
    // own polarity and quietly inverted with it.
    const full = topbarDepartures('full');
    const keys = Object.keys(full) as (keyof TopbarDepartures)[];
    expect(keys.length, 'three switches').toBe(3);
    // `full` restores everything: it IS every departure from the shipped bar at once.
    expect(Object.values(full)).toEqual([true, true, true]);
    const from = (arm: TopbarTreatment): (keyof TopbarDepartures)[] =>
      keys.filter((k) => topbarDepartures(arm)[k] !== full[k]);
    // NEGATIVE CONTROL for the comparator: `full` differs from itself in nothing, so a
    // `from` that returned every key regardless would not pass this line.
    expect(from('full')).toEqual([]);
    // The reason these two arms exist: the content removals have to be judgeable APART.
    expect(from('enemies-only')).toEqual(['restoreEnemies']);
    expect(from('denominator-only')).toEqual(['restoreDenominator']);
    // `spare` is exactly their union; `mode-chips` isolates the chip question by itself;
    // and the shipped bar is all three removals together, which is what `spare-chips`
    // named while it was still an arm.
    expect(from('spare')).toEqual(['restoreEnemies', 'restoreDenominator']);
    expect(from('mode-chips')).toEqual(['exceptionChip']);
    expect(from(SHIPPED_TOPBAR_TREATMENT)).toEqual(keys);
  });
});

describe('topbar: the SHIPPED arm is the no-flag bar itself', () => {
  it('mounts the same topbar as an absent flag, at every session, with no class of its own', () => {
    for (const name of SESSION_NAMES) {
      const absent = mount(null);
      absent.hud.setStatus(SESSIONS[name]);
      const absentBar = barEl(absent.root).outerHTML;
      const absentClasses = hudEl(absent.root).className;
      unmount();

      const shipped = mount(SHIPPED_TOPBAR_TREATMENT);
      shipped.hud.setStatus(SESSIONS[name]);
      expect(
        barEl(shipped.root).outerHTML,
        `${name}: the shipped arm rendered a different bar`,
      ).toBe(absentBar);
      expect(hudEl(shipped.root).className, `${name}: the shipped arm added a class`).toBe(
        absentClasses,
      );
      unmount();

      // NEGATIVE CONTROL: the same comparison against an arm that changes this session
      // must FAIL, or this would pass against a `topbar` option that was never read at
      // all. `full` is the one arm that differs at all four sessions.
      const other = mount('full');
      other.hud.setStatus(SESSIONS[name]);
      expect(
        barEl(other.root).outerHTML,
        `${name}: the option is not wired to anything`,
      ).not.toBe(absentBar);
      unmount();
    }
  });

  it('adds no class and no stylesheet rule for any arm -- the arms change readings, never restyle them', () => {
    const absent = mount(null);
    const absentClasses = hudEl(absent.root).className;
    unmount();
    for (const arm of TOPBAR_TREATMENTS) {
      const m = mount(arm);
      m.hud.setStatus(SESSIONS.campaign);
      expect(hudEl(m.root).className, arm).toBe(absentClasses);
      unmount();
    }
    // The stylesheet half. `.hud-enemy-stat` is a HANDLE for the enemy count, and the
    // claim in its markup comment -- and the licence for `markup()` to strip it before
    // comparing against the pre-ruling capture -- is that it adds nothing to the cascade.
    // A rule for it, or a `hud--topbar-` modifier, would make an arm a restyling.
    expect(css).not.toMatch(/hud--topbar-/);
    expect(css).not.toMatch(/\.hud-enemy-stat\b/);
    // Vacuity guard: this file really is reading the stylesheet, so the two absences
    // above are absences rather than an empty string matching nothing.
    expect(css).toMatch(/\.hud-campaign-stat--hidden\s*\{\s*display:\s*none/);
  });
});

describe('topbar: `full` is the pre-ruling bar', () => {
  it('reproduces the bar `origin/main` renders, at every session, class for class', () => {
    for (const name of SESSION_NAMES) {
      const m = mount('full');
      m.hud.setStatus(SESSIONS[name]);
      expect(markup(m.root), `${name}: full no longer restores the pre-ruling bar`).toBe(
        PRE_RULING_TOPBAR[name],
      );
      unmount();
    }
    // NEGATIVE CONTROL, and the whole point of the ruling: the SHIPPED bar is not the
    // pre-ruling one at any session. Without this, a `full` that had quietly become a
    // second name for the default would pass every line above.
    for (const name of SESSION_NAMES) {
      const m = mount(null);
      m.hud.setStatus(SESSIONS[name]);
      expect(markup(m.root), `${name}: the shipped bar changed nothing`).not.toBe(
        PRE_RULING_TOPBAR[name],
      );
      unmount();
    }
  });
});

describe('topbar: what each arm says', () => {
  it('carries no chip and no enemy count before a session lands -- the cascade this suite reads is live', () => {
    // The vacuity guard for every reading below. A HUD that has been told nothing keeps
    // the markup's own Lives/Enemies numbers (applyStatus deliberately does not blank
    // them; the whole bar is hidden on every surface that can be up with no session), but
    // there is no mode to name and the shipped bar has no enemy count either way, so one
    // reading is left. Without a live stylesheet this would read
    // `Practice | Lives: 3 | Enemies: 3 | Level:` -- which is also what a build that lost
    // the `--hidden` rules would put in front of a player.
    const { root } = mount(null);
    expect(reading(root)).toBe('Lives: 3');
    // NEGATIVE CONTROL: a status lands and the same reader reports the bar, so an empty
    // string is not what this helper returns for everything.
    mounted?.setStatus(SESSIONS.campaign);
    expect(reading(root)).toBe(READINGS['spare-chips'].campaign);
  });

  it('reads exactly the comparison table, for every arm at every session', () => {
    expect(Object.keys(READINGS).length, 'one column per arm').toBe(TOPBAR_TREATMENTS.size);
    for (const arm of TOPBAR_TREATMENTS) {
      for (const name of SESSION_NAMES) {
        const m = mount(arm);
        m.hud.setStatus(SESSIONS[name]);
        expect(reading(m.root), `${arm} @ ${name}`).toBe(READINGS[arm][name]);
        unmount();
      }
    }
    // NEGATIVE CONTROL, stated as a property of the table rather than of one mount: every
    // arm but the shipped one differs from the default somewhere, so a table filled with
    // six copies of one bar -- which is what a `topbar` option nothing reads would
    // produce -- cannot pass this suite.
    for (const arm of TOPBAR_TREATMENTS) {
      const differs = SESSION_NAMES.some(
        (name) => READINGS[arm][name] !== READINGS[SHIPPED_TOPBAR_TREATMENT][name],
      );
      expect(differs, arm).toBe(arm !== SHIPPED_TOPBAR_TREATMENT);
    }
  });

  it('labels the kind it is actually showing, and labels nothing when no session is live', () => {
    // The chip is a FIELD on the shipped bar, so it has to follow the session rather than
    // be written once at construction: a Levels pick really does change the kind on a live
    // HUD (`loop.ts` re-pushes the status on every world build).
    const { hud, root } = mount(null);
    const chip = (): HTMLElement => root.querySelector('.hud-practice') as HTMLElement;
    hud.setStatus(SESSIONS.campaign);
    expect(chip().textContent).toBe(MODE_CHIP_LABELS.campaign);
    hud.setStatus(SESSIONS.practice);
    expect(chip().textContent).toBe(MODE_CHIP_LABELS.practice);
    hud.setStatus(SESSIONS['versus-setup-match']);
    expect(chip().textContent).toBe(MODE_CHIP_LABELS.versus);
    // No live session is no mode to read out. NEGATIVE CONTROL for the lines above: if
    // the chip were simply nailed open, this would still read `VS` over an empty bar.
    hud.setStatus(null);
    expect(getComputedStyle(chip()).display, 'a chip over no session at all').toBe('none');
  });

  it('gives Practice the chip it already had, and exactly one of it', () => {
    // #324's step S6 put a PRACTICE chip in this bar as an exception marker. The ruling
    // GENERALISED that element rather than adding a mode chip beside it, so Practice's
    // chip is the same node, the same `.hud-practice` class and the same word as before
    // -- and `full` writes that same word back, which is why the pre-ruling capture above
    // matches character for character. If the two mechanisms had been separate, the
    // Practice bar would carry the word twice.
    const { hud, root } = mount(null);
    hud.setStatus(SESSIONS.practice);
    const chips = barEl(root).querySelectorAll('.hud-practice');
    expect(chips.length, 'one chip element, not two').toBe(1);
    const shown = (Array.from(barEl(root).children) as HTMLElement[]).filter(
      (child) => getComputedStyle(child).display !== 'none',
    );
    expect(
      shown.filter((child) => (child.textContent ?? '').trim() === MODE_CHIP_LABELS.practice)
        .length,
      'the word PRACTICE appears once on screen',
    ).toBe(1);
    // The chip's own styling is untouched: the visible chip carries the markup's two
    // classes and no modifier of its own.
    expect((chips[0] as HTMLElement).className).toBe('hud-stat hud-practice');
    // NEGATIVE CONTROL: the same one element is what campaign reads through, so this is a
    // generalised chip and not a Practice chip with two more hidden beside it.
    hud.setStatus(SESSIONS.campaign);
    expect(barEl(root).querySelectorAll('.hud-practice').length).toBe(1);
    expect((chips[0] as HTMLElement).textContent).toBe(MODE_CHIP_LABELS.campaign);
  });
});

describe('topbar: the two versus shapes, which question 5 conflated', () => {
  it('showed no level chip on a setup-pane match BEFORE the ruling either', () => {
    // Issue #552's fifth question read the versus bar as `Level: 1/5   P1 3  P2 3` and
    // called the ordinal meaningless there. Measured on the built app and retracted in
    // the issue: the bar a player reaches through Versus Setup carried no chip at all, at
    // 360, 390, 640, 1280 and 1920 -- its level system has ONE synthetic level, and
    // `missions > 1` was already false. `full` is where that bar still lives.
    const { hud, root } = mount('full');
    hud.setStatus(SESSIONS['versus-setup-match']);
    expect(reading(root)).toBe('P1 3 P2 3');
    // NEGATIVE CONTROL, and the session the issue's table actually described: the same
    // kind on the CAMPAIGN level system (`?dev=1&mode=ffa`) did show the chip -- so this
    // was never a HUD hiding the chip for versus, it was a sequence with nothing to say.
    hud.setStatus(SESSIONS['versus-on-campaign-levels']);
    expect(reading(root)).toBe('Level: 1/5 | P1 3 P2 3');
  });

  it('drops it on the shipped bar, where the VS chip takes that slot', () => {
    const { hud, root } = mount(null);
    hud.setStatus(SESSIONS['versus-on-campaign-levels']);
    expect(reading(root)).toBe('VS | P1 3 P2 3');
    // NEGATIVE CONTROL: the shipped bar drops the chip for VERSUS, not for everything --
    // a campaign session keeps the ordinal it is genuinely climbing.
    hud.setStatus(SESSIONS.campaign);
    expect(reading(root)).toBe(READINGS['spare-chips'].campaign);
  });
});
