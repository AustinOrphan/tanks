// The stored-versus-effective boundary (issue #320): which settings a capability gates,
// which it deliberately does not, how the three motion states resolve, and that a gate
// closing never erases what the player asked for.
import { describe, it, expect } from 'vitest';
import {
  resolveEffectiveSettings,
  createEffectiveSettings,
  type EffectiveSettings,
} from './effective-settings';
import {
  createPlayerSettingsStore,
  DEFAULT_SETTINGS,
  DEFAULT_VOLUME,
  MOTION_PREFERENCES,
  QUALITY_PRESET_IDS,
  UI_SCALES,
  type PlayerSettings,
} from './settings';
import {
  createCapabilitySource,
  createStaticReducedMotionSource,
  NO_CAPABILITIES,
  type PlatformCapabilities,
  type ReducedMotionSource,
} from './capabilities';
import { createMemoryStorage } from './storage';

const ALL_CAPABILITIES: PlatformCapabilities = Object.freeze({
  deviceVibration: true,
  controllerRumble: true,
  touch: true,
});

function settings(overrides: Partial<PlayerSettings> = {}): PlayerSettings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

describe('resolveEffectiveSettings: audio, UI scale and quality pass through ungated', () => {
  it('takes mute and volume straight from the stored preference', () => {
    // No capability gate: every platform that can play can also be silent, so an
    // effective mute that disagreed with the stored one could only ever be a bug.
    const stored = settings({ audio: { muted: true, volume: 0.25 } });
    for (const caps of [ALL_CAPABILITIES, NO_CAPABILITIES]) {
      const eff = resolveEffectiveSettings(stored, caps, false);
      expect(eff.muted).toBe(true);
      expect(eff.volume).toBe(0.25);
    }
  });

  it('passes the render-quality preset straight through, on any capability set', () => {
    // Issue #540. Quality is the second ungated closed-list preference (after touch scheme
    // and fire mode), and it is ungated because there is nothing to gate it ON:
    // `capabilities.ts` reports what a platform CAN do and never asks how fast its GPU is.
    // Population: all QUALITY_PRESET_IDS x both capability sets = 6 combinations.
    for (const quality of QUALITY_PRESET_IDS) {
      for (const caps of [ALL_CAPABILITIES, NO_CAPABILITIES]) {
        const eff = resolveEffectiveSettings(
          settings({ presentation: { ...DEFAULT_SETTINGS.presentation, quality } }),
          caps,
          false,
        );
        expect(eff.quality, quality).toBe(quality);
      }
    }
    // NEGATIVE CONTROL: two of the three swept values are NOT the shipped default, so a
    // resolver that answered with a constant would have to disagree above rather than
    // coincide -- and this states which constant it would have answered with.
    expect(DEFAULT_SETTINGS.presentation.quality).toBe('high');
    expect(QUALITY_PRESET_IDS).toContain('low');
  });

  it('reports UI scale as both the preset and a multiplier', () => {
    // Population: all UI_SCALES. The factor is what #290/#321 will multiply tokens by,
    // and 100 -> 1 exactly is the property that keeps the default a no-op.
    for (const uiScale of UI_SCALES) {
      const eff = resolveEffectiveSettings(
        settings({ presentation: { ...DEFAULT_SETTINGS.presentation, uiScale } }),
        ALL_CAPABILITIES,
        false,
      );
      expect(eff.uiScale, String(uiScale)).toBe(uiScale);
      expect(eff.uiScaleFactor, String(uiScale)).toBeCloseTo(uiScale / 100, 10);
    }
    expect(
      resolveEffectiveSettings(DEFAULT_SETTINGS, ALL_CAPABILITIES, false).uiScaleFactor,
    ).toBe(1);
  });
});

