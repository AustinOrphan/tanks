# Screen-state capture

Boot the **built** page into a named application state and photograph it, deterministically
(issue #561).

```sh
npm run build
npm run screens -- --state screen.records.stats --out out/records.png --report out/records.json
```

Or through the capture framework, which is where it belongs for anything durable:

```sh
npm run capture -- --recipe screen.records.stats
```

Playwright is not a dependency of this repository — see [`tools/visual/README.md`](../visual/README.md)
for why, and for the `PLAYWRIGHT_MODULE` resolution order this shares.

## The gap it closes

Before this, no capture path in the repository could reach an application state:

- `tools/visual/` is pinned to the title screen with regression-specific pixel thresholds.
- `tools/gallery/` poses simulation and render subjects — elements, arenas, moments. It has
  no notion of a route, an overlay, or an error screen.

So every player-facing state that is not gameplay and not the title screen was
unphotographable, and each PR that changed one either shipped without visual evidence or
grew a throwaway Playwright script. **Four such scripts were written and discarded in a
single day's work.** This is the fifth, kept — and kept as the `screen` producer that
`tools/capture` has had a declared-but-unimplemented slot for since it was written, rather
than as a fifth standalone tool beside `visual/`, `uikit/` and `gallery/`.

## What a state owns

[`states.mjs`](states.mjs) is pure declarative data — no imports, so
`tools/capture/schema.mjs` can validate a recipe against its ID list without pulling
Playwright into a unit test. Each state carries:

| Field | What it is for |
| --- | --- |
| `storage` | The save a returning player would have, seeded before the page loads. |
| `webgl` | How the renderer probe answers: `ok`, `unsupported` (returns null), `probe-blocked` (throws). |
| `javascript` | `off` reaches the `<noscript>` card. |
| `steps` | Declarative `click` / `press` / `waitVisible` / `waitHidden` / `breakWebgl`. |
| `measure` | The elements whose box, text and key computed properties are recorded. |

A **screen recipe carries an empty `variant`.** Which screen it is lives in
`producer.scenarioId`; the state definition owns the seeding, the capability override and
the reach steps, because those are properties of the screen rather than of one capture of
it. That is why implementing this producer needed exactly one schema change — validating
`scenarioId` against the catalogue, the same rule `moment` already had.

## Sweeping every state across layouts, and comparing two builds

A refactor that should change nothing a player sees needs proof that it did not (issue #766).
`npm run screens:sweep` photographs every state at every layout in a fixed matrix, from one built
`dist`, and `npm run screens:compare` compares two such sweeps byte for byte.

```sh
# Build each commit in its own worktree, then sweep both builds from this checkout:
npm run screens:sweep -- --dist ../base-worktree/dist --out tmp/sweep/base --hide-game
npm run screens:sweep -- --dist ../head-worktree/dist --out tmp/sweep/head --hide-game
npm run screens:compare -- --base tmp/sweep/base --head tmp/sweep/head

# Settle only the pairs that came out different, with a control sweep of each build:
S=screen.devtools.actions,screen.ending.campaign-over.played
npm run screens:sweep -- --dist ../base-worktree/dist --out tmp/sweep/base-control --states $S --hide-game
npm run screens:sweep -- --dist ../head-worktree/dist --out tmp/sweep/head-control --states $S --hide-game
npm run screens:compare -- --base tmp/sweep/base --head tmp/sweep/head \
  --base-control tmp/sweep/base-control --head-control tmp/sweep/head-control --states $S
```

A full sweep of both builds and a control of only the differing states costs much less than
three full sweeps. `--states` and `--layouts` restrict the comparison to the pairs being settled,
so the control needs to cover only those.

**What a sweep writes.** Each capture goes to `<out>/<state>/<layout>.png`, with the producer report
beside it as `<layout>.json`. `manifest.json` records:
- the `dist`, and the commit it came from;
- the options;
- every capture's SHA-256, a hash of its measurements, and its page-error count, or the error if it
  failed.

One browser and one server serve the whole run, and each capture gets a fresh browser context.
`--states` and `--layouts` take comma-separated ids and refuse an unknown one. `--out` must not exist
yet.

**How compare classifies each state and layout.**

| Outcome | Meaning |
| --- | --- |
| `identical` | Base and head are byte-identical, and every control given agrees with its side. |
| `different` | Base and head differ, and the pair was stable. |
| `missing` | Absent, or failed, on either side. It is never read as identical. |
| `unstable` | A control sweep of the same build differs from its side, so the pair cannot say anything about the change. |

- **Exit code.** The command exits 0 only when every pair is identical.
- **Measurements, per pair.** It also says whether the measured boxes, text and watched styles
  agree. That is secondary evidence, and it never turns an unstable or different pair identical.
- **Read back.** It recomputes every frame's hash from the file, and fails if a file no longer
  matches its manifest.

**Why `--hide-game`.** The states reached through a live match, such as Pause and Controllers, show
that match behind a translucent pane. How long the round ran before the pause decides where the
enemy turrets point. Measured on one build, two sweeps of `screen.controllers` differed in 2021
pixels at 1280x800, all inside the box around the two enemy tanks behind the title. Their
measurements were identical. With the game canvas hidden, two sweeps of `screen.controllers`,
`screen.controllers.pads` and `screen.pause.campaign` at 390x844 and 1280x800 were byte-identical: 6
of 6 pairs. A sweep with the canvas hidden cannot be compared with one without it, and compare
refuses to.

**The layouts** live in [`sweep-plan.mjs`](sweep-plan.mjs), and each one names the risk it protects.
A test reads the viewport queries `hud.css` declares, and fails when two layouts meet the same
queries without one naming the other in `sameQueriesAs` and saying what still tells them apart.

**What it is not.** It is not the required gate, it commits no baselines, and it is not a
required check. A full sweep is several hundred captures on software GL.

The gate is `npm run screens:check` (issue #846), which runs one bounded subset at one viewport
against committed baselines inside the required `visual` job (issue #847). This sweep is the
broad on-demand matrix beside it, and the two answer different questions: the gate asks whether
a screen changed, the sweep asks what a screen looks like everywhere.

## Failure screens are produced by failing, never by injecting markup

`screen.startup.unsupported-render` and `screen.startup.probe-blocked` patch
`HTMLCanvasElement.prototype.getContext` so the **real** probe in `render-capability.ts`
runs and takes its real branch: returning null is `no-webgl2`, throwing is `probe-failed`,
and those select two different branded screens with different advice. A capture that
injected the screen's markup would be evidence of nothing.

`screen.startup.match-failed` reaches the **recoverable** overlay, "That match could not
start.", with Retry beside Back to menu. It applies a WebGL override **after** boot, so the
probe has already passed and the menu is up. The override is `match-build-fails`: the context
is left alone so the renderer is built, and the context's first `createFramebuffer` then
throws an untyped error, which `classifyStartupFailure` treats as transient at the match
boundary (issue #700).

It used to break the context itself with `probe-blocked`. Since #669 that throw arrives as a
typed `RenderContextUnavailableError`, which is correctly **fatal**, so the step produced the
full-page "This browser cannot run Tanks!" state and the overlay was never reached. That
fatal page is the same screen `screen.startup.unsupported-render` already captures.

## Why every shot is also measured

A screenshot named `records.stats` proves the page did not crash and nothing else. Two
states that render identically produce two files a reviewer has to eyeball. So each capture
records the bounding box, trimmed text and watched computed properties of the elements the
state names, into `producer.json` beside the frame.

That half is deterministic in a way pixels are not, and it is the half that has caught
things: the campaign-complete screen's two tally lines sat 24px apart where 8px was
intended, and the *number* is what said so — the picture merely looked slightly loose.

Two assertions are reported to the capture framework, so a bad capture fails rather than
saving a picture of a broken screen:

- **no uncaught page errors** — the branded failure states *report* a failure, they do not
  suffer one;
- **every measured selector matched something** — not "was visible": several states exist
  precisely to show a control is absent (a fresh save hides Continue; the no-script style
  hides the holding card). A selector matching nothing means the state is measuring nothing.

## On demand, not a required check

**These are captured on demand and are deliberately not part of the required `visual`
check.** The argument, rather than the assumption:

- A **pixel** gate over text-heavy screens has a real flake cost — font rasterisation
  differs across CI images — and `visual` is already required. Feeding it flaky screens
  costs that gate its credibility, which is worth more than these screenshots.
- The two defects this style of capture has actually caught would **not** have been caught
  by a pixel baseline. The `<noscript>` overlap (PR #560) had no baseline to differ from,
  and the tally spacing was found by reading a measured box, not by diffing an image.
- The **measurement** half is deterministic and assertable, so it is the half worth gating.

## The required gate, decided

**Owner decision, 2026-09-19 (issue #840).** The paragraph above used to end by deferring the
choice to #326. It is made now, and the five children building the gate build against this
rather than re-litigating it.

### What it asserts

**The measurements block, and never pixels.** Each state's `metadata.screen.measurements`
entry carries `present`, `visible`, the element `box`, its `text`, and seven watched computed
properties — `display`, `opacity`, `color`, `background-color`, `font-size`, `margin-top`,
`margin-bottom`. That already covers most of what a pixel diff would catch, on the selectors a
state names, and it is deterministic across CI images in a way font rasterisation is not.

PNGs are still captured, and uploaded on failure as human evidence. They are never compared.

The one state that would most reward a pixel baseline is the 3D board, and it is exactly the
one where pixels are least trustworthy: measured at **1660 KB** against 40–80 KB for a menu
screen, and rendered through SwiftShader.

### What is in it

**Every state except the two played endings.** Each state is a distinct surface, so the
"name the distinct risk it protects" rule maps one-to-one.

A RULE, not a list, and deliberately: this paragraph first said "thirty-nine of forty-one" and
the catalogue outgrew that within a day. `subsetStates` in `baseline.mjs` derives the set, so a
state added tomorrow is covered without anyone remembering to edit a number.

`screen.ending.mission-clear.played` and `screen.ending.campaign-over.played` are out.
Measured: **22.9 s each**, against 5.9 s for the pushed-outcome twin that asserts the same
panel, and 1.4 s for an ordinary state. That is the argument `hit-sweep.mjs` already uses to
exclude them from the menu sweep.

### What it may cost

| | Budget | Measured |
|---|---|---|
| wall clock | 180 s | 127 s for 36 states, a fresh browser each |
| committed baseline | 100 KB | 53 KB of JSON |
| failure artifacts | 25 MB, 14-day retention | 13 MB if every state failed at once |

The headroom is for the runner being slower than a developer machine, and for `sweep.mjs`'s
shared browser not being adopted yet.

### Where it runs

**A step inside the existing required `visual` job**, not a fourth required check. That job
already pays for `npm ci`, Playwright, a cached Chromium and a build — about two minutes a
separate job would repeat — and it already bundles four distinct tools, naming the failing one
in its log.

**Promote it to its own required check when any of these becomes true**, and not before:

- the subset exceeds its 180 s budget;
- it fails independently of the other four tools often enough to want a separate retry;
- someone needs to re-run it alone.

Promotion means editing the `Protect main` ruleset, which records exactly
`verify (floor)`, `verify (current)` and `visual` today, and CLAUDE.md alongside it.

### How a baseline changes

**CI compares; it never writes.** A baseline moves only by running the accept command
locally, committing the result, and reading the diff.

```sh
npm run screens:accept -- --state screen.settings
```

## The six commands

| To | Run |
| --- | --- |
| list the screen recipes | `node -e "import('./tools/screens/states.mjs').then(m=>console.log(m.SCREEN_STATE_IDS.join('\n')))"` |
| run one recipe locally | `npm run screens -- --state screen.settings --dist dist` |
| run the bounded required suite | `npm run screens:check -- --dist dist` |
| inspect expected/actual/diff | read `screens-check-out/<state>/` — `expected.json`, `actual.json`, `diff.txt`, `source.json`, `capture.png` |
| accept a reviewed baseline change | `npm run screens:accept -- --state <id>` (or `--all`) |
| request the full on-demand matrix | `npm run screens:sweep` — every state at every layout, which is not this gate |

`screens:check` compares and never writes. `screens:accept` is the only thing that rewrites a
baseline, which is why it is a separate command rather than a flag: a `--update` on the
checking command is one habit away from a run that approves its own change, and CI runs the
checking command.

`capture.png` sits beside a failure as evidence for a person reading it. There is deliberately
no `expected.png` to compare it against — pixels are not the channel.

**A page error fails a state on its own**, whatever its measurements did. The sweep's
`measurementsSha256` hashes the measurements alone, so a screen that started throwing would
keep its hash and pass; an uncaught error is a defect regardless of what the layout did.

Because the baseline is JSON, the pull-request diff *is* the review:

```diff
   "selector": ".hud-practice",
   "box": {
-    "w": 114,
+    "w": 132,
   },
   "style": {
-    "font-size": "18px",
+    "font-size": "20px",
```

That is what pins #326's "a successful test run is not automatic approval of a changed
design": the run cannot approve anything, because the run cannot write.

### One member does not capture yet

`screen.startup.match-failed` times out waiting for `.hud-alert` after `breakWebgl:
'match-build-fails'`. Verified pre-existing at `b0035077`, before the 2026-09-19 merges, and
invisible because nothing in required CI exercises it. It stays a listed member; the required
check waits for it to pass.

## Known gap

`STARTUP_FAILURES` has a fourth entry, `startup-failed` — the generic "something went wrong
before the game was ready" state — and **it has no recipe here.** Every lever that reaches
it from outside the page (a blocked storage, a throwing probe) is already caught and
classified as something more specific, which is the module working as designed. Reaching it
would need a deliberate failure seam in `boot.ts`, which is a production change and its own
decision. Stated here rather than left as a silently missing row.

### The ending screens: which captures prove the panel, and which prove the path

| State | Reached by | Proves |
|---|---|---|
| `screen.ending.mission-clear` | `?dev=1&outcome=mission-clear` | the panel |
| `screen.ending.campaign-over` | `?dev=1&outcome=campaign-over` | the panel |
| `screen.ending.campaign-complete` | `?dev=1&outcome=campaign-complete` | the panel only; not played, see below |
| `screen.ending.practice-cleared` | `?dev=1&outcome=practice-cleared` | the panel |
| `screen.ending.practice-failed` | `?dev=1&outcome=practice-failed` | the panel |
| `screen.ending.mission-clear.played` | playing level 3 with autoplay until it is won | the path, and the panel it arrives at |
| `screen.ending.campaign-over.played` | playing level 3 with autoplay until the run is out of lives | the path, and the panel it arrives at |

**The played pair (issue #617).** Each starts from Continue on the same mid-campaign save and
runs `{ playUntil }` until `.hud-action` shows, then checks `.hud-title` says which ending it
is. `?seed=7` pins the world and, since #617, the autoplay controller's own stream too, so the
same match plays every run; mission-clear adds `invincible=1` so its win cannot become a loss.
A game that stopped being winnable, or stopped ending a run out of lives, fails these and
leaves the pushed-outcome states green.

- **Their budget is simulated ticks, not wall-clock.** `playUntil` reads the tick count from
  `__tanks.replay()` (hence `replay=1` in the query), sums it across world rebuilds, and fails
  with "the game did not end" naming the selector when the budget is exceeded. A missing replay
  surface, a truncated trace, a simulation that stops advancing for 15 s, and an ending with the
  wrong title each fail with their own message.
- **Their cost, measured on issue #617's branch** (software GL, 1280x800 at DPR 2, 2 runs
  each): mission-clear took 1035 simulated ticks both times, in 58.7 s and 59.5 s of
  wall-clock; campaign-over took 2190 ticks both times, in 125.4 s and 126.0 s. The identical
  tick counts are the seeded autoplay repeating its match. Each budget is twice its measured
  count (2070 and 4380), so a balance change that lengthens the match has room before it fails,
  and one that stops the game ending fails by name. The budget is ticks; the recipe's 300 s
  `timeoutMs` only has to cover it at this machine's rate, about 17.5 ticks per second of
  wall-clock, which puts 4380 ticks near 250 s.
- **Each capture reports its own cost.** The runner writes every `playUntil` step's `ticks`
  and `wallMs` into `producer.json` under `played`, so a later run shows whether the price has
  moved.
- **Not in the required `visual` check's hit sweep.** A played ending is tens of seconds of
  software-GL play, and its panel is the one the pushed-outcome state of the same ending is
  already swept through (`tools/visual/hit-sweep.mjs`).
- **Campaign complete is not played.** It would chain five levels of this, the most expensive
  capture here for the least conditional of the endings; the owner ruling on #617 keeps it on
  the pushed-outcome path unless later evidence shows the played path earns that cost.

#### The pushed-outcome states

The five pushed `screen.ending.*` states are reached with `?dev=1&outcome=`, a development flag
that ends the running session on its first simulated frame with a named ending (issue #591).

**What that buys.** The flag enters the real outcome phase through the same state-machine
transition a played ending uses, so the real `OUTCOME_PANEL` entry renders through the real
gates, over a live session that has pushed its level choice and its status. That is what makes
`Choose Level` and `Practice This Level` worth measuring here: each carries a multi-term
visibility gate, and both are in the measured selector set of all five states, so a screen that
stops offering one — or starts offering one it should not — fails rather than photographing
quietly.

**What it does not buy.** It does not play a match. These captures would not catch a game that
stopped being winnable, and nothing here should be read as claiming otherwise. They are
evidence about the SCREEN; the played-through capture is issue #617, filed rather than promised.

**Its cost.** One development flag in `FLAG_REGISTRY`, registered and documented through the
generator like every other, plus `finishWith` on the state machine — the same transition
`onEvents` makes, minus the classifier that decides which ending the events mean. Two options
were weighed and rejected on #591: a seeded save cannot express "one enemy left, one shot in
flight" (persisted state is progress and lives, not a world snapshot), and playing through
needs a new step kind whose capture time then depends on the AI.

**The session is part of the recipe.** The flag ends whatever session is running and the panel
describes that session, so each state starts the session its ending belongs to — a campaign
ending photographed over a practice session would be a screen no player can reach.

## Recording a flow at normal speed

`node tools/screens/record.mjs` (issue #815) is the moving counterpart of `run.mjs`: it
boots the built page the same way, drives a flow from `flow.mjs` to a playing round, and
records the compositor screencast for a wall-clock window while sampling the replay
surface's tick count and the page's animation frames. It measures and never decides; the
capture pipeline's `flow` adapter judges its report. Use it through `npm run capture --
--recipe flow.<...>`; the arguments it takes are built from the recipe, never typed.
