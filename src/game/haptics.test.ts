// The haptics seam: a fourth event consumer alongside render, particles and audio
// (see CLAUDE.md's "Render and audio are one-way projections"). The vibrate function
// itself is injected -- see resolveVibrate -- so this file never touches `navigator`.
import { describe, it, expect } from 'vitest';
import {
  createHapticsDirector,
  resolveVibrate,
  FIRE_PULSE_MS,
  DESTROYED_PATTERN_MS,
  MINE_NEAR_PULSE_MS,
  MINE_FUSE_WARN_PULSE_MS,
  MINE_TRIP_PATTERN_MS,
  MINE_DANGER_RADIUS,
  type VibrateFn,
  BLOCKED_FIRE_PATTERN_MS,
  BLOCKED_FIRE_TAP_PULSE_MS,
  BLOCKED_FIRE_DOUBLE_PATTERN_MS,
  BLOCKED_FIRE_LONG_PULSE_MS,
  BLOCKED_FIRE_RISE_PATTERN_MS,
} from './haptics';
import type { SimEvent } from '../sim/events';
import { BLOCKED_FIRE_CUES, type BlockedFireCue } from '../presentation/blocked-fire';

/** Records every call, and always reports success -- a fake device that never refuses. */
function fakeVibrate(): { vibrate: VibrateFn; calls: Array<number | number[]> } {
  const calls: Array<number | number[]> = [];
  return {
    calls,
    vibrate(pattern) {
      calls.push(pattern);
      return true;
    },
  };
}

const PLAYER_ID = 7;
const ENEMY_ID = 8;

/** The cues whose name carries the `haptic` channel -- issue #516's haptic column. */
type HapticArm = 'haptic' | 'haptic-tap' | 'haptic-double' | 'haptic-long' | 'haptic-rise' | 'haptic-audio';

function fireEvent(ownerId: number): SimEvent {
  return { type: 'fire', ownerId, bulletType: 'normal', pos: { x: 1, y: 2 }, angle: 0 };
}

function destroyedEvent(kind: 'player' | 'grey', tankId: number): SimEvent {
  return {
    type: 'tank-destroyed',
    tankId,
    kind,
    by: { source: 'shell', ownerId: ENEMY_ID },
    pos: { x: 3, y: 4 },
  };
}

function mineDetonateEvent(pos: { x: number; y: number }): SimEvent {
  return { type: 'mine-detonate', mineId: 1, ownerId: ENEMY_ID, pos };
}

function warnEvent(type: 'mine-triggered' | 'mine-fuse-warning', pos: { x: number; y: number }): SimEvent {
  return { type, mineId: 1, ownerId: ENEMY_ID, pos };
}

