# #1014 two-arm request-list probe

This is candidate evidence, measured locally on 2026-10-13. CI is authoritative.

- Branch `refactor/devtools-modules-on-open`, HEAD `f66eb68a6bb7b424d65d009a9674e053a78ae94f`
  (`head-sha.txt`). The tree was clean before the run, after the builds, after the screen gate and
  at the end (`status-before.txt`, `status-after-builds.txt`, `status-after-screens.txt` are all
  empty). No tracked file was modified, and nothing was committed or pushed.
- Comparison: `origin/main` at `52f04b11b470b127e781b95cdff1d5ec6067d32b` (`main-sha.txt`),
  extracted with `git archive origin/main` into
  `/Users/austinorphan/.claude/jobs/8fe9c2c6/tmp/w1014/main-src` with the worktree's
  `node_modules` symlinked in.
- Chromium 151.0.7922.34 (Playwright 1.62.0), headless. Node v24.21.0. Vite v8.3.1.

## Builds

`build-1014.sh` (it lives in `../w1014/`) runs each step with its output sent to a file.

| Step | Result |
| --- | --- |
| HEAD `npm run verify:build` (`verify-build-head.log`) | exit 0. portability: `dist/index.html + 10 bundle(s) + the PWA shell checked`. bundle:budget: `js 1,205,541 B raw (92.5% of budget), 338,860 B gzip (93.9%)`, within budget |
| main `npm run verify:build` (`verify-build-main.log`) | exit 0. `5 bundle(s)`. `js 1,199,364 B raw (92.0%), 334,015 B gzip (92.5%)` |
| HEAD sourcemap build to `../w1014/smap-head` (`smap-build-head.log`) | exit 0 |
| main sourcemap build to `../w1014/smap-main` (`smap-build-main.log`) | exit 0 |

## Method

The method is the one recorded for #1012 and #1013 (memory note `two-arm-request-probe`). The
script is `probe-requests-1014.mjs`, and `run-probes-1014.sh` runs it on both trees.

- `dist` is served by `node_modules/.bin/vite preview --port 4396 --strictPort --host 127.0.0.1`,
  spawned directly rather than through npx. Port 4396 had no listener before either run or after
  them (`port-check.txt`).
- Chromium runs with `--use-gl=swiftshader --enable-unsafe-swiftshader --disable-gpu-sandbox`.
- Each arm gets a fresh browser context, with `audioContextOverrideSource()` from
  `tools/shared/audio-context.mjs` installed as an init script.
- `page.on('request')` records every request whose path ends in `.js`. The script takes a named
  snapshot at each stage and records which files are new since the previous snapshot.
- The splash is dismissed with keyboard `Space`, then the script waits for
  `.hud-splash--hidden`.
