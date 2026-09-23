---
status: active
date: 2026-09-23
scope: The manual accessibility review sitting for PP1 - which surfaces to visit per area, how to reach each, what counts as a pass, and where verdicts are recorded
implementation-issues: [935]
supersedes: []
superseded-by: []
---

# Manual accessibility review protocol

`2026-08-23-ui-ux-direction.md` criterion 6 asks for a manual accessibility review. It names
an evidence matrix but no protocol, so the sitting has had no defined shape and no way to
record its outcome. This is that shape.

Six areas, one protocol each. A reviewer doing the TV pass reads part 6 and nothing else.

**The scarce resource here is human attention, so the first section is what NOT to check.**
Everything a required check already proves is subtracted before an area asks for anything.

## 1. What CI already proves — do not re-check these

Verified against `main` at `6457184`. Each row names the gate that would fail, so a reviewer
who doubts a row can run it rather than re-inspect by eye.

| Already proven | By | Over |
| --- | --- | --- |
| Every menu control is at least 44 CSS px across and down | `tools/visual/hit-targets.mjs`, `HIT_FLOOR` | every swept surface x 4 viewports |
| No two controls on one layer overlap | same | same |
| Every control can be scrolled to | same | same |
| No container scrolls sideways, and no page scrolls horizontally | same | same |
| Every swept surface actually opened | same — a state that never reached its surface fails | same |
| The toast rail clears the topbar's rendered bottom edge | `tools/visual/clearance.mjs` | 5 viewports x inset and no-inset |
| The shell-capacity flash overlaps no chip and no board, and stays inside the safe area | same | same |
| Topbar chips do not move when the flash appears | same | same |
| A screen's boxes and computed styles match a committed baseline | `tools/screens/check.mjs` | every state the screen gate captures |
| A captured screen raises no uncaught page error | same — page errors fail on their own, outside the measurement hash | same |
| The board paints, is not a flat fill, and fills its viewport | `tools/visual/verify.mjs` | 4 viewports |

The sweep's four viewports are 320x568, 390x844, 1280x800 and 1280x800 at 200% zoom. On
`main` it covers 32 surfaces; #956 takes it to 34 by adding the two branded startup-failure
pages.

### What no gate proves — this is where the sitting earns its keep

