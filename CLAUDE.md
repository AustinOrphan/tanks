# Tanks!

A browser arena shooter: a deterministic 2D simulation core with a Three.js render layer
projected from it. Spec, plan and backlog live in `docs/superpowers/`.

## Commands

```
npm test     # tsc --noEmit && vitest run
npm run build # tsc --noEmit && vite build
npm run dev   # vite
npm run gallery -- --elements mine,tank,shell --view low   # look at any element
npm run mutate                                              # run the hand-picked mutation manifest
npm run trace:browser -- --all                              # the golden trace, in three real engines
```

`npm run gallery` renders game elements as stills, animations or labelled sweep grids,
through the REAL render modules against a REAL world. `--skin`/`--hull`/`--accent` dress
the player tank through the game's own `setPlayerStyle`, and `--frames N` gives an
animated skin a timeline (one age step is one sim tick — `subjects.ts`'s `timelineDt`);
without those the gallery drew the roster default, unmapped, and could not show a skin at
all. Views are directions and each
element declares its own span, so any view frames any scene. `--sweep A,B --values
"1|2; 3|4"` patches constants in `src/` between passes and restores them in a `finally`;
it refuses to start if the target file is already dirty. `--scene game --slowmo 0.05
--burst 150` records a slow-motion timeline of REAL gameplay, one frame per rAF — the way
to catch a sub-second moment (a shell leaving the muzzle) that a still would miss. See
`tools/gallery/`.

`npm run mutate` (`tools/mutate/`) is the "prove the gap before writing the test" rule,
made checkable: for each hand-picked entry in `tools/mutate/manifest.json` (an exact
find/replace against a `src/` file, a declared `killed`/`survives`, an optional
`expectFailures` count, a `why`, and scoped `tests`) it verifies the find/replace
actually changed the file's bytes (refusing an ambiguous find rather than guessing),
runs a BASELINE check on the unmutated file first (a pre-existing red test in scope
must not be misattributed to the mutation), refuses to start if any entry's `tests`
cannot reach its `file` (checked once via `vitest related`, so a wrong-scope mutation
can never silently read as SURVIVES), applies the mutation, runs the scoped tests, and
restores from the bytes it read -- verified by reading them back, not by a zero exit.
The exit code is non-zero if any entry's real outcome (including a suite that fails to
COLLECT under the mutation, which counts as killed even at 0 failed tests) does not
match what it declared, which is what turns a manifest entry from a transcript into
something CI can check. **SURVIVES means the scoped vitest run does not catch it, not
that the full gate (`tsc --noEmit && vitest run`) doesn't** -- this tool does not run
`tsc` as part of the verdict, so a type-only mutation can still be caught by the build
even when every entry here reports SURVIVES. `--only <id>` runs a single entry.

CI (`.github/workflows/ci.yml`) runs typecheck, tests, build and a bundle-portability
assertion on Node 20.19.0 — the declared floor — and 22. `engines.node` is
`^20.19.0 || ^22.13.0 || >=24.0.0`, which is the intersection of what the tree
actually demands: a plain `>=20.19.0` would be wrong too, since it admits 22.0–22.12
and eight packages reject those.

**The game deploys from `main` to GitHub Pages** (`.github/workflows/pages.yml`), live at
`https://austinorphan.com/tanks/` — a **custom apex domain inherited from the user page**,
so `austinorphan.github.io/tanks/` 301-redirects there. It is still a `/tanks/` subpath,
which is what makes `base: './'` in `vite.config.ts` load-bearing: with the default base
the bundle asks for `/assets/…` and the page is blank. `npm run portability`
(`tools/portability/check.mjs`) asserts that against the BUILT output, and both workflows
call it — it cannot live in `npm test`, because under Vitest `import.meta.env.BASE_URL` is
`/` even though vitest reads the same config that sets `base: './'`.

**The deploy waits for CI.** `pages.yml` triggers on `workflow_run` for the `CI` workflow
and its `build` job requires `conclusion == 'success'`, so on the automatic path all 9 of
`ci.yml`'s checking steps have passed for that exact commit before a deploy starts. It
checks out `github.event.workflow_run.head_sha` rather than the branch head — under
`workflow_run` checkout defaults to the DEFAULT BRANCH'S head, which is a different commit
whenever a second merge lands while the first is still in CI.

**Three landmines that come with that**, all recorded at the point of decision in
`pages.yml` and repeated here because this is the file people read first. **A fork PR can
match the trigger**: `branches: [main]` filters on the CI RUN's head branch, and a PR from
a fork's own `main` produces a run here with `event: pull_request`, `head_branch: main`,
`name: CI`. The `github-pages` environment is NOT a backstop — under `workflow_run` the ref
is the default branch, so its `main`-only policy admits it. The `if` requires the
triggering run to be a **push from this repository**; do not relax that. **Re-running an
OLD CI run republishes that commit** — deliberate rollback and accidental rollback are the
same mechanism. **A flaky `visual` now stops the site updating**, and the symptom is a
pages run with every job SKIPPED, not a red run: if the site looks stale, check whether CI
went red before assuming the deploy is broken.

**`workflow_dispatch` is the ungated path, and it stays that way** — it exists to
re-deploy without a commit, so it cannot have a CI run behind it. It re-runs **5 of
`ci.yml`'s 9 checking steps** (`verify`: 6, `visual`: 3), **not the `visual` job and not
`Mutation manifest`**, so a manual deploy can still publish a render regression that only
`tools/gl/` and `tools/visual/` catch, and a stale `tools/mutate/manifest.json`. Those
five steps are duplicated work on the automatic path; they are kept because deleting them
would leave the manual path checking nothing. (Denominator: the named steps of both
`ci.yml` jobs that check something — that can fail because of the tree — rather than set
up the runner, so `checkout`, `setup-node`, `npm ci`, BOTH Playwright steps (`Install
Playwright` and `Install chromium` are separate named steps), the browser cache and
`upload-artifact` are all excluded. `verify` contributes 6: Typecheck, Test, Mutation
manifest, Build, portability, audit. `visual` contributes 4 — Build, GL tests, Baseline
trace, Visual check — but its `Build` is the same `npx vite build` already counted, so it
adds 3, for 9 distinct. The deploy runs 5 of them, all from `verify`: Typecheck, Test,
Build, portability, audit.) The construction is written out because the bare number went
stale twice unnoticed: `5 of 7` was **correct when #80 wrote it** — the same rule over
that `ci.yml` gives `verify` 5 and `visual` 2 — then #104 added `Mutation manifest` (→ 8)
and #128 added `Baseline trace (chromium)` (→ 9), and neither recounted. **`main` still
carries no branch protection and no ruleset** — nothing forces work through a PR, and
nothing stops a direct push. The CI gate above is on the DEPLOY, not on the branch: a red
commit can still land on `main`, it just will not publish. Two consequences of the shared
origin, neither fixable from this repo: every project page under `austinorphan.com` shares
one localStorage namespace (the game's **five** keys are all `tanks.*`-prefixed —
`progress`, `touch`, `stats`, `custom`, `achievements`, each `.v1`; this sentence said
"four" until the mobile-release investigation counted them), and the
portfolio's root-scoped `/sw.js` service worker controls `/tanks/` and deletes every
CacheStorage entry it does not own — so an offline feature here needs coordination first.

