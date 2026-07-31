import { describe, it, expect } from 'vitest';
import { wallConfigFor, GAME_WALL_DEFS } from './walls';
import { createCatalog } from './catalog';

describe('wall catalog (behaviour-preservation pins)', () => {
  it('destructibleByBlast mirrors the kind rule the mine system used to hardcode', () => {
    // detonateMine destroys a wall iff this is true; flipping either value makes
    // destructibles blast-proof or solids demolishable -- game-defining changes.
    expect(wallConfigFor('destructible').destructibleByBlast).toBe(true);
    expect(wallConfigFor('solid').destructibleByBlast).toBe(false);
  });

  it('parses to the exact 0xRRGGBB numbers the renderer used to hardcode', () => {
    // entities.ts renders parseInt(color.slice(1), 16); pin the number THREE
    // receives, same treatment as the tank colours in roster.test.ts.
    const asNumber = (k: 'solid' | 'destructible') => parseInt(wallConfigFor(k).color.slice(1), 16);
    expect(asNumber('solid')).toBe(0x565b66);
    expect(asNumber('destructible')).toBe(0xb08040);
  });

  it('covers every WallKind (a new kind must be defined here to compile at all)', () => {
    // GAME_WALL_DEFS is Record<WallKind, ...>, so this is belt-and-braces over the
    // type system: the runtime object really carries both keys.
    expect(Object.keys(GAME_WALL_DEFS).sort()).toEqual(['destructible', 'solid']);
  });
});

describe('createCatalog (the generic machinery both families ride on)', () => {
  it('resolves each key exactly once, at creation', () => {
    const calls: string[] = [];
    const cat = createCatalog({ a: 1, b: 2 }, (k, defs) => {
      calls.push(k);
      return defs[k] * 10;
    });
    expect(calls.sort()).toEqual(['a', 'b']);
    expect(cat.get('a')).toBe(10);
    expect(cat.get('b')).toBe(20);
    cat.get('a');
    expect(calls.length).toBe(2); // no re-resolution on read
  });

  it('get returns the same resolved object on every read (stable identity)', () => {
    const cat = createCatalog({ x: 1 }, (k, defs) => ({ v: defs[k] }));
    expect(cat.get('x')).toBe(cat.get('x'));
  });
});
