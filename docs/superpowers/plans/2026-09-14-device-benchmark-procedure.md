---
status: active
date: 2026-09-14
last-reviewed: 2026-09-14
scope: The procedure the real-device benchmark run for #288 follows, from serving the build to a summary, and which results only a physical device can provide
implementation-issues: [721, 737]
supersedes: []
superseded-by: []
---

# Device benchmark procedure

This is the procedure for the physical-device run that issue #288 needs. Follow it from start to finish and you get benchmark reports you can compare, with no edits to the repository.

The run produces evidence. Choosing a frame-time budget or a default quality from that evidence is #288's decision, and this document does not make it.

## What this run is for, and what it cannot tell you

**What the repository already establishes without a device** (CI, `npm run test:gl`, and desktop tooling):

- **The workload and report exist.** The workload opens the session it names, and the report carries the facts two runs are compared on (#734).
- **Each sweep flag changes only its own renderer setting.** `tools/gl/harness.ts` checks this against a real renderer (#735).
- **The summarizer refuses reports it would misread.** `tools/bench/summary.test.ts` covers this.
- **The steps below produce a report the summarizer accepts.** A desktop run shows this end to end.

None of that is a phone frame time. A desktop or software-GL run uses a different processor, GPU, driver, browser and thermal envelope from a phone, so its milliseconds describe only the machine it ran on.

**What only a physical device run can provide:**

- the frame times a player on that device actually gets: p50, p95 and p99, and how often a frame runs long;
- how those frame times drift as the device warms over a sitting;
- how much each quality setting moves that device's frame times.

**What neither provides.** Numbers for any other device. Every figure and ratio from this run describes the device, browser and build it was taken on, and does not transfer to another phone.

## What you need

- **An Android phone** running Chrome. Record its model, Android version and Chrome version.
- **A desktop with Chrome** and a USB cable. You read the reports through Chrome's remote debugging, because the report lives in the page's console, not on screen.
- **USB debugging enabled on the phone.** Settings, About phone: tap Build number seven times. Then Developer options: turn on USB debugging.
- **A build to open**, from one of these two sources. Use the same build for every run in a sitting.
  - **The deployed site**, `https://austinorphan.com/tanks/`. Use it only once the benchmark and render-override flags (#734, #735) have been deployed from `main`. The deploy stamps the commit into every report.
  - **A local build served on your network**, from a checkout of the commit you want:

    ```sh
    VITE_BUILD_SHA=$(git rev-parse --short HEAD) npm run build
    npm run preview -- --host
    ```

    Then open `http://<the desktop's LAN address>:4173/` on the phone, on the same Wi-Fi network. Without `VITE_BUILD_SHA` the report's build reads as unknown, and the reports can no longer be traced to a commit.

In the URLs below, `<base>` is whichever of those two addresses you use.

## Device state

Keep all of this the same for the whole sitting, and write it down in a `notes.md` beside the reports:

- **Power.** Charging over the USB cable, or on battery: pick one and keep it. Record the battery percentage at the start and end of each round.
- **Screen.** Turn adaptive brightness off and fix the brightness (record the level). Set the screen timeout longer than two minutes, or turn on Developer options, Stay awake, if you are charging.
- **Battery saver and similar modes** off. Close other apps.
- **Orientation.** Hold one orientation for the whole sitting. The viewport is part of what makes runs comparable, and the summarizer refuses a set whose viewports differ.
- **A cool start.** Leave the phone idle, screen off, for ten minutes before the first run. Rest it for two minutes, screen off, between runs.
- **Keep the page in the foreground** for the whole run. Do not switch apps or let the screen sleep: a hidden page stops or throttles its frames.

## The gameplay runs

The `versus-bots` workload is a four-bot free-for-all on seed 7, with no human input. It warms up for 5 seconds and then measures for 60.

### One run

1. **On the phone, open the run's URL** (below) in a fresh page load. Do not reuse the page from the previous run.
2. **Tap the splash screen**, then tap **Start Campaign** on the Main Menu. The workload's flags make that button start the four-bot match.
3. **Do not touch the screen.** The bots play by themselves.
   - If the round ends inside the window, leave the results screen alone.
   - Its frames are still measured, so note in `notes.md` that the round ended during the run.
4. **On the desktop, open `chrome://inspect/#devices`**, find the page and click inspect. In its console, check `__tanks.bench().phase`, repeating until it reads `"done"` (about 65 seconds after Start Campaign).
5. **Copy the report**, then paste it into a new file named for the run (see Naming):

   ```js
   copy(JSON.stringify(__tanks.bench(), null, 2))
   ```

### The arms

Each arm below changes one thing. The baseline is the `high` preset.
- The six override arms each change one setting from `high`.
- The last two arms run the other presets whole, for context.

| # | Arm | URL |
| --- | --- | --- |
| 01 | baseline | `<base>?dev=1&bench=versus-bots&mode=ffa&players=4&bots=4&seed=7&quality=high` |
| 02 | shadow map 1024 | `<base>?dev=1&bench=versus-bots&mode=ffa&players=4&bots=4&seed=7&quality=high&shadowMapSize=1024` |
| 03 | shadow map 512 | `<base>?dev=1&bench=versus-bots&mode=ffa&players=4&bots=4&seed=7&quality=high&shadowMapSize=512` |
| 04 | antialiasing off | `<base>?dev=1&bench=versus-bots&mode=ffa&players=4&bots=4&seed=7&quality=high&antialias=off` |
| 05 | pixel ratio cap 1.5 | `<base>?dev=1&bench=versus-bots&mode=ffa&players=4&bots=4&seed=7&quality=high&pixelRatioCap=1.5` |
| 06 | pixel ratio cap 1 | `<base>?dev=1&bench=versus-bots&mode=ffa&players=4&bots=4&seed=7&quality=high&pixelRatioCap=1` |
| 07 | fill and rim lights off | `<base>?dev=1&bench=versus-bots&mode=ffa&players=4&bots=4&seed=7&quality=high&fillRimLights=off` |
| 08 | medium preset | `<base>?dev=1&bench=versus-bots&mode=ffa&players=4&bots=4&seed=7&quality=medium` |
| 09 | low preset | `<base>?dev=1&bench=versus-bots&mode=ffa&players=4&bots=4&seed=7&quality=low` |

Always pass `quality=` explicitly. Without it the session uses whatever quality is stored in the phone's Settings, which the URL does not show.

The report records what the renderer actually used. It gives the preset as `session.quality`, the overrides as `render.overrides`, and the pixel ratio as `render.effectivePixelRatio`. `docs/dev-flags.md` describes each flag.

### Order, count and naming

- **Order and count.** Run all nine arms in the order above, and call that one round. Do three rounds, for 27 runs. Allow roughly an hour and a half with the rests.
  - Every round starts with the baseline, so the baseline's spread across rounds shows how far the device drifted as it warmed.
- **Naming.** Name each file `r<round>-<arm #>-<arm>.json`, for example `r1-01-baseline.json` and `r2-05-pixel-ratio-cap-1.5.json`, all in one folder, say `reports/`. Sorted by name, round 1's baseline comes first, which is what the summarizer takes as its baseline.

## The Customize preview runs

The `preview` workload measures the Customize panel's tank preview. That preview builds its own renderer, which ignores the quality preset and every override, so it has no arms. Take it in the same sitting, after the gameplay rounds.

1. Open `<base>?dev=1&bench=preview` in a fresh page load.
2. Tap the splash screen, then tap **Customize** on the Main Menu, then tap the **Flow** skin. Flow is the one animated skin, so the preview keeps drawing for the whole window.
3. Do not touch the preview. It warms up for 2 seconds and measures for 20, and only frames drawn while it animates on a visible page are measured.
4. Read `__tanks.bench().phase` until it is `"done"`, then copy the report as above.

Do three runs, named `preview-1.json` to `preview-3.json`, in a separate folder, say `preview/`.

## Summarize

On the desktop, from the repository checkout:

```sh
npm run bench:summarize -- reports/*.json
npm run bench:summarize -- preview/*.json
```

- **The baseline is the first file named.** With the naming above, a sorted glob puts round 1's baseline first.
- **The summary has two tables.**
  - One row per arm: the median run's p50, p95 and p99, the range of the arm's p95, the share of frames longer than 16.7 and 33.3 ms, and the main-thread frame work.
  - One row per run.
- **Every ratio divides by the baseline arm** from the same set.

The summarizer refuses, and summarizes nothing, when:
- **A report does not match this summarizer.** Its schema version differs, its window had not closed when it was copied, it measured no frames, it is missing a field, or its URL is not the workload's plus the sweep flags. Take that run again.
- **The reports are not one sitting.** They differ in device, pixel ratio, viewport, build, workload, seed, mode or player counts. Split them into separate sets, one per sitting.
- **A file is named twice.**

## Hand-off to #288

Attach everything to a comment on #288:
- the report files;
- `notes.md`;
- both summaries.

State the device model, Android version and Chrome version in the comment. What budget or default follows from the numbers is decided there.
