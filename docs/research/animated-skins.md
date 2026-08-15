# Animated skins in Tanks!

**Investigated 2026-08-09, adversarially verified, corrected and re-measured 2026-08-10.**
File/line citations are against commit `3522c0a` (`origin/main`) and were re-opened in that
tree. This document makes **no external claims**, so nothing here needs a source URL — it is
all verifiable from this checkout.

---

## Bottom line

**Animated skins already ship, and the mechanism is essentially free.** `flow` scrolls its
texture offset, driven by per-skin `scroll: {u,v}` data (`src/game/customization.ts:85`) and
applied in `src/render/entities.ts:881-884` from the wall-clock `dt` the driver hands the
renderer. It never touches `src/sim/`, so replay determinism is untouched.

**What it cannot express is anything that is not a rigid 2D transform of a static tile** — no
brightness or emissive pulse, no per-pixel evolution, no colour cycling. Adding more
scrolling patterns is a data-plus-painter edit. Anything richer means introducing this tree's
first `ShaderMaterial`/`onBeforeCompile`, or a per-frame material registry.

**Two real gaps.** The Customize preview passes `dt = 0` (`src/render/preview.ts:296`), so
the one animated skin the game ships is **frozen in the exact panel where a player evaluates
it**. And nothing in `npm test` can construct a WebGL renderer, so a shader-based skin's
compile failure would publish — only `npm run test:gl` could catch it, and the Pages deploy
does not run it.

**A correction that changes the cost of every "just add a skin" item below:** adding one
patterned skin does not cost "six golden hashes and two counts in `skins.test.ts`". Measured
by mutation (below), it costs **7 failing tests across 3 files**, including one in
`src/game/hud.css.test.ts`, which is outside the render subsystem entirely.

---

## The mechanism, verified

### Texture-offset scrolling is the only animation any skin has

`src/render/entities.ts:878-884` — `sync(prev, curr, alpha, dt = 0)` advances
`playerSkinMap.offset.x/y` by `playerScroll.u/v * dt` modulo 1, gated on `dt > 0`;
`RepeatWrapping` makes it cyclic. Per-skin data lives at `src/game/customization.ts:73`
(`scroll?: { u, v }`) and only **one** entry carries one — `:85`,
`{ id: 'flow', label: 'Flow', scroll: { u: 0.08, v: 0 } }`. `grep -n scroll
src/game/customization.ts` returns exactly those two lines.

Exclusivity is genuinely pinned: `src/game/customization.test.ts:108` is
`for (const s of SKINS.filter((x) => x.id !== 'flow')) expect(s.scroll).toBeUndefined();`

### The animation clock is wall-clock, and it is replay-safe

`src/game/driver.ts:87` computes `plan.dt` from the rAF timestamp via `planFrame` (clamped to
`MAX_FRAME_DT = 0.25`, `src/game/frame.ts:26`) and `:119` passes it to
`renderer.render(prev, curr, alpha, frameEvents, plan.dt)`. `step(curr, deps.input.sample())`
at `driver.ts:92` is the only sim call and `dt` is not among its arguments.

`dt` has **two** consumers, not one: `src/render/renderer.ts:85` forwards it to
`entities.sync` and `:89` to `particles.update`. (An earlier draft said it "dies inside
`EntityViews.sync`" — a reader auditing where the render clock reaches would come up one
consumer short.) Both are render-only, and nothing writes back into `World`, so the
replay-safety conclusion holds.

The purity guard would in fact catch a clock leaking into the sim:
`src/sim/purity.test.ts:203-208` denies `Math.random`, `Date.now`, `new Date` and
`performance` by word-boundary regex, with negative-control fixtures at :599-627 and
meta-tests at :757 and :768.

### Per-frame cost of the current mechanism is ~zero

Changing `texture.offset` costs two float ops. three re-uploads the texture matrix uniform
every frame regardless: `node_modules/three/src/renderers/webgl/WebGLMaterials.js:11-21`
(`refreshTransformUniform` — `map.updateMatrix()`, then `uniform.value.copy(map.matrix)`),
reached whenever `refreshMaterial` is true, and `WebGLRenderer.js:1288` resets
`_currentMaterialId = -1` at the end of every `render` call. So in a multi-material scene
every mapped material's texture matrix is recomputed and re-uploaded each frame whether the
offset moved or not. **An animated skin adds no upload and no extra uniform write versus a
static mapped skin.** (three 0.169.0.)

GPU sampling cost of a scrolling versus a static tile is **not measured**. It should be
identical — the shader is the same — but that is reasoning, not a result.

### Per-frame CPU regeneration is the approach to rule out

