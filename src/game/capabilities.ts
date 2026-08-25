/**
 * What the CURRENT device can actually deliver, and what the OS is currently asking for
 * (issue #320).
 *
 * Kept strictly apart from settings.ts, which owns what the PLAYER asked for. A stored
 * preference for a capability this device lacks is not an error and is never erased --
 * effective-settings.ts combines the two, and the preference becomes effective again the
 * moment the capability appears.
 *
 * Everything here is FEATURE DETECTION, never user-agent sniffing: `navigator.vibrate`
 * being a function, a connected pad exposing a rumble actuator, a positive
 * `maxTouchPoints`. Every probe is injected through a host object so a test can drive
 * each branch without a device, and every one is wrapped in try/catch, because a
 * locked-down context can make the property ACCESS itself throw (the case storage.ts's
 * `resolveStorage` exists for).
 *
 * "Capability exists" is deliberately NOT "this was the last active input". A desktop
 * with a pad plugged in has controller-rumble capability while the player is on the
 * keyboard; issue #227 owns which controls to SHOW from last-active input, and it must
 * read that from somewhere other than this file.
 *
 * Nothing here persists. No gamepad index, no device id, no player/controller assignment
 * ever reaches storage -- the only thing that leaves this module is booleans.
 */

export interface PlatformCapabilities {
  /** `navigator.vibrate` exists: the phone/tablet buzz haptics.ts drives. */
  readonly deviceVibration: boolean;
  /**
   * At least one CONNECTED pad exposes a rumble actuator.
   *
   * A separate capability from `deviceVibration`, not a synonym: Chrome on Android has
   * `navigator.vibrate` and usually no pad; Chrome on a desktop with an Xbox pad has a
   * `vibrationActuator` and, in Firefox/Safari, no `navigator.vibrate` at all (see
   * haptics.ts's own note on the real support split). Routing rumble through
   * `navigator.vibrate` would buzz the phone instead of the controller, which is why the
   * two are detected, stored and resolved independently end to end.
   */
  readonly controllerRumble: boolean;
  /**
   * The device reports touch input.
   *
   * Detected because issue #320 asks for the source to exist and be feature-detected.
   * Deliberately consumed by NOTHING today: the effective touch scheme and fire mode are
   * the stored preference regardless, because gating them would silently rewrite a
   * hybrid device's working settings. Which controls to SHOW from this is issue #227.
   */
  readonly touch: boolean;
}

export const NO_CAPABILITIES: PlatformCapabilities = Object.freeze({
  deviceVibration: false,
  controllerRumble: false,
  touch: false,
});

/** The rumble surface of a real `Gamepad`, reduced to what detection touches. */
export interface RumbleActuatorLike {
  readonly playEffect?: unknown;
}

export interface CapabilityPadLike {
  /** The modern, standardised actuator. `playEffect` being callable is the real test. */
  readonly vibrationActuator?: RumbleActuatorLike | null;
  /** The older array form some builds still expose. Non-empty is the test. */
  readonly hapticActuators?: ArrayLike<unknown> | null;
}

/** Only what detection needs from the global object, so a test can hand over a fake. */
export interface CapabilityHost {
  readonly navigator?: {
    readonly vibrate?: unknown;
    readonly maxTouchPoints?: unknown;
    readonly getGamepads?: () => ArrayLike<CapabilityPadLike | null | undefined>;
  };
  /** Present on touch-capable browsers. Read as a KEY, never called. */
  readonly ontouchstart?: unknown;
}

function detectDeviceVibration(host: CapabilityHost): boolean {
  try {
    return typeof host.navigator?.vibrate === 'function';
  } catch {
    return false;
  }
}

/**
 * True when a CONNECTED pad can rumble.
 *
 * Reads `getGamepads()` fresh rather than caching a pad: a `Gamepad` snapshot goes stale,
 * and holding one would be a step toward the durable controller identity issue #320
 * forbids. Only the boolean leaves this function -- not which index answered.
 */
function detectControllerRumble(host: CapabilityHost): boolean {
  let pads: ArrayLike<CapabilityPadLike | null | undefined>;
  try {
    const get = host.navigator?.getGamepads;
    if (typeof get !== 'function') return false;
    pads = get.call(host.navigator) ?? [];
  } catch {
    // Tolerate a throwing implementation, exactly as readDetectedPads does.
    return false;
  }
  try {
    for (let i = 0; i < pads.length; i++) {
      const pad = pads[i];
      if (pad == null) continue;
      if (typeof pad.vibrationActuator?.playEffect === 'function') return true;
      const legacy = pad.hapticActuators;
      if (legacy != null && legacy.length > 0) return true;
    }
  } catch {
    return false;
  }
  return false;
}

function detectTouch(host: CapabilityHost): boolean {
  try {
    if ('ontouchstart' in (host as object)) return true;
    const points = host.navigator?.maxTouchPoints;
    return typeof points === 'number' && points > 0;
  } catch {
    return false;
  }
}

