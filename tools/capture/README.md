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

## Initial registry

The canonical registry is [`recipes.json`](recipes.json). Its initial entries are:

| Recipe ID | Existing gallery moment | Output | Schedule |
| --- | --- | --- | --- |
| `gallery.fire.still` | `fire` | `capture.png` | tick 10 |
| `gallery.ai-tracking.normal` | `ai-tracking` | `capture.mp4`, `preview.gif` | ticks 0–46, one frame per 60 Hz tick |

`gallery.ai-tracking.normal` is a generic tracking/capture fixture. It is not evidence of
turret shimmer and does not encode or evaluate an AI deadband choice.

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

The producer vocabulary reserves `moment`, `screen`, `flow`, and `replay`. Only `moment`
is registered in [`producers.mjs`](producers.mjs). The other recognized kinds fail with an
explicit “not implemented” error until a reviewed adapter exists; no speculative screen,
flow, or replay path is hidden behind the registry.

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
`ticks` schedule.

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
