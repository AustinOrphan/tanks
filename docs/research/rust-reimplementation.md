# Reimplementing Tanks! in Rust

**Investigated 2026-08-11.**

This document evaluates whether Tanks! should be reimplemented in Rust, what the useful migration boundary is, how the work should be staged, how it interacts with the current backlog, and what the likely engineering cost is.

It is a decision record and migration plan, not a commitment to rewrite the entire game.

---

## Bottom line

**Reimplementing the deterministic simulation in Rust is strategically defensible. Reimplementing the entire game in Rust is not justified today.**

The current architecture has already created the seam that makes an incremental migration viable:

- `src/sim/` is pure and deterministic;
- the sim never imports Three.js, Howler, or DOM APIs;
- the fixed-step driver calls a narrow `step`/`stepInputs` boundary;
- rendering, audio, haptics, HUD/state, and particles are one-way consumers of world state and `SimEvent`s;
- input is already represented as a small deterministic per-tick structure;
- `stepInputs(world, inputs[])` already exists as the multiplayer-ready primitive;
- replay and golden-trace infrastructure already provide unusually strong behavioral oracles.

The recommended target is therefore:

```text
                 EXISTING TYPESCRIPT / WEB SHELL
┌──────────────────────────────────────────────────────────┐
│ Game loop / campaign / persistence / HUD / input         │
│ Three.js renderer / particles / customization            │
│ Howler + procedural audio / haptics                      │
└───────────────────────┬──────────────────────────────────┘
                        │ small simulation API
                        ▼
┌──────────────────────────────────────────────────────────┐
│ tanks-wasm                                               │
│ browser adapter / wasm-bindgen                           │
├──────────────────────────────────────────────────────────┤
│ tanks-sim                                                │
│ PURE RUST                                                │
│ world / physics / bullets / mines / AI / RNG / events   │
├──────────────────────────────────────────────────────────┤
│ tanks-content                                            │
│ arena/tank/AI schemas + validation                       │
└──────────────────────────────────────────────────────────┘
                        │
                        ├── WASM -> existing browser game
                        ├── native -> future headless server
                        ├── native -> future native client
                        └── native -> CLI/replay/testing tools
```

The important distinction is:

> **Piecemeal development: yes. Piecemeal production execution: mostly no.**

Collision, bullets, mines, AI, etc. can be translated and verified one module at a time inside the Rust implementation. They should not normally be split across TypeScript and Rust at runtime. The useful production migration boundary is the simulation as a whole.

---

## Why the whole sim is the correct boundary

The simulation stages operate on one shared `World` through a deliberately ordered tick pipeline. `World` owns tanks, bullets, mines, blasts, walls, spawns, the RNG seed, status, lives, and round state.

A migration shaped like this would be undesirable:

```text
TypeScript AI
    ↓
Rust collision through WASM
    ↓
TypeScript bullets
    ↓
Rust mines through WASM
```

That design creates repeated JS/WASM crossings inside every 60 Hz tick and requires either repeated serialization or a temporary shared-memory ABI that becomes migration infrastructure rather than game architecture.

Instead, preserve the existing conceptual boundary:

```text
inputs -> simulation step -> { world, events }
```

The TypeScript driver and renderer should not care whether that implementation is TypeScript or Rust.

---

## Work that should land before the port

The newly approved campaign/run model should be treated as the architectural cutoff before freezing the simulation contract.

Relevant work:

- #153 — first-class persisted campaign-run state;
- #154 — campaign level identity/order separate from arena identity;
- #152 — persistent run lives, implemented on top of the run model rather than as a one-off counter patch.

The reason is not that campaign persistence belongs in Rust. It does not necessarily belong there at all. The reason is that the current code still contains transitional assumptions around level position, lives, continuation, and the word `run` itself. Porting those assumptions faithfully and immediately restructuring them again in Rust would create avoidable duplicate work.

The intended boundary should remain roughly:

