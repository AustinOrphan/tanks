---
status: active
date: 2026-08-23
last-reviewed: 2026-08-23
scope: Spike -- richer animated skins — what the offset mechanism cannot express
implementation-issues: []
implementation-prs: []
supersedes: []
superseded-by: []
---
# Spike: richer animated skins — what the offset mechanism cannot express

**Raised 2026-08-10**, from the same investigation.
**Document: `docs/research/animated-skins.md`.**

**The question:** should skins gain animation beyond texture-offset scrolling, and what is
the cheapest route that does not introduce this tree's first shader?

**Why it is live now.** Two facts that were not written down together.

1. **The existing mechanism is free and narrow.** `flow` scrolls via per-skin `scroll` data
   applied in `entities.ts:881-884`; three re-uploads the texture matrix uniform every frame
   for every mapped material anyway (`WebGLMaterials.js:11-21`), so an animated skin costs no
   extra upload over a static mapped one. But it can only express a **rigid 2D transform of a
   static tile** — no brightness pulse, no per-pixel evolution, no colour cycling. Tinting is
   closed off too: mapped materials are forced to `0xffffff` and `entities.test.ts:881-884`
   pins it.
2. **Adding a skin costs more than the render tests suggest.** Measured by mutation (a sixth
   patterned skin, reverted): **7 failing tests across 3 files** — four literal counts in
   `skins.test.ts` (120, 28, 30 and a second 30), six new GOLDEN hashes, two in
   `customization.test.ts`, and one in `hud.css.test.ts` (every `SKINS` entry builds a
   button). A second *scrolling* skin costs more still, because `customization.test.ts:108`
   asserts `flow` is the only animated one.

**What would answer it:**

- **Decide what `customization.test.ts:108` should become.** That assertion is the reason
  "ship the bold-speed Flow variant" (ledger, #61) is not the trivial data edit it looks
  like. It is a design question — what does "the animated one" mean when there are two? —
  and it must be settled before any second scrolling skin, including the one already on the
  ledger.
- **Decide whether skins should be unlockable at all** (ledger, #61), and specifically what
  happens to a save wearing a locked skin after `Reset progress` calls
  `achievements.reset()` (`loop.ts:708`). The mechanics are trivial; the rule is not.
- **Whether a scrolling tile SHIMMERS at play distance is still open — the spatial half of
  it was measured and fixed, the temporal half was not.** Skins no longer inherit
  `DataTexture`'s NearestFilter/no-mipmap defaults: `skins.ts` now names
  `SKIN_MIN_FILTER`/`SKIN_MAG_FILTER`/`SKIN_MIPMAPS`, and minification moved to
  `LinearMipmapLinearFilter` + mipmaps on a gallery comparison at matched texel density
  (33.2 dB PSNR between the two settings on `checker`, 43.0 on `flow`; magnification was
  LEFT at Nearest, at 51.2 and 60.7 dB — i.e. not visibly different at any scale the game
  shows). **Those are stills.** Shimmer is a temporal artefact and no still can show it;
  what was measured is the spatial aliasing that causes it. Eyes on a moving frame at play
  distance would settle it.
- **`npm run gallery --scene game` cannot select a skin**, which is why the measurement
  above had to match texel density in the gallery scene instead. `--skin`/`--hull`/
  `--accent` reach `buildGallery` only; the real game reads its triple from
  `localStorage` (`tanks.custom.v1`) and there is no dev flag for it. Seeding that key
  from `run.mjs` (or adding a flag) is a small PR and would make "what does this skin look
  like while the game is actually running" a one-command question.
- **The preview animates an animated skin under `prefers-reduced-motion`; the idle spin
  does not.** The split is deliberate and written down at `preview-controls.ts`'s doc
  comment — the spin is motion the panel invents, the scroll is what the skin IS, and the
  game scrolls it in play whatever the media query says. What is NOT decided is that last
  clause: nothing in `src/` honours reduced motion during gameplay at all. If it ever
  should, the preview's rule follows from that decision rather than standing on its own.
- **If a brightness pulse is wanted, the cheapest route is an emissive channel, not a
  shader** — precedent exists in the same file (the mine's
  `mat.emissive.copy(lo).lerp(hi, pulse)`, `entities.ts:828`). It needs the player's hull and
  turret materials retained (or a `traverse` by mesh name); `tankViews` holds only
  `{ group, turret, kind, gen }` today. The open question is whether an emissive pulse reads
  as "skin" or as "this tank is in some state" — the game already uses emissive pulsing to
  mean "armed mine". Answer that with eyes before writing the registry.

**Constraint that shapes any shader answer, now HALF closed.** A `ShaderMaterial` whose
GLSL fails to compile typechecks and passes vitest (jsdom has no WebGL); only
`npm run test:gl` catches it. That used to mean it would publish, because `pages.yml` ran
`tsc`, `vitest`, `vite build`, `portability` and `npm audit` but **not the `visual` job**.
Since #141 the deploy waits on CI, and `visual` is part of that run — so on the automatic
path a broken shader now fails CI and never reaches the site. **It remains true of
`workflow_dispatch`**, which is ungated by construction and still runs only those five
steps. So: a shader is safe on merge, and a manual re-deploy can still publish one.
