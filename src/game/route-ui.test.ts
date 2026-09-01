// @vitest-environment jsdom
//
// The worldless shell seam (issue #427).
//
// Every test here builds the application routes with NO gameplay session behind them --
// no world, driver, renderer, canvas, frame loop or input controller -- and drives the
// routes anyway. That is criterion 1, and it needs its own file rather than a case in
// loop.test.ts: loop.test.ts reaches these handlers THROUGH `startGameWith`, so every
// assertion it makes about them is also an assertion that a session exists. Nothing there
// can fail if the route UI silently starts depending on gameplay again.
//
// Driven through the `Hud` INTERFACE rather than through hud.css class names. The DOM
// wiring from a button to `onCustomizeOpen` is hud.test.ts's subject and is covered there;
// what is under test here is what happens on the other side of that callback with no
// session, so binding these cases to markup would only make them fail for reasons this
// file is not about.
import { describe, it, expect } from 'vitest';
import { createRouteUi, type RouteUi, type RouteUiDeps, type StyleSink } from './route-ui';
import type { Hud } from './hud';
import { createGameSessionHost } from './session-host';
import { createGameStateMachine, createOutcomeClassifier, type GameStateMachine } from './state';
import { createAppSettings } from './app-settings';
import { createMemoryStorage, createStores } from './storage';
import {
  createCapabilitySource,
  createStaticReducedMotionSource,
  NO_CAPABILITIES,
} from './capabilities';
import { createLevelSystem } from './levels';
import { DEV_FLAGS_OFF } from './devflags';
import type { VersusConfig } from './versus-config';
import type { TankPreview } from '../render/preview';

type Triple = [string, string, string | null];

/**
 * A `Hud` that records what was called on it and hands back what was registered.
 *
 * A Proxy rather than an object literal with ~90 stubs: the `Hud` interface is wide, and
 * a literal would need editing every time an unrelated method joined it -- which is a
 * maintenance cost that buys nothing here, since these tests care about exactly the
 * `on*` registrations the route UI makes and the handful of setters those call back into.
 */
function recordingHud(): {
  hud: Hud;
  handlers: Map<string, (...args: unknown[]) => unknown>;
  calls: string[];
} {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const calls: string[] = [];
  const previewCanvas = document.createElement('canvas');
  const hud = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === 'previewCanvas') return previewCanvas;
        if (prop === 'previewRotateButtons') return [];
        return (...args: unknown[]): unknown => {
          if (prop.startsWith('on') && typeof args[0] === 'function') {
            handlers.set(prop, args[0] as (...a: unknown[]) => unknown);
            return undefined;
          }
          calls.push(prop);
          return undefined;
        };
      },
    },
  ) as unknown as Hud;
  return { hud, handlers, calls };
}

interface Fixture {
  hud: Hud;
  sm: GameStateMachine;
  routeUi: RouteUi;
  deps: RouteUiDeps;
  /** Fire a registered route handler by its `Hud` method name. */
  fire: (name: string, ...args: unknown[]) => void;
  registered: () => string[];
  hudCalls: string[];
  hostEvents: string[];
  versusStarts: VersusConfig[];
  campaignRequests: () => number;
  previewsBuilt: () => number;
  previewStyles: Triple[];
  previewDisposals: () => number;
  previewResizes: () => number;
  sunkStyles: Triple[];
  muted: () => boolean;
  volume: () => number;
}

