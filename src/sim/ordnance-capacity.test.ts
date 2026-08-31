// Enforcement AND release of the standard ordnance limits, through the public boundary
// (issue #268's tick-boundary criterion).
//
// bullets.test.ts and mines.test.ts already pin the REFUSAL at the cap, by calling
// spawnBullet/dropMine directly. Neither can show release, because release is a property
// of the PIPELINE: a shell frees its slot when it retires from world.bullets, and a mine
// frees its slot when detonateMine prunes activeMineIds. A unit test that never advances a
// tick cannot observe either, which is why these drive step().
//
// EVERY RUN STOPS AT THE FIRST ROUND RESET, and that bound is the whole reason these tests
// are worth anything. resetArena clears world.bullets outright and zeroes every tank's
// activeMineIds, so a run that crosses a death gets all its capacity back for free. The
// first version of this file did not stop, and passed against a build with BOTH shell
// release mechanisms deleted: firing stalled at exactly the cap, the player later died,
// the reset emptied the array, and firing resumed -- so the assertion was measuring
// respawn, not retirement. Measured spans in the clean build: arena-02 firing +x never
// dies at all within 3000 ticks (125 shots, peak 5), and the mine fixture reaches its
// first death at tick 210 having dropped 3 with 1 detonation.
//
// SHELL RELEASE IS DOUBLY GUARDED, and no single mutation can break it. `ownerShellCount`
// counts only live shells, and stepBullets removes dead ones from world.bullets before the
// next tick can fire -- so with either mechanism intact the other is unreachable. Measured:
// deleting the `alive` filter alone SURVIVES this file (an equivalent mutant), deleting
// both KILLS it. The mine side has one mechanism, so deleting detonateMine's prune kills on
// its own. Recorded so a future reader does not read the surviving single mutation as a
// coverage hole.
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
    const startRound = w.roundStartTick;
    const p = w.tanks.find((t: { kind: string }) => t.kind === 'player') as { pos: { x: number; y: number } };
    const aim = { x: p.pos.x + 50, y: p.pos.y };
    let fired = 0;
    let peak = 0;
    let sawFull = false;
    let releasedTick = -1;
    let firedAfterRelease = -1;
    let ticks = 0;

    for (let t = 0; t < 1200; t++) {
      const r = step(w, { move: { x: 0, y: 0 }, aim, fire: true, mine: false });
      w = r.world;
      // The bound: nothing past a reset counts, because a reset hands capacity back.
      if (w.roundStartTick !== startRound) break;
      ticks++;
      fired += r.events.filter((e) => e.type === 'fire').length;
      const live = liveShells(w, id);
      peak = Math.max(peak, live);
      expect(live).toBeLessThanOrEqual(PLAYER_SHELLS);
      if (live === PLAYER_SHELLS) sawFull = true;
      if (sawFull && releasedTick < 0 && live < PLAYER_SHELLS) releasedTick = t;
      if (releasedTick >= 0 && firedAfterRelease < 0 && r.events.some((e) => e.type === 'fire')) {
        firedAfterRelease = t;
      }
    }

    // The run really did stay inside one round, so everything below is retirement.
    expect(ticks).toBe(1200);
    expect(peak).toBe(PLAYER_SHELLS); // the cap is reached, so the bound above is not vacuous
    expect(releasedTick).toBeGreaterThanOrEqual(0);
    expect(firedAfterRelease).toBeGreaterThanOrEqual(releasedTick);
    expect(fired).toBeGreaterThan(PLAYER_SHELLS);
  });

  it('never exceeds the mine limit, and reuses slots as mines detonate', () => {
    let w = liveWorld();
    const startRound = w.roundStartTick;
    const p0 = w.tanks.find((t: { kind: string }) => t.kind === 'player') as { pos: { x: number; y: number } };
    const aim = { x: p0.pos.x + 50, y: p0.pos.y };
    let dropped = 0;
    let detonated = 0;
    let peak = 0;
    let sawFull = false;

    for (let t = 0; t < 2000; t++) {
      const dir = t % 240 < 120 ? 1 : -1;
      const r = step(w, { move: { x: dir, y: 0 }, aim, fire: false, mine: true });
      w = r.world;
      // Mines kill their own owner here, so this run DOES end at a reset -- earlier than
      // the shell one, which is why the assertions below are sized to the pre-reset span.
      if (w.roundStartTick !== startRound) break;
      dropped += r.events.filter((e) => e.type === 'mine-dropped').length;
      detonated += r.events.filter((e) => e.type === 'mine-detonate').length;
      const held = (w.tanks.find((t2: { kind: string }) => t2.kind === 'player') as { activeMineIds: number[] })
        .activeMineIds.length;
      peak = Math.max(peak, held);
      if (held === PLAYER_MINES) sawFull = true;
      expect(held).toBeLessThanOrEqual(PLAYER_MINES);
    }

    expect(sawFull).toBe(true);
    expect(peak).toBe(PLAYER_MINES);
    // At least one mine went off inside the span, and the tank got its slot back for it:
    // more drops than the limit, with no reset to hand them over.
    expect(detonated).toBeGreaterThan(0);
    expect(dropped).toBeGreaterThan(PLAYER_MINES);
  });
});