describe('createHapticsDirector', () => {
  it("vibrates the fire pulse for the PLAYER's own shot", () => {
    const { vibrate, calls } = fakeVibrate();
    const d = createHapticsDirector(vibrate, PLAYER_ID);
    d.handle([fireEvent(PLAYER_ID)]);
    expect(calls).toEqual([FIRE_PULSE_MS]);
  });

  it('does NOT vibrate for an enemy shot -- the stream is shared, discriminate by ownerId', () => {
    // Presence-only (`some(e => e.type === 'fire')`) is exactly the anti-pattern
    // CLAUDE.md names; this is the test that would pass under it and must not.
    const { vibrate, calls } = fakeVibrate();
    const d = createHapticsDirector(vibrate, PLAYER_ID);
    d.handle([fireEvent(ENEMY_ID)]);
    expect(calls).toHaveLength(0);
  });

  it('vibrates a DIFFERENT pattern when the player is destroyed than when the player fires', () => {
    const { vibrate, calls } = fakeVibrate();
    const d = createHapticsDirector(vibrate, PLAYER_ID);
    d.handle([destroyedEvent('player', PLAYER_ID)]);
    expect(calls).toEqual([DESTROYED_PATTERN_MS]);
    // No `.not.toEqual(FIRE_PULSE_MS)` companion: an array can never toEqual a
    // number, so that assertion was true regardless of either constant's value --
    // review flagged it as decorative and it is deleted rather than kept for show.
  });

  it('does NOT vibrate for a SECOND player-kind tank dying -- discriminate by tankId, not kind', () => {
    // Unreached by any runtime call site today (playerCount stays 1 everywhere),
    // but this is exactly the co-op misattribution the fix exists for: a second
    // player-kind tank (co-op's controlledBy: 1, its OWN distinct id) dying must
    // not pulse the DEVICE tracking a different player.
    const OTHER_PLAYER_ID = 99;
    const { vibrate, calls } = fakeVibrate();
    const d = createHapticsDirector(vibrate, PLAYER_ID);
    d.handle([destroyedEvent('player', OTHER_PLAYER_ID)]);
    expect(calls).toHaveLength(0);
  });

  it('pins MINE_DANGER_RADIUS to the sim kill reach it claims to be', () => {
    // The boundary tests below probe RELATIVE to the constant, so they survive any
    // magnitude -- review proved a x10 mutation (radius 25, larger than arena-01's
    // whole board) passed 217 scoped tests. This literal is the magnitude pin:
    // 2.5 = MINE_BLAST_RADIUS (2, balance.json mines.blastRadius) + TANK_RADIUS
    // (0.5, balance.json tank.radius). Breaks if either constant retunes -- which is
    // the point: retuning the sim's kill reach SHOULD force this file to re-affirm
    // that the buzz still means "genuinely in the blast".
    expect(MINE_DANGER_RADIUS).toBe(2.5);
  });

  it('does NOT vibrate when an ENEMY tank is destroyed', () => {
    const { vibrate, calls } = fakeVibrate();
    const d = createHapticsDirector(vibrate, PLAYER_ID);
    d.handle([destroyedEvent('grey', 99)]);
    expect(calls).toHaveLength(0);
  });

  it('vibrates for a mine detonating within kill reach of the player', () => {
    const { vibrate, calls } = fakeVibrate();
    const d = createHapticsDirector(vibrate, PLAYER_ID);
    d.setPlayerPosition({ x: 0, y: 0 });
    d.handle([mineDetonateEvent({ x: MINE_DANGER_RADIUS - 0.1, y: 0 })]);
    expect(calls).toEqual([MINE_NEAR_PULSE_MS]);
  });

  it('does NOT vibrate for a mine detonating outside kill reach of the player', () => {
    const { vibrate, calls } = fakeVibrate();
    const d = createHapticsDirector(vibrate, PLAYER_ID);
    d.setPlayerPosition({ x: 0, y: 0 });
    d.handle([mineDetonateEvent({ x: MINE_DANGER_RADIUS + 0.1, y: 0 })]);
    expect(calls).toHaveLength(0);
  });

  it('does NOT vibrate for a mine detonation before any player position is known', () => {
    const { vibrate, calls } = fakeVibrate();
    const d = createHapticsDirector(vibrate, PLAYER_ID);
    d.handle([mineDetonateEvent({ x: 0, y: 0 })]);
    expect(calls).toHaveLength(0);
  });

  it('rebinds to a new player id, the way the audio director does across a level switch', () => {
    const { vibrate, calls } = fakeVibrate();
    const d = createHapticsDirector(vibrate, PLAYER_ID);
    d.setPlayerId(ENEMY_ID);
    d.handle([fireEvent(PLAYER_ID)]); // now the OLD id, no longer "the player"
    expect(calls).toHaveLength(0);
    d.handle([fireEvent(ENEMY_ID)]);
    expect(calls).toEqual([FIRE_PULSE_MS]);
  });

  it('calls the injected vibrate function with exactly the named constants, nothing invented', () => {
    const { vibrate, calls } = fakeVibrate();
    const d = createHapticsDirector(vibrate, PLAYER_ID);
    d.setPlayerPosition({ x: 0, y: 0 });
    d.handle([
      fireEvent(PLAYER_ID),
      destroyedEvent('player', PLAYER_ID),
      mineDetonateEvent({ x: 0.5, y: 0 }),
    ]);
    expect(calls).toEqual([FIRE_PULSE_MS, DESTROYED_PATTERN_MS, MINE_NEAR_PULSE_MS]);
  });

  it('when disabled, calls vibrate zero times even with events flowing', () => {
    const { vibrate, calls } = fakeVibrate();
    const d = createHapticsDirector(vibrate, PLAYER_ID);
    d.setEnabled(false);
    d.setPlayerPosition({ x: 0, y: 0 });
    d.handle([
      fireEvent(PLAYER_ID),
      destroyedEvent('player', PLAYER_ID),
      mineDetonateEvent({ x: 0, y: 0 }),
    ]);
    expect(calls).toHaveLength(0);
  });

  it('re-enabling after a disable resumes vibrating', () => {
    const { vibrate, calls } = fakeVibrate();
    const d = createHapticsDirector(vibrate, PLAYER_ID);
    d.setEnabled(false);
    d.handle([fireEvent(PLAYER_ID)]);
    d.setEnabled(true);
    d.handle([fireEvent(PLAYER_ID)]);
    expect(calls).toEqual([FIRE_PULSE_MS]);
  });

  it('is silent for event kinds this seam does not cover -- win, ricochet, wall-destroyed', () => {
    const { vibrate, calls } = fakeVibrate();
    const d = createHapticsDirector(vibrate, PLAYER_ID);
    d.setPlayerPosition({ x: 0, y: 0 });
    const events: SimEvent[] = [
      { type: 'win' },
      { type: 'lose' },
      { type: 'ricochet', ownerId: PLAYER_ID, pos: { x: 0, y: 0 }, bounceIndex: 0 },
      { type: 'explosion', pos: { x: 0, y: 0 } },
      { type: 'mine-dropped', mineId: 1, ownerId: PLAYER_ID, pos: { x: 0, y: 0 } },
      { type: 'mine-armed', mineId: 1, ownerId: PLAYER_ID, pos: { x: 0, y: 0 } },
      { type: 'wall-destroyed', wallId: 1, ownerId: PLAYER_ID, pos: { x: 0, y: 0 } },
    ];
    d.handle(events);
    expect(calls).toHaveLength(0);
  });
});

