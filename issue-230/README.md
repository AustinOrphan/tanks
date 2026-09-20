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

---

## The persistent stock display: digit against pips (owner direction, 2026-09-15)

> Consider pips as the persistent stock display, not merely an animation during stock loss.
> Compare the numeric display with a pip-based display at actual gameplay scale.

`persistent-display/` is that comparison. Shipped digit against `?dev=1&stockCue=pips`, both
read off a **real played versus match** rather than a posed HUD.

### Captured with

Two-player FFA on `arena-01`, **stock 3** so a loss leaves a partial count, retained setup
seeded through `tanks.dev.tanks.versus.v1`, `?dev=1&replay=1&autoplay=1&seed=7` so autoplay
drives P1 against the bot and the same match plays every run. Each capture waits for the strip
to report a stock loss, then shoots.

**The two arms are captured at the same moment, and the tick count is the evidence:** every
frame below was taken at **1,859–1,861 simulated ticks**, P2 falling from 3 to 2.

| file | strip box | ticks | strip read |
| --- | --- | --- | --- |
| `digit.desktop` | **78×20** | 1860 | `P1 3 \| P2 2` |
| `pips.desktop` | **130×20** | 1860 | `3 of 3 stocks \| 2 of 3 stocks` |
| `digit.phone` | 78×20 | 1861 | `P1 3 \| P2 2` |
| `pips.phone` | 130×20 | 1859 | `3 of 3 stocks \| 2 of 3 stocks` |
| `digit.desktop.forced` | 78×20 | 1860 | `P1 3 \| P2 2` |
| `pips.desktop.forced` | 130×20 | 1860 | `3 of 3 stocks \| 2 of 3 stocks` |

Desktop is 1280×800 at dpr 2; phone is 390×844 at dpr 3; `forced` is `forced-colors: active`
with the dark scheme. `.hud.png` is the top 180px of the viewport — the strip in its topbar —
and `.strip.png` is the strip alone with 6px of margin.

### What the numbers say before the pictures do

- **Pips cost 1.67× the width for the same information**: 130px against 78px, at *both*
  viewports. Height is identical at 20px, so the strip does not grow taller, it grows sideways
  into a topbar that issue #838 has already measured as tight.
- **The phone is not the interesting case at this player count.** #838's table says a
  two-player strip fits at every stock count; overflow starts at three players × five stocks
  and at four players. So the crowded case belongs to #838 and its media, not here.
- **Reduced motion is a no-op for this comparison**, and that is measured rather than assumed:
  the `prefers-reduced-motion: reduce` captures are **byte-identical** to the ordinary ones in
  both arms, which is what a persistent readout should do — nothing here animates. Those files
  are therefore not duplicated into this directory.
- **The pips arm's only text is its accessible name.** `aria-label="2 of 3 stocks"` is what a
  screen reader gets and what these captures were synchronised on; the digit arm's count is in
  the visible text. A comparison that watched `textContent` sees the digit arm change and the
  pips arm never change — which is how the first attempt at this capture silently compared two
  different moments.
