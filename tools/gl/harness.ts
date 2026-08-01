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

check('the ground sizes to a NON-shipped board (15x11) at construction', () => {
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
    return `ground is ${p.width}x${p.height}, framed area for 15x11 is ${want.width}x${want.height}`;
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
  // The constraint this retires: every arena had to be 11x9 because the scene sized
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

check('WIDE_ARENA (15x11) sizes correctly through refit, not just construction', () => {
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

check('refit moves the shadow camera with the board, no wasted margin', () => {
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
  const cam = (sun as THREE.DirectionalLight).shadow.camera as THREE.OrthographicCamera;
  const wider = framedBounds(34, 18, BOUNDARY);
  const wantHalf = Math.max(wider.width, wider.height) / 2 + BOUNDARY;
  ctx.dispose();
  if (Math.abs(cam.right - wantHalf) > 1e-6) {
    return `shadow half-extent ${cam.right}, want ${wantHalf}`;
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

window.__glResults = results;
