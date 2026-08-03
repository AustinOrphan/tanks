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
- **Then listen.** #76 ends "Nobody has listened to any of this." Still true. Any curve
  chosen here is a guess until someone plays a round with it; the numbers above bound what
  is *possible* to hear, not what sounds right.

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

**Not scheduled.** Recorded so #76's deferral does not have to be rediscovered from a
commit message.

---
## Deployment residuals, measured while shipping the GitHub Pages workflow

**Raised 2026-08-03**, reviewing PR #80. Measured against the live `austinorphan.com`
Pages infrastructure using sibling project sites of the same account, because `/tanks/`
was not yet deployed.

**1. The ten missing audio files cost 91.6 kB on every load, and it never caches.**
`public/audio/` holds only `.gitkeep`; no `.wav` has ever been committed
(`git log --all --diff-filter=A --name-only -- '*.wav'` is empty), so all ten manifest
entries 404 and `audio/engine.ts` falls through to the procedural path. That part works —
a Pages 404 arrives as a *successful* XHR with `status: 404`, and Howler's `onload` branch
emits `loaderror` immediately with no retry, which is the cheap failure shape. The cost is
traffic. Pages sets no `cache-control` on a `.wav` 404 (0 of 3 probed) while `.mp3`,
`.ogg`, `.js` and `.png` 404s all get `max-age=14400` (4 of 4), and a Pages 404 body is
9,379 bytes: **9,379 × 10 = 91.6 kB and 10 round trips per load, never cached** — about
half the 186 kB gzipped bundle. The fix is a decision, not a patch: render and commit the
ten wavs, or stop the manifest requesting files that are not there. Note `npm run audio`
does **not** do the first — it writes to the gitignored `audio-out/`, needs chromium, and
names files `${label}.wav`, not `public/audio/cannon.wav`.

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
`http://` and `https://` are different localStorage origins, and all four save keys
(`tanks.progress.v1`, `tanks.stats.v1`, `tanks.achievements.v1`, `tanks.custom.v1`) are
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

## Ledger: deferred work harvested from PR descriptions

