# Backlog

Spikes and deferred work. Each entry says what the question is and what would answer it —
not a plan, just enough that the next person does not re-derive the context.

---

## Spike: pathfinding and risk-aversion weights in the movement AI

**Raised 2026-08-02**, while specifying the arena resolution change.

**The question:** should enemy movement gain (a) real pathfinding, and (b) per-profile
risk-aversion weights that make some tanks avoid exposure rather than only avoid bullets?

**Why it is live now.** Three separate findings in one session all point at the same gap:

1. **There is no pathfinding at all.** `grep -rlniE "pathfind|navmesh|a-?star|bfs|dijkstra"
   src/sim` returns nothing. `seekMove` is a wander heading plus a distance band relative to
   the player — purely reactive steering.
2. **The corridor minimum makes that worse.** At the 1.3-tank minimum a tank has 0.167
   clearance per side, three times tighter than today's 2.0 corridors. Reactive steering
   through a maze of minimum-width corridors will scrape and may jam; `wallBlocksStep`'s
   one-step probe is the only thing standing between those.
3. **One-way ledges need it, or need designing around it.** An enemy that chases the player
   over an irreversible drop cannot deliberately come back. The geometry spec's answer is a
   strong-connectivity rule so a ledge is always a shortcut, never a trap — that works, but
   it is a constraint on every future level rather than a capability in the AI.

**Risk aversion is the separate half.** Profiles already carry `aggression`,
`retreatChance`, `preferredDistance` and `minimumDistance`, and `dangerAvoidMove` dodges
bullets and flees armed mines — but nothing weighs *positional* risk. A tank has no notion
that a long open sightline is dangerous, or that a green sniper's bank lanes cover the
ground it is about to cross. That is what would make a "defensive" tank read as defensive
rather than as "a tank that backs up sometimes".

**What would answer it:**

- Measure how often reactive steering actually jams in minimum-width corridors. Build one
  maze board at `cellSize 2/3` with 1.333 corridors, run the seeded pacifist harness, and
  count ticks where an enemy's `desiredMove` is non-zero but its position does not change.
  If that number is small, pathfinding is a polish item; if it is large, it is a blocker on
  maze-like levels and should land before the difficulty curve's later stretches.
- Prototype the cheapest thing that could work: a flow field over the traversable lattice
  the clearance rule already computes (`spec: arena geometry`), regenerated when
  destructibles change. The lattice exists for validation anyway, so the marginal cost may
  be small. Compare against the pacifist metric — the AI's headline number — before and
  after.
- For risk aversion, the smallest real experiment is a single new profile field weighting
  "cells visible to a live enemy" against path length, scored on the same lattice. It
  composes with the existing `seekMove` rather than replacing it.

**Constraint that shapes any answer:** `src/sim/` is pure and deterministic. Any pathfinding
must be a pure function of world state — no caching that survives across `step()` calls
unless it lives in `World` and is cloned correctly, or replays stop being exact functions
of their inputs.

**Not scheduled.** Recorded so it is not rediscovered a fourth time.

---

## Follow-ups from "walls as geometry, not cells"

**Raised 2026-08-02**, by the final review of the arena-resolution branch. All four were
consciously deferred, not missed. None blocks that branch.

**1. Wall normal maps tile at the wrong density — on BOTH families, and the larger effect
is on the unmerged one.** `concreteNormal` (`repeat=(2,2)`) and `timberNormal`
(`repeat=(1,1)`) are single shared textures, and `BoxGeometry`'s per-face UVs are
size-independent, so neither is scaled to the mesh.

- **Destructible (not merged), the bigger change:** cells went 2.000 -> 0.667 units, so
  timber grain went from 2 grooves per unit to 6, a 3x density INCREASE, with a UV restart
  every 0.667 units. Re-measured in review as **visible at 1x**, not only under
  magnification — countable hatching in an unscaled 1280x800 capture of level 2's barrier.
- **Merged solids:** density falls by the merge factor instead; worst anisotropy per arena
  went 2.0:1 before to 6.0:1 / 8.0:1 / 4.0:1 / 6.0:1 (arena-01/02/03/04) after.
- The boundary ring is unaffected — marginally better, 26:1 -> 23:1.

An earlier version of this entry described only the merged half and called it "not visible
at gameplay zoom"; that was measured on the merged pillar alone and does not hold for the
destructible cells. The fix is larger than scaling the repeat: the texture is shared across
every wall, so it needs a clone per wall (or per distinct extent).

**2. arena-02's boundary-flush run can be escaped past the ring.** Its rows 12-14 put three
destructible cells against each side boundary, so the escape march's horizontal exit beats
the vertical one and some interior starts resolve outside the ring. Re-measured with the
population stated (an earlier draft of this entry and the comment in `collision.test.ts`
carried the same numerator against two different denominators, 20,000 and 160,000):
**154 of 159,201** hull centres on a 0.05 grid across the playable rect [0,22]x[0,18].
**Not reachable at the depths the sim produces**: the shallowest such start is **0.720
units** from the nearest legal hull centre, against the 0.375-unit shove `world.ts:99`
documents, and mine blasts only shrink
the region (0 of 633,600 at >=50% destruction). A 57,600-tick probe (4 arenas x 12 seeds x
1200) saw 0 tanks outside, 0 inside a wall, 0 shells escaped — but that samples end-of-tick
only and does not bound mid-`stepMovement` depth across the three
`separateTanks`/`resolveWalls` alternations. What would close it: sample inside that loop.

**3. `loop.test.ts` asserts "an AI fired within N frames".** That window moves whenever AI
RNG timing moves, and it moved twice on this branch (widened 12 -> 30 frames when tank ids
were renumbered). It should assert a specific deterministic event instead of a time bound.

**4. Wall mesh and material count rose 1.6x-4.1x.** arena-02 went 20 -> 81 wall entities, and
`render/entities.ts:568` allocates a `BoxGeometry` AND a material per wall. Destructible
cells are 3x subdivided and never merge, which is deliberate — but nothing has measured the
render cost, and the growth is entirely in the destructible family.

---

## Spike: intensity granularity, and a destination set by the level

**Raised 2026-08-03**, from the item PR #76 (`60bdcfa`) left explicitly open: "the
granularity of the signal itself -- arena-01 has 3 enemies, so intensity still moves in
half-scale jumps as they die; the glide softens the transit, not the destination."

**The question:** should the musical intensity a level reaches — where it starts, where it
ends, and how finely it moves in between — be a function of that level's difficulty,
instead of the same 0..1 kill fraction in every level?

`musicIntensity` (`game/loop.ts:189`) is `destroyed / (total - 1)`, where `total` is
`enemiesAtRoundStart`. Two consequences, both structural rather than a tuning miss:

- **The granularity IS the enemy count.** The step is `1 / (total - 1)`, so a level's
  musical resolution is decided by how many tanks its grid happens to spawn.
- **The destination is 1.0 everywhere.** The last kill of level 1 asks for exactly the
  arrangement the last kill of level 4 asks for. Nothing in the signal knows which level
  it is — though `level` (`loop.ts:319`) is in scope at the call site (`loop.ts:421`) and
  simply is not read.

