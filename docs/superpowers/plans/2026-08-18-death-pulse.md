# Death Pulse Implementation Plan (issue #200)

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans, one task at a time. Steps use checkbox
> (`- [ ]`) syntax. Prove the gap before each test (apply the breaking mutation, watch it
> fail, then keep the passing form) — this repo has shipped green tests that never could.

Design authority: `docs/superpowers/specs/2026-08-18-identity-spawn-death-animations-design.md`
(§5 the death pulse, §6 scope + dev flag). Companion to #199 (spawn animation core), which
is on branch `spawn-anim-core` and merged as PR #203. Branch this on top of #199's merge.

## Global Constraints (bind every task)

- **No `src/sim/` changes.** This is a render/HUD/flags feature. `src/sim/purity.test.ts`
  and the golden trace guard this; `BASELINE_HASH` must stay
  `a5458ede003c173ccc099b708f4b7d43b7537ca8a7846a87274b6376ccc311a9`.
- **The `tank-destroyed` SimEvent is NOT widened.** It carries `{ tankId, pos }` today and
  keeps exactly that. Identity colour is resolved render-side from the tank's
  `controlledBy`/`team` in the world, never added to the event — so no six-consumer sweep.
- **World-diff-driven, detached, pooled.** The death ring is spawned by diffing prev→curr
  worlds (a tank alive in prev, dead-or-absent in curr), at the tank's last-alive position
  in its identity colour. It is a scene-attached pooled mesh (NOT parented to the tank's
  `TankView.group`), because `entities.ts` disposes a dead tank's whole group the same tick
  death is detected (`entities.ts:1360-1365`, the `!seen.has(id)` teardown) — anything under
  the group is gone before a multi-second pulse could play.
- **Reuse, don't duplicate, colour logic.** `identityColor(slot)` and `teamColor(team)` are
  exported from `src/render/entities.ts` (`:83`, `:99`); import them. Do not re-hardcode
  `IDENTITY_RING_COLORS`.
- **Single-player default colour is a named constant, asserted against the constant** — never
  a hardcoded literal in a test (the spec's §11 residual: the choice is red today, but must
  be a one-line change).

## Task 1: The `enemyDeathPulse` dev flag

Isolated plumbing, done first so later tasks can gate on it. `DevFlags` uses a
`Record<keyof DevFlags, FlagSpec>` registry (`devflags.ts`), so a new field is a compile
error until all its touch points exist — that gate is the point.

**Files:** `src/game/devflags.ts`, `src/game/devflags.test.ts`, `docs/dev-flags.md` (generated).

- [ ] **Step 1 — write the failing test.** In `devflags.test.ts`, assert
  `parseDevFlags('?dev=1&enemyDeathPulse=1').enemyDeathPulse === true` and that it is
  `false` for `?dev=1` alone and for `''`. The existing `DEV_FLAGS_OFF`-derived coverage
  test will pick the field up automatically once the field exists — confirm it does.
- [ ] **Step 2 — run, watch it fail** (`enemyDeathPulse` is not a key yet → TS error / undefined).
- [ ] **Step 3 — implement.** Add `enemyDeathPulse: boolean` to the `DevFlags` interface
  (near `friendlyFire`), to `DEV_FLAGS_OFF` (`false`), to `parseDevFlags`
  (`enemyDeathPulse: isOn(params, 'enemyDeathPulse')`), and a `FLAG_REGISTRY.enemyDeathPulse`
  entry: `{ kind: 'boolean', description: 'Enemy tanks also fire the identity death pulse (a coloured world ring); off = players only, enemies keep just the explosion burst.' }`.
  Not in the playtest bundle.
- [ ] **Step 4 — regenerate the doc:** `npm run devflags:doc`, then `npx vitest run tools/devflags/doc.test.ts` (green). Do NOT hand-edit `docs/dev-flags.md`.
- [ ] **Step 5 — run `devflags.test.ts`, green. Commit.**

Prove-the-gap: the completeness is compile-time (drop the `FLAG_REGISTRY` entry → tsc error);
the doc-drift guard fails if `docs/dev-flags.md` is stale.

## Task 2: `signalPlayerDeath(color)` + the recoloured vignette

The screen vignette is a hardcoded-red radial gradient in `hud.css` (`.hud-damage`,
`:1298`) with no CSS variable. Give it one, drive it from `signalPlayerDeath`, and keep the
single-player red as a named constant.

**Files:** `src/game/hud.ts`, `src/game/hud.css`, `src/game/hud.test.ts`,
`src/game/hud.css.test.ts` (verify still green), and the caller `src/game/loop.ts` (+ its test).

