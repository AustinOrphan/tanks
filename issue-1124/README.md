# Issue #1124 evidence: versus hulls in a darker shade of each identity color

Captured 2026-10-31 with `tools/screens/record.mjs --flow versus-round --level 1 --seed 1
--driver autoplay --mode <ffa|teams> --players 4 --seconds 3 --stop window --fps 2 --w 1280
--h 800 --dpr 1 --visual host-gpu`, the last of each run's six frames. Classic palette.

- BEFORE (left of each image): a build of origin/main 20562782. P2, P3 and P4 share the
  magenta placeholder `#c23b8f`.
- AFTER (right): branch feat/versus-hull-identity-shades at e35de1f6. P2 burnt orange
  `#9a5000`, P3 crimson `#8a1618`, P4 deep purple `#580c80`, each under its own ring and
  marker; P1 unchanged.
- `ffa-before-after.png`: four-player FFA, slot rings and shape markers.
- `teams-before-after.png`: four-player Teams (2v2), team rings around the same hulls.

High contrast was not captured: the recorder cannot preset the stored Player colors setting.
Its shades are pinned and measured in `src/render/entities.test.ts`'s versus hull sweep.
