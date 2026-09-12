/**
 * THE SCREEN-STATE CATALOGUE (issue #561): every player-facing state that is not gameplay
 * and not the title screen, and how to reach it in the built page.
 *
 * WHY THIS EXISTS. Before it, no capture path in the repository could reach an application
 * state at all -- `tools/visual/` is pinned to the title screen and `tools/gallery/` poses
 * simulation subjects, with no notion of a route, an overlay or an error screen. So every
 * PR that changed one of those screens either shipped without visual evidence or grew a
 * throwaway Playwright script that ran nowhere and guarded nothing. Four such scripts were
 * written and discarded in a single day's work; this is the fifth, kept.
 *
 * PURE DATA, deliberately. Every step is a declarative record rather than a function, so
 * this module imports nothing, runs in any context, and can be read by `tools/capture`'s
 * schema (which must not pull Playwright into a unit test) as easily as by the runner that
 * drives a browser with it. The same constraint `tools/gallery/args.mjs` is under.
 *
 * WHAT A STATE OWNS: the storage a returning player would have, whether the renderer can
 * be probed at all, whether scripting is on, the clicks that reach the surface, and the
 * elements worth MEASURING once there. The last is not decoration -- see `measure`.
 */

/**
 * How the page's WebGL probe should answer, which is what selects the branded failure
 * screens in `src/game/startup-failure.ts`.
 *
 *  - `ok`            -- leave the browser alone.
 *  - `unsupported`   -- `getContext('webgl2')` returns null. `probeRenderCapability`
 *                       reports `no-webgl2`, and boot shows "This browser cannot run
 *                       Tanks!" with the hardware-acceleration advice.
 *  - `probe-blocked` -- `getContext` THROWS. The probe reports `probe-failed`, a different
 *                       state with different advice: a browser that could not be ASKED is
 *                       usually being blocked by something the player can switch off.
 *
 * The two are separated here for the same reason `STARTUP_FAILURES` separates them: the
 * screens differ, so a capture set that could only produce one of them would be evidence
 * for half the contract.
 */
export const WEBGL_MODES = Object.freeze(['ok', 'unsupported', 'probe-blocked']);

/**
 * Steps, in order. Each is a single-key record so an unknown step is a loud failure in the
 * runner rather than a silently skipped line.
 *
 *  - `{ click }`       -- wait for the selector to be visible and enabled, then click it.
 *  - `{ press }`       -- a keyboard key, for the Launch splash and Escape.
 *  - `{ waitVisible }` -- wait for a selector to be present and displayed.
 *  - `{ waitHidden }`  -- wait for it to be gone or `display: none`.
 *  - `{ scroll }`      -- scroll a selector's own scroll container to a named position.
 *                         `{ scroll: { selector, to } }`, where `to` is a CSS selector to
 *                         bring into view. Needed because a pane can be taller than any
 *                         viewport -- issue #246's configuration menu runs to about 4900px --
 *                         and a capture that can only ever show the top is evidence about a
 *                         heading, not about the control someone asked to see.
 *  - `{ breakWebgl }`  -- apply a WEBGL_MODES override *now*, after the page has booted.
 *                         This is how a MATCH failure is reached: the probe has already
 *                         passed, the menu is up, and the renderer fails when the player
 *                         starts a match -- which is a different screen from a boot
 *                         failure and says so ("That match could not start.").
 */
export const STEP_KINDS = Object.freeze([
  'click', 'press', 'waitVisible', 'waitHidden', 'breakWebgl', 'fakeGamepads', 'scroll',
]);

/**
 * Named gamepad fixtures for `{ fakeGamepads }` (issue #599).
 *
 * A HEADLESS BROWSER HAS NO CONTROLLER, and a browser reports no pad until one has been
 * ACTUATED, so the controller self-test photographs an empty pane on every capture machine
 * in existence -- true, and evidence for nothing the feature does. The fixture overrides
 * `navigator.getGamepads` on the live page, which is the same seam every unit test in
 * `src/input/` injects and the same seam production reads through
 * `readNavigatorGamepads`.
 *
 *  - `none`    -- no override. The pane's empty state, which IS what a tester sees first.
 *  - `mixed`   -- one `mapping: 'standard'` pad (4 axes, 17 buttons) and one unmapped pad
 *                 with a different channel count, both off centre with a button down, so
 *                 one picture carries both rendering paths and a filled bar.
 *
 * The VALUES live in the runner, not here: this module is pure data and imports nothing.
 */
