# Capture recipes

`npm run capture` is the stable entry point for reproducible, reviewable screenshots and
clips. Recipes are inert, versioned JSON; the first producer adapts the existing gallery
moment runner, which in turn renders the real simulation timeline through the production
Three.js entity and effects code. Capture does not define another scene or renderer.

## Commands

```sh
npm run capture -- --list
npm run capture -- --recipe gallery.fire.still
npm run capture -- --recipe gallery.ai-tracking.normal
npm run capture -- --recipe gallery.ai-tracking.normal --out artifacts/capture/my-review
```

The default destination is `artifacts/capture/<recipe-id>`. A destination must be a safe
relative path inside the checkout and must not already exist. Capture never overwrites an
existing directory. Use a new `--out` path, or deliberately remove an obsolete generated
directory before retrying.

Raw PNG frames are temporary by default. `--retain-frames` copies them into the completed
artifact directory when frame-level inspection is needed. `--source-ref <ref>` records the
requested ref after verifying that it resolves to the checked-out `HEAD`; capture never
switches or edits the checkout.

### Prerequisites

FFmpeg and ffprobe must be on `PATH`. Playwright is deliberately not a repository
dependency, matching the existing visual CI policy. Install the version pinned in
`.github/workflows/ci.yml` and its Chromium browser before a local capture:

```sh
npm i --no-save playwright@1.62.0
npx playwright install chromium
```

Missing Playwright, Chromium, FFmpeg, or ffprobe stops the command before a capture
workspace is created and reports the relevant setup action. Capture reads the Playwright
version from CI's install command when constructing that error; an automated consistency
test also pins this documentation and CI's browser-cache key to the same version.

## Registry

The canonical registry is [`recipes.json`](recipes.json). Its entries are:

