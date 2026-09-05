// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import {
  createRouteHost,
  type RouteHost,
  type RouteHostDeps,
  type SessionShape,
  type StartIntent,
} from './route-host';
import { createAppSettings } from './app-settings';
import type { AudioEngine } from '../audio/engine';
import { createMemoryStorage, createStores, type GameStores } from './storage';
import { createCapabilitySource, createStaticReducedMotionSource, NO_CAPABILITIES } from './capabilities';
import { createGameStateMachine } from './state';
import { createLevelSystem } from './levels';
import { CAMPAIGN_LEVELS } from '../sim/config/campaign';
import { DEV_FLAGS_OFF, type DevFlags } from './devflags';
import { defaultSlots } from './versus-setup';
import { createHud, type GameplayHud, type Hud } from './hud';
import { ZERO_STATS } from './stats';
import type { TankPreview } from '../render/preview';
import type { VersusConfig } from './versus-config';
import type { RouteUiDeps } from './route-ui';
import type { GamepadLike } from '../input/gamepad';
import type { SlotSource } from '../input/assignment';
import { MODALITY_SWITCH_MS } from './modality';

/**
 * Issue #468's coverage, and the shape of it is the point.
 *
 * `hud.ts` APPENDS every `on*` callback and has no unregister at all -- 26 `push(cb)`
 * methods, no `off`, no `delete`, no `splice`. So the failure this file exists to catch is
 * SILENT and additive: after one stop-and-start, a page-scoped HUD that let each session
 * register its own handlers would fire New Game twice on one click. Nothing counts
 * REGISTRATIONS below, because a registration count can be satisfied by a trampoline that
 * registered once and dispatched twice. Every assertion fires a trigger and counts what
 * actually happened.
 */

/**
 * The shape most cases attach with: an ordinary campaign session.
 *
 * Named rather than inlined 31 times so the two suites that care about the value -- the
 * attach-time push and the detach-time reset -- can pass `VERSUS_SHAPE` and be obviously
 * doing something different from every case that merely needs A session.
 */
const CAMPAIGN: SessionShape = { relaunchTarget: 'campaign-levels' };
/** A setup-pane versus session: the one shape that makes the title read "Start Match". */
const VERSUS_SHAPE: SessionShape = { relaunchTarget: 'versus-setup' };

const CONFIG: VersusConfig = {
  mode: 'ffa',
  players: 2,
  arenaId: 'vs-duel-01',
  stock: 3,
  friendlyFire: false,
  slots: defaultSlots(2),
};

/**
 * A HUD that records its registrations so a test can FIRE them, and nothing else.
 *
 * A `Proxy` rather than a literal, exactly as `route-ui.test.ts`'s does and for the same
 * reason: this file cares about which `on*` names got wired and what happens when they
 * fire, and a literal would need editing every time an unrelated method joined `Hud`.
 */
function recordingHud(): {
  hud: Hud;
  disposals: () => number;
  fire: (name: string, ...args: unknown[]) => void;
  registrations: (name: string) => number;
  /** Every non-`on*` call the route UI made, in order, with its arguments. */
  calls: Array<[string, unknown[]]>;
  argsOf: (name: string) => unknown[][];
} {
  const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const calls: Array<[string, unknown[]]> = [];
  const previewCanvas = document.createElement('canvas');
  const box = { disposals: 0 };
  const hud = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === 'previewCanvas') return previewCanvas;
        if (prop === 'previewRotateButtons') return [];
        return (...args: unknown[]): unknown => {
          if (prop === 'dispose') {
            box.disposals += 1;
            return undefined;
          }
          if (prop.startsWith('on') && typeof args[0] === 'function') {
            // APPEND, mirroring the real `hud.ts`. A fake that REPLACED would hide the
            // double-registration this whole file is about.
            const list = handlers.get(prop) ?? [];
            list.push(args[0] as (...a: unknown[]) => unknown);
            handlers.set(prop, list);
            return undefined;
          }
          calls.push([prop, args]);
          return undefined;
        };
      },
    },
  ) as unknown as Hud;
  return {
    hud,
    calls,
    disposals: () => box.disposals,
    fire: (name, ...args) => {
      for (const cb of handlers.get(name) ?? []) cb(...args);
    },
    registrations: (name) => (handlers.get(name) ?? []).length,
    argsOf: (name) => calls.filter(([n]) => n === name).map(([, a]) => a),
  };
}

interface Fixture {
  host: RouteHost;
  /** Every application-level start request the routes made (issue #428), in order. */
  startRequests: StartIntent[];
  /** How many times the routes asked the page to dispose the session (issue #429). */
  stopRequests(): number;
  hud: ReturnType<typeof recordingHud>;
  root: HTMLElement;
  stores: GameStores;
  versusStarts: VersusConfig[];
  campaignRequests: () => number;
  previewDisposals: () => number;
  /** Every call the page made on its one audio engine, in order (issue #485). */
  audioCalls: string[];
  /** How many engines `createAudio` minted; the page must take exactly one. */
  audioBuilds: () => number;
  /** The page menu poller's pads and queued frames (issue #494). */
  pads: GamepadLike[];
  frames: Array<(now: number) => void>;
  advance: (ms: number) => void;
  fireHost: (type: string, event: Event) => void;
  dismissLaunch(): void;
}

function fixture(
  opts: {
    launchDismissed?: boolean;
    seed?: (stores: GameStores) => void;
    realHud?: boolean;
    devFlags?: Partial<DevFlags>;
  } = {},
): Fixture {
  const storage = createMemoryStorage();
  const appSettings = createAppSettings({
    storage,
    namespace: 'production',
    stores: createStores(storage),
    capabilities: createCapabilitySource(() => NO_CAPABILITIES),
    motion: createStaticReducedMotionSource(false),
  });
  const stores = appSettings.stores;
  // What the page finds in its stores BEFORE it builds anything: a returning player's
  // run, their cleared levels, their paint job.
  opts.seed?.(stores);
  const hud = recordingHud();
  const root = document.createElement('div');
  // The REAL HUD, in the document, for the cases whose subject is a click travelling
  // through hud.ts into this host -- the recorder cannot click itself.
  if (opts.realHud) document.body.appendChild(root);
  const box = {
    startRequests: [] as StartIntent[],
    stopRequests: 0,
    versusStarts: [] as VersusConfig[],
    campaignRequests: 0,
    previewDisposals: 0,
    launchDismissed: opts.launchDismissed ?? false,
    /** The pads the page's menu poller sees (issue #494); a test mutates this and runs a frame. */
    pads: [] as GamepadLike[],
    /** Page frames requested and not yet run or cancelled, oldest first. */
    frames: [] as Array<(now: number) => void>,
    /** The clock the modality tracker reads (issue #496); a test advances it by hand. */
    now: 0,
    /** Listeners the route host registered on the page host, by event type. */
    hostListeners: new Map<string, Set<(e: Event) => void>>(),
    /**
     * Every call the page made on its ONE audio engine, in order (issue #485).
     *
     * Ordered strings rather than counters because the defect this file now covers was an
     * ORDER -- a bed started and then stopped one call later -- and a set of counters
     * records that as "one start, one stop" and looks healthy.
     */
    audioCalls: [] as string[],
    /** How many engines `createAudio` minted. The page must take exactly one. */
    audioBuilds: 0,
  };

  /**
   * The page's one engine (issue #485). Records the four calls the route host is allowed
   * to make and throws on `dispose`, which the PAGE's own teardown may do but which
   * nothing else may: an engine disposed under a live page is the failure mode
   * `releaseAudio`'s doc in `loop.ts` describes, and a silent one.
   */
  const pageAudio = {
    startMusic: () => box.audioCalls.push('start'),
    stopMusic: () => box.audioCalls.push('stop'),
    setMusicContext: (c: string) => box.audioCalls.push(`context:${c}`),
    duckMusic: (d: boolean) => box.audioCalls.push(`duck:${d}`),
    setMuted: (m: boolean) => box.audioCalls.push(`muted:${m}`),
    setVolume: (v: number) => box.audioCalls.push(`volume:${v}`),
    setMusicIntensity: () => {},
    unlock: () => {},
    play: () => {},
    toggleMute: () => false,
    isMuted: () => false,
    getVolume: () => 1,
    dispose: () => box.audioCalls.push('dispose'),
  } as unknown as AudioEngine;

  const routeUiDeps: RouteUiDeps = {
    settings: stores.settings,
    stats: stores.stats,
    progress: stores.progress,
    achievements: stores.achievements,
    customization: stores.customization,
    levels: createLevelSystem(DEV_FLAGS_OFF, stores.run),
    effectiveSettings: appSettings.effective,
    createPreview: (): TankPreview | null =>
      ({
        setStyle: () => {},
        resize: () => {},
        dispose: () => {
          box.previewDisposals += 1;
        },
      }) as unknown as TankPreview,
    readDetectedPads: () => [],
    // A host that actually registers, so a test can fire the page's own listeners rather
    // than dispatching at a window the route host never bound (issue #496's input paths).
    host: {
      addEventListener: (type: string, fn: (e: Event) => void) => {
        const set = box.hostListeners.get(type) ?? new Set();
        set.add(fn);
        box.hostListeners.set(type, set);
      },
      removeEventListener: (type: string, fn: (e: Event) => void) => {
        box.hostListeners.get(type)?.delete(fn);
      },
    } as unknown as RouteUiDeps['host'],
    // Deliberately the WRONG answers: the route host must override both with the
    // application-level seams it was handed, so a host that passed `deps` straight
    // through to `createRouteUi` would push into these and fail every request assertion.
    requestVersusSession: () => {
      throw new Error('the route UI reached a session-scoped requestVersusSession');
    },
    requestCampaignSession: () => {
      throw new Error('the route UI reached a session-scoped requestCampaignSession');
    },
    initialVersusConfig: null,
  };

  const deps: RouteHostDeps = {
    ...routeUiDeps,
    run: stores.run,
    // The page's own development flags (issue #324, step S5): the application ground is
    // page chrome, so the host reads `backdrop` itself rather than waiting for a session
    // to push one. `opts.devFlags` overrides exactly the fields a case is about.
    devFlags: { ...DEV_FLAGS_OFF, ...opts.devFlags },
    menuGamepads: () => box.pads,
    now: () => box.now,
    requestFrame: (cb) => {
      box.frames.push(cb);
      return () => {
        const at = box.frames.indexOf(cb);
        if (at >= 0) box.frames.splice(at, 1);
      };
    },
    // The PAGE's one engine, minted once and counted (issue #485). `createAudio` is the
    // same seam a session is handed; in the browser it returns `shell.audio` on every
    // call, and here it must be asked for exactly once by the host that outlives sessions.
    createAudio: () => {
      box.audioBuilds += 1;
      return pageAudio;
    },
    createHud: opts.realHud ? (r) => createHud(r) : () => hud.hud,
    // The REAL state machine. A fake over a surface variable cannot show that a
    // page-scoped machine resets its route on attach, which is one of this file's claims.
    createStateMachine: createGameStateMachine,
    launchGate: {
      dismissed: () => box.launchDismissed,
      dismiss: () => {
        box.launchDismissed = true;
      },
    },
  };

  const host = createRouteHost(root, deps, {
    requestStart: (intent) => box.startRequests.push(intent),
    requestStop: () => {
      box.stopRequests += 1;
    },
    requestVersusSession: (config) => box.versusStarts.push(config),
    requestCampaignSession: () => {
      box.campaignRequests += 1;
    },
  });

  return {
    host,
    hud,
    root,
    stores,
    startRequests: box.startRequests,
    stopRequests: () => box.stopRequests,
    versusStarts: box.versusStarts,
    campaignRequests: () => box.campaignRequests,
    previewDisposals: () => box.previewDisposals,
    /** Every call the page made on its one engine, in order (issue #485). */
    audioCalls: box.audioCalls,
    audioBuilds: () => box.audioBuilds,
    pads: box.pads,
    frames: box.frames,
    advance: (ms: number) => {
      box.now += ms;
    },
    fireHost: (type: string, event: Event) => {
      for (const fn of [...(box.hostListeners.get(type) ?? [])]) fn(event);
    },
    dismissLaunch: () => {
      box.launchDismissed = true;
    },
  };
}

