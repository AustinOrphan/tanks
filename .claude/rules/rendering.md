---
paths:
  - "src/render/**"
  - "src/game/hud.css"
  - "src/game/hud.css.test.ts"
  - "tools/gallery/**"
  - "tools/gl/**"
  - "tools/visual/**"
  - "tools/uvdiff.mjs"
  - "tools/uvdiff.test.ts"
---

# Rendering rules

- Rendering is a one-way projection of simulation state and events. Never make simulation
  outcomes depend on scene objects, interpolation, frame delta, or browser timing.
- The render animation clock advances in every state except `paused`. It remains outside
  `src/sim/`.
- Tank UV mapping is intentionally part-specific: hull projection/unrolled skirt, untouched
  turret lathe wrap, barrel density correction and underside seam, with a deliberate
  stripes exception. Do not generalize one part's mapping across all three.
- Camo and clouds intentionally use different shape languages. Do not restore the rejected
  `cumulus` generator without new visual evidence.
- Use `npm run gallery` for authored comparisons and `--sweep` for constants; it refuses
  dirty target files and restores patches in a finally block.
- A green Vitest run is not the render gate. Run `npm run verify:visual` with its documented
  browser prerequisites, and attach evidence for visible changes.
- `renderer.ts` and `scene.ts` are covered through the real-browser GL harness rather than
  sibling Vitest files.

Search `docs/agent/architecture.md` for the exact render mechanism and its rejected
alternatives before modifying it.
