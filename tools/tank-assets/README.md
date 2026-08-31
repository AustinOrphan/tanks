# Canonical tank reference bundle

The authoritative external representation of the **in-game tank** (issue #385) — the
starting point for logo, branding, documentation and merchandise work.

```
npm run tank-assets                 # writes to assets/tank/
npm run tank-assets -- --out DIR    # somewhere else
```

## What is authoritative

**The generator is authoritative, not its output.** `assets/tank/` is regenerated on demand
and nothing in CI writes it; if a committed bundle and a fresh run disagree, the fresh run
is right. The tank's shape is defined in exactly one place —
[`src/render/tank-model.ts`](../../src/render/tank-model.ts) — and both the live renderer
and this exporter build from it.

| File | What it is |
| --- | --- |
| `tank.glb` / `tank.gltf` | The tank in the shipped player blue (`#3d7bd6`). GLB for Blender and most DCC tools; the `.gltf` is the same scene as readable JSON. |
| `tank-mono.glb` / `tank-mono.gltf` | One flat colour across every part, for tracing a silhouette. |
| `tank.json` | Metadata: the resolved source revision, the 26 geometry parameters, and every part with its transform and vertex count. |

## Why it imports the game's own module

The problem this exists to solve is drift. Logo exploration kept starting from screenshots,
and a traced silhouette stops matching the game the moment anyone retunes a proportion —
which is discovered by whoever is holding the wrong model, usually late.

So the generator runs under **`vite-node`**, which is what lets a Node tool import
`src/render/tank-model.ts` directly. There is no second copy of the dimensions here. Every
number describing the tank comes from the model; everything this file decides is
presentation — colour, file layout, metadata.

`entities.ts` consumes the same module, and takes **positions as well as geometry** from it.
Sharing only the shapes would leave two copies of where each part sits, and where the parts
sit is half of what a canonical model is.

## The drift guard, and what it actually proves

`src/render/tank-model.test.ts` compares the **live scene graph** against the model — not
the model against itself, which could not fail, since `makeTank` calls `tankParts()`.

The risk is at the consumer: a position written out longhand in `makeTank` looks harmless
and keeps every existing render test green. Measured, with the tracks moved from the model's
±0.375 to ±0.3:

```
src/render/entities.test.ts   90 passed (90)   <-- blind
src/render/tank-model.test.ts  1 failed (7)    <-- names it
```

That gap is the coverage. It is pinned by the manifest entry
`tank-track-position-drifts-from-the-model`.

## Reference renders

The canonical camera angles live in the **gallery**, not here — the issue's boundary asks
for reuse rather than a competing screenshot system, and framing, distance-from-span and
the deterministic clock are already solved there.

```
npm run gallery -- --elements tank --view quarter
```

`top`, `headon`, `behind`, `game`, `low` and `close` predate this work; `side`, `quarter`
and `quarter-rear` were added for it (`tools/gallery/subjects.ts`, `VIEWS`).

## Known gaps

Stated rather than left to be discovered:

- **Gallery renders are not transparent.** They carry the arena's ground plane, so they are
  useful as reference but not as drop-in artwork. Transparent-background output would be a
  gallery change, not a change here.
- **No monochrome *render* variant.** `tank-mono.glb` is the monochrome **model**; the
  silhouette render a logo traced from would still be produced by hand from it.
- **No turret-off-axis pose.** The exported turret is a separate node positioned at
  `TURRET_GROUP_Y`, so it can be rotated in any DCC tool, but no posed render ships.
- **`GLTFExporter` needs a `FileReader` shim** (`generate.mjs`), because Node has no such
  global. It registers `onloadend`, *not* `onload` — a shim providing only the latter leaves
  the export promise pending forever with no error.
