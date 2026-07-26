import { describe, it, expect } from 'vitest';
import { loadArena, CURRENT_ARENA } from './arena';
import { reflectSweep } from './collision';
import { NORMAL_BOUNCES, RICOCHET_BOUNCES } from './constants';

/**
 * A shell must never come to rest inside a solid wall, and must never be left travelling
 * with bounces still in hand once it has passed through one.
 *
 * The shipped arena's four inside corners are where two boundary walls abut. reflectSweep
 * applied its "don't re-hit the wall I just left" epsilon to EVERY wall, so the abutting
 * wall's t=0 entry was discarded, the shell crossed 2 units of solid boundary with no hit
 * recorded and expired=false, and -- because raySegmentVsAABB reports t=0 from inside a box
 * -- every later tick was skipped too. The shell left the map and nothing retired it,
 * holding one of its owner's SHELL_CAP slots for the rest of the life. Five of those and
 * the player could not fire at all.
 *
 * Reachable without any float luck: InputController's aim starts at exactly {0,0} and
 * screenToGround passes sim coordinates through unchanged, so sim (0,0) -- one of those
 * corners -- is the default aim of anyone who has not moved the mouse since page load.
 */
describe('shells cannot escape through an arena corner', () => {
  const walls = loadArena(CURRENT_ARENA).walls.map((w) => w.aabb);
  const { cols, rows, cellSize } = CURRENT_ARENA;
  const corners = [
    { x: 0, y: 0 },
    { x: cols * cellSize, y: 0 },
    { x: 0, y: rows * cellSize },
    { x: cols * cellSize, y: rows * cellSize },
  ];

  function embeddedIn(p: { x: number; y: number }): boolean {
    return walls.some((w) => p.x > w.minX && p.x < w.maxX && p.y > w.minY && p.y < w.maxY);
  }

  for (const bounces of [NORMAL_BOUNCES, RICOCHET_BOUNCES]) {
    it(`leaves no shell embedded in a wall at any corner (${bounces} bounces)`, () => {
      for (const c of corners) {
        // Aim diagonally outward through the corner, from the corner itself -- which is
        // where `start` lands after the first reflection.
        for (const s of [-1, 1]) {
          for (const t of [-1, 1]) {
            const r = reflectSweep(c, { x: c.x + s * 0.25, y: c.y + t * 0.25 }, walls, bounces);
            expect(
              embeddedIn(r.end),
              `corner ${JSON.stringify(c)} dir ${s},${t} ended at ${JSON.stringify(r.end)}`,
            ).toBe(false);
          }
        }
      }
    });
  }

  it('never reports a shell as still live after it has crossed a wall', () => {
    for (const c of corners) {
      const r = reflectSweep(c, { x: c.x - 0.25, y: c.y - 0.25 }, walls, RICOCHET_BOUNCES);
      // Either it bounced and stayed inside, or it is expired so stepBullets retires it.
      expect(embeddedIn(r.end) && !r.expired).toBe(false);
    }
  });
});
