// @vitest-environment jsdom
// Dev-only is not untested: this is one of the arms issue #356's ruling will be made from,
// and the only one that claims to STATE THE REASON rather than merely mark the moment. A
// strip that showed the wrong count would answer the issue's hardest question ("did the
// player infer capacity full?") with a number that is not true.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createBlockedFirePipsSystem, SPENT_COLOR, FREE_COLOR } from './blocked-fire-pips';
import { createWorld, type World } from '../sim/world';
import { configFor } from '../sim/config';
import type { Bullet, Tank } from '../sim/types';
import type { SimEvent } from '../sim/events';
import { BLOCKED_FIRE_CUES, type BlockedFireCue } from '../presentation/blocked-fire';

const CAP = configFor('player').weapon.maxActiveProjectiles;

function tank(id: number, kind: string, alive = true, pos = { x: id, y: 0 }): Tank {
  return {
    id, kind, pos, bodyAngle: 0, turretAngle: 0, alive,
    desiredMove: { x: 0, y: 0 }, activeMineIds: [], fireCooldown: 0, mineCooldown: 0,
    aiState: 'idle', aiTimer: 0,
  } as unknown as Tank;
}
const bullet = (id: number, ownerId: number, alive = true): Bullet =>
  ({ id, ownerId, type: 'normal', pos: { x: 0, y: 0 }, vel: { x: 1, y: 0 }, bouncesLeft: 1, alive }) as Bullet;
function world(tanks: Tank[], bullets: Bullet[] = []): World {
  const w = createWorld({ walls: [], tanks, spawns: [], lives: 3 });
  w.bullets.push(...bullets);
  return w;
}
const blocked = (ownerId: number): SimEvent =>
  ({ type: 'fire-blocked', ownerId, reason: 'shell-cap' }) as SimEvent;

type PipMesh = THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
const strips = (s: THREE.Scene): THREE.Object3D[] =>
  s.children.filter((o) => o.name === 'blocked-fire-pips' && o.visible);
const pipsOf = (s: THREE.Scene): PipMesh[] => (strips(s)[0]?.children ?? []) as PipMesh[];
const litCount = (s: THREE.Scene): number =>
  pipsOf(s).filter((p) => p.material.color.getHex() === SPENT_COLOR).length;
/** A full magazine: every slot the resolved config allows, in the air. */
const fullLoad = (ownerId: number): Bullet[] =>
  Array.from({ length: CAP }, (_, i) => bullet(100 + i, ownerId));

