---
status: completed
date: 2026-07-31
last-reviewed: 2026-08-23
scope: Renderer refit-in-place design letting arenas use different board sizes without rebuilding the GL renderer or scene graph.
implementation-issues: []
implementation-prs: [53]
supersedes: []
superseded-by: []
---
# Renderer refit: arenas stop being locked to one board size

The standing constraint (maps pass 1, 2026-07-31): the renderer sizes its ground
plane, camera fit, lights, shadow camera and texture tiling ONCE at construction, so
every arena in `ARENAS` had to match `ARENA_01`'s 11x9 -- enforced by an
arena-validation test that says, verbatim, "DELETE this test when per-level renderer
refit lands". This is that landing.

## Design

- **Refit in place, never rebuild.** `SceneContext.refit(w, h, boundary)` mutates
  everything dimensional: ground geometry swapped (old disposed), arena-centre
  targets and light positions moved, shadow camera extents and far re-derived,
  felt tiling adjusted via `texture.repeat` (entities borrows the same TextureSet,
  so the texture object must survive), camera re-fit at the last viewport size.
  Rebuilding the renderer instead would tear down the GL context, the input
  mapping closure and the entity views for what is arithmetic.
- **`Renderer3D.refit(w, h, boundary)`** delegates and updates `screenToGround`'s
  fallback centre.
- **`LevelSystem.bounds(level)`** exposes `{width, height, cellSize}` (sandbox:
  ARENA_01's). `arenaBounds` stays the one source; walls are deliberately not
  measurable (boundary ring overhangs).
- **loop.ts** tracks the current bounds and refits only when a rebuild lands on a
  different board -- respawn-restarts on the same level must not reallocate
  geometry every click.
- The fixed-dimensions validation test is deleted, per its own instruction.

## Testing

The refit itself is GL-bound: pinned in tools/gl/harness.ts (real browser) -- ground
geometry matches the new framed bounds, screenToGround maps the canvas centre to the
NEW arena centre, both directions of a size change. Wiring pinned in loop.test.ts
(refit called with the new bounds on a cross-size switch, NOT called for a same-size
rebuild). bounds() pinned in levels.test.ts.

## Out of scope

Shipping a differently-sized arena (level design is a separate decision), camera
transitions/animation between sizes (instant; it happens behind panels), scrolling
cameras.