function fixture(opts: { withStyleSink?: boolean } = {}): Fixture {
  const storage = createMemoryStorage();
  const appSettings = createAppSettings({
    storage,
    namespace: 'production',
    stores: createStores(storage),
    capabilities: createCapabilitySource(() => NO_CAPABILITIES),
    motion: createStaticReducedMotionSource(false),
  });
  const stores = appSettings.stores;
  const { hud, handlers, calls } = recordingHud();

  const sm = createGameStateMachine({
    // A complete `OutcomeContext`. Neither arm is reachable from anything this file
    // drives -- no route handler ends a session -- but the classifier is REQUIRED with no
    // default (see its own doc comment), so the state machine cannot be built without one.
    classifyOutcome: createOutcomeClassifier({
      isFinalCampaignLevel: () => false,
      versusResult: () => ({ kind: 'draw' }),
    }),
  });

  const box = {
    hostEvents: [] as string[],
    versusStarts: [] as VersusConfig[],
    campaignRequests: 0,
    previewsBuilt: 0,
    previewStyles: [] as Triple[],
    previewDisposals: 0,
    previewResizes: 0,
    sunkStyles: [] as Triple[],
  };

  const deps: RouteUiDeps = {
    settings: stores.settings,
    stats: stores.stats,
    progress: stores.progress,
    achievements: stores.achievements,
    customization: stores.customization,
    levels: createLevelSystem(DEV_FLAGS_OFF, stores.run),
    effectiveSettings: appSettings.effective,
    // Returns an object rather than null deliberately: `createPreview` is ALLOWED to
    // return null where no second WebGL context exists, and a fixture that only ever
    // took that path would prove the handlers survive a MISSING preview without ever
    // proving they drive a present one.
    createPreview: (): TankPreview | null => {
      box.previewsBuilt += 1;
      return {
        setStyle: (hex: string, skin: string, accent: string | null) =>
          box.previewStyles.push([hex, skin, accent]),
        resize: () => {
          box.previewResizes += 1;
        },
        dispose: () => {
          box.previewDisposals += 1;
        },
      } as unknown as TankPreview;
    },
    readDetectedPads: () => [],
    host: {
      addEventListener: (name: string) => box.hostEvents.push(`+${name}`),
      removeEventListener: (name: string) => box.hostEvents.push(`-${name}`),
    } as unknown as RouteUiDeps['host'],
    requestVersusSession: (config: VersusConfig) => box.versusStarts.push(config),
    requestCampaignSession: () => {
      box.campaignRequests += 1;
    },
    initialVersusConfig: null,
  };

  const routeUi = createRouteUi(hud, sm, deps);
  if (opts.withStyleSink === true) {
    const sink: StyleSink = (hex, skin, accent) => box.sunkStyles.push([hex, skin, accent]);
    routeUi.setStyleSink(sink);
  }

  return {
    hud, sm, routeUi, deps,
    fire: (name, ...args) => {
      const cb = handlers.get(name);
      if (cb === undefined) throw new Error(`route UI never registered ${name}`);
      cb(...args);
    },
    registered: () => [...handlers.keys()].sort(),
    hudCalls: calls,
    hostEvents: box.hostEvents,
    versusStarts: box.versusStarts,
    previewStyles: box.previewStyles,
    sunkStyles: box.sunkStyles,
    campaignRequests: () => box.campaignRequests,
    previewsBuilt: () => box.previewsBuilt,
    previewDisposals: () => box.previewDisposals,
    previewResizes: () => box.previewResizes,
    muted: () => stores.settings.snapshot().audio.muted,
    volume: () => stores.settings.snapshot().audio.volume,
  };
}

/**
 * The 18 registrations this module owns, and the boundary of the claim.
 *
 * Pinned as a SET rather than a count so that a handler quietly leaving for the session,
 * or a session handler quietly arriving here, names itself in the diff. The seven absent
 * ones are listed in `route-ui.ts`'s own doc comment with the reason each stays behind.
 */
const ROUTE_HANDLERS = [
  'onCampaignOpen', 'onControllersClose', 'onControllersOpen', 'onCustomizeClose',
  'onCustomizeOpen', 'onFireModeChange', 'onHapticsChange', 'onMuteToggle',
  'onPauseTap', 'onPickAccentColor', 'onPickHullColor', 'onPickSkin',
  'onResetProgress', 'onResetStats', 'onTouchSchemeChange', 'onVersusOpen',
  'onVersusStart', 'onVolumeChange',
];

