# Screen-state capture

Boot the **built** page into a named application state and photograph it, deterministically
(issue #561).

```sh
npm run build
npm run screens -- --state screen.records.stats --out out/records.png --report out/records.json
```

Or through the capture framework, which is where it belongs for anything durable:

```sh
npm run capture -- --recipe screen.records.stats
```

Playwright is not a dependency of this repository — see [`tools/visual/README.md`](../visual/README.md)
for why, and for the `PLAYWRIGHT_MODULE` resolution order this shares.

## The gap it closes

Before this, no capture path in the repository could reach an application state:

- `tools/visual/` is pinned to the title screen with regression-specific pixel thresholds.
- `tools/gallery/` poses simulation and render subjects — elements, arenas, moments. It has
  no notion of a route, an overlay, or an error screen.

So every player-facing state that is not gameplay and not the title screen was
unphotographable, and each PR that changed one either shipped without visual evidence or
grew a throwaway Playwright script. **Four such scripts were written and discarded in a
single day's work.** This is the fifth, kept — and kept as the `screen` producer that
`tools/capture` has had a declared-but-unimplemented slot for since it was written, rather
than as a fifth standalone tool beside `visual/`, `uikit/` and `gallery/`.

## What a state owns

[`states.mjs`](states.mjs) is pure declarative data — no imports, so
`tools/capture/schema.mjs` can validate a recipe against its ID list without pulling
Playwright into a unit test. Each state carries:

| Field | What it is for |
| --- | --- |
| `storage` | The save a returning player would have, seeded before the page loads. |
| `webgl` | How the renderer probe answers: `ok`, `unsupported` (returns null), `probe-blocked` (throws). |
| `javascript` | `off` reaches the `<noscript>` card. |
| `steps` | Declarative `click` / `press` / `waitVisible` / `waitHidden` / `breakWebgl`. |
| `measure` | The elements whose box, text and key computed properties are recorded. |

A **screen recipe carries an empty `variant`.** Which screen it is lives in
`producer.scenarioId`; the state definition owns the seeding, the capability override and
the reach steps, because those are properties of the screen rather than of one capture of
it. That is why implementing this producer needed exactly one schema change — validating
`scenarioId` against the catalogue, the same rule `moment` already had.

## Failure screens are produced by failing, never by injecting markup

`screen.startup.unsupported-render` and `screen.startup.probe-blocked` patch
`HTMLCanvasElement.prototype.getContext` so the **real** probe in `render-capability.ts`
runs and takes its real branch: returning null is `no-webgl2`, throwing is `probe-failed`,
and those select two different branded screens with different advice. A capture that
injected the screen's markup would be evidence of nothing.

`screen.startup.match-failed` applies the same override **after** boot, so the probe has
already passed and the menu is up. That is a different screen from a boot failure and says
so — "That match could not start."

## Why every shot is also measured

A screenshot named `records.stats` proves the page did not crash and nothing else. Two
states that render identically produce two files a reviewer has to eyeball. So each capture
records the bounding box, trimmed text and watched computed properties of the elements the
state names, into `producer.json` beside the frame.

That half is deterministic in a way pixels are not, and it is the half that has caught
things: the campaign-complete screen's two tally lines sat 24px apart where 8px was
intended, and the *number* is what said so — the picture merely looked slightly loose.

Two assertions are reported to the capture framework, so a bad capture fails rather than
saving a picture of a broken screen:

- **no uncaught page errors** — the branded failure states *report* a failure, they do not
  suffer one;
- **every measured selector matched something** — not "was visible": several states exist
  precisely to show a control is absent (a fresh save hides Continue; the no-script style
  hides the holding card). A selector matching nothing means the state is measuring nothing.

## On demand, not a required check

**These are captured on demand and are deliberately not part of the required `visual`
check.** The argument, rather than the assumption:

- A **pixel** gate over text-heavy screens has a real flake cost — font rasterisation
  differs across CI images — and `visual` is already required. Feeding it flaky screens
  costs that gate its credibility, which is worth more than these screenshots.
- The two defects this style of capture has actually caught would **not** have been caught
  by a pixel baseline. The `<noscript>` overlap (PR #560) had no baseline to differ from,
  and the tally spacing was found by reading a measured box, not by diffing an image.
- The **measurement** half is deterministic and assertable, so it is the half worth gating
  — and choosing what to assert, with baselines, across responsive breakpoints is issue
  #326's scope, which this deliberately leaves open rather than pre-empting.

## Known gap

`STARTUP_FAILURES` has a fourth entry, `startup-failed` — the generic "something went wrong
before the game was ready" state — and **it has no recipe here.** Every lever that reaches
it from outside the page (a blocked storage, a throwing probe) is already caught and
classified as something more specific, which is the module working as designed. Reaching it
would need a deliberate failure seam in `boot.ts`, which is a production change and its own
decision. Stated here rather than left as a silently missing row.