## Architecture invariants

**`src/sim/` is a pure, deterministic core.** It must import nothing from `three`,
`howler`, or the DOM. That purity is what makes it headlessly testable and makes replays
exact functions of their inputs. `src/sim/purity.test.ts` enforces it by scanning every
file under `src/sim/`; it is the only file there that mentions those packages.

**Fixed timestep.** `TICK_HZ = 60`, `DT = 1/60`. The sim never sees wall-clock time.

**Render and audio are one-way projections.** The sim emits a `SimEvent[]` stream
(`src/sim/events.ts`) and never reaches back. Consumers today: `render/renderer.ts`,
`render/particles.ts`, `audio/director.ts`, `game/haptics.ts` (issue #112's seam --
`navigator.vibrate` on web, injected so a future Capacitor build can swap in the native
plugin), `game/state.ts` (win/lose drives the game-over screen) and `game/loop.ts`. If
you change an event's shape, check all six.

`step(world, input)` clones its input and returns `{ world, events }` — it never mutates
what it is given.

**The step boundary takes a LIST.** `stepInputs(world, inputs: InputState[])` is the
primitive and pairs `inputs[i]` with the i-th `kind === 'player'` tank in tank-array
order; `step(world, input)` is a one-line adapter (`stepInputs(world, [input])`) and is
what every caller in the tree uses. The adapter must stay one line: two copies of the
single-player path is exactly what would break the argument that the golden trace hash
proves single-player behaviour did not move. Nothing else about multiplayer exists —
`config/validate.ts` still hard-fails any grid without exactly one `P`, `resolveStatus`
still defines a win as "every non-player tank dead", and four AI sites still take the
FIRST player. The pairing rules (a dead player keeps its slot; surplus inputs are
ignored; a player past the end of the list gets NO input, which differs from an idle one)
are unreachable from gameplay today and are pinned ONLY by
`src/sim/step-inputs.test.ts` — the trace drives one player and cannot see them, measured:
all 8 mutations swept there leave the hash unchanged.

**Persistence is one seam, `src/game/storage.ts`.** All five stores take an injected
`Storage`; `resolveStorage()` picks the browser's or a complete in-memory shim (the old
inline stand-in was `{getItem, setItem}` cast to `Storage`, so `removeItem`/`clear`/`key`
were TypeErrors waiting), and `createStores(storage)` gives all five the SAME one **by
signature** — resolving per store was harmless only because localStorage returns the same
object every time, and would have given each store a private namespace under the shim.
Pointing the game at Capacitor Preferences or a file-backed desktop shim is a one-file
change with a test that can fail. `src/game/save.ts` serialises those five keys as one
blob at the RAW key/value layer, deliberately not through the typed stores: they validate
on read and drop what they do not recognise, which is exactly the data an export exists to
preserve. Import writes only keys on the `SAVE_KEYS` allow-list — the origin is shared, so
a pasted blob must not be able to set a neighbour's key — and an imported save is
**invisible until reload**, because every store snapshots its key into an in-memory shadow
at construction.

**A run is recordable because the sim is pure, and the recorder is a DECORATOR.**
`src/game/replay.ts` wraps the input collaborator `loop.ts` hands the driver — `driver.ts`
already calls `input.sample()` exactly once per simulated tick, so nothing in the driver
changed. It wraps `effectiveInput`, not `input`, so an autoplay demo records the stream
`step` actually saw. A trace spans ONE world and restarts on every level switch.
**The stamp is two things**: `schema` (can this build parse it?) and a canonical, key-sorted
FNV-1a fingerprint of all four sim data files — balance, tank-defs, ai-profiles, arenas
(can this build reproduce it?). Key-sorted because JSON module property order is a bundler
artefact. It does **not** cover CODE: a change to `targeting.ts` diverges a replay with the
fingerprint unchanged, so a mismatch proves a trace is stale while a match does not prove
it is fresh.