export function detectCapabilities(
  host: CapabilityHost = globalThis as unknown as CapabilityHost,
): PlatformCapabilities {
  return Object.freeze({
    deviceVibration: detectDeviceVibration(host),
    controllerRumble: detectControllerRumble(host),
    touch: detectTouch(host),
  });
}

export interface CapabilitySource {
  snapshot(): PlatformCapabilities;
  /**
   * Re-probe the platform and publish any change.
   *
   * Exists because the boot snapshot is not permanently correct: plugging in a pad adds
   * controller-rumble capability mid-session. Cheap on purpose (three property reads and
   * one `getGamepads()` scan), so the caller can hang it off an event it already handles
   * -- loop.ts calls it from the pad connect/disconnect detection it already runs for
   * the controllers panel, rather than adding a listener with its own disposal surface.
   */
  refresh(): PlatformCapabilities;
  subscribe(cb: (c: PlatformCapabilities) => void): () => void;
}

function sameCapabilities(a: PlatformCapabilities, b: PlatformCapabilities): boolean {
  return (
    a.deviceVibration === b.deviceVibration &&
    a.controllerRumble === b.controllerRumble &&
    a.touch === b.touch
  );
}

/**
 * @param probe Called once at construction and on every `refresh()`. Injected rather than
 * calling `detectCapabilities` directly so a test can move a capability without a device.
 */
export function createCapabilitySource(
  probe: () => PlatformCapabilities = () => detectCapabilities(),
): CapabilitySource {
  let current = probe();
  const listeners = new Set<(c: PlatformCapabilities) => void>();
  return {
    snapshot: () => current,
    refresh(): PlatformCapabilities {
      const next = probe();
      // Only a real change notifies: refresh() is called from a hotplug path that also
      // fires for changes this module cannot see, and a no-op notification would push
      // identical effective settings through every consumer on every pad event.
      if (!sameCapabilities(current, next)) {
        current = next;
        for (const cb of [...listeners]) cb(current);
      }
      return current;
    },
    subscribe(cb): () => void {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}

/**
 * The ONE place JavaScript asks the OS about reduced motion.
 *
 * `render/preview.ts` used to call `window.matchMedia('(prefers-reduced-motion: reduce)')`
 * inline, read once per preview, with no player override and no subscription. Issue #320
 * requires that the System motion state REACT while the page is open, so this is a live
 * source with explicit disposal, and consumers are forbidden from querying `matchMedia`
 * themselves -- they read the effective value (effective-settings.ts) instead.
 */
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

export interface MediaQueryListLike {
  readonly matches: boolean;
  addEventListener?: (type: 'change', cb: (e: { matches: boolean }) => void) => void;
  removeEventListener?: (type: 'change', cb: (e: { matches: boolean }) => void) => void;
  /** Safari < 14 and older WebKit. Kept because the game targets WebKit seriously. */
  addListener?: (cb: (e: { matches: boolean }) => void) => void;
  removeListener?: (cb: (e: { matches: boolean }) => void) => void;
}

export interface MediaQueryHost {
  readonly matchMedia?: (query: string) => MediaQueryListLike | null | undefined;
}

export interface ReducedMotionSource {
  matches(): boolean;
  subscribe(cb: (matches: boolean) => void): () => void;
  /** Detach from the platform. Idempotent; safe to call without any subscriber. */
  dispose(): void;
}

/**
 * A source that never changes -- for tests, for tools, and for a host with no
 * `matchMedia` at all (jsdom does not implement it).
 */
export function createStaticReducedMotionSource(matches = false): ReducedMotionSource {
  return {
    matches: () => matches,
    subscribe: () => () => {},
    dispose: () => {},
  };
}

export function createMediaReducedMotionSource(
  host: MediaQueryHost = globalThis as unknown as MediaQueryHost,
): ReducedMotionSource {
  let list: MediaQueryListLike | null = null;
  try {
    list = host.matchMedia?.(REDUCED_MOTION_QUERY) ?? null;
  } catch {
    list = null;
  }
  if (!list) return createStaticReducedMotionSource(false);
  const query = list;

  let current = query.matches === true;
  let disposed = false;
  const listeners = new Set<(matches: boolean) => void>();

  const onChange = (e: { matches: boolean }): void => {
    const next = e.matches === true;
    if (next === current) return;
    current = next;
    for (const cb of [...listeners]) cb(current);
  };

  // Attached ONCE, at construction, not per subscriber: the platform listener is this
  // module's own resource and `dispose()` is what removes it. One registration also means
  // `matches()` stays correct for a caller that never subscribes.
  let detach: () => void = () => {};
  if (typeof query.addEventListener === 'function') {
    query.addEventListener('change', onChange);
    detach = () => query.removeEventListener?.('change', onChange);
  } else if (typeof query.addListener === 'function') {
    query.addListener(onChange);
    detach = () => query.removeListener?.(onChange);
  }

  return {
    matches: () => current,
    subscribe(cb): () => void {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      try {
        detach();
      } catch {
        // A host that throws on removal cannot be helped; the listener set is already
        // empty, so nothing this module owns can still fire a callback.
      }
    },
  };
}
