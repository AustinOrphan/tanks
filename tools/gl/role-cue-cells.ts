/**
 * How much of the enemy role cue survives its own muzzle effects (issue #1018).
 *
 * Shared by the table page (`role-cue-overlap.html`, run by `node tools/gl/role-cue-overlap.mjs`)
 * and by `tools/gl/harness.ts`, which runs the controls, the staging guard and one fixed cell of
 * the same measurement on every `npm run test:gl`. Everything goes through `createRenderer`, the
 * production composition, because only there are the quality preset and the motion policy real.
 *
 * THE EFFECTS, derived from renderer.ts's construction (population: 13 systems built there).
 * Five are built on an ordinary page with no developer flag: the particle system, the death
 * pulse, the tread trails, the barrel recoil and the muzzle smoke (`null` on `low`). Of those,
 * the three that a `fire` or `fire-blocked` event draws at the gun are COVERED here:
 *
 *  - muzzle smoke (`fire` and `fire-blocked`, the refusal's cloud drawn nearly solid);
 *  - the particle burst `particles.ts` spawns on `fire` at the event's `pos` (none on a refusal);
 *  - the barrel recoil, which moves the gun itself. It is not an occluder, so it is never
 *    removed: both frames of every comparison carry it, at the same tick and pose.
 *
 * Left uncovered, and why: the death pulse draws only on a death; the tread trails only behind a
 * moving tank, and these tanks stand still; the eight others (wreck, shell trail, aim ray, mine
 * debug, AI contact, and the three refusal cues that take `options.blockedFire`) exist only behind
 * a developer flag, so none of them is a shipped effect. The SHELL BODY is drawn by entities.ts,
 * not by an effect system; these synthetic events put no bullet in the world, so no shell is drawn.
 *
 * HOW EACH EFFECT IS REMOVED for the no-effect baseline. Smoke: `quality.muzzleSmoke: null`,
 * the field `low` already uses. Burst: the event's `pos` is moved off the board, because
 * `particles.ts` bursts at `pos` while the smoke (muzzle-smoke.ts) and the recoil
 * (barrel-recoil.ts) both read the owner and the world, never `pos`. The `burst` control below
 * pins that: with the smoke off, relocating `pos` changes the frame only by the burst.
 *
 * DETERMINISM. `particles.ts` draws from `Math.random` by default, so two renders of one shot
 * differ by their sparks. Every renderer here is built with a delegating rng (see `delegate`),
 * and every sequence points it at the same seeded stream, so two renderers fed the same sequence
 * draw the same sparks. The first control (two unarmed renderers, same effect, 0 differing
 * pixels) is what proves it, and it failed by 51-79 pixels on every burst cell until the delegate
 * existed: seeding `Math.random` per sequence reached nothing, because the particle system had
 * already captured the real one.
 */
import { createRenderer } from '../../src/render/renderer';
import { QUALITY_PRESETS, type QualityPreset } from '../../src/render/quality';
import { createWorld, type World } from '../../src/sim/world';
import { spawnBullet } from '../../src/sim/bullets';
import { configFor } from '../../src/sim/config';
import type { SimEvent } from '../../src/sim/events';
import type { Spawn, Tank } from '../../src/sim/types';
import type { EnemyRoleCue } from '../../src/presentation/enemy-role';

export type CueKind = 'brown' | 'olive' | 'teal';
export type CueLever = 'flare' | 'riser';
export type CueEvent = 'fire' | 'fire-blocked';
export type CueMotion = 'full' | 'reduced';
export type CueEffect = 'smoke' | 'burst' | 'both';
/**
 * Which way the tank faces. ADDED AFTER THE FIRST RUN, not fixed in advance with the other axes:
 * that run measured `east` alone, where the gun is side-on to the camera and the cloud drifts
 * beside the flare, so occlusion was close to nil. `toward-camera` aims hull and gun down the
 * screen, which puts the cloud between the camera and the muzzle: the other end of the range.
 */
export type CuePose = 'east' | 'toward-camera';
export const POSE_ANGLE: Record<CuePose, number> = { east: 0, 'toward-camera': Math.PI / 2 };

/**
 * The (kind, lever) pairs whose footprint must be NONZERO: the staging guard. Olive has no riser
 * (`mineCapacity` 0) and brown's standard shell gets the shipped flare size, so neither of those
 * two pairs is here.
 */
export const LEVER_PAIRS: readonly { kind: CueKind; lever: CueLever }[] = [
  { kind: 'olive', lever: 'flare' },
  { kind: 'teal', lever: 'flare' },
  { kind: 'brown', lever: 'riser' },
  { kind: 'teal', lever: 'riser' },
];
/** Brown's flare footprint is 0 by construction: recorded as a check, not a measurement. */
export const ZERO_BY_CONSTRUCTION = { kind: 'brown', lever: 'flare' } as const;

