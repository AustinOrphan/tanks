import * as THREE from 'three';
import type { Vec2 } from '../sim/types';
import type { World } from '../sim/world';
import type { SimEvent } from '../sim/events';
import { createScene, type SceneContext } from './scene';
import { createEntityViews, type EntityViews } from './entities';
import { createParticleSystem, type ParticleSystem } from './particles';
import { createAimRay, type AimRay } from './aimray';
import { createMineDebug, type MineDebug } from './minedebug';

export interface Renderer3D {
  render(prev: World, curr: World, alpha: number, events: SimEvent[], dt: number): void;
  screenToGround(clientX: number, clientY: number): Vec2;
  resize(w: number, h: number): void;
  dispose(): void;
}

export interface RendererOptions {
  /**
   * Dev only: draw a ray along the player's turret. See aimray.ts -- the barrel
   * IS the aim indicator; this separates a bad mapping from a bad render.
   */
  readonly aimRay?: boolean;
  /** Dev overlay: ring each mine's trigger and kill radii. */
  readonly mineReach?: boolean;
  /** Dev overlay: print each mine's remaining fuse beside it. */
  readonly mineTimer?: boolean;
}

export function createRenderer(
  canvas: HTMLCanvasElement,
  worldWidth: number,
  worldHeight: number,
  boundary: number,
  options: RendererOptions = {},
): Renderer3D {
  const ctx: SceneContext = createScene(canvas, worldWidth, worldHeight, boundary);
  const entities: EntityViews = createEntityViews(ctx.scene);
  const particles: ParticleSystem = createParticleSystem(ctx.scene);
  const aimRay: AimRay | null = options.aimRay ? createAimRay(ctx.scene) : null;
  const mineDebug: MineDebug | null =
    options.mineReach || options.mineTimer
      ? createMineDebug(ctx.scene, { reach: !!options.mineReach, timer: !!options.mineTimer })
      : null;

  const raycaster = new THREE.Raycaster();
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const ndc = new THREE.Vector2();
  const hitPoint = new THREE.Vector3();

  function render(
    prev: World,
    curr: World,
    alpha: number,
    events: SimEvent[],
    dt: number,
  ): void {
    entities.sync(prev, curr, alpha);
    aimRay?.sync(curr);
    mineDebug?.sync(curr);
    particles.spawn(events);
    particles.update(dt);
    ctx.renderer.render(ctx.scene, ctx.camera);
  }

  function screenToGround(clientX: number, clientY: number): Vec2 {
    const rect = canvas.getBoundingClientRect();
    ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, ctx.camera);
    const hit = raycaster.ray.intersectPlane(groundPlane, hitPoint);
    if (!hit) return { x: worldWidth / 2, y: worldHeight / 2 };
    // three (x, z) -> world (x, y)
    return { x: hitPoint.x, y: hitPoint.z };
  }

  function resize(w: number, h: number): void {
    ctx.resize(w, h);
  }

  function dispose(): void {
    aimRay?.dispose();
    mineDebug?.dispose();
    entities.dispose();
    particles.dispose();
    ctx.dispose();
  }

  return { render, screenToGround, resize, dispose };
}
