---
paths:
  - "src/presentation/**"
  - "src/dependency-direction.test.ts"
---

# Presentation contract rules

- `src/presentation/` owns renderer-independent vocabulary that more than one layer reads:
  identity colours and labels, the customization catalog, and presentation cue sets. Keep
  it free of DOM, Three.js, Howler, packages, persistence, and session orchestration; name
  simulation TYPES only, through `import type`.
- Move a definition here only when game/HUD and render/audio both read it. Renderer
  materials and geometry, CSS, and audio-engine details stay in their own layer.
- `src/dependency-direction.test.ts` enforces the layer order. A new `game -> render` or
  `game -> audio` import is either wiring (list it in `GAME_WIRING`, per target module) or
  vocabulary that belongs here. Any rule you change needs a fixture on both sides.

Search "Presentation contracts" in `docs/agent/architecture.md` for the rationale.
