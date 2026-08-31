// Bounded last-seen contact memory (issue #372).
//
// The contract is six states -- visible, remembered, reacquired, expired, invalidated, and
// no-contact -- plus the one thing the memory must never become: a way to read where the
// target is NOW. That last case is why the fixtures below move the target while it is out of
// sight; a memory that tracked it would be indistinguishable from one that did not, in any
// fixture where the target stands still.
import { describe, it, expect } from 'vitest';
import { updateTargetMemory, rememberedContact, memoryAim } from './target-memory';
import { AI_LAST_SEEN_TICKS } from '../constants';
import { angleOf, vsub } from '../types';
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
/** A solid slab between (0,0) and anything out at +x. */
/**
 * A solid slab tall enough to occlude everything at +x, at any y these fixtures use.
 *
 * Deliberately oversized: an earlier version spanned y -5..5, and the case that moves the
 * target to (8,20) while "hidden" simply walked it out of the slab shadow -- line of sight
 * came back, the memory legitimately refreshed, and the test failed for a fixture reason
 * rather than a behaviour one.
 */
const BLOCKER = { id: 1, aabb: { minX: 3, minY: -200, maxX: 4, maxY: 200 }, kind: 'solid' as const, destroyed: false };

describe('last-seen contact memory', () => {
  it('VISIBLE: records the position actually observed, with a full span', () => {
    const ai = tank(1, 'grey', { x: 0, y: 0 });
    const foe = tank(2, 'player', { x: 8, y: 2 });
    updateTargetMemory(world([ai, foe]), ai, foe);
    expect(rememberedContact(ai)).toEqual({ x: 8, y: 2 });
    expect(ai.aiLastSeenTicks).toBe(AI_LAST_SEEN_TICKS);
  });

  it('REMEMBERED: the point FREEZES when sight breaks, and does not follow the target', () => {
    // The anti-omniscience case. The target moves a long way while hidden; the remembered
    // point must be where it was last seen, not where it is.
    const ai = tank(1, 'grey', { x: 0, y: 0 });
    const foe = tank(2, 'player', { x: 8, y: 2 });
    updateTargetMemory(world([ai, foe]), ai, foe);
    const seenAt = { ...(rememberedContact(ai) as Vec2) };

    const blocked = world([ai, foe], { walls: [BLOCKER] });
    for (let i = 0; i < 10; i++) {
      foe.pos = { x: foe.pos.x, y: foe.pos.y - 1 }; // walking away, unseen
      updateTargetMemory(blocked, ai, foe);
    }
    expect(rememberedContact(ai)).toEqual(seenAt);
    expect(rememberedContact(ai)).not.toEqual(foe.pos);
    expect(ai.aiLastSeenTicks).toBe(AI_LAST_SEEN_TICKS - 10); // ...and it is ageing
  });

  it('REACQUIRED: fresh sight replaces the remembered point outright and re-arms the span', () => {
    const ai = tank(1, 'grey', { x: 0, y: 0 });
    const foe = tank(2, 'player', { x: 8, y: 2 });
    const blocked = world([ai, foe], { walls: [BLOCKER] });
    updateTargetMemory(world([ai, foe]), ai, foe);
    for (let i = 0; i < 30; i++) updateTargetMemory(blocked, ai, foe);
    expect(ai.aiLastSeenTicks).toBe(AI_LAST_SEEN_TICKS - 30);

    foe.pos = { x: 9, y: -4 };
    updateTargetMemory(world([ai, foe]), ai, foe); // clear line again
    expect(rememberedContact(ai)).toEqual({ x: 9, y: -4 });
    expect(ai.aiLastSeenTicks).toBe(AI_LAST_SEEN_TICKS);
  });

  it('EXPIRED: the contact is dropped after exactly its span, not before', () => {
    const ai = tank(1, 'grey', { x: 0, y: 0 });
    const foe = tank(2, 'player', { x: 8, y: 2 });
    updateTargetMemory(world([ai, foe]), ai, foe);
    const blocked = world([ai, foe], { walls: [BLOCKER] });
    for (let i = 0; i < AI_LAST_SEEN_TICKS - 1; i++) updateTargetMemory(blocked, ai, foe);
    expect(rememberedContact(ai)).not.toBeNull(); // still remembered on the last tick of the span
    updateTargetMemory(blocked, ai, foe);
    expect(rememberedContact(ai)).toBeNull();
    expect(memoryAim(ai)).toBeNull();
    expect(ai.aiLastSeenPos).toBeUndefined(); // cleared, not merely aged to zero
  });

  it('INVALIDATED: a dead or absent target is forgotten at once, mid-span', () => {
    // Not left to expire: a tank still staring at where a corpse used to be reads as broken
    // rather than attentive, and the span would keep it there for a second and a half.
    const ai = tank(1, 'grey', { x: 0, y: 0 });
    const foe = tank(2, 'player', { x: 8, y: 2 });
    updateTargetMemory(world([ai, foe]), ai, foe);
    expect(rememberedContact(ai)).not.toBeNull();
    foe.alive = false;
    updateTargetMemory(world([ai, foe]), ai, foe);
    expect(rememberedContact(ai)).toBeNull();

    // ...and the same for a tank whose committed target resolved to nothing at all.
    const other = tank(3, 'grey', { x: 0, y: 0 });
    updateTargetMemory(world([other, foe]), other, foe);
    updateTargetMemory(world([other]), other, undefined);
    expect(rememberedContact(other)).toBeNull();
  });

  it('NO CONTACT: a tank that has never seen anything remembers nothing', () => {
    const ai = tank(1, 'grey', { x: 0, y: 0 });
    expect(rememberedContact(ai)).toBeNull();
    expect(memoryAim(ai)).toBeNull();
    // A target it cannot see does not create a memory either -- memory records observation,
    // not existence.
    const foe = tank(2, 'player', { x: 8, y: 2 });
    updateTargetMemory(world([ai, foe], { walls: [BLOCKER] }), ai, foe);
    expect(rememberedContact(ai)).toBeNull();
  });

  it('the aim it produces points at the REMEMBERED place, not the target', () => {
    const ai = tank(1, 'grey', { x: 0, y: 0 });
    const foe = tank(2, 'player', { x: 8, y: 0 });
    updateTargetMemory(world([ai, foe]), ai, foe);
    const blocked = world([ai, foe], { walls: [BLOCKER] });
    foe.pos = { x: 8, y: 20 }; // moved hard off the remembered bearing while unseen
    updateTargetMemory(blocked, ai, foe);
    expect(memoryAim(ai)).toBeCloseTo(angleOf(vsub({ x: 8, y: 0 }, ai.pos)), 10);
    expect(memoryAim(ai)).not.toBeCloseTo(angleOf(vsub(foe.pos, ai.pos)), 2);
  });
});
