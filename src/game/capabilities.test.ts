// The platform capability probes and the one reduced-motion source (issue #320). Every
// probe is feature detection through an injected host -- there is no user-agent string
// anywhere in this file, and there must not be one in the module it covers.
import { describe, it, expect, vi } from 'vitest';
import {
  detectCapabilities,
  createCapabilitySource,
  createMediaReducedMotionSource,
  createStaticReducedMotionSource,
  NO_CAPABILITIES,
  REDUCED_MOTION_QUERY,
  type CapabilityHost,
  type CapabilityPadLike,
  type MediaQueryListLike,
  type PlatformCapabilities,
} from './capabilities';

function padsHost(pads: Array<CapabilityPadLike | null>): CapabilityHost {
  return { navigator: { getGamepads: () => pads } };
}

describe('detectCapabilities: device vibration', () => {
  it('is true only when navigator.vibrate is a FUNCTION', () => {
    // Population: the four shapes a host can present -- a function, a truthy non-
    // function (an older polyfill leaving a property behind), undefined, and no
    // navigator at all. A bare property read would accept the second and then throw
    // when haptics.ts tried to call it.
    expect(detectCapabilities({ navigator: { vibrate: () => true } }).deviceVibration).toBe(true);
    expect(detectCapabilities({ navigator: { vibrate: true } }).deviceVibration).toBe(false);
    expect(detectCapabilities({ navigator: {} }).deviceVibration).toBe(false);
    expect(detectCapabilities({}).deviceVibration).toBe(false);
  });

  it('survives a host whose navigator ACCESS throws', () => {
    const host = {
      get navigator(): never {
        throw new Error('SecurityError');
      },
    } as unknown as CapabilityHost;
    expect(() => detectCapabilities(host)).not.toThrow();
    expect(detectCapabilities(host)).toEqual(NO_CAPABILITIES);
  });
});

describe('detectCapabilities: controller rumble', () => {
  it('is true when a connected pad exposes a callable vibrationActuator.playEffect', () => {
    expect(detectCapabilities(padsHost([{ vibrationActuator: { playEffect: () => {} } }])).controllerRumble).toBe(true);
  });

  it('accepts the older non-empty hapticActuators array too', () => {
    expect(detectCapabilities(padsHost([{ hapticActuators: [{}] }])).controllerRumble).toBe(true);
    expect(detectCapabilities(padsHost([{ hapticActuators: [] }])).controllerRumble).toBe(false);
  });

  it('is false for a pad with no actuator, a null slot, or an empty list', () => {
    // Population: the four negative shapes -- a pad with neither field, a pad whose
    // actuator has no callable playEffect, a null slot (getGamepads is sparse), and no
    // pads at all.
    expect(detectCapabilities(padsHost([{}])).controllerRumble).toBe(false);
    expect(detectCapabilities(padsHost([{ vibrationActuator: { playEffect: 'yes' } }])).controllerRumble).toBe(false);
    expect(detectCapabilities(padsHost([null])).controllerRumble).toBe(false);
    expect(detectCapabilities(padsHost([])).controllerRumble).toBe(false);
  });

  it('scans PAST an empty slot to a later pad that can rumble', () => {
    // Real `getGamepads()` arrays are sparse and index-stable, so the rumbling pad is
    // very often not at index 0. A loop that answered from index 0 alone would report
    // no rumble for a perfectly capable device.
    expect(
      detectCapabilities(padsHost([null, {}, { vibrationActuator: { playEffect: () => {} } }])).controllerRumble,
    ).toBe(true);
  });

  it('is NOT satisfied by navigator.vibrate, and does not satisfy device vibration either', () => {
    // The conflation issue #320 forbids. A phone with `navigator.vibrate` and no pad has
    // device vibration and NO controller rumble; a desktop pad with an actuator and no
    // `navigator.vibrate` has the reverse. Routing rumble through `navigator.vibrate`
    // would buzz the phone instead of the controller.
    const phone = detectCapabilities({ navigator: { vibrate: () => true, getGamepads: () => [] } });
    expect(phone).toMatchObject({ deviceVibration: true, controllerRumble: false });

    const desktopPad = detectCapabilities({
      navigator: { getGamepads: () => [{ vibrationActuator: { playEffect: () => {} } }] },
    });
    expect(desktopPad).toMatchObject({ deviceVibration: false, controllerRumble: true });
  });

  it('tolerates a getGamepads that THROWS, exactly as readDetectedPads does', () => {
    const host: CapabilityHost = {
      navigator: {
        getGamepads: () => {
          throw new Error('nope');
        },
      },
    };
    expect(() => detectCapabilities(host)).not.toThrow();
    expect(detectCapabilities(host).controllerRumble).toBe(false);
  });

  it('calls getGamepads with navigator as its receiver', () => {
    // Chromium's native method throws "Illegal invocation" when called detached from
    // its navigator -- the same trap haptics.ts's `resolveVibrate` binds around.
    let receiver: unknown = null;
    const navigator = {
      getGamepads(this: unknown): CapabilityPadLike[] {
        receiver = this;
        return [];
      },
    };
    detectCapabilities({ navigator });
    expect(receiver).toBe(navigator);
  });

  it('returns only booleans -- no index, no device identity', () => {
    // Issue #320: exact gamepad indices and connected device identity must never be
    // persisted. The cheapest structural guarantee is that they never leave this module.
    const caps = detectCapabilities(
      padsHost([null, { vibrationActuator: { playEffect: () => {} } }]),
    );
    expect(Object.keys(caps).sort()).toEqual(['controllerRumble', 'deviceVibration', 'touch']);
    for (const v of Object.values(caps)) expect(typeof v).toBe('boolean');
  });
});

