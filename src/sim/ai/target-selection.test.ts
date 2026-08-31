// Sticky, perception-bounded opponent selection (issue #359, binding policy 2026-08-31).
//
// Most of this file needs TWO player-kind tanks. With one player -- the campaign, and the
// whole golden trace -- rules 2, 3 and 6 are unreachable: there is nothing to rank, nothing
// to tie-break and nothing to switch to. A single-player fixture would let all three ship as
// dead code, so the symmetric two-player fixture below is the point rather than a detail.
import { describe, it, expect } from 'vitest';
import { commitTarget, isTargetable } from './target-selection';
import { resolveOpponent } from './targeting';
import { brownDecision } from './brown';
import { configFor } from '../config';
import { TICK_HZ, AI_TARGET_SWITCH_MARGIN } from '../constants';
import { TANK_KINDS } from '../config/validate';
import type { Tank, Vec2 } from '../types';
import type { World } from '../world';

function tank(id: number, kind: Tank['kind'], pos: Vec2, over: Partial<Tank> = {}): Tank {
  return {
    id, kind, pos, bodyAngle: 0, turretAngle: 0, alive: true,
    desiredMove: { x: 0, y: 0 }, activeMineIds: [], fireCooldown: 0, mineCooldown: 0,
    aiState: 'idle', aiTimer: 0, ...over,
  };
}
function world(tanks: Tank[], over: Partial<World> = {}): World {
  return {
    tick: 0, nextId: 100, seed: 5, tanks, bullets: [], mines: [], blasts: [], walls: [],
    spawns: [], status: 'playing', lives: 3, roundStartTick: -100000,
    unarmedTrigger: 'none', corpseBlocksShells: false, muzzleClearsTanks: true,
    coopAttempts: true, mode: 'campaign-coop', friendlyFire: false, ...over,
  } as World;
}
/** A solid wall, for taking line of sight away. */
const wall = (minX: number, minY: number, maxX: number, maxY: number) =>
  ({ id: 1, aabb: { minX, minY, maxX, maxY }, kind: 'solid' as const, destroyed: false });

const span = (kind: Tank['kind']) => Math.round(configFor(kind).ai.targetCommitmentTime * TICK_HZ);

