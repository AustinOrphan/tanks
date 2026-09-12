import { describe, it, expect } from 'vitest';
import {
  settingRelevance,
  isOffered,
  RUMBLE_UNAVAILABLE_REASON,
  type RelevanceSettingId,
  type Relevance,
} from './control-relevance';
import { NO_CAPABILITIES, type PlatformCapabilities } from './capabilities';
import { keyHint, type Modality } from './modality';
import { createStores, createMemoryStorage } from './storage';
import { createEffectiveSettings } from './effective-settings';
import { createCapabilitySource, createStaticReducedMotionSource } from './capabilities';

const caps = (over: Partial<PlatformCapabilities> = {}): PlatformCapabilities => ({
  ...NO_CAPABILITIES,
  ...over,
});

/**
 * THE DEVICE MATRIX the issue asks for: "every supported device/input combination has an
 * explicit expected settings-and-prompt result."
 *
 * Capabilities and a modality in, a control set and a prompt out — no user-agent string
 * anywhere, which is the issue's other criterion and the reason this is a table of plain
 * objects rather than a browser fixture.
 *
 * The two rows that share capabilities (`desktop-pad` and `tv-controller`) are the point of
 * pairing settings with prompts in ONE table: the same hardware answers the settings
 * question identically and the prompt question differently, so a table of settings alone
 * could not tell them apart, and neither could a table of prompts alone.
 */
interface DeviceProfile {
  readonly name: string;
  readonly capabilities: PlatformCapabilities;
  readonly modality: Modality | null;
  /** Every setting put on screen, refused or not, in id order. */
  readonly offered: RelevanceSettingId[];
  /** Settings on screen but refused, with the reason shown. */
  readonly refused: RelevanceSettingId[];
  /** What `Mute` reads as — the transient half. */
  readonly muteHint: string;
}

const PROFILES: DeviceProfile[] = [
  {
    name: 'desktop keyboard and mouse',
    capabilities: caps(),
    modality: 'keyboard',
    offered: ['controllerRumble'],
    refused: ['controllerRumble'],
    muteHint: ' (M)',
  },
  {
    name: 'phone, touch with a vibration motor',
    capabilities: caps({ touch: true, deviceVibration: true }),
    modality: 'touch',
    offered: ['touchScheme', 'fireMode', 'deviceHaptics', 'controllerRumble'],
    refused: ['controllerRumble'],
    muteHint: '',
  },
  {
    name: 'tablet, touch with NO navigator.vibrate',
    // Not hypothetical: Safari on iPadOS has touch and no `navigator.vibrate` at all, so a
    // haptics toggle there is a control that can never do anything.
    capabilities: caps({ touch: true }),
    modality: 'touch',
    offered: ['touchScheme', 'fireMode', 'controllerRumble'],
    refused: ['controllerRumble'],
    muteHint: '',
  },
  {
    name: 'desktop with a rumble pad connected',
    capabilities: caps({ controllerRumble: true }),
    modality: 'pointer',
    offered: ['controllerRumble'],
    refused: [],
    muteHint: ' (M)',
  },
  {
    name: 'TV with a controller — the same hardware, a different hand on it',
    capabilities: caps({ controllerRumble: true }),
    modality: 'gamepad',
    offered: ['controllerRumble'],
    refused: [],
    // No pad button is bound to mute, so naming one would instruct a player to press
    // something inert (modality.ts). The hint is empty rather than wrong.
    muteHint: '',
  },
  {
    name: 'hybrid touch laptop with a rumble pad',
    capabilities: caps({ touch: true, controllerRumble: true }),
    modality: 'keyboard',
    offered: ['touchScheme', 'fireMode', 'controllerRumble'],
    refused: [],
    muteHint: ' (M)',
  },
  {
    name: 'before the first input, on a phone',
    capabilities: caps({ touch: true, deviceVibration: true }),
    modality: null,
    offered: ['touchScheme', 'fireMode', 'deviceHaptics', 'controllerRumble'],
    refused: ['controllerRumble'],
    // `null` keeps the shipped keyboard hint, which is what an untouched page shows.
    muteHint: ' (M)',
  },
];

const ALL: RelevanceSettingId[] = ['touchScheme', 'fireMode', 'deviceHaptics', 'controllerRumble'];
const order = (ids: RelevanceSettingId[]): RelevanceSettingId[] =>
  ALL.filter((id) => ids.includes(id));

