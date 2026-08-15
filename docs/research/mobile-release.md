# Shipping Tanks! as a mobile app

**Investigated 2026-08-09, adversarially verified, corrected and re-measured 2026-08-10.**
All file/line citations are against commit `3522c0a` (`origin/main` at the time of writing)
and were re-opened in that tree. External claims carry a source URL and the date it was
checked — **platform policies and fees move, so re-check every dated line before acting on
it.**

---

## Bottom line

Android through a Capacitor wrapper is the short path, and nothing in the architecture
fights it: the bundle makes zero network requests after load, `base: './'` already makes it
origin-agnostic, and touch controls already ship. iOS is not blocked by the code either — it
is blocked by hardware this project does not have (an iOS build needs macOS + Xcode) and by
a $99/year membership.

**No total effort estimate is given, and that is deliberate.** The number that would decide
the size of the port — frame time on a real mid-range phone — has never been measured, by
anyone, in this repo. Whether the render settings ship as-is or need a whole quality-preset
system is unknown until someone runs the bundle on a device. Estimating around that would be
guessing.

The single hardest constraint is not engineering at all: a personal Google Play developer
account created after 2023-11-13 must run a closed test with **12 testers opted in for 14
continuous days** before it can apply for production access. That is a calendar wall, and it
should start before the polish work rather than after it.

---

## What is true today of this tree

### The bundle is genuinely offline

`grep -rn "fetch(\|XMLHttpRequest\|import(" src/ --include=*.ts` returns **14 lines across
the whole tree; exactly 1 outside test files**, and that one is a type-position dynamic
import (`src/audio/music.ts:86`, `director?: import('./playlist').MusicDirector | null`) —
not a runtime request. Thirteen of the fourteen are in `src/sim/purity.test.ts` and
`src/audio/imports.test.ts`, and one of those (`imports.test.ts:75`) is a real runtime
dynamic import inside a test.

`public/` contains exactly two files: `favicon.svg` and `audio/.gitkeep`. `CREDITS.md`
states "No third-party audio assets are currently committed to this repository." All sound
is synthesised at runtime.

This is the single most load-bearing fact for a wrapper: a Capacitor build ships a fully
offline game, not a webview pointed at a remote site — which is the distinction both Apple
Guideline 4.2 and Google Play's webview-spam policy actually turn on.

### `base: './'` already makes the output origin-agnostic — over http(s)

