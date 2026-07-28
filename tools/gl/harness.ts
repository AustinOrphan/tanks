/**
 * Tests for src/render/scene.ts, run in a REAL browser.
 *
 * scene.ts constructs a WebGLRenderer, which vitest cannot do, and that single
 * fact shaped the codebase: framing.ts exists because the camera maths had to be
 * pulled OUT of this file to be assertable at all. Everything left behind --
 * the ground plane's dimensions, the resize path, dispose -- stayed untested,
 * and BOTH visual defects that ever reached the screen lived here.
 *
 * CI now has chromium for the visual gate, so that constraint is lifted. These
 * run there, not under vitest.
 */
import * as THREE from 'three';
import { createScene } from '../../src/render/scene';
import { CURRENT_ARENA, arenaBounds } from '../../src/sim/arena';
import { framedBounds } from '../../src/render/framing';

interface Result { name: string; pass: boolean; detail: string }
declare global { interface Window { __glResults?: Result[] } }

const results: Result[] = [];
function check(name: string, fn: () => string | null): void {
  try {
    const failure = fn();
    results.push({ name, pass: failure === null, detail: failure ?? 'ok' });
  } catch (e) {
    results.push({ name, pass: false, detail: `threw: ${String(e)}` });
  }
}

const { width: W, height: H } = arenaBounds(CURRENT_ARENA);
const BOUNDARY = CURRENT_ARENA.cellSize;
const framed = framedBounds(W, H, BOUNDARY);

function fresh(w = 1280, h = 800): ReturnType<typeof createScene> {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  document.body.appendChild(canvas);
  return createScene(canvas, W, H, BOUNDARY);
}

function groundOf(ctx: ReturnType<typeof createScene>): THREE.Mesh<THREE.PlaneGeometry> | null {
  for (const c of ctx.scene.children) {
    const m = c as THREE.Mesh;
    if (m.isMesh && (m.geometry as THREE.PlaneGeometry).type === 'PlaneGeometry') {
      return m as THREE.Mesh<THREE.PlaneGeometry>;
    }
  }
  return null;
}

check('the ground covers the arena plus its wall ring EXACTLY', () => {
  // The shipped bug: a 10% margin (2.2) against a 2.0-thick ring left 0.2 of
  // overhang on every side, visible as a strip of felt detached from the board.
  // Too small is the opposite failure -- walls hanging over the clear colour.
  const ctx = fresh();
  const g = groundOf(ctx);
  if (!g) return 'no PlaneGeometry mesh in the scene';
  const p = g.geometry.parameters;
  ctx.dispose();
  if (p.width !== framed.width || p.height !== framed.height) {
    return `ground is ${p.width}x${p.height}, framed area is ${framed.width}x${framed.height}`;
  }
  return null;
});

check('the ground is centred on the arena, not on the origin', () => {
  const ctx = fresh();
  const g = groundOf(ctx);
  if (!g) return 'no ground mesh';
  const { x, z } = g.position;
  ctx.dispose();
  if (Math.abs(x - W / 2) > 1e-9 || Math.abs(z - H / 2) > 1e-9) {
    return `ground centre (${x}, ${z}), arena centre (${W / 2}, ${H / 2})`;
  }
  return null;
});

check('resize re-fits the camera rather than only changing aspect', () => {
  // The binding axis swaps as the viewport changes shape, so a resize that
  // updates aspect without re-fitting leaves the board cropped or tiny.
  const ctx = fresh(1280, 800);
  const before = ctx.camera.position.clone();
  ctx.resize(520, 1560); // portrait: a different binding axis
  const after = ctx.camera.position.clone();
  const aspect = ctx.camera.aspect;
  ctx.dispose();
  if (Math.abs(aspect - 520 / 1560) > 1e-9) return `aspect not updated: ${aspect}`;
  if (before.distanceTo(after) < 1e-6) {
    return `camera did not move on resize (still ${before.toArray().join(', ')})`;
  }
  return null;
});

check('dispose releases the ground geometry and material', () => {
  // Nothing else can see this: a leaked geometry holds GPU memory for the life
  // of the page, and the only witness is the renderer's own info counters.
  const ctx = fresh();
  const g = groundOf(ctx);
  if (!g) return 'no ground mesh';
  let disposed = 0;
  g.geometry.addEventListener('dispose', () => { disposed += 1; });
  (g.material as THREE.Material).addEventListener('dispose', () => { disposed += 1; });
  ctx.dispose();
  return disposed === 2 ? null : `expected 2 dispose events, saw ${disposed}`;
});

check('the renderer really has a live GL context', () => {
  // The negative control for every check above: if the context were dead these
  // would pass vacuously on a scene that can never draw.
  const ctx = fresh();
  const gl = ctx.renderer.getContext();
  const lost = gl.isContextLost();
  ctx.dispose();
  return lost ? 'context is lost' : null;
});

window.__glResults = results;
