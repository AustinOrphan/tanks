import { describe, it, expect } from 'vitest';
import {
  STANDARD_PROFILE,
  PROFILE_CATALOGUE,
  classifyPad,
  profileFor,
  profileCollisions,
  profileRequirements,
  validateProfileCatalogue,
  type ControlProfile,
  type ProfileEntry,
} from './gamepad-profile';
import { GAMEPAD_FIRE_BUTTON, GAMEPAD_MINE_BUTTON, type GamepadLike } from './gamepad';
import { MENU_CONFIRM_BUTTON, MENU_BACK_BUTTON, MENU_PAUSE_BUTTON } from './gamepad-menu';

/**
 * The four fixtures issue #596 asks for, as plain data -- which is the whole reason
 * `classifyPad` is pure. None of these needs jsdom, a browser, or hardware.
 */

/** A browser-remapped Xbox pad: the shape `tools/screens/run.mjs`'s `mixed` fixture ships. */
function standardPad(overrides: Partial<GamepadLike> = {}): GamepadLike {
  return {
    id: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 02fd)',
    mapping: 'standard',
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
    ...overrides,
  };
}

/**
 * A pad the browser has NOT remapped, taken from the same `mixed` fixture: a HuiJia adapter
 * reporting no mapping, six axes and twelve buttons. Using the repository's own existing
 * statement about what a non-standard pad looks like, rather than inventing a second one
 * that could describe a different device.
 */
function unmappedPad(overrides: Partial<GamepadLike> = {}): GamepadLike {
  return {
    id: 'HuiJia  USB GamePad',
    mapping: '',
    axes: [0, 0, 0, 0, 0, 0],
    buttons: Array.from({ length: 12 }, () => ({ pressed: false, value: 0 })),
    ...overrides,
  };
}

/**
 * A catalogue entry for that pad, used ONLY here.
 *
 * Said plainly because it is the honest residual of this change: the shipped catalogue is
 * empty, so the `profile` verdict has no production entry behind it yet. Issue #606 owns the
 * first one and issue #595 owns the hardware measurement it has to rest on -- a profile is a
 * claim about a physical device's layout, and this repository has not measured one. What
 * ships here is the mechanism, and this fixture is what proves the mechanism works rather
 * than proving anything about a HuiJia adapter. The indices below are therefore arbitrary
 * but INTERNALLY VALID: distinct, in range for six axes and twelve buttons, and free of the
 * #494 gameplay/menu collision.
 */
const FIXTURE_PROFILE: ControlProfile = {
  id: 'fixture-six-axis',
  label: 'Test fixture: a six-axis pad reporting no mapping',
  axes: { moveX: 0, moveY: 1, aimX: 4, aimY: 5 },
  buttons: { fire: 6, mine: 7, confirm: 0, back: 1, pause: 8, up: 2, down: 3, left: 4, right: 5 },
};

const FIXTURE_CATALOGUE: readonly ProfileEntry[] = [
  { match: { mapping: '', idIncludes: 'huijia', axes: 6, buttons: 12 }, profile: FIXTURE_PROFILE },
];

describe('the standard profile is the one copy of the standard indices', () => {
  it('is what gamepad.ts and gamepad-menu.ts export, so the two files cannot drift from it', () => {
    // The DERIVATION guard, and the reason this assertion is not circular: before issue #596
    // those five constants were five literals in two files, and `poll()` read the literals.
    // They are now derived from the record below and `poll()` reads the record. If anyone
    // re-inlines a number -- which is the natural thing to do when adding a sixth binding --
    // this fails, because the profile the reader actually uses and the constant the tests
    // press through would have become two different numbers.
    expect(GAMEPAD_FIRE_BUTTON).toBe(STANDARD_PROFILE.buttons.fire);
    expect(GAMEPAD_MINE_BUTTON).toBe(STANDARD_PROFILE.buttons.mine);
    expect(MENU_CONFIRM_BUTTON).toBe(STANDARD_PROFILE.buttons.confirm);
    expect(MENU_BACK_BUTTON).toBe(STANDARD_PROFILE.buttons.back);
    expect(MENU_PAUSE_BUTTON).toBe(STANDARD_PROFILE.buttons.pause);
  });

  it('still names the shipped standard layout, index by index', () => {
    // Pinned as VALUES, not just as "whatever the two files agree on": the test above would
    // pass if every number moved together, and these eleven are the Gamepad API's standard
    // mapping rather than a choice this repository is free to make. A change here is a
    // change to what a standard pad does, and owes its own reasoning.
    expect(STANDARD_PROFILE.axes).toEqual({ moveX: 0, moveY: 1, aimX: 2, aimY: 3 });
    expect(STANDARD_PROFILE.buttons).toEqual({
      fire: 7,
      mine: 6,
      confirm: 0,
      back: 1,
      pause: 9,
      up: 12,
      down: 13,
      left: 14,
      right: 15,
    });
  });

  it('never puts a menu action on a gameplay button, which is issue #494 stated as a rule', () => {
    // #494 was Confirm and Fire being the same button: confirming Resume with A, still held
    // on the first simulated tick, read as a fresh fire press and leaked a shell. The fix
    // moved fire to the trigger, and the fact that the sets are now disjoint has lived in a
    // comment ever since. This is that comment as a check -- and it is the check that a
    // catalogue profile has to pass too (`validateProfileCatalogue` below), so the rule
    // covers layouts nobody has written yet.
    expect(profileCollisions(STANDARD_PROFILE)).toEqual([]);
  });

  it('requires exactly the axes and buttons its own highest index names', () => {
    // Derived, so it cannot disagree with the indices above it: aim sits on axis 3 and the
    // D-pad ends at button 15, so 4 and 16. A 17-button Xbox pad clears it; a 12-button one
    // does not, which is the `insufficient` case below.
    expect(profileRequirements(STANDARD_PROFILE)).toEqual({ axes: 4, buttons: 16 });
  });
});

