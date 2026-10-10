# #1013 two-arm request-list probe

Candidate evidence, measured locally. CI is authoritative.

- Branch `refactor/selftest-loaded-on-open`, HEAD `26d718eb30fff8bb81bd9335b39e35c7b8bff5ff`, clean
  tree before and after. No tracked file was modified and nothing was committed or pushed.
- `npm run verify:build` passed (exit 0, `verify-build.log`): build, `portability`
  (`subpath-portable: dist/index.html + 5 bundle(s) + the PWA shell checked`), and `bundle:budget`
  (`js 1,198,119 B raw (92.0% of budget), 333,625 B gzip (92.4%)`, within budget).
- Chromium 151.0.7922.34 (Playwright 1.62.0), headless.

## Method

This is the method recorded for #1012 (memory note `two-arm-request-probe`). Script:
`probe-requests-1013.mjs`.

- `dist` served by `node_modules/.bin/vite preview --port 4396 --strictPort --host 127.0.0.1`,
  spawned directly rather than through npx. Port 4396 had no listener before the run or after it.
- Chromium args `--use-gl=swiftshader --enable-unsafe-swiftshader --disable-gpu-sandbox`.
- A fresh browser context for each arm, with `audioContextOverrideSource()` from
  `tools/shared/audio-context.mjs` installed as an init script.
- `page.on('request')` records every request whose path ends in `.js`.
- The splash is dismissed with keyboard `Space`, then the script waits for
  `.hud-splash--hidden`.
- Arm 2 drives the steps of the `screen.devtools.controller-selftest` screen state through the
  repository's own `runStep` (`tools/screens/steps.mjs`): `{ fakeGamepads: 'mixed' }`, a click
  on `.hud-devtools-open`, a visibility wait on `.hud-devtools`, a click on `.hud-selftest-open`,
  a visibility wait on `.hud-selftest`, then a visibility wait on `.hud-selftest-pad`. Each click
  is a real pointer click on the visible button.

Run (log written to a file, not piped through tail):

```sh
node probe-requests-1013.mjs <worktree> requests.json selftest-pane-dev.png > requests.log 2>&1
```

## Arm 1: ordinary URL (`http://127.0.0.1:4396/`)

| Observation | Result |
| --- | --- |
| Request for `controller-selftest-*.js` | **none** |
| `.hud-selftest-list` exists | yes |
| `.hud-selftest-list` child elements | **0** (and 0 child nodes) |
| Built-body nodes (`.hud-selftest-empty`, `.hud-selftest-pads`, `.hud-selftest-pad`) | 0 |
| Self-test pane | hidden |
| Developer Tools entry rendered | no |
| Main Menu shown | yes |
| Page errors / failed requests | 0 / 0 |

JS requested: `index-D40VqqRp.js` at 1,161,922 B. That is 1 file and **1,161,922 B**.

## Arm 2: `?dev=1`, Controller Self-Test opened through the real UI (positive control)

| Point in the run | `controller-selftest` chunk requested? | `.hud-selftest-list` child elements |
| --- | --- | --- |
| Developer Tools open, before Self-Test opens (1.5 s settle) | **no** (only `index-D40VqqRp.js`) | 0 |
| After clicking Controller Self-Test | **yes**: `controller-selftest-B62NS0iL.js` (2,822 B), the only request made on open | 2 |

The positive control was reached: `.hud-selftest-pad` became visible.

- The two list children are `hud-selftest-empty hud-selftest-empty--hidden` and
  `hud-selftest-pads`.
- 2 pad rows: `Index 0 — Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 02fd)`
  and `Index 1 — HuiJia  USB GamePad`.
- 39 channel rows, 2 of them in the held state (button 7 on pad 0 and button 3 on pad 1, the
  `mixed` fixture). Axis values read 0.62 / -0.41 on pad 0 and 0.05 / -0.98 / 1.00 / -1.00 on
  pad 1.
- No `.hud-selftest-failed` line.
- Copy: the report field is shown and focused and holds 1,307 characters. It begins
  `## Controller compatibility report` and says `Pads visible: 2`.
- Page errors / failed requests: 0 / 0.

