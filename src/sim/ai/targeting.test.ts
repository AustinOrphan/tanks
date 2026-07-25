import { describe, it, expect } from 'vitest';
import { lineOfSight, aimLead } from './targeting';
import type { Wall } from '../types';

function wall(id: number, minX: number, minY: number, maxX: number, maxY: number,
             kind: 'solid' | 'destructible' = 'solid', destroyed = false): Wall {
  return { id, aabb: { minX, minY, maxX, maxY }, kind, destroyed };
}

describe('lineOfSight', () => {
  it('is blocked by a solid wall between the two points', () => {
    const walls = [wall(1, 1.5, -1, 2.5, 1)];
    expect(lineOfSight({ x: 0, y: 0 }, { x: 4, y: 0 }, walls)).toBe(false);
  });

  it('is clear through a gap between walls', () => {
    const walls = [wall(1, 1.5, 1, 2.5, 3), wall(2, 1.5, -3, 2.5, -1)];
    expect(lineOfSight({ x: 0, y: 0 }, { x: 4, y: 0 }, walls)).toBe(true);
  });

  it('is clear once the blocking wall is destroyed', () => {
    const walls = [wall(1, 1.5, -1, 2.5, 1, 'destructible', true)];
    expect(lineOfSight({ x: 0, y: 0 }, { x: 4, y: 0 }, walls)).toBe(true);
  });
});

describe('aimLead', () => {
  it('aims directly at a stationary target', () => {
    const angle = aimLead({ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 0, y: 0 }, 6);
    expect(angle).toBeCloseTo(0, 6);
  });

  it('leads a crossing target ahead of its current position', () => {
    // target at (5,0) moving +y; the intercept must be at positive y, so angle > 0
    const angle = aimLead({ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 0, y: 3 }, 6);
    expect(angle).toBeGreaterThan(0);
    expect(angle).toBeLessThan(Math.PI / 2);
  });

  it('returns a sane direct-aim angle when no intercept exists (target faster than bullet)', () => {
    const angle = aimLead({ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 100, y: 0 }, 6);
    expect(Number.isNaN(angle)).toBe(false);
    expect(angle).toBeCloseTo(0, 6); // falls back to direct aim
  });
});
