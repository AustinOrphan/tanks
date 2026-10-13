# Issue #1022 visual evidence: the shipped `marks` strip, teams pips, the reversal, the loss cue

Captured 2026-10-13 (UTC), on an M1 Max under headless Chromium (Playwright 1.62.0, the version
CI pins). The arena was rendered with `--use-angle=metal`; the renderer string is in each record
report.

| Arm | Commit | Source |
| --- | --- | --- |
| AFTER | `aede72323b27ee25468afe7646cdbd8168af8cd2` (HEAD of `feat/ship-marks-stock-strip`) | the worktree, clean |
| BEFORE | `ba8f7085758fd6ef719d3d4a65eb6e60ddd1faab` (`origin/main`) | a `git archive origin/main` copy in `w1022/main-src`, with `node_modules` symlinked to the worktree's |

`git merge-base HEAD origin/main` is `ba8f7085`, so HEAD already contains current main. The spec's
"merge `main` before capturing" was already satisfied, and nothing was merged for this capture.
`origin/main` was not fetched again before the capture. Both lockfiles are identical: the branch diff
does not touch `package*.json`. The worktree's branch was never switched, no tracked file changed
(`git status --short` was empty after every step), and nothing was committed or pushed.

## Commands

```sh
# builds, one per arm, outside both trees (each run printed "built in ~215ms")
cd <worktree> && ./node_modules/.bin/vite build --outDir w1022/ev/head-dist --emptyOutDir
git archive --format=tar -o w1022/ev/main.tar origin/main   # then tar -x into w1022/main-src
cd w1022/main-src && ./node_modules/.bin/vite build --outDir w1022/ev/main-dist --emptyOutDir

# 1) the fit tool, on HEAD, at 390px (log: strip-width-head.log)
cd <worktree> && node tools/hud/strip-width.mjs

# 2a) record.mjs, the documented versus route, for every case x viewport x arm (scripts/run-rec1.sh)
node tools/screens/record.mjs --flow versus-round --mode <ffa|teams> --players <2|4> --bots <2|4> \
  --level 1 --seed 7 --driver autoplay [--flag identityMarker=solid] --seconds 2 --fps 2 \
  --w <1280|390> --h <800|844> --dpr 1 --visual host-gpu --stop window --dist w1022/ev/<arm>-dist \
  --timeout 180000 --out w1022/ev/rec1/<arm>/<case>-<vp> --report .../report.json

# 2b) drive.mjs: the same flow, DOM readings, lossless topbar PNGs, the loss-cue burst (scripts/run-all.sh)
node scripts/drive.mjs --dist w1022/ev/<arm>-dist --arm <arm> --case <case> --w <w> --h <h> --dpr 2 \
  --reduced <0|1> --seed 7 --level 1 --loss 1 --lossBudget 120 --out w1022/ev/runs/<arm>/<run>

# 3) contact sheets, stills and readings.json from both
python3 -I scripts/sheets.py
```

`w1022` is `/Users/austinorphan/.claude/jobs/8fe9c2c6/tmp/w1022`. Every long step wrote its own log
(`logs/`). None was piped through `tail`.

**The board.** Every capture is the same seeded board: `versus-round` flow, Level Select level 1
(`arena-01`), `seed=7`, every slot a bot (`bots` = `players`), `autoplay=1`. The page's own
diagnostics confirmed it: every record report reads `arenaId arena-01`, `seed 7`, with an empty
`requestedNotInEffect` and `unknownParams`. The simulation is the same in both arms. The first stock
lost on the board fell at the same tick in every arm and viewport, within one tick of polling
granularity:

| Case | First loss | Tick (main / HEAD, both viewports) |
| --- | --- | --- |
| FFA 2p | P2 | 1844-1845 / 1844 |
| FFA 4p, and the reversal | P3 | 1124-1125 / 1124 |
| Teams 4p | P4 (B) | 884 / 884 |

