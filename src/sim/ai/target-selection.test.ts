// Sticky, perception-bounded opponent selection (issue #359, binding policy 2026-08-31).
//
// Most of this file needs TWO player-kind tanks. With one player -- the campaign, and the
// whole golden trace -- rules 2, 3 and 6 are unreachable: there is nothing to rank, nothing
// to tie-break and nothing to switch to. A single-player fixture would let all three ship as
// dead code, so the symmetric two-player fixture below is the point rather than a detail.
import { describe, it, expect } from 'vitest';
import { commitTarget, isTargetable } from './target-selection';
import { resolveOpponent } from './targeting';
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

  it('acquires only what it can SEE, and reports the reason', () => {
    const ai = tank(1, 'grey', { x: 0, y: 0 });
    const seen = tank(2, 'player', { x: 9, y: 0 });
    const w = world([ai, seen]);
    expect(commitTarget(w, ai)).toBe('acquired');
    expect(resolveOpponent(w, ai)?.id).toBe(2);

    // The same opponent, behind a wall, is not acquirable at all.
    const blind = tank(1, 'grey', { x: 0, y: 0 });
    const w2 = world([blind, tank(2, 'player', { x: 9, y: 0 })], { walls: [wall(3, -3, 4, 3)] });
    expect(commitTarget(w2, blind)).toBe(null);
    expect(resolveOpponent(w2, blind)).toBeUndefined();
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
    expect(resolveOpponent(w, ai)).toBeUndefined();
  });

  it('never leaves a live AI pointed at a corpse', () => {
    // resolveOpponent re-checks `alive` because a target can die to a blast resolved later
    // in the SAME tick than the commitment was written.
    const ai = tank(1, 'grey', { x: 0, y: 0 }, { aiTargetId: 2, aiTargetTicks: 50 });
    const dead = tank(2, 'player', { x: 9, y: 0 }, { alive: false });
    expect(resolveOpponent(world([ai, dead]), ai)).toBeUndefined();
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
    // Committed to a target sitting exactly at preferred range, span already lapsed.
    const held = tank(2, 'player', { x: preferred, y: 0 });
    const run = (challengerX: number) => {
      const ai = tank(1, 'grey', { x: 0, y: 0 }, { aiTargetId: 2, aiTargetTicks: 0 });
      const challenger = tank(3, 'player', { x: challengerX, y: 0.001 });
      const reason = commitTarget(world([ai, held, challenger]), ai);
      return { id: ai.aiTargetId, reason };
    };
    // A challenger closer to preferred, but by less than the margin: keep the current one.
    const tiny = run(preferred - AI_TARGET_SWITCH_MARGIN / 2);
    expect(tiny.id).toBe(2);
    expect(tiny.reason).toBe(null);
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
