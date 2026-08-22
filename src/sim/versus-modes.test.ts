import { describe, it, expect } from 'vitest';
import { createWorld, resolveStatus, stepInputs, stepRespawns } from './world';
import type { World } from './world';
import { ARENA_01, createWorldFor } from './arena';
import type { Tank, Spawn } from './types';
import type { SimEvent } from './events';
import { RESPAWN_DELAY_TICKS, VERSUS_STOCK } from './constants';

/**
 * PR 4 of the n-player arc -- FFA + teams. `World.mode` (default `'campaign-coop'`)
 * dispatches `resolveStatus` three ways; this file pins the two NEW branches
 * (`resolveStatusFfa`/`resolveStatusTeams`) and the `stepRespawns` gate tightening.
 * `coop-attempts.test.ts`/`coop-respawn.test.ts` already pin that the `'campaign-coop'`
 * branch is byte-untouched -- not re-proven here.
 */

function makeTank(kind: Tank['kind'], id: number, x: number, y: number, opts?: { alive?: boolean; team?: number; stock?: number }): Tank {
  return {
    id, kind, pos: { x, y }, bodyAngle: 0, turretAngle: 0, alive: opts?.alive ?? true,
    desiredMove: { x: 0, y: 0 }, activeMineIds: [], fireCooldown: 0, mineCooldown: 0,
    aiState: 'idle', aiTimer: 0,
    ...(opts?.team !== undefined ? { team: opts.team } : {}),
    ...(opts?.stock !== undefined ? { stockRemaining: opts.stock } : {}),
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
//
// `stock` defaults to undefined -- every tank's `stockRemaining` stays unset, which is
// the pre-stock single-life fallback (`?? 0` in isVersusEliminated, world.ts): the
// pre-existing dispatch tests above call this without `stock` deliberately, so they keep
// exercising that fallback rather than the real stock path. Tests of the stock feature
// itself pass `stock` explicitly.
function versusWorld(mode: 'ffa' | 'teams', n: 2 | 3 | 4, lives = 3, stock?: number): World {
  const teamOf = (slot: number): number => slot % 2;
  const tanks: Tank[] = [];
  const spawns: Spawn[] = [];
  for (let i = 0; i < n; i++) {
    const x = 5 + i * 3;
    tanks.push(makeTank('player', i + 1, x, 5, { team: mode === 'teams' ? teamOf(i) : undefined, stock }));
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

/**
 * The stock PR's central claim: a versus death does not end the match while the dying
 * player still has stock -- "eliminated" (isVersusEliminated, world.ts) is
 * `!alive && stockRemaining === 0`, not bare `!alive`. Each test below is isolated on
 * fresh state with its own single call and its own assertion immediately after it (the
 * combined-call/one-trailing-assertion trap CLAUDE.md's testing conventions warn about),
 * so a defect in one call cannot be masked by a later call's own no-op path.
 */
describe('versus stock: a mid-stock death does not end the match', () => {
  it('FFA N=3, one death with 2 stock remaining after it: still playing, not won', () => {
    const w = versusWorld('ffa', 3, 3, 2);
    tankById(w, 1).alive = false;
    resolveStatus(w, [destroyed(1)]);
    expect(w.status).toBe('playing');
  });

  it('FFA: that same death decrements stock by exactly 1 and schedules a respawn', () => {
    const w = versusWorld('ffa', 3, 3, 2);
    const a = tankById(w, 1);
    a.alive = false;
    resolveStatus(w, [destroyed(1)]);
    expect(a.stockRemaining).toBe(1);
    expect(a.respawnAtTick).toBe(w.tick + RESPAWN_DELAY_TICKS);
  });

  it('the specific regression this feature is reviewed hardest for: a naive alive-count check ends the match on the FIRST death even with stock left -- ours must not', () => {
    // N=2, deliberately: with 3+ players a single death still leaves 2+ ALIVE tanks
    // either way, so an `alive`-based check and an `eliminated`-based one AGREE by
    // coincidence and this test would pass even under the pre-stock mutation --
    // verified directly (see this file's own mutation notes): only the N=2 shape
    // below actually discriminates the two, because there `alive.length === 1` fires
    // the instant the first of two players dies, stock or no stock. With stock=2 (1
    // remains after this death) the eliminated-based check must keep playing; the
    // pre-stock `alive.length === 1` rule would call this an immediate win instead.
    const w = versusWorld('ffa', 2, 3, 2);
    tankById(w, 1).alive = false;
    resolveStatus(w, [destroyed(1)]);
    expect(w.status).toBe('playing');
  });

  it('teams N=4: one death on a team that still has stock left leaves BOTH teams with a non-eliminated member -- still playing', () => {
    const w = versusWorld('teams', 4, 3, 2);
    tankById(w, 2).alive = false; // slot 1, team 1
    resolveStatus(w, [destroyed(2)]);
    expect(w.status).toBe('playing');
  });

  it('teams N=2 (one player per team), same regression shape as FFA above: a mid-stock death must not end the match', () => {
    // N=4 above leaves 1 living player on the OTHER team either way, so an
    // alive-based check and an eliminated-based one agree there by the same
    // coincidence as FFA's N=3 case -- verified directly (see this file's own
    // mutation notes). Only a one-player-per-team shape actually discriminates them:
    // an alive-based `teamsRemaining` collapses to size 1 (a "win") the instant the
    // first team's sole player dies, stock or no stock.
    const w = versusWorld('teams', 2, 3, 2);
    tankById(w, 1).alive = false; // team 0's only player, 1 stock left after this
    resolveStatus(w, [destroyed(1)]);
    expect(w.status).toBe('playing');
  });
});

describe('versus stock: elimination at zero stock', () => {
  it('a death at zero stock remaining is eliminated: no respawn is scheduled', () => {
    const w = versusWorld('ffa', 3, 3, 0);
    const a = tankById(w, 1);
    a.alive = false;
    resolveStatus(w, [destroyed(1)]);
    expect(a.stockRemaining).toBe(0);
    expect(a.respawnAtTick).toBeUndefined();
  });

  it('FFA N=3: eliminating one of three at zero stock still leaves two non-eliminated -- still playing', () => {
    const w = versusWorld('ffa', 3, 3, 0);
    tankById(w, 1).alive = false;
    resolveStatus(w, [destroyed(1)]);
    expect(w.status).toBe('playing');
  });

  it('FFA N=2: the survivor wins once the other reaches zero stock', () => {
    const w = versusWorld('ffa', 2, 3, 0);
    tankById(w, 1).alive = false;
    resolveStatus(w, [destroyed(1)]);
    expect(w.status).toBe('win');
  });

  it('teams N=2 (one player per team): a zero-stock death eliminates that whole team -- the other wins', () => {
    const w = versusWorld('teams', 2, 3, 0);
    tankById(w, 1).alive = false; // team 0's only player, zero stock left
    resolveStatus(w, [destroyed(1)]);
    expect(w.status).toBe('win');
  });

  it('simultaneous zero-stock wipeout still resolves to lose, not a third status (the pre-existing named gap, unmoved by stock)', () => {
    const w = versusWorld('ffa', 2, 3, 0);
    tankById(w, 1).alive = false;
    tankById(w, 2).alive = false;
    resolveStatus(w, [destroyed(1), destroyed(2)]);
    expect(w.status).toBe('lose');
  });

  it('a mutual kill where BOTH still have stock left is not a wipeout -- both respawn, still playing', () => {
    const w = versusWorld('ffa', 2, 3, 2);
    const a = tankById(w, 1);
    const b = tankById(w, 2);
    a.alive = false;
    b.alive = false;
    resolveStatus(w, [destroyed(1), destroyed(2)]);
    expect(w.status).toBe('playing');
    expect(a.respawnAtTick).toBeDefined();
    expect(b.respawnAtTick).toBeDefined();
  });
});

// The stock PR extended stepRespawns' reach: campaign-coop keeps its original
// player-count guard, but ffa/teams now respawn at ANY player count (a stock match can
// schedule a respawn regardless of how many players remain -- see applyVersusStock,
// world.ts). This block replaces a prior version that pinned the OPPOSITE of the second
// case below (ffa's real pipeline used to leave a due corpse down); that pin is exactly
// what this PR's own directive asked to change, so it was rewritten rather than kept
// alongside a newly-false assertion.
describe('stepRespawns gate: campaign-coop needs 2+ players, ffa/teams need none', () => {
  it('a stamped respawnAtTick is honored by a direct call regardless of mode -- stepRespawns itself carries no mode guard', () => {
    const w = versusWorld('ffa', 2);
    const a = tankById(w, 1);
    a.alive = false;
    a.respawnAtTick = 5;
    w.tick = 10; // past the stamped tick
    stepRespawns(w, []);
    expect(a.alive).toBe(true);
  });

  it('ffa: the real pipeline (stepInputs) now revives a due corpse -- no player-count guard blocks it', () => {
    const w = versusWorld('ffa', 2);
    const a = tankById(w, 1);
    a.alive = false;
    a.respawnAtTick = 1; // due on tick 1, the very first simulated tick
    const r = stepInputs(w, [
      { move: { x: 0, y: 0 }, aim: { x: 0, y: 0 }, fire: false, mine: false },
      { move: { x: 0, y: 0 }, aim: { x: 0, y: 0 }, fire: false, mine: false },
    ]);
    expect(r.world.tanks.find((t) => t.id === 1)!.alive).toBe(true);
  });

  it('teams: the same reachability as ffa -- both versus modes carry no player-count guard', () => {
    const w = versusWorld('teams', 2);
    const a = tankById(w, 1);
    a.alive = false;
    a.respawnAtTick = 1;
    const r = stepInputs(w, [
      { move: { x: 0, y: 0 }, aim: { x: 0, y: 0 }, fire: false, mine: false },
      { move: { x: 0, y: 0 }, aim: { x: 0, y: 0 }, fire: false, mine: false },
    ]);
    expect(r.world.tanks.find((t) => t.id === 1)!.alive).toBe(true);
  });

  // campaign-coop's own N<2 boundary is NOT re-tested here: it is unchanged by this PR
  // (the `mode === 'campaign-coop' && countPlayerTanks(draft) >= 2` arm is untouched)
  // and is already pinned by coop-respawn.test.ts's own composition block. A same-shape
  // attempt was tried here directly and abandoned: at campaign-coop N=1 a manually
  // killed player is ALSO reached by resolveStatus's original 1-player body (the
  // "byte-untouched" fallthrough, not resolveStatusCoop), which calls resetArena and
  // revives every tank unconditionally -- a completely different mechanism from
  // stepRespawns/respawnAtTick that would make such a test pass for the wrong reason.
});

// The versus-setup-menu plan's only src/sim change: a trailing, defaulted per-match
// `stock` parameter threaded through createWorldFor -> loadArena, so a future menu can
// pick a stock count without touching campaign-coop's own byte-identical trace path.
describe('createWorldFor/loadArena: a defaulted per-match stock', () => {
  it('a versus world built with an explicit stock stamps it on every player tank', () => {
    const w = createWorldFor(ARENA_01, 7, undefined, 3, undefined, undefined, 3, undefined, 'ffa', undefined, 5);
    const players = w.tanks.filter((t) => t.kind === 'player');
    expect(players.length).toBe(3);
    for (const t of players) expect(t.stockRemaining).toBe(5);
  });

  it('omitting stock keeps the shipped VERSUS_STOCK default — the defaulted-param negative control', () => {
    const w = createWorldFor(ARENA_01, 7, undefined, 3, undefined, undefined, 2, undefined, 'ffa');
    for (const t of w.tanks.filter((t) => t.kind === 'player')) {
      expect(t.stockRemaining).toBe(VERSUS_STOCK);
    }
  });
});
