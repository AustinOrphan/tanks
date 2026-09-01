// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { createRouteHost, type RouteHost, type RouteHostDeps, type StartIntent } from './route-host';
import { createAppSettings } from './app-settings';
import { createMemoryStorage, createStores } from './storage';
import { createCapabilitySource, createStaticReducedMotionSource, NO_CAPABILITIES } from './capabilities';
import { createGameStateMachine } from './state';
import { createLevelSystem } from './levels';
import { DEV_FLAGS_OFF } from './devflags';
import { defaultSlots } from './versus-setup';
import type { Hud } from './hud';
import type { TankPreview } from '../render/preview';
import type { VersusConfig } from './versus-config';
import type { RouteUiDeps } from './route-ui';

/**
 * Issue #468's coverage, and the shape of it is the point.
 *
 * `hud.ts` APPENDS every `on*` callback and has no unregister at all -- 25 `push(cb)`
 * methods, no `off`, no `delete`, no `splice`. So the failure this file exists to catch is
 * SILENT and additive: after one stop-and-start, a page-scoped HUD that let each session
 * register its own handlers would fire New Game twice on one click. Nothing counts
 * REGISTRATIONS below, because a registration count can be satisfied by a trampoline that
 * registered once and dispatched twice. Every assertion fires a trigger and counts what
 * actually happened.
 */

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
  hud: ReturnType<typeof recordingHud>;
  root: HTMLElement;
  versusStarts: VersusConfig[];
  campaignRequests: () => number;
  previewDisposals: () => number;
  dismissLaunch(): void;
}

function fixture(opts: { launchDismissed?: boolean } = {}): Fixture {
  const storage = createMemoryStorage();
  const appSettings = createAppSettings({
    storage,
    namespace: 'production',
    stores: createStores(storage),
    capabilities: createCapabilitySource(() => NO_CAPABILITIES),
    motion: createStaticReducedMotionSource(false),
  });
  const stores = appSettings.stores;
  const hud = recordingHud();
  const root = document.createElement('div');
  const box = {
    startRequests: [] as StartIntent[],
    versusStarts: [] as VersusConfig[],
    campaignRequests: 0,
    previewDisposals: 0,
    launchDismissed: opts.launchDismissed ?? false,
  };

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
    host: {
      addEventListener: () => {},
      removeEventListener: () => {},
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
    createHud: () => hud.hud,
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
    requestVersusSession: (config) => box.versusStarts.push(config),
    requestCampaignSession: () => {
      box.campaignRequests += 1;
    },
  });

  return {
    host,
    hud,
    root,
    startRequests: box.startRequests,
    versusStarts: box.versusStarts,
    campaignRequests: () => box.campaignRequests,
    previewDisposals: () => box.previewDisposals,
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
  const slot = host.attach();
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
    f.host.attach().detach();
    f.host.attach().detach();
    for (const h of GAMEPLAY_HANDLERS) {
      expect(f.hud.registrations(h.hudName), `${h.hudName} was registered again`).toBe(1);
    }
  });

  it('registers each application route exactly once too', () => {
    // The 19 `route-ui.ts` handlers. `createRouteUi` is called once by construction, and
    // the mutation that calls it per attach would double every one of these.
    const f = fixture();
    f.host.attach().detach();
    f.host.attach();
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
    const first = f.host.attach();
    const second = fillSlot(f.host);
    const stale: string[] = [];
    first.onNewGame(() => stale.push('stale'));

    f.hud.fire('onNewGame');
    expect(stale, 'a retired slot wrote over the live session').toEqual([]);
    expect(second.fired.map(([n]) => n)).toEqual(['onNewGame']);
  });

  it('registration REPLACES within one slot, so a session cannot double itself', () => {
    const f = fixture();
    const slot = f.host.attach();
    const fired: string[] = [];
    slot.onNewGame(() => fired.push('a'));
    slot.onNewGame(() => fired.push('b'));
    f.hud.fire('onNewGame');
    expect(fired).toEqual(['b']);
  });
});

describe('createRouteHost: the application-level start requests (issue #468)', () => {
  it('Versus Start reaches the page seam, with no session attached', () => {
    // The criterion in the issue's own words: a gameplay-starting route action must not
    // require dereferencing an existing gameplay session.
    const f = fixture();
    f.hud.fire('onVersusStart', CONFIG);
    expect(f.versusStarts).toEqual([CONFIG]);
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
    expect(f.versusStarts).toEqual([CONFIG, CONFIG]);
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
    f.host.attach().setVersusConfig(CONFIG);
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
    const slot = f.host.attach();
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
    const versusSlot = f.host.attach();
    versusSlot.setVersusConfig(CONFIG);
    versusSlot.detach();

    // A campaign session: it has no versus config of its own, and must not say so.
    f.host.attach();

    f.hud.fire('onVersusOpen');
    expect(
      f.hud.argsOf('showVersusSetup'),
      'a campaign session cleared the retained versus config',
    ).toEqual([[true, CONFIG]]);
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
    f.host.attach();
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
    const first = f.host.attach();
    f.host.sm.enterGameplay({
      descriptor: { kind: 'campaign', level: 0 },
      level: 0,
      seed: 1,
    } as never);
    expect(f.host.sm.inGameplay).toBe(true);

    first.detach();
    f.host.attach();
    expect(f.host.sm.atMainMenu, 'the replacement session inherited a gameplay route').toBe(true);
  });
});

describe('createRouteHost: disposal', () => {
  it('disposes the HUD and the live preview, and only from here', () => {
    const f = fixture();
    f.hud.fire('onCustomizeOpen');
    const slot = f.host.attach();

    slot.detach();
    expect(f.hud.disposals(), 'a session teardown disposed the page HUD').toBe(0);
    expect(f.previewDisposals(), 'a session teardown disposed the page preview').toBe(0);

    f.host.dispose();
    expect(f.hud.disposals()).toBe(1);
    expect(f.previewDisposals()).toBe(1);
  });
});
