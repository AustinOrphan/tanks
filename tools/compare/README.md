# Comparing a capture across two refs

`npm run capture:compare` captures one reviewed [capture recipe](../capture/README.md) at
two repository refs and assembles labelled before/after evidence. It exists so that
"this change looks different" can be shown rather than asserted, without hand-editing
source, switching branches, or recording two clips by hand.

```sh
npm run capture:compare -- --recipe gallery.fire.still --base main --head HEAD
npm run capture:compare -- --recipe gallery.ai-tracking.normal --base main --head my-branch --out artifacts/compare/review
npm run capture:compare -- --recipe gallery.fire.still --base v1.0 --head main --retain-frames
```

The default destination is `artifacts/compare/<recipe-id>`, which `.gitignore` covers.
Like capture, this command never overwrites an existing directory: pick a new `--out`, or
delete the obsolete one deliberately.

## Fixture first, behaviour second

**The recipe must already exist, unchanged, on both refs.** If it is missing on one side,
or differs in any way, the command refuses and says which fields differ.

That rule is the point of the tool rather than an obstacle to it. A recipe is the measuring
instrument: its seed, viewport, schedule, and expected events decide what the capture even
is. Change the instrument and the code in the same comparison and the resulting difference
image cannot distinguish the two — a moved viewport and a moved tank look identical.

So the workflow is:

1. Land the capture recipe on `main` first, in its own change.
2. Branch, and make the behaviour change.
3. Compare `main` against the branch.

Comparing against a ref that predates the recipe fails with that instruction rather than a
raw git error.

## What it does to your checkout

Nothing. Both refs are captured in throwaway worktrees under `tmp/`, created at the exact
resolved commit SHAs and removed on success and on failure alike. The command never
switches branches, never patches files, never runs `git clean`, and in particular:

- it **never stashes** — the stash stack is shared by every worktree on the machine, so a
  stash/pop pair can swallow another session's uncommitted work;
- it **never prunes** — `git worktree prune` collects stale entries for every worktree, not
  just this run's.

It removes only worktrees it created itself, tracked by absolute path. A worktree it could
not remove is reported and makes the command exit non-zero, because that needs a human.

Uncommitted changes in your tree are fine and are left alone. Note that `--head HEAD`
resolves to the **commit**, so your uncommitted work is *not* in the evidence; the command
says so, and `compare.json` records `callerTreeDirty`.

Both sides run against your installed `node_modules`, by symlink. That is the contract, not
a shortcut: one Playwright, one Chromium, one FFmpeg produce both halves, so a difference is
the code rather than the toolchain. The corollary is that this is the wrong tool for
comparing a *dependency* change.

## Output

For a still recipe:

```text
<output>/
  base.png            labelled capture at --base
  head.png            labelled capture at --head
  side-by-side.png    the pair, base left, head right
  difference.png      per-pixel difference; black is unchanged
  base/  head/        each side's complete capture, including its own capture.json
  compare.json
```

For a temporal recipe, `comparison.mp4` (H.264, yuv420p, normal speed — the review source
of truth) and `comparison.gif` (a practical preview) replace the four stills.

Captions carry the side, the short SHA, and the ref, in that order: a long branch name gets
an ellipsis rather than pushing the SHA off the edge.

`--retain-frames` additionally copies each side's raw PNG frames into `base/frames/` and
`head/frames/`. They are several megabytes a side on a clip, so they are opt-in; the
comparison itself always uses them regardless.

### Reading the result

Comparison happens on **raw frames, before encoding**. Encoded PNG, GIF, and MP4 bytes are
not stable across FFmpeg builds or operating systems (see the capture README's determinism
boundary), so comparing files would report the encoder's differences as if they were the
renderer's.

`compare.json` records the resolved SHAs, the recipe's version and content hash, both source
manifests, tool-version parity, per-frame changed-pixel counts, and the exact command to
reproduce the run. Two statistics are reported per frame because they answer different
questions: `changedPixels` is how much of the image moved, and `maxChannelDelta` is how far.
Antialiasing noise is many pixels at delta 1; a moved object is fewer pixels at a large
delta.

A tool-version difference between the two sides is reported, with a warning, rather than
refused. Every version `capture.json` records is the *caller's* — Node from the process that
ran the capture, Playwright and Chromium through the symlink to your `node_modules`, FFmpeg
and ffprobe from your PATH — so in the supported path the two sides cannot actually differ.
A reported difference means the two refs *record* tool versions differently, not that two
toolchains ran, and throwing away a real comparison over that would be the wrong trade.
`compare.json` names the differing keys.

**A zero-difference result is evidence.** It is reported as `IDENTICAL`, exits zero, and
means what it says — a change that was expected to move pixels and did not is a finding, not
a tool failure.

Frames are never frozen, padded, retimed, or scaled to make two captures line up. If the
two sides differ in dimensions, schedule kind, or frame count, the command fails and prints
both numbers.

### Sharing

Everything is written under `artifacts/`, which is gitignored, and stays local until someone
deliberately attaches it. `side-by-side.png` and `comparison.gif` paste directly into a
review comment; `comparison.mp4` is the one to link when motion matters, since the GIF's
centisecond delay quantisation cannot represent 60 fps exactly and is a preview rather than
timing evidence.

## Prerequisites

The same as capture — Playwright, Chromium, FFmpeg, and ffprobe. See the
[capture README](../capture/README.md#prerequisites).