/** The seven handlers a session holds, and the HUD name each is dispatched from. */
const GAMEPLAY_HANDLERS = [
  { hudName: 'onStartRestart', slotName: 'onStartRestart', args: [] as unknown[] },
  { hudName: 'onLevelSelect', slotName: 'onLevelSelect', args: [3] as unknown[] },
  { hudName: 'onNewGame', slotName: 'onNewGame', args: [] as unknown[] },
  { hudName: 'onMineTap', slotName: 'onMineTap', args: [] as unknown[] },
  { hudName: 'onFireTap', slotName: 'onFireTap', args: [] as unknown[] },
  { hudName: 'onQuitToTitle', slotName: 'onQuitToTitle', args: [] as unknown[] },
  { hudName: 'onReassignSlot', slotName: 'onReassignSlot', args: [1, 'keyboard'] as unknown[] },
] as const;

/** Fill every gameplay handler on a slot, recording which fired and with what. */
function fillSlot(host: RouteHost): { fired: Array<[string, unknown[]]>; slot: ReturnType<RouteHost['attach']> } {
  const slot = host.attach(CAMPAIGN);
  const fired: Array<[string, unknown[]]> = [];
  for (const h of GAMEPLAY_HANDLERS) {
    (slot[h.slotName] as (cb: (...a: unknown[]) => void) => void)((...a: unknown[]) =>
      fired.push([h.slotName, a]),
    );
  }
  return { fired, slot };
}

describe('createRouteHost: one HUD, one machine, one route UI', () => {
  it('builds exactly one HUD, in the root it was given', () => {
    const f = fixture();
    expect(f.hud.registrations('onStartRestart')).toBe(1);
    // Two sessions' worth of attach/detach, and still one registration per name.
    f.host.attach(CAMPAIGN).detach();
    f.host.attach(CAMPAIGN).detach();
    for (const h of GAMEPLAY_HANDLERS) {
      expect(f.hud.registrations(h.hudName), `${h.hudName} was registered again`).toBe(1);
    }
  });

  it('registers each application route exactly once too', () => {
    // The 19 `route-ui.ts` handlers. `createRouteUi` is called once by construction, and
    // the mutation that calls it per attach would double every one of these.
    const f = fixture();
    f.host.attach(CAMPAIGN).detach();
    f.host.attach(CAMPAIGN);
    for (const name of ['onMuteToggle', 'onVersusOpen', 'onCampaignOpen', 'onCustomizeOpen', 'onResetStats']) {
      expect(f.hud.registrations(name), `${name} was registered again`).toBe(1);
    }
  });
});

describe('createRouteHost: the gameplay slot', () => {
  it('does nothing at all when no session holds it', () => {
    // The ordinary state of a page whose host is empty -- not a degraded one. A trampoline
    // that dereferenced the slot would throw here on every one of the seven.
    const f = fixture();
    for (const h of GAMEPLAY_HANDLERS) {
      expect(() => f.hud.fire(h.hudName, ...h.args)).not.toThrow();
    }
    expect(f.host.hasSession()).toBe(false);
  });

  it('dispatches each handler to the attached session, with its arguments', () => {
    const f = fixture();
    const { fired } = fillSlot(f.host);
    expect(f.host.hasSession()).toBe(true);
    for (const h of GAMEPLAY_HANDLERS) f.hud.fire(h.hudName, ...h.args);
    expect(fired).toEqual(GAMEPLAY_HANDLERS.map((h) => [h.slotName, [...h.args]]));
  });

  /**
   * THE test this module exists for, and the one nothing before issue #468 could write.
   *
   * Counts EFFECTS, not registrations: fire each trigger once after a full
   * start -> stop -> start cycle and require exactly one invocation. Its negative control
   * is `slot.detach()` -- remove that call from `startGameWith`'s teardown, or make the
   * seven register on the HUD directly, and every count here becomes 2. A doubly-fired
   * `onNewGame` starts two campaign runs from one click.
   */
  it('fires each handler ONCE after start -> stop -> start, not once per session', () => {
    const f = fixture();
    const first = fillSlot(f.host);
    first.slot.detach();
    const second = fillSlot(f.host);

    for (const h of GAMEPLAY_HANDLERS) f.hud.fire(h.hudName, ...h.args);

    expect(first.fired, 'the retired session was still being dispatched to').toEqual([]);
    expect(second.fired.map(([name]) => name)).toEqual(GAMEPLAY_HANDLERS.map((h) => h.slotName));
  });

  it('stops dispatching to a session the moment it detaches', () => {
    const f = fixture();
    const { fired, slot } = fillSlot(f.host);
    f.hud.fire('onNewGame');
    expect(fired).toHaveLength(1);
    slot.detach();
    f.hud.fire('onNewGame');
    expect(fired, 'a detached session kept receiving clicks').toHaveLength(1);
  });

  /**
   * The stale-capture control, one layer up from `session-host.ts`'s pair.
   *
   * `boot.ts` replaces a session by stopping the old one and starting the new one, but a
   * teardown can be deferred, and an outgoing session's late `detach()` must not unhook
   * the incoming one. `attach()` is the authority on who is live, not `detach()`.
   */
  it('a late detach from a retired session does not unhook the live one', () => {
    const f = fixture();
    const first = fillSlot(f.host);
    const second = fillSlot(f.host);

    first.slot.detach(); // late, and out of order

    f.hud.fire('onNewGame');
    expect(second.fired.map(([n]) => n), 'the live session was unhooked by a dead one').toEqual([
      'onNewGame',
    ]);
    expect(f.host.hasSession()).toBe(true);
  });

  it('a retired session cannot register a handler over the live one', () => {
    const f = fixture();
    const first = f.host.attach(CAMPAIGN);
    const second = fillSlot(f.host);
    const stale: string[] = [];
    first.onNewGame(() => stale.push('stale'));

    f.hud.fire('onNewGame');
    expect(stale, 'a retired slot wrote over the live session').toEqual([]);
    expect(second.fired.map(([n]) => n)).toEqual(['onNewGame']);
  });

  it('registration REPLACES within one slot, so a session cannot double itself', () => {
    const f = fixture();
    const slot = f.host.attach(CAMPAIGN);
    const fired: string[] = [];
    slot.onNewGame(() => fired.push('a'));
    slot.onNewGame(() => fired.push('b'));
    f.hud.fire('onNewGame');
    expect(fired).toEqual(['b']);
  });
});

describe('createRouteHost: what a session REPORTS through the slot (issue #324, step S5)', () => {
  /**
   * The two application surfaces a session still has something to say about, and both go
   * through the slot rather than through the HUD.
   *
   * Everything else #324's step S5 moved is a read of a page-owned store, so the page can
   * simply do it. These two cannot be: an `Assignment` is built from the match's own
   * player count, validated versus roles and the pads that were plugged in when it
   * started, and the rematch destination is a fact about which session just finished. So
   * the session reports and the page writes, which is what leaves one writer per surface.
   */
  it('paints the Controllers panel from what the session reports -- both halves, one call', () => {
    // BOTH, from one report. The panel's candidate list is derived from the assignment
    // and the bot-allowed flag together, so a report that delivered only the rows would
    // leave a campaign session offering Bot -- or a versus session refusing it -- for as
    // long as the match lasted.
    const f = fixture();
    const slot = f.host.attach(CAMPAIGN);
    const assignment: SlotSource[] = [{ kind: 'keyboard' }, { kind: 'bot' }];
    slot.setControllers(assignment, true);
    expect(f.hud.argsOf('setControllers').at(-1)).toEqual([assignment]);
    expect(f.hud.argsOf('setBotAssignmentAllowed').at(-1)).toEqual([true]);
    // A second report replaces both, which is what a mid-match reassignment is.
    slot.setControllers([{ kind: 'none' }], false);
    expect(f.hud.argsOf('setControllers').at(-1)).toEqual([[{ kind: 'none' }]]);
    expect(f.hud.argsOf('setBotAssignmentAllowed').at(-1)).toEqual([false]);
  });

  it('a stale slot cannot repaint the Controllers panel under the session that replaced it', () => {
    // The stale-capture control every slot method needs: a reassignment dispatched into
    // an outgoing session must not overwrite the incoming session's rows with a roster
    // that belongs to a match that is over.
    const f = fixture();
    const old = f.host.attach(CAMPAIGN);
    f.host.attach(CAMPAIGN).setControllers([{ kind: 'keyboard' }], false);
    const before = f.hud.argsOf('setControllers').length;
    old.setControllers([{ kind: 'bot' }, { kind: 'bot' }], true);
    expect(f.hud.argsOf('setControllers')).toHaveLength(before);
    expect(f.hud.argsOf('setControllers').at(-1)).toEqual([[{ kind: 'keyboard' }]]);
  });

  it('reopens the Versus Setup pane prefilled with the config the PAGE retains', () => {
    // A finished versus match's action button reads "Versus Setup" and goes back to the
    // pane. The session decides that; the page decides what the pane is prefilled with,
    // because the retained config outlives the match -- which is exactly why the session
    // must not open the pane itself with a config of its own.
    const f = fixture();
    const slot = f.host.attach(CAMPAIGN);
    slot.setVersusConfig(CONFIG);
    slot.openVersusSetup();
    expect(f.hud.argsOf('showVersusSetup')).toEqual([[true, CONFIG]]);
  });

  it('a stale slot cannot reopen the pane', () => {
    const f = fixture();
    const old = f.host.attach(CAMPAIGN);
    f.host.attach(CAMPAIGN);
    old.openVersusSetup();
    expect(f.hud.argsOf('showVersusSetup')).toEqual([]);
  });
});

