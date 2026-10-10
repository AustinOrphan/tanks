/**
 * Where the enemy role cue and the owner identity marker draw over each other, per player slot
 * (issue #1040), run in a real browser by `node tools/gl/identity-cue-overlap.mjs`. A
 * measurement, not a gate: the sibling of `role-cue-overlap-page.ts`, reusing its pixel helpers.
 *
 * THE FRAME is the posed `identity` element (four player tanks, slots 0-3, body angles 0, 90, 180
 * and 45 degrees) at the gallery CLI's defaults, 640x480, view `game`, dpr 1, built by
 * `buildGallery` with the options `tools/gallery/main.ts` passes. The CLI cannot hide a mesh, so
 * this page hands `buildGallery` a renderer built as its default one is and wraps its `render` to
 * hide chosen meshes for one draw. The `page frame is the CLI frame` control holds the page's full
 * frame to the CLI's own PNG, pixel for pixel.
 *
 * FOOTPRINTS, each the pixels that differ from the same draw with one mesh hidden:
 *  - owner, slot s: its `identity-ring` (the ring, or the `shape` marker), counted in the frame
 *    WITHOUT the cue so a ring pixel the riser covers still counts, and again in the frame WITH it.
 *  - cue, slot s: its `mine-block`, in the frame with `enemyRole: 'both'`. A player fires a
 *    standard shell, so `both`'s flare gives the shipped barrel and only the riser can differ;
 *    `cue is the riser alone` proves that rather than assuming it.
 * A slot is its ring's colour (`IDENTITY_RING_COLORS[slot]`); a `mine-block` belongs to the slot
 * whose ring is in the same tank group.
 */
import * as THREE from 'three';

import { buildGallery } from '../../src/render/gallery/subjects';
import { IDENTITY_RING_COLORS } from '../../src/presentation/identity';
import type { IdentityMarkerStyle } from '../../src/presentation/identity-marker';
import type { EnemyRoleCue } from '../../src/presentation/enemy-role';
import { colours, differing } from './role-cue-cells';

const W = 640;
const H = 480;
/** `ring` is no `--identityMarker`: the solid ring co-op, teams and single-player keep. */
const MARKERS = [{ name: 'shape', style: 'shape' }, { name: 'ring', style: null }] as const;
/** Body angles in degrees, by slot, as `subjects.ts`'s `identity` element poses them. */
const ANGLES = [0, 90, 180, 45];

/** Pixels in both footprints. A footprint against itself must report its full size. */
export function sharedCount(a: readonly number[], b: readonly number[]): number {
  const inA = new Set(a);
  let n = 0;
  for (const i of b) if (inA.has(i)) n++;
  return n;
}

export interface Row {
  marker: string; slot: number; bodyAngle: number;
  ownerNoCue: number; ownerWithCue: number; cue: number;
  shared: number; covered: number; sharedWithCue: number; sharedOtherSlots: number;
}
export interface Control { name: string; pass: boolean; detail: string }
interface Tank { slot: number; x: number; ring: THREE.Object3D; blocks: THREE.Object3D[] }

