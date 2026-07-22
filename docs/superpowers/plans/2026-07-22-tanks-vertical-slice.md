# Tanks! Vertical Slice — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a playable, deterministic vertical slice of a Wii Play "Tanks!"-style toy-tank battler: one hand-designed arena with three enemy AIs, one-hit death, ricochet bullets, and mines, rendered as a felt tabletop diorama in Three.js with decoupled event-driven audio.

**Architecture:** A hard split between a pure, deterministic 60Hz simulation core (sim/ — no Three.js/DOM/Howler) and dumb projection layers (render/, audio/, input/, game/). step(world, input) returns a fresh world plus a list of SimEvents; render interpolates between the two most recent worlds and spawns particles from events, audio maps events to SFX, and both consume the same event stream. Collision uses swept ray-vs-AABB reflection for bullets (tunneling-proof, ricochet falls out naturally) and circle-vs-AABB/circle for tanks; everything tunable lives in sim/constants.ts and is unit-tested under Vitest.

**Tech Stack:** TypeScript + Vite (dev/build/HMR), Three.js (render only), Howler.js (audio, with a Web Audio procedural fallback), Vitest (pure-sim unit tests), Node 20+, npm.

## Global Constraints

- Stack: TypeScript + Vite + Three.js + Howler.js + Vitest; Node 20+; package manager is npm.
- Hard architectural split: sim/ is a PURE, deterministic, unit-tested core that imports NOTHING from three, the DOM, or howler.
- render/ and audio/ and input/ and game/ are dumb projections of sim state and SimEvents; the sim core never imports render or audio.
- Fixed 60Hz timestep accumulator, decoupled from render framerate; sim is deterministic (clean Vitest assertions) and framerate-independent.
- Render interpolates between the two most recent sim states for smoothness.
- Bullets use swept ray-vs-AABB collision with in-tick reflection, NOT per-frame point checks (no tunneling); corner double-reflect is explicitly unit-tested.
- One-hit death applies to BOTH the player AND every enemy.
- No external 3D art assets: all meshes built from Three.js primitives (boxes/cylinders).
- Audio is royalty-free, CC0 preferred; no AI-generated or unlicensed audio; assets committed under public/audio/ with attribution in CREDITS.md; a Web Audio procedural fallback is acceptable so dev is not blocked on downloads.
- Tunable default integer (verify against playtest): concurrent player shell cap = 5 on screen.
- Tunable default integer: player mine cap = 2 active.
- Tunable default integer: normal shell bounce cap = 1 bounce (dies on the next wall hit).
- Tunable default integer: ricochet shell = 2-3 bounces; fast/rocket shell = no bounce.
- Tunable default: mine detonation ~3s timer OR proximity trigger; mine blast radius kills any tank and destroys destructible walls.
- Tunable default integer: lives = 3, restart arena on death.
- ALL tunable numbers live in exactly one place: sim/constants.ts.
- TDD where it pays: physics/ricochet math and AI targeting are pure functions with clear right answers — write tests first there; render/audio wiring is validated by hand.
- Out of scope for the slice: full campaign, co-op, level-editor UI, gamepad, online, and menus beyond title/win/lose.

## File Structure

```
tanks/
  package.json                 # npm scripts: dev, build, test; deps three, howler; dev deps vite, vitest, typescript
  tsconfig.json                # strict TypeScript config
  vite.config.ts               # Vite + Vitest (test.environment) config
  index.html                   # mounts #app root, loads src/main.ts
  CREDITS.md                   # attribution for any non-CC0 audio assets
  public/
    audio/                     # committed CC0 SFX + music (or empty until sourced; engine degrades gracefully)
  src/
    main.ts                    # entry: boots canvas + starts game loop
    sim/
      types.ts                 # Vec2, AABB, Wall, Tank, Bullet, Mine, InputState, Spawn, enums, vec math, seeded PRNG
      constants.ts             # ALL tunable numbers + bulletConfig
      events.ts                # SimEvent discriminated union (canonical 10 kinds)
      collision.ts             # circleVsAABB, circleVsCircle, raySegmentVsAABB, reflectSweep, moveTank, separateTanks
      world.ts                 # World, createWorld, cloneWorld, step, stepMovement, resolveStatus
      bullets.ts               # spawnBullet, stepBullets, resolveBulletHits, ownerShellCount
      mines.ts                 # dropMine, stepMines, detonateMine
      arena.ts                 # Arena type, ARENA_01 data, loadArena, createArenaWorld
      ai/
        targeting.ts           # lineOfSight, aimLead, mirrorAcrossAABB, bankShot, incomingThreats, dangerAvoidMove
        brown.ts               # brownDecision (AiDecision defined here)
        grey.ts                # greyDecision
        teal.ts                # tealDecision
        index.ts               # decideAi dispatcher + stepAi
    render/
      scene.ts                 # createScene: renderer, tilted camera, directional light, felt ground
      interpolate.ts           # lerp, lerpAngle, lerpVec2
      entities.ts              # createEntityViews: tank/wall/bullet/mine meshes, add/remove/interp
      particles.ts             # createParticleSystem: spawn juice from SimEvents
      renderer.ts              # createRenderer aggregator + screenToGround
    audio/
      manifest.ts              # AudioManifest + AUDIO_MANIFEST
      engine.ts                # createAudioEngine: Howler wiring, graceful degrade, procedural fallback, music/mute/volume
      director.ts              # createAudioDirector: SimEvent -> SFX mapping, pitch-varied ricochet
    input/
      input.ts                 # createInputController: keyboard + mouse -> InputState
    game/
      state.ts                 # createGameStateMachine (title/playing/win/lose)
      hud.ts                   # createHud: lives, enemies remaining, mute/volume
      loop.ts                  # startGame: fixed-timestep accumulator wiring everything
```

---

### Task 1: Project scaffold, tooling, and canvas boot

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vite.config.ts`
- Create: `index.html`
- Create: `src/main.ts`
- Create: `src/render/canvas.ts`
- Create: `src/sim/smoke.ts`
- Create: `src/sim/smoke.test.ts`
- Test: `src/sim/smoke.test.ts`

**Interfaces:**

Consumes: nothing.

Produces:
- npm scripts: `dev` (vite), `build` (vite build), `test` (vitest run). Deps: `three`, `howler`. Dev deps: `vite`, `vitest`, `typescript`, `@types/three`, `@types/howler`. Node 20+. tsconfig `strict:true`.
- `function bootCanvas(root: HTMLElement): HTMLCanvasElement` — creates a full-window canvas, appends to root, returns it.
- `src/main.ts` calls `bootCanvas(document.getElementById('app')!)` (placeholder wiring, replaced in task 33).
- `smoke.ts`: `export function add(a: number, b: number): number` proving a pure sim module unit-tests headlessly.

---

#### Steps

- [ ] **Step: Create `package.json`**

```json
{
  "name": "tanks",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "engines": {
    "node": ">=20"
  },
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "preview": "vite preview",
    "test": "vitest run"
  },
  "dependencies": {
    "howler": "^2.2.4",
    "three": "^0.169.0"
  },
  "devDependencies": {
    "@types/howler": "^2.2.11",
    "@types/three": "^0.169.0",
    "typescript": "^5.6.3",
    "vite": "^5.4.10",
    "vitest": "^2.1.4"
  }
}
```

- [ ] **Step: Create `tsconfig.json`** (strict mode, DOM + ESNext libs so render/input can use the DOM while sim stays pure by convention)

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["vitest/globals"],
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "noImplicitReturns": true,
    "exactOptionalPropertyTypes": false,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": false,
    "resolveJsonModule": true,
    "noEmit": true
  },
  "include": ["src", "vite.config.ts"]
}
```

- [ ] **Step: Create `vite.config.ts`** (Vite + Vitest config; `globals: true` so `describe/it/expect` resolve without imports, `environment: 'node'` so pure sim tests run headless with no DOM)

```ts
import { defineConfig } from 'vite';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
```

- [ ] **Step: Create `index.html`** (mounts the `#app` root and loads the ESM entry)

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Tanks!</title>
    <style>
      html,
      body {
        margin: 0;
        padding: 0;
        width: 100%;
        height: 100%;
        overflow: hidden;
        background: #1a1a1a;
      }
      #app {
        position: fixed;
        inset: 0;
      }
      canvas {
        display: block;
      }
    </style>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

- [ ] **Step: Write the failing test** (`src/sim/smoke.test.ts`) — proves a pure sim module unit-tests headlessly with no DOM

```ts
import { describe, it, expect } from 'vitest';
import { add } from './smoke';

describe('smoke: pure sim module runs headlessly', () => {
  it('adds two numbers', () => {
    expect(add(2, 3)).toBe(5);
  });

  it('handles negatives and zero', () => {
    expect(add(-4, 4)).toBe(0);
    expect(add(0, 0)).toBe(0);
  });
});
```

- [ ] **Step: Run the test to verify it fails**

```
npx vitest run src/sim/smoke.test.ts
```

Expected: FAIL — `src/sim/smoke.ts` does not exist yet, so the import of `add` cannot be resolved (module not found).

- [ ] **Step: Implement minimal code to pass** (`src/sim/smoke.ts`) — a pure function importing nothing from three/DOM/howler

```ts
export function add(a: number, b: number): number {
  return a + b;
}
```

- [ ] **Step: Run the test to verify it passes**

```
npx vitest run src/sim/smoke.test.ts
```

Expected: PASS — 2 tests passing in `src/sim/smoke.test.ts`.

- [ ] **Step: Implement `bootCanvas`** (`src/render/canvas.ts`) — creates a full-window canvas, appends to root, returns it

```ts
export function bootCanvas(root: HTMLElement): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.style.display = 'block';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  root.appendChild(canvas);
  return canvas;
}
```

- [ ] **Step: Implement `src/main.ts`** (placeholder wiring, replaced by `startGame` in task 33)

```ts
import { bootCanvas } from './render/canvas';

bootCanvas(document.getElementById('app')!);
```

- [ ] **Step: Install dependencies**

```
npm install
```

Expected: dependencies resolve and a `node_modules/` + `package-lock.json` are produced with no error exit code.

- [ ] **Step: Verify the full test suite runs headless**

```
npm test
```

Expected: PASS — Vitest runs in the `node` environment (no DOM), `src/sim/smoke.test.ts` reports 2 passing tests, exit code 0.

- [ ] **Step: Verify the build type-checks under strict mode**

```
npm run build
```

Expected: PASS — `tsc --noEmit` reports no type errors (strict mode) and `vite build` emits `dist/` with no errors.

- [ ] **Step: Add a `.gitignore`** (so build artifacts and deps are not committed)

```
node_modules/
dist/
*.log
.DS_Store
```

- [ ] **Step: Commit**

```
git add package.json package-lock.json tsconfig.json vite.config.ts index.html .gitignore src/main.ts src/render/canvas.ts src/sim/smoke.ts src/sim/smoke.test.ts && git commit -m "Task 1: project scaffold, tooling, and canvas boot"
```

---

### Task 2: Core sim types, vec math, and seeded PRNG

**Files:**
- Create: `src/sim/types.ts`
- Test: `src/sim/types.test.ts`

**Interfaces:**

Consumes: nothing.

Produces (canonical shared types — defined ONCE here, referenced everywhere after):
- `type Vec2 = { x: number; y: number }`
- `interface AABB { minX: number; minY: number; maxX: number; maxY: number }`
- `type WallKind = 'solid' | 'destructible'`
- `interface Wall { id: number; aabb: AABB; kind: WallKind; destroyed: boolean }`
- `type BulletType = 'normal' | 'fast' | 'ricochet'`
- `type TankKind = 'player' | 'brown' | 'grey' | 'teal'`
- `type AiState = 'idle' | 'aim' | 'fire' | 'reposition'`
- `interface Spawn { kind: TankKind; pos: Vec2; angle: number }`
- `interface Tank { id: number; kind: TankKind; pos: Vec2; bodyAngle: number; turretAngle: number; alive: boolean; desiredMove: Vec2; activeMineIds: number[]; fireCooldown: number; mineCooldown: number; aiState: AiState; aiTimer: number }`
- `interface Bullet { id: number; ownerId: number; type: BulletType; pos: Vec2; vel: Vec2; bouncesLeft: number; alive: boolean }`
- `interface Mine { id: number; ownerId: number; pos: Vec2; timer: number; armed: boolean; detonated: boolean }`
- `interface InputState { move: Vec2; aim: Vec2; fire: boolean; mine: boolean }`
- Vec math: `vadd`, `vsub`, `vscale(a: Vec2, s: number): Vec2`, `vlen(a: Vec2): number`, `vnorm(a: Vec2): Vec2`, `vdot`, `vdist`, `angleOf(a: Vec2): number`, `fromAngle(r: number): Vec2`
- PRNG: `nextRng(seed: number): { value: number; seed: number }` — `value` in [0,1), deterministic, advances seed.

Steps:

- [ ] **Step: Write the failing test** — create `src/sim/types.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  vadd, vsub, vscale, vlen, vnorm, vdot, vdist, angleOf, fromAngle, nextRng,
} from './types';
import type { Vec2 } from './types';

describe('vec math', () => {
  it('vadd / vsub add and subtract componentwise', () => {
    expect(vadd({ x: 1, y: 2 }, { x: 3, y: -1 })).toEqual({ x: 4, y: 1 });
    expect(vsub({ x: 1, y: 2 }, { x: 3, y: -1 })).toEqual({ x: -2, y: 3 });
  });

  it('vscale multiplies both components', () => {
    expect(vscale({ x: 2, y: -3 }, 2)).toEqual({ x: 4, y: -6 });
  });

  it('vlen / vdist measure length and distance', () => {
    expect(vlen({ x: 3, y: 4 })).toBeCloseTo(5, 10);
    expect(vdist({ x: 0, y: 0 }, { x: 3, y: 4 })).toBeCloseTo(5, 10);
  });

  it('vdot computes the dot product', () => {
    expect(vdot({ x: 1, y: 2 }, { x: 3, y: 4 })).toBe(11);
  });

  it('vnorm returns a unit vector', () => {
    const n = vnorm({ x: 3, y: 4 });
    expect(vlen(n)).toBeCloseTo(1, 10);
    expect(n.x).toBeCloseTo(0.6, 10);
    expect(n.y).toBeCloseTo(0.8, 10);
  });

  it('vnorm of the zero vector returns {0,0} (no NaN)', () => {
    const n = vnorm({ x: 0, y: 0 });
    expect(n).toEqual({ x: 0, y: 0 });
    expect(Number.isNaN(n.x)).toBe(false);
    expect(Number.isNaN(n.y)).toBe(false);
  });

  it('angleOf and fromAngle round-trip', () => {
    const r = 0.7;
    const v: Vec2 = fromAngle(r);
    expect(vlen(v)).toBeCloseTo(1, 10);
    expect(angleOf(v)).toBeCloseTo(r, 10);
  });
});

describe('nextRng', () => {
  it('is deterministic for a fixed seed', () => {
    expect(nextRng(12345)).toEqual(nextRng(12345));
  });

  it('advances the seed (chained calls differ)', () => {
    const a = nextRng(1);
    const b = nextRng(a.seed);
    expect(a.value).not.toBe(b.value);
    expect(a.seed).not.toBe(1);
  });

  it('stays in [0,1) across a range of seeds', () => {
    let seed = 7;
    for (let i = 0; i < 1000; i++) {
      const r = nextRng(seed);
      expect(r.value).toBeGreaterThanOrEqual(0);
      expect(r.value).toBeLessThan(1);
      seed = r.seed;
    }
  });
});
```

- [ ] **Step: Run the test to verify it fails**
  - Command: `npx vitest run src/sim/types.test.ts`
  - Expected: FAIL — `Cannot find module './types'` (module not created yet).

- [ ] **Step: Implement minimal code to pass** — create `src/sim/types.ts`:

```ts
// ---- Geometry ----
export type Vec2 = { x: number; y: number };

export interface AABB {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

// ---- Walls ----
export type WallKind = 'solid' | 'destructible';

export interface Wall {
  id: number;
  aabb: AABB;
  kind: WallKind;
  destroyed: boolean;
}

// ---- Entities ----
export type BulletType = 'normal' | 'fast' | 'ricochet';
export type TankKind = 'player' | 'brown' | 'grey' | 'teal';
export type AiState = 'idle' | 'aim' | 'fire' | 'reposition';

export interface Spawn {
  kind: TankKind;
  pos: Vec2;
  angle: number;
}

export interface Tank {
  id: number;
  kind: TankKind;
  pos: Vec2;
  bodyAngle: number;
  turretAngle: number;
  alive: boolean;
  desiredMove: Vec2;
  activeMineIds: number[];
  fireCooldown: number;
  mineCooldown: number;
  aiState: AiState;
  aiTimer: number;
}

export interface Bullet {
  id: number;
  ownerId: number;
  type: BulletType;
  pos: Vec2;
  vel: Vec2;
  bouncesLeft: number;
  alive: boolean;
}

export interface Mine {
  id: number;
  ownerId: number;
  pos: Vec2;
  timer: number;
  armed: boolean;
  detonated: boolean;
}

// move components in [-1,1] (not normalized); aim is a world-space ground point;
// fire/mine are edge-triggered (press-this-tick).
export interface InputState {
  move: Vec2;
  aim: Vec2;
  fire: boolean;
  mine: boolean;
}

// ---- Vec math ----
export function vadd(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function vsub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function vscale(a: Vec2, s: number): Vec2 {
  return { x: a.x * s, y: a.y * s };
}

export function vlen(a: Vec2): number {
  return Math.sqrt(a.x * a.x + a.y * a.y);
}

export function vnorm(a: Vec2): Vec2 {
  const len = vlen(a);
  if (len === 0) return { x: 0, y: 0 };
  return { x: a.x / len, y: a.y / len };
}

export function vdot(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.y * b.y;
}

export function vdist(a: Vec2, b: Vec2): number {
  return vlen(vsub(a, b));
}

export function angleOf(a: Vec2): number {
  return Math.atan2(a.y, a.x);
}

export function fromAngle(r: number): Vec2 {
  return { x: Math.cos(r), y: Math.sin(r) };
}

// ---- Deterministic PRNG (mulberry32) ----
// The ONLY source of randomness in sim/. Never use Math.random.
export function nextRng(seed: number): { value: number; seed: number } {
  const z = (seed + 0x6d2b79f5) | 0;
  let x = Math.imul(z ^ (z >>> 15), z | 1);
  x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
  const value = ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  return { value, seed: z };
}
```

- [ ] **Step: Run the test to verify it passes**
  - Command: `npx vitest run src/sim/types.test.ts`
  - Expected: PASS (all cases green).

- [ ] **Step: Commit**
  - `git add src/sim/types.ts src/sim/types.test.ts && git commit -m "Add core sim types, vec math, and seeded PRNG"`

---

### Task 3: Tunable constants and bullet config

**Files:**
- Create: `src/sim/constants.ts`
- Test: `src/sim/constants.test.ts` (small exhaustiveness/values check — the blueprint marks this data-only, but the TDD cycle uses a tiny guard test)

**Interfaces:**

Consumes: `BulletType` (task 2).

Produces (the single home for all tunable numbers, spec §4 defaults):
- `TICK_HZ = 60`, `DT = 1 / 60`
- `TANK_RADIUS = 0.5`, `TANK_SPEED = 3.0`
- `BULLET_RADIUS = 0.1`
- `NORMAL_SPEED = 6`, `FAST_SPEED = 12`, `RICOCHET_SPEED = 6`
- `NORMAL_BOUNCES = 1`, `FAST_BOUNCES = 0`, `RICOCHET_BOUNCES = 3`
- `PLAYER_SHELL_CAP = 5`, `PLAYER_MINE_CAP = 2`
- `FIRE_COOLDOWN = 0.4`, `MINE_COOLDOWN = 0.5`
- `MINE_TIMER = 3.0`, `MINE_PROXIMITY_RADIUS = 1.5`, `MINE_BLAST_RADIUS = 2.0`
- `LIVES = 3`
- `bulletConfig: Record<BulletType, { speed: number; bounces: number }>`

Steps:

- [ ] **Step: Write the failing test** — create `src/sim/constants.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  bulletConfig, DT, TICK_HZ, PLAYER_SHELL_CAP, PLAYER_MINE_CAP,
  NORMAL_BOUNCES, FAST_BOUNCES, RICOCHET_BOUNCES, LIVES,
} from './constants';
import type { BulletType } from './types';

describe('constants', () => {
  it('DT is the reciprocal of the tick rate', () => {
    expect(TICK_HZ).toBe(60);
    expect(DT).toBeCloseTo(1 / 60, 12);
  });

  it('carries the spec default caps and lives', () => {
    expect(PLAYER_SHELL_CAP).toBe(5);
    expect(PLAYER_MINE_CAP).toBe(2);
    expect(LIVES).toBe(3);
  });

  it('bulletConfig covers every BulletType exhaustively', () => {
    const types: BulletType[] = ['normal', 'fast', 'ricochet'];
    for (const t of types) {
      expect(bulletConfig[t]).toBeDefined();
      expect(typeof bulletConfig[t].speed).toBe('number');
      expect(typeof bulletConfig[t].bounces).toBe('number');
    }
    expect(Object.keys(bulletConfig).sort()).toEqual([...types].sort());
  });

  it('bounce counts match the spec: fast=0, normal=1, ricochet=3', () => {
    expect(bulletConfig.fast.bounces).toBe(FAST_BOUNCES);
    expect(bulletConfig.normal.bounces).toBe(NORMAL_BOUNCES);
    expect(bulletConfig.ricochet.bounces).toBe(RICOCHET_BOUNCES);
    expect(FAST_BOUNCES).toBe(0);
    expect(NORMAL_BOUNCES).toBe(1);
    expect(RICOCHET_BOUNCES).toBe(3);
  });
});
```

- [ ] **Step: Run the test to verify it fails**
  - Command: `npx vitest run src/sim/constants.test.ts`
  - Expected: FAIL — `Cannot find module './constants'` (module not created yet).

- [ ] **Step: Implement minimal code to pass** — create `src/sim/constants.ts`:

```ts
import type { BulletType } from './types';

// ---- Simulation timing ----
export const TICK_HZ = 60;
export const DT = 1 / 60;

// ---- Tanks ----
export const TANK_RADIUS = 0.5;
export const TANK_SPEED = 3.0;

// ---- Bullets ----
export const BULLET_RADIUS = 0.1;

export const NORMAL_SPEED = 6;
export const FAST_SPEED = 12;
export const RICOCHET_SPEED = 6;

export const NORMAL_BOUNCES = 1;
export const FAST_BOUNCES = 0;
export const RICOCHET_BOUNCES = 3;

// ---- Player resource caps ----
export const PLAYER_SHELL_CAP = 5;
export const PLAYER_MINE_CAP = 2;

// ---- Cooldowns (seconds) ----
export const FIRE_COOLDOWN = 0.4;
export const MINE_COOLDOWN = 0.5;

// ---- Mines ----
export const MINE_TIMER = 3.0;
export const MINE_PROXIMITY_RADIUS = 1.5;
export const MINE_BLAST_RADIUS = 2.0;

// ---- Meta ----
export const LIVES = 3;

// ---- Per-type bullet tuning ----
export const bulletConfig: Record<BulletType, { speed: number; bounces: number }> = {
  normal: { speed: NORMAL_SPEED, bounces: NORMAL_BOUNCES },
  fast: { speed: FAST_SPEED, bounces: FAST_BOUNCES },
  ricochet: { speed: RICOCHET_SPEED, bounces: RICOCHET_BOUNCES },
};
```

- [ ] **Step: Run the test to verify it passes**
  - Command: `npx vitest run src/sim/constants.test.ts`
  - Expected: PASS.

- [ ] **Step: Commit**
  - `git add src/sim/constants.ts src/sim/constants.test.ts && git commit -m "Add tunable sim constants and bullet config"`

---

### Task 4: SimEvent discriminated union

**Files:**
- Create: `src/sim/events.ts`
- Test: `src/sim/events.test.ts` (type-level exhaustiveness guard — blueprint marks this type-only; the cycle uses a compile-checked switch)

**Interfaces:**

Consumes: `Vec2`, `BulletType`, `TankKind` (task 2).

Produces (canonical 10-kind union from spec §3 — exact set; render + audio depend on these exact names):
- `type SimEvent =`
  - `| { type: 'fire'; ownerId: number; bulletType: BulletType; pos: Vec2; angle: number }`
  - `| { type: 'ricochet'; pos: Vec2; bounceIndex: number }`
  - `| { type: 'explosion'; pos: Vec2 }`
  - `| { type: 'mine-dropped'; mineId: number; pos: Vec2 }`
  - `| { type: 'mine-armed'; mineId: number; pos: Vec2 }`
  - `| { type: 'mine-detonate'; mineId: number; pos: Vec2 }`
  - `| { type: 'tank-destroyed'; tankId: number; kind: TankKind; pos: Vec2 }`
  - `| { type: 'wall-destroyed'; wallId: number; pos: Vec2 }`
  - `| { type: 'win' }`
  - `| { type: 'lose' }`
- Note: `mine-dropped` fires when the player drops a mine (→ audio "mine-drop" thunk); `mine-armed` fires later, the instant the mine goes live as its owner leaves `MINE_PROXIMITY_RADIUS` (→ audio "mine-arm" beep). Two distinct moments, two distinct sounds (spec §10).

Steps:

- [ ] **Step: Write the failing test** — create `src/sim/events.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { SimEvent } from './events';

// Exhaustive switch: compiles ONLY if every SimEvent kind is handled.
// The `never` default is a compile-time guarantee for all downstream consumers.
function label(e: SimEvent): string {
  switch (e.type) {
    case 'fire': return 'fire';
    case 'ricochet': return 'ricochet';
    case 'explosion': return 'explosion';
    case 'mine-dropped': return 'mine-dropped';
    case 'mine-armed': return 'mine-armed';
    case 'mine-detonate': return 'mine-detonate';
    case 'tank-destroyed': return 'tank-destroyed';
    case 'wall-destroyed': return 'wall-destroyed';
    case 'win': return 'win';
    case 'lose': return 'lose';
    default: {
      const _never: never = e;
      return _never;
    }
  }
}

describe('SimEvent', () => {
  it('labels representative events across the union', () => {
    const events: SimEvent[] = [
      { type: 'fire', ownerId: 1, bulletType: 'normal', pos: { x: 0, y: 0 }, angle: 0 },
      { type: 'ricochet', pos: { x: 1, y: 1 }, bounceIndex: 2 },
      { type: 'explosion', pos: { x: 2, y: 2 } },
      { type: 'mine-dropped', mineId: 7, pos: { x: 3, y: 3 } },
      { type: 'mine-armed', mineId: 7, pos: { x: 3, y: 3 } },
      { type: 'mine-detonate', mineId: 7, pos: { x: 3, y: 3 } },
      { type: 'tank-destroyed', tankId: 4, kind: 'brown', pos: { x: 4, y: 4 } },
      { type: 'wall-destroyed', wallId: 9, pos: { x: 5, y: 5 } },
      { type: 'win' },
      { type: 'lose' },
    ];
    expect(events.map(label)).toEqual([
      'fire', 'ricochet', 'explosion', 'mine-dropped', 'mine-armed', 'mine-detonate',
      'tank-destroyed', 'wall-destroyed', 'win', 'lose',
    ]);
  });
});
```

- [ ] **Step: Run the test to verify it fails**
  - Command: `npx vitest run src/sim/events.test.ts`
  - Expected: FAIL — `Cannot find module './events'` (module not created yet).

- [ ] **Step: Implement minimal code to pass** — create `src/sim/events.ts`:

```ts
import type { Vec2, BulletType, TankKind } from './types';

// Canonical 10-kind event union emitted by step(). Render and audio both consume
// this stream; the sim core never imports render or audio.
export type SimEvent =
  | { type: 'fire'; ownerId: number; bulletType: BulletType; pos: Vec2; angle: number }
  | { type: 'ricochet'; pos: Vec2; bounceIndex: number }
  | { type: 'explosion'; pos: Vec2 }
  | { type: 'mine-dropped'; mineId: number; pos: Vec2 }
  | { type: 'mine-armed'; mineId: number; pos: Vec2 }
  | { type: 'mine-detonate'; mineId: number; pos: Vec2 }
  | { type: 'tank-destroyed'; tankId: number; kind: TankKind; pos: Vec2 }
  | { type: 'wall-destroyed'; wallId: number; pos: Vec2 }
  | { type: 'win' }
  | { type: 'lose' };
```

- [ ] **Step: Run the test to verify it passes**
  - Command: `npx vitest run src/sim/events.test.ts`
  - Expected: PASS (and it type-checks the exhaustive switch).

- [ ] **Step: Commit**
  - `git add src/sim/events.ts src/sim/events.test.ts && git commit -m "Add canonical SimEvent discriminated union"`

---

### Task 5: Collision primitives — circle-vs-AABB and circle-vs-circle

**Files:**
- Create: `src/sim/collision.ts`
- Test: `src/sim/collision.test.ts`

**Interfaces:**

Consumes (from task 2):
- `type Vec2 = { x: number; y: number }`
- `interface AABB { minX: number; minY: number; maxX: number; maxY: number }`

Produces:
- `interface Hit { hit: boolean; push: Vec2 }` — `push` is the minimum-translation vector that separates the circle (moves the FIRST argument out); `{x:0,y:0}` when no overlap.
- `function circleVsAABB(center: Vec2, radius: number, box: AABB): Hit`
- `function circleVsCircle(a: Vec2, ra: number, b: Vec2, rb: number): Hit`

**Steps:**

- [ ] **Step: Write the failing test for `circleVsAABB`**

  Create `src/sim/collision.test.ts`:

  ```ts
  import { describe, it, expect } from 'vitest';
  import { circleVsAABB, circleVsCircle } from './collision';
  import type { AABB } from './types';

  const BOX: AABB = { minX: 0, minY: 0, maxX: 2, maxY: 2 };

  describe('circleVsAABB', () => {
    it('pushes along the shortest axis when overlapping a face', () => {
      // circle to the left of the box, overlapping the left face
      const hit = circleVsAABB({ x: -0.4, y: 1 }, 0.5, BOX);
      expect(hit.hit).toBe(true);
      // shortest separation is along -x
      expect(hit.push.x).toBeCloseTo(-0.1, 9);
      expect(hit.push.y).toBeCloseTo(0, 9);
    });

    it('pushes diagonally out to a corner', () => {
      // circle beyond the bottom-left corner (0,0)
      const hit = circleVsAABB({ x: -0.2, y: -0.2 }, 0.5, BOX);
      expect(hit.hit).toBe(true);
      expect(hit.push.x).toBeLessThan(0);
      expect(hit.push.y).toBeLessThan(0);
      // pushes back along the corner diagonal (equal components here)
      expect(hit.push.x).toBeCloseTo(hit.push.y, 9);
    });

    it('returns a nonzero push when the center is fully inside', () => {
      const hit = circleVsAABB({ x: 0.5, y: 1 }, 0.3, BOX);
      expect(hit.hit).toBe(true);
      // nearest face is the left face -> push out along -x
      expect(hit.push.x).toBeLessThan(0);
      expect(hit.push.y).toBeCloseTo(0, 9);
      expect(Number.isNaN(hit.push.x)).toBe(false);
    });

    it('returns no hit and zero push when disjoint', () => {
      const hit = circleVsAABB({ x: 5, y: 5 }, 0.5, BOX);
      expect(hit.hit).toBe(false);
      expect(hit.push).toEqual({ x: 0, y: 0 });
    });
  });
  ```

- [ ] **Step: Run the test to verify it fails**

  `npx vitest run src/sim/collision.test.ts`

  Expected: FAIL — `Failed to resolve import "./collision"` / `circleVsAABB is not a function` (module does not exist yet).

- [ ] **Step: Implement `Hit` + `circleVsAABB` (minimal to pass)**

  Create `src/sim/collision.ts`:

  ```ts
  import type { Vec2, AABB } from './types';

  export interface Hit {
    hit: boolean;
    push: Vec2;
  }

  export function circleVsAABB(center: Vec2, radius: number, box: AABB): Hit {
    const inside =
      center.x >= box.minX &&
      center.x <= box.maxX &&
      center.y >= box.minY &&
      center.y <= box.maxY;

    if (inside) {
      // center is inside the box: push out through the nearest face
      const toLeft = center.x - box.minX;
      const toRight = box.maxX - center.x;
      const toBottom = center.y - box.minY;
      const toTop = box.maxY - center.y;
      const minPen = Math.min(toLeft, toRight, toBottom, toTop);
      if (minPen === toLeft) return { hit: true, push: { x: -(toLeft + radius), y: 0 } };
      if (minPen === toRight) return { hit: true, push: { x: toRight + radius, y: 0 } };
      if (minPen === toBottom) return { hit: true, push: { x: 0, y: -(toBottom + radius) } };
      return { hit: true, push: { x: 0, y: toTop + radius } };
    }

    // center outside: separate from the closest point on the box
    const cx = Math.max(box.minX, Math.min(center.x, box.maxX));
    const cy = Math.max(box.minY, Math.min(center.y, box.maxY));
    const dx = center.x - cx;
    const dy = center.y - cy;
    const distSq = dx * dx + dy * dy;
    if (distSq >= radius * radius) return { hit: false, push: { x: 0, y: 0 } };
    const dist = Math.sqrt(distSq);
    const depth = radius - dist;
    return { hit: true, push: { x: (dx / dist) * depth, y: (dy / dist) * depth } };
  }
  ```

