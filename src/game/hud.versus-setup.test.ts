// @vitest-environment jsdom
import { defaultSlots } from './versus-setup';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createHud, type Hud, type HudOptions } from './hud';
import { campaignBoardUnlock, resolveVersusConfig, versusMapChoices, type VersusConfig } from './versus-config';
import { createVersusSetupStore, VERSUS_SETUP_KEY } from './versus-setup-store';
import { versusCatalogEntryById, VERSUS_CATALOG } from '../sim/config/versus-catalog';
import { createMemoryStorage } from './storage';
import { VERSUS_STOCK } from '../sim/constants';
import { installComputedStyleCache } from './computed-style-cache';

/**
 * The Versus Setup pane (docs/superpowers/specs/2026-08-21-versus-setup-menu-design.md): its
 * rows, its action bar (issue #668), the retained setup it reads and writes (issue #260) and its
 * map cards (issue #274). Split from `hud.navigation.test.ts` (issue #1093), whose header says why.
 */

// Keeps `display` across focus moves, which jsdom 30.1.2 recomputes (issue #1093).
installComputedStyleCache();

let hud: Hud | null = null;

function mount(opts: HudOptions = {}): { hud: Hud; root: HTMLElement } {
  const root = document.createElement('div');
  document.body.appendChild(root);
  hud = createHud(root, opts);
  return { hud, root };
}

afterEach(() => {
  hud?.dispose();
  hud = null;
  document.body.innerHTML = '';
});