**Measured at `60bdcfa`.** Population: the 4 shipped arenas × the 24 distinct members
named by an `arena`-context suite in `music-suites.json` — 96 (arena, member) pairs. Each
pair replays the arena's reachable intensity values through the gate rule `layer sounds
iff layer.intensity <= intensity`, and compares the resulting layer sets:

| arena | enemies | reachable intensities | members reaching fewer tiers than authored | members whose first kill changes no layer | members whose last kill changes a layer |
|---|---|---|---|---|---|
| arena-01 | 3 | 0, .5, 1 | 12 of 24 | 0 of 24 | 18 of 24 |
| arena-02 | 4 | 0, .333, .667, 1 | 12 of 24 | 24 of 24 | 18 of 24 |
| arena-03 | 5 | 0, .25, .5, .75, 1 | 6 of 24 | 24 of 24 | 6 of 24 |
| arena-04 | 6 | 0, .2, .4, .6, .8, 1 | 12 of 24 | 24 of 24 | 0 of 24 |

Totals: 42 of 96 pairs reach fewer distinct arrangements than the member authored distinct
gate values — no kill count lands in the missing band. 72 of 96 open with a kill that
moves no layer at all. Every arena tops out at exactly 1.0.

**The last two columns run backwards.** On arena-04 — six enemies, the level with the green
ricochet sniper — the arrangement is already full at 0.8, so the kill that ends the hardest
level is musically silent in 24 of 24 members. On arena-01, three enemies and the first
level anyone plays, the fullest arrangement arrives exactly on the last kill in 18 of 24
(population: the same 24 members). The easiest level gets
the payoff the hardest one does not.

**What would answer it:**

- **Cheapest experiment for the destination half:** an affine remap, `lo(level) +
  (hi(level) - lo(level)) * kills`, with `lo`/`hi` per level. Level 1 need never reach the
  top of the arrangement; level 4 could open above the floor. That is a change to one
  expression plus a data lookup, and the table above is already the metric — recount
  unreachable tiers and check the per-level ordering comes out monotone rather than
  inverted.
- **For the granularity half**, the signal needs a term that is not a kill count. Candidates
  in reach of `loop.ts` without new plumbing: lives remaining, shells in flight, distance
  to the nearest live enemy, elapsed round ticks. A continuous term also removes the
  dependence on `total`, which is what makes resolution an accident of the grid.
- **Then listen — and this time write down what you heard.** #76 ended "Nobody has
  listened to any of this", which is no longer true: the game has been played and the
  audio has been heard. What is still missing is a *recorded judgement* on the thing this
  entry is about — whether the intensity transitions above land, and which of the
  inversions in the last two columns is actually audible in a round. Any curve chosen here
  stays a guess until someone plays it and states a verdict; the numbers above bound what
  is *possible* to hear, not what sounds right, and no verdict exists in the tree.

**Constraints that shape any answer:**

- **Stays out of `src/sim/`.** Intensity is computed in `game/loop.ts` and pushed into the
  audio engine; the sim never sees it, and a difficulty term must not migrate inward or
  replays stop being exact functions of their inputs.
- **The #76 glide is a rate limiter, not a shaper.** It walks the sounding density toward
  the target over `INTENSITY_GLIDE_SECONDS` (2.0). Changing the destination changes what
  the walk arrives at; it does not change the walk.
- **Respawn is part of this.** `enemiesAtRoundStart` is recomputed in `switchTo`
  (`loop.ts:484`) — per LEVEL, not per round — so losing a life still takes the target from
  1.0 to 0.0. A per-level floor shortens that fall, which is half the appeal.
- **`total <= 1` returns 1.** A one-enemy round sits at the full arrangement start to
  finish. Not reachable in a shipped level (the minimum is 3) but reachable today via
  `?dev=1&level=sandbox&tanks=brown`.
- **If the difficulty term becomes data**, `arenas.json` is the validated home for it and
  `validateArenas` the place a bad edit should fail — not a new parallel table.

**Not scheduled**, and its blocking half is now tracked as issue #89 (a model for level and
per-tank difficulty) — this entry stays because the measurement is the decision record; the
work it unblocks is the issue. Recorded so #76's deferral does not have to be rediscovered
from a commit message.

---
## Deployment residuals, measured while shipping the GitHub Pages workflow

**Raised 2026-08-03**, reviewing PR #80. Measured against the live `austinorphan.com`
Pages infrastructure using sibling project sites of the same account, because `/tanks/`
was not yet deployed.

**1. ~~The ten missing audio files cost 91.6 kB on every load~~ — CLOSED.** The manifest
no longer declares files that do not exist, so the ten requests are gone (measured on the
built bundle: 10 → 0). The entry stays only as the record of the measurement, because the
figure is quoted elsewhere: a GitHub Pages 404 body is 9,379 bytes and carries no
`cache-control`, so the cost was 93,790 bytes and 10 round trips on EVERY load, never
cached — re-measured directly against the deployed `/tanks/` rather than sibling sites,
10 of 10 requests, all 404, all uncached. The decision taken was the second of the two the
original entry named: stop requesting files that are not there, and let `src/audio/synth.ts`
be the voice rather than the fallback. `CREDITS.md`'s licensing policy is unchanged and
still unexercised — committing a real set remains open as issue #86.

**2. A service worker this repo does not own controls `/tanks/`.** The portfolio root
registers `navigator.serviceWorker.register("/sw.js")`, served from the origin root with no
`Service-Worker-Allowed` header, so its scope is `/`. It calls `clients.claim()`, and its
`activate` handler deletes every CacheStorage entry not named `austin-orphan-portfolio-v2`.
Harmless today — its precache list is `/`, `/blog`, `/rss.xml`, and `caches.match` is keyed
by exact URL, so every game request falls through to `fetch`. But any offline/precache work
here would be silently wiped whenever a player visits the portfolio, and if that worker
gains runtime caching the game would serve stale hashed assets with no way for this
pipeline to invalidate them. Not fixable from this repo. **UNVERIFIED:** the scope is
derived from the spec and the absent header, not measured in a browser —
`navigator.serviceWorker.getRegistrations()` on a deployed `/tanks/` page would settle it.

**3. HTTPS cannot be enforced through GitHub, because Cloudflare proxies the domain.**
`http://` and `https://` are different localStorage origins, and all five save keys
(`tanks.progress.v1`, `tanks.stats.v1`, `tanks.achievements.v1`, `tanks.custom.v1`,
`tanks.touch.v1`) are
origin-scoped, so anything built on the http origin vanishes when HTTPS is enforced. The
obvious fix does not work: `PUT /repos/AustinOrphan/tanks/pages -F https_enforced=true`
returns `"The certificate has not finished being issued"`. The reason is structural, not
transient — **all five** of the account's Pages sites report
`https_certificate.state: "bad_authz"` with the same `expires_at: 2026-07-24`, including
the apex, which already has `https_enforced: true` and serves fine. `austinorphan.com`
answers with `server: cloudflare` and a `cf-ray` header while `austinorphan.github.io`
answers `server: GitHub.com`, and the cert on the wire is a Cloudflare wildcard
(`SAN: *.austinorphan.com`) rather than the `[austinorphan.com, www.austinorphan.com]`
pair GitHub's record wants. GitHub's ACME challenge is answered by Cloudflare's edge, so
its authorization can never complete. The equivalent lever is **Cloudflare → SSL/TLS →
Edge Certificates → Always Use HTTPS**, which covers every project page on the zone at
once; the alternative is unproxying DNS, at the cost of the CDN.

**4. Copying `index.html` to `404.html` would break the site.** Pages serves a real 404 and
the game has no client-side router, so nothing needs the SPA fallback today. But that trick
is one file away and `base: './'` cannot survive it: `/tanks/foo/bar` would serve an
`index.html` whose `./assets/…` resolves to `/tanks/foo/assets/…`. This is *the* known
failure mode of a relative base.

**5. Untested claim, recorded rather than asserted:** the deploy builds only on Node 22
while `ci.yml` also builds on 20.19.0. Whether the two produce byte-identical bundles is
unmeasured. Nothing ships from the 20.19.0 build, so there is no path to the live site —
but "some CI job already built this bundle" is not a thing anyone has shown.

**6. No Open Graph or canonical tags** in `dist/index.html` (0 matches for
`og:|twitter:|rel="canonical"`), so sharing the link gives no preview card.

---

## Customize preview residuals, deferred while shipping the live tank preview

**Raised 2026-08-09**, shipping PR #102 (`src/render/preview.ts`, a second WebGL
context for the Customize panel's live tank preview).

