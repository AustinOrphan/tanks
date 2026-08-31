---
status: active
date: 2026-08-23
last-reviewed: 2026-08-31
scope: Ledger -- deferred work harvested from PR descriptions
implementation-issues: []
implementation-prs: []
supersedes: []
superseded-by: []
---
# Ledger: deferred work harvested from PR descriptions

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

Counts: **83 lines below** — 13 / 31 / 25 / 14 across four groups. **74** came from the
harvested set and **9** from prose-only PRs outside it — though 3 of that 74 did not: the
versus-spawn lines at the end of the fourth group were deferred by the PR that added them,
not harvested from anything. The 74 is what `tools/backlog.test.ts` recomputes (it is
`total − prose-only`, which cannot tell the two apart), so read it as "not prose-only"
rather than literally as "harvested". They do not sum to the number of
items triaged; the difference is itemised at the end. All five figures are recomputed in
`tools/backlog.test.ts`, so this paragraph cannot drift from the list below.

### Gaps with a reachability argument

- `bankShot` models an exact-corner bounce as a single-face reflection while `reflectSweep` retroreflects both axes; `targeting.ts:333` documents the divergence as negligible rather than closing it. #1
- The retroreflecting-seam fix is open: it must distinguish a coplanar neighbour that continues the surface from a perpendicular one that merely touches it. CLAUDE.md §Known holes owns the measurement and the record of the fix that was tried and reverted — do not restate them here. #1
- `melody.ts:99`'s density knob is inert at and above 0.5: the predicate is `rnd() < spec.density * 2`. **13 of 42** generated layers ship at ≥ 0.5. *(pinned)* #70
- `melody.ts` carries `previous` as a palette *index* across bars whose palettes may differ in size, weakening the contour guarantee. #70
- Six tracks — blitz, dread, hunt, siege, standoff, triumph — belong to no suite, so nothing can select them: **25 of 31** reachable. *(pinned)* #71, #74
- The suite walk can backtrack X→Y→X; `rankCandidates` takes only `from` and has no memory of the previous suite. #72
- No suite is authored for the `victory` or `defeat` context (6 arena + 1 menu, of 7), so those screens keep whatever was playing rather than scoring the moment. #74 *(prose-only PR)*
- Two music context changes inside one bar still drop the first silently — bounded to ≤ 1 bar (2.4–3.2s), where it used to be ≤ 1 cycle. #74 *(prose-only PR)*
- The overlay's outgoing lead is captured once and never re-gated as intensity falls, so it can sound while both tracks' own leads are gated silent — a window now up to a glide long. #76
- The intensity glide is a rate limiter, not hysteresis: a 1↔0 reversal faster than the 2.0s walk makes a layer flicker MORE than the bare assignment did. Not reachable from the sim today, which moves intensity only on a kill or `resetArena`. #76
- ~~`tools/visual/verify.mjs` resolves Playwright from a path in a dead session's job directory.~~ **CLOSED.** The path was verified absent (that host no longer uses the id format it was built from) and removed. The claim that its vanishing stopped the visual gate being runnable was **overstated**: it sat THIRD, behind `PLAYWRIGHT_MODULE` and the bare `playwright` specifier, and CI installs playwright with `--no-save` and resolves the bare one -- so the gate never depended on it. What was true is that a dead machine-specific absolute path sat in committed tooling that feeds a required check. #31 *(prose-only PR)*
- `fitCameraToArea` returns a CROPPING camera below aspect ~0.249 — nothing in the bracket fits, so it falls back to the untested `hi` — and no test aspect goes near it; test aspects run 0.42–3.0. The bracket itself is no longer *unvalidated*, which this line used to say: `framing-fit-bracket-4.5` (`tools/mutate/manifest.json`) kills `hi = span * 4.5`, 9 of 90, because the tightest shipped combination needs 4.84 spans of distance at 20:9 portrait. The ~0.249 figure dates from the fov 50→30 change (it was ~0.147 before; a narrower lens needs more distance and exhausts the bracket sooner, so the unusable region grew ~69%) and has not been re-measured since. #5 #103
- `framedAreaFits` projects the ground plane only (`y = 0` is hardcoded), so nothing above it is inside the fit; the ring starts clipping at wall height **~1.303** at the current `cellSize` (re-derived after #103's fov 50→30, which cost 15.7%; it was ~1.545 after #75 and ~1.721 before). `WALL_H` is 1.0, so headroom over the shipped wall is now 30.3% rather than 54.5%. #5 #103

### Unpinned behaviour — no test found that would catch the regression

Each line names what it looked at. "No test found" is the result of a grep, not a proof.

- Terminal-event cardinality: the win/lose presence assertions use `toContainEqual`, so a duplicated push survives and the audio director plays the stinger twice. (Three assertions in the same block do use `toEqual([])`, but on the empty case.) #3
- `resolveStatus`'s own guard is pinned on the win side only; narrowing it to `=== 'win'` still lets a lost world push a second `lose`. Reachability through `step()` was proven nil, so it is latent. #3
- `tank-destroyed` / `explosion` push order on the bullets path is stated in a comment and asserted by nothing. #3
- The purity guard's specifier regexes use `['"]` only, so a template-literal import specifier is invisible to it. **Narrower than this said**: a STATIC `import x from \`three\`` is a syntax error (verified with `node --check`), so the hole is reachable only through a DYNAMIC `import(\`three\`)`, which is valid. #1
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
- ~~Spawn and~~ victory animations. #61 -- spawn animations shipped in #203/#205 (see
  the versus spike's item 4, above); victory animations remain unbuilt.
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

- Versus spawn concealment is guaranteed only AT SPAWN, on intact geometry. Measured over all 5 shipped arenas x player counts 2/3/4 (15 pairs): on 4 of the 15, exactly one spawn pair becomes mutually visible once every destructible is gone. Running the LOS filter on both wall phases would close it and is a much stricter criterion — unmeasured, so it is a decision, not a fix. #versus-p1-maximin
- `versus-variants.ts`'s bounded retry is now close to unreachable on shipped boards: 0 unsuitable first draws in 1500 draws (arena-01 and arena-03, 250 seeds each at removal fractions 0.85 / 0.90 / 0.95, all well above the production 0.4). `pickVersusSpawnCell`'s LOS filter actively searches for concealment, so `allPairsConcealed` now fails only when no concealed pair exists anywhere. Whether the criterion should be strengthened, rather than leaving a retry that almost never fires, is undecided. #versus-p1-maximin
- The removal-fraction sweep in `2026-08-17-versus-map-variants.md` was measured under the OLD spawn placement and is stale. `DESTRUCTIBLE_REMOVAL_FRACTION` is unchanged at 0.4 and is now more conservative than that sweep implied; re-measuring it is a separate decision, deliberately not bundled. #versus-p1-maximin

### Where the numbers went

147 items were enumerated from the harvested set. 63 were already closed by later work
(62 found by the triage, plus one the review caught: the `startMusic()`/`loaderror` race
was filed as unsettleable and is in fact tested at `engine.synth.test.ts:218`, since #73).
8 remain unsettleable. 76 were still open.

The 8 unsettleable are the in-scope lines of "Cannot be settled by reading the tree" — they
are listed, not dropped, which an earlier draft's arithmetic missed by mapping the 76 onto
all 73 in-scope lines including that section.

The 76 open became the **62** in-scope lines of the first three groups, near enough
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
it exposed), netting to zero and holding the count at 66. The corner-bounce fix (#159)
closed the reachability line at `collision.ts:257-269` outright — the two-event corner
defect it named is fixed, and nothing replaced the line — the live count read 65 after
that. The achievements-reset fix (this PR) closes the reachability line naming
`achievements.ts`'s union-write resurrection defect (PR #62's residual) the same way:
`achievements.ts` now resyncs its shadow against disk before evaluating what is newly
earned, so a tab left open across Reset progress can no longer bring pre-reset ids back —
which is the one further decrease since: the live count read 64 after that. The
sim-switches PR closes the two reachability lines naming `resolveBulletHits`' dead-tank
ghost and `muzzlePoint`'s tank-overlap gap the same way, both awaiting exactly the call
they named: the ruling on 2026-08-14 was that the ghost stays the default (a flippable
`corpseBlocksShells` WALL variant behind it) and that the muzzle clearance ships ON by
default (a flippable `muzzleClearsTanks` restoring the old spawn), closing both lines
without deciding a THIRD way — which is the two further decreases since: the live count
now reads 62.

The remaining **9** lines came from prose-only PRs outside the heading scope and are marked
`*(prose-only PR)*`. They are a spot-check of 4 such PRs, not a sweep of the ~15.