- Clicks and visibility waits go through the screen harness's own `runStep`
  (`tools/screens/steps.mjs`), so every click is a real pointer click on a visible control. The
  one exception is the same-task Copy check in arm 2 (and arm 3's clicks), which uses
  `element.click()` on purpose; see each arm below.
- Each requested JS file is read from `dist/assets` on disk and searched for the probe strings.

```sh
zsh run-probes-1014.sh
# = node probe-requests-1014.mjs <worktree> requests-head.json ../w1014/downloads-head-final --supplementary > requests-head.log 2>&1
#   node probe-requests-1014.mjs ../w1014/main-src requests-main.json ../w1014/downloads-main-final > requests-main.log 2>&1
#   node bytes-1014.mjs requests-head.json requests-main.json bytes.json > bytes.log 2>&1
```

All three exited 0. The logs were written to files and never piped through `tail`.

## Probe strings (one per module, grepped, not chosen by eye)

`probe-grep-1014.sh` holds the exact commands. Each string was searched with
`git grep -n -F` over every tracked file at HEAD: template text, docs, tests, tools and mutation
manifests all included. Results are in `probe-grep-1.txt` to `probe-grep-7.txt`.

| Module | Probe string | Every hit in the tracked tree |
| --- | --- | --- |
| `dev-actions` | `Restart, losing this round?` | `src/game/dev-actions.ts:80` only |
| `dev-actions` | `Reroll, losing this round?` | `dev-actions.ts:86`, plus `hud.diagnostics.test.ts:304` |
| `dev-actions` | `Restart this round?` | `dev-actions.ts:92`, plus `hud.diagnostics.test.ts:320` |
| `dev-diagnostics` | `Session: none simulating (no seed to report)` | `dev-diagnostics.ts:171`, plus `dev-diagnostics.test.ts:107` and `tools/screens/flow.test.ts:332` |
| `dev-diagnostics` | `## Tanks! session diagnostics` | `dev-diagnostics.ts:165`, plus `tools/screens/flow.mjs:526` (a capture tool, never bundled) and `flow.test.ts:327` |
| `dev-exports` | `has not simulated a tick yet` | `src/game/dev-exports.ts:179` only |
| `dev-exports` | `there is no game canvas to save` | `src/game/dev-exports.ts:75` only |

Among shipped source (`src/`, non-test), each string occurs only in its own module. The template
now carries the resting labels (`Restart with Same Seed` and the others) in `hud.ts`, so the
resting labels are not probes. The confirm labels are still probes for `dev-actions`, and
source-map attribution below checks that module a second way.

## Arm 1: ordinary URL (`http://127.0.0.1:4396/`)

The script goes past the splash to the Main Menu, then presses Start Campaign and stays 3 s in the
running round.

| Observation | HEAD | main (control) |
| --- | --- | --- |
| Requests for `dev-actions-*`, `dev-diagnostics-*` or `dev-exports-*` | **none** | none (main has no such chunks) |
| Probe strings in the fetched JS | **none of the 7** | **all 7, in `index-DCK_xJX1.js`** |
| JS requested at the Main Menu | `index-DKSkR52s.js` 826,584, `blocked-fire-C-xN3qqJ.js` 292,446, `world-BiB0Jzri.js` 45,276 | `index-DCK_xJX1.js` 1,163,167 |
| New JS requested during the round | none | none |
| Developer Tools entry / DEV badge shown | no / no | no / no |
| Page errors / failed requests | 0 / 0 | 0 / 0 |

The main column is the detector's positive control. The same seven strings that are absent from
HEAD's ordinary arm are found in main's ordinary arm, in the one file it downloads.

## Arm 2: `?dev=1` (the positive control)

The arm runs in this order:

1. Main Menu.
2. Developer Tools opened from its button.
3. Copy Diagnostics, Pin Current Seed and the three exports.
4. Back, then Start Campaign.
5. The pane reopened from the DEV badge.
6. The same five presses in the round.
7. Each danger control armed only: one press, the confirm label read, the 4 s lapse waited out
   (4.5 s), and the resting label read back. Nothing was confirmed.

### Requests per stage (HEAD)

| Snapshot | New JS since the previous snapshot |
| --- | --- |
| Main Menu, before Developer Tools | `index-DKSkR52s.js`, `blocked-fire-C-xN3qqJ.js`, `world-BiB0Jzri.js` (no dev chunk) |
| Developer Tools open, before any press (1.5 s settle) | **`dev-exports-Cj0vU3wa.js` 2,434, `dev-diagnostics-DCxABR2C.js` 1,792, `dev-actions-DvQIcs-d.js` 733** |
| After the five Main Menu presses | none |
| In a round, before the DEV badge | none |
| Pane reopened from the DEV badge | none |
| End of the arm (after the presses and the arming) | none |

The chunks are requested when the menu opens, not at any press, and only once. All seven probe
strings are found in those three files and in no other file in `dist`. On main the same arm
requests nothing beyond `index-DCK_xJX1.js`.

### What each press did (HEAD; main identical field for field)

| Press | Field after it (first line) | Chars | Shown / focused / whole text selected |
| --- | --- | --- | --- |
| Menu: Copy Diagnostics | `## Tanks! session diagnostics` | 263 | yes / yes / yes |
| Menu: Pin Current Seed | `No session is running, so there is no resolved seed to pin. ...` | 95 | yes / yes / yes |
| Menu: Download Diagnostics | `Saved tanks-diagnostics-no-session.json: ...` (file downloaded) | 165 | yes / no / no |
| Menu: Download Replay | `No session is running, so there is no replay to save. ...` | 89 | yes / no / no |
| Menu: Download Screenshot | `No session is running, so there is no game canvas to save. ...` | 94 | yes / no / no |
| Menu: Copy, clicked and read in ONE task | value changed in the same task, `## Tanks! session diagnostics` | | focused / whole text selected |
| Round: Copy Diagnostics | `## Tanks! session diagnostics` (with `- Seed: 918339200`) | 317 | yes / yes / yes |
| Round: Pin Current Seed | `/?dev=1&seed=918339200` | 22 | yes / yes / yes |
| Round: Download Diagnostics | `Saved tanks-diagnostics-seed918339200-tick369.json: ...` (downloaded) | 184 | yes / no / no |
| Round: Download Replay | `Replay recording is off on this page, ... replay=1 ...` | 125 | yes / no / no |
| Round: Download Screenshot | `Saved tanks-canvas-seed918339200-tick483-1280x900-dpr1.png: ...` (downloaded) | 230 | yes / no / no |

Downloads saved: `tanks-diagnostics-no-session.json`, `tanks-diagnostics-seed918339200-tick369.json`
and `tanks-canvas-seed918339200-tick483-1280x900-dpr1.png`, all in `../w1014/downloads-head-final`.
Main's arm gives the same character counts for every press and the same three kinds of file.

### Armed confirmation (HEAD; main identical)

| Control | Resting | Armed (after one press) | After 4.5 s |
| --- | --- | --- | --- |
| `restart-same-seed` | Restart with Same Seed | **Restart, losing this round?** (`hud-danger--armed`) | Restart with Same Seed |
| `reroll-seed` | Reroll Seed | **Reroll, losing this round?** | Reroll Seed |
| `restart-round` | Restart Current Round | **Restart this round?** | Restart Current Round |
| Use Production Save | Use Production Save | Reload onto the REAL save? | Use Production Save |
| Reset Developer Data | Reset Developer Data | Erase all developer data? | Reset Developer Data |

- **Another control's arm disarms the first.** Restart with Same Seed was armed
  (`Restart, losing this round?`), then Reroll Seed was armed. That put the first back to
  `Restart with Same Seed` and armed the second (`Reroll, losing this round?`), which then lapsed
  to `Reroll Seed`.
- **The world was not rebuilt.** Copy read seed 918339200 before the arming and the same seed
  after it.
- **The actions show only once their catalogue has loaded and a round exists.** The three were
  `hidden` at the Main Menu before the open, even though the template already carries their text.
  They were shown in the round after the load.
- Page errors / failed requests: 0 / 0.

## Supplementary arms (HEAD only; they need the modules to be separate chunks)

These two arms go beyond the two the issue asks for. Each uses `page.route` on
`/assets/dev-(actions|diagnostics|exports)-*.js`.

**Arm 3: the load held back 2.5 s.** The script presses Start Campaign, opens the pane from the
DEV badge, and while the three chunks are held clicks Copy, Download Screenshot and Download
Diagnostics in one task (`element.click()` ×3). It clicks Download Diagnostics again once the load
has landed.

- **At the press:** the field was still hidden and empty, and the actions were hidden. No error
  was thrown.
- **When the load landed:** the probe's pass-through observer recorded Copy's `select()` on the
  317-character report, which was focused and wholly selected (ms 7152). The clipboard write made
  at that moment was **rejected** (`NotAllowedError ... Write permission denied`). The selection did
  not depend on it.
- **Press-time reads:** the screenshot pressed before the load saved
  `tanks-canvas-seed917752764-tick190-...png`. The diagnostics pressed in the same task saved
  `...tick190.json`. The diagnostics pressed after the load, 2,643 ms later, saved `...tick349.json`
  (159 ticks, which is 60 Hz). A frame or round read when the load landed would have carried a tick
  near 349, not 190.
- Page errors / failed requests: 0 / 0.

The field log does not show Copy's text, for a known reason: the Diagnostics export overwrote it in
the same task when the load landed. That is why the `select()` observer is the evidence for Copy.
(`superseded/requests-head-run1.log` is an earlier run of an earlier version of the script, in
which only Copy and Screenshot were held. In that run the field shows
`## Tanks! session diagnostics` at the instant the actions were revealed.)

**Arm 4: the three chunks aborted** (`internetdisconnected`).

- With no press, the open writes `The developer tools could not be loaded (Failed to fetch
  dynamically imported module: http://127.0.0.1:4396/assets/dev-exports-Cj0vU3wa.js). Reload the
  page to try again.` into the field.
- A Copy pressed afterwards writes the same kind of line, this time naming `dev-actions-...js`.
- The retry issued no new network request: each chunk was aborted once. This is consistent with
  Chromium keeping the failed module for the life of the page, which the "Reload" line anticipates.
- The actions stayed hidden.
- **Page errors: 0.** There was no unhandled rejection.

## Bytes (on-disk sizes, raw / gzip level 9 per file, summed)

`bytes-1014.mjs` produces these figures (`bytes.log`, `bytes.json`). gzip uses the same function
as `tools/bundle-budget/check.mjs`. The "shipped" sums match `bundle:budget` exactly on both trees.
Each row below is a separate population.

| Population | HEAD | main | Delta |
| --- | --- | --- | --- |
| Arm 1, ordinary URL, JS requested | 3 files, 1,164,306 / 325,509 | 1 file, 1,163,167 / 323,019 | **+2 files, +1,139 raw / +2,490 gzip** |
| Arm 2, `?dev=1`, JS requested in all | 6 files, 1,169,265 / 327,822 | 1 file, 1,163,167 / 323,019 | +5 files, +6,098 / +4,803 |
| Arm 2, requested on the menu open alone | 3 files, 4,959 / 2,313 | 0 | the three dev chunks |
| All JS shipped in `dist/assets` | 10 files, 1,205,541 / 338,860 | 5 files, 1,199,364 / 334,015 | +5 files, +6,177 / +4,845 |

The three dev chunks are 733 + 1,792 + 2,434 = 4,959 B raw. #946's per-file figures, which the
issue quoted, were 0.6 + 1.7 + 2.2 KB.

**The ordinary URL downloads more, not less.** The three modules are gone from it, but it now
fetches three files instead of one, and its total is 1,139 B raw and 2,490 B gzip LARGER than
main's. Rolldown split two shared chunks out of the entry, which `index.html` modulepreloads
(see below):

- `blocked-fire-C-xN3qqJ.js`, 292,446 B: the sim config modules, five presentation modules,
  `render/mine-warning.ts` and `three.core.js`.
- `world-BiB0Jzri.js`, 45,276 B: `sim/world.ts`, the sim's math, collision, rules and AI.

Main has neither chunk. `workbench-scene` also grew by 79 B (22,440 to 22,519). An earlier scratch
experiment in `../w1014/split-exp.sh` and `exp-*-only.log`, not run by me, reports this:

- `dev-actions` alone causes no split.
- `dev-diagnostics` alone splits out `blocked-fire`.
- `dev-exports` alone splits out a 337 KB `blocked-fire`.

I did not re-run that experiment.

## Chunk contents (sourcemap builds)

`chunk-sources-1014.mjs` reads each `.js.map`'s `sources` (`chunk-sources-head.log` / `.json`,
`chunk-sources-main.log` / `.json`). On both trees the sourcemap build has the same file names as
the shipped `dist`. Every `.js` file is byte-identical to its shipped counterpart once the trailing
`sourceMappingURL` comment is removed.

