// @vitest-environment jsdom
import { defaultSlots } from './versus-setup';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createHud, type GameplayOutcome, type GameplayStatus, type Hud } from './hud';
import { browserHistoryHost, type HistoryHost } from './navigation';
import { isMuteHotkey, isPauseHotkey } from './loop';
import { versusMapChoices, type VersusConfig } from './versus-config';
import { createVersusSetupStore, VERSUS_SETUP_KEY } from './versus-setup-store';
import { createMemoryStorage } from './storage';
import { VERSUS_STOCK } from '../sim/constants';


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

  it('roving tabindex reaches Start, then Back -- the two controls the task brief names explicitly', () => {
    const { hud: h, root } = mount();
    h.setState('main-menu');
    h.showVersusSetup(true);
    expect(document.activeElement, 'opening the pane did not focus its CONTAINER').toBe(view(root));
    let steps = 0;
    while (document.activeElement !== startBtn(root) && steps < 40) {
      (document.activeElement as HTMLElement).dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
      );
      steps += 1;
    }
    expect(document.activeElement, 'never reached Start').toBe(startBtn(root));
    (document.activeElement as HTMLElement).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
    );
    expect(document.activeElement, 'the step after Start did not reach Back').toBe(backBtn(root));
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

describe('createHud roving-tabindex focus navigation (issue #115)', () => {
  it('every focus-target container names itself from its own heading', () => {
    // The seven tabindex="-1" containers are what panel-open transitions focus; a bare
    // div's accessible name is the flattened text of everything inside it, so each one
    // carries aria-labelledby pointing at its own h1. Derived from the DOM, not a list:
    // an eighth focusable container added without the attribute fails here. Breaks if
    // an aria-labelledby is dropped, its id target renamed, or the target moves outside
    // the container it names.
    const { root } = mount();
    const containers = Array.from(root.querySelectorAll<HTMLElement>('[tabindex="-1"]'));
    expect(containers.length, '10 panel containers carry tabindex=-1 (panel + 9 panes: ' +
      'controller assignment landing added the 6th (docs/superpowers/plans/2026-08-17-' +
      'controller-assignment.md), the versus setup pane the 7th (docs/superpowers/specs/' +
      '2026-08-21-versus-setup-menu-design.md), and issue #226 the 8th, 9th and 10th -- ' +
      'Settings, About & Legal, and the replace-run confirmation)').toBe(10);
    for (const c of containers) {
      const ref = c.getAttribute('aria-labelledby');
      expect(ref, `${c.className} has no aria-labelledby`).toBeTruthy();
      const target = root.querySelector(`#${ref}`);
      expect(target, `${c.className}'s aria-labelledby (#${ref}) resolves to nothing`).not.toBeNull();
      expect(c.contains(target), `${c.className}'s label lives outside the container it names`).toBe(true);
      expect(target!.tagName, `${c.className}'s label is not its heading`).toBe('H1');
    }
  });

  /** A real keydown, dispatched at whatever currently holds focus -- exactly what a
   * browser delivers to `document.activeElement`, and what makes this reach the
   * capture-phase `window` listener `onNavKeyDown` registers (a bubbling event fired at
   * any connected descendant of `window` passes through it during capture, regardless
   * of which node it is dispatched at). */
  function pressActive(key: string): void {
    (document.activeElement as HTMLElement).dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
    );
  }

  /** Keyboard activation: MouseEvent detail 0, the same convention `blurIfPointer`
   * relies on elsewhere in this file (see 'does not keep keyboard focus after a
   * pointer interaction' above) -- so entering a subpanel through this traversal does
   * not blur the button the way a real pointer click would. */
  function activate(el: HTMLElement): void {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }));
  }

  /**
   * Independently re-derives the exact predicate hud.ts's own (unexported)
   * `focusableControls` applies, straight from the DOM rather than a maintained list --
   * `button, [tabindex]`, filtered to not-disabled and not hidden by `display: none` on
   * itself OR ON ANY ANCESTOR up to (not including) `container`. That ancestor walk
   * matters: since issue #226 the three Main Menu regions hide as GROUPS on the win/lose
   * panel, and `getComputedStyle` on a child inside one reports the child's OWN resolved
   * display, not `none` (measured directly below), so a check that only looked at the
   * element itself would disagree with a correct production predicate exactly where a
   * hidden wrapper is involved -- which is exactly the drift this independent oracle
   * exists to catch, not paper over by copying the bug.
   */
  function controlsOf(container: HTMLElement): HTMLElement[] {
    const hiddenWithin = (el: HTMLElement): boolean => {
      for (let n: HTMLElement | null = el; n && n !== container; n = n.parentElement) {
        if (getComputedStyle(n).display === 'none') return true;
      }
      return false;
    };
    return Array.from(container.querySelectorAll<HTMLElement>('button, [tabindex]')).filter(
      (el) => !(el instanceof HTMLButtonElement && el.disabled) && !hiddenWithin(el),
    );
  }

  /**
   * The openers that live on the MAIN PANEL, and the pane each opens.
   *
   * Panel-level only, deliberately, and that is a statement about the layer stack rather
   * than about this test's convenience: a pane opened from inside ANOTHER pane replaces
   * it (`openLayer`), so the opener is gone by the time Back runs and `restoreFocus`
   * falls back to the container. The walk below asserts that Back restores the opener,
   * which is true exactly for the openers listed here. The three pane-to-pane moves
   * issue #226 adds -- the Records tabs, Settings -> Controllers, Settings -> About --
   * have their own tests, and issue #327 owns the covering-layer contract that would let
   * them nest.
   */
  const OPEN_TO_PANEL: Record<string, string> = {
    'hud-customize-open': 'hud-customize',
    'hud-records-open': 'hud-stats',
    'hud-levelselect-open': 'hud-levelselect',
    'hud-controllers-open': 'hud-controllers',
    'hud-versus-open': 'hud-versus-setup',
    'hud-settings-open': 'hud-settings',
    'hud-about-open': 'hud-about',
  };
  const BACK_OF_PANEL: Record<string, string> = {
    'hud-customize': 'hud-customize-back',
    'hud-stats': 'hud-stats-back',
    'hud-achievements': 'hud-achievements-back',
    'hud-levelselect': 'hud-levelselect-back',
    'hud-controllers': 'hud-controllers-back',
    'hud-versus-setup': 'hud-versus-back',
    'hud-settings': 'hud-settings-back',
    'hud-about': 'hud-about-back',
  };

  it('reaches every visible, enabled control from the title screen using arrow keys alone', () => {
    // The issue's own falsifiable assertion. 3 of 5 levels unlocked: exercises a
    // reachable level button AND a locked one that must be SKIPPED, not merely
    // disabled-but-focusable.
    const { hud: h, root } = mount();
    h.setLevelSelect(3, 5);
    h.setContinueAvailable(true); // Continue must be one of the reachable controls counted below
    // The versus setup pane's Versus button is a bare click passthrough (onVersusOpen's
    // own doc comment on the Hud interface) -- unlike every sibling panel's own open
    // button, clicking it does NOT open the pane by itself; the real subscriber
    // (loop.ts) decides that. Wiring the SAME one-liner loop.ts will use is what lets
    // `walk` below enter this pane exactly like every other one, by an ACTUAL open
    // transition rather than a special case.
    h.onVersusOpen(() => h.showVersusSetup(true));
    h.setState('main-menu'); // splash -> title: focuses the .hud-panel CONTAINER, index -1

    let totalControls = 0;
    const visited = new Set<HTMLElement>();

    // Walks ONE panel's flat control list forward with ArrowDown, entering and leaving
    // every subpanel it finds along the way via its own open/Back buttons (never via
    // arrows -- activation is a separate, native concern; see the report). Recursive
    // because a subpanel is walked exactly the same way the title panel is.
    //
    // EVERY panel-open transition -- the first splash -> title, a subpanel's own open
    // button, and Back returning to title -- focuses that panel's CONTAINER, never a
    // control (see the doc comment above `activePanelContainer` in hud.ts for why:
    // focusing a button there killed Escape/M the instant the panel opened). So `walk`
    // always starts at index -1 and its own first ArrowDown is what reaches controls[0],
    // uniformly, with no "already there" special case.
    function walk(container: HTMLElement): void {
      expect(
        document.activeElement,
        `${container.className} was not focused as a CONTAINER on open`,
      ).toBe(container);
      const controls = controlsOf(container);
      expect(controls.length, `${container.className} exposed no reachable controls`).toBeGreaterThan(0);
      totalControls += controls.length;
      for (let i = 0; i < controls.length; i++) {
        pressActive('ArrowDown');
        const active = document.activeElement as HTMLElement;
        expect(active, `step ${i} in .${container.className.split(' ')[0]} landed on the wrong control`).toBe(
          controls[i],
        );
        visited.add(active);
        const openCls = Array.from(active.classList).find((c) => c in OPEN_TO_PANEL);
        if (openCls) {
          activate(active); // opens the subpanel and focuses ITS container
          const subPanel = root.querySelector(`.${OPEN_TO_PANEL[openCls]}`) as HTMLElement;
          walk(subPanel);
          const back = root.querySelector(`.${BACK_OF_PANEL[OPEN_TO_PANEL[openCls]]}`) as HTMLButtonElement;
          activate(back); // leave -- restores focus to the control that opened it (issue #318)
          expect(
            document.activeElement,
            'Back did not return focus to the control that opened the subpanel',
          ).toBe(active);
          // Focus is on control i again, so the loop's own next ArrowDown reaches i+1
          // with no replay. Until issue #318 Back landed on the CONTAINER (index -1)
          // and this loop had to replay i + 1 presses to get back to where it was.
        }
      }
      // One more step proves the list is a closed CYCLE, not just a reachable line --
      // the last control wraps back to the first rather than dead-ending.
      pressActive('ArrowDown');
      expect(document.activeElement, `${container.className} did not wrap back to its first control`).toBe(
        controls[0],
      );
    }

    walk(root.querySelector('.hud-panel') as HTMLElement);

    // Denominator: 42, the live sum of controlsOf().length over the title panel and all
    // four subpanels, counted as `walk` actually visits each one (not asserted as a bare
    // literal -- see below). It decomposes as 10 (title: Continue, New Game, the three
    // open buttons, Levels-open, panel Mute, the scheme, fire-mode and haptics toggles) +
    // 24 (Customize: the preview canvas, its 4 rotate buttons, PALETTE.length 6 hull
    // swatches, SKINS.length 7 skin buttons, ACCENTS.length 5 accent swatches, Back) + 3
    // (Stats: Reset stats, Reset progress, Back) + 1 (Achievements: Back -- the list
    // itself is plain divs, not focusable) + 4 (Levels: the 3 unlocked buttons this
    // test's own `setLevelSelect(3, 5)` leaves reachable, plus Back). The two volume
    // sliders and the topbar's own Mute are excluded by design -- see the roving-focus
    // doc comment in hud.ts.
    // 42 since the haptics toggle (issue #112's deferred HUD control) landed: 41 + the
    // toggle beside the fire-mode toggle in the title panel's settings row.
    // 44 since the controller assignment panel landed (docs/superpowers/plans/
    // 2026-08-17-controller-assignment.md): 42 + 1 (the title panel's own new
    // Controllers-open button) + 1 (the Controllers panel's own Back button -- this test
    // never calls hud.setControllers, so its rows are empty and Back is its only
    // reachable control; row-button reachability is covered by hud.css.test.ts's
    // buttons.length sweep and this file's own controller-row rendering tests instead).
    // 64 since issue #271 added a sixth board OFFERED AT N=2, the count this fixture's
    // versus pane defaults to; it was 63 when the versus setup pane landed
    // (docs/superpowers/specs/2026-08-21-versus-setup-menu-design.md).
    //
    // 70 since issue #260 made who's-playing a set of per-slot ROLE controls. That block
    // used to contribute 0 reachable controls here: it rendered a DEVICE preview, and
    // this test never calls hud.setControllers, so the session's assignment was length 0
    // against the pane's default 2 players -- a mismatch, which rendered every candidate
    // DISABLED and therefore unreachable by the roving walk. The role buttons are
    // enabled unconditionally, so the same block now contributes 2 slots x
    // [Human/Bot/Off] = 6. Start is still reachable because the default slots
    // (Human, Bot) raise no problem and so leave it enabled -- a fixture whose defaults
    // refused Start would pin 69, not 70.
    //
    // 44 + 1 (the title panel's own new Versus-open button) + 25 (the versus pane's OWN
    // reachable controls, measured against this test's own fixture -- 2 Mode + 3 Players
    // + 7 Map (versusMapChoices(2): the five migrated boards, vs-duel-01, plus Random --
    // a board curated for another count would NOT appear here) + 5 Stock + 0 friendly
    // fire (absent -- the pane defaults to FFA) + 6 who's-playing role buttons
    // + Start + Back = 2+3+7+5+0+6+1+1 = 25).
    // 72 since issue #281, DOWN by one, and the direction is the point: this sweep counts
    // visible and ENABLED controls, and Teams is no longer offered at two players ("not a
    // distinct option for two players because it is equivalent to FFA"). This fixture is at
    // the pane's default count, so the Teams button is disabled here and correctly drops
    // out of arrow-key navigation -- a disabled control that stayed reachable would be the
    // defect.
    //
    // It was 73 since issue #267, when the one BOT slot (`defaultSlots(2)` is
    // `[human, bot]`) gained Easy/Normal/Hard. The per-slot TEAM buttons do not appear
    // here at all, because they render only under Teams -- which this fixture cannot now
    // reach at two players.
    //
    // 76 SINCE ISSUE #226, up 4 from 72, and every part of that delta was the Main Menu and
    // Settings restructure. Re-measured per container at this fixture's state rather than
    // adjusted: 8 (Main Menu) + 24 (Customize) + 3 (Records/Stats) + 4 (Levels) + 27
    // (Versus setup) + 9 (Settings) + 1 (About & Legal) = 76.
    //
    // Itemised against the 72:
    //   -4  the Main Menu drops from 12 to 8. OUT: Stats-open and Achievements-open (one
    //       Records entry replaces both), Controllers-open (pause-only now), and the four
    //       settings-row controls (panel Mute, scheme, fire mode, haptics -- moved into
    //       the Settings pane). IN: Records, Settings, and the About & Legal footer.
    //       Continue, the campaign start button, Versus and Practice are unchanged.
    //   -1  the Controllers pane is no longer walked FROM HERE: its opener is pause-only,
    //       and the Settings -> Controls entry that replaces it is a pane-to-pane move,
    //       which this walk deliberately does not follow (see OPEN_TO_PANEL).
    //   -1  the Achievements pane likewise: it is a TAB of Records now, reached from
    //       inside the Stats pane rather than from the menu. Its own tests cover it.
    //   +9  the Settings pane: Mute, aim scheme, fire mode, haptics, Controllers, Reset
    //       stats, Reset progress, About & Legal, Back. The volume slider is excluded for
    //       the same reason the retired ones were -- `input[type=range]` matches neither
    //       `button` nor `[tabindex]`.
    //   +1  the About & Legal pane: Back. Its three paragraphs are prose, not controls.
    //
    // The Records pane holds at 3: the two reset buttons it gave up were replaced,
    // one for one, by the two tab buttons.
    //
    // 77 SINCE ISSUE #289: the Settings pane goes from 9 to 10 with the motion toggle,
    // which is the first control its Accessibility section has ever held. That the walk
    // reaches it is the assertion that matters here -- a section rendering with a control
    // the arrows cannot land on is the failure `refreshSettingsSections` and
    // `focusableControls` share a predicate to prevent.
    //
    // 78 SINCE ISSUE #540: 11 in the Settings pane, the extra one being the render-quality
    // toggle beside it in Accessibility. Same assertion, same reason.
    expect(totalControls, 'recount the panels above if this moves').toBe(78);
    expect(visited.size, 'a control was reached more than once under a different identity').toBe(
      totalControls,
    );
  });

  it('skips locked level buttons when stepping through the Levels panel', () => {
    const { hud: h, root } = mount();
    h.setLevelSelect(2, 4); // levels 3 and 4 locked
    h.setState('main-menu');

    let active = document.activeElement as HTMLElement;
    // Bounded like the other walks: a regression that stops the arrows moving focus must
    // FAIL here, not spin a CI worker forever (it did, on 2026-09-02, when a unified
    // key-consume rule briefly let a focused button keep the arrows).
    let steps = 0;
    while (!(active instanceof HTMLElement && active.classList.contains('hud-levelselect-open')) && steps < 40) {
      pressActive('ArrowDown');
      active = document.activeElement as HTMLElement;
      steps += 1;
    }
    expect(active.classList.contains('hud-levelselect-open'), 'the walk never reached the Levels opener').toBe(true);
    activate(active); // open Levels -- focuses the .hud-levelselect CONTAINER

    const levelSelectView = root.querySelector('.hud-levelselect') as HTMLElement;
    expect(document.activeElement, 'opening Levels did not focus its container').toBe(
      levelSelectView,
    );
    const levelBtns = Array.from(
      root.querySelectorAll('.hud-level-btn'),
    ) as HTMLButtonElement[];
    expect(levelBtns).toHaveLength(4);
    // 2 unlocked level buttons + Back -- the 2 locked ones must never appear here.
    const reached: HTMLButtonElement[] = [];
    for (let i = 0; i < 3; i++) {
      pressActive('ArrowDown');
      reached.push(document.activeElement as HTMLButtonElement);
    }
    expect(reached).toEqual([levelBtns[0], levelBtns[1], root.querySelector('.hud-levelselect-back')]);
    expect(reached.some((b) => b.disabled), 'a disabled, locked level button was focused').toBe(false);
  });

  it('moves focus backward with ArrowUp, undoing an ArrowDown step', () => {
    // A spot check, not a re-sweep of the whole panel -- the traversal test above
    // already proves the forward order for every control; this pins one adjacent pair
    // (of however many the title panel exposes) to check that reversing the direction
    // key reverses the step, not the full sweep that test performs.
    const { hud: h } = mount();
    h.setLevelSelect(3, 5);
    h.setState('main-menu');
    pressActive('ArrowDown');
    const first = document.activeElement;
    pressActive('ArrowDown');
    const second = document.activeElement;
    expect(second).not.toBe(first);
    pressActive('ArrowUp');
    expect(document.activeElement, 'ArrowUp did not undo the previous ArrowDown').toBe(first);
  });

  it('treats S/W as Down/Up, the same production call ArrowDown/ArrowUp reach', () => {
    const { hud: h } = mount();
    h.setState('main-menu');
    pressActive('s');
    const afterS = document.activeElement;
    pressActive('ArrowDown');
    const afterArrowDown = document.activeElement;
    expect(afterArrowDown, 's did not move focus the same way ArrowDown does').not.toBe(afterS);
    pressActive('w');
    expect(document.activeElement, 'w did not undo the previous step, as ArrowUp does').toBe(
      afterS,
    );
  });

  it('focuses the pause panel\'s CONTAINER (not Resume) so Escape-to-resume stays live', () => {
    // The regression this shape exists to avoid: an earlier draft focused Resume
    // directly on entering pause, on the reasoning that arriving already positioned
    // saves a keypress. `isPauseHotkey`/`isMuteHotkey` (game/loop.ts) both ignore any
    // key whose target sits inside a button, so that draft silently killed
    // Escape-to-resume and M-to-mute the instant the pause panel opened -- which no
    // test caught, because the only existing hotkey-liveness test covers splash ->
    // title, not pause. This constructs the SAME kind of event those guards read,
    // exactly as that test does, rather than trusting the class name alone.
    const { hud: h, root } = mount();
    h.setState('main-menu');
    h.setState('playing');
    h.setState('paused');
    const panel = root.querySelector('.hud-panel') as HTMLElement;
    const active = document.activeElement as HTMLElement;
    expect(active, 'pause focused something other than the panel container').toBe(panel);
    const ev = (key: string): KeyboardEvent =>
      ({ key, repeat: false, target: active }) as unknown as KeyboardEvent;
    expect(isPauseHotkey(ev('Escape')), 'Escape-to-resume is dead while paused').toBe(true);
    expect(isMuteHotkey(ev('m')), 'M-to-mute is dead while paused').toBe(true);
  });

  it('reaches Resume, then Settings, then Controllers, then Quit from the pause panel', () => {
    // Was "two ArrowDowns" before the controller assignment panel landed (docs/
    // superpowers/plans/2026-08-17-controller-assignment.md), and three until issue #226
    // gave the pause panel a Settings entry -- which sits in the utilities region, and so
    // in DOM order before Controllers and Quit. Each is a real, reachable stop.
    const { hud: h, root } = mount();
    h.setState('main-menu');
    h.setState('playing');
    h.setState('paused');
    pressActive('ArrowDown');
    expect(document.activeElement, 'the first ArrowDown from pause did not reach Resume').toBe(
      root.querySelector('.hud-action'),
    );
    pressActive('ArrowDown');
    expect(document.activeElement, 'the second ArrowDown did not reach Settings').toBe(
      root.querySelector('.hud-settings-open'),
    );
    pressActive('ArrowDown');
    expect(document.activeElement, 'the third ArrowDown did not reach Controllers').toBe(
      root.querySelector('.hud-controllers-open'),
    );
    pressActive('ArrowDown');
    expect(document.activeElement, 'the fourth ArrowDown did not reach Quit').toBe(
      root.querySelector('.hud-quit'),
    );
  });

  it('Back returns focus to the control that opened the subpanel, and the menu hotkeys stay alive there (issue #318)', () => {
    // Two contracts in one place, on purpose. Back lands on the Customize BUTTON now,
    // not on the panel container -- which is only legal because loop.ts's hotkey guard
    // stopped treating a button as a control that consumes M and Escape. Until #318
    // this test pinned the container, as the workaround for that broader guard.
    const { hud: h, root } = mount();
    h.setState('main-menu');
    const opener = root.querySelector('.hud-customize-open') as HTMLButtonElement;
    opener.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }));
    expect(document.activeElement, 'opening focuses the pane container').not.toBe(opener);
    (root.querySelector('.hud-customize-back') as HTMLButtonElement).dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }),
    );
    const active = document.activeElement as HTMLElement;
    expect(active, 'Back left focus somewhere other than the control that opened the pane').toBe(opener);
    const ev = (key: string): KeyboardEvent =>
      ({ key, repeat: false, target: active }) as unknown as KeyboardEvent;
    expect(isMuteHotkey(ev('m')), 'M is dead at the menu after Back').toBe(true);
  });

  it('auto-focuses the panel container, then reaches the action button, on win and lose', () => {
    const { hud: h, root } = mount();
    const panel = root.querySelector('.hud-panel') as HTMLElement;
    const action = root.querySelector('.hud-action') as HTMLButtonElement;
    h.setState('main-menu');
    h.setState('playing');
    h.setState('outcome-win');
    expect(document.activeElement, 'win focused something other than the panel container').toBe(
      panel,
    );
    pressActive('ArrowDown');
    expect(document.activeElement).toBe(action);
    h.setState('playing');
    h.setState('outcome-lose');
    expect(document.activeElement, 'lose focused something other than the panel container').toBe(
      panel,
    );
    pressActive('ArrowDown');
    expect(document.activeElement).toBe(action);
  });

  it('never walks focus into a Main Menu region while its wrapper is display:none', () => {
    // The bug the ancestor-walking `isHiddenWithin` in hud.ts exists to catch. It used
    // to be `.hud-panel-settings` hiding the audio row as a group; since issue #226 the
    // group hides are the three Main Menu REGIONS, which is a wider version of the same
    // shape -- each control's OWN `display` still resolves to something other than
    // `none`, so a check that only looked at the control itself would walk the roving
    // order onto six invisible buttons on every win/lose screen instead of three.
    const { hud: h, root } = mount();
    h.setState('main-menu');
    h.setState('playing');
    h.setState('outcome-win'); // controls: the action button ALONE
    for (const cls of ['hud-menu-play', 'hud-menu-utilities', 'hud-menu-footer']) {
      const region = root.querySelector(`.${cls}`) as HTMLElement;
      expect(getComputedStyle(region).display, `test invalid: .${cls} is not actually hidden`).toBe(
        'none',
      );
    }
    // The half that makes this test about the ANCESTOR walk rather than about the
    // controls: these two carry no `--hidden` of their own, so their own resolved
    // `display` is not `none` and only the wrapper excludes them. (The play region's two
    // buttons both have their own modifiers as well -- Versus is Main-Menu-only and
    // Practice also needs a level choice -- so they cannot make this point and are
    // deliberately not asked to.)
    for (const sel of ['.hud-settings-open', '.hud-about-open']) {
      const inner = root.querySelector(sel) as HTMLElement;
      expect(
        getComputedStyle(inner).display,
        `test invalid: ${sel} now also resolves display:none, which would make this pass for the wrong reason`,
      ).not.toBe('none');
    }
    pressActive('ArrowDown'); // reaches the action button
    pressActive('ArrowDown'); // must WRAP back to it, not fall into a hidden region
    expect(document.activeElement, 'focus walked onto a control inside a hidden region').toBe(
      root.querySelector('.hud-action'),
    );
  });

  it('does not intercept arrow keys while playing, so input.ts still drives the tank', () => {
    // The state-aware boundary this whole feature has to respect: no panel is visible
    // while playing, so `activePanelContainer` must return null and the handler must
    // return before calling preventDefault -- otherwise input.ts's own window listener,
    // which registers AFTER this one in a real boot and so runs strictly later, would
    // never see the key at all.
    const { hud: h } = mount();
    h.setState('main-menu');
    h.setState('playing');
    document.body.focus();
    const ev = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
    document.body.dispatchEvent(ev);
    expect(ev.defaultPrevented, 'a playing-state ArrowDown was swallowed by the HUD nav').toBe(
      false,
    );
  });

  it('leaves the volume slider in full control of its own arrow keys', () => {
    // input.ts's WIDGET_KEYS already gives a focused range input every arrow key for
    // its own value adjustment (see its doc comment on Right Arrow strafing instead of
    // moving the slider); this file's roving nav must not re-litigate that. Production
    // change that would break this: dropping the `e.target instanceof HTMLInputElement`
    // early return in `onNavKeyDown`.
    const { hud: h, root } = mount();
    h.setState('main-menu');
    // In the Settings pane since issue #226, so the pane has to be open for the slider to
    // be the control the roving handler is deciding about.
    (root.querySelector('.hud-settings-open') as HTMLButtonElement).dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }),
    );
    const slider = root.querySelector('.hud-settings-volume') as HTMLInputElement;
    slider.focus();
    for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
      const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      slider.dispatchEvent(ev);
      expect(document.activeElement, `${key} moved focus off the slider`).toBe(slider);
      expect(ev.defaultPrevented, `${key} was swallowed instead of left to the slider`).toBe(false);
    }
  });

  it('leaves ArrowLeft/ArrowRight on the preview canvas for its own rotation scheme', () => {
    // render/preview-controls.ts binds its own keydown DIRECTLY to the canvas (not at
    // window), so this file cannot see whether that scheme still fires -- what it CAN
    // pin is that its own capture-phase handler, which runs strictly before a
    // target-bound listener ever sees the event, gets out of the way for Left/Right and
    // does not for the axis the canvas never claims. Production change that would break
    // this: dropping the `e.target === previewCanvasEl` carve-out for lateral keys.
    const { hud: h, root } = mount();
    h.setState('main-menu');
    (root.querySelector('.hud-customize-open') as HTMLButtonElement).dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }),
    );
    // LOAD-BEARING, not clarity: showCustomize(true) focuses the PANE (customizeView),
    // never the canvas -- nothing in hud.ts ever calls previewCanvas.focus(). Delete
    // this line and the assertion below tests the wrong element.
    h.previewCanvas.focus();
    for (const key of ['ArrowLeft', 'ArrowRight']) {
      const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      h.previewCanvas.dispatchEvent(ev);
      expect(document.activeElement, `${key} moved focus off the canvas`).toBe(h.previewCanvas);
      expect(ev.defaultPrevented, `${key} was claimed by the HUD nav instead of the canvas`).toBe(
        false,
      );
    }
    const down = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
    h.previewCanvas.dispatchEvent(down);
    expect(document.activeElement, 'ArrowDown did not move focus off the canvas').not.toBe(
      h.previewCanvas,
    );
  });

  it('removes its own capture-phase window keydown listener on dispose', () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    const root = document.createElement('div');
    document.body.appendChild(root);
    const h = createHud(root);

    const added = addSpy.mock.calls.find(
      (c) => c[0] === 'keydown' && c[2] === true,
    );
    expect(added, 'no capture-phase keydown listener was registered at window').toBeDefined();

    h.dispose();

    const removed = removeSpy.mock.calls.find(
      (c) => c[0] === 'keydown' && c[1] === added![1] && c[2] === true,
    );
    expect(removed, 'dispose did not remove the capture-phase keydown listener it added').toBeDefined();

    addSpy.mockRestore();
    removeSpy.mockRestore();
  });
});