```text
CampaignDefinition
ActiveRun
PracticeSession
Permanent progression
Stats / achievements
        │
        │ creates/resumes a level attempt
        ▼
      World
        │
        │ 60 Hz deterministic simulation
        ▼
      Events
```

Persistent campaign ownership remains outside the low-level physics/AI simulation unless a later native/server architecture gives a concrete reason to move broader domain logic into Rust.

---

## Recommended Rust workspace

Start with a small workspace rather than introducing an engine.

```text
rust/
  Cargo.toml
  crates/
    tanks-sim/
    tanks-content/
    tanks-wasm/
    tanks-cli/
```

### `tanks-sim`

Pure deterministic game simulation.

Owns, eventually:

- world/entity types;
- fixed simulation constants;
- deterministic RNG;
- movement and collision;
- bullet simulation;
- mines and blasts;
- AI and targeting;
- round/status transitions;
- `SimEvent` production;
- `step_inputs`.

It must not know about:

- WASM;
- the DOM;
- Three.js;
- Howler;
- browser storage;
- HUD state;
- platform APIs;
- runtime feature flags.

### `tanks-content`

Language-neutral authored-content loading and validation.

The existing JSON files should remain the source of truth rather than creating separate TypeScript and Rust content definitions:

- `balance.json`;
- `tank-defs.json`;
- `ai-profiles.json`;
- `arenas.json`;
- future campaign definitions.

This crate can later own arena/campaign validation that is genuinely portable and simulation-facing.

### `tanks-wasm`

A thin browser adapter over `tanks-sim`.

It should contain interop concerns only, not game rules.

### `tanks-cli`

Headless utilities such as:

- golden-trace execution;
- replay verification;
- arena validation;
- deterministic probes;
- future benchmark/profiling commands.

This becomes useful even if no native graphical client is ever written.

---

## Migration sequence

### Phase 0 — settle campaign/run semantics

Land the campaign/run/attempt/practice model and arena-vs-campaign-level identity work before treating the current simulation contract as migration-ready.

Avoid large new simulation-side AI/physics features during the Rust translation if practical. UI, rendering, audio, content design, mobile work, and other shell work can continue.

### Phase 1 — introduce a TypeScript simulation adapter

Today the driver imports the TypeScript simulation directly. Introduce an explicit simulation collaborator without changing behavior.

Conceptually:

```ts
interface Simulation {
  step(world: World, inputs: InputState[]): StepResult;
}
```

The existing TypeScript implementation becomes `TsSimulation` or equivalent.

The golden trace must remain unchanged.

This makes the eventual Rust cutover a dependency substitution rather than another driver rewrite.

### Phase 2 — create the Rust workspace and prove the toolchain

Add Cargo, the WASM target, bindings generation, and CI plumbing.

Do not attempt to port the game yet. Prove only that:

- Rust builds reproducibly in CI;
- a trivial WASM function can be loaded by the existing Vite app;
- normal frontend iteration does not become unreasonably slow;
- TypeScript declarations for the boundary can be generated/checked.

### Phase 3 — port deterministic foundations

Translate:

- `Vec2`/AABB types;
- enums/entity structures;
- constants;
- RNG behavior;
- round phase logic;
- config deserialization/validation primitives.

The RNG must reproduce the current Mulberry32 stream exactly before anything that consumes randomness is ported.

### Phase 4 — port mechanics inside Rust

Translate in dependency order while TypeScript remains the shipped simulation:

1. movement/collision;
2. bullet simulation and ricochets;
3. hit resolution;
4. mines/blasts;
5. round reset/status logic;
6. AI movement;
7. targeting/bank-shot logic;
8. arena claims/validation/difficulty helpers that belong with simulation/content.

Each subsystem should gain native Rust tests and differential fixtures against the TypeScript implementation.

Do **not** expose each translated module to production through WASM individually.

### Phase 5 — build a cross-language differential harness

The existing golden trace is a strong regression oracle but should not be the only parity check.