- [ ] **Step 1 — write the failing tests** (`hud.test.ts`):
  - `signalPlayerDeath(0x3fd0ff)` sets the vignette element's `--hud-damage-color` custom
    property to a colour string derived from `0x3fd0ff` (assert
    `damageEl.style.getPropertyValue('--hud-damage-color')` is the expected `rgb`/hex form).
  - The single-player call path uses `SINGLE_PLAYER_DEATH_VIGNETTE` — assert the property
    equals the value derived from that **exported constant**, not a literal red. (Import the
    constant into the test.)
- [ ] **Step 2 — run, watch fail** (signature takes no arg; no property set).
- [ ] **Step 3 — implement.**
  - `hud.css`: add `--hud-damage-color` with a red default on `.hud-damage` (or `:root`), and
    rewrite the gradient's `rgba(180,30,30,…)` stops to `color-mix`/`rgb` off the variable so
    the colour is variable-driven while the alpha ramp is unchanged. Keep the keyframes.
    Confirm `hud.css.test.ts` (brace balance + selector presence) stays green — extend it to
    assert `--hud-damage-color` is referenced if that guard's convention fits.
  - `hud.ts`: export `const SINGLE_PLAYER_DEATH_VIGNETTE = 0x...` (the current red, e.g.
    `0xb41e1e` to match the existing `rgb(180,30,30)`); change `signalPlayerDeath()` →
    `signalPlayerDeath(color: number)`, set `damageEl.style.setProperty('--hud-damage-color', <css colour from color>)` before re-triggering the animation class. Update the `HudApi`
    type signature (`:104`).
  - `loop.ts` caller (`:1114`): resolve the colour and pass it. Single-player →
    `SINGLE_PLAYER_DEATH_VIGNETTE`; ≥2 players → the dying player's identity colour
    (`identityColor(slot)` / `teamColor` for the tank whose `tankId` matches the death
    event). Keep `isPlayerDeath` as the trigger. Update the `loop.test.ts` `HudApi` stub to
    the new signature and assert the colour it receives.
- [ ] **Step 4 — run `hud.test.ts`, `loop.test.ts`, `hud.css.test.ts`, green. Commit.**