**1. `webglcontextlost` is unhandled, for either renderer, and low-end eviction is
unmeasured.** The preview's peak-2-contexts design is checked against a typical
browser's commonly-cited cap (8-16) and against one real Chromium run holding both
contexts at once — not against actual eviction on constrained hardware, and not
against how the MAIN game renderer would behave if the browser ever reclaimed its
context while the preview also held one. Neither `render/renderer.ts` nor
`render/preview.ts` listens for the event. Needs a measurement (a real low-end
device, or a forced context loss in a browser) before anyone could write the fix
with confidence, which is why this is recorded rather than left as an unstated gap.

**2. Preview camera/light-rig constants were chosen by eye, not measured.**
`PREVIEW_AREA_W`/`PREVIEW_AREA_H`, the camera FOV, and the key/fill/ambient light
positions in `preview.ts` were tuned against one screenshot, in the spirit of this
repo's other "feel, not measurement" constants (see CLAUDE.md) — but unlike those,
nothing here says so at the constant's own definition. Cheap to retune; nobody has
compared candidates with `npm run gallery --sweep`.

**3. No `npm run gallery` element for the preview.** Every other rendered element
(tank, mine, shell) has a gallery entry for eyeballing changes without booting the
full game; the preview does not, so verifying a future retune still means opening
the real Customize panel by hand or re-running the GL harness.

---

**4. The preview's lens and the arena's are deliberately different, and neither is
pinned.** `preview.ts`'s `FOV` is 50 while `scene.ts`'s `BASE_FOV` is 30 -- a close-up
at 30 would push the camera far enough out to read flat. But the two were never
rendered side by side, and mutating `FOV` 50 -> 30 leaves both gates green (1563 tests,
39 GL checks), so nothing would catch a change either way. The previous comment claimed
the two matched and went stale silently when #103 moved `BASE_FOV`; review caught it,
and the comment now asserts no relationship rather than a false one. Needs eyes, not a
test. #102

---

**Raised while making the preview interactive** (`src/render/preview-controls.ts`, the
hull turntable and the turret aim).

**5. The preview's indefinite render loop, and its COST, still unmeasured — and it now
runs for TWO reasons.** Its behaviour is gated: five async checks in `tools/gl/harness.ts`
run on the real `requestAnimationFrame` and measure that the idle spin turns the tank
(23069 of 197600 bytes in 500ms), that a hover stops the spin permanently for a
non-animated skin, that an animated skin keeps repainting afterwards (23584 of 197600
bytes in 500ms) and comes to rest when a static one is picked, and that nothing repaints
after dispose. What none of them says is what it costs: while the Customize panel is open,
a second WebGL context repaints a 260x190 canvas every frame, indefinitely, with no
timeout and no `document.hidden` check. Nobody has measured that against battery or
against a low-end device, and "stop after N seconds" was considered and not done because
the stopping condition would then be invisible to the player.

The animated skin was hung on this SAME loop rather than given a second one, precisely
because this entry is still open: a second indefinite repaint would double a cost nobody
has a figure for. That is a reason to prefer one loop, **not** evidence that one is cheap.
What did change is the floor — an untouched panel showing a static skin now stops
repainting entirely once the spin ends, where before the spin was the only loop and the
same was true; the new case is `flow`, which repaints for as long as the panel is open.
(This entry replaces an earlier one saying the spin ran under no gate at all; that was
true when it was written.)

**6. `prefers-reduced-motion` is read in `preview.ts` and nothing covers that read.**
`createPreviewControls` takes the flag as a parameter and both branches are tested; the
`window.matchMedia` call that supplies it lives inside `createTankPreview`, which returns
null under jsdom, so no test reaches it. The optional-chaining fallback for an absent
`matchMedia` is likewise unexercised.

**7. Pointer capture is unverified.** `setPointerCapture` is what keeps a drag alive once
it leaves the 260px canvas, and neither gate can see it: jsdom does not implement capture
semantics (the call is inside a try/catch for exactly that reason), and the GL harness
dispatches events directly at the canvas, which needs no capture. "A drag that runs off
the preview keeps turning the hull" is therefore claimed by construction, not measured.
The `groundPointFromPointer` null-on-miss path exists for that case and IS tested.

**8. Four more feel constants, two of them partly pinned and two not at all.** An
earlier draft of this entry called all four unpinned; review disproved it, and the
corrected version is below. Each is swept against `preview-controls.test.ts` AND
`preview.test.ts` — the first draft ran only the former, which is how it got the answer
wrong, and is a reminder that a mutation sweep's denominator includes the files it was
pointed at.

- `HULL_DRAG_RAD_PER_PX` (0.012) — **bounded on both sides**, by the scene-graph
  turntable check in `preview.test.ts`: a 100px drag has to leave the hull's near face
  at `x > 0.2` and `z > 0`, which is true only for roughly 0.0021 to 0.0157 rad/px.
  0.0005 and 0.018 both fail. Inside that band it is free.
- `TURRET_AIM_DEAD_RADIUS` (0.12) — **pinned against zero only.** Setting it to 0 kills
  2 cases; 0.36 survives, because the sweep test derives the boundary from the constant.
  What is pinned is that a dead zone exists, not how big it is.
- `IDLE_SPIN_RAD_PER_SEC` (0.35) — **unpinned.** x10 survives both files.
- `KEY_STEP_RAD` (pi/24) — **unpinned.** x12 survives both files.

Nothing in the tree records anyone having used the panel on a phone, and the drag rate is
the one most likely to be wrong there. The game HAS been played — that is not the gap. The
gap is that no judgement on these four constants has been stated on any device, and
`HULL_DRAG_RAD_PER_PX` in particular is a touch constant whose only evidence is a mouse.

**9. `tools/` is not typechecked by anything.** `tsconfig.json`'s `include` is
`["src", "vite.config.ts"]`, so `npm test`'s `tsc --noEmit` never reads
`tools/gl/harness.ts`, `tools/gallery/`, `tools/baseline/` or the rest — and vitest
transforms without typechecking. This is not new, but it was found the hard way while
adding the async GL checks above: a duplicate `checkAsync` declaration passed `npm test`
cleanly and surfaced only as a vite 500 when the harness was actually loaded, which
`npm run test:gl` reports as a bare timeout with no error text. So the GL harness is
checked only by running it, and a typo there costs a 30-second timeout to diagnose.
Widening `include` was not attempted here and may surface pre-existing errors.

---

## Spike: mobile app release (iOS App Store / Google Play)

**Raised 2026-08-10**, from a four-part release investigation.
**Document: `docs/research/mobile-release.md`.**

**The question:** should Tanks! ship as a wrapped mobile app, and if so on which platform
first?

**Why it is live now.** The tree is unusually ready for a wrapper and nobody has said so in
one place: `grep` finds exactly 1 non-test occurrence of `fetch(`/`XMLHttpRequest`/`import(`
across `src/` (a type-position import at `audio/music.ts:86`), `public/audio/` holds only a
`.gitkeep`, and `base: './'` already emits `./assets/…`. Touch controls, gesture
classification, `pointercancel`/`blur`/`visibilitychange` recovery and the iOS audio-unlock
gesture path all ship today. What is missing is the store-quality shell — and one number.

**What would answer it:**

- **The gating measurement is frame time on a real mid-range Android.** Serve `dist/` over
  the LAN, add a temporary probe around the render call in `game/driver.ts`, and record
  p50/p95 over three 60-second rounds on arena-04. Report the distribution. Nothing in this
  repo has ever measured a frame time on a phone, and the render settings are desktop-tuned:
  `antialias: true`, a 2048x2048 PCFSoft shadow map, three directional lights, ACES tone
  mapping, a PMREM environment map, DPR capped at 2, and no instancing anywhere
  (`grep -rn InstancedMesh src/ tools/` returns nothing). **Until that number exists, the
  size of the port is a guess, and no estimate here is worth anything.**
- Then a one-variable-at-a-time knob sweep **on device** — shadow map 2048→1024, antialias
  off, DPR cap 2→1.5, dropping the fill/rim lights. `npm run gallery --sweep` already patches
  constants and restores them; it has never been pointed at a phone. Prove the knob is wired
  first: identical p50 across passes means a dead knob.
