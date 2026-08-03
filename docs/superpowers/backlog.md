# Backlog

Spikes and deferred work. Each entry says what the question is and what would answer it —
not a plan, just enough that the next person does not re-derive the context.

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

## Ledger: deferred work harvested from PR descriptions

**Compiled 2026-08-03**, by triaging every PR that records deferred work — 20 merged plus
the open #75 — against the tree at `a81139e` (`origin/curve` at `951c3db` for #75's own
items). **147 items were enumerated; 62 had already been closed by later work and are not
listed here; 9 cannot be settled by reading the tree.**

The 76 that are still open resolve to the 74 lines below, and the arithmetic is meant to
be checkable: 1 of the 76 is "the music does not vary by level", which is already the
spike above rather than a ledger line, and 1 is the null item "no save system references
tank ids, so save-compat is N/A" — true, with nothing to do about it. Two PRs raised the
committed-audio-assets item independently (#1 and #64) and it is one line here. One line
below came from this triage rather than from any PR body, and says so.

Ledger lines are one-liners on purpose. A spike above earns its length by having a
measurement behind it; a ledger line is a pointer — enough to find the thing, not enough
to skip re-deriving it. Promote a line to a spike when someone is about to act on it.

Each line names the PR it came from. A line marked **(curve)** was judged against
`origin/curve`, so it describes PR #75's tree rather than `main`'s.

### Gaps with a reachability argument

- Retroreflecting seams at wall cell boundaries; `collision.ts` retroreflects on `onX && onY`. See §Known holes in CLAUDE.md for the fix that was tried and reverted. #1 — **(curve changes the geometry: solid runs merge, so which faces carry it moves)**
- `bankShot` models an exact-corner bounce as a single-face reflection while `reflectSweep` retroreflects both axes; `targeting.ts:250` documents the divergence rather than closing it. #1
- `bounceIndex` can repeat across ticks: a corner emits two ricochet events but decrements `bouncesLeft` once. #1
- A corner charges one bounce for two reflections (`collision.ts`, the `if (corner)` branch). #1
- `resolveBulletHits` skips dead tanks, so a shell whose target died earlier in the same tick is never consumed. #2
- `muzzlePoint` tests the spawn point against `world.walls` only, never `world.tanks` — a shell can be born inside an adjacent tank's silhouette. #42
- A tab left open across "Reset progress" resurrects pre-reset achievement ids on its next write; `achievements.ts` persists by union and no `storage` listener exists. #62
- `melody.ts`'s density knob is inert at and above 0.5: the predicate is `rnd() < spec.density * 2`. **13 of 42 generated layers in `music-tracks.json` ship at ≥ 0.5**, where it is unconditionally true. #70
- `melody.ts` carries `previous` as a palette *index* across bars whose palettes may differ in size, weakening the contour guarantee. #70
- Six mood tracks — blitz, dread, hunt, siege, standoff, triumph — belong to no suite, so nothing can select them: **25 of 31 tracks are reachable**. #71
- The suite walk can backtrack X→Y→X; `rankCandidates` takes only `from` and has no memory of the previous suite. #72
- arena-01's brown holds a geometric bank onto the player spawn, spared only by `STATIC_BASIC.bankShotWeight === 0`. Raising that one scalar re-arms the rule, and no test pins arena-01's geometry against it. #69
- `fitCameraToArea`'s bisection bracket `hi = span * 8` is unvalidated; below aspect ~0.147 the fallback returns a cropping camera. Test aspects run 0.46–3.0. #5
- `framedAreaFits` projects the ground plane only (`y = 0` is hardcoded), so wall tops sit outside the fit; the ring starts clipping at wall height ~1.55. #5
- arena-02's boundary-flush destructible run can be escaped past the ring from ≥ 0.677 units deep; nothing samples depth *inside* the `separateTanks`/`resolveWalls` alternation. #75 **(curve)**
- Merged solid walls tile the one shared `concreteNormal` at the wrong density — no clone, no size-dependent repeat. #75 **(curve)**

### Unpinned behaviour — no test would catch the regression

- Terminal-event cardinality: every `win`/`lose` assertion uses `toContainEqual`, so a duplicated push survives and the audio director plays the stinger twice. #3
- `resolveStatus`'s own guard is pinned on the win side only; narrowing it to `=== 'win'` still lets a lost world push a second `lose`. Reachability through `step()` was proven nil, so it is latent. #3
- `tank-destroyed` / `explosion` push order on the bullets path is stated in a comment and asserted by nothing. #3
- The purity guard's specifier regexes use `['"]` only, so a template-literal import specifier is invisible to it. #1
- The purity guard matches `Math.random` / `Date.now` as tokens, so an alias or destructure walks past it. #1
- `FRAME_MARGIN` tightness is self-referential: the test imports the constant and uses it on both sides of the comparison. Routing around the constant *is* caught. #5
- `VIEW_DIR`'s pitch magnitude is unpinned — 19.4°, 67.0° and 69.1° all pass; only the sign is asserted. #5
- No test varies `fov`; every framing test builds a 50° camera. #5
- Aspect coverage is a grid of 8 values (0.46–3.0), and the monotonicity premise `fitCameraToArea` documents is unproven between grid points. #5
- Embeddings that can set an arbitrary aspect — iframes, devtools responsive mode, kiosk webviews — were never considered; every tested shape is an ordinary window. #5
- PR #5's own commit body says "roughly a quarter of the viewport was empty" while its table gives 34.77%. The claim is on `main` and unadjudicated; history is immutable, so this is a record, not a fix. #5
- Scene geometry beyond ground corners and wall tops — tanks, turrets, particles, shadow extents — is never projected against the fit. #5
- `createBrowserDeps` is only partly reachable: two same-shaped `() => number` factories inside the literal could be swapped and survive. #6
- `dispose()` ordering was never swept; the assertion `.sort()`s, making it explicitly order-insensitive. #6
- `renderer.dispose()` idempotency is still unmeasured — **the stated blocker has lifted**, since `tools/gl/harness.ts` now runs in a real browser and already calls `dispose()`. #6
- `loop.test.ts` still asserts "an AI fired within 30 frames" — a time bound that moves whenever AI RNG timing moves, rather than a deterministic event. #75 **(curve)**
- Wall mesh and material counts rose 1.6×–4.1×; `makeWall` allocates a `BoxGeometry` and a material each, and nothing measures the render cost. #75 **(curve)**
- The GL harness exercises `refit()` against the `WIDE_ARENA` fixture, not against shipped arena-04. #67
- A `lane` claim's `to` endpoint is a plain floor cell pinned by nothing. #67
- `makeTank`/`mkTank` is redefined in **10 test files**; `src/sim/test-helpers.ts` still does not exist. #2
- Musical content — authored pitches, layer lengths, voicings — is deliberately unpinned. #68
- `barSteps` has a lower bound and an integrality check, but no upper bound. #70
- Authored layers are never validated against the track's declared chords; the only chord check fires for generated layers. #70
- `TRACKS_PER_SUITE = 3` and the start suite are unmeasured feel constants; the test pins the mechanism against whatever the constant is. #72
- The music seed is taken from `Date.now()` at bed construction and is not surfaced as a dev flag, so a specific walk cannot be replayed. #72
- The 3.0s countdown and the "TAKE AIM" wording are unmeasured feel choices; the only test is the tautological seconds pin. #63
- The countdown's early-edge mutation kill is clock-dependent — it holds at 180 but is not general for any countdown length. #63
- `GRACE_TICKS` is 0, so the grace phase never occurs in play while its machinery and tests stay live. #63
- SFX recipe numbers were tuned by ear against design intent and never measured. #64
- `arenas.json`'s prose — `notes` and every claim's `why` — ships in the browser bundle. #65
- Playwright is not a declared devDependency; CI installs it ad hoc (`npm i --no-save playwright@1.62.0`). Observed during this triage, not carried from a PR body.

### Unbuilt by design — feature ideas, not defects

- Per-tank sandbox positioning; the anchor table is fixed and `SandboxOptions` has no position field. #43
- Procedural generation of shipped levels; all four arenas are hand-authored grids. #43
- Separate `canFire`/`canMine` flags instead of the single `disarmed` boolean. #43
- Per-chassis turret turn rate — still the two globals `PLAYER_TURRET_TURN_RATE` / `AI_TURRET_TURN_RATE`, with no per-kind field in `tank-defs.json`. #46
- Projectile `lifetime`/`damage`/`explosionRadius` and the `mines`/`invisibility` balance sections are schema carriage with no consumer. #46
- Skins are all free; unlock criteria were never designed, and the achievements set is never consulted by the customization store. #61
- Enemy tanks cannot wear skins; `setPlayerStyle` is the only entry point. #61
- Spawn and victory animations. #61
- Emotes. #61
- A bold-speed Flow skin variant (the per-skin `scroll` machinery already exists). #61
- Nothing is gated on achievements — `earned()` feeds display only. #62
- Achievement rarity / earned-percentages. #62
- Achievement earned-date stamps; the store persists a bare id array. #62
- An achievements progress bar beyond the "N of 14 earned" string. #62
- A scroll affordance on the achievements list (`max-height: 58vh`, `overflow-y: auto`, no fade). #62
- `OFFENSIVE` and `BERSERKER` route to `teal.ts`; the profile field for how much a threat overrides a tank's approach does not exist. #69
- The stationary-banker rule checks intact walls only, while `spawnBlockRobust` checks both phases — a deliberate split, recorded so it is not mistaken for an oversight. #69
- No crossfade when the music bed starts or stops; `start()` snaps by design and the #76 glide is intensity-only. #64
- The one-oscillator `beep` stays as the floor for contexts that cannot support the synth graph. #64
- No third-party audio assets are committed, so the licensing policy in CREDITS.md is unexercised. #1, #64
- No sustain/tie marker in the note grammar; `hold` is per voice, not per note. #68
- No per-note velocity; amplitude comes from `VOICES[].peak`. #68
- No MIDI import. #68
- The generated melody is monophonic — one slot per step. #70
- Rhythm templates are a fixed set of five, not data-driven. #70
- `outro` and `bridge` transitions are designed and documented; the validator rejects them loudly rather than silently behaving like `dominant`. #71
- `tools/gallery/subjects.ts` couples shell/shellring `focusY` to `BULLET_Y` (camera aim only). #42

*Already a spike, not re-listed:* "the music does not vary by level" (#64, restated in #72) is
the entry above on intensity granularity and a level-set destination.

### Cannot be settled by reading the tree

Each needs a measurement or a person, not a grep.

- 23 of PR #1's 24 surviving mutations are named only as a count; no catalog was committed. Settling it needs a fresh sweep of guards and constants. #1
- `framing.ts` mutation coverage left a real gap of 6 (28 applied, 19 killed, 9 survived, 3 proven equivalent). Two of the nine are separately listed above; the rest were never enumerated. #5
- Wiring mutation coverage was ~15 hand-picked call-site mutations, not a systematic sweep. #5
- Compound mutations on `frame.ts`/`driver.ts`/`loop.ts` beyond the two-site `sm.state` hoist were never swept. #6
- Whether `ended` fires for every music voice across a long real-browser session. #64
- Whether a `startMusic()` landing before Howler's 404 `loaderror` still brings the bed up. #64
- Whether a suspended-context resume inside a voice's teardown window throws or leaks a gain node. #64
- **Nobody has played arena-04.** Every number about it is a headless measurement. #67
- **Nobody has played against the green ricochet sniper**, and nobody has heard any of the music. #69, #76
