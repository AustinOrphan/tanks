// @vitest-environment jsdom
// Dev-only is not untested: this is one of the arms issue #356's ruling will be made from,
// so smoke at the wrong moment, in the wrong place, or looking like the flash beside it
// does not merely look wrong, it corrupts the comparison. Three.js builds its scene graph
// on the CPU, so the wiring is reachable headlessly; whether any of it reaches the
// framebuffer, and whether it looks like a different arm once there, is covered in
// tools/gl/harness.ts.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createBlockedFireSmokeSystem, PEAK_OPACITY } from './blocked-fire-smoke';
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
type Billow = THREE.Sprite;
const billows = (s: THREE.Scene): Billow[] =>
  s.children.filter((o) => o.name === 'blocked-fire-smoke' && o.visible) as Billow[];

describe('blocked-fire muzzle smoke (issue #356)', () => {
  it('draws nothing when the flag is absent', () => {
    // The shipped default every arm shares: none may become the cue by being wired first.
    // The NAMED cues are covered per cue by the table below; null and undefined cannot be,
    // because neither is a member of BLOCKED_FIRE_CUES.
    const scene = new THREE.Scene();
    const sys = createBlockedFireSmokeSystem(scene);
    const w = world([tank(1, 'player')]);
    for (const cue of [null, undefined] as const) {
      sys.spawn([blocked(1)], w, cue);
    }
    expect(billows(scene)).toHaveLength(0);
  });

  it('puffs for EVERY cue carrying `smoke`, and for no other -- one row per cue', () => {
    // The table every blocked-fire consumer keeps (director.test.ts owns `audio`,
    // haptics.test.ts `haptic`, and each visual arm its own), and the reason each exists:
    // the defect that shipped `ring-audio` silent was not a wrong branch, it was a MISSING
    // one -- a cue no assertion mentioned. Keying the table off BLOCKED_FIRE_CUES means
    // the next cue cannot be added without stating whether it puffs: widening the union
    // fails `Record<BlockedFireCue, boolean>` at compile time, and adding to the set alone
    // fails the key comparison below.
    const carriesSmoke: Record<BlockedFireCue, boolean> = {
      smoke: true,
      // `muzzle` is the row that matters most here. It is the other arm at this same
      // barrel, so a gate that let either flag draw both would put a flash against a
      // flash-plus-smoke in front of the owner and call the difference a preference.
      muzzle: false,
      // The rest of the visual channel: separate treatments in their own systems, false
      // here however they are implemented. The audio and haptic arms never draw at all.
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
    expect(Object.keys(carriesSmoke).sort()).toEqual([...BLOCKED_FIRE_CUES].sort());
    for (const [cue, shouldDraw] of Object.entries(carriesSmoke)) {
      const scene = new THREE.Scene();
      const sys = createBlockedFireSmokeSystem(scene);
      sys.spawn([blocked(1)], world([tank(1, 'player')]), cue as BlockedFireCue);
      expect(billows(scene).length > 0, cue).toBe(shouldDraw);
    }
  });

  it('leaves the MUZZLE, on the barrel centreline -- not the tank', () => {
    // What makes this a weapon-local arm rather than a second tank-local one: the cloud
    // starts at the point bullets.ts hands a real `fire` event as its flash position
    // (SHELL_MUZZLE_FORWARD along the turret), at the height shells actually leave from.
    // Spawning on `owner.pos`, or at ground level, fails here.
    //
    // Turret at +90deg, so the muzzle is offset along world y -> three z, and a system
    // that ignored the turret angle would put the whole cloud a barrel away in x.
    const scene = new THREE.Scene();
    const sys = createBlockedFireSmokeSystem(scene);
    sys.spawn([blocked(4)], world([tank(4, 'player', true, Math.PI / 2)]), 'smoke');
    const puffs = billows(scene);
    expect(puffs.length).toBeGreaterThan(1);
    for (const b of puffs) {
      // Each billow sits within a bore's width of the muzzle at birth: the cloud is
      // stacked at the barrel opening, not smeared across the tank.
      expect(Math.hypot(b.position.x - 4, b.position.z - SHELL_MUZZLE_FORWARD)).toBeLessThan(0.2);
      expect(b.position.y).toBeCloseTo(BULLET_Y, 1);
    }
  });

  it('ignores an AI refusal and a dead tank', () => {
    // `fire-blocked` is emitted for whoever was refused, AI included. Smoking an enemy's
    // gun would report the ENEMY's ammunition to the player. Dropping either guard fails.
    const scene = new THREE.Scene();
    const sys = createBlockedFireSmokeSystem(scene);
    sys.spawn([blocked(1)], world([tank(1, 'brown')]), 'smoke');
    sys.spawn([blocked(2)], world([tank(2, 'player', false)]), 'smoke');
    expect(billows(scene)).toHaveLength(0);
  });

  it('reads as SMOKE, not as the flash: it EXPANDS and thins where the flash collapsed', () => {
    // The design claim that separates this arm from blocked-fire-muzzle.ts, asserted
    // rather than described. That one shrinks toward SHRINK_TO while it fades; this one
    // grows while it fades. An implementation that collapsed instead would be a grey
    // muzzle flash, and #356 would be comparing two settings of one treatment.
    const scene = new THREE.Scene();
    const sys = createBlockedFireSmokeSystem(scene);
    sys.spawn([blocked(1)], world([tank(1, 'player')]), 'smoke');
    const b = billows(scene)[0];
    const born = b.scale.x;
    const opaque = b.material.opacity;
    sys.update(0.2);
    expect(b.scale.x).toBeGreaterThan(born);
    expect(b.material.opacity).toBeLessThan(opaque);
  });

  it('is not made of light: desaturated grey, normally blended', () => {
    // The other half of "not the flash". blocked-fire-muzzle.ts is ADDITIVE 0xffd873 --
    // particles.ts's own fire colour -- so it brightens whatever is behind it, which is
    // exactly what light does and exactly what smoke does not. Turning this material
    // additive, or giving it a saturated colour, fails here.
    const scene = new THREE.Scene();
    const sys = createBlockedFireSmokeSystem(scene);
    sys.spawn([blocked(1)], world([tank(1, 'player')]), 'smoke');
    const { material } = billows(scene)[0];
    expect(material.blending).toBe(THREE.NormalBlending);
    const { r, g, b } = material.color;
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThan(0.1);
    // And it is a texture, not a bare shape: smoke has no silhouette, so an untextured
    // sprite would read as a grey card however it were coloured.
    expect(material.map).not.toBeNull();
  });

  it('drifts off the barrel and rises, and outlives the flash several times over', () => {
    // The motion that makes it exhaust rather than a stationary grey blob, and the
    // duration that makes it smoke rather than a flash: blocked-fire-muzzle.ts is gone in
    // 0.07s, so a cue still on screen at 0.5s cannot be that arm even in a still frame.
    // Turret at +90deg again, so drift along the barrel is +z and cannot be confused with
    // the sideways spread of the billows, which is along x.
    const scene = new THREE.Scene();
    const sys = createBlockedFireSmokeSystem(scene);
    sys.spawn([blocked(4)], world([tank(4, 'player', true, Math.PI / 2)]), 'smoke');
    const b = billows(scene)[0];
    const z0 = b.position.z;
    const y0 = b.position.y;
    sys.update(0.5);
    expect(b.position.z).toBeGreaterThan(z0);
    expect(b.position.y).toBeGreaterThan(y0);
    expect(billows(scene).length).toBeGreaterThan(0);
    sys.update(0.3);
    expect(billows(scene)).toHaveLength(0);
  });

  it('is several DIFFERENT billows, not one stamp printed three times', () => {
    // Why the cloud has a layout table at all. Smoke reads as smoke because its parts
    // disagree; three sprites at one position, one size and one angle would read as a
    // single hard-edged blob, and no amount of texture would rescue it. Collapsing the
    // table's entries to identical values fails here.
    const scene = new THREE.Scene();
    const sys = createBlockedFireSmokeSystem(scene);
    sys.spawn([blocked(1)], world([tank(1, 'player')]), 'smoke');
    sys.update(0.1);
    const puffs = billows(scene);
    expect(puffs.length).toBeGreaterThan(2);
    const places = new Set(puffs.map((b) => `${b.position.x.toFixed(3)},${b.position.z.toFixed(3)}`));
    expect(places.size).toBe(puffs.length);
    expect(new Set(puffs.map((b) => b.scale.x.toFixed(3))).size).toBe(puffs.length);
    expect(new Set(puffs.map((b) => b.material.rotation.toFixed(3))).size).toBe(puffs.length);
  });

  it('retires the cloud at the end of its life and reuses it', () => {
    const scene = new THREE.Scene();
    const sys = createBlockedFireSmokeSystem(scene);
    const w = world([tank(1, 'player')]);
    sys.spawn([blocked(1)], w, 'smoke');
    const drawn = scene.children.length;
    sys.update(1);
    expect(billows(scene)).toHaveLength(0);
    // Pooled, not leaked: a second refusal reuses the retired sprites rather than adding
    // a fresh cloud's worth beside them.
    sys.spawn([blocked(1)], w, 'smoke');
    expect(billows(scene)).toHaveLength(drawn);
    expect(scene.children.length).toBe(drawn);
    // ...and it comes back at full density, not at the transparency it faded out at.
    expect(billows(scene)[0].material.opacity).toBe(PEAK_OPACITY);
  });

  it('reduced motion keeps the cue but removes the drift', () => {
    // #453's policy: a cue that still appears and thins is information; the drift, the
    // rise and the billowing out are motion, and the preference is about motion. The
    // cloud arrives at the size it would have spread to and simply fades from there.
    const scene = new THREE.Scene();
    const sys = createBlockedFireSmokeSystem(scene);
    sys.setReducedMotion(true);
    sys.spawn([blocked(4)], world([tank(4, 'player', true, Math.PI / 2)]), 'smoke');
    const b = billows(scene)[0];
    const settled = { z: b.position.z, y: b.position.y, size: b.scale.x };
    sys.update(0.2);
    expect(b.position.z).toBeCloseTo(settled.z, 9);
    expect(b.position.y).toBeCloseTo(settled.y, 9);
    expect(b.scale.x).toBeCloseTo(settled.size, 9);
    expect(b.material.opacity).toBeLessThan(PEAK_OPACITY);
  });

  it('snaps an ALREADY-DRIFTING cloud back to rest when reduced motion turns on mid-flight', () => {
    // The case the test above cannot see: it sets the preference BEFORE spawning, so it
    // passes whether `update` writes a rest placement or simply stops placing. The
    // preference is a live media query and can flip while a cloud is on screen.
    //
    // Negative control: guarding the `place` call with `if (!reducedMotion)` fails this --
    // the cloud freezes wherever it had drifted to instead of returning to the barrel.
    const scene = new THREE.Scene();
    const sys = createBlockedFireSmokeSystem(scene);
    sys.spawn([blocked(4)], world([tank(4, 'player', true, Math.PI / 2)]), 'smoke');
    const b = billows(scene)[0];
    const born = b.position.z;
    sys.update(0.2);
    expect(b.position.z).toBeGreaterThan(born);
    sys.setReducedMotion(true);
    sys.update(0.01);
    expect(b.position.z).toBeCloseTo(born, 9);
    // Still a cue, still thinning: reduced motion removes the travel, not the information.
    expect(b.material.opacity).toBeLessThan(PEAK_OPACITY);
    expect(billows(scene).length).toBeGreaterThan(0);
  });

  it('dispose empties the scene', () => {
    const scene = new THREE.Scene();
    const sys = createBlockedFireSmokeSystem(scene);
    sys.spawn([blocked(1)], world([tank(1, 'player')]), 'smoke');
    sys.dispose();
    expect(scene.children).toHaveLength(0);
  });
});