describe('hud: relaunch target -- the title/outcome affordance policy', () => {
  const continueBtn = (root: HTMLElement): HTMLButtonElement =>
    root.querySelector('.hud-continue') as HTMLButtonElement;
  const newGameBtn = (root: HTMLElement): HTMLButtonElement =>
    root.querySelector('.hud-new-game') as HTMLButtonElement;
  const levelSelectOpenBtn = (root: HTMLElement): HTMLButtonElement =>
    root.querySelector('.hud-levelselect-open') as HTMLButtonElement;
  const campaignOpenBtn = (root: HTMLElement): HTMLButtonElement =>
    root.querySelector('.hud-campaign-open') as HTMLButtonElement;
  const versusOpenBtn = (root: HTMLElement): HTMLButtonElement =>
    root.querySelector('.hud-versus-open') as HTMLButtonElement;
  const actionBtn = (root: HTMLElement): HTMLElement =>
    root.querySelector('.hud-action') as HTMLElement;

  /** The whole visibility/label set applyTitleAffordances drives, snapshotted together
   *  so a single assertion can pin the exact combination rather than one class at a
   *  time. */
  function titleAffordances(root: HTMLElement): {
    continueVisible: boolean;
    newGameVisible: boolean;
    newGameLabel: string;
    levelsVisible: boolean;
    campaignVisible: boolean;
    versusVisible: boolean;
  } {
    return {
      continueVisible: !continueBtn(root).classList.contains('hud-continue--hidden'),
      newGameVisible: !newGameBtn(root).classList.contains('hud-new-game--hidden'),
      newGameLabel: newGameBtn(root).textContent ?? '',
      levelsVisible: !levelSelectOpenBtn(root).classList.contains('hud-levelselect-open--hidden'),
      campaignVisible: !campaignOpenBtn(root).classList.contains('hud-campaign-open--hidden'),
      versusVisible: !versusOpenBtn(root).classList.contains('hud-versus-open--hidden'),
    };
  }

  /**
   * The outcome panel's half of this policy, which a session states on its own
   * projection since issue #324's step S4 -- `setRelaunchTarget` still answers it for
   * the title screen's buttons, and the two are asserted separately below.
   */
  const outcomeWithAction = (action: 'campaign-levels' | 'versus-setup'): GameplayOutcome => ({
    tally: 'solo',
    action,
    attempt: {
      shotsFired: 0, shellKills: 0, mineKills: 0, deaths: 0, selfKills: 0,
      friendlyFireKills: 0, minesLaid: 0, wallsDestroyed: 0, ricochets: 0,
    },
  });

  /**
   * The session's own half -- WHAT IS BEING PLAYED (issue #324, step S6). These cases
   * exist to prove the two halves stay apart, so each one pushes exactly one of them.
   * `mission`/`missions` are arguments because the outcome panel's copy reads them: a
   * FINAL win is `1, 1` and an intermediate one is `1, 2`.
   */
  const versusStatus = (mission: number, missions: number): GameplayStatus => ({
    kind: 'versus',
    mission,
    missions,
    stocks: [{ slot: 0, stock: 3 }],
  });
  const campaignStatus = (mission: number, missions: number): GameplayStatus => ({
    kind: 'campaign',
    mission,
    missions,
    lives: 3,
    enemies: 3,
  });

  it("the default target ('campaign-levels'), never calling setRelaunchTarget, is byte-identical to the title screen before this method existed", () => {
    // Fails if the default relaunchTarget is ever 'versus-setup', or if
    // applyTitleAffordances changes anything a campaign session's title screen showed
    // before this policy existed -- the "campaign flow is untouched" invariant.
    const { hud: h, root } = mount();
    h.setContinueAvailable(true);
    h.setLevelSelect(2, 4);
    h.setState('main-menu');
    expect(titleAffordances(root)).toEqual({
      continueVisible: true,
      newGameVisible: true,
      newGameLabel: 'Start New Campaign',
      levelsVisible: true,
      campaignVisible: false,
      versusVisible: true,
    });
  });

  it("an explicit setRelaunchTarget('campaign-levels') produces the IDENTICAL DOM as never calling it at all", () => {
    const { hud: h, root } = mount();
    h.setRelaunchTarget('campaign-levels');
    h.setContinueAvailable(true);
    h.setLevelSelect(2, 4);
    h.setState('main-menu');
    expect(titleAffordances(root)).toEqual({
      continueVisible: true,
      newGameVisible: true,
      newGameLabel: 'Start New Campaign',
      levelsVisible: true,
      campaignVisible: false,
      versusVisible: true,
    });
  });

  it("setRelaunchTarget('versus-setup') hides Continue and Levels-open, relabels New Game to 'Start Match' (kept VISIBLE, not hidden), and shows Campaign -- Versus stays visible either way", () => {
    // New Game is deliberately NOT hidden: unlike Continue, its handler
    // (loop.ts's onNewGame) always rebuilds the world via switchTo before
    // startPlaying(), and for a versus session it is the ONLY path from title into
    // the just-configured match (a versus session is never campaignActive(), so
    // nothing else reaches sm.startPlaying() from title once Levels is hidden).
    // Hiding it, as the controller ruling's literal text asked, would make a freshly
    // rebooted versus session unplayable through this UI -- see setRelaunchTarget's
    // own doc comment on the Hud interface.
    const { hud: h, root } = mount();
    h.setRelaunchTarget('versus-setup');
    h.setContinueAvailable(true); // a real campaign run is ALSO active -- see below
    h.setLevelSelect(2, 4); // a hypothetical multi-level versus system
    h.setState('main-menu');
    expect(titleAffordances(root)).toEqual({
      continueVisible: false,
      newGameVisible: true,
      newGameLabel: 'Start Match',
      levelsVisible: false,
      campaignVisible: true,
      versusVisible: true,
    });
  });

  it('is order-independent: setRelaunchTarget before or after setState/setContinueAvailable lands on the same DOM', () => {
    // Fails if `relaunchTarget` is only consulted INSIDE setState (e.g. a stale `s`
    // closed over rather than re-read live) -- that shape would leave Continue VISIBLE
    // when setRelaunchTarget runs after setState/setContinueAvailable, since those two
    // would have already computed visibility against the OLD (campaign) target.
    const before = mount();
    before.hud.setRelaunchTarget('versus-setup');
    before.hud.setContinueAvailable(true);
    before.hud.setState('main-menu');

    const after = mount();
    after.hud.setContinueAvailable(true);
    after.hud.setState('main-menu');
    after.hud.setRelaunchTarget('versus-setup');

    expect(titleAffordances(before.root)).toEqual(titleAffordances(after.root));
    // Sanity: hasProgress is true in both, so if the order bug above were present this
    // would read `continueVisible: true` for `after` instead.
    expect(titleAffordances(after.root).continueVisible).toBe(false);
    before.hud.dispose();
  });

  it("closes the corpse-world window: setContinueAvailable(true) pushed AFTER setState('main-menu') on a versus session still keeps Continue hidden", () => {
    // The discriminating case gating only inside setState would miss: loop.ts pushes
    // setContinueAvailable(deps.run.active() !== null) unconditionally on every
    // 'title' transition (not gated on tracksProgress), and `deps.run` is the SAME
    // store a versus session shares with campaign -- so this exact ordering fires
    // whenever a real campaign run is ALSO active, true for most returning players,
    // not an edge case.
    const { hud: h, root } = mount();
    h.setRelaunchTarget('versus-setup');
    h.setState('main-menu');
    h.setContinueAvailable(true);
    expect(continueBtn(root).classList.contains('hud-continue--hidden')).toBe(true);
  });

  it("the corpse-window closure holds under a second call order: setContinueAvailable(true) before win/lose/title (not just after title, as the case above covers) still keeps Continue hidden -- order-independence, not a trace of loop.ts's actual runtime call order", () => {
    // Mirrors the reachable sequence Task 5's own report traced but could not exercise
    // through its loop.test.ts fake (which only records calls, not real DOM/close-all
    // interactions): versus win/lose -> the setup pane's Back button (setState('main-menu'))
    // -> title, with Continue otherwise reachable via a concurrently active campaign
    // run. Fails if Continue's hide is gated on anything narrower than relaunchTarget
    // alone.
    const { hud: h, root } = mount();
    h.setRelaunchTarget('versus-setup');
    h.setContinueAvailable(true); // the shared run store says a campaign run is active
    h.setState('outcome-lose'); // the match just ended
    h.setState('main-menu'); // the pane's own Back button (Task 4) lands here
    expect(continueBtn(root).classList.contains('hud-continue--hidden')).toBe(true);
  });

  it("the win/lose action button reads 'Versus Setup' for a versus session's FINAL win and its lose -- truthful about what the click now does", () => {
    // Fails if the label branch is missing, or reads deps/state other than the
    // outcome's own `action` (e.g. always 'Versus Setup' regardless of it, which the
    // campaign-target tests elsewhere in this file would also have caught).
    //
    // The status pushed here is deliberately CAMPAIGN, not versus, even though a real
    // versus-setup session is versus by identity: that is what makes the case
    // discriminating. A versus status would let a label branch keyed on WHAT IS BEING
    // PLAYED produce the right words for the wrong reason -- measured on this branch, the
    // manifest entry `session-outcome-label-keyed-on-identity` stopped failing here the
    // moment this fixture stated a versus kind. `1, 1` is still the FINAL-win branch,
    // which is the one that carries the label.
    const { hud: h, root } = mount();
    h.setOutcome(outcomeWithAction('versus-setup'));
    h.setStatus(campaignStatus(1, 1));
    h.setState('outcome-win');
    expect(actionBtn(root).textContent).toBe('Versus Setup');
    h.setState('outcome-lose');
    expect(actionBtn(root).textContent).toBe('Versus Setup');
  });

  it('the outcome label follows a projection that lands AFTER the panel opened', () => {
    // The ordering production actually takes, and one the old boot-time-only source
    // could not have been wrong about: the state machine flips to `outcome-win` on the
    // winning frame's SimEvent, and the session's projection for that frame arrives
    // afterwards. A panel that painted its tally from the newest push and its button
    // from whatever was known when the panel opened would be half-applied -- so the
    // label is re-derived on every push that lands while an outcome is up.
    const { hud: h, root } = mount();
    h.setStatus(campaignStatus(1, 1)); // the FINAL win -- the branch that carries the label
    h.setState('outcome-win');
    expect(actionBtn(root).textContent).toBe('Play Again'); // the default, nothing pushed
    h.setOutcome(outcomeWithAction('versus-setup'));
    expect(actionBtn(root).textContent).toBe('Versus Setup');
    // ...and back again, so the assertion cannot pass on a setter that only ever
    // writes the versus wording once.
    h.setOutcome(outcomeWithAction('campaign-levels'));
    expect(actionBtn(root).textContent).toBe('Play Again');
  });

  it("leaves 'Resume' and 'Next Level' alone for a versus session -- neither click opens the pane, so relabeling either would be the same lie in reverse", () => {
    const { hud: h, root } = mount();
    h.setOutcome(outcomeWithAction('versus-setup'));
    h.setState('paused');
    expect(actionBtn(root).textContent).toBe('Resume');
    h.setStatus(campaignStatus(1, 2)); // an intermediate win -- not reachable for a real
    // versus session
    // (single synthetic level), but the label branch must not fire on it regardless
    h.setState('outcome-win');
    expect(actionBtn(root).textContent).toBe('Next Level');
  });

  it('onCampaignOpen fires once per Campaign button click', () => {
    const { hud: h, root } = mount();
    h.setRelaunchTarget('versus-setup');
    h.setState('main-menu');
    let opens = 0;
    h.onCampaignOpen(() => opens++);
    campaignOpenBtn(root).dispatchEvent(new MouseEvent('click'));
    expect(opens).toBe(1);
  });

  it('Campaign is a title-only affordance, even for a versus session', () => {
    const { hud: h, root } = mount();
    h.setRelaunchTarget('versus-setup');
    h.setState('main-menu');
    expect(campaignOpenBtn(root).classList.contains('hud-campaign-open--hidden')).toBe(false);
    for (const s of ['paused', 'outcome-win', 'outcome-lose'] as const) {
      h.setState(s);
      expect(campaignOpenBtn(root).classList.contains('hud-campaign-open--hidden'), s).toBe(true);
    }
  });

  // -------------------------------------------------------------------------
  // THE SEPARATION ITSELF (issue #316 review, finding 1). Each direction gets
  // its own negative control, because a regression that collapsed the two
  // concepts back into one value would break exactly one of them.
  // -------------------------------------------------------------------------

  it("a versus STATUS alone changes NO title affordance -- identity is not the button policy", () => {
    // The developer-flag versus shape (`?dev=1&mode=ffa`): Versus identity, campaign
    // relaunch target. Fails if any button gate is keyed on sessionKind -- Continue
    // would vanish, New Game would read 'Start Match', and the Campaign button would
    // appear, on a session whose Continue and Levels still rebuild correct FFA worlds.
    const kindOnly = mount();
    kindOnly.hud.setStatus(versusStatus(1, 1));
    kindOnly.hud.setContinueAvailable(true);
    kindOnly.hud.setLevelSelect(2, 4);
    kindOnly.hud.setState('main-menu');

    const neither = mount();
    neither.hud.setContinueAvailable(true);
    neither.hud.setLevelSelect(2, 4);
    neither.hud.setState('main-menu');

    expect(titleAffordances(kindOnly.root)).toEqual(titleAffordances(neither.root));
    // Sanity that the fixture is the campaign-shaped one, not two identically broken
    // screens: an assertion comparing two DOMs cannot fail if both are wrong.
    expect(titleAffordances(kindOnly.root)).toEqual({
      continueVisible: true,
      newGameVisible: true,
      newGameLabel: 'Start New Campaign',
      levelsVisible: true,
      campaignVisible: false,
      versusVisible: true,
    });
    kindOnly.hud.dispose();
    neither.hud.dispose();
  });

  it("a versus STATUS alone leaves the outcome action button reading 'Play Again'/'Retry'", () => {
    // The label names the click's DESTINATION, and loop.ts's onStartRestart routes a
    // developer-flag versus session through landOnCampaignBoard -- so 'Versus Setup'
    // here would name a pane the click never opens. Nothing is pushed to setOutcome,
    // so this also pins the default: a HUD told only WHAT IS BEING PLAYED still says
    // the campaign words. Fails if the label branch is keyed on sessionKind.
    const { hud: h, root } = mount();
    h.setStatus(versusStatus(1, 1)); // the FINAL win -- the branch that carries the label
    h.setState('outcome-win');
    expect(actionBtn(root).textContent).toBe('Play Again');
    h.setState('outcome-lose');
    expect(actionBtn(root).textContent).toBe('Retry');
  });

  it("setRelaunchTarget('versus-setup') alone hides NO campaign stat and shows NO stock strip -- the button policy is not identity", () => {
    // The other direction: a regression that reused the title policy as gameplay
    // identity would blank Lives/Enemies and surface the stock strip on the strength
    // of a button-shape decision.
    const { hud: h, root } = mount();
    h.setRelaunchTarget('versus-setup');
    h.setStatus(campaignStatus(1, 1));
    h.setState('playing');
    for (const el of Array.from(root.querySelectorAll('.hud-campaign-stat'))) {
      expect(el.classList.contains('hud-campaign-stat--hidden')).toBe(false);
    }
    expect(
      (root.querySelector('.hud-versus-stocks') as HTMLElement).classList.contains(
        'hud-versus-stocks--hidden',
      ),
    ).toBe(true);
  });

  it("a PRACTICE status shows the campaign stats, exactly as a campaign one does", () => {
    // Practice is a campaign board played in isolation: its lives and enemy count are
    // as real there as in a run. Fails if the stat gate is widened to `!== 'campaign'`,
    // which is the tempting shape once the setter takes three kinds.
    const practice = mount();
    practice.hud.setStatus({ kind: 'practice', mission: 1, missions: 1, lives: 3, enemies: 3 });
    practice.hud.setState('playing');
    for (const el of Array.from(practice.root.querySelectorAll('.hud-campaign-stat'))) {
      expect(el.classList.contains('hud-campaign-stat--hidden')).toBe(false);
    }
    // ...and its title affordances are campaign-shaped too.
    practice.hud.setContinueAvailable(true);
    practice.hud.setLevelSelect(2, 4);
    practice.hud.setState('main-menu');
    expect(titleAffordances(practice.root).newGameLabel).toBe('Start New Campaign');
    expect(titleAffordances(practice.root).campaignVisible).toBe(false);
    practice.hud.dispose();
  });

  it('a MID-SESSION kind change re-gates both gameplay surfaces, in both directions', () => {
    // A Levels pick makes a campaign session Practice and landing back on its home
    // board makes it Campaign again, so the kind is no longer fixed for a session's
    // life. Fails if either surface is computed once at the first setState and never
    // recomputed -- the shape the old "fixed for the session's whole life" comment
    // licensed.
    const { hud: h, root } = mount();
    const stocksEl = root.querySelector('.hud-versus-stocks') as HTMLElement;
    const statHidden = (): boolean =>
      (root.querySelector('.hud-campaign-stat') as HTMLElement).classList.contains(
        'hud-campaign-stat--hidden',
      );
    h.setStatus(campaignStatus(1, 1));
    h.setState('playing');
    expect(statHidden()).toBe(false);
    expect(stocksEl.classList.contains('hud-versus-stocks--hidden')).toBe(true);

    // ...now the same live session becomes versus, with NO intervening setState.
    h.setStatus({ kind: 'versus', mission: 1, missions: 1, stocks: [{ slot: 0, stock: 3 }] });
    expect(statHidden()).toBe(true);
    expect(stocksEl.classList.contains('hud-versus-stocks--hidden')).toBe(false);

    // ...and back again.
    h.setStatus(campaignStatus(1, 1));
    expect(statHidden()).toBe(false);
    expect(stocksEl.classList.contains('hud-versus-stocks--hidden')).toBe(true);
  });

  it('roving tabindex reaches the Campaign button on a versus-kind title screen', () => {
    // hud.ts's focusableControls is a GENERIC `button, [tabindex]` sweep of whatever is
    // visible inside the active panel container -- not a hardcoded class list -- so a
    // new title-panel button is reachable for free. This pins that it actually IS, the
    // same shape as the versus setup pane's own "reaches Start, then Back" test: a
    // bounded ArrowDown walk (not unbounded -- an unreachable control must fail loudly
    // here rather than hang the suite the way flipping the default did in this
    // policy's own mutation testing).
    const { hud: h, root } = mount();
    h.setRelaunchTarget('versus-setup');
    h.setState('main-menu');
    expect(document.activeElement, 'opening the title panel did not focus its CONTAINER').toBe(
      root.querySelector('.hud-panel'),
    );
    let steps = 0;
    while (document.activeElement !== campaignOpenBtn(root) && steps < 40) {
      (document.activeElement as HTMLElement).dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
      );
      steps += 1;
    }
    expect(document.activeElement, 'never reached the Campaign button').toBe(campaignOpenBtn(root));
  });
});