describe('resolveEffectiveSettings: the two haptics gates are INDEPENDENT', () => {
  it('sweeps the full stored x capability cross-product for device haptics', () => {
    // Population: 2 stored values x 2 capability values = all 4 combinations. Effective
    // is the AND, and only the AND.
    for (const stored of [true, false]) {
      for (const capable of [true, false]) {
        const eff = resolveEffectiveSettings(
          settings({ input: { ...DEFAULT_SETTINGS.input, deviceHaptics: stored } }),
          { ...ALL_CAPABILITIES, deviceVibration: capable },
          false,
        );
        expect(eff.deviceHaptics, `${stored}/${capable}`).toBe(stored && capable);
      }
    }
  });

  it('sweeps the same cross-product for controller rumble', () => {
    for (const stored of [true, false]) {
      for (const capable of [true, false]) {
        const eff = resolveEffectiveSettings(
          settings({ input: { ...DEFAULT_SETTINGS.input, controllerRumble: stored } }),
          { ...ALL_CAPABILITIES, controllerRumble: capable },
          false,
        );
        expect(eff.controllerRumble, `${stored}/${capable}`).toBe(stored && capable);
      }
    }
  });

  it('gates each on its OWN capability, never the other', () => {
    // The conflation issue #320 forbids, stated as a discriminating fixture: both
    // preferences on, exactly one capability present, in each direction. A resolver
    // that read one capability for both would get one of these two rows wrong.
    const bothOn = settings({
      input: { ...DEFAULT_SETTINGS.input, deviceHaptics: true, controllerRumble: true },
    });
    const phone = resolveEffectiveSettings(
      bothOn,
      { ...ALL_CAPABILITIES, deviceVibration: true, controllerRumble: false },
      false,
    );
    expect(phone).toMatchObject({ deviceHaptics: true, controllerRumble: false });

    const desktopPad = resolveEffectiveSettings(
      bothOn,
      { ...ALL_CAPABILITIES, deviceVibration: false, controllerRumble: true },
      false,
    );
    expect(desktopPad).toMatchObject({ deviceHaptics: false, controllerRumble: true });
  });

  it('does NOT gate touch scheme or fire mode on touch capability', () => {
    // Deliberate: gating them would silently rewrite a hybrid device's saved choice,
    // and WHETHER TO SHOW the control is issue #227's question, not this one's.
    const stored = settings({
      input: { ...DEFAULT_SETTINGS.input, touchScheme: 'point', fireMode: 'button' },
    });
    for (const touch of [true, false]) {
      const eff = resolveEffectiveSettings(stored, { ...NO_CAPABILITIES, touch }, false);
      expect(eff.touchScheme, String(touch)).toBe('point');
      expect(eff.fireMode, String(touch)).toBe('button');
    }
  });
});

describe('resolveEffectiveSettings: the three motion states', () => {
  it('resolves each state against both OS answers', () => {
    // Population: all 3 MOTION_PREFERENCES x both OS values = 6 rows, which is the
    // complete contract. `system` is the only row that moves with the OS.
    const rows: Array<[(typeof MOTION_PREFERENCES)[number], boolean, boolean]> = [
      ['system', false, false],
      ['system', true, true],
      ['full', false, false],
      ['full', true, false],
      ['reduced', false, true],
      ['reduced', true, true],
    ];
    expect(rows.map((r) => r[0])).toEqual(
      MOTION_PREFERENCES.flatMap((m) => [m, m]),
    );
    for (const [motion, os, expected] of rows) {
      const eff = resolveEffectiveSettings(
        settings({ presentation: { ...DEFAULT_SETTINGS.presentation, motion } }),
        ALL_CAPABILITIES,
        os,
      );
      expect(eff.reducedMotion, `${motion} with OS ${os}`).toBe(expected);
    }
  });

  it('defaults to System, so an untouched install follows the OS', () => {
    expect(resolveEffectiveSettings(DEFAULT_SETTINGS, ALL_CAPABILITIES, true).reducedMotion).toBe(true);
    expect(resolveEffectiveSettings(DEFAULT_SETTINGS, ALL_CAPABILITIES, false).reducedMotion).toBe(false);
  });
});

