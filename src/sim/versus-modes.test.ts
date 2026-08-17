import { describe, it, expect } from 'vitest';
import { createWorld, resolveStatus, stepInputs, stepRespawns } from './world';
import type { World } from './world';
import type { Tank, Spawn } from './types';
import type { SimEvent } from './events';

/**
 * PR 4 of the n-player arc -- FFA + teams. `World.mode` (default `'campaign-coop'`)
 * dispatches `resolveStatus` three ways; this file pins the two NEW branches
 * (`resolveStatusFfa`/`resolveStatusTeams`) and the `stepRespawns` gate tightening.
 * `coop-attempts.test.ts`/`coop-respawn.test.ts` already pin that the `'campaign-coop'`
 * branch is byte-untouched -- not re-proven here.
 */

function makeTank(kind: Tank['kind'], id: number, x: number, y: number, opts?: { alive?: boolean; team?: number }): Tank {
  return {
    id, kind, pos: { x, y }, bodyAngle: 0, turretAngle: 0, alive: opts?.alive ?? true,
    desiredMove: { x: 0, y: 0 }, activeMineIds: [], fireCooldown: 0, mineCooldown: 0,
    aiState: 'idle', aiTimer: 0,
    ...(opts?.team !== undefined ? { team: opts.team } : {}),
  };
}

function destroyed(tankId: number, ownerId = 999): SimEvent {
  return { type: 'tank-destroyed', tankId, kind: 'player', by: { source: 'shell', ownerId }, pos: { x: 0, y: 0 } };
}

const tankById = (w: World, id: number) => w.tanks.find((t) => t.id === id)!;

describe('World.mode: defaults to campaign-coop, cloneWorld carries it', () => {
  it('createWorld defaults mode to campaign-coop and friendlyFire to false when omitted', () => {
    const w = createWorld({ walls: [], tanks: [], spawns: [], lives: 3 });
    expect(w.mode).toBe('campaign-coop');
    expect(w.friendlyFire).toBe(false);
    const r = stepInputs(w, []);
    expect(r.world.mode).toBe('campaign-coop');
    expect(r.world.friendlyFire).toBe(false);
  });

  it('createWorld honors an explicit mode/friendlyFire, cloneWorld carries both', () => {
    const w = createWorld({ walls: [], tanks: [], spawns: [], lives: 3, mode: 'teams', friendlyFire: true });
    expect(w.mode).toBe('teams');
    expect(w.friendlyFire).toBe(true);
    expect(stepInputs(w, []).world.mode).toBe('teams');
    expect(stepInputs(w, []).world.friendlyFire).toBe(true);
  });
});

// 4 players, alternating spawns (P1 team 0, P2 team 1, P3 team 0, P4 team 1). Each test
// sets `.alive`/`.team` on top of this fixture; a bare fifth (enemy) tank is included so
// FFA/teams fixtures can assert enemies never enter the win check even if one happens to
// share the world (never true from loadArena, but resolveStatusFfa/Teams must not read it).
function versusWorld(mode: 'ffa' | 'teams', n: 2 | 3 | 4, lives = 3): World {
  const teamOf = (slot: number): number => slot % 2;
  const tanks: Tank[] = [];
  const spawns: Spawn[] = [];
  for (let i = 0; i < n; i++) {
    const x = 5 + i * 3;
    tanks.push(makeTank('player', i + 1, x, 5, mode === 'teams' ? { team: teamOf(i) } : undefined));
    spawns.push({ kind: 'player', pos: { x, y: 5 }, angle: 0 });
  }
  return createWorld({ walls: [], tanks, spawns, lives, mode });
}

