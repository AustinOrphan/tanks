import * as THREE from 'three';
import { createEntityViews } from '../../src/render/entities';
import { createParticleSystem } from '../../src/render/particles';
import { createDeathPulseSystem } from '../../src/render/death-pulse';
import { createTreadTrailSystem } from '../../src/render/tread-trails';
import type { SkinId, SpawnAnimId } from '../../src/game/customization';
import { MOMENTS, simulateMoment } from './moments';
import { VIEWS, timelineDt } from './subjects';

/**
 * A tiny, fast, deterministic PRNG (mulberry32), duplicated here rather than imported
 * from `src/sim/ai/player-profile.ts`: that module's copy is exported for the sim/AI
 * layer (pacifist.test.ts, the autoplay dev flag), and this is a presentation-tooling
 * concern with no reason to import across that boundary for six lines. Same algorithm,
 * same seed -> same sequence guarantee.
 */
function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Fixed literal seed: a moment gif is evidence about the shipped render path, and that
// evidence has to be reproducible run to run. `particles.ts`'s burst() draws from
// `Math.random()` by default (see its own doc comment) precisely so the GAME keeps its
// unrepeatable look; this is the one caller that instead needs two independent renders
// of the same moment to come back byte-identical, so it supplies its own seeded stream.
const PARTICLE_SEED = 0xc0ffee;

export interface MomentSceneOptions {
  /** Key into MOMENTS. */
  moment: string;
  /** Key into VIEWS. */
  view: string;
  skin: SkinId;
  hull: string | null;
  accent: string | null;
  /** Experimental mine-warning treatment (issue #276 playtest round); null = default. */
  mineWarn?: import('../../src/render/mine-warning').MineWarnStyle | null;
  /**
   * Dressing for the entrance the moment stages -- required here, unlike
   * `GalleryOptions.spawnAnim` (subjects.ts), which is optional and only reaches
   * `setPlayerStyle` behind a "something is being styled" guard. A moment scene always
   * renders the player tank through the paint shop (see `views.setPlayerStyle` below),
   * so there is no undecorated invocation to protect the way that guard protects
   * `buildGallery`'s plain `--elements tank` call.
   */
  spawnAnim: SpawnAnimId;
}

export interface MomentProducerReport {
  schemaVersion: 1;
  producer: { kind: 'moment'; scenarioId: string };
  fixture: { seed: number };
  tickCount: number;
  observedEvents: { type: string; tick: number }[];
  fixtureAssertions: {
    kind: 'event-at-tick';
    type: string;
    expectedTick: number;
    observedTicks: number[];
    passed: boolean;
  }[];
}

/**
 * Renders a `MOMENTS` timeline (Task 3/4) through the SAME render consumer set and
 * order the game itself drives (renderer.ts: `entities.sync`, `particles.spawn` +
 * `update`, `deathPulse.spawn` + `update`), so a moment gif is evidence about the
 * shipped render path rather than a bespoke replay of it.
 *
 * The scene/lighting/ground/camera construction below is copied from `buildGallery`
 * (subjects.ts) rather than shared: subjects.ts's own header warns that a scene
 * builder with its own meshes is a mockup, and the same risk applies one level up to
 * a SECOND scene builder that drifts from the first. Keeping this in step with
 * `buildGallery`'s construction -- same background/ambient/key light colour,
 * intensity and position; same ground plane size, material and rotation; same
 * camera FOV, span-fit math and view direction -- is what closes that gap, rather
 * than factoring out a "shared" builder that both could silently drift from later.
 * Two pieces are deliberately NOT copied: `buildGallery`'s conditional fill light
 * (`opts.fill`) and its mine-debug overlay (`createMineDebug`) -- neither applies to
 * a moment, which has no `--fill`/`--reach`/`--timer` knobs of its own.
 */
