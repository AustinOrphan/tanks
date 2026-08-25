// The page-scoped settings owner (issue #320): one store per document load, the
// at-most-once persistence notice, and the disposal boundary that separates the page
// from the sessions built and torn down beneath it.
import { describe, it, expect } from 'vitest';
import { createAppSettings, createBrowserAppSettings, type AppSettings } from './app-settings';
import { createStores, createMemoryStorage } from './storage';
import {
  NOT_PERSISTED_NOTICE,
  FUTURE_SCHEMA_NOTICE,
  SETTINGS_KEY,
  SETTINGS_SCHEMA_VERSION,
  type SettingsNotice,
} from './settings';
import {
  createCapabilitySource,
  createStaticReducedMotionSource,
  NO_CAPABILITIES,
  type PlatformCapabilities,
  type ReducedMotionSource,
} from './capabilities';

function build(opts: {
  storage?: Storage;
  availability?: 'persistent' | 'memory';
  caps?: Partial<PlatformCapabilities>;
  motion?: ReducedMotionSource;
} = {}): AppSettings {
  const storage = opts.storage ?? createMemoryStorage();
  return createAppSettings({
    storage,
    stores: createStores(storage, opts.availability ?? 'persistent'),
    capabilities: createCapabilitySource(() => ({ ...NO_CAPABILITIES, ...opts.caps })),
    motion: opts.motion ?? createStaticReducedMotionSource(false),
  });
}

/** A real Storage whose setItem throws. Safari private mode. */
function writeDenied(): Storage {
  const real = createMemoryStorage();
  return {
    get length(): number {
      return real.length;
    },
    key: (i: number) => real.key(i),
    getItem: (k: string) => real.getItem(k),
    setItem: () => {
      throw new Error('denied');
    },
    removeItem: (k: string) => real.removeItem(k),
    clear: () => real.clear(),
  };
}

describe('createAppSettings: ownership', () => {
  it('exposes the SAME settings store the stores bundle holds', () => {
    // Identity, not equivalence. Two instances over one storage would each keep their
    // own shadow, and the later write would silently win -- the "two writable sources"
    // hazard issue #320 exists to close.
    const storage = createMemoryStorage();
    const stores = createStores(storage);
    const app = createAppSettings({
      storage,
      stores,
      capabilities: createCapabilitySource(() => NO_CAPABILITIES),
      motion: createStaticReducedMotionSource(false),
    });
    expect(app.settings).toBe(stores.settings);
    expect(app.stores).toBe(stores);
    expect(app.storage).toBe(storage);
  });

  it('resolves the effective values from the store it owns', () => {
    const app = build({ caps: { deviceVibration: true } });
    app.settings.setVolume(0.25);
    app.settings.setDeviceHaptics(true);
    expect(app.effective.current()).toMatchObject({ volume: 0.25, deviceHaptics: true });
  });

  it('keeps values across a stores round trip on the SAME storage', () => {
    // The persistence half of "survives internal session replacement": a second owner
    // over the same storage comes up with what the first wrote.
    const storage = createMemoryStorage();
    const first = build({ storage });
    first.settings.setMuted(true);
    first.settings.setUiScale(150);
    expect(build({ storage }).settings.snapshot()).toMatchObject({
      audio: { muted: true, volume: 0.6 },
      presentation: { motion: 'system', uiScale: 150 },
    });
  });
});