/**
 * The sampled ticks after the event, fixed before measuring. The event is fed on tick 0; the
 * smoke lives 45 ticks (`LIFETIME_SECONDS` 0.75 s), the recoil about 10 (0.16 s). So 0 and 6 are
 * inside the recoil, and 15, 30 and 44 span the rest of the cloud's life.
 */
export const SAMPLE_TICKS = [0, 6, 15, 30, 44] as const;

/** A small board so the one tank fills a useful share of a small frame. */
const BOARD_W = 4;
const BOARD_H = 3;
const BOARD_EDGE = 1;
const DT = 1 / 60;
/**
 * Ticks of nothing before each sequence after a renderer's first: past every effect's life. The
 * longest is a spark's, 0.6 s x 1.3 at most (`particles.ts`), 46.8 ticks; the smoke lives 45 and
 * the recoil about 10. The first sequence on a renderer has nothing before it to outlive.
 */
const GAP_TICKS = 48;
const SEED = 0x51ce;

/**
 * The random stream the renderers built here draw from. `createParticleSystem` takes its rng as
 * `rng = Math.random`, a default evaluated at CONSTRUCTION, so replacing `Math.random` later
 * reaches nothing. `createCueRig` therefore hands it this delegate while the renderer is built,
 * and each sequence points the delegate at a freshly seeded stream.
 */
const realRandom = Math.random;
let stream: () => number = realRandom;
const delegate = (): number => stream();

function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One tank of `kind`, id `id`, near the centre, hull and gun facing `angle`. */
function tankWorld(kind: CueKind, id: number, angle: number): World {
  // Set back from the centre against its own heading, so the cloud ahead of the gun stays on
  // the board whichever way it faces.
  const pos = { x: BOARD_W / 2 - 0.3 * Math.cos(angle), y: BOARD_H / 2 - 0.3 * Math.sin(angle) };
  const tank: Tank = {
    id, kind, pos, bodyAngle: angle, turretAngle: angle, alive: true,
    desiredMove: { x: 0, y: 0 }, activeMineIds: [], fireCooldown: 0, mineCooldown: 0,
    aiState: 'idle', aiTimer: 0,
  };
  const spawns: Spawn[] = [{ kind, pos, angle }];
  return createWorld({ walls: [], tanks: [tank], spawns, lives: 3 });
}

/** The event the sim emits for this tank, built by the sim's own `spawnBullet` on a copy. */
function eventFor(world: World, id: number, event: CueEvent, burst: boolean): SimEvent {
  if (event === 'fire-blocked') return { type: 'fire-blocked', ownerId: id, reason: 'shell-cap' };
  const scratch = structuredClone(world);
  const events: SimEvent[] = [];
  const { kind, turretAngle } = world.tanks[0];
  spawnBullet(scratch, id, turretAngle, configFor(kind).weapon.bulletType, events);
  const fired = events.find((e) => e.type === 'fire');
  if (fired === undefined || fired.type !== 'fire') throw new Error(`spawnBullet emitted no fire for ${kind}`);
  // Off the board: the burst lands where nothing is drawn, and nothing else reads `pos`.
  return burst ? fired : { ...fired, pos: { x: -1000, y: -1000 } };
}

export interface CueRig {
  readonly canvas: HTMLCanvasElement;
  /** Feed one sequence and return one RGBA frame per sampled tick. */
  sequence(
    kind: CueKind, event: CueEvent, burst: boolean, ticks: readonly number[], pose?: CuePose,
  ): Promise<Uint8ClampedArray[]>;
  dispose(): void;
}

/**
 * A renderer configured for one arm: the cue lever (or none), the preset, whether its smoke is
 * built, and the motion policy. Each `sequence` uses a fresh tank id, so the previous tank's
 * view is torn down, and starts after a gap long enough for every earlier effect to have expired.
 */
