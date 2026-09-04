# Menu transition treatments (issue #542, PR pending)

Four arms behind `?dev=1&menuTransition=<id>`, same navigation each time
(Main Menu -> Settings), captured from the production build in Chromium.

| file | what it is |
| --- | --- |
| `all-four-slow6x.gif` | **start here** — all four at once, 6x slow, labelled |
| `all-four-slow6x.mp4` | the same, as video |
| `all-four-real-speed.mp4` | the same at real speed, which is how you'd actually see it |
| `<arm>-slow6x.mp4` | each arm full size |
| `filmstrip-<arm>.png` | eight consecutive frames from the click onward |

## What each arm is

- **`fade`** — today. 150ms, opacity only. The control: it adds no class and no CSS rule
  at all, so it *is* the shipped cascade rather than a copy of it.
- **`fade-long`** — 300ms, opacity only. Exactly double, because this arm has to answer
  "is duration the whole problem?" and a value inside the same 120–180ms budget could not.
- **`rise`** — 16px upward on the entering content, at the control's own 150ms.
- **`settle`** — scale 0.94 → 1 on the entering content, also at 150ms.

`rise` and `settle` keep the control's duration on purpose. `fade-long` owns the duration
variable; an arm that moved *and* slowed could not tell you which half to thank.

## Why those amounts

Not guessed. The same navigation was captured at 4, 6, 10, 16 and 24px, each screenshotted
at a fixed *fraction* of the animation. Residual offsets at the quarter mark — where the
arriving content first becomes legible — measured 1.7, 2.4, 4.2, 6.8 and 9.4px. At 4px the
content is already at rest before it can be read, which is the exact complaint this issue
exists to answer; at 24px it visibly slides in from off-position.

`settle`'s 0.94 is matched to `rise` by *amplitude* rather than chosen independently, so
the two differ in the kind of movement and not the amount: the widest block is 449px, so
0.94 starts each vertical edge 13.5px out, nearest to `rise`'s 16px.

One caveat stated rather than left to be discovered: because each child scales about its
own centre, `settle`'s blocks gain size without gaining separation.

## The ruling

Which arm ships is the owner's call. The winner ships unconditionally and the flag is
retired — the pattern #526 and #536 established. `fade` winning is a legitimate outcome:
it would mean the current transition is right and only its invisibility was the complaint.
