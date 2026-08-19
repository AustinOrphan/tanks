---
paths:
  - "src/audio/**"
  - "tools/audio/**"
---

# Audio rules

- Audio consumes simulation events as a one-way projection. Do not move browser/audio
  objects or timing into `src/sim/`.
- Preserve injected or fallback audio seams so tests do not require a real browser audio
  device.
- Use deterministic data and explicit manifests for authored music and sound collections;
  update the corresponding completeness tests when adding assets or entries.
- Use `npm run audio` for rendered inspection in addition to the directly affected tests.
- If a `SimEvent` payload changes, verify audio alongside render, particles, haptics,
  game state, and loop consumers.

The cross-layer projection contract and replay constraints are documented in
`docs/agent/architecture.md`.