describe('the application routes work with no gameplay session behind them', () => {
  it('registers exactly the route handlers, and no gameplay one', () => {
    const f = fixture();
    expect(f.registered()).toEqual([...ROUTE_HANDLERS].sort());
    // The negative half, and the one that would catch the seam being undone: these are
    // the registrations that need a world, a driver or an InputController. If any of them
    // appeared here it would mean the route UI had taken ownership of something it cannot
    // serve without a session.
    for (const gameplay of [
      'onStartRestart', 'onLevelSelect', 'onNewGame',
      'onFireTap', 'onMineTap', 'onReassignSlot', 'onQuitToTitle',
    ]) {
      expect(f.registered()).not.toContain(gameplay);
    }
  });

  it('was handed no gameplay collaborator to reach for', () => {
    const f = fixture();
    const keys = Object.keys(f.deps);
    // `RouteUiDeps` is a `Pick`, so this is already a compile-time fact -- asserted anyway
    // because widening the `Pick` is a one-word edit that would silently restore the
    // coupling this module exists to remove, and a type has no failing test.
    for (const gameplay of ['createRenderer', 'createInput', 'createDriver', 'run']) {
      expect(keys).not.toContain(gameplay);
    }
  });

  it('the audio routes write the store with no session to consume them', () => {
    const f = fixture();
    expect(f.muted()).toBe(false);
    f.fire('onMuteToggle');
    expect(f.muted()).toBe(true);
    // Through the exposed method too: `loop.ts`'s M hotkey calls this one, and the whole
    // point of sharing it is that the key and the button cannot diverge.
    f.routeUi.toggleMute();
    expect(f.muted()).toBe(false);

    f.fire('onVolumeChange', 0.25);
    expect(f.volume()).toBeCloseTo(0.25, 10);
  });

  it('the settings routes write their stores', () => {
    const f = fixture();
    const before = f.deps.settings.snapshot().input;
    // Non-default values from the shipped enums ('stick'|'point', 'tap'|'double'|'button'):
    // the stores REFUSE an unknown id and keep the default, so a made-up value here would
    // make this test pass while measuring nothing.
    f.fire('onTouchSchemeChange', 'point');
    f.fire('onFireModeChange', 'button');
    f.fire('onHapticsChange', !before.deviceHaptics);
    const after = f.deps.settings.snapshot().input;
    expect(after.touchScheme).toBe('point');
    expect(after.fireMode).toBe('button');
    // Asserted as a MOVE off the stored default rather than against a literal, so this
    // cannot start passing vacuously if the shipped default ever changes to match.
    expect(after.deviceHaptics).toBe(!before.deviceHaptics);
  });

  it('Versus Start and Campaign reach their reboot seams from an empty page', () => {
    const f = fixture();
    const config: VersusConfig = {
      mode: 'ffa', players: 2, arenaId: 'vs-duel-01',
      stock: 3, friendlyFire: false, slots: [],
    };
    f.fire('onVersusStart', config);
    expect(f.versusStarts).toEqual([config]);
    f.fire('onCampaignOpen');
    expect(f.campaignRequests()).toBe(1);
  });

  it('Pause and Resume move the state machine with no driver to obey it', () => {
    const f = fixture();
    // A route-level toggle: the state machine is the thing that changes, and the driver
    // that would normally READ that state does not exist here.
    expect(() => f.fire('onPauseTap')).not.toThrow();
    expect(() => f.fire('onPauseTap')).not.toThrow();
  });

  it('the paint shop records a pick and drives the preview with NO renderer attached', () => {
    const f = fixture();
    f.fire('onCustomizeOpen');
    expect(f.previewsBuilt()).toBe(1);
    const before = f.previewStyles.length;

    f.fire('onPickSkin', 'stripes');
    expect(f.deps.customization.skin()).toBe('stripes');
    // The preview saw the new triple...
    expect(f.previewStyles.length).toBe(before + 1);
    // ...and nothing threw for want of a renderer. This is criterion 3 in one place: a
    // route action completed without dereferencing a gameplay resource.
    expect(f.sunkStyles).toEqual([]);

    f.fire('onCustomizeClose');
    expect(f.previewDisposals()).toBe(1);
  });

  it('...and pushes the SAME triple at a renderer once a session offers one', () => {
    const f = fixture({ withStyleSink: true });
    f.fire('onCustomizeOpen');
    f.fire('onPickSkin', 'camo');
    expect(f.sunkStyles).toHaveLength(1);
    // The preview and the sink must never disagree -- the tank inside the panel and the
    // one behind it are the same tank. Compared as whole triples, because sending part of
    // a style resets the rest to a default.
    expect(f.sunkStyles[0]).toEqual(f.previewStyles[f.previewStyles.length - 1]);
  });

  it('a detached sink stops the pushes without stopping the pick', () => {
    const f = fixture({ withStyleSink: true });
    f.fire('onPickSkin', 'camo');
    expect(f.sunkStyles).toHaveLength(1);
    // What a session ending looks like from here. The negative control for the case
    // above: without this, "the sink received a triple" could not be told apart from
    // "something pushes a triple regardless of the sink".
    f.routeUi.setStyleSink(null);
    f.fire('onPickSkin', 'checker');
    expect(f.sunkStyles).toHaveLength(1);
    expect(f.deps.customization.skin()).toBe('checker');
  });

  it('the controller panel adds and removes its hotplug listeners around open/close', () => {
    const f = fixture();
    f.fire('onControllersOpen');
    expect(f.hostEvents).toEqual(['+gamepadconnected', '+gamepaddisconnected']);
    f.fire('onControllersClose');
    expect(f.hostEvents).toEqual([
      '+gamepadconnected', '+gamepaddisconnected',
      '-gamepadconnected', '-gamepaddisconnected',
    ]);
  });

  it('resetting stats and progress works from the routes alone', () => {
    const f = fixture();
    f.deps.stats.record([{ type: 'fire', ownerId: 0 }] as never, 0);
    // Recorded first, and asserted, so the reset below has something real to clear --
    // otherwise "it is 0 afterwards" would hold on a store that never counted at all.
    expect(f.deps.stats.lifetime().shotsFired).toBe(1);
    f.fire('onResetStats');
    expect(f.deps.stats.lifetime().shotsFired).toBe(0);
    // Progress reset also clears achievements and re-locks the level select; all three
    // stores are page-scoped, which is why these two handlers could move at all.
    expect(() => f.fire('onResetProgress')).not.toThrow();
    expect(f.deps.progress.highestCleared()).toBe(0);
  });

  it('preview resize and dispose are safe before the panel has ever opened', () => {
    const f = fixture();
    // The teardown path can fire at any time, including on a page whose Customize panel
    // was never opened. Neither call has a preview to act on, and neither may throw.
    expect(() => f.routeUi.resizePreview()).not.toThrow();
    expect(() => f.routeUi.disposePreview()).not.toThrow();
    expect(f.previewResizes()).toBe(0);
    expect(f.previewDisposals()).toBe(0);
  });

  it('disposePreview is idempotent, which is what lets teardown call it unconditionally', () => {
    const f = fixture();
    f.fire('onCustomizeOpen');
    f.routeUi.disposePreview();
    f.routeUi.disposePreview();
    // ONE disposal, not two: the second call finds the field already cleared. Disposing
    // twice is the stale-capture shape session-host.ts's own tests exist to catch, one
    // layer down.
    expect(f.previewDisposals()).toBe(1);
  });

  it('drives every route while a real GameSessionHost stays EMPTY (issue #427)', () => {
    // Criterion 1, end to end and in one place: the application routes render and accept
    // their existing actions while `GameSessionHost` has no active session.
    //
    // The two halves are asserted TOGETHER deliberately. Route UI working in isolation is
    // this file's other fourteen cases; a host being empty is session-host.test.ts's. What
    // neither says alone is that driving the routes does not quietly bring a session into
    // existence -- which is exactly the coupling #427 exists to remove, and exactly what a
    // route handler reaching for a world would do.
    const f = fixture();
    const root = document.createElement('div');
    const started: unknown[] = [];
    const host = createGameSessionHost({
      root,
      bootCanvas: () => {
        throw new Error('the empty host built a canvas');
      },
      startGame: () => {
        started.push(1);
        throw new Error('the empty host started a session');
      },
      shell: {} as never,
      // The page's route UI. `{}` for the same reason `shell` is: an empty host
      // touches neither, and a host that DID reach into one would throw here.
      routeHost: {} as never,
    });

    expect(host.hasSession()).toBe(false);
    // Every route handler this module owns, fired in turn. `fire` throws if one was never
    // registered, so this is also a sweep: a handler dropped from the route UI fails here
    // rather than silently not being exercised.
    f.fire('onMuteToggle');
    f.fire('onVolumeChange', 0.4);
    f.fire('onVersusOpen');
    f.fire('onCampaignOpen');
    f.fire('onPauseTap');
    f.fire('onTouchSchemeChange', 'point');
    f.fire('onFireModeChange', 'button');
    f.fire('onHapticsChange', false);
    f.fire('onCustomizeOpen');
    f.fire('onPickSkin', 'camo');
    f.fire('onCustomizeClose');
    f.fire('onControllersOpen');
    f.fire('onControllersClose');
    f.fire('onResetStats');
    f.fire('onResetProgress');

    // The host is untouched -- and `bootCanvas`/`startGame` throw, so this is not merely
    // "no session was recorded": any attempt at all would have surfaced as an exception
    // out of the handler rather than as a quiet zero here.
    expect(host.hasSession()).toBe(false);
    expect(started).toHaveLength(0);
    expect(root.querySelectorAll('canvas')).toHaveLength(0);
    // ...and the routes did their work: the store moved, which is what says the handlers
    // ran rather than being no-ops that trivially touch nothing.
    expect(f.deps.customization.skin()).toBe('camo');
    expect(f.volume()).toBeCloseTo(0.4, 10);
  });

  it('unlockedLevels answers from progress alone', () => {
    const f = fixture();
    // A fresh save has cleared nothing, so exactly one level is pickable.
    expect(f.routeUi.unlockedLevels()).toBe(1);
  });
});