export const GAMEPAD_FIXTURES = Object.freeze(['none', 'mixed']);

/** A save two levels into the campaign, so the menu shows Continue and a Levels grid. */
const MID_CAMPAIGN = Object.freeze({
  'tanks.progress.v1': JSON.stringify({ levelId: 'level-02' }),
  'tanks.run.v2': JSON.stringify({
    campaignId: 'main',
    currentLevelId: 'level-03',
    livesRemaining: 2,
    status: 'active',
  }),
  'tanks.stats.v1': JSON.stringify({
    shotsFired: 214, shellKills: 63, mineKills: 11, deaths: 9, selfKills: 1,
    friendlyFireKills: 2, minesLaid: 38, wallsDestroyed: 120, ricochets: 47,
  }),
});

/**
 * The same save, in the DEVELOPER key namespace (issue #245).
 *
 * Any state whose `query` carries the `dev` gate needs this instead of `MID_CAMPAIGN`, and
 * the reason is easy to miss: `selectStorageNamespace(location.search)` reads the gate at
 * boot, so a developer page persists behind `tanks.dev.` and cannot see a production save at
 * all. Seeding the unprefixed keys on a `?dev=1` capture boots a FIRST-TIME player -- no
 * Continue, no Levels grid -- which is what the ending captures first did.
 *
 * DERIVED from `MID_CAMPAIGN` rather than written out again, so the two saves cannot drift
 * into describing different runs. The prefix is spelled here because this module imports
 * nothing by design; `states.test.ts` pins it against `DEVELOPER_KEY_PREFIX` so the literal
 * cannot rot.
 */
const MID_CAMPAIGN_DEV = Object.freeze(
  Object.fromEntries(Object.entries(MID_CAMPAIGN).map(([key, value]) => [`tanks.dev.${key}`, value])),
);

/** Dismiss the Launch splash. Every state that wants a rendered UI starts with this. */
const PAST_SPLASH = Object.freeze([
  Object.freeze({ press: 'Space' }),
  Object.freeze({ waitHidden: '.hud-splash' }),
]);

const state = (s) => Object.freeze({
  storage: {},
  webgl: 'ok',
  javascript: 'on',
  /**
   * A query string, with its leading `?`, appended to the page URL (issue #591).
   *
   * Needed because two of what this catalogue photographs are only reachable by URL: a
   * level jump, and the ending a session finishes on. Empty for every state that a player
   * could click their way to, which is most of them -- a capture that needs a query is
   * saying something about how the page was ASKED for, and that belongs in the record.
   */
  query: '',
  steps: [],
  measure: [],
  ...s,
});

