# Issue #425 — Quarters candidate layouts

Top-down diagrams generated directly from each candidate's grid, so what is drawn is exactly what the
gate was run against. One image pixel block = one arena cell, with a faint cell grid so **corridor width
is countable by eye**.

- **grey** solid wall
- **orange** destructible — removed entirely before `evaluateSpawnEgress` runs, so ignore them when
  judging egress
- **yellow** the four spawn cells
- **green** open floor

A tank is 1.5 cells wide, so any corridor a tank must traverse needs at least 2 cells.

| File | Board | Narrowest corridor |
| --- | --- | --- |
| `current-27x17-broken.png` | what ships, withdrawn | sealed — spawns cannot reach each other |
| `rotunda-33x27.png` | recommended primary | 6 cells |
| `pinwheel-27x27.png` | rotational alternative | 3 cells |
| `ringroad-33x23.png` | perimeter alternative | 2 cells |

All three candidates pass the real `evaluateVersusBoard` at N=2, 3 and 4.
