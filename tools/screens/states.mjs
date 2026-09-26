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
 *  - `match-build-fails` -- `getContext` is left alone, so the renderer IS constructed; the
 *                       context's first `createFramebuffer` call then throws an untyped
 *                       Error. Meant for `{ breakWebgl }` after boot: it is the one mode that
 *                       reaches the RECOVERABLE match-failure overlay (issue #700).
 *
 * The first two are separated here for the same reason `STARTUP_FAILURES` separates them:
 * the screens differ, so a capture set that could only produce one of them would be evidence
 * for half the contract.
 *
 * WHY A THIRD FAILURE MODE (issue #700). `screen.startup.match-failed` used to break the
 * context with `probe-blocked` after boot. Since #669, a throw from `new THREE.WebGLRenderer`
 * is a typed `RenderContextUnavailableError`, which `classifyStartupFailure` correctly calls
 * FATAL, so that step now lands on the full-page "This browser cannot run Tanks!" state
 * (measured on `073f2aa`) and the overlay is never reached. The fatal page keeps its capture
 * in `screen.startup.unsupported-render`. Only an UNTYPED failure after the context exists is
 * transient, which is what this mode produces, without weakening either #669's typing or the
 * classifier.
 */
export const WEBGL_MODES = Object.freeze(['ok', 'unsupported', 'probe-blocked', 'match-build-fails']);

/**
 * How the entry script's request is answered (issue #781).
 *
 * `index.html` carries an inline guard that draws a branded card when the entry bundle never
 * arrives or never parses, and the two failures produce DIFFERENT cards: a resource `error`
 * whose target is the entry script says "could not load", while a parse error whose
 * `filename` matches the script's `src` says "could not start". Neither was reachable from
 * this catalogue before, because a state could seed storage and break WebGL but had no way to
 * refuse or corrupt a response.
 *
 *  - `ok`            -- the script is served normally. Every state but two.
 *  - `refused`       -- answered 404, so the request completes and fails. The "could not
 *                       load" card.
 *  - `unparseable`   -- answered 200 with JavaScript that cannot parse. The "could not
 *                       start" card.
 *
 * Distinct from `boot: 'holding'`, which never answers the request at all: that photographs
 * the page still WAITING, and these photograph it having given up.
 */
export const ENTRY_MODES = Object.freeze(['ok', 'refused', 'unparseable']);

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
 *  - `{ playUntil }`   -- let the game PLAY until a selector is visible, within a stated
 *                         budget of SIMULATED ticks (issue #617):
 *                         `{ playUntil: { visible, maxTicks } }`. This is how an ending is
 *                         reached by winning or losing rather than by `?outcome=`. The tick
 *                         count is read from `__tanks.replay()`, so the state's query must
 *                         carry `dev=1&replay=1`; it is summed across world rebuilds, since
 *                         each level and each retry starts a new trace. Exceeding the budget
 *                         fails naming the selector that never showed -- "the game did not
 *                         end", not a selector timeout -- and so do a missing replay surface,
 *                         a truncated trace, and a simulation that stops advancing.
 */
export const STEP_KINDS = Object.freeze([
  'click', 'press', 'waitVisible', 'waitHidden', 'breakWebgl', 'fakeGamepads', 'scroll', 'playUntil',
  // Issue #917: actuate a button on the pads `{ fakeGamepads }` installed. The fixture alone
  // cannot press anything -- it is a static array, and `createGamepadMenuPoller` dispatches on
  // the press->release EDGE -- so a pad-driven surface had no way into this catalogue at all.
  'padPress',
  // Issue #842: the interactive states `tools/uikit/primitive-states.mjs` produced one-shot.
  // Both VERIFY they engaged rather than assuming it -- a state that silently failed to engage
  // photographs the rest state, and a reviewer cannot tell that picture from a control that
  // simply has no rule for it.
  'focusKeyboard', 'pressHold',
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
export const GAMEPAD_FIXTURES = Object.freeze(['none', 'idle', 'mixed']);

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

/**
 * A retained versus setup, as the pane itself persists it (issue #776).
 *
 * READ OFF THE PAGE, not reconstructed from `versus-setup-store.ts`'s types: the pane was
 * driven to each configuration in a browser and `tanks.versus.v1` copied out. A hand-written
 * shape that the store quietly migrates or rejects would fall back to the DEFAULT setup --
 * Random map, stock 3 -- and the capture would play a different match every run while still
 * reaching an ending, which is exactly the failure a pinned seed is supposed to remove.
 *
 * `stock: 1` is what makes the match short enough to photograph: one life each, so the first
 * elimination ends it. `arenaId` is pinned for the same reason the seed is -- Random is the
 * pane's default and would choose a different board per run.
 *
 * Slot roles are the pane's own defaults at each player count: slot 0 human, every other slot
 * a bot. Slot 0 is the one `autoplay` substitutes (loop.ts's `autoplayRnd`), so the human slot
 * is the one that plays itself and the bots fight it.
 */
const versusSetup = (mode, players, slots) => JSON.stringify({
  mode,
  players,
  stock: 1,
  friendlyFire: false,
  arenaId: 'arena-01',
  slots,
});

const VERSUS_FFA_DEV = Object.freeze({
  ...MID_CAMPAIGN_DEV,
  'tanks.dev.tanks.versus.v1': versusSetup('ffa', 2, [{ role: 'human' }, { role: 'bot' }]),
});

const VERSUS_TEAMS_DEV = Object.freeze({
  ...MID_CAMPAIGN_DEV,
  // Teams is not offered at two players (issue #281), so the Teams ending needs three. The
  // pane assigns 0 -> team 1, 1 -> team 2, 2 -> team 1, which is the 2v1 the board supports.
  'tanks.dev.tanks.versus.v1': versusSetup('teams', 3, [{ role: 'human' }, { role: 'bot' }, { role: 'bot' }]),
});


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
   * Whether the page is allowed to finish booting before it is photographed (issue #841).
   *
   * `'done'` -- every state but one -- lets the module load and run, which is what removes
   * the `#boot-loading` holding card. `'holding'` stalls the module request in the RUNNER
   * so the card is still in the document: it is the only way to photograph the thing a
   * player sees while the bundle is still arriving, and it needs no production seam.
   */
  boot: 'done',
  /**
   * Whether this state puts a MENU in front of the player (issue #841).
   *
   * `'present'` -- almost every state -- means there are controls to press, which is what
   * the visual gate's hit sweep exists to measure. `'none'` says there are not, and the
   * three states that say it say it for three different reasons: the holding card has no
   * application in it, the launch splash takes any key rather than offering a target, and a
   * live board offers only the driving controls the collector excludes by design.
   *
   * Declared rather than inferred. The sweep reports "no controls measured" as a FAILURE --
   * correctly, because for every other state that means the surface never opened -- so a
   * state with genuinely none has to say so. Measured the hard way: `screen.practice` was
   * swept on the first attempt and failed in all four viewports.
   */
  menu: 'present',
  /**
   * A query string, with its leading `?`, appended to the page URL (issue #591).
   *
   * Needed because two of what this catalogue photographs are only reachable by URL: a
   * level jump, and the ending a session finishes on. Empty for every state that a player
   * could click their way to, which is most of them -- a capture that needs a query is
   * saying something about how the page was ASKED for, and that belongs in the record.
   */
  query: '',
  /**
   * Whether the browser context reports a TOUCHSCREEN (issue #844).
   *
   * Not a viewport. `control-relevance.ts` decides which control settings are worth showing
   * from `PlatformCapabilities.touch`, so `touchScheme` and `fireMode` are OMITTED entirely
   * on a device without one -- a phone-sized desktop context photographs a Settings pane
   * missing two controls a real phone shows. Declared per state rather than derived from
   * width, because that is the distinction the production code actually makes.
   *
   * It belongs on the STATE, not only on the capture recipe, so the layout sweep honours it
   * too: `sweep.mjs` iterates this catalogue and never sees a recipe.
   */
  touch: false,
  /**
   * How the entry script's request is answered (issue #781). One of `ENTRY_MODES`.
   *
   * Declared per state rather than inferred, for the reason `boot` gives: what a capture
   * photographs here is decided BEFORE the page is asked for, and a declared field is the
   * only place that decision is visible to someone reading the catalogue.
   */
  entry: 'ok',
  steps: [],
  measure: [],
  /**
   * Extra computed properties this state's measurements record (issue #917).
   *
   * The capture's own `WATCHED` list is seven properties about LAYOUT DRIFT, and a focus ring
   * is not layout -- an `outline` moves no box, so a ring could appear or vanish and every
   * baseline here would stay byte-identical. One state needed to photograph one, so it names
   * the properties it is about rather than widening the list for all forty-nine.
   *
   * Empty for every state that is about where things are and what colour they are, which is
   * almost all of them.
   */
  watch: [],
  ...s,
});

export const SCREEN_STATES = Object.freeze([
  // ---- The application routes ------------------------------------------------------
  state({
    id: 'screen.boot-loading',
    title: 'Boot holding card',
    description:
      'What a player on a slow connection sees while the bundle is still arriving: the '
      + 'holding card index.html ships in its own markup, before any of the application '
      + 'exists. Elsewhere this element is only ever measured for its ABSENCE.',
    /**
     * The module never arrives, so `boot()` never runs and never removes the card. Held in
     * the runner rather than by a flag on the page: there is nothing to add to production
     * for this, and a seam that existed only to be photographed would be worse than the
     * gap it filled.
     */
    boot: 'holding',
    menu: 'none',
    steps: [{ waitVisible: '#boot-loading' }],
    measure: ['#boot-loading'],
  }),
  // The two ways the entry bundle can fail a player (issue #781). Kept beside the holding
  // card on purpose: all three photograph the page BEFORE the application exists, and the
  // difference between them is only what happened to one request. These two do NOT measure
  // `#boot-loading` -- the card's own guard reads it and then `app.innerHTML = ''` takes it
  // out, so by the time the failure card is up the holding card is gone rather than hidden.
  // Each state repeats that below, and `states.test.ts` asserts it.
  state({
    id: 'screen.startup.entry-refused',
    title: 'Entry bundle refused',
    description:
      'What a player sees when the entry bundle never arrives -- a dropped connection, a bad '
      + 'deploy, a cache serving a 404. The inline guard in index.html draws its own card, '
      + 'because at this point none of the application has run.',
    entry: 'refused',
    menu: 'present',
    steps: [{ waitVisible: '#boot-entry-failure-card' }],
    // NOT `#boot-loading`. The card's own code runs `app.innerHTML = ''` before drawing, so
    // the holding card is REMOVED rather than hidden -- and the adapter fails any measured
    // selector that matches nothing, correctly, because a state measuring an absent element
    // is measuring nothing. `screen.no-script` can measure it because scripting off leaves
    // the static markup in place; here it is genuinely gone, and the picture shows that.
    measure: [
      '#boot-entry-failure-card',
      '#boot-entry-failure-card h1',
      '#boot-entry-failure-card p',
      '#boot-entry-failure-card button',
    ],
  }),
  state({
    id: 'screen.startup.entry-unparseable',
    title: 'Entry bundle unparseable',
    description:
      'What a player sees when the bundle arrives but cannot run -- a truncated file, or a '
      + 'proxy that answered with something that is not JavaScript. A DIFFERENT card from the '
      + 'refused one: "could not start" rather than "could not load", and the wording is the '
      + 'only thing that tells a player which happened.',
    entry: 'unparseable',
    menu: 'present',
    // The subject of this state IS a page error: the entry bundle is served deliberately
    // unbalanced (`tools/screens/steps.mjs`) so it fails at PARSE time, which is the only way
    // to reach the "could not start" card rather than the "could not load" one. Declared, so
    // `check` and `accept` treat it as the design instead of refusing to look -- and so a
    // capture that stops raising it fails too, because then the card is no longer being
    // demonstrated. Substring only: engines word the rest of a SyntaxError differently.
    pageError: 'SyntaxError',
    steps: [{ waitVisible: '#boot-entry-failure-card' }],
    // NOT `#boot-loading`. The card's own code runs `app.innerHTML = ''` before drawing, so
    // the holding card is REMOVED rather than hidden -- and the adapter fails any measured
    // selector that matches nothing, correctly, because a state measuring an absent element
    // is measuring nothing. `screen.no-script` can measure it because scripting off leaves
    // the static markup in place; here it is genuinely gone, and the picture shows that.
    measure: [
      '#boot-entry-failure-card',
      '#boot-entry-failure-card h1',
      '#boot-entry-failure-card p',
      '#boot-entry-failure-card button',
    ],
  }),
  state({
    id: 'screen.launch',
    title: 'Launch splash',
    description:
      'The title screen a first load opens on, before any key or tap dismisses it. The one '
      + 'route the catalogue could not reach by construction: every other state begins by '
      + 'pressing Space to get PAST this.',
    /**
     * NO STORAGE, deliberately. The shell shows Launch on a fresh load, and seeding a save
     * here would photograph the same splash while claiming a returning player -- a caption
     * that is not true of the picture.
     *
     * `waitVisible` rather than an empty step list. Boot is synchronous all the way from
     * `main.ts` through `boot()` to the state machine opening at `launch`, so the splash is
     * up by the time `load` fires and an empty list would work today. The wait costs nothing
     * and stops that being a silent assumption: if boot ever gains an await, this state
     * fails with a named selector instead of photographing an empty page.
     */
    menu: 'none',
    steps: [{ waitVisible: '.hud-splash' }],
    measure: ['.hud-splash', '.hud-splash-title', '.hud-splash-hint'],
  }),
  state({
    id: 'screen.main-menu',
    title: 'Main Menu, mid-campaign',
    description: 'The menu a returning player meets: Continue, the run summary, and the Levels entry.',
    storage: MID_CAMPAIGN,
    steps: PAST_SPLASH,
    measure: ['.hud-panel', '.hud-title', '.hud-run-summary', '.hud-continue', '.hud-new-game'],
  }),
  state({
    id: 'screen.main-menu.pad-only',
    title: 'Main Menu reached by controller alone',
    description:
      'The menu as a player who never touched a key, a mouse or the screen meets it: the '
      + 'splash was dismissed with a controller button and nothing else has been pressed.',
    // THE FIRST STATE IN THIS CATALOGUE WITH NO KEYBOARD OR POINTER INPUT AT ALL, and the
    // reason `{ padPress }` exists (issue #917). Every other state here starts with
    // `PAST_SPLASH`, which presses Space -- so the whole catalogue photographed pages whose
    // last input was a keystroke, and a controller-only session had no representation.
    //
    // That distinction is not cosmetic: a browser decides what `:focus-visible` matches from
    // the last input it saw, and a pad press is not a DOM input event at all, so these are
    // genuinely different pages to the engine that styles them.
    storage: MID_CAMPAIGN,
    steps: [
      // A SILENT pad. `mixed` ships with button 7 already down and the poller dispatches
      // that on its first read, which dismissed the splash on its own -- measured, by running
      // this state with the press removed and watching it pass anyway.
      { fakeGamepads: 'idle' },
      // Confirm. The splash takes any input, and a pad is the one it has never been shown
      // taking here -- `{ fakeGamepads }` alone could not press it, because the fixture is a
      // static array and the menu poller dispatches on the press->release edge.
      { padPress: { button: 0 } },
      { waitHidden: '.hud-splash' },
    ],
    // The same five selectors `screen.main-menu` measures, on the same seeded storage, so the
    // two are a direct comparison: identical measurements say the menu a controller player
    // reaches is the menu everyone else reaches, which is the claim worth pinning.
    measure: ['.hud-panel', '.hud-title', '.hud-run-summary', '.hud-continue', '.hud-new-game'],
  }),
  state({
    id: 'screen.main-menu.pad-focus',
    title: 'Main Menu with the controller focus ring',
    description:
      'The same controller-only session one D-pad press later, with the focus ring the pad '
      + 'modality paints. This is the state that photographs the ring.',
    // ISSUE #917's LAST ACCEPTANCE CRITERION. The ring itself has been pinned since #984 by
    // source-text assertions and two mutation entries; what none of them is, is a picture.
    //
    // ARRIVAL IS NOT ENOUGH, and that is the whole reason this is a second state rather than
    // two more steps on `pad-only`. MEASURED on the built bundle: after the confirm press the
    // splash is gone and `.hud--padnav` is already on, but `document.activeElement` is
    // `div.hud-panel` -- the pane CONTAINER, which the ring rule excludes by design with
    // `:not([tabindex="-1"])`, because a bare `[tabindex]:focus` would ring the whole pane on
    // every panel-open transition. So a controller player's first screen carries no ring, and
    // it takes one direction press to put focus on a control that can wear one.
    //
    // (Which control that is, is issue #919's open question -- arrival focus on the container
    // or on the primary action. This state does not depend on the answer: it presses a
    // direction either way, and it is the press, not the arrival, that is being photographed.)
    storage: MID_CAMPAIGN,
    steps: [
      { fakeGamepads: 'idle' },
      { padPress: { button: 0 } },
      { waitHidden: '.hud-splash' },
      // D-pad down. 12-15 are the standard mapping's up/down/left/right (`gamepad-menu.ts`),
      // and `route-host.ts`'s `onMenuAction` turns one into `hud.act('down')`, which ends in
      // the programmatic `.focus()` that `:focus-visible` refuses to ring. That refusal IS
      // issue #917.
      { padPress: { button: 13 } },
    ],
    // `:focus` rather than a class: what this state is about is whatever control the press
    // landed on, and naming one would pin the ROVING ORDER as well as the ring, so a future
    // change to which control comes first would read as a ring regression. The measurement
    // records the element's text, so the baseline still says which control it was.
    measure: ['.hud-panel', ':focus'],
    // The four properties a focus ring IS. None of them is in the capture's default list,
    // which is about layout, and an outline moves no box -- so without this the ring could
    // vanish and this state's baseline would not move a byte, which is the failure mode the
    // state exists to close rather than reproduce.
    watch: ['outline-style', 'outline-width', 'outline-color', 'outline-offset'],
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
    // The heading is measured because it is the box that goes ABOVE the scroll origin when
    // this pane overflows (issue #633): the pane and the grid can both read positive while
    // the title the pane is labelled by is off the top and unreachable.
    measure: ['.hud-levelselect', '#hud-levelselect-title', '.hud-levels', '.hud-levels-note'],
  }),
  state({
    id: 'screen.practice',
    title: 'Practice, mid-round',
    description:
      'A practice round in play. The ninth AppRoute kind, and the only one the catalogue '
      + 'never reached: the two practice ENDING panels photograph how a practice run '
      + 'finishes, not what it looks like while it is running.',
    storage: MID_CAMPAIGN,
    /**
     * Through Level Select, because that is what actually starts a practice session: a
     * level picked from the grid runs as PRACTICE rather than as a campaign run, which is
     * why the topbar chip below reads "Practice" and the campaign Lives/Enemies stats do
     * not. Reached the same way `screen.levels` reaches the grid, then one level further.
     *
     * READINESS is explicit -- the chip, not a sleep. The arena behind it is NOT pinned:
     * the start countdown is drawn in the 3D scene rather than the DOM, so there is no
     * selector to wait for its end and the digit showing depends on how long the click took.
     * That is a content-determinism problem for whoever commits a baseline over this state
     * (#846), not a readiness one, and it is recorded here rather than left to be discovered
     * from a diff.
     */
    steps: [
      ...PAST_SPLASH,
      { click: '.hud-levelselect-open' },
      { waitVisible: '.hud-levelselect' },
      { click: '.hud-level-btn[aria-label="Level 1"]' },
      { waitVisible: '.hud-practice' },
    ],
    // No menu: a live board's only controls are the on-screen driving ones, which the hit
    // collector leaves out because they are not menu targets. The pause OVERLAY has buttons
    // and is swept -- `screen.pause.campaign` is that state -- but the board behind it has
    // none at all.
    menu: 'none',
    // The chip is the assertion: it is present and unhidden only in a practice session, so
    // a capture that silently started a campaign run would fail rather than look right.
    measure: ['.hud-practice', '.hud-topbar', '.hud-lives', '.hud-enemies'],
  }),
  state({
    id: 'screen.practice.touch',
    title: 'Practice on a touchscreen, with the driving controls up',
    description:
      'The only state that puts the on-screen driving controls in front of a gate. They are '
      + 'sized by --hud-control-touch, a 56px floor no check could reach before this.',
    storage: MID_CAMPAIGN,
    touch: true,
    steps: [
      ...PAST_SPLASH,
      { click: '.hud-levelselect-open' },
      { waitVisible: '.hud-levelselect' },
      { click: '.hud-level-btn[aria-label="Level 1"]' },
      { waitVisible: '.hud-practice' },
      // The row is toggled by `setState`, not by the touch profile, so waiting on the
      // practice chip alone would photograph the board a tick before the controls arrive.
      { waitVisible: '.hud-fire-btn' },
    ],
    // No menu, for the reason `screen.practice` gives: the hit collector leaves the driving
    // controls out because they are not menu targets, and the 44px menu floor is the wrong
    // number for them anyway. This state exists so the 56px one has somewhere to be read.
    menu: 'none',
    /**
     * THE THREE CONTROLS ARE THE POINT. `--hud-control-touch` (hud.css:187) gives
     * `.hud-pause-btn`, `.hud-fire-btn` and `.hud-mine-btn` a 56px minimum in both
     * dimensions, and issue #633 recorded that nothing asserted it. Nothing COULD:
     * `screen.settings.touch` was the only state with a touchscreen and it is a pane, and
     * `hit-sweep.mjs` skips `.hud-touch` by rule.
     *
     * Measured before this state existed, in a touch context on a live round: 56x56,
     * 66.2x56 and 69.5x56, every one fully inside the viewport at 320x568, 390x844 and
     * 640x400@2x. The floor held; what was missing was a gate that would notice if it
     * stopped holding.
     */
    measure: ['.hud-touch', '.hud-pause-btn', '.hud-fire-btn', '.hud-mine-btn'],
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
    // `#hud-settings-title` is measured for its Y (issue #642): it is the pane's FIRST
    // child, and the centred-overflow clip is a property of the TOP of a scroll container
    // -- the bottom controls already measured here stay on screen either way. A negative y
    // is content above the scroll origin, which no scrollbar reaches.
    measure: ['.hud-settings', '#hud-settings-title', '.hud-reset-stats', '.hud-reset-progress'],
  }),
  state({
    id: 'screen.settings.ui-scale',
    title: 'Settings at 150% UI scale',
    description:
      'The same pane for a player who raised the in-game UI scale, which multiplies the '
      + 'type and spacing scales.',
    // Issue #843 filed this capture and issue #290 is why it is only now worth taking. The
    // catalogue could already seed `uiScale`, but NOTHING multiplied by `uiScaleFactor`, so
    // this state photographed a page byte-identical to `screen.settings` -- measured at the
    // time, both the measurements and the full-page pixels (sha 1c99be6edd3226e6 at 100 and
    // at 150). The consumer landed with this state, which is what turns it into evidence.
    //
    // The reader defaults every field it is not given (`settings.ts`), so naming only the
    // one under test keeps the seed about `uiScale` and nothing else.
    storage: {
      ...MID_CAMPAIGN,
      'tanks.settings.v1': JSON.stringify({ version: 1, presentation: { uiScale: 150 } }),
    },
    steps: [...PAST_SPLASH, { click: '.hud-settings-open' }, { waitVisible: '.hud-settings' }],
    // THE SAME FOUR SELECTORS `screen.settings` measures, deliberately, so the two baselines
    // are a direct before/after of the scale rather than two unrelated pictures. Baselines
    // record `font-size` and the box, which is exactly where a 1.5x multiplier shows up: if
    // the consumer is ever removed, these measurements collapse back onto `screen.settings`'s
    // and this state stops differing from it -- which is the failure this state exists to
    // catch, and the one it could not catch before the consumer existed.
    measure: ['.hud-settings', '#hud-settings-title', '.hud-reset-stats', '.hud-reset-progress'],
  }),
  state({
    id: 'screen.settings.touch',
    title: 'Settings on a touchscreen',
    description:
      'The same pane on a device with a touchscreen, where two controls exist that the '
      + 'desktop capture does not offer at all.',
    storage: MID_CAMPAIGN,
    touch: true,
    steps: [...PAST_SPLASH, { click: '.hud-settings-open' }, { waitVisible: '.hud-settings' }],
    // The two touch-only controls are the POINT of this state, and they are measured rather
    // than merely photographed so the difference is asserted and not left to the eye:
    // `control-relevance.ts` gives `touchScheme` and `fireMode` to a device with a
    // touchscreen and OMITS them otherwise, so on the desktop capture of `screen.settings`
    // these two selectors are absent. A capture that silently lost its touch context would
    // photograph the desktop pane, which looks like a perfectly good Settings screenshot --
    // the measurement is what tells the two apart.
    measure: ['.hud-settings', '.hud-scheme-toggle', '.hud-firemode-toggle'],
  }),
  state({
    id: 'screen.settings.focused',
    title: 'Settings, a control holding keyboard focus',
    description:
      'The focus ring on a shipped control, reached the way a keyboard user reaches it '
      + '(issue #842). `:focus-visible` is the state being shown, and Chromium does not '
      + 'reliably apply it to a programmatic `element.focus()` -- so the step focuses, steps '
      + 'off with Shift+Tab and back on with Tab, then reads `document.activeElement` back. A '
      + 'focus that failed to engage would photograph the rest state, which looks exactly '
      + 'like a control with no focus rule.',
    storage: MID_CAMPAIGN,
    steps: [
      ...PAST_SPLASH,
      { click: '.hud-settings-open' },
      { waitVisible: '.hud-settings' },
      { focusKeyboard: '.hud-settings-controllers' },
    ],
    measure: ['.hud-settings', '.hud-settings-controllers'],
  }),
  state({
    id: 'screen.settings.pressed',
    title: 'Settings, a control held down',
    description:
      'The pressed look of a shipped button, held rather than clicked (issue #842). A '
      + '`mouse.down()` followed by an `up()` in the same place is a CLICK -- capturing this '
      + 'on New Game started a game and lost the screen underneath it -- so the step presses '
      + 'and does not release, and the page teardown is the release. `:active` is read back '
      + 'from the element, because a press that missed and a button with no active rule '
      + 'produce the same picture.',
    storage: MID_CAMPAIGN,
    steps: [
      ...PAST_SPLASH,
      { click: '.hud-settings-open' },
      { waitVisible: '.hud-settings' },
      { pressHold: '.hud-settings-controllers' },
    ],
    measure: ['.hud-settings', '.hud-settings-controllers'],
  }),
  state({
    id: 'screen.settings.rumble-refused',
    title: 'Settings, rumble refused with its reason',
    description:
      'The first settings control that is ever disabled, beside the sentence saying why '
      + '(issues #227, #842). A capture machine has no gamepad and no vibration motor, so the '
      + 'refusal is the honest state of this browser rather than one staged for the shot. '
      + '`control-relevance.ts` records the rule it demonstrates -- a TRANSIENT absence is '
      + 'shown and explained, not omitted -- and `describeDisabledReason` points the '
      + "control's `aria-describedby` at the note, so the reason reaches a screen reader "
      + 'through the control rather than only sitting near it.',
    storage: MID_CAMPAIGN,
    steps: [
      ...PAST_SPLASH,
      { click: '.hud-settings-open' },
      { waitVisible: '.hud-settings' },
      // The note carries `--hidden` until the refusal is known, so waiting on it is what
      // proves the disabled state arrived rather than the shot being taken before it did.
      { waitVisible: '.hud-rumble-note' },
    ],
    measure: ['.hud-settings', '.hud-rumble-toggle', '.hud-rumble-note'],
  }),
  state({
    id: 'screen.settings.controller-layout',
    title: 'Controller Layout',
    description:
      'The Controller Layout pane over a synthetic standard pad (issue #754): the Sticks preset, ' +
      'the five action rows naming the button each reads, and Reset to Recommended.',
    storage: MID_CAMPAIGN,
    steps: [
      ...PAST_SPLASH,
      { fakeGamepads: 'mixed' },
      { click: '.hud-settings-open' },
      { waitVisible: '.hud-settings' },
      { click: '.hud-settings-layout' },
      { waitVisible: '.hud-layout' },
      { waitHidden: '.hud-layout-empty' },
    ],
    // The empty state is measured for its ABSENCE, as the self-test's is: a pane showing both the
    // explanation and the controls, or neither, is the failure this picture has to show.
    measure: ['.hud-layout', '#hud-layout-title', '.hud-layout-preset', '.hud-layout-bindings', '.hud-layout-reset'],
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
    // this pane, and the pane was one of the two that centred the main axis of a scroll
    // container until issue #642 top-aligned it -- so where this button sits is still the
    // number that says whether one more control pushed the pane past the viewport.
    // `#hud-devtools-title` is measured for the same reason as Settings': the pane's first
    // child is where the centred-overflow clip shows, and a negative y is lost content.
    // `.hud-diag-copy` and `.hud-diag-pin` are measured for their BOXES (issue #247): they are
    // the two controls that issue added to this pane, and where they sit is what says whether
    // two more entries pushed the pane past a viewport.
    measure: ['.hud-devtools', '#hud-devtools-title', '.hud-selftest-open', '.hud-diag-copy', '.hud-diag-pin', '.hud-devtools-back'],
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
    id: 'screen.devtools.production-save',
    title: 'Developer Tools, on the production save',
    description:
      'The namespace warning issue #249 requires to stay obvious while production data is ' +
      'active in a dev session. Reached with `?dev=1&prodSave=1`, which is the only way to ' +
      'get there -- the flag is inert without the gate.',
    // The PRODUCTION keys, deliberately: this state is about a session that is NOT namespaced,
    // so seeding the developer keys would leave the pane describing an empty save.
    storage: MID_CAMPAIGN,
    query: '?dev=1&prodSave=1',
    steps: [...PAST_SPLASH, { click: '.hud-devtools-open' }, { waitVisible: '.hud-devtools' }],
    // The namespace line is measured for its TEXT and its colour: the warning is what
    // distinguishes this state from the ordinary one, and a line that merely said something
    // different would not be the criterion.
    measure: ['.hud-devtools', '.hud-devns', '.hud-devreset', '.hud-devtools-back'],
  }),
  state({
    id: 'screen.devtools.actions',
    title: 'Developer Tools, with a round running',
    description:
      'The three runtime actions issue #252 added, which are hidden unless a round exists. ' +
      'Reached by continuing the saved run and opening the pane from the DEV badge, because ' +
      'from the main menu there is nothing to restart and all three are absent.',
    storage: MID_CAMPAIGN_DEV,
    query: '?dev=1',
    steps: [
      ...PAST_SPLASH,
      { click: '.hud-continue' },
      { waitHidden: '.hud-panel' },
      { click: '.hud-devbadge' },
      { waitVisible: '.hud-devtools' },
    ],
    // Each action measured by its own id rather than by the shared class: `querySelector`
    // returns the first match, so one `.hud-devact` selector would photograph three controls
    // and report one, and a pane that rendered only the first would measure as correct.
    measure: [
      '.hud-devtools',
      '.hud-devact[data-action="restart-same-seed"]',
      '.hud-devact[data-action="reroll-seed"]',
      '.hud-devact[data-action="restart-round"]',
      '.hud-devtools-back',
    ],
  }),
  state({
    id: 'screen.devtools.diagnostics',
    title: 'Developer Tools, diagnostics copied',
    description:
      'The session diagnostics report Copy Diagnostics writes into the pane. Taken from the ' +
      'main menu, so it is the no-session report -- deterministic by construction, because a ' +
      'running world would put a clock-derived seed in the picture.',
    storage: MID_CAMPAIGN_DEV,
    query: '?dev=1',
    steps: [
      ...PAST_SPLASH,
      { click: '.hud-devtools-open' },
      { waitVisible: '.hud-devtools' },
      { click: '.hud-diag-copy' },
      { waitVisible: '.hud-diag-out' },
    ],
    // The field is measured for its BOX and its TEXT: a button that wrote nothing, or wrote
    // into a field still hidden by its own modifier, is the failure this picture has to show.
    measure: ['.hud-devtools', '.hud-diag-out', '.hud-diag-copy'],
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
  state({
    id: 'screen.controllers',
    title: 'Controllers, from Pause',
    description:
      'The controller assignment pane (issue #766), reached the only way a player can: start a ' +
      'round, pause, and press Controllers. No pad is connected, so each slot names its default ' +
      'source.',
    // A FRESH save, not `MID_CAMPAIGN`: with a run active, New Game opens the replace-run
    // confirmation instead of starting the round this path needs.
    steps: [
      ...PAST_SPLASH,
      { click: '.hud-new-game' },
      { waitHidden: '.hud-panel' },
      { press: 'Escape' },
      { waitVisible: '.hud-controllers-open' },
      { click: '.hud-controllers-open' },
      { waitVisible: '.hud-controllers' },
    ],
    measure: ['.hud-controllers', '#hud-controllers-title', '.hud-controller-rows', '.hud-controllers-back'],
  }),
  state({
    id: 'screen.controllers.pads',
    title: 'Controllers, from Pause, with two pads',
    description:
      'The same pane over the two synthetic pads `mixed` installs (issue #766): a standard pad and a ' +
      'non-standard one, so each slot lists the pads it can take and the unsupported note shows.',
    steps: [
      ...PAST_SPLASH,
      { click: '.hud-new-game' },
      { waitHidden: '.hud-panel' },
      { press: 'Escape' },
      { waitVisible: '.hud-controllers-open' },
      { fakeGamepads: 'mixed' },
      { click: '.hud-controllers-open' },
      { waitVisible: '.hud-controllers' },
    ],
    measure: [
      '.hud-controllers', '#hud-controllers-title', '.hud-controller-rows', '#hud-controllers-unsupported',
      '.hud-controllers-back',
    ],
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
  // ---- The same two endings, reached by PLAYING (issue #617) -------------------------
  //
  // The pushed-outcome states above prove the SCREEN. These prove the PATH: the game is
  // played from Continue until the ending's panel shows, with `autoplay` driving the player
  // and `seed` pinning both the world and, since #617, the autoplay controller -- so the
  // same match plays every run. A game that stopped being winnable, or stopped ending a run
  // out of lives, fails these and not the pushed ones.
  //
  // `expect` checks WHICH ending was reached: both panels show `.hud-action`, so without it
  // an autoplay that won would photograph Mission Clear under the Game Over id and pass.
  //
  // Campaign complete is deliberately NOT played: it would chain five levels of this, the
  // most expensive capture in the repository for the least conditional screen (owner ruling
  // on #617). Its pushed-outcome state stays the evidence.
  state({
    id: 'screen.ending.mission-clear.played',
    title: 'Mission clear, played',
    description: 'Level 3 won by autoplay from Continue, invincible so the win cannot turn into a loss: the path to Mission Clear, not only its panel.',
    storage: MID_CAMPAIGN_DEV,
    query: '?dev=1&replay=1&autoplay=1&invincible=1&seed=7',
    steps: [
      ...PAST_SPLASH,
      { click: '.hud-continue' },
      // Budget: twice the 1035 simulated ticks this match took on each of 2 runs (issue #617).
      { playUntil: { visible: '.hud-action', maxTicks: 2070, expect: { selector: '.hud-title', text: 'Level 3 cleared!' } } },
    ],
    measure: ['.hud-panel', '.hud-title', '.hud-action', '.hud-choose-level', '.hud-practice-level'],
  }),
  state({
    id: 'screen.ending.campaign-over.played',
    title: 'Campaign over, played',
    description: 'The run\'s last lives lost to level 3 by autoplay from Continue: the path to Game Over, not only its panel.',
    storage: MID_CAMPAIGN_DEV,
    query: '?dev=1&replay=1&autoplay=1&seed=7',
    steps: [
      ...PAST_SPLASH,
      { click: '.hud-continue' },
      // Budget: twice the 2190 simulated ticks this match took on each of 2 runs (issue #617).
      { playUntil: { visible: '.hud-action', maxTicks: 4380, expect: { selector: '.hud-title', text: 'Game Over' } } },
    ],
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

  // ---- The versus results panel, reached by PLAYING (issue #776) ---------------------
  //
  // A finished versus match has ONE exit and no state reached it: `loop.ts` deliberately
  // leaves `vs-match-end` out of the pushed `outcome` arms, because issue #279 owned this
  // screen. #279 closed without it, so these two are the only evidence the panel exists --
  // and unlike every campaign ending above, there is no pushed twin to fall back on. That is
  // why both are played and neither has a cheaper stand-in.
  //
  // WHO PLAYS. `autoplay` substitutes SLOT 0 and only slot 0 (`loop.ts`, `autoplayRnd`), and
  // every other slot's own source still samples through on the same tick. A pane-launched
  // versus session goes through that same input path, which issue #776's first acceptance
  // criterion asked to be resolved either way: MEASURED, by launching one and watching it
  // finish -- 4 runs, every one reaching a winner with zero page errors. So slot 0 is driven
  // by autoplay and the bots in the other slots fight it, with no human input at all.
  //
  // The setup arrives through STORAGE rather than through clicks on the pane. Both are
  // reachable, and the `screen.versus-setup.*` states already photograph the clicking; what
  // these need is the launch, and a seven-click path to it is seven more things that can
  // change under them.
  //
  // `expect` on the title is what makes these say anything. Both panels show `.hud-action`,
  // so without it a Teams match that ended some other way would be photographed under the
  // FFA id and pass -- the same trap issue #617 recorded for the campaign pair.
  state({
    id: 'screen.ending.versus.ffa.played',
    title: 'Versus results, FFA',
    description:
      'A two-player FFA decided at one stock, played by autoplay against a bot: Rematch, ' +
      'Change Setup and Main Menu, the three exits a finished versus match has.',
    storage: VERSUS_FFA_DEV,
    query: '?dev=1&replay=1&autoplay=1&seed=7',
    steps: [
      ...PAST_SPLASH,
      { click: '.hud-versus-open' },
      { waitVisible: '.hud-versus-setup' },
      { click: '.hud-versus-start' },
      // Budget: twice the 1844-1849 simulated ticks this match took over 4 measured runs
      // (2 driven through the pane, 2 through the retained setup these states use).
      { playUntil: { visible: '.hud-action', maxTicks: 3700, expect: { selector: '.hud-title', text: 'Player 1 wins' } } },
    ],
    measure: ['.hud-panel', '.hud-title', '.hud-action', '.hud-change-setup', '.hud-quit'],
  }),
  state({
    id: 'screen.ending.versus.teams.played',
    title: 'Versus results, Teams',
    description:
      'The 2v1 Teams ending: the same three exits, under a title that names a TEAM rather ' +
      'than a player, which is the difference this state exists beside the FFA one for.',
    storage: VERSUS_TEAMS_DEV,
    query: '?dev=1&replay=1&autoplay=1&seed=7',
    steps: [
      ...PAST_SPLASH,
      { click: '.hud-versus-open' },
      { waitVisible: '.hud-versus-setup' },
      { click: '.hud-versus-start' },
      // Budget: twice the 2244-2255 simulated ticks this match took over 4 measured runs.
      { playUntil: { visible: '.hud-action', maxTicks: 4600, expect: { selector: '.hud-title', text: 'Team 1 wins' } } },
    ],
    measure: ['.hud-panel', '.hud-title', '.hud-action', '.hud-change-setup', '.hud-quit'],
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
    // The container AND its text. `[role="alert"]` alone is a full-viewport flex box whose
    // geometry cannot move whatever the type does, so measuring only it made these two states
    // blind to the thing #864 changed here -- and that blindness is why the inline card in
    // index.html stayed on `system-ui` unnoticed. The h1 and p are text-sized, so they move
    // when the face does.
    measure: ['[role="alert"]', '[role="alert"] h1', '[role="alert"] p'],
  }),
  state({
    id: 'screen.startup.probe-blocked',
    title: 'Startup failure: the probe could not run',
    description: 'getContext threw. Different cause, different advice: extensions and privacy modes.',
    webgl: 'probe-blocked',
    steps: [{ waitVisible: '[role="alert"]' }],
    // The container AND its text. `[role="alert"]` alone is a full-viewport flex box whose
    // geometry cannot move whatever the type does, so measuring only it made these two states
    // blind to the thing #864 changed here -- and that blindness is why the inline card in
    // index.html stayed on `system-ui` unnoticed. The h1 and p are text-sized, so they move
    // when the face does.
    measure: ['[role="alert"]', '[role="alert"] h1', '[role="alert"] p'],
  }),
  state({
    id: 'screen.startup.match-failed',
    title: 'A match could not start',
    description:
      'The probe passed and the menu came up; building the match then fails for a reason the '
      + "game cannot name. Since issue #325's 2026-09-11 ruling this is an OVERLAY over the "
      + 'working Main Menu rather than a replacement for the page, and since #685 it offers '
      + 'Retry beside Back to menu. It deliberately does not vouch for the rest.',
    steps: [
      ...PAST_SPLASH,
      // `match-build-fails`, NOT `probe-blocked` (issue #700). Breaking the context itself is
      // a typed, FATAL failure since #669 and lands on the full page instead of this overlay.
      { breakWebgl: 'match-build-fails' },
      { click: '.hud-new-game' },
      // `.hud-alert`, not `[role="alertdialog"]`: the replace-run confirmation declares the
      // same role, and a selector that could match either would pass on the wrong dialog.
      { waitVisible: '.hud-alert' },
      // ...and Retry, which is what distinguishes this overlay from the one #685 extended.
      { waitVisible: '.hud-alert-retry' },
    ],
    // `.hud-panel` is measured EXPECTING it to be hidden, which is why this state reports
    // 4 of 5 visible rather than 5 of 5. (3 of 4 until issue #685 added Retry beside
    // Back to menu; the count is restated here because a stale one reads as a defect.) The layer stack swaps surfaces, so the menu is not
    // drawn behind the alert; its 0x0 box is the record of that, and an earlier draft of
    // this feature claimed the opposite in player-facing copy. Remove it here and the next
    // reader has to rediscover the fact by hand.
    measure: ['.hud-alert', '.hud-alert-body', '.hud-alert-retry', '.hud-alert-dismiss', '.hud-panel'],
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