`vite.config.ts:13` sets `base: './'`. The built `dist/index.html` references
`./assets/index-*.js` (:54), `./assets/index-*.css` (:55) and `./favicon.svg` (:15).
Relative refs resolve correctly under Capacitor's default origins — iOS
`capacitor://localhost`, Android `https://localhost`
([capacitorjs.com/docs/config](https://capacitorjs.com/docs/config), checked 2026-08-09).
No change to `vite.config.ts` is needed for Capacitor or Tauri.

**Correction to an earlier draft of this research:** it also claimed the bundle resolves
correctly under `file://`. That is **false, and was falsified by measurement.** Loading
`dist/index.html` from a `file://` URL in Chromium 151.0.7922.34 produces a **blank page**:
`#app` is empty, zero canvas elements, and the console reports the module script and the
stylesheet both blocked by CORS policy from origin `null` (`net::ERR_FAILED`). The mechanism
is verifiable in-tree — vite emits `<script type="module" crossorigin>` and
`<link rel="stylesheet" crossorigin>` (`dist/index.html:54-55`), and `crossorigin` is
CORS-gated from an opaque `file://` origin. The control passes: the same `dist/` served over
http under a `/tanks/` subpath boots clean, 2 canvases, HUD present, zero console errors.
This does not affect Capacitor or Tauri, neither of which uses `file://` — but any wrapper
that does would need the `crossorigin` attributes removed. (Probe caveat: Chromium only, not
WKWebView.)

### `tools/portability/check.mjs` covers part of this already

Read in full (174 lines). Check (1) asserts `index.html` reaches its assets relatively
(:59). Check (2) asserts no origin-absolute `/audio/` or `/assets/` literal survives in any
bundle, in any quote style (:78-80). Check (3) (:87-103) — that the runtime base the audio
manifest interpolates is itself relative — is **dormant by design**, because `AUDIO_MANIFEST`
declares no files, so no asset URL reaches the bundle at all. The file asserts that state
rather than going quiet (:110-142) and re-arms itself the moment an asset is declared.

### Bundle size, measured at `3522c0a`

`npm run build`, run for this document on 2026-08-10:

| | raw | gzip |
|---|---|---|
| JS (one chunk, 79 modules) | 740.07 kB | 195.64 kB |
| CSS | 10.70 kB | 2.59 kB |
| index.html | 2.37 kB | 1.19 kB |

Built in 1.62 s.

**Caveat that matters:** the installed toolchain is stale. `node_modules/vite` is **5.4.21**
while `package-lock.json` pins **8.1.5** (and `package.json` declares `^8.1.5`). These
figures are vite 5 output. **The bundle size under the declared toolchain is UNKNOWN**;
`npm ci` and a rebuild would answer it.

> **UNSUPPORTED:** an earlier draft asserted that "Play's uncompressed AAB base limit and
> Apple's cellular-download threshold both leave enormous headroom". No figure and no source
> was given for either limit, and both have moved historically. Treat size as *probably* not
> a constraint, but do not quote headroom without pulling the Play Console app-bundle-size
> page and Apple's app-size-limits page and quoting their numbers with a date.

### Touch controls are substantially complete

`src/input/touch.ts` (199 lines) holds pure, DOM-free stick maths and gesture
classification. Every constant re-read in tree: `STICK_RADIUS_PX = 56` (:17),
`STICK_DEADZONE = 0.18` (:26) rescaled at :51 as `(throwFraction - STICK_DEADZONE) / (1 -
STICK_DEADZONE)` so the dead zone costs no range, `TAP_MAX_MS = 250` (:142), `TAP_SLOP_PX =
12` (:145), `DOUBLE_TAP_MAX_MS = 300` (:148), `DOUBLE_TAP_SLOP_PX = 40` (:159),
`AIM_PROJECTION_UNITS = 100` (:103).

Two aim schemes (`TouchScheme = 'point' | 'stick'`, :91, default `stick`) x three fire modes
(`FIRE_MODES = ['tap','double','button']`, :123, default `tap`), persisted under
`tanks.touch.v1` (`src/game/touch-settings.ts:11`) with per-field independent validation
(:42-51). Shipped in `0ea9798` (#94), `8a70574` (#96), `9f98360` (#99).

### The app-lifecycle cases a wrapper hits hardest are already handled

`src/input/input.ts` routes `pointercancel` through `onPointerEnd` and treats it as a
cancelled gesture that cannot fire and cannot prime a double-tap. `releaseAll()` clears keys,
`firePressed`, `minePressed`, `stickPointer`, `aimPointer`, `aimPoint`, `stickMove` and
`lastAimTap`, with a comment naming the switch-apps-mid-drive case; it is wired to
`window` `blur` and to `document` `visibilitychange` (hidden only) and all three listeners
are removed in `dispose()`. `src/boot.ts:66-74` registers a `pagehide` teardown with an
early return on `e.persisted` for the bfcache case.

### iOS audio unlock is already solved

`src/audio/engine.ts` declares `unlock()` with a doc comment naming the problem: "Safari/iOS
will not start a context resumed from anywhere else, and the sim's sounds are emitted from
the rAF loop, which is never a gesture." `tryResume` carries a `resuming` latch so a parked
WebKit promise cannot spawn one retry per shot. It is called from two gesture sites in
`src/game/loop.ts` (:518 and :580), the latter commented "Safari accepts no later
opportunity", and the engine installs its own last-resort gesture unlock as well.

### There is NO safe-area handling anywhere

`grep -nE "safe-area|env\(|viewport-fit|dvh|100vh|orientation"` over `index.html` and
`src/game/hud.css` returns **zero lines** (population: those two files).

- `index.html:5` viewport meta is exactly `width=device-width, initial-scale=1.0` — no
  `viewport-fit=cover`.
- `src/game/hud.css:307-311` — `.hud-touch { position: absolute; z-index: 2; right: 14px;
  bottom: 14px }`. Fire and Mine sit in the iPhone home-indicator swipe strip.
- `src/game/hud.css:10-21` — `.hud-topbar { position: absolute; top: 0; left: 0; right: 0;
  padding: 12px 18px }`. Score and lives sit under the Dynamic Island in landscape.

**Correction:** an earlier draft described the touch button row as "coarse-pointer-gated".
The mechanism is the inverse: `hud.css:333` is `@media (pointer: fine) { .hud-touch {
display: none } }` — hidden on fine pointers. There is no `(pointer: coarse)` query in the
file. Same visible outcome, opposite stated gate.

> **UNSUPPORTED:** the claim that "iOS insets the WebView to the safe area by default, so
> nothing is occluded today" carries no source and does real work (it is what makes the
> current state "letterboxed" rather than "clipped"). It would be settled by the WebKit
> documentation on `viewport-fit`/`safe-area-inset`, or by a screenshot on a notched device.

Related, and verified independently at
[developer.android.com/develop/ui/views/layout/edge-to-edge](https://developer.android.com/develop/ui/views/layout/edge-to-edge)
(checked 2026-08-09): "Edge-to-edge is enforced on Android 15 (API level 35) and higher
**once your app targets SDK 35**." It is a target-SDK trigger, not a device-version trigger.
Because Play forces API 36 from 2026-08-31 (below), the condition is met in practice.

### There are FIVE `tanks.*` localStorage keys, not four — CLAUDE.md was stale
<!-- Corrected in CLAUDE.md by the PR that closed issue #109; the finding below is kept
     as written, since it is what the investigation measured. -->


`grep -rn "_KEY = " src/ --include=*.ts` returned exactly five declarations **when this was
measured, against `d5cb2b3`** (re-run at that commit to confirm: still five):

| key | file |
|---|---|
| `tanks.progress.v1` | `src/game/progress.ts:12` |
| `tanks.touch.v1` | `src/game/touch-settings.ts:11` |
| `tanks.stats.v1` | `src/game/stats.ts:10` |
| `tanks.custom.v1` | `src/game/customization.ts:11` |
| `tanks.achievements.v1` | `src/game/achievements.ts:16` |

`CLAUDE.md:62` still says "the game's four keys are all `tanks.*`-prefixed". That sentence
is wrong. (Population caveat: this grep finds keys declared as `_KEY = `; a key declared
some other way would be missed. A second grep for the literal string `tanks.` across
non-test `src/` found the same five.)

<!-- Correction, added by the PR that closed #109/#110/#118. -->
**Both greps above are falsified by that same PR, and the wording is corrected rather than
the finding.** Neither grep is a predicate for "localStorage key"; both were reported as
counts, so both went stale the moment this branch added constants that match them:

- `grep -rn "_KEY = " src/ --include=*.ts` now returns **six**, the sixth being
  `DEV_CONSOLE_KEY = '__tanks'` (`src/game/loop.ts:159`) — a `globalThis` property name,
  not a storage key, and not even `tanks.*`-prefixed.
- `grep -rn "'tanks\." src --include=*.ts | grep -v '\.test\.ts'` now returns **seven**: the
  five keys plus `SAVE_FORMAT = 'tanks.save'` (`src/game/save.ts:29`) and
  `REPLAY_FORMAT = 'tanks.replay'` (`src/game/replay.ts:29`), both of which are wire-format
  discriminators inside a blob, not keys anything stores under.

The finding itself stands: there are still exactly **five** `tanks.*` localStorage keys, and
they are the five in the table. What is now pinned rather than grepped is that list —
`SAVE_KEYS` in `src/game/save.ts` is asserted equal to those five literals in
`save.test.ts`, and a second test drives all five stores and checks the keys that actually
appear in storage match it. A sixth store added without a `SAVE_KEYS` entry fails there.

### Swapping storage backends is already cheap

Every store takes a `Storage` as a constructor argument — `createProgressStore(storage)`
(`progress.ts:23`), `createStatsStore` (`stats.ts:75`), `createCustomizationStore`
(`customization.ts:110`), `createTouchSettingsStore` (`touch-settings.ts:28`),
`createAchievementsStore` (`achievements.ts:203`) — and exactly one site resolves the real
one: `browserStorage()` at `src/game/loop.ts:267`, which wraps `globalThis.localStorage` in
a try/catch with an inert stand-in fallback and is called five times at :278-282. Pointing
all five at Capacitor Preferences or a shimmed Storage is a one-function edit.

### Saves do not migrate into a wrapper

localStorage is origin-scoped. The web game is `https://austinorphan.com`; a Capacitor iOS
build is `capacitor://localhost` and Android is `https://localhost`. A player with web
progress starts the app at zero, and nothing in `src/` can serialise or import that state.

The flip side is real: this **solves** the hazard CLAUDE.md documents — the shared
localStorage namespace across `austinorphan.com` project pages, and the portfolio's
root-scoped `/sw.js` deleting CacheStorage entries it does not own — because the wrapper
origin is private to the app.

### The renderer is WebGL2-only and desktop-tuned

three.js **0.169.0** requests context name `webgl2` with no WebGL1 fallback —
`node_modules/three/build/three.module.js:28968` is `const contextName = 'webgl2';` and the
surrounding block has no WebGL1 branch; failure throws. WebGL1 support was removed at r163:
the [r163 release notes](https://github.com/mrdoob/three.js/releases/tag/r163) state under
WebGLRenderer, verbatim, "Remove WebGL 1 support." (checked 2026-08-09). There is no
graceful-degradation path to hardware without WebGL2.

`src/render/scene.ts`, every line re-read:

- `:116` `new THREE.WebGLRenderer({ canvas, antialias: true })`
- `:117` and `:293` `setPixelRatio(Math.min(window.devicePixelRatio, 2))`
- `:118-119` `shadowMap.enabled = true`, `PCFSoftShadowMap`
- `:166` sun DirectionalLight, `:168` `shadow.mapSize.set(2048, 2048)`
- `:190` fill light, `:197` rim light, `:203` AmbientLight
- `:131` `ACESFilmicToneMapping`
- `:74` `PMREMGenerator`

`grep -rn "InstancedMesh" src/ tools/` returns **nothing** — there is no instancing
anywhere. There is also **no FPS or frame-time instrumentation** in `src/`.

**Correction:** an earlier draft said `performance.now` appears only in the input tap timer
and the frame clock. It also drives `lastTouchAt` in `src/input/input.ts`, which powers the
`TOUCH_COMPAT_MS` mouse-suppression window. The load-bearing half — that nothing measures
frame time — holds.

### The frame loop clamps, so a slow phone degrades gracefully

`src/game/frame.ts:26` `MAX_FRAME_DT = 0.25` with the comment "At 0.25 a stall costs at most
15 ticks, whatever its length"; `planFrame` (:55-60) is a closed form, not a drain loop. A
slow device gets choppy, not a death spiral.

### Camera framing at phone aspects — partly covered already

`src/render/framing.test.ts:20` is
`const ASPECTS = [0.46, 0.75, 1.0, 1.33, 1.6, 1.78, 2.33, 3.0]`, commented "Portrait phone
through to ultrawide", and the coverage table at :204-209 already carries
`['phone landscape', 2.16]`. So 19.5:9 portrait (0.4615) and phone landscape are **already
in the grid** — an earlier draft proposed adding them. Genuinely untested are **0.42** (20:9
portrait) and **2.39** (21:9 landscape).

Two real limitations remain: the `ASPECTS` sweep runs against `CURRENT_ARENA` only
(`framing.test.ts:13-16`), i.e. one arena x 8 aspects, while the coverage block is 4 arenas x
4 aspects; and `docs/superpowers/backlog.md:402` records that below aspect ~0.249
`fitCameraToArea`'s bisection bracket returns a cropping camera, with :418 noting
"Embeddings that can set an arbitrary aspect … were never considered."

### No PWA scaffolding, and no privacy policy

`grep -rniE "manifest.webmanifest|serviceWorker|beforeinstallprompt|apple-touch-icon"` over
`src/`, `index.html`, `public/` and `tools/` returns zero lines. `grep -rni "privacy"` over
`src/`, `README.md`, `docs/`, `index.html` and `CREDITS.md` returns zero lines.

This matters twice. A TWA on Google Play is built on top of an installable PWA, so the TWA
route starts further back than the Capacitor route does. And Google Play requires a
privacy-policy URL for **every** app:
"[Even developers with apps that do not collect any user data must complete this form and
provide a link to their privacy policy.](https://support.google.com/googleplay/android-developer/answer/10787469)"
(checked 2026-08-09).

### There are TWO runtime dependencies

`package.json` declares `howler ^2.2.4` and `three ^0.169.0`. Nothing else at runtime, no
analytics, no SDKs. Both privacy questionnaires would be near-empty — Apple's app-privacy
declaration has nothing to declare, and Google's Data safety form still must be *completed*
and still requires the policy URL even when every answer is "no data collected or shared".

---

## Platform rules and costs

Every line below was fetched from a primary source. **Dates are the dates checked.** None of
these pages carries a last-updated stamp unless noted.

| Item | Value | Source | Checked |
|---|---|---|---|
| Apple Developer Program | "The Apple Developer Program is 99 USD per membership year." Individual enrolment needs an Apple Account with 2FA and legal name. | [developer.apple.com/programs/enroll](https://developer.apple.com/programs/enroll/) | 2026-08-09 |
| Play registration | "There is a US$25 one-time registration fee" | [support.google.com/.../answer/6112435](https://support.google.com/googleplay/android-developer/answer/6112435) | 2026-08-09 |
| Play closed-test gate | "you must run a closed test for your app with a minimum of 12 testers who have been opted-in for at least the last 14 days continuously"; applies to personal accounts created after November 13, 2023 | [support.google.com/.../answer/14151465](https://support.google.com/googleplay/android-developer/answer/14151465) | **re-verified 2026-08-10** |
| Apple SDK floor | "Starting April 2026, apps and games uploaded to App Store Connect need to meet the following minimum requirements: iOS and iPadOS apps must be built with the iOS 26 & iPadOS 26 SDK or later" (article dated 2025-09-09) | [developer.apple.com/news/?id=6lxhtioi](https://developer.apple.com/news/?id=6lxhtioi) | 2026-08-09 |
| Play API floor | "New apps and app updates must target Android 16 (API level 36) or higher" from **August 31, 2026**; "You will be able to request an extension to November 1, 2026" | [support.google.com/.../answer/11926878](https://support.google.com/googleplay/android-developer/answer/11926878) | **re-verified 2026-08-10** |

The Play API-36 deadline is **21 days from 2026-08-10**. Any Android submission after that
date must target API 36.

### Apple Guideline 4.2 is the real review hurdle

Verbatim from the
[App Store Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)
(checked 2026-08-09; the page shows no last-updated date):

> **4.2 Minimum Functionality** — Your app should include features, content, and UI that
> elevate it beyond a repackaged website. If your app is not particularly useful, unique, or
> "app-like," it doesn't belong on the App Store.

4.7 opens "Apps may offer certain software that is not embedded in the binary, specifically
HTML5 and JavaScript mini apps and mini games, streaming games, chatbots, and plug-ins."
**My reading — not Apple's statement — is that 4.7 does not attach**, because a Capacitor
build embeds the whole game in the binary and offers nothing downloadable. Only a submission
settles that. 2.5.6 ("Apps that browse the web must use the appropriate WebKit framework")
is satisfied by construction (Capacitor and Tauri iOS both use WKWebView) and arguably does
not attach to a game at all.

### Google Play's webview rule does not apply; the functionality rule is the live one

Spam policy, verbatim
([answer/9899034](https://support.google.com/googleplay/android-developer/answer/9899034),
checked 2026-08-09): "We don't allow apps whose primary purpose is to drive affiliate
traffic to a website or provide a webview of a website without permission from the website
owner or administrator." austinorphan.com is this project's own domain, and a Capacitor
build does not load it at all.

The live rule is on the page titled **"Functionality, Content, and User Experience"**
([answer/9898783](https://support.google.com/googleplay/android-developer/answer/9898783),
checked 2026-08-09) — an earlier draft called this "Minimum Functionality", which is not a
section name on that page. Verbatim: "Apps should provide a stable, responsive, and engaging
user experience. Apps that crash, do not have the basic degree of adequate utility as mobile
apps, lack engaging content, or exhibit other behavior that is not consistent with a
functional and engaging user experience are not allowed on Google Play." A four-level arena
shooter with progression, achievements and stats is not a static app — though Play
enforcement here is discretionary and this is a judgement, not a guarantee.

### Age rating

Apple's tiers
([developer.apple.com/help/app-store-connect/reference/age-ratings](https://developer.apple.com/help/app-store-connect/reference/age-ratings/),
checked 2026-08-09): 9+ covers "Infrequent cartoon or fantasy violence" and "Infrequent guns
or other weapons"; 13+ covers "Frequent cartoon or fantasy violence", "Infrequent realistic
violence" and "Frequent guns or other weapons". Continuous weapon fire is the core loop, so
**13+ is the likely self-declaration** — but that is a judgement Apple can override, and
Google Play's rating comes separately from the IARC questionnaire, which was not read.

> **UNSUPPORTED:** the description of these as a "2025-overhauled system". The tier table is
> primary and current; the overhaul date is not sourced.

### Wrapper comparison

The axis that matters is whether the three.js renderer survives untouched.

- **Capacitor** — yes. WKWebView on iOS, Android System WebView on Android, both WebGL2.
  Capacitor 8 shipped 2025-12-08 with SPM default on iOS and built-in edge-to-edge support
  via a new internal SystemBars plugin
  ([ionic.io/blog/announcing-capacitor-8](https://ionic.io/blog/announcing-capacitor-8),
  checked 2026-08-09). **Its floors, from the primary updating guide
  ([capacitorjs.com/docs/updating/8-0](https://capacitorjs.com/docs/updating/8-0), checked
  2026-08-09): `minSdkVersion` 24, `compileSdkVersion` 36, `targetSdkVersion` 36, Xcode
  26.0+, iOS deployment target 15.0, and "Capacitor 8 requires NodeJS 22 or greater".**
  That last one **conflicts with this repo's declared floor** — `package.json` `engines` is
  `^20.19.0 || ^22.13.0 || >=24.0.0` and CI runs on Node 20.19.0 and 22. The wrapper's build
  toolchain would need Node 22+, which is a decision to record rather than discover.
  (An earlier draft said Android API 23+; the primary doc says 24.)
  > **UNSUPPORTED:** "Capacitor is MIT-licensed" — trivially checkable in the
  > `ionic-team/capacitor` LICENSE file, but not checked for this document.
- **Tauri v2** — yes, same two WebViews on mobile. Stable since 2024-10-02
  ([v2.tauri.app/blog/tauri-20](https://v2.tauri.app/blog/tauri-20/)). It adds a Rust
  toolchain and 4 Android + 3 iOS Rust targets for a game that needs no native code, and
  "iOS development requires Xcode and is only available on macOS"
  ([v2.tauri.app/start/prerequisites](https://v2.tauri.app/start/prerequisites/), both
  checked 2026-08-09).
- **TWA** — Android only. Requires Digital Asset Links verification and Chrome 72+, and TWAs
  "need to meet the same Add to Home Screen requirements"
  ([developer.chrome.com/docs/android/trusted-web-activity](https://developer.chrome.com/docs/android/trusted-web-activity/),
  checked 2026-08-09) — which is why the TWA route starts further back: there is no PWA
  manifest in this repo yet.
  > **UNSUPPORTED:** an earlier draft said a TWA "falls back to a Custom Tab toolbar without
  > asset-link verification". The cited page attributes the Custom Tab fallback to the
  > user's Chrome version not supporting TWAs, and says nothing about failed asset-link
  > verification.
- **React Native WebView** — a whole RN runtime to host a WebView that Capacitor hosts with
  less. No reason to pick it here.

> **UNSUPPORTED:** "WKWebView gets the JIT, which is why an iOS WebView game is viable at
> all." Only secondary sources were found (construct.net, hackingwithswift.com); no Apple or
> WebKit document states it directly. The closest signal is WebKit bug 191822 ("Add SPI to
> disable JIT in a WKWebView"), which implies it is on by default. Unstated residual:
> Lockdown Mode disables JIT, so the claim would not be unconditional even if sourced.

---

## Blockers

1. **iOS cannot be built from this machine.** An iOS build requires Xcode on macOS, and from
   April 2026 specifically the iOS 26 SDK. This environment is Linux (`Linux 6.17.13-2-pve`).
   No amount of work in this repo removes it — it needs Mac hardware or a hosted macOS CI
   runner, plus the $99/year membership before anything can be uploaded.
2. **Play's 12-testers-for-14-continuous-days rule is a calendar wall.** Twelve real humans
   with Google accounts, opted in continuously. Start it early.
   > **UNSUPPORTED:** whether the 14-day clock *resets* if the count dips below 12. The
   > source says "opted-in for at least the last 14 days continuously"; a reset rule is an
   > inference from that wording, not something Google states on that page.
3. **Mobile GPU performance is entirely unmeasured.** `antialias: true`, a 2048² PCFSoft
   shadow map, three directional lights, ACES tone mapping, a PMREM environment map, DPR up
   to 2, no instancing. Nobody can size the port, or choose between shipping as-is and
   building quality presets, without a frame time from a real device — and there is no FPS
   instrumentation in the repo to produce one.
4. **No safe-area handling, and the Fire/Mine buttons sit in the home-indicator strip.** See
   above. This is the difference between a build that works and a build that reads as a port.
5. **Apple Guideline 4.2 review risk, which only a submission resolves.** Everything that
   reduces it — safe areas, orientation, haptics, a native splash, no visible browser chrome
   — must land *before* the first submission, because each rejection round trip costs days.
   > **UNSUPPORTED:** "Apple has no pre-submission ruling process for 4.2" (an absolute with
   > no source) and "TestFlight goes through Beta App Review against a lighter bar" (Beta
   > App Review exists; "lighter bar" is an unsourced characterisation).
6. **No privacy policy exists**, and Play requires a URL for one even at zero collection.
7. **Existing web saves do not survive the move**, and there is no export path.

---

## Open questions

1. **What frame time does the shipped bundle hold on a mid-range Android?**
   Serve `dist/` to a real phone over the LAN, add a temporary frame-time probe around the
   render call in `src/game/driver.ts`, and record p50/p95 ms over three 60-second rounds on
   arena-04 (45x33, six enemies) with particles live. Report the distribution, not an
   average. **Until that number exists, every statement about the port's viability is a
   guess.**
2. **Which render knob buys the most FPS per unit of visual loss** — shadow map 2048→1024,
   antialias off, pixelRatio cap 2→1.5, or dropping the fill/rim lights?
   A one-variable-at-a-time sweep *on device* against the probe above, same arena and seed
   each pass. `npm run gallery --sweep` already patches constants in `src/` between passes
   and restores them; it has just never been pointed at a phone. Prove the knob is wired
   first — identical p50 across passes means a dead knob.
3. **Does a WKWebView-hosted build clear Guideline 4.2?** Not answerable from
   documentation. Budget for one rejection round trip.
4. **Does the 250 ms tap window survive inside a WebView under render load?**
   `src/input/touch.ts` already records the hazard: timestamps come from when the main
   thread *handles* the event. Re-run that probe inside the wrapper on the target device. If
   real taps exceed 250 ms, the file already names the fix (raise the window under `stick`,
   where a stationary touch has no aiming meaning) — but that needs the number first.
5. **Portrait or landscape-locked?** Render arena-04 at 0.42, 0.46, 2.17 and 2.39 through
   the gallery and look at the coverage. If portrait crops the arena, lock landscape in the
   native manifest/plist rather than fighting the camera.
6. **Capacitor or Tauri v2?** Both preserve the renderer identically, so the deciding
   factors are plugin ecosystem and toolchain weight — plus Capacitor 8's Node 22+
   requirement against this repo's Node 20.19.0 floor. Enumerate the native surface actually
   wanted (my read: haptics, orientation lock, edge-to-edge, splash, nothing else) and check
   it against both. If the list stays short, Capacitor's zero-Rust toolchain wins on setup
   cost.
7. **Is a save export/import worth building?** A product decision. Answer "no" explicitly if
   that is the answer, so it stops being an unexamined risk.
8. **What does the IARC questionnaire return for a bloodless top-down tank shooter?** It is
   free and instant in Play Console and returns ESRB/PEGI/USK simultaneously. The IARC
   questionnaire text was not read, so nothing here predicts it.

---

## What a first PR would be

**Safe areas.** It is the highest-value pre-wrapper change and it improves the *web* build
too, since iPhone Safari in landscape has the same insets. Add `viewport-fit=cover` to
`index.html`'s viewport meta, then inset `.hud-topbar` and `.hud-touch` by
`max(14px, env(safe-area-inset-*))`. Both guard files already exist and already pin adjacent
facts, so the assertions have obvious homes: `src/game/index-html.test.ts:45` pins the
viewport meta by regex (`/name="viewport"[^>]*width=device-width/`, which would *not* break
if `viewport-fit=cover` were appended), and `src/game/hud.css.test.ts:140` pins the
required-selector list including `.hud-touch`. **Prove the gap first:** the current CSS has
zero `env(` occurrences, so a test asserting one fails today.

Size: **S**, half a day to a day. Biggest unknown: whether the absolutely-positioned panels
(achievements, stats, customize) also need insets, which needs eyes on a notched device
rather than reasoning.

Other PR-able items, filed as issues alongside this document: a web app manifest and
apple-touch-icon; pinning camera framing at 0.42 and 2.39; extracting the storage resolver
into its own module (and fixing `CLAUDE.md`'s four-vs-five); a save export/import over the
five keys; the privacy policy; a haptics seam fed by the `SimEvent` stream; and a render
quality preset behind a dev flag.