/** One posed gallery whose draws can hide meshes, each read back as top-down RGBA. */
function rig(marker: IdentityMarkerStyle | null, enemyRole: EnemyRoleCue | null) {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  canvas.style.width = `${W}px`;
  canvas.style.height = `${H}px`;
  document.body.appendChild(canvas);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  const render = renderer.render.bind(renderer);
  // A holder, not a `let`: TypeScript does not see an assignment made inside a callback.
  const drawn: { scene: THREE.Object3D | null } = { scene: null };
  let hide: THREE.Object3D[] = [];
  renderer.render = (s, cam) => {
    drawn.scene = s;
    for (const o of hide) o.visible = false;
    try { render(s, cam); } finally { for (const o of hide) o.visible = true; }
  };
  const g = buildGallery(canvas, W, H, {
    elements: ['identity'], view: 'game', reach: false, timer: false, fill: false,
    skin: 'solid', hull: null, accent: null, frames: null, mineWarn: null, shellTrail: null,
    identityMarker: marker, enemyRole, motion: 'full', renderer,
  });
  const gl = renderer.getContext();
  const frame = (hidden: THREE.Object3D[] = []): Uint8ClampedArray => {
    hide = hidden;
    try { g.draw(0, 0); } finally { hide = []; }
    const raw = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    const out = new Uint8ClampedArray(raw.length);
    for (let y = 0; y < H; y++) out.set(raw.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4);
    if (colours(out) < 8) throw new Error(`a cleared buffer (${colours(out)} colours), ${marker} ${enemyRole}`);
    return out;
  };
  frame();
  const tanks: Tank[] = [];
  for (const group of drawn.scene?.children ?? []) {
    const rings: THREE.Object3D[] = [];
    const blocks: THREE.Object3D[] = [];
    group.traverse((o) => {
      if (o.name === 'identity-ring') rings.push(o);
      if (o.name === 'mine-block') blocks.push(o);
    });
    if (rings.length !== 1) continue;
    const hex = ((rings[0] as THREE.Mesh).material as THREE.MeshBasicMaterial).color.getHex();
    tanks.push({ slot: IDENTITY_RING_COLORS.indexOf(hex), x: group.position.x, ring: rings[0], blocks });
  }
  tanks.sort((a, b) => a.slot - b.slot);
  return { frame, tanks, dispose() { g.dispose(); renderer.dispose(); canvas.remove(); } };
}

function png(frame: Uint8ClampedArray): string {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(frame), W, H), 0, 0);
  return c.toDataURL('image/png');
}

/** The CLI's PNG as RGBA, decoded with no colour conversion so it compares byte for byte. */
async function decode(base64: string): Promise<Uint8ClampedArray> {
  const blob = await (await fetch(`data:image/png;base64,${base64}`)).blob();
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  if (bmp.width !== W || bmp.height !== H) throw new Error(`the CLI frame is ${bmp.width}x${bmp.height}, not ${W}x${H}`);
  const ctx = new OffscreenCanvas(W, H).getContext('2d')!;
  ctx.drawImage(bmp, 0, 0);
  return ctx.getImageData(0, 0, W, H).data;
}

const page = window as unknown as {
  __identityCue?: unknown; __identityCueError?: string; __identityCueCli?: Record<string, string>;
};

