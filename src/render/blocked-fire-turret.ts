import type * as THREE from 'three';
import type { World } from '../sim/world';
import type { SimEvent } from '../sim/events';
import { cueDrives, type BlockedFireCue } from '../presentation/blocked-fire';

/**
 * Issue #356's weapon-local MOTION candidate, and issue #516's `turret` arm: the gun
 * kicks as if it had fired, and nothing leaves it.
 *
 * WHY A SECOND WEAPON-LOCAL ARM. `muzzle` and this one sit on the same part of the tank
 * on purpose, because they test opposite hypotheses about it. The muzzle flash says the
 * refusal in LIGHT, which the eye catches anywhere on screen but which a player may read
 * as a shot they simply lost track of. This says it in MOTION, which cannot be mistaken
 * for a discharge -- the barrel rocks back and settles with no shell and no flash, the
 * unmistakable shape of a mechanism that cycled and delivered nothing. Comparing them is
 * the point; adopting either is #356's decision, not this system's.
 *
 * IT MOVES THE REAL TURRET, through `EntityViews.turretOf`, rather than drawing a ghost
 * barrel of its own. A stutter drawn on a separate mesh would be a second gun beside the
 * first, which is not a recoil at all. The offset goes on the turret group's LOCAL +x --
 * the axis the barrel points down (entities.ts lays the barrel along the turret's +x) --
 * so a negative value is recoil, straight back along the bore, whatever direction the
 * hull or the turret happens to face.
 *
 * IT WRITES A CHANNEL `sync` DOES NOT. entities.ts assigns the turret's `rotation.y`
 * every frame and its `position` exactly once, at construction; this writes `position.x`
 * and always returns it to zero when the stutter ends, so the two never fight and no
 * offset can outlive its cue. The view behind a tank id is NOT stable (a kind change or a
 * repaint rebuilds it), which is why the object is looked up per frame instead of latched
 * at spawn.
 *
 * SILENT BY DEFAULT and PLAYER-ONLY, the contract every arm shares.
 */
export interface BlockedFireTurretSystem {
  /** Start a stutter for every refusal this frame that belongs to a player tank. */
  spawn(events: SimEvent[], world: World, cue: BlockedFireCue | null | undefined): void;
  update(dt: number): void;
  setReducedMotion(on: boolean): void;
  dispose(): void;
}

/**
 * Where the moving turret comes from. Structural, not `EntityViews` itself: this arm
 * needs one lookup, and taking the whole interface would make every test here build a
 * full entity-view set to exercise a number.
 */
export interface TurretSource {
  turretOf(tankId: number): THREE.Object3D | null;
}

/**
 * Feel constants. OWNER DECISIONS, stated rather than buried:
 *
 *  - 0.16s total, so the whole gesture is over inside a fifth of a second. A refusal is a
 *    small event and must not compete with an explosion.
 *  - KICK 0.13 world units, which the decay term below turns into a FIRST BUMP of about
 *    0.098 and a second of about 0.033 -- roughly a tenth of the hull's length and a
 *    quarter of the turret's own radius (0.36). Measured by eye against a rendered frame
 *    (the probe in this PR's evidence): 0.07 was invisible in a still and marginal in
 *    motion; this reads as a rock without the turret sliding off its ring.
 *  - TWO bumps (`CYCLES = 1` through `abs(sin)`), the second a third the size of the
 *    first, because one push reads as a nudge and a stutter reads as a mechanism.
 */
const LIFETIME_SECONDS = 0.16;
const KICK = 0.13;
const CYCLES = 1;
/**
 * Reduced motion (issue #289/#453 policy, the shape blocked-fire-ring.ts uses): keep the
 * cue, remove the travel. There is no version of a recoil with no movement at all, so
 * the animated stutter becomes ONE held offset -- the gun sits back for the cue's life
 * and returns once -- rather than oscillating. Half amplitude, because a static offset is
 * on screen far longer than any single bump of the animated one.
 */
const REST_KICK = KICK / 2;

export function createBlockedFireTurretSystem(turrets: TurretSource): BlockedFireTurretSystem {
  let reducedMotion = false;
  /** tank id -> seconds elapsed. One stutter per tank; a fresh refusal restarts it. */
  const active = new Map<number, number>();

  /** How far back the gun sits, in world units, at `k` (0 -> 1) through the stutter. */
  function offsetAt(k: number): number {
    if (reducedMotion) return REST_KICK;
    // `abs`, so every bump is RECOIL. A signed sine would push the barrel forward on the
    // second half of each cycle, which reads as the gun lunging at the target.
    return KICK * (1 - k) * Math.abs(Math.sin(k * Math.PI * 2 * CYCLES));
  }

  function rest(tankId: number): void {
    const turret = turrets.turretOf(tankId);
    if (turret) turret.position.x = 0;
  }

  function spawn(events: SimEvent[], world: World, cue: BlockedFireCue | null | undefined): void {
    // Channel, then arm -- see blocked-fire-muzzle.ts's own gate for why both halves.
    if (!cueDrives(cue, 'visual') || cue !== 'turret') return;
    for (const e of events) {
      if (e.type !== 'fire-blocked') continue;
      // Player tanks only: `fire-blocked` is emitted for every refused owner, and an
      // enemy's gun twitching would report the enemy's ammunition to the player.
      const owner = world.tanks.find((t) => t.id === e.ownerId);
      if (!owner || !owner.alive || owner.kind !== 'player') continue;
      active.set(owner.id, 0);
    }
  }

  function update(dt: number): void {
    for (const [tankId, elapsed] of [...active]) {
      const next = elapsed + dt;
      if (next >= LIFETIME_SECONDS) {
        // Always land back at zero. Leaving the last frame's offset in place would park
        // the turret permanently off-centre on a tank that is otherwise fine.
        rest(tankId);
        active.delete(tankId);
        continue;
      }
      active.set(tankId, next);
      const turret = turrets.turretOf(tankId);
      // No view: the tank died or was rebuilt mid-stutter. Drop the entry rather than
      // counting down against an object that no longer exists -- a rebuilt turret starts
      // at zero anyway, so there is nothing left to reset.
      if (!turret) {
        active.delete(tankId);
        continue;
      }
      // Recomputed from the CURRENT preference every frame, so a reduced-motion toggle
      // mid-stutter snaps the gun to its held offset instead of freezing it wherever the
      // animation had reached -- the landmine blocked-fire-ring.ts records for its ring.
      turret.position.x = -offsetAt(next / LIFETIME_SECONDS);
    }
  }

  function dispose(): void {
    for (const tankId of active.keys()) rest(tankId);
    active.clear();
  }

  return {
    spawn,
    update,
    setReducedMotion: (on: boolean) => { reducedMotion = on; },
    dispose,
  };
}
