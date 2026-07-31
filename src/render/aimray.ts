import * as THREE from 'three';
import type { World } from '../sim/world';
import { BULLET_Y } from './entities';

/**
 * Dev-only overlay: draws where the player's turret is actually pointing.
 *
 * NOT a missing feature made optional. The BARREL is the aim indicator, by
 * design. This exists because a wrong aim mapping and a correctly-drawn barrel
 * look identical on screen: `screenToGround` unprojects the cursor onto the
 * ground plane, `applyPlayerInput` slews the turret toward it at a finite rate,
 * and if either is wrong the tank still renders a perfectly plausible barrel
 * pointing somewhere the player did not choose.
 *
 * Drawing the ray from the tank along `turretAngle` makes the two separable: if
 * the ray disagrees with the barrel the render is wrong, and if they agree but
 * both miss the cursor the mapping is.
 */
export interface AimRay {
  /** Point the ray along the player's turret for this frame. Hidden if no player. */
  sync(world: World): void;
  dispose(): void;
}

/** How far along the turret heading to draw, in world units. */
const RAY_LENGTH = 40;
/**
 * At shell flight height, because the ray PREDICTS the shell's path and must lie on
 * it. This was a hardcoded 0.35 -- the shell height of its day -- and stayed behind
 * when BULLET_Y moved to the barrel centreline, so the overlay diverged on screen
 * from the path shells actually take. (Well clear of the ground, so no z-fighting.)
 */
const RAY_Y = BULLET_Y;

export function createAimRay(scene: THREE.Scene): AimRay {
  const geometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, RAY_Y, 0),
    new THREE.Vector3(RAY_LENGTH, RAY_Y, 0),
  ]);
  const material = new THREE.LineBasicMaterial({ color: 0xffe066, transparent: true, opacity: 0.6 });
  const line = new THREE.Line(geometry, material);
  line.visible = false;
  scene.add(line);

  function sync(world: World): void {
    const player = world.tanks.find((t) => t.kind === 'player' && t.alive);
    if (!player) {
      line.visible = false;
      return;
    }
    // Same convention as entities.ts: world (x, y) -> three (x, z), and a world
    // angle maps to rotation.y = -angle, because a CCW turn in the sim's
    // xy-plane is clockwise about three's +y.
    line.position.set(player.pos.x, 0, player.pos.y);
    line.rotation.y = -player.turretAngle;
    line.visible = true;
  }

  function dispose(): void {
    scene.remove(line);
    geometry.dispose();
    material.dispose();
  }

  return { sync, dispose };
}
