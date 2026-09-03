// @vitest-environment jsdom
// Dev-only is not untested: this is one of the arms issue #356's ruling will be made from.
// It is also the one arm that writes onto an object another system owns (entities.ts's
// turret group), so "does it put the gun back" is a correctness question, not a taste one.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createBlockedFireTurretSystem, type TurretSource } from './blocked-fire-turret';
import { createWorld, type World } from '../sim/world';
import type { Tank } from '../sim/types';
import type { SimEvent } from '../sim/events';
import { BLOCKED_FIRE_CUES, type BlockedFireCue } from '../presentation/blocked-fire';

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

/** A stand-in for EntityViews: one turret object per tank id, or none at all. */
function turretSource(ids: number[] = [1]): TurretSource & { turrets: Map<number, THREE.Object3D> } {
  const turrets = new Map<number, THREE.Object3D>();
  for (const id of ids) turrets.set(id, new THREE.Object3D());
  return { turrets, turretOf: (id) => turrets.get(id) ?? null };
}
/**
 * How far BACK the gun currently sits, in world units. Recoil is -x by construction.
 * Written as a subtraction rather than a negation so an untouched turret reads as +0:
 * `-0` is not `Object.is`-equal to `0`, and every rest assertion below wants exactness.
 */
const recoil = (src: { turrets: Map<number, THREE.Object3D> }, id = 1): number =>
  0 - (src.turrets.get(id) as THREE.Object3D).position.x;

