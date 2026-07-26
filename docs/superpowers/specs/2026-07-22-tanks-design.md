# Design: *Tanks!* Spiritual Successor — Vertical Slice

**Date:** 2026-07-22
**Status:** Approved design, pre-implementation
**Scope:** Playable vertical slice (one polished arena that nails the core feel), on the web with Three.js.

---

## 1. Target feel (the north star)

Toy tanks battling on a **felt/wood tabletop diorama**. A single fixed, slightly-tilted
camera shows the whole arena at once. Chunky primary-color tanks, soft shadows, the
satisfying *thunk* of ricochets. The core tension is **one shot kills anything** — you,
and every enemy. That single rule makes every bullet on screen matter, and the ricochets
mean danger arrives from angles you didn't expect.

We are recreating that *specific* tension — Wii Play *Tanks!* — not building a generic
top-down shooter. Every decision below serves that feel.

---

## 2. Tech stack & project structure

- **TypeScript + Vite** — dev server, HMR, production build.
- **Three.js** — rendering only.
- **Howler.js** — audio playback (pooling/overlap for many simultaneous SFX; swappable).
- **Vitest** — unit tests for the pure simulation core.

Hard split between a **pure simulation core** (no Three.js, no DOM, no audio) and the
**render / IO layers**:

```
src/
  sim/            # PURE, deterministic, unit-tested — no Three.js, no DOM, no audio
    world.ts        # entity state + fixed-timestep step(world, inputs) -> {world, events}
    collision.ts    # circle-vs-AABB, swept ray-vs-AABB reflection
    bullets.ts      # shell movement, bounce cap, concurrent cap
    mines.ts        # arming, timer/proximity detonation, blast radius
    ai/             # enemy behavior — pure decision functions
      brown.ts
      grey.ts
      teal.ts
      targeting.ts  # aim-lead + bank-shot geometry
    events.ts       # SimEvent types emitted by step()
    constants.ts    # ALL tunable numbers in one place
    types.ts
  render/         # Three.js scene, meshes, camera, interpolation, particles
  audio/          # Howler wiring; maps SimEvents -> sounds; music; mute/volume
  input/          # keyboard + mouse -> InputState
  game/           # state machine (title/playing/win/lose), HUD, main loop wiring
  main.ts
public/
  audio/          # committed royalty-free SFX + music assets
CREDITS.md        # attribution for any non-CC0 assets
```

The `sim/` layer *is* the game's logic and runs headless under Vitest. `render/` and
`audio/` are "dumb" projections of sim state and sim events.

---

## 3. Simulation model

- **Fixed timestep** (60 Hz) accumulator loop, decoupled from render framerate.
- Render **interpolates** between the two most recent sim states for smoothness.
- Fixed ticks make the sim **deterministic** (clean Vitest assertions) *and*
  framerate-independent (same feel at 144 Hz or 30 Hz).
- `step(world, inputs)` returns both the next `world` and a list of **`SimEvent`s**
  (`fire`, `ricochet`, `explosion`, `mine-armed`, `mine-detonate`, `tank-destroyed`,
  `wall-destroyed`, `win`, `lose`). Render consumes events for particles/juice; audio
  consumes them for SFX. The core never imports render or audio.

---

## 4. Core mechanics & rules

Integers below are **starting defaults to tune against playtest**, not sacred. The
*structure* (that caps and bounce-limits exist) is the point; exact numbers are verified
live and all live in `sim/constants.ts`.

| Rule | Default | Why it matters |
|---|---|---|
| **One-hit death** (player & enemies) | — | The entire tension model. |
| **Concurrent shell cap** (player) | 5 on screen | Forces aim discipline; no spamming. |
| **Bounce cap** (normal shell) | 1 bounce, dies on next wall hit | Ricochet is a tool *with a limit*. |
| **Mine cap** (player) | 2 active | Mines are a resource, not a carpet. |
| **Mine detonation** | ~3s timer OR proximity trigger | Area denial and self-danger. |
| **Mine blast** | radius kills any tank + destructible walls | Reshapes the arena. |
| **Lives** | 3, restart arena on death | Light for the slice; full mission flow is campaign-era. |

**Bullet types** (difficulty scales via *which enemies fire what*, not just enemy count):

- **Normal** — moderate speed, **1 bounce**. Player + most enemies.
- **Fast / rocket** — high speed, **no bounce**. Punishes standing still; hard to dodge.
- **Ricochet shell** — **2–3 bounces**. Turns the whole arena into a threat.

**Walls** — two kinds:

- **Solid** — indestructible; bounces bullets.
- **Destructible** ("cork"/blocks) — bounces bullets, but destroyed by mine blasts, so
  mines can open new lines of fire.

---

## 5. Physics & collision

Two decisions are baked in from day one because retrofitting them is painful:

- **Tanks:** circle-vs-AABB against walls; circle-vs-circle separation between tanks.
  Simple and snappy — arcade movement, not simulation.
- **Bullets use swept collision, not per-frame point checks.** Each tick, raycast the
  bullet's movement *segment* against walls, find the hit point, and **reflect the
  remaining travel within the same tick**, decrementing the bounce count. This prevents
  fast shells from tunneling through walls and makes ricochet reflection fall out
  naturally at any speed. **Corner hits** (reflect on both axes) are the tricky edge case
  and get explicit unit tests.

---

## 6. Controls