describe('classifyPad: the four verdicts', () => {
  it('reads a browser-remapped pad as standard, and hands back the standard profile', () => {
    const support = classifyPad(standardPad());
    expect(support.kind).toBe('standard');
    expect(profileFor(support)).toBe(STANDARD_PROFILE);
  });

  it('reads a catalogued non-standard pad as a recognized profile, NOT as standard', () => {
    // Both halves matter. `profile` rather than `unknown` is the mechanism working; `profile`
    // rather than `standard` is the distinction a compatibility report needs -- "the browser
    // remapped this" and "we recognized it ourselves" are different facts about a device.
    const support = classifyPad(unmappedPad(), FIXTURE_CATALOGUE);
    expect(support.kind).toBe('profile');
    expect(profileFor(support)).toBe(FIXTURE_PROFILE);
  });

  it('refuses a pad no catalogue entry matches, and says what the browser reported', () => {
    // THE DEFECT THIS ISSUE IS ABOUT. Before #596 this pad was read with the standard
    // indices: axis 0 as the left stick, button 7 as fire. On a device whose layout those
    // indices get wrong that is not "no input" -- it is input the game cannot tell from a
    // player's hands. The verdict carries the browser's own `mapping` and `id` verbatim so a
    // diagnostic (and issue #597's player-facing copy) has something to say beyond "no".
    const support = classifyPad(unmappedPad());
    expect(support).toEqual({
      kind: 'unknown',
      reason: { code: 'unknown-mapping', mapping: '', id: 'HuiJia  USB GamePad' },
    });
    // `profileFor` is the ONE way a caller asks "may I read this pad", and it is what both
    // readers call. An `isSupported` convenience sat here in an earlier draft with no
    // production caller at all -- the same dead-export shape `gamepad.ts`'s comment about a
    // returned-but-unused "just connected" edge records, and removed for the same reason.
    expect(profileFor(support)).toBeNull();
  });

  it('refuses a recognized pad that lacks the controls its profile names, and counts both sides', () => {
    // A SEPARATE verdict from `unknown`, because a separate thing went wrong: recognition
    // succeeded and the hardware fell short. A browser really does report `mapping:
    // 'standard'` for a device with fewer controls than the standard layout has.
    const support = classifyPad(standardPad({ buttons: [{ pressed: false }] }));
    expect(support).toEqual({
      kind: 'insufficient',
      reason: {
        code: 'insufficient-controls',
        profileId: 'standard',
        axes: 4,
        buttons: 1,
        requiredAxes: 4,
        requiredButtons: 16,
      },
    });
    expect(profileFor(support)).toBeNull();
  });

  it('applies the same shortfall test to a catalogued profile, not only to the standard one', () => {
    // The negative control for "insufficient is a property of the PROFILE, not a hardcoded
    // 4-and-16": this pad has four axes, which is plenty for the standard layout and one
    // short of the fixture profile's aim stick on axis 5.
    const support = classifyPad(unmappedPad({ axes: [0, 0, 0, 0] }), [
      { match: { idIncludes: 'huijia' }, profile: FIXTURE_PROFILE },
    ]);
    expect(support.kind).toBe('insufficient');
    expect(support.kind === 'insufficient' ? support.reason : null).toMatchObject({
      profileId: 'fixture-six-axis',
      axes: 4,
      requiredAxes: 6,
    });
  });
});