| Module | HEAD chunk | main chunk |
| --- | --- | --- |
| `src/game/dev-actions.ts` | `dev-actions-DvQIcs-d.js` (its only source) | `index-DCK_xJX1.js` |
| `src/game/dev-diagnostics.ts` | `dev-diagnostics-DCxABR2C.js` (its only source) | `index-DCK_xJX1.js` |
| `src/game/dev-exports.ts` | `dev-exports-Cj0vU3wa.js` (its only source) | `index-DCK_xJX1.js` |

- **What the ordinary URL fetches holds none of them.** On HEAD, none of `index-DKSkR52s.js`
  (126 sources), `blocked-fire-C-xN3qqJ.js` (22) or `world-BiB0Jzri.js` (27) contains any of the
  three modules.
- **How HEAD's entry refers to them.** `index-DKSkR52s.js` names the dev chunks only by file name,
  as dynamic-import targets: `dev-actions` once, `dev-diagnostics` twice, `dev-exports` twice.
- **What `index.html` loads.** HEAD's `dist/index.html` loads `index-DKSkR52s.js` as its script
  and modulepreloads `blocked-fire-C-xN3qqJ.js` and `world-BiB0Jzri.js`. Main's loads only
  `index-DCK_xJX1.js`.

## Screen gate

`screens-1014.sh` runs
`npm run screens:check -- --dist dist --out ../w1014/screens-check-out` against the `dist` that
HEAD's `verify:build` had just built (`screens-dist.txt`: `index-DKSkR52s.js`, 826,584 B, the
probed build). Output is in `screens-check.log`.

