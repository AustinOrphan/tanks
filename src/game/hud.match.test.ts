// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { createHud, type GameplayStatus, type Hud, type VersusStock } from './hud';
import { configFor } from '../sim/config';
import { IDENTITY_RING_COLORS, TEAM_COLORS } from '../presentation/identity';


let hud: Hud | null = null;

function mount(): { hud: Hud; root: HTMLElement } {
  const root = document.createElement('div');
  document.body.appendChild(root);
  hud = createHud(root);
  return { hud, root };
}

afterEach(() => {
  hud?.dispose();
  hud = null;
  document.body.innerHTML = '';
});

describe('hud: dev shell count', () => {
  function mount(): { root: HTMLElement; hud: ReturnType<typeof createHud> } {
    const root = document.createElement('div');
    document.body.appendChild(root);
    return { root, hud: createHud(root) };
  }

  it('is hidden until asked for, since it is off by default', () => {
    const { root, hud } = mount();
    expect(root.querySelector('.hud-shells')?.className).toContain('hud-shells--hidden');
    hud.dispose();
  });

  it('shows shells against the cap', () => {
    const { root, hud } = mount();
    hud.setShellCount({ inFlight: 2, cap: 5 });
    const el = root.querySelector('.hud-shells') as HTMLElement;
    expect(el.textContent).toBe('shells 2/5');
    expect(el.className).not.toContain('hud-shells--hidden');
    hud.dispose();
  });

  it('marks the state where the cannon goes silent', () => {
    // At the cap firing stops with no other cue. That is the state this
    // readout exists for, so it must be distinguishable at a glance.
    const { root, hud } = mount();
    hud.setShellCount({ inFlight: 5, cap: 5 });
    expect((root.querySelector('.hud-shells') as HTMLElement).className).toContain('hud-shells--full');
    hud.setShellCount({ inFlight: 4, cap: 5 });
    expect((root.querySelector('.hud-shells') as HTMLElement).className).not.toContain('hud-shells--full');
    hud.dispose();
  });

  it('hides again on null', () => {
    const { root, hud } = mount();
    hud.setShellCount({ inFlight: 1, cap: 5 });
    hud.setShellCount(null);
    expect(root.querySelector('.hud-shells')?.className).toContain('hud-shells--hidden');
    hud.dispose();
  });
});

describe('hud: blocked-fire capacity flash (issue #516, parent #356)', () => {
  function mount(): { root: HTMLElement; hud: ReturnType<typeof createHud> } {
    const root = document.createElement('div');
    document.body.appendChild(root);
    return { root, hud: createHud(root) };
  }

  it('shows nothing until a shot is actually refused', () => {
    // The base state, and the one that makes this the TRANSIENT arm: an empty element
    // holding no text, running no animation, claiming nothing.
    const { root, hud } = mount();
    const el = root.querySelector('.hud-capacity') as HTMLElement;
    expect(el.textContent).toBe('');
    expect(el.className).not.toContain('hud-capacity--flash');
    hud.dispose();
  });

  it('flashes the capacity the shot was refused against', () => {
    // Both numbers: the capacity AND that all of it is spent, which is the inference
    // #356 asks a treatment to produce -- capacity full, not cooldown or lost input.
    const { root, hud } = mount();
    hud.signalShellCapacity({ inFlight: 5, cap: 5 });
    const el = root.querySelector('.hud-capacity') as HTMLElement;
    expect(el.textContent).toBe('shells 5/5');
    expect(el.className).toContain('hud-capacity--flash');
    hud.dispose();
  });

  it('replays for a second refusal, so two refusals read as two', () => {
    // Re-adding a class the element already has does NOT restart a CSS animation. Without
    // the remove-and-reflow, a second refusal inside the animation window would be
    // invisible -- and a held trigger against a full cap is exactly when refusals arrive
    // in a row. Same mechanism, and same test shape, as signalPlayerDeath's own replay.
    // MutationObserver delivers on a microtask, so drain it synchronously with
    // takeRecords rather than waiting.
    const { root, hud } = mount();
    hud.signalShellCapacity({ inFlight: 5, cap: 5 });
    const el = root.querySelector('.hud-capacity') as HTMLElement;
    const obs = new MutationObserver(() => {});
    obs.observe(el, { attributes: true, attributeFilter: ['class'], attributeOldValue: true });
    hud.signalShellCapacity({ inFlight: 5, cap: 5 });
    const records = obs.takeRecords();
    obs.disconnect();
    const sawRemoval = records.some((r) => r.oldValue?.includes('hud-capacity--flash'));
    expect(records.length).toBeGreaterThanOrEqual(2); // removed, then re-added
    expect(sawRemoval).toBe(true);
    expect(el.className).toContain('hud-capacity--flash');
    hud.dispose();
  });

  it('is NOT the topbar readout, and does not turn into one', () => {
    // #356's boundary: no permanent numeric ammunition HUD unless play evidence shows
    // transient feedback is insufficient. Two structural halves of that here. It lives
    // outside .hud-topbar, so it can never reserve a slot in that flex row the way the
    // dev counter does -- which is what would make a refusal permanently widen the
    // topbar from the first shot onward. And it leaves the dev readout alone: a session
    // that never asked for `?dev=1&shellCount=1` still has no shell counter after a
    // refusal.
    const { root, hud } = mount();
    hud.signalShellCapacity({ inFlight: 5, cap: 5 });
    expect(root.querySelector('.hud-topbar .hud-capacity')).toBeNull();
    expect(root.querySelector('.hud-capacity')).not.toBeNull();
    expect(root.querySelector('.hud-shells')?.className).toContain('hud-shells--hidden');
    hud.dispose();
  });
});

