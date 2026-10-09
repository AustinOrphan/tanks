# Issue #1031 evidence: the UI scale reaches all text

Settings and Records at UI scale 150, 1280x800, reduced motion, seeded with the mid-campaign
save the screen states use plus `tanks.settings.v1 = {version: 1, presentation: {uiScale: 150}}`.
Production builds served by `vite preview`, Chromium with swiftshader.

- `*-before.png`: `main` at `1e110d34`.
- `*-after.png`: branch `fix/ui-scale-reaches-all-text`.

Before, at 150% the pane titles, the Records table, the Settings hints and the About lines
stayed at the page's 16px base while the controls around them grew. After, every text element
measured on six surfaces scales by exactly 1.5.
