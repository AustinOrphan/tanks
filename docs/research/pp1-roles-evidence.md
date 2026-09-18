# PP1 role-budget experiment: evidence package

Prepared for issue #358's human review, as issue #720's evidence package. It gathers what
already exists about the `pp1Roles` experiment arm, what that evidence means, and how to
reproduce it.

**This package decides nothing.** Whether the role matrix ships, and any adopt, revise or
reject ruling, stay with #358. Nothing here adds Grey retreat behaviour or changes
compositions, arenas, spawns, aim or reaction timing. Shipped balance is unchanged.

**Every measurement below comes from a scripted player.** None of it is human play; see
[Scripted evidence and human evidence](#scripted-evidence-and-human-evidence).

## Contents

- [Experiment inputs against shipped defaults](#experiment-inputs-against-shipped-defaults)
- [Deterministic measurements](#deterministic-measurements)
- [Normal-speed captures](#normal-speed-captures)
- [Playing the matched pair](#playing-the-matched-pair)
- [Scripted evidence and human evidence](#scripted-evidence-and-human-evidence)
- [Limitations](#limitations)

## Experiment inputs against shipped defaults

**Where the values come from:**
- **The arm:** `PP1_ROLE_SHELL_CAPS`, `PP1_ROLE_BANDS` and `PP1_ROLE_MINE_CAPS` in
  `src/sim/config/pp1-roles.ts`.
- **Shipped defaults:** `maxActiveProjectiles`, `mineCapacity`, `abilities` and `aiProfile`
  in `src/sim/config/data/tank-defs.json`.
- **Roles:** the approved role descriptions in #358's "Current PP1 experiment arm" table.

**The arm is on only with `?dev=1&pp1Roles=1`.** Caps are stamped in one pass over the built
roster (`src/sim/arena.ts`, deliberately not at each spawn site: "stamping at each is how one
gets missed"), and only in campaign worlds. Without the flag, every kind keeps its authored
value.

| Kind | Approved role to validate | Shell cap: shipped → arm (band) | Mine capacity: shipped → arm | Weapon, shipped | Mine-laying ability, shipped | AI profile, shipped |
| --- | --- | --- | --- | --- | --- | --- |
| Player | Stable generalist kit | 5 → **4** (3–4) | 2 → 2 | standard shell, 1 ricochet, medium fire rate | yes | none: human or script |
| Brown | Stationary direct-fire sentry | 5 → **2** (1–2) | 2 → **0** | standard shell, 1 ricochet, slow fire rate | no | `STATIC_BASIC` (stationary) |
| Grey | Defensive kiter | 5 → **3** (2–3) | 2 → 2, unchanged by decision | standard shell, 1 ricochet, medium fire rate | yes | `DEFENSIVE_BASIC` (defensive, mine chance 0.3) |
| Teal | Mobile ricochet skirmisher | 5 → **3** (2–3) | 2 → **0** | ricochet rocket, 2 ricochets, fast fire rate | yes | `MOBILE_MINE_LAYER` (tactical, mine chance 0.3) |
| Olive | Fast zero-bounce rocket threat | 1 → 1, the band's control | 0 → 0 | rocket, 0 ricochets, slow fire rate | no | `DEFENSIVE_ROCKET` (defensive) |
| Green | Stationary ricochet sniper | 5 → **2** (1–2) | 2 → **0** | ricochet rocket, 2 ricochets, slow fire rate | no | `RICOCHET_SNIPER` (stationary) |

**Why each arm value is the top of its band:** the band is the approved range, and the top is
the smallest role-shaped step off the shipped 5. The reasoning is in `pp1-roles.ts`'s own
comment. The lower bound of each band is the obvious second arm; it has not been run.

**Yellow is outside the arm:** no shipped campaign level contains it, so it keeps its authored
values even with the flag on.

**Not in this table, and still a human judgment for #358:** #358's required table also asks
for each kind's tactical question, weakness and key AI behaviour. The approved record gives a
role for each kind but none of those, and this package does not invent them. The AI-profile
column is the shipped profile name, not the "key AI behaviour" judgment.

### Two of the three mine removals cannot change AI play

**Brown's and Green's `mineCapacity: 0` removes a capability their AI never uses:**
- The AI dispatcher lays a mine only for a kind with the `MINE_LAYER` ability
  (`src/sim/ai/index.ts`, the `hasAbility(tank.kind, TankAbility.MINE_LAYER)` guard).
- Brown's abilities are empty, and Green's are `BANK_SHOT_AIM` only.
- Both kinds' profiles -- Brown's `STATIC_BASIC` and Green's `RICOCHET_SNIPER` -- carry the
  `STATIONARY` behaviour, which dispatches to `brownDecision`, and both of that function's
  returns set `mine: false`.

So the arm's Brown and Green mine change has no effect on AI play in any encounter. The
measurements agree: both kinds read `0.0000` mean live mines in both arms. **Of the arm's
three mine removals, only Teal's is exercised by play.**

## Deterministic measurements

These are #681's matched contrast and #726's attribution counters, in
`src/sim/ordnance-budget.measure.test.ts`. Re-running them for this package reproduced both
PRs' published tables exactly, number for number.

**The run:**
- **Command:** `VITE_RUN_MEASURE=1 npx vitest run src/sim/ordnance-budget.measure.test.ts`
- **Build:** commit `1673c3772f07efb04095cae21cdb2515cc0c01bf`.
- **Result:** exit 0, 2 of 2 cases passed.
- **Where it runs:** locally only. Without `VITE_RUN_MEASURE` the harness is skipped, CI never
  runs it, and no workflow lists it.

**The workload:**
- **Encounters:** 12, every pair of seeds `1, 2, 3` with arenas `arena-01` to `arena-04`,
  which are campaign levels 1 to 4. Both arms walk them in the same order, and the harness
  throws if a pair does not match.
- **Compositions, besides the one player** (counted from the arena grids):

  | Arena | Brown | Grey | Teal | Olive | Green |
  | --- | ---: | ---: | ---: | ---: | ---: |
  | arena-01 | 1 | 1 | 1 | 0 | 0 |
  | arena-02 | 2 | 1 | 1 | 0 | 0 |
  | arena-03 | 2 | 1 | 0 | 2 | 0 |
  | arena-04 | 1 | 1 | 2 | 1 | 1 |

  Green spawns only in arena-04, so its rows rest on 3 encounters. The harness's own comment
  says arena-03 "adds olive"; the grid shows it also has no Teal.
- **Length:** each encounter runs until the world's status leaves `playing` (a win or a loss)
  or for 60 s of simulated time, whichever comes first. The 180-tick countdown is skipped for
  the per-tick ordnance samples; shots, refusals and deaths are counted unconditionally, which
  is the same thing in effect, because movement and fire are both blocked during it.
- **World rules:** `createWorldFor(arena, seed, { pp1Roles })` with every other rule at its
  default. That matches the page's campaign world with no other developer flags set.
- **The driver:** the scripted player, `decidePlayerInput` in `src/sim/ai/player-profile.ts`.
  Its random stream is `mulberry32(seed * 7 + 1)`, identical in both arms. It never adapts to
  the arm.

**The independent variable is proven connected before anything prints.** The harness throws
unless the arm moved these values, and it asserts Grey's mine cap did not move:

```
knob wired: brown.mineCap 2->0, brown.shellCap 5->2, green.mineCap 2->0, green.shellCap 5->2, grey.shellCap 5->3, player.shellCap 5->4, teal.mineCap 2->0, teal.shellCap 5->3
determinism: two runs of the pp1Roles arm are bit-identical per kind
```

### Ordnance density and capacity stall (#681)

```
kind     shellCap    mineCap   meanLiveShells      meanLiveMines       capacityStall        shots        tickSamples
brown     5->2      2->0    0.0500->0.0494   0.0000->0.0000   0.00%->0.91%     41->28    38089->34945
green     5->2      2->0    1.0740->0.4100   0.0000->0.0000   2.85%->11.14%     29->16     6042->4112
grey      5->3      2->2    0.1478->0.2132   0.2298->0.2645   0.09%->1.81%     46->52    20146->18521
olive     1->1      0->0    0.0408->0.0438   0.0000->0.0000   4.08%->4.38%     32->22    24097->18088
player    5->4      2->2    0.6835->0.5813   0.1436->0.1608   1.16%->3.52%    219->180   29140->28638
teal      5->3      2->0    0.8546->0.6040   0.1925->0.0000   6.36%->14.90%    116->80    19334->21909

difficulty (coarse): player deaths 26 -> 22, encounters resolved 7/12 -> 9/12
```

**What the columns mean:**
- **`tickSamples`** is the kind's live ticks, summed over its tanks. It is the denominator.
  The arms do not run for the same number of ticks, so compare the per-tick columns across
  the arrow, not the raw `shots`.
- **`meanLiveShells` and `meanLiveMines`** are the live shells or mines the kind owns, averaged
  over those ticks.
- **`capacityStall`** is the share of live ticks spent at the shell cap. It is occupancy, not
  refusal: a tank can sit at its cap without trying to fire. The harness header records that
  Brown at cap 2 once stalled 0.44% while losing no shots at all.

### Refusals and causes of death (#726)

The harness checks the attribution before printing, per arm:
- summed kills equal summed deaths;
- each kind's deaths equal its shell deaths plus its blast deaths;
- own-mine deaths ≤ self-kills ≤ deaths.

```
kind     blocked        blocked/1k      deaths    byShell    byBlast    selfKills   ownMine    alliedKills
brown      0->5        0.00->0.14     19->15     19->15      0->0       0->0        0->0       1->1
green      1->6        0.17->1.46      0->0       0->0       0->0       0->0        0->0       3->2
grey       0->7        0.00->0.38     12->11     10->9       2->2       2->2        2->2       1->0
olive      5->6        0.21->0.33      4->2       4->2       0->0       0->0        0->0       0->0
player     6->22       0.21->0.77     26->22     25->21      1->1       9->7        1->1       0->0
teal      56->144      2.90->6.57     13->6      11->6       2->0       2->0        2->0       1->1
```

**What the columns mean:**
- **`blocked`** counts `fire-blocked` events, which are fire attempts refused at the shell cap.
  **`blocked/1k`** is that count per 1000 live ticks of the kind, and it is the column to
  compare across the arrow.
- **`byShell` and `byBlast`** read the `source` of `tank-destroyed.by`.
- **`selfKills`** are deaths credited to the tank itself. **`ownMine`** is the subset whose
  source was a blast, meaning the tank drove into its own mine's blast. Shooting one's own mine
  is credited as a **shell** self-kill, because the shell's credit passes to the detonation.
- **`alliedKills`** counts kills of another tank on the killer's own side, where the sides are
  the player against the enemies.

### Encounter outcomes, pair by pair (#726)

```
encounter duration, baseline -> pp1Roles (60s cap; ended = win, lose or timeout)
  arena-01 seed=1  23.2s win -> 37.3s win
  arena-02 seed=1  59.6s lose -> 60.0s timeout
  arena-03 seed=1  60.0s timeout -> 34.8s lose
  arena-04 seed=1  27.0s lose -> 27.1s lose
  arena-01 seed=2  13.7s win -> 49.1s win
  arena-02 seed=2  60.0s timeout -> 60.0s timeout
  arena-03 seed=2  54.7s lose -> 54.7s lose
  arena-04 seed=2  60.0s timeout -> 28.8s lose
  arena-01 seed=3  20.7s lose -> 25.1s lose
  arena-02 seed=3  60.0s timeout -> 60.0s timeout
  arena-03 seed=3  60.0s timeout -> 54.9s win
  arena-04 seed=3  22.7s lose -> 21.6s lose
  mean over all 12: 43.5s -> 42.8s
```

**Read the pairs, not the mean:**
- **Outcomes:** 2 wins, 5 losses and 5 timeouts in the baseline; 3 wins, 6 losses and 3
  timeouts under the arm.
- **Changed outcome in 4 of 12 pairs:** arena-02 seed 1 (loss → timeout), arena-03 seed 1
  (timeout → loss), arena-04 seed 2 (timeout → loss), arena-03 seed 3 (timeout → win).
- **The mean hides the moves:** a timeout counts as 60 s, and the arm times out less, so the
  near-equal means sit on top of large pair moves. The largest is arena-01 seed 2, 13.7 s →
  49.1 s, both wins.

### What the measurements can support

These are stated at the strength 12 scripted encounters allow.

- **Stall and refusals rise wherever a cap fell,** most on the two kinds cut hardest. Teal:
  stall 6.36% → 14.90%, refusals 2.90 → 6.57 per 1000 live ticks. Green: stall 2.85% →
  11.14%, refusals 0.17 → 1.46, on its 3 encounters.
- **Rows move on kinds whose cap did not.** Olive's cap is 1 in both arms, yet its shots went
  32 → 22 over 6009 fewer tick samples. The harness header names this cross-talk: a
  shorter-ranged opponent changes how long encounters run. The arm touches all six kinds'
  shell caps, so no row is a clean control; determinism stands in for one.
- **The coarse difficulty signal points the way #358's failure signals warn about:** player
  deaths 26 → 22 and 9 of 12 resolved against 7 of 12. With one scripted player over 12
  encounters, that is a direction to watch in human play, not a difficulty finding.
- **Teal's own-mine deaths go 2 → 0,** which follows from its mine capacity going to 0. Grey
  keeps 2, and the player has 1 in each arm.

## Normal-speed captures

**Four captures, two matched pairs**, made by `npm run capture` through the shared capture
pipeline (issue #815's `flow` producer) from a build stamped with the commit they were taken
at. Each publishes an H.264 MP4 and a `capture.json` whose assertions are the evidence that
the clip is what it says it is.

| Recipe | Level (arena) | Arm | Clip | Round | Ended |
| --- | --- | --- | --- | --- | --- |
| `flow.campaign-round.pp1roles-off` | 1 (`arena-01`) | shipped | 150 frames, 5.0 s | 302 ticks | Level Cleared |
| `flow.campaign-round.pp1roles-on` | 1 (`arena-01`) | `pp1Roles=1` | 165 frames, 5.5 s | 333 ticks | Level Cleared |
| `flow.campaign-roster.pp1roles-off` | 4 (`arena-04`) | shipped | 1524 frames, 50.8 s | 3050 ticks | Level Failed |
| `flow.campaign-roster.pp1roles-on` | 4 (`arena-04`) | `pp1Roles=1` | 558 frames, 18.6 s | 1117 ticks | Level Failed |

Every clip is 1280x800 at 30 fps, seed 1, the scripted player, recorded from the end of the
round-start countdown to the last frame before the outcome panel. Within a pair the only
difference is the flag, which each manifest records as `producer.requestedInputs`.

**Why two levels.** Level 1 holds Brown, Grey and Teal -- three of the five kinds the arm
touches, including Teal, whose mine removal is the only one that changes AI play. Level 4 is
the first board holding every kind it touches, and it is where the difference is largest.

**What the pairs show, as durations.** These are one scripted player on one seed, not a
difficulty measurement; the deterministic numbers above are that.

- **Level 1:** both arms clear it. The arm takes 31 more ticks, about half a second.
- **Level 4:** both arms fail. The baseline survives 3050 ticks, the arm 1117 -- under a third
  as long. The 12-encounter harness recorded the opposite direction overall (player deaths
  26 to 22 in the arm's favour), so these two clips are a different sample, not a contradiction
  of it: one seed, one board, one policy.

**What each manifest asserts.** Eleven checks pass on every capture. The ones carrying the
timing claim:

- `flow-simulation-rate`: the replay surface advanced 59.98 to 60.18 ticks per wall-clock
  second across the four, against a 60 Hz simulation.
- `flow-no-clamped-frames`: no animation frame crossed the game's 250 ms catch-up clamp, so no
  simulated time was lost against the clock.
- `flow-still-playing`: the round was playing at every sample and at the cut.
- `flow-world-identity`: the round's own seed and arena match the recipe's level.
- `flow-build-identity`: the page named the commit being captured, read from its diagnostics
  report rather than assumed.
- `flow-delivered-rate`: the compositor delivered 99 to 100 frames per second against the
  recipe's floor of 45, and no output frame is a repeat of the one before it.

**To make them again**, on any machine with a GPU:

```sh
VITE_BUILD_SHA=$(git rev-parse HEAD) npm run build
npm run capture -- --recipe flow.campaign-round.pp1roles-off --source-ref $(git rev-parse HEAD)
```

...and the same for the other three recipe ids. Each manifest carries its own `reproduce`
block with these commands filled in. A build that cannot name its commit fails
`flow-build-identity` rather than being filed under the wrong one, and a machine without a GPU
fails `flow-delivered-rate` with the rate it measured rather than publishing choppy footage.

**What these are not.** A scripted player, not a person: see
[Scripted evidence and human evidence](#scripted-evidence-and-human-evidence). Two real-time
captures of the same recipe differ by timing jitter, so they are reviewed as clips and
manifests, never diffed pixel by pixel -- `npm run capture:compare` refuses a flow recipe for
that reason.

## Playing the matched pair

**No build gate was found on developer flags,** so these URLs should work in a production
build as well as under `npm run dev`:
- `createBrowserDeps` in `src/game/loop.ts` passes the page's own `location.search` to
  `parseDevFlags`.
- Neither `parseDevFlags` nor `vite.config.ts` checks the build environment.
- Not tried against the published site.

**Open the page with the arm and the seed, then pick the level on screen.**

| Arm | URL |
| --- | --- |
| Baseline | `?dev=1&seed=1` |
| Experiment | `?dev=1&seed=1&pp1Roles=1` |

Then press **Levels** on the Main Menu and choose the level. Use seeds `2` and `3` for the
harness's other encounters.

**`?level=N` is NOT the way in, and this is worth knowing before a review session.** The flag
moves the level system's `start`, which is what **Continue** resumes -- but a **New Game**
deliberately lands on level one whatever the flag says (`campaign-new` in `loop.ts`, issue
#428). Measured on the built page: `?dev=1&level=4&seed=1` followed by New Game plays
`arena-01`, silently, and only the arena id in a developer trace says so. The same URL
followed by Continue plays `arena-04`, but Continue appears only when a run is already
active. Level Select has neither problem: it names the level on screen and reaches any
unlocked one. The capture recipes take that path for the same reason.

**Either way the session is a practice attempt,** not a campaign run: a developer level jump
and a Level Select pick both leave the run alone (`isDevJump` in `levels.ts`). The arm still
applies -- it reaches every campaign world, and only the sandbox is excluded.

**Options:**
- **To watch the scripted player** instead of playing, add `&autoplay=1`.
- **To record the input stream,** add `&replay=1`. Developer Tools can then save it.

**What a pinned seed does in the page** (`nextSeed` in `src/game/loop.ts`): every world the
session builds uses it, including a retry after a lost life and the next level. Reroll Seed
in Developer Tools cancels the pin for the rest of the session.

**The page does not reproduce the harness's encounters, even on the same seed and arena:**
- **Different random stream:** the page seeds its scripted player with
  `mulberry32(seed + 1)`, where the harness uses `mulberry32(seed * 7 + 1)`.
- **Different run structure:** the page runs a campaign, where the run's lives carry and a lost
  life rebuilds the world. The harness plays one world per encounter for at most 60 s.

A page session on seed 1 and arena-01 is therefore a matched baseline-and-arm pair in its own
right, not a replay of the harness's `arena-01 seed=1` row.

**A saved replay does not record the arm, and nothing flags the gap.** This was read in the
code, not run:
- **No field for it:** the replay format's `ReplayMeta` (`src/game/replay.ts`) carries the
  arena, seed, lives, invincibility and seven world rules, but no `pp1Roles`.
- **The validity check can't see it:** `checkTrace` compares only the trace's format, its
  schema, and a fingerprint of four data files (balance, tank definitions, AI profiles,
  arenas). The arm's values live in `src/sim/config/pp1-roles.ts`, outside that fingerprint.
  So a trace recorded under the arm passes the check.
- **The rebuild runs the baseline:** the only code that rebuilds a world from `ReplayMeta` is
  two test helpers (`worldFor` in `replay.test.ts` and `dev-exports.test.ts`). Neither passes
  `pp1Roles`, so an arm trace rebuilt that way would replay its inputs at shipped caps: a
  different run, reported as valid.

Keep the page's full URL beside any saved replay, and pass `pp1Roles` yourself when
re-simulating one.

**Build identity:** record the commit alongside each session, from the diagnostics report in
Developer Tools. Its `commit` comes from `VITE_BUILD_SHA`, which `.github/workflows/pages.yml`
sets for the published build. A local `npm run build` without it reports the build as unknown.
To reproduce locally:

```sh
git checkout <commit>
VITE_BUILD_SHA=$(git rev-parse HEAD) npm run build
npm run preview    # then open the URLs above on the printed address
```

## Scripted evidence and human evidence

| #358 wants to observe | This package's scripted evidence | Still needs human play |
| --- | --- | --- |
| Shell density, capacity stall, capped fire attempts | Measured per kind, 12 encounters, one scripted player | Whether lower caps create intention or only force waiting |
| Encounter duration | Measured per pair, with outcomes and timeouts | Whether the time feels like dead air |
| Kill and death causes, self-kills, mine self-interference, allied kills | Measured and attribution-checked | Whether deaths read as clearer |
| Whether players can name each enemy's threat and counterplay | Nothing | All of it |
| Ricochet, baiting, retreat, cover and mine decisions | Nothing | All of it |
| Whether removing Brown, Teal and Green mines improves role clarity | Only Teal's removal is exercised; Brown's and Green's cannot change AI play | Teal's effect on clarity, and whether Brown's and Green's entries mean anything |
| Difficulty against the shipped campaign | A coarse direction: player deaths 26 → 22, resolved 7 → 9 of 12; two normal-speed clips per board on levels 1 and 4 | The difficulty judgment itself |

**The scripted player is a fixed policy.** It does not learn the arm, avoid the cap or change
tactics. Its numbers show what the budgets do to one unchanging opponent, which is a
different question from what they do to a person.

## Limitations

- **The sample is small:** 3 seeds × 4 arenas, one scripted player, 60 s per encounter. Green
  appears in 3 encounters, and arena-05, the other arena with Green, is not sampled.
- **There is no control row:** the arm changes all six kinds' shell caps. Determinism (two arm
  runs bit-identical) rules out run-to-run noise, not cross-talk between kinds.
- **Only the top of each band has been measured.** The lower-bound arm has never been run.
- **Harness world versus page campaign:** the harness world is not the page's campaign flow;
  see [Playing the matched pair](#playing-the-matched-pair).
- **The clips are two boards, one seed and one scripted policy.** Levels 2, 3 and 5 have no
  clip, and no clip is human play. See [Normal-speed captures](#normal-speed-captures).
- **A saved replay does not identify its arm,** and the trace validity check would accept one
  rebuilt at shipped caps.
