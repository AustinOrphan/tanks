---
status: completed
date: 2026-08-18
last-reviewed: 2026-08-23
scope: Identity-coloured render-layer spawn entrance and death pulse, keyed to player slot colour, driven from the world diff.
implementation-issues: [199, 200]
implementation-prs: [203, 205]
supersedes: []
superseded-by: []
---
# Spec — identity spawn & death animations

Status: approved 2026-08-18. Design phase; implementation plan to follow (`writing-plans`).

Provenance: a design ruling in the versus arc — respawns should place tanks with "some
kind of spawn animation" and a "brief period of invincibility... only movement", and it
"might be good to have a few available so they can be customized later." Extended in the
same conversation: player deaths should trigger a death pulse "colored to the player's ring
color", the death form should be "both" (a world ring plus a recolored screen vignette),
and whether *enemy* deaths also pulse is undecided and should be "flaggable for now".

The unifying idea: **a tank's spawn and death are one visual language, keyed to its player
identity colour.** A player warps in inside a ring in their colour and, when destroyed,
leaves a shockwave in the same colour. In a 2–4 player game this is how you read *who* just
spawned or died and *where*.

This is a pure **render-layer projection**. It touches nothing under `src/sim/`, so the
golden trace `BASELINE_HASH` cannot move — a hard constraint, restated in each section that
might tempt a sim edit.

---

## 1. What the sim already provides (read, never written)

All facts verified on `main` at `f4fad62`:

- **`Tank.shieldUntilTick?: number`** (`src/sim/types.ts:155`) — the post-respawn window:
  the absolute `world.tick` until which the tank is damage-immune *and* fire/mine-locked,
  while movement and aim stay free. Stamped at revival as `world.tick +
  RESPAWN_SHIELD_TICKS` in `stepRespawns` (`src/sim/world.ts`).
- **`RESPAWN_SHIELD_TICKS = 90`** (`src/sim/constants.ts:160`) — 1.5s at `TICK_HZ = 60`.
  Time-left is `shieldUntilTick − world.tick`; seconds-left is that `/ TICK_HZ`.
- **`respawn` SimEvent** `{ type: 'respawn'; tankId; controlledBy; pos }`
  (`src/sim/events.ts`) — fired on revival. Carries *where* and *whose*, but **no tick and
  no duration**, so the ongoing shield visual cannot be driven by the event alone.
- **`tank-destroyed` SimEvent** `{ …; pos }` — fired on death; carries position but **not**
  `controlledBy`.
- **`IDENTITY_RING_COLORS = [0x3fd0ff, 0xff8a1e, 0xff4d2e, 0x9d3bff]`**
  (`src/render/entities.ts:75`), indexed by `Tank.controlledBy` (slot); `TEAM_COLORS`
  (`src/render/entities.ts`) in teams mode. This is the identity colour both animations key
  to, and the colour of the existing per-player identity ring.