describe('resolveVibrate', () => {
  it('binds and returns navigator.vibrate when the host has one', () => {
    // The fake READS `this`, because a fixture that ignores its receiver cannot tell
    // bound from unbound -- review proved the first version passed with .bind(nav)
    // deleted. Chromium's real vibrate throws "Illegal invocation" detached from its
    // navigator; this fake reproduces that contract, so dropping the bind fails here.
    const seen: Array<number | number[]> = [];
    const nav = {
      vibrate(this: unknown, pattern: number | number[]): boolean {
        if (this !== nav) throw new TypeError('Illegal invocation');
        seen.push(pattern);
        return true;
      },
    };
    const vibrate = resolveVibrate({ navigator: nav });
    expect(vibrate(10)).toBe(true);
    expect(seen).toEqual([10]);
  });

  it('degrades to the no-op when the navigator property itself THROWS on access', () => {
    // The resolveStorage-mirroring half the comment promises: Safari-style lockdown
    // hosts throw on property access rather than returning undefined. Breaks if the
    // try/catch around host.navigator is removed.
    const host = {
      get navigator(): { vibrate?: (p: number | number[]) => boolean } {
        throw new Error('SecurityError: navigator access blocked');
      },
    };
    const vibrate = resolveVibrate(host);
    expect(vibrate(10)).toBe(false); // the no-op, not a crash
  });

  it('returns a no-op that reports false when the host has no vibrate', () => {
    const vibrate = resolveVibrate({ navigator: {} });
    expect(vibrate(10)).toBe(false);
  });

  it('returns a no-op when the host has no navigator at all', () => {
    const vibrate = resolveVibrate({});
    expect(vibrate([10, 20])).toBe(false);
  });
});