describe('hud: versus results (n-player arc PR 4 -- FFA + teams, .hud-coop-kills precedent)', () => {
  /** Every outcome carries an attempt tally; these tests are about the versus line. */
  const NO_ATTEMPT = {
    shotsFired: 0, shellKills: 0, mineKills: 0, deaths: 0, selfKills: 0,
    friendlyFireKills: 0, minesLaid: 0, wallsDestroyed: 0, ricochets: 0,
  };
  const versusLine = (root: HTMLElement): HTMLElement =>
    root.querySelector('.hud-versus-results') as HTMLElement;

  it('win panel carries the ffa results line, per-slot kills/deaths', () => {
    const { hud: h, root } = mount();
    h.setOutcome({ tally: 'ffa', action: 'versus-setup', attempt: NO_ATTEMPT, kills: [2, 0, 1], deaths: [1, 3, 0] });
    h.setState('outcome-win');
    expect(versusLine(root).textContent ?? '').toBe('P1: 2/1 · P2: 0/3 · P3: 1/0');
    expect(versusLine(root).classList.contains('hud-versus-results--hidden')).toBe(false);
  });

  it('win panel carries the teams results line as PER-TEAM sums, not per-slot', () => {
    const { hud: h, root } = mount();
    // slots 0,2 -> team 0; slot 1 -> team 1 (teamOf(slot) = slot % 2).
    h.setOutcome({ tally: 'teams', action: 'versus-setup', attempt: NO_ATTEMPT, kills: [2, 1, 3], deaths: [1, 4, 0] });
    h.setState('outcome-win');
    expect(versusLine(root).textContent ?? '').toBe('Team 1: 5/1 · Team 2: 1/4');
  });

  it('a push during PLAY repaints nothing -- the surface gate survives a restart', () => {
    // `outcomeVisible` is the surface's half of the answer, and the restart path is where
    // it used to go wrong: `setState` returns early for `playing`, so the assignment that
    // clears the flag sat AFTER the return and the flag stayed `true` all the way through
    // the next match. Every outcome push during play then re-rendered these lines and
    // rewrote the action button behind a panel that was already hidden.
    //
    // Invisible in the product -- `.hud-panel` hides during play whatever these lines say
    // -- so the assertion is about the gate rather than about pixels: the line keeps the
    // text the OUTCOME left on it, and the push made during play does not reach it.
    const { hud: h, root } = mount();
    h.setOutcome({ tally: 'ffa', action: 'versus-setup', attempt: NO_ATTEMPT, kills: [2, 0], deaths: [0, 2] });
    h.setState('outcome-win');
    const atOutcome = versusLine(root).textContent ?? '';
    expect(atOutcome).toBe('P1: 2/0 · P2: 0/2');

    h.setState('playing');
    h.setOutcome({ tally: 'ffa', action: 'versus-setup', attempt: NO_ATTEMPT, kills: [9, 9], deaths: [9, 9] });
    expect(versusLine(root).textContent ?? '', 'a push during play reached the DOM').toBe(atOutcome);

    // ...and the gate reopens: the next outcome surface renders the push it was given,
    // so this is not a flag stuck the other way.
    h.setState('outcome-win');
    h.setOutcome({ tally: 'ffa', action: 'versus-setup', attempt: NO_ATTEMPT, kills: [1, 3], deaths: [3, 1] });
    expect(versusLine(root).textContent ?? '').toBe('P1: 1/3 · P2: 3/1');
  });

  it('a non-versus outcome keeps the line hidden even at win/lose', () => {
    const { hud: h, root } = mount();
    h.setOutcome({ tally: 'solo', action: 'campaign-levels', attempt: NO_ATTEMPT });
    h.setState('outcome-win');
    expect(versusLine(root).classList.contains('hud-versus-results--hidden')).toBe(true);
    h.setState('outcome-lose');
    expect(versusLine(root).classList.contains('hud-versus-results--hidden')).toBe(true);
  });

  it('the two results lines are mutually exclusive BY CONSTRUCTION, not by convention', () => {
    // What merging setCoopKills and setVersusResults into one projection bought (issue
    // #324, step S4). A world has exactly one `rules.mode`, so a session has exactly one
    // tally -- and with the tally as the payload's discriminant, switching kinds cannot
    // leave the previous kind's line standing underneath the new one. The old pair of
    // setters could: each held its own data and each hid only its own line.
    const { hud: h, root } = mount();
    const coopLine = (): HTMLElement => root.querySelector('.hud-coop-kills') as HTMLElement;
    h.setOutcome({ tally: 'coop', action: 'campaign-levels', attempt: NO_ATTEMPT, kills: [1, 2] });
    h.setState('outcome-win');
    expect(coopLine().classList.contains('hud-coop-kills--hidden')).toBe(false);
    h.setOutcome({ tally: 'ffa', action: 'versus-setup', attempt: NO_ATTEMPT, kills: [1, 2], deaths: [2, 1] });
    expect(coopLine().classList.contains('hud-coop-kills--hidden')).toBe(true);
    expect(versusLine(root).classList.contains('hud-versus-results--hidden')).toBe(false);
  });

  it('the versus results line is hidden outside win/lose, even with live data set', () => {
    const { hud: h, root } = mount();
    h.setOutcome({ tally: 'ffa', action: 'versus-setup', attempt: NO_ATTEMPT, kills: [1], deaths: [0] });
    h.setState('playing');
    expect(versusLine(root).classList.contains('hud-versus-results--hidden')).toBe(true);
  });

  it('updates live while the win panel is already open, same as the coop kill line', () => {
    const { hud: h, root } = mount();
    h.setOutcome({ tally: 'ffa', action: 'versus-setup', attempt: NO_ATTEMPT, kills: [1, 0], deaths: [0, 1] });
    h.setState('outcome-win');
    expect(versusLine(root).textContent).toBe('P1: 1/0 · P2: 0/1');
    h.setOutcome({ tally: 'ffa', action: 'versus-setup', attempt: NO_ATTEMPT, kills: [1, 1], deaths: [1, 1] });
    expect(versusLine(root).textContent).toBe('P1: 1/1 · P2: 1/1');
  });
});