describe('createAppSettings: the persistence notice', () => {
  it('delivers the memory-only notice to the first registrant, immediately', () => {
    const seen: SettingsNotice[] = [];
    build({ availability: 'memory' }).onNotice((n) => seen.push(n));
    expect(seen).toEqual([{ kind: 'not-persisted', message: NOT_PERSISTED_NOTICE }]);
  });

  it('delivers the future-schema notice instead when the payload is from a newer build', () => {
    const storage = createMemoryStorage();
    storage.setItem(SETTINGS_KEY, JSON.stringify({ version: SETTINGS_SCHEMA_VERSION + 1 }));
    const seen: SettingsNotice[] = [];
    build({ storage }).onNotice((n) => seen.push(n));
    expect(seen).toEqual([{ kind: 'future-schema', message: FUTURE_SCHEMA_NOTICE }]);
  });

  it('says NOTHING when storage is healthy', () => {
    const seen: SettingsNotice[] = [];
    const app = build();
    app.onNotice((n) => seen.push(n));
    app.settings.setMuted(true);
    expect(seen).toEqual([]);
  });

  it('stays ARMED for a write failure that is not knowable at boot', () => {
    // Safari private mode: a real `localStorage` whose `setItem` throws. A notice
    // consumed once at boot -- the obvious shape -- would report memory-only and
    // future-schema and silently miss this one entirely.
    const app = build({ storage: writeDenied() });
    const seen: SettingsNotice[] = [];
    app.onNotice((n) => seen.push(n));
    expect(seen).toEqual([]); // nothing has failed yet
    app.settings.setVolume(0.25);
    expect(seen).toEqual([{ kind: 'not-persisted', message: NOT_PERSISTED_NOTICE }]);
  });

  it('fires AT MOST ONCE, however many failures follow', () => {
    const app = build({ storage: writeDenied() });
    const seen: SettingsNotice[] = [];
    app.onNotice((n) => seen.push(n));
    app.settings.setVolume(0.25);
    app.settings.setVolume(0.5);
    app.settings.setMuted(true);
    expect(seen).toHaveLength(1);
  });

  it('says nothing to a registrant that arrives AFTER the notice was delivered', () => {
    // The page-scoped latch. A later session (a versus reboot) must not re-toast a
    // condition the player has already been told about.
    const app = build({ availability: 'memory' });
    app.onNotice(() => {});
    const late: SettingsNotice[] = [];
    app.onNotice((n) => late.push(n));
    expect(late).toEqual([]);
  });

  it('unregisters, so a torn-down session never receives one', () => {
    // The registration holds a session's HUD, and the session is destroyed on every
    // reboot. Without the unregister, a later notice would call showToast on it.
    const app = build({ storage: writeDenied() });
    const dead: SettingsNotice[] = [];
    const off = app.onNotice((n) => dead.push(n));
    off();
    const live: SettingsNotice[] = [];
    app.onNotice((n) => live.push(n));
    app.settings.setVolume(0.25);
    expect(dead).toEqual([]);
    expect(live).toHaveLength(1);
  });

  it('does not deliver anything after dispose', () => {
    const app = build({ storage: writeDenied() });
    const seen: SettingsNotice[] = [];
    app.onNotice((n) => seen.push(n));
    app.dispose();
    app.settings.setVolume(0.25);
    expect(seen).toEqual([]);
  });
});

describe('createAppSettings: disposal', () => {
  it('disposes the effective handle, releasing the OS motion listener', () => {
    let disposed = 0;
    const motion: ReducedMotionSource = {
      matches: () => false,
      subscribe: () => () => {},
      dispose: () => {
        disposed += 1;
      },
    };
    build({ motion }).dispose();
    expect(disposed).toBe(1);
  });

  it('is idempotent', () => {
    const app = build();
    app.dispose();
    expect(() => app.dispose()).not.toThrow();
  });
});

describe('createBrowserAppSettings', () => {
  it('builds a working owner against the real environment', () => {
    // The one unpinned line in the chain, exercised once so a throw inside it -- a
    // capability probe reaching a hostile global, say -- cannot go unnoticed until it
    // reaches a browser. Runs under the node environment, where there is no
    // localStorage and no matchMedia, which is exactly the degraded path.
    const app = createBrowserAppSettings();
    expect(app.settings.snapshot()).toEqual(app.stores.settings.snapshot());
    expect(app.effective.current().reducedMotion).toBe(false);
    app.settings.setMuted(true);
    expect(app.settings.snapshot().audio.muted).toBe(true);
    app.dispose();
  });
});