describe('mine warning haptics (issue #276)', () => {
  it('pulses for a fuse warning inside the danger radius, and NOT outside it', () => {
    // The gate is the point, not the pulse: without it, a mine burning down on the far side
    // of the arena buzzes a player who cannot even see it. Both sides asserted, so the test
    // fails whether the gate is deleted or inverted.
    const near = fakeVibrate();
    const dNear = createHapticsDirector(near.vibrate, PLAYER_ID);
    dNear.setPlayerPosition({ x: 0, y: 0 });
    dNear.handle([warnEvent('mine-fuse-warning', { x: MINE_DANGER_RADIUS - 0.1, y: 0 })]);
    expect(near.calls).toEqual([MINE_FUSE_WARN_PULSE_MS]);

    const far = fakeVibrate();
    const dFar = createHapticsDirector(far.vibrate, PLAYER_ID);
    dFar.setPlayerPosition({ x: 0, y: 0 });
    dFar.handle([warnEvent('mine-fuse-warning', { x: MINE_DANGER_RADIUS + 0.1, y: 0 })]);
    expect(far.calls).toEqual([]);
  });

  it('pulses the TRIP pattern inside the danger radius, and NOT outside it', () => {
    const near = fakeVibrate();
    const dNear = createHapticsDirector(near.vibrate, PLAYER_ID);
    dNear.setPlayerPosition({ x: 0, y: 0 });
    dNear.handle([warnEvent('mine-triggered', { x: 0.5, y: 0 })]);
    expect(near.calls).toEqual([MINE_TRIP_PATTERN_MS]);

    const far = fakeVibrate();
    const dFar = createHapticsDirector(far.vibrate, PLAYER_ID);
    dFar.setPlayerPosition({ x: 0, y: 0 });
    dFar.handle([warnEvent('mine-triggered', { x: MINE_DANGER_RADIUS + 0.1, y: 0 })]);
    expect(far.calls).toEqual([]);
  });

  it('gives the two warnings DIFFERENT patterns, so a hand can tell them apart', () => {
    // The whole point of the issue is that these two mean different things.
    //
    // An earlier version of this test asserted
    // `expect(MINE_TRIP_PATTERN_MS).not.toEqual(MINE_FUSE_WARN_PULSE_MS)`, which CANNOT
    // FAIL: one is an array and the other a number, so they are unequal whatever values
    // they hold. It advertised coverage it did not have. What actually discriminates is
    // the pair of RECORDED CALLS below -- point either case at the other's constant and
    // this fails.
    const { vibrate, calls } = fakeVibrate();
    const d = createHapticsDirector(vibrate, PLAYER_ID);
    d.setPlayerPosition({ x: 0, y: 0 });
    d.handle([warnEvent('mine-fuse-warning', { x: 0.5, y: 0 }), warnEvent('mine-triggered', { x: 0.5, y: 0 })]);
    expect(calls).toEqual([MINE_FUSE_WARN_PULSE_MS, MINE_TRIP_PATTERN_MS]);
  });

  it('stays silent with no known player position, rather than buzzing for every mine', () => {
    // setPlayerPosition is never called here. An ungated fallback would vibrate for warnings
    // anywhere on the map during the first frames of a round.
    const { vibrate, calls } = fakeVibrate();
    const d = createHapticsDirector(vibrate, PLAYER_ID);
    d.handle([warnEvent('mine-fuse-warning', { x: 0, y: 0 }), warnEvent('mine-triggered', { x: 0, y: 0 })]);
    expect(calls).toEqual([]);
  });
});


