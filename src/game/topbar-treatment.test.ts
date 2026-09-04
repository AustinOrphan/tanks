// @vitest-environment jsdom
/*
 * Issue #552's topbar comparison: six arms, and the properties that keep the comparison
 * honest while the owner rules on it.
 *
 *  1. The SHIPPED arm departs from nothing. `full` is not a description of today's bar
 *     that has to be kept in step with it -- it is the absence of every override, so the
 *     control cannot drift from the thing it is a control for. Guarded against
 *     `SHIPPED_TOPBAR_TREATMENT` rather than a spelled-out name, so a ruling that adopts
 *     an arm moves the guard with the default, the shape `menu-transition.test.ts`
 *     arrived at after `fade` handed that property to `rise`.
 *  2. No arm adds a class or a stylesheet rule. The arms differ in what the bar SAYS, so
 *     they hide with the `--hidden` modifiers the bar already has; an arm that restyled a
 *     chip would make a capture a comparison of two bars rather than of one bar with
 *     something taken out of it.
 *  3. What each arm actually reads on screen, per session kind, as one table. That table
 *     IS the comparison the issue asks to be ruled from, so it is written down once and
 *     asserted rather than described in prose that a later edit can quietly falsify.
 *  4. The two versus shapes are kept apart. A setup-pane match runs a ONE-level system
 *     and has never shown a level chip; only `?dev=1&mode=ffa`, which runs the campaign
 *     level system, has one to drop. Issue #552's fifth question assumes the shipped
 *     versus bar carries `Level: 1/5`, and it does not.
 *
 * The bar is read the way a player sees it -- the topbar's visible children, in order --
 * rather than by asserting class names, because what is being compared is the READING.
 * `hud.ts` imports `./hud.css` and vitest is configured with `css: true`, so the `--hidden`
 * rules are live in this document; the first case below fails outright if they are not,
 * which is what stops every other reading here from silently including hidden chips.
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

/**
 * The topbar as it reads on screen: every child the cascade is actually showing, in
 * order, joined by ` | `.
 *
 * The stock strip is joined from its own spans because it renders one element per slot
 * with no separator between them, so its raw `textContent` reads `P1 3P2 3`.
 */
