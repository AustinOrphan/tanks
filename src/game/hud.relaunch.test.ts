// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { createHud, type GameplayOutcome, type GameplayStatus, type Hud, type HudOptions } from './hud';
import { installComputedStyleCache } from './computed-style-cache';

/**
 * The relaunch target: which affordances the title and outcome screens offer a campaign, a
 * practice or a versus session. Split from `hud.navigation.test.ts` (issue #1093), whose header says why.
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

  it("the win/lose action button reads 'Rematch' for a versus session's FINAL win and its lose -- what the click now does", () => {
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
    // `Rematch` since issue #279: the primary action on a finished match plays it again,
    // and the setup pane moved to `Change Setup` beside it. The label previously read
    // `Versus Setup`, naming the pane the click went to.
    expect(actionBtn(root).textContent).toBe('Rematch');
    h.setState('outcome-lose');
    expect(actionBtn(root).textContent).toBe('Rematch');
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
    expect(actionBtn(root).textContent).toBe('Rematch');
    // ...and back again, so the assertion cannot pass on a setter that only ever
    // writes the versus wording once.
    h.setOutcome(outcomeWithAction('campaign-levels'));
    expect(actionBtn(root).textContent).toBe('Play Again');
    // Change Setup rides the SAME late projection (issue #279): it is decided from the
    // outcome's `action`, not from the session status, so a panel that re-derived the
    // label on a late push but not the button beside it would be half-applied in exactly
    // the way this case exists to catch.
    const changeSetupHidden = (): boolean =>
      root.querySelector('.hud-change-setup')!.classList.contains('hud-change-setup--hidden');
    expect(changeSetupHidden(), 'Change Setup stood on a campaign ending').toBe(true);
    h.setOutcome(outcomeWithAction('versus-setup'));
    expect(changeSetupHidden(), 'Change Setup ignored a late versus projection').toBe(false);
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
    // The Lives stat alone, not every `.hud-campaign-stat`: issue #552's ruling drops the
    // enemy count from the shipped bar for its own reasons, so a sweep of the pair would
    // now be asserting that ruling here instead of this policy. The gate this case is
    // about applies to both elements, and `topbar-treatment.test.ts` reads the pair under
    // the `full` arm, where the enemy count is still on screen.
    for (const el of Array.from(
      root.querySelectorAll('.hud-campaign-stat:not(.hud-enemy-stat)'),
    )) {
      expect(el.classList.contains('hud-campaign-stat--hidden')).toBe(false);
    }
    expect(
      (root.querySelector('.hud-versus-stocks') as HTMLElement).classList.contains(
        'hud-versus-stocks--hidden',
      ),
    ).toBe(true);
  });

  it("a PRACTICE status shows the campaign stats, exactly as a campaign one does", () => {
    // Practice is a campaign board played in isolation: its lives are as real there as in
    // a run. Fails if the stat gate is widened to `!== 'campaign'`, which is the tempting
    // shape once the setter takes three kinds. Scoped past `.hud-enemy-stat` for the
    // reason given in the case above -- the shipped bar drops that one on every kind, by
    // #552's ruling and not by any identity policy.
    const practice = mount();
    practice.hud.setStatus({ kind: 'practice', mission: 1, missions: 1, lives: 3, enemies: 3 });
    practice.hud.setState('playing');
    for (const el of Array.from(
      practice.root.querySelectorAll('.hud-campaign-stat:not(.hud-enemy-stat)'),
    )) {
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
    // A versus session's title has no Continue, so its primary is New Game, labelled for the
    // match it starts (issue #919's PANEL_PRIMARY), and the walk starts there.
    const arrival = root.querySelector('.hud-new-game') as HTMLElement;
    expect(document.activeElement, 'the title panel did not arrive on Start Match').toBe(arrival);
    expect(arrival.textContent).toBe('Start Match');
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
