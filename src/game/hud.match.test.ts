// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createHud, type GameplayStatus, type Hud, type VersusStock } from './hud';
import { STOCK_CUE_MS, type StockCue } from '../presentation/stock-cue';
import { configFor } from '../sim/config';
import { IDENTITY_RING_COLORS, TEAM_COLORS } from '../presentation/identity';
import {
  IDENTITY_MARKER_STYLES, type IdentityMarkerStyle, markerCount, shapeOutlineFor,
} from '../presentation/identity-marker';


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
  /**
   * The results readout as ROWS OF CELLS since the owner's ruling on issue #279 -- it was
   * one run-on line (`P1: 2/1 · P2: 0/3 · ...`) and is now a table, one row per
   * competitor. Read structurally rather than as a concatenated string: the point of the
   * change is that kills and deaths sit in their own columns, and a `textContent`
   * comparison cannot tell a table from the same digits in one cell.
   */
  const versusRows = (root: HTMLElement): string[][] =>
    Array.from(versusLine(root).querySelectorAll('tr')).map((tr) =>
      Array.from(tr.children).map((c) => c.textContent ?? ''),
    );

  it('drops the campaign attempt line, because the table below already says it per player', () => {
    // Owner ruling. "Level attempt: ..." was the last campaign-scoped wording on a versus
    // screen -- a versus match is not a level -- and it sat directly above a table
    // reporting the same ground for EVERY player rather than the tracked seat alone.
    //
    // The two also disagreed, which is the sharper reason: `attempt` counts the tracked
    // player's shell and mine kills against their own shots, while the table is per-slot.
    // The line read one number and Player 1's row read another, and neither was wrong.
    const { hud: h, root } = mount();
    const attemptLine = (): HTMLElement =>
      root.querySelector('.hud-attempt-summary') as HTMLElement;
    const shown = (): boolean =>
      !attemptLine().classList.contains('hud-attempt-summary--hidden');

    h.setOutcome({ tally: 'ffa', action: 'versus-setup', attempt: NO_ATTEMPT, kills: [2, 0], deaths: [0, 2], shots: [8, 4], shellKills: [2, 0] });
    h.setState('outcome-win');
    expect(shown(), 'a versus result still carried the campaign attempt line').toBe(false);

    // THE NEGATIVE CONTROL: the line is dropped for a VERSUS result, not switched off for
    // every ending. A campaign screen is where it belongs and where it stays -- without
    // this, deleting the element entirely would satisfy the assertion above.
    h.setOutcome({ tally: 'solo', action: 'campaign-levels', attempt: NO_ATTEMPT });
    expect(shown(), 'the campaign ending lost its attempt line too').toBe(true);
  });

  it('win panel carries the ffa results line, per-slot kills/deaths', () => {
    const { hud: h, root } = mount();
    h.setOutcome({ tally: 'ffa', action: 'versus-setup', attempt: NO_ATTEMPT, kills: [2, 0, 1], deaths: [1, 3, 0], shots: [8, 4, 4], shellKills: [2, 0, 1] });
    h.setState('outcome-win');
    // ACCURACY per player (owner ruling): shell kills over shots fired, the same meaning
    // the campaign line has always had -- so a mine kill raises Kills and leaves this
    // column alone. 2 of 8, 0 of 4, 1 of 4.
    expect(versusRows(root)).toEqual([
      ['', 'Kills', 'Deaths', 'Accuracy'],
      ['Player 1', '2', '1', '25%'],
      ['Player 2', '0', '3', '0%'],
      ['Player 3', '1', '0', '25%'],
    ]);
    expect(versusLine(root).classList.contains('hud-versus-results--hidden')).toBe(false);
  });

  it('win panel carries the teams results line as PER-TEAM sums, not per-slot', () => {
    const { hud: h, root } = mount();
    // slots 0,2 -> team 0; slot 1 -> team 1 (teamOf(slot) = slot % 2).
    h.setOutcome({ tally: 'teams', action: 'versus-setup', attempt: NO_ATTEMPT, kills: [2, 1, 3], deaths: [1, 4, 0], shots: [8, 4, 12], shellKills: [2, 1, 3] });
    h.setState('outcome-win');
    // PER-TEAM rows, not per-slot: teams mode cares which side won, and a per-player
    // breakdown here would answer a question the mode is not asking.
    expect(versusRows(root)).toEqual([
      ['', 'Kills', 'Deaths', 'Accuracy'],
      // Accuracy sums per SIDE too -- slots 0 and 2 are team 1, so 5 shell kills of 20
      // shots, not the average of two per-player percentages, which would weight a slot
      // that barely fired the same as one that carried the match.
      ['Team 1', '5', '1', '25%'],
      ['Team 2', '1', '4', '25%'],
    ]);
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
    h.setOutcome({ tally: 'ffa', action: 'versus-setup', attempt: NO_ATTEMPT, kills: [2, 0], deaths: [0, 2], shots: [8, 4], shellKills: [2, 0] });
    h.setState('outcome-win');
    const atOutcome = versusLine(root).textContent ?? '';
    expect(versusRows(root)).toEqual([
      ['', 'Kills', 'Deaths', 'Accuracy'],
      ['Player 1', '2', '0', '25%'],
      ['Player 2', '0', '2', '0%'],
    ]);

    h.setState('playing');
    h.setOutcome({ tally: 'ffa', action: 'versus-setup', attempt: NO_ATTEMPT, kills: [9, 9], deaths: [9, 9], shots: [36, 36], shellKills: [9, 9] });
    expect(versusLine(root).textContent ?? '', 'a push during play reached the DOM').toBe(atOutcome);

    // ...and the gate reopens: the next outcome surface renders the push it was given,
    // so this is not a flag stuck the other way.
    h.setState('outcome-win');
    h.setOutcome({ tally: 'ffa', action: 'versus-setup', attempt: NO_ATTEMPT, kills: [1, 3], deaths: [3, 1], shots: [4, 12], shellKills: [1, 3] });
    expect(versusRows(root)).toEqual([
      ['', 'Kills', 'Deaths', 'Accuracy'],
      ['Player 1', '1', '3', '25%'],
      ['Player 2', '3', '1', '25%'],
    ]);
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
    h.setOutcome({ tally: 'ffa', action: 'versus-setup', attempt: NO_ATTEMPT, kills: [1, 2], deaths: [2, 1], shots: [4, 8], shellKills: [1, 2] });
    expect(coopLine().classList.contains('hud-coop-kills--hidden')).toBe(true);
    expect(versusLine(root).classList.contains('hud-versus-results--hidden')).toBe(false);
  });

  it('the versus results line is hidden outside win/lose, even with live data set', () => {
    const { hud: h, root } = mount();
    h.setOutcome({ tally: 'ffa', action: 'versus-setup', attempt: NO_ATTEMPT, kills: [1], deaths: [0], shots: [4], shellKills: [1] });
    h.setState('playing');
    expect(versusLine(root).classList.contains('hud-versus-results--hidden')).toBe(true);
  });

  it('updates live while the win panel is already open, same as the coop kill line', () => {
    const { hud: h, root } = mount();
    h.setOutcome({ tally: 'ffa', action: 'versus-setup', attempt: NO_ATTEMPT, kills: [1, 0], deaths: [0, 1], shots: [4, 4], shellKills: [1, 0] });
    h.setState('outcome-win');
    expect(versusRows(root)).toEqual([
      ['', 'Kills', 'Deaths', 'Accuracy'],
      ['Player 1', '1', '0', '25%'],
      ['Player 2', '0', '1', '0%'],
    ]);
    h.setOutcome({ tally: 'ffa', action: 'versus-setup', attempt: NO_ATTEMPT, kills: [1, 1], deaths: [1, 1], shots: [4, 4], shellKills: [1, 1] });
    expect(versusRows(root)).toEqual([
      ['', 'Kills', 'Deaths', 'Accuracy'],
      ['Player 1', '1', '1', '25%'],
      ['Player 2', '1', '1', '25%'],
    ]);
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
 * Issue #230's stock-loss cue: three arms behind `?dev=1&stockCue=`, and no cue without it.
 *
 * Driven through the public boundary -- `createHud` with the option, then `setState` and
 * `setStatus` in production order -- because the hazard these cases exist for is composition:
 * `renderVersusStocks` rebuilds every entry from scratch on each status that moves, so a cue
 * drawn on an entry is destroyed by the next push unless the rebuild puts it back.
 *
 * Time is `performance.now()`, faked, so "300 ms into the cue" is a fact the case sets rather
 * than a race it hopes to win.
 */
describe('hud: stock-loss cue arms (issue #230)', () => {
  const entries = (root: HTMLElement): HTMLElement[] =>
    Array.from(root.querySelectorAll('.hud-versus-stock-entry')) as HTMLElement[];

  function mountCue(stockCue: StockCue | null): { hud: Hud; root: HTMLElement } {
    const root = document.createElement('div');
    document.body.appendChild(root);
    hud = createHud(root, { stockCue });
    hud.setState('playing');
    return { hud, root };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('draws no cue at all without the flag -- the shipped strip only changes its digit', () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    const { hud: h, root } = mountCue(null);
    h.setStatus(versusStatus([{ slot: 0, stock: 3 }, { slot: 1, stock: 3 }]));
    h.setStatus(versusStatus([{ slot: 0, stock: 2 }, { slot: 1, stock: 3 }]));
    expect(entries(root).map((e) => e.textContent)).toEqual(['P1 2', 'P2 3']);
    expect(root.querySelectorAll('.hud-stock-cue')).toHaveLength(0);
    expect(root.querySelectorAll('.hud-stock-pip')).toHaveLength(0);
  });

  it('badge: a "−1" on the entry that lost the stock, and on no other', () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    const { hud: h, root } = mountCue('badge');
    h.setStatus(versusStatus([{ slot: 0, stock: 3 }, { slot: 1, stock: 3 }]));
    expect(root.querySelectorAll('.hud-stock-cue'), 'no loss yet, no cue').toHaveLength(0);
    h.setStatus(versusStatus([{ slot: 0, stock: 3 }, { slot: 1, stock: 2 }]));
    const [p1, p2] = entries(root);
    expect(p1.querySelector('.hud-stock-cue')).toBeNull();
    const badge = p2.querySelector('.hud-stock-cue--badge') as HTMLElement;
    expect(badge.textContent).toBe('−1');
    // Decoration, not a second announcement: #629 already speaks the loss.
    expect(badge.getAttribute('aria-hidden')).toBe('true');
    expect(p2.querySelector('.hud-stock-count')?.textContent).toBe('2');
  });

  it('strike: the old number struck beside the new one', () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    const { hud: h, root } = mountCue('strike');
    h.setStatus(versusStatus([{ slot: 0, stock: 3 }, { slot: 1, stock: 3 }]));
    h.setStatus(versusStatus([{ slot: 0, stock: 2 }, { slot: 1, stock: 3 }]));
    const [p1, p2] = entries(root);
    const struck = p1.querySelector('.hud-stock-cue--struck') as HTMLElement;
    expect(struck.textContent).toBe('3');
    expect(struck.getAttribute('aria-hidden')).toBe('true');
    expect(p1.querySelector('.hud-stock-count')?.textContent).toBe('2');
    // The new number drops in on the cue's clock, so it is a cue element too.
    expect(p1.querySelector('.hud-stock-count')?.classList.contains('hud-stock-cue')).toBe(true);
    expect(p2.querySelector('.hud-stock-cue')).toBeNull();
  });

  it('pips: one pip per starting stock, lost ones hollow, and the one just lost carries the cue', () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    const { hud: h, root } = mountCue('pips');
    h.setStatus(versusStatus([{ slot: 0, stock: 3 }, { slot: 1, stock: 3 }]));
    const pipsOf = (e: HTMLElement): HTMLElement[] => Array.from(e.querySelectorAll('.hud-stock-pip')) as HTMLElement[];
    expect(pipsOf(entries(root)[0]).map((p) => p.classList.contains('hud-stock-pip--lost'))).toEqual([false, false, false]);
    h.setStatus(versusStatus([{ slot: 0, stock: 2 }, { slot: 1, stock: 3 }]));
    const [p1, p2] = entries(root);
    // Lost pips are the trailing ones, so the filled run always reads as the count.
    expect(pipsOf(p1).map((p) => p.classList.contains('hud-stock-pip--lost'))).toEqual([false, false, true]);
    expect(pipsOf(p1)[2].classList.contains('hud-stock-cue')).toBe(true);
    expect(p1.querySelectorAll('.hud-stock-cue')).toHaveLength(1);
    expect(p2.querySelectorAll('.hud-stock-cue')).toHaveLength(0);
    // The count survives as text for assistive technology, since the pips are shapes.
    expect(p1.querySelector('.hud-stock-pips')?.getAttribute('aria-label')).toBe('2 of 3 stocks');
  });

  it('pips: a narrow viewport shrinks the pip, and hands back the digit when none fits (#835)', () => {
    // The strip is a nowrap flex row with no wrapping or scrolling, so a strip wider than the
    // viewport clips its last entry SILENTLY -- four players at three stocks measured 345px in
    // a 390px viewport on main. Driven through the public boundary because the hazard is
    // composition: the sizing is decided in the builder that `renderVersusStocks` calls for
    // every entry on every status that moves.
    vi.useFakeTimers({ toFake: ['performance'] });
    const wide = window.matchMedia;
    try {
      // jsdom's matchMedia always reports false, so the narrow branch has to be asked for.
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        value: (q: string) => ({ matches: q === '(max-width: 480px)', media: q, addEventListener() {}, removeEventListener() {} }),
      });

      // Four players at three stocks: pips, shrunk to the 9px the measurement allows.
      const four = mountCue('pips');
      four.hud.setStatus(versusStatus([0, 1, 2, 3].map((slot) => ({ slot, stock: 3 }))));
      const shrunk = four.root.querySelector('.hud-stock-pips') as HTMLElement;
      expect(shrunk, 'four players at three stocks still draws pips').not.toBeNull();
      expect(shrunk.style.getPropertyValue('--hud-pip')).toBe('9px');
      four.root.remove();

      // Four players at FIVE stocks: no legible pip fits, so the entry states the digit. The
      // count stays readable, which is the whole requirement.
      const five = mountCue('pips');
      five.hud.setStatus(versusStatus([0, 1, 2, 3].map((slot) => ({ slot, stock: 5 }))));
      expect(five.root.querySelectorAll('.hud-stock-pip')).toHaveLength(0);
      expect(entries(five.root).map((e) => e.textContent)).toEqual(['P1 5', 'P2 5', 'P3 5', 'P4 5']);
    } finally {
      Object.defineProperty(window, 'matchMedia', { configurable: true, value: wide });
    }
  });

  it.each(['pips', 'strike', 'badge'] as const)(
    '%s: a cue still running survives the rebuild another slot\'s loss causes, resumed at its elapsed time',
    (arm) => {
      vi.useFakeTimers({ toFake: ['performance'] });
      const { hud: h, root } = mountCue(arm);
      h.setStatus(versusStatus([{ slot: 0, stock: 3 }, { slot: 1, stock: 3 }]));
      h.setStatus(versusStatus([{ slot: 0, stock: 2 }, { slot: 1, stock: 3 }]));
      vi.advanceTimersByTime(300);
      // A second loss, on the OTHER slot, moves the status: the strip is rebuilt.
      h.setStatus(versusStatus([{ slot: 0, stock: 2 }, { slot: 1, stock: 2 }]));
      const [p1, p2] = entries(root);
      const cue = p1.querySelector('.hud-stock-cue') as HTMLElement | null;
      expect(cue, `${arm}: P1's cue after the rebuild`).not.toBeNull();
      expect((cue as HTMLElement).style.animationDelay).toBe('-300ms');
      const fresh = p2.querySelector('.hud-stock-cue') as HTMLElement;
      expect(fresh, `${arm}: P2's own cue`).not.toBeNull();
      expect(fresh.style.animationDelay).toBe('0ms');
    },
  );

  it.each(['pips', 'strike', 'badge'] as const)('%s: a cue is gone once STOCK_CUE_MS has passed', (arm) => {
    vi.useFakeTimers({ toFake: ['performance'] });
    const { hud: h, root } = mountCue(arm);
    h.setStatus(versusStatus([{ slot: 0, stock: 3 }, { slot: 1, stock: 3 }]));
    h.setStatus(versusStatus([{ slot: 0, stock: 2 }, { slot: 1, stock: 3 }]));
    vi.advanceTimersByTime(STOCK_CUE_MS);
    h.setStatus(versusStatus([{ slot: 0, stock: 2 }, { slot: 1, stock: 2 }]));
    expect(entries(root)[0].querySelector('.hud-stock-cue'), `${arm}: P1's expired cue`).toBeNull();
    // ...while the pips arm still shows the lost stock as a hollow pip: the count is permanent.
    if (arm === 'pips') {
      expect(entries(root)[0].querySelectorAll('.hud-stock-pip--lost')).toHaveLength(1);
    }
  });

  it('a rematch that resets stocks upward is not a loss, and starts a new pip count', () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    const { hud: h, root } = mountCue('pips');
    h.setStatus(versusStatus([{ slot: 0, stock: 3 }, { slot: 1, stock: 3 }]));
    h.setStatus(versusStatus([{ slot: 0, stock: 5 }, { slot: 1, stock: 5 }]));
    expect(root.querySelectorAll('.hud-stock-cue')).toHaveLength(0);
    expect(entries(root)[0].querySelectorAll('.hud-stock-pip')).toHaveLength(5);
    expect(entries(root)[0].querySelectorAll('.hud-stock-pip--lost')).toHaveLength(0);
    // The first loss of the new match counts against 5, not against the old match's 3. Without
    // the reset on a rise, the denominator would stay 3 and this entry would show 4 pips, none lost.
    h.setStatus(versusStatus([{ slot: 0, stock: 4 }, { slot: 1, stock: 5 }]));
    expect(entries(root)[0].querySelectorAll('.hud-stock-pip')).toHaveLength(5);
    expect(entries(root)[0].querySelectorAll('.hud-stock-pip--lost')).toHaveLength(1);
  });

  it.each(['pips', 'strike', 'badge'] as const)(
    '%s: a rebuild with no new status after STOCK_CUE_MS -- a pause -- draws no cue',
    (arm) => {
      // The strip is also rebuilt when the SURFACE moves (setState runs applyStatus), with no
      // status push to record anything. Only the rebuild's own elapsed check can drop the cue.
      vi.useFakeTimers({ toFake: ['performance'] });
      const { hud: h, root } = mountCue(arm);
      h.setStatus(versusStatus([{ slot: 0, stock: 3 }, { slot: 1, stock: 3 }]));
      h.setStatus(versusStatus([{ slot: 0, stock: 2 }, { slot: 1, stock: 3 }]));
      h.setState('paused');
      expect(entries(root)[0].querySelector('.hud-stock-cue'), `${arm}: still running at 0 ms`).not.toBeNull();
      vi.advanceTimersByTime(STOCK_CUE_MS);
      h.setState('playing');
      expect(entries(root)[0].querySelector('.hud-stock-cue'), `${arm}: expired`).toBeNull();
    },
  );

  it('a different match with a lower stock is not a loss in this one -- the same-slots guard', () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    const { hud: h, root } = mountCue('badge');
    h.setStatus(versusStatus([{ slot: 0, stock: 3 }, { slot: 1, stock: 3 }]));
    // Three slots now: a different match, so slot 0's 1 is its starting stock, not a loss.
    h.setStatus(versusStatus([{ slot: 0, stock: 1 }, { slot: 1, stock: 1 }, { slot: 2, stock: 1 }]));
    expect(root.querySelectorAll('.hud-stock-cue')).toHaveLength(0);
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

/**
 * THE IDENTITY MARK IN THE STOCK STRIP (issue #778).
 *
 * The strip tells players apart by hue alone, which is the largest colour-only gap left in
 * #630 and #327. This arm draws the same mark that slot wears on the ground, so #234 can be
 * ruled on the PAIR rather than on either half.
 *
 * This is the strip's side of the shared table; `render/identity-marker.test.ts` holds the
 * ring's. Both derive their expectations from `shapeOutlineFor`/`markerCount` rather than
 * quoting shapes, so a slot cannot move in one and stay put in the other.
 */
describe('hud: identity mark in the stock strip (issue #778)', () => {
  const entries = (root: HTMLElement): HTMLElement[] =>
    Array.from(root.querySelectorAll('.hud-versus-stock-entry')) as HTMLElement[];
  const marks = (root: HTMLElement): SVGElement[] =>
    Array.from(root.querySelectorAll('.hud-stock-marker')) as unknown as SVGElement[];

  function mountMark(identityMarker: IdentityMarkerStyle | null): { hud: Hud; root: HTMLElement } {
    const root = document.createElement('div');
    document.body.appendChild(root);
    hud = createHud(root, { identityMarker });
    hud.setState('playing');
    return { hud, root };
  }

  const ffa = [{ slot: 0, stock: 3 }, { slot: 1, stock: 2 }, { slot: 2, stock: 3 }, { slot: 3, stock: 1 }];

  it('draws nothing at all without the flag, and leaves the strip byte-identical', () => {
    // The acceptance criterion this file owns: absent means the shipped strip. Asserted as
    // an EQUALITY between an unflagged HUD and an explicitly-null one, and then against the
    // literal markup, so an addition to this path fails here rather than in a capture.
    const { hud: off, root: offRoot } = mountMark(null);
    off.setStatus(versusStatus(ffa));
    const plain = document.createElement('div');
    document.body.appendChild(plain);
    const bare = createHud(plain);
    bare.setState('playing');
    bare.setStatus(versusStatus(ffa));
    const strip = (r: HTMLElement): string =>
      (r.querySelector('.hud-versus-stocks') as HTMLElement).innerHTML;
    expect(strip(offRoot), 'an explicit null differs from an absent option').toBe(strip(plain));
    expect(marks(offRoot)).toHaveLength(0);
    // Scoped to the STRIP: the shell carries its own icons (the achievement padlock, the
    // rotate glyphs), so a document-wide svg count would be asserting someone else's DOM.
    expect((offRoot.querySelector('.hud-versus-stocks') as HTMLElement)
      .querySelectorAll('svg')).toHaveLength(0);
    expect(entries(offRoot).map((e) => e.textContent)).toEqual(['P1 3', 'P2 2', 'P3 3', 'P4 1']);
    bare.dispose();
  });

  it('gives every FFA entry the outline its slot wears in the arena', () => {
    const { hud: h, root } = mountMark('shape');
    h.setStatus(versusStatus(ffa));
    expect(marks(root), 'one mark per entry').toHaveLength(4);
    for (const [slot, mark] of marks(root).entries()) {
      const outline = shapeOutlineFor(slot);
      if (outline.kind === 'circle') {
        expect(mark.querySelector('circle'), `slot ${slot} is not a circle`).not.toBeNull();
        expect(mark.querySelector('polygon'), `slot ${slot} drew a polygon too`).toBeNull();
        continue;
      }
      const poly = mark.querySelector('polygon');
      expect(poly, `slot ${slot} drew no polygon`).not.toBeNull();
      // A closed SVG polygon does NOT repeat its first point, so the corner count is the
      // table's own number: `sides` for an n-gon, `2 * points` for the alternating star.
      const want = outline.kind === 'polygon' ? outline.sides : outline.points * 2;
      const got = (poly as Element).getAttribute('points')!.trim().split(/\s+/).length / 2;
      expect(got, `slot ${slot} (${outline.kind}) drew ${got} corners`).toBe(want);
    }
  });

  it('counts the arcs and the blades the table counts, for the two counting styles', () => {
    for (const style of ['arcs', 'roof'] as const) {
      const { hud: h, root } = mountMark(style);
      h.setStatus(versusStatus(ffa));
      for (const [slot, mark] of marks(root).entries()) {
        expect(mark.querySelectorAll('path'), `${style} slot ${slot}`)
          .toHaveLength(markerCount(slot));
      }
      h.dispose();
    }
  });

  it('covers all three styles, so the pairing holds whichever the owner picks', () => {
    for (const style of IDENTITY_MARKER_STYLES) {
      const { hud: h, root } = mountMark(style);
      h.setStatus(versusStatus(ffa));
      expect(marks(root), `${style} drew no mark`).toHaveLength(4);
      for (const mark of marks(root)) {
        expect(mark.innerHTML.length, `${style} drew an empty mark`).toBeGreaterThan(0);
      }
      h.dispose();
    }
  });

  it('leaves TEAMS untouched -- the letter is already that entry second channel', () => {
    const { hud: h, root } = mountMark('shape');
    h.setStatus(versusStatus([
      { slot: 0, stock: 3, team: 0 }, { slot: 1, stock: 3, team: 1 },
    ]));
    expect(marks(root), 'a teams entry grew a mark').toHaveLength(0);
    expect(entries(root).map((e) => e.textContent)).toEqual(['P1 A 3', 'P2 B 3']);
  });

  it('adds no second name for the player, and nothing focusable', () => {
    // The a11y criterion: the entry already says "P1", so the mark carries no name of its
    // own. A `role`/`aria-label` here would be the duplicate announcement, and a focusable
    // SVG would put a stop on every entry in the tab ring.
    const { hud: h, root } = mountMark('shape');
    h.setStatus(versusStatus(ffa));
    for (const mark of marks(root)) {
      expect(mark.getAttribute('aria-hidden')).toBe('true');
      expect(mark.getAttribute('aria-label')).toBeNull();
      expect(mark.getAttribute('role')).toBeNull();
      expect(mark.getAttribute('focusable')).toBe('false');
      expect(mark.getAttribute('tabindex')).toBeNull();
    }
    // The text the screen reader gets is exactly what it was without the flag.
    expect(entries(root).map((e) => e.textContent)).toEqual(['P1 3', 'P2 2', 'P3 3', 'P4 1']);
  });

  it('puts the mark AHEAD of the label, and keeps one per entry across a rebuild', () => {
    const { hud: h, root } = mountMark('shape');
    h.setStatus(versusStatus(ffa));
    for (const entry of entries(root)) {
      // `firstChild`, NOT `firstElementChild`. The label is a TEXT node, so the mark is the
      // entry's only ELEMENT wherever it sits -- `firstElementChild` finds it just as
      // happily when it has been appended after the label, and the assertion measures
      // nothing. Proven by mutation: switching `afterbegin` to `beforeend` passed the
      // element-wise form and fails this one.
      expect(entry.firstChild?.nodeName.toLowerCase(), entry.textContent).toBe('svg');
    }
    // The strip is rebuilt from scratch on every status, so a mark appended rather than
    // rebuilt would double here -- the same failure the cue arms record for their own DOM.
    h.setStatus(versusStatus(ffa.map((e) => ({ ...e, stock: e.stock - 1 }))));
    expect(marks(root)).toHaveLength(4);
  });

  it('paints on currentColor, so forced colours repaints it instead of dropping it', () => {
    // A `background` is dropped outright under forced colours, which is the exact condition
    // a non-colour channel exists to survive -- and is why hud.css.test.ts refuses one in
    // any `hud-stock-` rule. Asserted on the markup: the stroke names currentColor and no
    // literal colour is written into the glyph at all.
    const { hud: h, root } = mountMark('shape');
    h.setStatus(versusStatus(ffa));
    for (const mark of marks(root)) {
      expect(mark.innerHTML).toContain('currentColor');
      expect(mark.innerHTML, 'a literal colour would not survive forced colours')
        .not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(/i);
      expect(mark.innerHTML, 'a fill would read as a blob at strip size').toContain('fill="none"');
    }
  });
});

/**
 * THE `marks` STOCK ARM (issue #230), proposed after #833 paired the strip with the ground
 * ring and the pairing turned out to state the player's identity three times per entry.
 *
 * It replaces the pip with the slot's own identity outline, so one channel carries both which
 * player this is and how many stocks are left, and suppresses the separate leading marker
 * while it runs. The cases below pin the three things that makes true: the outline comes from
 * the shared table, the leading marker goes away, and the denominator still survives a loss.
 */
describe('hud: identity-shaped stocks, the `marks` arm (issue #230)', () => {
  const entries = (root: HTMLElement): HTMLElement[] =>
    Array.from(root.querySelectorAll('.hud-versus-stock-entry')) as HTMLElement[];
  const allMarks = (root: HTMLElement): SVGElement[] =>
    Array.from(root.querySelectorAll('.hud-stock-mark')) as unknown as SVGElement[];

  function mountMarks(
    opts: { stockCue?: StockCue | null; identityMarker?: IdentityMarkerStyle | null },
  ): { hud: Hud; root: HTMLElement } {
    const root = document.createElement('div');
    document.body.appendChild(root);
    hud = createHud(root, opts);
    hud.setState('playing');
    return { hud, root };
  }

  const four = [
    { slot: 0, stock: 3 }, { slot: 1, stock: 3 }, { slot: 2, stock: 3 }, { slot: 3, stock: 3 },
  ];

  it('draws one mark per stock, in the outline the shared table gives that slot', () => {
    const { hud: h, root } = mountMarks({ stockCue: 'marks' });
    h.setStatus(versusStatus(four));
    expect(allMarks(root), 'four entries at three stocks').toHaveLength(12);
    for (const [i, entry] of entries(root).entries()) {
      const marks = Array.from(entry.querySelectorAll('.hud-stock-mark'));
      expect(marks, `slot ${i}`).toHaveLength(3);
      const outline = shapeOutlineFor(i);
      for (const mark of marks) {
        if (outline.kind === 'circle') {
          expect(mark.querySelector('circle'), `slot ${i} is not a circle`).not.toBeNull();
          continue;
        }
        const poly = mark.querySelector('polygon');
        expect(poly, `slot ${i} drew no polygon`).not.toBeNull();
        const want = outline.kind === 'polygon' ? outline.sides : outline.points * 2;
        const got = (poly as Element).getAttribute('points')!.trim().split(/\s+/).length / 2;
        expect(got, `slot ${i} (${outline.kind})`).toBe(want);
      }
    }
  });

  it('suppresses the leading marker, which is the whole point of the arm', () => {
    // Both flags on. The arm already draws this slot's outline once per stock, so a leading
    // copy would state the identity twice -- and sit beside a hollow LOST mark of the same
    // shape, which for slot 1 is the same circle drawn the same way.
    const { hud: h, root } = mountMarks({ stockCue: 'marks', identityMarker: 'shape' });
    h.setStatus(versusStatus(four));
    expect(root.querySelectorAll('.hud-stock-marker'), 'a leading marker survived').toHaveLength(0);
    expect(allMarks(root), 'but the stocks are still drawn').toHaveLength(12);
  });

  it('still shows the leading marker under every OTHER arm', () => {
    // The negative control for the case above: the suppression is keyed on `marks`, not on
    // "a stock cue is running", so choosing `pips` or `strike` leaves #778's marker alone.
    for (const cue of ['pips', 'strike', 'badge'] as const) {
      const { hud: h, root } = mountMarks({ stockCue: cue, identityMarker: 'shape' });
      h.setStatus(versusStatus(four));
      expect(root.querySelectorAll('.hud-stock-marker'), `${cue} dropped the marker`).toHaveLength(4);
      h.dispose();
    }
  });

  it('keeps the denominator: a lost stock goes hollow rather than disappearing', () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    const { hud: h, root } = mountMarks({ stockCue: 'marks' });
    h.setStatus(versusStatus(four));
    h.setStatus(versusStatus(four.map((e) => (e.slot === 0 ? { ...e, stock: 2 } : e))));
    const first = entries(root)[0];
    // Three marks still, because the match STARTED at three -- the count is readable as
    // "two of three" rather than as an unlabelled two.
    expect(first.querySelectorAll('.hud-stock-mark'), 'the denominator moved').toHaveLength(3);
    expect(first.querySelectorAll('.hud-stock-mark--lost'), 'the lost stock').toHaveLength(1);
    // The mark that just emptied is the one carrying the cue, and it is the LAST one.
    const marks = Array.from(first.querySelectorAll('.hud-stock-mark'));
    expect(marks[2].classList.contains('hud-stock-cue'), 'the emptied mark is not cued').toBe(true);
    expect(marks[0].classList.contains('hud-stock-cue'), 'a held mark is cued').toBe(false);
  });

  it('names the count once for the row, not once per mark', () => {
    const { hud: h, root } = mountMarks({ stockCue: 'marks' });
    h.setStatus(versusStatus(four));
    const rows = Array.from(root.querySelectorAll('.hud-stock-marks'));
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.getAttribute('role')).toBe('img');
      expect(row.getAttribute('aria-label')).toBe('3 of 3 stocks');
    }
    // Every individual mark is hidden, so the row's one name is the only announcement --
    // five marks each naming themselves would read the count out five times.
    for (const mark of allMarks(root)) expect(mark.getAttribute('aria-hidden')).toBe('true');
  });

  it('paints in currentColor with no literal colour and no background', () => {
    // A held mark is FILLED and a lost one hollow, and both must survive forced colours --
    // which is why the fill is an SVG attribute on currentColor and not a CSS background.
    const { hud: h, root } = mountMarks({ stockCue: 'marks' });
    h.setStatus(versusStatus(four));
    for (const mark of allMarks(root)) {
      expect(mark.innerHTML).toContain('currentColor');
      expect(mark.innerHTML).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(/i);
    }
    const held = allMarks(root)[0];
    expect(held.innerHTML, 'a held stock is filled').toContain('fill="currentColor"');
  });

  it('leaves teams and the shipped strip alone', () => {
    const { hud: h, root } = mountMarks({ stockCue: 'marks' });
    h.setStatus(versusStatus([{ slot: 0, stock: 3, team: 0 }, { slot: 1, stock: 3, team: 1 }]));
    // Teams falls back to the neutral dot: the A/B/C letter is already that entry's
    // non-colour channel, and two teammates drawn with different outlines would claim to be
    // different sides while wearing one colour. The COUNT is still cued, so the arm stays a
    // complete stock-loss cue in both modes rather than having none in one.
    expect(allMarks(root), 'a teams entry grew identity marks').toHaveLength(0);
    expect(root.querySelectorAll('.hud-stock-pip'), 'teams lost its cue entirely').toHaveLength(6);
    expect(entries(root).map((e) => e.textContent)).toEqual(['P1 A ', 'P2 B ']);
    h.dispose();
    const plain = mountMarks({ stockCue: null });
    plain.hud.setStatus(versusStatus(four));
    expect(allMarks(plain.root)).toHaveLength(0);
    expect(entries(plain.root).map((e) => e.textContent)).toEqual(['P1 3', 'P2 3', 'P3 3', 'P4 3']);
  });
});