**drive.mjs** (in `scripts/`, run from the job tmp directory) is not a repository tool. It imports
the worktree's own `findFlow('versus-round')`, `buildFlowUrl`, `runStep`, `serve`,
`audioContextOverrideSource` and record.mjs's `launchArgumentsFor`. So it boots the page exactly as
record.mjs does: same storage, splash, diagnostics detour, Level Select and readiness wait. Then it
reads the DOM, which record.mjs cannot. Both arms use the worktree's tools. `tools/screens` and
`tools/shared` are identical on main and HEAD, so the bundle is the only variable.

## 1. `node tools/hud/strip-width.mjs` on HEAD, 390px (exit 0)

Control: a 4-player, 3-stock teams strip at 320px reaches a right edge of 349.9px against a 312px
budget, so it overflows, as it must. The budget at 390px is the topbar's content edge, 380px.

**`marks: 15 of 15 configurations fit`** (the shipped FFA strip, no leading mark):

| players x stocks | layout | strip px | right edge px | spare px |
| --- | --- | --- | --- | --- |
| 2 x 1 | 9.9/2 | 76.7 | 126.8 | 253.2 |
| 2 x 2 | 9.9/2 | 100.5 | 150.7 | 229.3 |
| 2 x 3 | 9.9/2 | 124.3 | 174.5 | 205.5 |
| 2 x 4 | 9.9/2 | 148.1 | 198.3 | 181.7 |
| 2 x 5 | 9.9/2 | 171.9 | 222.1 | 157.9 |
| 3 x 1 | 9.9/2 | 120.0 | 170.2 | 209.8 |
| 3 x 2 | 9.9/2 | 155.7 | 205.9 | 174.1 |
| 3 x 3 | 9.9/2 | 191.4 | 241.6 | 138.4 |
| 3 x 4 | 9.9/2 | 227.1 | 277.3 | 102.7 |
| 3 x 5 | 9.9/2 | 262.9 | 313.0 | 67.0 |
| 4 x 1 | 9.9/2 | 163.3 | 213.5 | 166.5 |
| 4 x 2 | 9.9/2 | 210.9 | 261.1 | 118.9 |
| 4 x 3 | 9.9/2 | 258.6 | 308.8 | 71.2 |
| 4 x 4 | 8/2 (narrow row) | 275.7 | 325.9 | 54.1 |
| 4 x 5 | 9.9+n (one mark + count) | 217.8 | 267.9 | 112.1 |

**`teams: 10 of 10 configurations fit`** (`P1 A ` and its pips). Every row drew identical markup
under `identityMarker=solid`; the tool checks that and reports any difference:

| players x stocks | layout | strip px | right edge px | spare px |
| --- | --- | --- | --- | --- |
| 3 x 1 | 10/3 | 163.2 | 213.4 | 166.6 |
| 3 x 2 | 10/3 | 202.2 | 252.4 | 127.6 |
| 3 x 3 | 10/3 | 241.2 | 291.4 | 88.6 |
| 3 x 4 | 10/3 | 280.2 | 330.4 | 49.6 |
| 3 x 5 | 9/2 | 292.2 | 342.4 | 37.6 |
| 4 x 1 | 9/2 | 217.0 | 267.2 | 112.8 |
| 4 x 2 | 9/2 | 261.0 | 311.2 | 68.8 |
| 4 x 3 | 9/2 | 305.0 | 355.2 | 24.8 |
| 4 x 4 | 10+n (one pip + count) | 275.4 | 325.6 | 54.4 |
| 4 x 5 | 10+n | 275.4 | 325.6 | 54.4 |

`reversal: 15 of 15 configurations fit`. This is FFA under `identityMarker=solid`: pips, no mark.
The tightest row is 4 x 3 at 297.9px, 82.1px spare. The full table is in the log. The tool's
closing line is `every configuration fits`.

**Cross-check on the real built page** (drive.mjs, 390x844, 3 stocks). Each strip's right edge
equals the tool's cell exactly: FFA 2p 174.5px (tool 2 x 3: 174.5), FFA 4p 308.8 (4 x 3: 308.8),
teams 4p 355.2 (4 x 3: 355.2), reversal 4p 297.9 (4 x 3: 297.9). In every drive.mjs run the strip's
computed `font-family` was the shipped stack, `"IBM Plex Sans", system-ui, ...`. That is the
declaration only. The tool's own per-row check is what confirms the face file loaded.

