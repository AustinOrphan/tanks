// @vitest-environment jsdom
// No longer dev-only: since issue #536 this puff leaves the muzzle of every shot fired, so
// smoke at the wrong moment, in the wrong place, or looking like the flash beside it now
// reaches every player rather than only whoever set a flag. Three.js builds its scene graph
// on the CPU, so the wiring is reachable headlessly; whether any of it reaches the
// framebuffer, and how far the two looks are actually separated once there, is measured in
// tools/gl/harness.ts.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createMuzzleSmokeSystem, SMOKE } from './muzzle-smoke';
import { BULLET_Y } from './tank-model';
import { createWorld, type World } from '../sim/world';
import { SHELL_MUZZLE_FORWARD } from '../sim/constants';
import type { Tank } from '../sim/types';
import type { SimEvent } from '../sim/events';

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
const fired = (ownerId: number): SimEvent => ({ type: 'fire', ownerId }) as SimEvent;
type Billow = THREE.Sprite;
const billows = (s: THREE.Scene): Billow[] =>
  s.children.filter((o) => o.name === 'muzzle-smoke' && o.visible) as Billow[];
/** The tint the first billow of the newest cloud was given, as a hex integer. */
const tintOf = (s: THREE.Scene): number => billows(s)[0].material.color.getHex();

