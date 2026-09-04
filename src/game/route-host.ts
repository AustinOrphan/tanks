import { createRouteUi, type RouteUi, type RouteUiDeps, type StyleSink } from './route-ui';
import { createOutcomeClassifier, type GameStateMachine, type OutcomeContext } from './state';
import { versusDraw } from './app-state';
import type { GameplayHud, Hud } from './hud';
import type { RelaunchTarget } from './session-intent';
import { isMuteHotkey, locationToHudSurface, type GameDeps } from './loop';
import { createGamepadMenuPoller } from '../input/gamepad-menu';
import type { GetGamepads } from '../input/gamepad';
import type { UiAction } from '../input/ui-actions';
import { createModalityTracker, type Modality } from './modality';
import type { VersusConfig } from './versus-config';
import type { Assignment, SlotSource } from '../input/assignment';

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
 * `on*` callback onto a per-name list and has no unregister at all -- all 26 of its
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
  Pick<GameDeps, 'createStateMachine' | 'launchGate' | 'run' | 'devFlags'> & {
    /**
     * The page's ONE HUD factory.
     *
     * Declared HERE rather than on `GameDeps` (where it lived until issue #324's step S8)
     * because this is the only caller: a session has not built a HUD since issue #468, and
     * leaving the factory on the bag of seams `startGameWith` receives meant the session
     * could still ask for a whole `Hud` -- every Settings slider and Main Menu button
     * included -- from a dependency it was handed for building worlds. `createBrowserDeps`
     * still BINDS it (the versus-setup store, the History host and the menu-transition flag
     * are browser wiring, and that is where browser wiring lives); what changed is that the
     * session's own view of those deps no longer names it.
     */
    readonly createHud: (root: HTMLElement) => Hud;
    /**
     * Menu-time gamepad input (issue #494): the pads the page's own poller reads -- the
     * union of every connected pad, never the `pad[i] -> slot[i]` routing a session uses
     * -- and the page frame loop it is sampled on. Injected like every other reader so
     * jsdom drives menus through a fake pad and a fake frame clock.
     */
    readonly menuGamepads: GetGamepads;
    /** Schedule one page frame; returns the cancel. `requestAnimationFrame` in the browser. */
    readonly requestFrame: (cb: (now: number) => void) => () => void;
    /**
     * The clock the modality tracker measures its switch threshold on (issue #496),
     * milliseconds and monotonic. `performance.now()` in the browser; a test drives it
     * by hand so the threshold under test is the one the assertion names.
     */
    readonly now: () => number;
  };

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
  /**
   * WHAT A LIVE MATCH MAY PAINT, and the only HUD a session ever holds (issue #324, S8).
   *
   * `GameplayHud` is `hud.ts`'s own classification of the ten members a match owns, so
   * every application-route member -- the Settings sliders, the Levels grid, the Records
   * tables, the relaunch target -- is simply absent from the type rather than present and
   * discouraged. The debt list in `hud-ownership.test.ts` reached empty by S7; this is
   * what stops it filling again, because the next session-shaped edit that reaches for a
   * route member does not compile.
   *
   * A FACADE, not the HUD itself, and that is the second half. Every method here runs the
   * same generation guard the callbacks above do, so a frame from a retired session --
   * `startGameWith`'s driver can still deliver one after `boot.ts` has stopped it and
   * started its replacement -- paints nothing. Before this, `loop.ts` held the raw `Hud`
   * with no guard at all: the outgoing match's last status push landed on the incoming
   * match's topbar, and nothing in the suite could see it because nothing typed the
   * difference between the two sessions' HUDs.
   */
  readonly hud: GameplayHud;
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
   * The Controllers panel's session-dependent half: who is driving each player slot, and
   * whether `'bot'` may be offered as a source at all.
   *
   * ONE call for both, because they are one projection of one fact: `renderControllerRows`
   * (hud.ts) derives each row's candidate list from the assignment AND the flag together.
   * A reporter that could send one without the other is a reporter that could leave the
   * rows disagreeing with the sources offered for them.
   *
   * Genuinely session-scoped, unlike the rest of what the shell paints: an `Assignment`
   * is built from the match's player count, its validated versus roles and the pads that
   * were plugged in when it started, and it is mutated by the panel for as long as the
   * match lasts. There is no page-owned store to read it from, so the session reports it
   * here and the shell -- which owns every application surface (issue #324) -- is what
   * writes the HUD.
   */
  setControllers(assignment: Assignment, botsMayDrivePlayers: boolean): void;
  /**
   * Return to the retained Versus Setup pane, the way a finished versus match's action
   * button does.
   *
   * The session decides WHETHER (only a setup-pane versus session has anything to go back
   * to -- see `loop.ts`'s `relaunchTarget`); the shell decides WHAT the pane is prefilled
   * with, because the retained configuration is page state that outlives the match that
   * produced it. Callers pair this with the `sm.toMainMenu()` that precedes it: `setState`
   * closes every pane on a surface change, so opening first would have the open undone.
   */
  openVersusSetup(): void;
  /**
   * Release the slot. Idempotent, and INERT once another session has taken it -- a late
   * detach from an outgoing session must not silently unhook the incoming one. That is
   * the same stale-capture failure `session-host.ts`'s two "stale-capture control" tests
   * exist to catch, one layer up.
   *
   * Releasing also EMPTIES the gameplay sink -- see `clearGameplaySink` in this file's
   * implementation for what that is and why the page, not the session, does it.
   */
  detach(): void;
}