describe('blocked-fire cue (issue #356, first arm)', () => {
  const blocked = (ownerId: number): SimEvent =>
    ({ type: 'fire-blocked', ownerId, reason: 'shell-cap' }) as SimEvent;

  it('stays SILENT with no flag, because the treatments have not been compared yet', () => {
    // The default the issue requires: no arm may become the shipped cue by being wired
    // first. Passing { blockedFire: 'haptic' } instead makes this fail, which is the next
    // test -- the two together are the whole gate.
    const calls: (number | number[])[] = [];
    const d = createHapticsDirector((p) => { calls.push(p); return true; }, 7);
    d.handle([blocked(7)]);
    expect(calls).toEqual([]);
  });

  it('plays the double tap for the controlling player when the flag names it', () => {
    const calls: (number | number[])[] = [];
    const d = createHapticsDirector((p) => { calls.push(p); return true; }, 7, { blockedFire: 'haptic' });
    d.handle([blocked(7)]);
    expect(calls).toEqual([BLOCKED_FIRE_PATTERN_MS]);
  });

  it('ignores a refusal that belongs to someone else', () => {
    // `fire-blocked` carries whoever was refused, AI tanks included. A hand does not want
    // to feel an enemy running out of shells. Dropping the ownerId gate makes this fail.
    const calls: (number | number[])[] = [];
    const d = createHapticsDirector((p) => { calls.push(p); return true; }, 7, { blockedFire: 'haptic' });
    d.handle([blocked(9)]);
    expect(calls).toEqual([]);
  });

  it('is distinguishable from a successful shot by SHAPE, not just length', () => {
    // The issue asks for a pattern "distinct from successful firing". Two cues that
    // differed only in duration would satisfy a naive inequality and be indistinguishable
    // through a hand, so this asserts the structural difference: one pulse against three
    // elements, and every tap shorter than the shot it is not.
    expect(Array.isArray(BLOCKED_FIRE_PATTERN_MS)).toBe(true);
    expect(BLOCKED_FIRE_PATTERN_MS.length).toBeGreaterThan(1);
    expect(typeof FIRE_PULSE_MS).toBe('number');
    for (const ms of [BLOCKED_FIRE_PATTERN_MS[0], BLOCKED_FIRE_PATTERN_MS[2]]) {
      expect(ms).toBeLessThan(FIRE_PULSE_MS);
    }
  });

  it('follows the director when the player id is rebound', () => {
    // setPlayerId exists because tank numbering differs per arena; a cue still bound to
    // the old id would buzz for whoever inherited it. Removing the rebind fails this.
    const calls: (number | number[])[] = [];
    const d = createHapticsDirector((p) => { calls.push(p); return true; }, 7, { blockedFire: 'haptic' });
    d.setPlayerId(9);
    d.handle([blocked(9)]);
    d.handle([blocked(7)]);
    expect(calls).toEqual([BLOCKED_FIRE_PATTERN_MS]);
  });
});