function reading(root: HTMLElement): string {
  const bar = root.querySelector('.hud-topbar') as HTMLElement;
  const parts: string[] = [];
  for (const child of Array.from(bar.children) as HTMLElement[]) {
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
 * The four sessions the comparison is judged at. `campaign` and `practice` are the two
 * board kinds; the two versus entries are the SHAPES a versus session comes in, and they
 * differ on exactly the field question 5 is about -- the length of the level sequence.
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

/**
 * WHAT EACH ARM SAYS, at each of the four sessions. The comparison, written down.
 *
 * `full`'s column is today's bar, measured on the built app before this change existed
 * (Playwright, five viewports): campaign `Lives: 3 Enemies: 3 Level: 1/5`, practice the
 * same behind a PRACTICE chip, and a setup-pane versus `P1 3 P2 3` with no level chip at
 * any width. The chips read `Practice`/`Campaign`/`VS` here and render uppercase --
 * `.hud-practice` sets `text-transform`, which a jsdom `textContent` does not apply.
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
    // row that restates today's bar, so the control cannot drift from it.
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
      'spare',
      'mode-chips',
      'spare-chips',
      'enemies-only',
      'denominator-only',
    ]);
  });

  it('keeps the two single-removal arms genuinely single, and the paired arms their union', () => {
    // The reason `enemies-only` and `denominator-only` exist: the two content removals
    // have to be judgeable APART. If either single arm quietly carried both, a ruling on
    // one would be a ruling on the package -- which is the thing the comparison is for.
    const enemies = topbarDepartures('enemies-only');
    const denominator = topbarDepartures('denominator-only');
    expect(enemies).toEqual({ dropEnemies: true, dropDenominator: false, modeChips: false });
    expect(denominator).toEqual({ dropEnemies: false, dropDenominator: true, modeChips: false });
    // `spare` is exactly their union, and `spare-chips` is that plus the chips -- so the
    // pair really does decompose the package rather than approximating it.
    expect(topbarDepartures('spare')).toEqual({
      dropEnemies: true,
      dropDenominator: true,
      modeChips: false,
    });
    expect(topbarDepartures('spare-chips')).toEqual({
      ...topbarDepartures('spare'),
      modeChips: true,
    });
    expect(topbarDepartures('mode-chips')).toEqual({
      ...topbarDepartures(SHIPPED_TOPBAR_TREATMENT),
      modeChips: true,
    });
  });
});

describe('topbar: the SHIPPED arm is the no-flag bar itself', () => {
  it('mounts the same topbar as an absent flag, at every session, with no class of its own', () => {
    for (const name of Object.keys(SESSIONS) as SessionName[]) {
      const absent = mount(null);
      absent.hud.setStatus(SESSIONS[name]);
      const absentBar = (absent.root.querySelector('.hud-topbar') as HTMLElement).outerHTML;
      const absentClasses = hudEl(absent.root).className;
      unmount();

      const shipped = mount(SHIPPED_TOPBAR_TREATMENT);
      shipped.hud.setStatus(SESSIONS[name]);
      expect(
        (shipped.root.querySelector('.hud-topbar') as HTMLElement).outerHTML,
        `${name}: the shipped arm rendered a different bar`,
      ).toBe(absentBar);
      expect(hudEl(shipped.root).className, `${name}: the shipped arm added a class`).toBe(
        absentClasses,
      );
      unmount();

      // NEGATIVE CONTROL: the same comparison against an arm that changes this session
      // must FAIL, or this would pass against a `topbar` option that was never read at
      // all. `spare-chips` is the one arm that differs at all four sessions.
      const other = mount('spare-chips');
      other.hud.setStatus(SESSIONS[name]);
      expect(
        (other.root.querySelector('.hud-topbar') as HTMLElement).outerHTML,
        `${name}: the option is not wired to anything`,
      ).not.toBe(absentBar);
      unmount();
    }
  });

  it('adds no class and no stylesheet rule for any arm -- the arms remove readings, never restyle them', () => {
    const absent = mount(null);
    const absentClasses = hudEl(absent.root).className;
    unmount();
    for (const arm of TOPBAR_TREATMENTS) {
      const m = mount(arm);
      m.hud.setStatus(SESSIONS.campaign);
      expect(hudEl(m.root).className, arm).toBe(absentClasses);
      unmount();
    }
    // The stylesheet half. `.hud-enemy-stat` is a HANDLE for the enemy-count arm, and the
    // claim in its markup comment is that it adds nothing to the cascade; a rule for it,
    // or a `hud--topbar-` modifier, would make an arm a restyling.
    expect(css).not.toMatch(/hud--topbar-/);
    expect(css).not.toMatch(/\.hud-enemy-stat\b/);
    // Vacuity guard: this file really is reading the stylesheet, so the two absences
    // above are absences rather than an empty string matching nothing.
    expect(css).toMatch(/\.hud-campaign-stat--hidden\s*\{\s*display:\s*none/);
  });
});

describe('topbar: what each arm says', () => {
  it('carries no chip before a session lands -- the cascade this suite reads is live', () => {
    // The vacuity guard for every reading below. A HUD that has been told nothing keeps
    // the markup's own Lives/Enemies (applyStatus deliberately does not blank them; the
    // whole bar is hidden on every surface that can be up with no session), and both
    // chips are hidden by the stylesheet. Without a live stylesheet this would read
    // `Practice | Lives: 3 | Enemies: 3 | Level:` -- which is also what a build that lost
    // the `--hidden` rules would put in front of a player.
    const { root } = mount(null);
    expect(reading(root)).toBe('Lives: 3 | Enemies: 3');
    // NEGATIVE CONTROL: a status lands and the same reader reports the bar, so an empty
    // string is not what this helper returns for everything.
    mounted?.setStatus(SESSIONS.campaign);
    expect(reading(root)).toBe(READINGS.full.campaign);
  });

  it('reads exactly the comparison table, for every arm at every session', () => {
    expect(Object.keys(READINGS).length, 'one column per arm').toBe(TOPBAR_TREATMENTS.size);
    for (const arm of TOPBAR_TREATMENTS) {
      for (const name of Object.keys(SESSIONS) as SessionName[]) {
        const m = mount(arm);
        m.hud.setStatus(SESSIONS[name]);
        expect(reading(m.root), `${arm} @ ${name}`).toBe(READINGS[arm][name]);
        unmount();
      }
    }
    // NEGATIVE CONTROL, stated as a property of the table rather than of one mount: every
    // arm but the shipped one differs from the control somewhere, so a table filled with
    // six copies of today's bar -- which is what a `topbar` option nothing reads would
    // produce -- cannot pass this suite.
    for (const arm of TOPBAR_TREATMENTS) {
      const differs = (Object.keys(SESSIONS) as SessionName[]).some(
        (name) => READINGS[arm][name] !== READINGS[SHIPPED_TOPBAR_TREATMENT][name],
      );
      expect(differs, arm).toBe(arm !== SHIPPED_TOPBAR_TREATMENT);
    }
  });

  it('labels the kind it is actually showing, and labels nothing when no session is live', () => {
    // The chip is a FIELD under the mode arms, so it has to follow the session rather
    // than be written once at construction: a Levels pick really does change the kind on
    // a live HUD (`loop.ts` re-pushes the status on every world build).
    const { hud, root } = mount('mode-chips');
    const chip = (): HTMLElement => root.querySelector('.hud-practice') as HTMLElement;
    hud.setStatus(SESSIONS.campaign);
    expect(chip().textContent).toBe(MODE_CHIP_LABELS.campaign);
    hud.setStatus(SESSIONS.practice);
    expect(chip().textContent).toBe(MODE_CHIP_LABELS.practice);
    hud.setStatus(SESSIONS['versus-setup-match']);
    expect(chip().textContent).toBe(MODE_CHIP_LABELS.versus);
    // No live session is no mode to read out. NEGATIVE CONTROL for the line above: if the
    // arm simply forced the chip visible, this would still read `VS` over an empty bar.
    hud.setStatus(null);
    expect(getComputedStyle(chip()).display, 'a chip over no session at all').toBe('none');
  });
});

describe('topbar: the two versus shapes, which question 5 conflates', () => {
  it('shows no level chip on a setup-pane match TODAY, before any arm is selected', () => {
    // Issue #552's fifth question reads the versus bar as `Level: 1/5   P1 3  P2 3` and
    // calls the ordinal meaningless there. Measured on the built app, the bar a player
    // reaches through Versus Setup carries no chip at all, at 360, 390, 640, 1280 and
    // 1920: its level system has ONE synthetic level, and `missions > 1` is already false.
    const { hud, root } = mount(null);
    hud.setStatus(SESSIONS['versus-setup-match']);
    expect(reading(root)).toBe('P1 3 P2 3');
    // NEGATIVE CONTROL, and the session the issue's table actually describes: the same
    // kind on the CAMPAIGN level system (`?dev=1&mode=ffa`) does show the chip -- so this
    // is not a HUD that hides the chip for versus, it is a sequence with nothing to say.
    hud.setStatus(SESSIONS['versus-on-campaign-levels']);
    expect(reading(root)).toBe('Level: 1/5 | P1 3 P2 3');
  });

  it('drops it under the chip arms, which is the only place that chip is reachable at all', () => {
    const { hud, root } = mount('mode-chips');
    hud.setStatus(SESSIONS['versus-on-campaign-levels']);
    expect(reading(root)).toBe('VS | P1 3 P2 3');
    // NEGATIVE CONTROL: the arm drops the chip for VERSUS, not for everything -- a
    // campaign session keeps the ordinal it is genuinely climbing.
    hud.setStatus(SESSIONS.campaign);
    expect(reading(root)).toContain('Level: 1/5');
  });
});
