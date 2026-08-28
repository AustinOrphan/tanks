import { describe, it, expect } from 'vitest';
import {
  defaultSlots, sanitizeSetup, resolveSources, versusSetupProblem, botSlotsOf, resizeSlots,
  type VersusSetup, type VersusSlotSetup,
} from './versus-setup';

const BASE: VersusSetup = {
  mode: 'ffa', players: 2, stock: 3, friendlyFire: false, arenaId: 'arena-01',
  slots: defaultSlots(2),
};

describe('defaultSlots: the first-launch pattern', () => {
  it('gives slot 0 to a human and every other slot to a BOT', () => {
    // The issue opens on this exact gap: "a keyboard-only default can launch required
    // inert tanks". Defaulting slot 1 to a human hands a keyboard-only player a match with
    // a tank nothing can drive. Flip the ternary in defaultSlots and this fails.
    expect(defaultSlots(4).map((s) => s.role)).toEqual(['human', 'bot', 'bot', 'bot']);
  });

  it('produces a setup that passes the Start gate with no controllers at all', () => {
    // The criterion "first-time keyboard-only ... produce playable defaults", end to end
    // rather than by inspection: default slots, zero pads, Start must be allowed.
    const slots = defaultSlots(4);
    expect(versusSetupProblem(slots, resolveSources(slots, []))).toBeNull();
  });
});

describe('sanitizeSetup: anything can come back out of storage', () => {
  it('returns the fallback for null, and for a non-object', () => {
    expect(sanitizeSetup(null, BASE)).toEqual(BASE);
    expect(sanitizeSetup(42, BASE)).toEqual(BASE);
    expect(sanitizeSetup('nonsense', BASE)).toEqual(BASE);
  });

  it('defaults each field INDEPENDENTLY: junk in one does not discard the others', () => {
    // touch-settings.ts's rule, and the one that matters most here because the fields come
    // from different UI controls at different times. A single try/catch returning the whole
    // fallback would pass a "handles junk" test and silently lose a player's 4-player
    // choice because their arenaId was stale.
    const out = sanitizeSetup({ mode: 'nope', players: 4, stock: 'x', arenaId: 'arena-03' }, BASE);
    expect(out.mode).toBe(BASE.mode); // junk -> fallback
    expect(out.players).toBe(4); // valid -> kept
    expect(out.stock).toBe(BASE.stock); // junk -> fallback
    expect(out.arenaId).toBe('arena-03'); // valid -> kept
  });

  it('reconciles a SHORT slots array up to players, with defaults', () => {
    // players and slots are stored separately and can disagree across a build. Extending
    // rather than throwing is what keeps a stale setup from blocking launch.
    const out = sanitizeSetup({ ...BASE, players: 4, slots: [{ role: 'bot' }] }, BASE);
    expect(out.slots).toHaveLength(4);
    expect(out.slots[0].role).toBe('bot'); // the stored one survives
    expect(out.slots.slice(1).map((s) => s.role)).toEqual(['bot', 'bot', 'bot']);
  });

  it('truncates a LONG slots array down to players', () => {
    const long = [{ role: 'human' }, { role: 'human' }, { role: 'bot' }, { role: 'bot' }];
    const out = sanitizeSetup({ ...BASE, players: 2, slots: long }, BASE);
    expect(out.slots).toHaveLength(2);
    expect(out.slots.map((s) => s.role)).toEqual(['human', 'human']);
  });

  it('replaces an unknown role with the default for that slot, not with the whole fallback', () => {
    const out = sanitizeSetup({ ...BASE, players: 3, slots: [{ role: 'wizard' }, { role: 'bot' }, {}] }, BASE);
    expect(out.slots.map((s) => s.role)).toEqual(['human', 'bot', 'bot']);
  });

  it('keeps a valid team index and drops a nonsense one', () => {
    const out = sanitizeSetup(
      { ...BASE, players: 2, slots: [{ role: 'human', team: 1 }, { role: 'bot', team: -3 }] },
      BASE,
    );
    expect(out.slots[0].team).toBe(1);
    expect(out.slots[1].team).toBeUndefined();
  });

  it('never returns a stored pad index, because it never stores one', () => {
    // Structural proof of the stale-index rule: even a setup that explicitly carries pad
    // bindings comes back without them, so there is nothing for a later reload to honour.
    const out = sanitizeSetup(
      { ...BASE, slots: [{ role: 'human', padIndex: 3 }, { role: 'human', padIndex: 7 }] },
      BASE,
    );
    expect(JSON.stringify(out)).not.toContain('padIndex');
  });
});