Measured by me on this box (fresh vitest file, 20 warmup + 200 iterations, deleted
afterwards), cost of one 128x128 mint:

| skin | ms |
|---|---|
| stripes | 0.114 |
| checker | 0.144 |
| camo | 0.248 |
| clouds | 0.314 |
| flow | 0.677 |

`flow` is the worst case for a visible reason: `src/render/skins.ts:401` runs a `Math.sin`
per pixel. `SIZE = 128` (`skins.ts:13`) and `new Uint8ClampedArray(SIZE * SIZE * 4)`
(`skins.ts:426`) = 65,536 bytes, so regenerating every frame is a **3.93 MB/s upload** plus a
fresh array allocation per frame feeding the GC inside the frame loop — to animate a tile
that a rigid texture-matrix transform animates for free.

> An earlier draft reported 0.117 / 0.238 / 0.350 / 0.147 / 0.819 ms from a harness it
> deleted. Ranking and order of magnitude reproduce; its `flow` figure is ~21% above mine.
> **Treat the ranking as the finding and the absolutes as indicative.**

### Skin textures inherit `DataTexture`'s defaults

`node_modules/three/src/textures/DataTexture.js:6` defaults `magFilter` and `minFilter` to
`NearestFilter`; `:14` sets `generateMipmaps = false`. `src/render/skins.ts:428-433` sets
only `wrapS`, `wrapT`, `colorSpace` and `needsUpdate` — no filter or mipmap override. So
every skin is nearest-filtered and unmipmapped. **What that looks like when a 128px tile
scrolls at play distance is unmeasured** and needs eyes, not an argument.

### The Customize preview never animates

`src/render/preview.ts:295-296` — `function draw(): void { entities.sync(world, world, 1, 0);
}`. The literal `0`, against the `dt > 0` guard at `entities.ts:881`, is a freeze. It redraws
only at construction, on a pose change, on a style change and on a resize (:299, :308, :317,
:320).

### No shaders exist anywhere

`grep -rnE "ShaderMaterial|onBeforeCompile|RawShader|uniforms" src/ tools/` exits 1 with
**zero matches**. Every animated-looking effect is a property tween on a
`MeshStandardMaterial` or a texture. The nearest precedent is the mine's
`mat.emissive.copy(lo).lerp(hi, pulse)` (`entities.ts:828`) — but it is **not reusable as an
animation clock**: it is derived from `1 - m.timer / MINE_TIMER` (:820-828), i.e. sim state,
and its own comment says "Driven entirely by mine.timer, never by a clock." A skin pulse has
no sim state to ride.

### There is no per-frame handle on the player's materials

`entities.ts:279` — `tankViews` values are `{ group, turret, kind, gen }`. `makeTank`
(:403-524) creates `bodyMat` (:413) and `turretMat` (:491) as locals and returns only
`{ group, turret }`. A per-frame material or uniform tween needs a registry — **though not
new machinery**: meshes are named, and the mine path already does
`mesh.material as THREE.MeshStandardMaterial` on a retained mesh, so a `traverse` or name
lookup is available today. (An earlier draft ranked this a blocker; it is a small piece of
work, not a wall.)

### One owned texture, two dispose sites

`entities.ts:281-283` carries the ownership comment; `:262-271` `disposeObject` deliberately
skips material maps; `playerSkinMap?.dispose()` appears at exactly two sites, `:902`
(`dispose`) and `:919` (`setPlayerStyle`). **Any richer animated skin that introduces a
second texture (frame atlas, emissive map) must be added to both, or it leaks one texture per
style change.**

A style change already rebuilds the player's geometry and materials (`colorGen` bump →
`disposeObject` + `makeTank`, :288, :690-700, :917-924), and only the player's. So a
shader/material-based skin pays no *new* rebuild cost; it inherits this path.

### Animated skins keep animating while the game is not simulating

`src/game/driver.ts:113` zeroes the accumulator on the non-playing branch but `:119` still
calls `render` with the real clamped `dt`. So a scrolling skin drifts on the title screen,
while paused (`'paused'` is a real state, `src/game/state.ts:12`) and on the game-over
screen. **Whether that is desirable is a design question nobody has recorded.**

### The gallery cannot show a skin at all

`tools/gallery/subjects.ts:208` calls `views.sync(prev, curr, alpha)` with three arguments,
so `dt` defaults to 0, and `grep -rn setPlayerStyle tools/` returns nothing — the tank there
wears the roster default, unmapped. So the tool CLAUDE.md names as "the way to look at any
element" cannot look at a skin, animated or not. The `--scene game` path loads the real game
and would animate; `tools/gallery/run.mjs:120-128` scales both `performance.now` and the rAF
timestamp (with a comment recording that scaling `performance.now` alone was a dead knob).

