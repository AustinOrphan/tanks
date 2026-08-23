---
status: active
date: 2026-08-23
last-reviewed: 2026-08-23
scope: Customize preview residuals, deferred while shipping the live tank preview
implementation-issues: []
implementation-prs: []
supersedes: []
superseded-by: []
---
# Customize preview residuals, deferred while shipping the live tank preview

**Raised 2026-08-09**, shipping PR #102 (`src/render/preview.ts`, a second WebGL
context for the Customize panel's live tank preview).

**1. `webglcontextlost` is unhandled, for either renderer, and low-end eviction is
unmeasured.** The preview's peak-2-contexts design is checked against a typical
browser's commonly-cited cap (8-16) and against one real Chromium run holding both
contexts at once — not against actual eviction on constrained hardware, and not
against how the MAIN game renderer would behave if the browser ever reclaimed its
context while the preview also held one. Neither `render/renderer.ts` nor
`render/preview.ts` listens for the event. Needs a measurement (a real low-end
device, or a forced context loss in a browser) before anyone could write the fix
with confidence, which is why this is recorded rather than left as an unstated gap.

**2. Preview camera/light-rig constants were chosen by eye, not measured.**
`PREVIEW_AREA_W`/`PREVIEW_AREA_H`, the camera FOV, and the key/fill/ambient light
positions in `preview.ts` were tuned against one screenshot, in the spirit of this
repo's other "feel, not measurement" constants (see CLAUDE.md) — but unlike those,
nothing here says so at the constant's own definition. Cheap to retune; nobody has
compared candidates with `npm run gallery --sweep`.

**3. No `npm run gallery` element for the preview.** Every other rendered element
(tank, mine, shell) has a gallery entry for eyeballing changes without booting the
full game; the preview does not, so verifying a future retune still means opening
the real Customize panel by hand or re-running the GL harness.

---

**4. The preview's lens and the arena's are deliberately different, and neither is
pinned.** `preview.ts`'s `FOV` is 50 while `scene.ts`'s `BASE_FOV` is 30 -- a close-up
at 30 would push the camera far enough out to read flat. But the two were never
rendered side by side, and mutating `FOV` 50 -> 30 leaves both gates green (1563 tests,
39 GL checks), so nothing would catch a change either way. The previous comment claimed
the two matched and went stale silently when #103 moved `BASE_FOV`; review caught it,
and the comment now asserts no relationship rather than a false one. Needs eyes, not a
test. #102

---

**Raised while making the preview interactive** (`src/render/preview-controls.ts`, the
hull turntable and the turret aim).

**5. The preview's indefinite render loop, and its COST, still unmeasured — and it now
runs for TWO reasons.** Its behaviour is gated: five async checks in `tools/gl/harness.ts`
run on the real `requestAnimationFrame` and measure that the idle spin turns the tank
(23069 of 197600 bytes in 500ms), that a hover stops the spin permanently for a
non-animated skin, that an animated skin keeps repainting afterwards (23584 of 197600
bytes in 500ms) and comes to rest when a static one is picked, and that nothing repaints
after dispose. What none of them says is what it costs: while the Customize panel is open,
a second WebGL context repaints a 260x190 canvas every frame, indefinitely, with no
timeout and no `document.hidden` check. Nobody has measured that against battery or
against a low-end device, and "stop after N seconds" was considered and not done because
the stopping condition would then be invisible to the player.

The animated skin was hung on this SAME loop rather than given a second one, precisely
because this entry is still open: a second indefinite repaint would double a cost nobody
has a figure for. That is a reason to prefer one loop, **not** evidence that one is cheap.
What did change is the floor — an untouched panel showing a static skin now stops
repainting entirely once the spin ends, where before the spin was the only loop and the
same was true; the new case is `flow`, which repaints for as long as the panel is open.
(This entry replaces an earlier one saying the spin ran under no gate at all; that was
true when it was written.)

**6. `prefers-reduced-motion` is read in `preview.ts` and nothing covers that read.**
`createPreviewControls` takes the flag as a parameter and both branches are tested; the
`window.matchMedia` call that supplies it lives inside `createTankPreview`, which returns
null under jsdom, so no test reaches it. The optional-chaining fallback for an absent
`matchMedia` is likewise unexercised.

**7. Pointer capture is unverified.** `setPointerCapture` is what keeps a drag alive once
it leaves the 260px canvas, and neither gate can see it: jsdom does not implement capture
semantics (the call is inside a try/catch for exactly that reason), and the GL harness
dispatches events directly at the canvas, which needs no capture. "A drag that runs off
the preview keeps turning the hull" is therefore claimed by construction, not measured.
The `groundPointFromPointer` null-on-miss path exists for that case and IS tested.

**8. Four more feel constants, two of them partly pinned and two not at all.** An
earlier draft of this entry called all four unpinned; review disproved it, and the
corrected version is below. Each is swept against `preview-controls.test.ts` AND
`preview.test.ts` — the first draft ran only the former, which is how it got the answer
wrong, and is a reminder that a mutation sweep's denominator includes the files it was
pointed at.

- `HULL_DRAG_RAD_PER_PX` (0.012) — **bounded on both sides**, by the scene-graph
  turntable check in `preview.test.ts`: a 100px drag has to leave the hull's near face
  at `x > 0.2` and `z > 0`, which is true only for roughly 0.0021 to 0.0157 rad/px.
  0.0005 and 0.018 both fail. Inside that band it is free.
- `TURRET_AIM_DEAD_RADIUS` (0.12) — **pinned against zero only.** Setting it to 0 kills
  2 cases; 0.36 survives, because the sweep test derives the boundary from the constant.
  What is pinned is that a dead zone exists, not how big it is.
- `IDLE_SPIN_RAD_PER_SEC` (0.35) — **unpinned.** x10 survives both files.
- `KEY_STEP_RAD` (pi/24) — **unpinned.** x12 survives both files.

Nothing in the tree records anyone having used the panel on a phone, and the drag rate is
the one most likely to be wrong there. The game HAS been played — that is not the gap. The
gap is that no judgement on these four constants has been stated on any device, and
`HULL_DRAG_RAD_PER_PX` in particular is a touch constant whose only evidence is a mouse.

**9. Most of `tools/` is not typechecked by anything; `tools/mutate/` now is.**
`tsconfig.json`'s `include` was `["src", "vite.config.ts"]`, so `npm test`'s
`tsc --noEmit` never read `tools/gl/harness.ts`, `tools/gallery/`, `tools/baseline/`,
`tools/mutate/` or the rest — and vitest transforms without typechecking. This is not
new, but it was found the hard way while adding the async GL checks above: a duplicate
`checkAsync` declaration passed `npm test` cleanly and surfaced only as a vite 500 when
the harness was actually loaded, which `npm run test:gl` reports as a bare timeout with
no error text. So the GL harness is checked only by running it, and a typo there costs a
30-second timeout to diagnose. Widening `include` for the tree at large was not attempted
here and may surface pre-existing errors. Issue #134 narrowed this for one directory:
extracting `tools/mutate/` into its own workspace package added
`tools/mutate/orchestrate.test.ts` to `include` with `allowJs`/`checkJs` on, which pulls
its three `.mjs` files (`lib.mjs`, `orchestrate.mjs`, `run.mjs`) into the same `tsc
--noEmit` transitively through the imports that test file already makes. `tools/gl/`,
`tools/gallery/`, `tools/baseline/` and the rest are exactly as untypechecked as this
item originally described.

---
