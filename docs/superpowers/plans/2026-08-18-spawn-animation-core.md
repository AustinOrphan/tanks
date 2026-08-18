# Spawn Animation Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an identity-coloured spawn animation — an entrance plus a shield-driven invincibility overlay, in three interchangeable variants behind a registry — closing **issue #199**.

**Architecture:** Pure render-layer projection. A per-tank animation state lives on the tank view in `src/render/entities.ts` and is advanced by the render animation clock (`dt`). Each variant is a **pure function** of `(phase, progress, identityColor)` in a new `src/render/spawn-anim.ts`, selected from a registry that mirrors the skins system's data/impl split. The animation is *triggered* by edges in the `prev`/`curr` world diff `syncTanks` already computes and *reads* `Tank.shieldUntilTick` live for the invincibility overlay — so no `SimEvent` is widened and nothing under `src/sim/` changes.

**Tech Stack:** TypeScript, Three.js, Vitest. Design spec: `docs/superpowers/specs/2026-08-18-identity-spawn-death-animations-design.md`.

## Global Constraints

- **No `src/sim/` changes.** This is render-only. `BASELINE_HASH` (`tools/baseline/trace.test.ts`) MUST be unchanged — verify and state it in the PR.
- **The `respawn` / `tank-destroyed` SimEvents are NOT widened** — colour and duration are resolved render-side from the world diff.
- **Registry mirrors skins exactly:** data (`SpawnAnimId`, `SPAWN_ANIMATIONS`) in `src/game/customization.ts` (no `three` import); implementations in `src/render/spawn-anim.ts`.
- **Warp is the live default**; Rise and Beacon must be reachable (unit-tested + gallery-renderable) so none is dead code. No picker UI in this plan.
- **Testing bar:** prove the gap before writing a test (apply the mutation, watch it pass, then write the test, then watch it fail). Every new assertion names the production change that breaks it. `npm test` = `tsc --noEmit && vitest run`.
- **Commit rules:** no `Co-Authored-By` / tool trailers; refer to decisions impersonally.

---

### Task 1: The spawn-animation data registry

Mirror the `SkinId` / `SkinDef` / `SKINS` pattern (`src/game/customization.ts:63-94`). Data only — no `three`.

**Files:**
- Modify: `src/game/customization.ts` (add after the `SKINS` / `DEFAULT_SKIN` block, ~line 94)
- Test: `src/game/customization.test.ts`

**Interfaces:**
- Produces: `type SpawnAnimId = 'warp' | 'rise' | 'beacon'`; `interface SpawnAnimDef { id: SpawnAnimId; label: string }`; `const SPAWN_ANIMATIONS: readonly SpawnAnimDef[]`; `const DEFAULT_SPAWN_ANIM: SpawnAnimId = 'warp'`.

- [ ] **Step 1: Write the failing test**

```ts
// src/game/customization.test.ts — add to the existing suite
import { SPAWN_ANIMATIONS, DEFAULT_SPAWN_ANIM, type SpawnAnimId } from './customization';

describe('SPAWN_ANIMATIONS', () => {
  it('is a frozen list with unique ids and warp first', () => {
    expect(Object.isFrozen(SPAWN_ANIMATIONS)).toBe(true);
    const ids = SPAWN_ANIMATIONS.map((v) => v.id);
    expect(ids).toEqual(['warp', 'rise', 'beacon']);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it('DEFAULT_SPAWN_ANIM is warp and is present in the list', () => {
    expect(DEFAULT_SPAWN_ANIM).toBe<SpawnAnimId>('warp');
    expect(SPAWN_ANIMATIONS.some((v) => v.id === DEFAULT_SPAWN_ANIM)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/game/customization.test.ts`
Expected: FAIL — `SPAWN_ANIMATIONS` is not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/game/customization.ts — after DEFAULT_SKIN
export type SpawnAnimId = 'warp' | 'rise' | 'beacon';

export interface SpawnAnimDef {
  id: SpawnAnimId;
  label: string;
}