/**
 * What the page needs to be TOLD about a session in order to shape the route UI around it
 * (issue #324, step S7).
 *
 * One field, and the interesting part is which fact is NOT here: the session's KIND.
 * `relaunchTarget` answers "what do the title and outcome BUTTONS do", which is settled
 * for a session's whole life by the level system and reboot seam it was built with
 * (`session-intent.ts`'s `RelaunchTarget`). The kind answers "what is being played", which
 * is a property of each WORLD and changes under a Levels pick -- so it rides the per-frame
 * status push instead, where a rebuild can restate it.
 *
 * The two genuinely disagree: `?dev=1&mode=ffa` builds a real FFA world (kind `'versus'`)
 * on the campaign level system, so its buttons stay campaign-shaped. Collapsing them into
 * one attach-time value is the defect `session-title-policy-reused-as-identity` pins in
 * the mutation manifest, and it is the reason this carries the buttons alone.
 */
export interface SessionShape {
  readonly relaunchTarget: RelaunchTarget;
}

/**
 * The half of the page's route UI a gameplay session may reach (issue #324, step S8).
 *
 * `startGameWith` takes THIS, not `RouteHost`. The three members below are everything a
 * session was actually using; what the narrowing removes is `hud` -- the whole 67-member
 * interface, handed to a session that then had to be trusted not to touch 57 of them --
 * along with `hasSession` and the page teardown's `dispose`, neither of which a session
 * has any business calling.
 */
