# Issue #629 — the column-header regression, and its fix

Captures of `screen.records.stats` at 1280x800 @2dpr, cropped to the stats table.

| file | state |
| --- | --- |
| `records-before.png` | `main` — column names right-flush over their numerals |
| `records-regression.png` | first attempt — `<th scope="col">` inherited the ROW-header rule and the names fell out of alignment |
| `records-fixed.png` | shipped — **pixel-identical to `main`**, verified with an image diff, not by eye |

The middle frame is the point of this folder. Making the column headers real `<th scope="col">`
was the correct fix — as `<td>` they headed nothing and every figure beneath them was
announced bare — but each table already carried a `th` rule written for its **row** headers
(left-flush, heavier, dimmed), and a column header picked it up.

Every gate passed on the broken middle frame: the unit suite, the full mutation sweep, and
`verify:visual` — which photographs the arena and never opens Records. It was caught only by
diffing before against after. The PR adds a computed-style assertion and a mutation entry so
the next one fails in CI instead.