**The RENDER ANIMATION CLOCK is a second clock, and it is now named and decided.** The sim
is fixed-step and never sees wall time; the render layer does, as the `dt` `driver.ts`
hands `renderer.render`, which forwards it to **two** consumers — `entities.sync` (an
animated skin's texture scroll, gated on `dt > 0`) and `particles.update`. `frame.ts`'s
`animationDt(dt, state)` decides how much of it a frame gets: **it runs whenever the game
is not `paused`**. Pause is the one non-simulating state a player enters deliberately to
make the board hold still, so the cosmetics stop with it; `splash`/`title` keep a live
board behind the menu, and `win`/`lose` arrive mid-explosion, where freezing would hang
debris in the air. Before it was named, the answer was "always, silently" — an unstated
consequence of the non-playing branch dropping the accumulator but still forwarding
`plan.dt`, asserted nowhere. `frame.test.ts` pins the rule and `driver.test.ts` pins that
the driver applies it, the same split `renderAlpha` has. It must stay out of `src/sim/`:
a wall clock there would break replay.

**A SKIN'S UV MAPPING IS DECIDED PER PART, and the three parts disagree on purpose.**
`entities.ts` is the only place this lives, and each rule exists because a render was
wrong in a way no numeric probe caught.

The HULL must read as one continuous surface — Austin's "the hull should be distinctly
one piece". `ExtrudeGeometry` carries THREE parameterisations: the caps come from the
shape's own (x, y), while the bevel ring and side walls come from `generateSideWallUV`,
which returns `(x, 1 - z)` or `(y, 1 - z)` and **chooses between them per quad** on
`Math.abs(a_y - b_y) < Math.abs(a_x - b_x)`. So the perimeter's own u axis flipped with
the direction of that stretch of outline. `projectBodyUV` projects the body from above
and `unrollSkirtUV` folds the skirt outward by its drop; a plain top-down projection is
NOT enough on its own, because the near-vertical walls collapse and the skirt renders as
vertical streaks (checker became columns, camo a picket fence). The unroll averages the
outward direction over every vertex sharing a position, which is load-bearing rather
than tidy: the geometry is non-indexed, so facet normals split the UV at every rounded
corner — per-facet measures 0.102506 over the VISIBLE surface (normal.y > −0.1, 729 of
1248 vertices) and 0.400000 over all 1248, against 0.000000 either way once averaged and
1.472500 for the untouched default. **State which population**: an earlier draft quoted
0.102506 bare and a reviewer reproducing it over all vertices got 0.400000 and could not
match the figure.

**Three separate guards, because one metric cannot see all three failures.**
Co-located vertices agreeing pins continuity (negative control: the unmapped enemy hull).
It is blind to the unroll, since a collapsed skirt is perfectly continuous — so skirt
TEXEL DENSITY pins that the sides are drawn at authored size, and UV footprint exceeding
the plan footprint pins that the unroll goes OUTWARD rather than folding back inward.
Both of those mutations, and collapsing `projectPlanarUV`'s `along` axis, each left the
full suite green before those tests existed.

The TURRET keeps `LatheGeometry`'s own wrap and **must not be touched**: u around the
axis is what makes checker a pinwheel and flow a swirl, and Austin asked for both by
name. The generalisation that "fixes" the hull everywhere is exactly the wrong move
here; a test compares the dome's position, normal and uv arrays against a freshly built
reference so that move fails loudly.

The BARREL is a lathe too, and its defect was DENSITY, not topology. Lathe u is one full
texture repeat around the circumference whatever that circumference is, so the same tile
was packed 2.8x tighter on the 0.82-unit gun than on the 2.26-unit turret and flow's
swirl arrived as corduroy; lathe v is INDEX-based, so the 0.05-unit flare step and the
0.4-unit tube got equal shares. `matchLatheToTurret` scales u by the radius ratio and
rebuilds v from real arc length, both against the turret. That makes u a FRACTION of a
repeat, so it no longer meets itself and there is a seam — `BARREL_SEAM_PHI` puts it on
the gun's underside, and `PI/2` is exactly 4 of the barrel's 16 segments, so the surface
is unchanged and only the seam moves. Pick an angle that is not a whole number of
segments and the silhouette rotates with it.

`stripes` is the exception to all of it: a hard-edged band wrapped around a lathe axis
arrives as pie slices, so its turret and barrel are projected flat. `STRIPE_TURRET_MODE`
is `'body'` — one field at world scale, 0.084 wide on every part, which Austin chose from
renders ("I like continuous stripes actually"). `'part'` normalises each part to its own
half-width (0.084 / 0.069 / 0.025 on hull / turret / barrel) and was rejected because the
three sets do not line up. Pinned through the behaviour — all three parts must share one
v scale — not through the constant alone.

**CAMO AND CLOUDS ARE DIFFERENT SHAPE LANGUAGES — but only camo got a new generator.**
They shared one `blotches` helper (lobed clusters of circles) and differed only in count,
radius and lobes, so Austin twice reported them as swapped. The coverage WAS backwards
and swapping it was necessary — camo covers, clouds does not — but it was not sufficient,
because two skins cut from one silhouette generator read as versions of each other at any
density. `camoCells` is now a seeded power diagram: hard-edged interlocking polygons,
straight edges, no arcs, which a circle-based generator cannot produce at any parameter
setting.

**A soft-edged clouds generator (`cumulus`) was built for the other half of that split
and REJECTED ON LOOK** — "before clouds looks better actually" — so clouds is back on
`blotches` at the sparse post-swap setting, byte-identical to the texture it had at
`76ef38a`. `cumulus` is deleted rather than parked behind a switch; a generator nothing
calls rots. Do not rebuild it without new evidence: PR #139 carries the tile render it
lost on.

Two pins moved with it, and both had said something that stopped being true:

- **Coverage is measured by EXACT hull-hex equality.** It briefly used a nearest-tone
  classifier, which was genuinely forced by `cumulus`'s rim pixels (they equal no tone
  exactly, scoring 0.5913 exact against 0.6484 nearest). With both skins hard-edged again
  the two metrics are the same function — measured equal to 4 dp on all 12 (skin, hull)
  pairs — and exact is the one that cannot be fooled, since nearest has to guess the
  three flat tones by taking the three commonest.
- **The shape discriminator is EDGE GEOMETRY, not edge hardness.** Hardness now reads
  0.0000 for both. The test measures the share of boundary pixels lying on a locally
  straight run (7px window, 0.6px RMS): camo 0.2855, clouds 0.0355. Three cheaper
  candidates — base-region connectivity, triple-junction count, accent-meets-accent
  boundary share — were tried first and all three collapsed under a coverage-matched
  control, scoring camo's generator at clouds' coverage the same as clouds. The straight-
  run metric does not (0.2651 there), which is what makes it a shape metric rather than a
  density one wearing a shape's name.

Both skins still tile toroidally and stay deterministic from one seed, and neither tone
derivation moved: `autoAccent` keeps camo muted, `cloudTone` keeps clouds light, and the
white hull's deliberate darkening survives.

**`clouds is LIGHT on every hull that has room to be` was a tautology for two commits**,
which is worth knowing because nothing announced it. It read the tile's commonest colour
as "the dominant tone, the second one painted" — true only at the DENSE setting. The
density swap made the hull itself the majority tone, so that colour became the hull, and
the comparison became `hullL < hullL`. Forcing `cloudTone` to darken unconditionally left
it green. It now excludes the hull before taking the commonest, and the same mutation
fails it on 5 of the 6 hulls (all but white, which is allowed to darken).

**Entity configs are data, resolved through `src/sim/config/`.** A tank is
`TankDefinition` (`data/tank-defs.json`) + `BalanceConstants` (balance.ts, whose
AI profiles come from `data/ai-profiles.json`) → `resolveTankConfig` →
`ResolvedTankConfig`, read via `configFor(kind)`; gameplay code never branches
on a kind literal **to pick stats or behaviour** (identity checks like
`kind === 'player'` and the render's per-kind texture choice remain). The JSON
is validated at module load by `validate.ts` — a bad edit is a boot failure
naming the exact path, and the validator's own tests carry negative controls.
Adding a `TankKind` member is a compile error until `TANK_KINDS` (validate.ts)
lists it, which is what forces the JSON entry. Walls are the second family on
the same catalog machinery (`walls.ts`, `wallConfigFor`); new families
(power-ups, turrets, bosses) should ride `createCatalog` rather than invent
parallel plumbing. The **authoritative balance scalars live in
`config/data/balance.json`**; `constants.ts` derives from it and stays the
sim's one import site, so retuning is a two-file edit — the JSON entry and its
literal pin in `constants.test.ts` (every balance.json value is pinned;
`SHELL_SPAWN_FORWARD` stays a TS literal, render-coupled).
`decideAi` routes by the resolved profile's `behavior`; grey's dodge patience is
`(1 − aggression) · TICK_HZ`, rounded, pinned equal to `DODGE_PATIENCE_TICKS` in
`config/roster.test.ts`. Profile fields consumed today: `behavior`, `aggression`,
the signs of `directShotWeight`/`bankShotWeight`/`minePlacementChance`, and the
movement band — `preferredDistance`/`minimumDistance`/`retreatChance` (magnitude
included) drive `seekMove`, the mobile decisions' baseline move (approach beyond
preferred, seeded retreat draw inside minimum, wander in the band; tuned by
sweep, see `SEEK_APPROACH_BIAS`) — and `aimAccuracy`: per-profile jitter is
`AI_AIM_SPREAD / aimAccuracy` (`profileAimSpread`), the anchor being a
perfect-accuracy profile's spread; curve chosen by sweep, see the anchor's
comment in constants.ts — and `minePlacementChance` in full: its magnitude is
the per-bucket mine-proposal probability (`mineInclination`) — and
`reactionTime`: the dispatcher holds every AI shot until the solution has been
HELD (`Tank.aimTicks`, `AiDecision.hasSolution`) for the profile's reaction
span; cover resets the clock. **Every profile field is now consumed**, including
both shot weights in BOTH mobile and stationary implementations — `brown.ts`
gained bank shots gated on `bankShotWeight > 0`, which is what makes
RICOCHET_SNIPER (the **green** tank, level 4) a real enemy rather than authored
intent. It prefers the DIRECT shot and falls back to the bank, where `teal.ts`
alternates: a turret that can already see you has no reason to take the longer
path. Brown is unaffected because STATIC_BASIC carries `bankShotWeight` 0 — proven
by an identical trace hash over 4 arenas × 6 seeds × 2500 ticks, with a control
showing the probe moves when banking is switched on.