describe('createRouteHost: taking the slot shapes the menu around the session (issue #324, step S7)', () => {
  it('pushes the incoming session\'s relaunch target, so the page is the only writer', () => {
    // The last route-owned HUD member a session touched. `loop.ts` used to push this
    // itself a few statements after taking the slot, which left the title's shape owned
    // half here (the detach reset below) and half there. Declaring it at attach makes the
    // page the single writer AND makes "a session that never states it" unrepresentable.
    const versus = fixture({ launchDismissed: true });
    versus.host.attach(VERSUS_SHAPE);
    expect(versus.hud.argsOf('setRelaunchTarget').at(-1)).toEqual(['versus-setup']);
    // NEGATIVE CONTROL: a campaign session must get the other value, not merely "a"
    // value. Without this, a host that pushed a constant -- or that echoed whatever the
    // last detach left behind -- would satisfy the assertion above.
    const campaign = fixture({ launchDismissed: true });
    campaign.host.attach(CAMPAIGN);
    expect(campaign.hud.argsOf('setRelaunchTarget').at(-1)).toEqual(['campaign-levels']);
  });

  it('pushes it BEFORE the route reset, so the menu never paints in the outgoing shape', () => {
    // `attach` resets the visible route (`sm.toMainMenu()`), and that reset paints the
    // Main Menu. Pushing the target after it would render the incoming session's menu
    // wearing the outgoing session's buttons for one synchronous frame -- invisible in
    // production, but it is the ordering that decides whether "Start Match" or "Continue"
    // is what a Campaign<->Versus switch flashes through.
    // The route has to actually MOVE for the reset to paint, so this is the replacement
    // case: a campaign session in gameplay, then the versus session that takes its place.
    // Attaching onto a host already sitting at the Main Menu emits no change at all.
    const f = fixture({ launchDismissed: true });
    const first = f.host.attach(CAMPAIGN);
    f.host.sm.enterGameplay({ descriptor: { kind: 'campaign', level: 0 }, level: 0, seed: 1 } as never);
    first.detach();
    const before = f.hud.calls.length;
    f.host.attach(VERSUS_SHAPE);
    const names = f.hud.calls.slice(before).map(([name]) => name);
    // Both halves have to be in the slice, or the ordering claim is vacuous -- and the
    // vacuity is not hypothetical: with the attach push deleted, `indexOf` returns -1 for
    // it, and -1 is less than any real index, so the comparison below passes on a host
    // that never shaped the menu at all. Measured with the mutation
    // `route-host-attach-never-shapes-the-menu-for-its-session` applied, which this case
    // survived until these two lines were here.
    expect(names, 'the buttons were never pushed').toContain('setRelaunchTarget');
    expect(names, 'the route reset did not paint').toContain('setState');
    expect(names.indexOf('setRelaunchTarget'), 'the buttons were pushed after the paint').toBeLessThan(
      names.indexOf('setState'),
    );
  });

  it('says nothing about the session KIND: the topbar still comes from a world', () => {
    // Deliberately absent from `SessionShape`, and this is the assertion that keeps it
    // absent. `?dev=1&mode=ffa` is a genuine versus session wearing campaign-shaped
    // buttons, so a page that derived "what is being played" from "what the buttons do"
    // would report Campaign for a real FFA match -- the collapse issue #316 removed, and
    // the one `session-title-policy-reused-as-identity` pins in the mutation manifest.
    const f = fixture({ launchDismissed: true });
    const before = f.hud.argsOf('setStatus').length;
    const slot = f.host.attach(VERSUS_SHAPE);
    expect(f.hud.argsOf('setStatus'), 'attach invented a status from the button policy').toHaveLength(
      before,
    );
    // ...and the session's own push is what fills it, which is the control: the topbar is
    // not simply unreachable from here.
    slot.hud.setStatus({ kind: 'versus', mission: 1, missions: 1, stocks: null });
    expect(f.hud.argsOf('setStatus').at(-1)).toEqual([
      { kind: 'versus', mission: 1, missions: 1, stocks: null },
    ]);
  });
});

describe('createRouteHost: releasing the slot gives the menu back its page shape', () => {
  it('resets the relaunch target and clears the gameplay status when the live session detaches', () => {
    // A versus session shapes the title around itself ("Start Match", a Campaign
    // button). The page has to take that back when the session goes, or an empty host
    // keeps offering a "Start Match" that is a New Game in disguise.
    //
    // `null`, not a campaign-shaped status: a page has no world, so it can state no
    // lives, no enemy count and no stock strip. Since issue #324's step S6 the projection
    // has a word for exactly that, and `null` is the assertion -- a page that pushed a
    // fabricated campaign status would be claiming a session that does not exist.
    const f = fixture({ launchDismissed: true });
    const slot = f.host.attach(VERSUS_SHAPE);
    slot.hud.setStatus({ kind: 'versus', mission: 1, missions: 1, stocks: null });
    expect(f.hud.argsOf('setRelaunchTarget').at(-1), 'the attach did not shape the title').toEqual([
      'versus-setup',
    ]);
    slot.detach();
    expect(f.hud.argsOf('setRelaunchTarget').at(-1)).toEqual(['campaign-levels']);
    expect(f.hud.argsOf('setStatus').at(-1)).toEqual([null]);
  });

  it('empties the whole gameplay sink, not just the topbar (issue #324, step S7)', () => {
    // The five RETAINED gameplay members. `hud.ts` keeps whatever it was last told, so
    // every one of these stayed on screen after a quit unless the session that ended
    // happened to overwrite it: an outcome tally under the Main Menu, a frozen 3-2-1
    // chip, the developer shell readout, the touch thumbs where the player let go.
    //
    // Pushed through `slot.hud`, which is how a real session fills them, and asserted as
    // the LAST value of each -- the claim is what the HUD is left holding, not how many
    // times it was told.
    const f = fixture({ launchDismissed: true });
    const slot = f.host.attach(CAMPAIGN);
    slot.hud.setStatus({ kind: 'campaign', mission: 1, missions: 3, lives: 2, enemies: 4 });
    slot.hud.setOutcome({ tally: 'solo', attempt: ZERO_STATS, action: 'campaign-levels' });
    slot.hud.setRoundPhase({ phase: 'countdown', secondsLeft: 2 });
    slot.hud.setShellCount({ inFlight: 2, cap: 3 });
    slot.hud.setTouchIndicator({
      stick: { originX: 1, originY: 2, x: 3, y: 4 },
      aim: { originX: 5, originY: 6, x: 7, y: 8 },
      scheme: 'stick',
      used: true,
    });
    // NEGATIVE CONTROL: every member really is holding a live value first, so a clear
    // that never ran cannot be mistaken for a HUD that was never told anything.
    expect(f.hud.argsOf('setOutcome').at(-1)?.[0]).not.toBeNull();
    expect(f.hud.argsOf('setRoundPhase').at(-1)?.[0]).not.toBeNull();
    expect(f.hud.argsOf('setShellCount').at(-1)?.[0]).not.toBeNull();

    slot.detach();

    expect(f.hud.argsOf('setStatus').at(-1)).toEqual([null]);
    expect(f.hud.argsOf('setOutcome').at(-1)).toEqual([null]);
    expect(f.hud.argsOf('setRoundPhase').at(-1)).toEqual([null]);
    expect(f.hud.argsOf('setShellCount').at(-1)).toEqual([null]);
    // The one member with no `null`: it always takes a shape, so the page states the
    // shape that means "no thumbs down" and carries the player's own scheme from the
    // store it owns rather than inventing one.
    expect(f.hud.argsOf('setTouchIndicator').at(-1)).toEqual([
      { stick: null, aim: null, scheme: 'stick', used: false },
    ]);
  });

  it('carries the STORED touch scheme into the cleared indicator, not a hardcoded one', () => {
    // The scheme is a page-owned preference, so the emptied indicator states the
    // player's. `hud.ts` early-returns on `used: false` today, which is exactly why a
    // fabricated value here would be invisible until some later change stopped it doing
    // so -- and then the first touch after a quit would draw the wrong aim affordance.
    const f = fixture({ launchDismissed: true, seed: (stores) => stores.settings.setTouchScheme('point') });
    // NEGATIVE CONTROL: 'point' is not the shipped default (the case above reads
    // 'stick'), so a constant cannot coincide with both.
    expect(f.stores.settings.snapshot().input.touchScheme).toBe('point');
    f.host.attach(CAMPAIGN).detach();
    expect(f.hud.argsOf('setTouchIndicator').at(-1)).toEqual([
      { stick: null, aim: null, scheme: 'point', used: false },
    ]);
  });

  it('goes inert on release: a second detach, and every late report, does nothing', () => {
    // Releasing retires the slot's generation, not just the click trampolines. Before
    // that, a detached session could still repaint the Controllers panel and reopen the
    // Versus Setup pane over the empty host's Main Menu -- a match that has ended pushing
    // its own roster onto a page that is not playing anything -- and a second `detach()`
    // re-ran the resets the first one had already done.
    const f = fixture({ launchDismissed: true });
    const slot = f.host.attach(CAMPAIGN);
    slot.setVersusConfig(CONFIG);
    slot.detach();
    const before = f.hud.calls.length;

    slot.detach();
    slot.setControllers([{ kind: 'bot' }], true);
    slot.openVersusSetup();
    expect(f.hud.calls.slice(before), 'a released slot still reached the page HUD').toEqual([]);

    // NEGATIVE CONTROL: the same three calls on a LIVE slot all reach the HUD, so this is
    // a claim about release rather than about methods that never do anything.
    const live = f.host.attach(CAMPAIGN);
    live.setControllers([{ kind: 'bot' }], true);
    live.openVersusSetup();
    const names = f.hud.calls.slice(before).map(([name]) => name);
    expect(names).toContain('setControllers');
    expect(names).toContain('showVersusSetup');
    live.detach();
    expect(f.hud.argsOf('setStatus').at(-1), 'the live slot could not release').toEqual([null]);
  });

  it('a stale detach does not reshape the menu under the session that replaced it', () => {
    // The stale-capture control, same shape as the slot's own: an outgoing session's late
    // detach must not undo what the incoming one just pushed, nor blank the live match's
    // topbar and outcome lines out from under it.
    const f = fixture({ launchDismissed: true });
    const old = f.host.attach(CAMPAIGN);
    const live = f.host.attach(VERSUS_SHAPE);
    live.hud.setStatus({ kind: 'versus', mission: 1, missions: 1, stocks: null });
    const before = f.hud.argsOf('setRelaunchTarget').length;
    const statusBefore = f.hud.argsOf('setStatus').length;
    old.detach();
    expect(f.hud.argsOf('setRelaunchTarget')).toHaveLength(before);
    expect(f.hud.argsOf('setRelaunchTarget').at(-1)).toEqual(['versus-setup']);
    expect(f.hud.argsOf('setStatus'), 'a dead session blanked the live topbar').toHaveLength(
      statusBefore,
    );
  });
});

/**
 * The slot's own HUD (issue #324, step S8).
 *
 * `loop.ts` held the page's raw `Hud` until this step: every route member was reachable,
 * and no push was checked against the generation at all. These are the two properties the
 * facade adds, and the second is the one nothing could see before -- a session is stopped
 * and replaced by `boot.ts` (`session-host.ts`'s `replace`), and a frame already in flight
 * when that happens used to land on the incoming match's topbar.
 */