describe('blocked-fire capacity pips (issue #516, parent #356)', () => {
  it('draws nothing when the flag is absent', () => {
    // The shipped default every arm shares: none may become the cue by being wired first.
    const scene = new THREE.Scene();
    const sys = createBlockedFirePipsSystem(scene);
    const w = world([tank(1, 'player')], fullLoad(1));
    for (const cue of [null, undefined] as const) {
      sys.spawn([blocked(1)], w, cue);
    }
    expect(strips(scene)).toHaveLength(0);
  });

  it('draws for EVERY cue carrying `pips`, and for no other -- one row per cue', () => {
    // The table every blocked-fire consumer keeps. See blocked-fire-muzzle.test.ts's own
    // copy for why it is keyed off BLOCKED_FIRE_CUES rather than written per remembered
    // case, and why the other visual arms stay false here however they look.
    const carriesPips: Record<BlockedFireCue, boolean> = {
      pips: true,
      ring: false,
      'ring-audio': false,
      muzzle: false,
      smoke: false,
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
    expect(Object.keys(carriesPips).sort()).toEqual([...BLOCKED_FIRE_CUES].sort());
    for (const [cue, shouldDraw] of Object.entries(carriesPips)) {
      const scene = new THREE.Scene();
      const sys = createBlockedFirePipsSystem(scene);
      sys.spawn([blocked(1)], world([tank(1, 'player')], fullLoad(1)), cue as BlockedFireCue);
      expect(strips(scene), cue).toHaveLength(shouldDraw ? 1 : 0);
    }
  });

  it('is as long as the resolved CAPACITY, with every shell in the air lit', () => {
    // The whole message: "5 of 5". Both numbers come from the expressions
    // `shellCapReached` itself is made of -- configFor(kind).weapon.maxActiveProjectiles
    // and ownerShellCount -- which is what #356 means by deriving the displayed capacity
    // from the same resolved configuration spawnBullet enforces.
    const scene = new THREE.Scene();
    const sys = createBlockedFirePipsSystem(scene);
    sys.spawn([blocked(1)], world([tank(1, 'player')], fullLoad(1)), 'pips');
    expect(pipsOf(scene)).toHaveLength(CAP);
    expect(litCount(scene)).toBe(CAP);
  });

  it('counts the OWNER\'s live shells, not the arena\'s traffic', () => {
    // The count is read, not assumed to equal the cap: a dead shell and another tank's
    // shell are not this tank's capacity. A refusal with fewer than CAP lit cannot happen
    // in play (the cap is what refused the shot), which is exactly why the count has to be
    // asserted against a doctored world -- a system that lit every pip unconditionally
    // would be indistinguishable in a real match and wrong the moment the cap is retuned.
    const scene = new THREE.Scene();
    const sys = createBlockedFirePipsSystem(scene);
    const w = world(
      [tank(1, 'player'), tank(2, 'brown')],
      [bullet(10, 1), bullet(11, 1), bullet(12, 1, false), bullet(13, 2)],
    );
    sys.spawn([blocked(1)], w, 'pips');
    expect(pipsOf(scene)).toHaveLength(CAP);
    expect(litCount(scene)).toBe(2);
    // The unlit slots are still DRAWN, dim: a strip of only the lit pips would be a
    // count, and the capacity is the half that explains the refusal.
    sys.update(0.01, w);
    const free = pipsOf(scene).filter((p) => p.material.color.getHex() === FREE_COLOR);
    expect(free).toHaveLength(CAP - 2);
    for (const p of free) expect(p.material.opacity).toBeLessThan(1);
    for (const p of pipsOf(scene)) expect(p.visible).toBe(true);
  });

  it('FOLLOWS its tank, rather than being stranded where the refusal happened', () => {
    // Half a second is long enough for a tank at full speed to leave a latched strip
    // behind it -- which is why this arm takes the world in `update` and the ring, which
    // lives 0.18s, does not.
    const scene = new THREE.Scene();
    const sys = createBlockedFirePipsSystem(scene);
    const player = tank(1, 'player', true, { x: 3, y: 4 });
    const w = world([player], fullLoad(1));
    sys.spawn([blocked(1)], w, 'pips');
    const strip = strips(scene)[0];
    expect(strip.position.x).toBeCloseTo(3, 9);
    player.pos = { x: 9, y: 4 };
    sys.update(0.01, w);
    expect(strip.position.x).toBeCloseTo(9, 9);
    // Flat on the felt, not floating in the tank: a strip at hull height sits over the
    // turret at this camera's angle and hides the barrel the player is aiming.
    expect(strip.position.y).toBeLessThan(0.1);
  });

  it('RETIRES the strip when its tank dies, or leaves the arena, mid-effect', () => {
    // The arm lives 0.55s, which is long enough to be shot in. Without this the strip
    // freezes where the tank died and stays lit for the rest of its life -- a capacity
    // readout for a tank that no longer exists and can hold no shells, which reads as a
    // rendering fault rather than as a cue. Both routes out of the world are covered: the
    // tank dying in place, and the tank being gone from `world.tanks` altogether.
    for (const kill of [
      (w: World) => { w.tanks[0].alive = false; },
      (w: World) => { w.tanks.length = 0; },
    ]) {
      const scene = new THREE.Scene();
      const sys = createBlockedFirePipsSystem(scene);
      const w = world([tank(1, 'player')], fullLoad(1));
      sys.spawn([blocked(1)], w, 'pips');
      sys.update(0.05, w);
      expect(strips(scene)).toHaveLength(1);
      kill(w);
      sys.update(0.05, w);
      expect(strips(scene)).toHaveLength(0);
      // ...and it stays gone: no later frame of the original life brings it back.
      sys.update(0.05, w);
      expect(strips(scene)).toHaveLength(0);
    }
  });

  it('ignores an AI refusal and a dead tank', () => {
    // `fire-blocked` is emitted for whoever was refused, AI included. Showing an enemy's
    // capacity would report the ENEMY's ammunition to the player.
    const scene = new THREE.Scene();
    const sys = createBlockedFirePipsSystem(scene);
    sys.spawn([blocked(1)], world([tank(1, 'brown')], fullLoad(1)), 'pips');
    sys.spawn([blocked(2)], world([tank(2, 'player', false)], fullLoad(2)), 'pips');
    expect(strips(scene)).toHaveLength(0);
  });

  it('HOLDS at full brightness, then fades, then retires', () => {
    // The design claim, and the reason this arm lives four times as long as the ring: it
    // is READ rather than noticed, and a strip that started fading on its first frame
    // would be dimmest exactly while the player was still working out what it says.
    const scene = new THREE.Scene();
    const sys = createBlockedFirePipsSystem(scene);
    const w = world([tank(1, 'player')], fullLoad(1));
    sys.spawn([blocked(1)], w, 'pips');
    sys.update(0.2, w);
    expect(pipsOf(scene)[0].material.opacity).toBe(1);
    sys.update(0.2, w);
    const fading = pipsOf(scene)[0].material.opacity;
    expect(fading).toBeLessThan(1);
    expect(fading).toBeGreaterThan(0);
    sys.update(0.2, w);
    expect(strips(scene)).toHaveLength(0);
    // Relit by a second refusal, reusing the same strip rather than leaking another.
    const groups = scene.children.length;
    sys.spawn([blocked(1)], w, 'pips');
    expect(strips(scene)).toHaveLength(1);
    expect(scene.children.length).toBe(groups);
  });

  it('reduced motion keeps the light and drops the pop', () => {
    // #453's policy: the flash is information, the size jump is motion.
    const scene = new THREE.Scene();
    const sys = createBlockedFirePipsSystem(scene);
    const w = world([tank(1, 'player')], fullLoad(1));
    sys.setReducedMotion(true);
    sys.spawn([blocked(1)], w, 'pips');
    sys.update(0.01, w);
    expect(pipsOf(scene)[0].scale.x).toBe(1);
    expect(pipsOf(scene)[0].material.opacity).toBe(1);
  });

  it('snaps an ALREADY-POPPING pip to rest when reduced motion turns on mid-flight', () => {
    // The case the test above cannot see: it sets the preference BEFORE spawning, so it
    // passes whether `update` skips the scale term or writes a rest scale -- the landmine
    // blocked-fire-ring.ts records, where the guard froze a live effect oversized.
    const scene = new THREE.Scene();
    const sys = createBlockedFirePipsSystem(scene);
    const w = world([tank(1, 'player')], fullLoad(1));
    sys.spawn([blocked(1)], w, 'pips');
    sys.update(0.02, w);
    expect(pipsOf(scene)[0].scale.x).toBeGreaterThan(1);
    sys.setReducedMotion(true);
    sys.update(0.02, w);
    expect(pipsOf(scene)[0].scale.x).toBe(1);
    expect(strips(scene)).toHaveLength(1);
  });

  it('only the LIT pips pop', () => {
    // An empty slot jumping would say something happened to capacity the player still
    // has, which is the opposite of this arm's message.
    const scene = new THREE.Scene();
    const sys = createBlockedFirePipsSystem(scene);
    const w = world([tank(1, 'player')], [bullet(10, 1)]);
    sys.spawn([blocked(1)], w, 'pips');
    sys.update(0.02, w);
    const [lit, ...rest] = pipsOf(scene);
    expect(lit.material.color.getHex()).toBe(SPENT_COLOR);
    expect(lit.scale.x).toBeGreaterThan(1);
    for (const p of rest) expect(p.scale.x).toBe(1);
  });

  it('dispose empties the scene', () => {
    const scene = new THREE.Scene();
    const sys = createBlockedFirePipsSystem(scene);
    sys.spawn([blocked(1)], world([tank(1, 'player')], fullLoad(1)), 'pips');
    sys.dispose();
    expect(scene.children).toHaveLength(0);
  });
});