export interface GameplayRouteHost {
  /** The page's one state machine: which route or gameplay phase is showing. */
  readonly sm: GameStateMachine;
  /**
   * The ONE application-route member a session drives: re-fitting the Customize preview
   * when the window resizes.
   *
   * A `Pick` rather than the whole `RouteUi` because the session's window-resize listener
   * happens to be the page's only one, not because a match has anything to say about the
   * paint shop. Issue #427 owns giving the page its own listener; until then this is the
   * narrowest shape that keeps the preview correctly sized.
   */
  readonly routeUi: Pick<RouteUi, 'resizePreview'>;
  /**
   * Take the gameplay slot for a new session, telling the page what shape it is.
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
  attach(session: SessionShape): GameplaySlot;
}

export interface RouteHost extends GameplayRouteHost {
  /** The page's one HUD. Built at construction, disposed only at page teardown. */
  readonly hud: Hud;
  /** The page's one application-route controller (issue #427). */
  readonly routeUi: RouteUi;
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
   * Everything here is a READ of a page-owned store the route UI already holds, and since
   * issue #324's step S5 the page is the ONLY writer of them: the session's duplicate
   * pushes are gone, so there is one owner per surface rather than two that happened to
   * agree. What a session still paints is what only a session knows -- the topbar level
   * chip, the live status counts, the outcome projection -- and none of it is here.
   */
  /**
   * The active run, as both signals the Main Menu needs (issue #226): whether Continue is
   * offered at all, and where the run stands for the summary line above it and the
   * replace-run confirmation's copy.
   *
   * The mission NUMBER is resolved here rather than in the HUD because the run store
   * holds a level ID and only the level system can order it -- `run.ts` deliberately
   * never imports campaign data (see its own doc comment), and the HUD names no
   * simulation module at all. A stored id this build's campaign does not contain reports
   * `mission: null` and the HUD degrades the line to the lives half; that is reachable
   * today by a developer session whose `?dev=1&level=` jump left a run on a level the
   * sandbox sequence does not list.
   */
  const paintContinue = (): void => {
    const run = deps.run.active();
    hud.setContinueAvailable(run !== null);
    if (run === null) {
      hud.setCampaignRun(null);
      return;
    }
    const index = deps.levels.levels.findIndex((level) => level.id === run.currentLevelId);
    hud.setCampaignRun({
      mission: index < 0 ? null : index + 1,
      total: deps.levels.levels.length,
      lives: run.livesRemaining,
    });
  };
  /**
   * How much of the campaign the Levels grid may offer, from the permanent progress store.
   *
   * Re-read on arrival at the Main Menu rather than at the moment progress changes, and
   * that is the whole reason it is a function. A level is cleared mid-match, where the
   * grid is not on screen and cannot be reached -- `hud.ts` shows the Levels button at
   * the Main Menu only -- so the arrival is both the first moment the new value can be
   * seen and a moment that necessarily happens before it is. The session used to push
   * this from its own win handler, which covered the same instant from the other side and
   * covered nothing on a page with no session.
   */
  const paintLevelSelect = (): void => {
    hud.setLevelSelect(routeUi.unlockedLevels(), deps.levels.levels.length);
  };
  hud.setStats({ lifetime: deps.stats.lifetime(), attempt: deps.stats.attempt() });
  hud.setAchievements(deps.achievements.earned());
  hud.setHullColor(deps.customization.hull());
  hud.setSkin(deps.customization.skin());
  hud.setAccentColor(deps.customization.accent());
  paintLevelSelect();
  paintContinue();
  /**
   * WHICH GROUND the application screens stand on (issue #317), and the only paint here a
   * development flag decides: `null` -- absent or an unrecognised value -- is the shipped
   * flat ground, and the mapping happens at this layer rather than in the HUD so the HUD
   * keeps its own vocabulary and never imports the flag module.
   *
   * The page's flag, not a session's. `applyVersusToDeps` widens a session's `devFlags`
   * with the match's own mode, players and bot count and leaves `backdrop` alone, so the
   * two readings agree -- but the ground is page chrome that outlives every match, and a
   * session pushing it meant a page which never started one stood on whatever the markup
   * happened to say. Pushed unconditionally, so a page with no flag actively states the
   * default rather than relying on the element's initial classes.
   */
  hud.setBackdrop(deps.devFlags.backdrop === 'felt' ? 'felt' : 'default');