describe('blocked-fire cue: the arms are separable (issue #356)', () => {
  const blocked = (ownerId: number): SimEvent =>
    ({ type: 'fire-blocked', ownerId, reason: 'shell-cap' }) as SimEvent;
  const buzzed = (cue: BlockedFireCue) => {
    const calls: (number | number[])[] = [];
    const d = createHapticsDirector((p) => { calls.push(p); return true; }, 7, { blockedFire: cue });
    d.handle([blocked(7)]);
    return calls;
  };

  it('the AUDIO arm does not vibrate', () => {
    // The mirror of director.test.ts's "the haptic arm makes no sound". Together they are
    // what lets #356 attribute a preference to a channel rather than to a bundle.
    expect(buzzed('audio')).toEqual([]);
  });

  it('the multimodal arm vibrates AND (see director.test.ts) sounds', () => {
    expect(buzzed('haptic-audio')).toEqual([BLOCKED_FIRE_PATTERN_MS]);
  });

  const carriesHaptic: Record<BlockedFireCue, boolean> = {
    haptic: true,
    audio: false,
    'haptic-audio': true,
    ring: false,
    'ring-audio': false,
    // The visual and audio arms of issue #516's matrix: named in the vocabulary, and
    // false here permanently -- they carry no haptic at all and must never buzz, which
    // is what lets #356 attribute a preference to a channel rather than to a bundle.
    muzzle: false,
    pips: false,
    hud: false,
    click: false,
    clunk: false,
    'thunk-soft': false,
    'pitch-empty': false,
    // Issue #516's four extra haptic arms, now implemented (haptics.ts's
    // BLOCKED_FIRE_ARMS). This table is about CHANNEL MEMBERSHIP -- does this cue reach
    // the hand at all -- so it counts pulses; WHICH pattern each arm feels like is a
    // different contract, and has its own one-row-per-arm table below.
    'haptic-tap': true,
    'haptic-double': true,
    'haptic-long': true,
    'haptic-rise': true,
  };

  it('vibrates for EVERY cue carrying `haptic`, and for no other -- one row per cue', () => {
    // The mirror of director.test.ts's audio table, and the half that makes `ring-audio` a
    // CHECKED pair rather than a label: it must reach the screen and the speaker and stop
    // there. Without this row a bundle that also buzzed would pass as "ring plus audio",
    // and #356 would attribute a preference to the wrong set of channels.
    expect(Object.keys(carriesHaptic).sort()).toEqual([...BLOCKED_FIRE_CUES].sort());
    for (const [cue, shouldBuzz] of Object.entries(carriesHaptic)) {
      expect(buzzed(cue as BlockedFireCue), cue).toHaveLength(shouldBuzz ? 1 : 0);
    }
  });
  it('gives each haptic arm its OWN pattern -- one row per arm (issue #516)', () => {
    // The table above is CHANNEL MEMBERSHIP: the arms all buzzing the baseline double tap
    // would satisfy it completely, and a hand asked to compare five identical buzzes is
    // not comparing anything. MEASURED: collapsing haptics.ts's lookup to
    // `BLOCKED_FIRE_PATTERN_MS` left all 30 of this file's tests green before this case
    // existed.
    //
    // `haptic-audio` shares the baseline BY DESIGN: it exists to test the PAIRING of two
    // channels, so giving it a pattern of its own would confound the two questions.
    const armPulse: Record<HapticArm, number | number[]> = {
      haptic: BLOCKED_FIRE_PATTERN_MS,
      'haptic-audio': BLOCKED_FIRE_PATTERN_MS,
      'haptic-tap': BLOCKED_FIRE_TAP_PULSE_MS,
      'haptic-double': BLOCKED_FIRE_DOUBLE_PATTERN_MS,
      'haptic-long': BLOCKED_FIRE_LONG_PULSE_MS,
      'haptic-rise': BLOCKED_FIRE_RISE_PATTERN_MS,
    };
    // Every cue the membership table says buzzes needs a row here, so a sixth haptic arm
    // cannot be added, buzz, and go unmentioned by this test.
    expect(Object.keys(armPulse).sort()).toEqual(
      Object.entries(carriesHaptic)
        .filter(([, buzzes]) => buzzes)
        .map(([cue]) => cue)
        .sort(),
    );
    for (const [cue, pattern] of Object.entries(armPulse)) {
      expect(buzzed(cue as BlockedFireCue), cue).toEqual([pattern]);
    }

    // The five compared shapes really are five, and none of them is the shot. Pointing two
    // arms at one constant passes every row above; so does an arm that feels exactly like
    // firing, which is the one thing #356 says the refusal must never feel like.
    const compared = ['haptic', 'haptic-tap', 'haptic-double', 'haptic-long', 'haptic-rise'] as const;
    const shapes = compared.map((cue) => JSON.stringify(armPulse[cue]));
    expect(new Set(shapes).size, `arms sharing a pattern: ${shapes.join(' | ')}`).toBe(compared.length);
    expect(shapes).not.toContain(JSON.stringify(FIRE_PULSE_MS));
  });

  it('stays silent on a device with no vibration, and behind the haptics preference', () => {
    // The two gates every arm inherits, asserted for a NEW arm rather than assumed from
    // the old one. `resolveVibrate({})` is what a host with no `navigator.vibrate`
    // resolves to -- per this file's own resolveVibrate suite, that is every Safari and
    // Firefox visitor, on any OS -- and a cue that threw there would take the frame's
    // whole event loop down with it, not merely go quiet.
    const d = createHapticsDirector(resolveVibrate({}), 7, { blockedFire: 'haptic-rise' });
    expect(() => d.handle([blocked(7)])).not.toThrow();

    // And the persisted off switch (touch-settings.ts) suppresses a new arm exactly as it
    // suppresses the shipped one -- asserted in both directions, so a `setEnabled` that
    // ignored its argument entirely would fail rather than pass on the silent half.
    const calls: (number | number[])[] = [];
    const off = createHapticsDirector((p) => { calls.push(p); return true; }, 7, { blockedFire: 'haptic-long' });
    off.setEnabled(false);
    off.handle([blocked(7)]);
    expect(calls).toEqual([]);
    off.setEnabled(true);
    off.handle([blocked(7)]);
    expect(calls).toEqual([BLOCKED_FIRE_LONG_PULSE_MS]);
  });
});