/** First entry is the default. Implementations live in render/spawn-anim.ts (they need THREE). */
export const SPAWN_ANIMATIONS: readonly SpawnAnimDef[] = Object.freeze([
  { id: 'warp', label: 'Warp' },
  { id: 'rise', label: 'Rise' },
  { id: 'beacon', label: 'Beacon' },
]);

export const DEFAULT_SPAWN_ANIM: SpawnAnimId = 'warp';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/game/customization.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/game/customization.ts src/game/customization.test.ts
git commit -m "Spawn-anim registry: SpawnAnimId + SPAWN_ANIMATIONS data (mirrors skins)"
```

---

### Task 2: Animator contract, ring helper, and the Warp animator

The pure-function core. Each animator maps a phase and a normalized progress to a frame the renderer applies. `makeSpawnRing` mirrors `makeIdentityRing` (`src/render/entities.ts:142-158`).

**Files:**
- Create: `src/render/spawn-anim.ts`
- Test: `src/render/spawn-anim.test.ts`

**Interfaces:**
- Consumes: `SpawnAnimId` (Task 1).
- Produces:
  - `type SpawnPhase = 'entrance' | 'invincible'`
  - `interface SpawnFrame { tankOpacity: number; tankScale: number; ring: { radius: number; opacity: number; arc: number } }` — `arc` is the fraction of the ring drawn (1 = full circle), for Beacon's depleting timer.
  - `type SpawnAnimator = (phase: SpawnPhase, progress: number, color: number) => SpawnFrame` — `progress` is clamped to `[0,1]`.
  - `const SPAWN_ANIMATORS: Record<SpawnAnimId, SpawnAnimator>`
  - `function makeSpawnRing(color: number): THREE.Mesh`
  - `const ENTRANCE_SECONDS = 0.5`

- [ ] **Step 1: Write the failing test (Warp only)**

```ts
// src/render/spawn-anim.test.ts
import { describe, it, expect } from 'vitest';
import { SPAWN_ANIMATORS, ENTRANCE_SECONDS } from './spawn-anim';

const warp = SPAWN_ANIMATORS.warp;
const C = 0x3fd0ff;