  /**
   * THE SETTINGS-DRIVEN CONTROLS, painted by the PAGE (issue #226).
   *
   * Until this block only a session pushed these (`loop.ts`'s `applySettings`), which is
   * the second half of the hole issue #485 records: on a page with no session -- since
   * #428, every page before its first match -- the mute button read "Mute" and the volume
   * slider sat at its markup default no matter what the store said. That was survivable
   * while those two controls were topbar decoration; it is not now that Settings is the
   * one durable home for them, because a preference whose only display lies is worse than
   * no display at all.
   *
   * DISPLAY ONLY, and that is the whole boundary. It reads `effectiveSettings` and writes
   * the HUD; it never writes the store back (which would turn opening a menu into a
   * preference change) and it never reaches the audio ENGINE, which `app-shell.ts` owns
   * and no session-less page has wired -- issue #485 still owns that half. A stored mute
   * is applied to the engine by `applySettings` the moment a session exists, so the
   * preference is honoured wherever there is any audio for it to affect.
   *
   * Subscribed as well as painted once: a change made in Settings arrives here through the
   * store, so the button the player just pressed redraws from the value that was actually
   * accepted rather than from the click.
   */
  const paintSettingsControls = (): void => {
    // UNCONDITIONALLY, session or not (issue #324). This used to return early while a
    // session was live, because `loop.ts` pushed the same values from its own
    // subscription and painting in both places would have meant two owners. #324 settled
    // which one: Settings is an application route, so the page paints it and the session
    // no longer touches the HUD's settings controls at all. The early return would now
    // leave the controls unpainted for as long as a match lasts.
    const effective = deps.effectiveSettings.current();
    hud.setMuted(effective.muted);
    hud.setVolume(effective.volume);
    hud.setTouchScheme(effective.touchScheme);
    hud.setFireMode(effective.fireMode);
    // The render-quality preset (issue #540), read from `effective` like the four pushes
    // above it rather than from the store like the two below. Not an oversight: haptics and
    // motion break the pattern because stored and effective genuinely differ there -- a
    // capability gate on one, three states against a two-state policy on the other. Quality
    // has neither. `effective.quality` is the stored preset unchanged
    // (effective-settings.ts), so reading it here keeps the ONE rule "consumers read the
    // effective layer" intact for a control that gains nothing from an exception.
    hud.setQuality(effective.quality);
    // THE STORED PREFERENCE, not the effective one -- the first of the two reads here that
    // break the function's `effective` pattern, the motion control below being the other.
    // `haptics.setEnabled` (loop.ts) takes the effective value so a device with no
    // `navigator.vibrate` stays silent whatever the switch says -- but this toggle EDITS
    // the preference, and showing it forced off would look like a dead control and suggest
    // the preference had been erased, which issue #320 forbids. Hiding it where it cannot
    // apply is issue #227's work.
    //
    // It read `effective.deviceHaptics` while this block only ran on a session-less page
    // (issue #485), where it was a latent bug rather than a visible one: a supported
    // device reads the same either way, and an unsupported one had no session to correct
    // it. Making this the ONLY writer would have shipped that reading everywhere.
    hud.setHaptics(deps.settings.snapshot().input.deviceHaptics);
    // THE STORED PREFERENCE for the same reason haptics is, and a sharper one: the motion
    // control has three states and the resolved policy has two, so painting it from
    // `effective` would erase 'system' entirely -- a player following their device would
    // find the control reading 'Full' or 'Reduced' and no way back to following it.
    hud.setMotion(deps.settings.snapshot().presentation.motion);
    // ...and the resolved policy, which is the half `setMotion` cannot carry. It makes an
    // application transition instant the moment the preference changes with the menu
    // already open (issue #364, criterion 5), and it completes the 'Match device' label,
    // which is why it is pushed AFTER `setMotion` rather than before -- both orders settle
    // to the same label, but this one paints the finished string once. The gameplay
    // renderer gets the same value from the session's own subscription (issue #289); this
    // is the frame's half, and the frame is the page's.
    hud.setReducedMotion(effective.reducedMotion);
  };
  paintSettingsControls();
  const stopPaintingSettings = deps.effectiveSettings.subscribe(paintSettingsControls);

  const stopPainting = sm.onChange((location) => {
    hud.setState(locationToHudSurface(location));
    // Both Main Menu affordances that are claims about a SAVE rather than about a match --
    // whether a run is there to continue, and how far the Levels grid may reach -- re-read
    // on every arrival. Arrival is the right moment because the stores change while the
    // player is somewhere else: a run ends and a level is cleared during gameplay, and a
    // session is disposed on the way back here (issue #429), so the page must read them
    // again rather than trust the last value anything painted.
    if (location.kind === 'route' && location.route.kind === 'main-menu') {
      paintContinue();
      paintLevelSelect();
    }
  });
  hud.setState(locationToHudSurface(sm.location));

