# Issue #1055: visual evidence, teams stock strip at 390px

- After: `feat/teams-strip-phone-fit` HEAD `441eef9477ffafbe22549a77ea1b1dba115d8117`. The
  worktree was clean, and HEAD was the same when the run finished.
- Before: the branch's merge base with `origin/main`,
  `c200cf621d8bbd40add83acb570c17e40faa2c08`. `origin/main` (`a5c3273b`) has moved on since,
  but `git diff --stat c200cf62 origin/main` leaves out `src/game/hud.css` and
  `src/presentation/stock-cue.ts`, so the before images also show origin/main's rule. Main's
  later `hud.ts` change is the Controller Self-Test pane (#1072), which has nothing to do with
  the strip.
- Between the two exported `src/` trees, `diff -rq` finds only `src/game/hud.css`,
  `src/presentation/stock-cue.ts` and three test files.
- Viewport 390x844 at device scale factor 3 (crops are 3x CSS px). **UI scale 100% only.**
  Chromium from Playwright 1.62.0 (the worktree's `node_modules`, the version CI pins), on
  macOS (Darwin 25.5.0), Node v24.21.0.

## Headline

1. **No teams configuration's layout changed.** The body of `narrowPipLayout` is untouched
   (the `stock-cue.ts` diff changes doc comments only). All 10 teams configurations at rest
   (3 to 4 players x 1 to 5 stocks) are **pixel-identical** before and after: 0 px differ in
   every crop. The widths match HEAD's table in `stock-cue.ts` and the live
   `node tools/hud/strip-width.mjs` run (`strip-width-head.log`) to 0.1 px.
2. **The only rendered change** is the one-pip fallback (teams 4 players x 4 and x 5 stocks)
   after a stock loss that leaves the player with stock. Before, the cued pip keeps
   `hud-stock-cue` after the 700 ms cue, and `animation-fill-mode: both` holds
   `hud-stock-pip-empty`'s last frame: a **2px ring (hollow) next to a non-zero count**, the
   look of a player who is out. After, the pip stays **filled (5px border)**.
   - Full motion: frames at t = 0, 105 and 210 ms are identical (both rules swell the same
     way). From 350 ms on they differ: before, the border thins (3px, then 2px); after, it
     stays at 5px.
   - Reduced motion: every frame differs. Before, a full pip with its ring, then emptied from
     50% to 100%. After, the pip (and its ring) is held at opacity 0.4, then settles to 1.
3. **Controls are unchanged (0 px).** In both trees, a cue whose pip *is* lost renders
   identically: the fallback going 1 to 0, and a 9/2 row pip at 3 x 5.
4. **Noise floor: 0 px.** HEAD's tree was captured a second time (`repeat`) in the same run,
   and all 106 crops matched the `after` crops exactly. Two full runs of `run.sh` in a row
   produced byte-identical `diff.json`.

## Population

- **At rest:** all 10 teams configurations (teams is offered at 3 and 4 players only),
  lettered A, B, A, B. That is the widest legal split, the same one HEAD's `strip-width.mjs`
  uses.
- **Cued fallback pip (the changed case):** teams 4 x 4 (losses 4 to 3, 3 to 2, 2 to 1) and
  4 x 5 (5 to 4, 4 to 3, 3 to 2, 2 to 1). That makes 7 transitions per slot, x 4 slots, x 2
  motion policies.
  - **Captured:** 3 of the 7 transitions, all on P1: 4 x 5 5 to 4, 4 x 4 4 to 3, and
    4 x 5 2 to 1. Each was taken under full and reduced motion.
  - **Not captured:** the other transitions and slots. Each draws the same element with the
    same classes (`hud-stock-pip hud-stock-cue`, no `--lost`), so the same rule matches it.
- **Controls:** 4 x 4, 1 to 0 (the fallback pip becomes `--lost`); 3 x 5, 5 to 4 on a 9/2
  row. Both were taken under both motion policies.
- **Supplementary, not teams:** FFA under `pips`, 4 x 5, 5 to 4. The CSS rule is shared, so
  FFA's one-pip fallback gets the same fix (strip right edge 340.6 px, 39.4 px spare).

## Files

| File | What it shows |
| --- | --- |
| `sheet-1-rest-teams-all-10.png` | All 10 teams configurations at rest, before against after, with the topbar crop and the 380px content edge dashed. Each row gives its rung, strip width and spare room, plus the pixel verdict (all identical). |
| `sheet-2-held-after-loss-changed.png` | **The change.** The three captured fallback losses, 1.5 s after the loss in real time (nothing frozen), under full and reduced motion. Before: P1's pip is a hollow ring beside 4, 3 or 1. After: filled. |
| `sheet-3-held-after-loss-controls.png` | The two controls at 1.5 s: identical before and after. |
| `sheet-4-held-after-loss-ffa-supplementary.png` | FFA 4 x 5 under `pips`: the same change on the shared rule. |
| `sheet-5-frames-<scenario>.png` | P1's entry at 2x CSS, with the cue frozen at t = 0, 105, 210, 350, 525 and 700 ms, plus the 1.5 s held frame. Rows: before/after under full motion, then before/after under reduced motion. Each frame is captioned with the pip's computed border and opacity, and each after frame with its pixel verdict. |
| `png/rest/{before,after,repeat}-teams-<P>x<S>.png` | The raw topbar crops behind sheet 1 (1170 px wide = the full 390px viewport). |
| `png/cue/<scenario>/{before,after,repeat}-{full,reduced}-t<ms>.png` | The raw frozen entry crops. |
| `png/cue/<scenario>/{before,after,repeat}-{full,reduced}-held-{topbar,entry}.png` | The raw held crops. |
| `readings.json` | Every reading: the strip box, the right edge against the 380px edge, whether the face loaded, the pip classes, the running animations with their names and delays, and the cued pip's computed border, opacity and transform. |
| `diff.json` | The pixel count (RGBA differs at all) for every before/after pair, plus each pair's after-against-repeat noise count. |
| `strip-width-head.log` | `node tools/hud/strip-width.mjs` run in the worktree at HEAD (exit 0): the cross-check for the rest widths. |
| `run.log` | Output of the final `run.sh`. |
| `scripts/` | `run.sh` (end to end), `capture.mjs`, `sheets.mjs`, `cue-page.ts`, `cue.html`. |

## How it was made

1. `run.sh` exports the two commits with `git archive` (just `src`, `package.json` and
   `tsconfig.json`) into `../trees-1055/{before,after}`, links `node_modules` to the
   worktree's, and copies HEAD's `tools/hud/strip-width-page.ts` and `strip-width.html` (the
   page `strip-width.mjs` drives) into **both** trees. One harness therefore mounts both
   stylesheets. Nothing in the worktree is written.
2. `capture.mjs` serves each tree with the worktree's Vite 8.3.1 (JS API, `configFile: false`,
   with the dependency cache in `../trees-1055/.vite-<tree>`). It drives Chromium on each in
   three passes: `before`, `after`, and `after` again as `repeat`.
   - **Rest:** HEAD's own `window.measureStrip('marks', ...)` for each teams configuration,
     then a screenshot of the topbar. `measureStrip('pips', ...)` was also run, and its markup
     was confirmed identical for every row (a teams entry under `marks` is drawn as `pips`).
   - **Cue:** `cue-page.ts` mounts `createHud` just as `strip-width-page.ts` does. It then
     calls `hud.setReducedMotion` (the stylesheet's only view of the resolved policy) and
     pushes a second versus status with P1 one stock down. That arms the cue through the
     HUD's own `recordStockLosses`.
     - **Frames:** every animation is paused through the Web Animations API, with
       `currentTime` set to the target ms plus the cue's own `animation-delay`. The HUD gives
       a cue `-Math.round(now - at)`, which was -1 ms for some losses; without this
       correction one run's frames drifted 1 ms and differed by up to 4417 px.
     - **Held:** a separate run is left alone for 1500 ms of real time.
3. `sheets.mjs` decodes each PNG pair in Chromium and counts the pixels that differ, then lays
   out the labelled sheets.

To reproduce:

```sh
sh /Users/austinorphan/.claude/jobs/8fe9c2c6/tmp/media-1055/scripts/run.sh
# optional cross-check of the rest widths, from the worktree:
cd /Users/austinorphan/src/tanks/.claude/worktrees/imperative-waddling-willow && node tools/hud/strip-width.mjs
```

## What this does not show

- **Other UI scales:** only 100% was measured. The strip has been under the UI scale since
  #1048.
- **The full game page:** these come from a harness page that mounts `createHud` alone.
  HEAD's `strip-width.mjs` header records that its reading matched the game page booted at
  390x844 (355.16 px against 355.2 px for 4 x 3 teams). That match was not re-checked here.
- **Linux CI rendering:** text rasterisation differs between platforms. The verdicts compare
  the two trees on one machine, so they do not depend on that.
- **Forced colours and desktop widths:** neither was captured. The one-pip fallback only
  exists under `NARROW_STRIP_QUERY`, so at desktop width a cued pip is always `--lost` and the
  new rule cannot match it.
- **Observation for review, not a defect claim:** under reduced motion the after pip's
  opacity of 0.4 also dims its burst ring for the first 350 ms, because opacity on the pip
  composites its `::after`. Before, the ring was at full strength over a full pip. See the
  reduced-motion rows of any `sheet-5-frames-teams-*` sheet. Whether a dimmed ring is enough
  of a reduced-motion cue is a design call.
