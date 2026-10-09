# Issue #1035 evidence: the Map row at two and three players

The Versus Setup Map row, FFA, opened from the main menu with the player count clicked. DPR 1,
viewport 1280x1600 (tall, so the whole row is on screen), reduced motion. Production builds
served by `vite preview`, Chromium with swiftshader; element screenshots of `.hud-versus-map-row`.

- `*-before.png`: PR #1043's head (`feat/second-four-player-versus-board`, `974789e1`), the tree
  this change stacks on.
- `*-after.png`: branch `feat/offer-dedicated-boards-at-lower-counts`.

| file | cards |
| --- | --- |
| `map-row-2p-before.png` | 7: arena-01..05, vs-duel-01, Random |
| `map-row-2p-after.png` | 9: arena-01..05, vs-duel-01, **vs-tri-01, vs-quad-01**, Random |
| `map-row-3p-before.png` | 7: arena-01..05, vs-tri-01, Random |
| `map-row-3p-after.png` | 8: arena-01..05, vs-tri-01, **vs-quad-01**, Random |
