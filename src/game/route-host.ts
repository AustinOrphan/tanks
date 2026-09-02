import { createRouteUi, type RouteUi, type RouteUiDeps, type StyleSink } from './route-ui';
import { createOutcomeClassifier, type GameStateMachine, type OutcomeContext } from './state';
import { versusDraw } from './app-state';
import type { Hud } from './hud';
import { locationToHudSurface, type GameDeps } from './loop';
import type { VersusConfig } from './versus-config';
import type { SlotSource } from '../input/assignment';

/**
 * The PAGE's application-route UI, owned above every gameplay session (issue #468).
 *
 * `app-shell.ts` owns what must outlive a session -- settings, audio, the Launch gate,
 * the render capability. `session-host.ts` owns what is REPLACED with one. This owns the
 * third thing: the HUD element tree, the state machine that says which route is showing,
 * and the `RouteUi` controller #427 extracted. Before this module those three were built
 * inside `startGameWith`, which is what made the menu cost a world -- reaching Main Menu
 * meant constructing a session, because a session was the only thing that ever built the
 * HUD.
 *
 * WHY A SLOT RATHER THAN A SECOND ROUND OF REGISTRATIONS. `hud.ts` APPENDS every
 * `on*` callback onto a per-name list and has no unregister at all -- all 25 of its
 * registration methods are `push(cb)` returning `void`, and there is no `off`, no
 * `delete`, no `splice` anywhere in the file. So a page-scoped HUD that let each session
 * register its own handlers would, after one stop-and-start, hold TWO copies of every
 * gameplay handler: a single New Game click would start two runs, a single Quit would
 * quit twice. Nothing in the existing suite could see it, because nothing before this
 * issue could stop a session and start another on the same HUD.
 *
 * So the seven gameplay-facing handlers are registered ONCE here, as trampolines that
 * dispatch to whatever session currently holds the slot. A session takes the slot with
 * `attach()`, fills it, and releases it with `slot.detach()`. With no session the
 * trampolines are live and do nothing, which is the ordinary state of a page whose host
 * is empty -- exactly the shape `route-ui.ts`'s `setStyleSink(sink | null)` already uses,
 * and for the same reason.
 *
 * WHAT IS NOT HERE. Match creation timing is unchanged: `boot.ts` still starts a session
 * eagerly, and `requestVersusSession`/`requestCampaignSession` still reboot one. Issue
 * #428 owns removing that; this issue owns only the ownership boundary that makes it
 * possible. Route history, Back semantics and focus restoration are issue #318's.
 */

/** Everything the page-scoped route UI needs, and deliberately nothing session-shaped. */
export type RouteHostDeps = RouteUiDeps &
  Pick<GameDeps, 'createHud' | 'createStateMachine' | 'launchGate' | 'run'>;

/**
 * The two application-level start requests, threaded in rather than read off a session.
 *
 * This is the seam issue #468 asks for: "gameplay-starting route actions become explicit
 * application-level requests that do not require dereferencing an existing gameplay
 * session". Today `boot.ts` forwards both straight into `GameSessionHost`'s reboot paths,
 * which is the temporary compatibility path the issue permits and #428 replaces.
 */
export interface SessionRequests {
  /**
   * Start a match (issue #428). The ONE boundary that creates a gameplay session.
   *
   * Reached from the route UI when no session holds the slot, which since #428 is the
   * state the page boots into: `boot.ts` no longer starts a session eagerly, so Continue,
   * New Game, a Practice level pick and Versus Start are the only four things that can
   * bring a world, a seed and a renderer into existence.
   */
  readonly requestStart: (intent: StartIntent) => void;
  readonly requestVersusSession: (config: VersusConfig) => void;
  readonly requestCampaignSession: () => void;
  /**
   * Return to the application routes (issue #429). The ONE boundary that disposes a
   * gameplay session.
   *
   * Called by the page, not by the session: a session cannot be trusted to dispose itself
   * on the way out, and four separate handlers each remembering to would be four places
   * for one to stop. See `leavingGameplay` below for the single rule that decides when.
   */
  readonly requestStop: () => void;
}