- `PASS screen.devtools`
- `PASS screen.devtools.actions`
- `PASS screen.devtools.diagnostics`
- The run reported `50 state(s) checked in 85.8s, 0 failing`, exit 0. Every other state, including
  `screen.devtools.controller-selftest`, also passed.

PASS means the measurements match the committed baselines; no baseline moved.

What was not checked here:

- **No negative control for the screen gate.** Showing that the new `.actions` waits matter would
  mean editing `tools/screens/states.mjs`, a tracked file. An earlier scratch log,
  `../w1014/screens-control.log`, which I did not produce or verify, records
  `screen.devtools.actions` passing locally with the three waits removed. If that holds, the local
  load is fast enough that the waits are not what makes the state pass.
- **The hit-target sweep never measures these states.** `tools/visual/hit-sweep.mjs:70` excludes
  every `screen.devtools*` state (`'a developer pane, reached only behind ?dev=1'`). So no
  hit-target path replays the `.actions` steps at all.

## Controls

- **The recorder records.** Every arm logs the entry chunk, and HEAD's arm 2 logs the three dev
  chunks at the open. Arm 1's empty dev list is therefore not a listener that never fired.
- **The probe detector finds the strings when they are shipped.** On main, all seven strings are
  found in the one file arm 1 downloads. On HEAD they are found only in the three dev chunks, which
  arm 2 requests.
