# Shipping Tanks! on Steam, Switch or PlayStation

**Investigated 2026-08-09, adversarially verified, corrected and re-measured 2026-08-10.**
File/line citations are against commit `3522c0a` (`origin/main`). External claims carry a
source URL and the date checked — **store fees and platform policies move; re-check before
acting.**

---

## Bottom line

**Do not average these three.** They are different kinds of answer.

**Steam is real but not close.** The $100 Steam Direct fee and a desktop shell are the cheap
part. The expensive parts are that this tree has zero gamepad code, that its save state
lives in browser localStorage where Steam Auto-Cloud cannot see it, and that four levels is
a demo. Nothing is blocked; the work is a desktop shell, a gamepad path, controller-navigable
menus, a Steamworks binding for achievements, and content.

**Steam Deck / Machine Verified is UNKNOWN, not a guaranteed fail.** An earlier draft called
it a guaranteed fail on the input criterion because the bundle has no Gamepad API code. That
is contradicted by Valve's own guidance: the criterion binds the default *controller
configuration*, which is authored on the partner site, not in the bundle — "If your game
doesn't natively support controllers, we recommend creating a controller configuration to
map to the appropriate mouse and keyboard inputs."
([partner.steamgames.com/doc/steamdeck/recommendations](https://partner.steamgames.com/doc/steamdeck/recommendations),
re-verified 2026-08-10). The real question is narrower and genuinely open: **this game aims
at a mouse POSITION**, so it needs a mouse-region or joystick-mouse binding, and nobody has
tested whether that plays acceptably.

**Switch and PlayStation are hard, for reasons that are not about effort.** Both require
approved developer status under NDA before any technical question can be asked, and I found
no publicly documented licensed runtime that runs a TypeScript + three.js WebGL bundle on
either. **I refuse to estimate console porting effort or cost** — the toolchains are NDA'd
and neither Nintendo nor Sony publishes devkit prices or certification requirements.

The engineering quality of this tree is high (1,664 `it(`/`test(` call sites across `src/`
and `tools/`, an asserted golden trace, negative-control fixtures on the guards) and **none
of that quality is what stands in the way.**

---

## What is true today of this tree

### There is zero gamepad code

`grep -rni "gamepad"` across `.ts`, `.json`, `.html` and `.mjs`, excluding `node_modules` and
`dist`, returns **3 hits, all in docs**, each listing gamepad as out of scope:
`docs/superpowers/specs/2026-07-22-tanks-design.md:127` and `:224`,
`docs/superpowers/plans/2026-07-22-tanks-vertical-slice.md:30`. **Zero hits under `src/`.**

The mitigating fact is that the seam already exists. `InputState.aim` is a world-space POINT,
not an angle (`src/sim/types.ts:127-134`), and `src/input/touch.ts:103` already projects a
thumbstick direction onto a point via `AIM_PROJECTION_UNITS = 100`. A right stick can reuse
that path without changing the sim contract.

### The game DOES have a keyboard model — and a widget-arbitration one

**Correction to an earlier draft**, which claimed "the only keyboard bindings in the whole
game are mute and pause". That is false about a game whose primary controls are the keyboard:

- `src/input/input.ts:346-347` registers `window` `keydown`/`keyup`.
- `:372-379` maps `a`/`arrowleft`, `d`/`arrowright`, `w`/`arrowup`, `s`/`arrowdown` onto one
  move vector.
- `:95-117` defines `WIDGET_KEYS` and `swallowsKey` — an explicit keyboard-vs-focused-widget
  arbitration model, with a comment about `Right Arrow` strafing instead of moving a slider.
- `src/game/hud.ts` registers its own `keydown`, and `src/render/preview-controls.ts`
  handles arrow keys inside the Customize panel.

So what is missing for console is **D-pad/roving focus, a focus ring that survives pointer
use, and input glyphs** — not a keyboard model.

Menu handlers, enumerated (identical count in both trees checked):
31 `click`, 5 `pointerdown`, 2 `mouseup`, 2 `input`, 1 `keydown`. An earlier draft said
"every handler is `click` or `pointerdown`"; it is not — two are `input` (the volume slider).

### `step()` runs eight calls, and the repo's own deletable-stage population is seven

`src/sim/world.ts:242-259`: `step` clones (`cloneWorld(world)`), increments `draft.tick`,
and inside `if (draft.status === 'playing')` calls `applyPlayerInput`, `stepAi`, `stepBlasts`,
`stepMovement`, `stepBullets`, `resolveBulletHits`, `stepMines`, `resolveStatus` — **eight
calls**. `src/sim/step-pipeline.test.ts:40` states its population as "7 of 7 … (population:
all 7)" and swept "all 5040 orderings" (= 7!). An earlier draft said nine; it is not nine.