/**
 * A versus status carrying `stocks`, with the level position every status has.
 *
 * `missions: 1` throughout: a setup-pane versus match runs a one-level synthetic system,
 * so the level chip stays hidden and these cases are about the strip alone. The
 * `?dev=1&mode=ffa` session that DOES have a real ordinal is exercised in the level-chip
 * block further down.
 */
const versusStatus = (stocks: VersusStock[] | null): GameplayStatus => ({
  kind: 'versus',
  mission: 1,
  missions: 1,
  stocks,
});

/** A campaign-board status. `lives`/`enemies` default to the shipped opening pair. */
const boardStatus = (
  kind: 'campaign' | 'practice',
  over: Partial<{ mission: number; missions: number; lives: number; enemies: number }> = {},
): GameplayStatus => ({ kind, mission: 1, missions: 1, lives: 3, enemies: 3, ...over });

describe('hud: in-match stock readout (spec §3a, owner addition 2026-08-21)', () => {
  const strip = (root: HTMLElement): HTMLElement => root.querySelector('.hud-versus-stocks') as HTMLElement;
  const entries = (root: HTMLElement): HTMLElement[] =>
    Array.from(root.querySelectorAll('.hud-versus-stock-entry')) as HTMLElement[];

  /**
   * `--hud-damage-color` (the death-vignette precedent above) is a CUSTOM property, so
   * jsdom's `getPropertyValue` hands the literal `#rrggbb` string back unparsed. `color`
   * is a REAL css property here -- `span.style.color`, not a custom property -- and
   * jsdom's CSSOM (like a real browser's) normalizes any valid colour value to
   * `rgb(r, g, b)` on read, hex included. Measured directly: assigning `#3fd0ff` and
   * reading `.style.color` back gives `'rgb(63, 208, 255)'`, not `'#3fd0ff'`. This
   * derives that same rgb() form from the exported constant's number, so it is still
   * the CONTRACT being asserted (a colour derived from IDENTITY_RING_COLORS/
   * TEAM_COLORS), not hud.ts's private cssColor implementation.
   */
  function expectedCssColor(hex: number): string {
    const r = (hex >> 16) & 0xff;
    const g = (hex >> 8) & 0xff;
    const b = hex & 0xff;
    return `rgb(${r}, ${g}, ${b})`;
  }

  it('carries the TEAM as a letter beside the colour, all three teams (issue #281)', () => {
    // The non-colour channel. Colour alone fails a colour-blind reader, a forced-colours
    // palette (#368 replaces authored hues outright) and a greyscale screenshot; the
    // letter survives all three. Asserted as TEXT, which is the part that survives.
    const { hud: h, root } = mount();
    // Production order (see the note below this block): the strip's visibility is
    // state-derived, so the session kind has to be set before `playing`.
    h.setState('playing');
    h.setStatus(
      versusStatus([
        { slot: 0, stock: 3, team: 0 },
        { slot: 1, stock: 2, team: 1 },
        { slot: 2, stock: 1, team: 2 },
      ]),
    );
    expect(entries(root).map((e) => e.textContent)).toEqual(['P1 A 3', 'P2 B 2', 'P3 C 1']);
    // ...and the third team is a real hue, not the white fallback. This is the assertion
    // that would have failed while TEAM_COLORS had only two entries -- a 2v1v1 rendered
    // team 2 as the unstyled-slot placeholder.
    expect(entries(root)[2].style.color).toBe(expectedCssColor(TEAM_COLORS[2]));
    expect(entries(root)[2].style.color).not.toBe(expectedCssColor(0xffffff));
  });

  it('omits the team letter in FFA, where a slot has no side', () => {
    // The control for the case above: without it, "P1 A 3" could be an unconditional
    // format rather than a teams-only reinforcement, and FFA would grow a letter that
    // means nothing.
    const { hud: h, root } = mount();
    h.setState('playing');
    h.setStatus(versusStatus([{ slot: 0, stock: 3 }, { slot: 1, stock: 2 }]));
    expect(entries(root).map((e) => e.textContent)).toEqual(['P1 3', 'P2 2']);
  });

  it('a versus status with null stocks keeps the strip hidden even while playing', () => {
    const { hud: h, root } = mount();
    h.setStatus(versusStatus(null));
    h.setState('playing');
    expect(strip(root).classList.contains('hud-versus-stocks--hidden')).toBe(true);
  });

  /*
   * THE ORDERING PAIR, and the reason step S6's merge is safe.
   *
   * `setStatus` and `setState` each carry half of "should the strip be showing", and
   * either can arrive last. Production takes the order a test would not write by hand:
   * `hud.setState('playing')` runs BEFORE the first status carrying stocks, because
   * nothing marks "a versus match just started" as a SimEvent and the session's first
   * populated push comes from a simulated frame. At that first `setState('playing')` the
   * strip renders against no stocks at all and is left `--hidden` for a perfectly good
   * DATA reason -- and a guard that read that class back to answer the STATE question
   * dropped the first real entries permanently, until an unrelated `setState` (a pause)
   * happened to revive them. That is a bug that shipped once.
   *
   * Both orders are asserted, and both matter, because the two ways of half-applying the
   * merged projection fail in OPPOSITE directions -- measured, on this branch, by making
   * each mistake on purpose and running this file:
   *
   *  - `applyStatus()` removed from `setState` (the projection applied only when the
   *    session pushes it): 6 of 35 cases fail, and the failing one HERE is the reverse
   *    order. Production still passes, because setState had already moved
   *    `currentSurface` by the time the status arrived.
   *  - `applyStatus()` removed from `setStatus` (applied only when the surface next
   *    moves): 8 of 35 fail, and the failing one here is the PRODUCTION order.
   *
   * Neither mistake is caught by both cases, so a single ordering test would have left
   * one of them shipping. The two together are what make "whichever arrives last, the bar
   * lands in the same place" an assertion rather than a hope.
   */
  it('production order -- setState(playing) THEN the first status with stocks -- the strip still ends up visible with entries', () => {
    const { hud: h, root } = mount();
    h.setState('playing');
    h.setStatus(versusStatus([{ slot: 0, stock: 3 }, { slot: 1, stock: 2 }]));
    expect(strip(root).classList.contains('hud-versus-stocks--hidden')).toBe(false);
    expect(entries(root).map((e) => e.textContent)).toEqual(['P1 3', 'P2 2']);
  });

  it('the reverse order -- status first, THEN setState(playing) -- lands on the same strip', () => {
    const { hud: h, root } = mount();
    h.setStatus(versusStatus([{ slot: 0, stock: 3 }, { slot: 1, stock: 2 }]));
    h.setState('playing');
    expect(strip(root).classList.contains('hud-versus-stocks--hidden')).toBe(false);
    expect(entries(root).map((e) => e.textContent)).toEqual(['P1 3', 'P2 2']);
  });

  it('a campaign status lands the same way in BOTH orders -- stats shown, strip down', () => {
    // The other side of the projection under the same ordering pressure. A campaign
    // status cannot carry stocks at all (the union has no field for them), so what is
    // asserted here is the half a merged setter could still get wrong: the campaign
    // stats' own gate and their numbers must not depend on whether the surface or the
    // status moved last.
    const statHidden = (root: HTMLElement): boolean =>
      (root.querySelector('.hud-campaign-stat') as HTMLElement).classList.contains(
        'hud-campaign-stat--hidden',
      );
    const stateFirst = mount();
    stateFirst.hud.setState('playing');
    stateFirst.hud.setStatus(boardStatus('campaign', { lives: 2, enemies: 1 }));
    const dataFirst = mount();
    dataFirst.hud.setStatus(boardStatus('campaign', { lives: 2, enemies: 1 }));
    dataFirst.hud.setState('playing');
    for (const { root } of [stateFirst, dataFirst]) {
      expect(statHidden(root)).toBe(false);
      expect((root.querySelector('.hud-lives') as HTMLElement).textContent).toBe('2');
      expect((root.querySelector('.hud-enemies') as HTMLElement).textContent).toBe('1');
      expect(
        (root.querySelector('.hud-versus-stocks') as HTMLElement).classList.contains(
          'hud-versus-stocks--hidden',
        ),
      ).toBe(true);
    }
    stateFirst.hud.dispose();
    dataFirst.hud.dispose();
  });

  it('renders one entry per slot, with the slot number and stock count as its text', () => {
    const { hud: h, root } = mount();
    h.setStatus(versusStatus([{ slot: 0, stock: 3 }, { slot: 1, stock: 2 }]));
    h.setState('playing');
    expect(entries(root).map((e) => e.textContent)).toEqual(['P1 3', 'P2 2']);
    expect(strip(root).classList.contains('hud-versus-stocks--hidden')).toBe(false);
  });

  it('ffa entries are tinted from IDENTITY_RING_COLORS[slot], not a copied-out hex', () => {
    const { hud: h, root } = mount();
    h.setStatus(versusStatus([{ slot: 0, stock: 3 }, { slot: 1, stock: 2 }]));
    h.setState('playing');
    const es = entries(root);
    expect(es[0].style.color).toBe(expectedCssColor(IDENTITY_RING_COLORS[0]));
    expect(es[1].style.color).toBe(expectedCssColor(IDENTITY_RING_COLORS[1]));
  });

  it("teams entries are tinted from TEAM_COLORS[team], not IDENTITY_RING_COLORS[slot]", () => {
    const { hud: h, root } = mount();
    // slot 0 carries team 1 deliberately -- if the dispatch dropped `team` and fell
    // through to the ffa branch, this would read IDENTITY_RING_COLORS[0] instead.
    h.setStatus(versusStatus([{ slot: 0, stock: 3, team: 1 }, { slot: 1, stock: 2, team: 0 }]));
    h.setState('playing');
    const es = entries(root);
    expect(es[0].style.color).toBe(expectedCssColor(TEAM_COLORS[1]));
    expect(es[1].style.color).toBe(expectedCssColor(TEAM_COLORS[0]));
    expect(es[0].style.color).not.toBe(expectedCssColor(IDENTITY_RING_COLORS[0]));
  });

  it('hidden at title/win/lose even with entries set', () => {
    const { hud: h, root } = mount();
    h.setStatus(versusStatus([{ slot: 0, stock: 3 }, { slot: 1, stock: 2 }]));
    for (const s of ['main-menu', 'outcome-win', 'outcome-lose'] as const) {
      h.setState(s);
      expect(strip(root).classList.contains('hud-versus-stocks--hidden'), s).toBe(true);
    }
  });

  it('visible at both playing and paused', () => {
    const { hud: h, root } = mount();
    h.setStatus(versusStatus([{ slot: 0, stock: 3 }]));
    for (const s of ['playing', 'paused'] as const) {
      h.setState(s);
      expect(strip(root).classList.contains('hud-versus-stocks--hidden'), s).toBe(false);
    }
  });

  it('a campaign status takes the strip down again -- the exclusion is the projection, not a convention', () => {
    // What this case used to be, and what the merge changed. It read "a campaign session
    // never shows the strip even with entries set", and it could be written because
    // `setVersusStocks` and `setSessionKind` were separate members: a caller COULD state
    // versus stocks and campaign identity at once, and only a convention in loop.ts said
    // it never would. `GameplayStatus` has no field for stocks on a campaign arm, so that
    // case no longer compiles. What remains testable, and is what actually protects the
    // player, is the transition: a live strip must come down the moment the session says
    // it is a campaign board.
    const { hud: h, root } = mount();
    h.setStatus(versusStatus([{ slot: 0, stock: 3 }]));
    h.setState('playing');
    expect(strip(root).classList.contains('hud-versus-stocks--hidden'), 'setup').toBe(false);
    h.setStatus(boardStatus('campaign'));
    expect(strip(root).classList.contains('hud-versus-stocks--hidden')).toBe(true);
  });
});