describe('createRouteHost: the slot\'s gameplay HUD', () => {
  /**
   * Every member of `GameplayHud`, with an argument each, for the exhaustive guard case.
   *
   * The name is typed `keyof GameplayHud`, so a member that is renamed or removed fails
   * the build here rather than quietly dropping out of the sweep. The COUNT is asserted
   * below against the same ten `hud-ownership.test.ts` states, which is the half a type
   * cannot check: a member ADDED to the union would compile fine as an absence.
   */
  const GAMEPLAY_PUSHES: ReadonlyArray<
    [keyof GameplayHud, (slot: ReturnType<RouteHost['attach']>) => void]
  > = [
    ['setStatus', (s) => s.hud.setStatus(null)],
    ['setOutcome', (s) => s.hud.setOutcome(null)],
    ['setRoundPhase', (s) => s.hud.setRoundPhase(null)],
    ['setShellCount', (s) => s.hud.setShellCount(null)],
    ['signalShellCapacity', (s) => s.hud.signalShellCapacity({ inFlight: 3, cap: 3 })],
    ['signalPlayerDeath', (s) => s.hud.signalPlayerDeath(0xb41e1e)],
    ['signalPlayerFire', (s) => s.hud.signalPlayerFire()],
    [
      'setTouchIndicator',
      (s) => s.hud.setTouchIndicator({ stick: null, aim: null, scheme: 'stick', used: true }),
    ],
    ['showAchievementToasts', (s) => s.hud.showAchievementToasts([])],
    ['showToast', (s) => s.hud.showToast('Gamepad connected')],
  ];

  it('reaches the page HUD while the session holds the slot', () => {
    // Ten, the number `hud-ownership.test.ts` asserts `GameplayHudKey` holds. Stated here
    // because the sweep below is only exhaustive if this list is: a member added to the
    // union would make the facade forward it and leave this list one short, and nothing
    // else in either file would notice.
    expect(GAMEPLAY_PUSHES, 'GameplayHud has ten members').toHaveLength(10);
    const f = fixture({ launchDismissed: true });
    const slot = f.host.attach(CAMPAIGN);
    for (const [, push] of GAMEPLAY_PUSHES) push(slot);
    expect(f.hud.calls.map(([name]) => name)).toEqual(
      expect.arrayContaining(GAMEPLAY_PUSHES.map(([name]) => name)),
    );
    expect(f.hud.argsOf('showToast').at(-1)).toEqual(['Gamepad connected']);
  });

  it('drops EVERY push from a session that has already been replaced', () => {
    // Exhaustive on purpose: a facade that guarded nine members and forwarded the tenth
    // is the shape this whole step exists to rule out, and a spot check of one member
    // cannot tell that apart from a facade that guards all ten.
    const f = fixture({ launchDismissed: true });
    const retired = f.host.attach(CAMPAIGN);
    const live = f.host.attach(VERSUS_SHAPE);
    const before = f.hud.calls.length;

    for (const [, push] of GAMEPLAY_PUSHES) push(retired);
    expect(
      f.hud.calls.slice(before).map(([name]) => name),
      'a retired session painted over the live one',
    ).toEqual([]);

    // NEGATIVE CONTROL: the same pushes from the LIVE slot all land, so an assertion of
    // emptiness cannot be satisfied by a facade that forwards nothing at all.
    for (const [, push] of GAMEPLAY_PUSHES) push(live);
    expect(f.hud.calls.slice(before).map(([name]) => name)).toEqual(
      GAMEPLAY_PUSHES.map(([name]) => name),
    );
  });

  it('drops a push from a session that has detached, with nothing holding the slot', () => {
    // The other retirement: quitting to the Main Menu leaves the host empty, and a frame
    // that arrives afterwards must not repaint the menu's topbar with the match that just
    // ended. Measured after the detach's own clears, so what is asserted is that the
    // NULLS survive rather than that nothing was ever pushed.
    const f = fixture({ launchDismissed: true });
    const slot = f.host.attach(CAMPAIGN);
    slot.detach();
    const before = f.hud.calls.length;
    slot.hud.setStatus({ kind: 'campaign', mission: 2, missions: 3, lives: 1, enemies: 5 });
    expect(f.hud.calls.slice(before)).toEqual([]);
    expect(f.hud.argsOf('setStatus').at(-1)).toEqual([null]);
  });
});

describe('createRouteHost: the application-level start requests (issue #468)', () => {
  it('Versus Start reaches the page seam, with no session attached', () => {
    // The criterion in the issue's own words: a gameplay-starting route action must not
    // require dereferencing an existing gameplay session.
    //
    // Since issue #428 it arrives as a `StartIntent` on `requestStart` -- the ONE boundary
    // that creates a session -- rather than on its own callback, so Versus Start and the
    // three campaign/practice gestures are one seam rather than two.
    const f = fixture();
    f.hud.fire('onVersusStart', CONFIG);
    expect(f.startRequests).toEqual([{ kind: 'versus', config: CONFIG }]);
    expect(f.host.hasSession(), 'the request created a session').toBe(false);
  });

  it('Campaign reaches the page seam, with no session attached', () => {
    const f = fixture();
    f.hud.fire('onCampaignOpen');
    expect(f.campaignRequests()).toBe(1);
    expect(f.host.hasSession()).toBe(false);
  });

  it('keeps reaching the page seam across a session lifecycle', () => {
    const f = fixture();
    const { slot } = fillSlot(f.host);
    f.hud.fire('onVersusStart', CONFIG);
    slot.detach();
    f.hud.fire('onVersusStart', CONFIG);
    expect(f.startRequests).toEqual([
      { kind: 'versus', config: CONFIG },
      { kind: 'versus', config: CONFIG },
    ]);
  });
});

/**
 * The four gestures that create a session (issue #428).
 *
 * Three of the seven trampolines branch on whether a session exists, and this is the
 * empty-host half of that branch -- the state the page now BOOTS into, since `boot.ts` no
 * longer starts anything. Each assertion is a count of one, at the seam that is the only
 * thing in the page able to produce a world.
 */
describe('createRouteHost: starting a match from an empty host (issue #428)', () => {
  it('Continue asks for the active campaign run', () => {
    const f = fixture();
    f.hud.fire('onStartRestart');
    expect(f.startRequests).toEqual([{ kind: 'campaign-continue' }]);
  });

  it('New Game asks for a fresh run', () => {
    const f = fixture();
    f.hud.fire('onNewGame');
    expect(f.startRequests).toEqual([{ kind: 'campaign-new' }]);
  });

  it('a Levels pick asks for that level, carrying the index', () => {
    const f = fixture();
    f.hud.fire('onLevelSelect', 3);
    expect(f.startRequests).toEqual([{ kind: 'practice', level: 3 }]);
  });

  /**
   * With a session attached the same three buttons mean Resume, Play Again and a
   * mid-session Levels pick, and must NOT create a second session.
   *
   * This is the half a count alone would miss: "one session per Start" is satisfied by a
   * page that also starts one on every Retry, and only asserting that the request seam
   * stays EMPTY here can tell the two apart.
   */
  it('none of the three asks for a session while one is attached', () => {
    const f = fixture();
    const { fired } = fillSlot(f.host);
    f.hud.fire('onStartRestart');
    f.hud.fire('onNewGame');
    f.hud.fire('onLevelSelect', 3);
    expect(f.startRequests, 'a running match asked for a second session').toEqual([]);
    expect(fired.map(([n]) => n)).toEqual(['onStartRestart', 'onNewGame', 'onLevelSelect']);
  });

  /**
   * The other four have no meaning without a match and stay pure no-ops. Worth stating
   * rather than assuming: a Mine tap that reached the start boundary would create a whole
   * session from a touch control that is not even on screen at the title.
   */
  it('the four gameplay-only controls ask for nothing at all', () => {
    const f = fixture();
    f.hud.fire('onMineTap');
    f.hud.fire('onFireTap');
    f.hud.fire('onQuitToTitle');
    f.hud.fire('onReassignSlot', 1, 'keyboard');
    expect(f.startRequests).toEqual([]);
    expect(f.host.hasSession()).toBe(false);
  });
});

describe('createRouteHost: the retained versus config', () => {
  /**
   * Read through what the pane is actually OPENED with -- `hud.showVersusSetup(true, x)` --
   * rather than through an accessor, because that argument is the whole of what the
   * retained config is for.
   */
  it('starts null, so a fresh page opens the pane on an empty form', () => {
    const f = fixture();
    f.hud.fire('onVersusOpen');
    expect(f.hud.argsOf('showVersusSetup')).toEqual([[true, null]]);
  });

  it('is read LIVE, so a config set after construction reaches the pane', () => {
    // The getter, not a snapshot. `route-ui.ts` reads `deps.initialVersusConfig` at click
    // time, so a value copied into `routeDeps` at construction would be permanently null
    // -- the pane would never prefill at all.
    const f = fixture();
    f.host.attach(CAMPAIGN).setVersusConfig(CONFIG);
    f.hud.fire('onVersusOpen');
    expect(f.hud.argsOf('showVersusSetup')).toEqual([[true, CONFIG]]);
  });

  /**
   * RETAINED across detach, deliberately.
   *
   * The pane prefills from the player's own last match, and quitting one must not empty
   * the form. `session-host.ts` retains its `lastVersusConfig` for the same reason and
   * says so; this is the same fact one layer up, where the pane can actually read it.
   */
  it('survives the session that set it', () => {
    const f = fixture();
    const slot = f.host.attach(CAMPAIGN);
    slot.setVersusConfig(CONFIG);
    slot.detach();

    f.hud.fire('onVersusOpen');
    expect(f.hud.argsOf('showVersusSetup'), 'quitting the match emptied the form').toEqual([
      [true, CONFIG],
    ]);
  });

  /**
   * ...and survives a CAMPAIGN session started after it, which is the half a detach-only
   * test cannot see (raised by review on PR #475).
   *
   * `applyVersusToDeps` stamps `initialVersusConfig: null` on every campaign session, so a
   * session that pushed its own value unconditionally would clear the retained one the
   * moment the player left Versus for Campaign -- and the Setup pane would come up empty
   * on the very journey it exists to serve: play a match, go back to the menu, open Versus
   * again to tweak it.
   */
  it('survives a campaign session started after it', () => {
    const f = fixture();
    const versusSlot = f.host.attach(CAMPAIGN);
    versusSlot.setVersusConfig(CONFIG);
    versusSlot.detach();

    // A campaign session: it has no versus config of its own, and must not say so.
    f.host.attach(CAMPAIGN);

    f.hud.fire('onVersusOpen');
    expect(
      f.hud.argsOf('showVersusSetup'),
      'a campaign session cleared the retained versus config',
    ).toEqual([[true, CONFIG]]);
  });
});