describe('the UI kit contracts, swept across every control that uses them (issue #321)', () => {
  function mountEveryChoice(): { hud: Hud; root: HTMLElement } {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const h = createHud(root);
    h.setLevelSelect(2, 4);
    h.setBotAssignmentAllowed(true);
    h.setDetectedPads([{ padIndex: 1, id: 'Test Pad' }]);
    h.setControllers([{ kind: 'keyboard' }, { kind: 'gamepad', padIndex: 1 }]);
    // The paint shop's three rows render their selection when the game TELLS the HUD
    // what is stored -- `setHullColor`/`setSkin`/`setAccentColor`, the same calls
    // `loop.ts` makes at boot -- not at construction. A freshly built HUD shows no ring
    // on them and, equally, announces no pressed state; that symmetry is the point, and
    // driving the setters here is what puts those 18 controls inside the sweep at all
    // rather than leaving them permanently unselected and permanently unannounced.
    h.setHullColor((root.querySelector('.hud-swatch[data-hull]') as HTMLElement).dataset.hull as never);
    h.setSkin((root.querySelector('.hud-skin') as HTMLElement).dataset.skin as never);
    h.setAccentColor((root.querySelector('.hud-swatch[data-accent]') as HTMLElement).dataset.accent as never);
    return { hud: h, root };
  }

  const selectables = (root: HTMLElement): HTMLButtonElement[] =>
    Array.from(root.querySelectorAll('button.ui-selectable'));

  it('announces the current choice on EVERY choice control, not only draws it', () => {
    // Before `setSelected`, the hull swatches, accent swatches, skins, controller
    // sources and versus options each toggled a class of their own and told assistive
    // technology nothing: the current choice was a white border and nothing else.
    const { root } = mountEveryChoice();
    const btns = selectables(root);
    // Exactly, not a lower bound -- this is the sweep's denominator, and it is measured
    // against THIS fixture rather than derived: 11 swatches in the paint shop (PALETTE 6
    // + ACCENTS 5, which share `.hud-swatch`) + 7 skins (SKINS) + 8 in the Controllers
    // panel (2 slots x [Keyboard/Bot/None + 1 detected pad]) + 23 in the versus pane
    // (17 option buttons -- Mode 2, Players 3, Map 7, Stock 5 -- plus its who's-playing
    // ROLE buttons, 2 slots x [Human/Bot/Off] = 6). Map went 6 -> 7 with issue #271's
    // vs-duel-01, offered at the N=2 this fixture defaults to.
    //
    // 23 and not 25 since issue #260: the who's-playing block used to contribute 8
    // (2 slots x [Keyboard/Bot/None + 1 pad]) as a DEVICE preview reusing the
    // Controllers panel's own candidate rows. It renders per-slot ROLES now, and three
    // roles per slot is 6. A different slot, pad or player count pins a different
    // number; the number moving is the prompt to check the new row is inside the sweep
    // rather than beside it.
    //
    // 26 and not 23 since issue #267: a BOT slot also offers Easy/Normal/Hard.
    // `defaultSlots(2)` is `[human, bot]`, so exactly one slot carries them at this
    // fixture's player count -- 3 buttons, not 6. Re-derived, not incremented: the count
    // depends on how many slots are bots, so a fixture that defaulted both slots to Bot
    // would pin 29 here.
    //
    // +4 since issue #226: the Records tab pair, which appears in BOTH the Stats and the
    // Achievements pane so that each reads as one destination with two views. Their
    // selected state is STATIC -- a pane's own tab is always the current one -- so they
    // are the sweep's only members that never move, which is exactly why they have to be
    // in it: a static `aria-pressed` that disagreed with its static class would be
    // invisible to any test that only watched controls change.
    expect(btns.length).toBe(11 + 7 + 8 + 26 + 4);
    const missing = btns
      .filter((b) => !b.hasAttribute('aria-pressed'))
      .map((b) => Array.from(b.classList).join('.'));
    expect(missing, 'choice controls with no announced state').toEqual([]);
    // ...and the two channels agree, control for control. A helper that wrote the
    // attribute once at build time and then only moved the class would pass the sweep
    // above and fail here.
    const disagree = btns
      .filter((b) => (b.getAttribute('aria-pressed') === 'true')
        !== b.classList.contains('ui-selectable--on'))
      .map((b) => Array.from(b.classList).join('.'));
    expect(disagree, 'the ring and the announced state disagree').toEqual([]);
    // Not vacuous: something IS selected in this fixture, so the agreement above is not
    // "every control is false" agreeing with "no control has the class".
    expect(btns.filter((b) => b.getAttribute('aria-pressed') === 'true').length)
      .toBeGreaterThan(0);
  });

  it('moves the announced state with the choice, not only on the first render', () => {
    const { hud: h, root } = mountEveryChoice();
    const skins = () => Array.from(root.querySelectorAll('.hud-skin')) as HTMLButtonElement[];
    const pressed = () => skins().map((b) => b.getAttribute('aria-pressed'));
    const before = pressed();
    const other = skins().find((b) => b.getAttribute('aria-pressed') !== 'true')!;
    h.setSkin(other.dataset.skin as never);
    expect(pressed()).not.toEqual(before);
    expect(other.getAttribute('aria-pressed')).toBe('true');
    expect(pressed().filter((v) => v === 'true')).toHaveLength(1);
  });

  it('associates a locked level with the line that says why it is locked', () => {
    const { hud: h, root } = mountEveryChoice();
    const note = root.querySelector('#hud-levels-note') as HTMLElement;
    expect(note, 'the level picker has no reason line').not.toBeNull();
    expect(note.textContent).toContain('unlock');
    expect(note.classList.contains('hud-levels-note--hidden')).toBe(false);

    const btns = Array.from(root.querySelectorAll('.hud-level-btn')) as HTMLButtonElement[];
    // setLevelSelect(2, 4): levels 1-2 open, 3-4 locked.
    expect(btns.map((b) => b.disabled)).toEqual([false, false, true, true]);
    expect(btns.map((b) => b.getAttribute('aria-describedby')))
      .toEqual([null, null, 'hud-levels-note', 'hud-levels-note']);

    // Nothing locked: the reason goes away rather than explaining a state the player is
    // no longer in, and no button is left pointing at a line that is not on screen.
    h.setLevelSelect(4, 4);
    expect(note.classList.contains('hud-levels-note--hidden')).toBe(true);
    const after = Array.from(root.querySelectorAll('.hud-level-btn')) as HTMLButtonElement[];
    expect(after.map((b) => b.getAttribute('aria-describedby'))).toEqual([null, null, null, null]);
  });

  it("associates a refused Start with the reason, and describes the Controllers panel's real rows with nothing", () => {
    // SUPERSEDES the versus half of this test. It used to assert that the pane's
    // who's-playing PREVIEW buttons pointed at #hud-versus-assignment-note while
    // disabled -- those buttons are gone (issue #260), and the pane's disabled control
    // is now Start itself, whose reason moves with the problem.
    const { root } = mountEveryChoice();
    const described = (sel: string): (string | null)[] =>
      Array.from(root.querySelectorAll(`${sel} .hud-controller-source-btn`))
        .map((b) => b.getAttribute('aria-describedby'));
    // The standalone Controllers panel reassigns for real: its buttons need no excuse.
    expect(new Set(described('.hud-controllers'))).toEqual(new Set([null]));
    expect(described('.hud-controllers').length).toBeGreaterThan(0);
    // ...and the versus pane no longer renders any of those buttons at all.
    expect(described('.hud-versus-setup'), 'the device preview should be gone').toEqual([]);

    const start = root.querySelector('.hud-versus-start') as HTMLButtonElement;
    expect(start.disabled, 'the fixture default is startable').toBe(false);
    expect(start.getAttribute('aria-describedby'), 'an allowed Start needs no excuse').toBeNull();

    // Refuse it, and the association appears with the reason -- not merely near it.
    (root.querySelector('.hud-versus-slot-row[data-slot="0"] .hud-versus-role-btn[data-role="none"]') as HTMLButtonElement)
      .click();
    expect(start.disabled).toBe(true);
    const id = start.getAttribute('aria-describedby');
    expect(id).toBe('hud-versus-slot-reason-0');
    const reason = root.querySelector(`#${id}`) as HTMLElement;
    expect(reason, 'aria-describedby points at no element').not.toBeNull();
    expect(reason.textContent, 'the referenced element is empty, so the excuse says nothing')
      .not.toBe('');
  });
});

