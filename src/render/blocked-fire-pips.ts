import * as THREE from 'three';
import type { World } from '../sim/world';
import type { SimEvent } from '../sim/events';
import { cueDrives, type BlockedFireCue } from '../presentation/blocked-fire';
import { ownerShellCount } from '../sim/bullets';
import { configFor } from '../sim/config';

/**
 * Issue #356's tank-local CAPACITY candidate, and issue #516's `pips` arm: a short strip
 * of shell pips on the felt beside the tank, in which the shells already in the air light
 * up.
 *
 * WHY IT SAYS SOMETHING THE OTHER ARMS CANNOT. The ring, the muzzle flash and the turret
 * stutter all say the same thing -- "that did not happen" -- and #356's hardest acceptance
 * criterion is not that the player notices, it is that they infer SHELL CAPACITY FULL
 * rather than cooldown, lag or dropped input. This arm is the one that states the reason:
 * the strip is as long as the weapon's capacity, and at a refusal every pip in it is lit,
 * which is the picture of "you are holding all of them". A player who has seen it once
 * knows why the gun is quiet.
 *
 * IT READS THE AUTHORITATIVE NUMBERS, not a count of its own. The length is
 * `configFor(kind).weapon.maxActiveProjectiles` and the lit count is `ownerShellCount` --
 * the two expressions `shellCapReached` itself is made of (sim/bullets.ts), which is what
 * #356 means by "the displayed capacity derives from the same resolved tank configuration
 * enforced by spawnBullet". A pip strip that counted separately could disagree with the
 * gate it is explaining.
 *
 * IT GOES OUT WITH ITS TANK. Half a second is long enough to be shot in, and a capacity
 * readout for a destroyed tank is meaningless -- it would sit lit on the felt where the
 * tank died, reporting shells nothing can hold. A dead or vanished owner retires the strip
 * on the spot rather than merely stopping the follow, which would read as a rendering
 * fault. The other three arms reach the same end by other routes: the ring and the muzzle
 * flash are latched blinks that finish before a death is legible, and the turret stutter
 * is dropped the frame entities.ts disposes the dead tank's view.
 *
 * ON THE FELT, NOT ABOVE THE HULL, and NOT parented to the tank. Flat on the ground at the
 * ring's own Y, one hull-length toward the bottom of the screen: above the hull it would
 * sit over the turret at this camera's angle and hide the barrel the player is aiming,
 * and parented to the group it would rotate with the body, so a reversing tank would read
 * its own capacity backwards. It FOLLOWS the tank every frame instead -- unlike the ring,
 * which lives 0.18s and can afford to be latched where it was born; a readout on screen
 * for half a second must not slide off the tank it belongs to.
 *
 * SILENT BY DEFAULT and PLAYER-ONLY, the contract every arm shares.
 */
export interface BlockedFirePipsSystem {
  /** Light a strip for every refusal this frame that belongs to a player tank. */
  spawn(events: SimEvent[], world: World, cue: BlockedFireCue | null | undefined): void;
  /**
   * `world` is the CURRENT world: the strip follows its tank, and is retired early if that
   * tank dies or leaves the arena inside the cue's life.
   */
  update(dt: number, world: World): void;
  setReducedMotion(on: boolean): void;
  dispose(): void;
}

/**
 * Feel constants. OWNER DECISIONS, stated rather than buried:
 *
 *  - 0.55s, by far the longest of the four visual arms, because this one is READ rather
 *    than merely noticed. It holds for the first 55% and fades over the rest.
 *  - Spent pips in a hot orange (0xff7a1a), deliberately NOT the ring's amber (0xffb020):
 *    the two arms are compared side by side and must not be remembered as one treatment.
 *  - Free pips stay drawn, dim and grey. A strip that showed only the lit pips would be a
 *    count, not a capacity, and "5 of 5" is the entire message.
 *  - 0.9 world units toward the bottom of the screen: clear of the hull's own footprint
 *    (TANK_RADIUS is 0.5) without drifting off the tank.
 */
const LIFETIME_SECONDS = 0.55;
const HOLD_FRACTION = 0.55;
/**
 * Exported so blocked-fire-pips.test.ts can pin "the SPENT ones light up" against the
 * colours themselves rather than against a remembered pair of hex literals -- the same
 * reason entities.ts exports its identity-ring radii.
 */
export const SPENT_COLOR = 0xff7a1a;
export const FREE_COLOR = 0x8a939e;
const FREE_OPACITY = 0.3;
const PIP_RADIUS = 0.075;
const PIP_SPACING = 0.26;
const ROW_FORWARD = 0.9;
/** Just off the felt, the RING_Y precedent minedebug.ts sets for the same z-fight reason. */
const PIP_Y = 0.033;
/** How much larger a lit pip starts before settling. Removed under reduced motion. */
const POP_SCALE = 1.6;
/** Seconds the pop takes to settle. Short: it is an accent on the light, not a movement. */
const POP_SECONDS = 0.12;

interface Row {
  group: THREE.Group;
  pips: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>[];
  /** Which pips are shells already in the air, by index. Parallel to `pips`. */
  lit: boolean[];
  ownerId: number;
  life: number;
}

