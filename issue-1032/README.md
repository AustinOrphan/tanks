# Issue #1032 evidence: Versus Setup fits at 1920x1080 and up

Versus Setup in its default configuration (FFA, two players, Random), opened from the main menu,
DPR 1, UI scale 100, reduced motion. Production builds served by `vite preview`, Chromium with
swiftshader; viewport screenshots.

- `*-before.png`: `main` at `1e110d34` -- the pane scrolls at all three sizes.
- `*-after.png`: branch `feat/versus-setup-fits-large-viewports` -- the pane fits at 1920x1080 and
  2560x1440; 1280x800 still scrolls, as #985's ruling allows, and is shorter (976 px of content
  against 1,453).