describe('createRouteHost: the Main Menu is painted from the stores by the page', () => {
  /**
   * A session used to paint these at its own construction, which was complete only while
   * a session existed from the first frame. The page boots into an empty host since issue
   * #428, so a returning player's first Main Menu was told nothing but which surface to
   * show. Every reading here is what the HUD was TOLD, through the recorder, with no
   * session ever attached.
   */
  it('paints Continue, the Levels grid, Records and the paint shop at construction', () => {
    const f = fixture({
      seed: (stores) => {
        stores.run.startNewRun(CAMPAIGN_LEVELS[0].id);
        stores.progress.recordCleared(CAMPAIGN_LEVELS[0]);
        stores.customization.setHull('red');
      },
    });
    expect(f.host.hasSession()).toBe(false);
    expect(f.hud.argsOf('setContinueAvailable').at(-1)).toEqual([true]);
    // One cleared: the grid offers exactly that one. Not two -- the pane replays levels
    // the player has BEATEN and never offers the frontier (issue #555's second ruling).
    expect(f.hud.argsOf('setLevelSelect').at(-1)).toEqual([1, CAMPAIGN_LEVELS.length]);
    expect(f.hud.argsOf('setHullColor').at(-1)).toEqual(['red']);
    expect(f.hud.argsOf('setSkin')).toHaveLength(1);
    expect(f.hud.argsOf('setAccentColor')).toHaveLength(1);
    expect(f.hud.argsOf('setStats')).toHaveLength(1);
    expect(f.hud.argsOf('setAchievements')).toHaveLength(1);
  });

  it('sizes the grid on ALL-TIME progress, so a new campaign does not re-lock what was earned', () => {
    // The question issue #555 makes load-bearing. Before it, this contract only decided
    // which buttons were DIMMED; now it decides which exist at all, and whether the Main
    // Menu offers a Levels button in the first place -- so a page that sized the grid
    // from the active run instead of the permanent store would take a returning player's
    // whole campaign away, silently, with nothing on screen to say it had happened.
    //
    // Progress and the run are separate stores on purpose (`run.ts` vs `progress.ts`):
    // `startNewRun` writes only the run, and `progress.reset()` is reachable from exactly
    // one place -- Settings -> Reset progress, two-click confirmed. This pins the
    // composition of those two facts, which neither store's own suite can see.
    //
    // A REGRESSION GUARD, not a closed coverage gap, and the difference was measured
    // rather than assumed: a page that sized the grid from the run's own position was
    // applied to `route-host.ts` and killed by three cases, two of which already existed.
    // No manifest entry accompanies this test because no mutation kills it ALONE -- the
    // defect it names is currently unreachable by construction, since `RouteUiDeps` does
    // not carry `run` at all. It earns its place by stating the contract at the seam a
    // future widening of those deps would break first, not by adding a net.
    const f = fixture({
      seed: (stores) => {
        // Four cleared across earlier campaigns...
        for (const level of CAMPAIGN_LEVELS.slice(0, 4)) stores.progress.recordCleared(level);
        // ...and then a brand-new campaign, which starts back at level 1.
        stores.run.startNewRun(CAMPAIGN_LEVELS[0].id);
      },
    });
    // 4, not 0 and not 1: every level the player has ever BEATEN is still on offer. Not
    // 5 either -- level 5 was never cleared, and the frontier is the campaign's to hand
    // out, not the practice pane's.
    expect(f.hud.argsOf('setLevelSelect').at(-1)).toEqual([4, CAMPAIGN_LEVELS.length]);
    // ...and the run summary still reports where the NEW run stands, which is the half
    // that does come from the run store. Both readings from one paint, so a page that
    // crossed the two wires fails here rather than passing each check separately.
    expect(f.hud.argsOf('setCampaignRun').at(-1)).toEqual([{ mission: 1, lives: 3 }]);
  });

  it('paints no Continue when there is no run -- the negative control', () => {
    const f = fixture();
    expect(f.hud.argsOf('setContinueAvailable').at(-1)).toEqual([false]);
    expect(f.hud.argsOf('setCampaignRun').at(-1)).toEqual([null]);
    // 0, not 1: a player who has cleared nothing has nothing to replay, so the grid is
    // empty and `hud.ts` withholds the Levels button entirely. An empty grid is a
    // reachable VALUE and never a reachable screen.
    expect(f.hud.argsOf('setLevelSelect').at(-1)).toEqual([0, CAMPAIGN_LEVELS.length]);
  });

  it('resolves the run summary the Main Menu shows, mission NUMBER included (issue #226)', () => {
    // The mission number is resolved HERE and not in the HUD, because the run store holds
    // a level ID and only the level system can order it -- `run.ts` deliberately never
    // imports campaign data, and the HUD names no simulation module at all. So the page
    // is the only layer that can turn a stored id into "Mission 2".
    //
    // `toEqual` on the whole object, not a property check: the campaign LENGTH used to
    // travel here as `total` and issue #555 removed it, so this assertion is also what
    // fails if a later change starts sending the HUD a number it has no business
    // rendering. An extra key breaks toEqual; a `toMatchObject` would let it back in.
    const f = fixture({
      seed: (stores) => {
        stores.run.startNewRun(CAMPAIGN_LEVELS[1].id);
        stores.run.setLivesRemaining(2);
      },
    });
    expect(f.hud.argsOf('setCampaignRun').at(-1)).toEqual([{ mission: 2, lives: 2 }]);
  });

  it('reports a mission it cannot place as null rather than inventing a position', () => {
    // Reachable today: a developer session's `?dev=1&level=` jump can leave a run on a
    // level this build's sequence does not list. The HUD degrades the line to the lives
    // half; a fabricated `Mission 0` or a silent clamp to 1 would both be worse than
    // saying nothing about where the run stands.
    const f = fixture({
      seed: (stores) => {
        stores.run.startNewRun('a-level-this-campaign-does-not-contain');
      },
    });
    expect(f.hud.argsOf('setCampaignRun').at(-1)).toEqual([{ mission: null, lives: 3 }]);
    // ...and Continue is still offered: the run exists, only its POSITION is unresolvable.
    expect(f.hud.argsOf('setContinueAvailable').at(-1)).toEqual([true]);
  });

  it('paints the stored audio and input settings, which no session-less page did before', () => {
    // Issue #226 made Settings the one durable home for mute and volume, so a page that
    // painted neither until a session existed would show a returning player "Mute" and a
    // 0.6 slider over a store that says otherwise. This is the DISPLAY half;
    // `applyAudioSettings` drives the engine from the same subscription (issue #485), and
    // the test below is the one that proves the engine heard it.
    const f = fixture({
      seed: (stores) => {
        stores.settings.setMuted(true);
        stores.settings.setVolume(0.25);
      },
    });
    expect(f.host.hasSession(), 'the point is a page with no session').toBe(false);
    expect(f.hud.argsOf('setMuted').at(-1)).toEqual([true]);
    expect(f.hud.argsOf('setVolume').at(-1)).toEqual([0.25]);
    // ...and a later change reaches the controls too, so the button the player just
    // pressed redraws from the value the store actually accepted.
    f.stores.settings.setVolume(0.75);
    expect(f.hud.argsOf('setVolume').at(-1)).toEqual([0.75]);
  });

  it('MUTES THE ENGINE on a page with no session, not just the button (issue #485)', () => {
    // The half issue #324 could not take. A returning player who had muted the game got a
    // button that read "Muted" over an engine that was not muted, until the first match
    // constructed a session and `applySettings` ran. That was survivable only while the
    // page made no sound of its own -- and the menu bed in this same change removes that,
    // so shipping the two apart would have played music to somebody who switched it off.
    const f = fixture({
      seed: (stores) => {
        stores.settings.setMuted(true);
        stores.settings.setVolume(0.25);
      },
    });
    expect(f.host.hasSession(), 'the point is a page with no session').toBe(false);
    expect(f.audioCalls, 'the engine never heard the stored settings').toContain('muted:true');
    expect(f.audioCalls).toContain('volume:0.25');
    // ...and it keeps hearing them. One subscription drives both halves, so a change made
    // in Settings cannot reach the control while missing the engine.
    f.stores.settings.setMuted(false);
    expect(f.audioCalls.at(-2), 'a later change reached the button but not the engine').toBe(
      'muted:false',
    );
  });

  it('negative control: an UNMUTED save mutes nothing', () => {
    // Without this, an `applyAudioSettings` that called `setMuted(true)` unconditionally
    // -- or one that read the wrong field and happened to find a truthy value -- would
    // satisfy the assertion above while muting every player who never asked.
    const f = fixture();
    expect(f.audioCalls).toContain('muted:false');
    expect(f.audioCalls, 'a default save was muted').not.toContain('muted:true');
  });

  it('PLAYS THE MENU BED with no session in the slot, in order (issue #485)', () => {
    // The defect this issue recorded: since #428 the page boots empty and since #429 every
    // return to a route disposes the session, so the only thing that had ever started the
    // music no longer existed on the Main Menu. A fresh load was silent until the first
    // match, and silent again after every Quit.
    //
    // The exact SEQUENCE, matching the pin `loop.test.ts` already keeps on this trio: a
    // context set before the bed exists is stored by the engine and applied on start, so
    // swapping these two lines is invisible to counters and visible here.
    const f = fixture();
    expect(f.host.hasSession(), 'the point is a page with no session').toBe(false);
    expect(f.audioCalls.filter((c: string) => !c.startsWith('muted:') && !c.startsWith('volume:'))).toEqual([
      'start',
      'context:menu',
      'duck:false',
    ]);
  });

  it('FOLLOWS the game: gameplay takes the arena suite, pause ducks, the menu takes it back', () => {
    // The per-change half, and the half a construction-time call alone cannot cover:
    // deleting `followMusic(location)` from the page's `sm.onChange` leaves the eager call
    // at boot intact, so a suite that only checked the opening screen stayed green while
    // the music stopped following the game entirely. Measured -- that mutation survived 80
    // tests before this one existed.
    const f = fixture({ launchDismissed: true });
    const music = () => f.audioCalls.filter((c: string) => c.startsWith('context:') || c.startsWith('duck:'));
    const from = music().length;

    f.host.sm.enterGameplay({ descriptor: { kind: 'campaign', level: 0 }, level: 0, seed: 1 } as never);
    expect(music().slice(from), 'entering a match did not move the bed').toEqual([
      'context:arena',
      'duck:false',
    ]);

    // Pause DUCKS. A context change here would cut the bed and start another a beat later,
    // which is what `duckMusic`'s own comment exists to prevent.
    const atPause = music().length;
    f.host.sm.pause();
    expect(music().slice(atPause), 'pause did not duck, or changed suite').toEqual([
      'context:arena',
      'duck:true',
    ]);

    // ...and back to the menu, which is the arrival issue #485 is named for: this is the
    // path that was silent, because the session that used to do this was disposed on it.
    const atMenu = music().length;
    f.host.sm.toMainMenu();
    expect(music().slice(atMenu), 'returning to the menu left the arena bed playing').toEqual([
      'context:menu',
      'duck:false',
    ]);
  });

  it('never stops the bed it started, and never disposes the page engine', () => {
    // `stop` is the call that made the Main Menu silent -- the outgoing session's
    // `releaseAudio` fired it one call after the page had set the menu context. Nothing the
    // page does may reintroduce it, and `dispose` would be worse: it latches, so every
    // later session would get a dead `AudioContext` and no sound at all, silently.
    const f = fixture();
    f.host.attach(CAMPAIGN).detach();
    expect(f.audioCalls, 'something stopped the page bed').not.toContain('stop');
    expect(f.audioCalls, 'something disposed the page engine').not.toContain('dispose');
  });

  it('takes the page engine exactly ONCE, however many sessions come and go', () => {
    // `createAudio` returns `shell.audio` on every call in the browser, so asking twice is
    // harmless there and wrong everywhere else: a host that minted an engine per use would
    // read as correct against the real shell and silently split the bed under any other
    // wiring.
    const f = fixture();
    f.host.attach(CAMPAIGN).detach();
    f.stores.settings.setVolume(0.5);
    expect(f.audioBuilds()).toBe(1);
  });

  it('paints the STORED haptics preference, not the effective one', () => {
    // One of the two controls `paintSettingsControls` draws from the STORE rather than
    // from `effective` (the motion toggle is the other, below), and the only place the two
    // can disagree on this page: the fixture runs under NO_CAPABILITIES, so
    // `deviceVibration` is false and the EFFECTIVE value is false however the store reads.
    //
    // The toggle EDITS the preference. Painting it from the effective value shows a switch
    // forced off on any device without vibration, which reads as the preference having
    // been erased -- what issue #320 forbids, and what `loop.ts` was careful about while
    // it owned this push. The page read `effective.deviceHaptics` while it only ran on a
    // session-less page (issue #485); issue #324 made it the ONLY writer, which would have
    // shipped that reading everywhere.
    const f = fixture({ seed: (stores) => stores.settings.setDeviceHaptics(true) });
    expect(f.host.hasSession()).toBe(false);
    expect(
      f.stores.settings.snapshot().input.deviceHaptics,
      'the stored preference is what the toggle edits',
    ).toBe(true);
    expect(f.hud.argsOf('setHaptics').at(-1), 'the switch must not read as erased').toEqual([
      true,
    ]);
  });

  it('paints the STORED motion preference, and the resolved policy beside it', () => {
    // Both halves, because neither can carry the other. `setMotion` takes the three-state
    // preference the control EDITS -- painting it from `effective.reducedMotion` would
    // collapse 'system' into a boolean and leave a player following their device unable to
    // see, or return to, that state. `setReducedMotion` takes the resolved answer, which
    // is what drives the transitions and completes the 'Match device' label.
    const f = fixture({ seed: (stores) => stores.settings.setMotion('reduced') });
    expect(f.host.hasSession(), 'the point is a page with no session').toBe(false);
    expect(f.hud.argsOf('setMotion').at(-1)).toEqual(['reduced']);
    expect(f.hud.argsOf('setReducedMotion').at(-1)).toEqual([true]);
  });

  it('lets the motion control change the policy IMMEDIATELY, with the menu open and no session', () => {
    // Issue #364's fifth criterion, and the whole reason issue #289 is filed: the player
    // changes this from the Main Menu, where -- since issue #428 -- there is no session at
    // all. Everything the old push depended on is missing here, so this measures the
    // complete chain the page owns: the toggle's callback writes the store, the store
    // notifies `effectiveSettings`, and its subscription repaints BOTH the control and the
    // resolved policy on the same tick. No reload, no match, no second visit to Settings.
    const f = fixture();
    expect(f.host.hasSession()).toBe(false);
    // NEGATIVE CONTROL: the fixture's motion source reports no OS preference, so the
    // default 'system' resolves to false. Without it a chain that never ran would be
    // indistinguishable from one that ran and landed on the same answer.
    expect(f.stores.settings.snapshot().presentation.motion).toBe('system');
    expect(f.hud.argsOf('setReducedMotion').at(-1)).toEqual([false]);

    f.hud.fire('onMotionChange', 'reduced');
    expect(
      f.stores.settings.snapshot().presentation.motion,
      'the toggle did not reach the store',
    ).toBe('reduced');
    expect(
      f.hud.argsOf('setReducedMotion').at(-1),
      'the store moved but the resolved policy never reached the HUD',
    ).toEqual([true]);
    expect(
      f.hud.argsOf('setMotion').at(-1),
      'the control was not repainted from the value the store accepted',
    ).toEqual(['reduced']);
  });

  it('paints the STORED render-quality preset on a page with no session', () => {
    // Issue #540's first acceptance criterion, from the side the page owns. `setQuality`
    // reads `effective` rather than the store, unlike the haptics and motion pushes above,
    // and the reason is that nothing gates quality: effective IS the stored preset
    // (effective-settings.ts), so there is no second reading for an exception to protect.
    // What matters here is the same thing either way -- the control opens showing the
    // preset the player chose, on the Main Menu, which since issue #428 is where they are.
    const f = fixture({ seed: (stores) => stores.settings.setQuality('low') });
    expect(f.host.hasSession(), 'the point is a page with no session').toBe(false);
    // NEGATIVE CONTROL: 'low' is not the shipped default, so a paint that skipped the
    // stores entirely -- or a constant -- would have to disagree rather than coincide.
    expect(f.stores.settings.snapshot().presentation.quality).toBe('low');
    expect(f.hud.argsOf('setQuality').at(-1)).toEqual(['low']);
  });

  it('repaints the quality control from the value the STORE accepted, with no session', () => {
    // The whole chain the page owns for this control, measured end to end on an empty
    // page: the toggle's callback writes the store (route-ui.ts), the store notifies
    // `effectiveSettings`, and its subscription repaints the button. A handler that echoed
    // the click at the HUD instead would move the label and persist nothing, so the
    // preset would be gone on the next reload and would never reach a renderer.
    const f = fixture();
    expect(f.host.hasSession()).toBe(false);
    // NEGATIVE CONTROL on the pre-click state: the shipped default is 'high', so without
    // this a chain that never ran could not be told from one that ran and agreed.
    expect(f.stores.settings.snapshot().presentation.quality).toBe('high');
    expect(f.hud.argsOf('setQuality').at(-1)).toEqual(['high']);

    f.hud.fire('onQualityChange', 'medium');
    expect(
      f.stores.settings.snapshot().presentation.quality,
      'the toggle did not reach the store',
    ).toBe('medium');
    expect(
      f.hud.argsOf('setQuality').at(-1),
      'the control was not repainted from the value the store accepted',
    ).toEqual(['medium']);
  });

  it('keeps painting settings while a session holds the slot', () => {
    // The early return this replaced (`if (live !== null) return;`) existed because
    // `loop.ts` pushed the same values from its own subscription, so two owners would
    // have painted the same control. Issue #324 removed the session's push, which makes
    // the early return a hole rather than a courtesy: Settings is reachable DURING a
    // match, and a preference changed there would not redraw for as long as the match
    // lasted.
    const f = fixture({ seed: (stores) => stores.settings.setVolume(0.25) });
    fillSlot(f.host);
    expect(f.host.hasSession(), 'this test is about the live case').toBe(true);
    const before = f.hud.argsOf('setVolume').length;
    f.stores.settings.setVolume(0.8);
    expect(f.hud.argsOf('setVolume').length, 'the page repainted with a session live').toBe(
      before + 1,
    );
    expect(f.hud.argsOf('setVolume').at(-1)).toEqual([0.8]);
  });

  it('claims M for the page and reports the result, on a page with no session', () => {
    // The mute shortcut moved off the session's key handler with issue #226: the topbar
    // chip that used to show mute state on every surface is gone, so a session-scoped M
    // would be dead on exactly the screen that no longer shows one. The toast is the
    // issue's "brief status feedback" -- without it a mis-typed M is indistinguishable
    // from a broken build.
    const f = fixture({ launchDismissed: true });
    expect(f.host.hasSession()).toBe(false);
    f.fireHost('keydown', new KeyboardEvent('keydown', { key: 'm' }));
    expect(f.stores.settings.snapshot().audio.muted, 'M did not reach the store').toBe(true);
    expect(f.hud.argsOf('showToast').at(-1)).toEqual(['Muted']);
    f.fireHost('keydown', new KeyboardEvent('keydown', { key: 'm' }));
    expect(f.stores.settings.snapshot().audio.muted).toBe(false);
    expect(f.hud.argsOf('showToast').at(-1)).toEqual(['Sound on']);
  });

  it('paints the application ground the development flag names, and the default without one', () => {
    // Issue #324, step S5. The ground is page chrome that outlives every match, and a
    // session used to push it at its own construction -- so a page that never started one
    // stood on whatever the markup happened to say. The default is stated rather than
    // left implicit for the same reason it was in the session: an element's initial
    // classes are not a projection.
    expect(fixture({ devFlags: { backdrop: 'felt' } }).hud.argsOf('setBackdrop')).toEqual([
      ['felt'],
    ]);
    // The negative control: a page with no flag must say 'default', not nothing and not
    // 'felt'. Without it, an unconditional `hud.setBackdrop('felt')` would pass above.
    expect(fixture().hud.argsOf('setBackdrop')).toEqual([['default']]);
    // ...and an unrecognised value is the default too, which is what keeps the mapping
    // from flag vocabulary to HUD vocabulary here rather than in the HUD.
    expect(
      fixture({ devFlags: { backdrop: 'marble' as never } }).hud.argsOf('setBackdrop'),
    ).toEqual([['default']]);
  });

  it('re-sizes the Levels grid on every arrival at the Main Menu, and only there', () => {
    // A level is cleared mid-match, where the grid is neither shown nor reachable --
    // `hud.ts` puts the Levels button on the Main Menu alone. So the arrival back is both
    // the first moment the new size can be seen and a moment that necessarily precedes
    // seeing it. The session used to repaint at the win instead, which covered the same
    // instant from the other side and covered nothing at all on a page with no session.
    const f = fixture({ launchDismissed: true });
    const before = f.hud.argsOf('setLevelSelect').length;
    f.stores.progress.recordCleared(CAMPAIGN_LEVELS[0]);
    // Two negative controls in one: clearing a level is not a paint, and neither is
    // arriving at some OTHER route. Without them a host that repainted on every state
    // change -- or on every store write -- would satisfy the assertion below.
    expect(f.hud.argsOf('setLevelSelect'), 'a cleared level is not a paint').toHaveLength(before);
    f.host.sm.toRoute('settings');
    expect(f.hud.argsOf('setLevelSelect'), 'a non-menu route re-sized the grid').toHaveLength(
      before,
    );
    f.host.sm.toMainMenu();
    expect(f.hud.argsOf('setLevelSelect').at(-1)).toEqual([1, CAMPAIGN_LEVELS.length]);
  });

  it('re-reads Continue on every arrival at the Main Menu, and only there', () => {
    // The run changes underneath the page while it is away on another route -- as it
    // does when a session ends it and is disposed. A page that trusted the value it
    // painted at construction would offer Continue for a run that no longer exists.
    const f = fixture({ launchDismissed: true });
    const before = f.hud.argsOf('setContinueAvailable').length;
    f.stores.run.startNewRun(CAMPAIGN_LEVELS[0].id);
    f.host.sm.toRoute('settings');
    expect(f.hud.argsOf('setContinueAvailable'), 'a non-menu route repainted Continue').toHaveLength(before);
    f.host.sm.toMainMenu();
    expect(f.hud.argsOf('setContinueAvailable').at(-1)).toEqual([true]);
    f.stores.run.endRun();
    f.host.sm.toRoute('records');
    f.host.sm.toMainMenu();
    expect(f.hud.argsOf('setContinueAvailable').at(-1)).toEqual([false]);
  });
});

