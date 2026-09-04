import type { TouchScheme, FireMode } from '../input/touch';
import type { PlayerSettings, UiScale, PlayerSettingsStore, QualityPreset } from './settings';
import type { PlatformCapabilities, CapabilitySource, ReducedMotionSource } from './capabilities';

/**
 * The one layer that turns "what the player asked for" plus "what this device can do"
 * into "what a consumer should actually apply" (issue #320).
 *
 * Consumers read THIS, never the store and never `matchMedia`. That is the whole point:
 * the reduced-motion policy, the two haptics gates and the UI scale each have exactly one
 * derivation, in one testable pure function, instead of a rule per consumer.
 *
 * ## The effective rules
 *
 * | Effective value | Rule |
 * | --- | --- |
 * | `muted`, `volume` | the stored preference. Audio has no capability gate: every platform that can play can also be silent. |
 * | `touchScheme`, `fireMode` | the stored preference, UNGATED. See the note below. |
 * | `deviceHaptics` | stored `deviceHaptics` AND `capabilities.deviceVibration`. |
 * | `controllerRumble` | stored `controllerRumble` AND `capabilities.controllerRumble`. |
 * | `reducedMotion` | `'system'` follows the OS; `'full'` is always false; `'reduced'` is always true. |
 * | `uiScale` | the stored preference. |
 * | `quality` | the stored preference, UNGATED. Nothing here probes the GPU -- see below. |
 *
 * Touch scheme and fire mode are deliberately NOT gated on `capabilities.touch`. Gating
 * them would mean a hybrid device -- a laptop with a touchscreen, a tablet with a
 * keyboard -- silently ran on something other than the player's saved choice whenever the
 * probe answered differently, and it would pre-empt issue #227, which owns whether the
 * CONTROL is shown at all. A setting nobody can reach is a visibility question, not an
 * effective-value one.
 *
 * Render quality (issue #540) has no capability half to gate on: `capabilities.ts` reports
 * what a platform CAN do, and "how fast is this GPU" is not a question it asks -- deciding
 * a preset from a device probe is issue #113's deferred measurement spike, and until it
 * runs the player's choice is the only answer there is. `?dev=1&quality=` overrides that
 * choice, and does it in `loop.ts` where the renderer is built, not here: this function
 * takes a store, a capability set and an OS preference, and a URL is none of the three.
 *
 * Neither gate ERASES anything. `capabilities.deviceVibration` going false makes the
 * effective value false while the stored `true` sits untouched, so unplugging and
 * replugging a pad restores rumble without the player touching Settings.
 */
export interface EffectiveSettings {
  readonly muted: boolean;
  readonly volume: number;
  readonly touchScheme: TouchScheme;
  readonly fireMode: FireMode;
  /** Device vibration: enabled AND supported. haptics.ts's off switch. */
  readonly deviceHaptics: boolean;
  /** Controller rumble: enabled AND a connected pad has an actuator. Never `navigator.vibrate`. */
  readonly controllerRumble: boolean;
  /** The resolved reduced-motion/flash policy. The only reduced-motion answer in the game. */
  readonly reducedMotion: boolean;
  readonly uiScale: UiScale;
  /** `uiScale` as a multiplier -- 100 -> 1, 125 -> 1.25. The form #290/#321 will multiply by. */
  readonly uiScaleFactor: number;
  /**
   * Which render-quality preset a new session should build with. A `QualityPreset` id, not
   * a `RenderQuality` table: resolving the id to the table is `render/quality.ts`'s job and
   * nothing in the game layer may name that type.
   */
  readonly quality: QualityPreset;
}

/**
 * PURE, and exported on purpose: every rule above is decided here and nowhere else, so a
 * test can sweep the whole cross-product without building a store, a capability probe or
 * a media query.
 */
export function resolveEffectiveSettings(
  settings: PlayerSettings,
  capabilities: PlatformCapabilities,
  systemReducedMotion: boolean,
): EffectiveSettings {
  const motion = settings.presentation.motion;
  return Object.freeze({
    muted: settings.audio.muted,
    volume: settings.audio.volume,
    touchScheme: settings.input.touchScheme,
    fireMode: settings.input.fireMode,
    deviceHaptics: settings.input.deviceHaptics && capabilities.deviceVibration,
    controllerRumble: settings.input.controllerRumble && capabilities.controllerRumble,
    reducedMotion: motion === 'system' ? systemReducedMotion : motion === 'reduced',
    uiScale: settings.presentation.uiScale,
    uiScaleFactor: settings.presentation.uiScale / 100,
    quality: settings.presentation.quality,
  });
}

export interface EffectiveSettingsHandle {
  current(): EffectiveSettings;
  /** The capability half, for a consumer that must distinguish "off" from "unavailable". */
  capabilities(): PlatformCapabilities;
  /**
   * Fired whenever any INPUT changes -- a stored preference, a capability, or the OS
   * motion preference. Returns an unsubscribe.
   *
   * Deliberately not filtered on the resolved value changing. Each of the three sources
   * already filters its own notifications (the store publishes only accepted changes,
   * `CapabilitySource.refresh` only real ones, the media source only on a flipped match),
   * so a second filter here would add nothing except one specific silent hole: toggling
   * device haptics on a device with no vibration motor leaves every effective value
   * identical, and the control that EDITS that preference still has to redraw.
   */
  subscribe(cb: (e: EffectiveSettings) => void): () => void;
  /** Re-probe capabilities; see `CapabilitySource.refresh`. */
  refreshCapabilities(): void;
  /**
   * Detach from the store, the capability source and the OS media query.
   *
   * PAGE-scoped, not session-scoped. `startGameWith`'s teardown must NOT call this: the
   * game handle is rebuilt on every campaign/versus reboot (boot.ts), and disposing here
   * would leave the next session with a dead motion subscription and settings that stop
   * updating after one navigation. boot.ts's `pagehide` teardown owns this call.
   */
  dispose(): void;
}

export interface EffectiveSettingsDeps {
  readonly store: PlayerSettingsStore;
  readonly capabilities: CapabilitySource;
  readonly motion: ReducedMotionSource;
}

export function createEffectiveSettings(deps: EffectiveSettingsDeps): EffectiveSettingsHandle {
  const compute = (): EffectiveSettings =>
    resolveEffectiveSettings(
      deps.store.snapshot(),
      deps.capabilities.snapshot(),
      deps.motion.matches(),
    );

  const listeners = new Set<(e: EffectiveSettings) => void>();

  const republish = (): void => {
    const next = compute();
    for (const cb of [...listeners]) cb(next);
  };

  // Three inputs, three subscriptions, all released together in dispose().
  const unsubscribes = [
    deps.store.subscribe(republish),
    deps.capabilities.subscribe(republish),
    deps.motion.subscribe(republish),
  ];
  let disposed = false;

  return {
    current: compute,
    capabilities: () => deps.capabilities.snapshot(),
    subscribe(cb): () => void {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    refreshCapabilities(): void {
      deps.capabilities.refresh();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const off of unsubscribes) off();
      listeners.clear();
      deps.motion.dispose();
    },
  };
}
