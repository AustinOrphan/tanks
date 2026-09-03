import type { BlockedFireCue } from '../presentation/blocked-fire';
import * as THREE from 'three';
import type { Vec2 } from '../sim/types';
import type { World } from '../sim/world';
import type { SimEvent } from '../sim/events';
import { createScene, type SceneContext } from './scene';
import type { RenderQuality } from './quality';
import { createEntityViews, type EntityViews } from './entities';
import type { MineWarnStyle } from './mine-warning';
import { createParticleSystem, type ParticleSystem } from './particles';
import { createDeathPulseSystem, type DeathPulseSystem } from './death-pulse';
import { createTreadTrailSystem, type TreadTrailSystem } from './tread-trails';
import { createAimRay, type AimRay } from './aimray';
import type { SkinId } from '../presentation/customization';
import { createMineDebug, type MineDebug } from './minedebug';
import { createAiContact, type AiContact } from './ai-contact';
import { createBlockedFireRingSystem, type BlockedFireRingSystem } from './blocked-fire-ring';
import { createBlockedFireMuzzleSystem, type BlockedFireMuzzleSystem } from './blocked-fire-muzzle';
import { createBarrelRecoilSystem } from './barrel-recoil';
import { createBlockedFirePipsSystem, type BlockedFirePipsSystem } from './blocked-fire-pips';

export interface Renderer3D {
  render(prev: World, curr: World, alpha: number, events: SimEvent[], dt: number): void;
  screenToGround(clientX: number, clientY: number): Vec2;
  resize(w: number, h: number): void;
  /** Re-aim the scene at a new board size. In place: the GL context survives. */
  refit(worldWidth: number, worldHeight: number, boundary: number): void;
  /**
   * The game layer announcing that the World handed to `render` was REPLACED wholesale
   * -- a level switch -- rather than stepped forward from the previous one. Everything
   * that carries state ACROSS frames (interpolation history, tread anchors) must drop
   * it; the next `render` does exactly that, once.
   *
   * Issue #531. This exists because the inference it replaces is unsound, not merely
   * inconvenient: presentation used to detect the discontinuity by comparing
   * `roundStartTick` between the two worlds, and `createWorld` starts EVERY world at
   * `roundStartTick: 1` while only `resetArena` ever moves it. A level cleared on its
   * first attempt therefore hands the renderer a fresh world whose 1 matches the
   * outgoing world's 1, the comparison stays silent, and the tread system walks the gap
   * between the old board's coordinates and the new spawn printing decals the whole way
   * -- measured on tread-trails.ts with this announcement ignored, two decals from a
   * short drive became 158.
   *
   * A pushed announcement also fits the one-way-projection rule better than any repair
   * of the inference would: a level switch is something the game layer DOES, at one
   * site (`loop.ts`'s `switchTo`, through `driver.reset`), and it is the only layer that
   * knows it happened. The alternative -- giving `World` a generation counter that only
   * presentation reads -- would push a presentation concern into the sim's snapshot.
   * `entities.ts`'s per-tank `revived` (issue #239) stays where it is: it is a different
   * fact, true of ONE tank in a world that was neither replaced nor restarted.
   */
  worldReplaced(): void;
  /**
   * The paint shop: restyle the player live. Null hex restores the roster default;
   * null accentHex means `auto` -- derive the pattern's second tone from the hull.
   */
  setPlayerStyle(hex: string | null, skin: SkinId, accentHex: string | null): void;
  /**
   * The resolved reduced-motion policy (issue #289), pushed in from `game/loop.ts`'s one
   * effective-settings subscription -- the same call site that already tells the HUD.
   *
   * A SETTER beside setPlayerStyle rather than a constructor option, and for the same
   * reason: `'system'` follows the OS, which can change with the page open, so the value
   * has to be able to arrive after the renderer exists. Nothing under src/render/ reads a
   * media query; game/capabilities.ts is the one place anything asks.
   */
  setReducedMotion(on: boolean): void;
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
  /** Experimental mine-warning treatment (`mineWarn` dev flag); absent = shipped default. */
  readonly mineWarn?: MineWarnStyle | null;
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
  /**
   * `?dev=1&enemyDeathPulse=1` (devflags.ts): whether a non-player death also rings.
   * A player death rings unconditionally either way -- see death-pulse.ts's own doc
   * comment for why the gate lives inside `spawn`, not here.
   */
  readonly enemyDeathPulse?: boolean;
  /**
   * `?dev=1&aiContact=1` (devflags.ts): draws which opponent each AI is committed to and
   * whether it can see it, is remembering it, or has nothing. See ai-contact.ts.
   */
  readonly aiContact?: boolean;
  /**
   * `?dev=1&blockedFire=<cue>` (devflags.ts): which of issue #356's candidate refusal
   * cues to show. Three of the four remaining visual arms are built here --
   * `ring`/`ring-audio` (blocked-fire-ring.ts), `muzzle` (blocked-fire-muzzle.ts) and
   * `pips` (blocked-fire-pips.ts); the fourth, `hud`, is a DOM surface and lives in
   * game/blocked-fire-hud.ts. The arm that WON, gun recoil, is not among them: issue
   * #526 made it unconditional (barrel-recoil.ts below), so it is not a cue any more.
   * Null/absent draws nothing, and
   * each system re-checks the cue in its own `spawn` -- these constructor gates only
   * decide whether the scene objects exist at all.
   */
  readonly blockedFire?: BlockedFireCue | null;
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
  const entities: EntityViews = createEntityViews(ctx.scene, ctx.textures, options.mineWarn ?? null);
  if (options.playerColor || options.playerSkin || options.playerAccent) {
    entities.setPlayerStyle(
      options.playerColor ?? null,
      options.playerSkin ?? 'solid',
      options.playerAccent ?? null,
    );
  }
  const particles: ParticleSystem = createParticleSystem(ctx.scene);
  const deathPulse: DeathPulseSystem = createDeathPulseSystem(ctx.scene);
  const treadTrails: TreadTrailSystem = createTreadTrailSystem(ctx.scene);
  const aimRay: AimRay | null = options.aimRay ? createAimRay(ctx.scene) : null;
  const mineDebug: MineDebug | null =
    options.mineReach || options.mineTimer
      ? createMineDebug(ctx.scene, { reach: !!options.mineReach, timer: !!options.mineTimer })
      : null;
  const aiContact: AiContact | null = options.aiContact ? createAiContact(ctx.scene) : null;
  const blockedFireRing: BlockedFireRingSystem | null =
    options.blockedFire === 'ring' || options.blockedFire === 'ring-audio'
      ? createBlockedFireRingSystem(ctx.scene)
      : null;
  // One arm per cue, built only for the cue that names it: an unbuilt system is the
  // cheapest possible "off", and the comparison is between one arm at a time.
  const blockedFireMuzzle: BlockedFireMuzzleSystem | null =
    options.blockedFire === 'muzzle' ? createBlockedFireMuzzleSystem(ctx.scene) : null;
  // NOT gated on a cue, unlike every system around it: the gun kicks whenever it cycles,
  // on a shot and on a refusal alike (issue #526). `entities`, not the scene, because it
  // moves the REAL barrel and looks it up per frame through EntityViews.barrelOf.
  const barrelRecoil = createBarrelRecoilSystem(entities);
  const blockedFirePips: BlockedFirePipsSystem | null =
    options.blockedFire === 'pips' ? createBlockedFirePipsSystem(ctx.scene) : null;

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
    aiContact?.sync(curr);
    particles.spawn(events);
    particles.update(dt);
    deathPulse.spawn(events, curr, { enemyEnabled: !!options.enemyDeathPulse });
    blockedFireRing?.spawn(events, curr, options.blockedFire);
    blockedFireRing?.update(dt);
    blockedFireMuzzle?.spawn(events, curr, options.blockedFire);
    blockedFireMuzzle?.update(dt);
    // After entities.sync, though no longer load-bearing the way it was when this moved
    // the turret GROUP: sync writes `turret.rotation.y` every frame and never touches the
    // barrel's own position, which entities.ts sets once at construction. Kept in place
    // beside the muzzle flash because the two dress the same shot.
    barrelRecoil.spawn(events, curr);
    barrelRecoil.update(dt);
    // `curr` in update too: the pip strip follows its tank for the half-second it lives.
    blockedFirePips?.spawn(events, curr, options.blockedFire);
    blockedFirePips?.update(dt, curr);
    deathPulse.update(dt);
    treadTrails.sync(prev, curr);
    treadTrails.update(dt);
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

