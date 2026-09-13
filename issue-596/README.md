# Issue #596 — the support verdict on the controller self-test

The visible half of the gamepad mapping/capability work. The classifier itself is pure and
lives in `src/input/gamepad-profile.ts`; this is the one surface that renders its verdict.

Both frames are the **built** page at 900x1200 @2dpr, captured through
`tools/screens/run.mjs` at `screen.devtools.controller-selftest` — the state that already
existed for issue #599, with its `mixed` gamepad fixture unchanged. That fixture poses two
pads on purpose, and they now answer differently:

| | Frame |
| --- | --- |
| Before (`origin/main`) | `selftest-before.png` |
| After | `selftest-after.png` |

| Pad in the fixture | Browser reports | New line on the row |
| --- | --- | --- |
| Index 0, Xbox Wireless Controller | `mapping: standard`, 4 axes, 17 buttons | `supported (standard mapping)` |
| Index 1, HuiJia USB GamePad | `mapping: (none reported)`, 6 axes, 12 buttons | `NOT supported: no profile matches this mapping/id` |

Before, the pane stated three facts about each device — mapping, axis count, button count —
and left the tester to work out whether Tanks had accepted it. That inference is the thing
the classifier removes, so the pane says it outright.

**Two pads, two different verdicts, in one picture.** A verdict line that was really a
constant would read correctly on either pad alone; it cannot read correctly on both.

The same sentence goes into the copied compatibility report, from the same
`describeSupport`, as `- Tanks support:` directly under each pad's `- mapping:` line — so a
report pasted into an issue carries the verdict and not just the numbers behind it.

## The layout cost, measured

From the two capture reports, same viewport:

| Element | Before | After |
| --- | --- | --- |
| `.hud-selftest-pad` height | 445 | 471 |
| `.hud-selftest-channel` (first) y | 316 | 342 |
| `.hud-selftest-copy` y | 1100 | 1152 |

One line per pad row (+26px), and the Copy Report button moves down by exactly twice that
(+52) because the fixture has two pads. Nothing else moved: the pane, the heading block and
the pad list all start at the same y.

`.hud-selftest-pad-support` carries its own rule in `hud.css` rather than inheriting a bare
`<p>`'s 16px default margin, and is listed in `hud.css.test.ts`'s presence guard. The
mutation entry `selftest-support-line-has-no-rule` is what proves that guard covers it —
it survived twice before it was killed, once because nothing swept for the class and once
because the guard's `toContain` matched a renamed selector that still contained the
original as a substring.