**A green tank changed what `structuralFailures` has to check.** "No enemy sees
the player spawn" tested `lineOfSight` only, which was the same as "no enemy can
SHOOT the player spawn" for exactly as long as no stationary enemy could bank.
There is now a second rule: no STATIONARY banking enemy may hold a ricochet path
onto the spawn. Restricted to stationary bankers on evidence, not taste — applied
to every banking profile it rejects shipped arena-01 (grey banks onto the spawn
off 1 wall, teal off 2) and arena-04's teals. Mobile tanks leave that geometry
within a second; a turret never does. `BANK_SIGHTLINE_ARENA` is the negative
control, and swapping its one spawn letter for `T` and `B` controls the
behaviour gate and the weight gate separately.

**`determinism.test.ts` does not catch AI behaviour changes**, which is easy to
assume it does. It asserts self-consistency — same seed, same result — and that
is invariant under behaviour changes: giving brown a 0.5 `bankShotWeight` leaves
all 7 of its tests passing while a trace probe moves. When that mutation was first
run it passed the WHOLE suite (1155 tests); it now fails 5 tests in 2 files,
because green's arrival added tests that watch the bank path — so the hole is
narrower than it was, and the general point stands. Any claim that an AI edit is
behaviour-preserving needs a golden trace comparison, not a green suite.

STATIONARY still ignores `preferredDistance`/`minimumDistance`/`retreatChance`,
and always will: they are a distance band for a tank that moves. "Every profile
field is consumed" means consumed by the implementations it applies to. The 9-type Wii taxonomy in `config/reference/` is reference
data only — nothing in the game reads it.

**Arenas are data too.** Grids, design rationale (`notes`) and machine-checkable
design `claims` live in `config/data/arenas.json`, validated at load by
`validateArenas` — a bad edit is a boot failure naming the exact path (e.g.
`arenas[2].grid[4]`). `arena.ts` keeps every export it always had; `SPAWN_LETTERS`
(`config/arena-types.ts`) is the single source of the spawn-letter map for the
validator and `loadArena` — green is `N`, because grey already holds `G` and
re-lettering grey would rewrite every shipped grid — `src/sim/sandbox.ts` keeps its own `KIND_LETTER`
table (plus a hardcoded `'P'`) for grid GENERATION, so re-lettering a kind in
`SPAWN_LETTERS` without also updating `sandbox.ts` would leave the dev sandbox
emitting a character `loadArena` rejects. Three claim types —
`sightlineAfterBreach`, `lane`, `spawnBlockRobust` — are verified by
`src/sim/arena-claims.ts` from the test layer (it imports the AI's
`lineOfSight`, so it must never be imported by `config/`). `sightlineAfterBreach`
is all-or-nothing per arena: declaring one commits the arena to declaring one
for EVERY enemy spawn, checked by set equality (both directions) in
`arena-validation.test.ts` — an arena's claims of this type are a COMPLETE
statement of its post-breach spawn lines, never a sample (an arena may still
declare zero, as arena-01 does). `spawnBlockRobust` checks more than its name
suggests: every enemy spawn against 4 cardinal nudges of the player, in BOTH
wall phases (intact and breached) — measured across all 6 scenarios that can
run it (arena-01, arena-02, arena-03, arena-04, and the two fixtures built in
`arena-claims.test.ts` to discriminate the phases), 0 failures were
intact-only, so the intact phase's value is labelling which wall state a
failure lives in, not added detection power on its own; the breached phase is
what actually catches a corner tangency. arena-04 contributes 0 failures in
either phase (0 of 24 probes each: 6 enemies × 4 cardinal nudges). Only 5 of
those 6 DECLARE the claim —
arena-02 does not, because checked the same way it fails 12 of its 16
breached-phase checks (0 of 16 intact): the level's design is to open
sightlines when its centre barrier breaches, not survive it. The switch case in
`arena-claims.ts` only runs a claim type an arena actually DECLARES, so nothing
about arena-02's number falls out of the claim runner — it is recomputed
instead by its own test in `arena-validation.test.ts` (denominator pinned at 4
enemies × 4 cardinal nudges), which fails if that grid changes. Deliberately
not a claim: making it one would assert a property arena-02 does not have. Adding a level is editing JSON: the generic runner in
`arena-validation.test.ts` picks up its claims automatically, and `npx vitest
watch src/sim/arena-validation.test.ts` is the authoring loop — though the
claim MIX itself is pinned separately by that file's `EXPECTED_CLAIMS` table,
so changing an arena's claims is a deliberate two-file edit. `spawnBlockRobust`
exists because arena-03 once shipped a corner tangency a 0.1-unit nudge opened.
A `lane` claim's `from`/`to` are LITERAL grid cells, not tied to a spawn by the
validator (`cell()`, not `enemySpawnCell()`) — moving the spawn a lane's `why`
refers to does not invalidate the claim, which keeps measuring the same two
cells and keeps passing; arena-03's two lanes and arena-04's seven survive this
only because every one of them has an enemy spawn at its `from` end carrying a
`sightlineAfterBreach` claim at that same cell, which DOES require a live spawn
there and so catches the move at load time instead. Their `to` ends are plain
floor cells and are pinned by nothing — moving a wall so a lane's target cell
stops meaning what its `why` says is a change no test can see. See the `lane`
variant's doc comment in `config/arena-types.ts`.

**arena-04 is the first shipped board that is not 33x27** (45x33; world dimensions are
unchanged by the 3x cell-size rescale — only the cell counts moved), so PR #53's
per-level render refit is now exercised by a level players actually reach rather
than only by a fixture. `WIDE_ARENA` moved 15x11 -> 17x13 when it landed, because
`arena-validation.test.ts` asserts the fixture differs from every shipped arena
and a fixture whose whole job is to be an unshipped size gives way to production
data. Three distinct board sizes are now covered.