export const SCREEN_STATES = Object.freeze([
  // ---- The application routes ------------------------------------------------------
  state({
    id: 'screen.main-menu',
    title: 'Main Menu, mid-campaign',
    description: 'The menu a returning player meets: Continue, the run summary, and the Levels entry.',
    storage: MID_CAMPAIGN,
    steps: PAST_SPLASH,
    measure: ['.hud-panel', '.hud-title', '.hud-run-summary', '.hud-continue', '.hud-new-game'],
  }),
  state({
    id: 'screen.main-menu.fresh',
    title: 'Main Menu, nothing played',
    description: 'The first-boot menu. No Continue, no run summary, and no Levels entry to open.',
    steps: PAST_SPLASH,
    measure: ['.hud-panel', '.hud-title', '.hud-continue', '.hud-levelselect-open'],
  }),
  state({
    id: 'screen.levels',
    title: 'Levels',
    description: 'The level grid, which draws only the levels the player has cleared.',
    storage: MID_CAMPAIGN,
    steps: [...PAST_SPLASH, { click: '.hud-levelselect-open' }, { waitVisible: '.hud-levelselect' }],
    measure: ['.hud-levelselect', '.hud-levels', '.hud-levels-note'],
  }),
  state({
    id: 'screen.records.stats',
    title: 'Records, Stats tab',
    description: 'Lifetime against the level attempt, with a populated save.',
    storage: MID_CAMPAIGN,
    steps: [...PAST_SPLASH, { click: '.hud-records-open' }, { waitVisible: '.hud-stats' }],
    measure: ['.hud-stats', '.hud-stats-table', '.hud-stats-empty'],
  }),
  state({
    id: 'screen.records.stats.empty',
    title: 'Records, Stats tab, nothing played',
    description: 'The empty state: eleven rows of zeros, and the line that explains them.',
    steps: [...PAST_SPLASH, { click: '.hud-records-open' }, { waitVisible: '.hud-stats' }],
    measure: ['.hud-stats', '.hud-stats-table', '.hud-stats-empty'],
  }),
  state({
    id: 'screen.records.achievements',
    title: 'Records, Achievements tab',
    description: 'The earned/locked list and its count, reached through the tab rather than the menu.',
    storage: MID_CAMPAIGN,
    steps: [
      ...PAST_SPLASH,
      { click: '.hud-records-open' },
      { waitVisible: '.hud-stats' },
      { click: '.hud-stats .hud-records-tab-achievements' },
      { waitVisible: '.hud-achievements' },
    ],
    measure: ['.hud-achievements', '.hud-achievement-list', '.hud-achievements-count'],
  }),
  state({
    id: 'screen.settings',
    title: 'Settings',
    description: 'Audio, accessibility and the Data section the destructive actions live under.',
    storage: MID_CAMPAIGN,
    steps: [...PAST_SPLASH, { click: '.hud-settings-open' }, { waitVisible: '.hud-settings' }],
    measure: ['.hud-settings', '.hud-reset-stats', '.hud-reset-progress'],
  }),
  state({
    id: 'screen.customize',
    title: 'Customize',
    description: 'The paint shop, including the live tank preview canvas.',
    storage: MID_CAMPAIGN,
    steps: [...PAST_SPLASH, { click: '.hud-customize-open' }, { waitVisible: '.hud-customize' }],
    measure: ['.hud-customize', '.hud-preview'],
  }),
  state({
    id: 'screen.versus-setup',
    title: 'Versus Setup',
    description:
      'Mode, players, the map cards, stock and the who is-playing cards. Random is the ' +
      'pane default, so this is also the one state showing a selected card that is not a board.',
    storage: MID_CAMPAIGN,
    steps: [...PAST_SPLASH, { click: '.hud-versus-open' }, { waitVisible: '.hud-versus-setup' }],
    // `.hud-versus-start` is measured for its Y: the map cards (issue #274) lengthened this
    // pane, and how far down Start sits is the number that says whether it is still
    // reachable in about a screen. Measured at 793 before the cards and 1240 after.
    // `.hud-versus-role-btn` is measured for its BOX (issue #634): it shipped with no size
    // modifier and no rule of its own, so it rendered at zero padding beside team and
    // difficulty buttons that are `--sm`. The recorded width/height is what says so.
    measure: ['.hud-versus-setup', '.hud-versus-map-row', '.hud-versus-map-card', '.hud-versus-role-btn', '.hud-versus-start'],
  }),
  state({
    id: 'screen.versus-setup.selected',
    title: 'Versus Setup, a board chosen',
    description:
      'Arena 3 picked (issue #274). The pane default is Random, so this is the only state ' +
      'showing the selection ring on a card with a board schematic in it -- the state ' +
      "#274's \"selected state remains obvious without relying on color\" criterion is about.",
    storage: MID_CAMPAIGN,
    steps: [
      ...PAST_SPLASH,
      { click: '.hud-versus-open' },
      { waitVisible: '.hud-versus-setup' },
      { click: '.hud-versus-map-row [data-map="arena-03"]' },
      // Waiting on the ROW rather than on the clicked card: the row is replaced wholesale on
      // every selection, so the node clicked above is gone by the time this resolves.
      { waitVisible: '.hud-versus-map-row' },
    ],
    measure: ['.hud-versus-setup', '.hud-versus-map-row', '.hud-versus-map-card'],
  }),
  state({
    id: 'screen.versus-setup.teams',
    title: 'Versus Setup, three-player Teams',
    description: 'The 2v1 configuration: three players, Teams, and the map row that offers Keystone.',
    storage: MID_CAMPAIGN,
    // The pane opens at its retained default (two players, FFA), and the two clicks below
    // are the whole reason this state exists beside `screen.versus-setup`. Three of the
    // pane's rows change under them -- Teams is not even offered at two players (issue
    // #281), the friendly-fire toggle exists only under Teams, and the MAP row is filtered
    // by both axes -- so the default capture is evidence for none of it.
    //
    // Issue #627 is what made the map row worth a picture. Keystone (`vs-tri-01`) declared
    // `ffa` alone until #584 established that asymmetric Teams are intentionally supported,
    // so this row offered five boards and Random here and now offers six and Random. That
    // button is reachable in exactly this state and no other.
    //
    // Waiting on the friendly-fire toggle rather than on the Keystone button is deliberate:
    // it confirms the pane really entered Teams, which is the precondition. Waiting on the
    // thing under test would pass vacuously the day the mode click silently stops working.
    steps: [
      ...PAST_SPLASH,
      { click: '.hud-versus-open' },
      { waitVisible: '.hud-versus-setup' },
      { click: '.hud-versus-players-row [data-players="3"]' },
      { click: '.hud-versus-mode-row [data-mode="teams"]' },
      { waitVisible: '.hud-versus-friendlyfire-btn' },
    ],
    measure: ['.hud-versus-setup', '.hud-versus-map-row', '.hud-versus-map-card', '.hud-versus-friendlyfire-btn'],
  }),
  state({
    id: 'screen.versus-setup.map-replaced',
    title: 'Versus Setup, a map choice replaced',
    description: 'The notice shown when a player count change drops the map the player had chosen.',
    storage: MID_CAMPAIGN,
    // The one state in the pane that only a SEQUENCE produces: choose Pinwheel, which is
    // offered at two players and nowhere else (issue #271), then move to three. The board
    // leaves the row, so the pane replaces the retained choice with Random and says why
    // (issue #274). Before that fix the choice was kept silently and the launch gate threw
    // out of the Start handler, which is a state no capture could show because nothing was
    // drawn -- the button simply did nothing.
    //
    // Pinwheel rather than Keystone deliberately: its two-player restriction is structural
    // (a dedicated duel board), where Keystone's was a curation ruling that issue #627 has
    // already reversed once. A capture anchored to a ruling goes stale the next time one
    // moves.
    steps: [
      ...PAST_SPLASH,
      { click: '.hud-versus-open' },
      { waitVisible: '.hud-versus-setup' },
      { click: '.hud-versus-map-row [data-map="vs-duel-01"]' },
      { click: '.hud-versus-players-row [data-players="3"]' },
      { waitVisible: '.hud-versus-map-note' },
    ],
    measure: ['.hud-versus-setup', '.hud-versus-map-row', '.hud-versus-map-note'],
  }),
  // ---- Developer Tools -------------------------------------------------------------
  state({
    id: 'screen.devtools',
    title: 'Developer Tools',
    description:
      'The developer shell behind ?dev=1: the non-privilege statement, the Controller ' +
      'Self-Test entry, Exit and Back.',
    storage: MID_CAMPAIGN_DEV,
    query: '?dev=1',
    steps: [...PAST_SPLASH, { click: '.hud-devtools-open' }, { waitVisible: '.hud-devtools' }],
    // `.hud-selftest-open` is measured for its BOX: it is the control issue #599 added to
    // this pane, and the pane is one of the two issue #642 still owns for centring the main
    // axis of a scroll container -- so where this button sits is the number that says
    // whether one more control pushed the pane into its own clip.
    measure: ['.hud-devtools', '.hud-selftest-open', '.hud-devtools-back'],
  }),
  state({
    id: 'screen.devtools.config',
    title: 'Developer Configuration',
    description:
      'The registry-driven configuration menu: the six presets, every developer parameter ' +
      'in its own group, the persistence namespace and the URL the selection means.',
    storage: MID_CAMPAIGN_DEV,
    query: '?dev=1',
    steps: [
      ...PAST_SPLASH,
      { click: '.hud-devtools-open' },
      { waitVisible: '.hud-devtools' },
      { click: '.hud-devcfg-open' },
      { waitVisible: '.hud-devcfg' },
    ],
    // `.hud-devcfg-url` is measured for its TEXT: it is what Apply navigates to and Copy
    // copies, so a capture that showed the menu without it would not show the thing the
    // whole pane is for. `.hud-devcfg-namespace` for the same reason -- it is the
    // consequence that outlives the reload.
    measure: ['.hud-devcfg', '.hud-devcfg-presets', '.hud-devcfg-group', '.hud-devcfg-namespace', '.hud-devcfg-url'],
  }),
  state({
    id: 'screen.devtools.config.sandbox',
    title: 'Developer Configuration — Sandbox',
    description:
      'The Sandbox group of the configuration menu, scrolled into view: the tank multiset ' +
      'built by a count per kind rather than typed as a comma-separated list.',
    storage: MID_CAMPAIGN_DEV,
    query: '?dev=1',
    steps: [
      ...PAST_SPLASH,
      { click: '.hud-devtools-open' },
      { waitVisible: '.hud-devtools' },
      { click: '.hud-devcfg-open' },
      { waitVisible: '.hud-devcfg' },
      { scroll: { selector: '.hud-devcfg', to: '.hud-devcfg-control[data-field="sandboxTanks"]' } },
    ],
    measure: ['.hud-devcfg-control[data-field="sandboxTanks"]', '.hud-devcfg-count'],
  }),
  state({
    id: 'screen.devtools.controller-selftest',
    title: 'Controller Self-Test',
    description:
      'The controller compatibility self-test over two synthetic pads: one the browser ' +
      'remapped to the standard layout and one it did not, each showing live axis and ' +
      'button rows.',
    storage: MID_CAMPAIGN_DEV,
    query: '?dev=1',
    steps: [
      ...PAST_SPLASH,
      { fakeGamepads: 'mixed' },
      { click: '.hud-devtools-open' },
      { waitVisible: '.hud-devtools' },
      { click: '.hud-selftest-open' },
      { waitVisible: '.hud-selftest' },
      { waitHidden: '.hud-selftest-empty' },
    ],
    // The empty state is measured for its ABSENCE beside a populated list: a pane that
    // showed both, or neither, is the failure this picture has to be able to show.
    measure: ['.hud-selftest', '.hud-selftest-pads', '.hud-selftest-pad', '.hud-selftest-channel', '.hud-selftest-copy'],
  }),
  state({
    id: 'screen.about',
    title: 'About & Legal',
    description:
      'The index: two outbound links and one collapsed disclosure per legal document ' +
      '(issue #117). The widest text measure in the kit.',
    steps: [...PAST_SPLASH, { click: '.hud-about-open' }, { waitVisible: '.hud-about' }],
    measure: ['.hud-about', '.hud-about-line', '.hud-about-links', '.hud-legal-toggle'],
  }),
  state({
    id: 'screen.about.document',
    title: 'About & Legal, a document open',
    description:
      'Privacy expanded in place (issue #117). The one state that shows the document ' +
      "surface itself -- headings, prose, and the storage-key table's captioned columns -- " +
      'which screen.about above cannot, because every document is collapsed there.',
    steps: [
      ...PAST_SPLASH,
      { click: '.hud-about-open' },
      { waitVisible: '.hud-about' },
      { click: '.hud-legal-doc[data-legal="privacy"] .hud-legal-toggle' },
      { waitVisible: '#hud-legal-body-privacy' },
    ],
    measure: ['.hud-about', '#hud-legal-body-privacy', '.hud-legal-table'],
  }),
  state({
    id: 'screen.confirm.new-campaign',
    title: 'Replace-run confirmation',
    description: 'The one blocking layer: New Game over an active run asks before replacing it.',
    storage: MID_CAMPAIGN,
    steps: [...PAST_SPLASH, { click: '.hud-new-game' }, { waitVisible: '.hud-confirm' }],
    measure: ['.hud-confirm', '.hud-confirm-body', '.hud-confirm-actions'],
  }),

  // ---- Pause, which is a contextual surface rather than one screen -------------------
  //
  // Its exit is named for the session it belongs to and it carries a per-kind action, so
  // one capture of "the pause panel" would be evidence for whichever session happened to
  // be running. These two are a PAIR: same surface, different session, and the difference
  // between them is the whole contract (issue #261, and issue #323 before it).
  state({
    id: 'screen.pause.versus',
    title: 'Pause, versus match',
    description: 'The exit names Main Menu and Change Setup stands beside it.',
    steps: [
      ...PAST_SPLASH,
      { click: '.hud-versus-open' },
      { waitVisible: '.hud-versus-setup' },
      { click: '.hud-versus-start' },
      { waitHidden: '.hud-versus-setup' },
      { press: 'Escape' },
      { waitVisible: '.hud-quit' },
    ],
    measure: ['.hud-panel', '.hud-quit', '.hud-change-setup', '.hud-settings-open'],
  }),
  state({
    id: 'screen.pause.campaign',
    title: 'Pause, campaign round',
    description: 'The control for the versus pause: a generic exit, and no Change Setup.',
    steps: [
      ...PAST_SPLASH,
      { click: '.hud-new-game' },
      { waitHidden: '.hud-panel' },
      { press: 'Escape' },
      { waitVisible: '.hud-quit' },
    ],
    measure: ['.hud-panel', '.hud-quit', '.hud-change-setup', '.hud-settings-open'],
  }),

  // ---- The five ENDING SCREENS (issue #591) -----------------------------------------
  //
  // Reached with `?dev=1&outcome=`, which ends the running session on its first simulated
  // frame with the named ending. That enters the REAL outcome phase, so the real
  // `OUTCOME_PANEL` entry renders through the real gates, with the level choice and pushed
  // status a live session supplies -- which is what makes the two secondary controls
  // (`Choose Level`, `Practice This Level`) meaningful here rather than merely present.
  //
  // WHAT THESE ARE NOT. They do not play a match, so they are evidence about the SCREEN and
  // not about reaching it. See the "Known gap" section of this directory's README, and
  // issue #617 for the played-through capture.
  //
  // THE SESSION IS PART OF THE RECIPE. The flag ends whatever session is running, and the
  // panel describes that session -- so each state below starts the session its ending
  // belongs to. A campaign ending photographed over a practice session would be a screen no
  // player can reach, which is exactly the kind of thing a capture must not manufacture.
  //
  // Both secondary controls are measured on ALL FIVE, not only where they appear. That is
  // the point: `Choose Level` and `Practice This Level` each carry a multi-term gate, and a
  // screen that stops offering one -- or starts offering one it should not -- fails the
  // measurement rather than photographing quietly.
  state({
    id: 'screen.ending.mission-clear',
    title: 'Mission clear',
    description: 'A level cleared inside a live run: Next Level, and the Practice This Level offer #323 added.',
    storage: MID_CAMPAIGN_DEV,
    query: '?dev=1&outcome=mission-clear',
    steps: [...PAST_SPLASH, { click: '.hud-continue' }, { waitVisible: '.hud-action' }],
    measure: ['.hud-panel', '.hud-title', '.hud-action', '.hud-choose-level', '.hud-practice-level'],
  }),
  state({
    id: 'screen.ending.campaign-over',
    title: 'Campaign over',
    description: 'The run ended out of lives: Game Over, with the route back that #323 restored.',
    storage: MID_CAMPAIGN_DEV,
    query: '?dev=1&outcome=campaign-over',
    steps: [...PAST_SPLASH, { click: '.hud-continue' }, { waitVisible: '.hud-action' }],
    measure: ['.hud-panel', '.hud-title', '.hud-action', '.hud-choose-level', '.hud-practice-level'],
  }),
  state({
    id: 'screen.ending.campaign-complete',
    title: 'Campaign complete',
    description: 'The end of the whole campaign -- otherwise five levels of play away from any capture.',
    storage: MID_CAMPAIGN_DEV,
    query: '?dev=1&outcome=campaign-complete',
    steps: [...PAST_SPLASH, { click: '.hud-continue' }, { waitVisible: '.hud-action' }],
    measure: ['.hud-panel', '.hud-title', '.hud-action', '.hud-choose-level', '.hud-practice-level'],
  }),
  // The practice pair, entered through Levels so the session really is a practice one --
  // its panel says different things from the campaign endings above, and that difference is
  // the whole reason both are here.
  state({
    id: 'screen.ending.practice-cleared',
    title: 'Practice cleared',
    description: 'A level-select attempt won, which consumes no run and offers its own way back.',
    storage: MID_CAMPAIGN_DEV,
    query: '?dev=1&outcome=practice-cleared',
    steps: [
      ...PAST_SPLASH,
      { click: '.hud-levelselect-open' },
      { waitVisible: '.hud-levelselect' },
      { click: '.hud-level-btn' },
      { waitVisible: '.hud-action' },
    ],
    measure: ['.hud-panel', '.hud-title', '.hud-action', '.hud-choose-level', '.hud-practice-level'],
  }),
  state({
    id: 'screen.ending.practice-failed',
    title: 'Practice failed',
    description: 'The same attempt lost: the pair to practice-cleared, and a different panel.',
    storage: MID_CAMPAIGN_DEV,
    query: '?dev=1&outcome=practice-failed',
    steps: [
      ...PAST_SPLASH,
      { click: '.hud-levelselect-open' },
      { waitVisible: '.hud-levelselect' },
      { click: '.hud-level-btn' },
      { waitVisible: '.hud-action' },
    ],
    measure: ['.hud-panel', '.hud-title', '.hud-action', '.hud-choose-level', '.hud-practice-level'],
  }),

  // ---- The branded failure states (issue #325) --------------------------------------
  //
  // Produced by BREAKING the thing they report on, never by injecting markup: the probe
  // really fails, boot really takes its failure path, and the screen is really the one a
  // player would see. That is what made the equivalent one-off capture in PR #560 worth
  // anything -- it found a defect (the no-script message and the holding card overlapping
  // at `inset: 0`) that every assertion about the markup had passed straight over.
  state({
    id: 'screen.startup.unsupported-render',
    title: 'Startup failure: no WebGL 2',
    description: 'The browser answered, and the answer was no. Hardware-acceleration advice.',
    webgl: 'unsupported',
    steps: [{ waitVisible: '[role="alert"]' }],
    measure: ['[role="alert"]'],
  }),
  state({
    id: 'screen.startup.probe-blocked',
    title: 'Startup failure: the probe could not run',
    description: 'getContext threw. Different cause, different advice: extensions and privacy modes.',
    webgl: 'probe-blocked',
    steps: [{ waitVisible: '[role="alert"]' }],
    measure: ['[role="alert"]'],
  }),
  state({
    id: 'screen.startup.match-failed',
    title: 'A match could not start',
    description:
      'The probe passed and the menu came up; the renderer fails when a match starts. Since '
      + "issue #325's 2026-09-11 ruling this is an OVERLAY over the working Main Menu rather "
      + 'than a replacement for the page: the shell behind it is intact, so the recovery is '
      + 'Back to menu rather than Reload. It deliberately does not vouch for the rest.',
    steps: [
      ...PAST_SPLASH,
      { breakWebgl: 'probe-blocked' },
      { click: '.hud-new-game' },
      // `.hud-alert`, not `[role="alertdialog"]`: the replace-run confirmation declares the
      // same role, and a selector that could match either would pass on the wrong dialog.
      { waitVisible: '.hud-alert' },
    ],
    // `.hud-panel` is measured EXPECTING it to be hidden, which is why this state reports
    // 3 of 4 visible rather than 4 of 4. The layer stack swaps surfaces, so the menu is not
    // drawn behind the alert; its 0x0 box is the record of that, and an earlier draft of
    // this feature claimed the opposite in player-facing copy. Remove it here and the next
    // reader has to rediscover the fact by hand.
    measure: ['.hud-alert', '.hud-alert-body', '.hud-alert-dismiss', '.hud-panel'],
  }),
  state({
    id: 'screen.no-script',
    title: 'Scripting disabled',
    description:
      'The holding card and the <noscript> message. Both are absolutely positioned, which '
      + 'is exactly the defect class only a screenshot finds.',
    javascript: 'off',
    steps: [{ waitVisible: '#boot-noscript' }],
    measure: ['#boot-loading', '#boot-noscript'],
  }),
]);

/** Stable IDs only, for `tools/capture/schema.mjs` to validate a recipe against. */
export const SCREEN_STATE_IDS = Object.freeze(SCREEN_STATES.map((s) => s.id));

export function findScreenState(id) {
  return SCREEN_STATES.find((s) => s.id === id) ?? null;
}
