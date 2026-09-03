// @vitest-environment jsdom
// Dev-only is not untested: this is one of the arms issue #356's ruling will be made from,
// so a flash at the wrong moment or in the wrong place does not merely look wrong, it
// corrupts the comparison. Three.js builds its scene graph on the CPU, so the wiring is
// reachable headlessly; whether any of it reaches the framebuffer is covered in
// tools/gl/harness.ts.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createBlockedFireMuzzleSystem } from './blocked-fire-muzzle';
import { BULLET_Y } from './tank-model';
import { createWorld, type World } from '../sim/world';
import { SHELL_MUZZLE_FORWARD } from '../sim/constants';
import type { Tank } from '../sim/types';
import type { SimEvent } from '../sim/events';
import { BLOCKED_FIRE_CUES, type BlockedFireCue } from '../presentation/blocked-fire';

function tank(id: number, kind: string, alive = true, turretAngle = 0): Tank {
  return {
    id, kind, pos: { x: id, y: 0 }, bodyAngle: 0, turretAngle, alive,
    desiredMove: { x: 0, y: 0 }, activeMineIds: [], fireCooldown: 0, mineCooldown: 0,
    aiState: 'idle', aiTimer: 0,
  } as unknown as Tank;
}
const world = (tanks: Tank[]): World => createWorld({ walls: [], tanks, spawns: [], lives: 3 });
const blocked = (ownerId: number): SimEvent =>
  ({ type: 'fire-blocked', ownerId, reason: 'shell-cap' }) as SimEvent;
type FlashMesh = THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
const flashes = (s: THREE.Scene): FlashMesh[] =>
  s.children.filter((o) => o.name === 'blocked-fire-muzzle' && o.visible) as FlashMesh[];