**Adding a level moves more pins than the level file.** Five places moved when
arena-04 landed; arena-05 then proved that list stale in both directions, so the
checklist below is ARENA-05'S measured list, and the lesson is to re-derive it
each time rather than trust this paragraph: `cell-mapping.test.ts`'s cell and
spawn totals (5864 / 33 since arena-05); `EXPECTED_CLAIMS` in
`arena-validation.test.ts` (the claim mix, not a count); that file's cover-ratio
`EXPECTED` table (and its `tightest` assertion, which names one arena);
`framing.test.ts`'s two `ARENAS.length` pins; `difficulty.test.ts`'s per-arena
`EXPECTED` table and arena-list assertion (landed after arena-04, so the old
checklist never knew it); the `demolition` threshold in `achievements.ts`
(derived from the total destructible-cell count, which a new arena moves);
`BASELINE_HASH` in `tools/baseline/trace.test.ts` (the trace runs over ALL
shipped arenas); and the `framing-fit-bracket-4.5` entry's `expectFailures` in
`tools/mutate/manifest.json`. Two items from arena-04's list dropped off: the
`variable arena dimensions` fixture block only moves if the new size collides
with a fixture, and the "three size labels in `tools/gl/harness.ts`" no longer
exist — grep at arena-05 found no arena-size prose there to update. The harness
labels were prose, so nothing failed when one was missed — review caught it —
and the same class of miss is why this paragraph now says re-derive. Any number a `notes` string quotes is likewise unpinned by construction:
`notes` are validated as strings only. Three blocks in `arena-validation.test.ts`
exist purely to recompute quoted prose — arena-02's `12 of 16`, arena-04's cover
ratios, and arena-04's bank-reach count (275 cells reached by ricochet, covering
171 of the 284 nothing else sees) — because all three were measured once by hand
and nothing checked them again. Quote a measurement in `notes` and you owe it a
recomputing test.

**Walls load as geometry, not as cells.** `loadArena` merges SOLID cells into maximal
rectangles (`mergeSolidRuns`) and numbers tanks from a counter of their own. Both exist
because four parts of the sim read the wall ARRAY rather than the arena's shape, and
the 3x resolution upscale exposed all four: tank ids shared a counter with walls, so
wall count reseeded every per-tank RNG stream in `ai/targeting.ts`; `resolveWalls`
applied one push per overlapping wall, so a sliced wall pushed several times and its
interior seams offered phantom corners; `bankShot` chose the first reflector in
wall-array order; and `circleVsAABB`'s `inside` branch resolved a hull escape
differently depending on which sub-cell box it was handed.

**The bank-shot dependence turned out to live one function deeper**, which is worth
knowing before anyone "simplifies" it. `bankShot` now picks the SHORTEST muzzle ->
bounce -> target path, ties broken on the angle, so its answer is a property of the
arena rather than of the array. But the defect a subdivided wall actually triggered was
in `losIgnoring`: a bounce landing exactly on a seam put the segment's own ENDPOINT on
the neighbouring box's corner, and `raySegmentVsAABB` counts a boundary touch as a hit,
so a legitimate shot was reported blocked. `losIgnoring` now disambiguates with
`headingIntoBox` — the same direction-probe form `reflectSweep` already ships, NOT the
step-out-along-the-normal form this file records as tried and reverted. It is safe here
for a structural reason: `losIgnoring` has exactly two callers, both inside `bankShot`,
so it cannot reach `reflectSweep` and cannot reopen the escape bug.

An explicit `faceIsBuried` guard was written first and then DELETED, on evidence with a
stated DOMAIN — the unqualified version of this paragraph was falsified in review. With
both endpoints strictly outside every wall, which is the only state the sim produces
(`resolveWalls` keeps every hull centre out of the mass), removing the guard changed
0 of **4,195,692** (muzzle, target) probes across 12 synthetic shapes and all 4 shipped
arenas' real merged geometry. With an endpoint exactly ON a wall surface it is not a
no-op: **81 of 1,966,116** probes differ, all on arena-03. So the guard is unnecessary
because of REACHABILITY. The structural argument this file used to give — "if a face is
buried the neighbour occupies the space outside it, so any ray reaching it is already a
real penetration" — is FALSE, and there is a witness: an approach arriving exactly at the
seam CORNER only touches the neighbour, and the graze check correctly lets it through.
`targeting.ts:277` is the ledger of record. Do not re-add the guard without a fixture
that fails when it is removed — and such a fixture has to put an endpoint on a wall
surface, which is why none exists.

**Destructible walls are never merged**, and that is a rule, not an oversight. A
destructible cell is a destruction UNIT: mine blasts destroy by world-space radius
(`mines.ts`), so a finer grid means finer breaching. arena-02's centre barrier is
authored as adjacent blocks whose separate destruction is the level's design.

**The fourth is the hull-escape case: a hull INSIDE a wall escapes the mass, not the
sub-cell.** `circleVsAABB`'s `inside` branch pushes out through the nearest face of the
ONE box it is handed, which for a sub-cell is usually a buried internal seam — so the
same hull in the same place resolved differently depending only on the slicing
(measured: 780 of 1,681 interior centres on an isolated destructible mass).
`resolveWalls` now marches box to box along each axis to find where the wall MASS ends,
which is a property of the union. `circleVsAABB` itself is untouched, because
`bullets.ts` depends on it. This was reachable, not theoretical:
`separateTanks` drives hulls up to 0.375 units into a block and `stepMovement` calls
`resolveWalls` immediately afterwards.

**Two numbers in this section are NOT pinned by any test**, which by this file's own rule
is a debt: the 780 above (an independent reconstruction at the pre-fix commit measured
774, a 0.8% difference nobody has resolved — treat it as "most of an isolated destructible
mass's interior", not as a figure), and `targeting.ts`'s buried-face probe count, whose
guard is deleted so nothing can ever re-derive it. The decomposition GUARANTEES are pinned,
by `decomposition.test.ts`; these two provenance figures are not.

`src/sim/decomposition.test.ts` pins the property directly — the same geometry
expressed at two cell sizes must agree on `resolveWalls`, `lineOfSight` and `bankShot`.
`tools/baseline/trace.test.ts` is a golden trace over 5 arenas x 6 seeds x 2500 ticks
(4 until arena-05 joined — the trace runs over ALL shipped arenas, so adding a level
moves `BASELINE_HASH` by construction) and is now ASSERTED, not merely printed:
`determinism.test.ts` only proves
self-consistency, which is invariant under behaviour changes. **Know what it does not
cover, RE-MEASURED at the 4-arena tree (arena-05 has not re-measured these probes;
the hash values below predate it).** Mutating `bankShot` to return the first
valid candidate instead of the shortest changed the then-current hash (to
`0cf1f76a14060992eb8763c9cd20e95b8c17cde2d1dbe3e8de6c87ff47137e9a`) and fails the test —
a later change to `resolveWalls` altered trajectories enough that bank shots now DO
influence the trace, even though the bank-shot rewrite itself did not move it when it
first landed. Mutating the inside-wall escape (disabling `resolveWalls`' union-mass
marching so a hull inside a wall resolves through the single sub-cell box instead) still
leaves the hash unchanged: the seeded replay never drives a hull inside a wall, so that
path stays uncovered. The lesson generalises: a coverage claim recorded at one commit can
go stale as later changes alter trajectories, so re-measure rather than carrying it
forward. The decomposition guarantees are held by `decomposition.test.ts`, not by this
hash.

**The trace body lives in `tools/baseline/trace.ts` and runs in a BROWSER too.** It
imports `src/sim` only and hashes through `crypto.subtle` + `TextEncoder` rather than
`node:crypto`, which is the whole reason it can: the same code under vitest and under
Playwright. `npm run trace:browser -- --all` serves `tools/baseline/page.html` on
localhost (secure context — `crypto.subtle` is undefined without one) and prints one hash
per engine. Measured on this box at the 5-ARENA trace (2026-08-11, the day arena-05
landed): **chromium 151, firefox 153 and Playwright's webkit (JavaScriptCore, UA-spoofed
as macOS Safari but a Linux build) all produce `324aa9b5…`, matching the pinned
baseline** — so V8, SpiderMonkey and JSC agree on this trace, on Linux x86-64, headless.
(The 4-arena trace's three-engine agreement on `015a5d17…` was the same result at the
previous baseline; a new arena moves the hash by construction, so this re-run is owed
again after every arena. CI's `Baseline trace (chromium)` step keeps V8 current on every
push; firefox and webkit only re-verify when someone runs `npm run trace:browser --
--all`.) **That is not the whole question**: shipped Safari, iOS and non-x86-64 CPUs are
untested, and one matching hash is agreement on the sampled trajectory, not a proof
about `Math.hypot`. Take the remaining half by opening `page.html` by hand on the device.