Run the exact same initial world and per-tick input stream through TypeScript and Rust and compare state after every tick.

The harness should report the first divergence with at least:

- arena;
- seed;
- tick;
- entity ID;
- field;
- TypeScript value;
- Rust value.

The existing golden fingerprint remains valuable as a broad behavioral pin, but the migration harness needs better localization than a final hash.

Also port/supplement cases that the golden trace intentionally does not cover, such as the multi-input pairing rules and known collision escape branches.

### Phase 6 — integrate the complete Rust sim behind a dev flag

Only once the Rust simulation is complete should it become a selectable runtime implementation, for example:

```text
?dev=1&sim=rust
```

The TypeScript and Rust implementations can coexist temporarily for comparison.

Run the normal game through both paths:

- unit/integration tests;
- golden traces;
- real-browser trace harness;
- replay paths;
- gallery tooling where relevant;
- GL tests;
- visual regression tests;
- extended seeded autoplay/playthrough probes.

### Phase 7 — switch the default and delete the TypeScript sim

Do not maintain two production simulation implementations indefinitely.

After parity is established and the Rust path has had a short burn-in period:

- make Rust/WASM the default simulation;
- remove the TypeScript implementation;
- retain differential fixtures only where they remain useful as archived migration evidence;
- make the Rust native test suite authoritative for simulation behavior.

---

## Floating-point determinism is still a problem

Rust does not automatically solve the cross-platform floating-point question that already exists in the TypeScript simulation.

The current simulation uses transcendental operations including `sin`, `cos`, `atan2`, `hypot`, and `sqrt`. Rust standard-library transcendental implementations are not a guarantee of bit-identical results across every target/platform/toolchain combination.

Therefore the Rust design should introduce an explicit deterministic-math boundary rather than scattering direct standard-library calls throughout the simulation:

```rust
mod math {
    pub fn sin(x: f64) -> f64 { ... }
    pub fn cos(x: f64) -> f64 { ... }
    pub fn atan2(y: f64, x: f64) -> f64 { ... }
    pub fn hypot(x: f64, y: f64) -> f64 { ... }
}
```

Every deterministic call site should use that boundary.

Candidate implementations such as the pure-Rust `libm` crate are worth measuring, but they must not be declared cross-platform deterministic without running the same empirical tests already used for the JavaScript implementation.

Required targets should eventually include at least:

- browser WASM on Chromium;
- browser WASM on Firefox;
- browser WASM on Safari/iOS;
- x86-64 native;
- ARM64 native.

If exact cross-platform equality is not required for a future mode, this layer may still be useful simply because it makes the decision explicit and testable.

---

## WASM boundary and state transfer

The simplest first implementation can pass JS-friendly world snapshots across the boundary. The worlds are currently small enough that simplicity is more valuable than speculative optimization during the feasibility spike.

However, this must be measured early.

The existing TypeScript simulation is already inexpensive relative to a 16.7 ms frame budget. A Rust port that spends more time serializing the world than simulating it is possible if the API is careless.

If whole-object transfer is materially expensive, evolve toward a stateful Rust simulation:

```text
Rust GameSim
  current World
  previous World

step(inputs)
  ├── updates current
  ├── retains previous
  └── produces events

render_snapshot()
  ├── tank buffers / metadata
  ├── bullet buffers
  ├── mine buffers
  ├── blast buffers
  └── wall state
```

The renderer does not need arbitrary Rust objects. It needs enough structured data to interpolate and render the current entities.

Do not build this optimized representation until a benchmark shows the straightforward boundary is insufficient.

---

## Effort estimate

These are engineering estimates for preserving the current behavior and testing discipline, not estimates for a loose feature-equivalent rewrite.