describe('blocked-fire muzzle flash (issue #516, parent #356)', () => {
  it('draws nothing when the flag is absent', () => {
    // The shipped default every arm shares: none may become the cue by being wired first.
    // The NAMED cues are covered per cue by the table below; null and undefined cannot be,
    // because neither is a member of BLOCKED_FIRE_CUES.
    const scene = new THREE.Scene();
    const sys = createBlockedFireMuzzleSystem(scene);
    const w = world([tank(1, 'player')]);
    for (const cue of [null, undefined] as const) {
      sys.spawn([blocked(1)], w, cue);
    }
    expect(flashes(scene)).toHaveLength(0);
  });

  it('flashes for EVERY cue carrying `muzzle`, and for no other -- one row per cue', () => {
    // The table every blocked-fire consumer keeps (director.test.ts owns `audio`,
    // haptics.test.ts `haptic`, blocked-fire-ring.test.ts `ring`), and the reason each
    // exists: the defect that shipped `ring-audio` silent was not a wrong branch, it was a
    // MISSING one -- a cue no assertion mentioned. Keying the table off BLOCKED_FIRE_CUES
    // means the next cue cannot be added without stating whether it flashes: widening the
    // union fails `Record<BlockedFireCue, boolean>` at compile time, and adding to the set
    // alone fails the key comparison below.
    const carriesMuzzle: Record<BlockedFireCue, boolean> = {
      muzzle: true,
      // Every other cue, false, for two different reasons. The three other VISUAL arms
      // (ring, pips, hud) are separate treatments in their own systems and their rows stay
      // false here however they are implemented -- the whole point of the comparison is
      // that they are not the same picture. The audio and haptic arms draw nothing at all.
      // When #516's pairing of the strongest visual with the strongest audio lands,
      // whichever combination names this arm flips its own row to true.
      //
      // `smoke` used to be the row that mattered most here, because it was the other arm
      // at this same barrel. It is not a cue at all since issue #536 made the puff
      // unconditional (render/muzzle-smoke.ts), so the thing this table used to guard
      // against -- one flag drawing both, turning the comparison into a flash against a
      // flash-plus-smoke -- is now simply what every frame looks like. The flash still has
      // to stay the flash, which is what the false rows below are for.
      ring: false,
      'ring-audio': false,
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
    expect(Object.keys(carriesMuzzle).sort()).toEqual([...BLOCKED_FIRE_CUES].sort());
    for (const [cue, shouldDraw] of Object.entries(carriesMuzzle)) {
      const scene = new THREE.Scene();
      const sys = createBlockedFireMuzzleSystem(scene);
      sys.spawn([blocked(1)], world([tank(1, 'player')]), cue as BlockedFireCue);
      expect(flashes(scene), cue).toHaveLength(shouldDraw ? 1 : 0);
    }
  });

  it('sits at the MUZZLE, on the barrel centreline -- not on the tank', () => {
    // The claim that makes this arm weapon-local rather than a second tank-local ring: it
    // is the same point bullets.ts hands a real `fire` event as its flash position
    // (SHELL_MUZZLE_FORWARD along the turret), at the height shells actually leave from.
    // Spawning on `owner.pos`, or at ground level, fails here.
    const scene = new THREE.Scene();
    const sys = createBlockedFireMuzzleSystem(scene);
    // Turret at +90deg, so the muzzle is offset along world y -> three z, and a system
    // that ignored the turret angle would put the flash a whole barrel away in x.
    sys.spawn([blocked(4)], world([tank(4, 'player', true, Math.PI / 2)]), 'muzzle');
    const [f] = flashes(scene);
    expect(f).toBeDefined();
    expect(f.position.x).toBeCloseTo(4, 9);
    expect(f.position.z).toBeCloseTo(SHELL_MUZZLE_FORWARD, 9);
    expect(f.position.y).toBeCloseTo(BULLET_Y, 9);
  });

  it('ignores an AI refusal and a dead tank', () => {
    // `fire-blocked` is emitted for whoever was refused, AI included. Flashing an enemy's
    // gun would report the ENEMY's ammunition to the player. Dropping either guard fails.
    const scene = new THREE.Scene();
    const sys = createBlockedFireMuzzleSystem(scene);
    sys.spawn([blocked(1)], world([tank(1, 'brown')]), 'muzzle');
    sys.spawn([blocked(2)], world([tank(2, 'player', false)]), 'muzzle');
    expect(flashes(scene)).toHaveLength(0);
  });

  it('is CUT SHORT: it collapses and fades, and is gone inside a tenth of a second', () => {
    // The design claim, asserted rather than described. "The shot's own visual, cut short"
    // is a statement about duration: a real fire burst's particles live 0.18s and travel,
    // this blinks. Lengthening the life past 0.1s, or dropping either the collapse or the
    // fade, fails here.
    const scene = new THREE.Scene();
    const sys = createBlockedFireMuzzleSystem(scene);
    sys.spawn([blocked(1)], world([tank(1, 'player')]), 'muzzle');
    const f = flashes(scene)[0];
    const start = f.scale.x;
    sys.update(0.03);
    expect(f.scale.x).toBeLessThan(start);
    expect(f.material.opacity).toBeLessThan(1);
    expect(flashes(scene)).toHaveLength(1);
    sys.update(0.07);
    expect(flashes(scene)).toHaveLength(0);
  });

  it('retires the flash at the end of its life and reuses it', () => {
    const scene = new THREE.Scene();
    const sys = createBlockedFireMuzzleSystem(scene);
    const w = world([tank(1, 'player')]);
    sys.spawn([blocked(1)], w, 'muzzle');
    sys.update(1);
    expect(flashes(scene)).toHaveLength(0);
    // Pooled, not leaked: a second refusal reuses the retired mesh rather than adding one.
    const meshes = scene.children.length;
    sys.spawn([blocked(1)], w, 'muzzle');
    expect(flashes(scene)).toHaveLength(1);
    expect(scene.children.length).toBe(meshes);
    // ...and it comes back at full brightness and full size, not at the state it died in.
    expect(flashes(scene)[0].material.opacity).toBe(1);
    expect(flashes(scene)[0].scale.x).toBe(1);
  });

  it('reduced motion keeps the cue but removes the collapse', () => {
    // #453's policy: a cue that still appears and fades is information; the shrink is
    // motion, and the preference is about motion.
    const scene = new THREE.Scene();
    const sys = createBlockedFireMuzzleSystem(scene);
    sys.setReducedMotion(true);
    sys.spawn([blocked(1)], world([tank(1, 'player')]), 'muzzle');
    const f = flashes(scene)[0];
    sys.update(0.03);
    expect(f.scale.x).toBe(1);
    expect(f.material.opacity).toBeLessThan(1);
  });

  it('snaps an ALREADY-LIVE flash to full size when reduced motion turns on mid-flight', () => {
    // The case the test above cannot see: it sets the preference BEFORE spawning, so it
    // passes whether `update` skips the scale term or writes a rest scale. The preference
    // is a live media query and can flip while a flash is on screen.
    //
    // Negative control: guarding the scale write with `if (!reducedMotion)` fails this --
    // the flash freezes at whatever size it had collapsed to instead of reaching rest.
    const scene = new THREE.Scene();
    const sys = createBlockedFireMuzzleSystem(scene);
    sys.spawn([blocked(1)], world([tank(1, 'player')]), 'muzzle');
    const f = flashes(scene)[0];
    sys.update(0.03);
    expect(f.scale.x).toBeLessThan(1);
    sys.setReducedMotion(true);
    sys.update(0.01);
    expect(f.scale.x).toBe(1);
    // Still a cue, still fading: reduced motion removes the collapse, not the information.
    expect(f.material.opacity).toBeLessThan(1);
    expect(flashes(scene)).toHaveLength(1);
  });

  it('dispose empties the scene', () => {
    const scene = new THREE.Scene();
    const sys = createBlockedFireMuzzleSystem(scene);
    sys.spawn([blocked(1)], world([tank(1, 'player')]), 'muzzle');
    sys.dispose();
    expect(scene.children).toHaveLength(0);
  });
});
