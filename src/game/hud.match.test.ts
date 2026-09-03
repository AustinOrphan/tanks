// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { createHud, type Hud } from './hud';
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
  it('win panel carries the ffa results line, per-slot kills/deaths', () => {
    const { hud: h, root } = mount();
    h.setVersusResults({ mode: 'ffa', kills: [2, 0, 1], deaths: [1, 3, 0] });
    h.setState('outcome-win');
    const line = (root.querySelector('.hud-versus-results') as HTMLElement).textContent ?? '';
    expect(line).toBe('P1: 2/1 · P2: 0/3 · P3: 1/0');
    expect(root.querySelector('.hud-versus-results')!.classList.contains('hud-versus-results--hidden')).toBe(false);
  });

  it('win panel carries the teams results line as PER-TEAM sums, not per-slot', () => {
    const { hud: h, root } = mount();
    // slots 0,2 -> team 0; slot 1 -> team 1 (teamOf(slot) = slot % 2).
    h.setVersusResults({ mode: 'teams', kills: [2, 1, 3], deaths: [1, 4, 0] });
    h.setState('outcome-win');
    const line = (root.querySelector('.hud-versus-results') as HTMLElement).textContent ?? '';
    expect(line).toBe('Team 1: 5/1 · Team 2: 1/4');
  });

  it('setVersusResults(null) keeps the line hidden even at win/lose', () => {
    const { hud: h, root } = mount();
    h.setVersusResults(null);
    h.setState('outcome-win');
    expect(root.querySelector('.hud-versus-results')!.classList.contains('hud-versus-results--hidden')).toBe(true);
    h.setState('outcome-lose');
    expect(root.querySelector('.hud-versus-results')!.classList.contains('hud-versus-results--hidden')).toBe(true);
  });

  it('the versus results line is hidden outside win/lose, even with live data set', () => {
    const { hud: h, root } = mount();
    h.setVersusResults({ mode: 'ffa', kills: [1], deaths: [0] });
    h.setState('playing');
    expect(root.querySelector('.hud-versus-results')!.classList.contains('hud-versus-results--hidden')).toBe(true);
  });

  it('updates live while the win panel is already open, same as the coop kill line', () => {
    const { hud: h, root } = mount();
    h.setVersusResults({ mode: 'ffa', kills: [1, 0], deaths: [0, 1] });
    h.setState('outcome-win');
    expect((root.querySelector('.hud-versus-results') as HTMLElement).textContent).toBe('P1: 1/0 · P2: 0/1');
    h.setVersusResults({ mode: 'ffa', kills: [1, 1], deaths: [1, 1] });
    expect((root.querySelector('.hud-versus-results') as HTMLElement).textContent).toBe('P1: 1/1 · P2: 1/1');
  });
});

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
    h.setSessionKind('versus');
    h.setState('playing');
    h.setVersusStocks([
      { slot: 0, stock: 3, team: 0 },
      { slot: 1, stock: 2, team: 1 },
      { slot: 2, stock: 1, team: 2 },
    ]);
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
    h.setSessionKind('versus');
    h.setState('playing');
    h.setVersusStocks([{ slot: 0, stock: 3 }, { slot: 1, stock: 2 }]);
    expect(entries(root).map((e) => e.textContent)).toEqual(['P1 3', 'P2 2']);
  });

  it('setVersusStocks(null) keeps the strip hidden even while playing', () => {
    const { hud: h, root } = mount();
    h.setSessionKind('versus');
    h.setVersusStocks(null);
    h.setState('playing');
    expect(strip(root).classList.contains('hud-versus-stocks--hidden')).toBe(true);
  });

  // The PRODUCTION order, not the data-then-state order every test above/below this one
  // uses: loop.ts calls `hud.setState('playing')` BEFORE the first real
  // `hud.setVersusStocks(entries)` call, because nothing marks "a versus match just
  // started" as a SimEvent -- onFrameEvents (loop.ts) only fires once something has
  // actually happened. Before this fix, that first setState('playing') ran
  // renderVersusStocks against still-null data, which re-added `--hidden`; the OLD
  // setVersusStocks guard then read that SAME class and silently dropped the very
  // first real call, forever (nothing else touched the class until a later setState,
  // e.g. a pause). Breaks if `setVersusStocks`'s render guard reads the DOM class
  // instead of the state-derived `versusStocksVisible` variable.
  it('production order -- setSessionKind then setState(playing) THEN setVersusStocks -- the strip still ends up visible with entries', () => {
    const { hud: h, root } = mount();
    h.setSessionKind('versus');
    h.setState('playing');
    h.setVersusStocks([{ slot: 0, stock: 3 }, { slot: 1, stock: 2 }]);
    expect(strip(root).classList.contains('hud-versus-stocks--hidden')).toBe(false);
    expect(entries(root).map((e) => e.textContent)).toEqual(['P1 3', 'P2 2']);
  });

  it('renders one entry per slot, with the slot number and stock count as its text', () => {
    const { hud: h, root } = mount();
    h.setSessionKind('versus');
    h.setVersusStocks([{ slot: 0, stock: 3 }, { slot: 1, stock: 2 }]);
    h.setState('playing');
    expect(entries(root).map((e) => e.textContent)).toEqual(['P1 3', 'P2 2']);
    expect(strip(root).classList.contains('hud-versus-stocks--hidden')).toBe(false);
  });

  it('ffa entries are tinted from IDENTITY_RING_COLORS[slot], not a copied-out hex', () => {
    const { hud: h, root } = mount();
    h.setSessionKind('versus');
    h.setVersusStocks([{ slot: 0, stock: 3 }, { slot: 1, stock: 2 }]);
    h.setState('playing');
    const es = entries(root);
    expect(es[0].style.color).toBe(expectedCssColor(IDENTITY_RING_COLORS[0]));
    expect(es[1].style.color).toBe(expectedCssColor(IDENTITY_RING_COLORS[1]));
  });

  it("teams entries are tinted from TEAM_COLORS[team], not IDENTITY_RING_COLORS[slot]", () => {
    const { hud: h, root } = mount();
    h.setSessionKind('versus');
    // slot 0 carries team 1 deliberately -- if the dispatch dropped `team` and fell
    // through to the ffa branch, this would read IDENTITY_RING_COLORS[0] instead.
    h.setVersusStocks([{ slot: 0, stock: 3, team: 1 }, { slot: 1, stock: 2, team: 0 }]);
    h.setState('playing');
    const es = entries(root);
    expect(es[0].style.color).toBe(expectedCssColor(TEAM_COLORS[1]));
    expect(es[1].style.color).toBe(expectedCssColor(TEAM_COLORS[0]));
    expect(es[0].style.color).not.toBe(expectedCssColor(IDENTITY_RING_COLORS[0]));
  });

  it('hidden at title/win/lose even with entries set', () => {
    const { hud: h, root } = mount();
    h.setSessionKind('versus');
    h.setVersusStocks([{ slot: 0, stock: 3 }, { slot: 1, stock: 2 }]);
    for (const s of ['main-menu', 'outcome-win', 'outcome-lose'] as const) {
      h.setState(s);
      expect(strip(root).classList.contains('hud-versus-stocks--hidden'), s).toBe(true);
    }
  });

  it('visible at both playing and paused', () => {
    const { hud: h, root } = mount();
    h.setSessionKind('versus');
    h.setVersusStocks([{ slot: 0, stock: 3 }]);
    for (const s of ['playing', 'paused'] as const) {
      h.setState(s);
      expect(strip(root).classList.contains('hud-versus-stocks--hidden'), s).toBe(false);
    }
  });

  it('a campaign session never shows the strip, even with entries set -- the gate is sessionKind, not trusting loop.ts to never call this with entries', () => {
    const { hud: h, root } = mount();
    // sessionKind defaults to 'campaign' -- no setSessionKind('versus') call.
    h.setVersusStocks([{ slot: 0, stock: 3 }]);
    h.setState('playing');
    expect(strip(root).classList.contains('hud-versus-stocks--hidden')).toBe(true);
  });
});