/**
 * What the player asked to play (issue #428).
 *
 * Deliberately a REQUEST, not a resolved session: it names the gesture, and the start
 * boundary in `boot.ts`/`loop.ts` is what turns it into a level, an identity, a seed and
 * a world. Keeping the two apart is what lets an invalid request be rejected before any
 * of that is consumed -- `session-intent.ts` makes the same split for a boot, and this is
 * the per-gesture version of it.
 */
export type StartIntent =
  /** Continue: resume the active campaign run on whatever level it reached. */
  | { readonly kind: 'campaign-continue' }
  /** New Game: start a fresh run at level one. The only intent that writes the run. */
  | { readonly kind: 'campaign-new' }
  /** A Practice level pick. Isolated play; never reads or writes the campaign run. */
  | { readonly kind: 'practice'; readonly level: number }
  /** Versus Start, on the validated retained configuration. */
  | { readonly kind: 'versus'; readonly config: VersusConfig };

/**
 * One session's hold on the gameplay-facing half of the route UI.
 *
 * Registration REPLACES rather than appends -- the opposite of `hud.ts` -- so a session
 * that wired a handler twice would still be dispatched to once. That is deliberate: the
 * append semantics below this are what made double-registration invisible in the first
 * place, and a slot that reproduced them would move the bug rather than fix it.
 */
export interface GameplaySlot {
  onStartRestart(cb: () => void): void;
  onLevelSelect(cb: (level: number) => void): void;
  onNewGame(cb: () => void): void;
  onMineTap(cb: () => void): void;
  onFireTap(cb: () => void): void;
  onQuitToTitle(cb: () => void): void;
  onReassignSlot(cb: (slot: number, source: SlotSource) => void): void;
  /**
   * This session's gameplay hotkeys -- mute, pause, the developer keys.
   *
   * On the SLOT rather than on the host directly (issue #428) because the page has to see
   * the key first: the Launch route is dismissed by any key, and with two independent
   * listeners the page's would dismiss and the session's would then see a route that was
   * no longer `launch` and treat the same keystroke as a hotkey. "Press any key to begin"
   * would include M, which mutes -- silencing the menu bed the screen exists to make
   * audible. One listener, one decision, no ordering to get right.
   */
  onKey(cb: (e: KeyboardEvent) => void): void;
  /**
   * Where `classifyOutcome` reads its session-specific context.
   *
   * The state machine is built ONCE, here, but `createOutcomeClassifier` needs "is this
   * the last level of THIS session's sequence" and "who survived in THIS session's
   * world" -- both of which are facts about a driver that did not exist when the machine
   * was built. This is the indirection that lets the machine outlive them.
   */
  setOutcomeContext(ctx: OutcomeContext): void;
  /** Point the paint shop at this session's renderer. See `RouteUi.setStyleSink`. */
  setStyleSink(sink: StyleSink): void;
  /**
   * The versus config this session was built from.
   *
   * RETAINED after detach, not cleared: it is what the Versus Setup pane prefills from,
   * and a player who quits a match and reopens the pane must find their own last match
   * there rather than an empty form. `session-host.ts` retains its `lastVersusConfig` for
   * the same reason and says so.
   *
   * Takes a config and NOT `| null`, so "I am a campaign session" cannot be expressed as
   * "the last match played was nothing". That distinction is the whole of the defect
   * review found on PR #475: a campaign session pushing its own absent config wiped the
   * retained one. A caller with nothing to say now has nothing to call.
   */
  setVersusConfig(config: VersusConfig): void;
  /**
   * Release the slot. Idempotent, and INERT once another session has taken it -- a late
   * detach from an outgoing session must not silently unhook the incoming one. That is
   * the same stale-capture failure `session-host.ts`'s two "stale-capture control" tests
   * exist to catch, one layer up.
   */
  detach(): void;
}

