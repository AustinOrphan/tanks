import * as THREE from 'three';
import type { Vec2 } from '../sim/types';
import type { World } from '../sim/world';
import type { SimEvent } from '../sim/events';
import { createScene, type SceneContext } from './scene';
import type { RenderQuality } from './quality';
import { createEntityViews, type EntityViews } from './entities';
import { createParticleSystem, type ParticleSystem } from './particles';
import { createAimRay, type AimRay } from './aimray';
import type { SkinId } from '../game/customization';
import { createMineDebug, type MineDebug } from './minedebug';

export interface Renderer3D {
  render(prev: World, curr: World, alpha: number, events: SimEvent[], dt: number): void;
  screenToGround(clientX: number, clientY: number): Vec2;
  resize(w: number, h: number): void;
  /** Re-aim the scene at a new board size. In place: the GL context survives. */
  refit(worldWidth: number, worldHeight: number, boundary: number): void;
  /**
   * The paint shop: restyle the player live. Null hex restores the roster default;
   * null accentHex means `auto` -- derive the pattern's second tone from the hull.
   */
  setPlayerStyle(hex: string | null, skin: SkinId, accentHex: string | null): void;
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
  /** The paint shop's saved hull colour, applied from the first frame. */
  readonly playerColor?: string;
  /** The paint shop's saved skin, applied from the first frame. */
  readonly playerSkin?: SkinId;
  /**
   * The paint shop's saved accent tone, applied from the first frame. Undefined/null
   * means `auto` -- derive the tone from playerColor, exactly as skins.ts always has.
   */
  readonly playerAccent?: string | null;
  /**
   * The render quality preset (see quality.ts). Undefined leaves scene.ts's own
   * default, which is `high` -- today's shipped values -- so the default construction
   * path here must not move a single rendered pixel either.
   */
  readonly quality?: RenderQuality;
}

export function createRenderer(
  canvas: HTMLCanvasElement,
  worldWidth: number,
  worldHeight: number,
  boundary: number,
  options: RendererOptions = {},
): Renderer3D {
  // Mutable: refit() moves the board, and screenToGround's miss-fallback must keep
  // pointing at the CURRENT arena's centre.
  let centre: Vec2 = { x: worldWidth / 2, y: worldHeight / 2 };
  const ctx: SceneContext = createScene(canvas, worldWidth, worldHeight, boundary, options.quality);
  const entities: EntityViews = createEntityViews(ctx.scene, ctx.textures);
  if (options.playerColor || options.playerSkin || options.playerAccent) {
    entities.setPlayerStyle(
      options.playerColor ?? null,
      options.playerSkin ?? 'solid',
      options.playerAccent ?? null,
    );
  }
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
    entities.sync(prev, curr, alpha, dt);
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
    if (!hit) return { x: centre.x, y: centre.y };
    // three (x, z) -> world (x, y)
    return { x: hitPoint.x, y: hitPoint.z };
  }

  function resize(w: number, h: number): void {
    ctx.resize(w, h);
  }

  function refit(w: number, h: number, boundaryRing: number): void {
    centre = { x: w / 2, y: h / 2 };
    ctx.refit(w, h, boundaryRing);
  }

  function dispose(): void {
    aimRay?.dispose();
    mineDebug?.dispose();
    entities.dispose();
    particles.dispose();
    ctx.dispose();
  }

  return {
    render,
    screenToGround,
    resize,
    refit,
    setPlayerStyle: (hex, skin, accentHex) => entities.setPlayerStyle(hex, skin, accentHex),
    dispose,
  };
}