describe('hud: versus setup pane (docs/superpowers/specs/2026-08-21-versus-setup-menu-design.md)', () => {
  const openBtn = (root: HTMLElement): HTMLButtonElement =>
    root.querySelector('.hud-versus-open') as HTMLButtonElement;
  const view = (root: HTMLElement): HTMLElement =>
    root.querySelector('.hud-versus-setup') as HTMLElement;
  const backBtn = (root: HTMLElement): HTMLButtonElement =>
    root.querySelector('.hud-versus-back') as HTMLButtonElement;
  const startBtn = (root: HTMLElement): HTMLButtonElement =>
    root.querySelector('.hud-versus-start') as HTMLButtonElement;
  const modeBtn = (root: HTMLElement, mode: 'ffa' | 'teams'): HTMLButtonElement =>
    root.querySelector(`.hud-versus-mode-row [data-mode="${mode}"]`) as HTMLButtonElement;
  const playersBtn = (root: HTMLElement, players: number): HTMLButtonElement =>
    root.querySelector(`.hud-versus-players-row [data-players="${players}"]`) as HTMLButtonElement;
  const stockBtn = (root: HTMLElement, stock: number): HTMLButtonElement =>
    root.querySelector(`.hud-versus-stock-row [data-stock="${stock}"]`) as HTMLButtonElement;
  const mapButtons = (root: HTMLElement): HTMLButtonElement[] =>
    Array.from(root.querySelectorAll('.hud-versus-map-row button'));
  const mapBtn = (root: HTMLElement, map: string): HTMLButtonElement =>
    root.querySelector(`.hud-versus-map-row [data-map="${map}"]`) as HTMLButtonElement;
  const friendlyFireBtn = (root: HTMLElement): HTMLButtonElement | null =>
    root.querySelector('.hud-versus-friendlyfire-btn');
  const mapNote = (root: HTMLElement): HTMLElement =>
    root.querySelector('.hud-versus-map-note') as HTMLElement;
  // The who's-playing SETUP rows (issue #260). These used to be
  // .hud-controller-row/.hud-controller-source-btn, shared with the real Controllers
  // panel and therefore needing a `view(root)` scope; they are now the pane's own
  // classes, which cannot collide, so no scoping comment is needed here any more.
  const slotRows = (root: HTMLElement): HTMLElement[] =>
    Array.from(root.querySelectorAll('.hud-versus-slot-row'));
  const roleBtn = (root: HTMLElement, slot: number, role: string): HTMLButtonElement =>
    root.querySelector(
      `.hud-versus-slot-row[data-slot="${slot}"] .hud-versus-role-btn[data-role="${role}"]`,
    ) as HTMLButtonElement;
  const slotDevice = (root: HTMLElement, slot: number): HTMLElement =>
    root.querySelector(`.hud-versus-slot-row[data-slot="${slot}"] .hud-versus-slot-device`) as HTMLElement;
  const slotReason = (root: HTMLElement, slot: number): HTMLElement =>
    root.querySelector(`.hud-versus-slot-row[data-slot="${slot}"] .hud-versus-slot-reason`) as HTMLElement;

  it('the Versus button is a bare click passthrough: it does NOT open the pane itself, and fires onVersusOpen once per click', () => {
    // Kills the mutation "the button calls showVersusSetup directly" -- see
    // onVersusOpen's own doc comment on the Hud interface for why that would be
    // wrong: only the caller (loop.ts) knows which VersusConfig to retain across a
    // rematch, so the button cannot decide to open the pane on its own.
    const { hud: h, root } = mount();
    h.setState('main-menu');
    let opens = 0;
    h.onVersusOpen(() => {
      opens += 1;
    });
    openBtn(root).dispatchEvent(new MouseEvent('click'));
    expect(opens, 'onVersusOpen did not fire on click').toBe(1);
    expect(
      view(root).classList.contains('hud-versus-setup--hidden'),
      'clicking Versus opened the pane without any subscriber -- it must not',
    ).toBe(true);
    openBtn(root).dispatchEvent(new MouseEvent('click'));
    expect(opens, 'a second click did not fire the callback a second time').toBe(2);
  });

  it('is visible at title ONLY -- unlike Controllers, a live round has nothing this could offer', () => {
    // 'playing'/'splash' excluded from this per-button check, matching the
    // established convention (see 'hud: controller assignment panel's own
    // equivalent test): setState's early-return for playing/splash hides the whole
    // .hud-panel wrapper rather than toggling each button's own class, so the
    // button's OWN class is not the right oracle there.
    const { hud: h, root } = mount();
    h.setState('main-menu');
    expect(openBtn(root).classList.contains('hud-versus-open--hidden')).toBe(false);
    for (const s of ['paused', 'outcome-win', 'outcome-lose'] as const) {
      h.setState(s);
      expect(openBtn(root).classList.contains('hud-versus-open--hidden'), s).toBe(true);
    }
  });

  const teamBtns = (root: HTMLElement, slot: number): HTMLButtonElement[] =>
    Array.from(
      (root.querySelectorAll('.hud-versus-slot-rows > *')[slot]?.querySelectorAll('.hud-versus-team-btn') ?? []) as NodeListOf<HTMLButtonElement>,
    );

  it('does not offer Teams at two players, and does at three (issue #281)', () => {
    // The issue's first binding rule. `.click()` rather than `dispatchEvent`, deliberately:
    // a disabled button ignores a real click and honours a dispatched one, so only the
    // former measures what a player can actually do.
    const { hud: h, root } = mount();
    h.setState('main-menu');
    h.showVersusSetup(true);
    expect(modeBtn(root, 'teams').disabled, 'Teams is offered at two players').toBe(true);
    expect(modeBtn(root, 'ffa').disabled, 'FFA was refused too').toBe(false);
    modeBtn(root, 'teams').click();
    expect(teamBtns(root, 0), 'a refused Teams click still built the team controls').toHaveLength(0);

    playersBtn(root, 3).click();
    expect(modeBtn(root, 'teams').disabled, 'Teams still refused at three players').toBe(false);
  });

  it('drops out of Teams when the player count falls to two', () => {
    // The state a disabled button alone cannot prevent: pick Teams at three, then go back
    // to two. Leaving the mode set would leave the pane in a mode it no longer offers, and
    // the Start gate refusing a match the player cannot see how to fix.
    const { hud: h, root } = mount();
    h.setState('main-menu');
    h.showVersusSetup(true);
    playersBtn(root, 3).click();
    modeBtn(root, 'teams').click();
    expect(teamBtns(root, 0).length).toBeGreaterThan(0);

    playersBtn(root, 2).click();
    expect(modeBtn(root, 'teams').disabled).toBe(true);
    expect(teamBtns(root, 0), 'the team controls survived the drop to two players').toHaveLength(0);
    // ...and friendly fire, which is Teams-only, went with it.
    expect(friendlyFireBtn(root)).toBeNull();
  });

  it('offers a team per slot under Teams, and none under FFA', () => {
    const { hud: h, root } = mount();
    h.setState('main-menu');
    h.showVersusSetup(true);
    playersBtn(root, 3).click();
    expect(teamBtns(root, 0), 'FFA offered team controls').toHaveLength(0);
    modeBtn(root, 'teams').click();
    for (const slot of [0, 1, 2]) expect(teamBtns(root, slot)).toHaveLength(3);
    // The letters are the non-colour reinforcement the issue asks for, so they are pinned
    // as CONTENT rather than left to the swatch's hue.
    expect(teamBtns(root, 0).map((b) => b.textContent)).toEqual(['A', 'B', 'C']);
  });

  it('shows the EFFECTIVE team on an untouched slot, not an empty selection', () => {
    // An untouched slot has `team === undefined` and falls back to `teamOf(slot)`, which is
    // exactly what `loadArena` stamps. Showing nothing chosen would read as a decision the
    // player still had to make, in a pane whose Start button is already enabled.
    const { hud: h, root } = mount();
    h.setState('main-menu');
    h.showVersusSetup(true);
    playersBtn(root, 3).click();
    modeBtn(root, 'teams').click();
    const chosen = (slot: number): string[] =>
      teamBtns(root, slot).filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.textContent ?? '');
    // teamOf alternates, so slots 0/1/2 start on A/B/A.
    expect(chosen(0)).toEqual(['A']);
    expect(chosen(1)).toEqual(['B']);
    expect(chosen(2)).toEqual(['A']);
  });

  it('keeps a chosen team across a round trip through FFA', () => {
    // The issue's "switching modes does not corrupt retained team choices". The controls
    // are absent in FFA, so the only way this can hold is by the CHOICE surviving in the
    // descriptor while its control does not exist -- which is why `team` is carried
    // unconditionally rather than only under Teams.
    const { hud: h, root } = mount();
    h.setState('main-menu');
    h.showVersusSetup(true);
    playersBtn(root, 3).click();
    modeBtn(root, 'teams').click();
    teamBtns(root, 1)[2].click(); // put slot 1 on team C, which teamOf would never pick
    const chosenC = (): boolean =>
      teamBtns(root, 1)[2]?.getAttribute('aria-pressed') === 'true';
    expect(chosenC()).toBe(true);

    modeBtn(root, 'ffa').click();
    expect(teamBtns(root, 1), 'FFA kept the team controls on screen').toHaveLength(0);
    modeBtn(root, 'teams').click();
    expect(chosenC(), 'the round trip through FFA lost the chosen team').toBe(true);
  });

  it("Start fires onVersusStart with exactly the selections made, not the pane's defaults", () => {
    // Kills the mutation "emit versusConfigState's INITIAL value" / "emit a
    // hardcoded default object" -- every field below is changed from its default
    // before Start is clicked.
    const { hud: h, root } = mount();
    h.setState('main-menu');
    h.showVersusSetup(true);
    modeBtn(root, 'teams').dispatchEvent(new MouseEvent('click'));
    playersBtn(root, 3).dispatchEvent(new MouseEvent('click'));
    const choices = versusMapChoices(3, 'teams');
    mapBtn(root, choices[1]).dispatchEvent(new MouseEvent('click')); // the SECOND map entry
    stockBtn(root, 5).dispatchEvent(new MouseEvent('click'));
    (friendlyFireBtn(root) as HTMLButtonElement).dispatchEvent(new MouseEvent('click')); // off -> on

    const seen: VersusConfig[] = [];
    h.onVersusStart((config) => seen.push(config));
    startBtn(root).dispatchEvent(new MouseEvent('click'));
    expect(seen).toEqual([
      { mode: 'teams', players: 3, arenaId: choices[1], stock: 5, friendlyFire: true, slots: defaultSlots(3) },
    ]);
  });

  // ---------------------------------------------------------------------------
  // A retained map choice that the NEW (players, mode) does not support.
  //
  // Three shipped entries are narrower than {2,3,4} x both modes -- vs-duel-01 at two
  // players, vs-tri-01 at three, vs-quad-01 at four (issues #271-#273) -- so a choice
  // made at one combination can stop being offered at the next. The pane's Players and
  // Mode handlers follow every OTHER dependent field when that happens (`slots` is
  // resized, `mode` falls back to ffa where Teams is unofferable, each with a comment
  // saying why) and left `arenaId` alone, which three doc comments across two files
  // asserted was safe because no entry was narrow enough to reach it. That stopped being
  // true when #271-#273 shipped.
  //
  // The consequence is not a wrong board: `resolveVersusConfig` is the launch gate and
  // THROWS on an unsupported combination rather than launching one. Nothing catches it,
  // so the exception escapes the Start click handler and the button silently does
  // nothing. Issue #274's criterion 4 is the fix -- replace the invalid choice with an
  // obvious valid default and say why.
  // ---------------------------------------------------------------------------

  it('replaces a retained map the new player count does not support, and says why (issue #274)', () => {
    const { hud: h, root } = mount();
    h.setState('main-menu');
    h.showVersusSetup(true);

    // vs-duel-01 is the durable fixture for this, deliberately. It is offered at TWO
    // players and structurally cannot widen -- a dedicated duel board -- whereas
    // vs-tri-01 reaches the same bug only while a CURATION ruling holds it narrow, and
    // issue #627 has already moved that ruling once. A control anchored to a shipped
    // board that a ruling can widen deletes itself the day the ruling changes.
    expect(versusMapChoices(2, 'ffa'), 'the fixture board is offered at two').toContain('vs-duel-01');
    expect(versusMapChoices(3, 'ffa'), 'and not at three').not.toContain('vs-duel-01');

    mapBtn(root, 'vs-duel-01').dispatchEvent(new MouseEvent('click'));
    playersBtn(root, 3).dispatchEvent(new MouseEvent('click'));

    // The row rebuilt without it, which the pane already did. What it did NOT do is stop
    // carrying it: the assertion below is on what Start EMITS, not on what is drawn.
    expect(mapBtn(root, 'vs-duel-01'), 'the stale choice left the row').toBeNull();

    // NAMED, not just replaced. A silent swap is its own defect -- the player chose a
    // board and would launch a different one with nothing said -- so the notice is asserted
    // on content rather than on presence: it names the board that went, the axis that took
    // it, and what is selected instead.
    // The NAME, read from the catalog rather than typed here: `vs-duel-01` displays as
    // "Pinwheel", and a test that hardcodes a display name pins the wrong thing -- the
    // contract is that the notice says what the button said, whatever that is.
    const note = mapNote(root);
    const dropped = versusCatalogEntryById('vs-duel-01').displayName;
    expect(note.textContent, 'the notice names the dropped board').toContain(dropped);
    expect(note.textContent, 'and the axis that dropped it').toContain('3 players');
    expect(note.textContent, 'and what replaced it').toContain('Random');
    expect(note.classList.contains('hud-versus-map-note--hidden'), 'and is shown').toBe(false);

    const seen: VersusConfig[] = [];
    h.onVersusStart((config) => seen.push(config));
    startBtn(root).dispatchEvent(new MouseEvent('click'));
    expect(seen).toHaveLength(1);
    expect(seen[0].arenaId, 'Random is the fallback the storage path already uses').toBe('random');

    // The real failure, asserted through the real gate rather than restated: this is the
    // call loop.ts makes at the Start boundary (`applyVersusToDeps`), and on the stale
    // config it threw `map 'vs-duel-01' does not support N=3 mode=ffa`.
    expect(
      () => resolveVersusConfig(seen[0], 0),
      'the emitted config survives the launch gate',
    ).not.toThrow();
  });

  it('clears the dropped-map notice once the player has chosen again (issue #274)', () => {
    // The note describes a state the next click ends. Left up, it reads as a live warning
    // about the choice now selected -- which is the opposite of what it says.
    const { hud: h, root } = mount();
    h.setState('main-menu');
    h.showVersusSetup(true);
    mapBtn(root, 'vs-duel-01').dispatchEvent(new MouseEvent('click'));
    playersBtn(root, 3).dispatchEvent(new MouseEvent('click'));
    expect(mapNote(root).textContent, 'precondition: the notice is up').not.toBe('');

    mapBtn(root, versusMapChoices(3, 'ffa')[0]).dispatchEvent(new MouseEvent('click'));
    expect(mapNote(root).textContent, 'a fresh choice clears it').toBe('');
    expect(mapNote(root).classList.contains('hud-versus-map-note--hidden')).toBe(true);
  });

  it('does not announce a drop when the retained map survives the change (issue #274)', () => {
    // The negative control. Without it every assertion above passes on a pane that shows
    // the notice unconditionally, which would be a worse bug than the one being fixed.
    const { hud: h, root } = mount();
    h.setState('main-menu');
    h.showVersusSetup(true);
    const everywhere = 'arena-01';
    expect(versusMapChoices(2, 'ffa')).toContain(everywhere);
    expect(versusMapChoices(4, 'ffa')).toContain(everywhere);

    mapBtn(root, everywhere).dispatchEvent(new MouseEvent('click'));
    playersBtn(root, 4).dispatchEvent(new MouseEvent('click'));
    expect(mapNote(root).textContent, 'a surviving choice says nothing').toBe('');
    expect(mapBtn(root, everywhere).getAttribute('aria-pressed'), 'and stays selected').toBe('true');
  });

  it('replaces a retained map the new MODE does not support (issue #274)', () => {
    // The same defect through the other axis. Which board is narrow by MODE is a curation
    // ruling rather than a structural fact, so this case is driven from the catalog
    // instead of naming one: it finds whatever entry the current data narrows and skips
    // if none does, which is honest about the coverage rather than pinning a board that
    // a ruling can widen out from under it. (Issue #627 widened the last one, so this
    // currently skips -- the branch it guards is exercised by the player-count case
    // above and by the unit tests on the clamp itself.)
    const { hud: h, root } = mount();
    h.setState('main-menu');
    h.showVersusSetup(true);
    const ffaOnlyAtThree = versusMapChoices(3, 'ffa')
      .filter((id) => !versusMapChoices(3, 'teams').includes(id));
    if (ffaOnlyAtThree.length === 0) return;

    playersBtn(root, 3).dispatchEvent(new MouseEvent('click'));
    mapBtn(root, ffaOnlyAtThree[0]).dispatchEvent(new MouseEvent('click'));
    modeBtn(root, 'teams').dispatchEvent(new MouseEvent('click'));

    const seen: VersusConfig[] = [];
    h.onVersusStart((config) => seen.push(config));
    startBtn(root).dispatchEvent(new MouseEvent('click'));
    expect(() => resolveVersusConfig(seen[0], 0)).not.toThrow();
  });

  // ---------------------------------------------------------------------------
  // Issue #983: a campaign board is offered only once its campaign level is cleared. Each case
  // hands the HUD a mutable save, `cleared` levels deep, through the same getter
  // `createBrowserDeps` binds to the progress store.
  // ---------------------------------------------------------------------------

  it('shows only the boards this save has unlocked, re-read on every open (issue #983)', () => {
    let cleared = 2;
    const { hud: h, root } = mount({ versusUnlock: () => campaignBoardUnlock(cleared) });
    h.setState('main-menu');
    h.showVersusSetup(true);
    const maps = (): string[] => mapButtons(root).map((b) => b.dataset.map as string);
    // Two players, FFA, levels 1 and 2 cleared: their two boards, the three dedicated
    // two-player boards, and Random -- 6 cards, where every declared board would be 9.
    expect(maps()).toEqual(['arena-01', 'arena-02', 'vs-duel-01', 'vs-tri-01', 'vs-quad-01', 'random']);
    // Random counts the row it sits in, so it never claims a board the row hides.
    expect(mapBtn(root, 'random').querySelector('.hud-versus-map-config')?.textContent).toBe('5 eligible boards');

    // Level 3 cleared while the page lives: Arena 3 is on the next open, read live rather than
    // fixed when the HUD was built.
    cleared = 3;
    h.showVersusSetup(false);
    h.showVersusSetup(true);
    expect(maps()).toEqual(['arena-01', 'arena-02', 'arena-03', 'vs-duel-01', 'vs-tri-01', 'vs-quad-01', 'random']);
  });

  it('drops a selected board that a progress reset locked, on the next open, seeded or not (issue #983)', () => {
    // The pane's own selection and the retained config a finished match reopens it with
    // (route-ui.ts) both outlive a reset. What Start EMITS is asserted, because a stale id
    // with no card looks right in the row and only fails at the launch gate.
    let cleared = 3;
    const { hud: h, root } = mount({ versusUnlock: () => campaignBoardUnlock(cleared) });
    h.setState('main-menu');
    h.showVersusSetup(true);
    const seen: VersusConfig[] = [];
    h.onVersusStart((config) => seen.push(config));
    mapBtn(root, 'arena-03').dispatchEvent(new MouseEvent('click'));
    startBtn(root).dispatchEvent(new MouseEvent('click'));
    expect(seen.at(-1)?.arenaId, 'the negative control: kept while level 3 is cleared').toBe('arena-03');
    const retained = seen.at(-1) as VersusConfig;

    cleared = 0;
    h.showVersusSetup(false);
    h.showVersusSetup(true);
    startBtn(root).dispatchEvent(new MouseEvent('click'));
    expect(seen.at(-1)?.arenaId, 'reopened with no seed').toBe('random');
    expect(mapBtn(root, 'random').getAttribute('aria-pressed'), 'and Random is what is selected').toBe('true');
    expect(mapNote(root).textContent, 'silently: the player moved no control').toBe('');

    h.showVersusSetup(false);
    h.showVersusSetup(true, retained);
    startBtn(root).dispatchEvent(new MouseEvent('click'));
    expect(seen.at(-1)?.arenaId, 'reopened seeded with the retained Arena 3').toBe('random');
    expect(
      () => resolveVersusConfig(seen.at(-1) as VersusConfig, 0, VERSUS_CATALOG, campaignBoardUnlock(0)),
      'the emitted config survives the launch gate on the reset save',
    ).not.toThrow();
  });

  it('an axis change drops a held board the save no longer unlocks, and says only that it is gone (issue #983)', () => {
    // Nothing in the shipped page changes progress while the pane is open -- Reset progress is
    // in Settings, which replaces the pane, and the open re-check above catches it. This pins
    // that Players and Mode re-check the map against the SAME unlock the row they rebuild
    // reads, so the two cannot disagree about one board, and pins the sentence a locked board
    // gets: no axis named, because no axis can bring it back.
    let cleared = 3;
    const { hud: h, root } = mount({ versusUnlock: () => campaignBoardUnlock(cleared) });
    h.setState('main-menu');
    h.showVersusSetup(true);
    mapBtn(root, 'arena-03').dispatchEvent(new MouseEvent('click'));
    cleared = 0;
    playersBtn(root, 3).dispatchEvent(new MouseEvent('click'));

    const name = versusCatalogEntryById('arena-03').displayName;
    expect(mapNote(root).textContent).toBe(`${name} is no longer available. Random selected.`);
    const seen: VersusConfig[] = [];
    h.onVersusStart((config) => seen.push(config));
    startBtn(root).dispatchEvent(new MouseEvent('click'));
    expect(seen[0].arenaId).toBe('random');
  });

  it('stock defaults to VERSUS_STOCK, the same constant the sim boundary uses (constants.ts)', () => {
    const { hud: h, root } = mount();
    h.setState('main-menu');
    h.showVersusSetup(true);
    expect(stockBtn(root, VERSUS_STOCK).classList.contains('ui-selectable--on')).toBe(true);
  });

  it('friendly fire is GENUINELY ABSENT from the DOM under FFA, present under Teams', () => {
    // The spec's own wording (§3): "rendered only when Teams selected". Absent, not
    // merely hidden -- kills the mutation "hide it with a CSS class instead of not
    // building it", which a `.hud-versus-friendlyfire-row--hidden`-class check could
    // not tell apart from a genuinely broken hidden rule (see hud.css.test.ts's own
    // `.hud-accents` precedent for exactly that failure mode).
    const { hud: h, root } = mount();
    h.setState('main-menu');
    h.showVersusSetup(true);
    expect(friendlyFireBtn(root), 'present under the FFA default').toBeNull();
    modeBtn(root, 'teams').dispatchEvent(new MouseEvent('click'));
    expect(friendlyFireBtn(root), 'absent after switching to Teams').not.toBeNull();
    modeBtn(root, 'ffa').dispatchEvent(new MouseEvent('click'));
    expect(friendlyFireBtn(root), 'still present after switching back to FFA').toBeNull();
  });

  it('does not reset friendlyFire when leaving Teams -- Teams -> FFA -> Teams keeps the toggle', () => {
    // Kills the mutation "zero friendlyFire on switching to FFA": versus-config.ts's
    // own doc comment states loadArena/createWorld already ignore it outside
    // 'teams', so carrying it unconditionally is harmless -- resetting it here would
    // be an active regression against ruling 4's "selections persist" contract.
    const { hud: h, root } = mount();
    h.setState('main-menu');
    h.showVersusSetup(true);
    modeBtn(root, 'teams').dispatchEvent(new MouseEvent('click'));
    (friendlyFireBtn(root) as HTMLButtonElement).dispatchEvent(new MouseEvent('click')); // off -> on
    modeBtn(root, 'ffa').dispatchEvent(new MouseEvent('click'));
    modeBtn(root, 'teams').dispatchEvent(new MouseEvent('click'));
    expect((friendlyFireBtn(root) as HTMLButtonElement).textContent).toBe('Friendly fire: On');
  });

  it('Players change REPLACES the Map row rather than appending to it, across two successive re-renders', () => {
    // All 15 shipped (arena, playerCount) rows pass `suitable` today (measured via
    // versusBoardCatalog(), see versus-config.ts's own doc comment), so 2/3/4
    // players all offer the SAME five arenas -- which is exactly why row COUNT,
    // not arena identity, is what proves REPLACE here: an APPEND mutation would
    // grow the row count on every click below rather than holding steady.
    const { hud: h, root } = mount();
    h.setState('main-menu');
    h.showVersusSetup(true);
    expect(mapButtons(root)).toHaveLength(versusMapChoices(2, 'ffa').length + 1); // + Random
    playersBtn(root, 3).dispatchEvent(new MouseEvent('click'));
    expect(mapButtons(root)).toHaveLength(versusMapChoices(3, 'ffa').length + 1);
    playersBtn(root, 4).dispatchEvent(new MouseEvent('click'));
    expect(mapButtons(root)).toHaveLength(versusMapChoices(4, 'ffa').length + 1);
  });

  it('showVersusSetup(true, initial) pre-fills every field', () => {
    const { hud: h, root } = mount();
    h.setState('main-menu');
    const initial: VersusConfig = {
      mode: 'teams',
      players: 4,
      arenaId: versusMapChoices(4, 'teams')[2],
      stock: 2,
      friendlyFire: true, slots: defaultSlots(4) };
    h.showVersusSetup(true, initial);
    expect(modeBtn(root, 'teams').classList.contains('ui-selectable--on')).toBe(true);
    expect(playersBtn(root, 4).classList.contains('ui-selectable--on')).toBe(true);
    expect(mapBtn(root, initial.arenaId).classList.contains('ui-selectable--on')).toBe(true);
    expect(stockBtn(root, 2).classList.contains('ui-selectable--on')).toBe(true);
    expect(friendlyFireBtn(root)).not.toBeNull();
    expect((friendlyFireBtn(root) as HTMLButtonElement).textContent).toBe('Friendly fire: On');
  });

  it("selections persist across a close (setState) and reopen with NO `initial` argument -- session-scoped state (ruling 4)", () => {
    // Kills the mutation "reset versusConfigState to defaults whenever the pane
    // closes or reopens".
    const { hud: h, root } = mount();
    h.setState('main-menu');
    h.showVersusSetup(true);
    modeBtn(root, 'teams').dispatchEvent(new MouseEvent('click'));
    stockBtn(root, 5).dispatchEvent(new MouseEvent('click'));
    h.setState('playing'); // setState's close-all discipline hides the pane
    h.setState('main-menu');
    h.showVersusSetup(true); // no `initial` argument at all
    expect(modeBtn(root, 'teams').classList.contains('ui-selectable--on')).toBe(true);
    expect(stockBtn(root, 5).classList.contains('ui-selectable--on')).toBe(true);
  });

  it("passing `null` -- Task 5's own `deps.initialVersusConfig ?? null` for \"nothing retained yet\" -- also keeps the pane's persisted selections, same as omitting the argument", () => {
    // Kills the mutation "seed from `initial ?? DEFAULTS`", which would silently
    // wipe a returning player's own selections on precisely this call -- the one
    // Task 5's own wiring line makes on every FIRST open of a session.
    const { hud: h, root } = mount();
    h.setState('main-menu');
    h.showVersusSetup(true);
    modeBtn(root, 'teams').dispatchEvent(new MouseEvent('click'));
    playersBtn(root, 4).dispatchEvent(new MouseEvent('click'));
    h.setState('playing');
    h.setState('main-menu');
    h.showVersusSetup(true, null);
    expect(modeBtn(root, 'teams').classList.contains('ui-selectable--on')).toBe(true);
    expect(playersBtn(root, 4).classList.contains('ui-selectable--on')).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Who's playing -- per-slot ROLE controls (issue #260).
  //
  // These four tests REPLACE four that pinned the previous ruling: that these rows
  // rendered the RUNNING session's `Assignment` and that clicking a candidate
  // reassigned that session through `onReassignSlot`, interactively when the pane's
  // player count matched the session's and as a disabled preview when it did not.
  // That is the divergence issue #260 exists to remove -- Start disposes the session
  // those clicks were editing, so what the pane showed was not what launched. The old
  // tests are deleted rather than skipped: they asserted the superseded behaviour
  // directly, so there is nothing in them left to be true.
  // ---------------------------------------------------------------------------

  it('offers a role control per slot, and a click writes that slot -- Start carries the roles it displayed', () => {
    // The issue's "Start initializes the session from the exact displayed assignments".
    // Kills the mutation "the role button re-renders without calling setVersusConfig":
    // the pane would LOOK right and Start would still emit the old slots.
    const { hud: h, root } = mount();
    h.setState('main-menu');
    h.showVersusSetup(true);
    expect(slotRows(root), 'one row per slot at the default player count').toHaveLength(2);

    let started: VersusConfig | null = null;
    h.onVersusStart((c) => {
      started = c;
    });
    // Slot 1 defaults to Bot (defaultSlots); make it a second Human and start.
    roleBtn(root, 1, 'human').dispatchEvent(new MouseEvent('click'));
    expect(roleBtn(root, 1, 'human').classList.contains('ui-selectable--on')).toBe(true);
    startBtn(root).dispatchEvent(new MouseEvent('click'));
    expect(started, 'Start fired').not.toBeNull();
    expect((started as unknown as VersusConfig).slots).toEqual([
      { role: 'human' },
      { role: 'human' },
    ]);
  });

  it('derives the device column from the live pads rather than storing one, and never honours a stale index', () => {
    // The issue's one purely NEGATIVE criterion. Slot 1 is Human and one pad is
    // connected, so it resolves to that pad; unplug it and the SAME stored role
    // resolves to Unassigned rather than to some other physical controller.
    //
    // Negative control: if `resolveSources` were replaced by a stored per-slot device,
    // the second assertion would still read "Pad Seven (index 3)" after the unplug.
    const { hud: h, root } = mount();
    h.setDetectedPads([{ padIndex: 3, id: 'Pad Seven' }]);
    h.setState('main-menu');
    h.showVersusSetup(true);
    roleBtn(root, 1, 'human').dispatchEvent(new MouseEvent('click'));
    expect(slotDevice(root, 0).textContent).toBe('Keyboard / Mouse / Touch');
    expect(slotDevice(root, 1).textContent).toBe('Pad Seven (index 3)');

    h.setDetectedPads([]); // unplugged WHILE the pane is open
    expect(
      slotDevice(root, 1).textContent,
      'a human slot with no free device must read Unassigned, not a remembered pad',
    ).toBe('Unassigned');
  });

  it('skips a pad Tanks cannot read in the device column and the Start gate (issue #713)', () => {
    // The Controllers pane marks such a pad "not supported" (#597); this pane must not bind
    // a slot to it and then accept Start. Negative control: resolving against the raw pad
    // list shows "HuiJia USB GamePad (index 0)" for slot 1 and leaves Start enabled in the
    // second half.
    const unreadable = {
      padIndex: 0,
      id: 'HuiJia USB GamePad',
      unsupported: { code: 'unknown-mapping' as const, mapping: '', id: 'HuiJia USB GamePad' },
    };
    const { hud: h, root } = mount();
    h.setDetectedPads([unreadable, { padIndex: 1, id: 'Pad One' }]);
    h.setState('main-menu');
    h.showVersusSetup(true);
    roleBtn(root, 1, 'human').dispatchEvent(new MouseEvent('click'));
    expect(slotDevice(root, 1).textContent, 'the next readable pad, not the first detected').toBe('Pad One (index 1)');
    expect(startBtn(root).disabled).toBe(false);

    h.setDetectedPads([unreadable]); // the readable pad unplugged; only the unreadable one left
    expect(slotDevice(root, 1).textContent).toBe('Unassigned');
    expect(startBtn(root).disabled, 'an unreadable pad is not a device for Start').toBe(true);
    expect(slotReason(root, 1).textContent).toBe(
      'Player 2 is Human but no device is free. Connect a controller, or choose Bot.',
    );
  });

  it('refuses Start with an actionable, ASSOCIATED reason -- and only the first offending card carries one', () => {
    // "Never accept Start with an inert required slot", plus the deliberate
    // first-problem-only choice `versusSetupProblem` makes: two simultaneous refusals
    // would give a player two sentences and no order to fix them in.
    const { hud: h, root } = mount();
    h.setState('main-menu');
    h.showVersusSetup(true);
    playersBtn(root, 3).dispatchEvent(new MouseEvent('click'));
    expect(startBtn(root).disabled, 'the default 3-player setup is startable').toBe(false);

    // Turn slots 1 AND 2 off: two `unassigned` problems at once.
    roleBtn(root, 1, 'none').dispatchEvent(new MouseEvent('click'));
    roleBtn(root, 2, 'none').dispatchEvent(new MouseEvent('click'));
    expect(startBtn(root).disabled, 'an Off slot must refuse Start').toBe(true);
    expect(slotReason(root, 1).textContent).toBe('Player 2 is off. Choose Human or Bot to start.');
    expect(slotReason(root, 1).classList.contains('hud-versus-slot-reason--hidden')).toBe(false);
    expect(
      slotReason(root, 2).textContent,
      'the SECOND offending card stays silent -- one actionable fix at a time',
    ).toBe('');
    // Associated, not merely on screen (#321's rule).
    expect(startBtn(root).getAttribute('aria-describedby')).toBe('hud-versus-slot-reason-1');

    // Fixing the first reveals the second, which is what makes one-at-a-time workable.
    roleBtn(root, 1, 'bot').dispatchEvent(new MouseEvent('click'));
    expect(slotReason(root, 2).textContent).toBe('Player 3 is off. Choose Human or Bot to start.');
    expect(startBtn(root).getAttribute('aria-describedby')).toBe('hud-versus-slot-reason-2');
    roleBtn(root, 2, 'bot').dispatchEvent(new MouseEvent('click'));
    expect(startBtn(root).disabled, 'both fixed -> startable again').toBe(false);
    expect(startBtn(root).getAttribute('aria-describedby'), 'the reason is withdrawn').toBeNull();
  });

  it('refuses an all-bot match at the PANE level, since no-human names no slot to hang a reason on', () => {
    const { hud: h, root } = mount();
    h.setState('main-menu');
    h.showVersusSetup(true);
    const paneReason = root.querySelector('.hud-versus-start-reason') as HTMLElement;
    expect(paneReason.classList.contains('hud-versus-start-reason--hidden')).toBe(true);

    roleBtn(root, 0, 'bot').dispatchEvent(new MouseEvent('click'));
    expect(startBtn(root).disabled).toBe(true);
    expect(paneReason.textContent).toBe('At least one slot must be Human.');
    expect(paneReason.classList.contains('hud-versus-start-reason--hidden')).toBe(false);
    expect(startBtn(root).getAttribute('aria-describedby')).toBe('hud-versus-start-reason');
    // No per-slot card claims it -- the problem belongs to the match, not a player.
    expect(slotReason(root, 0).textContent).toBe('');
    expect(slotReason(root, 1).textContent).toBe('');
  });

  it('a Human slot left without a device refuses Start with the device-missing reason, not the off one', () => {
    // The three refusal kinds are distinguished on purpose: a card that says only
    // "not ready" is not actionable, and the fix here (connect a pad, or choose Bot)
    // is different from the fix for an Off slot.
    const { hud: h, root } = mount();
    h.setState('main-menu');
    h.showVersusSetup(true);
    roleBtn(root, 1, 'human').dispatchEvent(new MouseEvent('click')); // no pads connected
    expect(startBtn(root).disabled).toBe(true);
    expect(slotReason(root, 1).textContent).toBe(
      'Player 2 is Human but no device is free. Connect a controller, or choose Bot.',
    );
    // ...and connecting one clears it, which is what proves the gate reads live pads.
    h.setDetectedPads([{ padIndex: 0, id: 'Pad One' }]);
    expect(startBtn(root).disabled).toBe(false);
    expect(slotReason(root, 1).textContent).toBe('');
  });

  it('keyboard-only first launch is playable by default: no refusal, and exactly one human', () => {
    // The issue's "first-time keyboard-only ... produce playable defaults". A default
    // of Human for slot 1 would hand a keyboard-only player a tank nothing can drive.
    const { hud: h, root } = mount(); // no setDetectedPads at all
    h.setState('main-menu');
    h.showVersusSetup(true);
    expect(startBtn(root).disabled, 'first launch must be startable with no controllers').toBe(false);
    expect(startBtn(root).getAttribute('aria-describedby')).toBeNull();
    expect(slotDevice(root, 0).textContent).toBe('Keyboard / Mouse / Touch');
    expect(slotDevice(root, 1).textContent).toBe('Bot');
  });

  it('returning from a match reopens the pane on the roles that match started with', () => {
    // The issue's "returning from gameplay preserves displayed role choices". The
    // return-to-setup path is `showVersusSetup(true, initial)` with loop.ts's retained
    // `initialVersusConfig` -- the UNRESOLVED config the session was started from.
    //
    // Driven end to end rather than asserted on `initial` alone: the seeding call is
    // `setVersusConfig`, so this also pins that a re-open RE-RENDERS the cards from the
    // seeded slots. Kills the mutation "seed the state but skip renderVersusSlotRows",
    // which would leave the previous match's cards on screen while Start emitted the
    // seeded ones -- the same display/launch divergence the issue is about, one level up.
    const { hud: h, root } = mount();
    h.setState('main-menu');
    h.showVersusSetup(true);
    playersBtn(root, 3).dispatchEvent(new MouseEvent('click'));
    roleBtn(root, 1, 'human').dispatchEvent(new MouseEvent('click'));

    let started: VersusConfig | null = null;
    h.onVersusStart((c) => {
      started = c;
    });
    startBtn(root).dispatchEvent(new MouseEvent('click'));
    const launched = started as unknown as VersusConfig;
    expect(launched.slots).toEqual([{ role: 'human' }, { role: 'human' }, { role: 'bot' }]);

    // ...the match runs, then the results screen returns to setup with what it launched.
    h.setState('playing');
    h.setState('main-menu');
    h.showVersusSetup(true, launched);
    expect(slotRows(root), 'the pane reopened at the match player count').toHaveLength(3);
    expect(roleBtn(root, 1, 'human').classList.contains('ui-selectable--on')).toBe(true);
    expect(roleBtn(root, 2, 'bot').classList.contains('ui-selectable--on')).toBe(true);
    // ...and a negative half: slot 1 is NOT still showing the default it started life at.
    expect(roleBtn(root, 1, 'bot').classList.contains('ui-selectable--on')).toBe(false);
  });

  it('Players change REPLACES the slot rows across two successive re-renders, and keeps the roles already chosen', () => {
    const { hud: h, root } = mount();
    h.setState('main-menu');
    h.showVersusSetup(true);
    expect(slotRows(root)).toHaveLength(2);
    roleBtn(root, 1, 'human').dispatchEvent(new MouseEvent('click'));
    playersBtn(root, 3).dispatchEvent(new MouseEvent('click'));
    expect(slotRows(root)).toHaveLength(3);
    expect(
      roleBtn(root, 1, 'human').classList.contains('ui-selectable--on'),
      "resizeSlots keeps slot 1's chosen role when the count grows",
    ).toBe(true);
    playersBtn(root, 4).dispatchEvent(new MouseEvent('click'));
    expect(slotRows(root)).toHaveLength(4);
  });

  it('Back hides the pane and returns to the surface it was opened OVER: paused when opened there, title from the title (issue #318)', () => {
    // Until issue #318 this Back hard-coded setState('main-menu'); the layer now records
    // the surface it was pushed over. Opened from 'paused' on purpose -- a real user
    // cannot today (the open button is hidden there), but that is exactly the shape
    // under which a Back that still hard-coded the title would show: starting from
    // 'title' leaves every title-only marker already correct before Back ever runs, so
    // a mutation back to setState('main-menu') survives that shape (measured when the
    // hard-code was the behaviour under test).
    vi.useFakeTimers();
    try {
      const { hud: h, root } = mount();
      h.setState('paused');
      h.showVersusSetup(true);
      backBtn(root).dispatchEvent(new MouseEvent('click'));
      vi.advanceTimersByTime(1000);
      expect(view(root).classList.contains('hud-versus-setup--hidden')).toBe(true);
      // Landed back on PAUSED: the pause panel's own Resume is showing and the
      // title-only Versus button is not.
      expect((root.querySelector('.hud-action') as HTMLButtonElement).textContent).toBe('Resume');
      expect(
        (root.querySelector('.hud-action') as HTMLButtonElement).classList.contains('hud-action--hidden'),
        'Back abandoned the paused round for the title',
      ).toBe(false);
      expect(openBtn(root).classList.contains('hud-versus-open--hidden')).toBe(true);

      // ...and from the title, the title: the other half of "the surface it was opened
      // over", so a Back that always re-rendered 'paused' would fail here.
      h.setState('main-menu');
      openBtn(root).dispatchEvent(new MouseEvent('click'));
      h.showVersusSetup(true);
      backBtn(root).dispatchEvent(new MouseEvent('click'));
      vi.advanceTimersByTime(1000);
      expect(view(root).classList.contains('hud-versus-setup--hidden')).toBe(true);
      expect(openBtn(root).classList.contains('hud-versus-open--hidden'), 'Back did not land back on the title menu').toBe(false);
      expect(
        (root.querySelector('.hud-action') as HTMLButtonElement).classList.contains('hud-action--hidden'),
        'the title shows Continue/New Game, never the action button',
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is closed unconditionally by ANY state change, same as every sibling subpanel', () => {
    const { hud: h, root } = mount();
    h.setState('main-menu');
    h.showVersusSetup(true);
    h.setState('playing');
    expect(view(root).classList.contains('hud-versus-setup--hidden')).toBe(true);
  });

  it('roving tabindex reaches Back, then Start -- the two controls the task brief names explicitly', () => {
    // ORDER REVERSED at issue #668, and the reversal is the point rather than a detail.
    // The two buttons used to be STACKED, Start above Back, and document order matched that
    // reading. They are now a pinned ROW at the foot of the pane, Back left and Start right,
    // so document order follows the new visual order -- done in the markup rather than with
    // a CSS order property precisely so this walk keeps matching what is on screen.
    //
    // jsdom reports zero-size rects, so spatial-focus.ts takes its documented degenerate
    // path and walks document order; that is why Down steps between two controls a real
    // browser lays side by side and walks with Left/Right. The ORDER is what this pins, and
    // it is the same order either way.
    const { hud: h, root } = mount();
    h.setState('main-menu');
    h.showVersusSetup(true);
    // Start is the pane's primary action, so the arrival lands on it (issue #919) and the walk
    // below starts there, wraps, and must still come round to Back and then Start again.
    expect(document.activeElement, 'opening the pane did not focus Start, its primary action').toBe(
      startBtn(root),
    );
    let steps = 0;
    while (document.activeElement !== backBtn(root) && steps < 40) {
      (document.activeElement as HTMLElement).dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
      );
      steps += 1;
    }
    expect(document.activeElement, 'never reached Back').toBe(backBtn(root));
    (document.activeElement as HTMLElement).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
    );
    expect(document.activeElement, 'the step after Back did not reach Start').toBe(startBtn(root));
    // A RAISED BUDGET, for the reason the issue #115 title-screen walk has one: 0.45s in CI
    // before jsdom 30.1.2 and 4.0s after, because every ArrowDown re-derives the pane's
    // controls after jsdom empties its computed-style cache on the previous focus move.
  }, 20_000);
});

describe('hud: the versus action bar and its arm (issue #668)', () => {
  // Local copies: the pane selectors live in the sibling describe above, which mounts through
  // its own helper. These three are the same three selectors.
  const view = (root: HTMLElement): HTMLElement =>
    root.querySelector('.hud-versus-setup') as HTMLElement;
  const backBtn = (root: HTMLElement): HTMLButtonElement =>
    root.querySelector('.hud-versus-back') as HTMLButtonElement;
  const startBtn = (root: HTMLElement): HTMLButtonElement =>
    root.querySelector('.hud-versus-start') as HTMLButtonElement;

  /** The pane, with the action-bar arm chosen -- `createHud`'s own option, as loop.ts binds it. */
  function mountArm(versusActions: 'header' | null): HTMLElement {
    const root = document.createElement('div');
    document.body.appendChild(root);
    hud = createHud(root, { versusActions });
    hud.setState('main-menu');
    hud.showVersusSetup(true);
    return root;
  }

  it('keeps Start and Back together in the pinned bar by default', () => {
    // The shipped layout is the ABSENCE of a value. Asserted structurally rather than by
    // geometry because jsdom has no layout: what makes the bar a bar is that both controls
    // are inside the one sticky wrapper, which is what the stylesheet pins.
    const root = mountArm(null);
    const bar = root.querySelector('.hud-versus-actions')!;
    expect(bar, 'no action bar at all').not.toBeNull();
    expect(bar.contains(startBtn(root))).toBe(true);
    expect(bar.contains(backBtn(root))).toBe(true);
    expect(root.querySelector('.hud-versus-header'), 'built a header without being asked').toBeNull();
    expect(view(root).classList.contains('hud-versus-setup--header')).toBe(false);
  });

  it('carries the refusal INTO the bar, with the button it explains', () => {
    // The defect pinning introduces, and the reason the reason moved. Left in the
    // who's-playing row it scrolls away from a Start that no longer does, so the player
    // meets a dead control whose explanation is a screen and a half up the pane.
    const root = mountArm(null);
    const reason = root.querySelector('.hud-versus-start-reason')!;
    expect(root.querySelector('.hud-versus-actions')!.contains(reason)).toBe(true);
    // Its id is intact, which is what the refusal path binds Start to: `describeDisabledReason`
    // sets `aria-describedby` only WHILE there is a refusal, so this asserts the association
    // is still wireable rather than that it is currently wired -- moving the element must not
    // have broken the id that association travels on.
    expect(reason.id).toBe('hud-versus-start-reason');
    // Hidden until there is something to say, so the bar is 83px at rest and grows only when
    // refused.
    expect(reason.classList.contains('hud-versus-start-reason--hidden')).toBe(true);
  });

  it('reads Back before Start, matching how the row is laid out', () => {
    // DOM order is the accessible reading order, and the bar renders Back left / Start right.
    // Pinned as a DOCUMENT question so a later CSS `order` cannot silently divorce the two.
    const root = mountArm(null);
    const controls = Array.from(root.querySelectorAll('.hud-versus-actions button'));
    expect(controls).toEqual([backBtn(root), startBtn(root)]);
  });

  it('the arm lifts Back and the title into a header, leaving Start at the foot', () => {
    const root = mountArm('header');
    const header = root.querySelector('.hud-versus-header')!;
    expect(header, 'the arm built no header').not.toBeNull();
    expect(header.contains(backBtn(root)), 'Back stayed at the foot').toBe(true);
    expect(header.querySelector('h1'), 'the title did not come with it').not.toBeNull();
    // Start does NOT follow it up: the whole point of the arm is that the two separate.
    expect(root.querySelector('.hud-versus-actions')!.contains(startBtn(root))).toBe(true);
    expect(header.contains(startBtn(root))).toBe(false);
    expect(view(root).classList.contains('hud-versus-setup--header')).toBe(true);
  });

  it('the arm puts Back FIRST in the document, where it now sits on screen', () => {
    // Moving a control visually has to move it in the reading order too. In this arm Back is
    // the first thing on the pane, so it must be the first thing reached.
    const root = mountArm('header');
    const controls = Array.from(view(root).querySelectorAll('button'));
    expect(controls[0], 'Back is not the first control in the pane').toBe(backBtn(root));
  });

  it('both layouts expose the same controls -- the arm moves them, it does not add or drop any', () => {
    // The property that makes this safe to flip at runtime: an arm that quietly lost Back,
    // or grew a second one by cloning rather than moving, would pass every assertion above.
    const names = (root: HTMLElement) =>
      Array.from(view(root).querySelectorAll('button'))
        .map((b) => b.className).sort();
    const shipped = names(mountArm(null));
    document.body.innerHTML = '';
    hud?.dispose();
    const armed = names(mountArm('header'));
    expect(armed).toEqual(shipped);
  });
});

describe('hud: the versus pane reads and writes the RETAINED setup (issue #260)', () => {
  // A REAL `createVersusSetupStore` over a real `createMemoryStorage`, not a fake.
  // A hand-rolled stub would give this file's assertions nothing to say about the
  // module that actually has to survive a reload -- and the store's own sanitize-on-
  // write is part of the behaviour under test, since the pane hands it a whole config.
  function mountWithStore(storage: Storage): { hud: Hud; root: HTMLElement } {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const h = createHud(root, { versusSetup: createVersusSetupStore(storage) });
    return { hud: h, root };
  }

  const roleBtn = (root: HTMLElement, slot: number, role: string): HTMLButtonElement =>
    root.querySelector(
      `.hud-versus-slot-row[data-slot="${slot}"] .hud-versus-role-btn[data-role="${role}"]`,
    ) as HTMLButtonElement;
  const open = (h: Hud): void => {
    h.setState('main-menu');
    h.showVersusSetup(true);
  };

  it('persists a role choice to the RAW key, so a second HUD on the same storage opens with it', () => {
    // The reload criterion, and the reason it is asserted through a SECOND HUD rather
    // than by reading the first one back: a pane that only updated its own closure
    // state would pass any single-instance assertion and still forget on reload.
    //
    // Negative control: drop the `opts.versusSetup?.set(...)` line from
    // `setVersusConfig` and the second HUD opens on the default Bot for slot 1.
    const storage = createMemoryStorage();
    const first = mountWithStore(storage);
    open(first.hud);
    roleBtn(first.root, 1, 'human').dispatchEvent(new MouseEvent('click'));
    first.hud.dispose();

    expect(storage.getItem(VERSUS_SETUP_KEY), 'nothing reached the raw key').not.toBeNull();
    const second = mountWithStore(storage);
    open(second.hud);
    expect(
      roleBtn(second.root, 1, 'human').classList.contains('ui-selectable--on'),
      'the retained role did not survive into a fresh HUD',
    ).toBe(true);
    second.hud.dispose();
    document.body.innerHTML = '';
  });

  it('persists the match rules too, not only the slots -- every write goes through one funnel', () => {
    // Kills the mutation "persist only in the role-button handler": mode, players,
    // stock, map and friendly fire each have their own call site, and a per-site
    // `store.set` is exactly the thing that gets forgotten at the next one added.
    const storage = createMemoryStorage();
    const first = mountWithStore(storage);
    open(first.hud);
    (first.root.querySelector('.hud-versus-mode-row [data-mode="teams"]') as HTMLButtonElement)
      .dispatchEvent(new MouseEvent('click'));
    (first.root.querySelector('.hud-versus-players-row [data-players="4"]') as HTMLButtonElement)
      .dispatchEvent(new MouseEvent('click'));
    (first.root.querySelector('.hud-versus-stock-row [data-stock="5"]') as HTMLButtonElement)
      .dispatchEvent(new MouseEvent('click'));
    first.hud.dispose();

    const stored = JSON.parse(storage.getItem(VERSUS_SETUP_KEY) as string);
    expect(stored.mode).toBe('teams');
    expect(stored.players).toBe(4);
    expect(stored.stock).toBe(5);
    expect(stored.slots, 'slots follow the player count into storage').toHaveLength(4);
    document.body.innerHTML = '';
  });

  it('never writes a device to storage -- only the role pattern survives', () => {
    // The stored shape is what makes "survives reload" and "never silently binds a
    // different physical controller" both true at once. A pad index in here would
    // break the second the moment anyone read it back.
    const storage = createMemoryStorage();
    const { hud: h, root } = mountWithStore(storage);
    h.setDetectedPads([{ padIndex: 2, id: 'Pad Three' }]);
    open(h);
    roleBtn(root, 1, 'human').dispatchEvent(new MouseEvent('click'));
    const raw = storage.getItem(VERSUS_SETUP_KEY) as string;
    expect(raw).toContain('"role":"human"');
    expect(raw, 'a device index reached storage').not.toContain('padIndex');
    expect(raw).not.toContain('keyboard');
    h.dispose();
    document.body.innerHTML = '';
  });

  it('works with no store at all -- the pane still gates, it simply forgets', () => {
    // `createHud(root)` is the shape ~200 existing tests use. The optional dependency
    // must not turn into a required one by accident.
    const root = document.createElement('div');
    document.body.appendChild(root);
    const h = createHud(root);
    open(h);
    const start = root.querySelector('.hud-versus-start') as HTMLButtonElement;
    expect(start.disabled).toBe(false);
    (root.querySelector('.hud-versus-slot-row[data-slot="0"] .hud-versus-role-btn[data-role="bot"]') as HTMLButtonElement)
      .dispatchEvent(new MouseEvent('click'));
    expect(start.disabled, 'the gate still runs without a store').toBe(true);
    h.dispose();
    document.body.innerHTML = '';
  });
});

describe('the versus map cards (issue #274)', () => {
  const open = (root: HTMLElement, h: Hud): void => {
    h.setState('main-menu');
    (root.querySelector('.hud-versus-open') as HTMLButtonElement).click();
  };
  const cards = (root: HTMLElement): HTMLButtonElement[] =>
    Array.from(root.querySelectorAll('.hud-versus-map-row button'));
  const part = (card: HTMLElement, cls: string): HTMLElement =>
    card.querySelector(`.${cls}`) as HTMLElement;
  /** The accessible name, for the name-from-content case these cards use. */
  const name = (el: HTMLElement): string =>
    Array.from(el.childNodes)
      .filter((n) => !(n instanceof HTMLElement) || n.getAttribute('aria-hidden') !== 'true')
      .map((n) => n.textContent ?? '')
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

  it('gives every eligible board a card, and Random last', () => {
    // The population is the filter's, not a literal: `versusMapChoices` is what decides
    // eligibility and the row must not add or lose one. Random is asserted to be LAST
    // because it is the only choice that is not a board, and a row that offered it first
    // would put the least specific option where the eye lands.
    const { hud: h, root } = mount();
    open(root, h);
    const expected = [...versusMapChoices(2, 'ffa'), 'random'];
    expect(expected.length).toBeGreaterThan(2);
    expect(cards(root).map((c) => c.dataset.map)).toEqual(expected);
  });

  it('names each board, says what it supports, and says what it plays like', () => {
    // Three separate claims on one card. The middle one is the easiest to get subtly wrong
    // and is checked against the CATALOG rather than against the current selection -- see
    // the next case for why that distinction is the point.
    const { hud: h, root } = mount();
    open(root, h);
    for (const card of cards(root)) {
      const id = card.dataset.map as string;
      expect(part(card, 'hud-versus-map-name').textContent, id).not.toBe('');
      expect(part(card, 'hud-versus-map-config').textContent, id).not.toBe('');
      expect(part(card, 'hud-versus-map-intent').textContent, id).not.toBe('');
      if (id === 'random') continue;
      const entry = versusCatalogEntryById(id);
      expect(part(card, 'hud-versus-map-name').textContent, id).toBe(entry.displayName);
      // The intent is the catalog's own sentence, not a rewrite: #274 asks for the board's
      // match intent, and a second copy in the HUD would drift from the one the catalog
      // validates.
      expect(part(card, 'hud-versus-map-intent').textContent, id).toBe(entry.intent);
    }
  });

  it('says what a board supports, not what is currently selected', () => {
    // The whole reason the line exists. At two players the row shows Pinwheel, which is
    // two-only, beside Arena 1, which is 2/3/4 -- and a card that echoed the selection
    // would say "2 players" on both, which is true of the moment and useless for the
    // choice. Two boards with DIFFERENT support, compared in the same fixture, so a
    // config line built from `versusConfigState` fails here rather than reading fine.
    const { hud: h, root } = mount();
    open(root, h);
    const line = (id: string): string =>
      part(cards(root).find((c) => c.dataset.map === id) as HTMLElement, 'hud-versus-map-config')
        .textContent ?? '';
    expect(versusCatalogEntryById('vs-duel-01').players).toEqual([2]);
    expect(versusCatalogEntryById('arena-01').players).toEqual([2, 3, 4]);
    expect(line('vs-duel-01')).toContain('2 players');
    expect(line('arena-01')).toContain('2/3/4 players');
    expect(line('vs-duel-01')).not.toBe(line('arena-01'));
    // ...and the modes are the catalog's, spelled with the Mode row's own words.
    expect(line('arena-01')).toContain('FFA and Teams');
  });

  it('tells Random how many boards it will draw from, counting the row and not the catalog', () => {
    // WHAT THIS DISCRIMINATES. Two players yield EIGHT eligible boards -- the five campaign
    // arenas plus vs-duel-01, vs-tri-01 and vs-quad-01 since issue #1035 offered the last two
    // at the lower counts they measure suitable at -- and three and four players yield SEVEN:
    // vs-tri-01 and vs-quad-01 at three (#1035), vs-quad-01 and vs-quad-02 at four (#1036).
    // While every combination yielded six, no fixture told this line from a hardcoded `6`;
    // the two-player combination now differs from the rest, so a hardcoded figure fails.
    //
    // It also discriminates the other mistake available here: counting the CATALOG, which
    // has nine entries, instead of the filtered row. That is the number a reader of
    // `VERSUS_CATALOG.length` would reach for, and Random drawing from nine boards when seven
    // or eight are offered is the criterion "Random never selects outside the displayed
    // eligible set" restated as a claim on the card.
    const { hud: h, root } = mount();
    open(root, h);
    const randomLine = (): string =>
      part(cards(root).find((c) => c.dataset.map === 'random') as HTMLElement, 'hud-versus-map-config')
        .textContent ?? '';
    const eligible = (): number => cards(root).length - 1;

    const counts = new Set<number>();
    for (const players of [2, 3, 4] as const) {
      for (const mode of ['ffa', 'teams'] as const) {
        if (mode === 'teams' && players === 2) continue; // not offered at two
        (root.querySelector(`.hud-versus-players-row [data-players="${players}"]`) as HTMLButtonElement).click();
        (root.querySelector(`.hud-versus-mode-row [data-mode="${mode}"]`) as HTMLButtonElement).click();
        counts.add(eligible());
        expect(randomLine(), `${players}p ${mode}`).toBe(`${eligible()} eligible boards`);
        expect(eligible(), `${players}p ${mode}`).toBeLessThan(VERSUS_CATALOG.length);
      }
    }
    // The population, recorded rather than assumed: eight at two players, seven at three and four.
    expect([...counts]).toEqual([8, 7]);
    expect(VERSUS_CATALOG.length).toBe(9);
  });

  it('keeps the picture and the sentence out of the card\'s name, and the sentence in its description', () => {
    // A card names a board; it does not recite a paragraph. Folding seven intent sentences
    // into seven accessible names gives a screen reader seven paragraphs to walk before the
    // eighth control. The canvas is `aria-hidden` for the same reason and a stronger one:
    // an unlabelled canvas in the accessibility tree announces nothing at all.
    const { hud: h, root } = mount();
    open(root, h);
    for (const card of cards(root)) {
      const id = card.dataset.map as string;
      const intent = part(card, 'hud-versus-map-intent');
      expect(part(card, 'hud-versus-map-canvas').getAttribute('aria-hidden'), id).toBe('true');
      expect(intent.getAttribute('aria-hidden'), id).toBe('true');
      // Described by it, which is how the sentence still reaches a screen reader.
      expect(card.getAttribute('aria-describedby'), id).toBe(intent.id);
      // `getElementById`, not a `#id` selector: jsdom has no `CSS.escape`, and the ids
      // here embed an arena id that contains a hyphen.
      expect(intent.id, id).not.toBe('');
      expect(root.ownerDocument.getElementById(intent.id), id).toBe(intent);
      // The name is the board and its support, and NOT the sentence.
      expect(name(card), id).not.toContain(intent.textContent);
      expect(name(card), id).toContain(part(card, 'hud-versus-map-name').textContent);
    }
  });

  it('draws a board on every card but Random, which has none to draw', () => {
    // jsdom has no 2D context, so what is observable here is the CALL's own report: a real
    // board is asked for and Random is not. The pixels are photographed by tools/screens.
    const { hud: h, root } = mount();
    open(root, h);
    for (const card of cards(root)) {
      const canvas = part(card, 'hud-versus-map-canvas') as HTMLCanvasElement;
      const isRandom = card.dataset.map === 'random';
      expect(canvas.classList.contains('hud-versus-map-canvas--random'), card.dataset.map).toBe(
        isRandom,
      );
      // The box is set from attributes, which is what `drawArenaSchematic` scales into.
      expect(canvas.width, card.dataset.map).toBeGreaterThan(0);
      expect(canvas.height, card.dataset.map).toBeGreaterThan(0);
    }
  });

  it('rebuilds the cards when the filter moves, with no card left behind', () => {
    // The row is replaced wholesale on every change, so the failure to look for is a card
    // that SURVIVES a filter it no longer satisfies. Pinwheel is two-only; at three players
    // it must be gone from the DOM, not merely hidden.
    const { hud: h, root } = mount();
    open(root, h);
    expect(cards(root).map((c) => c.dataset.map)).toContain('vs-duel-01');
    (root.querySelector('.hud-versus-players-row [data-players="3"]') as HTMLButtonElement).click();
    expect(cards(root).map((c) => c.dataset.map)).not.toContain('vs-duel-01');
    expect(root.querySelectorAll('[data-map="vs-duel-01"]').length).toBe(0);
    // ...and the three-player board that two players could not offer is now here.
    expect(cards(root).map((c) => c.dataset.map)).toContain('vs-tri-01');
  });
});