describe('createRouteHost: where the page opens', () => {
  it('opens on the splash when the Launch gate is still up', () => {
    expect(fixture({ launchDismissed: false }).host.sm.atLaunch).toBe(true);
  });

  /**
   * ...and on Main Menu when it is already down, read at CONSTRUCTION.
   *
   * Today no production path builds a route host with a dismissed gate -- `boot.ts` builds
   * the shell and the route host one statement apart, before any gesture -- so this branch
   * is currently reachable only from here. It is kept, and tested, because issue #428
   * removes the eager `sessions.start()` that currently papers over it: with no session at
   * boot there is no `attach()` to correct the route afterwards, and a page that hardcoded
   * `'launch'` would show a returning player a splash they had already dismissed.
   *
   * Measured, not assumed: with this case absent, `initialRoute: 'launch'` SURVIVED at 0 of
   * 423 -- the manifest entry `launch-gate-ignored-on-reboot`, which the ownership move had
   * quietly emptied out.
   */
  it('opens on Main Menu when the gate was already dismissed', () => {
    expect(fixture({ launchDismissed: true }).host.sm.atMainMenu).toBe(true);
  });
});

describe('createRouteHost: the route on attach', () => {
  it('leaves the splash up for the FIRST session of a document load', () => {
    // The Launch gate is a page-level handoff. A host that reset to Main Menu here would
    // skip the splash entirely -- and with it the gesture that unlocks the AudioContext.
    const f = fixture({ launchDismissed: false });
    f.host.attach(CAMPAIGN);
    expect(f.host.sm.atLaunch).toBe(true);
  });

  /**
   * ...and resets it once the gate is down, which is the job the freshly-constructed
   * state machine used to do on every Campaign<->Versus reboot.
   *
   * Would fail if `attach()` left the route alone: the incoming session would inherit
   * whatever the outgoing one was on -- mid-gameplay, or at an outcome screen -- which is
   * the "stale route state" issue #468's acceptance criteria forbid.
   */
  it('resets to Main Menu for a replacement session', () => {
    const f = fixture({ launchDismissed: true });
    const first = f.host.attach(CAMPAIGN);
    f.host.sm.enterGameplay({
      descriptor: { kind: 'campaign', level: 0 },
      level: 0,
      seed: 1,
    } as never);
    expect(f.host.sm.inGameplay).toBe(true);

    first.detach();
    f.host.attach(CAMPAIGN);
    expect(f.host.sm.atMainMenu, 'the replacement session inherited a gameplay route').toBe(true);
  });
});