export function buildMomentScene(
  canvas: HTMLCanvasElement,
  w: number,
  h: number,
  opts: MomentSceneOptions,
): {
  draw(age: number, alpha: number): void;
  frames: number;
  dispose(): void;
  captureReport: MomentProducerReport;
} {
  const def = MOMENTS[opts.moment];
  const tl = simulateMoment(def);
  const observedEvents = tl.events.flatMap((events, tick) =>
    events.map((event) => ({ type: event.type, tick })),
  );
  const fixtureAssertions = def.expect.map(({ type, tick }) => {
    const observedTicks = observedEvents
      .filter((event) => event.type === type)
      .map((event) => event.tick);
    return {
      kind: 'event-at-tick' as const,
      type,
      expectedTick: tick,
      observedTicks,
      passed: observedTicks.length === 1 && observedTicks[0] === tick,
    };
  });

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x14171a);
  scene.add(new THREE.AmbientLight(0xffffff, 0.62));
  const key = new THREE.DirectionalLight(0xffffff, 1.05);
  key.position.set(6, 12, 4);
  scene.add(key);
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(40, 40),
    new THREE.MeshStandardMaterial({ color: 0x2d5a3d }),
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  const views = createEntityViews(scene, undefined, opts.mineWarn ?? null);
  // Same call the game makes (renderer.ts's setPlayerStyle) -- unconditional here,
  // unlike buildGallery's guarded call, because opts.spawnAnim is always meaningful
  // for a moment (see the field doc above). Slot 0 carries the CLI's hull/skin/accent
  // triple, same as before.
  views.setPlayerStyle(opts.hull ?? null, opts.skin, opts.accent ?? null, 0, opts.spawnAnim);
  // Slots 1-3 too: entities.ts's entrance trigger reads `styleFor(t.controlledBy ??
  // 0).spawnAnim`, keyed by whichever slot's tank actually respawns -- and in
  // `buildKillWorld` (moments.ts), that is the VICTIM, `controlledBy: 1`, not the
  // slot-0 shooter this call alone used to reach. Styling every slot with the chosen
  // variant means the entrance animation follows whichever tank the moment's own script
  // revives, instead of silently landing on slot 0 by construction.
  //
  // VISIBLE SIDE EFFECT (measured, task 7's follow-up): passing `hex: null` here writes
  // an ENTRY into entities.ts's playerStyles map for slots 1-3, so `styleFor(slot)` no
  // longer falls through to `DEFAULT_OTHER_SLOT_STYLE` (hex `#c23b8f`, a magenta
  // placeholder distinct from every roster tank). It resolves `null ?? configFor
  // ('player').color` instead -- the same roster blue slot 0 uses. A moment with a
  // second player tank (`destroyed`, `respawn`) now renders BOTH tanks the same hull
  // colour for the whole clip, distinguished only by the identity ring (cyan/orange),
  // not just at the entrance. This is a consequence of the exact call signature this
  // fix was ruled to use, not a bug in it -- flagged here for whoever next edits this
  // block, and in the task report.
  for (let slot = 1; slot <= 3; slot++) {
    views.setPlayerStyle(null, 'solid', null, slot, opts.spawnAnim);
  }
  const particles = createParticleSystem(scene, mulberry32(PARTICLE_SEED));
  const deathPulse = createDeathPulseSystem(scene);
  // No RNG seam needed (unlike particles): emission is purely a function of world
  // position/orientation, so two renders of the same moment are already
  // byte-identical without one -- see tread-trails.ts's own doc comment.
  const treadTrails = createTreadTrailSystem(scene);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(w, h, false);

  const v = VIEWS[opts.view] ?? VIEWS.game;
  const FOV = 38;
  const cam = new THREE.PerspectiveCamera(FOV, w / h, 0.01, 200);
  if (v.up) cam.up.set(...v.up);
  // Same fit math as buildGallery: distance that fits `def.span` across the SHORTER of
  // the two axes, with a margin, so a wide moment is not cropped by a tall viewport or
  // vice versa.
  const vFov = (FOV * Math.PI) / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * (w / h));
  const dist = (def.span / 2 / Math.tan(Math.min(vFov, hFov) / 2)) * 1.12;
  const focus = new THREE.Vector3(...def.focus);
  const dir = new THREE.Vector3(...v.dir).normalize();
  cam.position.copy(focus).addScaledVector(dir, dist);
  cam.lookAt(focus);

  // Where on the timeline the last draw left off, in ticks. Null until the first draw,
  // which therefore advances nothing -- see subjects.ts's timelineDt.
  let clock: number | null = null;
  // Ticks whose events have already been handed to particles/deathPulse. A plain
  // "spawn events[age]" would re-fire the SAME tick's burst once per --subdiv alpha,
  // since the runner redraws one integer age at several alphas before advancing it;
  // `fed` instead walks the tick index forward once, independent of how many times
  // draw() is called at the same age.
  //
  // DISCLOSED LIMITATION: this only walks forward. A rewind (`GALLERY_DRAW(0, 0)`
  // called again after the timeline has already advanced) does not replay ticks
  // 0..fed-1's events -- `fed` never resets. run.mjs's runner only walks ages forward,
  // so this is unreached from `npm run gallery`, but a hand-driven rewind through the
  // dev server would silently miss those bursts. The FORWARD counterpart of the same
  // limitation is the ordinary case, not an edge one: a hand-typed `?age=N` for N > 0
  // is the first draw() call ever made, so the `while (fed <= a)` loop below feeds
  // every skipped tick 0..N in one shot -- all of them at `dt` 0 (clock was still
  // null), so every past event spawns at its own tick's creation state rather than
  // animating in. Only tick N's own events, fed on some LATER draw(), ever get a
  // nonzero dt to animate with.
  let fed = 0;
  function draw(age: number, alpha: number): void {
    const at = age + alpha;
    const dt = clock === null ? 0 : timelineDt(clock, at);
    clock = at;
    const a = Math.min(Math.max(0, age), tl.worlds.length - 1);
    // Spawn-loop-then-sync-then-update, not renderer.ts's own per-frame order
    // (entities.sync, THEN particles.spawn/update, deathPulse.spawn/update). The
    // deviation is required, not incidental: a multi-tick catch-up (see the
    // DISCLOSED LIMITATION above) must feed EVERY skipped tick's events, not just the
    // latest, and only this loop knows how many ticks that is -- renderer.ts always
    // advances exactly one. It stays functionally equivalent to renderer.ts's order
    // because `spawn()` reads only the events/world arguments passed to it, never
    // scene state `sync()` would have touched -- reordering the two changes nothing
    // either call observes.
    while (fed <= a) {
      particles.spawn(tl.events[fed]);
      deathPulse.spawn(tl.events[fed], tl.worlds[fed], { enemyEnabled: true });
      fed++;
    }
    // prev/curr one tick apart, so interpolated quantities animate rather than step.
    views.sync(tl.worlds[Math.max(0, a - 1)], tl.worlds[a], alpha, dt);
    particles.update(dt);
    deathPulse.update(dt);
    // Same prev/curr pair as views.sync above -- treadTrails reads only
    // roundStartTick off `prev`, never its tank positions (tread-trails.ts's own
    // doc comment), so it is unaffected by this loop feeding events/spawn a
    // different (possibly multi-tick) pairing than renderer.ts's per-frame call.
    treadTrails.sync(tl.worlds[Math.max(0, a - 1)], tl.worlds[a]);
    treadTrails.update(dt);
    renderer.render(scene, cam);
  }

  function dispose(): void {
    views.dispose();
    particles.dispose();
    deathPulse.dispose();
    treadTrails.dispose();
    renderer.dispose();
  }

  // `def.ticks` -- NOT `tl.worlds.length` (one longer). The runner loops `age` in
  // [0, frames), so `events[def.ticks]` is never fed; every shipped moment's `expect`
  // ticks sit well inside that range (fire@10/40, destroyed@15/20, respawn@135/180), so
  // this is a real constraint to keep in mind for a future moment, not a live bug.
  return {
    draw,
    frames: def.ticks,
    dispose,
    captureReport: {
      schemaVersion: 1,
      producer: { kind: 'moment', scenarioId: opts.moment },
      fixture: { seed: tl.worlds[0].seed },
      tickCount: def.ticks,
      observedEvents,
      fixtureAssertions,
    },
  };
}