describe('committed opponent selection', () => {
  it('every shipped profile resolves a validated commitment span', () => {
    // Population stated: all shipped kinds. A profile missing the field is a load failure by
    // now (config/validate.ts), so this asserts the resolved value is usable rather than
    // merely present -- a zero span would re-commit every tick and make the policy stateless.
    let checked = 0;
    for (const kind of TANK_KINDS) {
      const t = configFor(kind).ai.targetCommitmentTime;
      expect(Number.isFinite(t)).toBe(true);
      expect(Math.round(t * TICK_HZ)).toBeGreaterThan(0);
      checked++;
    }
    expect(checked).toBe(TANK_KINDS.length);
  });

  it('by DEFAULT sees the whole board, exactly as the player does', () => {
    // The owner ruling that supersedes rule 1's perception bound. The camera frames the
    // whole playable area and nothing fogs or culls, so an AI limited to line of sight had
    // an information limit the human does not -- and the counterplay was standing behind a
    // wall until it forgot you. brown is the case that showed it: it does not bank, so the
    // old bound left it with no target for 44.78% of its live ticks.
    expect(configFor('brown').ai.bankShotWeight).toBe(0);
    const ai = tank(1, 'brown', { x: 0, y: 0 });
    const w = world([ai, tank(2, 'player', { x: 9, y: 0 })], { walls: [wall(3, -3, 4, 3)] });
    expect(commitTarget(w, ai)).toBe('acquired');
    expect(resolveOpponent(w, ai, configFor('brown'))?.id).toBe(2);
  });

  it("selection is all it widens: aiming still needs a real line of sight", () => {
    // The load-bearing half of the ruling. Full awareness decides WHO a tank is fighting,
    // never what it can shoot -- otherwise a turret would track a target through a wall,
    // which is the omniscience the bound was reaching for in the first place. `hasSolution`
    // is the gate, and it is unchanged: no line, no solution.
    const ai = tank(1, 'brown', { x: 0, y: 0 });
    const foe = tank(2, 'player', { x: 9, y: 0 });
    const blocked = world([ai, foe], { walls: [wall(3, -3, 4, 3)] });
    commitTarget(blocked, ai);
    expect(resolveOpponent(blocked, ai, configFor('brown'))?.id).toBe(2); // committed...
    expect(brownDecision(blocked, ai).hasSolution).toBe(false); // ...and still cannot shoot
    // Same fixture with the wall gone: now it has both.
    const clear = world([ai, foe]);
    expect(brownDecision(clear, ai).hasSolution).toBe(true);
  });

  it("under the dev flag, acquires only what it can SEE, for a profile that does not bank", () => {
    // `?dev=1&aiPerception=los` restores the bound so the experiment stays runnable.
    // BROWN, not grey, and the choice is the test: `perceives` treats a banking profile as
    // perceiving what it could bank at -- indirect fire is that role's identity -- so grey
    // (bankShotWeight 0.1) saw through walls even under the bound, measured at 0.00% of its
    // live ticks blocked. brown's STATIC_BASIC banks at weight 0, so it is the profile the
    // rule ever bit on.
    expect(configFor('brown').ai.bankShotWeight).toBe(0);
    const seen = tank(1, 'brown', { x: 0, y: 0 });
    const w = world([seen, tank(2, 'player', { x: 9, y: 0 })], { aiTargetPerception: 'line-of-sight' });
    expect(commitTarget(w, seen)).toBe('acquired');

    const blind = tank(1, 'brown', { x: 0, y: 0 });
    const w2 = world([blind, tank(2, 'player', { x: 9, y: 0 })], {
      walls: [wall(3, -3, 4, 3)],
      aiTargetPerception: 'line-of-sight',
    });
    expect(commitTarget(w2, blind)).toBe(null);
    expect(resolveOpponent(w2, blind, configFor('brown'))).toBeUndefined();
  });

  it('under the dev flag, a BANKING profile still selects what it cannot see', () => {
    // Why the bound was never a graded perception model: it is switched by
    // `bankShotWeight`, a weapon-style knob. Kept as a case because it is the measurement
    // that drove the ruling, and it must stay true of the flagged path.
    expect(configFor('grey').ai.bankShotWeight).toBeGreaterThan(0);
    const grey = tank(1, 'grey', { x: 0, y: 0 });
    const w = world([grey, tank(2, 'player', { x: 9, y: 0 })], {
      walls: [wall(3, -3, 4, 3)],
      aiTargetPerception: 'line-of-sight',
    });
    expect(commitTarget(w, grey)).toBe('acquired');
  });

  it('holds one opponent for the whole span, THROUGH a sight break', () => {
    // Rules 5 and 7: perception bounds acquisition, not retention. A committed target
    // survives a wall coming between them; only death or invalidity cuts the span short.
    const ai = tank(1, 'grey', { x: 0, y: 0 });
    const near = tank(2, 'player', { x: 9, y: 0 });
    const far = tank(3, 'player', { x: 9.4, y: 0 });
    const w = world([ai, near, far]);
    commitTarget(w, ai);
    const chosen = ai.aiTargetId;
    expect(chosen).toBeDefined();

    // Blind the AI completely for the rest of the span; the commitment must not move.
    const blinded = world([ai, near, far], { walls: [wall(3, -5, 4, 5)] });
    for (let i = 0; i < span('grey'); i++) {
      expect(commitTarget(blinded, ai)).toBe(null);
      expect(ai.aiTargetId).toBe(chosen);
    }
  });

  it('drops a target that dies, on the tick it dies, mid-span', () => {
    const ai = tank(1, 'grey', { x: 0, y: 0 });
    const a = tank(2, 'player', { x: 9, y: 0 });
    const w = world([ai, a]);
    commitTarget(w, ai);
    expect(ai.aiTargetId).toBe(2);
    expect((ai.aiTargetTicks ?? 0) > 0).toBe(true); // still well inside the span
    a.alive = false;
    expect(commitTarget(w, ai)).toBe('target-lost');
    expect(ai.aiTargetId).toBeUndefined();
    expect(resolveOpponent(w, ai, configFor('grey'))).toBeUndefined();
  });

  it('never leaves a live AI pointed at a corpse', () => {
    // resolveOpponent re-checks `alive` because a target can die to a blast resolved later
    // in the SAME tick than the commitment was written.
    const ai = tank(1, 'grey', { x: 0, y: 0 }, { aiTargetId: 2, aiTargetTicks: 50 });
    const dead = tank(2, 'player', { x: 9, y: 0 }, { alive: false });
    expect(resolveOpponent(world([ai, dead]), ai, configFor('grey'))).toBeUndefined();
  });

  it('prefers the opponent nearest the profile PREFERRED range, not the nearest one', () => {
    // grey's preferredDistance is 9 at time of writing; read it rather than assume it.
    const preferred = configFor('grey').ai.preferredDistance;
    const ai = tank(1, 'grey', { x: 0, y: 0 });
    const inYourFace = tank(2, 'player', { x: 1, y: 0 });
    const atPreferred = tank(3, 'player', { x: preferred, y: 0 });
    const w = world([ai, inYourFace, atPreferred]);
    commitTarget(w, ai);
    expect(ai.aiTargetId).toBe(3);
  });

  it('breaks a symmetric tie per-AI, rather than by slot order or in unison', () => {
    // THE fixture rule 3 exists for: two players equidistant from every AI, so range cost
    // cannot separate them and only the seeded per-AI draw can.
    const preferred = configFor('grey').ai.preferredDistance;
    const left = tank(90, 'player', { x: -preferred, y: 0 });
    const right = tank(91, 'player', { x: preferred, y: 0 });
    const picks: number[] = [];
    for (let id = 1; id <= 12; id++) {
      const ai = tank(id, 'grey', { x: 0, y: 0 });
      commitTarget(world([ai, left, right]), ai);
      picks.push(ai.aiTargetId as number);
    }
    // Both players are chosen by somebody: neither slot is privileged, and the line does
    // not swing onto one target together. A slot-order policy makes this all 90s.
    expect(new Set(picks)).toEqual(new Set([90, 91]));
    expect(picks.filter((p) => p === 90).length).toBeGreaterThan(1);
    expect(picks.filter((p) => p === 91).length).toBeGreaterThan(1);
  });

  it('gives the same AI the same tie result every time it is asked', () => {
    const preferred = configFor('grey').ai.preferredDistance;
    const mk = () => tank(4, 'grey', { x: 0, y: 0 });
    const players = () => [tank(90, 'player', { x: -preferred, y: 0 }), tank(91, 'player', { x: preferred, y: 0 })];
    const a = mk(); commitTarget(world([a, ...players()]), a);
    const b = mk(); commitTarget(world([b, ...players()]), b);
    expect(b.aiTargetId).toBe(a.aiTargetId);
    // ...and a different seed is allowed to disagree, or the draw is not seeded at all.
    const c = mk(); commitTarget(world([c, ...players()], { seed: 99 }), c);
    const d = mk(); commitTarget(world([d, ...players()], { seed: 1234 }), d);
    expect([a.aiTargetId, c.aiTargetId, d.aiTargetId].some((x) => x !== a.aiTargetId)).toBe(true);
  });

  it('does not switch at expiry for a trivially better candidate, but does for a material one', () => {
    const preferred = configFor('grey').ai.preferredDistance;
    // The challenger must be genuinely BETTER than the held target, by less than the margin.
    // An earlier version of this case put the challenger further from preferred than the
    // held one, so no margin could ever have been crossed and the assertion held for a build
    // with the margin set to -1 -- i.e. it tested nothing. Held sits one unit off preferred;
    // the challenger sits exactly on it, an improvement of 1 against a margin of 2.
    const ai0 = tank(1, 'grey', { x: 0, y: 0 }, { aiTargetId: 2, aiTargetTicks: 0 });
    const heldSlightlyOff = tank(2, 'player', { x: preferred + AI_TARGET_SWITCH_MARGIN / 2, y: 0 });
    const slightlyBetter = tank(3, 'player', { x: preferred, y: 0 });
    expect(commitTarget(world([ai0, heldSlightlyOff, slightlyBetter]), ai0)).toBe(null);
    expect(ai0.aiTargetId).toBe(2);
    // The held target is only reachable as "worse" if the challenger beats it by MORE than
    // the margin. Put the held one far off preferred instead.
    const ai = tank(1, 'grey', { x: 0, y: 0 }, { aiTargetId: 2, aiTargetTicks: 0 });
    const wayOff = tank(2, 'player', { x: preferred + AI_TARGET_SWITCH_MARGIN * 3, y: 0 });
    const good = tank(3, 'player', { x: preferred, y: 0.001 });
    expect(commitTarget(world([ai, wayOff, good]), ai)).toBe('switched-on-expiry');
    expect(ai.aiTargetId).toBe(3);
  });

  it('re-arms the span when it lapses without switching', () => {
    // Otherwise an AI that declines to switch is re-evaluating every tick from then on,
    // which is the per-tick thrashing the issue rules out.
    const ai = tank(1, 'grey', { x: 0, y: 0 }, { aiTargetId: 2, aiTargetTicks: 0 });
    const only = tank(2, 'player', { x: 9, y: 0 });
    expect(commitTarget(world([ai, only]), ai)).toBe(null);
    expect(ai.aiTargetTicks).toBe(span('grey'));
  });

  it('will not target a teammate in Teams mode, nor an AI tank ever', () => {
    const ai = tank(1, 'grey', { x: 0, y: 0 }, { team: 0 });
    const mate = tank(2, 'player', { x: 9, y: 0 }, { team: 0 });
    const foe = tank(3, 'player', { x: 9, y: 1 }, { team: 1 });
    const w = world([ai, mate, foe], { mode: 'teams' });
    expect(isTargetable(w, ai, mate)).toBe(false);
    expect(isTargetable(w, ai, foe)).toBe(true);
    // Another enemy is never a target, in any mode.
    expect(isTargetable(world([ai]), ai, tank(4, 'brown', { x: 2, y: 0 }))).toBe(false);
  });
});
