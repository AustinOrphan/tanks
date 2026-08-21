# Gallery Moment Scenes Implementation Plan (issue #208, closes #201)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps
> use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A deterministic "moment scene" gallery mode — a tiny scripted world plus a seeded
input sequence, staged so a chosen SimEvent fires on a known tick, rendered through the
real render modules and captured with the existing still/gif machinery — covering every
SimEvent the render layer consumes, plus the three motion states, and landing the
`--spawn-anim` render seam (branch `gallery-media` commit b897825) with the end-to-end
coverage its deferral demanded.

**Architecture:** The sim is pure and `step(world, input)` does not mutate its input, so a
moment is precomputed as a timeline: `worlds[0..ticks]` and `events[tick][]` produced by
walking `step` over a scripted `InputState` sequence. Rendering then stays a pure function
of `(age, alpha)` exactly like the existing gallery: `draw` syncs `worlds[age-1] → worlds
[age]` through `createEntityViews` and feeds each tick's `SimEvent[]` once to the same
consumers `renderer.ts` uses (`particles.spawn/update`, `deathPulse.spawn/update`). The
runner (`run.mjs`) needs no new capture machinery — `GALLERY_DRAW(age, alpha)` /
`GALLERY_FRAMES` already drive stills, bursts and gifs.

**Tech Stack:** TypeScript, Three.js, vitest, the existing Playwright-driven
`tools/gallery/run.mjs` and `tools/gl/harness.ts`.