| Scope | Engineering effort | Full-time equivalent | Confidence |
| --- | ---: | ---: | --- |
| Feasibility spike only | **24–40 h** | 3–5 days | High |
| Production Rust simulation + WASM cutover | **250–400 h** | 6–10 weeks | Medium-high |
| Rust sim + broader campaign/domain/save logic | **350–550 h** | 9–14 weeks | Medium |
| Full Rust game reimplementation | **1,000–1,700 h** | 25–43 weeks | Low |

If the engineer is simultaneously learning Rust to a significant degree, a rough planning multiplier of **1.3–1.6×** is reasonable. That is not a property of the codebase; it is schedule risk from learning and review/debug cycles.

### Breakdown of the recommended simulation migration

| Work | Estimate |
| --- | ---: |
| Rust workspace, CI, TS simulation seam, WASM proof | 25–40 h |
| Types, RNG, constants, config/content loading | 30–45 h |
| Collision, movement, bullets, mines, round/status logic | 60–90 h |
| AI, targeting, arena validation/claims/difficulty | 60–90 h |
| Differential tests, golden traces, replay compatibility | 55–85 h |
| Browser integration, bridge performance, CI cutover | 20–40 h |
| **Total** | **250–390 h** |

At approximately 10 hours/week of side-project work, the recommended migration is roughly a **6–10 month** project. The full rewrite is in a different class of commitment and should not be treated as the default continuation of the simulation port.

---

## Benefits

### One portable gameplay implementation

The same core can serve:

- browser WASM;
- a native headless authoritative server;
- native desktop/mobile clients if one is eventually justified;
- CLI validation and replay tooling.

This is the main architectural payoff.

### Stronger multiplayer foundation

`stepInputs` already provides the correct broad shape for multiple human input streams.

A portable native simulation makes both peer-deterministic clients and an authoritative server easier to support without maintaining a second gameplay implementation in Node/TypeScript.

The existing immutable-snapshot design also remains a strong fit for rollback.

### Future AI complexity lands in the long-lived implementation

The backlog already contains possible flow-field/pathfinding and positional-risk work. If those features become real, their cost increases the amount of simulation code that would later need translation.

A successful Rust migration before that expansion avoids writing major new AI systems twice.

### Better headless tooling

Arena validation, simulation probes, replay verification, fuzzing, and benchmarks become native commands that do not depend on a browser or Node runtime.

### More explicit domain types

Rust enums/newtypes can make identifiers, player/controller ownership, event variants, and invalid state combinations harder to mix accidentally.

---

## Costs and disadvantages

### Performance is not a sufficient reason by itself

The existing TypeScript simulation is already fast enough for the current game. A Rust port should not be sold as a performance fix for a measured performance problem that does not exist.

The justification is portability, native reuse, multiplayer/server options, stronger tooling, and future scale.

### More build complexity

The project gains:

- Cargo;
- a Rust toolchain;
- a WASM target;
- binding generation;
- cross-language CI concerns.

Node/Vite do not disappear while the web shell remains.

### Browser debugging becomes less direct

A gameplay bug may cross the TS/WASM boundary. Source maps and browser devtools are less frictionless than the current all-TypeScript simulation.

### Determinism still requires deliberate work

Rust changes the language; it does not make floating-point transcendental behavior magically portable.

### It does not solve renderer/platform work

A Rust simulation does not materially solve:

- mobile GPU cost;
- safe-area handling;
- orientation decisions;
- Three.js rendering optimization;
- native store packaging;
- console certification/runtime availability.

Those remain separate problems.

---

## Why not rewrite the renderer/UI/audio now

The current browser shell is mature and is not the architectural problem this investigation is trying to solve.

Existing systems include:

- Three.js rendering and interpolation;
- particles;
- customization/preview rendering;
- touch input;
- gamepad work;
- a substantial HUD/menu system;
- procedural sound/music;
- haptics;
- browser/mobile lifecycle handling;
- visual/GL/gallery tooling.

Reproducing all of those in a Rust-native engine would consume hundreds of hours while delivering comparatively little immediate product value.

A native Rust client should therefore be a **later independent decision**, not the automatic second half of the simulation migration.