describe('hud: campaign Lives/Enemies stats hidden during versus (issue #282)', () => {
  const statEls = (root: HTMLElement): HTMLElement[] =>
    Array.from(root.querySelectorAll('.hud-campaign-stat')) as HTMLElement[];
  const hidden = (root: HTMLElement): boolean[] =>
    statEls(root).map((e) => e.classList.contains('hud-campaign-stat--hidden'));

  it('hides Lives/Enemies for a versus session in both playing and paused', () => {
    const { hud: h, root } = mount();
    h.setSessionKind('versus');
    // Two stat elements exist (Lives, Enemies) -- fails silently (an empty sweep that
    // still passes) if the markup ever drops one, so the population is asserted here
    // rather than assumed.
    expect(statEls(root).length).toBe(2);
    for (const s of ['playing', 'paused'] as const) {
      h.setState(s);
      expect(hidden(root), s).toEqual([true, true]);
    }
  });

  it('keeps Lives/Enemies visible and updating for a campaign session -- the negative control against over-hiding', () => {
    const { hud: h, root } = mount();
    h.setSessionKind('campaign');
    for (const s of ['playing', 'paused'] as const) {
      h.setState(s);
      expect(hidden(root), s).toEqual([false, false]);
    }
    h.setLives(2);
    h.setEnemiesRemaining(1);
    expect((root.querySelector('.hud-lives') as HTMLElement).textContent).toBe('2');
    expect((root.querySelector('.hud-enemies') as HTMLElement).textContent).toBe('1');
  });

  it("a session-kind switch restores the stats -- production reboots into a FRESH Hud per session (boot.ts's requestCampaignSession -> deps.startGame), so this exercises the stronger property that the gate tracks CURRENT kind rather than latching the first kind a Hud instance ever saw", () => {
    const { hud: h, root } = mount();
    h.setSessionKind('versus');
    h.setState('playing');
    expect(hidden(root)).toEqual([true, true]);

    h.setSessionKind('campaign');
    expect(hidden(root)).toEqual([false, false]);
  });

  it('a campaign session never hides the stats even if setVersusStocks somehow carried entries -- the gate is sessionKind, not versus data', () => {
    const { hud: h, root } = mount();
    // sessionKind defaults to 'campaign' -- no setSessionKind('versus') call.
    h.setVersusStocks([{ slot: 0, stock: 3 }]);
    h.setState('playing');
    expect(hidden(root)).toEqual([false, false]);
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