## 2. Stills (`sheets/`, `stills/`)

**Populations.**
- drive.mjs, static plus burst: 4 cases x 2 viewports x 2 arms = 16 runs. Add 4 reduced-motion
  runs (FFA 4p x 2 viewports x 2 arms) and 1 retake (HEAD teams 1280, see below), for 21 runs.
  Every run found a stock loss within the 120 s budget, with 0 page errors.
- record.mjs at `--dpr 1`: 4 cases x 2 viewports x 2 arms = 16 runs. All exited 0 at 59.5-60.5
  ticks/s, ~120 render fps, surface `playing` at the end, 0 frame-size mismatches, 0 page errors.
- Not used: 16 more record.mjs runs at `--dpr 2` (`w1022/ev/rec`). See Problems.

Each `sheets/case-*.png` stacks, per viewport: the BEFORE and AFTER drive.mjs PNG (2x, lossless),
each above the record.mjs `frame-0000` from the same arm. That frame is JPEG-sourced, captured at 1x
and pixel-doubled to match. At 1280 the crop stops 40px past the wider strip. At 390 it is the full
width. The tile labels carry the DOM readings: text, accessible name, unit counts, leading marks and
right edge.

| Case | BEFORE (origin/main) | AFTER (HEAD) |
| --- | --- | --- |
| `case-ffa-2p.png` | Digit strip `P1 3`, `P2 3`, each behind a leading identity mark (2 marks; no `role="img"`). Right edge 186.6px at 1280, 162.3px at 390. | `marks` row: 3 filled outlines per entry (circle, triangle), no leading mark. Text is `P1 `/`P2 ` with no digit; each row is named "3 of 3 stocks". Right edge 198.7 / 174.5px. |
| `case-ffa-4p.png` | Digit strip with 4 leading marks (circle, triangle, square, star). Right edge 308.7 / 284.5px. | `marks` row: 12 outlines (3 per entry) in each slot's shape, no leading mark, "3 of 3 stocks" x4. Right edge 333.0 / 308.8px. |
| `case-teams-4p.png` | Digit strip with letters, `P1 A 3`, `P2 B 3`, `P3 A 3`, `P4 B 3`, no marks. Right edge 293.8 / 269.6px. | Pips beside the letter, `P1 A ` and 3 pips per entry (12 pips), no mark, "3 of 3 stocks" x4. Right edge 399.4 / 355.2px. |
| `case-reversal-ffa-4p.png` (`identityMarker=solid`) | Digit strip `P1 3` ... `P4 3`, no marks. Right edge 236.5 / 212.3px. | Pips, 3 per entry (12), no marks, no leading mark, "3 of 3 stocks" x4. Right edge 342.1 / 297.9px. |

`stills/<case>/` holds each arm and viewport as `-topbar.png` (drive.mjs clip of the topbar band,
2x), `-full.png` (drive.mjs full page, 2x) and `-record-frame-0000.png` (record.mjs full frame,
1x).

### The loss cue mid-run (`sheets/loss-cue-1280x800.png`, `sheets/loss-cue-390x844.png`)

FFA 4 players. The first stock lost on the board is P3's, at tick 1124. When the strip changed,
drive.mjs shot the topbar as fast as it could, roughly every 25-35 ms, for 1.1 s. It read the cue
element's `getAnimations()` timing just before and just after each shot. The columns are BEFORE, AFTER,
AFTER under reduced motion (context `reducedMotion: 'reduce'`, which the page resolved to
`.hud--reduced-motion`) and BEFORE under reduced motion. The rows are round start, then cue progress
0, 0.25, 0.5 and 0.75, the first finished frame, and +1.2 s. The BEFORE columns take the frame
nearest the same elapsed ms.