**Compiled 2026-08-03, rebuilt after adversarial review.** Scope, stated exactly: the
**21 of 77** merged PRs whose bodies carry an ATX heading matching `/residual/i`, plus #75
while it was open. **PRs that record deferred work only in prose were NOT swept** — by the
census in CLAUDE.md that is up to 15 more bodies, and spot-checks of four of them (#31,
#45, #50, #74) all yielded open items, which are included below and marked. This is a
floor on the backlog, not a sweep of history.

**These lines are triage notes, not proven claims.** Each was checked once by grep against
`a7b39ec`; none is pinned by a test unless it says so. Verify before acting. The three
numbers that ARE pinned — 13 of 42, 25 of 31, and this section's own line counts — are
recomputed in `tools/backlog.test.ts` and compared against the figures stated here, because
a quoted measurement that nothing recomputes is how the previous draft of this file shipped
a fabricated figure.

Counts: **84 lines below** — 17 / 31 / 26 / 10 across four groups. **75** came from the
21 PRs in scope and **9** from prose-only PRs outside it. They do not sum to the number of
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
- `fitCameraToArea`'s bisection bracket `hi = span * 8` is unvalidated; below aspect ~0.147 the fallback returns a cropping camera. Test aspects run 0.46–3.0. #5
- `framedAreaFits` projects the ground plane only (`y = 0` is hardcoded), so nothing above it is inside the fit; the ring starts clipping at wall height **~1.545** at the current `cellSize` (re-derived after #75; it was ~1.721 before). #5

### Unpinned behaviour — no test found that would catch the regression

Each line names what it looked at. "No test found" is the result of a grep, not a proof.

- Terminal-event cardinality: the win/lose presence assertions use `toContainEqual`, so a duplicated push survives and the audio director plays the stinger twice. (Three assertions in the same block do use `toEqual([])`, but on the empty case.) #3
- `resolveStatus`'s own guard is pinned on the win side only; narrowing it to `=== 'win'` still lets a lost world push a second `lose`. Reachability through `step()` was proven nil, so it is latent. #3
- `tank-destroyed` / `explosion` push order on the bullets path is stated in a comment and asserted by nothing. #3
- The purity guard's specifier regexes use `['"]` only, so a template-literal import specifier is invisible to it. #1
- The purity guard matches `Math.random` / `Date.now` as tokens, so an alias or destructure walks past it. #1
- `FRAME_MARGIN` tightness is self-referential: the test imports the constant and uses it on both sides. Routing around the constant *is* caught. #5
- `VIEW_DIR`'s pitch magnitude is unpinned — only its sign is asserted, and `VIEW_DIR` is imported by no test. The three angles PR #5 reported as passing were measured before #75 changed the framed rect, so the pass-set should be re-derived, not trusted. #5
- No test varies `fov`; every framing test builds a 50° camera. #5
- Aspect coverage is a grid of 8 values (0.46–3.0), and the monotonicity premise `fitCameraToArea` documents is unproven between grid points. #5
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
- Enemy tanks cannot wear skins; `setPlayerStyle` is the only entry point. #61
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
- No third-party audio assets are committed, so the licensing policy in CREDITS.md is unexercised. #1, #64
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

- 23 of PR #1's 24 surviving mutations are named only as a count; no catalog was committed. Settling it needs a fresh sweep. #1
- `framing.ts` mutation coverage left a real gap of 6 (28 applied, 19 killed, 9 survived, 3 proven equivalent). Two of the nine are listed above; the rest were never enumerated. #5
- Wiring mutation coverage was ~15 hand-picked call-site mutations, not a systematic sweep. #5
- Compound mutations on `frame.ts`/`driver.ts`/`loop.ts` beyond the two-site `sm.state` hoist were never swept. #6
- Whether `ended` fires for every music voice across a long real-browser session. #64
- Whether a suspended-context resume inside a voice's teardown window throws or leaks a gain node. #64
- The visual gate's thresholds were calibrated against ONE defect pair, on swiftshader rather than a real GPU, so a different regression may pass all six checks and the CI runner's output may differ. #9, #14 *(prose-only PR)*
- Whether a routine roam change landing seconds after a level ends reads as caused by it. #74 says this wants a decision rather than a quiet change. *(prose-only PR)*
- **Nobody has played arena-04.** Its geometry, structure and pacifist outcomes are measured; its feel is not. (One quoted figure in `arenas.json` was recomputed by hand and cites `task-4-report.md`, which exists in neither the tree nor any commit.) #67
- **Nobody has played against the green ricochet sniper, and nobody has heard any of the music.** Every number about them is a headless measurement. #69, #76

### Where the numbers went

147 items were enumerated from the 21 PRs in scope. 63 were already closed by later work
(62 found by the triage, plus one the review caught: the `startMusic()`/`loaderror` race
was filed as unsettleable and is in fact tested at `engine.synth.test.ts:218`, since #73).
8 remain unsettleable. 76 were still open.

Those 76 became the **75** in-scope lines above, near enough one-to-one, with these
adjustments: 4 are PR #75's residuals and live in the "Follow-ups from walls as geometry"
spike; 1 is the intensity spike; 1 is a null item (no save system references tank ids);
2 share the audio-assets line; 2 were one corner defect counted twice and are now one
line; 3 duplicated CLAUDE.md and are left to it; and **2 were false and are deleted** — a
claim that the GL harness drives `refit()` from `WIDE_ARENA` (it uses bare literals), and
a claim that arena-01's *brown* holds an unpinned bank onto the spawn (the tree names grey
and teal, and every shipped arena runs through `structuralFailures`). A third line quoted
a figure that exists in no PR body; it is rewritten to the two figures that do. Against
those 16 removals the review also split or corrected lines that were understated, which is
why 76 − 16 lands above 60 rather than at it.

The remaining **9** lines came from prose-only PRs outside the heading scope and are marked
`*(prose-only PR)*`. They are a spot-check of 4 such PRs, not a sweep of the ~15.