/*
 * Issue #282's gate, read on the bar issue #552's ruling ships.
 *
 * The pair is still two elements and the gate still governs both, but the shipped bar
 * hides the enemy count on every kind now -- "noise and unnecessary" -- so the readings
 * below are `[Lives, Enemies]` with Enemies down throughout, and the interesting column
 * is Lives. That is not this describe's decision to make or unmake: it is asserted where
 * it belongs, in `topbar-treatment.test.ts`, which reads the pair under the `full` arm
 * where the count is still on screen and the versus gate is what takes it away.
 */
describe('hud: campaign Lives/Enemies stats hidden during versus (issue #282)', () => {
  const statEls = (root: HTMLElement): HTMLElement[] =>
    Array.from(root.querySelectorAll('.hud-campaign-stat')) as HTMLElement[];
  const hidden = (root: HTMLElement): boolean[] =>
    statEls(root).map((e) => e.classList.contains('hud-campaign-stat--hidden'));

  it('hides Lives/Enemies for a versus session in both playing and paused', () => {
    const { hud: h, root } = mount();
    h.setStatus(versusStatus(null));
    // Two stat elements exist (Lives, Enemies) -- fails silently (an empty sweep that
    // still passes) if the markup ever drops one, so the population is asserted here
    // rather than assumed.
    expect(statEls(root).length).toBe(2);
    for (const s of ['playing', 'paused'] as const) {
      h.setState(s);
      expect(hidden(root), s).toEqual([true, true]);
    }
  });

  it('keeps Lives visible and both numbers updating for a campaign session -- the negative control against over-hiding', () => {
    const { hud: h, root } = mount();
    h.setStatus(boardStatus('campaign'));
    for (const s of ['playing', 'paused'] as const) {
      h.setState(s);
      expect(hidden(root), s).toEqual([false, true]);
    }
    // Both numbers keep being projected, including the one the shipped bar is not
    // showing: the enemy count is a field of the same status, and the `full` arm reveals
    // the element rather than switching a second source of truth back on.
    h.setStatus(boardStatus('campaign', { lives: 2, enemies: 1 }));
    expect((root.querySelector('.hud-lives') as HTMLElement).textContent).toBe('2');
    expect((root.querySelector('.hud-enemies') as HTMLElement).textContent).toBe('1');
  });

  it("a session-kind switch restores the stats -- production reboots into a FRESH Hud per session (boot.ts's requestCampaignSession -> deps.startGame), so this exercises the stronger property that the gate tracks CURRENT kind rather than latching the first kind a Hud instance ever saw", () => {
    const { hud: h, root } = mount();
    h.setStatus(versusStatus(null));
    h.setState('playing');
    expect(hidden(root)).toEqual([true, true]);

    h.setStatus(boardStatus('campaign'));
    expect(hidden(root)).toEqual([false, true]);
  });

  it('PRACTICE shows the campaign stats, exactly as campaign does, and wears its own word', () => {
    // Both halves in one case, because they are one decision. Practice is a campaign
    // board played in isolation: its lives are as real there as in a run, so hiding them
    // would be a shipped-behaviour regression on the Level-Select path -- that is the
    // first assertion, and the one a widened predicate (`kind !== 'campaign'`) breaks.
    // The second is what issue #324 asked for and what was missing: before the chip, a
    // Practice topbar and a Campaign topbar were byte-identical screenshots at every
    // captured width, so nothing on screen said which board the player was on.
    //
    // #552's ruling generalised that chip into a mode readout rather than adding a
    // second one, so the element, the class and the word are all the ones #324 shipped;
    // what changed is that campaign and versus now fill the same field instead of
    // leaving it empty.
    const chip = (root: HTMLElement): HTMLElement =>
      root.querySelector('.hud-practice') as HTMLElement;
    const { hud: h, root } = mount();
    h.setStatus(boardStatus('practice', { lives: 2, enemies: 1 }));
    h.setState('playing');
    expect(hidden(root), 'practice hid the stat it is meant to show').toEqual([false, true]);
    expect((root.querySelector('.hud-lives') as HTMLElement).textContent).toBe('2');
    expect((root.querySelector('.hud-enemies') as HTMLElement).textContent).toBe('1');
    expect(root.querySelectorAll('.hud-practice').length, 'one chip, not a second one').toBe(1);
    expect(chip(root).classList.contains('hud-practice--hidden')).toBe(false);
    expect(chip(root).textContent).toBe('Practice');
  });

  it('the chip names whichever kind is live, and is DOWN with no session -- the control that stops it being decoration', () => {
    // Without this, a chip nailed permanently open with one fixed word would satisfy the
    // case above while announcing PRACTICE over a campaign run and a versus match alike.
    // Since #552 the chip is a FIELD, so "not decoration" means it carries the current
    // kind's own word rather than merely appearing and disappearing -- and both halves
    // are asserted, because a chip left hidden still holds text.
    //
    // The transition back matters as much as the first reading: the chip follows the
    // CURRENT kind rather than latching the first one this Hud ever saw -- a Levels pick
    // makes a campaign session Practice and landing back on its home board makes it
    // Campaign again, both within one Hud.
    const chip = (root: HTMLElement): HTMLElement =>
      root.querySelector('.hud-practice') as HTMLElement;
    const reads = (root: HTMLElement): string | null =>
      chip(root).classList.contains('hud-practice--hidden') ? null : chip(root).textContent;
    const { hud: h, root } = mount();
    expect(reads(root), 'a HUD that has never been told about a session').toBeNull();
    h.setStatus(boardStatus('campaign'));
    h.setState('playing');
    expect(reads(root), 'campaign').toBe('Campaign');
    h.setStatus(versusStatus([{ slot: 0, stock: 3 }]));
    expect(reads(root), 'versus').toBe('VS');
    h.setStatus(boardStatus('practice'));
    expect(reads(root), 'a Levels pick made this session Practice').toBe('Practice');
    h.setStatus(boardStatus('campaign'));
    expect(reads(root), 'landing back on the home board').toBe('Campaign');
    // NEGATIVE CONTROL, and the one that fails if the chip is ever nailed open: a HUD
    // told the session is over stops naming a mode instead of keeping the last word up.
    h.setStatus(null);
    expect(reads(root), 'the session ended').toBeNull();
  });
});