describe('detectCapabilities: touch', () => {
  it('accepts either the ontouchstart key or a positive maxTouchPoints', () => {
    expect(detectCapabilities({ ontouchstart: null }).touch).toBe(true);
    expect(detectCapabilities({ navigator: { maxTouchPoints: 5 } }).touch).toBe(true);
    expect(detectCapabilities({ navigator: { maxTouchPoints: 0 } }).touch).toBe(false);
    expect(detectCapabilities({ navigator: { maxTouchPoints: 'lots' } }).touch).toBe(false);
    expect(detectCapabilities({ navigator: {} }).touch).toBe(false);
  });
});

describe('createCapabilitySource', () => {
  it('probes once at construction and hands that snapshot back', () => {
    let probes = 0;
    const source = createCapabilitySource(() => {
      probes += 1;
      return NO_CAPABILITIES;
    });
    source.snapshot();
    source.snapshot();
    expect(probes).toBe(1);
  });

  it('publishes a real change on refresh, and nothing when the probe is unchanged', () => {
    // The no-op guard is not cosmetic: loop.ts calls refresh() from its pad hotplug
    // edge detection, and a notification per call would push identical effective
    // settings through every consumer on every controller event.
    let caps: PlatformCapabilities = { ...NO_CAPABILITIES };
    const source = createCapabilitySource(() => caps);
    const seen: PlatformCapabilities[] = [];
    source.subscribe((c) => seen.push(c));

    source.refresh();
    expect(seen).toEqual([]);

    caps = { ...caps, controllerRumble: true };
    source.refresh();
    expect(seen).toHaveLength(1);
    expect(source.snapshot().controllerRumble).toBe(true);

    source.refresh();
    expect(seen).toHaveLength(1); // same value, no second publish
  });

  it('stops publishing after unsubscribe', () => {
    let caps: PlatformCapabilities = { ...NO_CAPABILITIES };
    const source = createCapabilitySource(() => caps);
    let calls = 0;
    const off = source.subscribe(() => {
      calls += 1;
    });
    caps = { ...caps, touch: true };
    source.refresh();
    off();
    caps = { ...caps, deviceVibration: true };
    source.refresh();
    expect(calls).toBe(1);
  });
});