Prove-the-gap: mutation removing the `setProperty` call (vignette test red); mutation
hardcoding red instead of the passed `color` (the multiplayer-colour assertion red); mutation
inlining a red literal where `SINGLE_PLAYER_DEATH_VIGNETTE` is read (the constant-derived
assertion red only if the literal differs — so choose the assertion to compare to the
constant's value, making any divergence fail).

## Task 3: `death-pulse.ts` — the pooled detached world ring

Mirror `particles.ts`'s factory + pool + per-object clock. This module is fully vitest-
testable in jsdom (three works headless for non-GL), like `particles.test.ts`.

**Files:** new `src/render/death-pulse.ts`, new `src/render/death-pulse.test.ts`.

- [ ] **Step 1 — write failing tests** (`death-pulse.test.ts`, model on `particles.test.ts`
  scene-traversal helpers):
  - On a prev→curr diff where a player tank is alive in prev and dead in curr, `spawn`
    creates exactly one mesh named `death-ring` at the tank's prev position, coloured to its
    identity colour (`identityColor(slot)`). Assert position and material colour.
  - The ring **expires on its own clock**: after `update(dt)` totalling more than the
    lifetime, no `death-ring` remains in the scene (recycled/hidden).
  - It is a **distinct effect from a spawn ring**: name is `death-ring`, not `spawn-ring`
    (so a same-frame respawn elsewhere is separable) — assert the names differ.
  - **Enemy gating:** with `{ enemyEnabled: false }`, an enemy alive→dead diff yields **no**
    `death-ring`; with `{ enemyEnabled: true }`, it yields one. Player rings ignore the flag.
  - Each test names the mutation that breaks it (wrong position source; wrong colour lookup;
    no lifetime decrement; dropped enemy gate).
- [ ] **Step 2 — run, watch fail** (module does not exist).
- [ ] **Step 3 — implement `createDeathPulseSystem(scene)` → `{ spawn(prev, curr, opts), update(dt), dispose() }`:**
  - `spawn(prev, curr, { enemyEnabled })`: build a set of currently-alive ids from
    `curr.tanks`; for each `p` in `prev.tanks` with `p.alive` and (`p.id` absent from that set
    OR its curr entry `!alive`): if `p.kind === 'player'` OR (`enemyEnabled` and enemy),
    acquire a pooled ring at `p.pos` in `curr.mode === 'teams' ? teamColor(p.team ?? 0) : identityColor(p.controlledBy ?? 0)`. Reuse #199's `makeSpawnRing(color)` from
    `./spawn-anim` for the mesh recipe (the issue's "shared ring-mesh helper"), then set
    `mesh.name = 'death-ring'` so a same-frame spawn ring stays separable. (`makeSpawnRing`
    mints a fresh geometry per call — fine for a small pool of own meshes.) One
    fixed effect, no variant registry).
  - `update(dt)`: per active ring, `life -= dt`; recycle at `life <= 0`; drive
    radius outward (`scale.setScalar(baseR + growth * k)`) and opacity down as it expands
    (the mirror of the spawn ring: out + fade). Pool + `MAX` cap like particles.
  - `dispose()`: dispose all meshes/materials, remove from scene, clear arrays.
  - Import `identityColor`, `teamColor` from `./entities`.
- [ ] **Step 4 — run `death-pulse.test.ts` + full `src/render/`, green. Commit.**

Prove-the-gap: each mutation in Step 1 must redden its test (verified before commit).

## Task 4: Wire the system into the renderer, threaded by the flag

`renderer.ts` is browser-only (no vitest); its collaborators are created inside it and
covered by the GL harness (`tools/gl`, the CI `visual` job), same as `particles`.

**Files:** `src/render/renderer.ts`, the flag-plumbing path (trace it), and a GL/integration
pin for the wiring.

- [ ] **Step 1 — trace the flag path.** Find how an existing render-affecting flag (e.g.
  `quality`) flows from `parseDevFlags` through boot/loop into `renderer`. Record the path;
  thread `enemyDeathPulse` the same way (a render option, not a new global).
- [ ] **Step 2 — wire it.** In `renderer.ts`, `const deathPulse = createDeathPulseSystem(ctx.scene)`;
  call `deathPulse.spawn(prev, curr, { enemyEnabled })` and `deathPulse.update(dt)` alongside
  the `particles` calls in `render`; `deathPulse.dispose()` in `dispose`. Confirm `render`
  already has `prev` and `curr` in scope (it forwards them to `entities.sync`).
- [ ] **Step 3 — pin the wiring.** Composition blindness (CLAUDE.md): a unit test on
  `death-pulse.ts` does NOT prove `renderer` calls it. Add the cheapest honest pin — extend
  the GL harness (`tools/gl/harness.ts`) to drive a player death in a real scene and assert a
  `death-ring` appears, OR inject `createDeathPulseSystem` as a factory into `renderer` so a
  spy can assert the calls. Choose per what the harness already supports; state the choice.
- [ ] **Step 4 — run `npm run test:gl` (the `visual` gate) locally if the box allows; else
  rely on CI's `visual` job. Commit.**

## Task 5: Full gate + PR (closes #200)

- [ ] `npm test` (tsc + vitest) green.
- [ ] `npx vitest run tools/baseline/trace.test.ts` — `BASELINE_HASH` unmoved at `a5458ede…`.
      If it moved, a `src/sim/` file was touched — revert.
- [ ] Confirm `tank-destroyed` shape unchanged: `git diff main..HEAD -- src/sim/events.ts`
      is empty (and no `src/sim/` file changed at all).
- [ ] `npm run mutate` green (no manifest entry is required by #200; the existing suite must
      stay green). CI runs it as a required check regardless.
- [ ] `docs/dev-flags.md` regenerated and `tools/devflags/doc.test.ts` green.
- [ ] Push, `gh pr create --base main`, body: closes #200, the world ring + vignette + flag,
      `BASELINE_HASH` stated unmoved, `tank-destroyed` unchanged, single-player red held via
      the named constant. Merge on green CI + resolved threads (arc policy).

## Self-Review

**Spec coverage:** §5 world ring → Task 3; §5 vignette recolour + single-player constant →
Task 2; §6 enemy dev flag → Task 1; wiring → Task 4; invariants → Task 5. §8 test list
(death pos/colour, own clock, distinct-from-spawn, vignette-vs-constant, flag coverage) →
Tasks 2–3 tests.

**Cross-task interfaces:** Task 1's `enemyDeathPulse` is consumed by Task 4's threading and
Task 3's `opts.enemyEnabled` (Task 3 takes it as a parameter, so Task 3 is testable before
Task 4 wires the real flag). Task 2's `SINGLE_PLAYER_DEATH_VIGNETTE` is self-contained.
Task 3's `createDeathPulseSystem` is consumed only by Task 4. No task depends on a later
task's output.

**Deferred (out of scope, stated):** the gallery `--spawn-anim`/death media (#201); death
pulse as a customizable variant set (spec §11 — one fixed effect for now); tuning the ring's
growth/lifetime look (a `gallery --sweep` follow-up, not a correctness gate).

**Placeholder scan:** none — every step carries concrete files and the exact registry/CSS
changes; Task 4 Step 1 is a genuine trace with a recorded finding, not a TODO.
