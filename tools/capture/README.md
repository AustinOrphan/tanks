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
workspace is created and reports the relevant setup action.

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

The producer vocabulary reserves `moment`, `screen`, `flow`, and `replay`. Only `moment`
is implemented. The other recognized kinds fail with an explicit “not implemented” error
until a reviewed adapter exists; no speculative screen, flow, or replay path is hidden
behind the registry.

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

The MP4 is the normal-speed review source of truth. It is H.264, yuv420p, and written with
fast-start metadata. The looping GIF is a practical preview; GIF centisecond delay
quantization cannot represent exact 60 fps, so its measured display duration/rate are
recorded separately and must not be used as exact timing evidence.

The manifest records the recipe version and canonical hash, source ref/SHA/dirty state,
effective fixture and structured variants, viewport/DPR/profile, resolved tick schedule,
intended and measured playback, observed events and assertion results, tool versions,
media properties, relative filenames, sizes, SHA-256 checksums, budget result, status, and
diagnostics. It contains no temporary paths or unrelated environment data.

Numbered PNGs live in a unique `tmp/capture-*` workspace. On success or failure, the
gallery/browser process group is closed and that workspace is removed. When
`--retain-frames` is set, copies are published under `frames/` and the manifest records a
relative pattern plus an aggregate checksum. Encoding, probing, assertion, and budget
failures remove the partial publication; a final output directory therefore never looks
successful without a successful `capture.json`.

## Determinism boundary

For the same recipe and source, capture preserves the scenario inputs and seed, fixed-tick
schedule, dimensions, and observable events. Gallery moments are advanced explicitly by
integer tick and interpolation fraction, never by wall-clock or `requestAnimationFrame`
pacing.

Raw-frame equality can be useful inside a pinned supported environment. Encoded PNG, GIF,
or MP4 byte equality is not promised across operating systems, GPU stacks, Chromium
builds, or FFmpeg builds. The manifest's tool versions and checksums establish provenance;
they complement, rather than replace, its record of effective inputs and schedule.