JS requested: `index-D40VqqRp.js` (1,161,922 B) and `controller-selftest-B62NS0iL.js` (2,822 B).
That is 2 files and **1,164,744 B**.

`selftest-pane-dev.png` is a supplementary still of the open pane. The pane scrolls, so the still
is cropped to the 1280x900 viewport and shows pad 0 in full and the top of pad 1. No screenshot
from before the change was taken for comparison.

## Bytes (on-disk sizes in `dist/assets`)

These are three separate populations.

| Population | Files | Bytes |
| --- | --- | --- |
| Arm 1, ordinary URL, JS requested | 1 | 1,161,922 |
| Arm 2, `?dev=1` with the self-test opened, JS requested | 2 | 1,164,744 (+2,822, the self-test chunk) |
| All JS shipped in `dist/assets` | 5 | 1,198,119 |

Shipped JS files: `index-D40VqqRp.js` 1,161,922, `workbench-scene-CDGIGQX9.js` 22,440,
`gallery-workbench-5Nf6WS0g.js` 8,248, `controller-selftest-B62NS0iL.js` 2,822, and
`gallery-selection-DqJLKZTq.js` 2,687. Their sum, 1,198,119, equals `bundle:budget`'s raw JS
figure.

No probe was run against `main` here, so this README gives no before/after byte delta. The issue
cites #946's per-file figure of 2.7 KB for the module and did not re-measure it.

## Chunk contents (sourcemap build)

`npx vite build --sourcemap --outDir /Users/austinorphan/.claude/jobs/8fe9c2c6/tmp/w1013/smap
--emptyOutDir` exited 0 (`smap-build.log`). `chunk-sources-1013.mjs` reads each `.js.map`'s
`sources` and resolves them relative to the worktree (`chunk-sources.log`,
`chunk-sources.json`).

The sourcemap build is the same build as the shipped one. It has the same five file names, and
each of its `.js` files is byte-identical to the shipped `dist` file once the trailing
`sourceMappingURL` comment is removed.

| Chunk | Sources | Contains `src/game/controller-selftest.ts` |
| --- | --- | --- |
| `controller-selftest-B62NS0iL.js` | `src/game/controller-selftest.ts` (1) | **yes** |
| `index-D40VqqRp.js` (entry; the only file arm 1 requested) | 174 (171 under `src/`, plus `three.core.js`, `three.module.js`, `howler.js`) | **no** |
| `gallery-workbench-5Nf6WS0g.js` | `src/game/gallery-command.ts`, `src/game/gallery-workbench.ts` | no |
| `gallery-selection-DqJLKZTq.js` | `src/game/gallery-selection.ts` | no |
| `workbench-scene-CDGIGQX9.js` | 4 under `src/render/gallery/` | no |

The entry chunk names `controller-selftest-B62NS0iL.js` exactly once, as the target of the
dynamic import. It contains no source from that module.

## Controls

- **The recorder records.** Both arms log `index-D40VqqRp.js`, and arm 2 logs the self-test chunk.
  Arm 1's empty result is therefore not a listener that never fired.
- **The chunk-name match finds the chunk.** The same `controller-selftest-*.js` pattern that
  finds nothing in arm 1 matches in arm 2 after the pane opens.
- **Dev mode alone does not pull the chunk in.** In arm 2 the chunk is absent while Developer
  Tools is open and appears only after the Controller Self-Test click.
- **The child count is not vacuous.** In arm 1 `.hud-selftest-list` exists and reads 0. In arm 2
  the same selector reads 0 before the pane opens and 2 after it.
- **The source detector works.** `controller-selftest.ts` is found in the self-test chunk's map
  and in no other chunk's map.

## Files here

- `probe-requests-1013.mjs`: the two-arm probe.
- `requests.log`, `requests.json`: the probe's output.
- `selftest-pane-dev.png`: a still of the arm 2 pane.
- `chunk-sources-1013.mjs`: reads the sourcemap `sources`.
- `chunk-sources.log`, `chunk-sources.json`: its output.
- `verify-build.log`: the `npm run verify:build` output.
- `smap-build.log`: the sourcemap build output.