### Save state is localStorage-only, in five browser-scoped keys

`tanks.progress.v1` (`progress.ts:12`), `tanks.touch.v1` (`touch-settings.ts:11`),
`tanks.stats.v1` (`stats.ts:10`), `tanks.custom.v1` (`customization.ts:11`),
`tanks.achievements.v1` (`achievements.ts:16`). **`CLAUDE.md:62` said "four keys" when this
was written; corrected to five by the PR that closed issue #109.**

Steam Auto-Cloud matches a Root + Subdirectory + wildcard Pattern against files on disk
([partner.steamgames.com/doc/features/cloud](https://partner.steamgames.com/doc/features/cloud),
checked 2026-08-09); it cannot see Chromium's LevelDB-backed localStorage. A desktop shell
needs those five writes landing in a filesystem path.

**All five stores already take an injected `Storage`**, and one grep shows it:
`createProgressStore` (`progress.ts:23`), `createStatsStore` (`stats.ts:75`),
`createCustomizationStore` (`customization.ts:110`), `createTouchSettingsStore`
(`touch-settings.ts:28`), `createAchievementsStore` (`achievements.ts:203`); the single
resolver is `browserStorage()` at `src/game/loop.ts:267`, called five times at :278-282. An
earlier draft posed "do all five already take a Storage?" as an open question and sized a PR
around the uncertainty — **that unknown does not exist**, and the item is small.

### Achievements are a closed local system, but the shape is right

`src/game/achievements.ts:49-63` declares an `AchievementId` union with exactly **14**
members; `:71-166` holds the defs, each a pure `earned(ctx)` predicate over tallies, all
latched. `check()` returns freshly-earned defs and then `persist()` writes localStorage
(:232-238) — nothing observable crosses out of the game layer.

Steam's cap is comfortable: "By default, games are limited to 100 achievements at first"
([partner.steamgames.com/doc/features/achievements](https://partner.steamgames.com/doc/features/achievements),
checked 2026-08-09), unlocked via `ISteamUserStats` (`RequestCurrentStats` /
`SetAchievement` / `StoreStats`). A Steam integration is a hook on the `check()` return path.
This is the **smallest** blocker of the set.

### No desktop packaging, and no LICENSE

`package.json` scripts are `dev, build, preview, test, visual, portability, test:gl, gallery,
audio, mutate` — no packaging target. It is `"private": true`, `"version": "0.0.0"`.
`ls -a | grep -i licen` exits 1: **there is no LICENSE file.**

three.js 0.169.0 and howler 2.2.4 are both MIT (read from `node_modules/*/package.json`), and
MIT requires the copyright notice travel with distributions — so a commercial binary needs a
notices screen or file that does not exist today. *I am not a lawyer; treat this as a prompt
to get advice, not as advice.*

### There is genuinely no audio to license

`CREDITS.md`: "No third-party audio assets are currently committed to this repository", with
a stated policy of royalty-free/CC0 preferred, **no AI-generated audio**, and no unclear
licensing. `public/` holds only `favicon.svg` and `audio/.gitkeep`; every SFX is synthesised
in Web Audio and the music is generated. Fonts are the system stack
(`src/game/hud.css:5`), not a bundled file. For a commercial release that is a real
advantage.

### Content: 4 arenas, 18 enemies, 5 enemy kinds

Counted directly from `src/sim/config/data/arenas.json` for this document:

| arena | size | enemy spawns |
|---|---|---|
| arena-01 | 33x27 | 3 |
| arena-02 | 33x27 | 4 |
| arena-03 | 33x27 | 5 |
| arena-04 | 45x33 | 6 |
| | | **18 total** |

`src/sim/config/validate.ts:35` — `TANK_KINDS = ['player','brown','grey','teal','olive',
'green']`, i.e. **5 enemy kinds**, not 6 (the sixth is the player). The design spec itself
names "Full 20-mission campaign" as out of scope
(`docs/superpowers/specs/2026-07-22-tanks-design.md:224`).

Steam has no minimum-length rule in any page I read, so it would technically ship at this
size. (Weaker evidence than a positive statement: absence of a rule in the pages fetched is
not proof there is none; Valve's full Rules and Guidelines page was not read.)

> **UNSUPPORTED:** an earlier draft asserted "at this size it is a free or $2-3 product" —
> no source, no comparable-title data, pure opinion stated as a pricing fact. And it
> predicted Nintendo/Sony would decline the pitch, which **contradicts its own correct
> finding** that neither platform publishes approval criteria. An outcome cannot be
> predicted from criteria established to be unpublished.

### The deterministic sim is an asset for Steam, and neutral for console

`step(world, input)` is a pure function returning a new world, and the golden trace
(`tools/baseline/trace.test.ts`) is an asserted hash over 4 arenas x 6 seeds x 2500 ticks. A
seeded input stream is therefore a verifiable score submission — but **no input recorder or
replay player exists in the shipped game**; `grep -rn replay src/` finds comments and test
hits only, no recorder module.

For console it buys nothing against the real barrier, which is whether a JS runtime exists on
the device at acceptable speed. (An inference from one documented case, below — not a
platform statement.)

---

## Steam: the facts, dated

All primary, all from Valve's partner site.

| Item | Verbatim | Source | Checked |
|---|---|---|---|
| Steam Direct fee | "$100 USD (or equivalent) fee for each new app you wish to distribute on Steam"; "The Steam Direct Fee is not refundable"; "recoupable in the payment made after your product has at least $1,000.00 Adjusted Gross Revenue" | [appfee](https://partner.steamgames.com/doc/gettingstarted/appfee) | **re-verified 2026-08-10** |
| Calendar time | "A 30-day waiting period between when you paid the app fee and when you can release your game"; "a publicly-visible 'coming soon' page for at least two weeks"; tax/identity verification 2-7 business days; store page and build review 1-5 days | [onboarding](https://partner.steamgames.com/doc/gettingstarted/onboarding) | 2026-08-09 |
| Identity | "Complete the paperwork with your bank and tax information as well as identity verification"; "The account holder name on your bank account must match the name you provide when onboarding." | [onboarding](https://partner.steamgames.com/doc/gettingstarted/onboarding) | 2026-08-09 |
| Achievements | "By default, games are limited to 100 achievements at first" | [achievements](https://partner.steamgames.com/doc/features/achievements) | 2026-08-09 |
| SDK licence | "a nonexclusive, royalty-free, terminable, worldwide, nontransferable license"; `redistributable_bin` may ship in object code form | [sdk_access_agreement](https://partner.steamgames.com/documentation/sdk_access_agreement/) | 2026-08-09 |

### Deck / Machine Verified criteria

From [partner.steamgames.com/doc/steamdeck/compat](https://partner.steamgames.com/doc/steamdeck/compat)
(checked 2026-08-09). The page now says "Deck/Machine" and names Steam Frame as a separate
process, confirming the programme has widened beyond the Deck.

- Framerate: "On Steam Deck, this is 30fps at 800p, and on Steam Machine this is 30fps at
  1080p."
- Legibility: "The smallest on-screen font character should never fall below 9 pixels in
  height at 1280x800."
- Input: the default controller configuration must provide access to **all content**. (An
  earlier draft misquoted this inside quotation marks as "all game functionality".)
- Glyphs must match the input device; the game must not tell the user the Deck/Machine is
  unsupported.

**Against this tree, only input and glyphs are in question, and the font claim is not
established.** An earlier draft asserted "font sizes in `src/game/hud.css` are fixed px
between 12 and 18" — re-measured, that is wrong in both directions. The fixed-px
declarations run **12px to 72px** (:25, 101, 110, 129, 356, 423=72px, 435, 452=56px, 460,
470, 519, 937), plus two `clamp(16px, 2.2vw, 26px)` (:1076, :1083). More importantly the
sweep **omits the em-relative rules** — `0.72em` (:728), `1em` (:750), `0.85em` (:864),
`0.75em` (:896) — which are precisely the declarations whose computed pixel height cannot be
read off the rule, and therefore the only candidates for falling under 9px. The conclusion
may well hold; **the evidence offered does not establish it**, and settling it needs a
computed-style measurement at 1280x800.

> **UNSUPPORTED:** the specific Steam Machine / Steam Frame figures beyond the 1080p/30fps
> line above ("90fps VR, or 30fps at 720p for 2D titles") and the "as of GDC 2026" framing
> came from press coverage, not a Valve document. Do not rely on them.

> Deck framerate for *this game* is an inference from scene complexity, **not a measurement**
> — nobody has run it on Deck or any other hardware.

### Wrapping for Steam

Mature MIT-licensed bindings exist ([steamworks.js](https://github.com/ceifa/steamworks.js/),
[greenworks](https://github.com/greenheartgames/greenworks), both checked 2026-08-09) and the
Steamworks SDK is royalty-free. The Steam overlay in Electron is a documented, recurring
problem class — `electron/electron#3340` ("Trouble with steam-overlay in electron"),
`electron/electron#47662` ("Electron 35 introduces steam overlay issues"),
`ceifa/steamworks.js#97` and `#195` (Linux overlay) all exist with those titles (checked
2026-08-09). **Low confidence it would bite this game**: a commonly cited root cause is a page
that does not repaint every frame, and this game drives a continuous rAF loop
(`src/game/driver.ts`). Untested — see open questions.

Electron and Tauri are not equivalent here, and the axis is WebGL2 consistency rather than
size: Tauri uses the system webview (WebView2 on Windows, WebKitGTK on Linux/Deck), so the
three.js scene runs on a different renderer per platform, while Electron bundles Chromium at
~100 MB+ install cost. (`tools/gl/run.mjs` launches Playwright's Chromium, so Chromium is
the family this game is actually tested against — but nobody has compared the specific
Chromium builds, so "the exact engine" would be an overstatement, and nobody has run this
game under WebKitGTK at all.)

---

## Switch and PlayStation

### Nintendo

- Registration is **free** and open to individuals: "Registering for the portal and
  downloading the tools is completely free."
  ([developer.nintendo.com/faq](https://developer.nintendo.com/faq), checked 2026-08-09 —
  note an earlier draft cited `/register` for this, which does not say it.)
- `/register` does say: "If you register as an individual, you will not be able to add other
  users to your organization. Other than this limitation … there is no difference from
  registering as a company", and the Nintendo Switch Access Request form asks you to "enter
  your development experience history and information on your planned project".
- The process ([developer.nintendo.com/the-process](https://developer.nintendo.com/the-process),
  checked 2026-08-09) is NDA + ToS, publishing agreement, age rating, Nintendo review. It
  **states no cost, no criteria and no timeline.**

> **UNSUPPORTED:** "Nintendo gates on concept approval before a devkit is issued." Neither
> `/register` nor `/the-process` describes a concept-approval gate; the access-request form
> asking about a planned project is an inference. (For Sony it *is* supported — see below.)

> **UNKNOWN, deliberately:** the devkit price. Secondary blogs assert "a few hundred dollars
> per unit"; no primary source supports it, so it is recorded as unknown rather than
> repeated.

### PlayStation

Sony's public position since 2022-07-26: newly registered partners can request "one
complimentary development kit and one complimentary test kit", loaned rather than sold, and
they "need to be returned to SIE within 2 years (or earlier, at SIE's request)" — but only
"once you are registered as a partner and **your game concept has been accepted**"
([sonyinteractive.com/en/news/blog/complimentary-development-hardware](https://sonyinteractive.com/en/news/blog/complimentary-development-hardware/),
checked 2026-08-09). **Medium confidence it is still operating policy in 2026** — that post
is four years old and no newer primary statement was found.

Approval criteria, devkit terms beyond that post, certification requirements and SDK
capabilities are **not publicly documented**. `register.playstation.net` returns no
substantive public content.

### The runtime question

**I found no publicly documented licensed path that runs a TypeScript + three.js WebGL bundle
on Switch or PlayStation.** Stated that way deliberately: it is an absence claim and cannot
be proven, only searched for. What survived adversarial search:

- The Nintendo Web Framework (the HTML5 path) "was available for the Wii U, but was
  discontinued for the Nintendo Switch".
- CrossCode's port team found interpreting JS "turns out to not be fast enough", that
  V8-style runtime optimisations "have also not been an option", and that they had to
  "compile the JavaScript code base into C++ ahead-of-time" to reach 60fps on Switch.
  All four quotes verbatim from
  [siliconera.com/crosscode-interview-radical-fish-games-on-console-ports-and-whats-next](https://www.siliconera.com/crosscode-interview-radical-fish-games-on-console-ports-and-whats-next/)
  (dated 2020-07-02, checked 2026-08-09). *That is a bespoke compiler project, not a port.*
- Nintendo's middleware section does carry a TypeScript-scripted engine — Cocos Creator for
  Nintendo Switch — and a Godot port distributed by RAWRLAB. **Neither runs this codebase**;
  both are re-implementation targets with their own renderers. Whether Cocos's Switch build
  interprets, JITs or AOT-compiles its TypeScript is unknown, and Nintendo's own tools page
  is behind a login.
- `nx.js` (QuickJS on Switch) self-describes as a runtime for Switch **homebrew** — not a
  licensed distribution path.

If a console port were pursued, `src/sim/` is the part that ports well: it is self-contained
TypeScript with no three.js, no DOM, no Howler and no nondeterministic globals — the purity
guard (`src/sim/purity.test.ts`) bans `Math.random`, `Date.now`, `new Date` and `performance`
by regex with negative-control fixtures. `src/render/` and `src/game/` do not exist on
console and would be a rewrite.

> Correction on the guard's coverage: an earlier draft said "every rule carries a
> negative-control fixture plus a meta-test asserting one fixture per rule". Meta-tests
> exist for `FORBIDDEN_GLOBALS`, `FORBIDDEN_NONDETERMINISM` and `SPECIFIER_RES` — but not
> for `FORBIDDEN_IMPORT_PATTERNS`, so appending a mistyped import pattern there would go
> unfixtured.

### Age ratings

Digital-only console releases can get ratings free via IARC — one questionnaire covering
Nintendo eShop, PlayStation Store, Microsoft Store, Epic and others, "at no cost to you"
([globalratings.com](https://www.globalratings.com/), checked 2026-08-09). Ratings are a
paperwork cost, not a money cost, unless a physical release is wanted.

---

## Blockers

1. **No gamepad input exists anywhere.** Console has no other input option that a player will
   accept. For Steam Deck it is *probably* survivable through a Steam Input default config,
   but this game aims at a mouse position, which is the hard case.
   > Correction: an earlier draft said "Switch and PlayStation have NO other input — no
   > mouse, no keyboard." Nintendo's own tech specs list a capacitive touch screen, and this
   > repo already ships a touch input path (`src/input/touch.ts`). PS5 supports USB/Bluetooth
   > keyboards and mice at the console level with per-game opt-in (secondary sources only;
   > Sony publishes no consolidated list). The defensible claim is **"controller support is
   > mandatory and cannot be substituted"**, not "no other input exists".
2. **Menus have no D-pad/roving-focus model and no input glyphs.** The HUD is real `<button>`
   elements, so focus exists — directional movement between controls does not.
3. **Save state is browser-scoped**, and Auto-Cloud cannot see it. The seam to fix it already
   exists (all five stores inject `Storage`).
4. **Achievements have no external write path.** Smallest of the set; the design is already
   shaped for it.
5. **No desktop packaging target and no LICENSE**, and MIT notice reproduction is owed for
   three.js and howler in any distributed binary.
6. **No publicly documented licensed JS/WebGL runtime on Switch or PlayStation** (absence of
   evidence, searched — see above).
7. **Four levels and 18 enemies is a demo.** Steam would technically accept it; whether it
   should be *sold* at that size is a product decision, not a platform rule.

---

## Open questions

1. **Does this exact bundle render correctly and fast under WebKitGTK** (Tauri's Linux/Deck
   webview), or does it require Electron's bundled Chromium?
   Build `dist/` and load it in a WebKitGTK browser (Epiphany/GNOME Web) on Linux, then on
   Deck hardware if available; compare WebGL2 context creation, three.js material
   compilation and frame time against Chromium on the same machine. **This single
   measurement decides Electron vs Tauri**, which decides install size, overlay behaviour and
   the whole shell architecture.
2. **Does a Steam Input default configuration make a mouse-position-aimed game playable on a
   controller?** Author one (mouse-region or joystick-mouse binding), test it on Deck. This
   is the actual Verified question, and it is unknown.
3. **Does the Steam overlay break in an Electron shell for THIS game**, given its continuous
   rAF loop? A throwaway Electron shell around `dist/` plus steamworks.js, added to Steam,
   Shift-Tab tested on Windows and Linux/Deck. Test before committing to Electron.
4. **Do any `hud.css` em-relative font sizes compute below 9px at 1280x800?** Read computed
   styles in a real browser at that viewport for `.hud` descendants using `0.72em`, `0.85em`
   and `0.75em`. Cheap, and it converts the Verified legibility criterion from an assumption
   into a fact.
5. **What is the target content scope, and does it come before or after a platform
   decision?** A decision, not a measurement. Adding a level is JSON plus five pinned test
   sites (CLAUDE.md enumerates the checklist), so per-level cost is *knowable*: time
   arena-05 end to end, then multiply.
6. **Would a Switch or PlayStation concept submission be accepted at all?** Nothing short of
   registering (free for Nintendo) and submitting will answer it — neither platform publishes
   its criteria. Do not start until the content question is decided, because the pitch is
   what is judged.
7. **Port or re-implementation, and in which engine?** A prototype spike: port `src/sim/`
   alone to the candidate engine's language and run the golden-trace inputs through it to
   check the outputs match. If the sim survives translation with matching traces, the
   re-implementation is bounded to render + HUD. If not, the AOT-compile route is the only
   one left, and that is a compiler project.
8. **Is a paid release even the goal?** The $100 fee is recoupable only after $1,000 AGR, and
   free games still pay it and can never recoup it.

---

## What a first PR would be

**A gamepad input source behind a `gamepad` dev flag, single player only.** It is the single
largest gap for every platform, and the seam already exists: `InputState.aim` is a world
point (`src/sim/types.ts:127-134`) and `src/input/touch.ts:103` already projects a stick
direction onto one via `AIM_PROJECTION_UNITS`. A Gamepad API reader emitting the same
`InputState` needs no sim change, and `src/game/devflags.ts` is the established home for
unshipped work on `main`. It **must stay out of `src/sim/`** — CLAUDE.md's rule that flags
never reach the pure core applies.

The Gamepad API is Baseline "available across browsers since March 2017", polled per frame
via `navigator.getGamepads()`; note that "In Firefox, gamepads are only exposed to a page
when the user interacts with one with the page visible" (anti-fingerprinting), so the HUD
needs a "press a button" state
([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Gamepad_API/Using_the_Gamepad_API),
checked 2026-08-09).

Size: **M** — a new `src/input/gamepad.ts` plus a sibling test and a devflags entry. Biggest
unknown: whether jsdom can fake `navigator.getGamepads` well enough to test it without a
browser harness; deadzone and response tuning is feel work rather than code.

Other PR-able items, filed as issues alongside this document: HUD keyboard/D-pad focus
navigation; a repo LICENSE plus a generated third-party notices file; routing the five stores
through one injected storage module; an input recorder and replay driver; a notices/credits
HUD panel; and authoring arena-05 while timing it end to end.
