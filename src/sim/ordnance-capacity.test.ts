// Enforcement AND release of the standard ordnance limits, through the public boundary
// (issue #268's tick-boundary criterion).
//
// bullets.test.ts and mines.test.ts already pin the REFUSAL at the cap, by calling
// spawnBullet/dropMine directly. Neither can show release, because release is a property
// of the PIPELINE: a shell frees its slot when stepBullets compacts it out of
// world.bullets, and a mine frees its slot when detonateMine prunes activeMineIds. A unit
// test that never advances a tick cannot observe either, which is why these drive step().
import { describe, it, expect } from 'vitest';
import { step } from './world';
import { createWorldFor } from './arena';
import { ARENA_DEFS, arenaById } from './config/arenas';
import { configFor } from './config';
import { COUNTDOWN_TICKS } from './constants';
import type { InputState } from './types';
import type { World } from './world';

const PLAYER_SHELLS = configFor('player').weapon.maxActiveProjectiles;
const PLAYER_MINES = configFor('player').mineCapacity;

/**
 * A campaign board with the enemies removed, already past the countdown.
 *
 * ARENA INDEX 1 (arena-02) by default, chosen rather than assumed: shells retire on their
 * last bounce, so on a cramped board they expire faster than the fire cooldown can stack
 * them and the tank never reaches its limit at all -- which would leave the "never exceeds"
 * assertion below passing vacuously. Swept 8 arenas x 4 aim headings; 17 of those 32 reach
 * 4 or more live shells, and arena-02 along +x reaches the full 5.
 *
 * The countdown is not optional bookkeeping: roundPhase blocks firing and movement for its
 * whole span, and it takes COUNTDOWN_TICKS + 1 steps to reach 'live' because roundStartTick
 * is `tick + 1`. A fixture that skips this reads zero shots and looks like a broken cap.
 */
function liveWorld(arena = 1): World {
  let w = createWorldFor(arenaById(ARENA_DEFS[arena].id), 1) as World;
  const player = w.tanks.find((t: { kind: string }) => t.kind === 'player');
  if (!player) throw new Error('fixture has no player');
  w.tanks.length = 0;
  w.tanks.push(player);
  const idle: InputState = { move: { x: 0, y: 0 }, aim: { x: player.pos.x + 10, y: player.pos.y }, fire: false, mine: false };
  for (let i = 0; i <= COUNTDOWN_TICKS; i++) w = step(w, idle).world;
  return w;
}
const playerId = (w: World) => (w.tanks.find((t: { kind: string }) => t.kind === 'player') as { id: number }).id;
const liveShells = (w: World, id: number) => w.bullets.filter((b) => b.ownerId === id && b.alive).length;

describe('standard ordnance limits, driven through step()', () => {
  it('never exceeds the shell limit, and reuses slots as shells retire', () => {
    let w = liveWorld();
    const id = playerId(w);
    const p = w.tanks.find((t: { kind: string }) => t.kind === 'player') as { pos: { x: number; y: number } };
    const aim = { x: p.pos.x + 50, y: p.pos.y };
    let fired = 0;
    let peak = 0;
    let sawFull = false;
    let releasedTick = -1;
    let firedAfterRelease = -1;

    for (let t = 0; t < 1200; t++) {
      const r = step(w, { move: { x: 0, y: 0 }, aim, fire: true, mine: false });
      w = r.world;
      fired += r.events.filter((e) => e.type === 'fire').length;
      const live = liveShells(w, id);
      peak = Math.max(peak, live);
      // ENFORCEMENT: the limit is never breached on any tick, not merely at the end.
      expect(live).toBeLessThanOrEqual(PLAYER_SHELLS);
      if (live === PLAYER_SHELLS) sawFull = true;
      // RELEASE, at the boundary: the first tick the count drops below the limit after
      // having been at it, and the first shot that follows.
      if (sawFull && releasedTick < 0 && live < PLAYER_SHELLS) releasedTick = t;
      if (releasedTick >= 0 && firedAfterRelease < 0 && r.events.some((e) => e.type === 'fire')) {
        firedAfterRelease = t;
      }
    }

    expect(peak).toBe(PLAYER_SHELLS); // the cap is actually reached, so the bound above is not vacuous
    expect(sawFull).toBe(true);
    expect(releasedTick).toBeGreaterThanOrEqual(0);
    // A slot freed is a slot usable: the next shot lands after the release, not never.
    expect(firedAfterRelease).toBeGreaterThanOrEqual(releasedTick);
    // ...and over the run the tank fires MORE than one capful, which is only possible if
    // retiring shells returns capacity. Without release this equals PLAYER_SHELLS exactly.
    expect(fired).toBeGreaterThan(PLAYER_SHELLS);
  });

  it('never exceeds the mine limit, and reuses slots as mines detonate', () => {
    let w = liveWorld();
    const p0 = w.tanks.find((t: { kind: string }) => t.kind === 'player') as { pos: { x: number; y: number } };
    const aim = { x: p0.pos.x + 50, y: p0.pos.y };
    let dropped = 0;
    let peak = 0;

    for (let t = 0; t < 2000; t++) {
      // Drive while mining so mines are laid apart rather than stacked on one spot.
      const dir = t % 240 < 120 ? 1 : -1;
      const r = step(w, { move: { x: dir, y: 0 }, aim, fire: false, mine: true });
      w = r.world;
      dropped += r.events.filter((e) => e.type === 'mine-dropped').length;
      const held = (w.tanks.find((t2) => t2.kind === 'player') as { activeMineIds: number[] })
        .activeMineIds.length;
      peak = Math.max(peak, held);
      expect(held).toBeLessThanOrEqual(PLAYER_MINES);
    }

    expect(peak).toBe(PLAYER_MINES);
    // More than one capful over the run: activeMineIds is an explicit array that
    // detonateMine has to prune, so unlike shells this release is not automatic.
    expect(dropped).toBeGreaterThan(PLAYER_MINES);
  });
});