async function measure() {
  const rows: Row[] = [];
  const controls: Control[] = [];
  const dumps: Record<string, string> = {};
  const full: Record<string, Uint8ClampedArray> = {};
  const check = (name: string, pass: boolean, detail: string) => controls.push({ name, pass, detail });
  for (const { name, style } of MARKERS) {
    console.log(`[identity-cue] ${name}`);
    const withCue = rig(style, 'both');
    const noCue = rig(style, null);
    const slotsOk = (tanks: Tank[], blocks: number) => tanks.length === 4 && tanks.every((t, s) =>
      t.slot === s && t.blocks.length === blocks && (s === 0 || t.x > tanks[s - 1].x));
    check(`slots, ${name}`, slotsOk(withCue.tanks, 1) && slotsOk(noCue.tanks, 0),
      `${withCue.tanks.length} and ${noCue.tanks.length} ringed tanks; want slots 0-3 by ring colour in x order, one mine-block each with the cue, none without`);

    const A = withCue.frame();
    const B = noCue.frame();
    full[name] = A;
    const ownerB = noCue.tanks.map((t) => differing(B, noCue.frame([t.ring])));
    const ownerA = withCue.tanks.map((t) => differing(A, withCue.frame([t.ring])));
    const cue = withCue.tanks.map((t) => differing(A, withCue.frame(t.blocks)));
    const arm = differing(A, B);
    const riserless = differing(withCue.frame(withCue.tanks.flatMap((t) => t.blocks)), B).length;
    const again = differing(A, withCue.frame()).length;
    withCue.dispose();
    noCue.dispose();

    for (let s = 0; s < 4; s++) {
      const inA = new Set(ownerA[s]);
      rows.push({
        marker: name, slot: s, bodyAngle: ANGLES[s],
        ownerNoCue: ownerB[s].length, ownerWithCue: ownerA[s].length, cue: cue[s].length,
        shared: sharedCount(ownerB[s], cue[s]),
        covered: sharedCount(ownerB[s].filter((i) => !inA.has(i)), cue[s]),
        sharedWithCue: sharedCount(ownerA[s], cue[s]),
        sharedOtherSlots: sharedCount(ownerB[s], cue.filter((_, t) => t !== s).flat()),
      });
    }
    check(`repeat draw identical, ${name}`, again === 0, `${again} pixels differ between the first and last full draw`);
    check(`cue is the riser alone, ${name}`, riserless === 0 && arm.length > 0,
      `${riserless} pixels differ from no --enemyRole with all four mine-blocks hidden; ${arm.length} with them drawn`);
    const union = new Set(cue.flat());
    check(`cue attribution complete, ${name}`, union.size === arm.length && arm.every((i) => union.has(i)),
      `${union.size} pixels in the four slots' cue footprints, ${arm.length} between the arms`);
    const cells = rows.filter((r) => r.marker === name);
    const empty = cells.filter((r) => r.ownerNoCue === 0 || r.ownerWithCue === 0 || r.cue === 0);
    check(`staging guard, ${name}`, cells.length === 4 && empty.length === 0,
      `${empty.length} of ${cells.length} slots with an empty owner or cue footprint`);
    const self = [0, 1, 2, 3].filter((s) => sharedCount(ownerB[s], ownerB[s]) === ownerB[s].length
      && sharedCount(cue[s], cue[s]) === cue[s].length && cue[s].length > 0);
    check(`a footprint against itself is all shared, ${name}`, self.length === 4,
      `${self.length} of 4 slots report their whole owner and cue footprint as shared with itself`);
    let crossed = 0;
    for (let s = 0; s < 4; s++) for (let t = s + 1; t < 4; t++) crossed += sharedCount(ownerB[s], ownerB[t]);
    check(`disjoint rings share nothing, ${name}`, crossed === 0, `${crossed} pixels shared between different slots' rings`);

    // The footprint map: the frame in dim grey, owner footprints (cue absent) yellow, cue magenta,
    // pixels in both white.
    const map = new Uint8ClampedArray(A);
    for (let i = 0; i < map.length; i += 4) map.fill((A[i] + A[i + 1] + A[i + 2]) / 9, i, i + 3);
    const inOwner = new Set(ownerB.flat());
    for (const i of inOwner) map.set([255, 210, 0], i);
    for (const i of union) map.set(inOwner.has(i) ? [255, 255, 255] : [255, 0, 255], i);
    dumps[`${name}-cue`] = png(A);
    dumps[`${name}-nocue`] = png(B);
    dumps[`${name}-footprints`] = png(map);
  }

  const cli = page.__identityCueCli ?? {};
  for (const { name } of MARKERS) {
    const other = name === 'shape' ? 'ring' : 'shape';
    if (!cli[name] || !cli[other]) {
      check(`page frame is the CLI frame, ${name}`, false, 'no CLI frame supplied; run the page through its runner');
      continue;
    }
    const same = differing(full[name], await decode(cli[name])).length;
    const crossed = differing(full[name], await decode(cli[other])).length;
    check(`page frame is the CLI frame, ${name}`, same === 0 && crossed > 0,
      `${same} pixels differ from the CLI's ${name} frame; ${crossed} from its ${other} frame`);
  }
  return { rows, controls, width: W, height: H, dumps };
}

// Published either way, so the runner never waits out its ceiling on a page that threw.
measure().then(
  (result) => { page.__identityCue = result; },
  (e: unknown) => { page.__identityCueError = e instanceof Error ? `${e.message}\n${e.stack}` : String(e); },
);