- Decide Capacitor vs Tauri v2 by enumerating the native surface actually wanted (my read:
  haptics, orientation lock, edge-to-edge, splash, nothing else). Note Capacitor 8 requires
  Node 22+, which sits above this repo's declared floor of 20.19.0.

**Two calendar constraints that no engineering shortens**, both re-verified 2026-08-10: a
personal Play account created after 2023-11-13 must run a closed test with **12 testers
opted in for 14 continuous days** before applying for production access; and from
**2026-08-31** new Play apps and updates must target API 36. iOS additionally cannot be built
from this machine at all — it needs macOS + Xcode, which is hardware, not code.

**Not scheduled.** The PR-able pieces (safe areas, a web app manifest, the storage seam, a
privacy policy) are filed as issues and are worth doing on their own merits.

**What the safe-area / manifest / framing PR left open** (issues #106, #107 and #108; PR
#130). Three of these need a notched phone in a hand, which is the reason they are here
rather than in an issue — nobody can write the closing PR from this machine.

- **Do the absolutely-positioned panels need insets too?** `.hud-topbar` and `.hud-touch`
  are inset by `max(base, env(safe-area-inset-*))`; the stats, achievements and customize
  panes are not, and reasoning cannot settle it — the panes are centred overlays, so
  whether a cutout eats a Back button depends on their real measured box. What would
  answer it: open each pane on a notched device in BOTH orientations and look. If they do
  need it, the shape is already there to copy.
- **`display: standalone` or `fullscreen`?** The manifest ships `standalone` because it is
  the value both platforms honour predictably; `fullscreen` is what a game usually wants
  on Android, and iOS's handling of it was not verified. One install on each platform
  answers it.
- **Orientation: lock landscape, or accept a small board in portrait?** Now measured
  rather than guessed, and it is NOT a correctness question — `framing.test.ts` sweeps
  4 shipped arenas x 10 aspects and nothing crops at 20:9 portrait (0.42). It is a
  product call: the same board fills 20.8–22.9% of the frame at 0.42 against 44.4–49.4%
  at 21:9 (population: all 4 shipped arenas at each aspect), recomputed by that file's
  `measures what a phone aspect costs` tripwire. A lock would live in a wrapper's native
  manifest, which this repo does not have yet — so it is a decision for the wrapper, not
  a change to make here.

---

## Spike: console release (Steam, Switch, PlayStation)

**Raised 2026-08-10**, from the same investigation.
**Document: `docs/research/console-release.md`.**

**The question:** is any console or storefront release worth pursuing, and does it start with
content or with platform work?

**Why it is live now.** Three findings do not point the same way, and averaging them would
be wrong.

1. **Steam is unblocked but not close.** The gaps are concrete: zero gamepad code anywhere
   (`grep -rni gamepad` returns 3 doc hits, all "out of scope", and 0 under `src/`), five
   localStorage keys that Steam Auto-Cloud cannot see, 14 achievements with no external
   write path, no packaging target, and no LICENSE file.
2. **Steam Deck / Machine Verified is UNKNOWN, not a fail.** The criterion binds the default
   *controller configuration*, authored on the partner site — Valve's own recommendations
   page tells developers without native controller support to map one to keyboard/mouse. The
   real question is narrower: this game aims at a mouse POSITION, and nobody has tested
   whether a mouse-region binding plays acceptably.
3. **Switch and PlayStation are gated on approved developer status under NDA**, and no
   publicly documented licensed runtime was found that runs a TypeScript + three.js WebGL
   bundle on either. CrossCode's team AOT-compiled their JS to C++ to reach 60fps on Switch —
   a compiler project, not a port.

**What would answer it:**

- **Author a Steam Input default configuration and play it on a Deck.** That is the whole
  Verified input question, and it is cheap relative to writing a gamepad reader.
- **Does `dist/` render correctly and fast under WebKitGTK** (what Tauri would use on
  Linux/Deck), or does it require Electron's bundled Chromium? One measurement decides the
  whole shell architecture — install size, overlay behaviour, everything.
- **Do any `hud.css` em-relative font sizes compute below 9px at 1280x800?** The fixed-px
  declarations run 12px–72px and are fine; the `0.72em`/`0.85em`/`0.75em` rules are the only
  ones whose computed height cannot be read off the rule, and they were never checked.
- **Author arena-05 and time it end to end.** Four arenas and 18 enemy spawns is a demo. The
  five pin sites a new level moves are already enumerated in CLAUDE.md, so per-level cost is
  knowable rather than guessable — measure one, then multiply.
- For Switch/PlayStation there is no substitute for registering (free for Nintendo) and
  submitting a concept. **Neither platform publishes its criteria**, so nothing short of that
  converts the unknown into a fact — and the pitch is what is judged, so decide content
  first.

**Deliberately unestimated.** Console porting effort and cost are not estimated here: the
toolchains are NDA'd, and neither Nintendo nor Sony publishes devkit prices or certification
requirements. Any number would be invented.

---

## Spike: multiplayer — which mode, and does peer determinism hold?

**Raised 2026-08-10**, from the same investigation.
**Document: `docs/research/multiplayer.md`.**

**The question:** which multiplayer mode, if any, and can it be peer-deterministic or does it
need a server?

**Why it is live now.** The sim is a genuinely good netcode foundation and the game around it
is not, and the gap has never been written down. `step(world, input)` clones its argument
(`world.ts:242-243`) so every tick is already an immutable snapshot — rollback save-states,
normally the expensive part, are free. Measured on this box, `cloneWorld` is **2–7% of a
tick**, and an 8-frame rollback is roughly **0.5–1.2 ms of a 16.7 ms budget**. (Report the
contrast, not the tick number: two probes disagreed by more than 2x, and tick cost varies
2.3x across arenas — 61 µs to 144 µs — so the absolute moves when the probe moves.)

Against that, the single-player assumption is load-bearing in five places, of which issue
#120 moved one: the step boundary now takes a LIST (`stepInputs`, with `step` as a
one-argument adapter) and pairs inputs with player tanks by position, so `applyPlayerInput`
finding one tank by kind is no longer the only path. The other four are untouched.
`resolveStatus` still finds one tank by kind; the arena validator **hard-fails at module load**
on any grid without exactly one `P` (`config/validate.ts:257`); four AI target-acquisition
sites take the FIRST player found; a death resets the whole arena by `tanks[i]` ↔ `spawns[i]`
index alignment; and there is no gamepad code, so local versus has no second controller.

**What would answer it:**

- **THE gating measurement: do Chrome, Firefox and Safari produce a bit-identical baseline
  trace hash?** **Half answered 2026-08-10 (issue #121).** The rig is
  `npm run trace:browser -- --all` (`tools/baseline/{trace.ts,page.html,run.mjs}`), and one
  run each of chromium 151 (V8), firefox 153 (SpiderMonkey) and Playwright's webkit
  (JavaScriptCore) printed
  `015a5d1745ce2d3a9ca11e150b2874c10b1b8ca6d77988599787e2269fd198e4`, matching Node.
  **Still open:** shipped Safari and iOS — Playwright's WebKit is a Linux JSC build, not
  Safari — and every engine here ran on x86-64, so ARM is untested. The method for the
  rest is now known rather than unknown: open `tools/baseline/page.html` from a localhost
  server on the device (`crypto.subtle` needs a secure context). If a device diverges, the
  choice is quantizing the sim's 18 transcendental lines (bounded — 10 `hypot`, 4 `sqrt`,
  3 `cos`, 3 `sin`, 1 `atan2`) or falling back to an authoritative Node server, which is
  the most expensive design.
- **Decide win/lose semantics before touching `resolveStatus`**, which currently encodes
  exactly one answer. Co-op: is `world.lives` shared or per-player, and does one death reset
  the arena? Versus: "every non-player tank dead" and a HUD reading "Enemies remaining" mean
  nothing with no AI.
