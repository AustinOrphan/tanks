import { describe, it, expect } from 'vitest';
import type { SimEvent } from './events';

// Exhaustive switch: compiles ONLY if every SimEvent kind is handled.
// The `never` default is a compile-time guarantee for all downstream consumers.
function label(e: SimEvent): string {
  switch (e.type) {
    case 'fire': return 'fire';
    case 'ricochet': return 'ricochet';
    case 'explosion': return 'explosion';
    case 'mine-dropped': return 'mine-dropped';
    case 'mine-armed': return 'mine-armed';
    case 'mine-detonate': return 'mine-detonate';
    case 'tank-destroyed': return 'tank-destroyed';
    case 'wall-destroyed': return 'wall-destroyed';
    case 'win': return 'win';
    case 'lose': return 'lose';
    default: {
      const _never: never = e;
      return _never;
    }
  }
}

describe('SimEvent', () => {
  it('labels representative events across the union', () => {
    const events: SimEvent[] = [
      { type: 'fire', ownerId: 1, bulletType: 'normal', pos: { x: 0, y: 0 }, angle: 0 },
      { type: 'ricochet', ownerId: 1, pos: { x: 1, y: 1 }, bounceIndex: 2 },
      { type: 'explosion', pos: { x: 2, y: 2 } },
      { type: 'mine-dropped', mineId: 7, ownerId: 1, pos: { x: 3, y: 3 } },
      { type: 'mine-armed', mineId: 7, ownerId: 1, pos: { x: 3, y: 3 } },
      { type: 'mine-detonate', mineId: 7, ownerId: 1, pos: { x: 3, y: 3 } },
      { type: 'tank-destroyed', tankId: 4, kind: 'brown', by: { source: 'shell', ownerId: 9 }, pos: { x: 4, y: 4 } },
      { type: 'wall-destroyed', wallId: 9, ownerId: 1, pos: { x: 5, y: 5 } },
      { type: 'win' },
      { type: 'lose' },
    ];
    expect(events.map(label)).toEqual([
      'fire', 'ricochet', 'explosion', 'mine-dropped', 'mine-armed', 'mine-detonate',
      'tank-destroyed', 'wall-destroyed', 'win', 'lose',
    ]);
  });
});