/**
 * Returning to an application route disposes the session (issue #429).
 *
 * The rule is "a handler that ran while the machine was in gameplay and left it", so
 * every case here drives the machine into gameplay first and then fires a real HUD
 * handler. Counting the STOP REQUESTS rather than inspecting a flag is what makes these
 * about the boundary `boot.ts` actually wires, not about an internal.
 */
describe('createRouteHost: leaving gameplay (issue #429)', () => {
  /** Attach a session and put the machine into gameplay, the way a real start does. */
  function inGameplay(f: Fixture): ReturnType<RouteHost['attach']> {
    const slot = f.host.attach(CAMPAIGN);
    f.host.sm.enterGameplay({
      descriptor: { kind: 'campaign', level: 0 },
      level: 0,
      seed: 1,
    } as never);
    expect(f.host.sm.inGameplay).toBe(true);
    return slot;
  }

  it('Quit disposes exactly once', () => {
    const f = fixture({ launchDismissed: true });
    const slot = inGameplay(f);
    slot.onQuitToTitle(() => f.host.sm.toMainMenu());

    f.hud.fire('onQuitToTitle');
    expect(f.stopRequests(), 'the session outlived the return to Main Menu').toBe(1);
  });

  /**
   * The action button is an exit TOO, on one of its branches: a finished versus match's
   * reads "Versus Setup" and returns to the retained pane. Same rule, no second list.
   */
  it('an action-button branch that returns to a route disposes too', () => {
    const f = fixture({ launchDismissed: true });
    const slot = inGameplay(f);
    slot.onStartRestart(() => f.host.sm.toMainMenu());

    f.hud.fire('onStartRestart');
    expect(f.stopRequests()).toBe(1);
  });

  /**
   * ...and a branch that STAYS in gameplay disposes nothing. This is the half a
   * one-sided rule gets wrong: Resume, Retry, Play Again and Next Level all run the same
   * handler and must leave the session alone.
   *
   * Would fail if `leavingGameplay` read only the after-state, or dropped the
   * `wasInGameplay` half.
   */
  it('a handler that stays in gameplay disposes nothing', () => {
    const f = fixture({ launchDismissed: true });
    const slot = inGameplay(f);
    let ran = 0;
    slot.onStartRestart(() => {
      ran += 1; // Resume: the machine stays where it is.
    });

    f.hud.fire('onStartRestart');
    expect(ran, 'the handler did not run at all').toBe(1);
    expect(f.stopRequests(), 'a click that stayed in gameplay disposed the session').toBe(0);
  });

  /**
   * A click made AT an application route disposes nothing either -- the other direction of
   * the same mistake, and the one that would fire on every menu button.
   */
  it('a click at an application route disposes nothing', () => {
    const f = fixture({ launchDismissed: true });
    const slot = f.host.attach(CAMPAIGN);
    slot.onQuitToTitle(() => f.host.sm.toMainMenu());

    f.hud.fire('onQuitToTitle');
    expect(f.stopRequests()).toBe(0);
  });

  it('a Quit with no session attached asks for nothing', () => {
    // The empty host is the page's normal state since #428; a stop request from it would
    // be a disposal of something that does not exist.
    const f = fixture({ launchDismissed: true });
    f.hud.fire('onQuitToTitle');
    expect(f.stopRequests()).toBe(0);
  });

  /**
   * Repeated Quits ask once, because the second finds the machine already out of
   * gameplay. The criterion "repeated stop requests cannot duplicate cleanup" is answered
   * twice over -- here, and by `stopSession` being idempotent in `session-host.ts`.
   */
  it('a second Quit does not ask again', () => {
    const f = fixture({ launchDismissed: true });
    const slot = inGameplay(f);
    slot.onQuitToTitle(() => f.host.sm.toMainMenu());

    f.hud.fire('onQuitToTitle');
    f.hud.fire('onQuitToTitle');
    expect(f.stopRequests(), 'the second Quit disposed again').toBe(1);
  });
});

describe("createRouteHost: the HUD's own Back never leaves gameplay (issue #318)", () => {
  it('a pointer Back on Controllers at paused leaves the machine paused and requests neither a stop nor a start', () => {
    // The direct proof of issue #429's dispose rule against the new Back path: hud.ts's
    // `back()` re-renders the origin surface through `setState` and never touches the
    // state machine, so `leavingGameplay` sees no exit. A Back wired through
    // `toMainMenu` would dispose the session the player was about to resume.
    const f = fixture({ launchDismissed: true, realHud: true });
    f.host.attach(CAMPAIGN);
    f.host.sm.enterGameplay({
      descriptor: { kind: 'campaign' },
      seed: 1,
      arenaId: 'arena-01',
    });
    f.host.sm.pause();
    expect(f.host.sm.isPaused).toBe(true);
    const click = (sel: string): void => {
      (f.root.querySelector(sel) as HTMLElement).dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }),
      );
    };
    click('.hud-controllers-open');
    expect((f.root.querySelector('.hud-controllers') as HTMLElement).classList.contains('hud-controllers--hidden')).toBe(false);
    click('.hud-controllers-back');
    expect(f.host.sm.isPaused, 'Back moved the machine').toBe(true);
    expect(f.host.sm.inGameplay).toBe(true);
    expect(f.stopRequests(), 'Back asked the page to dispose the session').toBe(0);
    expect(f.startRequests, 'Back asked the page for a match').toEqual([]);
    expect((f.root.querySelector('.hud-action') as HTMLElement).textContent).toBe('Resume');
    f.host.dispose();
    f.root.remove();
  });
});

describe('createRouteHost: disposal', () => {
  it("releases the page's own painter: a machine change after disposal paints nothing", () => {
    // The route host and its machine die together, but a reference kept past teardown
    // must not drive a disposed HUD. Before disposal the same change paints -- the
    // negative control for an assertion that would otherwise pass on a painter that
    // never painted at all.
    const f = fixture({ launchDismissed: true });
    const before = f.hud.argsOf('setState').length;
    f.host.sm.toRoute('settings');
    expect(f.hud.argsOf('setState').length, 'the live painter did not paint').toBe(before + 1);
    f.host.dispose();
    const disposed = f.hud.argsOf('setState').length;
    f.host.sm.toRoute('records');
    expect(f.hud.argsOf('setState').length, 'the painter outlived the page').toBe(disposed);
  });

  it('disposes the HUD and the live preview, and only from here', () => {
    const f = fixture();
    f.hud.fire('onCustomizeOpen');
    const slot = f.host.attach(CAMPAIGN);

    slot.detach();
    expect(f.hud.disposals(), 'a session teardown disposed the page HUD').toBe(0);
    expect(f.previewDisposals(), 'a session teardown disposed the page preview').toBe(0);

    f.host.dispose();
    expect(f.hud.disposals()).toBe(1);
    expect(f.previewDisposals()).toBe(1);
  });
});