describe('classifyPad: how a pad is matched', () => {
  it("lets the browser's own 'standard' win over a catalogue entry that would also match", () => {
    // THE ORDER CONTRACT, and the thing that keeps "standard-mapped controllers retain
    // current behavior" true no matter what issue #606 later adds: a catalogue entry cannot
    // capture a pad the browser has already remapped, even one written to match it exactly.
    const greedy: ProfileEntry[] = [{ match: { idIncludes: 'xbox' }, profile: FIXTURE_PROFILE }];
    const support = classifyPad(standardPad(), greedy);
    expect(support.kind).toBe('standard');
    expect(profileFor(support)).toBe(STANDARD_PROFILE);
  });

  it('requires EVERY present matcher field, so a near-miss is not a match', () => {
    // Each of these differs from the fixture entry in exactly one field, and each must fall
    // through to `unknown`. A matcher that ORed its fields would pass three of the four.
    const near: GamepadLike[] = [
      unmappedPad({ mapping: 'xr-standard' }),
      unmappedPad({ id: 'Some Other Pad' }),
      unmappedPad({ axes: [0, 0, 0, 0, 0] }),
      unmappedPad({ buttons: Array.from({ length: 11 }, () => ({ pressed: false })) }),
    ];
    for (const pad of near) {
      expect(classifyPad(pad, FIXTURE_CATALOGUE).kind, `${pad.id} / ${pad.mapping}`).toBe('unknown');
    }
    // ...and the unaltered pad still matches, so the four above failed on their one
    // difference rather than on something the fixture got wrong.
    expect(classifyPad(unmappedPad(), FIXTURE_CATALOGUE).kind).toBe('profile');
  });

  it('matches an id case-insensitively, because browsers do not agree on case', () => {
    // Issue #606 asks for "robust browser-reported characteristics, avoiding brittle exact-id
    // matching". Case is the cheapest way that brittleness shows up: the same adapter reads
    // `HuiJia` in one browser and `HUIJIA` in another.
    expect(classifyPad(unmappedPad({ id: 'HUIJIA  USB GAMEPAD' }), FIXTURE_CATALOGUE).kind).toBe('profile');
  });

  it('treats a pad with no mapping field at all as one reporting none', () => {
    // `GamepadLike.mapping` is optional so that fakes written before it existed still
    // type-check. `undefined` must therefore mean the same as `''` -- if it meant "assume
    // standard", every such fake would be privileged over real hardware, and the refusal
    // this module exists for would be untested by construction.
    const support = classifyPad({ axes: [0, 0, 0, 0], buttons: [], id: 'No Mapping Field' });
    expect(support).toEqual({
      kind: 'unknown',
      reason: { code: 'unknown-mapping', mapping: '', id: 'No Mapping Field' },
    });
  });

  it('reports an absent id as the empty string rather than inventing one', () => {
    const support = classifyPad({ axes: [], buttons: [] });
    expect(support.kind === 'unknown' ? support.reason : null).toEqual({
      code: 'unknown-mapping',
      mapping: '',
      id: '',
    });
  });
});

describe('validateProfileCatalogue refuses a catalogue that cannot mean what it says', () => {
  const entry = (overrides: Partial<ProfileEntry> = {}): ProfileEntry => ({
    match: { idIncludes: 'x' },
    profile: FIXTURE_PROFILE,
    ...overrides,
  });

  it('accepts the shipped catalogue', () => {
    // Vacuous TODAY and stated as such: the shipped catalogue is empty until issue #606 adds
    // the first entry, so this asserts that an empty catalogue is legal and nothing more. It
    // is here so that the FIRST entry is validated the moment it lands, rather than after
    // someone remembers to add a check.
    expect(() => validateProfileCatalogue(PROFILE_CATALOGUE)).not.toThrow();
    expect(PROFILE_CATALOGUE).toHaveLength(0);
  });

  it('refuses an empty matcher, which would swallow every unknown pad', () => {
    // The worst failure mode a catalogue has: one entry with no criteria matches the FIRST
    // pad it sees, so every unrecognized device silently acquires someone else's layout --
    // reintroducing exactly the defect this module removes, from the other direction.
    expect(() => validateProfileCatalogue([entry({ match: {} })])).toThrow(/empty matcher/);
  });

  it('refuses a duplicate profile id, so a trace cannot name two layouts', () => {
    expect(() => validateProfileCatalogue([entry(), entry()])).toThrow(/duplicate profile id/);
  });

  it('refuses an entry that redefines the built-in standard profile', () => {
    expect(() =>
      validateProfileCatalogue([entry({ profile: { ...FIXTURE_PROFILE, id: 'standard' } })]),
    ).toThrow(/standard profile/);
  });

  it('refuses an empty profile id', () => {
    expect(() => validateProfileCatalogue([entry({ profile: { ...FIXTURE_PROFILE, id: '' } })])).toThrow(
      /empty profile id/,
    );
  });

  it('refuses a profile that puts confirm on the fire button, naming the pair', () => {
    // THE #494 REGRESSION, caught at authoring time. A pad with few buttons is exactly where
    // a catalogue author is tempted to double one up, and the consequence is not obvious from
    // the profile record: Confirm is held across Resume, and the first simulated tick reads
    // it as a fresh fire press.
    const collided: ControlProfile = {
      ...FIXTURE_PROFILE,
      buttons: { ...FIXTURE_PROFILE.buttons, confirm: FIXTURE_PROFILE.buttons.fire },
    };
    expect(() => validateProfileCatalogue([entry({ profile: collided })])).toThrow(/fire\/confirm/);
    expect(() => validateProfileCatalogue([entry({ profile: collided })])).toThrow(/#494/);
  });

  it('names every colliding pair, not just the first', () => {
    const collided: ControlProfile = {
      ...FIXTURE_PROFILE,
      buttons: {
        ...FIXTURE_PROFILE.buttons,
        confirm: FIXTURE_PROFILE.buttons.fire,
        back: FIXTURE_PROFILE.buttons.mine,
      },
    };
    expect(profileCollisions(collided).sort()).toEqual(['fire/confirm', 'mine/back']);
  });
});