- **Dev mode alone does not load the modules.** On HEAD's `?dev=1` arm, no dev chunk is requested
  at the Main Menu before the open.
- **The second arm reached the controls.** Each of the 10 presses changed the field from a
  sentinel to that control's own output. Every Copy and Pin press (four Copies, counting the
  same-task check and the one after arming, and two Pins) left its text focused and wholly
  selected. Three files were downloaded. Five danger controls showed their confirm labels and
  lapsed.
- **The behaviour matches main.** Main's arm 2 gives identical labels, confirm labels and
  per-press character counts.
- **The source detector works.** Each module is found in exactly one chunk's map on each tree:
  the dev chunk on HEAD, the entry on main.

## Files here

| File | What it is |
| --- | --- |
| `probe-requests-1014.mjs` | The probe script: two arms, plus two with `--supplementary` |
| `run-probes-1014.sh` | Runs the probe on HEAD and on main, then the byte tally |
| `requests-head.log`, `requests-head.json` | HEAD probe output, four arms |
| `requests-main.log`, `requests-main.json` | main probe output, two arms |
| `bytes-1014.mjs`, `bytes.log`, `bytes.json` | Byte populations, raw and gzip |
| `chunk-sources-1014.mjs`, `chunk-sources-{head,main}.{log,json}` | Sourcemap attribution |
| `probe-grep-1014.sh`, `probe-grep-1.txt` to `probe-grep-7.txt` | Where each probe string occurs |
| `verify-build-{head,main}.log`, `smap-build-{head,main}.log`, `build-steps.log` | Build output |
| `screens-1014.sh`, `screens-check.log`, `screens-dist.txt` | Screen gate |
| `head-sha.txt`, `main-sha.txt`, `status-*.txt`, `port-check.txt` | Provenance |
| `superseded/` | Earlier runs of earlier versions of the probe script. Kept for the Copy-at-landing field log; not the headline numbers |
| `../w1014/build-1014.sh` | The build script |
| `../w1014/downloads-*-final/` | The files the exports saved |
