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
import { buildGallery, type GalleryOptions } from '../gallery/subjects';
import { buildMomentScene } from '../gallery/moment-scene';
import { QUALITY_PRESETS } from '../../src/render/quality';

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
// render/quality.ts, applied. Every check above this line calls fresh(), which
// omits the 5th argument -- so none of them could tell a quality preset apart from
// no preset support at all existing. That question is asked here: does a NON-DEFAULT
// preset actually reach the THREE.WebGLRenderer/DirectionalLight construction, not just
// the plain data table quality.test.ts already pins under vitest.
// ---------------------------------------------------------------------------

/** A bare canvas in the document, sized like fresh()'s -- but WITHOUT calling
 * createScene, so the caller can pass its own quality preset as the 5th argument. */
function freshCanvas(w = 1280, h = 800): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  document.body.appendChild(canvas);
  return canvas;
}

function sunOf(ctx: ReturnType<typeof createScene>): THREE.DirectionalLight | null {
  let sun: THREE.DirectionalLight | null = null;
  ctx.scene.traverse((o) => {
    if ((o as THREE.DirectionalLight).isDirectionalLight && (o as THREE.DirectionalLight).castShadow) {
      sun = o as THREE.DirectionalLight;
    }
  });
  return sun;
}

// Each knob gets its OWN check, deliberately not folded into one multi-assertion check
// with early returns: a masking mutation test proved a combined check's later
// assertions (mapSize) were never demonstrated to fire, because the first
// (shadowType) always returned first. One property per check is what makes "this
// check has teeth" a claim about EACH knob rather than about whichever one happens to
// be checked first.

check('the `low` quality preset sets renderer.shadowMap.type', () => {
  const ctx = createScene(freshCanvas(), W, H, BOUNDARY, QUALITY_PRESETS.low);
  const shadowType = ctx.renderer.shadowMap.type;
  ctx.dispose();
  if (shadowType !== QUALITY_PRESETS.low.shadowType) {
    return `shadowMap.type is ${shadowType}, want low's ${QUALITY_PRESETS.low.shadowType} (BasicShadowMap)`;
  }
  return null;
});

check('the `low` quality preset sets the shadow-casting sun.shadow.mapSize', () => {
  const ctx = createScene(freshCanvas(), W, H, BOUNDARY, QUALITY_PRESETS.low);
  const sun = sunOf(ctx);
  const mapSize = sun?.shadow.mapSize.width;
  ctx.dispose();
  if (!sun) return 'no shadow-casting sun found';
  if (mapSize !== QUALITY_PRESETS.low.shadowMapSize) {
    return `sun.shadow.mapSize.width is ${mapSize}, want ${QUALITY_PRESETS.low.shadowMapSize}`;
  }
  return null;
});

check('the three presets scale renderer.getPixelRatio() distinctly when devicePixelRatio exceeds every cap', () => {
  // The vacuous form this replaces: comparing getPixelRatio() to a preset's own cap
  // under this harness's real devicePixelRatio (1, under swiftshader) is
  // min(1, cap) <= cap for EVERY cap -- an assertion that cannot fail, the named
  // anti-pattern. Stubbing devicePixelRatio above every cap (3 > high's 2) forces
  // Math.min(dpr, cap) to equal the cap exactly, which is what actually distinguishes
  // the three presets from each other and from a mutation that ignores the cap.
  const original = window.devicePixelRatio;
  Object.defineProperty(window, 'devicePixelRatio', { value: 3, configurable: true });
  const got: Partial<Record<'low' | 'medium' | 'high', number>> = {};
  try {
    for (const name of ['low', 'medium', 'high'] as const) {
      const ctx = createScene(freshCanvas(), W, H, BOUNDARY, QUALITY_PRESETS[name]);
      got[name] = ctx.renderer.getPixelRatio();
      ctx.dispose();
    }
  } finally {
    Object.defineProperty(window, 'devicePixelRatio', { value: original, configurable: true });
  }
  const mismatches = (['low', 'medium', 'high'] as const)
    .filter((name) => got[name] !== QUALITY_PRESETS[name].pixelRatioCap)
    .map((name) => `${name}: got ${got[name]}, want ${QUALITY_PRESETS[name].pixelRatioCap}`);
  return mismatches.length > 0 ? mismatches.join('; ') : null;
});

