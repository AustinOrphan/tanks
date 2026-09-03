// @vitest-environment jsdom
// This writes onto an object another system owns (entities.ts's barrel mesh), so "does it
// put the gun back" is a correctness question, not a taste one. It is also no longer
// dev-only: since issue #526 the recoil is shipped behaviour on every shot, which raises
// the stakes on every rest assertion below -- a leaked offset now reaches every player.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createBarrelRecoilSystem, type BarrelSource } from './barrel-recoil';
import { createWorld, type World } from '../sim/world';
import type { Tank } from '../sim/types';
import type { SimEvent } from '../sim/events';

function tank(id: number, kind: string, alive = true): Tank {
  return {
    id, kind, pos: { x: id, y: 0 }, bodyAngle: 0, turretAngle: 0, alive,
    desiredMove: { x: 0, y: 0 }, activeMineIds: [], fireCooldown: 0, mineCooldown: 0,
    aiState: 'idle', aiTimer: 0,
  } as unknown as Tank;
}
const world = (tanks: Tank[]): World => createWorld({ walls: [], tanks, spawns: [], lives: 3 });
const blocked = (ownerId: number): SimEvent =>
  ({ type: 'fire-blocked', ownerId, reason: 'shell-cap' }) as SimEvent;
const fired = (ownerId: number): SimEvent => ({ type: 'fire', ownerId }) as SimEvent;

/** A stand-in for EntityViews: one barrel object per tank id, or none at all. */
function barrelSource(ids: number[] = [1]): BarrelSource & { barrels: Map<number, THREE.Object3D> } {
  const barrels = new Map<number, THREE.Object3D>();
  for (const id of ids) barrels.set(id, new THREE.Object3D());
  return { barrels, barrelOf: (id) => barrels.get(id) ?? null };
}
/**
 * How far BACK the gun currently sits, in world units. Recoil is -x by construction.
 * Written as a subtraction rather than a negation so an untouched barrel reads as +0:
 * `-0` is not `Object.is`-equal to `0`, and every rest assertion below wants exactness.
 */
const recoil = (src: { barrels: Map<number, THREE.Object3D> }, id = 1): number =>
  0 - (src.barrels.get(id) as THREE.Object3D).position.x;