/*
 * ISSUE #226: the replace-run confirmation.
 *
 * Here rather than with the menu composition it belongs to, because every property it has
 * is a layer-stack property: it is this file's first `overlay`, a route may not open
 * under it, Back cancels it, a surface change dismisses it, and answering it has to
 * restore the control that asked.
 */
describe('hud: the replace-run confirmation (issue #226)', () => {
  const q = (root: HTMLElement, sel: string): HTMLButtonElement =>
    root.querySelector(sel) as HTMLButtonElement;
  const click = (root: HTMLElement, sel: string): void => {
    q(root, sel).dispatchEvent(new MouseEvent('click'));
  };
  const confirmOpen = (root: HTMLElement): boolean =>
    !(root.querySelector('.hud-confirm') as HTMLElement).classList.contains('hud-confirm--hidden');

  it('is announced as a modal, and earns that claim: focus cannot rove out of it into the menu behind', () => {
    // `aria-modal="true"` is a promise that nothing outside this is reachable while it is
    // open, so it is asserted TOGETHER with the behaviour that makes it true rather than
    // on its own. The menu stays on screen behind the scrim -- that is what a modal IS --
    // so the load-bearing property is that the roving focus walks the confirmation's own
    // controls and never lands on a menu button. Asserted through the arrow keys, which
    // is the same path a D-pad takes (issues #494, #495).
    vi.useFakeTimers();
    try {
      const { hud: h, root } = mount();
      h.setState('main-menu');
      const confirm = root.querySelector('.hud-confirm') as HTMLElement;
      expect(confirm.getAttribute('role')).toBe('alertdialog');
      expect(confirm.getAttribute('aria-modal')).toBe('true');

      h.setContinueAvailable(true); // only a run that would be LOST is worth asking about
      click(root, '.hud-new-game');
      vi.advanceTimersByTime(1000); // let the crossfade finish, so nothing is mid-transition
      expect(confirmOpen(root), 'the confirmation did not open').toBe(true);

      const inside = [...confirm.querySelectorAll('button')];
      expect(inside.map((b) => b.className.includes('hud-confirm-cancel') || b.className.includes('hud-confirm-accept')))
        .toEqual([true, true]);
      for (let i = 0; i < 6; i++) {
        (document.activeElement ?? document.body).dispatchEvent(
          new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
        );
        expect(confirm.contains(document.activeElement), `step ${i} left the confirmation`).toBe(true);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('is asked only when an active run would be lost', () => {
    // The acceptance criterion, both ways round. With no run the same button is "Start
    // Campaign" and starting is not destructive, so a confirmation there would be
    // friction with nothing to protect.
    const { hud: h, root } = mount();
    const starts: number[] = [];
    h.onNewGame(() => starts.push(1));
    h.setState('main-menu');

    click(root, '.hud-new-game');
    expect(confirmOpen(root), 'no run, and it still asked').toBe(false);
    expect(starts, 'the direct path did not start a campaign').toEqual([1]);

    h.setContinueAvailable(true);
    click(root, '.hud-new-game');
    expect(confirmOpen(root), 'a run would be replaced and it did not ask').toBe(true);
    expect(starts, 'opening the question already started the campaign').toEqual([1]);
  });

  it('names the run it would replace', () => {
    // "Are you sure?" over an unnamed loss is the wording that gets clicked through. The
    // body is written at OPEN, from the summary the menu is already showing, so it cannot
    // describe a run the player is not looking at.
    const { hud: h, root } = mount();
    h.setState('main-menu');
    h.setContinueAvailable(true);
    h.setCampaignRun({ mission: 4, total: 8, lives: 1 });
    click(root, '.hud-new-game');
    const body = root.querySelector('.hud-confirm-body') as HTMLElement;
    expect(body.textContent).toBe(
      'Mission 4 of 8 -- 1 life left. Starting a new campaign replaces it. This cannot be undone.',
    );
  });

  it('Cancel starts nothing and returns to the menu; Confirm starts exactly one campaign', () => {
    vi.useFakeTimers();
    try {
      const { hud: h, root } = mount();
      const starts: number[] = [];
      h.onNewGame(() => starts.push(1));
      h.setState('main-menu');
      h.setContinueAvailable(true);

      click(root, '.hud-new-game');
      click(root, '.hud-confirm-cancel');
      vi.advanceTimersByTime(1000);
      expect(starts, 'Cancel started a campaign').toEqual([]);
      expect(confirmOpen(root), 'Cancel left the question up').toBe(false);
      expect(
        (root.querySelector('.hud-panel') as HTMLElement).classList.contains('hud-panel--hidden'),
        'Cancel did not return to the menu',
      ).toBe(false);
      // ...and focus is back on the control that asked, so a keyboard player who cancels
      // is standing where they were rather than at the top of the panel.
      expect(document.activeElement).toBe(q(root, '.hud-new-game'));

      click(root, '.hud-new-game');
      click(root, '.hud-confirm-accept');
      vi.advanceTimersByTime(1000);
      expect(starts, 'Confirm did not start exactly one campaign').toEqual([1]);
      expect(confirmOpen(root), 'Confirm left the question up').toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is a BLOCKING layer: no route opens under an unanswered question', () => {
    // The one structural difference between an overlay and a route (`navigation.ts`):
    // a route may never be pushed over an overlay. Without it a menu button reached by
    // the keyboard behind the confirmation would open a pane UNDER it, and the Back that
    // dismissed the question would land on a screen the player never asked for.
    const { hud: h, root } = mount();
    h.setState('main-menu');
    h.setContinueAvailable(true);
    click(root, '.hud-new-game');
    expect(confirmOpen(root)).toBe(true);

    click(root, '.hud-records-open');
    expect(
      (root.querySelector('.hud-stats') as HTMLElement).classList.contains('hud-stats--hidden'),
      'a route opened under the confirmation',
    ).toBe(true);
    expect(confirmOpen(root), 'the confirmation was replaced by a route').toBe(true);

    // NEGATIVE CONTROL: the same click with no question up really does open the pane, so
    // the assertion above is about the overlay and not about a broken Records button.
    expect(h.back()).toBe(true);
    click(root, '.hud-records-open');
    expect(
      (root.querySelector('.hud-stats') as HTMLElement).classList.contains('hud-stats--hidden'),
    ).toBe(false);
  });

  it('Back cancels it, and a surface change dismisses it rather than letting it outlive the menu', () => {
    const { hud: h, root } = mount();
    const starts: number[] = [];
    h.onNewGame(() => starts.push(1));
    h.setState('main-menu');
    h.setContinueAvailable(true);

    click(root, '.hud-new-game');
    expect(h.back(), 'Back did not consume the confirmation').toBe(true);
    expect(starts, 'Back answered the question').toEqual([]);

    click(root, '.hud-new-game');
    h.setState('playing');
    expect(confirmOpen(root), 'the question survived a surface change').toBe(false);
    expect(h.back(), 'the confirmation was left on the layer stack').toBe(false);
    expect(starts, 'a surface change answered the question').toEqual([]);
  });

  it('puts the safe answer first, so a blind Confirm cannot delete a run', () => {
    // `act('confirm')` on a freshly arrived pane lands focus on the FIRST control rather
    // than activating it (issue #494), and the first ArrowDown from a container lands
    // there too. Both make the first control the one a hurried player reaches, which is
    // why the destructive answer is second.
    const { hud: h, root } = mount();
    const starts: number[] = [];
    h.onNewGame(() => starts.push(1));
    h.setState('main-menu');
    h.setContinueAvailable(true);
    click(root, '.hud-new-game');

    expect(h.act('confirm'), 'the pane did not take the action').toBe(true);
    expect(document.activeElement, 'the first control is not the safe answer').toBe(
      q(root, '.hud-confirm-cancel'),
    );
    expect(starts, 'a single blind Confirm replaced the run').toEqual([]);
  });
});

describe('hud: navigation layers -- origin, Back and focus restoration (issue #318)', () => {
  const click = (el: Element, detail = 0): void => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail }));
  };
  const q = (root: HTMLElement, sel: string): HTMLElement => root.querySelector(sel) as HTMLElement;
  const isHidden = (root: HTMLElement, sel: string, cls: string): boolean => q(root, sel).classList.contains(cls);
  const cfg = (players: 2 | 3 | 4): VersusConfig => ({
    mode: 'ffa',
    players,
    arenaId: 'arena-02',
    stock: 3,
    friendlyFire: false,
    slots: defaultSlots(players),
  });
  function mountWith(opts: Parameters<typeof createHud>[1]): { hud: Hud; root: HTMLElement } {
    const root = document.createElement('div');
    document.body.appendChild(root);
    hud = createHud(root, opts);
    return { hud, root };
  }

  it('Controllers opened from PAUSED returns to paused, focuses the Controllers button, and the narrowed pause hotkey accepts that target', () => {
    // The one Back that could never hard-code its destination is now the ordinary case:
    // the layer records the surface it was pushed over. And the control it returns focus
    // to is a BUTTON, which is only a working place to leave a paused player because
    // loop.ts's guard no longer treats a button as a control that consumes Escape.
    vi.useFakeTimers();
    try {
      const { hud: h, root } = mount();
      h.setState('main-menu');
      h.setState('playing');
      h.setState('paused');
      const opener = q(root, '.hud-controllers-open');
      click(opener);
      expect(isHidden(root, '.hud-controllers', 'hud-controllers--hidden')).toBe(false);
      expect(document.activeElement, 'opening focuses the pane container').toBe(q(root, '.hud-controllers'));
      click(q(root, '.hud-controllers-back'));
      vi.advanceTimersByTime(1000);
      expect(isHidden(root, '.hud-controllers', 'hud-controllers--hidden')).toBe(true);
      expect(q(root, '.hud-action').textContent, 'Back abandoned the paused round').toBe('Resume');
      expect(document.activeElement, 'Back did not return focus to the Controllers button').toBe(opener);
      const escape = { key: 'Escape', repeat: false, target: opener } as unknown as KeyboardEvent;
      expect(isPauseHotkey(escape), 'Escape is dead on the restored opener').toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a pane opened programmatically (showVersusSetup(true) at the title) falls back to the panel container on Back', () => {
    // The post-match "Versus Setup" reopen (loop.ts) invokes no control, so there is
    // nothing to restore focus to: the destination container stands, as it always did.
    // Kills an unguarded `opener.focus()` -- a null opener would throw there.
    const { hud: h, root } = mount();
    h.setState('main-menu');
    h.showVersusSetup(true);
    expect(document.activeElement).toBe(q(root, '.hud-versus-setup'));
    click(q(root, '.hud-versus-back'));
    expect(document.activeElement).toBe(q(root, '.hud-panel'));
  });

  it('Back falls back to the panel container when the opener was hidden while the pane was up', () => {
    // `setLevelSelect(1, 1)` hides the Levels button ("the sandbox is not a choice") and
    // can land while the Levels pane is open. Focusing a hidden button would strand a
    // keyboard player with no visible position, which is what the container rule
    // exists to prevent.
    const { hud: h, root } = mount();
    h.setLevelSelect(2, 3);
    h.setState('main-menu');
    const opener = q(root, '.hud-levelselect-open');
    expect(opener.classList.contains('hud-levelselect-open--hidden')).toBe(false);
    click(opener);
    h.setLevelSelect(1, 1);
    click(q(root, '.hud-levelselect-back'));
    expect(opener.classList.contains('hud-levelselect-open--hidden'), 'the fixture no longer hides the opener').toBe(true);
    expect(document.activeElement).toBe(q(root, '.hud-panel'));
  });

  it('hud.back() pops one layer and reports true; with nothing open it reports false and changes no class', () => {
    // The controller seam (issue #319 maps gamepad B here). `false` is what lets the
    // caller fall through to its own Back meaning, so a `back()` that reported true
    // with nothing open would swallow every gamepad Back at the Main Menu.
    const { hud: h, root } = mount();
    h.setState('main-menu');
    const surfaces = ['.hud-panel', '.hud-stats', '.hud-customize', '.hud-achievements',
      '.hud-levelselect', '.hud-controllers', '.hud-versus-setup', '.hud-settings',
      '.hud-about', '.hud-confirm'];
    const snapshot = (): string[] => surfaces.map((sel) => q(root, sel).className);
    const before = snapshot();
    expect(h.back()).toBe(false);
    expect(snapshot()).toEqual(before);
    const opener = q(root, '.hud-records-open');
    click(opener);
    expect(h.back()).toBe(true);
    expect(q(root, '.hud-stats').classList.contains('ui-surface--leaving'), 'the pane is not on its way out').toBe(true);
    expect(document.activeElement).toBe(opener);
  });

  it('a pointer-initiated Back click still lands focus on the opener', () => {
    // `blurIfPointer` blurs the clicked BACK button after its handler; the restore has
    // already moved focus to the opener by then, so it survives. The spec names the
    // invoking control without a modality.
    const { hud: h, root } = mount();
    h.setState('main-menu');
    const opener = q(root, '.hud-about-open');
    click(opener, 1);
    click(q(root, '.hud-about-back'), 1);
    expect(document.activeElement).toBe(opener);
  });

  it('entering gameplay from an open pane empties the stack: hud.back() then has nothing to pop', () => {
    // Every surface change resets the stack, so a layer can never outlive the surface it
    // opened over -- a ghost layer here would swallow the first Escape of the match.
    const { hud: h, root } = mount();
    h.setState('main-menu');
    click(q(root, '.hud-records-open'));
    expect(h.back(), 'the pane did not open').toBe(true);
    click(q(root, '.hud-records-open'));
    h.setState('playing');
    expect(isHidden(root, '.hud-stats', 'hud-stats--hidden')).toBe(true);
    expect(h.back(), 'gameplay entry left a layer on the stack').toBe(false);
  });

  it('Back fires no start, pick, reset, quit, pause, setup or open callback, leaves no reset armed, and writes nothing to the retained VS store', () => {
    // The HUD-level proof of "Back never resets a run or changes persisted settings":
    // hud.ts reaches no store, run or state machine itself, so what it must not do is
    // fire the callbacks through which the page does. Population: all six Back buttons
    // and `hud.back()`. The two negative controls at the end prove the spies and the
    // store counter are live.
    const storage = createMemoryStorage();
    const real = createVersusSetupStore(storage);
    let writes = 0;
    const { hud: h, root } = mountWith({
      versusSetup: {
        get: () => real.get(),
        set: (setup) => {
          writes += 1;
          real.set(setup);
        },
        clear: () => real.clear(),
      },
    });
    const fired: string[] = [];
    h.onStartRestart(() => fired.push('start'));
    h.onNewGame(() => fired.push('new-game'));
    h.onLevelSelect((level) => fired.push(`pick:${level}`));
    h.onResetStats(() => fired.push('reset-stats'));
    h.onResetProgress(() => fired.push('reset-progress'));
    h.onQuitToTitle(() => fired.push('quit'));
    h.onPauseTap(() => fired.push('pause'));
    h.onVersusStart(() => fired.push('versus-start'));
    h.onVersusOpen(() => fired.push('versus-open'));
    h.onCampaignOpen(() => fired.push('campaign-open'));
    h.setLevelSelect(3, 3);
    h.setState('main-menu');
    // Population: every pane with an opener and a Back button. Achievements is reached
    // through the Records tab inside the Stats pane since issue #226, and Controllers
    // through Settings -> Controls, which is why those two rows name an opener that lives
    // inside another pane rather than on the menu.
    const pairs: Array<[string, string]> = [
      ['.hud-records-open', '.hud-stats-back'],
      ['.hud-customize-open', '.hud-customize-back'],
      ['.hud-stats .hud-records-tab-achievements', '.hud-achievements-back'],
      ['.hud-levelselect-open', '.hud-levelselect-back'],
      ['.hud-settings-open', '.hud-settings-back'],
      ['.hud-settings-controllers', '.hud-controllers-back'],
      ['.hud-about-open', '.hud-about-back'],
    ];
    for (const [open, back] of pairs) {
      click(q(root, open));
      click(q(root, back));
    }
    h.showVersusSetup(true); // the sixth pane, opened without its passthrough button
    click(q(root, '.hud-versus-back'));
    h.showVersusSetup(true);
    expect(h.back()).toBe(true);
    expect(fired).toEqual([]);
    expect(writes).toBe(0);
    expect(root.querySelector('.hud-danger--armed')).toBeNull();
    // Negative controls: a role click writes once, Start fires once.
    h.showVersusSetup(true);
    click(q(root, '.hud-versus-slot-row[data-slot="1"] .hud-versus-role-btn[data-role="bot"]'));
    expect(writes).toBe(1);
    click(q(root, '.hud-versus-start'));
    expect(fired).toEqual(['versus-start']);
  });

  it('showVersusSetup(true, cfg) twice keeps the pane open and reseeds from the second config', () => {
    // Before issue #318 the second call ran a transition from the pane to ITSELF, which
    // marked the one surface LEAVING then ENTERING and hid it when the crossfade
    // settled -- measured failing on the pre-#318 tree with exactly this case. The
    // stack reports the pane as already on top, and the HUD re-renders in place.
    vi.useFakeTimers();
    try {
      const { hud: h, root } = mount();
      h.setState('main-menu');
      h.showVersusSetup(true, cfg(2));
      h.showVersusSetup(true, cfg(4));
      vi.advanceTimersByTime(1000);
      expect(isHidden(root, '.hud-versus-setup', 'hud-versus-setup--hidden'), 'the second open hid the pane').toBe(false);
      expect(root.querySelectorAll('.hud-versus-slot-row'), 'the second config did not reseed the pane').toHaveLength(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a pane opened while a different pane is up replaces it through that pane's own close, so its close callback fires once", () => {
    // Covering Customize would leave its live preview alive with no close callback;
    // refusing would break the transition contract's "second navigation wins". Replacing
    // does neither: the covered pane leaves through the same path its Back uses.
    vi.useFakeTimers();
    try {
      const { hud: h, root } = mount();
      let opens = 0;
      let closes = 0;
      h.onCustomizeOpen(() => {
        opens += 1;
      });
      h.onCustomizeClose(() => {
        closes += 1;
      });
      h.setState('main-menu');
      click(q(root, '.hud-customize-open'));
      expect(opens).toBe(1);
      h.showVersusSetup(true);
      vi.advanceTimersByTime(1000);
      expect(closes, "the covered pane's close callback").toBe(1);
      expect(isHidden(root, '.hud-customize', 'hud-customize--hidden')).toBe(true);
      expect(isHidden(root, '.hud-versus-setup', 'hud-versus-setup--hidden')).toBe(false);
      // ...and the replacement kept the ORIGINAL origin: Back lands on the title.
      click(q(root, '.hud-versus-back'));
      vi.advanceTimersByTime(1000);
      expect(isHidden(root, '.hud-versus-setup', 'hud-versus-setup--hidden')).toBe(true);
      expect(isHidden(root, '.hud-panel', 'hud-panel--hidden')).toBe(false);
      expect(closes, 'a second close fired for a pane that was already closed').toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('hud: Escape is Back while a layer is open (issue #318)', () => {
  const click = (el: Element): void => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }));
  };
  const q = (root: HTMLElement, sel: string): HTMLElement => root.querySelector(sel) as HTMLElement;
  /** A key pressed where the browser would deliver it: at the focused element, bubbling. */
  const press = (key: string, init: KeyboardEventInit = {}): void => {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }),
    );
  };

  it('Escape closes the top pane, restores the opener, and never reaches a bubble-phase window listener; with no pane it reaches it and changes no surface', () => {
    // The bubble-phase window listener stands in for route-host's `onHostKey`, which
    // forwards to the session's pause hotkey. An Escape that closed a pane and ALSO
    // reached it would resume a paused round underneath the pane it just closed.
    const seen: string[] = [];
    const bubble = (e: KeyboardEvent): void => {
      seen.push(e.key);
    };
    window.addEventListener('keydown', bubble);
    try {
      const { hud: h, root } = mount();
      h.setState('main-menu');
      const opener = q(root, '.hud-customize-open');
      click(opener);
      expect(document.activeElement).toBe(q(root, '.hud-customize'));
      press('Escape', { repeat: true });
      expect(q(root, '.hud-customize').classList.contains('ui-surface--leaving'), 'an auto-repeat Escape was claimed').toBe(false);
      expect(seen, 'the repeat should fall through').toEqual(['Escape']);
      press('Escape');
      expect(q(root, '.hud-customize').classList.contains('ui-surface--leaving'), 'Escape did not close the pane').toBe(true);
      expect(document.activeElement, 'Escape did not restore the opener').toBe(opener);
      expect(seen, 'the Escape that closed a pane leaked to the bubble listener').toEqual(['Escape']);
      press('Escape');
      expect(seen, 'Escape with nothing to close must fall through').toEqual(['Escape', 'Escape']);
      expect(q(root, '.hud-panel').classList.contains('hud-panel--hidden')).toBe(false);
      expect(h.back(), 'a second Escape popped something').toBe(false);
    } finally {
      window.removeEventListener('keydown', bubble);
    }
  });

  it('Escape with Controllers open over Pause returns to Pause and fires onControllersClose exactly once; a second Escape is not consumed', () => {
    // The spec's "from Pause with no deeper overlay, resume": the first Escape consumes
    // the layer, the second is the session's. Both halves through one chokepoint, so
    // the close callback (route-ui's gamepad listeners) fires once, not twice and not
    // never.
    vi.useFakeTimers();
    const seen: string[] = [];
    const bubble = (e: KeyboardEvent): void => {
      seen.push(e.key);
    };
    window.addEventListener('keydown', bubble);
    try {
      const { hud: h, root } = mount();
      let closes = 0;
      h.onControllersClose(() => {
        closes += 1;
      });
      h.setState('main-menu');
      h.setState('playing');
      h.setState('paused');
      const opener = q(root, '.hud-controllers-open');
      click(opener);
      press('Escape');
      vi.advanceTimersByTime(1000);
      expect(q(root, '.hud-controllers').classList.contains('hud-controllers--hidden')).toBe(true);
      expect(q(root, '.hud-action').textContent, 'Escape abandoned the paused round').toBe('Resume');
      expect(document.activeElement).toBe(opener);
      expect(closes).toBe(1);
      expect(seen).toEqual([]);
      press('Escape');
      expect(seen, 'the second Escape is the session\'s').toEqual(['Escape']);
      expect(closes).toBe(1);
      expect(q(root, '.hud-action').textContent).toBe('Resume');
    } finally {
      window.removeEventListener('keydown', bubble);
      vi.useRealTimers();
    }
  });
});

describe('hud: the browser-history mirror (issue #318)', () => {
  const click = (el: Element): void => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }));
  };
  const q = (root: HTMLElement, sel: string): HTMLElement => root.querySelector(sel) as HTMLElement;

  /** A host whose `back()` lands synchronously, so the test needs no timers. */
  function fakeHost(): HistoryHost & { calls: string[]; pop: (state: unknown) => void } {
    const calls: string[] = [];
    let listener: ((state: unknown) => void) | null = null;
    let state: unknown = null;
    return {
      calls,
      get state() {
        return state;
      },
      pushState(next) {
        calls.push('push');
        state = next;
      },
      replaceState(next) {
        calls.push('replace');
        state = next;
      },
      back() {
        calls.push('back');
        state = null;
        listener?.(null);
      },
      onPopState(cb) {
        listener = cb;
        return () => {
          listener = null;
        };
      },
      pop(next) {
        listener?.(next);
      },
    };
  }

  it('opening a pane pushes one entry, Back retires it with one back(), and a browser Back closes the pane through its own chokepoint', () => {
    // Kills a HUD that never syncs the mirror: the pane would open with no history
    // entry, so the browser's Back would leave the page with a pane still up.
    const host = fakeHost();
    const root = document.createElement('div');
    document.body.appendChild(root);
    hud = createHud(root, { history: host });
    const h = hud;
    let closes = 0;
    h.onCustomizeClose(() => {
      closes += 1;
    });
    h.setState('main-menu');
    expect(host.calls, 'the mirror pushed with nothing open').toEqual([]);
    const opener = q(root, '.hud-customize-open');
    click(opener);
    expect(host.calls).toEqual(['push']);
    click(q(root, '.hud-customize-back'));
    expect(host.calls, 'Back must retire the entry with exactly one back()').toEqual(['push', 'back']);
    expect(closes).toBe(1);

    // The browser's own Back: the host lands on the base entry and reports it.
    click(opener);
    expect(host.calls).toEqual(['push', 'back', 'push']);
    host.pop(null);
    expect(q(root, '.hud-customize').classList.contains('ui-surface--leaving'), 'the browser Back did not close the pane').toBe(true);
    expect(closes, 'the close callback must fire once for a browser Back too').toBe(2);
    expect(document.activeElement).toBe(opener);
    expect(host.calls, 'a browser Back that emptied the stack must traverse nothing itself').toEqual(['push', 'back', 'push']);
    expect(h.back()).toBe(false);
  });

  it('a real jsdom history: the browser\'s Back closes the open pane and restores its opener, and location.search survives', async () => {
    // Through `browserHistoryHost(window)`, the adapter production wires. jsdom fires
    // popstate asynchronously after two chained tasks, hence the two awaited turns.
    // `?dev=1` selects developer mode and the storage namespace, so the entry the mirror
    // pushes must never carry a URL of its own.
    const before = window.location.href;
    window.history.replaceState(null, '', `${window.location.pathname}?dev=1#top`);
    try {
      const root = document.createElement('div');
      document.body.appendChild(root);
      hud = createHud(root, { history: browserHistoryHost(window) });
      const h = hud;
      h.setState('main-menu');
      const opener = q(root, '.hud-records-open');
      click(opener);
      expect(window.history.state).toEqual({ tanks: 'layer' });
      expect(window.location.search).toBe('?dev=1');
      expect(window.location.hash).toBe('#top');
      window.history.back();
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      expect(q(root, '.hud-stats').classList.contains('ui-surface--leaving'), 'the browser Back did not close the pane').toBe(true);
      expect(document.activeElement).toBe(opener);
      expect(window.history.state).toBeNull();
      expect(window.location.search).toBe('?dev=1');
      expect(h.back()).toBe(false);
    } finally {
      window.history.replaceState(null, '', before);
    }
  });
});