describe('createMediaReducedMotionSource', () => {
  function fakeQuery(initial: boolean): {
    list: MediaQueryListLike;
    emit(matches: boolean): void;
    listeners: number;
  } {
    const cbs = new Set<(e: { matches: boolean }) => void>();
    const state = { matches: initial };
    const list: MediaQueryListLike = {
      get matches(): boolean {
        return state.matches;
      },
      addEventListener: (_t, cb) => {
        cbs.add(cb);
      },
      removeEventListener: (_t, cb) => {
        cbs.delete(cb);
      },
    };
    return {
      list,
      get listeners(): number {
        return cbs.size;
      },
      emit(matches: boolean): void {
        state.matches = matches;
        for (const cb of [...cbs]) cb({ matches });
      },
    };
  }

  it('asks the platform for the reduced-motion query, by its exact string', () => {
    const asked: string[] = [];
    createMediaReducedMotionSource({
      matchMedia: (q) => {
        asked.push(q);
        return fakeQuery(false).list;
      },
    });
    expect(asked).toEqual([REDUCED_MOTION_QUERY]);
    expect(REDUCED_MOTION_QUERY).toBe('(prefers-reduced-motion: reduce)');
  });

  it('reports the initial match and REACTS while the page is open', () => {
    // The requirement System mode exists for: the OS preference can change mid-session,
    // and a value read once at boot would never notice.
    const q = fakeQuery(false);
    const source = createMediaReducedMotionSource({ matchMedia: () => q.list });
    const seen: boolean[] = [];
    source.subscribe((m) => seen.push(m));

    expect(source.matches()).toBe(false);
    q.emit(true);
    expect(seen).toEqual([true]);
    expect(source.matches()).toBe(true);
    q.emit(false);
    expect(seen).toEqual([true, false]);
  });

  it('ignores a change event that does not actually change the value', () => {
    const q = fakeQuery(true);
    const source = createMediaReducedMotionSource({ matchMedia: () => q.list });
    const seen: boolean[] = [];
    source.subscribe((m) => seen.push(m));
    q.emit(true);
    expect(seen).toEqual([]);
  });

  it('attaches EXACTLY ONE platform listener however many subscribers there are', () => {
    const q = fakeQuery(false);
    const source = createMediaReducedMotionSource({ matchMedia: () => q.list });
    source.subscribe(() => {});
    source.subscribe(() => {});
    source.subscribe(() => {});
    expect(q.listeners).toBe(1);
    source.dispose();
    expect(q.listeners).toBe(0);
  });

  it('removes the platform listener on dispose, and stops publishing', () => {
    const q = fakeQuery(false);
    const source = createMediaReducedMotionSource({ matchMedia: () => q.list });
    const seen: boolean[] = [];
    source.subscribe((m) => seen.push(m));
    source.dispose();
    expect(q.listeners).toBe(0);
    q.emit(true);
    expect(seen).toEqual([]);
  });

  it('is idempotent on dispose', () => {
    const q = fakeQuery(false);
    const source = createMediaReducedMotionSource({ matchMedia: () => q.list });
    source.dispose();
    expect(() => source.dispose()).not.toThrow();
    expect(q.listeners).toBe(0);
  });

  it('falls back to the legacy addListener/removeListener pair', () => {
    // Older WebKit, which the game targets seriously. Without this branch the source
    // would report the initial value forever and never react.
    const cbs = new Set<(e: { matches: boolean }) => void>();
    const state = { matches: false };
    const list = {
      get matches(): boolean {
        return state.matches;
      },
      addListener: (cb: (e: { matches: boolean }) => void) => {
        cbs.add(cb);
      },
      removeListener: (cb: (e: { matches: boolean }) => void) => {
        cbs.delete(cb);
      },
    } as MediaQueryListLike;
    const source = createMediaReducedMotionSource({ matchMedia: () => list });
    const seen: boolean[] = [];
    source.subscribe((m) => seen.push(m));
    state.matches = true;
    for (const cb of [...cbs]) cb({ matches: true });
    expect(seen).toEqual([true]);
    source.dispose();
    expect(cbs.size).toBe(0);
  });

  it('degrades to a static false source when matchMedia is absent or throws', () => {
    // Population: the three hostile hosts -- no matchMedia (jsdom), a matchMedia that
    // returns null, and one whose call throws. None may take the game down.
    for (const host of [
      {},
      { matchMedia: () => null },
      {
        matchMedia: (): MediaQueryListLike => {
          throw new Error('nope');
        },
      },
    ]) {
      const source = createMediaReducedMotionSource(host);
      expect(source.matches()).toBe(false);
      expect(() => source.dispose()).not.toThrow();
    }
  });

  it('survives a removeEventListener that throws at dispose', () => {
    const source = createMediaReducedMotionSource({
      matchMedia: () =>
        ({
          matches: false,
          addEventListener: () => {},
          removeEventListener: () => {
            throw new Error('nope');
          },
        }) as MediaQueryListLike,
    });
    const cb = vi.fn();
    source.subscribe(cb);
    expect(() => source.dispose()).not.toThrow();
  });
});

describe('createStaticReducedMotionSource', () => {
  it('reports its fixed value and never publishes', () => {
    const source = createStaticReducedMotionSource(true);
    const seen: boolean[] = [];
    source.subscribe((m) => seen.push(m));
    expect(source.matches()).toBe(true);
    expect(seen).toEqual([]);
    expect(createStaticReducedMotionSource().matches()).toBe(false);
  });
});
