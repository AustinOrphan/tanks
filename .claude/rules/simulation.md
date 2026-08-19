---
paths:
  - "src/sim/**"
  - "tools/baseline/**"
---

# Simulation rules

- Keep `src/sim/` free of Three.js, Howler, DOM APIs, wall time, and runtime flags.
- Preserve `TICK_HZ = 60` and `DT = 1 / 60` unless the task explicitly changes the
  simulation contract.
- `stepInputs` is the multiplayer primitive. It pairs input index with player-tank order;
  dead players retain slots, surplus inputs are ignored, and missing inputs are not idle
  inputs. Keep `step` as its one-line single-player adapter.
- The sim clones input and emits state plus `SimEvent[]`. When an event changes, inspect all
  render, particle, audio, haptics, game-state, and loop consumers.
- Use the existing validated catalogs for tanks, walls, balance, AI profiles, arenas, and
  campaign data. Do not branch on tank kinds to choose statistics.
- Use vendored math from `src/sim/math/` at simulation call sites covered by the
  cross-engine determinism work.
- `determinism.test.ts` proves repeatability, not behavior preservation. AI, arena, collision,
  and balance changes need the golden trace and the directly affected invariant tests.
- Arena grids, claims, campaign membership, trace pins, achievements, and framing have
  separate obligations. Re-derive the affected list instead of trusting an old checklist.
- Solid walls may merge as geometry; destructible cells remain separate destruction units.
  Do not revive buried-face or seam fixes without a reachable failing fixture.

For provenance, rejected approaches, and exact measurements, search the matching bold
heading in `docs/agent/architecture.md` before changing that mechanism.