describe('hud: the semantic action dispatcher (issue #494)', () => {
  const q = (root: HTMLElement, sel: string): HTMLElement => root.querySelector(sel) as HTMLElement;
  const click = (el: Element): void => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }));
  };
  /** A key pressed where the browser would deliver it: at the focused element, bubbling. */
  const press = (key: string, init: KeyboardEventInit = {}): void => {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }),
    );
  };
  const controls = (root: HTMLElement, sel: string): HTMLElement[] =>
    Array.from(q(root, sel).querySelectorAll<HTMLElement>('button, [tabindex]')).filter(
      (el) => !(el instanceof HTMLButtonElement && el.disabled) && getComputedStyle(el).display !== 'none',
    );

  it('a direction walks the active panel like the arrows do, and reports unconsumed with nothing shown', () => {
    const { hud: h, root } = mount();
    h.setState('main-menu');
    const panelControls = controls(root, '.hud-panel');
    expect(panelControls.length, 'the Main Menu has controls to walk').toBeGreaterThan(1);
    expect(h.act('down')).toBe(true);
    expect(document.activeElement).toBe(panelControls[0]);
    expect(h.act('down')).toBe(true);
    expect(document.activeElement).toBe(panelControls[1]);
    expect(h.act('up')).toBe(true);
    expect(document.activeElement).toBe(panelControls[0]);
    expect(h.act('left'), 'Left walks backwards').toBe(true);
    expect(document.activeElement, 'Left did not wrap to the last control').toBe(panelControls[panelControls.length - 1]);
    expect(h.act('right')).toBe(true);
    expect(document.activeElement).toBe(panelControls[0]);
    h.setState('playing');
    const before = document.activeElement;
    expect(h.act('down'), 'a direction with nothing shown was consumed').toBe(false);
    expect(document.activeElement).toBe(before);
  });

  it('confirm on a fresh panel lands on the first control instead of activating it; confirm on a focused control activates it once', () => {
    // A gamepad Confirm the instant a panel arrives must not fire whatever happens to be
    // first (New Game, on a Main Menu with no run). The activation half is the negative
    // control: the same verb on a focused control DOES fire, exactly once.
    const { hud: h, root } = mount();
    let opens = 0;
    h.onCustomizeOpen(() => {
      opens += 1;
    });
    h.setState('main-menu');
    expect(document.activeElement, 'a fresh panel focuses its container').toBe(q(root, '.hud-panel'));
    expect(h.act('confirm')).toBe(true);
    expect(document.activeElement).toBe(controls(root, '.hud-panel')[0]);
    expect(q(root, '.hud-customize').classList.contains('hud-customize--hidden'), 'confirm on the container opened a pane').toBe(true);
    q(root, '.hud-customize-open').focus();
    expect(h.act('confirm')).toBe(true);
    expect(opens, 'confirm on the focused opener did not activate it exactly once').toBe(1);
    expect(q(root, '.hud-customize').classList.contains('hud-customize--hidden')).toBe(false);
  });

  it('back pops the layer and reports whether it did; pause is never the HUD\'s', () => {
    const { hud: h, root } = mount();
    h.setState('main-menu');
    click(q(root, '.hud-customize-open'));
    expect(q(root, '.hud-customize').classList.contains('hud-customize--hidden')).toBe(false);
    expect(h.act('pause'), 'pause was consumed by the HUD').toBe(false);
    expect(q(root, '.hud-customize').classList.contains('hud-customize--hidden'), 'pause changed a surface').toBe(false);
    expect(h.act('back')).toBe(true);
    expect(q(root, '.hud-customize').classList.contains('ui-surface--leaving')).toBe(true);
    expect(document.activeElement).toBe(q(root, '.hud-customize-open'));
    expect(h.act('back'), 'back with nothing open was consumed').toBe(false);
  });

  it('Escape is Back with a volume slider focused, while ArrowDown stays with the slider (the consume model)', () => {
    // The product-visible half of issue #494's ruling: the slider consumes only the keys
    // that move it. ArrowDown is the negative control -- the same handler, a key the
    // slider DOES keep, so the roving focus must not take it.
    const { hud: h, root } = mount();
    h.setState('main-menu');
    click(q(root, '.hud-customize-open'));
    const slider = q(root, '.hud-settings-volume') as HTMLInputElement;
    slider.focus();
    expect(document.activeElement).toBe(slider);
    press('ArrowDown');
    expect(document.activeElement, 'the roving focus took an arrow the slider consumes').toBe(slider);
    press('Escape');
    expect(q(root, '.hud-customize').classList.contains('ui-surface--leaving'), 'Escape at a slider did not pop the layer').toBe(true);
  });

  it('focus survives a Controllers re-render: the same candidate when it still exists, the same row when it does not', () => {
    const { hud: h, root } = mount();
    h.setDetectedPads([{ padIndex: 3, id: 'Pad' }]);
    h.setControllers([{ kind: 'keyboard' }, { kind: 'none' }]);
    h.setState('main-menu');
    click(q(root, '.hud-controllers-open'));
    const row1 = (): HTMLElement => q(root, '.hud-controller-row[data-slot="1"]');
    const padBtn = row1().querySelector('[data-candidate="gamepad-3"]') as HTMLElement;
    expect(padBtn, 'the pad candidate is rendered').not.toBeNull();
    padBtn.focus();
    h.setDetectedPads([{ padIndex: 3, id: 'Pad' }]); // a hotplug event for the same pad: a full re-render
    expect(document.activeElement, 'focus fell off the re-rendered row').not.toBe(padBtn);
    expect(document.activeElement).toBe(row1().querySelector('[data-candidate="gamepad-3"]'));
    h.setDetectedPads([]); // the focused pad unplugs: its button is gone
    expect(row1().querySelector('[data-candidate="gamepad-3"]')).toBeNull();
    expect(document.activeElement, 'focus did not stay on the same row').toBe(row1().querySelector('button'));
    // Negative control: with focus outside the rows a re-render moves nothing.
    (document.activeElement as HTMLElement).blur();
    h.setDetectedPads([{ padIndex: 3, id: 'Pad' }]);
    expect(document.activeElement).toBe(document.body);
  });

  it('focus survives a Versus Setup re-render on the same role button of the same row', () => {
    const { hud: h, root } = mount();
    h.setState('main-menu');
    h.showVersusSetup(true);
    const rowBtn = (): HTMLElement | null =>
      root.querySelector('.hud-versus-slot-row[data-slot="1"] button[data-role="bot"]');
    const before = rowBtn();
    expect(before, 'the role button is rendered').not.toBeNull();
    before!.focus();
    h.setDetectedPads([{ padIndex: 0, id: 'Pad' }]); // a hotplug repaints every row
    expect(rowBtn(), 'the rows were not re-rendered').not.toBe(before);
    expect(document.activeElement).toBe(rowBtn());
  });
});