- **WASD / arrows** — drive; the tank body faces its movement direction.
- **Mouse** — turret aims at the cursor, independent of body facing.
- **Left-click** — fire (respects the shell cap).
- **Space / right-click** — drop a mine (respects the mine cap).
- **M** — mute toggle; a volume control lives in the HUD/pause.
- Gamepad (twin-stick) is **out of scope for the slice** — designed-around, added later.

---

## 7. Enemy AI (first-class system — the make-or-break)

The riskiest, most feel-critical component: mediocre AI is exactly what reads as "not
*Tanks!*". It gets its own **pure, testable decision layer** — a state machine
(**Idle → Aim → Fire → Reposition**) with a **danger-avoid** behavior that overrides when
an incoming bullet or nearby mine is detected.

Slice roster of **three**, echoing the originals, built in ascending risk order:

1. **Brown — Stationary Gunner.** Does not move. Rotates turret, leads the target
   slightly, fires normal shells. The gentle intro. *(Low risk.)*
2. **Grey — Roamer.** Wanders/patrols open space, straight normal shots, actively dodges
   incoming bullets and avoids its own mines. *(Medium risk — movement + avoidance.)*
3. **Teal — Bank-Shooter.** Mobile, and the signature "aha": aims **ricochet bank shots**
   off a wall to hit the player around cover. This is what makes the ricochet identity cut
   *both* ways — the whole reason to build this and not a generic shooter. *(High risk;
   built last.)*

**Bank-shot geometry** (Teal's targeting) is a pure function: mirror the target across
candidate wall planes, test line-of-sight from the muzzle to each mirror image, pick a
valid bounced path, fire along it. Unit-tested against known geometries. **Committed
decision:** Teal ships in the slice with real bank-shots (no rocket-shooter fallback).

---

## 8. Arena & content (the slice)

One hand-designed arena: outer walls plus a mix of solid and destructible interior blocks
forming lanes and deliberate bank-shot opportunities. Player spawns on one side; a small
set of enemies (a Brown, a Grey, a Teal) on the other. **Clear all enemies = win; lose all
lives = lose;** both offer instant restart.

The arena is defined as **plain data** (a grid / JSON tile map), which quietly sets up
many levels and a level editor later without committing to them now.

---

## 9. Camera & visuals

Fixed camera, slight tilt (perspective, angled down ~45–55°) framing the entire arena — no
scrolling. Soft shadows from a single directional light, matte "felt" ground, chunky
low-poly tanks in flat primary colors. Built from Three.js primitives
(boxes/cylinders) — **no external 3D art assets** for the slice. Visual is cheap to iterate,
so it stays deliberately under-specified and gets tuned live.

---

## 10. Audio

Audio is an **output concern driven by `SimEvent`s**, so the sim stays pure and audio is
fully decoupled. `audio/` maps events → sounds via Howler.js (pooling handles many
overlapping pings).

**Vibe brief:** playful, ever-so-slightly military, but mostly childish, imaginative, and
fun — never distracting, irritating, or annoying. Toy-war-on-the-living-room-floor.

**SFX (from `SimEvent`s):** cannon fire, shell ricochet *ping* (pitch varied per bounce for
juice), tank explosion, mine drop, mine arm/beep, mine detonation, enemy fire (subtly
distinct), plus short **victory** and **defeat** stings. Optional subtle engine rumble on
movement if it doesn't get annoying.

**Music:** one looping background track matching the vibe, at a low, non-intrusive level,
with a mute toggle (**M**) and volume control. Ducking optional.

**Sourcing & licensing:** prefer **CC0 / public domain** (no attribution) — e.g. Kenney.nl
game-audio packs, freesound.org filtered to CC0. For music, a CC0 or CC-BY playful/quirky
loop. All assets are committed under `public/audio/`; any attribution-required asset is
recorded in `CREDITS.md`. (No AI-generated or unlicensed audio.)

---

## 11. Game states & HUD

Minimal state machine: **Title → Playing → Win / Lose → (restart)**. HUD shows **lives**
and **enemies remaining**, plus mute/volume. Clean and toy-like — no clutter.

---

## 12. Testing strategy

- **Unit-tested (Vitest), pure `sim/`:** ricochet reflection incl. corner double-reflect;
  bounce-cap expiry; swept collision vs. tunneling at high speed; shell/mine caps; mine
  blast radius; one-hit resolution; and AI decision functions (aim-lead math, bank-shot
  targeting, danger-avoid triggering).
- **Manual / playtest:** feel, camera framing, audio balance, and tuning the integers in
  `constants.ts`.
- **TDD where it pays:** physics/ricochet math and AI targeting are pure functions with
  clear right answers — write tests first there. Render/audio wiring is validated by hand.

---

## 13. Explicitly out of scope for the slice (YAGNI)

Full 20-mission campaign & progression, local co-op, level editor UI, gamepad support,
online anything, and menus beyond title/win/lose. The data-driven arena and event-driven
audio keep the door open for these without building them now.

---

## Locked decisions

1. **Platform:** Web, Three.js (rendering only).
2. **First milestone:** Playable vertical slice — one arena that nails the feel.
3. **Controls:** WASD drive + mouse aim; left-click fire; Space/right-click mine.
4. **Architecture:** Vanilla Three.js + hand-rolled 2D arcade physics; pure, deterministic,
   unit-tested sim core; TypeScript + Vite + Vitest.
5. **Enemy #3 (Teal):** real bank-shot ricochet AI in the slice (no fallback).
6. **Audio:** light SFX pass + one looping background-music track; royalty-free (CC0
   preferred); playful/childish/faintly-military vibe; mute + volume.