| Recipe ID | Existing gallery moment | Output | Schedule |
| --- | --- | --- | --- |
| `gallery.fire.still` | `fire` | `capture.png` | tick 10 |
| `gallery.ricochet.still` | `ricochet` | `capture.png` | tick 36 |
| `gallery.ai-tracking.normal` | `ai-tracking` | `capture.mp4`, `preview.gif` | ticks 0–46, one frame per 60 Hz tick |
| `gallery.drive.normal` | `drive` | `capture.mp4`, `preview.gif` | ticks 0–29, one frame per 60 Hz tick |
| `gallery.ai-last-seen.normal` | `ai-last-seen` | `capture.mp4`, `preview.gif` | ticks 0–164, one frame per 60 Hz tick |
| `screen.main-menu` | `screen.main-menu` | `capture.png` | still |
| `screen.main-menu.pad-only` | `screen.main-menu.pad-only` | `capture.png` | still |
| `screen.main-menu.fresh` | `screen.main-menu.fresh` | `capture.png` | still |
| `screen.levels` | `screen.levels` | `capture.png` | still |
| `screen.records.stats` | `screen.records.stats` | `capture.png` | still |
| `screen.records.stats.empty` | `screen.records.stats.empty` | `capture.png` | still |
| `screen.records.achievements` | `screen.records.achievements` | `capture.png` | still |
| `screen.settings` | `screen.settings` | `capture.png` | still |
| `screen.settings.pad-focus` | `screen.settings.pad-focus` | `capture.png` | still |
| `screen.settings.controller-layout` | `screen.settings.controller-layout` | `capture.png` | still |
| `screen.customize` | `screen.customize` | `capture.png` | still |
| `screen.versus-setup` | `screen.versus-setup` | `capture.png` | still |
| `screen.versus-setup.selected` | `screen.versus-setup.selected` | `capture.png` | still |
| `screen.versus-setup.teams` | `screen.versus-setup.teams` | `capture.png` | still |
| `screen.versus-setup.map-replaced` | `screen.versus-setup.map-replaced` | `capture.png` | still |
| `screen.about` | `screen.about` | `capture.png` | still |
| `screen.about.document` | `screen.about.document` | `capture.png` | still |
| `screen.devtools` | `screen.devtools` | `capture.png` | still |
| `screen.devtools.config` | `screen.devtools.config` | `capture.png` | still |
| `screen.devtools.config.sandbox` | `screen.devtools.config.sandbox` | `capture.png` | still |
| `screen.devtools.production-save` | `screen.devtools.production-save` | `capture.png` | still |
| `screen.devtools.actions` | `screen.devtools.actions` | `capture.png` | still |
| `screen.devtools.diagnostics` | `screen.devtools.diagnostics` | `capture.png` | still |
| `screen.devtools.controller-selftest` | `screen.devtools.controller-selftest` | `capture.png` | still |
| `screen.confirm.new-campaign` | `screen.confirm.new-campaign` | `capture.png` | still |
| `screen.startup.unsupported-render` | `screen.startup.unsupported-render` | `capture.png` | still |
| `screen.startup.probe-blocked` | `screen.startup.probe-blocked` | `capture.png` | still |
| `screen.startup.entry-refused` | `screen.startup.entry-refused` | `capture.png` | still |
| `screen.startup.entry-unparseable` | `screen.startup.entry-unparseable` | `capture.png` | still |
| `screen.startup.match-failed` | `screen.startup.match-failed` | `capture.png` | still |
| `screen.no-script` | `screen.no-script` | `capture.png` | still |
| `screen.launch` | `screen.launch` | `capture.png` | still |
| `screen.boot-loading` | `screen.boot-loading` | `capture.png` | still |
| `screen.practice` | `screen.practice` | `capture.png` | still |
| `screen.practice.touch` | `screen.practice.touch` | `capture.png` | still |
| `screen.pause.versus` | `screen.pause.versus` | `capture.png` | still |
| `screen.pause.campaign` | `screen.pause.campaign` | `capture.png` | still |
| `screen.controllers` | `screen.controllers` | `capture.png` | still |
| `screen.controllers.pads` | `screen.controllers.pads` | `capture.png` | still |
| `screen.ending.mission-clear` | `screen.ending.mission-clear` | `capture.png` | still |
| `screen.ending.campaign-over` | `screen.ending.campaign-over` | `capture.png` | still |
| `screen.ending.mission-clear.played` | `screen.ending.mission-clear.played` | `capture.png` | still |
| `screen.ending.campaign-over.played` | `screen.ending.campaign-over.played` | `capture.png` | still |
| `screen.ending.versus.ffa.played` | `screen.ending.versus.ffa.played` | `capture.png` | still |
| `screen.ending.versus.teams.played` | `screen.ending.versus.teams.played` | `capture.png` | still |
| `screen.ending.campaign-complete` | `screen.ending.campaign-complete` | `capture.png` | still |
| `screen.ending.practice-cleared` | `screen.ending.practice-cleared` | `capture.png` | still |
| `screen.ending.practice-failed` | `screen.ending.practice-failed` | `capture.png` | still |
| `screen.settings.focused` | `screen.settings.focused` | `capture.png` | still |
| `screen.settings.pressed` | `screen.settings.pressed` | `capture.png` | still |
| `screen.settings.rumble-refused` | `screen.settings.rumble-refused` | `capture.png` | still |
| `screen.settings.touch` | `screen.settings.touch` | `capture.png` | still |
| `screen.settings.ui-scale` | `screen.settings.ui-scale` | `capture.png` | still |
| `flow.campaign-round.pp1roles-off` | `campaign-round` | `capture.mp4` | one round at 30 fps, 60 s ceiling |
| `flow.campaign-round.pp1roles-on` | `campaign-round` | `capture.mp4` | one round at 30 fps, 60 s ceiling |
| `flow.campaign-roster.pp1roles-off` | `campaign-round` | `capture.mp4` | one round at 30 fps, 60 s ceiling |
| `flow.campaign-roster.pp1roles-on` | `campaign-round` | `capture.mp4` | one round at 30 fps, 60 s ceiling |
| `flow.campaign-round.docs` | `campaign-round` | `capture.mp4`, `preview.gif` | documentation profile: 640x400, 8 s at 15 fps |
| `flow.versus-round.docs` | `versus-round` | `capture.mp4`, `preview.gif` | documentation profile: 640x400, 8 s at 15 fps |

