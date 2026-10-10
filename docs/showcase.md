# Showcase media

How an animated GIF reaches this repository's documentation. A clip is published only as an
entry in `tools/showcase/manifest.json`, at a tracked path under `docs/media/showcase/`, and
`npm run showcase:check` holds every clip to the limits below. The policy comes from #258; the
layer that enforces it from #1062. This page shows no clips of its own.

## Limits

- At most 4 clips, and at most 1 of them shown in the root `README.md`.
- Each GIF at most 640 px wide.
- Each GIF at most 15 displayed frames per second and at most 8 seconds. A GIF delay is a whole
  number of centiseconds, so 15 fps is not exactly representable, and both limits allow one
  centisecond of slack, the capture pipeline's own GIF tolerance.
- Each GIF loops forever.
- Each GIF at most 2 MiB (2,097,152 bytes), and at most the `maxBytes` its manifest entry
  declares.
- The whole set at most 6 MiB (6,291,456 bytes).

## The manifest

`tools/showcase/manifest.json` is `{ "version": 1, "clips": [...] }`. A clip has exactly these
keys:

| Key | Meaning |
| --- | --- |
| `id` | A unique name for the clip. |
| `recipe` | The capture recipe that produced it. It must be in the capture registry and declare a `gif` artifact. |
| `output` | `docs/media/showcase/<name>.gif`, where a name is lowercase letters and digits joined by hyphens. Unique. |
| `placement` | `readme` to show it in `README.md`, or `docs` to show it here. |
| `caption` | The visible caption. Not empty. |
| `alt` | The alt text, at most 500 characters and different from the caption. Not empty. |
| `maxBytes` | The clip's own byte budget, at most 2,097,152. |
| `order` | Its position among the clips. Unique. |

An entry is publication metadata only. The viewport, seed, timing, flags and encoder settings
belong to the capture recipe it names.

An output must be a regular file in git; `showcase:check` refuses a symbolic link rather than
measuring the file it points to.

Every GIF reference in `README.md` and in this page, written as a Markdown image or an `<img>`
tag, must be a relative path to a manifest output, with alt text equal to the manifest's `alt`.
The path is relative to the document: `README.md` writes `docs/media/showcase/<name>.gif`, and
this page writes `media/showcase/<name>.gif`.
Alt text is compared as GitHub shows it, so a Markdown image may escape a character such as `\*`.
Each clip must be referenced from the document its `placement` names. An absolute URL, including
a link into the `pr-media` branch, fails. A reference inside a code block counts too.

## Publishing a clip

1. Generate it through the capture pipeline. The documentation-profile recipes are
   `flow.campaign-round.docs` and `flow.versus-round.docs`, which record 640x400 at 15 fps for
   8 s:

   ```sh
   npm run capture -- --recipe flow.campaign-round.docs
   ```

   The MP4 and the GIF land in `artifacts/capture/<recipe-id>/`, which is ignored. Capture
   never overwrites a destination, so a second take needs a new `--out`.
   `tools/capture/README.md` lists the prerequisites: Playwright with Chromium, FFmpeg and
   ffprobe.
2. Watch both the MP4 and the GIF at normal speed, and approve the clip or record it again.
3. Copy only the approved GIF to `docs/media/showcase/<name>.gif`, add its manifest entry and
   its reference from the document its placement names, and open a normal pull request.
   `.gitignore` ignores every `*.gif` except one directly in `docs/media/showcase/`, so no
   `git add -f` is needed.

No workflow commits regenerated binaries. A clip changes only through a reviewed pull request.

## Checking

```sh
npm run showcase:check
```

It prints every broken rule, then the population it checked: the clips, the tracked files under
`docs/media/showcase/` and the set's bytes. It exits non-zero on any failure, and needs git but
no FFmpeg, Playwright or network. `npm run verify:quick` runs the same check over the repository
through `tools/showcase/check.test.ts`, so CI enforces it without a workflow step of its own.