export interface RouteHost {
  /** The page's one HUD. Built at construction, disposed only at page teardown. */
  readonly hud: Hud;
  /** The page's one state machine: which route or gameplay phase is showing. */
  readonly sm: GameStateMachine;
  /** The page's one application-route controller (issue #427). */
  readonly routeUi: RouteUi;
  /**
   * Take the gameplay slot for a new session.
   *
   * Invalidates any previous slot, so a session that forgot to detach cannot keep
   * receiving clicks -- `attach` is the authority on who is live, not `detach`.
   *
   * Also resets the visible route the way a fresh state machine used to. Before this
   * module every Campaign<->Versus reboot built a NEW machine, which opened at Main Menu
   * (or at Launch, when the gate was still up). A machine that now survives the reboot
   * would otherwise hand the incoming session whatever route the outgoing one was on --
   * mid-gameplay, at an outcome screen -- which is the "stale route state" issue #468's
   * acceptance criteria forbid.
   */
  attach(): GameplaySlot;
  /** Is a session holding the slot right now? */
  hasSession(): boolean;
  /**
   * Release the page's route UI. Called ONLY from the page teardown, never from a
   * session: this is the disposal that `startGameWith` used to do on every teardown and
   * must not any more, because the next session needs the same HUD still on screen.
   */
  dispose(): void;
}

/** What one session has filled into the slot. Every field optional: it fills in order. */
interface SlotState {
  startRestart?: () => void;
  levelSelect?: (level: number) => void;
  newGame?: () => void;
  mineTap?: () => void;
  fireTap?: () => void;
  quitToTitle?: () => void;
  reassignSlot?: (slot: number, source: SlotSource) => void;
  key?: (e: KeyboardEvent) => void;
  outcome?: OutcomeContext;
  style?: StyleSink;
}