  // Forwarded to each system that keeps cross-frame state, rather than latched here and
  // passed down through `render`'s already long argument list: each system then owns the
  // one-frame lifetime of its own latch and can be tested for it in jsdom, which
  // `createRenderer` itself (a real GL context) cannot be.
  function worldReplaced(): void {
    entities.worldReplaced();
    treadTrails.worldReplaced();
  }

  function refit(w: number, h: number, boundaryRing: number): void {
    centre = { x: w / 2, y: h / 2 };
    ctx.refit(w, h, boundaryRing);
  }

  function dispose(): void {
    aimRay?.dispose();
    mineDebug?.dispose();
    aiContact?.dispose();
    blockedFireRing?.dispose();
    blockedFireMuzzle?.dispose();
    barrelRecoil.dispose();
    blockedFirePips?.dispose();
    entities.dispose();
    particles.dispose();
    deathPulse.dispose();
    treadTrails.dispose();
    ctx.dispose();
  }

  return {
    render,
    screenToGround,
    resize,
    refit,
    worldReplaced,
    setPlayerStyle: (hex, skin, accentHex) => entities.setPlayerStyle(hex, skin, accentHex),
    // Forwarded, not stored: every consumer of the policy owns its own reduced treatment,
    // so the renderer is a router here rather than a second source of truth. Today that is
    // the death ring; each effect added under issue #289 joins this line.
    setReducedMotion: (on: boolean) => {
      deathPulse.setReducedMotion(on);
      blockedFireRing?.setReducedMotion(on);
      blockedFireMuzzle?.setReducedMotion(on);
      barrelRecoil.setReducedMotion(on);
      blockedFirePips?.setReducedMotion(on);
    },
    dispose,
  };
}