If a native Rust client eventually becomes justified, Bevy is an obvious engine to prototype, but the decision should be based on a concrete platform/product need and a current evaluation of the engine at that time. It should not be introduced merely to make the language uniform.

---

## Interaction with the backlog

### Campaign expansion

Do #153/#154/#152 first, then let campaign/content design expand independently of the simulation ABI.

Campaign definitions and arena definitions should remain language-neutral authored data.

### Pathfinding / richer AI

If practical, defer substantial new simulation-side pathfinding/risk-model work until after the feasibility spike and migration decision.

If the Rust direction fails its gates, build the features in TypeScript with no regret. If the Rust direction succeeds, build them once in the implementation intended to remain canonical.

### Multiplayer

This is the strongest strategic reason for the Rust core.

The simulation port itself should remain behavior-preserving. After it is stable, multiplayer work can independently address:

- multiple controlled tanks/player identity;
- co-op/versus win and life rules;
- input quantization;
- event identities/tick IDs for rollback de-duplication;
- lockstep vs rollback vs authoritative networking.

Do not combine those behavioral changes with the language migration.

### Replays

Preserve the current input-trace approach.

The migration is also a good time to close the existing replay-versioning gap: the current replay data fingerprint covers simulation data but not simulation code. A Rust build identity or simulation protocol/version should become part of compatibility checks once the Rust implementation is canonical.

### Mobile / Steam

Continue platform work independently.

A Rust-WASM simulation does not block the short Capacitor-style mobile route and makes a later Tauri/native/Steam architecture stronger without forcing it today.

### Rendering, mobile UI, music, and polish

Continue these in TypeScript. They do not need to wait for the simulation port.

---

## Feasibility spike

Before committing 250–400 hours, spend **24–40 hours** answering four questions with code and measurements.

### Gate 1 — behavioral parity

Port enough simulation to run a meaningful deterministic trace and prove the Rust output can be compared field-by-field against TypeScript.

Success means a divergence can be localized to a specific tick and field rather than producing only “hash changed”.

### Gate 2 — math viability

Choose and test a deterministic-math strategy for the currently relevant transcendental operations.

Success means the strategy is explicit and testable across WASM/native targets rather than relying on accidental agreement.

### Gate 3 — bridge cost

Measure the full browser path: JS input -> Rust step -> render-visible state/events back to JS.

Success means the bridge leaves large headroom inside the 16.7 ms frame budget. A reasonable initial target is **comfortably below 1 ms p95 for simulation + interop** on representative hardware, but the measurement matters more than the exact threshold.

### Gate 4 — build ergonomics

Prove the existing frontend development loop and CI can consume the Rust artifact reliably.

Success means normal web iteration does not become dominated by Rust/WASM rebuild friction.

---

## Go / no-go rule

Proceed with the production simulation migration only if all four feasibility gates pass.

### Proceed when

- parity is demonstrable;
- deterministic math has a defensible implementation/measurement plan;
- WASM interop cost is small;
- build/CI ergonomics remain acceptable;
- the strategic goals still include one or more of multiplayer, authoritative simulation, native reuse, or materially larger AI/simulation complexity.

### Stop after the spike when

- the only remaining argument is that Rust is cleaner or theoretically faster;
- the bridge/build complexity outweighs the reuse benefit;
- deterministic parity becomes disproportionately difficult;
- platform plans no longer benefit from a portable native simulation.

Stopping after the spike is a valid outcome. The current TypeScript simulation is already well structured.

---

## Decision

The preferred long-term direction, **conditional on the feasibility spike**, is:

> **Make Rust the canonical Tanks! simulation platform while retaining the mature TypeScript/web client until a concrete product or platform requirement justifies replacing another layer.**

This is not “rewrite Tanks! in Rust.”

It is a bounded migration of the part of the codebase that gains the most from portability, native execution, deterministic tooling, multiplayer reuse, and future simulation growth while preserving the substantial value already present in the browser client.
