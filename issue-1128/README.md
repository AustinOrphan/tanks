# Issue #1128 evidence: each player's shape in Teams

Captured 2026-10-31 with `tools/screens/record.mjs --flow versus-round --level 1 --seed 1
--driver autoplay --mode teams --players 4 --seconds 3 --stop window --fps 2 --dpr 1
--visual host-gpu`, at 1280x800 and 390x844, the last of each run's six frames. Classic palette,
teams A, B, A, B.

- BEFORE (left of each image): a build of origin/main 4b9d1c5c (which already has #1127's hull
  shades). Solid team-colored rings; the strip draws pips: `P1 A ●●● P2 B ●●● P3 A ●●● P4 B ●●●`.
- AFTER (right): branch feat/teams-player-shapes. Each ring is its own player's shape in its
  team's color (P1 circle and P3 square in team A's red, P2 triangle and P4 starburst in team
  B's pink); the strip draws `P1 A ●●● P2 B ▲▲▲ P3 A ■■■ P4 B ✶✶✶`.
- `teams-4p-phone-strip-zoom.png`: the 390px strip, enlarged; it fits, the last starburst whole.
