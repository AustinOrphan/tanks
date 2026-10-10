# Issue #983 visual evidence: the Versus Setup Map row, before and after the board gate

| Arm | Commit | Build |
| --- | --- | --- |
| before | `origin/main` 5d8d7de6df29eaebbb58f55de732c7372895ce75 | `git archive origin/main` extracted to `w983/main-src`, node_modules symlinked from the worktree, `vite build` into `main-src/dist` |
| after | `feat/gate-campaign-boards-behind-progress` HEAD d7e40bdceb4b155be99827e4e847ab71d11ebb7d | `vite build --outDir w983/head-dist` from the worktree, which was clean |

A grep of the two bundles confirms the arms differ. The launch-gate message `is locked until its
campaign level is cleared` appears in 1 HEAD asset and 0 main assets.

## Method

- **One capture driver for both arms**, `scripts/capture-983.mjs`. Only `--dist` differs between
  arms. It reuses the worktree's `tools/screens/capture.mjs` for `launchBrowser` (SwiftShader,
  `--font-render-hinting=none`) and `serve`, `tools/screens/steps.mjs` for `runStep`, and
  `tools/shared/audio-context.mjs`. The browser context options are copied from `captureStateOnce`:
  reduced motion, dark scheme, no touch, a 250 ms settle, and a wait for `document.fonts.ready`.
- **Saves and steps come from `tools/screens/states.mjs`.**
  - `MID_CAMPAIGN` is the storage of `screen.versus-setup`. It has levels 1-2 cleared, and the
    script checks that `levelId` is `level-02`.
  - The fresh save is the storage of `screen.versus-setup.fresh`, which is `{}`.
  - The reach steps are the `screen.versus-setup` steps: Space, wait for the splash to close,
    click `.hud-versus-open`, wait for `.hud-versus-setup`.
  - The Teams click and the friendly-fire wait come from `screen.versus-setup.teams`.
  - The 3- and 4-player cases click `[data-players=N]` and then wait for Pinwheel
    (`vs-duel-01`) to leave the row, as `screen.versus-setup.fresh` does. That proves the row
    was rebuilt.
- **The all-five-cleared save is derived from `MID_CAMPAIGN`, not taken from the catalogue.** No
  catalogue state has this save. It sets `tanks.progress.v1 = {"levelId":"level-05"}`, which makes
  `highestCleared()` return 5. It drops `tanks.run.v2`, because an ended run is the absence of
  that key (`src/game/run.ts` stores only `status: 'active'`). Stats are kept.
- **Viewports** come from `tools/screens/sweep-plan.mjs` `LAYOUTS`: `390x844` at DPR 2 and
  `1280x800` at DPR 1. Both arms use the same values.
- **The pane state is checked before anything is captured.** The selected Players and Mode buttons
  (`aria-pressed="true"`) must match the case, or the capture fails.
- **Cards are read from the DOM.** Each card's `data-map`, name and config line are recorded in
  row order, from `.hud-versus-map-row [data-map]`.
- **The Map-row crop** covers the whole Map section: the `h2`, the card row and the hidden note.
  - It keeps 8 CSS px above and 3 CSS px below the section.
  - The pane (`.hud-versus-setup`) is the scroll container, and the sticky `.hud-versus-actions`
    bar covers the bottom of the scrollport. Where the section is taller than the space above the
    bar, the driver scrolls the pane and stitches the slices.
  - The viewport is never resized. Slice offsets are in each `*.json` under `stitch`.
  - The 390 before-crops are 2 slices. I checked the seam at native resolution and it does not
    show.
- **The pointer is parked off-screen** with `mouse.move(-1, -1)` before any screenshot.
  - The reach steps leave the pointer where `.hud-versus-open` was clicked. Once the pane
    scrolls, a card ends up under it. The first run painted Arena 5 in its hover state in the
    before 390 crop, which was a capture artefact.
  - Each screenshot now records the `:hover` chain in `hover`, and the capture fails if a map card
    is hovered.
  - Negative control: `--no-park` on `before fresh-2p-ffa 390x844` fails with "a map card is under
    :hover at opened". With the pointer parked, the same capture passes. All 16 final captures
    report 0 hovered elements.
- **No page errors** were recorded in any of the 16 captures.

## Cards offered, per case (read from the DOM)

In every case both layouts showed the identical card list, compared tuple for tuple. Random is
always last and always selected, because it is the pane default and no map was clicked. The Random
card's own text says how many boards it draws from, and that number is the count of boards shown.

### 1. Fresh save, 2 players, FFA: `fresh-2p-ffa/`

| | Cards | Data-map, in row order |
| --- | --- | --- |
| before | **9**: 8 boards + Random ("8 eligible boards") | `arena-01` Arena 1, `arena-02` Arena 2, `arena-03` Arena 3, `arena-04` Arena 4, `arena-05` Arena 5, `vs-duel-01` Pinwheel, `vs-tri-01` Keystone, `vs-quad-01` Quarters, `random` |
| after | **4**: 3 boards + Random ("3 eligible boards") | `vs-duel-01` Pinwheel, `vs-tri-01` Keystone, `vs-quad-01` Quarters, `random` |

Removed: all five campaign boards, `arena-01` to `arena-05`. At 1280 the row goes from 2 lines of
243 px cards (265 px tall) to 1 line of four 306 px cards (114 px tall). The computed grid
`306px 306px 306px 306px 0px` shows `auto-fit` collapsing the empty fifth track.

### 2. Fresh save, 4 players, Teams: `fresh-4p-teams/`