## Testing conventions, learned the hard way

These are not style preferences. Each one exists because a real defect shipped green.

**Unit files call sim stages directly, so they cannot see composition.** `movement.test.ts`
and friends call `stepMovement` themselves, which means deleting the call from `step()`
leaves them passing. Composition is pinned separately, through `step()` alone, in
`src/sim/step-pipeline.test.ts`. Anything asserting *that a stage runs* or *in what order*
belongs there and must not call the stage directly.

**Presence-only assertions on the event stream are close to worthless.** The stream is
shared: `some(e => e.type === 'fire')` passes on an AI tank's shell even when the player's
event is dropped entirely. Discriminate by `ownerId`, and assert payloads (`pos`, `angle`)
— `particles.ts` draws bursts at exactly `ev.pos`, so a wrong position is a visible defect
that no presence check catches.

**Prove the gap before writing the test.** Apply the mutation, watch the suite pass, then
write the test, then watch the mutation die. A test that never failed proves nothing.

**Sweep classes, state denominators.** Write "32 of 36 (population: all 36 distinct
single-element moves)", never "32 of 36". A count without its population reads as an
exhaustive sweep. Name any class you did *not* sweep. This repo has twice shipped a
survivor hiding in an unstated remainder.

Two habits that come from the same place. The RECURRING failure is attribution rather than
arithmetic — the figure was really measured, then carried into a sentence it was not
about. (Not the only one: `CLAUDE.md:81` records a plain miscount, four keys where there
are five, which no amount of naming the probe would have caught.) **State the derivation
inline** so the arithmetic is checkable (`skins.ts:142`: "5,832 accents on a 15-step RGB
grid (18 values a channel, 18^3)"). And **when two probes appear in one paragraph, put
each one's population next to its number** — `skins.test.ts:771` does this explicitly,
because an earlier draft there conflated them and quoted a 483,695 hit count from the
909,792-pair probe against the coarser 33,696-pair sweep, claiming more hits than the
sweep had trials. That is catchable by reading alone, but only if the populations are on
the page.

**Counts are a property of the tree at the moment you ran them**, so measure them LAST:
writing a test changes them. `tools/mutate/run.mjs:30` exists because of this — "fails 4
of 12" quietly becoming "fails 5 of 13" when a test is added is `killed` both times, which
is why the manifest carries `expectFailures` rather than an outcome alone. The same
applies to any test total quoted in a PR body.

**Every assertion must be able to fail.** Before adding one, name the production change
that would break it. Watch for tautologies against the fixture: asserting `angle: 0` in a
fixture whose angle is 0 passes even when the field is hardcoded. Decorative assertions are
worse than none — they advertise coverage that does not exist.

**Files no test reads are where defects live forever.** `hud.css` lost a closing brace in
a merge and silently swallowed every rule after it -- the entire losing-a-life vignette was
dead on `main` for as long as the feature existed, and a second merge did the identical
thing to the round banner. Neither `tsc` nor any test could see it, because CSS is not
typechecked and nothing read it. `hud.css.test.ts` now checks brace balance, checks no
block opens inside a plain rule (at-rule aware), and checks the selectors features depend
on are still present. It needs `test.css: true` in `vite.config.ts`: vitest stubs CSS
imports, so `?raw` returns an **empty string** and every assertion passes vacuously --
which is why that guard asserts it loaded something first. Any new stylesheet wants the
same treatment.

**A guard is worth what its own tests prove.** The purity guard reported green for four of
five known-bad imports until it was given a meta-test. Guards need negative controls.

**An assertion can stop meaning what its name says without anyone touching it.** It does
not need to be edited to go blind — its SUBJECT changing underneath it is enough, which
makes this different from the tautology-at-write-time above. Two cases, and the useful
thing about both is that each was caught inside the PR that broke it, which is why either
is recoverable at all:

- `clouds is LIGHT on every hull that has room to be` took the commonest tone in the tile,
  on the stated reasoning that this was the painted one. That reasoning held only while
  clouds was dense — an unstated property of its subject. #139's density swap made the
  HULL the majority tone, so the comparison became `hullL < hullL` and could never hold;
  forcing the production function to darken unconditionally left it GREEN, the exact
  property it exists to guard, inverted. Measured over all 6 shipped hulls at both
  commits: the hull's share goes 0.2791 -> 0.5781, and goes from not being the top tone to
  being it, on every one. Broken and repaired inside #139.
- The metric separating camo from clouds was EDGE HARDNESS, which worked only while clouds
  had a ramped rim. Reverting that generator made both skins hard-edged and the metric
  read 0.0000 for BOTH — it would have had to be asserted as EQUAL to keep passing. Also
  written and replaced inside #139.

The rule: **when you change what a test's subject is, re-run that test's own mutation
against it.** A test written against the old subject is evidence about the old subject
only. `skins.test.ts` records both cases in place, each with the mutation that proves the
repaired form fails.

**A guard blind to one dimension stays green until that dimension moves.** Reversing
`applyPlayerInputs`' loop order (`for (i = n - 1; i >= 0; i--)`, pairing untouched) passed
the WHOLE gate as it then stood: 87 files passed, 1730 passed, 2 skipped, 0 failed. The
neighbouring two-player test `.sort()`s the ownerIds — correct for the question it asks
("did each player get its own shell") and exactly what hid the ordering. It is not
cosmetic: `world.nextId++` is consumed in drive order, so the reversal renumbers every
shell. Pinned unsorted now, in `step-inputs.test.ts`. The golden trace passed too, but for
a reason that does not generalise: the trace drives ONE player, so `n` is 1 on every tick
and reversing a one-element loop is bit-identical. Before trusting a suite as a behaviour
proof, name the dimension it sorts, rounds or aggregates away.

**A green local gate is not necessarily the gate.** Three ways it has lied here:

- **`node_modules` drifting from the lockfile.** A worktree in this repo sat on vite
  5.4.21 / vitest 2.1.9 while `package-lock.json` pinned 8.1.5 / 3.2.7 — versions
  `package.json`'s own `^8.1.5` / `^3.2.7` ranges do not even admit — and one
  `tools/mutate` test failed locally and nowhere else. `npm ci` fixed it. The direction
  was luck: a stale tree can as easily go green on something CI fails. If a local result
  disagrees with CI, check `npx vitest --version` against the lock before debugging the
  code.
- **`tools/` is typechecked by nothing.** `tsconfig.json` includes only `["src",
  "vite.config.ts"]`, while `vite.config.ts` runs `tools/**/*.test.ts` — so those tests
  RUN under `npm test` and `tsc` never reads the files. A duplicate declaration there
  passes the gate and surfaces as a bare timeout under `npm run test:gl`. See backlog item
  9, under "Customize preview residuals" — that numbering is section-relative, so grep the
  title rather than trusting the number.
- **A zero exit code is not verification.** Separate shell lines do not inherit the
  previous line's failure: a heredoc `python3` that raised and wrote nothing, followed by
  `gh pr edit --body-file`, re-published the UNCHANGED body and printed "edited". Read the
  value back and grep it for the string you expect to be **gone**, not only the one you
  expect to be there.

## Merge bar

Nothing reaches `main` without comprehensive adversarial review: reviewers fan out per
subsystem and must prove each finding with a command and its real output, then an
independent pass adjudicates every claim. Re-measure headline numbers yourself rather than
relaying an agent's self-report.

Review agents that *mutate* files each need their own worktree, or they overwrite each
other's experiments and every result becomes noise.

## Dev flags

Unshipped work lives behind a flag in `src/game/devflags.ts`, on `main` — **not on a
long-lived experimental branch**. Both approaches were measured before choosing:

- Flags cost **4.15 kB raw / 1.45 kB gzipped**, 0.8% of the bundle.
- An unmerged branch (`round-ux`) had NOT rotted after 11 commits — it merged clean and
  passed. Branch rot is not the argument.
- What the split *did* cost was real: `devflags.ts` ended up on two branches at 40 and 53
  lines and had **already diverged**, in the one file whose job is to be the single place
  flags are defined.

The deciding reason is CI. Code on `main` is exercised on every run; a branch is exercised
only when someone updates it. `round-ux` passes today, and nobody would learn the day it
stopped.

The flags today: `aimRay`, `shellCount`, `seed`, `mineTrigger`, `mineReach`, `mineTimer`,
`quality` (a valued flag, `low|medium|high` — render preset, see `render/quality.ts`),
`invincible`, `autoplay`, `saveIo`, `replay`, `gamepad` (issue #114: merges gamepad[0]
into keyboard/mouse/touch, single player only -- see `src/input/gamepad.ts`), `level` (a
1-based jump, or `level=sandbox`), and the sandbox knobs
`tanks`, `disarmed`, `walls`. `playtest=1` is a parse-time BUNDLE, not a field: it
expands to invincible + shellCount + mineReach + mineTimer. `parseDevFlags` derives the
boolean list from `DEV_FLAGS_OFF` in its tests, so adding one cannot quietly shrink what
they cover.

**`roundPhaseHud` is the first flag to complete the cycle: it SHIPPED, so the flag is
gone and the behaviour is on.** The round opens with `COUNTDOWN_TICKS` (3.0s) in which
movement is blocked; with no HUD, the player pressed a direction and the game read as
broken for three seconds of every round and every respawn. `devflags.test.ts` pins that
the retired key is not merely ignored but absent, so a stale `?dev=1&roundPhaseHud=1`
link cannot read as still meaning something.

Two rules follow:

**Nothing is on unless `dev` is present.** `?aimRay=1` alone does nothing; it needs
`?dev=1&aimRay=1`, so a shared link cannot enable anything by accident.

**A flag is temporary.** It exists so work can land tested and unshipped, not so `main` can
accumulate features nobody decided on. Each one should end up either shipped — flag deleted,
behaviour on — or deleted outright. A flag with no owner and no decision is the thing this
arrangement is meant to avoid, and it is worse than the branch would have been.

Flags are **build-time-free but not free**: they are parsed at runtime, so they must never
reach `src/sim/`. That core is pure and deterministic, and a replay has to stay an exact
function of its inputs — a runtime-varying flag there would break it. `MINE_BLAST_THROUGH_DESTRUCTIBLE`
is a *constant* for exactly this reason.

## Numbers that are feel, not measurement

Some constants were chosen by eye and are cheap to change; the tests are written against
the constant rather than a hardcoded result, so retuning does not mean rewriting tests.

- `TANK_TURN_RATE` (5.0 rad/s) -- how fast the hull swings. Modelled on Wii Play: Tanks!
  from recollection, **not measured against it**. Must stay below
  `PLAYER_TURRET_TURN_RATE` (8.0): a hull that outturns its own gun makes aiming while
  moving feel like fighting the tank.
- `MINE_BLAST_EXPAND_TICKS` / `MINE_BLAST_HOLD_TICKS` (5/5) -- the blast ramp. **Measured**
  to be a feel change, not a balance one: at `TANK_SPEED` 3.0 a tank covers 0.25 units
  while the blast expands, 10% of the 2.5 kill reach. 60 seeded games, 25 detonations,
  7 tanks in reach, 0 escapes either with the ramp or with it flattened to instant.
- `BLAST_FLATTEN` (0.7), `BLAST_LINGER_TICKS` (2), `MINE_DOME_H` -- pure look. Compare
  candidates with `npm run gallery --sweep` rather than guessing.

**`GRACE_TICKS` is 0 -- the grace phase is switched off**, but its machinery is intact.
`roundPhase` and `roundPhaseTicksLeft` delegate to pure `phaseAt(elapsed, countdown,
grace)` and `ticksLeftAt(...)`, which are tested at a POSITIVE grace span precisely so
turning the constant back on does not land on untested code.

## Commits

No `Co-Authored-By` or tool-attribution trailers — the history carries none. `gh pr merge
--squash` concatenates branch commit messages into the merge commit, so pass an explicit
`--body` to control what lands.

## Known holes

`src/main.ts` still has no test file and cannot have one: it runs at module scope against
`document.getElementById('app')`, so importing it starts the game. It is now **wiring only** —
everything it used to do (the WebGL error page, the teardown registration) lives in
`src/boot.ts`, which takes its collaborators as arguments and is tested. Keep `main.ts` free
of logic; anything added there is unpinned again, and that is the whole of its remaining risk.

The game loop used to be the worst of these — `while (false && acc >= DT)`, the shipped
game never simulating a tick, passed the full gate. It is now split across `game/frame.ts`
(pure timestep maths), `game/driver.ts` (the frame loop, clock and rAF injected) and
`game/loop.ts` (construction and wiring, dependencies injected as factories), each with a
sibling test file. **Two seams there are load-bearing and easy to lose in a tidy-up:**
`driver.ts` reads `sm.state` twice per frame and the reads must not be hoisted into one
const, because `onEvents` flips the state between them; and `Driver.world`/`prevWorld` must
stay getters, since a plain property snapshots at construction and `tsc` will not warn.
`loop.test.ts`'s last describe block exists because `driver.test.ts` injects fake hooks and
so cannot see whether `loop.ts` wires the real collaborators into them — the composition
blindness above, one layer up. Do not delete it.

Modules with no sibling test file, re-swept at `620eef4`: `main.ts`, `render/aimray.ts`,
`render/renderer.ts`, `render/scene.ts`, `sim/ai/decision.ts`, `sim/ai/index.ts`.

**A missing sibling file is not the same as untested, and for three of those five it is
now actively misleading.** `sim/ai/` is exercised through `sim/step-integration.test.ts`,
with 15 files asserting AI behaviour. `render/scene.ts` and `render/renderer.ts` **are
tested** — in a real browser, by `tools/gl/harness.ts`, because they build a
`WebGLRenderer` that vitest cannot construct. Run them with `npm run test:gl`; CI runs them
in the `visual` job. That covers the ground plane's dimensions, the resize re-fit,
`dispose`, and `screenToGround`'s canvas-rect handling — none of which `npm test` can see,
so **a green `npm test` is not the whole gate for `src/render/`**.

The one module genuinely without coverage is `main.ts`: it runs at module scope against
`document.getElementById('app')`, so importing it starts the game and no test can reach it.
Its logic lives in `src/boot.ts`, which is tested; keep `main.ts` free of anything else.

**Deferred work goes in `docs/superpowers/backlog.md`** — spikes carry what the question is
and what would answer it; the ledger below them carries one-line pointers. A PR that defers
something adds its entry in the same PR, **and a PR that closes something deletes its entry
in the same PR.**

**Issues or backlog?** One question: **can a PR close it?** If yes it is an issue — file it,
and `Fixes #N` closes it on merge, which is upkeep you do not have to remember. If it needs a
decision or a measurement *before* anyone could write that PR, it is a spike here.

That test does not partition cleanly, and saying it does would be worse than admitting it.
Some ledger lines are closable by a PR *and* carry a figure this file's guard recomputes —
the inert density knob and the unreachable tracks. When both apply, prefer the issue and
move the measurement with it. An earlier draft of this paragraph tried a three-part test
("owner, state, close event"); **none of the eight issues filed so far has an assignee**, so
the owner limb rejected every example that motivated the rule.

**What is binding today**, whatever should happen eventually: the ledger exists, the
delete-when-you-close rule above applies to it, and `tools/backlog.test.ts` gates its counts.
If it migrates to issues that is a deliberate change, not attrition — "it should have been an
issue" is not a reason to leave a closed line sitting in the file.

One collision worth knowing: a ledger line ends in `#N` meaning **the PR it came from**, and
an issue is also `#N`. Write `issue #N` when you mean an issue.

The second half is the one that rots, and it is not a tidiness rule. When the previous
arrangement was finally harvested, a one-pass triage enumerated 147 items across the PRs it
swept and found **63 already done** — roughly two in five. Read that as an order of magnitude
rather than a rate: what counts as "one item" was a judgement call, not a command; the swept
set is enumerated in `backlog.md` rather than defined by a predicate (three drafts stated it
as a PR count and all three were false); and the PRs recording deferred work only in prose
were not swept. `docs/superpowers/backlog.md` carries the breakdown.

Two caveats on using it as evidence, since both cut against the rule. Nobody *could* have
struck those out — a merged description is immutable, so the rot was structural rather than
negligence. And `backlog.md` is days old, so its own rot rate is unmeasured. The number is
the reason to expect the failure here, not proof it has happened. What it does establish is
the cost: a reader who cannot separate live entries from dead ones has to re-derive them,
which is the whole expense the file exists to remove. Deleting the line is part of the work,
not follow-up to it.

`tools/backlog.test.ts` makes the deletion cheap to get right rather than merely required:
it cross-checks the ledger's stated counts against the list itself and pins no count literal
of its own, so deleting a line and updating the `Counts:` paragraph is a **one-file edit that
goes green**. It shipped with literals first, which made this sentence false — fixing the
header left the build red until the TEST's expected values were edited too, and "repair the
red build by changing what the test expects" is the habit that ends guards. If you find
yourself editing an expected count in `backlog.test.ts`, stop: you are removing the guard,
not satisfying it.

**What it does not see: everything above the `## Ledger` heading.** The spikes and the
numbered follow-up entries are unguarded, so closing one goes green either way — and closing
a spike often strands ledger lines that cite the same PR, so grep for that PR number before
calling it done. Green is not evidence you got this right; red is evidence you did not.

Two cases the binary rule does not cover. If a line bundled several facts and only one is
settled, **rewrite it down to what is still true** rather than deleting it, and say in the PR
body which half closed. If you verify a line and find it **false rather than done**, delete
it and itemise it under "Where the numbers went" — two lines already there were removed that
way. A wrong entry costs a reader more than a missing one.

That file exists because the previous arrangement was "merged PR descriptions carry the
detailed residual backlog". Roughly a quarter of merged PR bodies carry an ATX heading
matching `/residual/i` and about half mention deferred work anywhere
(`/residual|backlog|defer|follow[- ]?up|future work|next step|out of scope|not doing/i`) — so
finding an open item meant reading every PR body and hoping. **Deliberately no counts here:
they move on every merge, and each time one was written down it was stale within the hour.
Run the predicate if you need a number.** A first pass harvested most of the PRs with a
heading; those recording deferred work only in prose have NOT been swept, so a merged PR body
is still the only home for some of it.

Most of this section is a landmine map rather than a task list: it records what has already
been tried and must not be re-attempted, and that part stays here. The exception is the
retroreflecting-seam fix — "must distinguish a coplanar neighbour that continues the surface
from a perpendicular one that merely touches it" is an open task, and it has a ledger line.

**Retroreflecting wall seams: real, measure-zero, and do NOT apply the obvious fix.**
Solid walls now load as merged maximal rectangles (`mergeSolidRuns`, see "Walls load as
geometry, not as cells" above), not one AABB per grid cell — but a merged run still
abuts its neighbours at internal seams, so the buried-face hazard below is unchanged in
kind, only in which faces carry it. A ray arriving at *exactly* a seam coordinate can
enter through one of those buried faces; its normal then points along the run and the
shell reflects back the way it came instead of mirroring off the visible face. Measured
**against the pre-upscale `cellSize` 2 geometry, one AABB per grid cell** (retired since
this branch; not re-measured against merged geometry): **1 of 121 sampled crossings**
(45°, offsets −0.60..+0.60 in 0.01 steps against cellSize 2) — the one at exactly 0.00 —
and **0 of 155 ricochets** in 15 seeded games × 4000 ticks landed on an exact cell corner.
So it was not the hazard on every flat face the PR #1 backlog describes.

The obvious fix — reject a hit whose face is buried, by stepping a hair out along the normal
and testing containment in another wall — **was tried and reverted**: it fails 4 tests in
`collision.test.ts` and `escape.test.ts`. At the arena's concave inside corners the outward
step from a *legitimate* face lands inside the abutting perpendicular wall, so real surfaces
are misclassified as buried and shells pass straight through — reopening the escape bug that
holds a `SHELL_CAP` slot for the rest of a life. Any real fix must distinguish a coplanar
neighbour that continues the surface from a perpendicular one that merely touches it.