  /**
   * Which input the player is using, for the prompts that name a key or a button (issue
   * #496). Every page-level input path reports here -- the keydown listener below, the
   * pointer gesture, and the gamepad poller's actions -- and only a settled change
   * repaints the HUD's hints. Touch is told apart from mouse by the pointer event's own
   * `pointerType`, which is the browser's answer rather than a capability guess: a
   * laptop with a touchscreen genuinely produces both, and the last one used is the one
   * the player is holding.
   */
  const modality = createModalityTracker();
  const noteModality = (kind: Modality): void => {
    if (modality.note(kind, deps.now())) hud.setModality(kind);
  };

  const onLaunchGesture = (): void => {
    sm.dismissLaunch();
    deps.launchGate.dismiss();
  };
  const onPointerDown = (e?: Event): void => {
    // Optional, and read defensively: the pre-#496 handler ignored its argument, and
    // fakes in the session tests still invoke the page's listeners with none. A pointer
    // event that does not say what it came from is a mouse, the majority case.
    const pointerType = (e as { pointerType?: string } | undefined)?.pointerType;
    noteModality(pointerType === 'touch' || pointerType === 'pen' ? 'touch' : 'pointer');
    onLaunchGesture();
  };
  deps.host.addEventListener('pointerdown', onPointerDown);

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
    noteModality('keyboard');
    if (sm.atLaunch) {
      onLaunchGesture();
      return;
    }
    /*
     * M IS THE PAGE'S KEY NOW (issue #226).
     *
     * The mute shortcut used to live in `loop.ts`'s session key handler, which was
     * survivable only while the Mute button sat in the topbar on every surface: with the
     * button gone, a session-scoped M would be dead on exactly the screens that no longer
     * show one -- the Main Menu of a page that has not started a match. Muting is a
     * page-scoped preference on a page-scoped store (`AppSettings`, see this module's
     * ownership comment), so the key belongs beside it.
     *
     * It RETURNS rather than falling through, so the session never sees a key the page
     * has claimed -- the same rule the Launch gesture above follows, and what stops the
     * old session handler and this one both firing during a match.
     *
     * The toast is the issue's "brief status feedback", and it is not decoration: the
     * always-visible button label was the only thing that told a player whether the game
     * was muted or merely silent, and removing it without a replacement would make a
     * mis-typed M indistinguishable from a broken build.
     */
    if (isMuteHotkey(e)) {
      routeUi.toggleMute();
      hud.showToast(deps.settings.snapshot().audio.muted ? 'Muted' : 'Sound on');
      return;
    }
    live?.key?.(e);
  };
  deps.host.addEventListener('keydown', onHostKey);

  /**
   * The gamepad's route into the same verbs (issue #494). One poller for the page, over
   * the union of connected pads, on the page's own frame loop from construction to
   * `dispose()` -- and DISPATCHING only while nothing simulates, except Start, which is
   * how a pad pauses. A direction, Confirm or Back pressed mid-play is dropped here but
   * still counted as held by the poller, so the A that was firing when Start landed does
   * not confirm the Pause panel's first control on the next frame. The gameplay readers
   * never see this poller's edges and it never sees theirs; `loop.ts` resyncs them on
   * every entry into play.
   *
   * Any action at Launch dismisses the splash, exactly as a key or pointer does, so a
   * controller-only player can navigate. Audio is not unlocked by it: the engine
   * self-heals on the first pointer or key, and the spec's controller-only evidence row
   * records that exception.
   */
  const onMenuAction = (action: UiAction): void => {
    noteModality('gamepad');
    if (sm.atLaunch) {
      onLaunchGesture();
      return;
    }
    if (sm.isSimulating && action !== 'pause') return;
    if (hud.act(action)) return;
    if (action === 'pause') {
      if (sm.isPaused) sm.resume();
      else sm.pause();
      return;
    }
    // Back with nothing open: at Pause it is Resume, the same meaning Escape has there.
    if (action === 'back' && sm.isPaused) sm.resume();
  };
  const menuPoller = createGamepadMenuPoller(deps.menuGamepads, onMenuAction);
  let cancelFrame: (() => void) | null = null;
  let polling = true;
  const pollFrame = (now: number): void => {
    cancelFrame = null;
    menuPoller.poll(now);
    if (polling) cancelFrame = deps.requestFrame(pollFrame);
  };
  cancelFrame = deps.requestFrame(pollFrame);

  // The paint shop's push at the gameplay renderer, same trampoline shape. `route-ui.ts`
  // owns the null case and documents it as the normal state of a session-less page, so
  // this is handed over once and never withdrawn -- what changes is whether the slot
  // behind it holds a renderer.
  routeUi.setStyleSink((hex, skin, accentHex) => live?.style?.(hex, skin, accentHex));

  /**
   * EMPTY THE GAMEPLAY SINK: every retained thing on screen that only a world can state.
   *
   * Run when a session releases the slot, and the direction is the whole point. Until
   * issue #324's step S7 the page's only defence against a dead session's readings was
   * that each exit path remembered to push a menu-shaped value on its way out -- which is
   * a list, and a list is what goes stale. `hud.ts` retains what it was last told (the
   * topbar strip, the outcome lines, the countdown chip, the developer shell readout, the
   * touch thumbs), so anything a quitting match failed to overwrite simply stayed up.
   *
   * The five members here are exactly the RETAINED half of `GameplayHudKey`; the other
   * five (`signalShellCapacity`, `signalPlayerDeath`, `signalPlayerFire`,
   * `showAchievementToasts`, `showToast`) are transient signals that expire on their own
   * and have no cleared state to push.
   *
   * `null` throughout rather than a campaign-shaped substitute: a page has no world, so it
   * can state no lives, no enemy count, no stock strip and no tally. The touch indicator
   * is the one member with no `null` -- it always takes a shape -- so the page states the
   * one that means "no thumbs down", carrying the player's own scheme from the store it
   * owns rather than inventing a default the HUD would then draw with.
   */
  const clearGameplaySink = (): void => {
    hud.setStatus(null);
    hud.setOutcome(null);
    hud.setRoundPhase(null);
    hud.setShellCount(null);
    hud.setTouchIndicator({
      stick: null,
      aim: null,
      scheme: deps.effectiveSettings.current().touchScheme,
      used: false,
    });
  };

  return {
    hud,
    sm,
    routeUi,
    hasSession: () => live !== null,
    attach(session): GameplaySlot {
      const state: SlotState = {};
      live = state;
      const mine = ++generation;
      /**
       * WHAT THE BUTTONS DO, pushed by the PAGE (issue #324, step S7).
       *
       * This was the last application-route member a gameplay session touched: `loop.ts`
       * pushed its own `setRelaunchTarget` a few statements after taking the slot, which
       * left the title's shape owned half by the page (which resets it on detach) and half
       * by whichever session last remembered to state it. Taking it as an attach argument
       * makes the page the single writer, and makes "a session that never says" impossible
       * rather than merely unobserved.
       *
       * BEFORE `sm.toMainMenu()` below, so the route reset paints the INCOMING session's
       * shape. Either order settles on the same buttons -- `hud.ts`'s
       * `applyTitleAffordances` recomputes from whichever of its four inputs moved last --
       * but pushing first means the Main Menu is never rendered wearing the outgoing
       * session's affordances, not even for the one synchronous frame a Campaign<->Versus
       * switch spends passing through it.
       */
      hud.setRelaunchTarget(session.relaunchTarget);
      // The route the outgoing session left behind is not the incoming one's. Guarded on
      // the gate so the FIRST attach of a document load -- where the machine is still at
      // `launch` and nothing has been dismissed -- leaves the splash up.
      if (deps.launchGate.dismissed()) sm.toMainMenu();
      const current = (): boolean => mine === generation;
      /**
       * THE GUARDED GAMEPLAY HUD (issue #324, step S8). See `GameplaySlot.hud`.
       *
       * Written out member by member rather than built by a loop over the key union,
       * because an object literal typed `GameplayHud` is checked BOTH ways: a member added
       * to `GameplayHudKey` and not forwarded here stops the build, and a member forwarded
       * here that the classification does not call gameplay-owned stops it too. A
       * `Proxy`, or a `for` loop over `Object.keys`, would silently accept either.
       */
      const guardedHud: GameplayHud = {
        setStatus: (status) => {
          if (current()) hud.setStatus(status);
        },
        setOutcome: (outcome) => {
          if (current()) hud.setOutcome(outcome);
        },
        setRoundPhase: (info) => {
          if (current()) hud.setRoundPhase(info);
        },
        setShellCount: (info) => {
          if (current()) hud.setShellCount(info);
        },
        signalShellCapacity: (info) => {
          if (current()) hud.signalShellCapacity(info);
        },
        signalPlayerDeath: (color) => {
          if (current()) hud.signalPlayerDeath(color);
        },
        signalPlayerFire: () => {
          if (current()) hud.signalPlayerFire();
        },
        setTouchIndicator: (t) => {
          if (current()) hud.setTouchIndicator(t);
        },
        showAchievementToasts: (defs) => {
          if (current()) hud.showAchievementToasts(defs);
        },
        showToast: (message) => {
          if (current()) hud.showToast(message);
        },
      };
      return {
        hud: guardedHud,
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
        setControllers(assignment, botsMayDrivePlayers): void {
          if (!current()) return;
          // Two HUD members for one report, in the order the session's own boot push used
          // before this moved. Either order settles on the same rows -- both setters
          // re-render from the pair -- so what the single method buys is that there is no
          // way to push one of them and not the other.
          hud.setBotAssignmentAllowed(botsMayDrivePlayers);
          hud.setControllers(assignment);
        },
        openVersusSetup(): void {
          if (current()) routeUi.openVersusSetup();
        },
        detach(): void {
          if (!current()) return;
          live = null;
          // RETIRE THE GENERATION TOO, so `current()` is false for everything this slot
          // can still be asked to do afterwards -- which is the whole of it, since the
          // slot object outlives the release in `startGameWith`'s closure.
          //
          // Without this, only the seven click trampolines went quiet (they read `live`),
          // while every method that guards on `current()` stayed live on a session that no
          // longer exists: a late `setControllers` would repaint the panel for a finished
          // match, a late `openVersusSetup` would open the pane over the Main Menu, and
          // `detach()` itself would run its resets a second time. Since step S8 it also
          // covers the whole gameplay HUD facade, where the failure is visible: a frame
          // that lands after a quit repaints the empty host's topbar with the match that
          // just ended.
          generation += 1;
          // The menu goes back to the PAGE's shape, and the arena's readouts go away with
          // the world that produced them. Until this pair nothing took either back: after
          // a setup-pane versus match the empty host kept offering "Start Match" and
          // "Campaign", and that "Start Match" -- with no session to dispatch to -- is a
          // New Game, which replaced the player's campaign run with no confirmation.
          //
          // Reset on the way OUT rather than on the next attach, because the page can sit
          // at the Main Menu with no session for as long as the player likes. That is also
          // why the clear belongs here rather than in each session's teardown: the menu
          // must be free of a dead match because the SLOT was emptied, not because the
          // match that happened to end remembered to tidy up after itself.
          hud.setRelaunchTarget('campaign-levels');
          clearGameplaySink();
        },
      };
    },
    dispose(): void {
      deps.host.removeEventListener('pointerdown', onPointerDown);
      deps.host.removeEventListener('keydown', onHostKey);
      // The frame loop first: a frame already queued must find the poller disposed
      // (its poll is then a no-op) and must not queue another.
      polling = false;
      cancelFrame?.();
      cancelFrame = null;
      menuPoller.dispose();
      // The preview then, for the same reason `startGameWith` disposed it before the
      // HUD: it is a second WebGL context hanging off an element the HUD owns.
      routeUi.disposePreview();
      // The page's own subscription, released for the same reason a session releases its
      // own: the machine and this host die together, but a reference kept past teardown
      // must not keep painting a disposed HUD.
      stopPainting();
      stopPaintingSettings();
      hud.dispose();
    },
  };
}
