# Issue #686: a 44 px floor on every menu control

Each image puts the same screen state side by side, before and after.

- **Builds:** before is `main` at `e3d1a7c`; after is branch `fix/menu-hit-targets` at `0418922`.
- **Captured with:** `tools/screens/run.mjs` in Chromium 151 (Playwright 1.62.0, swiftshader), DPR 2, reduced motion.
- **Seeded save:** the screens' mid-campaign save.

Measured by `hitTargetFailures` (`tools/visual/hit-targets.mjs`) over 96 runs. Those runs cover 24 surfaces (the 22 player-facing screen states plus the Controllers pane and Settings with Reset stats armed), each at 320x568, 390x844, 1280x800, and 1280x800 at 200% zoom:

| | before | after |
|---|---|---|
| control readings under 44 CSS px | 764 of 1016 (44 of 54 classes) | 0 of 1016 |
| overlapping controls on one layer | 0 | 0 |
| controls that cannot be scrolled to | 11 | 0 |
| horizontal page overflow | 0 | 0 |

Sizes before the floor, as rendered:
- `--sm` buttons: 27 px tall.
- `--slab` buttons: 31–33 px tall.
- Tertiary "Start New Campaign": 157.9x19.
- Versus player-count button: 39.4 px wide.
- Volume slider: 140x16.

A build with the floor alone raised unreachable controls from 11 to 22. The added 11 were on the Main Menu/pause panel, Records, Customize and Achievements, which did not scroll. Those four panes now scroll with `justify-content: safe center`. Against the floor-only build, 88 of 96 runs keep every control within 0.5 px. All 8 runs that moved are ones whose content overflows the viewport.
