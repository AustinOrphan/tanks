---
paths:
  - "src/game/**"
  - "src/input/**"
  - "src/boot.ts"
  - "src/boot.test.ts"
  - "src/main.ts"
  - "docs/dev-flags.md"
  - "tools/devflags/**"
---

# Game and input rules

- `src/main.ts` stays wiring-only; construction and behavior belong behind injected seams
  in `src/boot.ts` or game modules.
- All persistence enters through `src/game/storage.ts`. Resolve storage once, inject the
  same object into all stores, and keep save import/export at the raw allow-listed key
  layer. Imported data becomes visible after reload.
- A campaign run owns its shared lives and campaign progress. Practice/level-select state
  must not create or mutate a campaign run.
- Replay recording decorates the effective per-tick input. It spans one world; its data
  fingerprint does not prove code compatibility.
- Keep both `sm.state` reads in the driver and keep `world`/`prevWorld` as getters; those
  apparently tidy refactors change behavior without a type error.
- Runtime development flags require `dev=1`, stay out of `src/sim/`, and must be temporary.
  Update `FLAG_REGISTRY` and regenerate `docs/dev-flags.md` with `npm run devflags:doc`.
- For CSS, preserve the raw-content test setup and structural guards; Vitest can otherwise
  stub a stylesheet to an empty string and make assertions vacuous.

Read `docs/agent/architecture.md` and `docs/agent/known-holes.md` at the matching heading
before changing persistence, replay, frame/driver wiring, or development flags.