| | Cards | Data-map, in row order |
| --- | --- | --- |
| before | **8**: 7 boards + Random ("7 eligible boards") | `arena-01` Arena 1, `arena-02` Arena 2, `arena-03` Arena 3, `arena-04` Arena 4, `arena-05` Arena 5, `vs-quad-01` Quarters, `vs-quad-02` Citadel, `random` |
| after | **3**: 2 boards + Random ("2 eligible boards") | `vs-quad-01` Quarters, `vs-quad-02` Citadel, `random` |

Removed: `arena-01` to `arena-05`. At 1280 there are three 411 px cards on one line, 114 px tall,
with computed columns `410.656px 410.672px 410.656px 0px 0px`.

### 3. MID_CAMPAIGN save (levels 1-2 cleared), 3 players, FFA: `mid-3p-ffa/`

| | Cards | Data-map, in row order |
| --- | --- | --- |
| before | **8**: 7 boards + Random ("7 eligible boards") | `arena-01` Arena 1, `arena-02` Arena 2, `arena-03` Arena 3, `arena-04` Arena 4, `arena-05` Arena 5, `vs-tri-01` Keystone, `vs-quad-01` Quarters, `random` |
| after | **5**: 4 boards + Random ("4 eligible boards") | `arena-01` Arena 1, `arena-02` Arena 2, `vs-tri-01` Keystone, `vs-quad-01` Quarters, `random` |

Removed: `arena-03`, `arena-04` and `arena-05`, whose levels are not cleared. The two cleared
campaign boards stay. At 1280 there are five 243 px cards filling one line, 128 px tall.

### 4. All five levels cleared, 2 players, FFA: `cleared-2p-ffa/`

| | Cards | Data-map, in row order |
| --- | --- | --- |
| before | **9**: 8 boards + Random ("8 eligible boards") | `arena-01`, `arena-02`, `arena-03`, `arena-04`, `arena-05`, `vs-duel-01`, `vs-tri-01`, `vs-quad-01`, `random` |
| after | **9**: 8 boards + Random ("8 eligible boards") | the same 9, in the same order |

Nothing is removed. Both Map-row crops are **pixel-identical** between arms: 1280x304 at 1280x800
and 780x1732 at 390x844, compared with PIL `ImageChops.difference`, `getbbox() is None`. So once
everything is unlocked, a full row lays out exactly as before, including the `auto-fill` to
`auto-fit` change.

### Summary of counts

| Case | Before | After | Removed |
| --- | --- | --- | --- |
| fresh, 2p FFA | 9 | 4 | 5 |
| fresh, 4p Teams | 8 | 3 | 5 |
| MID_CAMPAIGN, 3p FFA | 8 | 5 | 3 |
| all cleared, 2p FFA | 9 | 9 | 0 |

Captures: 4 cases x 2 layouts x 2 arms = 16. Each produced:
- a Map-row crop: 16 PNGs, forming 8 before/after pairs;
- a viewport frame with the Map section scrolled to the top of the pane: 16 PNGs;
- a report: 16 JSON files.

There is one contact sheet per case, 4 in all.

## Screen baselines that changed: `screens/`

`git diff --name-status origin/main HEAD -- tools/screens/baseline/` lists 5 files: 1 added and 4
modified. These are the gate's own baselines, at 1280x800 DPR 2 according to
`tools/capture/recipes.json`.

| Baseline | Status | What moved |
| --- | --- | --- |
| `screen.versus-setup.fresh` | **A** (after only; no before exists) | new state: 3 players on a fresh save. The row is `h 114`, and the first card `w 411` |
| `screen.versus-setup` | M | `.hud-versus-map-row` h 265 to 251; `.hud-versus-role-btn` y 792 to 778 |
| `screen.versus-setup.selected` | M | `.hud-versus-map-row` h 265 to 251. The state clicks Arena 2 now instead of Arena 3 |
| `screen.versus-setup.teams` | M | `.hud-versus-map-row` h 265 to 128; `.hud-versus-friendlyfire-btn` y 560 to 423 |
| `screen.versus-setup.map-replaced` | M | `.hud-versus-map-row` h 265 to 128; `.hud-versus-map-note` y 517 to 381 |

The folder holds `<state>.before.json` (from `git show origin/main:...`), `<state>.after.json`
(from `git show HEAD:...`), `<state>.diff`, and `CHANGED.txt`.

## Files

- `<case>/contact.png`: the contact sheet. It has a 1280x800 section and a 390x844 section, with
  before and after side by side under each card list read from the DOM.
- `<case>/<layout>-before.png` and `<case>/<layout>-after.png`: the stitched Map-row crop pair, at
  device pixels.
- `<case>/<layout>-<arm>-viewport.png`: the full viewport with the Map section scrolled to the top
  of the pane.
- `<case>/<layout>-<arm>.json`: the report. It holds storage, steps, the DOM readout (`dom.cards`,
  players, mode, row box, grid columns), stitch slices, the hover log, and page errors.
- `scripts/`: the capture driver, the stitch and contact-sheet composer (PIL), and the baseline
  copier.

## Not verified

- These captures are Chromium with SwiftShader on macOS only. `screens:check` was not run here.
- Only the four requested cases were captured. Other combinations were not: 3p Teams, 4p FFA, and
  any save between 2 and 5 levels cleared other than MID_CAMPAIGN.
- The all-cleared save is hand-derived as described above. No catalogue state carries it.
- The 390x844 rows place cards edge to edge, with 390 px cards and no side gutter. This is the
  same in both arms, so this change did not cause it.