describe('createRouteHost: the gamepad menu poller (issue #494)', () => {
  /** A standard-mapping pad with `pressed` buttons and centred sticks. */
  const pad = (...pressed: number[]): GamepadLike => ({
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: pressed.includes(i) })),
    id: 'Fake Pad',
  });
  /** Run the one queued page frame at `now`; the poller queues the next one itself. */
  const frame = (f: Fixture, now: number): void => {
    expect(f.frames.length, 'exactly one page frame should be queued').toBe(1);
    f.frames.shift()!(now);
  };
  /** The first control hud.ts's roving walk would land on: enabled and not inside a hidden subtree. */
  const firstControl = (container: HTMLElement): HTMLElement => {
    const hidden = (el: HTMLElement): boolean => {
      for (let n: HTMLElement | null = el; n && n !== container; n = n.parentElement) {
        if (getComputedStyle(n).display === 'none') return true;
      }
      return false;
    };
    return Array.from(container.querySelectorAll<HTMLElement>('button, [tabindex]')).find(
      (el) => !(el instanceof HTMLButtonElement && el.disabled) && !hidden(el),
    )!;
  };

  it('polls on a page frame loop from construction: one frame queued, and each frame queues the next', () => {
    const f = fixture({ launchDismissed: true });
    expect(f.frames).toHaveLength(1);
    frame(f, 0);
    expect(f.frames, 'the frame did not queue its successor').toHaveLength(1);
  });

  it('any button at Launch dismisses the splash, exactly as a key does', () => {
    const f = fixture();
    expect(f.host.sm.atLaunch).toBe(true);
    f.pads.push(pad(0));
    frame(f, 0);
    expect(f.host.sm.atLaunch, 'Confirm did not dismiss Launch').toBe(false);
    expect(f.host.sm.atMainMenu).toBe(true);
  });

  it('a direction walks the real HUD and Back pops its layer', () => {
    const f = fixture({ launchDismissed: true, realHud: true });
    const panel = f.root.querySelector('.hud-panel') as HTMLElement;
    expect(document.activeElement).toBe(panel);
    f.pads.push(pad(13)); // D-pad Down
    frame(f, 0);
    expect(document.activeElement, 'Down did not move focus into the panel').toBe(firstControl(panel));
    f.pads[0] = pad(); // released
    frame(f, 16);
    (f.root.querySelector('.hud-customize-open') as HTMLElement).focus();
    f.pads[0] = pad(0); // A: confirm
    frame(f, 32);
    const customize = f.root.querySelector('.hud-customize') as HTMLElement;
    expect(customize.classList.contains('hud-customize--hidden'), 'Confirm did not open the pane').toBe(false);
    f.pads[0] = pad();
    frame(f, 48);
    f.pads[0] = pad(1); // B: back
    frame(f, 64);
    expect(customize.classList.contains('ui-surface--leaving'), 'Back did not pop the pane').toBe(true);
    f.host.dispose();
    f.root.remove();
  });

  it('Start pauses a simulating session and resumes a paused one; every other action is dropped mid-play', () => {
    const f = fixture({ launchDismissed: true, realHud: true });
    f.host.attach(CAMPAIGN);
    f.host.sm.enterGameplay({ descriptor: { kind: 'campaign' }, seed: 1, arenaId: 'arena-01' });
    expect(f.host.sm.isSimulating).toBe(true);
    // The MACHINE decides, not the DOM. Today no panel is displayed while a session
    // simulates, so the HUD's dispatcher would be inert anyway; a surface pushed here by
    // hand stands in for a future gameplay HUD with focusable controls (issue #324), and
    // a direction must still move nothing while the round runs.
    f.host.hud.setState('main-menu');
    const panel = f.root.querySelector('.hud-panel') as HTMLElement;
    const focusBefore = document.activeElement;
    expect(focusBefore, 'the pushed surface focused its container').toBe(panel);
    f.pads.push(pad(13, 0, 1)); // Down, A and B all held mid-play
    frame(f, 0);
    expect(f.host.sm.isSimulating, 'a menu action reached a simulating session').toBe(true);
    expect(document.activeElement, 'a direction moved focus mid-play').toBe(focusBefore);
    f.pads[0] = pad(9); // Start
    frame(f, 16);
    expect(f.host.sm.isPaused, 'Start did not pause').toBe(true);
    f.pads[0] = pad(9, 0); // Start still held, A pressed: no repeat, and A is a fresh press at Pause
    frame(f, 32);
    expect(f.host.sm.isPaused, 'a held Start repeated').toBe(true);
    f.pads[0] = pad();
    frame(f, 48);
    f.pads[0] = pad(9);
    frame(f, 64);
    expect(f.host.sm.isPaused, 'a second Start did not resume').toBe(false);
    expect(f.host.sm.isSimulating).toBe(true);
    f.host.dispose();
    f.root.remove();
  });

  it('Back at Pause with nothing open resumes; with a pane open it pops the pane and leaves the round paused', () => {
    const f = fixture({ launchDismissed: true, realHud: true });
    f.host.attach(CAMPAIGN);
    f.host.sm.enterGameplay({ descriptor: { kind: 'campaign' }, seed: 1, arenaId: 'arena-01' });
    f.host.sm.pause();
    (f.root.querySelector('.hud-controllers-open') as HTMLElement).dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }),
    );
    const controllers = f.root.querySelector('.hud-controllers') as HTMLElement;
    expect(controllers.classList.contains('hud-controllers--hidden')).toBe(false);
    f.pads.push(pad(1)); // B
    frame(f, 0);
    expect(controllers.classList.contains('ui-surface--leaving'), 'Back did not pop the pane').toBe(true);
    expect(f.host.sm.isPaused, 'Back over a pane resumed the round underneath').toBe(true);
    f.pads[0] = pad();
    frame(f, 16);
    f.pads[0] = pad(1);
    frame(f, 32);
    expect(f.host.sm.isPaused, 'Back with nothing open did not resume').toBe(false);
    expect(f.stopRequests(), 'Back asked the page to dispose the session').toBe(0);
    f.host.dispose();
    f.root.remove();
  });

  it('a held A across a Resume does not confirm again, so the pad that resumed the round is silent at the next Pause', () => {
    // The poller's own edge state: A pressed at Pause (Resume, via confirm on the focused
    // action button) stays "held" through play, and the next Pause sees no fresh edge.
    const f = fixture({ launchDismissed: true, realHud: true });
    const slot = f.host.attach(CAMPAIGN);
    // What a real session registers: the action button at Pause is Resume.
    slot.onStartRestart(() => {
      if (f.host.sm.isPaused) f.host.sm.resume();
    });
    f.host.sm.enterGameplay({ descriptor: { kind: 'campaign' }, seed: 1, arenaId: 'arena-01' });
    f.host.sm.pause();
    const action = f.root.querySelector('.hud-action') as HTMLElement;
    expect(action.textContent).toBe('Resume');
    action.focus();
    f.pads.push(pad(0));
    frame(f, 0);
    expect(f.host.sm.isSimulating, 'Confirm on Resume did not resume').toBe(true);
    f.host.sm.pause();
    action.focus();
    frame(f, 16); // A still held
    expect(f.host.sm.isPaused, 'a held A re-confirmed at the next Pause').toBe(true);
    f.host.dispose();
    f.root.remove();
  });

  it('disposal cancels the queued frame, and a frame that fires anyway emits nothing', () => {
    const f = fixture({ launchDismissed: true });
    f.host.attach(CAMPAIGN);
    f.host.sm.enterGameplay({ descriptor: { kind: 'campaign' }, seed: 1, arenaId: 'arena-01' });
    f.host.sm.pause();
    // Negative control for the emission claim: a live frame with Start held resumes.
    f.pads.push(pad(9));
    frame(f, 0);
    expect(f.host.sm.isPaused, 'the live poller did not resume').toBe(false);
    f.pads[0] = pad();
    frame(f, 16);
    f.host.sm.pause();
    const queued = f.frames[0]!;
    f.host.dispose();
    expect(f.frames, 'disposal left a frame queued').toHaveLength(0);
    f.pads[0] = pad(9);
    queued(32);
    expect(f.frames, 'a post-disposal frame queued another').toHaveLength(0);
    expect(f.host.sm.isPaused, 'a disposed poller still emitted').toBe(true);
  });
});

describe('createRouteHost: prompts follow the input the player is using (issue #496)', () => {
  // The mute button lives in Settings -> Audio since issue #226; the topbar chip this
  // used to read is gone. Its label is still the modality-sensitive one (`Mute (M)` on a
  // keyboard, bare `Mute` on touch and on a pad), which is all this suite reads it for.
  const mute = (f: Fixture): HTMLElement =>
    f.root.querySelector('.hud-settings-mute') as HTMLElement;
  const key = (f: Fixture): void => {
    f.fireHost('keydown', new KeyboardEvent('keydown', { key: 'a' }));
  };
  /** A pointerdown at the page host, of the given kind, the way a browser reports it. */
  const pointer = (f: Fixture, pointerType: string): void => {
    const e = new MouseEvent('pointerdown') as MouseEvent & { pointerType?: string };
    Object.defineProperty(e, 'pointerType', { value: pointerType });
    f.fireHost('pointerdown', e);
  };
  const pad = (...pressed: number[]): GamepadLike => ({
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: pressed.includes(i) })),
    id: 'Fake Pad',
  });

  it('the first input of the page sets the hint with no threshold: a touch tap drops the key hint', () => {
    const f = fixture({ launchDismissed: true, realHud: true });
    expect(mute(f).textContent, 'a fresh page keeps the shipped keyboard hint').toBe('Mute (M)');
    pointer(f, 'touch');
    expect(mute(f).textContent, 'the first input did not take effect immediately').toBe('Mute');
    f.host.dispose();
    f.root.remove();
  });

  it('a single stray event of another modality does not switch the hint; a sustained one does', () => {
    const f = fixture({ launchDismissed: true, realHud: true });
    key(f);
    expect(mute(f).textContent).toBe('Mute (M)');
    f.advance(50);
    pointer(f, 'touch');
    expect(mute(f).textContent, 'one stray tap rewrote the hint').toBe('Mute (M)');
    f.advance(MODALITY_SWITCH_MS);
    pointer(f, 'touch');
    expect(mute(f).textContent, 'a sustained touch did not take over').toBe('Mute');
    f.host.dispose();
    f.root.remove();
  });

  it('a gamepad naming its own button takes over from the keyboard, and the mouse is not touch', () => {
    const f = fixture({ launchDismissed: true, realHud: true });
    key(f);
    f.pads.push(pad(13));
    f.frames.shift()!(0);
    expect(mute(f).textContent, 'one pad press rewrote the hint').toBe('Mute (M)');
    f.advance(MODALITY_SWITCH_MS);
    f.pads[0] = pad();
    f.frames.shift()!(1);
    f.pads[0] = pad(13);
    f.frames.shift()!(2);
    // Nothing binds a pad button to mute, so the hint is empty rather than a false
    // instruction; the pad reaches the button through focus like any other control.
    expect(mute(f).textContent, 'a sustained pad should not name an unbound button').toBe('Mute');
    // A mouse is `pointer`, not `touch`, and keeps the key hint: clicking says nothing
    // about whether a keyboard is present, and on the desktop it always is.
    f.advance(MODALITY_SWITCH_MS * 2);
    pointer(f, 'mouse');
    f.advance(MODALITY_SWITCH_MS);
    pointer(f, 'mouse');
    expect(mute(f).textContent, 'a mouse should keep the key hint').toBe('Mute (M)');
    f.host.dispose();
    f.root.remove();
  });

  it('a modality change repaints the hint and nothing else: no surface is re-rendered', () => {
    // The ruling this pins: Settings never reflows on a modality change. Measured as a
    // contrast -- the HUD's own setState count must not move while the hint does.
    const f = fixture({ launchDismissed: true });
    const before = f.hud.argsOf('setState').length;
    key(f);
    f.advance(MODALITY_SWITCH_MS);
    pointer(f, 'touch');
    f.advance(MODALITY_SWITCH_MS);
    pointer(f, 'touch');
    expect(f.hud.argsOf('setState').length, 'a modality change re-rendered a surface').toBe(before);
  });
});
