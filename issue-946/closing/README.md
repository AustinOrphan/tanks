# #946 closing check (2026-10-22, `main` at 1c3a193e)

Scripts behind the closing-check comment on #946 for criteria 2 to 5, beside `../probe.mjs` and
`../analyze.mjs` (criterion 1, reused unchanged).

| script | criterion | what it does |
| --- | --- | --- |
| `devtools-journey.mjs` | 2 | drives `?dev=1&ref=keep` through 25 steps (open each surface, press a diagnostics, export and action control, exit), recording every request, failed request and page error; modes `root <dist>`, `pages <dist>`, `remote <url>` |
| `ordinary-bytes.mjs` | 3 | sums raw and zlib-9 gzip bytes of what an ordinary URL fetches, from a probe's request list |
| `gallery-stability.mjs` | 4 | captures the five moment recipes twice per tree through each tree's own `tools/gallery/run.mjs` and compares frames by SHA-256 |
| `criterion5.mjs` | 5 | the ruled readings on an ordinary URL against `?dev=1`: display and Tab reach of the entry, badge and shell; the two containers' children and markup; `window`'s own property names |
| `pages-control.mjs` | 2, #251 | negative control for the Pages-shaped serve: a chunk resolves under `/tanks/` and 404s at the origin root, so a chunk URL that escaped the prefix would show |
| `live-probe-strings.mjs` | 1 | checks the probe strings against the files the deployed site served |

The scripts carry absolute paths from the machine that ran them (`REPO`, `A`, `T` constants at
the top). Point those at a checkout and a scratch directory before running. Playwright 1.62.0 and
Chromium are required.