describe('warp animator', () => {
  it('entrance: fades and scales the tank in, ring expands', () => {
    const a = warp('entrance', 0, C);
    const b = warp('entrance', 1, C);
    // Mutation that breaks this: an animator that returns a constant frame.
    expect(a.tankOpacity).toBeLessThan(b.tankOpacity);
    expect(a.tankScale).toBeLessThan(b.tankScale);
    expect(a.ring.radius).toBeLessThan(b.ring.radius);
    expect(b.tankOpacity).toBeCloseTo(1, 5); // fully solid by end of entrance
    expect(b.tankScale).toBeCloseTo(1, 5);
  });
  it('invincible: tank is translucent at the start and solidifies to opaque', () => {
    // progress here is 0=just shielded, 1=shield about to end.
    const start = warp('invincible', 0, C);
    const end = warp('invincible', 1, C);
    // Mutation that breaks this: dropping the invincibility branch (returns entrance frame).
    expect(start.tankOpacity).toBeLessThan(1);
    expect(end.tankOpacity).toBeCloseTo(1, 5);
    expect(start.tankOpacity).toBeLessThan(end.tankOpacity);
  });
  it('clamps progress outside [0,1] (negative control: no NaN, no >1 opacity)', () => {
    for (const p of [-1, 2]) {
      const f = warp('entrance', p, C);
      expect(f.tankOpacity).toBeGreaterThanOrEqual(0);
      expect(f.tankOpacity).toBeLessThanOrEqual(1);
    }
  });
  it('ENTRANCE_SECONDS is a positive, finite duration', () => {
    expect(ENTRANCE_SECONDS).toBeGreaterThan(0);
    expect(Number.isFinite(ENTRANCE_SECONDS)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/render/spawn-anim.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/render/spawn-anim.ts
import * as THREE from 'three';
import type { SpawnAnimId } from '../game/customization';

export type SpawnPhase = 'entrance' | 'invincible';

export interface SpawnFrame {
  tankOpacity: number;
  tankScale: number;
  ring: { radius: number; opacity: number; arc: number };
}

export type SpawnAnimator = (phase: SpawnPhase, progress: number, color: number) => SpawnFrame;

/** Fixed entrance length, in seconds of render wall-clock. Round start and respawn share it. */
export const ENTRANCE_SECONDS = 0.5;

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

// Ring geometry the animators drive by scaling; base radius is 1 world unit so a frame's
// `ring.radius` is a direct world-space radius.
const RING_BASE_R = 1;
const RING_WIDTH = 0.12;
const RING_Y = 0.06;
const RING_SEGMENTS = 48;

/** A flat additive ring, same family as entities.ts's makeIdentityRing. */
export function makeSpawnRing(color: number): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.RingGeometry(RING_BASE_R - RING_WIDTH, RING_BASE_R, RING_SEGMENTS),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 1,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  mesh.name = 'spawn-ring';
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = RING_Y;
  return mesh;
}

const warp: SpawnAnimator = (phase, progress) => {
  const p = clamp01(progress);
  if (phase === 'entrance') {
    return {
      tankOpacity: p,
      tankScale: 0.6 + 0.4 * p,
      ring: { radius: 0.4 + 1.6 * p, opacity: 1 - p, arc: 1 },
    };
  }
  // invincible: translucent, solidifying as the shield runs out (p: 0 fresh -> 1 ending).
  return {
    tankOpacity: 0.45 + 0.55 * p,
    tankScale: 1,
    ring: { radius: 1, opacity: 0.35 * (1 - p), arc: 1 },
  };
};

// Rise and Beacon are implemented in Tasks 3 and 4; aliased to warp here so the typed
// Record is complete and compiles. Each is replaced by its own function next.
export const SPAWN_ANIMATORS: Record<SpawnAnimId, SpawnAnimator> = {
  warp,
  rise: warp,
  beacon: warp,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/render/spawn-anim.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/render/spawn-anim.ts src/render/spawn-anim.test.ts
git commit -m "Spawn-anim: animator contract, spawn-ring helper, Warp variant"
```

---

### Task 3: The Rise animator

Tank scales up from the ground; the ring pulses. Invincibility shown by translucency, with the ring pulse-rate rising as time runs out.

**Files:**
- Modify: `src/render/spawn-anim.ts`
- Test: `src/render/spawn-anim.test.ts`

**Interfaces:**
- Produces: replaces `rise` in `SPAWN_ANIMATORS` with a distinct function.

- [ ] **Step 1: Write the failing test**

```ts
// src/render/spawn-anim.test.ts — add
const rise = SPAWN_ANIMATORS.rise;

describe('rise animator', () => {
  it('entrance: scales up from near-zero (distinct from warp, which starts at 0.6)', () => {
    const a = rise('entrance', 0, 0x3fd0ff);
    const b = rise('entrance', 1, 0x3fd0ff);
    // Mutation that breaks this: rise === warp (its start scale would be 0.6, not < 0.2).
    expect(a.tankScale).toBeLessThan(0.2);
    expect(b.tankScale).toBeCloseTo(1, 5);
    expect(a.tankScale).toBeLessThan(b.tankScale);
  });
  it('invincible: ring opacity oscillates (pulse), unlike warp\'s monotone fade', () => {
    const samples = [0, 0.25, 0.5, 0.75, 1].map((p) => rise('invincible', p, 0x3fd0ff).ring.opacity);
    // A pulse is non-monotone: at least one sample rises after falling (or vice versa).
    // Mutation that breaks this: a monotone ring opacity (rise aliased to warp).
    const monotone = samples.every((v, i) => i === 0 || v <= samples[i - 1])
      || samples.every((v, i) => i === 0 || v >= samples[i - 1]);
    expect(monotone).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/render/spawn-anim.test.ts -t rise`
Expected: FAIL — `rise` is still aliased to `warp`.

- [ ] **Step 3: Write the implementation**

```ts
// src/render/spawn-anim.ts — replace the `rise: warp` entry, add above SPAWN_ANIMATORS:
const rise: SpawnAnimator = (phase, progress) => {
  const p = clamp01(progress);
  if (phase === 'entrance') {
    return {
      tankOpacity: clamp01(p * 1.4),
      tankScale: p, // grows from 0
      ring: { radius: 0.9 + 0.3 * Math.sin(p * Math.PI), opacity: 0.6 * (1 - p), arc: 1 },
    };
  }
  // pulse faster as the shield ends: frequency rises with p.
  const pulse = 0.5 + 0.5 * Math.sin(p * Math.PI * (4 + 6 * p));
  return {
    tankOpacity: 0.45 + 0.55 * p,
    tankScale: 1,
    ring: { radius: 1, opacity: 0.3 * pulse, arc: 1 },
  };
};
```

Update the Record: `rise,` (remove the `rise: warp` alias).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/render/spawn-anim.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/render/spawn-anim.ts src/render/spawn-anim.test.ts
git commit -m "Spawn-anim: Rise variant (scale-up entrance, pulsing invincibility ring)"
```

---

### Task 4: The Beacon animator (ring-as-timer, opaque tank)

The "if translucency doesn't read well" path. Tank materializes opaque; a ring ARC depletes over the shield window.

**Files:**
- Modify: `src/render/spawn-anim.ts`
- Test: `src/render/spawn-anim.test.ts`

**Interfaces:**
- Produces: replaces `beacon` in `SPAWN_ANIMATORS`.

- [ ] **Step 1: Write the failing test**

```ts
// src/render/spawn-anim.test.ts — add
const beacon = SPAWN_ANIMATORS.beacon;

describe('beacon animator', () => {
  it('invincible: tank stays opaque; ring ARC depletes from full to empty', () => {
    const start = beacon('invincible', 0, 0x3fd0ff);
    const end = beacon('invincible', 1, 0x3fd0ff);
    // Mutations that break this: beacon aliased to warp (start opacity would be 0.45,
    // and arc would be constant 1 the whole time).
    expect(start.tankOpacity).toBeCloseTo(1, 5);
    expect(end.tankOpacity).toBeCloseTo(1, 5);
    expect(start.ring.arc).toBeCloseTo(1, 5);
    expect(end.ring.arc).toBeCloseTo(0, 5);
    expect(end.ring.arc).toBeLessThan(start.ring.arc);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/render/spawn-anim.test.ts -t beacon`
Expected: FAIL — `beacon` is aliased to `warp` (opaque check passes at end but `arc` stays 1).

- [ ] **Step 3: Write the implementation**

```ts
// src/render/spawn-anim.ts — replace the `beacon: warp` entry:
const beacon: SpawnAnimator = (phase, progress) => {
  const p = clamp01(progress);
  if (phase === 'entrance') {
    return {
      tankOpacity: clamp01(p * 1.6), // materializes to opaque quickly
      tankScale: 1,
      ring: { radius: 0.5 + 1.2 * p, opacity: 1 - p, arc: 1 },
    };
  }
  // Opaque tank; the ring is the timer — its arc depletes as the shield runs out.
  return {
    tankOpacity: 1,
    tankScale: 1,
    ring: { radius: 1, opacity: 0.9, arc: 1 - p },
  };
};
```

Update the Record: `beacon,`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/render/spawn-anim.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/render/spawn-anim.ts src/render/spawn-anim.test.ts
git commit -m "Spawn-anim: Beacon variant (opaque tank, depleting ring-as-timer)"
```

---

### Task 5: Wire the animation into the tank view

Detect the entrance edge from the world diff, read `shieldUntilTick` live for the invincibility overlay, advance a per-view clock on `dt`, and apply the frame (tank material opacity + ring). This is the one task that touches the large `entities.ts`; keep it to the sites named here.

**Files:**
- Modify: `src/render/entities.ts` — the `tankViews` map type (`:433-436`), `syncTanks` (`:1153`), and the `sync` call site that invokes `syncTanks` (search for `syncTanks(`).
- Test: `src/render/entities.test.ts`

**Interfaces:**
- Consumes: `SPAWN_ANIMATORS`, `makeSpawnRing`, `ENTRANCE_SECONDS`, `SpawnPhase` (Tasks 2-4); `DEFAULT_SPAWN_ANIM` (Task 1); `Tank.shieldUntilTick`, `World.tick`, `World.roundStartTick` (sim, read-only).
- Produces: per-view field `spawn: { variant: SpawnAnimId; elapsed: number; ring: THREE.Mesh } | null`.

- [ ] **Step 1: Verify the `roundStartTick` semantics that the trigger relies on**

Run: `grep -n "roundStartTick" src/sim/world.ts`
Confirm whether an individual versus respawn (`stepRespawns`) assigns `roundStartTick`, or only a full `resetArena` does. Expected finding (verify, do not assume): `resetArena` moves it (campaign round restart), per-tank `stepRespawns` does not (versus). If that holds, the entrance trigger is: **dead→alive edge OR `roundStartTick` changed**, de-duplicated so a campaign round-restart (both true at once) fires once. Record the finding in the commit body.

- [ ] **Step 2: Write the failing test**

```ts
// src/render/entities.test.ts — model on the existing setPlayerStyle / makeWorld helpers.
// A respawn: tank dead in prev, alive in curr, with a shield set.
import { RESPAWN_SHIELD_TICKS } from '../sim/constants';

it('starts a spawn entrance and adds a spawn ring on the dead->alive edge', () => {
  const views = createEntityViews(scene);
  const prev = makeWorld([{ ...makeTank(1, 'player', { x: 5, y: 5 }, 0), alive: false }]);
  const curr = makeWorld([{ ...makeTank(1, 'player', { x: 5, y: 5 }, 0), alive: true }]);
  views.sync(prev, curr, 1, 0.016);
  // Mutation that breaks this: never creating the ring on the respawn edge.
  const ring = findByName(scene, 'spawn-ring');
  expect(ring).toBeTruthy();
});

it('drives the invincibility overlay from shieldUntilTick, not a latched copy', () => {
  const views = createEntityViews(scene);
  const tank = { ...makeTank(1, 'player', { x: 5, y: 5 }, 0), alive: true,
    shieldUntilTick: 90 };
  const w0 = makeWorld([tank]); w0.tick = 10;   // 80 ticks of shield left
  const w1 = makeWorld([tank]); w1.tick = 89;   // 1 tick left -> nearly solid
  const bodyMat = () => (tankBodyMaterial(scene, 1)); // helper: the tank's body material
  views.sync(w0, w0, 1, 0.016);
  const early = bodyMat().opacity;
  views.sync(w1, w1, 1, 0.016);
  const late = bodyMat().opacity;
  // Mutation that breaks this: reading a fixed duration instead of shieldUntilTick - tick.
  expect(late).toBeGreaterThan(early);
});
```

Add small test helpers if the file lacks them: `findByName(scene, name)` (traverse for `obj.name === name`) and `tankBodyMaterial(scene, id)` (locate the tank group's body mesh material). Model on `activeMeshes`/scene-traversal helpers already in `entities.test.ts` / `particles.test.ts`.

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/render/entities.test.ts -t spawn`
Expected: FAIL — no spawn ring, opacity constant.

- [ ] **Step 4: Extend the view type and thread `dt` into `syncTanks`**

```ts
// entities.ts:433 — add the field to the tankViews value type:
//   spawn: { variant: SpawnAnimId; elapsed: number; ring: THREE.Mesh } | null
// Initialize `spawn: null` wherever a view is created (the `view = { ...makeTank(...) }`
// line at ~1173).
// Change syncTanks' signature to accept dt, and pass it from the sync() call site:
//   function syncTanks(prev, curr, alpha, snap, multiPlayer, dt: number)
```

- [ ] **Step 5: Write the trigger + apply logic in `syncTanks`**

Inside the `for (const t of curr.tanks)` loop, after the view exists and pose is set:

```ts
// entities.ts — inside syncTanks, per player-kind tank (guard on t.kind === 'player'
// to start; enemies are out of scope for #199).
const prevT = prevMap.get(t.id);
const enteredRespawn = !!prevT && !prevT.alive && t.alive;
const enteredRound = curr.roundStartTick !== prev.roundStartTick;
if ((enteredRespawn || enteredRound) && !view.spawn) {
  const variant = DEFAULT_SPAWN_ANIM; // per-slot selection arrives with the picker UI
  const color = curr.mode === 'teams' ? teamColor(t.team ?? 0) : identityColor(slot);
  const ring = makeSpawnRing(color);
  view.group.add(ring);
  view.spawn = { variant, elapsed: 0, ring };
}
if (view.spawn) {
  view.spawn.elapsed += dt;
  const shieldLeft = (t.shieldUntilTick ?? 0) - curr.tick;
  let frame;
  if (view.spawn.elapsed < ENTRANCE_SECONDS) {
    frame = SPAWN_ANIMATORS[view.spawn.variant]('entrance', view.spawn.elapsed / ENTRANCE_SECONDS, 0);
  } else if (shieldLeft > 0) {
    const p = 1 - shieldLeft / RESPAWN_SHIELD_TICKS; // 0 fresh -> 1 ending
    frame = SPAWN_ANIMATORS[view.spawn.variant]('invincible', p, 0);
  } else {
    // Done: restore solid, drop the ring, clear state.
    setTankOpacity(view, 1);
    view.group.scale.setScalar(1);
    disposeObject(view.spawn.ring);
    view.group.remove(view.spawn.ring);
    view.spawn = null;
    frame = null;
  }
  if (frame) {
    setTankOpacity(view, frame.tankOpacity);
    view.group.scale.setScalar(frame.tankScale);
    view.spawn.ring.scale.setScalar(frame.ring.radius);
    (view.spawn.ring.material as THREE.MeshBasicMaterial).opacity = frame.ring.opacity;
    // arc: set the ring geometry's thetaLength when < 1 (Beacon). Rebuild only on change.
    applyRingArc(view.spawn.ring, frame.ring.arc);
  }
}
```

Add two small local helpers in `entities.ts`:
- `setTankOpacity(view, k)`: set `transparent = true` and `opacity = k` on the view's body/turret/track materials (the per-tank `MeshStandardMaterial` instances built in `makeTank`).
- `applyRingArc(mesh, arc)`: when `arc < 1`, swap the `RingGeometry` for one with `thetaLength = arc * 2π`; skip if unchanged (store last arc on the mesh's `userData`).

The `color` arg to the animator is unused for opacity/scale/arc (the ring mesh already carries the colour); pass `0`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/render/entities.test.ts`
Expected: PASS. Then the full render suite: `npx vitest run src/render/`.

- [ ] **Step 7: Commit**

```bash
git add src/render/entities.ts src/render/entities.test.ts
git commit -m "Spawn-anim: wire entrance edge + live shield overlay into the tank view

roundStartTick verification: <record the Step 1 finding here>."
```

---

### Task 6: Default wiring, gallery renderability, and the full gate

Confirm Warp plays in real gameplay, all three variants are reachable, and the sim invariant holds.

**Files:**
- Modify: `src/render/entities.ts` (only if Task 5 left the default unwired)
- Verify: `tools/baseline/trace.test.ts` (unchanged), `src/render/entities.test.ts`

- [ ] **Step 1: Confirm the three variants are each reachable from a test**

Add a parametrized test asserting each `SPAWN_ANIMATORS[id]` returns a frame whose entrance-start differs from its entrance-end (so no variant is a dead constant), over `['warp','rise','beacon']`. This is the anti-rot guard until the picker UI and the `--spawn-anim` gallery arg (issue #201) land.

```ts
// src/render/spawn-anim.test.ts
it.each(['warp', 'rise', 'beacon'] as const)('%s is a live animator, not a constant', (id) => {
  const a = SPAWN_ANIMATORS[id]('entrance', 0, 0);
  const b = SPAWN_ANIMATORS[id]('entrance', 1, 0);
  expect(a).not.toEqual(b);
});
```

- [ ] **Step 2: Run the full test gate**

Run: `npm test`
Expected: PASS (`tsc --noEmit` clean + all vitest green).

- [ ] **Step 3: Verify BASELINE_HASH is unmoved**

Run: `npx vitest run tools/baseline/trace.test.ts`
Expected: PASS with the pinned `a5458ede…` hash. If it moved, a `src/sim/` file was touched — revert that; this feature must not reach the sim.

- [ ] **Step 4: Run the mutation manifest**

Run: `npm run mutate`
Expected: all entries match declared outcomes (no new mismatches). The new spawn-anim tests are unit-level; no manifest entry is required by #199, but the existing suite must stay green.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Spawn-anim: anti-rot reachability guard for all three variants; gate green"
```

- [ ] **Step 6: Open the PR (closes #199)**

```bash
git push -u origin <branch>
gh pr create --base main --title "Spawn animation core: identity entrance + shield invincibility, three variants" \
  --body "Closes #199. <summary: files, the three variants, Warp default, BASELINE_HASH unmoved (state the value), npm test + mutate counts. Note that Rise/Beacon are unit-tested and default-unwired pending the #201 gallery arg and a future picker UI.>"
```

---

## Self-Review

**Spec coverage (§ of the design spec → task):**
- §2 architecture (tank-attached, world-diff-driven, dt clock) → Task 5.
- §3 two phases (entrance fixed ~0.5s; invincibility live from `shieldUntilTick`) → Tasks 2, 5 (`ENTRANCE_SECONDS`, the `shieldLeft` read).
- §4 three variants, pure `(phase, progress, color)` functions → Tasks 2-4.
- §7 registry mirrors skins (data in `customization.ts`, impl Record in render) → Tasks 1-2.
- §8 testing (progress 0/0.5/1, negative controls, trigger edges, shield-length tracking) → Tasks 2-5.
- Global: no `src/sim/`, `BASELINE_HASH` unmoved, Warp default, all variants reachable → Task 6.

**Deferred to #200/#201 (out of scope here, stated in issues):** the death pulse (#200), the `--spawn-anim` gallery arg + removing the cyan burst + media (#201), and a per-slot picker UI. Enemy tanks are excluded from the entrance trigger in Task 5 (`t.kind === 'player'` guard) — the death-side enemy question is #200's flag.

**Placeholder scan:** none — every code step carries real code; Task 5 Step 1 is a genuine verification with an expected finding to record, not a TODO.

**Type consistency:** `SpawnAnimId` (Task 1) is the Record key in Task 2 and the `variant` field in Task 5. `SpawnFrame`/`SpawnAnimator`/`SpawnPhase`/`ENTRANCE_SECONDS`/`makeSpawnRing` are defined in Task 2 and consumed in Task 5. `SPAWN_ANIMATORS[id](phase, progress, color)` arity is consistent across Tasks 2-6.

## Note on the sibling plans

Issues **#200 (death pulse)** and **#201 (gallery + media)** get their own plans, written once #199 lands and its concrete interfaces (`makeSpawnRing`, the `entities.ts` trigger hub, `SPAWN_ANIMATORS`) exist. Detailing their TDD steps now would mean inventing signatures #199 defines — the exact speculative-detail failure the self-review guards against. #200 reuses `makeSpawnRing` and the alive→dead edge; #201 adds `--spawn-anim` selection over `SPAWN_ANIMATIONS`.