check('the `low` quality preset disables antialiasing on the WebGL context', () => {
  // Read back through the GL context itself (getContextAttributes), not the JS-side
  // RenderQuality object passed in -- the latter would only prove the value was
  // read, not that it reached THREE.WebGLRenderer's constructor.
  const highCtx = createScene(freshCanvas(), W, H, BOUNDARY, QUALITY_PRESETS.high);
  const highAA = highCtx.renderer.getContext().getContextAttributes()?.antialias;
  highCtx.dispose();
  const lowCtx = createScene(freshCanvas(), W, H, BOUNDARY, QUALITY_PRESETS.low);
  const lowAA = lowCtx.renderer.getContext().getContextAttributes()?.antialias;
  lowCtx.dispose();
  if (highAA !== true) return `high preset: context antialias attribute is ${highAA}, want true`;
  if (lowAA !== false) return `low preset: context antialias attribute is ${lowAA}, want false`;
  return null;
});

check('omitting the quality argument reproduces the `high` preset\'s shadowMap.type', () => {
  // fresh() (used by every OTHER check above this section) omits the 5th argument.
  // This is the default-path guarantee the whole feature depends on: an absent
  // `quality` dev flag must not move construction away from what shipped before this
  // feature existed. Split per-knob for the same masking reason as the low-preset
  // checks above.
  const ctx = fresh();
  const shadowType = ctx.renderer.shadowMap.type;
  ctx.dispose();
  if (shadowType !== QUALITY_PRESETS.high.shadowType) {
    return `default shadowMap.type is ${shadowType}, want high's ${QUALITY_PRESETS.high.shadowType} (PCFSoftShadowMap)`;
  }
  return null;
});

check('omitting the quality argument reproduces the `high` preset\'s sun.shadow.mapSize', () => {
  const ctx = fresh();
  const sun = sunOf(ctx);
  const mapSize = sun?.shadow.mapSize.width;
  ctx.dispose();
  if (!sun) return 'no shadow-casting sun found';
  if (mapSize !== QUALITY_PRESETS.high.shadowMapSize) {
    return `default sun.shadow.mapSize.width is ${mapSize}, want ${QUALITY_PRESETS.high.shadowMapSize}`;
  }
  return null;
});