### Mapped materials are forced to white, and that is pinned

`entities.ts:412` — `const matColor = skinMap ? 0xffffff : color;` with a double-tint
rationale at :407-410, asserted at `entities.test.ts:881-884`. **So a mapped skin's
brightness cannot be pulsed by tinting the material colour** without undoing that decision.

### No unlock machinery for skins

`src/game/customization.ts:174-178` — `setSkin` is `if (!SKIN_IDS.has(id)) return;` and
nothing else. `grep -rn unlock src/` hits only level/progress unlocks and audio unlock.
`docs/superpowers/backlog.md:447` records it as unbuilt by design: "Skins are all free;
unlock criteria were never designed, and the achievements set is never consulted by the
customization store. #61"

The tie-in is mechanically easy: `AchievementsStore.earned()` returns a fresh Set
(`achievements.ts:171`, `:230`), and both stores are constructed side by side in
`loop.ts:280-282`. Gating a skin is a `requires?: AchievementId` field on `SkinDef`, a guard
in `setSkin`, and a HUD locked state. **The design is not easy** — see open questions.

---

## The real cost of adding a skin — measured, not read

An earlier draft claimed adding a patterned skin costs "six golden hashes plus two literal
counts (`toBe(30)`, and the `// 150` comment)" in `skins.test.ts`. I applied the mutation
rather than reasoning about it: added a sixth patterned skin (`chevron`, aliased to the
stripes painter, `scroll: { u: 0.05, v: 0 }`) to `customization.ts` and `skins.ts`, ran the
full suite, then reverted (`git status --porcelain` empty afterwards).

**Result: 8 failed tests across 4 files — 7 direct across 3 files.**

| file | test | failure |
|---|---|---|
| `src/render/skins.test.ts:319` | explicit accents clear a real contrast floor | `expected 144 to be 120` |
| `src/render/skins.test.ts:433` | auto keeps the hull's OWN hue | `expected 34 to be 28` |
| `src/render/skins.test.ts:453` | no auto combination is invisible on its own hull | `expected 36 to be 30` |
| `src/render/skins.test.ts:491` | the auto derivation is pinned (GOLDEN table) | `blue/chevron: expected '68c745c5' to be undefined` |
| `src/game/customization.test.ts` | offers the approved six, solid first | array mismatch |
| `src/game/customization.test.ts:108` | flow is the animated one | `expected { u: 0.05, v: 0 } to be undefined` |
| `src/game/hud.css.test.ts:216` | never lets a button fall through to browser default styling | `expected 39 to be 38` |

The eighth failure is `tools/mutate/orchestrate.test.ts`, which shells out to vitest and
expects success — an indirect consequence of the tree being red, not a direct toll.

Three things follow:

1. **Four literal counts move, not one** — 120, 28, 30 and a *second* 30 at :453 and :494.
   The `// 150` at `skins.test.ts:286` is a **comment beside a derived assertion**
   (`PALETTE.length * ACCENTS.length * PATTERNED_SKINS.length`) which **passed** the
   mutation. It cannot fail, so it is not part of the toll in the sense meant; it just goes
   stale silently.
2. **The toll crosses out of `src/render/`** into `src/game/customization.test.ts` and
   `src/game/hud.css.test.ts` (every `SKINS` entry builds a button, `hud.ts:548-558`).
3. **Six new GOLDEN hashes are needed** (6 shipped hulls x 1 new skin) — that part of the
   earlier claim was right.

**And a second *scrolling* skin costs more than a second static one**, because it trips
`customization.test.ts:108` ("flow is the animated one"). That assertion has to become
something else, which is a **design question about what "the animated one" means** — not hash
re-capture. An earlier draft sized shipping the backlog's bold-speed Flow variant at "XS,
under 2 hours, dominated by the six golden hashes". That sizing is not supportable as
written.

---

## Blockers

1. **No test that runs on the deploy path can see a shader.** A `ShaderMaterial` /
   `onBeforeCompile` skin whose GLSL fails to compile typechecks fine, passes vitest (jsdom
   has no WebGL — `src/render/preview.ts` returns null there for exactly that reason), and
   publishes. `.github/workflows/pages.yml` runs only `npm ci`, `npx tsc --noEmit`,
   `npx vitest run`, `npx vite build`, `npm run portability` and `npm audit` — **no
   `test:gl`, no `visual` job**. `.github/workflows/ci.yml:89` is where the `visual` job
   lives (`node tools/gl/run.mjs` at :138).
2. **Per-frame CPU texture regeneration should be ruled out up front** — 0.11–0.68 ms per
   mint plus a 64 kB upload and a fresh allocation every frame, for something the texture
   matrix does for free.
