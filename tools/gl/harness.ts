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
import { createRenderer } from '../../src/render/renderer';
import { createAimRay } from '../../src/render/aimray';
import { createArenaWorld } from '../../src/sim/arena';
import { CURRENT_ARENA, arenaBounds } from '../../src/sim/arena';
import { framedBounds } from '../../src/render/framing';
import { synthVoice, isSfxKey } from '../../src/audio/synth';
import { createMusicBed } from '../../src/audio/music';
import { trackById } from '../../src/audio/music-data';
import { WIDE_ARENA } from '../../src/sim/config/arena-fixtures';
import { createTankPreview } from '../../src/render/preview';

interface Result { name: string; pass: boolean; detail: string }
declare global { interface Window { __glResults?: Result[] } }

const results: Result[] = [];

/** The manifest's sfx keys, filtered through the synth's own guard. */
const SFX_KEYS = [
  'cannon', 'cannon-enemy', 'ping', 'explosion',
  'mine-drop', 'mine-arm', 'mine-boom', 'victory', 'defeat',
].filter(isSfxKey);
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

check('the ground sizes to a NON-shipped board (17x13) at construction', () => {
  // vitest cannot construct a WebGLRenderer, so per-level sizing can only be
  // proven in a real browser. Without this, "variable dimensions work" rests on
  // geometry tests that never build a scene.
  //
  // fresh() is not reused here: it hardcodes the shipped CURRENT_ARENA's W/H/BOUNDARY
  // into createScene, and createScene takes plain dimension numbers rather than a
  // World -- World itself carries no width/height field. Widening fresh() to accept
  // a World would give it nothing it could use, so this builds its own scene straight
  // from WIDE_ARENA's bounds instead.
  const { width: w, height: h } = arenaBounds(WIDE_ARENA);
  const boundary = WIDE_ARENA.cellSize;
  const want = framedBounds(w, h, boundary);
  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 800;
  document.body.appendChild(canvas);
  const ctx = createScene(canvas, w, h, boundary);
  const g = groundOf(ctx);
  if (!g) { ctx.dispose(); return 'no PlaneGeometry mesh in the scene'; }
  const p = g.geometry.parameters;
  const centre = { x: g.position.x, z: g.position.z };
  ctx.dispose();
  if (p.width !== want.width || p.height !== want.height) {
    return `ground is ${p.width}x${p.height}, framed area for 17x13 is ${want.width}x${want.height}`;
  }
  if (Math.abs(centre.x - w / 2) > 1e-9 || Math.abs(centre.z - h / 2) > 1e-9) {
    return `ground centre (${centre.x}, ${centre.z}), arena centre (${w / 2}, ${h / 2})`;
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

check('tone mapping is on, so bright faces roll off instead of clipping', () => {
  // Every material is untextured flat colour, so the response curve is the only thing
  // separating a lit face from an unlit one. NoToneMapping clipped the wall tops to a
  // single value.
  const ctx = fresh();
  const tm = ctx.renderer.toneMapping;
  const exposure = ctx.renderer.toneMappingExposure;
  ctx.dispose();
  if (tm !== THREE.ACESFilmicToneMapping) return `toneMapping is ${tm}, not ACESFilmic`;
  // Above 1 deliberately: the curve darkens the midrange, so 1.0 is dimmer than none.
  if (exposure <= 1) return `exposure ${exposure} does not compensate for the curve`;
  return null;
});

check('there is a fill and a rim light, not just the sun', () => {
  // With one directional light every surface facing away from it fell to flat ambient.
  // Counts, not names: three directionals and one ambient, and the two additions must
  // NOT cast shadows -- a second shadow map is a real cost and a competing shadow.
  const ctx = fresh();
  const dirs: THREE.DirectionalLight[] = [];
  let ambients = 0;
  ctx.scene.traverse((o) => {
    if ((o as THREE.DirectionalLight).isDirectionalLight) dirs.push(o as THREE.DirectionalLight);
    if ((o as THREE.AmbientLight).isAmbientLight) ambients++;
  });
  const casters = dirs.filter((d) => d.castShadow).length;
  ctx.dispose();
  if (dirs.length !== 3) return `expected 3 directional lights, found ${dirs.length}`;
  if (ambients !== 1) return `expected 1 ambient light, found ${ambients}`;
  if (casters !== 1) return `expected exactly 1 shadow caster, found ${casters}`;
  return null;
});

check('an environment map exists, so metalness is not just darkness', () => {
  // MeshStandardMaterial takes a metal's colour from reflections. Without an
  // environment, everything metallic renders near black -- so the material
  // differentiation added alongside this would have made things darker, not different.
  const ctx = fresh();
  const env = ctx.scene.environment;
  const intensity = ctx.scene.environmentIntensity;
  ctx.dispose();
  if (!env) return 'scene.environment is null';
  // Low on purpose: the environment feeds reflections, it does not light the scene.
  if (!(intensity > 0 && intensity < 0.7)) return `environmentIntensity ${intensity} out of range`;
  return null;
});

check('dispose detaches every light and clears the environment', () => {
  // The sun was already disposed; fill, rim and the generated env map are new and are
  // exactly the kind of thing that leaks silently.
  const ctx = fresh();
  ctx.dispose();
  let lights = 0;
  ctx.scene.traverse((o) => {
    if ((o as THREE.Light).isLight) lights++;
  });
  if (lights !== 0) return `${lights} light(s) still attached after dispose`;
  if (ctx.scene.environment !== null) return 'scene.environment still set after dispose';
  return null;
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


// ---------------------------------------------------------------------------
// renderer.ts. screenToGround is a CLOSURE over a live GL context, so nothing
// under vitest could ever call it: PR #6's review recorded that inverting its
// Y or returning a constant both passed the whole suite, and that its
// round-trip probes "cannot fail for the reasons that matter -- canvas rect,
// CSS-vs-buffer size, devicePixelRatio". Those are precisely the cases below.
// ---------------------------------------------------------------------------

/** A canvas with a CSS size and page offset that differ from its buffer size. */
function placedCanvas(cssW: number, cssH: number, left: number, top: number,
                      bufW: number, bufH: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = bufW;
  c.height = bufH;
  c.style.position = 'absolute';
  c.style.left = `${left}px`;
  c.style.top = `${top}px`;
  c.style.width = `${cssW}px`;
  c.style.height = `${cssH}px`;
  document.body.appendChild(c);
  return c;
}

check('screenToGround maps the canvas centre to the arena centre', () => {
  const c = placedCanvas(800, 500, 0, 0, 800, 500);
  const r = createRenderer(c, W, H, BOUNDARY);
  const p = r.screenToGround(400, 250);
  r.dispose();
  c.remove();
  const dx = Math.abs(p.x - W / 2);
  const dy = Math.abs(p.y - H / 2);
  // The camera is tilted, so the centre pixel is not exactly the arena centre;
  // it is within a cell. A constant return or a swapped axis is far outside.
  if (dx > CURRENT_ARENA.cellSize || dy > CURRENT_ARENA.cellSize) {
    return `centre pixel mapped to (${p.x.toFixed(2)}, ${p.y.toFixed(2)}), arena centre (${W / 2}, ${H / 2})`;
  }
  return null;
});

check('refit re-aims ground, camera and screenToGround at a NEW board size', () => {
  // The constraint this retires: every arena had to be one fixed size because the scene sized
  // its ground plane, camera and shadow rig ONCE at construction. A refit to a wider
  // board must move all of it -- and the GL context must survive (in-place, not a
  // rebuild).
  const c = placedCanvas(800, 500, 0, 0, 800, 500);
  const r = createRenderer(c, W, H, BOUNDARY);
  const gl = (c.getContext('webgl2') ?? c.getContext('webgl')) as WebGLRenderingContext;

  const W2 = 34; // a 17-column board at cellSize 2 -- half again wider than shipped
  const H2 = 18;
  r.refit(W2, H2, BOUNDARY);

  // The centre pixel must now map to the NEW arena centre.
  const p = r.screenToGround(400, 250);
  const dx = Math.abs(p.x - W2 / 2);
  const dy = Math.abs(p.y - H2 / 2);
  if (dx > BOUNDARY || dy > BOUNDARY) {
    r.dispose();
    c.remove();
    return `after refit, centre pixel mapped to (${p.x.toFixed(2)}, ${p.y.toFixed(2)}), want near (${W2 / 2}, ${H2 / 2})`;
  }
  if (gl.isContextLost()) {
    r.dispose();
    c.remove();
    return 'refit lost the GL context -- it must be in-place, not a rebuild';
  }
  r.dispose();
  c.remove();
  return null;
});

check('refit resizes the ground plane to the new framed bounds, both directions', () => {
  const ctx = fresh();
  const wider = framedBounds(34, 18, BOUNDARY);
  ctx.refit(34, 18, BOUNDARY);
  const g1 = groundOf(ctx);
  const p1 = g1?.geometry.parameters;
  if (!p1 || Math.abs(p1.width - wider.width) > 1e-6 || Math.abs(p1.height - wider.height) > 1e-6) {
    ctx.dispose();
    return `after widening, ground is ${p1?.width}x${p1?.height}, want ${wider.width}x${wider.height}`;
  }
  const centre1 = g1.position;
  if (Math.abs(centre1.x - 17) > 1e-6 || Math.abs(centre1.z - 9) > 1e-6) {
    ctx.dispose();
    return `after widening, ground centred at (${centre1.x}, ${centre1.z}), want (17, 9)`;
  }
  // And back down: refit is not a one-way door.
  ctx.refit(W, H, BOUNDARY);
  const p2 = groundOf(ctx)?.geometry.parameters;
  ctx.dispose();
  if (!p2 || Math.abs(p2.width - framed.width) > 1e-6 || Math.abs(p2.height - framed.height) > 1e-6) {
    return `after refitting back, ground is ${p2?.width}x${p2?.height}, want ${framed.width}x${framed.height}`;
  }
  return null;
});

check('WIDE_ARENA (17x13) sizes correctly through refit, not just construction', () => {
  // arena-fixtures.ts states, in shipped source, that WIDE_ARENA exists to prove
  // "the per-level render refit (PR #53)" -- but until this check, nothing actually
  // ran it through refit(): the sibling check above only proves refit works for an
  // unnamed 34x18 board, and the construction check a few lines up never calls
  // refit() at all. This exercises the SAME path a live level switch takes
  // (src/game/loop.ts:393, renderer.refit(b.width, b.height, b.cellSize)) with the
  // fixture the doc comment names.
  const { width: w, height: h } = arenaBounds(WIDE_ARENA);
  const boundary = WIDE_ARENA.cellSize;
  const want = framedBounds(w, h, boundary);
  const ctx = fresh(); // constructed at the shipped board size, same as every other refit check
  ctx.refit(w, h, boundary);
  const g = groundOf(ctx);
  if (!g) { ctx.dispose(); return 'no PlaneGeometry mesh in the scene'; }
  const p = g.geometry.parameters;
  const centre = { x: g.position.x, z: g.position.z };
  ctx.dispose();
  if (p.width !== want.width || p.height !== want.height) {
    return `after refit, ground is ${p.width}x${p.height}, want ${want.width}x${want.height}`;
  }
  if (Math.abs(centre.x - w / 2) > 1e-9 || Math.abs(centre.z - h / 2) > 1e-9) {
    return `after refit, ground centre (${centre.x}, ${centre.z}), want (${w / 2}, ${h / 2})`;
  }
  return null;
});

check('the shadow map covers every corner of the framed board after a refit', () => {
  // The shadow lesson (extents fitted to the board, bias second) has to survive
  // refit: a wider board with the OLD extents clips casters at the edges, and OLD
  // extents kept oversized waste texels. Note the map stays 2048^2, so a larger
  // board still means fewer texels per unit -- that is physics, not a defect; this
  // asserts the margin discipline only.
  const ctx = fresh();
  ctx.refit(34, 18, BOUNDARY);
  let sun: THREE.DirectionalLight | null = null;
  ctx.scene.traverse((o) => {
    if ((o as THREE.DirectionalLight).isDirectionalLight && (o as THREE.DirectionalLight).castShadow) {
      sun = o as THREE.DirectionalLight;
    }
  });
  if (!sun) {
    ctx.dispose();
    return 'no shadow-casting sun found';
  }
  // Assert the PROPERTY the shadow camera exists for -- every corner of the framed board
  // projects inside the shadow map -- rather than restating scene.ts's own expression for
  // it. The previous form recomputed `max(width,height)/2 + BOUNDARY` here and compared
  // it to what scene.ts had just computed the same way, so it could only catch "the refit
  // didn't move the camera"; a formula that stopped covering the board passed it. One
  // did: sizing the square ortho to the longer SIDE clips the corners, because the ortho
  // is oriented by the sun's azimuth and not by the board's axes.
  const light = sun as THREE.DirectionalLight;
  const cam = light.shadow.camera as THREE.OrthographicCamera;
  light.updateMatrixWorld(true);
  light.target.updateMatrixWorld(true);
  light.shadow.updateMatrices(light);
  const viewProj = cam.projectionMatrix.clone().multiply(cam.matrixWorldInverse);
  const wider = framedBounds(34, 18, BOUNDARY);
  const outside: string[] = [];
  const v = new THREE.Vector3();
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    v.set(34 / 2 + (sx * wider.width) / 2, 0, 18 / 2 + (sz * wider.height) / 2)
      .applyMatrix4(viewProj);
    if (Math.abs(v.x) > 1 || Math.abs(v.y) > 1) {
      outside.push(`(${sx},${sz})->ndc ${v.x.toFixed(3)},${v.y.toFixed(3)}`);
    }
  }
  const half = cam.right;
  ctx.dispose();
  if (outside.length > 0) {
    return `${outside.length} of 4 framed corners fall outside the shadow map (half-extent ${half}): ${outside.join(' ')}`;
  }
  return null;
});

check('screenToGround subtracts the canvas page offset', () => {
  // The canvas is not at the page origin, so a handler that uses clientX
  // directly instead of clientX - rect.left aims at the wrong place. Nothing
  // under jsdom can see this: getBoundingClientRect there returns all zeros.
  const a = placedCanvas(800, 500, 0, 0, 800, 500);
  const ra = createRenderer(a, W, H, BOUNDARY);
  const atOrigin = ra.screenToGround(400, 250);
  ra.dispose();
  a.remove();

  const b = placedCanvas(800, 500, 120, 60, 800, 500);
  const rb = createRenderer(b, W, H, BOUNDARY);
  // Same point ON the canvas, so the same ground point, despite the offset.
  const offset = rb.screenToGround(400 + 120, 250 + 60);
  rb.dispose();
  b.remove();

  const dx = Math.abs(atOrigin.x - offset.x);
  const dy = Math.abs(atOrigin.y - offset.y);
  if (dx > 1e-6 || dy > 1e-6) {
    return `offset canvas mapped to (${offset.x.toFixed(3)}, ${offset.y.toFixed(3)}), origin canvas (${atOrigin.x.toFixed(3)}, ${atOrigin.y.toFixed(3)})`;
  }
  return null;
});

// REMOVED: a check named "screenToGround uses the CSS rect, not the drawing
// buffer". It could not fail for its stated reason. createScene calls
// renderer.setSize(w, h, false), and three sets canvas.width/height itself, so
// a drawing buffer that differs from the CSS size does not survive the first
// resize -- the mutation it was written to catch (dividing by canvas.width
// instead of rect.width) is EQUIVALENT here. It appeared to work only because
// it also fired on the axis-swap mutation, which the check below already owns.
// A devicePixelRatio mismatch would need the renderer to stop owning the buffer.

check('screenToGround does not swap the ground axes', () => {
  // three's (x, z) -> world (x, y). A swap is invisible on a square arena and
  // on the centre pixel, so probe a deliberately off-centre point on a
  // non-square arena (22 x 18).
  const c = placedCanvas(800, 500, 0, 0, 800, 500);
  const r = createRenderer(c, W, H, BOUNDARY);
  const left = r.screenToGround(200, 250);
  const right = r.screenToGround(600, 250);
  r.dispose();
  c.remove();
  // Moving the cursor horizontally must move the ground point in x, not y.
  if (Math.abs(right.x - left.x) < Math.abs(right.y - left.y)) {
    return `horizontal cursor move changed y more than x: dx=${(right.x - left.x).toFixed(3)} dy=${(right.y - left.y).toFixed(3)}`;
  }
  return null;
});

check('render draws a frame without throwing', () => {
  const c = placedCanvas(800, 500, 0, 0, 800, 500);
  const r = createRenderer(c, W, H, BOUNDARY);
  const world = createArenaWorld(1);
  r.render(world, world, 0.5, [], 1 / 60);
  const gl = (c.getContext('webgl2') ?? c.getContext('webgl')) as WebGLRenderingContext | null;
  const lost = !gl || gl.isContextLost();
  r.dispose();
  c.remove();
  return lost ? 'context lost after render' : null;
});

check('resize forwards to the scene camera', () => {
  const c = placedCanvas(800, 500, 0, 0, 800, 500);
  const r = createRenderer(c, W, H, BOUNDARY);
  r.resize(400, 1200);
  // No direct camera handle here, so assert through the observable: aiming at
  // the centre of the RESIZED viewport still lands near the arena centre.
  c.style.width = '400px';
  c.style.height = '1200px';
  const p = r.screenToGround(200, 600);
  r.dispose();
  c.remove();
  if (Math.abs(p.x - W / 2) > CURRENT_ARENA.cellSize * 2) {
    return `after resize the centre mapped to x=${p.x.toFixed(2)}, expected near ${W / 2}`;
  }
  return null;
});


// REMOVED: a check named "the aim ray follows the turret, and is absent by
// default". createRenderer does not expose its scene, so it could not actually
// reach the Line, and what remained asserted nothing -- it did its setup and
// returned null unconditionally. The check below tests the same behaviour
// where it IS reachable, against createAimRay directly.

check('createAimRay orients the line to the turret angle', () => {
  // Direct, because the renderer does not expose its scene. rotation.y = -angle
  // is the repo's world->three convention; getting the sign wrong points the
  // diagnostic the wrong way, which is worse than not having it.
  const scene = new THREE.Scene();
  const before = scene.children.length;
  const ray = createAimRay(scene);
  if (scene.children.length !== before + 1) return 'aim ray added no object to the scene';
  const line = scene.children[scene.children.length - 1] as THREE.Line;
  if (line.visible) return 'aim ray is visible before any sync';

  const world = createArenaWorld(1);
  const player = world.tanks.find((t) => t.kind === 'player');
  if (!player) { ray.dispose(); return 'fixture has no player'; }
  player.turretAngle = Math.PI / 2;
  ray.sync(world);
  if (!line.visible) return 'aim ray hidden after sync with a live player';
  if (Math.abs(line.rotation.y - -Math.PI / 2) > 1e-9) {
    return `rotation.y is ${line.rotation.y}, expected ${-Math.PI / 2}`;
  }
  if (Math.abs(line.position.x - player.pos.x) > 1e-9 || Math.abs(line.position.z - player.pos.y) > 1e-9) {
    return `line at (${line.position.x}, ${line.position.z}), player at (${player.pos.x}, ${player.pos.y})`;
  }

  // A dead player must hide it rather than leave a stale ray on the board.
  player.alive = false;
  ray.sync(world);
  const hiddenWhenDead = !line.visible;
  ray.dispose();
  if (!hiddenWhenDead) return 'aim ray still visible after the player died';
  if (scene.children.length !== before) return 'dispose left the line in the scene';
  return null;
});

// ---- Audio: does the synth actually produce SAMPLES? ------------------------
//
// vitest has no Web Audio, so synth.test.ts and music.test.ts can only assert
// the GRAPH is built -- every node and every scheduled value, but never a single
// sample. A graph can be perfectly shaped and still render silence (an envelope
// that never opens, a source never started, a layer connected to nothing).
// OfflineAudioContext renders faster than real time and deterministically, so
// the browser is where "it makes a sound" can finally be asserted.

async function renderPeak(
  build: (ctx: OfflineAudioContext) => void,
  seconds = 1,
): Promise<number> {
  const ctx = new OfflineAudioContext(1, Math.floor(44100 * seconds), 44100);
  build(ctx);
  const buf = await ctx.startRendering();
  const data = buf.getChannelData(0);
  let peak = 0;
  for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
  return peak;
}

async function checkAsync(name: string, fn: () => Promise<string | null>): Promise<void> {
  try {
    const failure = await fn();
    results.push({ name, pass: failure === null, detail: failure ?? 'ok' });
  } catch (e) {
    results.push({ name, pass: false, detail: `threw: ${String(e)}` });
  }
}

for (const key of SFX_KEYS) {
  await checkAsync(`synth renders audible samples for "${key}"`, async () => {
    const peak = await renderPeak((ctx) => {
      const v = synthVoice(ctx, ctx.destination, key, 0, { volume: 1 });
      if (!v) throw new Error('synthVoice returned null in a real context');
    });
    // Well above the noise floor: a silent render peaks at 0, and an envelope
    // that never opens lands around the 1e-4 floor the ramps start from.
    return peak > 0.01 ? null : `peak amplitude was ${peak.toExponential(2)}, effectively silent`;
  });
}

await checkAsync('the SAME voice is loud at volume 1 and silent at volume 0', async () => {
  // The real negative control. An earlier version rendered only the volume-0
  // case, which passes when synthVoice returns null and NOTHING is built --
  // exactly the failure it was meant to exclude. Comparing the same graph at two
  // volumes proves the measurement is reading the voice.
  const loud = await renderPeak((ctx) => {
    if (!synthVoice(ctx, ctx.destination, 'explosion', 0, { volume: 1 })) {
      throw new Error('synthVoice returned null');
    }
  });
  const silent = await renderPeak((ctx) => {
    if (!synthVoice(ctx, ctx.destination, 'explosion', 0, { volume: 0 })) {
      throw new Error('synthVoice returned null');
    }
  });
  if (!(loud > 0.01)) return `volume 1 peaked at ${loud.toExponential(2)}, not audible`;
  if (!(silent < 1e-3)) return `volume 0 still peaked at ${silent.toExponential(2)}`;
  return null;
});

check('every SFX key is actually covered by an audio check', () => {
  // Without this, degrading isSfxKey silently drops the nine render checks and
  // the runner still reports success -- proven in review: 9 checks vanished and
  // it printed "all 20 GL checks passed".
  const rendered = results.filter((r) => r.name.startsWith('synth renders audible samples')).length;
  if (SFX_KEYS.length !== 9) return `SFX_KEYS has ${SFX_KEYS.length} entries, expected 9`;
  return rendered === 9 ? null : `only ${rendered} of 9 sfx render checks ran`;
});

await checkAsync('a COMPOSED track renders audible samples', async () => {
  // The authored path, end to end: JSON -> validator -> scheduler -> samples.
  const track = trackById('arena');
  if (!track) return 'the shipped "arena" track is missing from music-tracks.json';
  const peak = await renderPeak((ctx) => {
    const bed = createMusicBed(ctx, ctx.destination, {
      setInterval: () => 0 as unknown as ReturnType<typeof setInterval>,
      clearInterval: () => undefined,
      track,
    });
    bed.setVolume(1);
    bed.start();
  }, 2);
  return peak > 0.01 ? null : `composed track peaked at ${peak.toExponential(2)}, silent`;
});

await checkAsync('the generated music bed renders audible samples', async () => {
  const peak = await renderPeak((ctx) => {
    const bed = createMusicBed(ctx, ctx.destination, {
      // No timer in an offline render: start() schedules the first window
      // synchronously, which is all a 2s render needs.
      setInterval: () => 0 as unknown as ReturnType<typeof setInterval>,
      clearInterval: () => undefined,
      seed: 4242,
    });
    bed.setVolume(1);
    bed.start();
  }, 2);
  return peak > 0.01 ? null : `music peaked at ${peak.toExponential(2)}, effectively silent`;
});

// ---------------------------------------------------------------------------
// render/preview.ts. A SECOND WebGLRenderer, live only while the Customize panel
// is open -- these checks are the reason to believe that is actually safe: a real
// tank gets drawn (not a depiction, the entities.ts mesh), a style change actually
// reaches the pixels, dispose really frees the GL context (not just the JS
// references), and two contexts held at once -- this preview's and the main
// renderer's -- coexist without either losing its context, which is the whole
// premise the "second WebGL context" design leans on.
// ---------------------------------------------------------------------------

/** A preview-sized canvas with a real CSS layout box, appended to the document --
 * preview.ts reads canvas.clientWidth/clientHeight to size itself, which is 0 for a
 * detached or unstyled canvas. */
function previewCanvas(w = 260, h = 190): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.style.width = `${w}px`;
  c.style.height = `${h}px`;
  document.body.appendChild(c);
  return c;
}

function readPixel(gl: WebGLRenderingContext, x: number, y: number): Uint8Array {
  const px = new Uint8Array(4);
  gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return px;
}

check('createTankPreview draws an opaque tank against a transparent background', () => {
  const c = previewCanvas();
  const preview = createTankPreview(c);
  if (!preview) { c.remove(); return 'createTankPreview returned null in a real browser'; }
  const gl = (c.getContext('webgl2') ?? c.getContext('webgl')) as WebGLRenderingContext;
  const w = c.width;
  const h = c.height;
  // Centre: the tank's own footprint (PREVIEW_AREA_W/H frame it there on purpose).
  const centre = readPixel(gl, Math.floor(w / 2), Math.floor(h / 2));
  // Top row, centre column: above the tank and above the ground disc -- nothing else
  // is in this scene to paint it, so it must still show the transparent clear colour.
  const top = readPixel(gl, Math.floor(w / 2), h - 1);
  preview.dispose();
  c.remove();
  if (centre[3] < 200) return `centre pixel alpha ${centre[3]}, expected an opaque tank there`;
  if (top[3] > 40) return `top-row pixel alpha ${top[3]}, expected the transparent background`;
  return null;
});

check('setStyle actually repaints the pixels, not just the JS-side style triple', () => {
  const c = previewCanvas();
  const preview = createTankPreview(c);
  if (!preview) { c.remove(); return 'createTankPreview returned null in a real browser'; }
  const gl = (c.getContext('webgl2') ?? c.getContext('webgl')) as WebGLRenderingContext;
  const w = Math.floor(c.width / 2);
  const h = Math.floor(c.height / 2);
  preview.setStyle('#ff0000', 'solid', null);
  const red = readPixel(gl, w, h);
  preview.setStyle('#0000ff', 'solid', null);
  const blue = readPixel(gl, w, h);
  preview.dispose();
  c.remove();
  // Not exact-channel equality (lighting/tone-mapping/metalness all move the raw
  // value away from the input hex) -- the property that matters is which channel
  // DOMINATES, and that a real hull-colour change flips it.
  if (!(red[0] > red[2])) return `red hull: pixel was (${red.join(',')}), red should dominate blue`;
  if (!(blue[2] > blue[0])) return `blue hull: pixel was (${blue.join(',')}), blue should dominate red`;
  return null;
});

check('dispose actually runs (does not throw), including a SECOND dispose', () => {
  // Not a context-loss check: this preview's dispose deliberately does NOT force
  // context loss (see preview.ts's doc comment -- the canvas is reused, not
  // recreated, so losing the context would break the very next open, proven by the
  // "reopening" check below). What dispose DOES still have to do is free every THREE
  // object it built -- the entity views, the lights, the ground, the generated
  // environment map -- without throwing, and stay safe to call again (defensive,
  // catches a double-free on any of those).
  const c = previewCanvas();
  const preview = createTankPreview(c);
  if (!preview) { c.remove(); return 'createTankPreview returned null in a real browser'; }
  preview.dispose();
  preview.dispose(); // must not throw on the second call
  c.remove();
  return null;
});

check('dispose does NOT lose the context -- it is held, live, and reused on reopen', () => {
  // Pins the exact lifetime claim documented in loop.ts and preview.ts: after
  // dispose(), the canvas's WebGL context is the SAME object, still live, not lost --
  // "held for the rest of the session" is the true (and safe) behaviour, not "freed
  // and reacquired every open/close". This is the direct measurement; the "repeated
  // open/close cycles" check below shows the CONSEQUENCE (reopening still draws) but
  // does not by itself distinguish "context reused" from "context re-created cheaply
  // some other way" -- this check reads the context identity and isContextLost()
  // directly, so the claim in the doc comments is measured here, not merely inferred.
  const c = previewCanvas();
  const preview = createTankPreview(c);
  if (!preview) { c.remove(); return 'createTankPreview returned null in a real browser'; }
  const glBefore = c.getContext('webgl2') ?? c.getContext('webgl');
  preview.dispose();
  const glAfter = c.getContext('webgl2') ?? c.getContext('webgl');
  const lostAfterDispose = (glAfter as WebGLRenderingContext).isContextLost();
  const sameCtxAfterDispose = glBefore === glAfter;
  const reopened = createTankPreview(c);
  const sameCtxOnReopen = reopened
    ? (c.getContext('webgl2') ?? c.getContext('webgl')) === glBefore
    : false;
  reopened?.dispose();
  c.remove();
  if (lostAfterDispose) return 'context IS lost after dispose -- the doc comments are now wrong';
  if (!sameCtxAfterDispose) return 'a DIFFERENT context object exists after dispose -- not held, replaced';
  if (!sameCtxOnReopen) return 'reopen did not reuse the same context object';
  return null;
});

check('the preview and the main renderer hold TWO live contexts at once, neither lost', () => {
  // The concurrency claim behind scoping the preview to "panel open": the peak is
  // two contexts (this one plus the main game's), only while the Customize panel is
  // open, and there is never a third. This is the direct proof, not an inference
  // from "each disposes cleanly alone" -- two SEPARATE renderers constructed
  // together, each checked while the other is still live.
  const gameCanvas = placedCanvas(800, 500, 0, 0, 800, 500);
  const game = createRenderer(gameCanvas, W, H, BOUNDARY);
  const previewC = previewCanvas();
  const preview = createTankPreview(previewC);
  if (!preview) {
    game.dispose();
    gameCanvas.remove();
    previewC.remove();
    return 'createTankPreview returned null in a real browser (main renderer built fine)';
  }
  const gameGl = (gameCanvas.getContext('webgl2') ?? gameCanvas.getContext('webgl')) as WebGLRenderingContext;
  const previewGl = (previewC.getContext('webgl2') ?? previewC.getContext('webgl')) as WebGLRenderingContext;
  const bothLiveTogether = !gameGl.isContextLost() && !previewGl.isContextLost();
  const world = createArenaWorld(1);
  game.render(world, world, 0.5, [], 1 / 60); // both actually draw while coexisting
  preview.setStyle('#3d7bd6', 'solid', null);
  const stillLiveAfterDraw = !gameGl.isContextLost() && !previewGl.isContextLost();
  preview.dispose();
  game.dispose();
  gameCanvas.remove();
  previewC.remove();
  if (!bothLiveTogether) return 'one context was already lost the moment both existed';
  if (!stillLiveAfterDraw) return 'one context was lost after both rendered a frame';
  return null;
});

check('repeated open/close cycles on the SAME canvas keep drawing a tank', () => {
  // The production path, not the one every other preview check above exercises: the
  // HUD owns ONE persistent `.hud-preview` canvas (see hud.ts), and game/loop.ts
  // opens/disposes a preview against that SAME element every time the Customize panel
  // opens and closes -- open, Back, open again, Back, open again... is an ordinary
  // playtest, not an edge case. Every OTHER check in this file builds a fresh canvas
  // per preview, so none of them can see what happens on a SECOND (or later) create()
  // against a canvas a previous dispose() already tore down.
  //
  // This first caught a real bug: with dispose() calling `renderer.forceContextLoss()`
  // (matching scene.ts's own pattern), the SECOND createTankPreview on the same canvas
  // came back non-null but drew nothing -- a force-lost context does not reliably
  // revive, unlike scene.ts's canvas, which gets a genuinely NEW canvas per level
  // rather than reusing one. Looped 3 times (not just once) as a cheap stress against
  // anything that accumulates quietly across cycles rather than failing on the first.
  const c = previewCanvas();
  for (let i = 0; i < 3; i++) {
    const preview = createTankPreview(c);
    if (!preview) { c.remove(); return `cycle ${i}: createTankPreview returned null in a real browser`; }
    preview.setStyle(i % 2 === 0 ? '#3d7bd6' : '#d64545', 'solid', null);
    const gl = (c.getContext('webgl2') ?? c.getContext('webgl')) as WebGLRenderingContext;
    const centre = readPixel(gl, Math.floor(c.width / 2), Math.floor(c.height / 2));
    preview.dispose();
    if (centre[3] < 200) {
      c.remove();
      return `cycle ${i}: centre pixel alpha ${centre[3]} -- blank/dead preview on a reused canvas`;
    }
  }
  c.remove();
  return null;
});

// ---------------------------------------------------------------------------
// render/preview-controls.ts, through the renderer it drives.
//
// The angle maths is asserted headlessly in preview-controls.test.ts, against the
// production camera -- there is no need to repeat it here, and pixels are a poor way
// to measure an angle. What ONLY a browser can show is the wiring: a real
// getBoundingClientRect (jsdom's is all zeros, which the production code correctly
// reads as "no layout box" and refuses to aim through), a real camera fitted to a real
// canvas size, and whether the pose actually reaches the FRAMEBUFFER instead of
// stopping at a JS-side number.
// ---------------------------------------------------------------------------

/** The whole framebuffer, as bytes. */
function grab(gl: WebGLRenderingContext, w: number, h: number): Uint8Array {
  const px = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return px;
}

/** How many of the sampled bytes differ. Pixel counts are not compared to a threshold
 * chosen by eye: "the tank moved" is a change of tens of thousands of bytes and "it did
 * not" is zero, so the two are separated by orders of magnitude, not by a margin. */
function bytesDiffering(a: Uint8Array, b: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
  return n;
}

function pointerAt(type: string, c: HTMLCanvasElement, dx: number, dy: number): PointerEvent {
  const r = c.getBoundingClientRect();
  return new PointerEvent(type, {
    clientX: r.left + r.width / 2 + dx,
    clientY: r.top + r.height / 2 + dy,
    pointerId: 1,
    pointerType: 'mouse',
    button: 0,
    buttons: type === 'pointerdown' ? 1 : 0,
    bubbles: true,
    cancelable: true,
  });
}

check('a drag on the preview canvas turns the tank in the rendered image', () => {
  const c = previewCanvas();
  const preview = createTankPreview(c);
  if (!preview) { c.remove(); return 'createTankPreview returned null in a real browser'; }
  const gl = (c.getContext('webgl2') ?? c.getContext('webgl')) as WebGLRenderingContext;
  const before = grab(gl, c.width, c.height);
  c.dispatchEvent(pointerAt('pointerdown', c, 0, 0));
  c.dispatchEvent(pointerAt('pointermove', c, 90, 0));
  const after = grab(gl, c.width, c.height);
  c.dispatchEvent(pointerAt('pointerup', c, 90, 0));
  preview.dispose();
  c.remove();
  const moved = bytesDiffering(before, after);
  // 1% of the buffer (1976 bytes) sits between the two states by an order of
  // magnitude in each direction. Both ends measured on this harness: a real 90px drag
  // moves 26926 of 197600 bytes, and with the controls unwired from preview.ts it
  // moves 0.
  if (moved < c.width * c.height * 4 * 0.01) {
    return `only ${moved} of ${before.length} bytes changed -- the drag did not reach the pixels`;
  }
  return null;
});

check('a hover over the preview canvas aims the turret in the rendered image', () => {
  // Distinct from the drag above, and not implied by it: this presses nothing, so it
  // exercises the desktop hover-aim path alone. If only the drag were checked, wiring
  // that handled pointerdown and ignored a bare pointermove would pass.
  const c = previewCanvas();
  const preview = createTankPreview(c);
  if (!preview) { c.remove(); return 'createTankPreview returned null in a real browser'; }
  const gl = (c.getContext('webgl2') ?? c.getContext('webgl')) as WebGLRenderingContext;
  // Aim left first, then far right: two hovers, so the comparison cannot be against
  // the opening pose (which the idle spin may already have nudged).
  c.dispatchEvent(pointerAt('pointermove', c, -100, 0));
  const left = grab(gl, c.width, c.height);
  c.dispatchEvent(pointerAt('pointermove', c, 100, 0));
  const right = grab(gl, c.width, c.height);
  preview.dispose();
  c.remove();
  const moved = bytesDiffering(left, right);
  // A turret swinging through 180 degrees is a smaller silhouette change than a hull
  // turn, so the floor is lower. Measured: 11794 of 197600 bytes with the hover wired,
  // 0 with it unwired.
  if (moved < 2000) {
    return `only ${moved} of ${left.length} bytes changed -- the hover did not aim the turret`;
  }
  return null;
});

check('a reopened preview on the SAME canvas is interactive again', () => {
  // The production path: open, drag, Back, open, drag. The existing 3-cycle check
  // proves a reopened preview still DRAWS; this proves it still LISTENS. The failure
  // it is aimed at is a dispose that tears the controls down and a create that does
  // not build them back -- which draws a perfectly good static tank.
  const c = previewCanvas();
  createTankPreview(c)?.dispose();
  const preview = createTankPreview(c);
  if (!preview) { c.remove(); return 'the reopened createTankPreview returned null'; }
  const gl = (c.getContext('webgl2') ?? c.getContext('webgl')) as WebGLRenderingContext;
  const before = grab(gl, c.width, c.height);
  c.dispatchEvent(pointerAt('pointerdown', c, 0, 0));
  c.dispatchEvent(pointerAt('pointermove', c, 90, 0));
  const after = grab(gl, c.width, c.height);
  c.dispatchEvent(pointerAt('pointerup', c, 90, 0));
  preview.dispose();
  c.remove();
  const moved = bytesDiffering(before, after);
  if (moved < c.width * c.height * 4 * 0.01) {
    return `only ${moved} of ${before.length} bytes changed after reopen -- not interactive`;
  }
  return null;
});

check('a disposed preview stops listening to the canvas it no longer owns', () => {
  // The integration half of preview-controls.test.ts's listener check: that one proves
  // controls.dispose() unbinds what it bound, this proves preview.dispose() CALLS it.
  // The panel closing while a finger is still down is the ordinary way to reach this,
  // and what a leaked listener does is draw through a disposed renderer.
  const c = previewCanvas();
  const preview = createTankPreview(c);
  if (!preview) { c.remove(); return 'createTankPreview returned null in a real browser'; }
  const gl = (c.getContext('webgl2') ?? c.getContext('webgl')) as WebGLRenderingContext;
  preview.dispose();
  const before = grab(gl, c.width, c.height);
  c.dispatchEvent(pointerAt('pointerdown', c, 0, 0));
  c.dispatchEvent(pointerAt('pointermove', c, 90, 0));
  c.dispatchEvent(pointerAt('pointerup', c, 90, 0));
  const after = grab(gl, c.width, c.height);
  c.remove();
  const moved = bytesDiffering(before, after);
  if (moved !== 0) return `${moved} bytes changed after dispose -- something is still drawing`;
  return null;
});

// ---------------------------------------------------------------------------
// The idle spin, on the REAL requestAnimationFrame.
//
// Everything above this line is synchronous, which is why these are separate: no rAF
// callback can fire while a synchronous script is running, so not one check in this
// file had ever seen the spin move. It was shipped as an acknowledged residual and is
// closed here instead -- the spin is a render loop that runs on its own, indefinitely,
// against a live WebGL context, and "it stops when it should" was the one claim about
// it resting entirely on an injected fake `raf`.
//
// Measured through PIXELS rather than a pose read-back, deliberately: what matters is
// whether the loop is repainting the canvas, which is the cost and the visible effect.
// ---------------------------------------------------------------------------

/** Resolve after `ms` of wall clock, with rAF free to run throughout. This file is an
 * ES module, so the top-level awaits below really do suspend it -- and `__glResults` is
 * assigned after them, which is what keeps the runner from reading a partial set. */
function idle(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

await checkAsync('the idle spin actually turns the tank on the real rAF', async () => {
  const c = previewCanvas();
  const preview = createTankPreview(c);
  if (!preview) { c.remove(); return 'createTankPreview returned null in a real browser'; }
  const gl = (c.getContext('webgl2') ?? c.getContext('webgl')) as WebGLRenderingContext;
  const before = grab(gl, c.width, c.height);
  await idle(500);
  const after = grab(gl, c.width, c.height);
  preview.dispose();
  c.remove();
  const moved = bytesDiffering(before, after);
  // 500ms at IDLE_SPIN_RAD_PER_SEC 0.35 is ~0.175 rad, about 10 degrees -- a small
  // but unmistakable silhouette change. Both ends measured on this harness: 23069 of
  // 197600 bytes with the spin running, 0 with it suppressed.
  if (moved < 1000) return `only ${moved} of ${before.length} bytes changed in 500ms -- the spin is not running`;
  return null;
});

await checkAsync('the idle spin stops at the first interaction and does not drift back on its own', async () => {
  // The claim the whole design rests on -- a preview that resumes drifting under
  // someone trying to look at one face is the failure this is written to avoid --
  // and until now it was asserted only against an injected raf/cancelRaf pair.
  //
  // "does not drift back" is now bounded rather than permanent: the spin RESUMES, and
  // the two things that bring it back are a mouse leaving the canvas (checked below)
  // and IDLE_RESUME_DELAY_MS of quiet. Neither happens inside this window -- no
  // pointerleave is dispatched and 500ms is far short of the delay -- so a spin that
  // came back here is one that never stopped.
  const c = previewCanvas();
  const preview = createTankPreview(c);
  if (!preview) { c.remove(); return 'createTankPreview returned null in a real browser'; }
  const gl = (c.getContext('webgl2') ?? c.getContext('webgl')) as WebGLRenderingContext;
  c.dispatchEvent(pointerAt('pointermove', c, 70, 0));
  // Let a frame or two go by first: the cancel happens inside the event handler, but
  // a callback already scheduled for this frame may still be in flight.
  await idle(100);
  const settled = grab(gl, c.width, c.height);
  await idle(500);
  const later = grab(gl, c.width, c.height);
  preview.dispose();
  c.remove();
  const moved = bytesDiffering(settled, later);
  if (moved !== 0) return `${moved} bytes changed 500ms after a hover -- the spin restarted or never stopped`;
  return null;
});

await checkAsync('a disposed preview schedules no further frames', async () => {
  // dispose() cancels the pending frame AND the loop must not reschedule from inside
  // the callback that was already queued. A leak here is a rAF loop running against a
  // disposed renderer for the rest of the session, once per Customize close.
  //
  // WHAT ACTUALLY STOPS THE LOOP IS `cancelFrame()`, and only that. An earlier version of
  // this comment claimed three co-equal stoppers and attributed a measured 81377 bytes to
  // removing the `idle = false` / `disposed` pair; review falsified it and the measurement
  // was re-run here. Removing BOTH guards leaves all 46 GL checks and 57 of 57 vitest
  // cases green. The 81377 figure belongs to a THREE-line mutation that also drops
  // `cancelFrame()`; `cancelFrame()` alone dropped fails this check at 81376 (1-byte rAF
  // jitter between runs).
  //
  // The two guards are an UNREACHED backstop rather than redundant stoppers: JS is
  // single-threaded and `dispose()` is never called from inside a frame callback, so no
  // frame is ever in flight for them to catch. They cost nothing and are worth keeping
  // against a future async dispose path -- but nothing can kill them, and a reader should
  // not mistake "no mutation kills it" for "covered".
  const c = previewCanvas();
  const preview = createTankPreview(c);
  if (!preview) { c.remove(); return 'createTankPreview returned null in a real browser'; }
  const gl = (c.getContext('webgl2') ?? c.getContext('webgl')) as WebGLRenderingContext;
  preview.dispose();
  const before = grab(gl, c.width, c.height);
  await idle(500);
  const after = grab(gl, c.width, c.height);
  c.remove();
  const moved = bytesDiffering(before, after);
  if (moved !== 0) return `${moved} bytes changed 500ms after dispose -- a frame loop outlived the preview`;
  return null;
});

/** The HUD's rotate cluster, as far as preview.ts is concerned: four buttons carrying
 * the two data attributes. Built here rather than mounted from hud.ts so this file keeps
 * testing the RENDER path -- hud.ts's markup has its own guards under vitest. */
function rotateButtons(): HTMLButtonElement[] {
  const out: HTMLButtonElement[] = [];
  for (const part of ['hull', 'turret']) {
    for (const dir of ['left', 'right']) {
      const b = document.createElement('button');
      b.dataset.rotatePart = part;
      b.dataset.rotateDir = dir;
      document.body.appendChild(b);
      out.push(b);
    }
  }
  return out;
}

function buttonPointer(type: string): PointerEvent {
  return new PointerEvent(type, {
    pointerId: 2,
    pointerType: 'mouse',
    button: 0,
    buttons: type === 'pointerdown' ? 1 : 0,
    bubbles: true,
    cancelable: true,
  });
}

await checkAsync('a rotate button turns the tank in the rendered image', async () => {
  // The vitest cases prove the ANGLES move; nothing there can see whether the angle
  // reaches the pixels, because preview.ts is what wires the controls to a draw. This
  // is the same gap the drag check next door exists for, one control further along.
  const c = previewCanvas();
  const btns = rotateButtons();
  const preview = createTankPreview(c, btns);
  if (!preview) { c.remove(); for (const b of btns) b.remove(); return 'createTankPreview returned null in a real browser'; }
  const gl = (c.getContext('webgl2') ?? c.getContext('webgl')) as WebGLRenderingContext;
  // A press stops the idle spin, so the two grabs below differ only by the button.
  const hullRight = btns.find((b) => b.dataset.rotatePart === 'hull' && b.dataset.rotateDir === 'right')!;
  hullRight.dispatchEvent(buttonPointer('pointerdown'));
  hullRight.dispatchEvent(buttonPointer('pointerup'));
  await idle(100);
  const before = grab(gl, c.width, c.height);
  hullRight.dispatchEvent(buttonPointer('pointerdown'));
  hullRight.dispatchEvent(buttonPointer('pointerup'));
  const after = grab(gl, c.width, c.height);
  preview.dispose();
  c.remove();
  for (const b of btns) b.remove();
  const moved = bytesDiffering(before, after);
  // One KEY_STEP_RAD nudge is 7.5 degrees of hull, a much smaller silhouette change
  // than the 90px drag next door. Both ends measured on this harness: 11828 of 197600
  // bytes with the buttons wired, and EXACTLY 0 with preview.ts stopping forwarding
  // rotateButtons to createPreviewControls -- which is the one mutation in that sweep
  // no vitest case could see, and the reason this check exists.
  if (moved < 1000) return `only ${moved} of ${before.length} bytes changed -- the button did not reach the pixels`;
  return null;
});

await checkAsync('holding a rotate button keeps turning it, well past one nudge', async () => {
  // The hold is a rAF ramp, so it cannot be seen by anything synchronous -- and a
  // handler that stepped once and never started the ramp passes the check above.
  const c = previewCanvas();
  const btns = rotateButtons();
  const preview = createTankPreview(c, btns);
  if (!preview) { c.remove(); for (const b of btns) b.remove(); return 'createTankPreview returned null in a real browser'; }
  const gl = (c.getContext('webgl2') ?? c.getContext('webgl')) as WebGLRenderingContext;
  const turret = btns.find((b) => b.dataset.rotatePart === 'turret' && b.dataset.rotateDir === 'right')!;
  // Tap once to stop the spin and settle, then measure a HELD press against a tap.
  turret.dispatchEvent(buttonPointer('pointerdown'));
  turret.dispatchEvent(buttonPointer('pointerup'));
  await idle(100);
  const before = grab(gl, c.width, c.height);
  turret.dispatchEvent(buttonPointer('pointerdown'));
  await idle(100); // inside HOLD_REPEAT_DELAY_MS: the nudge only
  const nudged = grab(gl, c.width, c.height);
  await idle(700); // past the delay: ~0.6s of ramp, about 55 degrees of turret
  const held = grab(gl, c.width, c.height);
  turret.dispatchEvent(buttonPointer('pointerup'));
  await idle(300);
  const released = grab(gl, c.width, c.height);
  preview.dispose();
  c.remove();
  for (const b of btns) b.remove();
  const ramp = bytesDiffering(nudged, held);
  const nudge = bytesDiffering(before, nudged);
  const afterRelease = bytesDiffering(held, released);
  if (ramp <= nudge) {
    return `the hold moved ${ramp} bytes against a single nudge's ${nudge} -- the ramp is not running`;
  }
  if (afterRelease !== 0) return `${afterRelease} bytes changed 300ms after release -- the hold outlived the press`;
  return null;
});

await checkAsync('the idle spin comes back when the mouse leaves the canvas', async () => {
  // Desktop's resume path, end to end and on the real clock. The vitest case asserts
  // idleRunning() flips; this asserts the loop is actually repainting again, which is
  // the whole point of resuming it.
  const c = previewCanvas();
  const preview = createTankPreview(c);
  if (!preview) { c.remove(); return 'createTankPreview returned null in a real browser'; }
  const gl = (c.getContext('webgl2') ?? c.getContext('webgl')) as WebGLRenderingContext;
  c.dispatchEvent(pointerAt('pointerenter', c, 70, 0));
  c.dispatchEvent(pointerAt('pointermove', c, 70, 0));
  await idle(100);
  const stopped = grab(gl, c.width, c.height);
  await idle(300);
  const stillStopped = grab(gl, c.width, c.height);
  c.dispatchEvent(pointerAt('pointerleave', c, 700, 0));
  await idle(500);
  const resumed = grab(gl, c.width, c.height);
  preview.dispose();
  c.remove();
  if (bytesDiffering(stopped, stillStopped) !== 0) return 'the spin never stopped, so a resume proves nothing';
  const moved = bytesDiffering(stillStopped, resumed);
  if (moved < 1000) return `only ${moved} of ${resumed.length} bytes changed 500ms after the mouse left -- the spin did not come back`;
  return null;
});

// __glResults is the runner's readiness signal, and it is assigned LAST on purpose: the
// top-level awaits above suspend module evaluation, so publishing it any earlier would
// report a pass for checks that had not run -- the same failure the runner's "no results
// at all" guard covers one level up.
window.__glResults = results;