- **Decide `TankKind` vs a `controlledBy` field on `Tank`** by prototyping both far enough to
  count touched files. The kind route gets compiler help; the field route avoids four AI
  files and the spawn-letter table. The file count is the deciding number.
- **Price the zero-infrastructure option first:** manual SDP copy-paste works on the current
  static deploy today, with no signalling server at all, and would let an online prototype be
  measured before anyone signs up for Cloudflare or depends on Trystero's public relays.

**Constraint that shapes any answer:** `InputState.aim` is a world-space POINT produced by
unprojecting a mouse position against the ground plane, so it depends on canvas size. Two
peers with different window sizes produce different aim floats — the input must be quantized
at the input boundary before the sim consumes it. And `SimEvent` carries no tick field, so
re-simulation re-emits the same events and rollback needs de-duplication across all five
consumers.

---

## Spike: richer animated skins — what the offset mechanism cannot express

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


## Follow-ups from "game data plumbing" (storage resolver, save export/import, replay recorder)

**Raised 2026-08-10** by #127, which shipped issues #109, #110 and #118. All three were
consciously deferred, not missed.

**Deliberately NOT ledger lines.** The Ledger below states a measured provenance — how many
of its lines came from the PR-description harvest — and `tools/backlog.test.ts` recomputes
that split by treating every unmarked line as harvested. Appending new work there would
make that sentence say something false about where these came from, so they sit here, in
the same shape as the "walls as geometry" follow-ups above.

