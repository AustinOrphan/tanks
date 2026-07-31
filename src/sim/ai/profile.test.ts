import { describe, it, expect } from 'vitest';
import { greyDecision } from './grey';
import { tealDecision } from './teal';
import { configFor } from '../config';
import type { ResolvedTankConfig } from '../config';
import type { Tank, Vec2, Bullet, Wall } from '../types';
import type { World } from '../world';

// ---------------------------------------------------------------------------
// PROFILE CONSUMPTION tests: each one injects a variant ResolvedTankConfig via
// the decision functions' cfg parameter and asserts behaviour actually changes.
// This is what separates "the profile is consumed" from "the profile is carried":
// every test here fails if its field stops being read (verified by mutation --
// reverting each consumption to its old hardcoded form kills the matching test).
//
// Each variant is paired with a same-fixture default-cfg control, so a fixture
// drift that breaks the baseline cannot leave the variant assertion passing
// vacuously.
// ---------------------------------------------------------------------------

function tank(id: number, kind: Tank['kind'], pos: Vec2, over: Partial<Tank> = {}): Tank {
  return {
    id, kind, pos, bodyAngle: 0, turretAngle: 0, alive: true,
    desiredMove: { x: 0, y: 0 }, activeMineIds: [], fireCooldown: 0, mineCooldown: 0,
    aiState: 'idle', aiTimer: 0, ...over,
  };
}
function wall(id: number, minX: number, minY: number, maxX: number, maxY: number): Wall {
  return { id, aabb: { minX, minY, maxX, maxY }, kind: 'solid', destroyed: false };
}
function world(over: Partial<World>): World {
  return {
    tick: 0, nextId: 100, seed: 5, tanks: [], bullets: [], mines: [], blasts: [], walls: [],
    spawns: [], status: 'playing', lives: 3, roundStartTick: -100000,
    unarmedTrigger: 'none' as const, ...over,
  };
}
/** A cfg whose ai block is the shipped one with the given fields overridden. */
function withAi(base: ResolvedTankConfig, over: Partial<ResolvedTankConfig['ai']>): ResolvedTankConfig {
  return { ...base, ai: { ...base.ai, ...over } };
}

describe('aggression drives dodge patience (greyDecision)', () => {
  // The dispatch.test regression fixture: a threat bullet parked in grey's danger
  // corridor, clear LOS to a far player -- a firing solution exists but the shipped
  // profile (aggression 0.25 -> 45 ticks patience) suppresses it on the first tick.
  const fixture = () => {
    const grey = tank(1, 'grey', { x: 0, y: 0 });
    const player = tank(2, 'player', { x: 20, y: 0 });
    const threat: Bullet = {
      id: 999, ownerId: 2, type: 'normal', pos: { x: -1, y: 0 }, vel: { x: 5, y: 0 },
      bouncesLeft: 1, alive: true,
    };
    return { grey, w: world({ tanks: [grey, player], bullets: [threat] }) };
  };

  it('control: the shipped profile suppresses fire on the first dodge tick', () => {
    const { grey, w } = fixture();
    const d = greyDecision(w, grey);
    expect(d.fire).toBe(false);
    expect(d.nextTimer).toBe(1); // the patience counter is running
  });

  it('aggression 1.0 -> zero patience: fires immediately under the same threat', () => {
    const { grey, w } = fixture();
    const d = greyDecision(w, grey, withAi(configFor('grey'), { aggression: 1 }));
    expect(d.fire).toBe(true);
  });
});

describe('shot-type weights gate what teal attempts (tealDecision)', () => {
  // Bank-only geometry, verbatim from teal.test: a blocker kills the direct line,
  // a top wall affords a pi/4 bank via the bounce point (2,2).
  const bankFixture = () => {
    const teal = tank(1, 'teal', { x: 0, y: 0 });
    const player = tank(2, 'player', { x: 4, y: 0 });
    const walls = [wall(1, 1.5, -1, 2.5, 1), wall(2, -5, 2, 10, 3)];
    return { teal, w: world({ tanks: [teal, player], walls }) };
  };
  // Direct-only geometry: clear LOS, no walls at all, so no bank can exist.
  const directFixture = () => {
    const teal = tank(1, 'teal', { x: 0, y: 0 });
    const player = tank(2, 'player', { x: 5, y: 0 });
    return { teal, w: world({ tanks: [teal, player] }) };
  };

  it('control: both fixtures produce a shot under the shipped profile', () => {
    const bank = bankFixture();
    expect(tealDecision(bank.w, bank.teal).fire).toBe(true);
    const direct = directFixture();
    expect(tealDecision(direct.w, direct.teal).fire).toBe(true);
  });

  it('bankShotWeight 0 deletes the bank shot: same geometry, no fire', () => {
    const { teal, w } = bankFixture();
    const d = tealDecision(w, teal, withAi(configFor('teal'), { bankShotWeight: 0 }));
    expect(d.fire).toBe(false);
    expect(d.nextState).toBe('reposition');
  });

  it('directShotWeight 0 deletes the direct shot: clear LOS, no fire', () => {
    const { teal, w } = directFixture();
    const d = tealDecision(w, teal, withAi(configFor('teal'), { directShotWeight: 0 }));
    expect(d.fire).toBe(false);
  });
});

describe('minePlacementChance sign gates mine proposals', () => {
  // The player inside tactical mine range, no dodge, cooldown ready: the shipped
  // grey profile proposes a mine here (control), a chance-less profile must not.
  const fixture = () => {
    const grey = tank(1, 'grey', { x: 0, y: 0 });
    const player = tank(2, 'player', { x: 3, y: 0 });
    return { grey, w: world({ tanks: [grey, player] }) };
  };

  it('control: the shipped profile proposes a mine', () => {
    const { grey, w } = fixture();
    expect(greyDecision(w, grey).mine).toBe(true);
  });

  it('minePlacementChance undefined -> no proposal, same fixture', () => {
    const { grey, w } = fixture();
    const d = greyDecision(w, grey, withAi(configFor('grey'), { minePlacementChance: undefined }));
    expect(d.mine).toBe(false);
  });
});