describe('createEffectiveSettings', () => {
  function harness(opts: { caps?: Partial<PlatformCapabilities>; motion?: ReducedMotionSource } = {}): {
    store: ReturnType<typeof createPlayerSettingsStore>;
    handle: ReturnType<typeof createEffectiveSettings>;
    setCaps(next: Partial<PlatformCapabilities>): void;
  } {
    let caps: PlatformCapabilities = { ...ALL_CAPABILITIES, ...opts.caps };
    const store = createPlayerSettingsStore(createMemoryStorage());
    const capabilities = createCapabilitySource(() => caps);
    const handle = createEffectiveSettings({
      store,
      capabilities,
      motion: opts.motion ?? createStaticReducedMotionSource(false),
    });
    return {
      store,
      handle,
      setCaps(next): void {
        caps = { ...caps, ...next };
        capabilities.refresh();
      },
    };
  }

  it('starts from the store and the capability snapshot', () => {
    const h = harness({ caps: { deviceVibration: false } });
    expect(h.handle.current()).toMatchObject({
      volume: DEFAULT_VOLUME,
      deviceHaptics: false,
      controllerRumble: true,
    });
  });

  it('republishes when a stored preference changes', () => {
    const h = harness();
    const seen: EffectiveSettings[] = [];
    h.handle.subscribe((e) => seen.push(e));
    h.store.setVolume(0.25);
    expect(seen.map((e) => e.volume)).toEqual([0.25]);
  });

  it('republishes a preference change even when the RESOLVED value cannot move', () => {
    // The hole a change-filtered subscription would leave: on a device with no
    // vibration motor, toggling device haptics leaves every effective value identical --
    // and the control that edits it still has to redraw. loop.ts's single subscription
    // depends on this.
    const h = harness({ caps: { deviceVibration: false } });
    let calls = 0;
    h.handle.subscribe(() => {
      calls += 1;
    });
    h.store.setDeviceHaptics(false);
    expect(calls).toBe(1);
    expect(h.handle.current().deviceHaptics).toBe(false);
  });

  it('republishes when a CAPABILITY appears, without the player touching anything', () => {
    // Plugging in a controller. The stored preference was true the whole time; only the
    // effective value moved.
    const h = harness({ caps: { controllerRumble: false } });
    const seen: boolean[] = [];
    h.handle.subscribe((e) => seen.push(e.controllerRumble));
    expect(h.handle.current().controllerRumble).toBe(false);
    h.setCaps({ controllerRumble: true });
    expect(seen).toEqual([true]);
    expect(h.handle.current().controllerRumble).toBe(true);
  });

  it('never ERASES the stored preference when a capability disappears', () => {
    // Issue #320's explicit requirement: unplugging must not rewrite what the player
    // asked for, so replugging restores the behaviour with no visit to Settings.
    const h = harness();
    h.store.setControllerRumble(true);
    h.setCaps({ controllerRumble: false });
    expect(h.handle.current().controllerRumble).toBe(false);
    expect(h.store.snapshot().input.controllerRumble).toBe(true); // untouched
    h.setCaps({ controllerRumble: true });
    expect(h.handle.current().controllerRumble).toBe(true);
  });

  it('reacts to a LIVE OS motion change under System', () => {
    // The requirement System mode exists for. Uses a source that really publishes,
    // rather than re-reading a value, so a handle that never subscribed would fail.
    const listeners = new Set<(m: boolean) => void>();
    let matches = false;
    const motion: ReducedMotionSource = {
      matches: () => matches,
      subscribe(cb) {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
      dispose(): void {
        listeners.clear();
      },
    };
    const h = harness({ motion });
    const seen: boolean[] = [];
    h.handle.subscribe((e) => seen.push(e.reducedMotion));
    expect(h.handle.current().reducedMotion).toBe(false);

    matches = true;
    for (const cb of [...listeners]) cb(true);
    expect(seen).toEqual([true]);
    expect(h.handle.current().reducedMotion).toBe(true);
  });

  it('ignores a live OS change once the player has chosen Full effects', () => {
    // The override half. Without it "System" would be the only state that existed.
    const listeners = new Set<(m: boolean) => void>();
    let matches = false;
    const motion: ReducedMotionSource = {
      matches: () => matches,
      subscribe(cb) {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
      dispose(): void {
        listeners.clear();
      },
    };
    const h = harness({ motion });
    h.store.setMotion('full');
    matches = true;
    for (const cb of [...listeners]) cb(true);
    expect(h.handle.current().reducedMotion).toBe(false);
  });

  it('exposes the capability snapshot, so a consumer can tell OFF from UNAVAILABLE', () => {
    const h = harness({ caps: { deviceVibration: false } });
    expect(h.handle.capabilities().deviceVibration).toBe(false);
    h.setCaps({ deviceVibration: true });
    expect(h.handle.capabilities().deviceVibration).toBe(true);
  });

  it('refreshCapabilities re-probes and publishes', () => {
    let caps: PlatformCapabilities = { ...NO_CAPABILITIES };
    const store = createPlayerSettingsStore(createMemoryStorage());
    const handle = createEffectiveSettings({
      store,
      capabilities: createCapabilitySource(() => caps),
      motion: createStaticReducedMotionSource(false),
    });
    const seen: boolean[] = [];
    handle.subscribe((e) => seen.push(e.controllerRumble));
    caps = { ...caps, controllerRumble: true };
    handle.refreshCapabilities();
    expect(seen).toEqual([true]);
  });

  it('releases every subscription on dispose, and disposes the motion source', () => {
    // The leak check. Three inputs, and any one left attached keeps a whole session's
    // closures alive across every later navigation.
    let disposedMotion = 0;
    const motionListeners = new Set<(m: boolean) => void>();
    const motion: ReducedMotionSource = {
      matches: () => false,
      subscribe(cb) {
        motionListeners.add(cb);
        return () => motionListeners.delete(cb);
      },
      dispose(): void {
        disposedMotion += 1;
        motionListeners.clear();
      },
    };
    let caps: PlatformCapabilities = { ...ALL_CAPABILITIES };
    const store = createPlayerSettingsStore(createMemoryStorage());
    const capabilities = createCapabilitySource(() => caps);
    const handle = createEffectiveSettings({ store, capabilities, motion });
    let calls = 0;
    handle.subscribe(() => {
      calls += 1;
    });

    handle.dispose();
    expect(disposedMotion).toBe(1);
    expect(motionListeners.size).toBe(0);

    store.setVolume(0.1);
    caps = { ...caps, touch: false };
    capabilities.refresh();
    expect(calls).toBe(0);
  });

  it('is idempotent on dispose', () => {
    const h = harness();
    h.handle.dispose();
    expect(() => h.handle.dispose()).not.toThrow();
  });
});