The `screen.*` recipes are the `screen` producer (issue #561): they boot the BUILT page
into a named application state from [`tools/screens/states.mjs`](../screens/states.mjs) and
photograph it. A screen recipe carries an empty `variant` — which screen it is lives in
`producer.scenarioId`, and the state definition owns its seeded storage, its renderer-probe
override and the clicks that reach it, because those are properties of the screen rather
than of one capture of it.

They are captured on demand and are NOT part of the required `visual` check. See
[`tools/screens/README.md`](../screens/README.md) for that argument.

`gallery.ai-tracking.normal` is a generic tracking/capture fixture. It is not evidence of
turret shimmer and does not encode or evaluate an AI deadband choice.

`gallery.ai-last-seen.normal` is issue #372's artefact: an AI that has lost sight of its
target holding its turret on the last position it actually observed, then handing off to
the idle search sweep. It is the only recipe shot from the `top` view rather than the game
camera, because its whole content is where a turret points relative to a target it cannot
see and the game camera's oblique angle foreshortens exactly that bearing. It is evidence
for a judgement, not a measurement; what is measurable about the moment is pinned in
`src/render/gallery/moments.test.ts`.

At least two recipes per media kind, on different scenarios, is deliberate rather than a
coincidence of what was needed first: with one of each, "the still path works" and "this one
recipe works" are indistinguishable, and a pipeline coupled to a single scenario ID or to a
tick only one moment reaches would pass either way. `schema.test.ts` pins the property, so
deleting a recipe fails rather than quietly narrowing the evidence -- and pins this table
against the registry, so adding one without documenting it fails too. `gallery.ricochet.still`
additionally captures a tick that is *not* the tick of its first expected event, which a
single-event recipe cannot exercise.

Each recipe declares a schema and recipe version, producer/scenario, deterministic fixture
and seed, structured render variants, viewport/DPR, visual-motion-capability profile,
fixed schedule, intended playback, exact artifact names, expected events, descriptive
metadata, timeout, and byte budget. Validation uses exact allowlists; registry values are
never interpreted as commands, shell fragments, environment interpolation, paths, or
free-form gallery arguments.

Recipe hashes use recursively key-sorted canonical JSON before SHA-256. Reordering object
keys does not change the hash. A semantic recipe change must increment `recipeVersion`;
the content hash then identifies the exact reviewed configuration.

### Producer contract and registration

The producer vocabulary reserves `moment`, `screen`, `flow`, and `replay`. `moment`,
`screen`, and `flow` are registered in [`producers.mjs`](producers.mjs). `replay` fails with
an explicit “not implemented” error until a reviewed adapter exists; no speculative replay
path is hidden behind the registry.

An adapter receives the validated recipe, an isolated producer output directory, resolved
prerequisites, environment, and an `AbortSignal`. It returns the schema-v1 normalized result
validated by [`producer.mjs`](producer.mjs):

```text
{
  schemaVersion,
  producer: { kind, scenarioId },
  rawFrames: [absolute PNG paths inside the producer directory],
  capture: {
    viewport: { width, height, devicePixelRatio },
    frameSchedule: { kind: "still" | "frames", frameCount }
  },
  assertions: [{ kind, passed, diagnostic, details }],
  metadata: object | null,
  toolVersions: { [toolId]: version },
  diagnostics: [string]
}
```

The shared runner validates and renumbers those frames, assembles every requested PNG,
MP4, and GIF, probes the results, builds the manifest, and publishes atomically. An adapter
never returns an assembled GIF or format-specific command. Moment-only facts—effective
seed, tick schedule, fixture assertions, and observed gameplay events—live under
`producer.metadata.moment`; core does not read them. The fake `screen` adapter test uses a
generic fixed-frame recipe and the complete shared pipeline without supplying moment data.

Adding a real producer requires its own strict recipe-option validation, an adapter that
returns this result, and one registration in `producers.mjs`. It does not require runner,
manifest-builder, or media-encoder changes. A generic `frames` schedule is available for
non-simulation producers; the gallery adapter continues to require the existing fixed
`ticks` schedule, and the flow adapter the `realtime` one described below.

## Artifact contract

A still capture is published only when this complete directory can be installed:

```text
<output>/
  capture.png
  capture.json
```

A temporal capture is:

```text
<output>/
  capture.mp4
  preview.gif
  capture.json
```

A `flow` recipe may leave `preview.gif` out (issue #815): at a real-time capture's size and
length a GIF is tens of megabytes, and the MP4 is the review artifact.

The MP4 is the normal-speed review source of truth. The encoder is constructed to request
libx264, yuv420p, and fast-start metadata. Validation then independently measures H.264,
yuv420p, average FPS, frame count, duration, and top-level `moov`/`mdat` box ordering.
MP4 FPS must match the recipe within the larger of 0.01 fps or 0.1%; duration must match
the captured frame count divided by requested FPS within half a frame, and its measured
FPS/duration must imply the same frame count within that half-frame tolerance.

The GIF is a practical preview. The pipeline parses its image blocks, graphic-control
delays, and NETSCAPE/ANIMEXTS loop extension instead of assuming FFmpeg honored the
request. Its frame count must match the raw capture, its measured loop count must be zero
(infinite), and its displayed duration must be within one centisecond of the schedule.
The ffprobe duration must also agree with the parsed delays within one centisecond. GIF
centisecond delay quantization cannot represent exact 60 fps, so its measured display
duration/rate must not be used as exact timing evidence.

The manifest records the recipe version and canonical hash, source ref/SHA/dirty state,
requested fixture and structured variants, effective viewport/DPR/profile and frame
schedule, intended and measured playback, generic assertion results, optional
producer-specific metadata, tool versions, media properties, relative filenames, sizes,
SHA-256 checksums, budget result, status, and diagnostics. Each artifact separates encoder
`construction` requests from measured container properties and a passed `verification`
record with expected values, evidence source, and tolerances. It contains no raw producer
paths, temporary paths, or unrelated environment data.

Numbered PNGs live in a unique `tmp/capture-*` workspace. A pre-existing `tmp` symlink is
refused, and the created directory is realpath-checked inside the checkout. On success or
failure, the producer/browser/FFmpeg process groups are closed and that workspace is
removed. When
`--retain-frames` is set, copies are published under `frames/` and the manifest records a
relative pattern plus an aggregate checksum. Encoding, probing, assertion, and budget
failures remove the partial publication; a final output directory therefore never looks
successful without a successful `capture.json`.

The CLI handles SIGINT and SIGTERM cooperatively. The first signal aborts every active
subprocess group and lets the normal idempotent cleanup path remove workspaces, partial
publication, and `.capture.lock`; exit status is 130 for SIGINT or 143 for SIGTERM. A
repeated signal force-kills active groups and imposes a bounded hard-exit fallback rather
than hanging indefinitely.

## Real-time application captures (`flow`)

The `flow` producer (issue #815) records the BUILT application playing at wall-clock pace:
`tools/screens/record.mjs` serves `dist`, drives the page through a flow from
[`tools/screens/flow.mjs`](../screens/flow.mjs), and once the round is playing (and its
start countdown has cleared) captures every frame the compositor produces, with its
timestamp, through the CDP screencast for `schedule.durationSeconds`. Nothing steps the
simulation. The frames are laid onto a constant-rate timeline by holding the last frame
(`resamplePlan`) and decoded by one ffmpeg call into the numbered PNGs every producer hands
the shared runner, which encodes and validates the MP4 exactly as for a gallery clip.

A flow recipe:

- names a flow through `producer.scenarioId` (`campaign-round`: a fresh save, New Game at
  the requested level);
- carries the seed in `fixture.seed` (1 or more: the page derives a clock seed from 0);
- carries `variant: { level, driver: 'autoplay', flags: { pp1Roles?: boolean },
  minimumDeliveredFps? }`. The page URL is BUILT from these in a fixed order; a recipe never
  supplies query text, and `flags` is an allowlist checked against the dev-flag registry;
- uses `schedule: { kind: 'realtime', durationSeconds }` (1 to 60 s) with `playback.rate` 1
  and an `intendedFps` that gives a whole frame count, `profile.motion` `full`, and
  `profile.visual` `software-gl` (SwiftShader) or `host-gpu` (the machine's GPU; on macOS
  through ANGLE Metal). Which renderer ran is recorded, never assumed;
- needs `timeoutMs` to hold the window plus 60 s of boot.

**The manifest's timing evidence** lives in `producer.metadata.flow.timing` and in the
assertions the adapter judges the recording by:

- `flow-report-identity`: the recorder played the level, seed, driver and flags the recipe asked for
- `flow-config-effective`: the page's own diagnostics report opened developer mode and refused none of the parameters
- `flow-build-identity`: the page names the checkout's commit; build with `VITE_BUILD_SHA=$(git rev-parse HEAD) npm run build`
- `flow-world-identity`: the replay surface reports the recipe's seed and the level's arena
- `flow-still-playing`: the surface was `playing` at every sample and at the end of the window
- `flow-no-clamped-frames`: no animation frame crossed the 250 ms catch-up clamp (`MAX_FRAME_DT`), so simulated time kept pace with the clock
- `flow-simulation-rate`: the replay surface advanced 60 ticks per wall-clock second within 3%
- `flow-frame-size` and `flow-frame-count`: every staged frame is the viewport at its DPR, and there are exactly `durationSeconds x intendedFps` of them
- `flow-delivered-rate`: only when `variant.minimumDeliveredFps` is set: the compositor delivered at least that many frames per second

The simulation-rate and clamp assertions are the normal-speed proof, and they hold under
SwiftShader too: the game's driver catches up in whole ticks, so simulated time tracks the
clock even when rendering is slow. What a slow renderer changes is the delivered rate and
the held frames, both recorded (`screencast.fps`, `resample.heldFrames`,
`resample.maxConsecutiveHold`). Measured on an M1 Max at 1280x800: about 100 delivered
frames per second under `host-gpu`, about 30 under `software-gl`. The proving pair asks for
45, so on a machine without a GPU it fails with the measured number rather than publishing
choppy footage as evidence. Headless animation frames are not display-throttled, so a render
rate above the display rate is a headless artefact, not a display condition.

**What the manifest says about provenance.** `reproduce` (every recipe) lists the Playwright
install, the build line with the commit, and the capture command, with a note when the
checkout was dirty. `metadata.flow` records the built URL, the page's diagnostics report
(build, developer mode, refused and unknown parameters), the world's seed and arena, whether
the round is the campaign's or a practice level (a `level` jump plays as practice: the same
world, outside a run), the served bundle's fingerprint, the browser version and renderer,
and every timing number above. World-level application of `pp1Roles` is not observable
from the page (issue #797); the flag's evidence is that the page accepted it.

**Registering a flow capture.** Add the recipe to `recipes.json`, its row above, its id to
`schema.test.ts` and to `.github/workflows/capture.yml`'s options; a new flow goes in
`flow.mjs`'s catalogue with its storage and is validated like a screen state. Two real-time
captures differ by timing jitter, so `npm run capture:compare` refuses flow recipes; review
the MP4 pair and the two manifests, whose `producer.requestedInputs` differ in exactly the
experiment's flags.

## Comparing two refs

`npm run capture:compare` runs this command at two refs in throwaway worktrees and assembles
labelled before/after evidence from the raw frames. It requires the recipe to be identical
on both sides -- fixture first, behaviour second -- so that a difference image cannot
confuse a change in the measurement with a change in the code. See
[`tools/compare/README.md`](../compare/README.md).

## Determinism boundary

For the same recipe and source, capture preserves the declared scenario inputs, effective
frame schedule, dimensions, and producer assertions/metadata. Gallery moments additionally
record their effective seed, fixed-tick schedule, fixture assertions, and observable events;
they are advanced explicitly by integer tick and interpolation fraction, never by wall-clock
or `requestAnimationFrame` pacing.

Raw-frame equality can be useful inside a pinned supported environment. Encoded PNG, GIF,
or MP4 byte equality is not promised across operating systems, GPU stacks, Chromium
builds, or FFmpeg builds. The manifest's tool versions and checksums establish provenance;
they complement, rather than replace, its record of effective inputs and schedule.
