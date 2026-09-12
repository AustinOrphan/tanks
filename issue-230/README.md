# Issue #230 — telling an arrival apart from a destruction

The issue's complaint is that spawn and death "are easy to miss and hard to tell apart at
normal speed". The reason is concrete and measurable: **every shipped entrance grows its ring
outward, and so does the death pulse.** Two events, one vocabulary.

| animator | shipped entrance ring | shipped death ring |
| --- | --- | --- |
| `warp` | radius 0.4 → 2.0, opacity 1 → 0 | radius ×1 → ×3.4, opacity 1 → 0 |
| `rise` | radius 0.9 + 0.3·sin(pπ) (a bump), opacity 0.6 → 0 | — |
| `beacon` | radius 0.5 → 1.7, opacity 1 → 0 | — |

`?dev=1&arrival=opposed` gives the two events opposite vocabularies.

## Captured with

```sh
npm run gallery -- --scene respawn   --anim --subdiv 1 --fps 60 --view close [--arrival opposed]
npm run gallery -- --scene destroyed --anim --subdiv 1 --fps 60 --view game  [--arrival opposed]
```

`--subdiv 1 --fps 60` plays back within ~1% of real time, so these are the clips at **the speed
the complaint lives at**, not a slowed-down flattering view. Shipped is on the LEFT of each gif.

## Converge — the arrival gathers

![converge](converge-vs-shipped.gif)

`converge-frames-shipped.png` / `converge-frames-opposed.png` are the same five frames as stills.

Shipped starts small and bright at the tank, expands outward and dims. Opposed starts **wide and
dim** (radius 2.4) and **closes onto the tank** (radius 1.0 — the tank's own footprint, not
through it) while **brightening**, so the brightest frame is the one the entrance lands on.

Applied to all three animators, not one: the player picks a spawn *style*, but
arrival-versus-destruction is a property of the *event*, and a language that held only for `warp`
would leave `rise` and `beacon` still reading like deaths.

## Detonate — the destruction blasts

![detonate](detonate-vs-shipped.gif)

Three changes, all envelope, no new geometry:

| | shipped | `opposed` |
| --- | --- | --- |
| growth | linear `k` | ease-out `1 − (1−k)³` |
| scale at ⅓ of life | ×1.80 | **×2.69** — most of the travel is already spent |
| opacity | `1 − k` from frame one | holds at **1.0 for the first 0.108s**, then falls |
| band width | 0.12 world units | **0.384** (×3.2), grown inward from the same outer radius |

The attack hold is what the eye reads as an impact rather than a departure, and the fat band is
what still separates the two events **at speed** — direction alone reads in a still frame and
much less well in motion, which is exactly where the issue's complaint sits.

## What this does NOT cover

#230 is wider than this arm, and the rest is untouched:

- The **entrance → invincibility discontinuity** the issue describes is still present. `warp`
  and `rise` end their entrance at `tankOpacity: 1` and open the invincible phase at
  `0.45 + 0.55·p` = **0.45** — a one-frame drop, exactly as reported. `beacon` stays at 1.0
  throughout, so it reads as fully vulnerable.
- The **life/stock decrement cue** (coordinated with #324).
- Retuning the **shipped** defaults. This ships as a flag so the language can be judged in play
  first; nothing changes for a player who does not set it.
