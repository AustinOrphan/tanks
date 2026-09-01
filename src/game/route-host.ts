import { createRouteUi, type RouteUi, type RouteUiDeps, type StyleSink } from './route-ui';
import { createOutcomeClassifier, type GameStateMachine, type OutcomeContext } from './state';
import { versusDraw } from './app-state';
import type { Hud } from './hud';
import type { GameDeps } from './loop';
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
  Pick<GameDeps, 'createHud' | 'createStateMachine' | 'launchGate'>;

/**
 * The two application-level start requests, threaded in rather than read off a session.
 *
 * This is the seam issue #468 asks for: "gameplay-starting route actions become explicit
 * application-level requests that do not require dereferencing an existing gameplay
 * session". Today `boot.ts` forwards both straight into `GameSessionHost`'s reboot paths,
 * which is the temporary compatibility path the issue permits and #428 replaces.
 */
export interface SessionRequests {
  readonly requestVersusSession: (config: VersusConfig) => void;
  readonly requestCampaignSession: () => void;
}

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
   * The versus config this session was built from, or `null` for a campaign one.
   *
   * RETAINED after detach, not cleared: it is what the Versus Setup pane prefills from,
   * and a player who quits a match and reopens the pane must find their own last match
   * there rather than an empty form. `session-host.ts` retains its `lastVersusConfig` for
   * the same reason and says so.
   */
  setVersusConfig(config: VersusConfig | null): void;
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
    requestVersusSession: requests.requestVersusSession,
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
  hud.onStartRestart(() => live?.startRestart?.());
  hud.onLevelSelect((level) => live?.levelSelect?.(level));
  hud.onNewGame(() => live?.newGame?.());
  hud.onMineTap(() => live?.mineTap?.());
  hud.onFireTap(() => live?.fireTap?.());
  hud.onQuitToTitle(() => live?.quitToTitle?.());
  hud.onReassignSlot((slot, source) => live?.reassignSlot?.(slot, source));

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
        },
      };
    },
    dispose(): void {
      // The preview first, for the same reason `startGameWith` disposed it before the
      // HUD: it is a second WebGL context hanging off an element the HUD owns.
      routeUi.disposePreview();
      hud.dispose();
    },
  };
}