describe('barrel recoil (issue #526, parent #356)', () => {
  it('stays at rest until the gun actually cycles', () => {
    // No flag gates this system any more, so "nothing happens by default" has to be
    // proven against the EVENT stream rather than against an absent cue. An unrelated
    // event must not move the gun.
    const src = barrelSource();
    const sys = createBarrelRecoilSystem(src);
    sys.spawn([{ type: 'tank-destroyed', tankId: 1 } as SimEvent], world([tank(1, 'player')]));
    sys.update(0.04);
    expect(recoil(src)).toBe(0);
  });

  it('kicks on a SHOT and on a REFUSAL alike -- that is the whole ruling', () => {
    // Issue #526's inversion. Before it, the kick was a refusal cue and a normal shot did
    // nothing; a reader who assumes the old shape would expect `fire` to be ignored here.
    // The refusal now reads because the shell and flash are MISSING from a motion the
    // player already knows, so both events must drive the identical gesture.
    for (const event of [fired, blocked]) {
      const src = barrelSource();
      const sys = createBarrelRecoilSystem(src);
      sys.spawn([event(1)], world([tank(1, 'player')]));
      sys.update(0.04);
      expect(recoil(src), event === fired ? 'fire' : 'fire-blocked').toBeGreaterThan(0);
    }
    // ...and identically: the same elapsed time yields the same offset for either event,
    // so nothing distinguishes a refusal except what does NOT accompany it.
    const a = barrelSource(), b = barrelSource();
    const sysA = createBarrelRecoilSystem(a), sysB = createBarrelRecoilSystem(b);
    sysA.spawn([fired(1)], world([tank(1, 'player')]));
    sysB.spawn([blocked(1)], world([tank(1, 'player')]));
    sysA.update(0.05);
    sysB.update(0.05);
    expect(recoil(a)).toBe(recoil(b));
  });

  it('recoils EVERY living tank, enemies included, and never a dead one', () => {
    // The other half of #526's inversion, and the assertion most likely to be reverted by
    // someone porting the old arm forward: as a refusal cue this was PLAYER-ONLY, because
    // an enemy's refusal leaked the enemy's ammunition state. Firing is already visible,
    // so that reason does not survive -- an enemy gun that stayed rigid while the
    // player's kicked would be the odd thing on screen.
    const src = barrelSource([1, 2, 3]);
    const sys = createBarrelRecoilSystem(src);
    const w = world([tank(1, 'player'), tank(2, 'brown'), tank(3, 'player', false)]);
    sys.spawn([fired(1), fired(2), fired(3)], w);
    sys.update(0.04);
    expect(recoil(src, 1), 'player').toBeGreaterThan(0);
    expect(recoil(src, 2), 'enemy').toBeGreaterThan(0);
    // A dead tank's view is being torn down or replaced; kicking it animates a corpse.
    expect(recoil(src, 3), 'dead').toBe(0);
  });

  it('recoils BACKWARD along the bore, never forward', () => {
    // The design claim. The barrel points down the turret's local +x (entities.ts), so a
    // recoil is negative x for the whole gesture: a signed sine here would lunge the gun
    // at the target on half of every cycle, which reads as a thrust rather than a kick.
    const src = barrelSource();
    const sys = createBarrelRecoilSystem(src);
    sys.spawn([fired(1)], world([tank(1, 'player')]));
    for (let i = 0; i < 15; i++) {
      sys.update(0.01);
      expect(recoil(src), `sample ${i}`).toBeGreaterThanOrEqual(0);
    }
  });

  it('STUTTERS -- two decaying bumps, not one push', () => {
    // What makes it read as a mechanism rather than a nudge. Sampled across the whole
    // life; a single hump (dropping the oscillation, or the `abs`) fails on the bump
    // count, and dropping the (1 - k) decay fails on the second bump being smaller.
    const src = barrelSource();
    const sys = createBarrelRecoilSystem(src);
    sys.spawn([fired(1)], world([tank(1, 'player')]));
    const samples: number[] = [];
    for (let i = 0; i < 16; i++) {
      sys.update(0.01);
      samples.push(recoil(src));
    }
    const peaks: number[] = [];
    for (let i = 1; i < samples.length - 1; i++) {
      if (samples[i] > samples[i - 1] && samples[i] >= samples[i + 1]) peaks.push(samples[i]);
    }
    expect(peaks).toHaveLength(2);
    expect(peaks[1]).toBeLessThan(peaks[0]);
    // ...and the whole gesture stays small: this is a gun rocking, not a tube sliding out
    // of its ring. The turret's own radius is 0.36 world units and the hull is 1 long;
    // the measured first bump is ~0.098, so a third of the turret radius is a bound that
    // fails on a retune into absurdity without pinning the feel constant itself.
    expect(Math.max(...samples)).toBeLessThan(0.12);
  });

  it('puts the gun back at EXACTLY rest when the recoil ends', () => {
    // The correctness half, and it matters more now than it did as a dev-flagged arm:
    // this writes onto entities.ts's own barrel object, on an axis `sync` never
    // reassigns, so an offset left behind is permanent -- the tank drives around for the
    // rest of the match with its gun short, on every player's screen.
    const src = barrelSource();
    const sys = createBarrelRecoilSystem(src);
    sys.spawn([fired(1)], world([tank(1, 'player')]));
    sys.update(0.08);
    expect(recoil(src)).toBeGreaterThan(0);
    sys.update(0.2);
    expect(recoil(src)).toBe(0);
    // ...and it stops there: no further frame re-applies an offset.
    sys.update(0.02);
    expect(recoil(src)).toBe(0);
  });

  it('restarts on a second shot rather than queueing one behind the other', () => {
    // The weapon can fire again before 0.16s is up, so overlapping recoils are ordinary,
    // not exotic. One entry per tank: the new shot resets the gesture to its first bump
    // instead of continuing the old one toward rest.
    const src = barrelSource();
    const sys = createBarrelRecoilSystem(src);
    const w = world([tank(1, 'player')]);
    sys.spawn([fired(1)], w);
    sys.update(0.14);
    const nearlyDone = recoil(src);
    sys.spawn([fired(1)], w);
    sys.update(0.02);
    expect(recoil(src)).toBeGreaterThan(nearlyDone);
  });

  it('drops a recoil whose barrel disappeared, without throwing', () => {
    // A view is rebuilt whenever the tank's kind or the player's paint generation changes,
    // and destroyed when the tank dies -- both reachable inside a 0.16s recoil. The offset
    // lives on an object this system does not own, so a vanished barrel is a no-op, not a
    // crash and not a latched reference to a corpse.
    const src = barrelSource();
    const sys = createBarrelRecoilSystem(src);
    sys.spawn([fired(1)], world([tank(1, 'player')]));
    sys.update(0.02);
    src.barrels.delete(1);
    expect(() => sys.update(0.02)).not.toThrow();
    // A barrel rebuilt at the same id starts at rest and is NOT written to by the
    // abandoned recoil.
    src.barrels.set(1, new THREE.Object3D());
    sys.update(0.02);
    expect(recoil(src)).toBe(0);
  });

  it('reduced motion holds ONE static offset instead of oscillating', () => {
    // #453's policy is "keep the cue, remove the travel", and a recoil has nothing left if
    // the travel goes entirely -- so the animated stutter becomes a single held offset the
    // gun returns from once. Constant across frames is the assertion: any oscillation
    // surviving the preference fails here.
    const src = barrelSource();
    const sys = createBarrelRecoilSystem(src);
    sys.setReducedMotion(true);
    sys.spawn([fired(1)], world([tank(1, 'player')]));
    sys.update(0.02);
    const held = recoil(src);
    expect(held).toBeGreaterThan(0);
    for (let i = 0; i < 5; i++) {
      sys.update(0.02);
      expect(recoil(src)).toBe(held);
    }
    // ...and it still returns to rest at the end, rather than parking there.
    sys.update(0.2);
    expect(recoil(src)).toBe(0);
  });

  it('snaps an ALREADY-RUNNING recoil to the held offset when the preference flips', () => {
    // The case the test above cannot see: it sets the preference BEFORE spawning. The
    // preference is a live media query and can flip mid-gesture -- the landmine
    // blocked-fire-ring.ts records, where skipping the term froze the effect instead of
    // moving it to rest.
    const src = barrelSource();
    const sys = createBarrelRecoilSystem(src);
    sys.spawn([fired(1)], world([tank(1, 'player')]));
    sys.update(0.04);
    const midFlight = recoil(src);
    sys.setReducedMotion(true);
    sys.update(0.01);
    expect(recoil(src)).not.toBe(midFlight);
    const held = recoil(src);
    sys.update(0.01);
    expect(recoil(src)).toBe(held);
  });

  it('dispose returns every live barrel to rest', () => {
    // Renderer teardown mid-recoil: the barrel objects outlive this system only in the
    // sense that entities.ts disposes them itself, but a renderer rebuilt around the same
    // scene must never inherit an offset from a gesture that no longer exists.
    const src = barrelSource([1, 2]);
    const sys = createBarrelRecoilSystem(src);
    sys.spawn([fired(1), fired(2)], world([tank(1, 'player'), tank(2, 'brown')]));
    sys.update(0.04);
    expect(recoil(src, 1)).toBeGreaterThan(0);
    expect(recoil(src, 2)).toBeGreaterThan(0);
    sys.dispose();
    expect(recoil(src, 1)).toBe(0);
    expect(recoil(src, 2)).toBe(0);
  });
});