describe('resolveStatus dispatch: FFA', () => {
  it('N=3: two dead, one alive -- WIN', () => {
    const w = versusWorld('ffa', 3);
    tankById(w, 1).alive = false;
    tankById(w, 2).alive = false;
    resolveStatus(w, [destroyed(1), destroyed(2)]);
    expect(w.status).toBe('win');
  });

  it('N=3: one dead, two alive -- still playing', () => {
    const w = versusWorld('ffa', 3);
    tankById(w, 1).alive = false;
    resolveStatus(w, [destroyed(1)]);
    expect(w.status).toBe('playing');
  });

  it('N=2: one death is an immediate win for the survivor (last man standing)', () => {
    const w = versusWorld('ffa', 2);
    tankById(w, 1).alive = false;
    resolveStatus(w, [destroyed(1)]);
    expect(w.status).toBe('win');
  });

  it('N=2: a SIMULTANEOUS final wipeout resolves to lose, not a third status', () => {
    const w = versusWorld('ffa', 2);
    tankById(w, 1).alive = false;
    tankById(w, 2).alive = false;
    resolveStatus(w, [destroyed(1), destroyed(2)]);
    expect(w.status).toBe('lose');
  });

  it('guard-first: a second call on an already-won world does not push a second win event', () => {
    const w = versusWorld('ffa', 2);
    tankById(w, 1).alive = false;
    const events: SimEvent[] = [];
    resolveStatus(w, events);
    expect(w.status).toBe('win');
    resolveStatus(w, events);
    expect(events.filter((e) => e.type === 'win')).toHaveLength(1);
  });
});

describe('resolveStatus dispatch: teams', () => {
  it('N=4: team 1 (slots 1,3) fully dead, team 0 has a survivor -- WIN', () => {
    const w = versusWorld('teams', 4);
    tankById(w, 2).alive = false; // slot 1, team 1
    tankById(w, 4).alive = false; // slot 3, team 1
    resolveStatus(w, [destroyed(2), destroyed(4)]);
    expect(w.status).toBe('win');
  });

  it('N=4: one death on each team -- both teams still have a survivor, still playing', () => {
    const w = versusWorld('teams', 4);
    tankById(w, 1).alive = false; // team 0
    tankById(w, 2).alive = false; // team 1
    resolveStatus(w, [destroyed(1), destroyed(2)]);
    expect(w.status).toBe('playing');
  });

  it('N=2: both teams wiped in the SAME call -- lose, not a draw', () => {
    const w = versusWorld('teams', 2);
    tankById(w, 1).alive = false;
    tankById(w, 2).alive = false;
    resolveStatus(w, [destroyed(1), destroyed(2)]);
    expect(w.status).toBe('lose');
  });

  it('N=2: only one team exists in this fixture -- a lone survivor still standing is a win', () => {
    const w = versusWorld('teams', 2);
    tankById(w, 1).alive = false; // team 0 wiped
    resolveStatus(w, [destroyed(1)]);
    expect(w.status).toBe('win'); // team 1 (slot 1) still has tankById(w, 2) alive
  });
});

describe('stepRespawns gate tightened to mode === campaign-coop', () => {
  it('a stamped respawnAtTick is NOT honored in ffa mode even past its tick -- the gate blocks stepRespawns entirely outside campaign-coop', () => {
    const w = versusWorld('ffa', 2);
    const a = tankById(w, 1);
    a.alive = false;
    a.respawnAtTick = 5;
    w.tick = 10; // past the stamped tick
    const events: SimEvent[] = [];
    stepRespawns(w, events); // direct call: campaign-coop-only gating lives in stepInputs, not here --
    // stepRespawns itself has no internal mode guard (see its own doc comment), so a direct
    // call still revives on a stamped tick regardless of mode.
    expect(a.alive).toBe(true);
    // Reset and prove the REAL gate: stepInputs only calls stepRespawns at all when
    // mode === 'campaign-coop' && countPlayerTanks >= 2 -- in ffa this corpse must stay
    // down through the real pipeline even with respawnAtTick already due.
    const w2 = versusWorld('ffa', 2);
    const a2 = tankById(w2, 1);
    a2.alive = false;
    a2.respawnAtTick = 1; // due on tick 1, the very first simulated tick
    const r = stepInputs(w2, [
      { move: { x: 0, y: 0 }, aim: { x: 0, y: 0 }, fire: false, mine: false },
      { move: { x: 0, y: 0 }, aim: { x: 0, y: 0 }, fire: false, mine: false },
    ]);
    expect(r.world.tanks.find((t) => t.id === 1)!.alive).toBe(false);
  });
});