- AFTER: P3's third square goes hollow and swells. The cue is `hud-stock-mark-empty`, 700 ms,
  peaking at a measured scale of 1.498 (1280) and 1.500 (390). It settles at scale 1.00, finished.
  The mid-run frame is `cue-12` at 1280 (+384 ms, progress 0.499) and `cue-14` at 390 (+389 ms,
  0.512). Those are `stills/loss-cue/head-<vp>-mid.png`.
- AFTER, reduced motion: `hud-stock-mark-empty--still` runs instead. The emptied square is dimmed
  and never moves: the measured scale was 1.00 in every frame. At mid-run the progress is 0.476
  (1280) and 0.512 (390).
- BEFORE, both forms: the digit goes `P3 3` to `P3 2`. There is no cue element in any frame,
  because `stockCue` absent is the digit strip on main.
- At +1.2 s P4 has also lost a stock in every run. P2 has too in the runs whose settled frame fell
  at tick 1262-1263. The two HEAD 390 runs settled at ticks 1257-1258, just before P2's loss.

`sheets/loss-cue-mid-every-case.png` shows the mid-run frame of the first loss for every case, from
the bursts the 16 static runs also took. HEAD's FFA strips swell the emptied outline. HEAD's teams
and reversal strips run `hud-stock-pip-empty`: the pip empties and a ring bursts around it. Every
frame was taken at progress 0.49-0.51 and labelled with its before-after range. The frames are
also in `stills/loss-cue-every-case/`. One retake: the first HEAD teams burst at 1280 stalled for
275 ms between progress 0.19 and 0.63, so it has no mid-run frame. Take 2 used the same board, with
the same first loss at tick 884, and supplies that frame.

**Resume across a rebuild, seen on the real page.** In the teams board, P3 loses a stock at tick
~915, while P4's cue is still running. The strip rebuilds. P4's cue reads p=0.70 just before and
0.75-0.76 just after (it did not restart at 0), while P3's new cue starts at p=0.01-0.02. This
showed in all three teams bursts. The readings are in each run's `facts.json`, under
`w1022/ev/runs/head/teams-4p-*`, and are not copied into `readings.json`.

## Files

- `strip-width-head.log`: step 1, verbatim.
- `sheets/`: `case-ffa-2p`, `case-ffa-4p`, `case-teams-4p` and `case-reversal-ffa-4p` (one per
  static case); `loss-cue-1280x800` and `loss-cue-390x844`; `loss-cue-mid-every-case`.
- `stills/`: the individual PNGs behind the sheets.
- `readings.json`: per case, arm and viewport, the drive.mjs DOM reading (entries, names, unit
  counts, leading marks, strip and topbar geometry, font, diagnostics) and the record.mjs
  provenance (URL, world, diagnostics, ticks/s, renderer). Per loss run: the selected frames with
  their cue timing.
- `record-reports/`: the 16 record.mjs `report.json` files (`--dpr 1`).
- `scripts/`: `drive.mjs`, `run-all.sh`, `run-rec1.sh`, `sheets.py`. `logs/`: every run's log
  and both build logs.

## Problems and limits

- **`record.mjs --dpr 2` delivers 1x frames.** At `--dpr 2` every frame came back at CSS-pixel
  size: 1280x800 against an expected 2560x1600, and 390x844 against 780x1688. The report lists all
  four frames under `frames.mismatched` on all 16 runs. That set is kept in `w1022/ev/rec` and not
  used. The `--dpr 1` rerun, the memory note's documented form, has 0 mismatches. The 2x stills
  come from drive.mjs's Playwright screenshots instead.
- **Real-page stills are at 3 stocks only.** The `versus-round` flow and the page's dev flags take
  no stock count. So the narrow fallbacks were measured by the tool but not photographed on the game
  page: the 8px row at 4 x 4, mark plus count at 4 x 5, and the teams one pip plus count at 4 x 4 and
  4 x 5.
- **Single frames of a moving cue.** The cue progress printed on each frame is the reading taken
  before the shot, with the after reading as the range. The pixels were composited somewhere inside
  that range.
- The UI-scale fit (125% and 150%) is out of scope, per the issue, and was not measured.
- The rematch and different-match cases of the cue were not exercised on the page. These stills
  cover first-loss, reduced-motion and rebuild-resume only.
