import * as THREE from 'three';
import type { Vec2 } from '../sim/types';
import type { World } from '../sim/world';
import type { SimEvent } from '../sim/events';
import { createScene, type SceneContext } from './scene';
import { createEntityViews, type EntityViews } from './entities';
import { createParticleSystem, type ParticleSystem } from './particles';

export interface Renderer3D {
  render(prev: World, curr: World, alpha: number, events: SimEvent[], dt: number): void;
  screenToGround(clientX: number, clientY: number): Vec2;
  resize(w: number, h: number): void;
  dispose(): void;
}

export function createRenderer(
  canvas: HTMLCanvasElement,
  worldWidth: number,
  worldHeight: number,
): Renderer3D {
  const ctx: SceneContext = createScene(canvas, worldWidth, worldHeight);
  const entities: EntityViews = createEntityViews(ctx.scene);
  const particles: ParticleSystem = createParticleSystem(ctx.scene);

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
    entities.dispose();
    particles.dispose();
    ctx.dispose();
  }

  return { render, screenToGround, resize, dispose };
}