describe('the device matrix (issue #227)', () => {
  for (const profile of PROFILES) {
    it(`${profile.name}: offers the right controls and the right prompt`, () => {
      const verdicts = settingRelevance(profile.capabilities);
      expect(order(ALL.filter((id) => isOffered(verdicts[id])))).toEqual(order(profile.offered));
      expect(
        order(ALL.filter((id) => verdicts[id].kind === 'unavailable')),
        'shown-but-refused',
      ).toEqual(order(profile.refused));
      expect(keyHint(profile.modality, 'M', null)).toBe(profile.muteHint);
    });
  }

  it('covers a profile for every capability combination that changes the answer', () => {
    // Non-vacuity with a stated population: the three capability booleans give 8 combinations,
    // and the matrix above uses 5 of them (none; touch; touch+vibration; rumble;
    // touch+rumble). The 3 unused ones differ from a used one only in `deviceVibration`,
    // whose verdict this asserts is independent of the other two -- so they would assert
    // nothing a listed row does not. Asserted rather than claimed:
    const combos: PlatformCapabilities[] = [];
    for (const touch of [false, true])
      for (const deviceVibration of [false, true])
        for (const controllerRumble of [false, true])
          combos.push({ touch, deviceVibration, controllerRumble });
    expect(combos).toHaveLength(8);
    for (const c of combos) {
      const v = settingRelevance(c);
      expect(v.deviceHaptics.kind).toBe(c.deviceVibration ? 'shown' : 'omitted');
      expect(v.touchScheme.kind).toBe(c.touch ? 'shown' : 'omitted');
      expect(v.controllerRumble.kind).toBe(c.controllerRumble ? 'shown' : 'unavailable');
    }
    const used = new Set(PROFILES.map((p) => JSON.stringify(p.capabilities)));
    expect(used.size, 'distinct capability sets exercised by the matrix').toBe(5);
  });
});

describe('settingRelevance', () => {
  it('omits a STABLE absence and explains a TRANSIENT one', () => {
    // The rule the two acceptance criteria pull against each other over. A desktop browser
    // does not grow a touchscreen, so "Aim scheme: unavailable, connect a touchscreen" is
    // clutter that never resolves; a pad is plugged in all the time, so a rumble toggle that
    // vanished would appear from nowhere on hotplug.
    const desktop = settingRelevance(caps());
    expect(desktop.touchScheme).toEqual({ kind: 'omitted' });
    expect(desktop.deviceHaptics).toEqual({ kind: 'omitted' });
    expect(desktop.controllerRumble).toEqual({
      kind: 'unavailable',
      reason: RUMBLE_UNAVAILABLE_REASON,
    });
  });

  it('names the action that fixes it, rather than only stating the refusal', () => {
    // A reason a player cannot act on is a worse control than no reason at all -- it says
    // "no" and stops. This is the assertion that would fail if the copy were reduced to
    // "Rumble unavailable".
    expect(RUMBLE_UNAVAILABLE_REASON).toMatch(/Connect one/);
    expect(RUMBLE_UNAVAILABLE_REASON).toMatch(/connected controller/);
  });

  it('treats the two touch controls as one question, never one without the other', () => {
    // Aim scheme and fire mode are both properties of the aim thumb. A device offered one
    // and not the other would present a fire gesture for a thumb it has already said is not
    // there.
    for (const touch of [false, true]) {
      const v = settingRelevance(caps({ touch }));
      expect(v.touchScheme).toEqual(v.fireMode);
    }
  });

  it('returns a verdict for all four settings on every call', () => {
    // A partial record is how a control gets hidden once and never restored: the caller
    // applies the whole set each push, so a missing key is a control left in whatever state
    // the last device put it in.
    for (const c of [caps(), caps({ touch: true, deviceVibration: true, controllerRumble: true })]) {
      expect(Object.keys(settingRelevance(c)).sort()).toEqual([...ALL].sort());
    }
  });
});

describe('the contract with effective-settings.ts', () => {
  it('OMITS a touch control without changing what the touch settings resolve to', () => {
    // The two halves of one contract, stated in the source at both ends: capabilities.ts
    // says "which controls to SHOW from this is issue #227", and effective-settings.ts says
    // touch scheme and fire mode are deliberately NOT gated on `capabilities.touch`, because
    // gating them would silently rewrite a hybrid device's working settings.
    //
    // This is the assertion that stops the next reader "simplifying" the two into one gate:
    // visibility moves and resolution does not.
    const store = createStores(createMemoryStorage()).settings;
    store.setTouchScheme('stick');
    const effective = createEffectiveSettings({
      store,
      capabilities: createCapabilitySource(() => caps()),
      motion: createStaticReducedMotionSource(false),
    });
    expect(settingRelevance(caps()).touchScheme).toEqual({ kind: 'omitted' });
    expect(effective.current().touchScheme, 'the stored scheme must survive the hiding').toBe(
      'stick',
    );
    expect(store.snapshot().input.touchScheme).toBe('stick');
  });

  it('the same for rumble: refusing the CONTROL is not turning the preference off', () => {
    // A refused control still edits a live preference. If relevance and resolution were the
    // same switch, unplugging a pad would read as the player having turned rumble off, and
    // plugging it back in would not restore it.
    const store = createStores(createMemoryStorage()).settings;
    expect(store.snapshot().input.controllerRumble).toBe(true);
    expect(settingRelevance(caps()).controllerRumble.kind).toBe('unavailable');
    expect(store.snapshot().input.controllerRumble, 'the stored preference is untouched').toBe(
      true,
    );
  });
});

describe('isOffered', () => {
  it('counts a refused control as on screen, and only an omitted one as gone', () => {
    // The distinction the section-collapse rule reads: a refused control still occupies its
    // section, so a section holding only refused controls must NOT collapse and take its
    // explanation with it.
    expect(isOffered({ kind: 'shown' })).toBe(true);
    expect(isOffered({ kind: 'unavailable', reason: 'x' } as Relevance)).toBe(true);
    expect(isOffered({ kind: 'omitted' })).toBe(false);
  });
});
