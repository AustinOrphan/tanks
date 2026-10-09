# Issue #971 evidence: a locked achievement description dimmed once

Records > Achievements at 1280x800, device scale 2, reduced motion, seeded with
`tanks.achievements.v1 = {"earned": ["first-blood"]}` so the list shows one earned row above the
locked ones. Production builds served by `vite preview`, Chromium.

- `achievements-before.png`: `main` at `1e110d34` -- locked descriptions at an effective 0.36.
- `achievements-after.png`: branch `fix/locked-achievement-dimmed-once` -- locked descriptions at
  the row's 0.45, the same as their labels; the earned row unchanged.

Contrast read from pixels (a Range over the text node, its rect clipped, decoded in Chromium,
background = modal colour, glyph = the colour furthest from it in luminance among colours holding
at least 0.4% of the box). Controls in the same run: rgb(10,20,30) decodes exactly, and white on
black reads 21.00:1.

| text | before | after |
| --- | ---: | ---: |
| locked label | 3.66:1 | 3.66:1 |
| locked description | 2.71:1 | 3.66:1 |
| earned label | 13.99:1 | 13.99:1 |
| earned description | 9.06:1 | 9.06:1 |