describe('blocked-fire turret stutter (issue #516, parent #356)', () => {
  it('does nothing when the flag is absent', () => {
    // The shipped default every arm shares: none may become the cue by being wired first.
    const src = turretSource();
    const sys = createBlockedFireTurretSystem(src);
    const w = world([tank(1, 'player')]);
    for (const cue of [null, undefined] as const) {
      sys.spawn([blocked(1)], w, cue);
    }
    sys.update(0.04);
    expect(recoil(src)).toBe(0);
  });

  it('kicks for EVERY cue carrying `turret`, and for no other -- one row per cue', () => {
    // The table every blocked-fire consumer keeps. See blocked-fire-muzzle.test.ts's own
    // copy for why it is keyed off BLOCKED_FIRE_CUES rather than written per remembered
    // case, and why the other four visual arms stay false here however they look.
    const carriesTurret: Record<BlockedFireCue, boolean> = {
      turret: true,
      ring: false,
      'ring-audio': false,
      muzzle: false,
      pips: false,
      hud: false,
      audio: false,
      click: false,
      clunk: false,
      'thunk-soft': false,
      'pitch-empty': false,
      haptic: false,
      'haptic-tap': false,
      'haptic-double': false,
      'haptic-long': false,
      'haptic-rise': false,
      'haptic-audio': false,
    };
    expect(Object.keys(carriesTurret).sort()).toEqual([...BLOCKED_FIRE_CUES].sort());
    for (const [cue, shouldKick] of Object.entries(carriesTurret)) {
      const src = turretSource();
      const sys = createBlockedFireTurretSystem(src);
      sys.spawn([blocked(1)], world([tank(1, 'player')]), cue as BlockedFireCue);
      sys.update(0.04);
      expect(recoil(src) > 0, cue).toBe(shouldKick);
    }
  });

  it('recoils BACKWARD along the bore, never forward', () => {
    // The design claim. The barrel points down the turret's local +x (entities.ts), so a
    // recoil is negative x for the whole gesture: a signed sine here would lunge the gun
    // at the target on half of every cycle, which reads as firing, not as refusing.
    const src = turretSource();
    const sys = createBlockedFireTurretSystem(src);
    sys.spawn([blocked(1)], world([tank(1, 'player')]), 'turret');
    for (let i = 0; i < 15; i++) {
      sys.update(0.01);
      expect(recoil(src), `sample ${i}`).toBeGreaterThanOrEqual(0);
    }
  });

  it('STUTTERS -- two decaying bumps, not one push', () => {
    // What separates this arm from a nudge, and the reason it is a candidate at all: a
    // mechanism that cycled reads as two beats. Sampled across the whole life; a single
    // hump (dropping the oscillation, or the `abs`) fails on the bump count, and dropping
    // the (1 - k) decay fails on the second bump being smaller.
    const src = turretSource();
    const sys = createBlockedFireTurretSystem(src);
    sys.spawn([blocked(1)], world([tank(1, 'player')]), 'turret');
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
    // ...and the whole gesture stays small: this is a gun rocking, not a turret sliding
    // off its ring. The turret's own radius is 0.36 world units and the hull is 1 long;
    // the measured first bump is ~0.098, so a third of the turret radius is a bound that
    // fails on a retune into absurdity without pinning the feel constant itself.
    expect(Math.max(...samples)).toBeLessThan(0.12);
  });

  it('puts the gun back at EXACTLY rest when the stutter ends', () => {
    // The correctness half. This system writes onto entities.ts's own turret object, on
    // an axis `sync` never reassigns, so an offset left behind at the end is permanent:
    // the tank drives around for the rest of the match with its turret off-centre.
    const src = turretSource();
    const sys = createBlockedFireTurretSystem(src);
    sys.spawn([blocked(1)], world([tank(1, 'player')]), 'turret');
    sys.update(0.08);
    expect(recoil(src)).toBeGreaterThan(0);
    sys.update(0.2);
    expect(recoil(src)).toBe(0);
    // ...and it stops there: no further frame re-applies an offset.
    sys.update(0.02);
    expect(recoil(src)).toBe(0);
  });

  it('ignores an AI refusal and a dead tank', () => {
    // `fire-blocked` is emitted for whoever was refused, AI included. An enemy's gun
    // twitching would report the ENEMY's ammunition to the player.
    const src = turretSource([1, 2]);
    const sys = createBlockedFireTurretSystem(src);
    sys.spawn([blocked(1)], world([tank(1, 'brown')]), 'turret');
    sys.spawn([blocked(2)], world([tank(2, 'player', false)]), 'turret');
    sys.update(0.04);
    expect(recoil(src, 1)).toBe(0);
    expect(recoil(src, 2)).toBe(0);
  });

  it('drops a stutter whose turret disappeared, without throwing', () => {
    // A view is rebuilt whenever the tank's kind or the player's paint generation changes,
    // and destroyed when the tank dies -- both reachable inside a 0.16s stutter. The
    // offset lives on an object this system does not own, so a vanished turret is a
    // no-op, not a crash and not a latched reference to a corpse.
    const src = turretSource();
    const sys = createBlockedFireTurretSystem(src);
    sys.spawn([blocked(1)], world([tank(1, 'player')]), 'turret');
    sys.update(0.02);
    src.turrets.delete(1);
    expect(() => sys.update(0.02)).not.toThrow();
    // A turret rebuilt at the same id starts at rest and is NOT written to by the
    // abandoned stutter.
    src.turrets.set(1, new THREE.Object3D());
    sys.update(0.02);
    expect(recoil(src)).toBe(0);
  });

  it('reduced motion holds ONE static offset instead of oscillating', () => {
    // #453's policy is "keep the cue, remove the travel", and a recoil has nothing left if
    // the travel goes entirely -- so the animated stutter becomes a single held offset the
    // gun returns from once. Constant across frames is the assertion: any oscillation
    // surviving the preference fails here.
    const src = turretSource();
    const sys = createBlockedFireTurretSystem(src);
    sys.setReducedMotion(true);
    sys.spawn([blocked(1)], world([tank(1, 'player')]), 'turret');
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

  it('snaps an ALREADY-RUNNING stutter to the held offset when the preference flips', () => {
    // The case the test above cannot see: it sets the preference BEFORE spawning. The
    // preference is a live media query and can flip mid-gesture -- the landmine
    // blocked-fire-ring.ts records, where skipping the term froze the effect instead of
    // moving it to rest.
    const src = turretSource();
    const sys = createBlockedFireTurretSystem(src);
    sys.spawn([blocked(1)], world([tank(1, 'player')]), 'turret');
    sys.update(0.04);
    const midFlight = recoil(src);
    sys.setReducedMotion(true);
    sys.update(0.01);
    expect(recoil(src)).not.toBe(midFlight);
    const held = recoil(src);
    sys.update(0.01);
    expect(recoil(src)).toBe(held);
  });

  it('dispose returns every live turret to rest', () => {
    // Renderer teardown mid-stutter: the turret objects outlive this system only in the
    // sense that entities.ts disposes them itself, but a renderer rebuilt around the same
    // scene must never inherit an offset from a cue that no longer exists.
    const src = turretSource();
    const sys = createBlockedFireTurretSystem(src);
    sys.spawn([blocked(1)], world([tank(1, 'player')]), 'turret');
    sys.update(0.04);
    expect(recoil(src)).toBeGreaterThan(0);
    sys.dispose();
    expect(recoil(src)).toBe(0);
  });
});