export function createCueRig(opts: {
  lever: CueLever | null;
  preset: QualityPreset;
  smoke: boolean;
  motion: CueMotion;
  width: number;
  height: number;
}): CueRig {
  const canvas = document.createElement('canvas');
  canvas.width = opts.width;
  canvas.height = opts.height;
  canvas.style.cssText = 'position:fixed;left:0;top:0;z-index:1';
  document.body.appendChild(canvas);
  const quality = opts.smoke ? QUALITY_PRESETS[opts.preset] : { ...QUALITY_PRESETS[opts.preset], muzzleSmoke: null };
  const enemyRole: EnemyRoleCue | undefined = opts.lever ?? undefined;
  Math.random = delegate;
  let r: ReturnType<typeof createRenderer>;
  try {
    r = createRenderer(canvas, BOARD_W, BOARD_H, BOARD_EDGE, { quality, ...(enemyRole ? { enemyRole } : {}) });
  } finally {
    Math.random = realRandom;
  }
  r.setReducedMotion(opts.motion === 'reduced');
  let nextId = 1;

  const read = (): Uint8ClampedArray => {
    const frame = r.captureFrame();
    const ctx2d = frame.image.getContext('2d');
    if (ctx2d === null) throw new Error('no 2d context to read the capture back');
    return ctx2d.getImageData(0, 0, frame.width, frame.height).data;
  };

  return {
    canvas,
    async sequence(kind, event, burst, ticks, pose = 'east') {
      const id = nextId++;
      const world = tankWorld(kind, id, POSE_ANGLE[pose]);
      const ev = eventFor(world, id, event, burst);
      stream = mulberry32(SEED);
      try {
        const gap = id === 1 ? 0 : GAP_TICKS;
        for (let i = 0; i < gap; i++) r.render(world, world, 1, [], DT);
        const out: Uint8ClampedArray[] = [];
        const last = Math.max(...ticks);
        for (let k = 0; k <= last; k++) {
          r.render(world, world, 1, k === 0 ? [ev] : [], DT);
          if (ticks.includes(k)) out.push(read());
        }
        return out;
      } finally {
        stream = realRandom;
      }
    },
    dispose() {
      r.dispose();
      canvas.remove();
    },
  };
}

/** Pixel indices whose RGB differ between two frames. */
export function differing(a: Uint8ClampedArray, b: Uint8ClampedArray): number[] {
  if (a.length !== b.length) throw new Error(`frame sizes differ: ${a.length} vs ${b.length}`);
  const out: number[] = [];
  for (let i = 0; i < a.length; i += 4) {
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) out.push(i);
  }
  return out;
}

/** Mean absolute RGB channel difference over `pixels`. */
function meanDiff(a: Uint8ClampedArray, b: Uint8ClampedArray, pixels: readonly number[]): number {
  if (pixels.length === 0) return 0;
  let sum = 0;
  for (const i of pixels) sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
  return sum / (pixels.length * 3);
}

export interface CellResult {
  /** Pixels in the cue's no-effect footprint at this tick. */
  footprint: number;
  /** Of those, how many still differ between armed and unarmed with the effect on. */
  retained: number;
  /** `retained / footprint`; null for an empty footprint. */
  retainedFraction: number | null;
  /** Mean |armed - unarmed| over the footprint with the effect, over the same without it. */
  dimRatio: number | null;
}

/**
 * One cell. `armedNone`/`unarmedNone` are the no-effect pair (the footprint); `armedFx`/
 * `unarmedFx` the same tick with the effect on.
 */
export function cell(
  armedNone: Uint8ClampedArray,
  unarmedNone: Uint8ClampedArray,
  armedFx: Uint8ClampedArray,
  unarmedFx: Uint8ClampedArray,
): CellResult {
  const footprint = differing(armedNone, unarmedNone);
  let retained = 0;
  for (const i of footprint) {
    if (armedFx[i] !== unarmedFx[i] || armedFx[i + 1] !== unarmedFx[i + 1] || armedFx[i + 2] !== unarmedFx[i + 2]) retained++;
  }
  const base = meanDiff(armedNone, unarmedNone, footprint);
  return {
    footprint: footprint.length,
    retained,
    retainedFraction: footprint.length === 0 ? null : retained / footprint.length,
    dimRatio: footprint.length === 0 || base === 0 ? null : meanDiff(armedFx, unarmedFx, footprint) / base,
  };
}

/**
 * The second control: the same frames with one opaque patch laid over the footprint in BOTH, so
 * nothing of the cue can differ there. A metric that still reads a retained fraction well above 0
 * is counting something other than the cue.
 */
export function patched(frame: Uint8ClampedArray, footprint: readonly number[]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(frame);
  for (const i of footprint) {
    out[i] = 255;
    out[i + 1] = 0;
    out[i + 2] = 255;
  }
  return out;
}

/** Sampled distinct colours: a cleared buffer reads as one or two. */
export function colours(a: Uint8ClampedArray): number {
  const seen = new Set<number>();
  for (let i = 0; i < a.length; i += 4 * 97) seen.add((a[i] << 16) | (a[i + 1] << 8) | a[i + 2]);
  return seen.size;
}