3. **A second scrolling skin requires a design decision, not just data**, because
   `customization.test.ts:108` currently asserts `flow` is the only animated skin.

**Removed from an earlier draft's blocker list:** "an animating preview contradicts a GL
harness invariant." `tools/gl/harness.ts:975-994` does assert that 0 bytes of the preview
canvas change 500 ms after a hover — but that check **cannot collide with an animated skin
today**, because `preview.ts:296` passes a hardwired literal `0` for `dt`. Selecting `flow`
in that harness check would still change zero bytes. It becomes a real constraint only *after*
someone changes the preview to animate — i.e. it is a consequence of the proposed work, not a
pre-existing blocker. (`harness.ts` does call `setStyle` elsewhere — :676, :678, :757, :787 —
always with `'solid'`.)

---

## Open questions

1. **Should a skin keep animating while the game is not simulating** (title, pause,
   game-over)? Today the answer is "yes, silently" (`driver.ts:110-119`). Whichever way it
   goes, `driver.test.ts` can assert the `dt` handed to `render` on the non-playing branch —
   it already injects a fake renderer.
2. **Does the preview need a continuous render loop to show an animated skin, and what does
   that cost?** Two measurements: (a) frame cost of the 260x190 preview canvas repainting
   continuously on a low-end device — the same measurement backlog spike 5 already asks for;
   (b) whether something cheaper suffices, e.g. repaint only while the pointer is over the
   panel, or for N seconds after a skin is picked. Design tension worth naming: the idle spin
   deliberately stops forever at first interaction.
3. **Which achievements should gate which skins, and what happens to a save wearing a skin
   the player no longer qualifies for?** The concrete case: `Reset progress` calls
   `deps.achievements.reset()` (`loop.ts:708`) while `tanks.custom.v1` still names a locked
   skin. Options: (i) render it anyway and gate only the picker; (ii) fall back to
   `DEFAULT_SKIN` on read — small, since `customization.ts`'s `read()` already validates each
   field independently, but it silently repaints someone's tank; (iii) do not gate skins on
   achievements at all. **A design decision, not a measurement.**
4. **Does a nearest-filtered, unmipmapped 128px tile shimmer or step visibly when scrolled at
   play distance?** Eyes, via `npm run gallery --scene game --slowmo` with `flow` saved. If it
   does, the fix is `magFilter`/`minFilter = LinearFilter` + `generateMipmaps = true` on the
   `DataTexture` — which does **not** move `skins.test.ts`'s golden hashes, because
   `skins.test.ts:18` reads `createSkinTexture(...)!.image.data`, the painter's source array,
   not a sampled result. So it is cheap to try.
5. **Should animated skins be player-only forever?** `setPlayerStyle` is the only entry point
   and `makeTank` gates the map on `kind === 'player'` (`entities.ts:411`);
   `backlog.md:448` records it. If an animated skin is a reward, the player never sees one on
   an enemy, which is fine — if animation is ever meant to signal enemy state, that is a
   different feature.
6. **What does one extra painter cost in the bundle?** `npm run build` with and without,
   comparing gzipped `dist/assets/index-*.js`. Cheap; nobody has done it. (For reference, the
   whole bundle at `3522c0a` is 740.07 kB raw / 195.64 kB gzip — but note the installed vite
   is 5.4.21 while the lockfile pins 8.1.5, so even that is not the declared toolchain's
   output.)

---

## What a first PR would be

**Make the Customize preview animate animated skins.** `preview.ts:296` passes `dt = 0`, so
`flow` — the one animated skin the game ships — is frozen in the exact panel where a player
decides whether to wear it. Today the only way to discover the animation is to start a level.

Smallest honest version: when the selected skin has a `scroll`, run the preview's redraw off
a clock. `src/render/preview-controls.ts` already owns a rAF loop with a clamped `dt`, which
is the natural place to hang it. Then restate the GL harness's "stops for good" check as
applying to non-animated skins — it does not need restating *before* this change, only as
part of it.

Size: **M**. Biggest unknown, and it should be decided first: whether to reuse the idle-spin
loop (which couples two behaviours that deliberately stop at different times) or add a second
indefinite repaint (whose cost backlog spike 5 already records as unmeasured).

Other PR-able items, filed as issues alongside this document: giving the gallery a way to
render a skin; naming and pinning the render animation clock (and deciding whether it runs
while paused); and setting the skin textures' filtering deliberately rather than inheriting
`DataTexture`'s defaults.

**Deliberately not filed as an issue:** "ship the bold-speed Flow variant" and "add one or
two new scroll-driven skins". Both need the `customization.test.ts:108` exclusivity decision
first, which makes them spike material rather than PR material.