| Not proven | Why not | Measured stand-in, if any |
| --- | --- | --- |
| Text contrast | Nothing in the repository computes a luminance ratio; `colour-distance.ts` is a perceptual distance for camouflage | 30 of 735 visible text runs below their WCAG floor, in 3 class signatures ([#633](https://github.com/AustinOrphan/tanks/issues/633)) |
| Response to a browser font-size preference | No gate changes the root font size | 502 of 735 runs (68.3%) do not move when the root doubles ([#633](https://github.com/AustinOrphan/tanks/issues/633)) |
| The 56 px driving-control floor | No catalogue state shows the driving controls; the menu sweep skips `.hud-touch` by rule | measured at 56x56 / 66.2x56 / 69.5x56 at three viewports ([#957](https://github.com/AustinOrphan/tanks/issues/957)) |
| Type size and control size at TV distance | Nothing measures either. A required check does drive a `1920x1080-tv` layout at DPR 2, but only for topbar clearance, and `tools/screens/sweep-plan.mjs` has a 2560x1440 layout that is explicitly **not a gate** and commits no baseline | none |
| Thumb reach on a real device | A viewport is not a hand | none |
| Rendered pixels against a reference image | No gate in this repository compares pixels to a committed image | none |
| Forced-colors and OS high-contrast modes | Not driven by any required check | none |
| Screen-reader output | Not driven at all | none |

A reviewer who finds something in the left column has found something no machine here can.
A reviewer who re-measures something in the first table has spent the sitting's budget on a
question already answered.

## 2. How to reach any screen

There is exactly one catalogue of screens, `tools/screens/states.mjs`, with 49 states. **Do
not invent a second way to reach a screen.** Each state is reached by at most three things:

1. **A URL query** — the flags in `docs/dev-flags.md`, all of them gated behind `dev=1`.
2. **Seeded storage** — keys written before the page loads. A developer session namespaces
   them under `tanks.dev.` unless `prodSave=1` is set.
3. **Steps** — clicks and key presses, listed per state.

For a manual sitting the practical route is `npm run dev`, then the state's query, then its
steps. Where a state seeds storage, the fastest equivalent is to play far enough to produce
it once, or to paste the seed with `saveIo`'s import on the dev console object.

Reach recipes, by area of the product:

| Surface group | States |
| --- | --- |
| Boot and entry | `screen.boot-loading`, `screen.launch`, `screen.startup.entry-refused`, `screen.startup.entry-unparseable`, `screen.no-script` |
| Startup failures | `screen.startup.unsupported-render`, `screen.startup.probe-blocked`, `screen.startup.match-failed` |
| Menus | `screen.main-menu`, `screen.main-menu.fresh`, `screen.levels`, `screen.about`, `screen.about.document`, `screen.confirm.new-campaign` |
| Settings and controls | `screen.settings`, `.touch`, `.focused`, `.pressed`, `.rumble-refused`, `.controller-layout`, `screen.controllers`, `screen.controllers.pads` |
| Customize and records | `screen.customize`, `screen.records.stats`, `screen.records.stats.empty`, `screen.records.achievements` |
| Versus setup | `screen.versus-setup`, `.selected`, `.teams`, `.map-replaced` |
| In play | `screen.practice`, `screen.pause.campaign`, `screen.pause.versus` |
| Endings | `screen.ending.mission-clear`, `.campaign-over`, `.campaign-complete`, `.practice-cleared`, `.practice-failed`, and the four `.played` variants |
| Developer Tools | the seven `screen.devtools.*` states, all behind `?dev=1` |

Endings are reached with `?dev=1&outcome=<name>`; the `.played` variants add
`replay=1&autoplay=1&seed=7` and play the round. `screen.settings.touch` needs a touchscreen
profile, which on a desktop browser means device emulation.

## 3. Pass targets

From `2026-08-23-ui-ux-direction.md` sections 6 and 7. A number here is a target, not a gate;
record a miss as a verdict rather than treating it as a build failure.

| What | Target |
| --- | --- |
| Control height | 48 px preferred, **44 px absolute minimum**, 56-64 px on TV |
| Body type | 16-20 px effective, line height 1.4-1.55 |
| Meta and help text | 14-16 px; never below legibility for essential validation |
| Screen title | 28-40 px responsive; Launch/display title 48-80 px |
| HUD type | about 16 px phone, 20 px desktop, **22-26 px TV** |
| Panel width | about 520 px standard, about 1040 px wide setup |
| Panel padding | 16-24 px phone, 24-32 px desktop and TV |
| Focus ring | 2-3 px high-contrast outer ring with offset, **never colour alone** |
| Motion | 120-180 ms UI transitions; no animation may delay input or navigation |
| TV margins | 5% safe margins |
| Contrast | WCAG 2.2: 4.5:1 body text, 3:1 large text (>=24 px, or >=18.66 px bold) |

## 4. The six area protocols

Each part lists its surfaces, what to do, and what counts as a pass. Record every verdict in
the table in part 5.

### 4.1 Zoom and narrow viewports

**Surfaces:** every menu group in part 2, plus Pause.

**Do:** at 320x568 and at 200% browser zoom on a 1280x800 window, open each surface and try
to reach every control and every piece of text with one axis of scrolling.

**Pass:** nothing is cut off that cannot be scrolled to; no surface needs both axes; titles
and body text stay inside their targets in part 3.

**Subtracted:** control size, overlap, reachability and horizontal overflow are gated at
exactly these two viewports. Do not re-measure them. What is left is judgement — whether a
surface that technically fits is still *usable*, and whether text that technically scrolls is
still *findable*.

### 4.2 Safe area and notch

**Surfaces:** the topbar, the toast rail, the shell-capacity flash, the touch controls, the
versus action bar, and every full-screen pane.

**Do:** a device or emulation with a top notch in portrait and a side notch in landscape.

**Pass:** nothing the player must read or press sits under the housing.

**Subtracted:** the toast rail and the capacity flash are gated against insets at five
viewports. **Not subtracted, and the known gap:** no full-screen pane applies a safe-area
inset to its own padding. Check the panes specifically.

### 4.3 Reduced motion

**Surfaces:** menu transitions, the splash, the capacity flash, endings, and the life/stock
cue.

**Do:** enable the OS reduced-motion setting, then repeat with the in-game Motion preference
set the other way, so both inputs are exercised.

**Pass:** nothing moves that was asked not to move; every cue that carried meaning through
motion still carries it through shape, position or text; no transition delays a press.

### 4.4 Physical phone

**Surfaces:** a live round, Pause, and the versus setup pane.

**Do:** on a real handset, held one-handed and then two-handed. Play a round.

**Pass:** Pause, Fire and Mine are reachable by thumb without re-gripping; the arena and the
control zone stay separate; no control needs a hover; a press registers where it looks.

**Subtracted:** the 44 px menu floor is gated. **Not subtracted:** the driving controls
themselves are not in any gate (#957) — they measure 56 px today, so the question here is
reach and feel, not size.

### 4.5 Controller-only

**Surfaces:** every menu group, Pause, and a full campaign entry from the splash.

**Do:** a pad and nothing else. No pointer, no keyboard, from page load.

**Pass:** the splash can be dismissed by the pad; focus is always visible and always somewhere
sensible; Confirm, Back and Pause do what their prompts say; no surface can only be left with
a pointer; a disconnect is announced with a way forward.

**Expected, not a defect:** the session is **silent** until the first pointer or key, because
audio unlocks on that gesture and the engine self-heals afterwards (issue #494). Do not file
it.

### 4.6 Couch-distance TV

**Surfaces:** the HUD in a live round, the Main Menu, versus setup, and one ending.

**Do:** a TV at normal seating distance, driven by a pad.

**Pass:** HUD type reads at 22-26 px equivalent; controls are 56-64 px; content clears a 5%
safe margin on every edge; prompts are short enough to read at distance; nothing depends on a
pointer.

**Subtracted:** topbar clearance only — `tools/visual/verify.mjs` drives a `1920x1080-tv`
layout at DPR 2 as a TV stand-in, with and without side insets, so the toast rail and the
capacity flash are already held clear there. Nothing else is. `tools/screens/sweep-plan.mjs`
has a 2560x1440 layout, but that file is explicitly not a gate and commits no baseline, and
neither it nor `verify.mjs` reads a type size. **Type and control sizing at distance rests
entirely on this part**, and a screenshot cannot stand in for it.

## 5. Recording a sitting

One row per surface visited, per area. Copy this table into the sitting's issue or PR.

| Area | Surface | Device / viewport | Verdict | Note |
| --- | --- | --- | --- | --- |
| 4.1 Zoom | | | pass / fail / n/a | |

`n/a` needs a reason. A **documented manual exception** is a fail the project accepts on
purpose: record it as `fail` with the reason and a link to the issue or ruling that accepts
it, never as a pass. A verdict with no note is only meaningful when it is a clean pass.

A sitting is complete when every area has at least one row and every `fail` has either a
filed issue or a linked exception.

## 6. What this protocol deliberately leaves out

- **Pixel comparison against reference images.** No gate here does it, and a human eye is a
  worse instrument for it than the box-and-style baselines already in place.
- **Re-measuring anything in part 1.** If a reviewer suspects one of those rows is wrong, the
  right move is to break the gate deliberately and watch it fail, not to measure by hand.
- **Sign-off.** The parent, #327, keeps the roll-up and the final decision. This document
  produces the evidence that decision reads.