describe('resolveSources: devices are re-resolved, never restored', () => {
  it('gives slot 0 this device and later human slots the connected pads in order', () => {
    const slots: VersusSlotSetup[] = [{ role: 'human' }, { role: 'human' }, { role: 'human' }];
    expect(resolveSources(slots, [0, 1])).toEqual([
      { kind: 'keyboard' }, { kind: 'gamepad', padIndex: 0 }, { kind: 'gamepad', padIndex: 1 },
    ]);
  });

  it('resolves against the pads ACTUALLY connected, not the indices last seen', () => {
    // THE negative criterion: "never silently binds a different physical controller by
    // stale index". Unplug pad 0 and plug in pad 5; the human slot must follow the pad that
    // is really there. A build that restored a stored index would answer padIndex 0 here.
    const slots: VersusSlotSetup[] = [{ role: 'human' }, { role: 'human' }];
    expect(resolveSources(slots, [5])).toEqual([{ kind: 'keyboard' }, { kind: 'gamepad', padIndex: 5 }]);
  });

  it('leaves a human slot with NO device as none, rather than inventing one', () => {
    // The other half of the same rule: running out of pads must not wrap around to pad 0 or
    // hand a second slot the keyboard. `none` is what versusSetupProblem then reports.
    const slots: VersusSlotSetup[] = [{ role: 'human' }, { role: 'human' }, { role: 'human' }];
    expect(resolveSources(slots, [])).toEqual([
      { kind: 'keyboard' }, { kind: 'none' }, { kind: 'none' },
    ]);
  });

  it('does not spend a pad on a bot or an empty slot', () => {
    // Bots and empty slots must not consume the pad a later human needs -- otherwise
    // adding a bot in slot 1 would silently unbind the human in slot 2.
    const slots: VersusSlotSetup[] = [{ role: 'human' }, { role: 'bot' }, { role: 'none' }, { role: 'human' }];
    expect(resolveSources(slots, [4])).toEqual([
      { kind: 'keyboard' }, { kind: 'bot' }, { kind: 'none' }, { kind: 'gamepad', padIndex: 4 },
    ]);
  });

  it('gives THIS DEVICE to the first human slot even when it is not slot 0', () => {
    // A bot in slot 0 must not strand the keyboard: the device follows the first human,
    // not the index. Otherwise a player who bots slot 0 loses their own controls.
    const slots: VersusSlotSetup[] = [{ role: 'bot' }, { role: 'human' }];
    expect(resolveSources(slots, [])[1]).toEqual({ kind: 'keyboard' });
  });
});

describe('versusSetupProblem: the Start gate', () => {
  const ok: VersusSlotSetup[] = [{ role: 'human' }, { role: 'bot' }];

  it('allows Start when every slot resolves', () => {
    expect(versusSetupProblem(ok, resolveSources(ok, []))).toBeNull();
  });

  it('refuses an UNASSIGNED slot, naming which one', () => {
    // "Never accept Start with an inert required slot", and the slot index is what makes
    // the refusal actionable on a card rather than a bare disabled button.
    const slots: VersusSlotSetup[] = [{ role: 'human' }, { role: 'none' }];
    expect(versusSetupProblem(slots, resolveSources(slots, []))).toEqual({ kind: 'unassigned', slot: 1 });
  });

  it('refuses a human slot whose DEVICE is missing, distinctly from unassigned', () => {
    // The disconnect criterion. Distinguished from `unassigned` because the fixes differ:
    // one wants a different role, the other wants a controller plugged back in.
    const slots: VersusSlotSetup[] = [{ role: 'human' }, { role: 'human' }];
    expect(versusSetupProblem(slots, resolveSources(slots, []))).toEqual({ kind: 'device-missing', slot: 1 });
  });

  it('refuses an all-bot match', () => {
    const slots: VersusSlotSetup[] = [{ role: 'bot' }, { role: 'bot' }];
    expect(versusSetupProblem(slots, resolveSources(slots, []))).toEqual({ kind: 'no-human' });
  });

  it('reports the EARLIEST unassigned slot when several are wrong', () => {
    // Determinism, so the card that gets highlighted is stable rather than whichever the
    // loop happened to reach last.
    const slots: VersusSlotSetup[] = [{ role: 'none' }, { role: 'none' }];
    expect(versusSetupProblem(slots, resolveSources(slots, []))).toEqual({ kind: 'unassigned', slot: 0 });
  });
});