**Consequence that shapes the architecture:** neither event carries what these animations
need (the shield duration; the dying tank's slot colour). Rather than widen the events —
which would force a six-consumer sweep and reach toward `src/sim/` — the render layer reads
what it needs from the `prev`/`curr` world diff it already has, where `shieldUntilTick` and
`controlledBy` are both present. **The events stay unchanged.**

## 2. Architecture — tank-attached, world-diff-driven

`entities.sync(prev, curr, alpha, dt)` (`src/render/entities.ts`) already diffs two worlds
each frame, owns the per-tank view map, and advances wall-clock cosmetics on `dt` (the
render animation clock, gated on not-`paused`; see CLAUDE.md "render animation clock"). It
is the natural home. Both animations are triggered by **edges in that diff** and advanced
by that `dt`:

- **dead→alive** for a given tank id → a spawn entrance begins.
- **alive→dead** (or a live tank id vanishing from `curr.tanks`) → a death pulse begins.
- **`roundStartTick` changed** → a spawn entrance for every alive tank at once.

`entities.ts` is the **trigger hub** only; the visual logic lives in two focused sibling
modules so `entities.ts` — already large — grows by wiring, not content:

- `src/render/spawn-anim.ts` — the spawn variant registry and animators (tank-attached).
- `src/render/death-pulse.ts` — the death shockwave (a detached, pooled one-shot).

A shared, tiny ring-mesh helper serves both (a flat additive ring, the same family as the
existing identity ring and blast-fade meshes, which set `transparent`/`opacity`/
`AdditiveBlending` per instance — so per-tank opacity is already an established pattern).

**Rejected alternatives** (recorded so they are not re-proposed):

- *Particle/event-driven* (extend the existing cyan respawn burst in `particles.ts`):
  cannot serve round-start (no `respawn` event fires there), cannot make the *tank*
  translucent (particles are separate meshes), and cannot track the ongoing shield (the
  event carries no duration). Structurally unable to meet the requirements.
- *Hybrid* (entrance via particles, invincibility via entities): splits one variant's look
  across two files and two triggers for no gain.

## 3. The two spawn phases

A respawn plays **entrance → invincibility → solid**; a round-start spawn plays
**entrance → solid** (the countdown is the round's protection, so no indicator is needed
there, and no shield exists to drive one).

- **Entrance** — fixed ~0.5s, render-side duration (round start has no shield to borrow a
  length from, and a consistent entrance length across both triggers is the point). The
  "materialize": ring + fade/scale-in.
- **Invincibility** — respawn only, its length read **live** from `shieldUntilTick`
  (`shieldUntilTick − world.tick`, re-read each frame). Reading live rather than latching a
  copy keeps it exact under pause and immune to any future retuning of
  `RESPAWN_SHIELD_TICKS`.

## 4. The three spawn variants (one skeleton, identity-coloured)

Each variant is the same skeleton — a ring plus a tank treatment — differing in style, and
each variant's ring is drawn in the tank's identity colour so spawn and death match:

| Variant | Entrance | Invincibility |
|---|---|---|
| **Warp** *(live default)* | ring expands outward; tank fades in translucent inside it | tank stays semi-transparent, solidifying as the shield expires |
| **Rise** | tank scales up from the ground plane; a ground ring pulses | tank translucent; ring pulse-rate tracks time-left |
| **Beacon** | a vertical light column; tank materialises **opaque** | **ring-as-timer**: an arc depletes over the shield window (the "if translucency doesn't read well" path, kept as a real, shippable option) |

Each animator is a **pure function of `(phase, progress ∈ [0,1], identityColor)`** →
`{ tankOpacity, tankScale, ring: { radius, opacity, arc } }`. Purity is deliberate: it
makes every visual claim a unit assertion that can fail (exact opacity at progress
0 / 0.5 / 1), with the untouched-tank state as the negative control.

## 5. The death pulse (companion, not a variant set)

One fixed effect — the mirror of the spawn ring, in vs out:

- **World ring** — on the alive→dead edge, a detached self-expiring shockwave at the death
  position, in the dying tank's identity colour. Detached (in `death-pulse.ts`, pooled)
  because the tank's own view is hidden once dead, so the ring must outlive it.
- **Screen vignette recolour** — `signalPlayerDeath()` (`src/game/hud.ts`) gains a colour
  parameter and tints the current red vignette to the dying player's identity colour.
  **Single-player keeps the classic red** (red = damage is a strong convention) — but as an
  **adjustable named constant** (e.g. `SINGLE_PLAYER_DEATH_VIGNETTE`), not a baked-in
  literal, so changing that decision later is a one-constant edit. This follows the repo's
  "numbers that are feel, not measurement" convention: the constant is chosen by eye and the
  tests assert *against the constant*, not against a hardcoded red, so retuning it does not
  rewrite tests.

Colour is resolved render-side from `controlledBy`, so `tank-destroyed` is **not** widened
and its consumers are not swept.

## 6. Scope, and the dev flag for the undecided half

- **Player death pulse ships** — decided. Every player-controlled tank's death fires the
  world ring (and the primary player's fires the vignette).
- **Enemy death pulse is undecided → dev flag `enemyDeathPulse`**, added to `DevFlags` and
  `FLAG_REGISTRY` (`src/game/devflags.ts`), **off by default** (players-only), reachable at
  `?dev=1&enemyDeathPulse=1` for playtesting. Per the dev-flags doctrine: it is temporary
  (ends up shipped-with-flag-deleted or deleted outright), it is **render-layer only** so it
  never reaches `src/sim/`, and `docs/dev-flags.md` is regenerated by `npm run devflags:doc`
  so `tools/devflags/doc.test.ts` stays green. When off, enemies keep their current
  destruction effect unchanged.

The three spawn *variants* are **not** flagged: they are shipped render data. Only the
default (Warp) is live in gameplay today because no picker UI exists yet — but all three are
unit-tested and renderable in the gallery (§8), so none is dead code, and making them
user-selectable later is data wiring, not new machinery.

## 7. Customization seam (mirrors skins)

The "customizable later" requirement is served by copying the skins pattern exactly:

- **Data** — `SpawnAnimId` union + frozen `SPAWN_ANIMATIONS: readonly SpawnAnimDef[]` in
  `src/game/customization.ts` (no THREE), the `SkinId` / `SKINS` shape
  (`customization.ts:63,77`). Each def is `{ id, label }` plus any per-variant params.
- **Render** — `SPAWN_ANIMATORS: Record<SpawnAnimId, SpawnAnimator>` in `spawn-anim.ts`,
  the `PAINTERS` shape (`src/render/skins.ts`).
- **Selection** — per slot through the existing `playerStyles`/`controlledBy` plumbing
  (`src/render/entities.ts`), the same path `setPlayerStyle` already uses. A future picker
  UI writes a `SpawnAnimId` per slot into the customization store; that store field and the
  UI are **out of scope here** — this spec ships the registry, the animators, and Warp as
  the default for every slot.

## 8. Testing

- `spawn-anim.test.ts` — each variant's animator asserted at progress 0 / 0.5 / 1 (exact
  opacity, scale, ring radius/arc), each assertion paired with the mutation that breaks it;
  untouched-tank state as the negative control.
- `death-pulse.test.ts` — the ring spawns at the death position in the correct identity
  colour, expires on its own clock, and is a distinct effect from a same-frame spawn ring.
- `entities.test.ts` — the three trigger edges (dead→alive, alive→dead, `roundStartTick`
  change) each start the right animation, de-duplicated (§9); the invincibility phase's
  length tracks `shieldUntilTick`.
- `hud.test.ts` — `signalPlayerDeath(color)` tints the vignette; the classic-red default
  path still holds.
- `tools/devflags/doc.test.ts` — regenerated `docs/dev-flags.md` matches the registry.
- **Feel & exhibition** — the gallery, covered in its own section below, since it is both
  how the look gets tuned and a required deliverable.

## 8a. Gallery: comparisons & exhibition media (a deliverable, not just a check)

The gallery renders these animations through the REAL render modules against a REAL world,
and it already produces stills (PNG), animated **gifs** (ffmpeg: `--anim`/`--frames` for an
element timeline, `--scene game --slowmo --burst N` for real gameplay, `--out clip.gif`,
`--fps`), and directories of raw frames. A new **`--spawn-anim <id>`** arg (mirroring
`--skin`) selects the variant, the same way `--skin`/`--hull`/`--accent` already dress the
tank.

Two distinct outputs are required:

- **Comparisons** — before/after gifs of a respawn: the removed cyan burst (§9) vs the new
  identity ring, and a three-up of Warp / Rise / Beacon at matched timing. These are the
  evidence that replacing the burst is not a regression and that the variants are visibly
  distinct — they go in the PR body (the established practice; PR #139 carried the tile
  render it turned on).
- **Exhibition media** — polished gifs/images of each spawn variant and the death pulse in
  the player identity colours, for showing the feature off. Produced from the same gallery
  recipes at a higher frame count / slow-mo.

**Video (mp4/webm) is not something the gallery does today** — animated output is gif or a
raw-frames directory only (`tools/gallery/args.mjs` refuses a non-`.gif` animated target).
Gifs cover animated exhibition media; if true video is wanted, the small addition is a
`raw-frames → ffmpeg libx264/vp9` step behind an `--out clip.mp4` path, and the plan will
scope it as an explicit, separable task rather than bundling it silently.

**Where the media lives:** comparison and exhibition artifacts attach to the **PR**, not the
repo tree — gifs and (any) videos are heavy binaries and committing them bloats history.
A curated, committed `docs/` media set is a separate decision; if wanted it should be a
short, deliberately chosen few, not every render.

## 9. Migration & one detail to pin

- **The ad-hoc cyan respawn burst in `particles.ts` is removed** — the identity spawn ring
  replaces it, so "what a respawn looks like" has one source of truth. Its stale "coop only"
  comment goes with it. The gallery before/after is the check that the ring is not a
  regression on the burst.
- **To pin in the plan, not assumed here:** whether `roundStartTick` moves on every respawn
  or only per round/level. The trigger set in §2 is robust either way — the dead→alive edge
  and the `roundStartTick` edge are de-duplicated so a respawn that also moves
  `roundStartTick` fires the entrance once — but the plan verifies the actual behaviour so
  the de-dup is provably correct rather than defensively coded.

## 10. Footprint

- **New:** `src/render/spawn-anim.ts` (+ `.test.ts`), `src/render/death-pulse.ts`
  (+ `.test.ts`), a shared ring-mesh helper, `SpawnAnimId`/`SPAWN_ANIMATIONS` in
  `customization.ts`, a `--spawn-anim` gallery arg.
- **Changed:** `src/render/entities.ts` (trigger hub, per-view spawn state, per-tank
  opacity, delegate to animators), `src/render/particles.ts` (remove the cyan burst),
  `src/game/hud.ts` (colour param on `signalPlayerDeath`), `src/game/devflags.ts`
  (`enemyDeathPulse` + registry), `docs/dev-flags.md` (regenerated).
- **Untouched:** all of `src/sim/`. `BASELINE_HASH` cannot move.

## 11. Residuals (deferred, on purpose)

- The spawn-animation **picker UI and its per-slot store field** — the registry ships, the
  chooser does not.
- The **single-player death-vignette colour** — decided (classic red), but kept as an
  adjustable constant so a change of mind is a one-line edit, not a code hunt.
- The **enemy death pulse** — behind `enemyDeathPulse`, to be shipped-or-deleted once
  playtested.
- Death pulse as a **customizable variant set** — one fixed effect for now; it lives in its
  own module so it could gain variants later without disturbing the spawn registry.
- **Gallery mp4/webm output** — gifs cover animated exhibition media today; a
  `raw-frames → ffmpeg libx264` `--out clip.mp4` path is a small separable add if true video
  is wanted, scoped as its own task.
- A **committed `docs/` media gallery** — exhibition artifacts attach to PRs by default;
  a curated in-repo set is a separate call because of binary weight.