- [ ] **Step: Run the test to verify it passes**

  `npx vitest run src/sim/collision.test.ts -t "circleVsAABB"`

  Expected: PASS — 4 passing.

- [ ] **Step: Write the failing test for `circleVsCircle`**

  Append to `src/sim/collision.test.ts`:

  ```ts
  import { vdist } from './types';

  describe('circleVsCircle', () => {
    it('pushes the first circle away from the second along their center line', () => {
      const hit = circleVsCircle({ x: 0, y: 0 }, 0.5, { x: 0.5, y: 0 }, 0.5);
      expect(hit.hit).toBe(true);
      // overlap is 1.0 - 0.5 = 0.5, directed from b toward a (-x)
      expect(hit.push.x).toBeCloseTo(-0.5, 9);
      expect(hit.push.y).toBeCloseTo(0, 9);
    });

    it('returns no hit when the circles are disjoint', () => {
      const hit = circleVsCircle({ x: 0, y: 0 }, 0.5, { x: 3, y: 0 }, 0.5);
      expect(hit.hit).toBe(false);
      expect(hit.push).toEqual({ x: 0, y: 0 });
    });

    it('produces a deterministic non-NaN direction for concentric circles', () => {
      const hit = circleVsCircle({ x: 1, y: 1 }, 0.5, { x: 1, y: 1 }, 0.5);
      expect(hit.hit).toBe(true);
      expect(Number.isNaN(hit.push.x)).toBe(false);
      expect(Number.isNaN(hit.push.y)).toBe(false);
      // default separation is along +x with magnitude ra+rb
      expect(vdist({ x: 0, y: 0 }, hit.push)).toBeCloseTo(1.0, 9);
    });
  });
  ```

- [ ] **Step: Run the test to verify it fails**

  `npx vitest run src/sim/collision.test.ts -t "circleVsCircle"`

  Expected: FAIL — `circleVsCircle is not a function`.

- [ ] **Step: Implement `circleVsCircle`**

  Append to `src/sim/collision.ts`:

  ```ts
  export function circleVsCircle(a: Vec2, ra: number, b: Vec2, rb: number): Hit {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const r = ra + rb;
    const distSq = dx * dx + dy * dy;
    if (distSq >= r * r) return { hit: false, push: { x: 0, y: 0 } };
    const dist = Math.sqrt(distSq);
    if (dist === 0) {
      // concentric: pick a deterministic default axis
      return { hit: true, push: { x: r, y: 0 } };
    }
    const overlap = r - dist;
    return { hit: true, push: { x: (dx / dist) * overlap, y: (dy / dist) * overlap } };
  }
  ```

- [ ] **Step: Run the full file to verify everything passes**

  `npx vitest run src/sim/collision.test.ts`

  Expected: PASS — 7 passing.

- [ ] **Step: Commit**

  `git add src/sim/collision.ts src/sim/collision.test.ts && git commit -m "collision: circleVsAABB and circleVsCircle primitives"`

---

### Task 6: Swept ray-segment vs AABB (entry hit + normal)

**Files:**
- Modify: `src/sim/collision.ts`
- Test: `src/sim/collision.test.ts`

**Interfaces:**

Consumes (from task 2):
- `type Vec2 = { x: number; y: number }`
- `interface AABB { minX: number; minY: number; maxX: number; maxY: number }`

Produces:
- `interface RayHit { t: number; point: Vec2; normal: Vec2 }` — `t` in `[0,1]` along the from→to segment; `normal` is the axis-aligned outward face normal at entry.
- `function raySegmentVsAABB(from: Vec2, to: Vec2, box: AABB): RayHit | null` — nearest entry hit, or `null` if the segment misses. Point-based (no radius inflation) per spec §5.

**Steps:**

- [ ] **Step: Write the failing test**

  Append to `src/sim/collision.test.ts`:

  ```ts
  import { raySegmentVsAABB } from './collision';

  describe('raySegmentVsAABB', () => {
    const box: AABB = { minX: 1, minY: -1, maxX: 2, maxY: 1 };

    it('hits the left face with the correct t and -x normal', () => {
      const hit = raySegmentVsAABB({ x: 0, y: 0 }, { x: 3, y: 0 }, box);
      expect(hit).not.toBeNull();
      expect(hit!.t).toBeCloseTo(1 / 3, 9);
      expect(hit!.point.x).toBeCloseTo(1, 9);
      expect(hit!.point.y).toBeCloseTo(0, 9);
      expect(hit!.normal).toEqual({ x: -1, y: 0 });
    });

    it('returns a defined hit exactly at a corner', () => {
      const cornerBox: AABB = { minX: 0, minY: 0, maxX: 1, maxY: 1 };
      const hit = raySegmentVsAABB({ x: -1, y: -1 }, { x: 1, y: 1 }, cornerBox);
      expect(hit).not.toBeNull();
      expect(hit!.point.x).toBeCloseTo(0, 9);
      expect(hit!.point.y).toBeCloseTo(0, 9);
      expect(hit!.t).toBeCloseTo(0.5, 9);
    });

    it('returns null when the segment ends before the box', () => {
      const hit = raySegmentVsAABB({ x: 0, y: 0 }, { x: 0.5, y: 0 }, box);
      expect(hit).toBeNull();
    });

    it('returns null when the segment misses entirely', () => {
      const hit = raySegmentVsAABB({ x: 0, y: 5 }, { x: 3, y: 5 }, box);
      expect(hit).toBeNull();
    });

    it('handles a segment starting inside deterministically (t=0)', () => {
      const hit = raySegmentVsAABB({ x: 1.5, y: 0 }, { x: 3, y: 0 }, box);
      expect(hit).not.toBeNull();
      expect(hit!.t).toBe(0);
      expect(hit!.point).toEqual({ x: 1.5, y: 0 });
    });

    it('does not divide-by-zero on a parallel/grazing segment', () => {
      // vertical segment whose x sits outside the box: dx===0 branch, no NaN
      const hit = raySegmentVsAABB({ x: 5, y: -5 }, { x: 5, y: 5 }, box);
      expect(hit).toBeNull();
    });
  });
  ```

- [ ] **Step: Run the test to verify it fails**

  `npx vitest run src/sim/collision.test.ts -t "raySegmentVsAABB"`

  Expected: FAIL — `raySegmentVsAABB is not a function`.

- [ ] **Step: Implement `RayHit` + `raySegmentVsAABB` (slab method)**

  Append to `src/sim/collision.ts`:

  ```ts
  export interface RayHit {
    t: number;
    point: Vec2;
    normal: Vec2;
  }

  export function raySegmentVsAABB(from: Vec2, to: Vec2, box: AABB): RayHit | null {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    let tmin = 0;
    let tmax = 1;
    let normal: Vec2 = { x: 0, y: 0 };

    // X slab
    if (dx === 0) {
      if (from.x < box.minX || from.x > box.maxX) return null;
    } else {
      const inv = 1 / dx;
      let t1 = (box.minX - from.x) * inv;
      let t2 = (box.maxX - from.x) * inv;
      let nx = -1; // entering through minX face (moving +x)
      if (t1 > t2) {
        const tmp = t1;
        t1 = t2;
        t2 = tmp;
        nx = 1; // entering through maxX face (moving -x)
      }
      if (t1 > tmin) {
        tmin = t1;
        normal = { x: nx, y: 0 };
      }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return null;
    }

    // Y slab
    if (dy === 0) {
      if (from.y < box.minY || from.y > box.maxY) return null;
    } else {
      const inv = 1 / dy;
      let t1 = (box.minY - from.y) * inv;
      let t2 = (box.maxY - from.y) * inv;
      let ny = -1;
      if (t1 > t2) {
        const tmp = t1;
        t1 = t2;
        t2 = tmp;
        ny = 1;
      }
      if (t1 > tmin) {
        tmin = t1;
        normal = { x: 0, y: ny };
      }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return null;
    }

    return {
      t: tmin,
      point: { x: from.x + dx * tmin, y: from.y + dy * tmin },
      normal,
    };
  }
  ```

- [ ] **Step: Run the test to verify it passes**

  `npx vitest run src/sim/collision.test.ts -t "raySegmentVsAABB"`

  Expected: PASS — 6 passing.

- [ ] **Step: Run the whole file to confirm no regressions**

  `npx vitest run src/sim/collision.test.ts`

  Expected: PASS — 13 passing.

- [ ] **Step: Commit**

  `git add src/sim/collision.ts src/sim/collision.test.ts && git commit -m "collision: raySegmentVsAABB swept entry hit + normal"`

---

### Task 7: reflectSweep — multi-bounce in-tick reflection with corner double-reflect

**Files:**
- Modify: `src/sim/collision.ts`
- Test: `src/sim/collision.test.ts`

**Interfaces:**

Consumes (from task 2): `Vec2`, `AABB`; vec helpers `vadd`, `vsub`, `vscale`, `vnorm`, `vdot`. From task 6: `raySegmentVsAABB`, `RayHit`.

Produces:
- `interface SweepHit { point: Vec2; normal: Vec2; wallIndex: number }`
- `interface SweepResult { end: Vec2; dir: Vec2; bouncesLeft: number; hits: SweepHit[]; expired: boolean }`
- `function reflectSweep(from: Vec2, to: Vec2, walls: AABB[], bounces: number): SweepResult` — raycasts the segment against all walls, reflects the remaining travel within the same tick, decrementing `bounces` per reflection; `hits` lists reflections in order; `expired:true` when it runs out of bounces on a wall (caller kills the bullet at that point). `end`/`dir` describe the final position and unit heading.

**Steps:**

- [ ] **Step: Write the failing test**

  Append to `src/sim/collision.test.ts`:

  ```ts
  import { reflectSweep } from './collision';

  describe('reflectSweep', () => {
    it('passes straight through open space with no hits', () => {
      const res = reflectSweep({ x: 0, y: 0 }, { x: 1, y: 0 }, [], 1);
      expect(res.end.x).toBeCloseTo(1, 9);
      expect(res.end.y).toBeCloseTo(0, 9);
      expect(res.hits).toHaveLength(0);
      expect(res.expired).toBe(false);
      expect(res.dir.x).toBeCloseTo(1, 9);
    });

    it('reflects off a vertical wall, flipping the x component only', () => {
      const wall: AABB = { minX: 1, minY: -1, maxX: 2, maxY: 1 };
      const res = reflectSweep({ x: 0, y: 0 }, { x: 2, y: 0 }, [wall], 1);
      expect(res.hits).toHaveLength(1);
      expect(res.hits[0].normal).toEqual({ x: -1, y: 0 });
      expect(res.hits[0].point.x).toBeCloseTo(1, 9);
      expect(res.dir.x).toBeLessThan(0); // heading reversed in x
      expect(res.dir.y).toBeCloseTo(0, 9);
      expect(res.bouncesLeft).toBe(0);
      expect(res.expired).toBe(false);
    });

    it('EXACT corner hit produces TWO SweepHits at the same point (both axes reflect)', () => {
      const wall: AABB = { minX: 0, minY: 0, maxX: 1, maxY: 1 };
      const res = reflectSweep({ x: -1, y: -1 }, { x: 1, y: 1 }, [wall], 3);
      expect(res.hits).toHaveLength(2);
      expect(res.hits[0].point.x).toBeCloseTo(0, 9);
      expect(res.hits[0].point.y).toBeCloseTo(0, 9);
      expect(res.hits[1].point.x).toBeCloseTo(0, 9);
      expect(res.hits[1].point.y).toBeCloseTo(0, 9);
      // one hit per axis
      const normals = res.hits.map((h) => `${h.normal.x},${h.normal.y}`).sort();
      expect(normals).toEqual(['-1,0', '0,-1']);
      // both components of travel reversed -> retroreflection back toward origin
      expect(res.dir.x).toBeLessThan(0);
      expect(res.dir.y).toBeLessThan(0);
    });

    it('with bounces:0, stops at the wall and marks expired', () => {
      const wall: AABB = { minX: 1, minY: -1, maxX: 2, maxY: 1 };
      const res = reflectSweep({ x: 0, y: 0 }, { x: 3, y: 0 }, [wall], 0);
      expect(res.expired).toBe(true);
      expect(res.end.x).toBeCloseTo(1, 9);
      expect(res.end.y).toBeCloseTo(0, 9);
      expect(res.hits).toHaveLength(0);
    });

    it('reflects many times without tunneling through a wall', () => {
      const wallRight: AABB = { minX: 5, minY: -10, maxX: 6, maxY: 10 };
      const wallLeft: AABB = { minX: -6, minY: -10, maxX: -5, maxY: 10 };
      const res = reflectSweep(
        { x: 0, y: 0 },
        { x: 53, y: 0 },
        [wallRight, wallLeft],
        10,
      );
      expect(res.hits).toHaveLength(5);
      expect(res.expired).toBe(false);
      // total path folds into the [-5,5] corridor; never escapes
      expect(res.end.x).toBeCloseTo(-3, 6);
      expect(res.end.y).toBeCloseTo(0, 9);
      for (const h of res.hits) {
        expect(Math.abs(h.point.x)).toBeLessThanOrEqual(5 + 1e-6);
        expect(Number.isNaN(h.point.x)).toBe(false);
      }
    });
  });
  ```

- [ ] **Step: Run the test to verify it fails**

  `npx vitest run src/sim/collision.test.ts -t "reflectSweep"`

  Expected: FAIL — `reflectSweep is not a function`.

- [ ] **Step: Add vec-helper imports to collision.ts**

  Replace the top import line of `src/sim/collision.ts`:

  ```ts
  import type { Vec2, AABB } from './types';
  ```

  with:

  ```ts
  import type { Vec2, AABB } from './types';
  import { vadd, vsub, vnorm, vdot } from './types';
  ```

- [ ] **Step: Implement `reflectSweep` (+ SweepHit/SweepResult)**

  Append to `src/sim/collision.ts`:

  ```ts
  export interface SweepHit {
    point: Vec2;
    normal: Vec2;
    wallIndex: number;
  }

  export interface SweepResult {
    end: Vec2;
    dir: Vec2;
    bouncesLeft: number;
    hits: SweepHit[];
    expired: boolean;
  }

  const SWEEP_EPS = 1e-7;

  function reflectVec(v: Vec2, n: Vec2): Vec2 {
    const d = vdot(v, n);
    return { x: v.x - 2 * d * n.x, y: v.y - 2 * d * n.y };
  }

  export function reflectSweep(
    from: Vec2,
    to: Vec2,
    walls: AABB[],
    bounces: number,
  ): SweepResult {
    let start: Vec2 = { x: from.x, y: from.y };
    let target: Vec2 = { x: to.x, y: to.y };
    let bouncesLeft = bounces;
    const hits: SweepHit[] = [];

    // Bounded loop: guards against pathological infinite reflection.
    for (let iter = 0; iter < 16; iter++) {
      let best: RayHit | null = null;
      let bestWall = -1;
      for (let i = 0; i < walls.length; i++) {
        const h = raySegmentVsAABB(start, target, walls[i]);
        // Skip t<=EPS so we don't immediately re-hit the wall we just left.
        if (h !== null && h.t > SWEEP_EPS && (best === null || h.t < best.t)) {
          best = h;
          bestWall = i;
        }
      }

      if (best === null) {
        return {
          end: target,
          dir: vnorm(vsub(target, start)),
          bouncesLeft,
          hits,
          expired: false,
        };
      }

      const box = walls[bestWall];
      const pt = best.point;

      if (bouncesLeft <= 0) {
        // Out of bounces: stop dead at the wall; caller kills the bullet.
        return {
          end: pt,
          dir: vnorm(vsub(target, start)),
          bouncesLeft,
          hits,
          expired: true,
        };
      }

      const onX =
        Math.abs(pt.x - box.minX) < SWEEP_EPS || Math.abs(pt.x - box.maxX) < SWEEP_EPS;
      const onY =
        Math.abs(pt.y - box.minY) < SWEEP_EPS || Math.abs(pt.y - box.maxY) < SWEEP_EPS;
      const corner = onX && onY;

      const remaining = vsub(target, pt);
      let reflected: Vec2;

      if (corner) {
        // Exact corner: reflect both axes -> retroreflection, two hit records.
        const nx = Math.abs(pt.x - box.minX) < SWEEP_EPS ? -1 : 1;
        const ny = Math.abs(pt.y - box.minY) < SWEEP_EPS ? -1 : 1;
        hits.push({ point: pt, normal: { x: nx, y: 0 }, wallIndex: bestWall });
        hits.push({ point: pt, normal: { x: 0, y: ny }, wallIndex: bestWall });
        reflected = { x: -remaining.x, y: -remaining.y };
      } else {
        hits.push({ point: pt, normal: best.normal, wallIndex: bestWall });
        reflected = reflectVec(remaining, best.normal);
      }

      bouncesLeft -= 1;
      start = pt;
      target = vadd(pt, reflected);
    }

    return {
      end: target,
      dir: vnorm(vsub(target, start)),
      bouncesLeft,
      hits,
      expired: false,
    };
  }
  ```

- [ ] **Step: Run the test to verify it passes**

  `npx vitest run src/sim/collision.test.ts -t "reflectSweep"`

  Expected: PASS — 5 passing.

- [ ] **Step: Run the whole file to confirm no regressions**

  `npx vitest run src/sim/collision.test.ts`

  Expected: PASS — 18 passing.

- [ ] **Step: Commit**

  `git add src/sim/collision.ts src/sim/collision.test.ts && git commit -m "collision: reflectSweep in-tick multi-bounce with corner double-reflect"`

---

### Task 8: World state, createWorld, cloneWorld, and step skeleton

**Files:**
- Create: `src/sim/world.ts`
- Test: `src/sim/world.test.ts`

**Interfaces:**

Consumes: `Tank`, `Bullet`, `Mine`, `Wall`, `Spawn`, `InputState` (task 2); `SimEvent` (task 4).

Produces:
- `interface World { tick: number; nextId: number; seed: number; tanks: Tank[]; bullets: Bullet[]; mines: Mine[]; walls: Wall[]; spawns: Spawn[]; status: 'playing' | 'win' | 'lose'; lives: number }`
- `function createWorld(init: { walls: Wall[]; tanks: Tank[]; spawns: Spawn[]; lives: number; seed?: number }): World` — takes PRIMITIVES, not an Arena.
- `function cloneWorld(world: World): World` — deep clone of all mutable arrays/objects.
- `interface StepResult { world: World; events: SimEvent[] }`
- `function step(world: World, input: InputState): StepResult` — treats the input world as IMMUTABLE; clones then mutates a draft; returns a fresh World. Skeleton for now: clone, increment tick, return no events.

Steps:

- [ ] **Step: Write the failing test** — create `src/sim/world.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createWorld, cloneWorld, step } from './world';
import type { World } from './world';
import type { Tank, Wall, Spawn, InputState } from './types';

function makeTank(id: number, x: number, y: number): Tank {
  return {
    id,
    kind: 'player',
    pos: { x, y },
    bodyAngle: 0,
    turretAngle: 0,
    alive: true,
    desiredMove: { x: 0, y: 0 },
    activeMineIds: [],
    fireCooldown: 0,
    mineCooldown: 0,
    aiState: 'idle',
    aiTimer: 0,
  };
}

function makeWall(id: number): Wall {
  return { id, aabb: { minX: 0, minY: 0, maxX: 1, maxY: 1 }, kind: 'solid', destroyed: false };
}

function makeWorld(): World {
  const tanks = [makeTank(5, 2, 3)];
  const walls = [makeWall(9)];
  const spawns: Spawn[] = [{ kind: 'player', pos: { x: 2, y: 3 }, angle: 0 }];
  return createWorld({ walls, tanks, spawns, lives: 3 });
}

const noInput: InputState = { move: { x: 0, y: 0 }, aim: { x: 0, y: 0 }, fire: false, mine: false };

describe('createWorld', () => {
  it('starts playing with empty bullet/mine arrays and given lives', () => {
    const w = makeWorld();
    expect(w.status).toBe('playing');
    expect(w.tick).toBe(0);
    expect(w.bullets).toEqual([]);
    expect(w.mines).toEqual([]);
    expect(w.lives).toBe(3);
  });

  it('sets nextId above the highest wall/tank id', () => {
    const w = makeWorld();
    expect(w.nextId).toBe(10); // max(9, 5) + 1
  });
});

describe('cloneWorld', () => {
  it('is a true deep copy', () => {
    const w = makeWorld();
    const c = cloneWorld(w);
    c.tanks[0].pos.x = 999;
    c.walls[0].aabb.minX = 999;
    c.lives = 1;
    expect(w.tanks[0].pos.x).toBe(2);
    expect(w.walls[0].aabb.minX).toBe(0);
    expect(w.lives).toBe(3);
  });
});

describe('step (skeleton)', () => {
  it('returns a NEW deep world, leaving the input untouched', () => {
    const w = makeWorld();
    const result = step(w, noInput);
    expect(result.world).not.toBe(w);
    result.world.tanks[0].pos.x = 777;
    expect(w.tanks[0].pos.x).toBe(2);
    expect(result.events).toEqual([]);
  });

  it('increments tick each call', () => {
    let w = makeWorld();
    w = step(w, noInput).world;
    expect(w.tick).toBe(1);
    w = step(w, noInput).world;
    expect(w.tick).toBe(2);
  });

  it('is deterministic: identical worlds + input give identical results', () => {
    const a = step(makeWorld(), noInput).world;
    const b = step(makeWorld(), noInput).world;
    expect(a).toEqual(b);
  });
});
```

- [ ] **Step: Run the test to verify it fails**
  - Command: `npx vitest run src/sim/world.test.ts`
  - Expected: FAIL — `Cannot find module './world'` (module not created yet).

- [ ] **Step: Implement minimal code to pass** — create `src/sim/world.ts`:

```ts
import type { Tank, Bullet, Mine, Wall, Spawn, InputState } from './types';
import type { SimEvent } from './events';

export interface World {
  tick: number;
  nextId: number;
  seed: number;
  tanks: Tank[];
  bullets: Bullet[];
  mines: Mine[];
  walls: Wall[];
  spawns: Spawn[];
  status: 'playing' | 'win' | 'lose';
  lives: number;
}

export interface StepResult {
  world: World;
  events: SimEvent[];
}

export function createWorld(init: {
  walls: Wall[];
  tanks: Tank[];
  spawns: Spawn[];
  lives: number;
  seed?: number;
}): World {
  const maxId = Math.max(
    0,
    ...init.walls.map((w) => w.id),
    ...init.tanks.map((t) => t.id),
  );
  return {
    tick: 0,
    nextId: maxId + 1,
    seed: init.seed ?? 1,
    tanks: init.tanks,
    bullets: [],
    mines: [],
    walls: init.walls,
    spawns: init.spawns,
    status: 'playing',
    lives: init.lives,
  };
}

function cloneTank(t: Tank): Tank {
  return {
    ...t,
    pos: { ...t.pos },
    desiredMove: { ...t.desiredMove },
    activeMineIds: [...t.activeMineIds],
  };
}

export function cloneWorld(world: World): World {
  return {
    tick: world.tick,
    nextId: world.nextId,
    seed: world.seed,
    status: world.status,
    lives: world.lives,
    tanks: world.tanks.map(cloneTank),
    bullets: world.bullets.map((b) => ({ ...b, pos: { ...b.pos }, vel: { ...b.vel } })),
    mines: world.mines.map((m) => ({ ...m, pos: { ...m.pos } })),
    walls: world.walls.map((w) => ({ ...w, aabb: { ...w.aabb } })),
    spawns: world.spawns.map((s) => ({ ...s, pos: { ...s.pos } })),
  };
}

// Skeleton. Update calls (movement, AI, bullets, mines, status) are inserted in a
// fixed order by tasks 9-15 and 22. CONTRACT: input world is immutable; we clone a
// draft, mutate the draft, and return it, so render can keep prev/curr distinct.
export function step(world: World, _input: InputState): StepResult {
  const draft = cloneWorld(world);
  draft.tick += 1;
  return { world: draft, events: [] };
}
```

- [ ] **Step: Run the test to verify it passes**
  - Command: `npx vitest run src/sim/world.test.ts`
  - Expected: PASS.

- [ ] **Step: Commit**
  - `git add src/sim/world.ts src/sim/world.test.ts && git commit -m "Add World state, createWorld, cloneWorld, and step skeleton"`

---

### Task 9: Tank movement — input-driven drive, wall slide, tank separation

**Files:**
- Modify: `src/sim/collision.ts`, `src/sim/world.ts`
- Test: `src/sim/movement.test.ts`

**Interfaces:**

Consumes: `Tank`, `Wall`, `Vec2`, `WallKind`, `AABB`, vec helpers `vadd`, `vsub`, `vscale`, `vlen`, `angleOf`, `vdist` (task 2); `circleVsAABB`, `circleVsCircle`, `Hit` (task 5); `World`, `createWorld` (task 8); `TANK_RADIUS`, `TANK_SPEED`, `DT` (task 3).

Produces (in `collision.ts`):
- `function moveTank(tank: Tank, walls: Wall[], dt: number): void` — advances by `tank.desiredMove` (clamped to unit) `* TANK_SPEED * dt`, resolves circle-vs-AABB against every non-destroyed wall by sliding (push out along MTV), and sets `tank.bodyAngle` from movement direction when moving.
- `function separateTanks(tanks: Tank[]): void` — circle-vs-circle push-apart of overlapping alive tanks.

Produces (in `world.ts`):
- `function stepMovement(world: World, dt: number): void` — moves every alive tank by its desiredMove, resolves walls, then separates; wired into `step()` before bullets.

**Steps:**

- [ ] **Step: Write the failing test for `moveTank` and `separateTanks`**

  Create `src/sim/movement.test.ts`:

  ```ts
  import { describe, it, expect } from 'vitest';
  import { moveTank, separateTanks, circleVsAABB } from './collision';
  import { stepMovement } from './world';
  import { createWorld } from './world';
  import { TANK_RADIUS, DT } from './constants';
  import { vdist } from './types';
  import type { Tank, Wall, AABB, WallKind } from './types';

  function makeTank(overrides: Partial<Tank>): Tank {
    return {
      id: 0,
      kind: 'player',
      pos: { x: 0, y: 0 },
      bodyAngle: 0,
      turretAngle: 0,
      alive: true,
      desiredMove: { x: 0, y: 0 },
      activeMineIds: [],
      fireCooldown: 0,
      mineCooldown: 0,
      aiState: 'idle',
      aiTimer: 0,
      ...overrides,
    };
  }

  function makeWall(id: number, aabb: AABB, kind: WallKind = 'solid'): Wall {
    return { id, aabb, kind, destroyed: false };
  }

  // A tall wall occupying x in [1, 3].
  const WALL: Wall = makeWall(1, { minX: 1, minY: -5, maxX: 3, maxY: 5 });

  describe('moveTank', () => {
    it('slides along an axis-aligned wall on a diagonal drive (keeps tangential motion, zero penetration)', () => {
      const tank = makeTank({ pos: { x: 0.9, y: 0 }, desiredMove: { x: 1, y: 1 } });
      moveTank(tank, [WALL], DT);
      // right edge resolves to exactly the wall face
      expect(tank.pos.x + TANK_RADIUS).toBeCloseTo(WALL.aabb.minX, 9);
      // tangential (y) motion is retained
      expect(tank.pos.y).toBeGreaterThan(0);
      // no residual penetration
      expect(circleVsAABB(tank.pos, TANK_RADIUS, WALL.aabb).hit).toBe(false);
    });

    it('stops with no overlap when driving straight into a wall', () => {
      const tank = makeTank({ pos: { x: 0.9, y: 0 }, desiredMove: { x: 1, y: 0 } });
      moveTank(tank, [WALL], DT);
      expect(tank.pos.x + TANK_RADIUS).toBeCloseTo(WALL.aabb.minX, 9);
      expect(tank.pos.y).toBeCloseTo(0, 9);
      expect(circleVsAABB(tank.pos, TANK_RADIUS, WALL.aabb).hit).toBe(false);
    });

    it('produces zero drift and leaves bodyAngle unchanged when desiredMove is zero', () => {
      const tank = makeTank({ pos: { x: 0, y: 0 }, desiredMove: { x: 0, y: 0 }, bodyAngle: 1.23 });
      moveTank(tank, [], DT);
      expect(tank.pos).toEqual({ x: 0, y: 0 });
      expect(tank.bodyAngle).toBe(1.23);
    });

    it('sets bodyAngle to the movement direction when moving', () => {
      const tank = makeTank({ desiredMove: { x: 0, y: 1 } });
      moveTank(tank, [], DT);
      expect(tank.bodyAngle).toBeCloseTo(Math.PI / 2, 9);
    });
  });

  describe('separateTanks', () => {
    it('pushes two overlapping tanks apart to non-overlapping', () => {
      const a = makeTank({ id: 1, pos: { x: 0, y: 0 } });
      const b = makeTank({ id: 2, pos: { x: 0.5, y: 0 } });
      separateTanks([a, b]);
      expect(vdist(a.pos, b.pos)).toBeGreaterThanOrEqual(2 * TANK_RADIUS - 1e-9);
    });

    it('ignores dead tanks', () => {
      const a = makeTank({ id: 1, pos: { x: 0, y: 0 }, alive: false });
      const b = makeTank({ id: 2, pos: { x: 0.5, y: 0 } });
      separateTanks([a, b]);
      expect(a.pos).toEqual({ x: 0, y: 0 });
      expect(b.pos).toEqual({ x: 0.5, y: 0 });
    });
  });

  describe('stepMovement', () => {
    it('moves alive tanks by desiredMove and separates overlaps', () => {
      const a = makeTank({ id: 1, pos: { x: 0, y: 0 }, desiredMove: { x: 1, y: 0 } });
      const b = makeTank({ id: 2, pos: { x: 0.4, y: 0 } });
      const world = createWorld({ walls: [], tanks: [a, b], spawns: [], lives: 3 });
      stepMovement(world, DT);
      expect(vdist(world.tanks[0].pos, world.tanks[1].pos)).toBeGreaterThanOrEqual(
        2 * TANK_RADIUS - 1e-9,
      );
    });

    it('does not move dead tanks', () => {
      const dead = makeTank({ id: 1, pos: { x: 0, y: 0 }, alive: false, desiredMove: { x: 1, y: 0 } });
      const world = createWorld({ walls: [], tanks: [dead], spawns: [], lives: 3 });
      stepMovement(world, DT);
      expect(world.tanks[0].pos).toEqual({ x: 0, y: 0 });
    });
  });
  ```

- [ ] **Step: Run the test to verify it fails**

  `npx vitest run src/sim/movement.test.ts`

  Expected: FAIL — `moveTank is not a function` / `stepMovement is not a function` (not implemented yet).

- [ ] **Step: Extend collision.ts imports for movement**

  Replace the import block at the top of `src/sim/collision.ts`:

  ```ts
  import type { Vec2, AABB } from './types';
  import { vadd, vsub, vnorm, vdot } from './types';
  ```

  with:

  ```ts
  import type { Vec2, AABB, Tank, Wall } from './types';
  import { vadd, vsub, vscale, vlen, vnorm, vdot, angleOf } from './types';
  import { TANK_RADIUS, TANK_SPEED } from './constants';
  ```

- [ ] **Step: Implement `moveTank` and `separateTanks`**

  Append to `src/sim/collision.ts`:

  ```ts
  export function moveTank(tank: Tank, walls: Wall[], dt: number): void {
    let move = tank.desiredMove;
    const mlen = vlen(move);
    // clamp the drive vector to unit length (diagonals aren't faster)
    if (mlen > 1) move = vscale(move, 1 / mlen);

    tank.pos = vadd(tank.pos, vscale(move, TANK_SPEED * dt));
    if (mlen > 0) tank.bodyAngle = angleOf(move);

    // slide: resolve penetration against every non-destroyed wall
    for (const wall of walls) {
      if (wall.destroyed) continue;
      const hit = circleVsAABB(tank.pos, TANK_RADIUS, wall.aabb);
      if (hit.hit) tank.pos = vadd(tank.pos, hit.push);
    }
  }

  export function separateTanks(tanks: Tank[]): void {
    for (let i = 0; i < tanks.length; i++) {
      for (let j = i + 1; j < tanks.length; j++) {
        const a = tanks[i];
        const b = tanks[j];
        if (!a.alive || !b.alive) continue;
        const hit = circleVsCircle(a.pos, TANK_RADIUS, b.pos, TANK_RADIUS);
        if (hit.hit) {
          // push apart symmetrically (push separates a from b)
          a.pos = vadd(a.pos, vscale(hit.push, 0.5));
          b.pos = vsub(b.pos, vscale(hit.push, 0.5));
        }
      }
    }
  }
  ```