describe('hud: spatial focus follows the drawn layout (issue #495)', () => {
  const ROW_SELECTOR =
    '.hud-versus-mode-row, .hud-versus-players-row, .hud-versus-map-row, .hud-versus-stock-row, .hud-versus-slot-row, .hud-levels';
  /**
   * A desktop-like layout drawn by hand, since jsdom lays nothing out: each Versus option
   * row and each slot card is one visual row, everything else is one control per row, and
   * a control's column is its index among the buttons of its row. `perRow` wraps a row
   * into several, standing in for a narrow viewport.
   */
  function drawn(root: HTMLElement, perRow = Infinity): (el: HTMLElement) => DOMRect {
    const rowEls: Element[] = [];
    return (el) => {
      const rowEl = el.closest(ROW_SELECTOR) ?? el.parentElement ?? root;
      let r = rowEls.indexOf(rowEl);
      if (r < 0) {
        r = rowEls.length;
        rowEls.push(rowEl);
      }
      const siblings = Array.from(rowEl.querySelectorAll<HTMLElement>('button'));
      const i = Math.max(0, siblings.indexOf(el));
      const wrapRow = Math.floor(i / perRow);
      const col = i % perRow;
      return new DOMRect(col * 110, r * 1000 + wrapRow * 50, 100, 40);
    };
  }
  function mountDrawn(perRow?: number): { hud: Hud; root: HTMLElement } {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const h = createHud(root, { measure: drawn(root, perRow) });
    hud = h;
    return { hud: h, root };
  }
  const press = (key: string): void => {
    (document.activeElement as HTMLElement).dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
    );
  };
  const active = (): HTMLElement => document.activeElement as HTMLElement;

  it('a segmented row walks Left/Right within itself and wraps at its ends; Up/Down leave it for the neighbouring row', () => {
    // The Map row is the segment with the most options (7); Mode has one enabled button
    // at two players, which is why it is not the subject here.
    const { hud: h, root } = mountDrawn();
    h.setState('main-menu');
    h.showVersusSetup(true);
    const maps = Array.from(root.querySelectorAll<HTMLButtonElement>('.hud-versus-map-row button')).filter((b) => !b.disabled);
    const players = Array.from(root.querySelectorAll<HTMLButtonElement>('.hud-versus-players-row button')).filter((b) => !b.disabled);
    const stocks = Array.from(root.querySelectorAll<HTMLButtonElement>('.hud-versus-stock-row button')).filter((b) => !b.disabled);
    expect(maps.length, 'the Map segment population').toBe(7);
    maps[0].focus();
    press('ArrowRight');
    expect(active()).toBe(maps[1]);
    maps[maps.length - 1].focus();
    press('ArrowRight');
    expect(active(), 'Right at the end of the segment left it').toBe(maps[0]);
    press('ArrowLeft');
    expect(active(), 'Left at the start of the segment left it').toBe(maps[maps.length - 1]);
    maps[0].focus();
    press('ArrowDown');
    expect(active(), 'Down did not leave the segment for the Stock row').toBe(stocks[0]);
    press('ArrowUp');
    expect(active()).toBe(maps[0]);
    press('ArrowUp');
    expect(active(), 'Up did not leave the segment for the Players row').toBe(players[0]);
  });

  it('the slot cards navigate as a grid: Down lands on the nearest column of the next card', () => {
    const { hud: h, root } = mountDrawn();
    h.setState('main-menu');
    h.showVersusSetup(true);
    const card = (slot: number): HTMLElement[] =>
      Array.from(root.querySelectorAll<HTMLButtonElement>(`.hud-versus-slot-row[data-slot="${slot}"] button`)).filter((b) => !b.disabled);
    expect([card(0).length, card(1).length], 'the two cards: a human card and a bot card with its difficulty options').toEqual([3, 6]);
    card(0)[2].focus();
    press('ArrowDown');
    expect(active(), 'Down did not land on the same column of the next card').toBe(card(1)[2]);
    press('ArrowRight');
    expect(active()).toBe(card(1)[3]);
    press('ArrowUp');
    expect(active(), 'Up did not return to the nearest column of the shorter card above').toBe(card(0)[2]);
    press('ArrowUp');
    expect(active(), 'Up from the first card did not reach the Stock row above it').not.toBe(card(0)[2]);
  });

  it('a row that wraps behaves as the grid it has become: the Levels grid at three per row', () => {
    const { hud: h, root } = mountDrawn(3);
    h.setLevelSelect(5, 5);
    h.setState('main-menu');
    (root.querySelector('.hud-levelselect-open') as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }));
    const levels = Array.from(root.querySelectorAll<HTMLElement>('.hud-levels button'));
    expect(levels.length, 'the level population').toBe(5);
    levels[0].focus();
    press('ArrowDown');
    expect(active(), 'Down did not drop to the wrapped row').toBe(levels[3]);
    press('ArrowRight');
    expect(active()).toBe(levels[4]);
    press('ArrowRight');
    expect(active(), 'Right at the wrapped row end did not wrap within it').toBe(levels[3]);
    levels[2].focus();
    press('ArrowRight');
    expect(active(), 'Right at the first row end left the row').toBe(levels[0]);
  });

  it('the re-derived walk: Right along each row then Down reaches every control of the Versus pane exactly once -- population stated', () => {
    const { hud: h, root } = mountDrawn();
    h.setState('main-menu');
    h.showVersusSetup(true);
    const pane = root.querySelector('.hud-versus-setup') as HTMLElement;
    const population = Array.from(pane.querySelectorAll<HTMLElement>('button, [tabindex]')).filter(
      (el) => !(el instanceof HTMLButtonElement && el.disabled) && Number(el.getAttribute('tabindex') ?? 0) >= 0 && getComputedStyle(el).display !== 'none',
    );
    press('ArrowDown'); // from the container: enters at the first control
    const first = active();
    const visited = new Set<HTMLElement>([first]);
    let rowStart = first;
    for (let steps = 0; steps < 200; steps++) {
      press('ArrowRight');
      if (active() === rowStart) {
        press('ArrowDown');
        if (active() === first) break;
        rowStart = active();
      }
      visited.add(active());
    }
    expect(visited.size, 'the walk did not cover the pane').toBe(population.length);
    expect(population.length, 'the population this walk covers').toBe(27);
  });

  it('negative control: with jsdom\'s empty rects the same Right leaves the segment in document order', () => {
    const { hud: h, root } = mount();
    h.setState('main-menu');
    h.showVersusSetup(true);
    const maps = Array.from(root.querySelectorAll<HTMLButtonElement>('.hud-versus-map-row button')).filter((b) => !b.disabled);
    const stocks = Array.from(root.querySelectorAll<HTMLButtonElement>('.hud-versus-stock-row button')).filter((b) => !b.disabled);
    maps[maps.length - 1].focus();
    press('ArrowRight');
    expect(active(), 'the fallback should walk document order').toBe(stocks[0]);
  });
});