describe('standard VS ordnance limits (issue #268)', () => {
  const limitsLine = (root: HTMLElement): HTMLElement =>
    root.querySelector('.hud-versus-limits') as HTMLElement;

  const mount = (): HTMLElement => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    // Through the shared `hud` binding so the file-level afterEach disposes it: this
    // block's own mount used to drop the instance on the floor, leaking createHud's
    // window listeners and timers into every later test in the file.
    hud = createHud(root);
    return root;
  };

  it('states the shell and mine limits the simulation actually enforces', () => {
    const cfg = configFor('player');
    const text = limitsLine(mount()).textContent ?? '';
    // The two authoritative values: spawnBullet gates on the first, dropMine on the second.
    expect(text).toContain(String(cfg.weapon.maxActiveProjectiles));
    expect(text).toContain(String(cfg.mineCapacity));
  });

  it('names both kinds of ordnance in plain language, not implementation terms', () => {
    // The decision asks for the limits "without requiring players to understand
    // implementation terminology". A line that said maxActiveProjectiles would satisfy
    // the numbers assertion above and fail the readable-rule requirement.
    const text = (limitsLine(mount()).textContent ?? '').toLowerCase();
    expect(text).toContain('shell');
    expect(text).toContain('mine');
    for (const jargon of ['maxactiveprojectiles', 'minecapacity', 'cap', 'projectile']) {
      expect(text).not.toContain(jargon);
    }
  });

  it('offers no control that could change either limit', () => {
    // Criterion 1, asserted at the DOM rather than trusted to the descriptor's shape:
    // the row is text, and the pane grows no shell/mine input as it is extended.
    const root = mount();
    expect(limitsLine(root).tagName).toBe('P');
    expect(root.querySelectorAll('.hud-versus-setup input')).toHaveLength(0);
    const labels = Array.from(root.querySelectorAll('.hud-versus-setup button')).map(
      (b) => (b.textContent ?? '').toLowerCase(),
    );
    expect(labels.some((l) => l.includes('shell') || l.includes('mine'))).toBe(false);
  });
});