- [ ] **Step: Add `stepMovement` to world.ts and wire it into `step()`**

  Add these imports near the top of `src/sim/world.ts`:

  ```ts
  import { moveTank, separateTanks } from './collision';
  import { DT } from './constants';
  ```

  Add the `stepMovement` function:

  ```ts
  export function stepMovement(world: World, dt: number): void {
    for (const tank of world.tanks) {
      if (!tank.alive) continue;
      moveTank(tank, world.walls, dt);
    }
    separateTanks(world.tanks);
  }
  ```

  Then wire it into the existing `step()` body (task 8's skeleton clones the draft and increments `tick`). Insert the `stepMovement` call before the return so movement runs before bullets (later tasks add AI/bullets/mines around it):

  ```ts
  export function step(world: World, input: InputState): StepResult {
    const draft = cloneWorld(world);
    draft.tick += 1;
    const events: SimEvent[] = [];
    stepMovement(draft, DT);
    return { world: draft, events };
  }
  ```

- [ ] **Step: Run the test to verify it passes**

  `npx vitest run src/sim/movement.test.ts`

  Expected: PASS — 8 passing.

- [ ] **Step: Run the collision + world suites to confirm no regressions**

  `npx vitest run src/sim/collision.test.ts src/sim/world.test.ts src/sim/movement.test.ts`

  Expected: PASS — all suites green (18 collision + task-8 world tests + 8 movement).

- [ ] **Step: Commit**

  `git add src/sim/collision.ts src/sim/world.ts src/sim/movement.test.ts && git commit -m "movement: moveTank wall-slide, separateTanks, stepMovement wired into step"`

---

### Task 10: Bullets — spawn, swept movement/bounce, and caps

**Files:**
- Create: `src/sim/bullets.ts`
- Create: `src/sim/bullets.test.ts`
- Test: `src/sim/bullets.test.ts`

**Interfaces:**

Consumes:
- `Bullet`, `BulletType`, `Vec2`, `fromAngle(r: number): Vec2`, `vscale(a: Vec2, s: number): Vec2`, `vadd(a: Vec2, b: Vec2): Vec2`, `vlen(a: Vec2): number` (task 2)
- `reflectSweep(from: Vec2, to: Vec2, walls: AABB[], bounces: number): SweepResult` where `SweepResult { end: Vec2; dir: Vec2; bouncesLeft: number; hits: SweepHit[]; expired: boolean }` and `SweepHit { point: Vec2; normal: Vec2; wallIndex: number }` (task 7)
- `World`, `createWorld`, `cloneWorld` (task 8)
- `SimEvent` (task 4)
- `bulletConfig: Record<BulletType, { speed: number; bounces: number }>`, `BULLET_RADIUS`, `PLAYER_SHELL_CAP`, `NORMAL_SPEED`, `RICOCHET_SPEED`, `DT` (task 3)

Produces:
- `function ownerShellCount(world: World, ownerId: number): number` — count of that owner's live bullets.
- `function spawnBullet(world: World, ownerId: number, angle: number, type: BulletType, events: SimEvent[]): boolean` — enforces `PLAYER_SHELL_CAP` only for a `player`-kind owner; returns `false` and spawns nothing if capped; on success creates a `Bullet` with speed/bouncesLeft from `bulletConfig`, pushes a `fire` event, returns `true`.
- `function stepBullets(world: World, dt: number, events: SimEvent[]): void` — for each live bullet, `to = pos + vel*dt`, runs `reflectSweep` against every non-destroyed wall AABB, updates `pos`/`vel`/`bouncesLeft` from the `SweepResult`, emits a `ricochet` event per `SweepHit`, and kills the bullet when `SweepResult.expired`.

> Note: step() wiring (calling `stepBullets` inside `step`) is finalized in Task 15. These functions are unit-tested directly here on hand-built worlds.

**Steps:**

- [ ] **Step: Write the failing test file** (`src/sim/bullets.test.ts`)

```ts
import { describe, it, expect } from 'vitest'
import { createWorld } from './world'
import { spawnBullet, ownerShellCount, stepBullets } from './bullets'
import type { SimEvent } from './events'
import type { Tank, TankKind, Vec2, AABB, Wall, WallKind, Bullet } from './types'
import {
  PLAYER_SHELL_CAP,
  NORMAL_SPEED,
  RICOCHET_SPEED,
  DT,
  bulletConfig,
} from './constants'

function mkTank(p: Partial<Tank> & { id: number; kind: TankKind; pos: Vec2 }): Tank {
  return {
    id: p.id,
    kind: p.kind,
    pos: p.pos,
    bodyAngle: p.bodyAngle ?? 0,
    turretAngle: p.turretAngle ?? 0,
    alive: p.alive ?? true,
    desiredMove: p.desiredMove ?? { x: 0, y: 0 },
    activeMineIds: p.activeMineIds ?? [],
    fireCooldown: p.fireCooldown ?? 0,
    mineCooldown: p.mineCooldown ?? 0,
    aiState: p.aiState ?? 'idle',
    aiTimer: p.aiTimer ?? 0,
  }
}

function mkWall(id: number, aabb: AABB, kind: WallKind = 'solid'): Wall {
  return { id, aabb, kind, destroyed: false }
}

describe('spawnBullet + ownerShellCount', () => {
  it("rejects the player's 6th concurrent shell while 5 are live", () => {
    const player = mkTank({ id: 1, kind: 'player', pos: { x: 0, y: 0 } })
    const world = createWorld({ walls: [], tanks: [player], spawns: [], lives: 3 })
    const events: SimEvent[] = []
    for (let i = 0; i < PLAYER_SHELL_CAP; i++) {
      expect(spawnBullet(world, 1, 0, 'normal', events)).toBe(true)
    }
    expect(ownerShellCount(world, 1)).toBe(PLAYER_SHELL_CAP)
    expect(spawnBullet(world, 1, 0, 'normal', events)).toBe(false)
    expect(ownerShellCount(world, 1)).toBe(PLAYER_SHELL_CAP)
  })

  it('does not cap enemy shells', () => {
    const brown = mkTank({ id: 2, kind: 'brown', pos: { x: 0, y: 0 } })
    const world = createWorld({ walls: [], tanks: [brown], spawns: [], lives: 3 })
    const events: SimEvent[] = []
    for (let i = 0; i < PLAYER_SHELL_CAP + 3; i++) {
      expect(spawnBullet(world, 2, 0, 'normal', events)).toBe(true)
    }
    expect(ownerShellCount(world, 2)).toBe(PLAYER_SHELL_CAP + 3)
  })

  it('spawns a bullet with config speed/bounces and emits a fire event', () => {
    const player = mkTank({ id: 1, kind: 'player', pos: { x: 2, y: 3 } })
    const world = createWorld({ walls: [], tanks: [player], spawns: [], lives: 3 })
    const events: SimEvent[] = []
    expect(spawnBullet(world, 1, 0, 'normal', events)).toBe(true)
    const b = world.bullets[0]
    expect(b.ownerId).toBe(1)
    expect(b.type).toBe('normal')
    expect(b.bouncesLeft).toBe(bulletConfig.normal.bounces)
    expect(b.pos).toEqual({ x: 2, y: 3 })
    expect(b.vel.x).toBeCloseTo(NORMAL_SPEED, 6)
    expect(b.vel.y).toBeCloseTo(0, 6)
    const fire = events.find((e) => e.type === 'fire')
    expect(fire).toMatchObject({ type: 'fire', ownerId: 1, bulletType: 'normal', angle: 0 })
  })
})

describe('stepBullets', () => {
  it('a normal shell survives exactly one bounce and dies on the second wall hit', () => {
    const walls: Wall[] = [mkWall(1, { minX: 2, minY: -5, maxX: 3, maxY: 5 })]
    const world = createWorld({ walls, tanks: [], spawns: [], lives: 3 })
    const b: Bullet = {
      id: 10,
      ownerId: 1,
      type: 'normal',
      pos: { x: 1.9, y: 0 },
      vel: { x: NORMAL_SPEED, y: 0 },
      bouncesLeft: bulletConfig.normal.bounces,
      alive: true,
    }
    world.bullets.push(b)
    // first hit: travel 0.3 crosses the x=2 face and bounces once
    stepBullets(world, 0.05, [])
    expect(b.alive).toBe(true)
    expect(b.bouncesLeft).toBe(0)
    expect(b.vel.x).toBeLessThan(0)
    // send it into a wall again with no bounces left -> dies
    b.pos = { x: 1.9, y: 0 }
    b.vel = { x: NORMAL_SPEED, y: 0 }
    stepBullets(world, 0.05, [])
    expect(b.alive).toBe(false)
  })

  it('a shell fired at a boundary wall bounces back inward instead of leaving the arena', () => {
    const walls: Wall[] = [mkWall(1, { minX: 5, minY: -10, maxX: 6, maxY: 10 })]
    const world = createWorld({ walls, tanks: [], spawns: [], lives: 3 })
    const b: Bullet = {
      id: 1,
      ownerId: 1,
      type: 'ricochet',
      pos: { x: 4.8, y: 0 },
      vel: { x: RICOCHET_SPEED, y: 0 },
      bouncesLeft: bulletConfig.ricochet.bounces,
      alive: true,
    }
    world.bullets.push(b)
    stepBullets(world, 0.1, [])
    expect(b.vel.x).toBeLessThan(0)
    expect(b.pos.x).toBeLessThan(5)
  })

  it('emits a ricochet event per bounce with increasing bounceIndex in a single tick (corner double-reflect)', () => {
    const walls: Wall[] = [mkWall(1, { minX: 1, minY: 1, maxX: 3, maxY: 3 })]
    const world = createWorld({ walls, tanks: [], spawns: [], lives: 3 })
    const s = Math.SQRT1_2
    const b: Bullet = {
      id: 1,
      ownerId: 1,
      type: 'ricochet',
      pos: { x: 0, y: 0 },
      vel: { x: RICOCHET_SPEED * s, y: RICOCHET_SPEED * s },
      bouncesLeft: 3,
      alive: true,
    }
    world.bullets.push(b)
    const events: SimEvent[] = []
    stepBullets(world, 1, events) // big dt so it reaches the (1,1) corner this tick
    const ric = events.filter((e) => e.type === 'ricochet') as Extract<
      SimEvent,
      { type: 'ricochet' }
    >[]
    expect(ric.length).toBe(2)
    expect(ric[0].bounceIndex).toBe(0)
    expect(ric[1].bounceIndex).toBe(1)
  })

  it('is deterministic across identical steps', () => {
    const makeWorld = () => {
      const walls: Wall[] = [mkWall(1, { minX: 3, minY: -5, maxX: 4, maxY: 5 })]
      const w = createWorld({ walls, tanks: [], spawns: [], lives: 3 })
      w.bullets.push({
        id: 1,
        ownerId: 1,
        type: 'ricochet',
        pos: { x: 0, y: 0 },
        vel: { x: RICOCHET_SPEED, y: 0.3 },
        bouncesLeft: 3,
        alive: true,
      })
      return w
    }
    const a = makeWorld()
    const b = makeWorld()
    for (let i = 0; i < 30; i++) {
      stepBullets(a, DT, [])
      stepBullets(b, DT, [])
    }
    expect(a.bullets).toEqual(b.bullets)
  })
})
```

- [ ] **Step: Run the test to verify it fails**

`npx vitest run src/sim/bullets.test.ts`

Expected: FAIL — `Failed to resolve import "./bullets"` (module `src/sim/bullets.ts` does not exist yet).

- [ ] **Step: Implement minimal code to pass** (`src/sim/bullets.ts`)

```ts
import type { Bullet, BulletType, Vec2 } from './types'
import { fromAngle, vscale, vadd, vlen } from './types'
import { reflectSweep } from './collision'
import type { World } from './world'
import type { SimEvent } from './events'
import { bulletConfig, PLAYER_SHELL_CAP } from './constants'

export function ownerShellCount(world: World, ownerId: number): number {
  let n = 0
  for (const b of world.bullets) {
    if (b.alive && b.ownerId === ownerId) n++
  }
  return n
}

export function spawnBullet(
  world: World,
  ownerId: number,
  angle: number,
  type: BulletType,
  events: SimEvent[],
): boolean {
  const owner = world.tanks.find((t) => t.id === ownerId)
  if (!owner) return false
  if (owner.kind === 'player' && ownerShellCount(world, ownerId) >= PLAYER_SHELL_CAP) {
    return false
  }
  const cfg = bulletConfig[type]
  const pos: Vec2 = { x: owner.pos.x, y: owner.pos.y }
  const bullet: Bullet = {
    id: world.nextId++,
    ownerId,
    type,
    pos,
    vel: vscale(fromAngle(angle), cfg.speed),
    bouncesLeft: cfg.bounces,
    alive: true,
  }
  world.bullets.push(bullet)
  events.push({ type: 'fire', ownerId, bulletType: type, pos: { x: pos.x, y: pos.y }, angle })
  return true
}

export function stepBullets(world: World, dt: number, events: SimEvent[]): void {
  const wallAABBs = world.walls.filter((w) => !w.destroyed).map((w) => w.aabb)
  for (const b of world.bullets) {
    if (!b.alive) continue
    const speed = vlen(b.vel)
    const to = vadd(b.pos, vscale(b.vel, dt))
    const result = reflectSweep(b.pos, to, wallAABBs, b.bouncesLeft)
    for (let i = 0; i < result.hits.length; i++) {
      const p = result.hits[i].point
      events.push({ type: 'ricochet', pos: { x: p.x, y: p.y }, bounceIndex: i })
    }
    b.pos = result.end
    b.vel = vscale(result.dir, speed)
    b.bouncesLeft = result.bouncesLeft
    if (result.expired) b.alive = false
  }
}
```

- [ ] **Step: Run the test to verify it passes**

`npx vitest run src/sim/bullets.test.ts`

Expected: PASS — `Test Files 1 passed`, `8 passed`.

- [ ] **Step: Commit**

```bash
git add src/sim/bullets.ts src/sim/bullets.test.ts && git commit -m "Add bullet spawn, swept movement/bounce, and shell cap"
```

---

### Task 11: Bullet types — normal / fast / ricochet behavior

**Files:**
- Modify: `src/sim/bullets.ts`
- Test: `src/sim/bullets.test.ts`

**Interfaces:**

Consumes:
- `bulletConfig: Record<BulletType, { speed: number; bounces: number }>`, `FAST_SPEED`, `NORMAL_SPEED`, `RICOCHET_SPEED`, `RICOCHET_BOUNCES`, `DT` (task 3)
- `spawnBullet`, `stepBullets` (task 10)

Produces: no new signatures — parameterizes spawn/step by `bulletConfig[type]` so fast shells get `FAST_SPEED`/`FAST_BOUNCES` (0, die on first wall), ricochet shells get `RICOCHET_SPEED`/`RICOCHET_BOUNCES` (3), and normal gets 1 bounce. Upgrades `stepBullets` so each `ricochet` event's `bounceIndex` increases monotonically across the bullet's whole life (not reset per tick), which downstream audio (Task 30) uses to pitch-shift successive pings.

> **Deferral note (spec §4 vs §7):** the `fast`/rocket type is fully implemented and unit-tested here, but no tank in the slice roster fires it — per spec §7 the slice enemies are Brown/Grey (normal) and Teal (ricochet), and reassigning `fast` would contradict that roster. `fast` is intentionally defined-but-deferred, ready for a future enemy variant without touching the bullet system. Do not treat its absence from live play as a gap.

**Steps:**

- [ ] **Step: Write the failing test — cross-tick monotonic bounceIndex** (append a new `describe` block to `src/sim/bullets.test.ts`)

Add these constants to the existing `constants` import at the top of the file: `FAST_SPEED`, `RICOCHET_BOUNCES`. Then append:

```ts
describe('bullet types', () => {
  it('increments bounceIndex across ticks so ricochet audio can pitch-shift per bounce', () => {
    const walls: Wall[] = [mkWall(1, { minX: 2, minY: -5, maxX: 3, maxY: 5 })]
    const world = createWorld({ walls, tanks: [], spawns: [], lives: 3 })
    const b: Bullet = {
      id: 1,
      ownerId: 1,
      type: 'ricochet',
      pos: { x: 1.95, y: 0 },
      vel: { x: RICOCHET_SPEED, y: 0 },
      bouncesLeft: bulletConfig.ricochet.bounces,
      alive: true,
    }
    world.bullets.push(b)
    const indices: number[] = []
    for (let k = 0; k < 3; k++) {
      // re-present the bullet at the wall each tick to force one bounce per tick
      b.pos = { x: 1.95, y: 0 }
      b.vel = { x: RICOCHET_SPEED, y: 0 }
      const events: SimEvent[] = []
      stepBullets(world, DT, events)
      const ric = events.filter((e) => e.type === 'ricochet') as Extract<
        SimEvent,
        { type: 'ricochet' }
      >[]
      expect(ric.length).toBe(1)
      indices.push(ric[0].bounceIndex)
    }
    expect(indices).toEqual([0, 1, 2])
  })

  it('a fast shell dies on the first wall hit with no bounce and emits no ricochet', () => {
    const walls: Wall[] = [mkWall(1, { minX: 2, minY: -5, maxX: 3, maxY: 5 })]
    const world = createWorld({ walls, tanks: [], spawns: [], lives: 3 })
    const b: Bullet = {
      id: 1,
      ownerId: 1,
      type: 'fast',
      pos: { x: 1.9, y: 0 },
      vel: { x: FAST_SPEED, y: 0 },
      bouncesLeft: bulletConfig.fast.bounces,
      alive: true,
    }
    world.bullets.push(b)
    const events: SimEvent[] = []
    stepBullets(world, 0.05, events) // travel 0.6 -> crosses x=2
    expect(bulletConfig.fast.bounces).toBe(0)
    expect(b.alive).toBe(false)
    expect(events.filter((e) => e.type === 'ricochet').length).toBe(0)
  })

  it('a fast shell travels farther per tick than a normal shell (no tunneling)', () => {
    const world = createWorld({ walls: [], tanks: [], spawns: [], lives: 3 })
    const normal: Bullet = {
      id: 1,
      ownerId: 1,
      type: 'normal',
      pos: { x: 0, y: 0 },
      vel: { x: NORMAL_SPEED, y: 0 },
      bouncesLeft: bulletConfig.normal.bounces,
      alive: true,
    }
    const fast: Bullet = {
      id: 2,
      ownerId: 1,
      type: 'fast',
      pos: { x: 0, y: 0 },
      vel: { x: FAST_SPEED, y: 0 },
      bouncesLeft: bulletConfig.fast.bounces,
      alive: true,
    }
    world.bullets.push(normal, fast)
    stepBullets(world, DT, [])
    expect(fast.pos.x).toBeGreaterThan(normal.pos.x)
  })

  it('a ricochet shell survives exactly RICOCHET_BOUNCES wall hits then dies', () => {
    const walls: Wall[] = [mkWall(1, { minX: 2, minY: -5, maxX: 3, maxY: 5 })]
    const world = createWorld({ walls, tanks: [], spawns: [], lives: 3 })
    const b: Bullet = {
      id: 1,
      ownerId: 1,
      type: 'ricochet',
      pos: { x: 1.9, y: 0 },
      vel: { x: RICOCHET_SPEED, y: 0 },
      bouncesLeft: bulletConfig.ricochet.bounces,
      alive: true,
    }
    world.bullets.push(b)
    for (let k = 0; k < RICOCHET_BOUNCES; k++) {
      b.pos = { x: 1.9, y: 0 }
      b.vel = { x: RICOCHET_SPEED, y: 0 }
      stepBullets(world, 0.05, [])
      expect(b.alive).toBe(true)
    }
    expect(b.bouncesLeft).toBe(0)
    b.pos = { x: 1.9, y: 0 }
    b.vel = { x: RICOCHET_SPEED, y: 0 }
    stepBullets(world, 0.05, [])
    expect(b.alive).toBe(false)
  })
})
```

- [ ] **Step: Run the test to verify it fails**

`npx vitest run src/sim/bullets.test.ts -t "increments bounceIndex across ticks"`

Expected: FAIL — `expected [ 0, 0, 0 ] to deeply equal [ 0, 1, 2 ]`. Task 10's `stepBullets` emits `bounceIndex: i` (reset each tick); the fast/ricochet coverage tests already pass because `stepBullets` is `bulletConfig`-driven, but this monotonic-across-ticks assertion does not.

- [ ] **Step: Implement — make bounceIndex monotonic per bullet** (edit `stepBullets` in `src/sim/bullets.ts`)

Replace the existing `stepBullets` body loop so it offsets the per-tick hit index by the bounces already consumed. Add `bulletConfig` is already imported; change the function to:

```ts
export function stepBullets(world: World, dt: number, events: SimEvent[]): void {
  const wallAABBs = world.walls.filter((w) => !w.destroyed).map((w) => w.aabb)
  for (const b of world.bullets) {
    if (!b.alive) continue
    const speed = vlen(b.vel)
    const consumedBefore = bulletConfig[b.type].bounces - b.bouncesLeft
    const to = vadd(b.pos, vscale(b.vel, dt))
    const result = reflectSweep(b.pos, to, wallAABBs, b.bouncesLeft)
    for (let i = 0; i < result.hits.length; i++) {
      const p = result.hits[i].point
      events.push({ type: 'ricochet', pos: { x: p.x, y: p.y }, bounceIndex: consumedBefore + i })
    }
    b.pos = result.end
    b.vel = vscale(result.dir, speed)
    b.bouncesLeft = result.bouncesLeft
    if (result.expired) b.alive = false
  }
}
```

- [ ] **Step: Run the test to verify it passes**

`npx vitest run src/sim/bullets.test.ts`

Expected: PASS — `Test Files 1 passed`, `12 passed` (the earlier single-tick corner test still yields `[0, 1]` because `consumedBefore` is `0` on that tick).

- [ ] **Step: Commit**

```bash
git add src/sim/bullets.ts src/sim/bullets.test.ts && git commit -m "Parameterize bullet types and make ricochet bounceIndex monotonic"
```

---

### Task 12: Bullet-vs-tank one-hit resolution

**Files:**
- Modify: `src/sim/bullets.ts`
- Test: `src/sim/bullets.test.ts`

**Interfaces:**

Consumes:
- `circleVsCircle(a: Vec2, ra: number, b: Vec2, rb: number): Hit` where `Hit { hit: boolean; push: Vec2 }` (task 5)
- `vsub(a: Vec2, b: Vec2): Vec2`, `vdot(a: Vec2, b: Vec2): number` (task 2)
- `World`, `Bullet`, `Tank` (task 2/8)
- `SimEvent` (task 4)
- `TANK_RADIUS`, `BULLET_RADIUS` (task 3)

Produces:
- `function resolveBulletHits(world: World, events: SimEvent[]): void` — for each live bullet overlapping any alive tank (circle-vs-circle), sets the tank `alive:false` and the bullet `alive:false`, and emits `tank-destroyed` (with `kind`/`pos`) plus `explosion`. One hit kills any tank (player or enemy). A bullet may kill its own owner via a ricochet return (heading back toward the owner) but never on the tick it spawns inside its own muzzle (still heading away).

> Note: step() wiring (calling `resolveBulletHits` after `stepBullets`) is finalized in Task 15.

**Steps:**

- [ ] **Step: Write the failing tests** (append a new `describe` block to `src/sim/bullets.test.ts`)

Add `resolveBulletHits` to the existing import from `./bullets`. Then append:

```ts
describe('resolveBulletHits', () => {
  it('a bullet overlapping an enemy destroys it and emits tank-destroyed + explosion', () => {
    const player = mkTank({ id: 1, kind: 'player', pos: { x: 5, y: 5 } })
    const enemy = mkTank({ id: 2, kind: 'brown', pos: { x: 0.5, y: 0 } })
    const world = createWorld({ walls: [], tanks: [player, enemy], spawns: [], lives: 3 })
    const b: Bullet = {
      id: 10,
      ownerId: 1,
      type: 'normal',
      pos: { x: 0.1, y: 0 },
      vel: { x: NORMAL_SPEED, y: 0 },
      bouncesLeft: 1,
      alive: true,
    }
    world.bullets.push(b)
    const events: SimEvent[] = []
    resolveBulletHits(world, events)
    expect(enemy.alive).toBe(false)
    expect(b.alive).toBe(false)
    expect(events.find((e) => e.type === 'tank-destroyed')).toMatchObject({
      type: 'tank-destroyed',
      tankId: 2,
      kind: 'brown',
    })
    expect(events.some((e) => e.type === 'explosion')).toBe(true)
  })

  it('a bullet overlapping the player destroys the player (one-hit death applies to the player too)', () => {
    const player = mkTank({ id: 1, kind: 'player', pos: { x: 0, y: 0 } })
    const enemy = mkTank({ id: 2, kind: 'brown', pos: { x: 9, y: 9 } })
    const world = createWorld({ walls: [], tanks: [player, enemy], spawns: [], lives: 3 })
    const b: Bullet = {
      id: 10,
      ownerId: 2,
      type: 'normal',
      pos: { x: 0.3, y: 0 },
      vel: { x: -NORMAL_SPEED, y: 0 },
      bouncesLeft: 1,
      alive: true,
    }
    world.bullets.push(b)
    resolveBulletHits(world, [])
    expect(player.alive).toBe(false)
  })

  it('a bullet that misses leaves tanks alive', () => {
    const enemy = mkTank({ id: 2, kind: 'brown', pos: { x: 0, y: 0 } })
    const world = createWorld({ walls: [], tanks: [enemy], spawns: [], lives: 3 })
    const b: Bullet = {
      id: 10,
      ownerId: 1,
      type: 'normal',
      pos: { x: 3, y: 3 },
      vel: { x: NORMAL_SPEED, y: 0 },
      bouncesLeft: 1,
      alive: true,
    }
    world.bullets.push(b)
    resolveBulletHits(world, [])
    expect(enemy.alive).toBe(true)
    expect(b.alive).toBe(true)
  })

  it('does not self-destruct in the muzzle but can self-hit on a ricochet return', () => {
    const player = mkTank({ id: 1, kind: 'player', pos: { x: 0, y: 0 } })
    const world = createWorld({ walls: [], tanks: [player], spawns: [], lives: 3 })
    // freshly fired: bullet at the muzzle heading away -> no self hit
    const outbound: Bullet = {
      id: 10,
      ownerId: 1,
      type: 'normal',
      pos: { x: 0, y: 0 },
      vel: { x: NORMAL_SPEED, y: 0 },
      bouncesLeft: 1,
      alive: true,
    }
    world.bullets.push(outbound)
    resolveBulletHits(world, [])
    expect(player.alive).toBe(true)
    expect(outbound.alive).toBe(true)
    // a shell heading back into the owner (post-ricochet) does hit
    const inbound: Bullet = {
      id: 11,
      ownerId: 1,
      type: 'normal',
      pos: { x: 0.4, y: 0 },
      vel: { x: -NORMAL_SPEED, y: 0 },
      bouncesLeft: 0,
      alive: true,
    }
    world.bullets.push(inbound)
    resolveBulletHits(world, [])
    expect(player.alive).toBe(false)
    expect(inbound.alive).toBe(false)
  })
})
```

- [ ] **Step: Run the test to verify it fails**

`npx vitest run src/sim/bullets.test.ts -t "resolveBulletHits"`

Expected: FAIL — `resolveBulletHits is not exported by src/sim/bullets.ts` (function does not exist yet).

- [ ] **Step: Implement `resolveBulletHits`** (add to `src/sim/bullets.ts`)

Extend the imports at the top of `src/sim/bullets.ts`:

```ts
import { fromAngle, vscale, vadd, vlen, vsub, vdot } from './types'
import { reflectSweep, circleVsCircle } from './collision'
import { bulletConfig, PLAYER_SHELL_CAP, BULLET_RADIUS, TANK_RADIUS } from './constants'
```

Then append this function:

```ts
export function resolveBulletHits(world: World, events: SimEvent[]): void {
  for (const b of world.bullets) {
    if (!b.alive) continue
    for (const t of world.tanks) {
      if (!t.alive) continue
      if (t.id === b.ownerId) {
        // Avoid self-destruct while the shell is still leaving the muzzle:
        // only vulnerable once the shell heads back toward its owner (e.g. after a ricochet).
        const toOwner = vsub(t.pos, b.pos)
        if (vdot(b.vel, toOwner) <= 0) continue
      }
      if (circleVsCircle(b.pos, BULLET_RADIUS, t.pos, TANK_RADIUS).hit) {
        t.alive = false
        b.alive = false
        events.push({ type: 'tank-destroyed', tankId: t.id, kind: t.kind, pos: { x: t.pos.x, y: t.pos.y } })
        events.push({ type: 'explosion', pos: { x: t.pos.x, y: t.pos.y } })
        break
      }
    }
  }
}
```

- [ ] **Step: Run the test to verify it passes**

`npx vitest run src/sim/bullets.test.ts`

Expected: PASS — `Test Files 1 passed`, `16 passed`.

- [ ] **Step: Commit**

```bash
git add src/sim/bullets.ts src/sim/bullets.test.ts && git commit -m "Add bullet-vs-tank one-hit resolution with muzzle self-hit guard"
```

---

### Task 13: Mines — drop, arm, timer/proximity detonation, blast

**Files:**
- Create: `src/sim/mines.ts`
- Create: `src/sim/mines.test.ts`
- Test: `src/sim/mines.test.ts`

**Interfaces:**

Consumes:
- `Mine`, `Tank`, `Wall`, `Vec2`, `AABB`, `vdist(a: Vec2, b: Vec2): number` (task 2)
- `World`, `createWorld` (task 8)
- `SimEvent` (task 4)
- `PLAYER_MINE_CAP`, `MINE_TIMER`, `MINE_PROXIMITY_RADIUS`, `MINE_BLAST_RADIUS`, `DT` (task 3)

Produces:
- `function dropMine(world: World, ownerId: number, events: SimEvent[]): boolean` — enforces `PLAYER_MINE_CAP` for a `player`-kind owner; on success creates a `Mine` at the owner's pos, records the id in `tank.activeMineIds`, emits `mine-dropped`, returns `true`; `false` if capped.
- `function stepMines(world: World, dt: number, events: SimEvent[]): void` — decrements each mine's timer; arms a mine (emitting `mine-armed`) once its owner leaves `MINE_PROXIMITY_RADIUS`; detonates on timer expiry OR when a non-owner tank enters `MINE_PROXIMITY_RADIUS` (owner is immune until armed, then vulnerable too). Removes detonated mines from `world.mines`.
- `function detonateMine(world: World, mine: Mine, events: SimEvent[]): void` — emits `mine-detonate`; kills every alive tank within `MINE_BLAST_RADIUS` (emitting `tank-destroyed`+`explosion`) and destroys destructible walls within radius (set `destroyed:true`, emit `wall-destroyed`); removes the mine from its owner's `activeMineIds`.

> Note: step() wiring (calling `stepMines` after `resolveBulletHits`) is finalized in Task 15.

**Steps:**

- [ ] **Step: Write the failing test file** (`src/sim/mines.test.ts`)

```ts
import { describe, it, expect } from 'vitest'
import { createWorld } from './world'
import { dropMine, stepMines, detonateMine } from './mines'
import type { SimEvent } from './events'
import type { Tank, TankKind, Vec2, AABB, Wall, WallKind, Mine } from './types'
import {
  PLAYER_MINE_CAP,
  MINE_TIMER,
  MINE_PROXIMITY_RADIUS,
  MINE_BLAST_RADIUS,
  DT,
} from './constants'

function mkTank(p: Partial<Tank> & { id: number; kind: TankKind; pos: Vec2 }): Tank {
  return {
    id: p.id,
    kind: p.kind,
    pos: p.pos,
    bodyAngle: p.bodyAngle ?? 0,
    turretAngle: p.turretAngle ?? 0,
    alive: p.alive ?? true,
    desiredMove: p.desiredMove ?? { x: 0, y: 0 },
    activeMineIds: p.activeMineIds ?? [],
    fireCooldown: p.fireCooldown ?? 0,
    mineCooldown: p.mineCooldown ?? 0,
    aiState: p.aiState ?? 'idle',
    aiTimer: p.aiTimer ?? 0,
  }
}

function mkWall(id: number, aabb: AABB, kind: WallKind = 'solid'): Wall {
  return { id, aabb, kind, destroyed: false }
}

describe('dropMine', () => {
  it('rejects a 3rd player mine while 2 are active', () => {
    const player = mkTank({ id: 1, kind: 'player', pos: { x: 0, y: 0 } })
    const world = createWorld({ walls: [], tanks: [player], spawns: [], lives: 3 })
    expect(dropMine(world, 1, [])).toBe(true)
    expect(dropMine(world, 1, [])).toBe(true)
    expect(player.activeMineIds.length).toBe(PLAYER_MINE_CAP)
    expect(dropMine(world, 1, [])).toBe(false)
  })

  it('drops a mine at the owner and emits mine-dropped', () => {
    const player = mkTank({ id: 1, kind: 'player', pos: { x: 2, y: -1 } })
    const world = createWorld({ walls: [], tanks: [player], spawns: [], lives: 3 })
    const events: SimEvent[] = []
    expect(dropMine(world, 1, events)).toBe(true)
    const mine = world.mines[0]
    expect(mine.pos).toEqual({ x: 2, y: -1 })
    expect(mine.timer).toBeCloseTo(MINE_TIMER, 6)
    expect(mine.detonated).toBe(false)
    expect(events.find((e) => e.type === 'mine-dropped')).toMatchObject({
      type: 'mine-dropped',
      mineId: mine.id,
    })
  })
})

describe('stepMines', () => {
  it('detonates on the ~3s timer with no one nearby', () => {
    const player = mkTank({ id: 1, kind: 'player', pos: { x: 0, y: 0 } })
    const world = createWorld({ walls: [], tanks: [player], spawns: [], lives: 3 })
    dropMine(world, 1, [])
    player.pos = { x: 10, y: 10 } // walk away so nobody is in proximity/blast
    const events: SimEvent[] = []
    let ticks = 0
    while (world.mines.length > 0 && ticks < 1000) {
      stepMines(world, DT, events)
      ticks++
    }
    expect(events.some((e) => e.type === 'mine-detonate')).toBe(true)
    expect(ticks).toBeGreaterThanOrEqual(Math.floor(MINE_TIMER / DT) - 2)
  })

  it('detonates early when an enemy enters proximity', () => {
    const player = mkTank({ id: 1, kind: 'player', pos: { x: 0, y: 0 } })
    const enemy = mkTank({ id: 2, kind: 'brown', pos: { x: 10, y: 0 } })
    const world = createWorld({ walls: [], tanks: [player, enemy], spawns: [], lives: 3 })
    dropMine(world, 1, [])
    player.pos = { x: 10, y: 10 }
    enemy.pos = { x: 1.0, y: 0 } // inside MINE_PROXIMITY_RADIUS (1.5)
    const events: SimEvent[] = []
    stepMines(world, DT, events)
    expect(events.some((e) => e.type === 'mine-detonate')).toBe(true)
    expect(enemy.alive).toBe(false) // 1.0 <= blast radius 2.0
  })

  it('leaves the owner unharmed while unarmed (owner immune until armed)', () => {
    const player = mkTank({ id: 1, kind: 'player', pos: { x: 0, y: 0 } })
    const world = createWorld({ walls: [], tanks: [player], spawns: [], lives: 3 })
    dropMine(world, 1, [])
    const events: SimEvent[] = []
    stepMines(world, DT, events) // owner still standing on the fresh mine
    expect(events.some((e) => e.type === 'mine-detonate')).toBe(false)
    expect(world.mines[0].detonated).toBe(false)
    expect(world.mines[0].armed).toBe(false)
    expect(player.alive).toBe(true)
  })

  it('emits mine-armed the tick the owner leaves proximity (mine goes live)', () => {
    const player = mkTank({ id: 1, kind: 'player', pos: { x: 0, y: 0 } })
    const world = createWorld({ walls: [], tanks: [player], spawns: [], lives: 3 })
    dropMine(world, 1, [])
    // still standing on the mine: not armed, no mine-armed event
    let events: SimEvent[] = []
    stepMines(world, DT, events)
    expect(world.mines[0].armed).toBe(false)
    expect(events.some((e) => e.type === 'mine-armed')).toBe(false)
    // walk out of proximity: arms THIS tick and emits exactly one mine-armed
    player.pos = { x: 10, y: 10 }
    events = []
    stepMines(world, DT, events)
    expect(world.mines[0].armed).toBe(true)
    expect(events.filter((e) => e.type === 'mine-armed').length).toBe(1)
    // subsequent ticks do not re-emit (guarded by !mine.armed)
    events = []
    stepMines(world, DT, events)
    expect(events.some((e) => e.type === 'mine-armed')).toBe(false)
  })
})

describe('detonateMine', () => {
  it('kills tanks inside the blast radius but not just outside it', () => {
    const owner = mkTank({ id: 1, kind: 'player', pos: { x: 100, y: 100 } })
    const inside = mkTank({ id: 2, kind: 'brown', pos: { x: 1.5, y: 0 } })
    const outside = mkTank({ id: 3, kind: 'grey', pos: { x: 2.5, y: 0 } })
    const world = createWorld({ walls: [], tanks: [owner, inside, outside], spawns: [], lives: 3 })
    const mine: Mine = { id: 50, ownerId: 1, pos: { x: 0, y: 0 }, timer: 1, armed: true, detonated: false }
    world.mines.push(mine)
    const events: SimEvent[] = []
    detonateMine(world, mine, events)
    expect(inside.alive).toBe(false) // 1.5 <= 2.0
    expect(outside.alive).toBe(true) // 2.5 > 2.0
    expect(events.some((e) => e.type === 'mine-detonate')).toBe(true)
  })

  it('destroys a destructible wall in radius but leaves a solid wall intact', () => {
    const owner = mkTank({ id: 1, kind: 'player', pos: { x: 100, y: 100 } })
    const world = createWorld({
      walls: [
        mkWall(1, { minX: 0.5, minY: -0.5, maxX: 1.5, maxY: 0.5 }, 'destructible'),
        mkWall(2, { minX: 0.5, minY: 5, maxX: 1.5, maxY: 6 }, 'solid'),
      ],
      tanks: [owner],
      spawns: [],
      lives: 3,
    })
    const mine: Mine = { id: 50, ownerId: 1, pos: { x: 0, y: 0 }, timer: 1, armed: true, detonated: false }
    world.mines.push(mine)
    const events: SimEvent[] = []
    detonateMine(world, mine, events)
    expect(world.walls[0].destroyed).toBe(true)
    expect(world.walls[1].destroyed).toBe(false)
    expect(events.find((e) => e.type === 'wall-destroyed')).toMatchObject({ type: 'wall-destroyed', wallId: 1 })
  })

  it('frees a mine slot when a mine detonates so the player can drop again', () => {
    const player = mkTank({ id: 1, kind: 'player', pos: { x: 0, y: 0 } })
    const world = createWorld({ walls: [], tanks: [player], spawns: [], lives: 3 })
    dropMine(world, 1, [])
    dropMine(world, 1, [])
    expect(dropMine(world, 1, [])).toBe(false) // capped at 2
    const first = world.mines[0]
    detonateMine(world, first, [])
    expect(player.activeMineIds.includes(first.id)).toBe(false)
    expect(dropMine(world, 1, [])).toBe(true) // slot freed
  })
})
```

- [ ] **Step: Run the test to verify it fails**

`npx vitest run src/sim/mines.test.ts`

Expected: FAIL — `Failed to resolve import "./mines"` (module `src/sim/mines.ts` does not exist yet).

- [ ] **Step: Implement minimal code to pass** (`src/sim/mines.ts`)

```ts
import type { Mine, Vec2, AABB } from './types'
import { vdist } from './types'
import type { World } from './world'
import type { SimEvent } from './events'
import {
  PLAYER_MINE_CAP,
  MINE_TIMER,
  MINE_PROXIMITY_RADIUS,
  MINE_BLAST_RADIUS,
} from './constants'

function blastHitsAABB(center: Vec2, radius: number, box: AABB): boolean {
  const cx = Math.max(box.minX, Math.min(center.x, box.maxX))
  const cy = Math.max(box.minY, Math.min(center.y, box.maxY))
  const dx = center.x - cx
  const dy = center.y - cy
  return dx * dx + dy * dy <= radius * radius
}

export function dropMine(world: World, ownerId: number, events: SimEvent[]): boolean {
  const owner = world.tanks.find((t) => t.id === ownerId)
  if (!owner) return false
  if (owner.kind === 'player' && owner.activeMineIds.length >= PLAYER_MINE_CAP) return false
  const mine: Mine = {
    id: world.nextId++,
    ownerId,
    pos: { x: owner.pos.x, y: owner.pos.y },
    timer: MINE_TIMER,
    armed: false,
    detonated: false,
  }
  world.mines.push(mine)
  owner.activeMineIds.push(mine.id)
  events.push({ type: 'mine-dropped', mineId: mine.id, pos: { x: mine.pos.x, y: mine.pos.y } })
  return true
}

export function detonateMine(world: World, mine: Mine, events: SimEvent[]): void {
  if (mine.detonated) return
  mine.detonated = true
  events.push({ type: 'mine-detonate', mineId: mine.id, pos: { x: mine.pos.x, y: mine.pos.y } })
  for (const t of world.tanks) {
    if (!t.alive) continue
    if (vdist(t.pos, mine.pos) <= MINE_BLAST_RADIUS) {
      t.alive = false
      events.push({ type: 'tank-destroyed', tankId: t.id, kind: t.kind, pos: { x: t.pos.x, y: t.pos.y } })
      events.push({ type: 'explosion', pos: { x: t.pos.x, y: t.pos.y } })
    }
  }
  for (const w of world.walls) {
    if (w.kind !== 'destructible' || w.destroyed) continue
    if (blastHitsAABB(mine.pos, MINE_BLAST_RADIUS, w.aabb)) {
      w.destroyed = true
      const cx = (w.aabb.minX + w.aabb.maxX) / 2
      const cy = (w.aabb.minY + w.aabb.maxY) / 2
      events.push({ type: 'wall-destroyed', wallId: w.id, pos: { x: cx, y: cy } })
    }
  }
  const owner = world.tanks.find((t) => t.id === mine.ownerId)
  if (owner) owner.activeMineIds = owner.activeMineIds.filter((id) => id !== mine.id)
}

export function stepMines(world: World, dt: number, events: SimEvent[]): void {
  for (const mine of [...world.mines]) {
    if (mine.detonated) continue
    mine.timer -= dt
    const owner = world.tanks.find((t) => t.id === mine.ownerId)
    if (!mine.armed && (!owner || vdist(owner.pos, mine.pos) > MINE_PROXIMITY_RADIUS)) {
      mine.armed = true
      events.push({ type: 'mine-armed', mineId: mine.id, pos: { x: mine.pos.x, y: mine.pos.y } })
    }
    if (mine.timer <= 0) {
      detonateMine(world, mine, events)
      continue
    }
    for (const t of world.tanks) {
      if (!t.alive) continue
      if (vdist(t.pos, mine.pos) > MINE_PROXIMITY_RADIUS) continue
      if (t.id === mine.ownerId && !mine.armed) continue // owner immune until armed
      detonateMine(world, mine, events)
      break
    }
  }
  world.mines = world.mines.filter((m) => !m.detonated)
}
```

- [ ] **Step: Run the test to verify it passes**

`npx vitest run src/sim/mines.test.ts`

Expected: PASS — `Test Files 1 passed`, `9 passed`.

- [ ] **Step: Run the full sim suite to confirm no regressions**

`npx vitest run`

Expected: PASS — all sim test files pass (`bullets.test.ts`, `mines.test.ts`, and prior modules).

- [ ] **Step: Commit**

```bash
git add src/sim/mines.ts src/sim/mines.test.ts && git commit -m "Add mines: drop, arm, timer/proximity detonation, and blast"
```

---

### Task 14: Input controller (keyboard + mouse → InputState)

**Files:**
- Create: `src/input/input.ts`
- Create: `src/input/input.test.ts` (DOM-bound, run under jsdom via a per-file environment directive)
- Modify: `package.json` (add `jsdom` dev dependency so the DOM-bound controller can be unit-tested headlessly; sim/ tests stay on the default node environment)

**Interfaces:**

Consumes:
- `InputState` — `interface InputState { move: Vec2; aim: Vec2; fire: boolean; mine: boolean }` (task 2). `move` components in [-1,1], NOT normalized; `aim` is a world-space ground point; `fire`/`mine` are edge-triggered press-this-tick.
- `Vec2` — `type Vec2 = { x: number; y: number }` (task 2).

Produces:
- `interface InputController { sample(): InputState; dispose(): void }`
- `function createInputController(target: HTMLElement, screenToGround: (clientX: number, clientY: number) => Vec2): InputController` — WASD/arrows → `move` (x,y in [-1,1]); mouse position → `aim` via injected `screenToGround` (the camera-unproject lives in render, keeping input DOM-only, not Three-dependent); left-click → `fire` edge; Space/right-click → `mine` edge; `sample()` returns accumulated edge presses and clears them so a held button fires once per intended press. Suppresses the context menu on right-click.

Notes for this task:
- Keyboard listeners attach to `window` (movement must work regardless of which element has focus); pointer listeners (`mousemove`, `mousedown`, `contextmenu`) attach to `target`.
- `move` is deliberately un-normalized: a diagonal returns `{x:1, y:1}` (magnitude ≈1.41). The sim clamps to unit length in `moveTank` (task 9), so input must NOT pre-normalize.
- Axis convention matches world space used by the sim: `w`/`ArrowUp` → `y = +1`, `s`/`ArrowDown` → `y = -1`, `a`/`ArrowLeft` → `x = -1`, `d`/`ArrowRight` → `x = +1`.

---

STEPS:

- [ ] **Step: Add the jsdom dev dependency**

  The input controller touches `window` and DOM events, so its test runs under the jsdom environment. Install it as a dev dependency (task 1 already set up Vitest):

  ```bash
  npm install -D jsdom
  ```

  Expected: `jsdom` appears under `devDependencies` in `package.json`; no other changes.

- [ ] **Step: Write the failing test (movement mapping)**

  Create `src/input/input.test.ts`. The first line MUST be the environment directive so this single file runs under jsdom while sim/ tests stay on node.

  ```ts
  // @vitest-environment jsdom
  import { describe, it, expect, afterEach } from 'vitest';
  import { createInputController, InputController } from './input';
  import type { Vec2 } from '../sim/types';

  // A predictable screenToGround: echoes the client coords as a world point.
  const echoGround = (clientX: number, clientY: number): Vec2 => ({ x: clientX, y: clientY });

  let controller: InputController | null = null;

  afterEach(() => {
    controller?.dispose();
    controller = null;
  });

  function makeTarget(): HTMLElement {
    const el = document.createElement('div');
    document.body.appendChild(el);
    return el;
  }

  function key(type: 'keydown' | 'keyup', k: string): void {
    window.dispatchEvent(new KeyboardEvent(type, { key: k }));
  }

  describe('createInputController — movement', () => {
    it('maps WASD to axis-aligned move vectors', () => {
      const target = makeTarget();
      controller = createInputController(target, echoGround);

      key('keydown', 'w');
      expect(controller.sample().move).toEqual({ x: 0, y: 1 });

      key('keyup', 'w');
      key('keydown', 's');
      expect(controller.sample().move).toEqual({ x: 0, y: -1 });

      key('keyup', 's');
      key('keydown', 'a');
      expect(controller.sample().move).toEqual({ x: -1, y: 0 });

      key('keyup', 'a');
      key('keydown', 'd');
      expect(controller.sample().move).toEqual({ x: 1, y: 0 });
    });

    it('maps arrow keys identically to WASD', () => {
      const target = makeTarget();
      controller = createInputController(target, echoGround);

      key('keydown', 'ArrowUp');
      expect(controller.sample().move).toEqual({ x: 0, y: 1 });
    });

    it('returns an un-normalized diagonal (magnitude ~1.41)', () => {
      const target = makeTarget();
      controller = createInputController(target, echoGround);

      key('keydown', 'w');
      key('keydown', 'd');
      const move = controller.sample().move;
      expect(move).toEqual({ x: 1, y: 1 });
      expect(Math.hypot(move.x, move.y)).toBeCloseTo(Math.SQRT2, 6);
    });

    it('cancels opposite keys to zero drift', () => {
      const target = makeTarget();
      controller = createInputController(target, echoGround);

      key('keydown', 'a');
      key('keydown', 'd');
      expect(controller.sample().move).toEqual({ x: 0, y: 0 });
    });
  });
  ```

- [ ] **Step: Run the test to verify it fails**

  ```bash
  npx vitest run src/input/input.test.ts -t "maps WASD to axis-aligned move vectors"
  ```

  Expected: FAIL — `createInputController` is not yet exported from `./input` (module resolution / import error).

- [ ] **Step: Implement minimal code to pass (movement only)**

  Create `src/input/input.ts` with just keyboard-driven movement wired; aim/fire/mine are stubbed to defaults for now.

  ```ts
  import type { InputState, Vec2 } from '../sim/types';

  export interface InputController {
    sample(): InputState;
    dispose(): void;
  }

  export function createInputController(
    target: HTMLElement,
    screenToGround: (clientX: number, clientY: number) => Vec2,
  ): InputController {
    const keys = new Set<string>();

    const onKeyDown = (e: KeyboardEvent): void => {
      keys.add(e.key.toLowerCase());
    };
    const onKeyUp = (e: KeyboardEvent): void => {
      keys.delete(e.key.toLowerCase());
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);

    function readMove(): Vec2 {
      let x = 0;
      let y = 0;
      if (keys.has('a') || keys.has('arrowleft')) x -= 1;
      if (keys.has('d') || keys.has('arrowright')) x += 1;
      if (keys.has('w') || keys.has('arrowup')) y += 1;
      if (keys.has('s') || keys.has('arrowdown')) y -= 1;
      return { x, y };
    }

    return {
      sample(): InputState {
        return { move: readMove(), aim: { x: 0, y: 0 }, fire: false, mine: false };
      },
      dispose(): void {
        window.removeEventListener('keydown', onKeyDown);
        window.removeEventListener('keyup', onKeyUp);
      },
    };
  }
  ```

  Note: `screenToGround` is intentionally unused at this stage (wired in the next cycle). `strict:true` does not enable `noUnusedParameters`, so this type-checks.

- [ ] **Step: Run the test to verify it passes**

  ```bash
  npx vitest run src/input/input.test.ts -t "movement"
  ```

  Expected: PASS — all four movement tests green.

- [ ] **Step: Write the failing test (aim, fire/mine edges, context menu)**

  Append these suites to `src/input/input.test.ts` (below the movement `describe`):

  ```ts
  describe('createInputController — aim', () => {
    it('resolves aim through the injected screenToGround on mouse move', () => {
      const target = makeTarget();
      controller = createInputController(target, echoGround);

      target.dispatchEvent(new MouseEvent('mousemove', { clientX: 42, clientY: 7 }));
      expect(controller.sample().aim).toEqual({ x: 42, y: 7 });
    });
  });

  describe('createInputController — fire/mine edges', () => {
    it('left-click yields fire=true on exactly one sample, then false', () => {
      const target = makeTarget();
      controller = createInputController(target, echoGround);

      target.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
      expect(controller.sample().fire).toBe(true);
      expect(controller.sample().fire).toBe(false);
    });

    it('Space drops a mine as a one-shot edge', () => {
      const target = makeTarget();
      controller = createInputController(target, echoGround);

      window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
      expect(controller.sample().mine).toBe(true);
      expect(controller.sample().mine).toBe(false);
    });

    it('right-click drops a mine and suppresses the context menu', () => {
      const target = makeTarget();
      controller = createInputController(target, echoGround);

      target.dispatchEvent(new MouseEvent('mousedown', { button: 2 }));
      expect(controller.sample().mine).toBe(true);

      const ctx = new MouseEvent('contextmenu', { cancelable: true });
      target.dispatchEvent(ctx);
      expect(ctx.defaultPrevented).toBe(true);
    });

    it('a held-down key does not re-trigger the mine edge each sample', () => {
      const target = makeTarget();
      controller = createInputController(target, echoGround);

      window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
      expect(controller.sample().mine).toBe(true);
      // No keyup dispatched (key still held), but the edge was consumed:
      expect(controller.sample().mine).toBe(false);
    });
  });
  ```

- [ ] **Step: Run the test to verify it fails**

  ```bash
  npx vitest run src/input/input.test.ts -t "aim"
  ```

  Expected: FAIL — `aim` is still hard-coded to `{x:0,y:0}` (received `{x:0,y:0}`, expected `{x:42,y:7}`); the fire/mine and context-menu suites also fail (fire/mine always false, no `contextmenu` handler so `defaultPrevented` is false).

- [ ] **Step: Implement the full controller (aim + fire/mine edges + context-menu suppression)**

  Replace the entire contents of `src/input/input.ts` with the complete implementation:

  ```ts
  import type { InputState, Vec2 } from '../sim/types';

  export interface InputController {
    sample(): InputState;
    dispose(): void;
  }

  export function createInputController(
    target: HTMLElement,
    screenToGround: (clientX: number, clientY: number) => Vec2,
  ): InputController {
    const keys = new Set<string>();
    let aim: Vec2 = { x: 0, y: 0 };
    let firePressed = false;
    let minePressed = false;

    const onKeyDown = (e: KeyboardEvent): void => {
      const k = e.key.toLowerCase();
      keys.add(k);
      if (k === ' ' || k === 'spacebar') minePressed = true;
    };
    const onKeyUp = (e: KeyboardEvent): void => {
      keys.delete(e.key.toLowerCase());
    };
    const onMouseMove = (e: MouseEvent): void => {
      aim = screenToGround(e.clientX, e.clientY);
    };
    const onMouseDown = (e: MouseEvent): void => {
      if (e.button === 0) firePressed = true;
      else if (e.button === 2) minePressed = true;
    };
    const onContextMenu = (e: MouseEvent): void => {
      e.preventDefault();
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    target.addEventListener('mousemove', onMouseMove);
    target.addEventListener('mousedown', onMouseDown);
    target.addEventListener('contextmenu', onContextMenu);

    function readMove(): Vec2 {
      let x = 0;
      let y = 0;
      if (keys.has('a') || keys.has('arrowleft')) x -= 1;
      if (keys.has('d') || keys.has('arrowright')) x += 1;
      if (keys.has('w') || keys.has('arrowup')) y += 1;
      if (keys.has('s') || keys.has('arrowdown')) y -= 1;
      return { x, y };
    }

    return {
      sample(): InputState {
        const state: InputState = {
          move: readMove(),
          aim,
          fire: firePressed,
          mine: minePressed,
        };
        firePressed = false;
        minePressed = false;
        return state;
      },
      dispose(): void {
        window.removeEventListener('keydown', onKeyDown);
        window.removeEventListener('keyup', onKeyUp);
        target.removeEventListener('mousemove', onMouseMove);
        target.removeEventListener('mousedown', onMouseDown);
        target.removeEventListener('contextmenu', onContextMenu);
      },
    };
  }
  ```

- [ ] **Step: Run the full test file to verify it passes**

  ```bash
  npx vitest run src/input/input.test.ts
  ```

  Expected: PASS — all movement, aim, and fire/mine edge suites green.

- [ ] **Step: Write the failing test (dispose detaches all listeners)**

  Append a final suite to `src/input/input.test.ts`:

  ```ts
  describe('createInputController — dispose', () => {
    it('stops responding to input after dispose', () => {
      const target = makeTarget();
      const c = createInputController(target, echoGround);

      c.dispose();

      // Post-dispose events must be ignored.
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w' }));
      target.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
      target.dispatchEvent(new MouseEvent('mousemove', { clientX: 99, clientY: 99 }));

      const s = c.sample();
      expect(s.move).toEqual({ x: 0, y: 0 });
      expect(s.fire).toBe(false);
      expect(s.aim).toEqual({ x: 0, y: 0 });
    });
  });
  ```

  (This suite manages its own controller and calls `dispose()` explicitly, so it does not use the shared `controller`/`afterEach` teardown — a double `dispose()` would be harmless anyway since `removeEventListener` on an already-removed handler is a no-op, but here `controller` stays null.)

- [ ] **Step: Run the test to verify it fails, then passes**

  First confirm the assertion is meaningful by running only the dispose test:

  ```bash
  npx vitest run src/input/input.test.ts -t "stops responding to input after dispose"
  ```

  Expected: PASS — the full implementation already detaches every listener in `dispose()`. (This test guards against regressions where a future edit adds a listener but forgets to remove it; if you had written it before implementing `dispose`, it would have FAILED with `move` still tracking `w`.)

- [ ] **Step: Run the whole suite to confirm no cross-file regressions**

  ```bash
  npx vitest run
  ```

  Expected: PASS — the input file runs under jsdom (per its directive) while all sim/ files remain on the node environment; total suite green.

- [ ] **Step: Type-check with the production build config**

  ```bash
  npm run build
  ```

  Expected: PASS — strict TypeScript compiles `src/input/input.ts` with no errors; input imports only `InputState`/`Vec2` types from `../sim/types` and nothing from three or howler.

- [ ] **Step: Commit**

  ```bash
  git add src/input/input.ts src/input/input.test.ts package.json package-lock.json && git commit -m "Task 14: keyboard+mouse InputController with edge-triggered fire/mine and injected screenToGround"
  ```

---

### Task 15: Integrate player input, firing, mines, death and win/lose into step()

**Files:**
- Modify: `src/sim/world.ts`
- Test: `src/sim/step-integration.test.ts`

**Interfaces:**

Consumes: `InputState`, `Tank`, `angleOf`, `vsub` (task 2); `spawnBullet(world, ownerId, angle, type, events): boolean` (task 10); `dropMine(world, ownerId, events): boolean` (task 13); `World`, `step`, `stepMovement(world, dt)` (task 8/9); `stepBullets(world, dt, events)`, `resolveBulletHits(world, events)` (task 10/12); `stepMines(world, dt, events)` (task 13); `SimEvent` (task 4); `FIRE_COOLDOWN`, `MINE_COOLDOWN`, `DT` (task 3).

Produces:
- `function applyPlayerInput(world: World, input: InputState, events: SimEvent[]): void` — sets the player tank's `desiredMove` from `input.move`; sets `turretAngle` from `angleOf(aim - pos)`; decrements cooldowns; on `input.fire` (and `fireCooldown<=0`) calls `spawnBullet(type 'normal')` and resets `fireCooldown`; on `input.mine` (and `mineCooldown<=0`) calls `dropMine` and resets `mineCooldown`.
- `function resolveStatus(world: World, events: SimEvent[]): void` — if the player is dead: decrement lives; if `lives>0` **restart the whole arena** via `resetArena` (every tank back to its spawn and alive, destructible walls restored, bullets/mines cleared, lives preserved — matching the spec's "restart arena on death"); else set status `'lose'` and emit `lose`. If all enemy tanks are dead: set status `'win'` and emit `win`.
- Finalizes `step()` order: clone -> applyPlayerInput -> (stepAi, added task 22) -> stepMovement -> stepBullets -> resolveBulletHits -> stepMines -> resolveStatus.

Steps:

- [ ] **Step: Write the failing test** — create `src/sim/step-integration.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createWorld, applyPlayerInput, resolveStatus } from './world';
import type { World } from './world';
import type { Tank, Spawn, InputState } from './types';
import type { SimEvent } from './events';
import { FIRE_COOLDOWN } from './constants';

function makeTank(kind: Tank['kind'], id: number, x: number, y: number): Tank {
  return {
    id,
    kind,
    pos: { x, y },
    bodyAngle: 0,
    turretAngle: 0,
    alive: true,
    desiredMove: { x: 0, y: 0 },
    activeMineIds: [],
    fireCooldown: 0,
    mineCooldown: 0,
    aiState: 'idle',
    aiTimer: 0,
  };
}

function makeWorld(): World {
  const player = makeTank('player', 1, 5, 5);
  const brown = makeTank('brown', 2, 5, 15);
  const spawns: Spawn[] = [
    { kind: 'player', pos: { x: 5, y: 5 }, angle: 0 },
    { kind: 'brown', pos: { x: 5, y: 15 }, angle: 0 },
  ];
  return createWorld({ walls: [], tanks: [player, brown], spawns, lives: 3 });
}

const fireInput: InputState = {
  move: { x: 0, y: 0 },
  aim: { x: 10, y: 5 }, // straight to the +x of the player at (5,5) -> angle 0
  fire: true,
  mine: false,
};

describe('applyPlayerInput', () => {
  it('aims the turret at the cursor independent of body facing', () => {
    const w = makeWorld();
    const player = w.tanks[0];
    player.bodyAngle = Math.PI; // body faces the other way
    applyPlayerInput(w, { ...fireInput, fire: false }, []);
    expect(player.turretAngle).toBeCloseTo(0, 10);
    expect(player.bodyAngle).toBe(Math.PI); // unchanged
  });

  it('fires once, spends the cooldown, then refuses until it elapses', () => {
    const w = makeWorld();
    const events: SimEvent[] = [];
    applyPlayerInput(w, fireInput, events);
    expect(w.bullets.length).toBe(1);
    expect(events.some((e) => e.type === 'fire')).toBe(true);
    expect(w.tanks[0].fireCooldown).toBeCloseTo(FIRE_COOLDOWN, 10);

    // Immediately press fire again: cooldown not yet elapsed -> no new shell.
    applyPlayerInput(w, fireInput, []);
    expect(w.bullets.length).toBe(1);
  });
});

describe('resolveStatus', () => {
  it('restarts the arena (revives enemies, restores walls) and decrements lives while lives remain', () => {
    const w = makeWorld();
    const player = w.tanks[0];
    const enemy = w.tanks[1]; // brown, spawn-aligned at index 1
    player.alive = false;
    player.pos = { x: 99, y: 99 };
    enemy.alive = false; // was destroyed earlier this life
    // a destructible wall blown open earlier this life
    w.walls.push({ id: 99, aabb: { minX: 0, minY: 0, maxX: 1, maxY: 1 }, kind: 'destructible', destroyed: true });
    resolveStatus(w, []);
    expect(w.lives).toBe(2);
    expect(player.alive).toBe(true);
    expect(player.pos).toEqual({ x: 5, y: 5 }); // player back at spawn
    expect(enemy.alive).toBe(true); // arena restarted -> enemy revived
    expect(enemy.pos).toEqual({ x: 5, y: 15 }); // enemy back at its spawn
    expect(w.walls[0].destroyed).toBe(false); // destroyed wall restored
    expect(w.status).toBe('playing');
  });

  it('emits lose and sets status when the player dies at 1 life', () => {
    const w = makeWorld();
    w.lives = 1;
    w.tanks[0].alive = false;
    const events: SimEvent[] = [];
    resolveStatus(w, events);
    expect(w.lives).toBe(0);
    expect(w.status).toBe('lose');
    expect(events).toContainEqual({ type: 'lose' });
  });

  it('emits win when the last enemy is destroyed', () => {
    const w = makeWorld();
    w.tanks[1].alive = false; // only enemy dead
    const events: SimEvent[] = [];
    resolveStatus(w, events);
    expect(w.status).toBe('win');
    expect(events).toContainEqual({ type: 'win' });
  });

  it('does nothing while both sides have live tanks', () => {
    const w = makeWorld();
    const events: SimEvent[] = [];
    resolveStatus(w, events);
    expect(w.status).toBe('playing');
    expect(events).toEqual([]);
  });
});
```

- [ ] **Step: Run the test to verify it fails**
  - Command: `npx vitest run src/sim/step-integration.test.ts`
  - Expected: FAIL — `applyPlayerInput` / `resolveStatus` are not exported from `./world` yet.

- [ ] **Step: Add imports to `src/sim/world.ts`** — add the new type/bullet/mine imports, and EXTEND task 9's existing `import { DT } from './constants';` line to also pull in the cooldown constants (do NOT add a second `./constants` import — re-declaring `DT` is a TS2300 duplicate-identifier error):

```ts
import { angleOf, vsub } from './types';
import { spawnBullet, stepBullets, resolveBulletHits } from './bullets';
import { dropMine, stepMines } from './mines';
// Replace task 9's `import { DT } from './constants';` with this single line:
import { DT, FIRE_COOLDOWN, MINE_COOLDOWN } from './constants';
// NOTE: stepMovement is defined locally in this file by task 9.
```

- [ ] **Step: Implement `applyPlayerInput`, `resolveStatus`, and the respawn helper** — append to `src/sim/world.ts`:

```ts
export function applyPlayerInput(world: World, input: InputState, events: SimEvent[]): void {
  const player = world.tanks.find((t) => t.kind === 'player');
  if (!player || !player.alive) return;

  player.desiredMove = { x: input.move.x, y: input.move.y };

  const aimDir = vsub(input.aim, player.pos);
  if (aimDir.x !== 0 || aimDir.y !== 0) {
    player.turretAngle = angleOf(aimDir);
  }

  if (player.fireCooldown > 0) player.fireCooldown -= DT;
  if (player.mineCooldown > 0) player.mineCooldown -= DT;

  if (input.fire && player.fireCooldown <= 0) {
    if (spawnBullet(world, player.id, player.turretAngle, 'normal', events)) {
      player.fireCooldown = FIRE_COOLDOWN;
    }
  }

  if (input.mine && player.mineCooldown <= 0) {
    if (dropMine(world, player.id, events)) {
      player.mineCooldown = MINE_COOLDOWN;
    }
  }
}

// A life loss restarts the WHOLE arena (spec §4: "restart arena on death"): every
// tank returns to its spawn alive, destroyed walls come back, and all bullets/mines
// clear. Relies on the loadArena invariant that world.tanks[i] was built from
// world.spawns[i] — tanks are never removed or reordered (dead tanks stay in place
// with alive=false), so that index alignment holds for the whole game.
function resetArena(world: World): void {
  for (let i = 0; i < world.tanks.length; i++) {
    const t = world.tanks[i];
    const s = world.spawns[i];
    t.pos = { ...s.pos };
    t.bodyAngle = s.angle;
    t.turretAngle = s.angle;
    t.alive = true;
    t.desiredMove = { x: 0, y: 0 };
    t.activeMineIds = [];
    t.fireCooldown = 0;
    t.mineCooldown = 0;
    t.aiState = 'idle';
    t.aiTimer = 0;
  }
  for (const w of world.walls) w.destroyed = false;
  world.bullets = [];
  world.mines = [];
}

export function resolveStatus(world: World, events: SimEvent[]): void {
  const player = world.tanks.find((t) => t.kind === 'player');
  if (player && !player.alive) {
    world.lives -= 1;
    if (world.lives > 0) {
      resetArena(world);
    } else {
      world.status = 'lose';
      events.push({ type: 'lose' });
      return; // dying on the last life = lose, even if an enemy died the same tick
    }
  }

  const enemies = world.tanks.filter((t) => t.kind !== 'player');
  if (enemies.length > 0 && enemies.every((e) => !e.alive)) {
    world.status = 'win';
    events.push({ type: 'win' });
  }
}
```

- [ ] **Step: Replace the skeleton `step()` with the full fixed-order pipeline** — in `src/sim/world.ts`, replace the task-8 skeleton body:

```ts
export function step(world: World, _input: InputState): StepResult {
  const draft = cloneWorld(world);
  draft.tick += 1;
  return { world: draft, events: [] };
}
```

  with the wired version (note the param is now used, so it is named `input`):

```ts
export function step(world: World, input: InputState): StepResult {
  const draft = cloneWorld(world);
  draft.tick += 1;
  const events: SimEvent[] = [];

  if (draft.status === 'playing') {
    applyPlayerInput(draft, input, events);
    // stepAi(draft, events);  // wired in by task 22, right here (before movement)
    stepMovement(draft, DT);
    stepBullets(draft, DT, events);
    resolveBulletHits(draft, events);
    stepMines(draft, DT, events);
    resolveStatus(draft, events);
  }

  return { world: draft, events };
}
```

- [ ] **Step: Run the new test to verify it passes**
  - Command: `npx vitest run src/sim/step-integration.test.ts`
  - Expected: PASS.

- [ ] **Step: Run the full sim suite to confirm no regressions**
  - Command: `npx vitest run src/sim`
  - Expected: PASS (world, movement, bullets, mines, and integration suites all green).

- [ ] **Step: Commit**
  - `git add src/sim/world.ts src/sim/step-integration.test.ts && git commit -m "Wire player input, firing, mines, and win/lose into step()"`

---

### Task 16: AI targeting core — line-of-sight and aim-lead

**Files:**
- Create: `src/sim/ai/targeting.ts`
- Create: `src/sim/ai/targeting.test.ts`
- Test: `src/sim/ai/targeting.test.ts`

**Interfaces:**

Consumes:
- `type Vec2 = { x: number; y: number }`, `interface Wall { id: number; aabb: AABB; kind: WallKind; destroyed: boolean }` (task 2)
- `function vsub(a: Vec2, b: Vec2): Vec2`, `function angleOf(a: Vec2): number` (task 2)
- `function raySegmentVsAABB(from: Vec2, to: Vec2, box: AABB): RayHit | null` where `RayHit = { t: number; point: Vec2; normal: Vec2 }` (task 6)

Produces:
- `function lineOfSight(from: Vec2, to: Vec2, walls: Wall[]): boolean` — true iff no non-destroyed wall AABB blocks the segment.
- `function aimLead(muzzle: Vec2, target: Vec2, targetVel: Vec2, bulletSpeed: number): number` — firing angle (radians) that intercepts a target moving at `targetVel`; falls back to direct aim when no positive intercept exists.

Steps:

- [ ] **Step: Write the failing test** for `lineOfSight`.

```ts
// src/sim/ai/targeting.test.ts
import { describe, it, expect } from 'vitest';
import { lineOfSight, aimLead } from './targeting';
import type { Wall } from '../types';

function wall(id: number, minX: number, minY: number, maxX: number, maxY: number,
             kind: 'solid' | 'destructible' = 'solid', destroyed = false): Wall {
  return { id, aabb: { minX, minY, maxX, maxY }, kind, destroyed };
}

describe('lineOfSight', () => {
  it('is blocked by a solid wall between the two points', () => {
    const walls = [wall(1, 1.5, -1, 2.5, 1)];
    expect(lineOfSight({ x: 0, y: 0 }, { x: 4, y: 0 }, walls)).toBe(false);
  });

  it('is clear through a gap between walls', () => {
    const walls = [wall(1, 1.5, 1, 2.5, 3), wall(2, 1.5, -3, 2.5, -1)];
    expect(lineOfSight({ x: 0, y: 0 }, { x: 4, y: 0 }, walls)).toBe(true);
  });

  it('is clear once the blocking wall is destroyed', () => {
    const walls = [wall(1, 1.5, -1, 2.5, 1, 'destructible', true)];
    expect(lineOfSight({ x: 0, y: 0 }, { x: 4, y: 0 }, walls)).toBe(true);
  });
});
```

- [ ] **Step: Run the test to verify it fails.**
  `npx vitest run src/sim/ai/targeting.test.ts -t "lineOfSight"`
  Expected: FAIL — `lineOfSight` is not exported / module `./targeting` cannot be resolved.

- [ ] **Step: Implement `lineOfSight` (and stub file).**

```ts
// src/sim/ai/targeting.ts
import type { Vec2, Wall } from '../types';
import { vsub, angleOf } from '../types';
import { raySegmentVsAABB } from '../collision';

export function lineOfSight(from: Vec2, to: Vec2, walls: Wall[]): boolean {
  for (const w of walls) {
    if (w.destroyed) continue;
    if (raySegmentVsAABB(from, to, w.aabb) !== null) return false;
  }
  return true;
}
```

- [ ] **Step: Run the test to verify it passes.**
  `npx vitest run src/sim/ai/targeting.test.ts -t "lineOfSight"`
  Expected: PASS (3 tests).

- [ ] **Step: Write the failing test** for `aimLead`.

```ts
// append to src/sim/ai/targeting.test.ts
describe('aimLead', () => {
  it('aims directly at a stationary target', () => {
    const angle = aimLead({ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 0, y: 0 }, 6);
    expect(angle).toBeCloseTo(0, 6);
  });

  it('leads a crossing target ahead of its current position', () => {
    // target at (5,0) moving +y; the intercept must be at positive y, so angle > 0
    const angle = aimLead({ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 0, y: 3 }, 6);
    expect(angle).toBeGreaterThan(0);
    expect(angle).toBeLessThan(Math.PI / 2);
  });

  it('returns a sane direct-aim angle when no intercept exists (target faster than bullet)', () => {
    const angle = aimLead({ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 100, y: 0 }, 6);
    expect(Number.isNaN(angle)).toBe(false);
    expect(angle).toBeCloseTo(0, 6); // falls back to direct aim
  });
});
```

- [ ] **Step: Run the test to verify it fails.**
  `npx vitest run src/sim/ai/targeting.test.ts -t "aimLead"`
  Expected: FAIL — `aimLead` is not a function.

- [ ] **Step: Implement `aimLead`.**

```ts
// append to src/sim/ai/targeting.ts
export function aimLead(muzzle: Vec2, target: Vec2, targetVel: Vec2, bulletSpeed: number): number {
  const rel = vsub(target, muzzle);
  // Solve |rel + targetVel*t| = bulletSpeed*t  ->  a t^2 + b t + c = 0
  const a = targetVel.x * targetVel.x + targetVel.y * targetVel.y - bulletSpeed * bulletSpeed;
  const b = 2 * (rel.x * targetVel.x + rel.y * targetVel.y);
  const c = rel.x * rel.x + rel.y * rel.y;
  const EPS = 1e-9;

  let t = -1;
  if (Math.abs(a) < EPS) {
    if (Math.abs(b) > EPS) t = -c / b;
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      const t1 = (-b + sq) / (2 * a);
      const t2 = (-b - sq) / (2 * a);
      if (t1 > EPS && t2 > EPS) t = Math.min(t1, t2);
      else if (t1 > EPS) t = t1;
      else if (t2 > EPS) t = t2;
    }
  }

  if (t <= EPS) return angleOf(rel); // no positive intercept: direct aim
  const intercept = { x: target.x + targetVel.x * t, y: target.y + targetVel.y * t };
  return angleOf(vsub(intercept, muzzle));
}
```

- [ ] **Step: Run the test to verify it passes.**
  `npx vitest run src/sim/ai/targeting.test.ts`
  Expected: PASS (all `lineOfSight` + `aimLead` tests).

- [ ] **Step: Commit.**
  `git add src/sim/ai/targeting.ts src/sim/ai/targeting.test.ts && git commit -m "AI targeting: lineOfSight + aimLead intercept math"`

---

### Task 17: AI bank-shot mirror geometry

**Files:**
- Modify: `src/sim/ai/targeting.ts`
- Test: `src/sim/ai/targeting.test.ts`

**Interfaces:**

Consumes:
- `type Vec2`, `interface AABB { minX; minY; maxX; maxY }`, `interface Wall`, `function angleOf(a: Vec2): number`, `function vsub(a: Vec2, b: Vec2): Vec2` (task 2)
- `function lineOfSight(from, to, walls): boolean` (task 16)
- `function raySegmentVsAABB(from, to, box): RayHit | null` (task 6)

Produces:
- `function mirrorAcrossAABB(point: Vec2, box: AABB): Vec2[]` — reflects a point across each of the 4 face planes of a wall (order: left, right, bottom, top), returning the candidate mirror images.
- `function bankShot(muzzle: Vec2, target: Vec2, walls: Wall[], maxBounces: number): number | null` — for each candidate wall face, mirror the target, test that `muzzle -> mirror` strikes the intended face and that both `muzzle -> bounce` and `bounce -> target` have line-of-sight; return the firing angle of the first valid single-bounce bank path, or `null`.

Steps:

- [ ] **Step: Write the failing test** for `mirrorAcrossAABB`.

```ts
// append to src/sim/ai/targeting.test.ts
import { mirrorAcrossAABB, bankShot } from './targeting';

describe('mirrorAcrossAABB', () => {
  it('reflects a point across all four face planes (left,right,bottom,top)', () => {
    const box = { minX: 1.5, minY: 2, maxX: 2.5, maxY: 3 };
    const [left, right, bottom, top] = mirrorAcrossAABB({ x: 4, y: 0 }, box);
    expect(left).toEqual({ x: 2 * 1.5 - 4, y: 0 });   // x = minX plane -> (-1, 0)
    expect(right).toEqual({ x: 2 * 2.5 - 4, y: 0 });  // x = maxX plane -> (1, 0)
    expect(bottom).toEqual({ x: 4, y: 2 * 2 - 0 });   // y = minY plane -> (4, 4)
    expect(top).toEqual({ x: 4, y: 2 * 3 - 0 });      // y = maxY plane -> (4, 6)
  });
});
```

- [ ] **Step: Run the test to verify it fails.**
  `npx vitest run src/sim/ai/targeting.test.ts -t "mirrorAcrossAABB"`
  Expected: FAIL — `mirrorAcrossAABB` is not exported.

- [ ] **Step: Implement `mirrorAcrossAABB` plus the internal LOS helper.**

```ts
// append to src/sim/ai/targeting.ts
import type { AABB } from '../types';

export function mirrorAcrossAABB(point: Vec2, box: AABB): Vec2[] {
  return [
    { x: 2 * box.minX - point.x, y: point.y }, // face 0: left  (x = minX, normal -x)
    { x: 2 * box.maxX - point.x, y: point.y }, // face 1: right (x = maxX, normal +x)
    { x: point.x, y: 2 * box.minY - point.y }, // face 2: bottom (y = minY, normal -y)
    { x: point.x, y: 2 * box.maxY - point.y }, // face 3: top   (y = maxY, normal +y)
  ];
}

// LOS that ignores one wall (the reflecting wall, since the bounce point sits on its surface).
function losIgnoring(from: Vec2, to: Vec2, walls: Wall[], ignore: Wall): boolean {
  for (const w of walls) {
    if (w === ignore || w.destroyed) continue;
    if (raySegmentVsAABB(from, to, w.aabb) !== null) return false;
  }
  return true;
}
```

- [ ] **Step: Run the test to verify it passes.**
  `npx vitest run src/sim/ai/targeting.test.ts -t "mirrorAcrossAABB"`
  Expected: PASS.

- [ ] **Step: Write the failing test** for `bankShot`.

```ts
// append to src/sim/ai/targeting.test.ts
describe('bankShot', () => {
  it('finds a valid single-bounce path off a side wall around a blocker', () => {
    const blocker = wall(1, 1.5, -1, 2.5, 1);            // blocks the direct line (0,0)->(4,0)
    const topWall = wall(2, -5, 2, 10, 3);               // bounce surface: bottom face y=2
    const walls = [blocker, topWall];
    const angle = bankShot({ x: 0, y: 0 }, { x: 4, y: 0 }, walls, 3);
    expect(angle).not.toBeNull();
    // bounce point is (2,2) -> firing angle = atan2(2,2) = pi/4
    expect(angle as number).toBeCloseTo(Math.PI / 4, 6);
  });

  it('returns null when the target has no valid bank path (only the blocker exists)', () => {
    const blocker = wall(1, 1.5, -1, 2.5, 1);
    const angle = bankShot({ x: 0, y: 0 }, { x: 4, y: 0 }, [blocker], 3);
    expect(angle).toBeNull();
  });

  it('reflected direction across the chosen face points at the real target', () => {
    const blocker = wall(1, 1.5, -1, 2.5, 1);
    const topWall = wall(2, -5, 2, 10, 3);
    const angle = bankShot({ x: 0, y: 0 }, { x: 4, y: 0 }, [blocker, topWall], 3) as number;
    // The shot travels (0,0)->(2,2); reflecting velocity across the horizontal face flips y:
    // dir (1,1) becomes (1,-1); from (2,2) that reaches (4,0) = the target.
    const dir = { x: Math.cos(angle), y: Math.sin(angle) };
    const reflected = { x: dir.x, y: -dir.y };
    // parametric from bounce (2,2): (2,2) + reflected * 2 == (4,0)
    expect(2 + reflected.x * 2).toBeCloseTo(4, 6);
    expect(2 + reflected.y * 2).toBeCloseTo(0, 6);
  });
});
```

- [ ] **Step: Run the test to verify it fails.**
  `npx vitest run src/sim/ai/targeting.test.ts -t "bankShot"`
  Expected: FAIL — `bankShot` is not a function.

- [ ] **Step: Implement `bankShot`.**

```ts
// append to src/sim/ai/targeting.ts
const FACE_NORMALS: Vec2[] = [
  { x: -1, y: 0 }, // 0 left
  { x: 1, y: 0 },  // 1 right
  { x: 0, y: -1 }, // 2 bottom
  { x: 0, y: 1 },  // 3 top
];

export function bankShot(muzzle: Vec2, target: Vec2, walls: Wall[], maxBounces: number): number | null {
  if (maxBounces < 1) return null;
  for (const w of walls) {
    if (w.destroyed) continue;
    const mirrors = mirrorAcrossAABB(target, w.aabb);
    for (let face = 0; face < 4; face++) {
      const mirror = mirrors[face];
      const hit = raySegmentVsAABB(muzzle, mirror, w.aabb);
      if (!hit) continue;
      // The ray must enter through the intended reflecting face (normals are exact ±1/0).
      const n = FACE_NORMALS[face];
      if (hit.normal.x !== n.x || hit.normal.y !== n.y) continue;
      const bounce = hit.point;
      // Clear line to the wall, and clear line from the bounce point to the real target.
      if (!losIgnoring(muzzle, bounce, walls, w)) continue;
      if (!losIgnoring(bounce, target, walls, w)) continue;
      return angleOf(vsub(bounce, muzzle));
    }
  }
  return null;
}
```

- [ ] **Step: Run the test to verify it passes.**
  `npx vitest run src/sim/ai/targeting.test.ts`
  Expected: PASS (all targeting tests, including `bankShot`).

- [ ] **Step: Commit.**
  `git add src/sim/ai/targeting.ts src/sim/ai/targeting.test.ts && git commit -m "AI targeting: mirrorAcrossAABB + single-bounce bankShot"`

---

### Task 18: AI danger-avoidance (incoming bullets and own mines)

**Files:**
- Modify: `src/sim/ai/targeting.ts`
- Create: `src/sim/ai/danger.test.ts`
- Test: `src/sim/ai/danger.test.ts`

**Interfaces:**

Consumes:
- `interface World { tick; nextId; seed; tanks; bullets; mines; walls; spawns; status; lives }` (task 8)
- `interface Bullet`, `interface Mine`, `interface Tank`, `type Vec2` (task 2)
- `function vsub`, `function vdot`, `function vdist`, `function vnorm` (task 2)
- `const TANK_RADIUS = 0.5`, `const MINE_PROXIMITY_RADIUS = 1.5` (task 3)

Produces:
- `function incomingThreats(world: World, tank: Tank): Bullet[]` — live bullets (not owned by `tank`) whose forward path passes within a danger corridor of the tank inside a lookahead horizon.
- `function dangerAvoidMove(world: World, tank: Tank): Vec2 | null` — unit move direction perpendicular-away from the nearest incoming bullet, or away from a nearby armed mine (including the tank's own), or `null` when safe. Overrides normal behavior when non-null.

Steps:

- [ ] **Step: Write the failing test** for `incomingThreats`.

```ts
// src/sim/ai/danger.test.ts
import { describe, it, expect } from 'vitest';
import { incomingThreats, dangerAvoidMove } from './targeting';
import type { Tank, Bullet, Mine, Vec2 } from '../types';
import type { World } from '../world';

function tank(id: number, pos: Vec2): Tank {
  return {
    id, kind: 'grey', pos, bodyAngle: 0, turretAngle: 0, alive: true,
    desiredMove: { x: 0, y: 0 }, activeMineIds: [], fireCooldown: 0, mineCooldown: 0,
    aiState: 'idle', aiTimer: 0,
  };
}
function bullet(id: number, ownerId: number, pos: Vec2, vel: Vec2): Bullet {
  return { id, ownerId, type: 'normal', pos, vel, bouncesLeft: 1, alive: true };
}
function world(over: Partial<World>): World {
  return {
    tick: 0, nextId: 100, seed: 1, tanks: [], bullets: [], mines: [], walls: [],
    spawns: [], status: 'playing', lives: 3, ...over,
  };
}

describe('incomingThreats', () => {
  it('flags a bullet whose path passes through the tank', () => {
    const t = tank(1, { x: 3, y: 0 });
    const b = bullet(50, 99, { x: 0, y: 0 }, { x: 6, y: 0 }); // heading +x straight at the tank
    const w = world({ tanks: [t], bullets: [b] });
    expect(incomingThreats(w, t).map((x) => x.id)).toContain(50);
  });

  it('does not flag a bullet heading away from the tank', () => {
    const t = tank(1, { x: 3, y: 0 });
    const b = bullet(50, 99, { x: 0, y: 0 }, { x: -6, y: 0 }); // heading -x, away
    const w = world({ tanks: [t], bullets: [b] });
    expect(incomingThreats(w, t)).toHaveLength(0);
  });

  it('ignores the tank\'s own bullets', () => {
    const t = tank(1, { x: 3, y: 0 });
    const b = bullet(50, 1, { x: 0, y: 0 }, { x: 6, y: 0 }); // owner is the tank itself
    const w = world({ tanks: [t], bullets: [b] });
    expect(incomingThreats(w, t)).toHaveLength(0);
  });
});
```

- [ ] **Step: Run the test to verify it fails.**
  `npx vitest run src/sim/ai/danger.test.ts -t "incomingThreats"`
  Expected: FAIL — `incomingThreats` is not exported.

- [ ] **Step: Implement `incomingThreats`.**

```ts
// append to src/sim/ai/targeting.ts
import type { World } from '../world';
import type { Bullet, Tank } from '../types';
import { vdot, vdist, vnorm } from '../types';
import { TANK_RADIUS, MINE_PROXIMITY_RADIUS } from '../constants';

const THREAT_HORIZON = 1.0;                 // seconds of lookahead
const DANGER_CORRIDOR = TANK_RADIUS + 0.3;  // lateral half-width the bullet may pass within

export function incomingThreats(world: World, tank: Tank): Bullet[] {
  const out: Bullet[] = [];
  for (const b of world.bullets) {
    if (!b.alive || b.ownerId === tank.id) continue;
    const speed = Math.hypot(b.vel.x, b.vel.y);
    if (speed < 1e-6) continue;
    const dir = vnorm(b.vel);
    const rel = { x: tank.pos.x - b.pos.x, y: tank.pos.y - b.pos.y };
    const along = vdot(rel, dir);
    if (along < 0) continue;                     // bullet already past / moving away
    if (along > speed * THREAT_HORIZON) continue; // too far ahead in time
    const perp = { x: rel.x - dir.x * along, y: rel.y - dir.y * along };
    if (Math.hypot(perp.x, perp.y) <= DANGER_CORRIDOR) out.push(b);
  }
  return out;
}
```

- [ ] **Step: Run the test to verify it passes.**
  `npx vitest run src/sim/ai/danger.test.ts -t "incomingThreats"`
  Expected: PASS (3 tests).

- [ ] **Step: Write the failing test** for `dangerAvoidMove`.

```ts
// append to src/sim/ai/danger.test.ts
function mine(id: number, ownerId: number, pos: Vec2, armed: boolean): Mine {
  return { id, ownerId, pos, timer: 3, armed, detonated: false };
}

describe('dangerAvoidMove', () => {
  it('dodges laterally (perpendicular) to an incoming bullet, not backward into it', () => {
    const t = tank(1, { x: 3, y: 0.1 });
    const b = bullet(50, 99, { x: 0, y: 0 }, { x: 6, y: 0 }); // heading +x
    const w = world({ tanks: [t], bullets: [b] });
    const move = dangerAvoidMove(w, t)!;
    expect(move).not.toBeNull();
    // move is perpendicular to the bullet direction (dot ~ 0), i.e. sideways
    expect(Math.abs(move.x * 1 + move.y * 0)).toBeCloseTo(0, 6);
    // it's a unit vector
    expect(Math.hypot(move.x, move.y)).toBeCloseTo(1, 6);
  });

  it('moves away from a nearby armed mine (including its own)', () => {
    const t = tank(1, { x: 0, y: 0 });
    const m = mine(70, 1, { x: 1, y: 0 }, true); // own mine, armed, within proximity
    const w = world({ tanks: [t], mines: [m] });
    const move = dangerAvoidMove(w, t)!;
    // direction points away from the mine (negative x component dominant)
    expect(move.x).toBeLessThan(0);
  });

  it('returns null when nothing threatens', () => {
    const t = tank(1, { x: 0, y: 0 });
    const w = world({ tanks: [t] });
    expect(dangerAvoidMove(w, t)).toBeNull();
  });
});
```

- [ ] **Step: Run the test to verify it fails.**
  `npx vitest run src/sim/ai/danger.test.ts -t "dangerAvoidMove"`
  Expected: FAIL — `dangerAvoidMove` is not a function.

- [ ] **Step: Implement `dangerAvoidMove`.**

```ts
// append to src/sim/ai/targeting.ts
export function dangerAvoidMove(world: World, tank: Tank): Vec2 | null {
  const threats = incomingThreats(world, tank);
  if (threats.length > 0) {
    let nearest = threats[0];
    let best = vdist(nearest.pos, tank.pos);
    for (const b of threats) {
      const d = vdist(b.pos, tank.pos);
      if (d < best) { best = d; nearest = b; }
    }
    const dir = vnorm(nearest.vel);
    const perpA = { x: -dir.y, y: dir.x };
    const perpB = { x: dir.y, y: -dir.x };
    // pick the perpendicular on the side the tank already sits, so it dodges outward
    const rel = { x: tank.pos.x - nearest.pos.x, y: tank.pos.y - nearest.pos.y };
    return vdot(rel, perpA) >= 0 ? perpA : perpB;
  }

  for (const m of world.mines) {
    if (m.detonated || !m.armed) continue;
    if (vdist(m.pos, tank.pos) < MINE_PROXIMITY_RADIUS + TANK_RADIUS) {
      const away = { x: tank.pos.x - m.pos.x, y: tank.pos.y - m.pos.y };
      if (Math.hypot(away.x, away.y) < 1e-6) return { x: 1, y: 0 };
      return vnorm(away);
    }
  }
  return null;
}
```

- [ ] **Step: Run the test to verify it passes.**
  `npx vitest run src/sim/ai/danger.test.ts`
  Expected: PASS (all `incomingThreats` + `dangerAvoidMove` tests).

- [ ] **Step: Commit.**
  `git add src/sim/ai/targeting.ts src/sim/ai/danger.test.ts && git commit -m "AI targeting: incomingThreats + dangerAvoidMove dodge logic"`

---

### Task 19: Brown AI — stationary gunner + AiDecision contract

**Files:**
- Create: `src/sim/ai/brown.ts`
- Create: `src/sim/ai/brown.test.ts`
- Test: `src/sim/ai/brown.test.ts`

**Interfaces:**

Consumes:
- `interface World` (task 8); `interface Tank`, `type Vec2`, `type BulletType`, `type AiState`, `function vscale(a: Vec2, s: number): Vec2` (task 2)
- `function lineOfSight(from, to, walls): boolean`, `function aimLead(muzzle, target, targetVel, bulletSpeed): number` (task 16)
- `const bulletConfig: Record<BulletType, { speed; bounces }>`, `const TANK_SPEED = 3.0` (task 3)

Produces (AiDecision defined HERE — grey/teal reuse it):
- `interface AiDecision { desiredMove: Vec2; turretAngle: number; fire: boolean; fireType: BulletType; mine: boolean; nextState: AiState }`
- `function brownDecision(world: World, tank: Tank): AiDecision` — never moves (`{0,0}`); rotates turret to lead the player (aimLead with normal-shell speed); fires `normal` only with line-of-sight to the player; walks Idle→Aim→Fire→Reposition (Reposition is a no-op cooldown for Brown).

Steps:

- [ ] **Step: Write the failing test.**

```ts
// src/sim/ai/brown.test.ts
import { describe, it, expect } from 'vitest';
import { brownDecision } from './brown';
import type { Tank, Vec2, Wall, AiState } from '../types';
import type { World } from '../world';

function tank(id: number, kind: Tank['kind'], pos: Vec2, over: Partial<Tank> = {}): Tank {
  return {
    id, kind, pos, bodyAngle: 0, turretAngle: 0, alive: true,
    desiredMove: { x: 0, y: 0 }, activeMineIds: [], fireCooldown: 0, mineCooldown: 0,
    aiState: 'idle', aiTimer: 0, ...over,
  };
}
function wall(id: number, minX: number, minY: number, maxX: number, maxY: number): Wall {
  return { id, aabb: { minX, minY, maxX, maxY }, kind: 'solid', destroyed: false };
}
function world(tanks: Tank[], walls: Wall[] = []): World {
  return {
    tick: 0, nextId: 100, seed: 1, tanks, bullets: [], mines: [], walls,
    spawns: [], status: 'playing', lives: 3,
  };
}

describe('brownDecision', () => {
  it('never moves', () => {
    const brown = tank(1, 'brown', { x: 0, y: 0 }, { aiState: 'aim' });
    const player = tank(2, 'player', { x: 5, y: 0 });
    const d = brownDecision(world([brown, player]), brown);
    expect(d.desiredMove).toEqual({ x: 0, y: 0 });
    expect(d.fireType).toBe('normal');
  });

  it('leads a moving player (turret angle offset from the direct angle)', () => {
    const brown = tank(1, 'brown', { x: 0, y: 0 }, { aiState: 'aim' });
    const player = tank(2, 'player', { x: 5, y: 0 }, { desiredMove: { x: 0, y: 1 } });
    const d = brownDecision(world([brown, player]), brown);
    // direct angle to (5,0) is 0; leading a +y mover pushes the aim above 0
    expect(d.turretAngle).toBeGreaterThan(0);
  });

  it('fires only with clear line-of-sight, and advances Aim -> Fire', () => {
    const brown = tank(1, 'brown', { x: 0, y: 0 }, { aiState: 'aim' });
    const player = tank(2, 'player', { x: 5, y: 0 });
    const d = brownDecision(world([brown, player]), brown);
    expect(d.fire).toBe(true);
    expect(d.nextState).toBe('fire');
  });

  it('does not fire when a wall blocks line-of-sight', () => {
    const brown = tank(1, 'brown', { x: 0, y: 0 }, { aiState: 'aim' });
    const player = tank(2, 'player', { x: 5, y: 0 });
    const walls = [wall(9, 2, -1, 3, 1)]; // between brown and player
    const d = brownDecision(world([brown, player], walls), brown);
    expect(d.fire).toBe(false);
  });

  it('returns to a cooldown state after firing (Fire -> Reposition)', () => {
    const brown = tank(1, 'brown', { x: 0, y: 0 }, { aiState: 'fire' });
    const player = tank(2, 'player', { x: 5, y: 0 });
    const d = brownDecision(world([brown, player]), brown);
    expect(d.fire).toBe(false);
    expect(d.nextState).toBe('reposition');
  });
});
```

- [ ] **Step: Run the test to verify it fails.**
  `npx vitest run src/sim/ai/brown.test.ts`
  Expected: FAIL — module `./brown` cannot be resolved / `brownDecision` not exported.

- [ ] **Step: Implement `AiDecision` + `brownDecision`.**

```ts
// src/sim/ai/brown.ts
import type { World } from '../world';
import type { Tank, Vec2, BulletType, AiState } from '../types';
import { vscale } from '../types';
import { lineOfSight, aimLead } from './targeting';
import { bulletConfig, TANK_SPEED } from '../constants';

export interface AiDecision {
  desiredMove: Vec2;
  turretAngle: number;
  fire: boolean;
  fireType: BulletType;
  mine: boolean;
  nextState: AiState;
}

export function brownDecision(world: World, tank: Tank): AiDecision {
  const player = world.tanks.find((t) => t.kind === 'player' && t.alive);
  if (!player) {
    return { desiredMove: { x: 0, y: 0 }, turretAngle: tank.turretAngle, fire: false, fireType: 'normal', mine: false, nextState: 'idle' };
  }

  const speed = bulletConfig.normal.speed;
  const los = lineOfSight(tank.pos, player.pos, world.walls);
  const targetVel = vscale(player.desiredMove, TANK_SPEED);
  const turretAngle = los ? aimLead(tank.pos, player.pos, targetVel, speed) : tank.turretAngle;

  let fire = false;
  let nextState: AiState = tank.aiState;
  switch (tank.aiState) {
    case 'idle':
      nextState = los ? 'aim' : 'idle';
      break;
    case 'aim':
      if (los) { fire = true; nextState = 'fire'; }
      else nextState = 'idle';
      break;
    case 'fire':
      nextState = 'reposition';
      break;
    case 'reposition':
      nextState = 'idle';
      break;
  }

  return { desiredMove: { x: 0, y: 0 }, turretAngle, fire, fireType: 'normal', mine: false, nextState };
}
```

- [ ] **Step: Run the test to verify it passes.**
  `npx vitest run src/sim/ai/brown.test.ts`
  Expected: PASS (5 tests).

- [ ] **Step: Commit.**
  `git add src/sim/ai/brown.ts src/sim/ai/brown.test.ts && git commit -m "Brown AI: stationary gunner + AiDecision contract"`

---

### Task 20: Grey AI — roamer with dodging

**Files:**
- Create: `src/sim/ai/grey.ts`
- Create: `src/sim/ai/grey.test.ts`
- Test: `src/sim/ai/grey.test.ts`

**Interfaces:**

Consumes:
- `interface AiDecision` (task 19); `interface World`, `interface Tank`, `type Vec2`, `type AiState`, `function fromAngle(r: number): Vec2`, `function vscale(a: Vec2, s: number): Vec2`, `function vdot(a: Vec2, b: Vec2): number`, `function nextRng(seed: number): { value: number; seed: number }` (task 2/8)
- `function lineOfSight`, `function aimLead` (task 16); `function dangerAvoidMove(world, tank): Vec2 | null` (task 18)
- `const bulletConfig`, `const TANK_SPEED` (task 3)

Produces:
- `function greyDecision(world: World, tank: Tank): AiDecision` — wanders open space using the seeded PRNG (`world.seed + tank.id`, never `Math.random`), fires straight `normal` shots with line-of-sight, and lets `dangerAvoidMove` override its wander (dodging bullets and its own armed mines).

Steps:

- [ ] **Step: Write the failing test.**

```ts
// src/sim/ai/grey.test.ts
import { describe, it, expect } from 'vitest';
import { greyDecision } from './grey';
import type { Tank, Vec2, Wall, Bullet } from '../types';
import type { World } from '../world';

function tank(id: number, kind: Tank['kind'], pos: Vec2, over: Partial<Tank> = {}): Tank {
  return {
    id, kind, pos, bodyAngle: 0, turretAngle: 0, alive: true,
    desiredMove: { x: 0, y: 0 }, activeMineIds: [], fireCooldown: 0, mineCooldown: 0,
    aiState: 'idle', aiTimer: 0, ...over,
  };
}
function bullet(id: number, ownerId: number, pos: Vec2, vel: Vec2): Bullet {
  return { id, ownerId, type: 'normal', pos, vel, bouncesLeft: 1, alive: true };
}
function wall(id: number, minX: number, minY: number, maxX: number, maxY: number): Wall {
  return { id, aabb: { minX, minY, maxX, maxY }, kind: 'solid', destroyed: false };
}
function world(over: Partial<World>): World {
  return {
    tick: 0, nextId: 100, seed: 7, tanks: [], bullets: [], mines: [], walls: [],
    spawns: [], status: 'playing', lives: 3, ...over,
  };
}

describe('greyDecision', () => {
  it('wander direction is deterministic for a fixed seed (reproducible)', () => {
    const grey = tank(1, 'grey', { x: 0, y: 0 });
    const w = world({ tanks: [grey] }); // no player, no threats -> pure wander
    const a = greyDecision(w, grey);
    const b = greyDecision(w, grey);
    expect(a.desiredMove).toEqual(b.desiredMove);
    expect(Math.hypot(a.desiredMove.x, a.desiredMove.y)).toBeCloseTo(1, 6);
  });

  it('an incoming bullet overrides wander with a lateral dodge', () => {
    const grey = tank(1, 'grey', { x: 3, y: 0 });
    const b = bullet(50, 99, { x: 0, y: 0 }, { x: 6, y: 0 }); // straight at grey
    const w = world({ tanks: [grey], bullets: [b] });
    const d = greyDecision(w, grey);
    // dodge is perpendicular to the bullet's +x direction
    expect(Math.abs(d.desiredMove.x)).toBeCloseTo(0, 6);
    expect(Math.abs(d.desiredMove.y)).toBeCloseTo(1, 6);
  });

  it('fires normal only with line-of-sight', () => {
    const grey = tank(1, 'grey', { x: 0, y: 0 });
    const player = tank(2, 'player', { x: 5, y: 0 });
    const clear = greyDecision(world({ tanks: [grey, player] }), grey);
    expect(clear.fire).toBe(true);
    expect(clear.fireType).toBe('normal');

    const blocked = greyDecision(world({ tanks: [grey, player], walls: [wall(9, 2, -1, 3, 1)] }), grey);
    expect(blocked.fire).toBe(false);
  });

  it('steers away from its own armed mine\'s blast radius', () => {
    const grey = tank(1, 'grey', { x: 0, y: 0 });
    const w = world({
      tanks: [grey],
      mines: [{ id: 70, ownerId: 1, pos: { x: 1, y: 0 }, timer: 3, armed: true, detonated: false }],
    });
    const d = greyDecision(w, grey);
    // moving away from the mine at +x means a negative x component
    expect(d.desiredMove.x).toBeLessThan(0);
  });
});
```

- [ ] **Step: Run the test to verify it fails.**
  `npx vitest run src/sim/ai/grey.test.ts`
  Expected: FAIL — module `./grey` cannot be resolved / `greyDecision` not exported.

- [ ] **Step: Implement `greyDecision`.**

```ts
// src/sim/ai/grey.ts
import type { World } from '../world';
import type { Tank, Vec2, AiState } from '../types';
import { fromAngle, vscale, nextRng } from '../types';
import { lineOfSight, aimLead, dangerAvoidMove } from './targeting';
import { bulletConfig, TANK_SPEED } from '../constants';

const WANDER_TICKS = 30; // hold a wander heading ~0.5s before repicking

export function greyDecision(world: World, tank: Tank): AiDecision {
  const bucket = Math.floor(world.tick / WANDER_TICKS);
  const rng = nextRng(world.seed + tank.id * 1000 + bucket);
  let move: Vec2 = fromAngle(rng.value * Math.PI * 2);

  const avoid = dangerAvoidMove(world, tank);
  if (avoid) move = avoid;

  const player = world.tanks.find((t) => t.kind === 'player' && t.alive);
  let turretAngle = tank.turretAngle;
  let fire = false;
  let nextState: AiState = tank.aiState;

  if (player) {
    if (lineOfSight(tank.pos, player.pos, world.walls)) {
      const targetVel = vscale(player.desiredMove, TANK_SPEED);
      turretAngle = aimLead(tank.pos, player.pos, targetVel, bulletConfig.normal.speed);
      fire = true;
      nextState = 'fire';
    } else {
      nextState = 'reposition';
    }
  }

  return { desiredMove: move, turretAngle, fire, fireType: 'normal', mine: false, nextState };
}

import type { AiDecision } from './brown';
```

Note: keep the `import type { AiDecision } from './brown'` line at the top with the other imports when writing the file; it is shown last here only for readability — TypeScript hoists imports regardless of position.

- [ ] **Step: Run the test to verify it passes.**
  `npx vitest run src/sim/ai/grey.test.ts`
  Expected: PASS (4 tests).

- [ ] **Step: Commit.**
  `git add src/sim/ai/grey.ts src/sim/ai/grey.test.ts && git commit -m "Grey AI: wandering roamer with bullet/mine dodging"`

---

### Task 21: Teal AI — bank-shooter

**Files:**
- Create: `src/sim/ai/teal.ts`
- Create: `src/sim/ai/teal.test.ts`
- Test: `src/sim/ai/teal.test.ts`

**Interfaces:**

Consumes:
- `interface AiDecision` (task 19); `interface World`, `interface Tank`, `type Vec2`, `type AiState`, `function fromAngle`, `function vscale`, `function nextRng` (task 2/8)
- `function lineOfSight`, `function aimLead` (task 16); `function bankShot(muzzle, target, walls, maxBounces): number | null` (task 17); `function dangerAvoidMove` (task 18)
- `const bulletConfig` (ricochet), `const TANK_SPEED`, `const RICOCHET_BOUNCES = 3` (task 3)

Produces:
- `function tealDecision(world: World, tank: Tank): AiDecision` — mobile; prefers a direct `ricochet` shot with line-of-sight; otherwise computes a `bankShot` bounce path and fires `ricochet` along it; when NEITHER exists it repositions (moves, never falls back to a direct/rocket shot); obeys `dangerAvoidMove` overrides.

Steps:

- [ ] **Step: Write the failing test.**

```ts
// src/sim/ai/teal.test.ts
import { describe, it, expect } from 'vitest';
import { tealDecision } from './teal';
import type { Tank, Vec2, Wall, Bullet } from '../types';
import type { World } from '../world';

function tank(id: number, kind: Tank['kind'], pos: Vec2, over: Partial<Tank> = {}): Tank {
  return {
    id, kind, pos, bodyAngle: 0, turretAngle: 0, alive: true,
    desiredMove: { x: 0, y: 0 }, activeMineIds: [], fireCooldown: 0, mineCooldown: 0,
    aiState: 'idle', aiTimer: 0, ...over,
  };
}
function bullet(id: number, ownerId: number, pos: Vec2, vel: Vec2): Bullet {
  return { id, ownerId, type: 'normal', pos, vel, bouncesLeft: 1, alive: true };
}
function wall(id: number, minX: number, minY: number, maxX: number, maxY: number): Wall {
  return { id, aabb: { minX, minY, maxX, maxY }, kind: 'solid', destroyed: false };
}
function world(over: Partial<World>): World {
  return {
    tick: 0, nextId: 100, seed: 3, tanks: [], bullets: [], mines: [], walls: [],
    spawns: [], status: 'playing', lives: 3, ...over,
  };
}

describe('tealDecision', () => {
  it('takes a direct ricochet shot when line-of-sight is clear', () => {
    const teal = tank(1, 'teal', { x: 0, y: 0 });
    const player = tank(2, 'player', { x: 5, y: 0 });
    const d = tealDecision(world({ tanks: [teal, player] }), teal);
    expect(d.fire).toBe(true);
    expect(d.fireType).toBe('ricochet');
  });

  it('fires a bank shot when the player is behind cover but a bank path exists', () => {
    const teal = tank(1, 'teal', { x: 0, y: 0 });
    const player = tank(2, 'player', { x: 4, y: 0 });
    const walls = [wall(1, 1.5, -1, 2.5, 1), wall(2, -5, 2, 10, 3)]; // blocker + top bounce wall
    const d = tealDecision(world({ tanks: [teal, player], walls }), teal);
    expect(d.fire).toBe(true);
    expect(d.fireType).toBe('ricochet');
    expect(d.turretAngle).toBeCloseTo(Math.PI / 4, 6); // bounce point (2,2)
  });

  it('repositions (no fire) when neither a direct nor a bank shot exists', () => {
    const teal = tank(1, 'teal', { x: 0, y: 0 });
    const player = tank(2, 'player', { x: 4, y: 0 });
    const walls = [wall(1, 1.5, -1, 2.5, 1)]; // only the blocker, no bounce surface
    const d = tealDecision(world({ tanks: [teal, player], walls }), teal);
    expect(d.fire).toBe(false);
    expect(d.nextState).toBe('reposition');
    expect(Math.hypot(d.desiredMove.x, d.desiredMove.y)).toBeGreaterThan(0);
  });

  it('dodges incoming fire instead of shooting', () => {
    const teal = tank(1, 'teal', { x: 3, y: 0 });
    const player = tank(2, 'player', { x: 5, y: 0 });
    const b = bullet(50, 99, { x: 0, y: 0 }, { x: 6, y: 0 }); // straight at teal
    const d = tealDecision(world({ tanks: [teal, player], bullets: [b] }), teal);
    expect(d.fire).toBe(false);
    expect(Math.abs(d.desiredMove.x)).toBeCloseTo(0, 6); // lateral dodge
  });
});
```

- [ ] **Step: Run the test to verify it fails.**
  `npx vitest run src/sim/ai/teal.test.ts`
  Expected: FAIL — module `./teal` cannot be resolved / `tealDecision` not exported.

- [ ] **Step: Implement `tealDecision`.**

```ts
// src/sim/ai/teal.ts
import type { World } from '../world';
import type { Tank, Vec2 } from '../types';
import type { AiDecision } from './brown';
import { fromAngle, vscale, nextRng } from '../types';
import { lineOfSight, aimLead, bankShot, dangerAvoidMove } from './targeting';
import { bulletConfig, TANK_SPEED, RICOCHET_BOUNCES } from '../constants';

const WANDER_TICKS = 30;

export function tealDecision(world: World, tank: Tank): AiDecision {
  // Dodging overrides everything.
  const avoid = dangerAvoidMove(world, tank);
  if (avoid) {
    return { desiredMove: avoid, turretAngle: tank.turretAngle, fire: false, fireType: 'ricochet', mine: false, nextState: 'reposition' };
  }

  const player = world.tanks.find((t) => t.kind === 'player' && t.alive);
  if (!player) {
    return { desiredMove: { x: 0, y: 0 }, turretAngle: tank.turretAngle, fire: false, fireType: 'ricochet', mine: false, nextState: 'idle' };
  }

  const speed = bulletConfig.ricochet.speed;

  // 1) Direct ricochet shot when visible.
  if (lineOfSight(tank.pos, player.pos, world.walls)) {
    const targetVel = vscale(player.desiredMove, TANK_SPEED);
    const turretAngle = aimLead(tank.pos, player.pos, targetVel, speed);
    return { desiredMove: { x: 0, y: 0 }, turretAngle, fire: true, fireType: 'ricochet', mine: false, nextState: 'fire' };
  }

  // 2) Bank shot around cover.
  const bank = bankShot(tank.pos, player.pos, world.walls, RICOCHET_BOUNCES);
  if (bank !== null) {
    return { desiredMove: { x: 0, y: 0 }, turretAngle: bank, fire: true, fireType: 'ricochet', mine: false, nextState: 'fire' };
  }

  // 3) Neither: reposition (never a fallback rocket/direct shot).
  const bucket = Math.floor(world.tick / WANDER_TICKS);
  const rng = nextRng(world.seed + tank.id * 1000 + bucket);
  const move: Vec2 = fromAngle(rng.value * Math.PI * 2);
  return { desiredMove: move, turretAngle: tank.turretAngle, fire: false, fireType: 'ricochet', mine: false, nextState: 'reposition' };
}
```

- [ ] **Step: Run the test to verify it passes.**
  `npx vitest run src/sim/ai/teal.test.ts`
  Expected: PASS (4 tests).

- [ ] **Step: Commit.**
  `git add src/sim/ai/teal.ts src/sim/ai/teal.test.ts && git commit -m "Teal AI: bank-shooter with direct/bank/reposition decision tree"`

---

### Task 22: AI dispatcher and integration into step()

**Files:**
- Create: `src/sim/ai/index.ts`
- Modify: `src/sim/world.ts`
- Create: `src/sim/ai/dispatch.test.ts`
- Test: `src/sim/ai/dispatch.test.ts`

**Interfaces:**

Consumes:
- `interface AiDecision` (task 19); `function brownDecision`, `function greyDecision`, `function tealDecision` (tasks 19-21)
- `function spawnBullet(world, ownerId, angle, type, events): boolean` (task 10); `function dropMine(world, ownerId, events): boolean` (task 13)
- `interface World`, `interface Tank` (task 8/2); `type SimEvent` (task 4)
- `const FIRE_COOLDOWN = 0.4`, `const MINE_COOLDOWN = 0.5`, `const DT = 1/60` (task 3) — enemy `fireCooldown`/`mineCooldown` are decremented here because task 15's `applyPlayerInput` only touches the player, so this is the single place enemy cooldowns tick.

Produces:
- `function decideAi(world: World, tank: Tank): AiDecision` — dispatches by `tank.kind` (brown/grey/teal).
- `function stepAi(world: World, events: SimEvent[]): void` — for every alive enemy: decrements its cooldowns, gets its `AiDecision`, writes `desiredMove`/`turretAngle`/`aiState`/`aiTimer` onto the tank, respects `fireCooldown` before `spawnBullet(fireType)` (enemies are not shell-capped), and drops mines when decided. Wired into `step()` right after `applyPlayerInput` and before `stepMovement`.

Steps:

- [ ] **Step: Write the failing test.**

```ts
// src/sim/ai/dispatch.test.ts
import { describe, it, expect } from 'vitest';
import { decideAi, stepAi } from './index';
import { FIRE_COOLDOWN } from '../constants';
import type { Tank, Vec2 } from '../types';
import type { World } from '../world';
import type { SimEvent } from '../events';

function tank(id: number, kind: Tank['kind'], pos: Vec2, over: Partial<Tank> = {}): Tank {
  return {
    id, kind, pos, bodyAngle: 0, turretAngle: 0, alive: true,
    desiredMove: { x: 0, y: 0 }, activeMineIds: [], fireCooldown: 0, mineCooldown: 0,
    aiState: 'idle', aiTimer: 0, ...over,
  };
}
function world(tanks: Tank[]): World {
  return {
    tick: 0, nextId: 100, seed: 5, tanks, bullets: [], mines: [], walls: [],
    spawns: [], status: 'playing', lives: 3,
  };
}

describe('decideAi', () => {
  it('routes by tank kind (Brown never moves)', () => {
    const brown = tank(1, 'brown', { x: 0, y: 0 }, { aiState: 'aim' });
    const player = tank(2, 'player', { x: 5, y: 0 });
    const d = decideAi(world([brown, player]), brown);
    expect(d.desiredMove).toEqual({ x: 0, y: 0 });
  });
});

describe('stepAi', () => {
  it('leaves a Brown stationary (desiredMove {0,0})', () => {
    const brown = tank(1, 'brown', { x: 0, y: 0 }, { aiState: 'aim' });
    const player = tank(2, 'player', { x: 5, y: 0 });
    const w = world([brown, player]);
    stepAi(w, []);
    expect(w.tanks[0].desiredMove).toEqual({ x: 0, y: 0 });
  });

  it('creates enemy bullets via spawnBullet when the enemy decides to fire', () => {
    const grey = tank(1, 'grey', { x: 0, y: 0 });
    const player = tank(2, 'player', { x: 5, y: 0 }); // clear LOS -> grey fires
    const w = world([grey, player]);
    const events: SimEvent[] = [];
    stepAi(w, events);
    expect(w.bullets.length).toBe(1);
    expect(w.bullets[0].ownerId).toBe(1);
    expect(events.some((e) => e.type === 'fire')).toBe(true);
  });

  it('respects fireCooldown (no every-tick spam)', () => {
    const grey = tank(1, 'grey', { x: 0, y: 0 });
    const player = tank(2, 'player', { x: 5, y: 0 });
    const w = world([grey, player]);
    stepAi(w, []);
    expect(w.bullets.length).toBe(1);
    expect(w.tanks[0].fireCooldown).toBeCloseTo(FIRE_COOLDOWN, 6);
    stepAi(w, []); // cooldown still active
    expect(w.bullets.length).toBe(1);
  });

  it('is deterministic across identical worlds', () => {
    const build = () => world([tank(1, 'grey', { x: 0, y: 0 }), tank(2, 'player', { x: 5, y: 0 })]);
    const a = build(); const b = build();
    stepAi(a, []); stepAi(b, []);
    expect(JSON.stringify(a.bullets)).toBe(JSON.stringify(b.bullets));
  });
});
```

- [ ] **Step: Run the test to verify it fails.**
  `npx vitest run src/sim/ai/dispatch.test.ts`
  Expected: FAIL — module `./index` cannot be resolved / `decideAi`/`stepAi` not exported.

- [ ] **Step: Implement `decideAi` + `stepAi`.**

```ts
// src/sim/ai/index.ts
import type { World } from '../world';
import type { Tank } from '../types';
import type { SimEvent } from '../events';
import type { AiDecision } from './brown';
import { brownDecision } from './brown';
import { greyDecision } from './grey';
import { tealDecision } from './teal';
import { spawnBullet } from '../bullets';
import { dropMine } from '../mines';
import { FIRE_COOLDOWN, MINE_COOLDOWN, DT } from '../constants';

export function decideAi(world: World, tank: Tank): AiDecision {
  switch (tank.kind) {
    case 'brown': return brownDecision(world, tank);
    case 'grey': return greyDecision(world, tank);
    case 'teal': return tealDecision(world, tank);
    default:
      return { desiredMove: { x: 0, y: 0 }, turretAngle: tank.turretAngle, fire: false, fireType: 'normal', mine: false, nextState: 'idle' };
  }
}

export function stepAi(world: World, events: SimEvent[]): void {
  for (const tank of world.tanks) {
    if (!tank.alive || tank.kind === 'player') continue;

    // Enemy cooldowns tick here (applyPlayerInput only handles the player).
    if (tank.fireCooldown > 0) tank.fireCooldown -= DT;
    if (tank.mineCooldown > 0) tank.mineCooldown -= DT;

    const decision = decideAi(world, tank);
    tank.desiredMove = decision.desiredMove;
    tank.turretAngle = decision.turretAngle;
    tank.aiState = decision.nextState;

    if (decision.fire && tank.fireCooldown <= 0) {
      if (spawnBullet(world, tank.id, decision.turretAngle, decision.fireType, events)) {
        tank.fireCooldown = FIRE_COOLDOWN;
      }
    }
    if (decision.mine && tank.mineCooldown <= 0) {
      if (dropMine(world, tank.id, events)) {
        tank.mineCooldown = MINE_COOLDOWN;
      }
    }
  }
}
```

- [ ] **Step: Run the test to verify it passes.**
  `npx vitest run src/sim/ai/dispatch.test.ts`
  Expected: PASS (5 tests).

- [ ] **Step: Wire `stepAi` into `step()` in `src/sim/world.ts`.**
  Add the import near the other `sim/ai` / update imports at the top of `src/sim/world.ts`:

```ts
import { stepAi } from './ai';
```

  Then, inside `step()`, insert the `stepAi` call between the existing `applyPlayerInput` and `stepMovement` calls (task 15 left this slot for the AI). The surrounding order must read:

```ts
  // ...inside step(), operating on the cloned draft world:
  applyPlayerInput(draft, input, events);
  stepAi(draft, events);          // <-- inserted here (task 22)
  stepMovement(draft, DT);
  stepBullets(draft, DT, events);
  resolveBulletHits(draft, events);
  stepMines(draft, DT, events);
  resolveStatus(draft, events);
```

  If task 15 left a placeholder comment (e.g. `// stepAi added in task 22`), replace that line with the `stepAi(draft, events);` call; otherwise add the call immediately after the `applyPlayerInput(...)` line.

- [ ] **Step: Run the full sim suite to confirm integration didn't regress anything.**
  `npx vitest run src/sim`
  Expected: PASS — all sim tests green, including `world.test.ts` determinism and the new `dispatch.test.ts`.

- [ ] **Step: Commit.**
  `git add src/sim/ai/index.ts src/sim/ai/dispatch.test.ts src/sim/world.ts && git commit -m "AI dispatcher: decideAi + stepAi wired into step()"`

---

### Task 23: Arena data and loader

**Files:**
- Create: `src/sim/arena.ts`
- Test: `src/sim/arena.test.ts`

**Interfaces:**

Consumes: `Wall`, `Tank`, `Spawn`, `AABB`, `TankKind`, `WallKind` (task 2); `raySegmentVsAABB` (task 6, used in the test to prove the direct line is blocked); `bankShot` (task 17, used in the test to prove a valid bank path exists); `World`, `createWorld` (task 8); `LIVES`, `RICOCHET_BOUNCES` (task 3).

Produces:
- `interface Arena { cols: number; rows: number; cellSize: number; grid: string[]; legend: Record<string, WallKind> }` — grid chars: `'#'`=solid, `'x'`=destructible, `'.'`=empty, `'P'`/`'B'`/`'G'`/`'T'`=player/brown/grey/teal spawns.
- `const ARENA_01: Arena` — hand-designed slice arena.
- `function loadArena(arena: Arena): { walls: Wall[]; tanks: Tank[]; spawns: Spawn[] }` — converts wall cells to Wall AABBs, ADDS 4 solid boundary walls around the perimeter, builds tanks+spawns from spawn chars.
- `function createArenaWorld(): World` — `createWorld({ ...loadArena(ARENA_01), lives: LIVES })`.

Steps:

- [ ] **Step: Write the failing test** — create `src/sim/arena.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { ARENA_01, loadArena, createArenaWorld } from './arena';
import { raySegmentVsAABB } from './collision';
import { bankShot } from './ai/targeting';
import { RICOCHET_BOUNCES } from './constants';

function countChar(grid: string[], ch: string): number {
  return grid.reduce((n, row) => n + [...row].filter((c) => c === ch).length, 0);
}

describe('loadArena', () => {
  it('produces the interior walls plus exactly 4 solid boundary walls', () => {
    const { walls } = loadArena(ARENA_01);
    const solidCells = countChar(ARENA_01.grid, '#');
    const destructibleCells = countChar(ARENA_01.grid, 'x');

    expect(walls.length).toBe(solidCells + destructibleCells + 4);

    const destructible = walls.filter((w) => w.kind === 'destructible');
    const solid = walls.filter((w) => w.kind === 'solid');
    expect(destructible.length).toBe(destructibleCells);
    expect(solid.length).toBe(solidCells + 4); // interior solids + 4 boundaries
  });

  it('assigns unique ids across walls and tanks', () => {
    const { walls, tanks } = loadArena(ARENA_01);
    const ids = [...walls.map((w) => w.id), ...tanks.map((t) => t.id)];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('maps spawn chars to the right TankKind at grid-to-world coordinates', () => {
    const { tanks } = loadArena(ARENA_01);
    const kinds = tanks.map((t) => t.kind).sort();
    expect(kinds).toEqual(['brown', 'grey', 'player', 'teal']);

    // Teal spawn is at grid (col 5, row 3), cellSize 2 -> center (11, 7).
    const teal = tanks.find((t) => t.kind === 'teal')!;
    expect(teal.pos).toEqual({ x: 11, y: 7 });
    expect(teal.alive).toBe(true);
  });

  it('has geometry where Teal cannot hit the player directly (bank shot required)', () => {
    const { tanks, walls } = loadArena(ARENA_01);
    const teal = tanks.find((t) => t.kind === 'teal')!;
    const player = tanks.find((t) => t.kind === 'player')!;
    // A direct line from Teal to the player must be blocked by some solid wall,
    // which is exactly what forces Teal into a bank shot.
    const blocked = walls.some(
      (w) => w.kind === 'solid' && raySegmentVsAABB(teal.pos, player.pos, w.aabb) !== null,
    );
    expect(blocked).toBe(true);
  });

  it('affords Teal a real single-bounce bank shot at the player (signature slice feature)', () => {
    const { tanks, walls } = loadArena(ARENA_01);
    const teal = tanks.find((t) => t.kind === 'teal')!;
    const player = tanks.find((t) => t.kind === 'player')!;
    // The direct line is blocked (previous test), so ricochet-around-cover REQUIRES a
    // valid bank path to exist — it is the whole reason Teal (and this slice) exists.
    // If this assertion fails, the geometry does not afford one: TUNE ARENA_01 (widen
    // the side lanes / reposition the flanking blocks) until a single-bounce path is
    // found. Do NOT ship the slice with this red — a bank-less Teal just repositions
    // forever and the signature behavior never appears.
    expect(bankShot(teal.pos, player.pos, walls, RICOCHET_BOUNCES)).not.toBeNull();
  });
});

describe('createArenaWorld', () => {
  it('yields a playing world with a player and three enemies', () => {
    const w = createArenaWorld();
    expect(w.status).toBe('playing');
    expect(w.lives).toBe(3);
    expect(w.tanks.filter((t) => t.kind === 'player').length).toBe(1);
    expect(w.tanks.filter((t) => t.kind !== 'player').length).toBe(3);
    expect(w.nextId).toBeGreaterThan(Math.max(...w.walls.map((wall) => wall.id)));
  });
});
```

- [ ] **Step: Run the test to verify it fails**
  - Command: `npx vitest run src/sim/arena.test.ts`
  - Expected: FAIL — `Cannot find module './arena'` (module not created yet).

- [ ] **Step: Implement minimal code to pass** — create `src/sim/arena.ts`:

```ts
import type { Wall, Tank, Spawn, AABB, TankKind, WallKind } from './types';
import { createWorld, type World } from './world';
import { LIVES } from './constants';

export interface Arena {
  cols: number;
  rows: number;
  cellSize: number;
  grid: string[];
  legend: Record<string, WallKind>;
}

// Hand-designed slice arena. Player at the bottom (row 7), a Brown + Grey + Teal
// across the top (rows 2-3). The center solid block at (col 5, row 4) sits directly
// on the Teal->player line, so Teal must bank a ricochet off a side wall. Flanking
// destructibles ('x') can be blown open by mines to create new lines of fire.
//        col: 0123456789A   (A = 10)
export const ARENA_01: Arena = {
  cols: 11,
  rows: 9,
  cellSize: 2,
  legend: { '#': 'solid', x: 'destructible' },
  grid: [
    '...........', // 0
    '..#.....#..', // 1
    '..#.B.G.#..', // 2  Brown, Grey
    '.....T.....', // 3  Teal
    '..x..#..x..', // 4  center cover + flanking destructibles
    '...........', // 5
    '..#.....#..', // 6
    '..#..P..#..', // 7  Player
    '...........', // 8
  ],
};

const SPAWN_KINDS: Record<string, TankKind> = {
  P: 'player',
  B: 'brown',
  G: 'grey',
  T: 'teal',
};

function makeTank(id: number, kind: TankKind, pos: { x: number; y: number }, angle: number): Tank {
  return {
    id,
    kind,
    pos: { ...pos },
    bodyAngle: angle,
    turretAngle: angle,
    alive: true,
    desiredMove: { x: 0, y: 0 },
    activeMineIds: [],
    fireCooldown: 0,
    mineCooldown: 0,
    aiState: 'idle',
    aiTimer: 0,
  };
}

export function loadArena(arena: Arena): { walls: Wall[]; tanks: Tank[]; spawns: Spawn[] } {
  const { cols, rows, cellSize, grid, legend } = arena;
  const walls: Wall[] = [];
  const tanks: Tank[] = [];
  const spawns: Spawn[] = [];
  let id = 1;

  for (let r = 0; r < rows; r++) {
    const row = grid[r];
    for (let c = 0; c < cols; c++) {
      const ch = row[c];
      const wallKind = legend[ch];
      if (wallKind) {
        walls.push({
          id: id++,
          aabb: {
            minX: c * cellSize,
            minY: r * cellSize,
            maxX: (c + 1) * cellSize,
            maxY: (r + 1) * cellSize,
          },
          kind: wallKind,
          destroyed: false,
        });
      } else if (SPAWN_KINDS[ch]) {
        const kind = SPAWN_KINDS[ch];
        const pos = { x: (c + 0.5) * cellSize, y: (r + 0.5) * cellSize };
        const angle = 0;
        spawns.push({ kind, pos: { ...pos }, angle });
        tanks.push(makeTank(id++, kind, pos, angle));
      }
    }
  }

  // 4 solid boundary walls (thickness = one cell) around the playable area, so
  // reflectSweep bounces bullets off the edges with no map-escape special case.
  const W = cols * cellSize;
  const H = rows * cellSize;
  const t = cellSize;
  const boundaries: AABB[] = [
    { minX: -t, minY: -t, maxX: W + t, maxY: 0 }, // top
    { minX: -t, minY: H, maxX: W + t, maxY: H + t }, // bottom
    { minX: -t, minY: 0, maxX: 0, maxY: H }, // left
    { minX: W, minY: 0, maxX: W + t, maxY: H }, // right
  ];
  for (const aabb of boundaries) {
    walls.push({ id: id++, aabb, kind: 'solid', destroyed: false });
  }

  return { walls, tanks, spawns };
}

export function createArenaWorld(): World {
  return createWorld({ ...loadArena(ARENA_01), lives: LIVES });
}
```

- [ ] **Step: Run the test to verify it passes**
  - Command: `npx vitest run src/sim/arena.test.ts`
  - Expected: PASS (11 interior + 4 boundary walls; 9+4 solid, 2 destructible; 4 tanks; blocked direct Teal→player line; and a valid Teal bank shot exists). If ONLY the bank-shot assertion fails, ARENA_01 does not yet afford a single-bounce path — tune the arena (widen the side lanes / move the flanking blocks) until it passes, since the slice's signature feature depends on it.

- [ ] **Step: Commit**
  - `git add src/sim/arena.ts src/sim/arena.test.ts && git commit -m "Add ARENA_01 data, loadArena, and createArenaWorld"`

---

### Task 24: Render scene — renderer, tilted camera, light, felt ground

**Files:**
- Create: `src/render/scene.ts`
- Test: (manual — Three.js/DOM bound; type-checked via `npx tsc --noEmit`)

**Interfaces:**

Consumes:
- `three`
- `AABB` (task 2) — `{ minX: number; minY: number; maxX: number; maxY: number }` (imported only if needed; not required by this file's body)

Produces:
- `interface SceneContext { scene: THREE.Scene; camera: THREE.PerspectiveCamera; renderer: THREE.WebGLRenderer; resize(w: number, h: number): void; dispose(): void }`
- `function createScene(canvas: HTMLCanvasElement, worldWidth: number, worldHeight: number): SceneContext` — WebGLRenderer with soft shadows; one fixed PerspectiveCamera angled down ~45-55° framing the whole arena (no scrolling); one directional light casting soft shadows; a matte 'felt' ground plane sized to the arena.

Coordinate convention (used by ALL render tasks): the sim is 2D `Vec2 {x, y}`. It maps to the Three.js **XZ ground plane**: world `x → three.x`, world `y → three.z`, ground surface at `three.y = 0`. World angles (`angleOf`, CCW in the xy-plane) map to `object.rotation.y = -angle`.

Steps:

- [ ] **Step: Implement `src/render/scene.ts`**

```ts
import * as THREE from 'three';

export interface SceneContext {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  resize(w: number, h: number): void;
  dispose(): void;
}

export function createScene(
  canvas: HTMLCanvasElement,
  worldWidth: number,
  worldHeight: number,
): SceneContext {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.setClearColor(0x14161c, 1);

  const scene = new THREE.Scene();

  // Arena center in world/three space (ground = XZ plane).
  const cx = worldWidth / 2;
  const cz = worldHeight / 2;

  // Single fixed camera tilted ~50deg down, framing the whole board (no scrolling).
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
  const span = Math.max(worldWidth, worldHeight);
  camera.position.set(cx, span * 1.05, cz + span * 0.85);
  camera.lookAt(cx, 0, cz);

  // Directional 'sun' casting soft shadows across the whole arena.
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(cx - worldWidth * 0.6, span * 1.6, cz - worldHeight * 0.6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const shadowCam = sun.shadow.camera as THREE.OrthographicCamera;
  shadowCam.left = -span;
  shadowCam.right = span;
  shadowCam.top = span;
  shadowCam.bottom = -span;
  shadowCam.near = 0.5;
  shadowCam.far = span * 4;
  shadowCam.updateProjectionMatrix();
  sun.target.position.set(cx, 0, cz);
  scene.add(sun);
  scene.add(sun.target);

  const ambient = new THREE.AmbientLight(0xffffff, 0.45);
  scene.add(ambient);

  // Matte 'felt' ground plane sized to the arena.
  const groundGeo = new THREE.PlaneGeometry(worldWidth, worldHeight);
  const groundMat = new THREE.MeshStandardMaterial({
    color: 0x2f6d4f,
    roughness: 1.0,
    metalness: 0.0,
  });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(cx, 0, cz);
  ground.receiveShadow = true;
  scene.add(ground);

  function resize(w: number, h: number): void {
    renderer.setSize(w, h, false);
    camera.aspect = h === 0 ? 1 : w / h;
    camera.updateProjectionMatrix();
  }
  resize(
    canvas.clientWidth || window.innerWidth,
    canvas.clientHeight || window.innerHeight,
  );

  function dispose(): void {
    groundGeo.dispose();
    groundMat.dispose();
    renderer.dispose();
  }

  return { scene, camera, renderer, resize, dispose };
}
```

- [ ] **Step: Type-check the module**

Command: `npx tsc --noEmit`
Expected: PASS (exit 0, no output). Confirms the file compiles against strict TS and `@types/three`.

- [ ] **Step: Manual verification (deferred until task 33 wires the loop)**

Record this manual checklist in the PR/commit body; execute once the app boots:
- The full arena is visible with no scrolling at the tilted angle.
- The felt ground reads matte (no specular sheen).
- Soft shadows render under objects.
- Resizing the window keeps the arena framed and the aspect correct (no stretch).

- [ ] **Step: Commit**

```bash
git add src/render/scene.ts && git commit -m "render: tilted-camera scene with soft shadows and felt ground"
```

---

### Task 25: Interpolation helpers

**Files:**
- Create: `src/render/interpolate.ts`, `src/render/interpolate.test.ts`
- Test: `src/render/interpolate.test.ts`

**Interfaces:**

Consumes:
- `Vec2` (task 2) — `type Vec2 = { x: number; y: number }`

Produces:
- `function lerp(a: number, b: number, t: number): number`
- `function lerpAngle(a: number, b: number, t: number): number` — shortest-arc angular interpolation.
- `function lerpVec2(a: Vec2, b: Vec2, t: number): Vec2`

Steps:

- [ ] **Step: Write the failing test**

```ts
// src/render/interpolate.test.ts
import { describe, it, expect } from 'vitest';
import { lerp, lerpAngle, lerpVec2 } from './interpolate';

describe('lerp', () => {
  it('returns endpoints and midpoint', () => {
    expect(lerp(0, 10, 0)).toBe(0);
    expect(lerp(0, 10, 1)).toBe(10);
    expect(lerp(0, 10, 0.5)).toBe(5);
  });

  it('handles negative ranges', () => {
    expect(lerp(-4, 4, 0.25)).toBeCloseTo(-2, 6);
  });
});

describe('lerpAngle', () => {
  it('takes the short way across the -pi/pi wrap (170deg -> -170deg through 180deg)', () => {
    const a = (170 * Math.PI) / 180;
    const b = (-170 * Math.PI) / 180;
    // Short arc is +20deg through +/-180, so the midpoint is exactly PI.
    expect(lerpAngle(a, b, 0.5)).toBeCloseTo(Math.PI, 6);
  });

  it('interpolates normally within range', () => {
    expect(lerpAngle(0, Math.PI / 2, 0.5)).toBeCloseTo(Math.PI / 4, 6);
  });

  it('returns endpoints at t=0 and t=1', () => {
    expect(lerpAngle(0.3, 1.2, 0)).toBeCloseTo(0.3, 6);
    expect(lerpAngle(0.3, 1.2, 1)).toBeCloseTo(1.2, 6);
  });
});

describe('lerpVec2', () => {
  it('interpolates both components independently', () => {
    expect(lerpVec2({ x: 0, y: 4 }, { x: 10, y: 8 }, 0.5)).toEqual({ x: 5, y: 6 });
  });
});
```

- [ ] **Step: Run the test to verify it fails**

Command: `npx vitest run src/render/interpolate.test.ts`
Expected: FAIL — module `./interpolate` does not exist / `lerp`, `lerpAngle`, `lerpVec2` are undefined (import resolution error).

- [ ] **Step: Implement minimal code to pass**

```ts
// src/render/interpolate.ts
import type { Vec2 } from '../sim/types';

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function lerpAngle(a: number, b: number, t: number): number {
  const TWO_PI = Math.PI * 2;
  let delta = (b - a) % TWO_PI;
  if (delta > Math.PI) delta -= TWO_PI;
  if (delta < -Math.PI) delta += TWO_PI;
  return a + delta * t;
}

export function lerpVec2(a: Vec2, b: Vec2, t: number): Vec2 {
  return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) };
}
```

- [ ] **Step: Run the test to verify it passes**

Command: `npx vitest run src/render/interpolate.test.ts`
Expected: PASS (all 7 assertions across 4 suites green).

- [ ] **Step: Commit**

```bash
git add src/render/interpolate.ts src/render/interpolate.test.ts && git commit -m "render: interpolation helpers (lerp, shortest-arc lerpAngle, lerpVec2)"
```

---

### Task 26: Entity views — interpolated tank/wall/bullet/mine meshes

**Files:**
- Create: `src/render/entities.ts`
- Test: (manual — Three.js bound; type-checked via `npx tsc --noEmit`)

**Interfaces:**

Consumes:
- `three`
- `World` (task 8) — `{ tick; nextId; seed; tanks: Tank[]; bullets: Bullet[]; mines: Mine[]; walls: Wall[]; spawns; status; lives }`
- `Tank`, `Bullet`, `Mine`, `Wall`, `TankKind` (task 2)
- `lerp`, `lerpAngle`, `lerpVec2` (task 25)
- `TANK_RADIUS`, `BULLET_RADIUS` (task 3)

Produces:
- `interface EntityViews { sync(prev: World, curr: World, alpha: number): void; dispose(): void }`
- `function createEntityViews(scene: THREE.Scene): EntityViews` — maintains meshes keyed by entity id; chunky low-poly tanks from primitives in flat primary colors per `TankKind` (body + independently-rotated turret), boxes for walls (destructible visually distinct), small shells and mine pucks. `sync` interpolates positions/angles between prev and curr by `alpha`, adds meshes for new ids, and removes meshes for ids gone from curr.

Steps:

- [ ] **Step: Implement `src/render/entities.ts`**

```ts
import * as THREE from 'three';
import type { World } from '../sim/world';
import type { Tank, Bullet, Mine, Wall, TankKind } from '../sim/types';
import { lerp, lerpAngle, lerpVec2 } from './interpolate';
import { TANK_RADIUS, BULLET_RADIUS } from '../sim/constants';

export interface EntityViews {
  sync(prev: World, curr: World, alpha: number): void;
  dispose(): void;
}

const TANK_COLORS: Record<TankKind, number> = {
  player: 0x3d7bd6,
  brown: 0x8a5a2b,
  grey: 0x8890a0,
  teal: 0x2bb0a6,
};

const TANK_BODY_H = 0.4;
const BULLET_Y = 0.35;
const MINE_Y = 0.06;
const WALL_H = 1.0;

function indexById<T extends { id: number }>(arr: T[]): Map<number, T> {
  const m = new Map<number, T>();
  for (const e of arr) m.set(e.id, e);
  return m;
}

function disposeObject(obj: THREE.Object3D): void {
  obj.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
    else if (mat) mat.dispose();
  });
  obj.parent?.remove(obj);
}

export function createEntityViews(scene: THREE.Scene): EntityViews {
  const tankViews = new Map<number, { group: THREE.Group; turret: THREE.Object3D }>();
  const bulletViews = new Map<number, THREE.Mesh>();
  const mineViews = new Map<number, THREE.Mesh>();
  const wallViews = new Map<number, THREE.Mesh>();

  function makeTank(kind: TankKind): { group: THREE.Group; turret: THREE.Object3D } {
    const group = new THREE.Group();
    const color = TANK_COLORS[kind];

    const bodyMat = new THREE.MeshStandardMaterial({ color, roughness: 0.75 });
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(TANK_RADIUS * 2, TANK_BODY_H, TANK_RADIUS * 1.6),
      bodyMat,
    );
    body.position.y = TANK_BODY_H / 2;
    body.castShadow = true;
    body.receiveShadow = true;
    group.add(body);

    const turret = new THREE.Group();
    turret.position.y = TANK_BODY_H + 0.12;
    const turretMat = new THREE.MeshStandardMaterial({ color, roughness: 0.5 });
    const dome = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.28, 0.5), turretMat);
    dome.castShadow = true;
    turret.add(dome);
    const barrel = new THREE.Mesh(
      new THREE.CylinderGeometry(0.07, 0.07, 0.7, 8),
      turretMat,
    );
    barrel.rotation.z = Math.PI / 2; // lay the cylinder along local +x
    barrel.position.set(0.42, 0, 0);
    barrel.castShadow = true;
    turret.add(barrel);
    group.add(turret);

    scene.add(group);
    return { group, turret };
  }

  function makeBullet(): THREE.Mesh {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(BULLET_RADIUS * 1.6, 8, 8),
      new THREE.MeshStandardMaterial({ color: 0xf5f0d0, emissive: 0x444422 }),
    );
    mesh.castShadow = true;
    scene.add(mesh);
    return mesh;
  }

  function makeMine(): THREE.Mesh {
    const mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(0.28, 0.28, MINE_Y * 2, 12),
      new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.6 }),
    );
    mesh.castShadow = true;
    scene.add(mesh);
    return mesh;
  }

  function makeWall(wall: Wall): THREE.Mesh {
    const w = wall.aabb.maxX - wall.aabb.minX;
    const d = wall.aabb.maxY - wall.aabb.minY;
    const geo = new THREE.BoxGeometry(w, WALL_H, d);
    const mat =
      wall.kind === 'destructible'
        ? new THREE.MeshStandardMaterial({ color: 0xb08040, roughness: 0.95 })
        : new THREE.MeshStandardMaterial({ color: 0x565b66, roughness: 0.85 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(
      (wall.aabb.minX + wall.aabb.maxX) / 2,
      WALL_H / 2,
      (wall.aabb.minY + wall.aabb.maxY) / 2,
    );
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    return mesh;
  }

  function syncTanks(prev: World, curr: World, alpha: number): void {
    const prevMap = indexById(prev.tanks);
    const seen = new Set<number>();
    for (const t of curr.tanks) {
      if (!t.alive) continue;
      seen.add(t.id);
      let view = tankViews.get(t.id);
      if (!view) {
        view = makeTank(t.kind);
        tankViews.set(t.id, view);
      }
      const p = prevMap.get(t.id);
      // New id (no prev): snap to curr pose, do not lerp from a garbage origin.
      const pos = p ? lerpVec2(p.pos, t.pos, alpha) : t.pos;
      const bodyA = p ? lerpAngle(p.bodyAngle, t.bodyAngle, alpha) : t.bodyAngle;
      const turretA = p ? lerpAngle(p.turretAngle, t.turretAngle, alpha) : t.turretAngle;
      view.group.position.set(pos.x, 0, pos.y);
      view.group.rotation.y = -bodyA;
      view.turret.rotation.y = -turretA;
    }
    for (const [id, view] of tankViews) {
      if (!seen.has(id)) {
        disposeObject(view.group);
        tankViews.delete(id);
      }
    }
  }

  function syncBullets(prev: World, curr: World, alpha: number): void {
    const prevMap = indexById(prev.bullets);
    const seen = new Set<number>();
    for (const b of curr.bullets) {
      if (!b.alive) continue;
      seen.add(b.id);
      let mesh = bulletViews.get(b.id);
      if (!mesh) {
        mesh = makeBullet();
        bulletViews.set(b.id, mesh);
      }
      const p = prevMap.get(b.id);
      const pos = p && p.alive ? lerpVec2(p.pos, b.pos, alpha) : b.pos;
      mesh.position.set(pos.x, BULLET_Y, pos.y);
    }
    for (const [id, mesh] of bulletViews) {
      if (!seen.has(id)) {
        disposeObject(mesh);
        bulletViews.delete(id);
      }
    }
  }

  function syncMines(prev: World, curr: World, _alpha: number): void {
    const seen = new Set<number>();
    for (const m of curr.mines) {
      if (m.detonated) continue;
      seen.add(m.id);
      let mesh = mineViews.get(m.id);
      if (!mesh) {
        mesh = makeMine();
        mineViews.set(m.id, mesh);
      }
      mesh.position.set(m.pos.x, MINE_Y, m.pos.y);
      // Armed mines glow slightly to read as "hot".
      const mat = mesh.material as THREE.MeshStandardMaterial;
      mat.emissive.setHex(m.armed ? 0x661111 : 0x000000);
    }
    for (const [id, mesh] of mineViews) {
      if (!seen.has(id)) {
        disposeObject(mesh);
        mineViews.delete(id);
      }
    }
  }

  function syncWalls(curr: World): void {
    for (const wall of curr.walls) {
      const existing = wallViews.get(wall.id);
      if (wall.destroyed) {
        if (existing) {
          disposeObject(existing);
          wallViews.delete(wall.id);
        }
        continue;
      }
      if (!existing) {
        wallViews.set(wall.id, makeWall(wall));
      }
    }
  }

  function sync(prev: World, curr: World, alpha: number): void {
    syncWalls(curr);
    syncTanks(prev, curr, alpha);
    syncBullets(prev, curr, alpha);
    syncMines(prev, curr, alpha);
  }

  function dispose(): void {
    for (const v of tankViews.values()) disposeObject(v.group);
    for (const m of bulletViews.values()) disposeObject(m);
    for (const m of mineViews.values()) disposeObject(m);
    for (const m of wallViews.values()) disposeObject(m);
    tankViews.clear();
    bulletViews.clear();
    mineViews.clear();
    wallViews.clear();
  }

  return { sync, dispose };
}
```

- [ ] **Step: Type-check the module**

Command: `npx tsc --noEmit`
Expected: PASS (exit 0). Confirms it compiles against `World`/`Tank`/`Bullet`/`Mine`/`Wall`, the interp helpers, and the constants. (Requires sim tasks 2/3/8 to already exist, which they do by the time the render cluster runs.)

- [ ] **Step: Manual verification (deferred until task 33)**

Checklist for the running app:
- Tanks move smoothly (interpolated) at high refresh; no stutter.
- An entity present in curr but absent in prev snaps to its curr pose (no lerp from origin).
- An entity gone from curr has its mesh removed (no ghosts).
- Turret rotates independently of body (aim vs facing differ).
- Destructible walls look distinct from solid and disappear when destroyed.

- [ ] **Step: Commit**

```bash
git add src/render/entities.ts && git commit -m "render: id-keyed interpolated entity views for tanks/walls/bullets/mines"
```

---

### Task 27: Particle system — juice from SimEvents

**Files:**
- Create: `src/render/particles.ts`
- Test: (manual — Three.js bound; type-checked via `npx tsc --noEmit`)

**Interfaces:**

Consumes:
- `three`
- `SimEvent` (task 4) — the canonical 10-kind discriminated union

Produces:
- `interface ParticleSystem { spawn(events: SimEvent[]): void; update(dt: number): void; dispose(): void }`
- `function createParticleSystem(scene: THREE.Scene): ParticleSystem` — `spawn()` reads events (explosion bursts, ricochet sparks at hit points, mine-detonate blast, muzzle flash on fire, wall-destroyed debris) and `update()` advances/fades/recycles short-lived primitive particles.

Steps:

- [ ] **Step: Implement `src/render/particles.ts`**

```ts
import * as THREE from 'three';
import type { SimEvent } from '../sim/events';

export interface ParticleSystem {
  spawn(events: SimEvent[]): void;
  update(dt: number): void;
  dispose(): void;
}

interface Particle {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  vel: THREE.Vector3;
  life: number;
  maxLife: number;
  baseScale: number;
}

const MAX_PARTICLES = 500;
const GRAVITY = -6;
const EVENT_Y = 0.5;

export function createParticleSystem(scene: THREE.Scene): ParticleSystem {
  const geo = new THREE.SphereGeometry(0.08, 6, 6);
  const pool: Particle[] = [];
  const active: Particle[] = [];

  function acquire(): Particle | null {
    let p = pool.pop();
    if (!p) {
      if (active.length >= MAX_PARTICLES) return null;
      const mat = new THREE.MeshBasicMaterial({ transparent: true });
      const mesh = new THREE.Mesh(geo, mat);
      scene.add(mesh);
      p = { mesh, vel: new THREE.Vector3(), life: 0, maxLife: 1, baseScale: 1 };
    }
    p.mesh.visible = true;
    active.push(p);
    return p;
  }

  function recycle(p: Particle, i: number): void {
    p.mesh.visible = false;
    active.splice(i, 1);
    pool.push(p);
  }

  function burst(
    x: number,
    z: number,
    count: number,
    color: number,
    speed: number,
    life: number,
    scale: number,
  ): void {
    for (let i = 0; i < count; i++) {
      const p = acquire();
      if (!p) return;
      const theta = Math.random() * Math.PI * 2;
      const up = Math.random() * 0.8 + 0.2;
      const s = speed * (0.5 + Math.random() * 0.5);
      p.vel.set(Math.cos(theta) * s, up * s, Math.sin(theta) * s);
      p.life = life * (0.7 + Math.random() * 0.6);
      p.maxLife = p.life;
      p.baseScale = scale;
      p.mesh.material.color.setHex(color);
      p.mesh.material.opacity = 1;
      p.mesh.position.set(x, EVENT_Y, z);
      p.mesh.scale.setScalar(scale);
    }
  }

  function spawn(events: SimEvent[]): void {
    for (const ev of events) {
      switch (ev.type) {
        case 'fire':
          burst(ev.pos.x, ev.pos.y, 5, 0xffd873, 4, 0.18, 0.6);
          break;
        case 'ricochet':
          burst(ev.pos.x, ev.pos.y, 6, 0xfff4c0, 5, 0.25, 0.5);
          break;
        case 'explosion':
        case 'tank-destroyed':
          burst(ev.pos.x, ev.pos.y, 24, 0xff6a2b, 6, 0.6, 1.0);
          break;
        case 'wall-destroyed':
          burst(ev.pos.x, ev.pos.y, 16, 0xb08040, 4, 0.5, 0.9);
          break;
        case 'mine-detonate':
          burst(ev.pos.x, ev.pos.y, 40, 0xffbb33, 8, 0.7, 1.4);
          break;
        // 'mine-dropped', 'mine-armed', 'win', 'lose' produce no particles.
        default:
          break;
      }
    }
  }

  function update(dt: number): void {
    for (let i = active.length - 1; i >= 0; i--) {
      const p = active[i];
      p.life -= dt;
      if (p.life <= 0) {
        recycle(p, i);
        continue;
      }
      p.vel.y += GRAVITY * dt;
      p.mesh.position.x += p.vel.x * dt;
      p.mesh.position.y += p.vel.y * dt;
      p.mesh.position.z += p.vel.z * dt;
      if (p.mesh.position.y < 0.02) p.mesh.position.y = 0.02;
      const k = p.life / p.maxLife;
      p.mesh.material.opacity = k;
      p.mesh.scale.setScalar(p.baseScale * (0.4 + 0.6 * k));
    }
  }

  function dispose(): void {
    for (const p of active) {
      p.mesh.material.dispose();
      scene.remove(p.mesh);
    }
    for (const p of pool) {
      p.mesh.material.dispose();
      scene.remove(p.mesh);
    }
    active.length = 0;
    pool.length = 0;
    geo.dispose();
  }

  return { spawn, update, dispose };
}
```

- [ ] **Step: Type-check the module**

Command: `npx tsc --noEmit`
Expected: PASS (exit 0). The `switch` over `ev.type` covers the event kinds it cares about and falls through on the rest; confirms it compiles against the `SimEvent` union.

- [ ] **Step: Manual verification (deferred until task 33)**

Checklist for the running app:
- An `explosion`/`tank-destroyed` event produces a visible burst at the tank position.
- A `ricochet` event sparks at the bounce point.
- `mine-detonate` produces a large blast puff.
- Particles fade and recycle without unbounded growth (active count stays bounded under sustained fire).

- [ ] **Step: Commit**

```bash
git add src/render/particles.ts && git commit -m "render: pooled particle system spawning juice from SimEvents"
```

---

### Task 28: Renderer aggregator + screen-to-ground

**Files:**
- Create: `src/render/renderer.ts`
- Test: (manual — Three.js bound; type-checked via `npx tsc --noEmit`)

**Interfaces:**

Consumes:
- `SceneContext`, `createScene` (task 24)
- `EntityViews`, `createEntityViews` (task 26)
- `ParticleSystem`, `createParticleSystem` (task 27)
- `World` (task 8)
- `SimEvent` (task 4)
- `Vec2` (task 2)

Produces:
- `interface Renderer3D { render(prev: World, curr: World, alpha: number, events: SimEvent[], dt: number): void; screenToGround(clientX: number, clientY: number): Vec2; resize(w: number, h: number): void; dispose(): void }`
- `function createRenderer(canvas: HTMLCanvasElement, worldWidth: number, worldHeight: number): Renderer3D` — composes scene + entity views + particles; `render()` syncs entities (interpolated), feeds events to particles, updates+draws; `screenToGround` unprojects a cursor position onto the ground plane (supplied to the input controller so aim resolves without input depending on three).

Steps:

- [ ] **Step: Implement `src/render/renderer.ts`**

```ts
import * as THREE from 'three';
import type { Vec2 } from '../sim/types';
import type { World } from '../sim/world';
import type { SimEvent } from '../sim/events';
import { createScene, type SceneContext } from './scene';
import { createEntityViews, type EntityViews } from './entities';
import { createParticleSystem, type ParticleSystem } from './particles';

export interface Renderer3D {
  render(prev: World, curr: World, alpha: number, events: SimEvent[], dt: number): void;
  screenToGround(clientX: number, clientY: number): Vec2;
  resize(w: number, h: number): void;
  dispose(): void;
}

export function createRenderer(
  canvas: HTMLCanvasElement,
  worldWidth: number,
  worldHeight: number,
): Renderer3D {
  const ctx: SceneContext = createScene(canvas, worldWidth, worldHeight);
  const entities: EntityViews = createEntityViews(ctx.scene);
  const particles: ParticleSystem = createParticleSystem(ctx.scene);

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
    entities.sync(prev, curr, alpha);
    particles.spawn(events);
    particles.update(dt);
    ctx.renderer.render(ctx.scene, ctx.camera);
  }

  function screenToGround(clientX: number, clientY: number): Vec2 {
    const rect = canvas.getBoundingClientRect();
    ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, ctx.camera);
    const hit = raycaster.ray.intersectPlane(groundPlane, hitPoint);
    if (!hit) return { x: worldWidth / 2, y: worldHeight / 2 };
    // three (x, z) -> world (x, y)
    return { x: hitPoint.x, y: hitPoint.z };
  }

  function resize(w: number, h: number): void {
    ctx.resize(w, h);
  }

  function dispose(): void {
    entities.dispose();
    particles.dispose();
    ctx.dispose();
  }

  return { render, screenToGround, resize, dispose };
}
```

- [ ] **Step: Type-check the module**

Command: `npx tsc --noEmit`
Expected: PASS (exit 0). Confirms the aggregator composes scene/entities/particles and that `screenToGround` returns a `Vec2` matching the input controller's injected signature `(clientX, clientY) => Vec2` (task 14).

- [ ] **Step: Manual verification (deferred until task 33)**

Checklist for the running app:
- One `render()` call draws interpolated entities and event particles together.
- Cursor over a known ground point yields the correct world `Vec2` (turret aims exactly where the mouse points).
- Resize propagates (arena stays framed, aspect correct).

- [ ] **Step: Commit**

```bash
git add src/render/renderer.ts && git commit -m "render: renderer aggregator with screen-to-ground unprojection"
```

---

### Task 29: Audio engine — manifest, Howler, graceful degrade, procedural fallback, music/mute/volume

**Files:**
- Create: `src/audio/manifest.ts`
- Create: `src/audio/manifest.test.ts`
- Create: `src/audio/engine.ts`
- Create: `src/audio/engine.test.ts`
- Create: `public/audio/.gitkeep`
- Create: `CREDITS.md`
- Test: `src/audio/manifest.test.ts`, `src/audio/engine.test.ts`

**Interfaces:**

Consumes:
- `howler` (`Howl`, `Howler`).

Produces:
- `interface AudioManifest { sfx: Record<string, string>; music: string }`
- `const AUDIO_MANIFEST: AudioManifest` — keys: `cannon`, `cannon-enemy`, `ping`, `explosion`, `mine-drop`, `mine-arm`, `mine-boom`, `victory`, `defeat`; paths under `public/audio/`.
- `interface AudioEngine { play(key: string, opts?: { rate?: number; volume?: number }): void; startMusic(): void; stopMusic(): void; setMuted(muted: boolean): void; toggleMute(): boolean; isMuted(): boolean; setVolume(v: number): void; dispose(): void }`
- `function createAudioEngine(manifest: AudioManifest): AudioEngine` — loads each asset via Howler with pooling for overlap; if an asset is MISSING or fails to load, degrades gracefully to a Web Audio procedural tone for that key and NEVER throws; looping low-level background music with mute (M) and volume.

Notes for this task:
- The engine imports `howler` (allowed — this is the audio projection layer, not `sim/`).
- Tests run in Vitest's default **node** environment: `howler` is mocked with `vi.mock`, and the Web Audio fallback is guarded by `typeof window !== 'undefined'`, so it safely no-ops in node while still working in the browser. No DOM is required.

Steps:

- [ ] **Step: Write the failing manifest test**

```ts
// src/audio/manifest.test.ts
import { describe, it, expect } from 'vitest';
import { AUDIO_MANIFEST } from './manifest';

const REQUIRED_KEYS = [
  'cannon',
  'cannon-enemy',
  'ping',
  'explosion',
  'mine-drop',
  'mine-arm',
  'mine-boom',
  'victory',
  'defeat',
];

describe('AUDIO_MANIFEST', () => {
  it('defines every required SFX key', () => {
    for (const key of REQUIRED_KEYS) {
      expect(AUDIO_MANIFEST.sfx[key], `missing sfx key: ${key}`).toBeTruthy();
    }
  });

  it('has no unexpected extra SFX keys', () => {
    expect(Object.keys(AUDIO_MANIFEST.sfx).sort()).toEqual([...REQUIRED_KEYS].sort());
  });

  it('points all SFX and music paths under /audio/', () => {
    for (const path of Object.values(AUDIO_MANIFEST.sfx)) {
      expect(path.startsWith('/audio/')).toBe(true);
    }
    expect(AUDIO_MANIFEST.music.startsWith('/audio/')).toBe(true);
  });
});
```

- [ ] **Step: Run the test to verify it fails**

Command: `npx vitest run src/audio/manifest.test.ts`

Expected: FAIL with `Cannot find module './manifest'` (the module does not exist yet).

- [ ] **Step: Implement the manifest**

```ts
// src/audio/manifest.ts

export interface AudioManifest {
  sfx: Record<string, string>;
  music: string;
}

// Paths resolve against Vite's public/ dir, which is served at the site root,
// so public/audio/cannon.wav is reachable at /audio/cannon.wav.
export const AUDIO_MANIFEST: AudioManifest = {
  sfx: {
    cannon: '/audio/cannon.wav',
    'cannon-enemy': '/audio/cannon-enemy.wav',
    ping: '/audio/ping.wav',
    explosion: '/audio/explosion.wav',
    'mine-drop': '/audio/mine-drop.wav',
    'mine-arm': '/audio/mine-arm.wav',
    'mine-boom': '/audio/mine-boom.wav',
    victory: '/audio/victory.wav',
    defeat: '/audio/defeat.wav',
  },
  music: '/audio/music-loop.wav',
};
```

- [ ] **Step: Run the test to verify it passes**

Command: `npx vitest run src/audio/manifest.test.ts`

Expected: PASS (3 tests).

- [ ] **Step: Create the audio asset directory and CREDITS.md**

Create `public/audio/.gitkeep` (empty file — keeps the committed directory present until CC0 assets are sourced; the engine degrades to procedural beeps until then):

```
```

Create `CREDITS.md`:

```md
# Audio Credits

All audio assets in `public/audio/` are royalty-free and CC0-preferred
(e.g. Kenney.nl game-audio packs, freesound.org filtered to CC0). No
AI-generated or unlicensed audio is used. Any asset requiring attribution
is listed below.

Until CC0 assets are committed, the audio engine (`src/audio/engine.ts`)
degrades gracefully to a Web Audio procedural fallback tone per SFX key,
so development is never blocked on sourcing downloads.

## SFX

| Key           | File                       | Source | License |
| ------------- | -------------------------- | ------ | ------- |
| cannon        | audio/cannon.wav           | TBD    | CC0     |
| cannon-enemy  | audio/cannon-enemy.wav     | TBD    | CC0     |
| ping          | audio/ping.wav             | TBD    | CC0     |
| explosion     | audio/explosion.wav        | TBD    | CC0     |
| mine-drop     | audio/mine-drop.wav        | TBD    | CC0     |
| mine-arm      | audio/mine-arm.wav         | TBD    | CC0     |
| mine-boom     | audio/mine-boom.wav        | TBD    | CC0     |
| victory       | audio/victory.wav          | TBD    | CC0     |
| defeat        | audio/defeat.wav           | TBD    | CC0     |

## Music

| File                 | Source | License |
| -------------------- | ------ | ------- |
| audio/music-loop.wav | TBD    | CC0     |

Replace `TBD` with the concrete pack/author + URL when the corresponding
asset file is committed.
```

- [ ] **Step: Commit the manifest and credits**

```bash
git add src/audio/manifest.ts src/audio/manifest.test.ts public/audio/.gitkeep CREDITS.md && git commit -m "Add audio manifest, asset dir, and CREDITS scaffolding"
```

- [ ] **Step: Write the failing engine test**

```ts
// src/audio/engine.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Howler so the engine can be constructed and exercised headlessly (node env).
const globalMute = vi.fn();
const globalVolume = vi.fn();

vi.mock('howler', () => {
  class Howl {
    private opts: unknown;
    playCount = 0;
    constructor(opts: unknown) {
      this.opts = opts;
    }
    play() {
      this.playCount += 1;
      return this.playCount;
    }
    stop() {}
    volume() {}
    rate() {}
    mute() {}
    unload() {}
    playing() {
      return false;
    }
    on() {}
  }
  return {
    Howl,
    Howler: { mute: globalMute, volume: globalVolume },
  };
});

import { createAudioEngine } from './engine';
import { AUDIO_MANIFEST } from './manifest';

describe('createAudioEngine', () => {
  beforeEach(() => {
    globalMute.mockClear();
    globalVolume.mockClear();
  });

  it('constructs without throwing and starts unmuted', () => {
    const engine = createAudioEngine(AUDIO_MANIFEST);
    expect(engine.isMuted()).toBe(false);
    engine.dispose();
  });

  it('plays a known SFX key without throwing', () => {
    const engine = createAudioEngine(AUDIO_MANIFEST);
    expect(() => engine.play('cannon', { rate: 1.2, volume: 0.8 })).not.toThrow();
    engine.dispose();
  });

  it('falls back gracefully (no throw) for an unknown/missing key', () => {
    const engine = createAudioEngine(AUDIO_MANIFEST);
    // No Howl for this key -> procedural fallback -> guarded no-op in node.
    expect(() => engine.play('does-not-exist')).not.toThrow();
    engine.dispose();
  });

  it('toggleMute flips state and returns the new value', () => {
    const engine = createAudioEngine(AUDIO_MANIFEST);
    expect(engine.toggleMute()).toBe(true);
    expect(engine.isMuted()).toBe(true);
    expect(engine.toggleMute()).toBe(false);
    expect(engine.isMuted()).toBe(false);
    expect(globalMute).toHaveBeenCalled();
    engine.dispose();
  });

  it('setMuted drives the muted state', () => {
    const engine = createAudioEngine(AUDIO_MANIFEST);
    engine.setMuted(true);
    expect(engine.isMuted()).toBe(true);
    engine.setMuted(false);
    expect(engine.isMuted()).toBe(false);
    engine.dispose();
  });

  it('setVolume clamps to [0,1] and forwards to Howler', () => {
    const engine = createAudioEngine(AUDIO_MANIFEST);
    engine.setVolume(2);
    engine.setVolume(-1);
    expect(globalVolume).toHaveBeenCalledWith(1);
    expect(globalVolume).toHaveBeenCalledWith(0);
    engine.dispose();
  });

  it('startMusic/stopMusic do not throw', () => {
    const engine = createAudioEngine(AUDIO_MANIFEST);
    expect(() => engine.startMusic()).not.toThrow();
    expect(() => engine.stopMusic()).not.toThrow();
    engine.dispose();
  });
});
```

- [ ] **Step: Run the test to verify it fails**

Command: `npx vitest run src/audio/engine.test.ts`

Expected: FAIL with `Cannot find module './engine'` (the engine module does not exist yet).

- [ ] **Step: Implement the audio engine**

```ts
// src/audio/engine.ts
import { Howl, Howler } from 'howler';
import type { AudioManifest } from './manifest';

export interface AudioEngine {
  play(key: string, opts?: { rate?: number; volume?: number }): void;
  startMusic(): void;
  stopMusic(): void;
  setMuted(muted: boolean): void;
  toggleMute(): boolean;
  isMuted(): boolean;
  setVolume(v: number): void;
  dispose(): void;
}

const MUSIC_VOLUME = 0.25;

// Base frequencies for the procedural fallback tone per SFX key (Hz).
const FALLBACK_FREQ: Record<string, number> = {
  cannon: 180,
  'cannon-enemy': 150,
  ping: 900,
  explosion: 90,
  'mine-drop': 300,
  'mine-arm': 660,
  'mine-boom': 70,
  victory: 520,
  defeat: 160,
};

export function createAudioEngine(manifest: AudioManifest): AudioEngine {
  const sounds: Record<string, Howl | null> = {};
  let music: Howl | null = null;
  let muted = false;
  let masterVolume = 1;
  let ctx: AudioContext | null = null;

  // Load each SFX with pooling for overlap. A missing/broken asset is marked
  // null on loaderror and served by the procedural fallback instead.
  for (const key of Object.keys(manifest.sfx)) {
    try {
      const howl = new Howl({ src: [manifest.sfx[key]], preload: true, pool: 8, volume: 1 });
      howl.on('loaderror', () => {
        sounds[key] = null;
      });
      sounds[key] = howl;
    } catch {
      sounds[key] = null;
    }
  }

  try {
    music = new Howl({ src: [manifest.music], loop: true, volume: MUSIC_VOLUME, preload: true });
    music.on('loaderror', () => {
      music = null;
    });
  } catch {
    music = null;
  }

  function ensureCtx(): AudioContext | null {
    if (ctx) return ctx;
    const AC =
      typeof window !== 'undefined'
        ? window.AudioContext ||
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
        : undefined;
    if (!AC) return null;
    ctx = new AC();
    return ctx;
  }

  // Procedural fallback: a short decaying tone so dev is never blocked on assets.
  // No-ops safely when there is no Web Audio (e.g. headless test/node env).
  function beep(key: string, opts?: { rate?: number; volume?: number }): void {
    if (muted) return;
    const audio = ensureCtx();
    if (!audio) return;
    const freq = (FALLBACK_FREQ[key] ?? 440) * (opts?.rate ?? 1);
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.value = freq;
    osc.type = key === 'explosion' || key === 'mine-boom' ? 'square' : 'sine';
    const vol = 0.2 * masterVolume * (opts?.volume ?? 1);
    gain.gain.setValueAtTime(vol, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.18);
    osc.connect(gain).connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + 0.2);
  }

  return {
    play(key, opts) {
      const howl = sounds[key];
      if (howl) {
        const id = howl.play();
        if (opts?.rate !== undefined) howl.rate(opts.rate, id);
        if (opts?.volume !== undefined) howl.volume(opts.volume, id);
      } else {
        beep(key, opts);
      }
    },
    startMusic() {
      if (music && !music.playing()) music.play();
    },
    stopMusic() {
      if (music) music.stop();
    },
    setMuted(m) {
      muted = m;
      Howler.mute(m);
    },
    toggleMute() {
      muted = !muted;
      Howler.mute(muted);
      return muted;
    },
    isMuted() {
      return muted;
    },
    setVolume(v) {
      masterVolume = Math.max(0, Math.min(1, v));
      Howler.volume(masterVolume);
    },
    dispose() {
      for (const k of Object.keys(sounds)) sounds[k]?.unload();
      music?.unload();
      if (ctx) {
        void ctx.close();
        ctx = null;
      }
    },
  };
}
```

- [ ] **Step: Run the test to verify it passes**

Command: `npx vitest run src/audio/engine.test.ts`

Expected: PASS (7 tests).

- [ ] **Step: Run the full audio suite and type-check**

Command: `npx vitest run src/audio/ && npx tsc --noEmit`

Expected: PASS (all manifest + engine tests green) and no TypeScript errors.

- [ ] **Step: Commit the engine**

```bash
git add src/audio/engine.ts src/audio/engine.test.ts && git commit -m "Add audio engine: Howler wiring, procedural fallback, mute/volume/music"
```

---

### Task 30: Audio director — SimEvent → SFX mapping with pitch-varied ricochet

**Files:**
- Create: `src/audio/director.ts`
- Create: `src/audio/director.test.ts`
- Test: `src/audio/director.test.ts`

**Interfaces:**

Consumes:
- `AudioEngine` (task 29): `{ play(key: string, opts?: { rate?: number; volume?: number }): void; startMusic(): void; stopMusic(): void; setMuted(m: boolean): void; toggleMute(): boolean; isMuted(): boolean; setVolume(v: number): void; dispose(): void }`.
- `SimEvent` (task 4): the canonical 10-kind discriminated union (`fire`, `ricochet`, `explosion`, `mine-dropped`, `mine-armed`, `mine-detonate`, `tank-destroyed`, `wall-destroyed`, `win`, `lose`).

Produces:
- `interface AudioDirector { handle(events: SimEvent[]): void }`
- `function createAudioDirector(engine: AudioEngine, playerId?: number): AudioDirector` — maps each SimEvent to a sound: `fire` → `cannon` (`cannon-enemy` when `ownerId` is not the player), `ricochet` → `ping` with rate varied by `bounceIndex`, `explosion` & `tank-destroyed` → `explosion`, `mine-dropped` → `mine-drop` (drop thunk), `mine-armed` → `mine-arm` (arming beep), `mine-detonate` → `mine-boom`, `win` → `victory`, `lose` → `defeat`.

Note: the `fire` event carries only `ownerId` (a number), so the director must be told which id is the player. Do NOT assume the player is id `0` — `loadArena` (task 23) assigns ids in grid-scan order starting at `1`, and the player spawns last, so it never has id `0`. The director takes a `playerId` argument (the `0` default is only an inert fallback); the loop (task 33) passes the real id from the world: `createAudioDirector(audio, world.tanks.find((t) => t.kind === 'player')!.id)`. That id is deterministic and stable across arena rebuilds, so the director can be created once.

Steps:

- [ ] **Step: Write the failing director test**

```ts
// src/audio/director.test.ts
import { describe, it, expect } from 'vitest';
import { createAudioDirector } from './director';
import type { AudioEngine } from './engine';
import type { SimEvent } from '../sim/events';

interface PlayCall {
  key: string;
  opts?: { rate?: number; volume?: number };
}

function makeSpyEngine(): { engine: AudioEngine; calls: PlayCall[] } {
  const calls: PlayCall[] = [];
  const engine: AudioEngine = {
    play: (key, opts) => {
      calls.push({ key, opts });
    },
    startMusic: () => {},
    stopMusic: () => {},
    setMuted: () => {},
    toggleMute: () => false,
    isMuted: () => false,
    setVolume: () => {},
    dispose: () => {},
  };
  return { engine, calls };
}

describe('createAudioDirector', () => {
  it('plays cannon for a player fire (ownerId 0) and cannon-enemy otherwise', () => {
    const { engine, calls } = makeSpyEngine();
    const director = createAudioDirector(engine);
    const playerFire: SimEvent = {
      type: 'fire',
      ownerId: 0,
      bulletType: 'normal',
      pos: { x: 0, y: 0 },
      angle: 0,
    };
    const enemyFire: SimEvent = {
      type: 'fire',
      ownerId: 1,
      bulletType: 'normal',
      pos: { x: 0, y: 0 },
      angle: 0,
    };
    director.handle([playerFire, enemyFire]);
    expect(calls.map((c) => c.key)).toEqual(['cannon', 'cannon-enemy']);
  });

  it('varies ping rate by bounceIndex (higher index -> higher rate)', () => {
    const { engine, calls } = makeSpyEngine();
    const director = createAudioDirector(engine);
    director.handle([
      { type: 'ricochet', pos: { x: 0, y: 0 }, bounceIndex: 0 },
      { type: 'ricochet', pos: { x: 0, y: 0 }, bounceIndex: 1 },
      { type: 'ricochet', pos: { x: 0, y: 0 }, bounceIndex: 2 },
    ]);
    expect(calls.every((c) => c.key === 'ping')).toBe(true);
    const rates = calls.map((c) => c.opts?.rate ?? 0);
    expect(rates[0]).toBeLessThan(rates[1]);
    expect(rates[1]).toBeLessThan(rates[2]);
  });

  it('maps explosion and tank-destroyed both to the explosion sound', () => {
    const { engine, calls } = makeSpyEngine();
    const director = createAudioDirector(engine);
    director.handle([
      { type: 'explosion', pos: { x: 0, y: 0 } },
      { type: 'tank-destroyed', tankId: 3, kind: 'brown', pos: { x: 0, y: 0 } },
    ]);
    expect(calls.map((c) => c.key)).toEqual(['explosion', 'explosion']);
  });

  it('maps mine-dropped to the drop thunk and mine-armed to the arming beep', () => {
    const { engine, calls } = makeSpyEngine();
    const director = createAudioDirector(engine);
    director.handle([
      { type: 'mine-dropped', mineId: 7, pos: { x: 0, y: 0 } },
      { type: 'mine-armed', mineId: 7, pos: { x: 0, y: 0 } },
    ]);
    expect(calls.map((c) => c.key)).toEqual(['mine-drop', 'mine-arm']);
  });

  it('maps mine-detonate to mine-boom', () => {
    const { engine, calls } = makeSpyEngine();
    const director = createAudioDirector(engine);
    director.handle([{ type: 'mine-detonate', mineId: 7, pos: { x: 0, y: 0 } }]);
    expect(calls.map((c) => c.key)).toEqual(['mine-boom']);
  });

  it('maps win to victory and lose to defeat', () => {
    const { engine, calls } = makeSpyEngine();
    const director = createAudioDirector(engine);
    director.handle([{ type: 'win' }, { type: 'lose' }]);
    expect(calls.map((c) => c.key)).toEqual(['victory', 'defeat']);
  });

  it('plays nothing for wall-destroyed (blast is already covered by explosion/mine-boom)', () => {
    const { engine, calls } = makeSpyEngine();
    const director = createAudioDirector(engine);
    director.handle([{ type: 'wall-destroyed', wallId: 12, pos: { x: 0, y: 0 } }]);
    expect(calls).toHaveLength(0);
  });

  it('respects a custom playerId', () => {
    const { engine, calls } = makeSpyEngine();
    const director = createAudioDirector(engine, 5);
    director.handle([
      { type: 'fire', ownerId: 5, bulletType: 'normal', pos: { x: 0, y: 0 }, angle: 0 },
      { type: 'fire', ownerId: 0, bulletType: 'normal', pos: { x: 0, y: 0 }, angle: 0 },
    ]);
    expect(calls.map((c) => c.key)).toEqual(['cannon', 'cannon-enemy']);
  });
});
```

- [ ] **Step: Run the test to verify it fails**

Command: `npx vitest run src/audio/director.test.ts`

Expected: FAIL with `Cannot find module './director'` (the director module does not exist yet).

- [ ] **Step: Implement the audio director**

```ts
// src/audio/director.ts
import type { AudioEngine } from './engine';
import type { SimEvent } from '../sim/events';

export interface AudioDirector {
  handle(events: SimEvent[]): void;
}

// Inert fallback only: the loop (task 33) passes the real player id. loadArena
// assigns ids from 1 in grid-scan order, so the player is NOT id 0.
const DEFAULT_PLAYER_ID = 0;
// Each successive ricochet bounce shifts the ping pitch up for audible juice.
const RICOCHET_RATE_STEP = 0.15;

export function createAudioDirector(
  engine: AudioEngine,
  playerId: number = DEFAULT_PLAYER_ID,
): AudioDirector {
  function handleOne(e: SimEvent): void {
    switch (e.type) {
      case 'fire':
        engine.play(e.ownerId === playerId ? 'cannon' : 'cannon-enemy');
        break;
      case 'ricochet':
        engine.play('ping', { rate: 1 + e.bounceIndex * RICOCHET_RATE_STEP });
        break;
      case 'explosion':
        engine.play('explosion');
        break;
      case 'tank-destroyed':
        engine.play('explosion');
        break;
      case 'mine-dropped':
        engine.play('mine-drop'); // the drop thunk
        break;
      case 'mine-armed':
        engine.play('mine-arm'); // the arming beep — the mine just went live
        break;
      case 'mine-detonate':
        engine.play('mine-boom');
        break;
      case 'wall-destroyed':
        // No dedicated sound: the accompanying explosion / mine-boom already
        // covers the blast that destroyed the wall.
        break;
      case 'win':
        engine.play('victory');
        break;
      case 'lose':
        engine.play('defeat');
        break;
      default: {
        // Exhaustiveness guard: if a new SimEvent kind is added, this fails to compile.
        const _exhaustive: never = e;
        return _exhaustive;
      }
    }
  }

  return {
    handle(events) {
      for (const e of events) handleOne(e);
    },
  };
}
```

- [ ] **Step: Run the test to verify it passes**

Command: `npx vitest run src/audio/director.test.ts`

Expected: PASS (8 tests).

- [ ] **Step: Run the full audio suite and type-check**

Command: `npx vitest run src/audio/ && npx tsc --noEmit`

Expected: PASS (manifest + engine + director tests all green) and no TypeScript errors (the `never` exhaustiveness guard confirms every SimEvent kind is handled).

- [ ] **Step: Commit the director**

```bash
git add src/audio/director.ts src/audio/director.test.ts && git commit -m "Add audio director: SimEvent -> SFX mapping with pitch-varied ricochet"
```

---

### Task 31: Game state machine (title / playing / win / lose)

**Files:**
- Create: `src/game/state.ts`
- Test: `src/game/state.test.ts`

**Interfaces:**

Consumes:
- `type SimEvent` (task 4) — the discriminated union; this task reacts to the `{ type: 'win' }` and `{ type: 'lose' }` members.

Produces:
- `type GameState = 'title' | 'playing' | 'win' | 'lose'`
- `interface GameStateMachine { state: GameState; onEvents(events: SimEvent[]): void; toTitle(): void; startPlaying(): void; restart(): void; onChange(cb: (s: GameState) => void): void }`
- `function createGameStateMachine(): GameStateMachine` — starts in `'title'`; `startPlaying` -> `'playing'`; `onEvents` transitions to `'win'` on a `win` event and `'lose'` on a `lose` event (only while `'playing'`); `restart` re-enters `'playing'`; `onChange` notifies subscribers on every transition.

**Steps:**

- [ ] **Step: Write the failing test**

```ts
// src/game/state.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createGameStateMachine } from './state';

describe('game state machine', () => {
  it('starts in title', () => {
    const sm = createGameStateMachine();
    expect(sm.state).toBe('title');
  });

  it('startPlaying moves to playing', () => {
    const sm = createGameStateMachine();
    sm.startPlaying();
    expect(sm.state).toBe('playing');
  });

  it('transitions to win on a win event while playing', () => {
    const sm = createGameStateMachine();
    sm.startPlaying();
    sm.onEvents([{ type: 'win' }]);
    expect(sm.state).toBe('win');
  });

  it('transitions to lose on a lose event while playing', () => {
    const sm = createGameStateMachine();
    sm.startPlaying();
    sm.onEvents([{ type: 'lose' }]);
    expect(sm.state).toBe('lose');
  });

  it('ignores win/lose events when not playing', () => {
    const sm = createGameStateMachine();
    sm.onEvents([{ type: 'win' }]); // still in title
    expect(sm.state).toBe('title');
  });

  it('restart from win or lose returns to playing', () => {
    const sm = createGameStateMachine();
    sm.startPlaying();
    sm.onEvents([{ type: 'lose' }]);
    expect(sm.state).toBe('lose');
    sm.restart();
    expect(sm.state).toBe('playing');
  });

  it('only reacts to the first terminal event in a batch', () => {
    const sm = createGameStateMachine();
    sm.startPlaying();
    sm.onEvents([{ type: 'win' }, { type: 'lose' }]);
    expect(sm.state).toBe('win');
  });

  it('onChange fires exactly on transitions', () => {
    const sm = createGameStateMachine();
    const cb = vi.fn();
    sm.onChange(cb);
    sm.startPlaying();                 // title -> playing
    sm.onEvents([{ type: 'win' }]);    // playing -> win
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb).toHaveBeenNthCalledWith(1, 'playing');
    expect(cb).toHaveBeenNthCalledWith(2, 'win');
  });

  it('does not fire onChange when the state is unchanged', () => {
    const sm = createGameStateMachine();
    const cb = vi.fn();
    sm.onChange(cb);
    sm.toTitle(); // already in title, no transition
    expect(cb).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step: Run the test to verify it fails**
  - Command: `npx vitest run src/game/state.test.ts`
  - Expected: FAIL — `createGameStateMachine` is not exported / `src/game/state.ts` does not exist (module resolution error).

- [ ] **Step: Implement minimal code to pass**

```ts
// src/game/state.ts
import type { SimEvent } from '../sim/events';

export type GameState = 'title' | 'playing' | 'win' | 'lose';

export interface GameStateMachine {
  state: GameState;
  onEvents(events: SimEvent[]): void;
  toTitle(): void;
  startPlaying(): void;
  restart(): void;
  onChange(cb: (s: GameState) => void): void;
}

export function createGameStateMachine(): GameStateMachine {
  const subscribers: Array<(s: GameState) => void> = [];

  function emit(): void {
    for (const cb of subscribers) cb(machine.state);
  }

  function setState(next: GameState): void {
    if (next === machine.state) return;
    machine.state = next;
    emit();
  }

  const machine: GameStateMachine = {
    state: 'title',
    onEvents(events: SimEvent[]): void {
      if (machine.state !== 'playing') return;
      for (const ev of events) {
        if (ev.type === 'win') {
          setState('win');
          return;
        }
        if (ev.type === 'lose') {
          setState('lose');
          return;
        }
      }
    },
    toTitle(): void {
      setState('title');
    },
    startPlaying(): void {
      setState('playing');
    },
    restart(): void {
      // restart always re-enters 'playing' (the loop rebuilds a fresh arena world)
      // and notifies subscribers, even if it was already in a non-playing state.
      machine.state = 'playing';
      emit();
    },
    onChange(cb: (s: GameState) => void): void {
      subscribers.push(cb);
    },
  };

  return machine;
}
```

- [ ] **Step: Run the test to verify it passes**
  - Command: `npx vitest run src/game/state.test.ts`
  - Expected: PASS — 9 passed.

- [ ] **Step: Commit**
  - Command: `git add src/game/state.ts src/game/state.test.ts && git commit -m "Add game state machine (title/playing/win/lose)"`

---

### Task 32: HUD (lives, enemies remaining, mute/volume)

**Files:**
- Create: `src/game/hud.ts`, `src/game/hud.css`
- Test: (manual; DOM-bound overlay)

**Interfaces:**

Consumes:
- `type GameState` (task 31) — used by `setState` to show the title/win/lose panels.

Produces:
- `interface Hud { setLives(n: number): void; setEnemiesRemaining(n: number): void; setState(s: GameState): void; onMuteToggle(cb: () => void): void; onVolumeChange(cb: (v: number) => void): void; dispose(): void }`
- `function createHud(root: HTMLElement): Hud` — clean, toy-like DOM overlay: lives + enemies-remaining counters; a mute button and volume slider; title/win/lose panels with a start/restart affordance shown per `setState`.

> Contract extension (consumed by task 33): the panels need a start/restart button, but the blueprint `Hud` interface exposes no callback for its click. This task adds one method — `onStartRestart(cb: () => void): void` — so the main loop (task 33) can react to the panel button. This is an addition within the `game/` cluster only; all blueprint-listed methods keep their exact names/types.

**Steps:**

- [ ] **Step: Write the stylesheet**

```css
/* src/game/hud.css */
.hud {
  position: fixed;
  inset: 0;
  pointer-events: none;
  font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
  color: #fff;
  user-select: none;
}

.hud-topbar {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 12px 18px;
}

.hud-stat {
  font-size: 18px;
  font-weight: 700;
  letter-spacing: 0.5px;
  text-shadow: 0 2px 4px rgba(0, 0, 0, 0.5);
}

.hud-audio {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 10px;
  pointer-events: auto;
}

.hud-mute {
  pointer-events: auto;
  cursor: pointer;
  border: none;
  border-radius: 8px;
  padding: 6px 12px;
  font-weight: 700;
  background: #ffcf3f;
  color: #3a2c00;
}

.hud-volume {
  pointer-events: auto;
  cursor: pointer;
  width: 120px;
}

.hud-panel {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  background: rgba(20, 24, 30, 0.55);
  pointer-events: auto;
}

.hud-panel--hidden {
  display: none;
}

.hud-title {
  margin: 0;
  font-size: 56px;
  font-weight: 900;
  letter-spacing: 2px;
  text-shadow: 0 4px 10px rgba(0, 0, 0, 0.6);
}

.hud-subtitle {
  margin: 0;
  font-size: 18px;
  opacity: 0.9;
}

.hud-action {
  pointer-events: auto;
  cursor: pointer;
  border: none;
  border-radius: 12px;
  padding: 12px 28px;
  font-size: 20px;
  font-weight: 800;
  background: #4fd06a;
  color: #06340f;
  box-shadow: 0 6px 0 #2f8f45;
}

.hud-action:active {
  transform: translateY(3px);
  box-shadow: 0 3px 0 #2f8f45;
}
```

- [ ] **Step: Implement the HUD**

```ts
// src/game/hud.ts
import type { GameState } from './state';
import './hud.css';

export interface Hud {
  setLives(n: number): void;
  setEnemiesRemaining(n: number): void;
  setState(s: GameState): void;
  onMuteToggle(cb: () => void): void;
  onVolumeChange(cb: (v: number) => void): void;
  /** Extension: fired when the title/win/lose panel's start/restart button is clicked. */
  onStartRestart(cb: () => void): void;
  dispose(): void;
}

export function createHud(root: HTMLElement): Hud {
  const el = document.createElement('div');
  el.className = 'hud';
  el.innerHTML = `
    <div class="hud-topbar">
      <div class="hud-stat">Lives: <span class="hud-lives">3</span></div>
      <div class="hud-stat">Enemies: <span class="hud-enemies">3</span></div>
      <div class="hud-audio">
        <button class="hud-mute" type="button">Mute (M)</button>
        <input class="hud-volume" type="range" min="0" max="1" step="0.01" value="0.6" />
      </div>
    </div>
    <div class="hud-panel hud-panel--hidden">
      <h1 class="hud-title"></h1>
      <p class="hud-subtitle"></p>
      <button class="hud-action" type="button"></button>
    </div>
  `;
  root.appendChild(el);

  const livesEl = el.querySelector('.hud-lives') as HTMLElement;
  const enemiesEl = el.querySelector('.hud-enemies') as HTMLElement;
  const muteBtn = el.querySelector('.hud-mute') as HTMLButtonElement;
  const volumeEl = el.querySelector('.hud-volume') as HTMLInputElement;
  const panel = el.querySelector('.hud-panel') as HTMLElement;
  const titleEl = el.querySelector('.hud-title') as HTMLElement;
  const subtitleEl = el.querySelector('.hud-subtitle') as HTMLElement;
  const actionBtn = el.querySelector('.hud-action') as HTMLButtonElement;

  const muteCbs: Array<() => void> = [];
  const volumeCbs: Array<(v: number) => void> = [];
  const startRestartCbs: Array<() => void> = [];

  const handleMute = (): void => {
    for (const cb of muteCbs) cb();
  };
  const handleVolume = (): void => {
    const v = Number(volumeEl.value);
    for (const cb of volumeCbs) cb(v);
  };
  const handleAction = (): void => {
    for (const cb of startRestartCbs) cb();
  };

  muteBtn.addEventListener('click', handleMute);
  volumeEl.addEventListener('input', handleVolume);
  actionBtn.addEventListener('click', handleAction);

  function setState(s: GameState): void {
    if (s === 'playing') {
      panel.classList.add('hud-panel--hidden');
      return;
    }
    panel.classList.remove('hud-panel--hidden');
    if (s === 'title') {
      titleEl.textContent = 'TANKS!';
      subtitleEl.textContent = 'Clear the arena. One shot kills anything.';
      actionBtn.textContent = 'Start';
    } else if (s === 'win') {
      titleEl.textContent = 'You Win!';
      subtitleEl.textContent = 'Arena cleared.';
      actionBtn.textContent = 'Play Again';
    } else {
      titleEl.textContent = 'Game Over';
      subtitleEl.textContent = 'Out of lives.';
      actionBtn.textContent = 'Retry';
    }
  }

  setState('title');

  return {
    setLives(n: number): void {
      livesEl.textContent = String(n);
    },
    setEnemiesRemaining(n: number): void {
      enemiesEl.textContent = String(n);
    },
    setState,
    onMuteToggle(cb: () => void): void {
      muteCbs.push(cb);
    },
    onVolumeChange(cb: (v: number) => void): void {
      volumeCbs.push(cb);
    },
    onStartRestart(cb: () => void): void {
      startRestartCbs.push(cb);
    },
    dispose(): void {
      muteBtn.removeEventListener('click', handleMute);
      volumeEl.removeEventListener('input', handleVolume);
      actionBtn.removeEventListener('click', handleAction);
      el.remove();
    },
  };
}
```

- [ ] **Step: Type-check that it compiles**
  - Command: `npx tsc --noEmit`
  - Expected: PASS — no output, exit code 0 (strict mode clean; `.css` import resolved by Vite's client types).

- [ ] **Step: Manual verification**
  - Command: `npm run dev`, then open the served URL.
  - Verify:
    - The title panel shows "TANKS!" with a "Start" button over the diorama; top bar shows "Lives: 3" and "Enemies: 3".
    - Clicking the mute button and dragging the volume slider trigger their callbacks (confirm once wired in task 33 — for now, temporarily log in a callback if checking in isolation).
    - `hud.setState('win')` shows the win panel with "Play Again"; `hud.setState('lose')` shows "Retry"; `hud.setState('playing')` hides the panel.
    - The HUD stays uncluttered and does not block clicks on the game canvas except over the panel/controls (pointer-events).

- [ ] **Step: Commit**
  - Command: `git add src/game/hud.ts src/game/hud.css && git commit -m "Add toy-like HUD overlay (lives, enemies, mute/volume, panels)"`

---

### Task 33: Main loop — fixed-timestep accumulator wiring everything

**Files:**
- Create: `src/game/loop.ts`
- Modify: `src/main.ts`
- Test: (manual; end-to-end)

**Interfaces:**

Consumes:
- `function bootCanvas(root: HTMLElement): HTMLCanvasElement` (task 1)
- `interface StepResult { world: World; events: SimEvent[] }`, `function step(world: World, input: InputState): StepResult`, `interface World` (task 8)
- `function createArenaWorld(): World` (task 23)
- `interface InputState` (task 2), `type SimEvent` (task 4)
- `interface InputController { sample(): InputState; dispose(): void }`, `function createInputController(target: HTMLElement, screenToGround: (clientX: number, clientY: number) => Vec2): InputController` (task 14)
- `interface Renderer3D { render(prev: World, curr: World, alpha: number, events: SimEvent[], dt: number): void; screenToGround(clientX: number, clientY: number): Vec2; resize(w: number, h: number): void; dispose(): void }`, `function createRenderer(canvas: HTMLCanvasElement, worldWidth: number, worldHeight: number): Renderer3D` (task 28)
- `interface AudioEngine { play; startMusic(): void; stopMusic(): void; setMuted(muted: boolean): void; toggleMute(): boolean; isMuted(): boolean; setVolume(v: number): void; dispose(): void }`, `function createAudioEngine(manifest: AudioManifest): AudioEngine`, `const AUDIO_MANIFEST` (task 29)
- `interface AudioDirector { handle(events: SimEvent[]): void }`, `function createAudioDirector(engine: AudioEngine, playerId?: number): AudioDirector` (task 30)
- `type GameState`, `interface GameStateMachine`, `function createGameStateMachine(): GameStateMachine` (task 31)
- `interface Hud` (incl. `onStartRestart`), `function createHud(root: HTMLElement): Hud` (task 32)
- `const DT = 1 / 60` (task 3)

Produces:
- `function startGame(canvas: HTMLCanvasElement, uiRoot: HTMLElement): { dispose(): void }` — builds the arena world, input, renderer, audio engine+director, state machine, and HUD; runs a fixed-timestep accumulator (`while (acc >= DT) { prev = curr; ({ world, events } = step(curr, input.sample())); curr = world; ... }`); drains events to the director + state machine; renders `render(prev, curr, alpha, frameEvents, dt)` each animation frame; wires HUD mute/volume to the audio engine and start/restart to a fresh arena; updates HUD lives/enemies from `curr`.
- `src/main.ts`: `startGame(bootCanvas(document.getElementById('app')!), document.getElementById('app')!)`.

**Steps:**

- [ ] **Step: Implement the loop**

```ts
// src/game/loop.ts
import { DT } from '../sim/constants';
import { step, type World } from '../sim/world';
import { createArenaWorld } from '../sim/arena';
import type { SimEvent } from '../sim/events';
import { createInputController } from '../input/input';
import { createRenderer } from '../render/renderer';
import { createAudioEngine } from '../audio/engine';
import { AUDIO_MANIFEST } from '../audio/manifest';
import { createAudioDirector } from '../audio/director';
import { createGameStateMachine } from './state';
import { createHud } from './hud';

/** Arena bounds come from the outermost boundary walls (loadArena origin is 0,0). */
function computeBounds(world: World): { width: number; height: number } {
  let width = 0;
  let height = 0;
  for (const w of world.walls) {
    if (w.aabb.maxX > width) width = w.aabb.maxX;
    if (w.aabb.maxY > height) height = w.aabb.maxY;
  }
  return { width, height };
}

function countEnemies(world: World): number {
  let n = 0;
  for (const t of world.tanks) {
    if (t.kind !== 'player' && t.alive) n += 1;
  }
  return n;
}

export function startGame(
  canvas: HTMLCanvasElement,
  uiRoot: HTMLElement,
): { dispose(): void } {
  let curr: World = createArenaWorld();
  let prev: World = curr;

  const { width, height } = computeBounds(curr);

  const renderer = createRenderer(canvas, width, height);
  const input = createInputController(canvas, (x, y) => renderer.screenToGround(x, y));
  const audio = createAudioEngine(AUDIO_MANIFEST);
  const director = createAudioDirector(audio, curr.tanks.find((t) => t.kind === 'player')!.id);
  const sm = createGameStateMachine();
  const hud = createHud(uiRoot);

  function updateHudStats(): void {
    hud.setLives(curr.lives);
    hud.setEnemiesRemaining(countEnemies(curr));
  }

  function resetWorld(): void {
    curr = createArenaWorld();
    prev = curr;
    acc = 0;
    updateHudStats();
  }

  // --- HUD wiring -----------------------------------------------------------
  hud.onMuteToggle(() => {
    audio.toggleMute();
  });
  hud.onVolumeChange((v) => {
    audio.setVolume(v);
  });
  hud.onStartRestart(() => {
    if (sm.state === 'title') {
      sm.startPlaying();
    } else {
      // win or lose -> rebuild a fresh arena and re-enter playing
      resetWorld();
      sm.restart();
    }
  });

  sm.onChange((s) => {
    hud.setState(s);
    if (s === 'playing') audio.startMusic();
  });

  hud.setState(sm.state); // initial title panel
  updateHudStats();

  // --- global mute hotkey (M) ----------------------------------------------
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'm' || e.key === 'M') audio.toggleMute();
  };
  window.addEventListener('keydown', onKey);

  // --- resize ---------------------------------------------------------------
  const onResize = (): void => {
    renderer.resize(window.innerWidth, window.innerHeight);
  };
  window.addEventListener('resize', onResize);
  onResize();

  // --- fixed-timestep accumulator ------------------------------------------
  let acc = 0;
  let last = performance.now();
  let raf = 0;
  let running = true;

  const frame = (now: number): void => {
    if (!running) return;
    raf = requestAnimationFrame(frame);

    let dtReal = (now - last) / 1000;
    last = now;
    if (dtReal > 0.25) dtReal = 0.25; // clamp to avoid a spiral of death after a stall

    const frameEvents: SimEvent[] = [];

    if (sm.state === 'playing') {
      acc += dtReal;
      while (acc >= DT) {
        prev = curr;
        const result = step(curr, input.sample());
        curr = result.world;
        acc -= DT;
        for (const ev of result.events) frameEvents.push(ev);
      }
      if (frameEvents.length > 0) {
        director.handle(frameEvents);
        sm.onEvents(frameEvents);
      }
      updateHudStats();
    } else {
      // Not simulating: keep prev == curr so the scene renders a static pose.
      acc = 0;
      prev = curr;
    }

    const alpha = sm.state === 'playing' ? acc / DT : 1;
    renderer.render(prev, curr, alpha, frameEvents, dtReal);
  };

  raf = requestAnimationFrame(frame);

  return {
    dispose(): void {
      running = false;
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
      input.dispose();
      renderer.dispose();
      audio.dispose();
      hud.dispose();
    },
  };
}
```

- [ ] **Step: Wire up main.ts**

```ts
// src/main.ts
import { bootCanvas } from './render/canvas';
import { startGame } from './game/loop';

const root = document.getElementById('app')!;
startGame(bootCanvas(root), root);
```

- [ ] **Step: Type-check the whole project**
  - Command: `npx tsc --noEmit`
  - Expected: PASS — no output, exit code 0 (all cross-module signatures line up: `step` returns `{ world, events }`, `renderer.screenToGround` feeds `createInputController`, `director.handle`/`sm.onEvents` consume the same `SimEvent[]`).

- [ ] **Step: Build to confirm a production bundle**
  - Command: `npm run build`
  - Expected: PASS — Vite build completes with no type errors and emits `dist/`.

- [ ] **Step: Run the full sim test suite (guard against regressions in wiring)**
  - Command: `npx vitest run`
  - Expected: PASS — every prior sim/game unit test still green.

- [ ] **Step: Manual end-to-end verification**
  - Command: `npm run dev`, then open the served URL.
  - Verify:
    - Title panel -> click **Start** -> the arena plays; the player drives with WASD, the turret tracks the mouse, left-click fires, right-click/Space drops a mine.
    - Motion is smooth: throttle the tab / test on a 144Hz and a ~30Hz display — interpolation keeps movement fluid while the sim ticks at a fixed 60Hz (behavior identical, only smoothness differs).
    - Firing plays the cannon, ricochets ping (pitch varies per bounce), explosions and mine detonations show particles and play their SFX; enemy fire is subtly distinct.
    - HUD "Lives" and "Enemies" counters update as tanks die/respawn.
    - Clearing all three enemies shows the **You Win!** panel; dying out of lives shows **Game Over**; the panel button rebuilds a fresh arena and resumes cleanly.
    - **M** mutes/unmutes; the HUD mute button and volume slider affect audio.
    - No console errors across a full title -> play -> win/lose -> restart cycle.

- [ ] **Step: Commit**
  - Command: `git add src/game/loop.ts src/main.ts && git commit -m "Wire main loop: fixed-timestep accumulator connecting sim, render, audio, input, HUD"`
