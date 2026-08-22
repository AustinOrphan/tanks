---
name: visual-check
description: Run and interpret Tanks gallery, WebGL, browser-trace, and screenshot checks. Use for visible UI or rendering changes, visual evidence, gallery captures, cross-browser rendering validation, or failures in the visual CI job.
context: fork
background: false
---

# Check a visual change

Treat invocation arguments as the behavior, scene, viewport, or failing check to investigate.

## Workflow

1. Inspect the complete diff and name the visible behavior that must change and the nearby behavior that must not. Read the matching rendering, workflow, or testing rule and the relevant parts of the [command reference](../../../docs/agent/commands-and-operations.md) and [merge bar](../../../docs/agent/testing-and-review.md#merge-bar).
2. Choose the narrowest useful repository entry point:
   - `npm run gallery -- <arguments>` for an isolated element, deterministic moment, animation, or parameter sweep.
   - `npm run test:gl` for real-browser renderer construction and WebGL integration checks.
   - `npm run trace:browser -- --all` for browser-engine trace fingerprints.
   - `npm run verify:visual` for the final build, portability, GL, browser-trace, and screenshot gate.
3. Use the Playwright version and browser setup pinned in `.github/workflows/ci.yml`. Do not add or upgrade a project dependency merely to bypass a missing local prerequisite. Use FFmpeg only when the requested gallery output needs GIF or grid assembly.
4. For a user-visible change, capture before and after with the same command, scene, seed, viewport, device scale, and browser. Inspect the images themselves at normal scale; a zero exit code or generated file is not visual evidence.
5. Inspect `gallery-out/` for default gallery captures and `visual-out/<label>/` for visual screenshots plus `report.json`. Confirm page errors are absent, the intended checkout was served, and no blank, clipped, stale, or unrelated state was captured.
6. Diagnose the first failing composite step with its direct repository script, then rerun the composite. Renderer/WebGL infrastructure is high risk and also requires `npm run verify:full` from a clean candidate worktree.

## Stop conditions

- Stop if the browser, Playwright, FFmpeg-required output, or target device is unavailable; report the missing evidence rather than substituting unit tests.
- Stop if a stale server or wrong worktree is being served, a sweep target is dirty, the page reports errors, or the capture does not visibly reach the intended state.
- Stop on unexplained pixel or fingerprint drift. Do not approve a baseline update by appearance alone.

## Evidence

Report exact commands, browser/device/viewport/seed, before-and-after artifact paths, observed differences and expected absences, check totals, and any platform not reproduced. Keep generated evidence out of commits unless the issue explicitly requires tracked media.