**1. The replay stamp cannot see CODE.** `simDataFingerprint()` (`src/game/replay.ts`) is a
canonical FNV-1a over the sim's four JSON data files — balance, tank-defs, ai-profiles,
arenas — so any DATA change invalidates a trace. A change to `targeting.ts` or
`collision.ts` diverges a replay with the fingerprint unchanged. So a mismatch proves a
trace is stale; a match does not prove it is fresh. Closing it means stamping a build
identity (a commit sha injected through `vite`'s `define`), which is a build-pipeline
change this PR did not make. Until then, treat a matching stamp as necessary and not
sufficient.

**2. An imported save is invisible until reload, and nothing enforces the reload.** Every
store snapshots its key into an in-memory shadow at CONSTRUCTION and writes back from that
shadow, so `__tanks.save.import(...)` mid-session changes nothing on screen — and the next
write from a live store overwrites what was just imported. `save.ts`'s doc comment says so
and the API is dev-flag-gated, which is the whole of the mitigation. A real fix is either a
`location.reload()` inside `import`, or a re-read path on the five stores; both are product
decisions about what an import is allowed to do to a session in progress.

**3. Nothing REPLAYS a trace back into the running game.** `replayTrace(trace, world)`
re-simulates headlessly and is what the tests use, but the loop has no path that feeds a
recorded trace to the driver in place of live input — so there is no attract-mode demo and
no "watch the bug happen" viewer yet. The pieces are in place (the decorator seam is the
same seam a player would use); what is missing is the world-rebuild-from-meta path in
`loop.ts` and a decision about what the HUD shows while one is playing.

---

## Spike: should `src/sim/` be Rust compiled to WASM?

**Raised 2026-08-10**, alongside the cross-engine determinism issue.

**The question:** should the deterministic core be rewritten in Rust and compiled to WASM?

**Why it is live now.** Two things it would buy, both real. Rust + WASM gives
**bit-identical arithmetic across platforms**, and it is worth being exact about the
mechanism rather than waving at "WASM is deterministic". Two separate reasons combine:
WASM's core `f32`/`f64` arithmetic (add, sub, mul, div, sqrt) is specified as IEEE-754 and
correctly rounded, so it cannot vary by engine; and WASM has **no transcendental
instructions at all** — `sin`, `cos`, `atan2`, `hypot` would come from Rust's `libm`
compiled *into the module*, so every peer executes the same compiled implementation rather
than whatever their JS engine ships. It is the second reason that does the work here, and
it is exactly the property the 21 transcendental occurrences in `src/sim/` do not have
today (measured 2026-08-10 and re-measured after #128: 18 lines,
21 occurrences, 4 files — `collision.ts`, `types.ts`, `ai/targeting.ts`, `bullets.ts`; 10
`hypot`, 4 `sqrt`, 3 `cos`, 3 `sin`, 1 `atan2` — unchanged by the step-inputs refactor).
Note what that means precisely: it is the *specification* that does not guarantee
agreement. Three JS engines have since been measured agreeing anyway, which the first
bullet below takes up. And it opens a **native path** — the same
crate could back a Steam or console build without a JS engine, which
`docs/research/console-release.md` records as the blocker CrossCode solved by AOT-compiling
JS to C++.

**What it would cost is the thing to weigh, and it is not small.** `src/sim/` is the part
of this codebase that already works. Rewriting it discards, or forces a re-derivation of:
the golden trace (`tools/baseline/trace.test.ts`, 4 arenas × 6 seeds × 2500 ticks), the
two-cell-size decomposition guarantees (`decomposition.test.ts`), the purity guard and its
meta-test (`purity.test.ts`), the arena claim runner (`arena-claims.ts`), and the config
catalog's load-time validation — plus every sim-side unit file. It also puts a
serialisation boundary between the sim and its five event consumers, where today
`SimEvent[]` is a plain array.

**What would answer it:**

- **First, whether the cheap fix is even needed — and the answer has moved since this
  spike was drafted.** It read "that measurement is issue #121"; #121 closed with #128,
  which built the rig AND ran it. Chromium 151 (V8), firefox 153 (SpiderMonkey) and
  Playwright's webkit (JSC) each printed the pinned
  `015a5d17…`, matching Node, with the 21 transcendental occurrences **untouched**. So the
  arithmetic argument for Rust is not merely unproven, it is running against a
  three-engine agreement. What is still open is narrower — shipped Safari, iOS, and any
  ARM engine, none of which this box can run (see the multiplayer spike's gating bullet
  above for the method) — and it is one sampled trajectory, not a proof about `Math.hypot`.
  The replacement work is issue #133, still open; **it should not be pre-empted by a
  rewrite, and neither should a rewrite be justified by a divergence nobody has observed.**
- **Second, whether multiplayer is actually being built.** Bit-identical arithmetic is
  worth a rewrite only if lockstep netcode is a commitment rather than an interest. See the
  multiplayer spike above — its gating measurement is the same one, and is half answered.
- **Third, whether a native release is a commitment.** `docs/research/console-release.md`
  concludes Switch/PlayStation are gated on NDA'd developer status and Steam is unblocked
  but not close. If no native target is committed, the second reason is hypothetical too.
- If both answers are yes, price it against a **strangler route** rather than a rewrite:
  port one leaf module (`collision.ts` is the smallest with real arithmetic) behind the
  existing TS interface, and check the golden trace hash is unchanged. If the hash cannot
  be held across the boundary for one module, it will not be held for the whole core, and
  that is the cheapest possible falsification.

**Constraint that shapes any answer:** the golden trace is the only thing that can tell you
a sim rewrite preserved behaviour. `determinism.test.ts` cannot — it asserts
self-consistency, which is invariant under behaviour change (CLAUDE.md says so, with a
worked mutation). Any port plan that does not carry the trace forward is unfalsifiable.

**Not scheduled.** Recorded because "rewrite the sim in Rust" is the kind of idea that
recurs, and the case against it — that it discards the one subsystem with no known defects
— should not have to be re-argued from scratch each time.

---

## Spike: `src/sim/` behind a real package boundary

**Raised 2026-08-10**, from the modularization pass.

**The question:** should `src/sim/` become a workspace package with its own
`package.json`, so purity is enforced by the module graph rather than by a test that reads
files?

**Why it is live now.** Purity today is `src/sim/purity.test.ts`, which scans every file
under `src/sim/` for imports of `three`, `howler` and the DOM. It is a good guard — it has
a meta-test, added after it reported green for four of five known-bad imports — but it is a
**string scan**, and this ledger already records two holes it cannot close (see the purity-guard lines under "Unpinned behaviour"): the specifier
regexes use `['"]` only, so a template-literal import specifier is invisible to it, and it
matches `Math.random`/`Date.now` as tokens, so an alias or destructure walks past it. A
package with an empty `dependencies` block closes the first class structurally: the import
would not resolve.

The second draw is that a package boundary is what would let **the identical sim run
server-side**. The multiplayer spike's most expensive branch is an authoritative Node
server; today that would mean importing out of an app's `src/` tree.

**What would answer it:**

- **Count the touched import paths before anything else.** Every file outside `src/sim/`
  that imports from it changes specifier. That count is the deciding number and nobody has
  it — `grep -rn "from '.*sim/" src/ tools/ --include="*.ts"` is the whole measurement.
- **Decide what happens to the files that straddle the line.** `src/sim/arena-claims.ts`
  imports the AI's `lineOfSight` and is imported only from the test layer; `src/sim/
  sandbox.ts` is a dev rig. Whether those ship inside the package or stay in the app is a
  decision, not a lookup.
- **Check the guards survive the move.** `purity.test.ts`, `decomposition.test.ts` and
  `tools/baseline/trace.test.ts` all resolve paths relative to the repo root today. A move
  that quietly stops running one of them is the failure mode to design against — verify by
  watching each one FAIL under a deliberate mutation after the move, not by a green run.
- **Check `tsconfig.json`'s `include` first.** It is `["src", "vite.config.ts"]`, so
  `tools/` is already untypechecked (see the preview residuals above). A workspace layout
  either fixes that or makes it worse, and which one is not obvious.

**Constraint that shapes any answer:** whatever the layout, `src/sim/` must keep importing
nothing from `three`, `howler` or the DOM, and a replay must stay an exact function of its
inputs. A package boundary is a stronger way to say that — it is not a licence to relax it.
**Do not delete `purity.test.ts` when the boundary lands.** An empty `dependencies` block
does not catch `Math.random`, `Date.now`, or a relative import that climbs out of the
package; those are the classes the scan owns, and they are the ones with no structural
replacement.

**Not scheduled**, and deliberately not an issue: it touches every import path in the tree,
so the decision has to precede the PR rather than be discovered inside it.

---

## Spike: the campaign's levels — the approved arc says "renumbered", the owner says "rewritten"

**Raised 2026-08-10.** The prompt for this spike was "the campaign's levels need
rewriting, and there is documentation for it somewhere". Both halves check out, and they
disagree with each other. That disagreement is the spike.

**What the documentation says.** It exists, and it is approved:

- **`docs/superpowers/specs/2026-08-02-difficulty-curve-design.md`** — "A taught difficulty
  curve: eleven levels, one idea at a time", marked *Approved 2026-08-02*. It designs an
  **11-level arc** as a table of (new idea, roster, enemy count, board). Seven boards are
  marked **new**; the four shipped arenas take slots 6, 7, 8 and 11. Its governing
  constraint is that there is no tutorial text anywhere in the tree, so **levels teach
  through geometry alone**. It also records a `bankOnly` claim type that was tried and
  **withdrawn as geometrically impossible**, and measured bot win-rates per roster that it
  explicitly refuses to treat as a difficulty ordering.
- **`docs/superpowers/plans/2026-08-02-difficulty-curve-stretch-1.md`** — the
  implementation plan for **stretch 1 only**: prepend two 2-brown boards and renumber the
  existing four. It carries full JSON grids.

**Neither was executed, and the plan has gone stale.** Verified 2026-08-10:
`src/sim/config/data/arenas.json` holds exactly `arena-01` .. `arena-04` (4 `"id"` keys, no
`arena-00a`/`arena-00b`). `firstMission` is still only validated as a non-negative integer
(`config/validate.ts:131`) and copied through `config/resolve.ts:79` — the spec's
"enforced load-time rule" does not exist and **nothing reads the field**. And the plan's
boards are specified as `"cols": 9, "rows": 7, "cellSize": 2`, which is pre-#75 geometry:
shipped arenas are 33x27 at `cellSize` 0.667. Its grids cannot be pasted in as written.

**The disagreement, stated plainly.** The spec's decision line is "the four existing levels
are **renumbered, not rewritten**", and its Out of scope section forbids "any change to the
four existing boards' geometry". If the campaign's levels now need *rewriting*, the
approved spec is the thing being overruled. **Nobody should author a board until that is
settled**, because the two readings produce different work: renumbering is additive and the
plan (once re-based onto the current cell size) still describes it, while rewriting
invalidates the four arenas' `notes`, their `claims`, the cover-ratio table in
`arena-validation.test.ts`, and the difficulty scores #98 derived for them.

**What would answer it:**

- **An owner decision on one question: are arena-01..04 kept?** Everything else follows.
  This is not a measurement and no amount of reading settles it.
- **If kept:** re-base the stretch-1 plan onto `cellSize` 0.667 and re-derive its two grids
  at 3x, then run it. Its five pin sites are already enumerated in CLAUDE.md.
- **If rewritten:** the spec needs revising *before* the plan, because its arc assigns
  specific lessons to specific existing boards (teal's bank corridor to arena-01,
  breaching to arena-02, rockets to arena-03, green's crossfire to arena-04). Those four
  rows become vacant and the arc has to say what replaces them.
- **Either way, play the first two levels before building levels 3-5.** The spec's own
  residual risk says so, and this file's audio and arena-04 lines say the same thing about
  their own subjects: the tree carries no recorded playtest judgement about any level.

**Constraint that shapes any answer:** the four shipped arenas are load-validated data with
machine-checked `claims`. Rewriting a board is not editing a grid — it is re-deriving every
claim attached to it, and `sightlineAfterBreach` is **all-or-nothing per arena** (declaring
one commits the arena to declaring one for every enemy spawn). Related: issue #119 asks for
arena-05 and a measured per-level cost; that number is worth having **before** this decision
is made, not after, because it prices both branches.

---

## Ledger: deferred work harvested from PR descriptions

**Compiled 2026-08-03, rebuilt after adversarial review.** **Scope is an enumerated set, not
a predicate: it is the PRs cited by `#NN` in the lines below.** Say it that way because three
successive drafts stated it as a count — 21, then 20 — and all three were false.

The harvest *started* from "merged PRs whose body carries an ATX heading matching
`/residual/i`", which at the grep baseline `a7b39ec` (77 merged) selects 20. It then diverged
in both directions, so that predicate does not describe what was swept:

- **#58 matches and contributed nothing.** Its heading is about *closing* a residual named in
  #55's review — a false positive of the pattern.
- **#43, #74 and #76 contributed lines without matching.** #76 has no ATX heading at all and
  never uses the word "residual"; its deferrals are a closing paragraph of prose.

The predicate is also unstable: #80 merged 55 minutes after the baseline carrying a
`## Residuals` heading, so re-running it today selects a different set again. Any "how many
PRs" number here is derived, drifting, and has been wrong every time it was written down.

**PRs that record deferred work only in prose were NOT swept** — roughly 15 more bodies. Six
were spot-checked (#9, #14, #31, #45, #50, #74) and all six yielded open items, included
below and marked. This is a floor on the backlog, not a sweep of history.

**These lines are triage notes, not proven claims.** Each was checked once by grep against
`a7b39ec`; none is pinned by a test unless it says so. Verify before acting. The three
numbers that ARE pinned — 13 of 42, 25 of 31, and this section's own line counts — are
recomputed in `tools/backlog.test.ts` and compared against the figures stated here, because
a quoted measurement that nothing recomputes is how the previous draft of this file shipped
a fabricated figure.

Counts: **84 lines below** — 17 / 31 / 25 / 11 across four groups. **75** came from the
harvested set and **9** from prose-only PRs outside it. They do not sum to the number of
items triaged; the difference is itemised at the end. All five figures are recomputed in
`tools/backlog.test.ts`, so this paragraph cannot drift from the list below.

### Gaps with a reachability argument

- `resolveBulletHits` skips dead tanks, so a shell whose target died earlier in the same tick is never consumed. #2
- `muzzlePoint` tests the spawn point against `world.walls` and not `world.tanks`, so a shell can be born inside an adjacent tank's silhouette. #42
- A corner emits two ricochet events but decrements `bouncesLeft` once (`collision.ts:257-269`), so a corner is charged one bounce for two reflections AND `bounceIndex` can repeat across ticks. One defect, two symptoms. #1
- `bankShot` models an exact-corner bounce as a single-face reflection while `reflectSweep` retroreflects both axes; `targeting.ts:333` documents the divergence as negligible rather than closing it. #1
- The retroreflecting-seam fix is open: it must distinguish a coplanar neighbour that continues the surface from a perpendicular one that merely touches it. CLAUDE.md §Known holes owns the measurement and the record of the fix that was tried and reverted — do not restate them here. #1
- A tab left open across "Reset progress" resurrects pre-reset achievement ids on its next write; `achievements.ts` persists by union and no `storage` listener exists. #62
- `melody.ts:99`'s density knob is inert at and above 0.5: the predicate is `rnd() < spec.density * 2`. **13 of 42** generated layers ship at ≥ 0.5. *(pinned)* #70
- `melody.ts` carries `previous` as a palette *index* across bars whose palettes may differ in size, weakening the contour guarantee. #70
- Six tracks — blitz, dread, hunt, siege, standoff, triumph — belong to no suite, so nothing can select them: **25 of 31** reachable. *(pinned)* #71, #74
- The suite walk can backtrack X→Y→X; `rankCandidates` takes only `from` and has no memory of the previous suite. #72
- No suite is authored for the `victory` or `defeat` context (6 arena + 1 menu, of 7), so those screens keep whatever was playing rather than scoring the moment. #74 *(prose-only PR)*
- Two music context changes inside one bar still drop the first silently — bounded to ≤ 1 bar (2.4–3.2s), where it used to be ≤ 1 cycle. #74 *(prose-only PR)*
- The overlay's outgoing lead is captured once and never re-gated as intensity falls, so it can sound while both tracks' own leads are gated silent — a window now up to a glide long. #76
- The intensity glide is a rate limiter, not hysteresis: a 1↔0 reversal faster than the 2.0s walk makes a layer flicker MORE than the bare assignment did. Not reachable from the sim today, which moves intensity only on a kill or `resetArena`. #76
- `tools/visual/verify.mjs:33` resolves Playwright from `/home/dev/.claude/jobs/17681316/...`, a path in a dead session's job directory. When it vanishes the visual gate stops being runnable, and nothing says so. #31 *(prose-only PR)*
- `fitCameraToArea` returns a CROPPING camera below aspect ~0.249 — nothing in the bracket fits, so it falls back to the untested `hi` — and no test aspect goes near it; test aspects run 0.42–3.0. The bracket itself is no longer *unvalidated*, which this line used to say: `framing-fit-bracket-4.5` (`tools/mutate/manifest.json`) kills `hi = span * 4.5`, 9 of 90, because the tightest shipped combination needs 4.84 spans of distance at 20:9 portrait. The ~0.249 figure dates from the fov 50→30 change (it was ~0.147 before; a narrower lens needs more distance and exhausts the bracket sooner, so the unusable region grew ~69%) and has not been re-measured since. #5 #103
- `framedAreaFits` projects the ground plane only (`y = 0` is hardcoded), so nothing above it is inside the fit; the ring starts clipping at wall height **~1.303** at the current `cellSize` (re-derived after #103's fov 50→30, which cost 15.7%; it was ~1.545 after #75 and ~1.721 before). `WALL_H` is 1.0, so headroom over the shipped wall is now 30.3% rather than 54.5%. #5 #103

### Unpinned behaviour — no test found that would catch the regression

Each line names what it looked at. "No test found" is the result of a grep, not a proof.

- Terminal-event cardinality: the win/lose presence assertions use `toContainEqual`, so a duplicated push survives and the audio director plays the stinger twice. (Three assertions in the same block do use `toEqual([])`, but on the empty case.) #3
- `resolveStatus`'s own guard is pinned on the win side only; narrowing it to `=== 'win'` still lets a lost world push a second `lose`. Reachability through `step()` was proven nil, so it is latent. #3
- `tank-destroyed` / `explosion` push order on the bullets path is stated in a comment and asserted by nothing. #3
- The purity guard's specifier regexes use `['"]` only, so a template-literal import specifier is invisible to it. #1
- The purity guard matches `Math.random` / `Date.now` as tokens, so an alias or destructure walks past it. #1
- `FRAME_MARGIN` tightness is self-referential: the test imports the constant and uses it on both sides. Routing around the constant *is* caught. #5
- `VIEW_DIR`'s pitch magnitude is now pinned to 51.0° by `framing.test.ts` (#103 added it after review measured that swinging it to 80° — a near-top-down camera — passed all 1538 tests; 27 of integer tilts 30–89 survived the coverage floor). What is still unpinned is whether 51° is the right CHOICE: it is not optimal for any single aspect (43° is +3.49pp at 16:9, fov 30) and was kept because within a playable 40–60° band the best fixed tilt (60°) gains only +1.63pp on a uniform mix of 4 arenas × 4 common aspects — going further means going near-top-down (89° gains +10.07pp and is a different game). #5 #103
- `framing.test.ts`'s coverage tests now import the shipped `BASE_FOV`, and `cameraAt` was moved onto it too, so the old "every framing test builds a 50° camera" no longer holds. What remains unpinned is fov as a SWEPT variable: no test checks behaviour at more than the one shipped value. #5 #103
- Aspect coverage is a grid of 10 values (0.42–3.0), and the monotonicity premise `fitCameraToArea` documents is unproven between grid points. #5
- Embeddings that can set an arbitrary aspect — iframes, devtools responsive mode, kiosk webviews — were never considered; every tested shape is an ordinary window. #5
- Scene geometry other than the four ground corners — wall tops, tanks, turrets, particles, shadow extents — is never projected against the fit. #5
- `createBrowserDeps` is only partly reachable: two same-shaped `() => number` factories inside the literal could be swapped and survive. #6
- `dispose()` ordering was never swept; the assertion `.sort()`s, making it explicitly order-insensitive. #6
- `renderer.dispose()` idempotency is still unmeasured — **the blocker PR #6 recorded has lifted**, since `tools/gl/harness.ts` now runs in a real browser and already calls `dispose()`. #6
- The GL harness's two `refit()` checks pass bare literals (`34, 18`), not the bounds of any shipped arena or of `WIDE_ARENA` (which is 34 × 26). No `refit` check is driven by production arena data. #67
- `makeTank`/`mkTank` is redefined in **8 test files** — and `src/sim/arena.ts:38` already exports a `makeTank` that two other test files import. The shared helper exists; it is neither named `test-helpers.ts` nor used consistently. #2
- Musical content — authored pitches, layer lengths, voicings — is deliberately unpinned. #68
- `barSteps` has a lower bound and an integrality check, but no upper bound. #70
- Authored layers are not validated against the track's declared chords; the chord check fires for generated layers. #70
- `TRACKS_PER_SUITE = 3` and the start suite are unmeasured feel constants; the test pins the mechanism against whatever the constant is. #72
- The music seed is taken from `Date.now()` at bed construction and is not surfaced as a dev flag, so a specific walk cannot be replayed. #72
- The 3.0s countdown is an unmeasured feel choice, pinned only by the tautological seconds assertion. (The "TAKE AIM" string itself IS pinned, at `hud.test.ts:338`.) #63
- SFX recipe numbers were tuned by ear against design intent and never measured. #64
- `arenas.json`'s prose — `notes` and each claim's `why` — ships in the browser bundle. #65
- `engine.ts`'s non-`setMusicContext` call site was not swept; sequences of length ≥ 5 and a real unstubbed bed were never exercised. #74 *(prose-only PR)*
- The `ramp === null && overlay === null` clause is kept as defence and explicitly not claimed as tested. #74 *(prose-only PR)*
- `scheduleGenerated` never reads intensity, so `setIntensity` has never affected the generated bed. The shipped game does not take that path. #76
- The `780 of 1,681` interior-centre figure has an independent reconstruction that measured **774**, and the discrepancy is unresolved. #75
- The buried-face probe count has no guard left that could re-derive it — the guard was deliberately deleted as a no-op. #75
- `tools/gallery/subjects.ts` couples shell/shellring `focusY` to `BULLET_Y`, a render constant imported for camera aim. Latent drift, nothing pins the relationship. #42
- PR #5's commit body says "roughly a quarter of the viewport was empty" on one line and "about 35% of the vertical frustum unused" seven lines later. Both are in `main`'s history and neither was adjudicated. A record, not a fix — history is immutable. #5

### Unbuilt by design — feature ideas, not defects

- Per-tank sandbox positioning; the anchor table is fixed and `SandboxOptions` has no position field. #43
- Procedural generation of shipped levels; the four arenas are authored grids (mechanically rescaled by `tools/upscale-arenas.mjs` for #75, not generated). #43
- Separate `canFire`/`canMine` flags instead of the single `disarmed` boolean. #43
- Per-chassis turret turn rate — still the two globals, with no per-kind field in `tank-defs.json`. #46
- Skins are all free; unlock criteria were never designed, and the achievements set is never consulted by the customization store. #61
- Every enemy kind's two-tone skin uses the SAME split geometry (one 50/50 v-band), differing only in the two tones -- both still derived from that kind's own hull hue. #137's dichromacy measurement (grey/teal collapse to dE 4.1 under deuteranopia) is therefore only partly answered: under that same collapse, grey's two-tone `[grey, lighter-grey]` and teal's `[teal, lighter-teal]` also read as the same texture, because the shape carries no per-kind information. A pattern that varies by kind -- a distinct split axis, band count or offset per kind -- would add a real non-colour channel; this is a design decision (which split maps to which kind, and whether it still reads as "two-tone" once it does), not a mechanical follow-up. #137
- Spawn and victory animations. #61
- Emotes. #61
- A bold-speed Flow skin variant (the per-skin `scroll` machinery already exists). #61
- Nothing is gated on achievements — `earned()` feeds display only. #62
- Achievement rarity / earned-percentages. #62
- Achievement earned-date stamps; the store persists `{ earned: [...ids] }`, an object wrapping the id array. #62
- An achievements progress bar beyond the "N of 14 earned" string. #62
- A scroll affordance on the achievements list (`max-height: 58vh`, `overflow-y: auto`, no fade). Arguably a usability defect rather than an idea: 14 entries clip with no cue. #62
- `OFFENSIVE` and `BERSERKER` route to `teal.ts`; the profile field for how much a threat overrides a tank's approach does not exist. #69
- No crossfade when the music bed starts or stops. `start()` snaps by design, and the #76 glide is intensity-only — but `music.ts:418` already carries a linear per-note fade for the suite-change overlay, which is the machinery to reuse. #64
- The one-oscillator `beep` stays as the floor for contexts that cannot support the synth graph. #64
- No sustain/tie marker in the note grammar; `hold` is per voice, not per note. #68
- No per-note velocity; amplitude comes from `VOICES[].peak`. #68
- No MIDI import. #68
- The generated melody is monophonic — one slot per step. #70
- Rhythm templates are a fixed set of five, not data-driven. #70
- `outro` and `bridge` transitions are designed and documented; the validator rejects them loudly rather than silently behaving like `dominant`. #71
- Restart Level, held back on a pending lives-policy decision. #45 *(prose-only PR)*
- Dev-flag retirement: each of the 18 flags needs an owner's ship-or-delete decision, which is the arrangement's own stated rule. #50 *(prose-only PR)*

### Cannot be settled by reading the tree

Each needs a measurement, a browser, or a person.

- How much screen the board SHOULD take is undecided, and it is a taste call rather than a limit. #103 stopped at fov 30 (arena-01 covers 59.6% of a 16:9 frame); the same camera reaches 68.7% at fov 15 and ~82.2% in the long-lens limit at the shipped margin (~87.3% at margin 0), at the cost of flattening depth toward orthographic and moving the camera 64.9 units out. An earlier draft of #103 claimed 68% was a geometric ceiling from the arena's 1.21 aspect — that was WRONG, it ignored the tilt, and the level-design conclusion drawn from it (wider grids) is withdrawn. Needs a person to look at candidates. #103
- 23 of PR #1's 24 surviving mutations are named only as a count; no catalog was committed. Settling it needs a fresh sweep. #1
- `framing.ts` mutation coverage left a real gap of 6 (28 applied, 19 killed, 9 survived, 3 proven equivalent). Two of the nine are listed above; the rest were never enumerated. #5
- Wiring mutation coverage was ~15 hand-picked call-site mutations, not a systematic sweep. #5
- Compound mutations on `frame.ts`/`driver.ts`/`loop.ts` beyond the two-site `sm.state` hoist were never swept. #6
- Whether `ended` fires for every music voice across a long real-browser session. #64
- Whether a suspended-context resume inside a voice's teardown window throws or leaks a gain node. #64
- The visual gate's thresholds were calibrated against ONE defect pair, on swiftshader rather than a real GPU, so a different regression may pass all six checks and the CI runner's output may differ. #9, #14 *(prose-only PR)*
- Whether a routine roam change landing seconds after a level ends reads as caused by it. #74 says this wants a decision rather than a quiet change. *(prose-only PR)*
- **No judgement on arena-04's feel has been recorded.** The game has been played, so "nobody has played it" is no longer the claim — but its geometry, structure and pacifist outcomes are the only things measured, and nothing in the tree states whether the crossfire reads as a crossfire. (One quoted figure in `arenas.json` was recomputed by hand and cites `task-4-report.md`, which exists in neither the tree nor any commit.) #67
- **The green ricochet sniper and the music have been experienced but not adjudicated.** The game has been played and the audio has been heard, so the old form of this line — "nobody has played against green, nobody has heard the music" — is false and is withdrawn. What remains open is narrower and still real: every number in the tree about either is a headless measurement, and no stated verdict exists on whether green's bank shots read as fair or on whether any specific music transition lands. #69, #76

### Where the numbers went

147 items were enumerated from the harvested set. 63 were already closed by later work
(62 found by the triage, plus one the review caught: the `startMusic()`/`loaderror` race
was filed as unsettleable and is in fact tested at `engine.synth.test.ts:218`, since #73).
8 remain unsettleable. 76 were still open.

The 8 unsettleable are the in-scope lines of "Cannot be settled by reading the tree" — they
are listed, not dropped, which an earlier draft's arithmetic missed by mapping the 76 onto
all 75 in-scope lines including that section.

The 76 open became the **66** in-scope lines of the first three groups, near enough
one-to-one, with these
adjustments: 4 are PR #75's residuals and live in the "Follow-ups from walls as geometry"
spike; 1 is the intensity spike; 1 is a null item (no save system references tank ids);
2 shared the audio-assets line, now deleted and absorbed by issue #86; 2 were one corner defect counted twice and are now one
line; 3 duplicated CLAUDE.md and are left to it; and **2 were false and are deleted** — a
claim that the GL harness drives `refit()` from `WIDE_ARENA` (it uses bare literals), and
a claim that arena-01's *brown* holds an unpinned bank onto the spawn (the tree names grey
and teal, and every shipped arena runs through `structuralFailures`). A third line quoted
a figure that exists in no PR body; it is rewritten to the two figures that do. Against
those 16 removals the review also split or corrected lines that were understated, which is
why 76 − 16 lands above 60 rather than at it. Issue #137 closed one line here (enemy tanks
wearing skins) and opened another in its place (the shared-geometry limitation that closing
it exposed), which is why the live count still reads 66 rather than one lower.

The remaining **9** lines came from prose-only PRs outside the heading scope and are marked
`*(prose-only PR)*`. They are a spot-check of 4 such PRs, not a sweep of the ~15.