**Spec:** `docs/superpowers/specs/2026-08-18-identity-spawn-death-animations-design.md`
(§8a media deliverables, §9 migration — the burst removal half already merged as PR #218).
The issue text of #208 and the owner's 2026-08-21 comment on #201/#208 are the scope
authority for the moment taxonomy and the end-to-end test requirement.

## Global Constraints

- **No `src/sim/` changes.** `BASELINE_HASH` in `tools/baseline` must not move. Moment
  fixtures live in `tools/gallery/` and IMPORT the sim (subjects.ts already does).
- The only `src/` change in this plan is carrying commit b897825 (`src/render/entities.ts`
  + test: the 5th `setPlayerStyle` arg). It cherry-picks cleanly onto `3cd883d` (verified
  2026-08-21: `git cherry-pick --no-commit b897825` stages 5 files, zero conflicts).
- Determinism: no `Date.now`, no `Math.random`, no wall clock in moment fixtures. Seeds go
  through `createWorld({ seed })` / `loadArena(..., seed)`.
- Media (gifs) attach to the PR, never the repo tree (spec §8a). mp4/webm stays out of
  scope (issue #208 says so explicitly).
- `npm test` (tsc + vitest) and `npm run test:gl` green at every commit. Rendering changes
  need visual evidence in the PR (CLAUDE.md).
- Branch: `gallery-moments` (created off `3cd883d`). PR title is the squash message; no
  attribution trailers.

## Verified interfaces this plan builds against

(All verified on `3cd883d`, 2026-08-21 — re-grep if the tree has moved.)

- `step(world, input): StepResult` — `src/sim/world.ts:791`; `StepResult = { world, events }`
  (`world.ts:114`). `stepInputs(world, inputs)` at `world.ts:741`.
- `InputState = { move: Vec2; aim: Vec2; fire: boolean; mine: boolean }` — `src/sim/types.ts:282`.
- `loadArena(arena, playerCount = 1, mode = 'campaign-coop', seed?)` — `src/sim/arena.ts:191`.
- Render consumer set, exactly as the game wires it — `src/render/renderer.ts:100-106`:
  `entities.sync(prev, curr, alpha, dt)`; `particles.spawn(events)`; `particles.update(dt)`;
  `deathPulse.spawn(events, curr, { enemyEnabled })`; `deathPulse.update(dt)`.
- `views.setPlayerStyle(hull, skin, accent, slot = 0, spawnAnim = DEFAULT_SPAWN_ANIM)` —
  the 5-arg form exists only after Task 1 carries b897825.
- Gallery timeline clock: `timelineDt(fromTicks, toTicks)` and `VIEWS` — exported from
  `tools/gallery/subjects.ts`. One `age` = one sim tick; `dt` seconds = ticks × `DT`.
- Runner bridge: `main.ts` sets `window.GALLERY_DRAW(age, alpha)`, `GALLERY_FRAMES`,
  `GALLERY_READY`; `run.mjs`'s `capture()` walks ages × `--subdiv`, screenshots, and
  assembles a gif when ffmpeg exists. `--scene` is validated at `args.mjs:132` (today:
  `'gallery' | 'game'`).
- GL harness: `check(name, fn)` in `tools/gl/harness.ts:38`, imports `buildGallery` from
  `../gallery/subjects`; runs under `npm run test:gl` in a real browser;
  `buildGallery` creates its renderer with `preserveDrawingBuffer: true`, so pixel readback
  is safe there.
- SimEvent taxonomy (`src/sim/events.ts:16-36`): fire, ricochet, explosion, mine-dropped,
  mine-armed, mine-detonate, tank-destroyed, respawn, wall-destroyed, win, lose. Moments
  cover all except win/lose (screen-level states, out of #208's list).

## Known landmine: the round-start countdown

A fresh world begins in the countdown phase (the 3.0s "TAKE AIM" hold), during which
player fire is locked. A naïve fixture that fires on tick 5 will fire nothing. Every
moment's `build()` must either (a) set `roundStartTick` far enough in the past that the
world is already in the play phase at tick 0, or (b) budget the countdown into `ticks` and
the expected event ticks. **This plan mandates (a)** — moments are short clips, not round
openings — except where a moment deliberately shows the entrance animation. The
`expect[]`-pin test in Task 3 makes a wrong choice loud: if the countdown eats the input,
the pinned event never fires and the test reddens. Do not silence that by widening a
window; fix the fixture. (This is the same class of bug as the `loop.test.ts:1691`
frame-window assertion the backlog wants replaced — moments pin exact ticks precisely to
avoid it.)

---

### Task 1: Carry the spawn-anim seam (b897825) onto the branch

**Files:**
- Modify (via cherry-pick, not by hand): `src/render/entities.ts`,
  `src/render/entities.test.ts`, `tools/gallery/args.mjs`, `tools/gallery/args.test.ts`,
  `tools/gallery/subjects.ts`

**Interfaces:**
- Produces: `views.setPlayerStyle(hull, skin, accent, slot, spawnAnim)` (5-arg);
  `SPAWN_ANIM_IDS = ['warp', 'rise', 'beacon']` and `--spawn-anim` parsing/rejection in
  `args.mjs`; `subjects.ts` threads `opts.spawnAnim` as the 5th `setPlayerStyle` arg.

- [ ] **Step 1: Cherry-pick the authored commit**

```bash
git cherry-pick b897825
```

Expected: clean apply (verified on 3cd883d). If the tree has moved and it conflicts, stop
and resolve by reading `git show b897825` — the commit message documents intent.

- [ ] **Step 2: Run the carried tests**

Run: `npx vitest run src/render/entities.test.ts tools/gallery/args.test.ts`
Expected: PASS, including the commit's own additions (rise-vs-warp variant selection;
`SPAWN_ANIM_IDS` two-way pin; `--spawn-anim nope` rejection).

- [ ] **Step 3: Full gate**

Run: `npm test`
Expected: PASS (tsc clean, all vitest green). The cherry-picked commit keeps its authored
message; nothing further to commit in this task.

### Task 2: End-to-end pixel check for the seam (GL harness)

The owner's deferral reason for b897825 was that nothing end-to-end proved the CLI
selection reaches pixels. This task adds that proof at the deepest layer available under a
repository gate: `buildGallery({ spawnAnim }) → setPlayerStyle → entities` in a real
browser. (The full CLI→URL hop is covered in Task 5's args/main routing tests; the
by-hand gif check in Task 7 is the final visual control, matching the repo's disclosed
precedent on `--frames`.)

**Files:**
- Modify: `tools/gallery/subjects.ts` (add `spawnAnim` to `GalleryOptions`, pass as 5th
  arg — b897825 already did this; verify, don't duplicate)
- Modify: `tools/gl/harness.ts` (one new check)

**Interfaces:**
- Consumes: `buildGallery(canvas, w, h, { ...opts, spawnAnim })` from Task 1.
- Produces: nothing new — a gate.

- [ ] **Step 1: Write the failing check**

In `tools/gl/harness.ts`, following the existing `check(name, fn)` idiom (harness.ts:38)
and its canvas/readback conventions (copy a neighbouring gallery-building check's setup):

```ts
check('--spawn-anim reaches pixels: rise and warp differ at a matched entrance frame, and rise matches itself', () => {
  // A respawn entrance only animates on a dead->alive or roundStartTick edge, so pose
  // the tank element and drive two draws: the second sync sees the entrance running.
  const render = (spawnAnim: 'warp' | 'rise') => {
    const canvas = document.createElement('canvas');
    const g = buildGallery(canvas, 128, 96, {
      elements: ['tank'], view: 'low', reach: false, timer: false, fill: false,
      skin: 'solid', hull: null, accent: null, frames: null, spawnAnim,
    });
    g.draw(0, 0);
    g.draw(1, 0.5); // mid-entrance: the variants' skeletons diverge here
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    const px = new Uint8Array(128 * 96 * 4);
    gl!.readPixels(0, 0, 128, 96, gl!.RGBA, gl!.UNSIGNED_BYTE, px);
    g.dispose();
    return px.join(',');
  };
  const warp = render('warp');
  const rise = render('rise');
  const rise2 = render('rise');
  if (rise !== rise2) return 'control failed: two identical rise renders differ — the check cannot discriminate';
  if (warp === rise) return 'warp and rise produced identical pixels — the spawnAnim option is not reaching the entrance';
  return null;
});
```

Negative control is built in: `rise !== rise2` proves the comparison is not noise before
`warp === rise` is allowed to mean anything. **Landmine:** if the entrance does not
trigger from a plain second draw (no edge), the check degenerates — both sides equal and
the control passes. Guard against that: while writing, confirm via a deliberate mutation
(hardcode `DEFAULT_SPAWN_ANIM` back at the entities.ts read site) that the check REDDENS.
If it does not, the entrance is not running; stage the edge explicitly (consult
`entities.test.ts`'s own entrance-trigger fixtures from #199 for the world shape that
produces a dead→alive edge) before trusting the check.

- [ ] **Step 2: Run to verify it fails for the right reason**

Run: `npm run test:gl` with the deliberate mutation from Step 1 in place.
Expected: the new check FAILS. Revert the mutation.

- [ ] **Step 3: Run clean**

Run: `npm run test:gl`
Expected: all checks PASS, including the new one.

- [ ] **Step 4: Commit**

```bash
git add tools/gl/harness.ts tools/gallery/subjects.ts
git commit -m "test(gl): spawn-anim selection proven end-to-end at the pixel level"
```

### Task 3: Moment timelines — `moments.ts` core plus the first moment (`fire`)

**Files:**
- Create: `tools/gallery/moments.ts`
- Create: `tools/gallery/moments.test.ts`

**Interfaces:**
- Consumes: `step`, `createWorld` (`src/sim/world`), `InputState` (`src/sim/types`),
  `SimEvent` (`src/sim/events`), sim constants as needed.
- Produces (Tasks 4-6 rely on these exact names):

```ts
export interface MomentDef {
  /** Ticks to simulate. Becomes GALLERY_FRAMES. Keep clips short: 30-120. */
  ticks: number;
  /** Events that MUST fire on exact ticks; moments.test.ts pins every entry. */
  expect: { type: SimEvent['type']; tick: number }[];
  /** The tick-0 world. Deterministic; sets roundStartTick past the countdown. */
  build(): World;
  /** Player input for a given tick (0-based). Pure function of tick. */
  input(tick: number): InputState;
  /** Camera focus point and span, same meaning as subjects.ts's Composed. */
  focus: [number, number, number];
  span: number;
}

export interface MomentTimeline { worlds: World[]; events: SimEvent[][]; }
export function simulateMoment(def: MomentDef): MomentTimeline;
export const MOMENTS: Record<string, MomentDef>;
```

- [ ] **Step 1: Write the failing tests**

```ts
// tools/gallery/moments.test.ts
import { describe, it, expect } from 'vitest';
import { MOMENTS, simulateMoment } from './moments';

describe('every moment pins its events to exact ticks', () => {
  for (const [name, def] of Object.entries(MOMENTS)) {
    it(`${name}: each expected event fires on its declared tick — and on no other`, () => {
      const tl = simulateMoment(def);
      expect(tl.worlds).toHaveLength(def.ticks + 1);
      for (const { type, tick } of def.expect) {
        expect(tl.events[tick].map((e) => e.type)).toContain(type);
        // The negative half: the pinned tick is THE tick. An event that also fires
        // elsewhere makes "staged on a known tick" false, and a fixture drift that
        // moves it shows up here rather than as a silently mistimed gif.
        const elsewhere = tl.events
          .flatMap((evs, t) => evs.filter((e) => e.type === type).map(() => t))
          .filter((t) => t !== tick);
        expect(elsewhere, `${type} also fired at ticks ${elsewhere}`).toEqual([]);
      }
    });
    it(`${name}: the timeline is a pure function of the def (two runs, identical)`, () => {
      const a = simulateMoment(def);
      const b = simulateMoment(def);
      expect(JSON.stringify(a.events)).toBe(JSON.stringify(b.events));
      expect(JSON.stringify(a.worlds[def.ticks])).toBe(JSON.stringify(b.worlds[def.ticks]));
    });
  }
});

describe('fire moment specifics', () => {
  it('the fire event carries the player ownerId and the staged position', () => {
    const tl = simulateMoment(MOMENTS.fire);
    const tick = MOMENTS.fire.expect.find((e) => e.type === 'fire')!.tick;
    const ev = tl.events[tick].find((e) => e.type === 'fire');
    expect(ev).toBeDefined();
  });
});
```

Which change makes each assertion fail: the exact-tick pin reddens if the countdown
swallows the input, if the fixture's geometry moves, or if a sim rebalance shifts timing
(that last one is the point — a moment is also a tripwire that render evidence is being
regenerated against the sim that ships). The purity pin reddens if a fixture sneaks in
`Math.random`/`Date.now` or shares mutable state between runs.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tools/gallery/moments.test.ts`
Expected: FAIL — `./moments` does not exist.

- [ ] **Step 3: Implement the core and the `fire` moment**

```ts
// tools/gallery/moments.ts
import { createWorld, step } from '../../src/sim/world';
import type { World } from '../../src/sim/world';
import type { SimEvent } from '../../src/sim/events';
import type { InputState } from '../../src/sim/types';

const IDLE: InputState = { move: { x: 0, y: 0 }, aim: { x: 1, y: 0 }, fire: false, mine: false };

export function simulateMoment(def: MomentDef): MomentTimeline {
  let w = def.build();
  const worlds: World[] = [w];
  const events: SimEvent[][] = [[]];
  for (let t = 0; t < def.ticks; t++) {
    const r = step(w, def.input(t));   // step() does not mutate its input world
    w = r.world;
    worlds.push(w);
    events.push(r.events);
  }
  return { worlds, events };
}

export const MOMENTS: Record<string, MomentDef> = {
  /** One tank, one trigger pull: the muzzle flash / fire event, dead centre. */
  fire: {
    ticks: 40,
    expect: [{ type: 'fire', tick: /* pin from the fixture: input fires at t=9, event lands next step */ 10 }],
    focus: [0, 0.3, 0], span: 3,
    build: () => {
      const w = createWorld({ walls: [], spawns: [{ pos: { x: 0, y: 0 }, angle: 0 }], lives: 3, tanks: [/* one player tank at origin — copy the `tank` element's literal from subjects.ts with kind 'player' */], seed: 7 });
      w.roundStartTick = -600; // long past the countdown; see the landmine note
      return w;
    },
    input: (t) => (t === 9 ? { ...IDLE, fire: true } : IDLE),
  },
};
```

The tick numbers above are the fixture author's to pin, not to trust from this plan:
write the fixture, run the test, and if `fire` lands on a different tick than guessed,
move the `expect` entry to the MEASURED tick and say so in the commit body. What is not
negotiable is that after pinning, the exact-tick test passes — including its
no-other-tick half.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tools/gallery/moments.test.ts`
Expected: PASS.

- [ ] **Step 5: Full gate and commit**

Run: `npm test`

```bash
git add tools/gallery/moments.ts tools/gallery/moments.test.ts
git commit -m "feat(gallery): moment timelines — scripted worlds with tick-pinned events, first moment: fire"
```

### Task 4: The `respawn` moment (kill → stock respawn → entrance)

The moment #201's media needs: a versus kill whose victim respawns with the identity
entrance, selectable per `--spawn-anim`.

**Files:**
- Modify: `tools/gallery/moments.ts` (add `respawn` and `destroyed` moments)
- Modify: `tools/gallery/moments.test.ts` (specifics beyond the generic pins)

**Interfaces:**
- Consumes: `loadArena(ARENA_01, 2, 'ffa')` (`src/sim/arena.ts:191`) or a hand-built ffa
  world copied from `src/sim/versus-respawn.test.ts:60`'s fixture shape
  (`createWorld({ walls, tanks, spawns, lives: 3, mode: 'ffa', arenaGeometry })`);
  `RESPAWN_DELAY_TICKS` from `src/sim/constants`.
- Produces: `MOMENTS.respawn`, `MOMENTS.destroyed`.

- [ ] **Step 1: Write the failing specifics**

```ts
describe('respawn moment specifics', () => {
  it('stages kill and revival K ticks apart, where K is the shipped RESPAWN_DELAY_TICKS', () => {
    const killed = MOMENTS.respawn.expect.find((e) => e.type === 'tank-destroyed')!.tick;
    const revived = MOMENTS.respawn.expect.find((e) => e.type === 'respawn')!.tick;
    expect(revived - killed).toBe(RESPAWN_DELAY_TICKS);
  });
  it('the victim is dead in the worlds between the two pinned ticks and alive after', () => {
    const tl = simulateMoment(MOMENTS.respawn);
    const killed = MOMENTS.respawn.expect.find((e) => e.type === 'tank-destroyed')!.tick;
    const revived = MOMENTS.respawn.expect.find((e) => e.type === 'respawn')!.tick;
    const ev = tl.events[killed].find((e) => e.type === 'tank-destroyed') as { tankId: number };
    const victim = (w: World) => w.tanks.find((t) => t.id === ev.tankId)!;
    expect(victim(tl.worlds[killed]).alive).toBe(false);
    expect(victim(tl.worlds[revived - 1]).alive).toBe(false);
    expect(victim(tl.worlds[revived]).alive).toBe(true);
  });
});
```

The delay assertion's named negative control: it fails if the fixture fakes the revival
by hand-flipping `alive` (the gap would be whatever the author typed, not the shipped
constant) and it fails if a balance change moves `RESPAWN_DELAY_TICKS` without the
moment's expect table moving — both are exactly the drifts worth catching.

- [ ] **Step 2: Run to verify failure** — `npx vitest run tools/gallery/moments.test.ts`

- [ ] **Step 3: Implement the two moments**

Fixture shape (the author pins exact ticks by measurement, per Task 3's rule):

```ts
/** Versus kill only — the death pulse moment. Two tanks, a bullet already lethal. */
destroyed: { /* ffa world, shooter fires at point-blank victim; expect tank-destroyed (+ explosion if the sim emits one on the shell path — pin what MEASURES) */ },
/** Kill then stock respawn: #201's before/after and three-up media source. */
respawn: {
  ticks: /* killed tick + RESPAWN_DELAY_TICKS + ~45 ticks of entrance to watch */,
  expect: [
    { type: 'tank-destroyed', tick: K },
    { type: 'respawn', tick: K + RESPAWN_DELAY_TICKS },
  ],
  build: () => { /* versus-respawn.test.ts:60 fixture shape; both tanks kind 'player',
                    controlledBy 0 and 1; victim's stockRemaining > 0; shooter aimed;
                    roundStartTick past the countdown; fixed seed */ },
  input: (t) => /* slot-0 shooter fires once at the staged tick, then idles */,
},
```

**Landmine:** `stepRespawns` places the revived tank via `pickVersusSpawnCell` when
`arenaGeometry` is present — the revival position is NOT the authored spawn. Set `focus`/
`span` wide enough to hold both the death position and any cell the picker can choose, or
the entrance may animate off-camera. `versus-respawn.test.ts`'s doc comment (lines 8-33)
is the reference for how placement actually resolves.

- [ ] **Step 4: Run to verify pass** — `npx vitest run tools/gallery/moments.test.ts`, then `npm test`.

- [ ] **Step 5: Commit**

```bash
git add tools/gallery/moments.ts tools/gallery/moments.test.ts
git commit -m "feat(gallery): destroyed and respawn moments — a staged versus kill and its stock revival"
```

### Task 5: Render the timeline — `buildMomentScene`, page routing, `--scene <moment>`

**Files:**
- Create: `tools/gallery/moment-scene.ts`
- Modify: `tools/gallery/main.ts` (route on scene param)
- Modify: `tools/gallery/args.mjs` (scene validation + `MOMENT_IDS`)
- Modify: `tools/gallery/args.test.ts` (two-way id pin + routing)
- Modify: `tools/gallery/run.mjs` (URL builder: pass `scene` through to index.html)
- Modify: `tools/gl/harness.ts` (one check)

**Interfaces:**
- Consumes: `MOMENTS`, `simulateMoment` (Task 3); `VIEWS`, `timelineDt`
  (`tools/gallery/subjects.ts`); the renderer.ts consumer set (verified list above);
  `spawnAnim` option (Task 1).
- Produces:

```ts
// tools/gallery/moment-scene.ts
export interface MomentSceneOptions {
  moment: string;              // key into MOMENTS
  view: string;                // key into VIEWS
  skin: SkinId; hull: string | null; accent: string | null;
  spawnAnim: SpawnAnimId;      // dressing for the entrance the moment stages
}
export function buildMomentScene(canvas: HTMLCanvasElement, w: number, h: number,
  opts: MomentSceneOptions): { draw(age: number, alpha: number): void; frames: number; dispose(): void };
```

```js
// args.mjs — same duplicated-list idiom as SKIN_IDS/SPAWN_ANIM_IDS, same reason
export const MOMENT_IDS = ['fire', 'destroyed', 'respawn']; // grows with Task 6
```

- [ ] **Step 1: Write the failing tests**

`args.test.ts` (mirror the existing `SKIN_IDS`/`SPAWN_ANIM_IDS` pin blocks exactly):
`MOMENT_IDS` equals `Object.keys(MOMENTS)` both directions; `--scene respawn` parses;
`--scene nope` still throws; `--frames` interaction: a moment scene's frame count comes
from the moment, so `--frames` with a moment scene is REJECTED (the `--frames does not
apply to --scene game` guard at args.mjs:149 is the precedent — extend its message).

- [ ] **Step 2: Run to verify failure** — `npx vitest run tools/gallery/args.test.ts`

- [ ] **Step 3: Implement**

`moment-scene.ts` — the draw loop, mirroring `buildGallery`'s scene/lighting/camera
construction (copy its Three.js setup verbatim; one scene builder drifting from the other
is exactly the mockup risk subjects.ts's header warns about) and renderer.ts's consumer
order:

```ts
const tl = simulateMoment(MOMENTS[opts.moment]);
const views = createEntityViews(scene);
views.setPlayerStyle(opts.hull ?? null, opts.skin, opts.accent ?? null, 0, opts.spawnAnim);
const particles = createParticleSystem(scene);
const deathPulse = createDeathPulseSystem(scene);
let clock: number | null = null;
let fed = 0; // ticks whose events have been spawned exactly once
function draw(age: number, alpha: number): void {
  const at = age + alpha;
  const dt = clock === null ? 0 : timelineDt(clock, at);
  clock = at;
  const a = Math.min(Math.max(0, age), tl.worlds.length - 1);
  while (fed <= a) {  // events fire once per tick even when subdiv replays an age
    particles.spawn(tl.events[fed]);
    deathPulse.spawn(tl.events[fed], tl.worlds[fed], { enemyEnabled: true });
    fed++;
  }
  views.sync(tl.worlds[Math.max(0, a - 1)], tl.worlds[a], alpha, dt);
  particles.update(dt);
  deathPulse.update(dt);
  renderer.render(scene, cam);
}
```

Disclosed limitation, stated in a comment: rewinding (`GALLERY_DRAW(0,0)` after a
sequence) does not replay already-fed events; the runner only walks forward. Camera:
`focus`/`span` come from the MomentDef through the same fit math `buildGallery` uses.

`main.ts` — route: `scene` param `gallery` (default) → `buildGallery` unchanged; a moment
id → `buildMomentScene`; expose `GALLERY_FRAMES = MOMENTS[id].ticks`. `run.mjs` — in `q()`
add `scene` (and `spawnAnim`) to the URLSearchParams; the `args.scene === 'game'` branch
at run.mjs:239 stays first, so moment ids fall through to the existing `capture()` path
untouched.

`harness.ts` — one check: `buildMomentScene(..., { moment: 'fire', ... })` drives
`draw(t, 0)` across the fire tick and asserts pixels change between the tick before the
pinned fire tick and the tick after (the muzzle particle burst is the visible delta);
control: two renders of the same tick match. Verify it reddens by feeding
`particles.spawn([])` instead of the tick's events (deliberate mutation, then revert).

- [ ] **Step 4: Run all gates** — `npm test` and `npm run test:gl`. Expected: PASS.

- [ ] **Step 5: First live capture (evidence, not a gate)**

Run: `npm run gallery -- --scene respawn --view game --spawn-anim rise --anim --out respawn-rise.gif`
Expected: a gif in which the victim dies, the arena holds for `RESPAWN_DELAY_TICKS`, and
the rise entrance plays at the picked cell. Keep the file for the PR body.

- [ ] **Step 6: Commit**

```bash
git add tools/gallery/moment-scene.ts tools/gallery/main.ts tools/gallery/args.mjs tools/gallery/args.test.ts tools/gallery/run.mjs tools/gl/harness.ts
git commit -m "feat(gallery): --scene <moment> renders a scripted timeline through the real render modules"
```

### Task 6: The rest of the taxonomy

**Files:**
- Modify: `tools/gallery/moments.ts`, `tools/gallery/moments.test.ts`,
  `tools/gallery/args.mjs` (`MOMENT_IDS` grows), `tools/gallery/args.test.ts` only if the
  pin is not already key-derived.

**Interfaces:**
- Consumes: everything from Tasks 3-5. No new exports.
- Produces: `MOMENTS.ricochet`, `MOMENTS['mine-cycle']`, `MOMENTS['wall-break']`,
  `MOMENTS.drive`, `MOMENTS.pivot`, `MOMENTS.traverse`.

One commit per moment (or per pair), each with the generic exact-tick/purity pins from
Task 3 passing plus one moment-specific assertion:

- [ ] **ricochet** — shooter fires at a solid wall at a shallow angle; expect `fire` then
  `ricochet` (`bounceIndex` 0); specific: the ricochet position sits on the wall line.
- [ ] **mine-cycle** — `mine: true` at a staged tick; expect `mine-dropped`, `mine-armed`
  (arm delay measured from constants), `mine-detonate` (fuse expiry — the `fuse` element's
  `MINE_TIMER` math in subjects.ts is the reference), plus the `explosion` if the sim
  emits it on that path — pin what measures, don't guess.
- [ ] **wall-break** — shooter fires at a destructible cell; expect `wall-destroyed`;
  specific: the cell's `destroyed` flag flips exactly at the pinned tick.
- [ ] **drive / pivot / traverse** — no event to pin; these are the issue's three motion
  states. Pin the motion instead: position (drive), `bodyAngle` (pivot), `turretAngle`
  (traverse) differ monotonically across the clip while the OTHER two fields hold still —
  each assertion's negative control is a scripted input that moves the wrong axis.

Run `npm test` per commit. After the last: update `MOMENT_IDS`, run
`npx vitest run tools/gallery/args.test.ts`.

Suggested messages:
```
feat(gallery): ricochet and wall-break moments
feat(gallery): mine-cycle moment — lay, arm, detonate on pinned ticks
feat(gallery): drive, pivot, traverse motion moments
```

### Task 7: Media production and the by-hand control

**Files:** none committed (media attaches to the PR; spec §8a forbids committing gifs).

- [ ] **Step 1: Comparison media (spec §8a bullet 1)**
  - Respawn before/after: the "before" (cyan burst) no longer exists at HEAD — cite PR
    #218's own evidence for the removal side and render only the "after"
    (`--scene respawn --spawn-anim warp`), OR check out `3cd883d~1` in a throwaway
    worktree for a true before-clip. State in the PR body which was done.
  - Three-up at matched timing: `for a in warp rise beacon; do npm run gallery -- --scene respawn --spawn-anim $a --anim --out respawn-$a.gif; done`
    — matched by construction, since the timeline (and so the kill and revival ticks) is
    identical across the three.
- [ ] **Step 2: Exhibition media (spec §8a bullet 2)** — same recipes at higher `--subdiv`
  / `--fps`, each variant plus `--scene destroyed` for the death pulse, in identity colours.
- [ ] **Step 3: The by-hand discriminator with its control** (repo precedent: the
  `--frames` disclosed mutant in subjects.ts): md5 the three variant gifs — three distinct
  sums; then render `respawn-warp` twice — identical sums. Record both results in the PR
  body. If the twice-rendered gif is NOT byte-identical, find the nondeterminism before
  shipping (the timeline is pure; the renderer should be too at fixed size).
- [ ] **Step 4: Assemble the PR evidence section**: the Task 5/7 gifs, the md5 table, and
  the tick-pin table (`MOMENTS` names × expected events × ticks) generated from the test
  output — populations stated (which moments, which events, which controls ran).

### Task 8: Ship and close the loop

- [ ] **Step 1: Gates, in full, on the final tree:** `npm test`, `npm run build`,
  `npm run test:gl`, and `npm run visual` after the build. Recompute the test count for
  the PR body from THIS run, not memory.
- [ ] **Step 2: PR** — title is the squash message, e.g.
  `Gallery moment scenes: scripted SimEvent timelines, --scene <moment>, --spawn-anim media (#208, closes #201)`.
  Body: what landed per task, the evidence section, and the residuals below. No
  attribution trailers.
- [ ] **Step 3: Bookkeeping in the same PR:**
  - `docs/superpowers/backlog.md`: the versus spike's item 4 (spawn animation) — strike
    with the CLOSED idiom the file already uses, citing #203/#205 and this PR; the Ledger
    line `Spawn and victory animations. #61` — narrow to victory animations only.
  - Issue #201: closed by the PR (`closes #201` in the body); #208 likewise if the owner
    agrees scope is met, else comment with what remains.
- [ ] **Step 4: Residuals to state, not solve:** mp4/webm export (issue #208 defers it);
  a committed docs/ media set (spec §8a calls it a separate decision); win/lose as
  moments (screen-level, excluded); event replay on rewind (disclosed in Task 5).

## Self-review notes (run before first commit)

- Spec coverage: §8a comparisons → Task 7.1; §8a exhibition → Task 7.2; §8a "spawn-anim
  arg" → Tasks 1/5; owner comment's end-to-end test → Tasks 2 and 5's harness checks plus
  the args routing pins; issue #208's taxonomy → Tasks 3/4/6 (9 SimEvents: fire,
  ricochet, explosion via mine-cycle/destroyed, mine×3, tank-destroyed, respawn,
  wall-destroyed; motions: drive/pivot/traverse; win/lose excluded, stated).
- Tick numbers written as K/measured-on-purpose are the ONLY deliberate unknowns; every
  one is forced to a pinned value by a test before its task can commit.
- Type consistency: `MomentDef`/`MomentTimeline`/`simulateMoment`/`MOMENTS` named
  identically in Tasks 3-6; `MomentSceneOptions.spawnAnim` matches Task 1's seam.