export function createRouteHost(
  root: HTMLElement,
  deps: RouteHostDeps,
  requests: SessionRequests,
): RouteHost {
  /** The session currently holding the slot, or `null` while the host is empty. */
  let live: SlotState | null = null;
  /**
   * Which slot is current. Compared rather than object-identity-checked so a released
   * slot stays released even if a later one happens to be allocated at the same address.
   */
  let generation = 0;

  /**
   * The versus config the Setup pane prefills from, page-scoped.
   *
   * Read LIVE through the getter below rather than snapshotted into `routeDeps`, because
   * `route-ui.ts` reads `deps.initialVersusConfig` at click time and a snapshot taken
   * before the first session would be permanently `null`.
   */
  let versusConfig: VersusConfig | null = deps.initialVersusConfig ?? null;

  /**
   * The route UI's deps, page-scoped.
   *
   * Three fields are deliberately NOT the ones a session would supply:
   *
   *  - `requestVersusSession`/`requestCampaignSession` are the application-level seams
   *    above, not a session's own copies.
   *  - `initialVersusConfig` is a live getter over the retained config.
   *  - `levels` is whatever `deps` brought, which in production is the CAMPAIGN level
   *    system. It is only read for `unlockedLevels()` -- how many campaign levels the
   *    level-select grid may offer. Before this module the route UI got whichever level
   *    system the LIVE session had, so during a versus match the campaign level-select
   *    grid was sized from the versus arena list. Sizing it from the campaign sequence
   *    regardless of what is being played is the behaviour this hoist makes true.
   */
  const routeDeps: RouteUiDeps = {
    ...deps,
    // Versus Start goes through the SAME start boundary as the other three (issue #428);
    // `requestVersusSession` is kept on the seam because a session's own Rematch still
    // reboots through it, and #429 owns collapsing the two.
    requestVersusSession: (config) => requests.requestStart({ kind: 'versus', config }),
    requestCampaignSession: requests.requestCampaignSession,
    get initialVersusConfig(): VersusConfig | null {
      return versusConfig;
    },
  };

  const sm = deps.createStateMachine({
    /**
     * Both context calls are unreachable with an empty slot, and the fallbacks say so
     * rather than asserting it: `state.ts`'s `onEvents` returns early unless the machine
     * is in `gameplay`/`playing`, and only a session's driver drives `onEvents`. The
     * fallbacks are the conservative direction anyway -- `false` reports Mission Clear
     * rather than inventing a Campaign Complete, and a draw claims no winner.
     */
    classifyOutcome: createOutcomeClassifier({
      isFinalCampaignLevel: () => live?.outcome?.isFinalCampaignLevel() ?? false,
      versusResult: () => live?.outcome?.versusResult() ?? versusDraw(),
    }),
    // Asked ONCE, at page construction. Before this module `startGameWith` asked it per
    // session, which is what made it possible for a reboot to replay the splash; now the
    // machine that would have to be rebuilt is not rebuilt at all.
    initialRoute: deps.launchGate.dismissed() ? 'main-menu' : 'launch',
  });

  const hud = deps.createHud(root);

  /**
   * The application routes (issue #427), wired once onto the page's HUD.
   *
   * `createRouteUi` registers 19 handlers and `hud.ts` appends rather than replaces, so
   * calling it twice on one HUD would double every one of them. It is called here and
   * nowhere else, which is what makes "exactly once per HUD" structural rather than a
   * convention `startGameWith` had to remember.
   */
  const routeUi = createRouteUi(hud, sm, routeDeps);

  // The seven gameplay-facing handlers, registered ONCE. Each is a trampoline: it reads
  // the slot at CLICK time, so it dispatches to whichever session is live and does
  // nothing at all when none is. See this module's doc comment for why the sessions
  // cannot register these themselves.
  /**
   * Three of the seven branch on whether a session exists (issue #428).
   *
   * With a session attached they mean what they always meant -- Resume, Retry, Play
   * Again, a mid-session New Game -- and go to the slot. With NO session they are the
   * gestures that create one, and go to the application-level start boundary instead.
   *
   * That branch is the whole of #428 at this layer, and it is here rather than inside
   * each handler because "is a match running?" is a fact about the page, not about the
   * button. The other four (`onMineTap`, `onFireTap`, `onQuitToTitle`, `onReassignSlot`)
   * have no meaning without a match and stay pure no-ops when the slot is empty.
   */
  /**
   * THE RULE (issue #429): a click that LEAVES gameplay disposes the session.
   *
   * One rule rather than a list of exits, because the list is what goes stale. Quit,
   * Return to Main Menu, Change Setup and the campaign/practice exits are all just
   * "handler ran, and afterwards the machine is no longer in gameplay" -- and so is any
   * exit a later issue adds, without this file having to hear about it.
   *
   * Asked on BOTH sides of the handler, not just after. `onQuitToTitle` early-returns
   * unless the session is paused or on a cleared-level panel, and Resume, Retry, Play
   * Again and Next Level all stay in gameplay; comparing before with after is what tells
   * a real exit from a click that changed nothing. Reading only the after-state would
   * dispose the session on every click made at an application route.
   */
  const leavingGameplay = (handler: () => void): void => {
    const wasInGameplay = sm.inGameplay;
    handler();
    if (wasInGameplay && !sm.inGameplay) requests.requestStop();
  };

  hud.onStartRestart(() => {
    if (live) {
      // Wrapped because this button is ALSO an exit: a finished versus match's action
      // button reads "Versus Setup" and returns to the retained pane (`loop.ts`'s
      // `relaunchTarget` branch). Its other branches -- Resume, Retry, Play Again, Next
      // Level -- all stay in gameplay and so dispose nothing.
      leavingGameplay(() => live?.startRestart?.());
      return;
    }
    requests.requestStart({ kind: 'campaign-continue' });
  });
  hud.onLevelSelect((level) => {
    if (live) {
      live.levelSelect?.(level);
      return;
    }
    requests.requestStart({ kind: 'practice', level });
  });
  hud.onNewGame(() => {
    if (live) {
      live.newGame?.();
      return;
    }
    requests.requestStart({ kind: 'campaign-new' });
  });
  hud.onMineTap(() => live?.mineTap?.());
  hud.onFireTap(() => live?.fireTap?.());
  hud.onQuitToTitle(() => leavingGameplay(() => live?.quitToTitle?.()));
  hud.onReassignSlot((slot, source) => live?.reassignSlot?.(slot, source));

  /**
   * THE LAUNCH GESTURE, moved to the page by issue #428.
   *
   * "Press any key or tap to begin" was dismissed by a listener a SESSION registered, and
   * that was survivable only while `boot.ts` started one eagerly. With the page booting
   * into an empty host, a listener that lives on a session means the splash can never be
   * dismissed at all: the first thing a player ever sees would be the last, and no gesture
   * could get past it.
   *
   * Both halves are page-level facts, which is why they belong together here:
   *
   *  - `sm.dismissLaunch()` acts ONLY from the Launch route (state.ts), so the listeners
   *    are unconditional and the machine does the guarding -- a click during play falls
   *    through to the session's own handlers unchanged.
   *  - `launchGate.dismiss()` records it on the SHELL, which is what stops a later session
   *    -- or, since #428, a page that has never had one -- reopening on the splash.
   *
   * The audio half of this is ORDERING, not unlocking (see `dismissLaunch` in state.ts):
   * `audio/engine.ts` already resumes the context from its own document-level handler.
   * What this guarantees is that a gesture has happened before the menu is on screen.
   */
  /**
   * WHICH SCREEN IS SHOWING -- painted by the page, not by a session (issue #428).
   *
   * This subscription and the initial paint below it lived in `startGameWith`, which was
   * survivable only while a session existed from the first frame. With the page booting
   * into an empty host, a HUD that only a session ever painted would show the player
   * nothing at all: no splash, no Main Menu, and therefore no button with which to start
   * the session that would have painted them.
   *
   * ONLY the surface moved. The session's own `sm.onChange` still owns everything that
   * needs a world -- the music context, clearing queued input, the run bookkeeping -- and
   * still runs for every change this one sees.
   *
   * `locationToHudSurface` is imported from `loop.ts` as a VALUE while `loop.ts` imports
   * this module's types only, so the dependency is one-directional at runtime.
   */
  /**
   * The Main Menu's store-derived affordances, painted by the PAGE.
   *
   * Until this block a session painted these at its own construction and its
   * state-machine subscriber refreshed Continue on every arrival at the Main Menu -- which
   * was complete only while a session existed from the first frame. With the page booting
   * into an empty host (issue #428) the first Main Menu a returning player saw was told
   * nothing beyond which surface to show: no Continue for the run they had left, no
   * Levels grid, an empty Records page, no selected swatch in the paint shop. Measured on
   * `main` at b581d86 through loop.test.ts's page harness, with a saved run and cleared
   * levels in the stores: after the Launch gesture, `rec.continueAvailable` and
   * `rec.levelSelects` were both empty.
   *
   * Everything here is a READ of a page-owned store the route UI already holds. Nothing a
   * session owns -- the attempt counter, the topbar level chip, the settings-driven
   * controls -- is painted from here; a session still pushes its own values at its own
   * construction, and the page's copy is the one that exists before any session does.
   */
  const paintContinue = (): void => {
    hud.setContinueAvailable(deps.run.active() !== null);
  };
  hud.setStats({ lifetime: deps.stats.lifetime(), attempt: deps.stats.attempt() });
  hud.setAchievements(deps.achievements.earned());
  hud.setHullColor(deps.customization.hull());
  hud.setSkin(deps.customization.skin());
  hud.setAccentColor(deps.customization.accent());
  hud.setLevelSelect(routeUi.unlockedLevels(), deps.levels.levels.length);
  paintContinue();

  const stopPainting = sm.onChange((location) => {
    hud.setState(locationToHudSurface(location));
    // Continue is a claim about the run store, re-read on every arrival at the Main Menu.
    // A live session's own subscriber makes the same refresh for the arrivals it sees; this
    // one covers the arrivals no session does -- the first after Launch, and every one
    // after a session has been disposed.
    if (location.kind === 'route' && location.route.kind === 'main-menu') paintContinue();
  });
  hud.setState(locationToHudSurface(sm.location));

  const onLaunchGesture = (): void => {
    sm.dismissLaunch();
    deps.launchGate.dismiss();
  };
  deps.host.addEventListener('pointerdown', onLaunchGesture);

  /**
   * ONE keydown listener for the whole page, and it decides.
   *
   * A key at the Launch route dismisses the splash and does NOTHING ELSE -- that early
   * return is the whole of "the key that begins the game must not also mute it". Every
   * other key falls through to whatever session holds the slot, unchanged.
   *
   * Two independent listeners would not do: whichever ran first would move the route out
   * from under the other's guard, and which one that is depends on registration order at
   * a host neither of them owns.
   */
  const onHostKey = (e: KeyboardEvent): void => {
    if (sm.atLaunch) {
      onLaunchGesture();
      return;
    }
    live?.key?.(e);
  };
  deps.host.addEventListener('keydown', onHostKey);

  // The paint shop's push at the gameplay renderer, same trampoline shape. `route-ui.ts`
  // owns the null case and documents it as the normal state of a session-less page, so
  // this is handed over once and never withdrawn -- what changes is whether the slot
  // behind it holds a renderer.
  routeUi.setStyleSink((hex, skin, accentHex) => live?.style?.(hex, skin, accentHex));

  return {
    hud,
    sm,
    routeUi,
    hasSession: () => live !== null,
    attach(): GameplaySlot {
      const state: SlotState = {};
      live = state;
      const mine = ++generation;
      // The route the outgoing session left behind is not the incoming one's. Guarded on
      // the gate so the FIRST attach of a document load -- where the machine is still at
      // `launch` and nothing has been dismissed -- leaves the splash up.
      if (deps.launchGate.dismissed()) sm.toMainMenu();
      const current = (): boolean => mine === generation;
      return {
        onStartRestart(cb): void {
          if (current()) state.startRestart = cb;
        },
        onLevelSelect(cb): void {
          if (current()) state.levelSelect = cb;
        },
        onNewGame(cb): void {
          if (current()) state.newGame = cb;
        },
        onMineTap(cb): void {
          if (current()) state.mineTap = cb;
        },
        onFireTap(cb): void {
          if (current()) state.fireTap = cb;
        },
        onQuitToTitle(cb): void {
          if (current()) state.quitToTitle = cb;
        },
        onReassignSlot(cb): void {
          if (current()) state.reassignSlot = cb;
        },
        onKey(cb): void {
          if (current()) state.key = cb;
        },
        setOutcomeContext(ctx): void {
          if (current()) state.outcome = ctx;
        },
        setStyleSink(sink): void {
          if (current()) state.style = sink;
        },
        setVersusConfig(config): void {
          // NOT guarded on `current()`: this is retained page state, not a hook into the
          // live session, and the config a session was built from stays true after it.
          versusConfig = config;
        },
        detach(): void {
          if (!current()) return;
          live = null;
          // The menu goes back to the PAGE's shape. `relaunchTarget` and the session kind
          // are pushed only by a session, at its construction, and until this line nothing
          // took them back: after a setup-pane versus match the empty host kept offering
          // "Start Match" and "Campaign", and that "Start Match" -- with no session to
          // dispatch to -- is a New Game, which replaced the player's campaign run with no
          // confirmation. Reset on the way OUT rather than on the next attach, because the
          // page can sit at the Main Menu with no session for as long as the player likes.
          hud.setRelaunchTarget('campaign-levels');
          hud.setSessionKind('campaign');
        },
      };
    },
    dispose(): void {
      deps.host.removeEventListener('pointerdown', onLaunchGesture);
      deps.host.removeEventListener('keydown', onHostKey);
      // The preview then, for the same reason `startGameWith` disposed it before the
      // HUD: it is a second WebGL context hanging off an element the HUD owns.
      routeUi.disposePreview();
      // The page's own subscription, released for the same reason a session releases its
      // own: the machine and this host die together, but a reference kept past teardown
      // must not keep painting a disposed HUD.
      stopPainting();
      hud.dispose();
    },
  };
}
