# Issue #657 — versus map cards on a 390px phone

`npm run screens -- --state screen.versus-setup --w 390 --h 844 --dpr 2`

| file | state |
| --- | --- |
| `before-390.png` | the grid at 736px wide, sitting at x=-173 — cards clipped off both edges, content unreachable |
| `after-390.png` | one column, 390px, nothing clipped |

The grid measured 736px at EVERY viewport, 1280 and 390 alike, because its `width: 100%`
resolved against a shrink-to-fit parent and it fell back to max-content, stopping at its own
`max-width: 46rem` — which is exactly 736px.