describe('botSlotsOf: the derived count', () => {
  it('is derived from roles, never stored alongside them', () => {
    // The issue's binding decision: "a bot count is derived data and is not authoritative".
    const slots: VersusSlotSetup[] = [{ role: 'human' }, { role: 'bot' }, { role: 'none' }, { role: 'bot' }];
    expect([...botSlotsOf(slots)].sort()).toEqual([1, 3]);
  });

  it('is empty for an all-human setup', () => {
    expect(botSlotsOf([{ role: 'human' }, { role: 'human' }]).size).toBe(0);
  });
});

describe('sanitizeSetup: arena ids are checked against what is offerable', () => {
  // resolveVersusConfig throws for an id naming no catalog entry AND for a real id whose
  // entry does not support the (players, mode) being started. Both are reachable from
  // stored data alone, so both must be repaired before they reach the launch path.
  const allowOnly = (ids: string[]) => (id: string) => ids.includes(id);

  it('keeps an arena the predicate allows', () => {
    const out = sanitizeSetup({ ...BASE, arenaId: 'arena-02' }, BASE, allowOnly(['arena-02']));
    expect(out.arenaId).toBe('arena-02');
  });

  it('falls back to random for an arena the predicate refuses', () => {
    const out = sanitizeSetup({ ...BASE, arenaId: 'arena-02' }, BASE, allowOnly([]));
    expect(out.arenaId).toBe('random');
  });

  it('refuses on the (players, mode) actually stored, not on the fallback pair', () => {
    // The subtle half: a map valid at 2 players, stored, then 4 players chosen. The
    // predicate must be asked about the SANITIZED players/mode, or the check answers a
    // question about the wrong match and lets the throw through.
    const seen: Array<[string, number, string]> = [];
    sanitizeSetup({ ...BASE, players: 4, mode: 'teams', arenaId: 'arena-02' }, BASE, (id, p, m) => {
      seen.push([id, p, m]);
      return false;
    });
    expect(seen).toEqual([['arena-02', 4, 'teams']]);
  });

  it("never asks the predicate about 'random', which is always allowed", () => {
    // 'random' names no catalog entry, so a predicate backed by versusMapChoices would
    // refuse it and silently convert "surprise me" into a concrete board on every read.
    let asked = false;
    const out = sanitizeSetup({ ...BASE, arenaId: 'random' }, BASE, () => {
      asked = true;
      return false;
    });
    expect(out.arenaId).toBe('random');
    expect(asked).toBe(false);
  });
});

describe('resizeSlots: the player-count buttons', () => {
  it('KEEPS chosen roles when the count grows', () => {
    // The bug this closes: changing 2 players to 3 left `slots` at length 2, so Start
    // emitted a config whose slots did not describe the match. Caught by an existing hud
    // test, not by anything written for this issue.
    const chosen = [{ role: 'bot' as const }, { role: 'human' as const }];
    expect(resizeSlots(chosen, 4).map((s) => s.role)).toEqual(['bot', 'human', 'bot', 'bot']);
  });

  it('keeps the surviving roles when the count shrinks', () => {
    const chosen = [{ role: 'bot' as const }, { role: 'human' as const }, { role: 'human' as const }];
    expect(resizeSlots(chosen, 2).map((s) => s.role)).toEqual(['bot', 'human']);
  });

  it('round-trips 2 -> 4 -> 2 back to the original choices', () => {
    // Why resize rather than rebuild: a player who changes their mind about the count and
    // changes it back should not silently lose the roles they set.
    const chosen = [{ role: 'bot' as const }, { role: 'human' as const }];
    expect(resizeSlots(resizeSlots(chosen, 4), 2)).toEqual(chosen);
  });

  it('copies rather than aliasing, so a later edit cannot reach back into the old array', () => {
    const chosen = [{ role: 'human' as const }];
    const out = resizeSlots(chosen, 2);
    out[0].role = 'bot';
    expect(chosen[0].role).toBe('human');
  });
});