check('createRenderer forwards its quality option through to the scene it builds', () => {
  // renderer.ts's own seam, not scene.ts's -- proves the RendererOptions.quality field
  // (loop.ts's actual wiring point) is not merely typed but actually plumbed.
  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 800;
  document.body.appendChild(canvas);
  const r = createRenderer(canvas, W, H, BOUNDARY, { quality: QUALITY_PRESETS.low });
  const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as WebGLRenderingContext;
  // Read back a QUALITY-DERIVED value, not merely context liveness: review proved the
  // isContextLost() version passed with renderer.ts's forwarding line reverted, since
  // a live context is exactly as achievable at the default preset. The context is the
  // one three.js created on this canvas, and low's antialias is FALSE where the
  // default high's is true -- so a dropped forwarding reads back true here and fails.
  const aa = gl.getContextAttributes()?.antialias;
  r.dispose();
  canvas.remove();
  if (aa === undefined) return 'context attributes unavailable -- cannot verify forwarding';
  return aa === QUALITY_PRESETS.low.antialias
    ? null
    : `context antialias is ${aa} after forwarding the low preset, want ${QUALITY_PRESETS.low.antialias}`;
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
// tools/gallery/subjects.ts: that the gallery can show a SKIN, and an animated one.
//
// Here rather than in vitest for the usual reason -- `buildGallery` constructs a
// WebGLRenderer -- and worth having at all because the gallery is what every future
// skin change is supposed to be reviewed through. Until now it drew the roster default,
// unmapped, and `views.sync(prev, curr, alpha)` left `dt` at its default 0, so an
// animated skin could not move even if one had been selected.
//
// Both checks are pixel comparisons against a CONTROL that must NOT move, because
// "some bytes changed" on its own is satisfied by any wobble in the scene.
// ---------------------------------------------------------------------------

function galleryCanvas(w = 320, h = 240): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.style.width = `${w}px`;
  c.style.height = `${h}px`;
  document.body.appendChild(c);
  return c;
}

function galleryOpts(over: Partial<GalleryOptions>): GalleryOptions {
  return {
    elements: ['tank'], view: 'close', reach: false, timer: false, fill: false,
    skin: 'solid', hull: '#3d7bd6', accent: null, frames: null, ...over,
  };
}

check('the gallery paints the chosen skin onto the tank it renders', () => {
  const a = galleryCanvas();
  const b = galleryCanvas();
  const plain = buildGallery(a, a.width, a.height, galleryOpts({ skin: 'solid' }));
  const skinned = buildGallery(b, b.width, b.height, galleryOpts({ skin: 'checker' }));
  plain.draw(0, 0);
  skinned.draw(0, 0);
  const glA = (a.getContext('webgl2') ?? a.getContext('webgl')) as WebGLRenderingContext;
  const glB = (b.getContext('webgl2') ?? b.getContext('webgl')) as WebGLRenderingContext;
  const solid = grab(glA, a.width, a.height);
  const checker = grab(glB, b.width, b.height);
  plain.dispose();
  skinned.dispose();
  a.remove();
  b.remove();
  const moved = bytesDiffering(solid, checker);
  // Same hull colour, same pose, same camera: the ONLY difference is the mapped
  // texture, so 0 here means setPlayerStyle never reached the tank -- which is exactly
  // what the gallery did before, with no way to tell from a screenshot.
  if (moved < 1000) return `only ${moved} of ${solid.length} bytes differ between solid and checker -- the skin is not being applied`;
  return null;
});

check('the gallery advances an ANIMATED skin along its timeline, and only an animated one', () => {
  // 600 age steps is 10 seconds of ticks (see timelineDt): `flow` scrolls 0.08 of a
  // tile per second, so 0.8 of a tile -- unmistakable. The `checker` half is the
  // control and it is the load-bearing half: the tank element ignores `age` entirely,
  // so a static skin MUST come back byte-identical, and any pixel difference there
  // would mean the flow result proves nothing about scrolling.
  const results: string[] = [];
  for (const [skin, mustMove] of [['flow', true], ['checker', false]] as const) {
    const c = galleryCanvas();
    const g = buildGallery(c, c.width, c.height, galleryOpts({ skin }));
    const gl = (c.getContext('webgl2') ?? c.getContext('webgl')) as WebGLRenderingContext;
    g.draw(0, 0);
    const before = grab(gl, c.width, c.height);
    g.draw(600, 0);
    const after = grab(gl, c.width, c.height);
    g.dispose();
    c.remove();
    const moved = bytesDiffering(before, after);
    if (mustMove && moved < 1000) results.push(`${skin}: only ${moved} of ${before.length} bytes moved over 600 ticks -- the skin is not scrolling`);
    if (!mustMove && moved !== 0) results.push(`${skin}: ${moved} bytes moved over 600 ticks, but nothing in this scene animates but the skin`);
  }
  return results.length > 0 ? results.join('; ') : null;
});

check('--spawn-anim reaches pixels: rise and warp differ at a matched entrance frame, and rise matches itself', () => {
  // The owner's deferral reason for b897825 (#201) was that nothing end-to-end proved
  // `--spawn-anim` reaches pixels. This proves it at the deepest layer under a repository
  // gate: buildGallery({ spawnAnim }) -> setPlayerStyle -> entities.ts's entrance trigger
  // -> a real WebGL readback.
  //
  // `entrant` (subjects.ts) is dead before age 0 and alive from age 0 -- the `tank`
  // element used elsewhere is always alive and cannot supply the dead->alive edge
  // entities.ts's trigger actually needs. `draw(0, 0)` is the gallery's FIRST draw, so
  // its own dt is clamped to 0 (subjects.ts's clock comment); the edge still fires there,
  // with the entrance starting at elapsed 0. `draw(15, 0)` then carries the timeline
  // 15 ticks forward: dt = 15 * DT (1/60s) = 0.25s, exactly ENTRANCE_SECONDS (0.5) / 2 --
  // the same midpoint entities.test.ts already proved the variants diverge at (rise
  // tankScale 0.5, warp 0.8).
  const render = (spawnAnim: 'warp' | 'rise'): Uint8Array => {
    const c = galleryCanvas(128, 96);
    const g = buildGallery(c, c.width, c.height, {
      elements: ['entrant'], view: 'low', reach: false, timer: false, fill: false,
      skin: 'solid', hull: null, accent: null, frames: null, spawnAnim,
    });
    const gl = (c.getContext('webgl2') ?? c.getContext('webgl')) as WebGLRenderingContext;
    g.draw(0, 0);
    g.draw(15, 0);
    const px = grab(gl, c.width, c.height);
    g.dispose();
    c.remove();
    return px;
  };
  const warp = render('warp');
  const rise = render('rise');
  const rise2 = render('rise');
  // Built-in negative control: two identical `rise` renders must be pixel-identical
  // before `warp !== rise` is allowed to mean anything about spawnAnim.
  const control = bytesDiffering(rise, rise2);
  if (control !== 0) return `control failed: two identical rise renders differ by ${control} of ${rise.length} bytes -- the check cannot discriminate`;
  // Measured on this fixture: warp vs. rise differ by 9024 of 49152 bytes at this
  // matched frame -- orders of magnitude, not a margin (bytesDiffering's own doc
  // comment), so this follows the file's `< 1000` convention (harness.ts's other two
  // gallery checks) rather than a bare `=== 0`/`!== 0`.
  const moved = bytesDiffering(warp, rise);
  if (moved < 1000) return `only ${moved} of ${warp.length} bytes differ between warp and rise -- the spawnAnim option is not reaching the entrance`;
  return null;
});

check('a moment scene renders the fire tick\'s muzzle burst, and a repeated draw is pixel-identical', () => {
  // The brief's original design compared a draw of the tick BEFORE the pinned fire tick
  // (moments.ts: MOMENTS.fire.expect) against the tick after, expecting the muzzle burst
  // to be the visible delta. MEASURED not to discriminate: the newly spawned SHELL is
  // also part of that delta (worlds[9] has no bullet, worlds[11] does, moving under its
  // own velocity) and dominates it -- one run each on this harness (200x150 canvas,
  // 120000 bytes) gave 534 AS SHIPPED and 495 under the very mutation this check exists
  // to catch (particles.spawn([]) in place of the tick's events) -- not separated at all.
  //
  // This form isolates the burst instead: hold `age` FIXED at the fire tick (10) and
  // advance only `alpha`. entities.ts's syncBullets has no `prev` counterpart for a
  // bullet that did not exist before tick 10, so it falls back to the bullet's CURRENT
  // position regardless of alpha (entities.ts:1439) -- and the shooter tank never moves
  // in this moment (IDLE input throughout). Only `particles.update(dt)`, driven by the
  // alpha-advanced clock, can move anything between the two draws below.
  //
  // alpha=10 is a HAND-DRIVEN PROBE, not a state the shipped runner ever reaches --
  // run.mjs only ever calls GALLERY_DRAW with alpha in `[0, 1)` (one sub-tick fraction
  // per --subdiv step). It is used here because it drives the real timelineDt ->
  // particles.update(dt) path with enough elapsed time for the burst to have visibly
  // moved, through the same public draw() signature the runner calls.
  const c = galleryCanvas(320, 240);
  const g = buildMomentScene(c, c.width, c.height, {
    moment: 'fire', view: 'low', skin: 'solid', hull: null, accent: null, spawnAnim: 'warp',
  });
  const gl = (c.getContext('webgl2') ?? c.getContext('webgl')) as WebGLRenderingContext;
  g.draw(10, 0); // first draw: dt clamped to 0, so the burst is captured at its spawn point
  const spawn0 = grab(gl, c.width, c.height);
  g.draw(10, 10); // same age, alpha 10 ticks later (~0.17s) -- only particles can have moved
  const moved = grab(gl, c.width, c.height);
  // Built-in negative control: redrawing the SAME (age, alpha) a second time must be
  // pixel-identical -- the clock is already at this instant, so dt is 0 and nothing
  // should move further, before "delta > 0" is allowed to mean anything about the burst.
  //
  // This control is not a formality: it also kills moment-scene.ts's `fed` idempotency
  // guard on its own. MEASURED by dropping `while (fed <= a) { ...; fed++ }` for a bare
  // `particles.spawn(tl.events[a])` on every call (no idempotency at all): this exact
  // redraw then re-spawns 5 fresh particles at the muzzle, and the control below reddens
  // at "differs by 60 of 307200 bytes" instead of the delta assertion ever running.
  g.draw(10, 10);
  const repeat = grab(gl, c.width, c.height);
  g.dispose();
  c.remove();
  const control = bytesDiffering(moved, repeat);
  if (control !== 0) return `control failed: redrawing (10, 10) differs by ${control} of ${moved.length} bytes -- the check cannot discriminate`;
  const delta = bytesDiffering(spawn0, moved);
  // MEASURED with this exact (age, alpha) pair, 320x240 canvas, 307200 bytes total: 2
  // runs as shipped landed at EXACTLY 102 both times, and 2 runs under
  // `particles.spawn([])` in place of the tick's events (the mutation this check exists
  // to catch) both landed at EXACTLY 0. Both are fixed constants, not ranges: task 7's
  // fix seeded moment-scene.ts's particle rng (a local mulberry32, fixed literal seed),
  // so `buildMomentScene` renders are now deterministic by construction -- before that
  // fix, this same measurement (`particles.ts`'s burst() drawing directly from
  // `Math.random()`) varied run to run (5 runs landed at 90, 117, 174, 180, 213). The
  // threshold below is set well under the shipped 102 and well over the mutated 0.
  if (delta < 20) {
    return `only ${delta} of ${spawn0.length} bytes moved between a freshly spawned fire burst and 0.17s later -- the moment's events are not reaching particles`;
  }
  return null;
});

check('a moment scene applies --spawn-anim to the tank that actually respawns, not slot 0', () => {
  // Task 7's routing bug: moment-scene.ts wrote the CLI's chosen spawnAnim into slot 0
  // only, but MOMENTS.respawn's revived tank is buildKillWorld's VICTIM,
  // `controlledBy: 1` -- slot 1. entities.ts's entrance trigger reads
  // `styleFor(t.controlledBy ?? 0).spawnAnim`, so a slot-0-only call never reached the
  // tank whose entrance is actually on screen; task 7's report measured all three
  // `--spawn-anim` variants pixel-identical outside the (unrelated) particle-noise
  // window. Fixed by styling every co-op slot (0-3) with the chosen variant. This is
  // the same construction as the `--spawn-anim reaches pixels` check above (matched
  // entrance frame at elapsed = ENTRANCE_SECONDS / 2, where rise/warp tankScale is
  // measured to diverge: 0.5 vs 0.8), through buildMomentScene instead of buildGallery
  // -- the builder this bug actually lived in.
  const render = (spawnAnim: 'warp' | 'rise'): Uint8Array => {
    const c = galleryCanvas(200, 150);
    const g = buildMomentScene(c, c.width, c.height, {
      moment: 'respawn', view: 'low', skin: 'solid', hull: null, accent: null, spawnAnim,
    });
    const gl = (c.getContext('webgl2') ?? c.getContext('webgl')) as WebGLRenderingContext;
    // First draw ever for this instance: age held at 135, MOMENTS.respawn's pinned
    // revival tick, so `clock === null` clamps dt to 0 and entities.ts's
    // `enteredRespawn` edge (prev dead, curr alive) fires with the entrance starting
    // at elapsed 0 -- same shape as the fire-tick check above, moved from the muzzle
    // tick to the revival tick.
    g.draw(135, 0);
    // Same age (world pose held fixed, same reason the fire-tick check holds age
    // fixed): alpha advances the clock 15 ticks, dt = 15 * DT = 0.25s =
    // ENTRANCE_SECONDS / 2.
    g.draw(135, 15);
    const px = grab(gl, c.width, c.height);
    g.dispose();
    c.remove();
    return px;
  };
  const warp = render('warp');
  const rise = render('rise');
  const rise2 = render('rise');
  // Built-in negative control: two identical `rise` renders must be pixel-identical
  // before `warp !== rise` is allowed to mean anything -- also exercises that
  // moment-scene.ts's particle rng seed makes independent renders reproducible, not
  // just this check's own entrance-frame comparison.
  const control = bytesDiffering(rise, rise2);
  if (control !== 0) return `control failed: two identical rise renders of the respawn moment differ by ${control} of ${rise.length} bytes -- the check cannot discriminate`;
  const moved = bytesDiffering(warp, rise);
  // MEASURED on this exact fixture (200x150 canvas, 120000 bytes): 241 as shipped
  // (fixed), and EXACTLY 0 under the mutation this check exists to catch (reverting
  // moment-scene.ts's slots 1-3 loop back to the slot-0-only call -- verified live and
  // reverted, see this task's report). 0 is not a margin call here: `respawn`'s revived
  // tank is slot 1, so with no slot-1 style ever written, entities.ts's `styleFor(1)`
  // falls back to the SAME unstyled-slot default (DEFAULT_SPAWN_ANIM) regardless of
  // which variant the CLI asked for, making warp and rise render byte-identical at this
  // frame rather than merely close. `respawn`'s span (13, far wider than the
  // `--spawn-anim reaches pixels` check's `entrant` element) puts the revived tank far
  // from camera, so the shipped delta is two orders of magnitude smaller than that
  // check's 9024/49152 -- the threshold below is set well under the measured 241 and
  // well over the mutated 0.
  if (moved < 40) return `only ${moved} of ${warp.length} bytes differ between warp and rise at the revived tank's entrance -- --spawn-anim is not reaching the tank that actually respawns`;
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

await checkAsync('the idle spin stops at the first interaction and does not drift back on its own, for a NON-ANIMATED skin', async () => {
  // The claim the whole design rests on -- a preview that resumes drifting under
  // someone trying to look at one face is the failure this is written to avoid --
  // and until now it was asserted only against an injected raf/cancelRaf pair.
  //
  // "does not drift back" is now bounded rather than permanent: the spin RESUMES, and
  // the two things that bring it back are a mouse leaving the canvas (checked below)
  // and IDLE_RESUME_DELAY_MS of quiet. Neither happens inside this window -- no
  // pointerleave is dispatched and 500ms is far short of the delay -- so a spin that
  // came back here is one that never stopped.
  //
  // THE SKIN QUALIFIER IS ALSO LOAD-BEARING. "0 bytes change after a hover" used to be
  // unconditional, and it was safe to state that way only because `preview.ts` passed a
  // hardwired `dt = 0`: selecting `flow` could not have moved a pixel. Now that it can,
  // this check is about the SPIN, and it says so -- with the static skin selected
  // explicitly rather than relying on a freshly built preview happening to have no skin
  // at all. The animated case is two checks below, and it asserts the opposite.
  const c = previewCanvas();
  const preview = createTankPreview(c);
  if (!preview) { c.remove(); return 'createTankPreview returned null in a real browser'; }
  const gl = (c.getContext('webgl2') ?? c.getContext('webgl')) as WebGLRenderingContext;
  preview.setStyle('#3d7bd6', 'checker', null);
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

await checkAsync('a STATIC skin schedules NO frames once the spin has stopped', async () => {
  // The check above says the pixels come to rest. This one says the panel stops ASKING
  // for frames, which is a different fact and the one `preview.ts` actually claims:
  // "picking a static one stops it, so an untouched panel showing `solid` costs no
  // frames at all once the idle spin ends" (and `backlog.md` entry 5 says the same).
  //
  // Nothing pinned it, and the gap was real: `controls.setAnimating(true)` written
  // unconditionally in `preview.ts` passed 1741 of 1743 vitest cases (2 skipped) and all
  // 50 GL checks. Every byte-level probe is blind to it by construction -- a static skin
  // repainted forever changes zero bytes, which is exactly what `afterStatic === 0`
  // asserts next door. The observable that is NOT blind is the frame request itself.
  //
  // An earlier draft of the disclosure claimed this needed an observable `TankPreview`
  // does not expose. That was wrong: `window.requestAnimationFrame` is the observable,
  // and it is already reachable from here. UNTESTED and UNFALSIFIABLE are different
  // claims and this one was only the former.
  const c = previewCanvas();
  const preview = createTankPreview(c);
  if (!preview) { c.remove(); return 'createTankPreview returned null in a real browser'; }
  preview.setStyle('#3d7bd6', 'checker', null);
  c.dispatchEvent(pointerAt('pointermove', c, 70, 0));
  // The spin's cancel happens inside the event handler, but a callback already scheduled
  // for this frame may still be in flight and will reschedule once before it sees the
  // stop. Counting starts after that has settled -- same reason as the check above.
  await idle(100);
  const real = window.requestAnimationFrame;
  let scheduled = 0;
  window.requestAnimationFrame = function (cb: FrameRequestCallback): number {
    scheduled++;
    return real.call(window, cb);
  };
  try {
    await idle(400);
  } finally {
    // Restored in a finally: leaving a counting wrapper on `window` would silently
    // follow every later check in this file.
    window.requestAnimationFrame = real;
  }
  preview.dispose();
  c.remove();
  // Measured on this harness, both ends: 0 as shipped, 24 with `setAnimating(true)`
  // written unconditionally. Asserted at exactly 0 rather than at a threshold, because
  // "stops asking" is the claim -- one frame per 400ms would still be a live loop.
  if (scheduled !== 0) {
    return `${scheduled} frames scheduled in 400ms with a static skin -- the panel never stops repainting`;
  }
  return null;
});

await checkAsync('an ANIMATED skin keeps repainting after the spin has stopped', async () => {
  // The whole of issue #122, measured where it lives. `flow` is the one animated skin
  // the game ships, and the panel where a player decides whether to wear it showed it
  // frozen: `preview.ts` passed a literal `dt = 0` and `entities.ts` gates the scroll on
  // `dt > 0`. Nothing under vitest can see this -- preview.ts returns null in jsdom.
  //
  // Same shape as the check above and the opposite expectation, deliberately: the two
  // together say the spin stopped and the skin did not.
  const c = previewCanvas();
  const preview = createTankPreview(c);
  if (!preview) { c.remove(); return 'createTankPreview returned null in a real browser'; }
  const gl = (c.getContext('webgl2') ?? c.getContext('webgl')) as WebGLRenderingContext;
  preview.setStyle('#3d7bd6', 'flow', null);
  c.dispatchEvent(pointerAt('pointermove', c, 70, 0));
  await idle(100); // let the spin's last in-flight frame land
  const settled = grab(gl, c.width, c.height);
  await idle(500);
  const later = grab(gl, c.width, c.height);
  // ...and then a static skin must come to rest. This half is the CONTROL for the half
  // above -- it is what makes "23584 bytes changed" mean the skin and not some other
  // repaint (a spin that never stopped would move bytes here too).
  //
  // It earns its place: dropping `idle = false` from `stopIdle` fails HERE at 27983
  // bytes while the "stops for good" check above still passes, because with no animated
  // skin that same mutation still cancels the frame.
  //
  // What it does NOT prove, stated because the obvious reading is wrong: it cannot tell
  // "the loop stopped" from "the loop is running and drawing the same thing", since a
  // static skin repainted forever changes zero bytes. Mutating `entities.setPlayerStyle`
  // to leave a stale `playerScroll` behind leaves this GREEN, because `setAnimating`
  // has already stopped the clock. The loop's cancellation is asserted where it can be
  // seen -- preview-controls.test.ts, against the handle `cancelRaf` was handed.
  preview.setStyle('#3d7bd6', 'checker', null);
  await idle(100);
  const stat0 = grab(gl, c.width, c.height);
  await idle(500);
  const stat1 = grab(gl, c.width, c.height);
  preview.dispose();
  c.remove();
  const scrolled = bytesDiffering(settled, later);
  const afterStatic = bytesDiffering(stat0, stat1);
  // 500ms at scroll u = 0.08 is 0.04 of a tile -- about 5 of the tile's 128 texels,
  // several screen pixels of pattern on a hull this size. Measured on this harness:
  // 23584 of 197600 bytes with the skin animating, 0 once `checker` is selected.
  if (scrolled < 1000) return `only ${scrolled} of ${settled.length} bytes changed in 500ms -- the animated skin is frozen`;
  if (afterStatic !== 0) return `${afterStatic} bytes changed 500ms after switching to a static skin -- something is still moving`;
  return null;
});

await checkAsync('a disposed preview stops an ANIMATED skin too', async () => {
  // dispose() cancels the pending frame; the animation clock is a second reason for
  // that frame to exist, and a `dispose` that only cleared `idle` would leave a rAF
  // loop running against a torn-down renderer for the rest of the session -- once per
  // Customize close, for anyone wearing `flow`.
  const c = previewCanvas();
  const preview = createTankPreview(c);
  if (!preview) { c.remove(); return 'createTankPreview returned null in a real browser'; }
  const gl = (c.getContext('webgl2') ?? c.getContext('webgl')) as WebGLRenderingContext;
  preview.setStyle('#3d7bd6', 'flow', null);
  await idle(100);
  preview.dispose();
  const before = grab(gl, c.width, c.height);
  await idle(500);
  const after = grab(gl, c.width, c.height);
  c.remove();
  const moved = bytesDiffering(before, after);
  if (moved !== 0) return `${moved} bytes changed 500ms after dispose -- the skin's frame loop outlived the preview`;
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