describe('muzzle smoke (issue #536, parent #356)', () => {
  it('stays clear of the barrel until the gun actually cycles', () => {
    // No flag gates this system any more, so "nothing happens by default" has to be proven
    // against the EVENT stream rather than against an absent cue -- the shape
    // barrel-recoil.test.ts uses for the same reason. An unrelated event must not smoke.
    const scene = new THREE.Scene();
    const sys = createMuzzleSmokeSystem(scene);
    sys.spawn([{ type: 'tank-destroyed', tankId: 1 } as SimEvent], world([tank(1, 'player')]));
    expect(billows(scene)).toHaveLength(0);
  });

  it('puffs on a SHOT and on a REFUSAL alike -- that is the whole ruling', () => {
    // Issue #536's inversion, and the assertion a reader of this file's history is most
    // likely to revert: as issue #356's `smoke` arm this drew ONLY on `fire-blocked`, and
    // only for a flag naming it. The owner ruled that smoke is what firing looks like, so
    // both events must produce a cloud -- what differs is how the cloud looks, which the
    // next test pins.
    for (const event of [fired, blocked]) {
      const scene = new THREE.Scene();
      const sys = createMuzzleSmokeSystem(scene);
      sys.spawn([event(1)], world([tank(1, 'player')]));
      expect(billows(scene).length, event === fired ? 'fire' : 'fire-blocked').toBeGreaterThan(0);
    }
  });

  it('a REFUSAL is darker, and denser, than a shot', () => {
    // The owner's ruling in one assertion: "darker, blacker" on a misfire. Darkness is the
    // primary signal and is asserted first, per channel, so a refusal tinted lighter --
    // or tinted the same -- fails whatever else is true of it.
    const lit = new THREE.Scene();
    const litSys = createMuzzleSmokeSystem(lit);
    litSys.spawn([fired(1)], world([tank(1, 'player')]));
    const burnt = new THREE.Scene();
    const burntSys = createMuzzleSmokeSystem(burnt);
    burntSys.spawn([blocked(1)], world([tank(1, 'player')]));

    const shot = billows(lit)[0].material;
    const refusal = billows(burnt)[0].material;
    expect(refusal.color.r).toBeLessThan(shot.color.r);
    expect(refusal.color.g).toBeLessThan(shot.color.g);
    expect(refusal.color.b).toBeLessThan(shot.color.b);
    // And the second property the difference is carried on -- see SMOKE's own comment for
    // the measurement that made one property insufficient. Value alone moved the two puffs
    // TOWARD each other against this arena's dark felt; density is what puts the
    // exceptional event back in front of the routine one. A refusal that were merely
    // darker would pass the three assertions above and still be the quieter of the two on
    // screen, which is the failure this line exists to prevent.
    expect(refusal.opacity).toBeGreaterThan(shot.opacity);
    // Still the same substance, not a different material: both are desaturated, so the
    // refusal reads as soot rather than as a coloured signal.
    for (const m of [shot, refusal]) {
      const { r, g, b } = m.color;
      expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThan(0.1);
    }
  });

  it('keeps a refusal DENSE for its whole life, not just at birth', () => {
    // The fade multiplies each cloud's OWN peak. An `update` that faded from a single
    // shared constant instead would pull the refusal back to the ordinary puff's density
    // on the very first frame, leaving the extra opacity visible for one sixtieth of a
    // second -- and the test above, which reads the material at birth, would not notice.
    //
    // The assertion that catches it has to be an ABSOLUTE one, and that is worth spelling
    // out because the obvious relative form does not work. Comparing the two clouds after
    // the same elapsed time stays green under the defect: both would fade from the shot's
    // peak, but the refusal's slower thinning curve still leaves it the denser of the two,
    // so the comparison passes while the extra density it was born with is gone.
    // MEASURED: with the peak read from `SMOKE.fired` instead of the cloud, 0 of this
    // file's 18 tests failed until the two lines below were added.
    //
    // Negative control: fading from `SMOKE.fired.peakOpacity` rather than `cl.peak` fails
    // here while every other case in this file stays green.
    const burnt = new THREE.Scene();
    const burntSys = createMuzzleSmokeSystem(burnt);
    burntSys.spawn([blocked(1)], world([tank(1, 'player')]));
    // One frame in, so `update` has had its say and almost no life has been spent.
    burntSys.update(1 / 60);
    const oneFrameIn = billows(burnt)[0].material.opacity;
    expect(oneFrameIn).toBeCloseTo(SMOKE.refused.peakOpacity, 1);
    // A refusal a frame old is still thicker than an ordinary puff is at BIRTH -- which is
    // the plainest statement of "nearly solid" this file can make, and false the instant
    // the fade forgets whose cloud it is animating.
    expect(oneFrameIn).toBeGreaterThan(SMOKE.fired.peakOpacity);

    // ...and it stays the denser of the two well into the life, which is the property the
    // GL harness's separation measurement actually samples.
    const lit = new THREE.Scene();
    const litSys = createMuzzleSmokeSystem(lit);
    litSys.spawn([fired(1)], world([tank(1, 'player')]));
    litSys.update(0.3);
    burntSys.update(0.3 - 1 / 60);
    expect(billows(burnt)[0].material.opacity).toBeGreaterThan(billows(lit)[0].material.opacity);
  });

  it('thins a refusal SLOWER, not merely from a higher start', () => {
    // The second half of the density difference, and the half the test above cannot see:
    // it compares raw opacities, which the refusal wins on its higher peak alone even if
    // both clouds thin on the identical curve. What the measurement in SMOKE actually
    // needed was for the soot to still be there later, so this compares each cloud against
    // its OWN birth density -- a shape a difference in peak cannot produce.
    //
    // Negative control: reading `SMOKE.fired.fadePower` instead of `cl.fadePower` in
    // `update` leaves the two fractions exactly equal and fails only here.
    const lit = new THREE.Scene();
    const litSys = createMuzzleSmokeSystem(lit);
    litSys.spawn([fired(1)], world([tank(1, 'player')]));
    const burnt = new THREE.Scene();
    const burntSys = createMuzzleSmokeSystem(burnt);
    burntSys.spawn([blocked(1)], world([tank(1, 'player')]));
    litSys.update(0.3);
    burntSys.update(0.3);
    const shotLeft = billows(lit)[0].material.opacity / SMOKE.fired.peakOpacity;
    const refusalLeft = billows(burnt)[0].material.opacity / SMOKE.refused.peakOpacity;
    expect(refusalLeft).toBeGreaterThan(shotLeft);
    // Both are still THINNING, though: a refusal that held its density flat would stop
    // being smoke and start being a stain on the lens.
    expect(refusalLeft).toBeLessThan(1);
  });

  it('gives a recycled cloud the look of the event that reused it, not the one that retired it', () => {
    // One pool now serves two looks, so a refusal's sprites are handed straight to the
    // next ordinary shot. Everything `place` writes is reset by the placement that follows
    // a spawn; the tint and the peak opacity are not, so `acquire` has to write them.
    //
    // Negative control: dropping the `setHex` from `acquire` leaves this shot wearing the
    // refusal's soot, and nothing else in this file fails.
    const scene = new THREE.Scene();
    const sys = createMuzzleSmokeSystem(scene);
    const w = world([tank(1, 'player')]);
    sys.spawn([blocked(1)], w);
    expect(tintOf(scene)).toBe(SMOKE.refused.color);
    sys.update(1);
    expect(billows(scene)).toHaveLength(0);
    sys.spawn([fired(1)], w);
    expect(tintOf(scene)).toBe(SMOKE.fired.color);
    expect(billows(scene)[0].material.opacity).toBe(SMOKE.fired.peakOpacity);
    // ...and back the other way, so this cannot pass by always resetting to `fired`.
    sys.update(1);
    sys.spawn([blocked(1)], w);
    expect(tintOf(scene)).toBe(SMOKE.refused.color);
    expect(billows(scene)[0].material.opacity).toBe(SMOKE.refused.peakOpacity);
  });

  it('leaves the MUZZLE, on the barrel centreline -- not the tank', () => {
    // What makes this weapon-local rather than tank-local: the cloud starts at the point
    // bullets.ts hands a real `fire` event as its flash position (SHELL_MUZZLE_FORWARD
    // along the turret), at the height shells actually leave from. Spawning on `owner.pos`,
    // or at ground level, fails here.
    //
    // Turret at +90deg, so the muzzle is offset along world y -> three z, and a system
    // that ignored the turret angle would put the whole cloud a barrel away in x.
    const scene = new THREE.Scene();
    const sys = createMuzzleSmokeSystem(scene);
    sys.spawn([fired(4)], world([tank(4, 'player', true, Math.PI / 2)]));
    const puffs = billows(scene);
    expect(puffs.length).toBeGreaterThan(1);
    for (const b of puffs) {
      // Each billow sits within a bore's width of the muzzle at birth: the cloud is
      // stacked at the barrel opening, not smeared across the tank.
      expect(Math.hypot(b.position.x - 4, b.position.z - SHELL_MUZZLE_FORWARD)).toBeLessThan(0.2);
      expect(b.position.y).toBeCloseTo(BULLET_Y, 1);
    }
  });

  it('smokes EVERY living tank, enemies included, and never a dead one', () => {
    // The guard this arm lost in the transition. As a refusal cue it was PLAYER-ONLY,
    // because an enemy's `fire-blocked` would have reported the enemy's ammunition state
    // to the player. barrel-recoil.ts records why that reason does not survive: firing is
    // already visible, the shell is right there, so smoke on it reports nothing new -- and
    // an enemy gun firing clean while the player's smoked would be the odd thing. Dead
    // tanks are still refused, since their view is being torn down.
    const scene = new THREE.Scene();
    const sys = createMuzzleSmokeSystem(scene);
    sys.spawn([fired(1)], world([tank(1, 'brown')]));
    expect(billows(scene).length, 'enemy shot').toBeGreaterThan(0);
    const refusals = new THREE.Scene();
    const refusalSys = createMuzzleSmokeSystem(refusals);
    refusalSys.spawn([blocked(1)], world([tank(1, 'grey')]));
    expect(billows(refusals).length, 'enemy refusal').toBeGreaterThan(0);
    const dead = new THREE.Scene();
    const deadSys = createMuzzleSmokeSystem(dead);
    deadSys.spawn([fired(2), blocked(3)], world([tank(2, 'player', false), tank(3, 'brown', false)]));
    expect(billows(dead), 'dead owners').toHaveLength(0);
  });

  it('reads as SMOKE, not as the flash: it EXPANDS and thins where the flash collapsed', () => {
    // The design claim that separates this from blocked-fire-muzzle.ts, asserted rather
    // than described. That one shrinks toward SHRINK_TO while it fades; this grows while it
    // fades. An implementation that collapsed instead would be a grey muzzle flash -- and
    // since the flash is still a selectable arm, the two can now be on screen together.
    const scene = new THREE.Scene();
    const sys = createMuzzleSmokeSystem(scene);
    sys.spawn([fired(1)], world([tank(1, 'player')]));
    const b = billows(scene)[0];
    const born = b.scale.x;
    const opaque = b.material.opacity;
    sys.update(0.2);
    expect(b.scale.x).toBeGreaterThan(born);
    expect(b.material.opacity).toBeLessThan(opaque);
  });

  it('is not made of light: normally blended, and textured', () => {
    // The other half of "not the flash". blocked-fire-muzzle.ts is ADDITIVE 0xffd873 --
    // particles.ts's own fire colour -- so it brightens whatever is behind it, which is
    // exactly what light does and exactly what smoke does not. It matters twice as much
    // since #536: under additive blending the refusal's near-black tint would add almost
    // nothing, so the darker puff would be the INVISIBLE one.
    const scene = new THREE.Scene();
    const sys = createMuzzleSmokeSystem(scene);
    sys.spawn([blocked(1)], world([tank(1, 'player')]));
    const { material } = billows(scene)[0];
    expect(material.blending).toBe(THREE.NormalBlending);
    // And it is a texture, not a bare shape: smoke has no silhouette, so an untextured
    // sprite would read as a grey card however it were coloured.
    expect(material.map).not.toBeNull();
  });

  it('drifts off the barrel and rises, and outlives the flash several times over', () => {
    // The motion that makes it exhaust rather than a stationary blob, and the duration that
    // makes it smoke rather than a flash: blocked-fire-muzzle.ts is gone in 0.07s, so a
    // puff still on screen at 0.5s cannot be that arm even in a still frame. Turret at
    // +90deg again, so drift along the barrel is +z and cannot be confused with the
    // sideways spread of the billows, which is along x.
    const scene = new THREE.Scene();
    const sys = createMuzzleSmokeSystem(scene);
    sys.spawn([fired(4)], world([tank(4, 'player', true, Math.PI / 2)]));
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

  it('gives a shot and a refusal the SAME shape, so only the look distinguishes them', () => {
    // The other side of the "darker and denser" ruling, and the thing that keeps the two
    // legible as one gesture: lifetime, spread, drift and rise are deliberately NOT split.
    // Splitting them would make a refusal a different EFFECT rather than the same gun
    // having a bad time -- and it is what would let a future retune quietly substitute
    // motion for the darkness the owner actually asked for.
    const lit = new THREE.Scene();
    const litSys = createMuzzleSmokeSystem(lit);
    litSys.spawn([fired(4)], world([tank(4, 'player', true, Math.PI / 2)]));
    const burnt = new THREE.Scene();
    const burntSys = createMuzzleSmokeSystem(burnt);
    burntSys.spawn([blocked(4)], world([tank(4, 'player', true, Math.PI / 2)]));
    for (const t of [0, 0.3, 0.3]) {
      litSys.update(t);
      burntSys.update(t);
      const a = billows(lit);
      const b = billows(burnt);
      expect(b.length, `count at ${t}`).toBe(a.length);
      for (let i = 0; i < a.length; i++) {
        expect(b[i].position.toArray()).toEqual(a[i].position.toArray());
        expect(b[i].scale.toArray()).toEqual(a[i].scale.toArray());
      }
    }
  });

  it('is several DIFFERENT billows, not one stamp printed three times', () => {
    // Why the cloud has a layout table at all. Smoke reads as smoke because its parts
    // disagree; three sprites at one position, one size and one angle would read as a
    // single hard-edged blob, and no amount of texture would rescue it. Collapsing the
    // table's entries to identical values fails here.
    const scene = new THREE.Scene();
    const sys = createMuzzleSmokeSystem(scene);
    sys.spawn([fired(1)], world([tank(1, 'player')]));
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
    const sys = createMuzzleSmokeSystem(scene);
    const w = world([tank(1, 'player')]);
    sys.spawn([fired(1)], w);
    const drawn = scene.children.length;
    sys.update(1);
    expect(billows(scene)).toHaveLength(0);
    // Pooled, not leaked: a second shot reuses the retired sprites rather than adding a
    // fresh cloud's worth beside them. That matters more than it did as a refusal arm --
    // every gun on the board now smokes on every shot, so an unpooled cloud would grow the
    // scene graph for the whole match.
    sys.spawn([fired(1)], w);
    expect(billows(scene)).toHaveLength(drawn);
    expect(scene.children.length).toBe(drawn);
    // ...and it comes back at full density, not at the transparency it faded out at.
    expect(billows(scene)[0].material.opacity).toBe(SMOKE.fired.peakOpacity);
  });

  it('recycles the OLDEST cloud at budget, so the newest puff always survives', () => {
    // Two claims, and the second is the one that was only in the title before. A bound
    // must exist: unbounded, this would add three sprites per shot for as long as a match
    // lasts, and it is now driven by every tank rather than one flagged player.
    //
    // WHICH cloud loses its slot is the part that shows on screen. Refusing the new puff
    // -- returning null at the ceiling, which is what this did -- drops smoke from the
    // shot the player just fired and is watching, while a nearly-faded cloud from half a
    // second ago keeps its place. So the newest spawn must always end up visible.
    const scene = new THREE.Scene();
    const sys = createMuzzleSmokeSystem(scene);
    const w = world([tank(1, 'player')]);
    for (let i = 0; i < 200; i++) sys.spawn([fired(1)], w);
    expect(scene.children.length).toBeLessThan(200 * 3);

    // The newest spawn is identified by its TINT, not its opacity. Nothing here calls
    // `update`, so every cloud still sits at its birth opacity and "is anything at peak?"
    // would be true however the ceiling behaved -- a vacuous assertion. A refusal is
    // near-black where a shot is grey, so asking whether the board carries a REFUSAL's
    // colour after 200 ordinary shots have filled the budget answers the real question.
    sys.spawn([blocked(1)], w);
    const soot = billows(scene).filter(
      (b) => b.visible && b.material.color.getHex() === SMOKE.refused.color,
    );
    expect(soot.length, 'the newest puff was dropped at the ceiling').toBeGreaterThan(0);
  });

  it('reduced motion keeps the puff but removes the drift', () => {
    // #453's policy: a cue that still appears and thins is information; the drift, the rise
    // and the billowing out are motion, and the preference is about motion. The cloud
    // arrives at the size it would have spread to and simply fades from there.
    const scene = new THREE.Scene();
    const sys = createMuzzleSmokeSystem(scene);
    sys.setReducedMotion(true);
    sys.spawn([fired(4)], world([tank(4, 'player', true, Math.PI / 2)]));
    const b = billows(scene)[0];
    const settled = { z: b.position.z, y: b.position.y, size: b.scale.x };
    sys.update(0.2);
    expect(b.position.z).toBeCloseTo(settled.z, 9);
    expect(b.position.y).toBeCloseTo(settled.y, 9);
    expect(b.scale.x).toBeCloseTo(settled.size, 9);
    expect(b.material.opacity).toBeLessThan(SMOKE.fired.peakOpacity);
  });

  it('snaps an ALREADY-DRIFTING cloud back to rest when reduced motion turns on mid-flight', () => {
    // The case the test above cannot see: it sets the preference BEFORE spawning, so it
    // passes whether `update` writes a rest placement or simply stops placing. The
    // preference is a live media query and can flip while a cloud is on screen.
    //
    // Negative control: guarding the `place` call with `if (!reducedMotion)` fails this --
    // the cloud freezes wherever it had drifted to instead of returning to the barrel.
    const scene = new THREE.Scene();
    const sys = createMuzzleSmokeSystem(scene);
    sys.spawn([fired(4)], world([tank(4, 'player', true, Math.PI / 2)]));
    const b = billows(scene)[0];
    const born = b.position.z;
    sys.update(0.2);
    expect(b.position.z).toBeGreaterThan(born);
    sys.setReducedMotion(true);
    sys.update(0.01);
    expect(b.position.z).toBeCloseTo(born, 9);
    // Still a cue, still thinning: reduced motion removes the travel, not the information.
    expect(b.material.opacity).toBeLessThan(SMOKE.fired.peakOpacity);
    expect(billows(scene).length).toBeGreaterThan(0);
  });

  it('dispose empties the scene', () => {
    const scene = new THREE.Scene();
    const sys = createMuzzleSmokeSystem(scene);
    sys.spawn([fired(1)], world([tank(1, 'player')]));
    sys.dispose();
    expect(scene.children).toHaveLength(0);
  });
});