export function createBlockedFirePipsSystem(scene: THREE.Scene): BlockedFirePipsSystem {
  let reducedMotion = false;
  // One geometry for every pip in every strip, disposed once.
  const geometry = new THREE.CircleGeometry(PIP_RADIUS, 16);
  /** tank id -> its strip. One strip per tank; a fresh refusal relights the same one. */
  const rows = new Map<number, Row>();

  function makePip(): THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> {
    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({ transparent: true, side: THREE.DoubleSide, depthWrite: false }),
    );
    // Flat on the felt, the same lie-down the ring and the identity ring use.
    mesh.rotation.x = -Math.PI / 2;
    mesh.name = 'blocked-fire-pip';
    return mesh;
  }

  function rowFor(ownerId: number, cap: number): Row {
    let row = rows.get(ownerId);
    if (!row) {
      const group = new THREE.Group();
      group.name = 'blocked-fire-pips';
      scene.add(group);
      row = { group, pips: [], lit: [], ownerId, life: 0 };
      rows.set(ownerId, row);
    }
    // Capacity is per resolved tank config, so it can differ between kinds and can be
    // retuned by the ordnance experiment; rebuild the strip only when the count changes.
    while (row.pips.length < cap) {
      const pip = makePip();
      row.group.add(pip);
      row.pips.push(pip);
    }
    while (row.pips.length > cap) {
      const pip = row.pips.pop() as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
      row.group.remove(pip);
      pip.material.dispose();
    }
    for (let i = 0; i < row.pips.length; i++) {
      // Centred on the tank: the strip reads as belonging to it, not as pointing away.
      row.pips[i].position.set((i - (cap - 1) / 2) * PIP_SPACING, 0, 0);
    }
    return row;
  }

  /**
   * Move the strip onto its tank, or report that there is no tank left to follow.
   *
   * A dead or vanished owner is NOT merely a frame with nowhere to move to: this arm lives
   * 0.55s, so a tank destroyed mid-effect would otherwise leave a lit capacity readout
   * sitting on the felt where it died, for a tank that no longer exists and can hold no
   * shells. That reads as a rendering fault rather than as a cue. `update` retires the
   * strip on a false return; the sibling arms reach the same end by other routes (the ring
   * and the muzzle flash are latched sub-0.2s blinks that finish before a death is
   * legible; the turret stutter is dropped the moment entities.ts disposes the dead tank's
   * view, which is the frame after it dies).
   */
  function follow(row: Row, world: World): boolean {
    const owner = world.tanks.find((t) => t.id === row.ownerId);
    if (!owner || !owner.alive) return false;
    // World (x, y) -> three (x, z). +z is toward the bottom of the screen at this camera.
    row.group.position.set(owner.pos.x, PIP_Y, owner.pos.y + ROW_FORWARD);
    return true;
  }

  /** End the strip now. `life` is the retired sentinel `update` skips on later frames. */
  function retire(row: Row): void {
    row.life = 0;
    row.group.visible = false;
  }

  function spawn(events: SimEvent[], world: World, cue: BlockedFireCue | null | undefined): void {
    // Channel, then arm -- see blocked-fire-muzzle.ts's own gate for why both halves.
    if (!cueDrives(cue, 'visual') || cue !== 'pips') return;
    for (const e of events) {
      if (e.type !== 'fire-blocked') continue;
      const owner = world.tanks.find((t) => t.id === e.ownerId);
      if (!owner || !owner.alive || owner.kind !== 'player') continue;
      const cap = configFor(owner.kind).weapon.maxActiveProjectiles;
      // The refused owner's OWN shells, the same count the cap is enforced against.
      const spent = ownerShellCount(world, owner.id);
      const row = rowFor(owner.id, cap);
      row.lit = row.pips.map((_, i) => i < spent);
      for (let i = 0; i < row.pips.length; i++) {
        row.pips[i].material.color.setHex(row.lit[i] ? SPENT_COLOR : FREE_COLOR);
        row.pips[i].visible = true;
      }
      row.life = LIFETIME_SECONDS;
      row.group.visible = true;
      // Alive by the guard above, so the return value cannot be false here.
      follow(row, world);
    }
  }

  function update(dt: number, world: World): void {
    for (const row of [...rows.values()]) {
      if (row.life <= 0) continue;
      row.life -= dt;
      if (row.life <= 0) {
        retire(row);
        continue;
      }
      // Follow, or go out with the tank: see `follow`'s own comment for why a dead owner
      // ends the cue rather than freezing it.
      if (!follow(row, world)) {
        retire(row);
        continue;
      }
      const k = 1 - row.life / LIFETIME_SECONDS;
      // Full brightness for the hold, then out. A strip that faded from the first frame
      // would be dimmest exactly while the player is still working out what it says.
      const fade = k <= HOLD_FRACTION ? 1 : 1 - (k - HOLD_FRACTION) / (1 - HOLD_FRACTION);
      // Written on EVERY frame under the CURRENT policy rather than skipped when reduced
      // motion is on -- the landmine blocked-fire-ring.ts records: skipping the term
      // freezes a live pip at whatever size it had reached when the preference flipped.
      const pop = reducedMotion
        ? 1
        : 1 + (POP_SCALE - 1) * Math.max(0, 1 - (LIFETIME_SECONDS - row.life) / POP_SECONDS);
      for (let i = 0; i < row.pips.length; i++) {
        const lit = row.lit[i];
        row.pips[i].material.opacity = (lit ? 1 : FREE_OPACITY) * fade;
        // Only the lit pips pop: the flash is the message, and an empty slot jumping
        // would say something happened to capacity the player still has.
        row.pips[i].scale.setScalar(lit ? pop : 1);
      }
    }
  }

  function dispose(): void {
    for (const row of rows.values()) {
      scene.remove(row.group);
      for (const pip of row.pips) pip.material.dispose();
    }
    geometry.dispose();
    rows.clear();
  }

  return {
    spawn,
    update,
    setReducedMotion: (on: boolean) => { reducedMotion = on; },
    dispose,
  };
}
