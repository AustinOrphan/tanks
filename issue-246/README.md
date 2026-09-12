# Issue #246 — the Developer Tools configuration menu

Captured with `npm run screens`, 1280x800 @2, against the built page. Issue #623 already
built the configuration MODEL -- the registry-derived control list, the six presets, the URL
builder and the explainer -- and this issue renders it.

| File | What it shows |
| --- | --- |
| `devtools-shell.png` | The developer shell, with the new Configuration entry beside Controller Self-Test. |
| `config-top.png` | The menu: six presets, then the registry group by group. Each row is the parameter, its current value, the registry's own description, and a button row. `level` carries a stepper, `Unset`, and `sandbox` as its own button. |
| `config-sandbox.png` | The Sandbox group, scrolled into view. The `tanks` multiset is a COUNT PER KIND; `disarmed` carries its `inverted-default` note; `walls` has `random:8` beside its stepper. |

## Two things the pictures are evidence for

**No text entry anywhere.** The issue rules out a general-purpose text-entry primitive, and a
menu that needs a keyboard is not operable by controller. Every one of the 35 registered
controls is buttons: a toggle, a row of selectable values, a stepper, or -- for the one
multiset -- a pair of arrows per kind. Asserted directly as well: the renderer's test sweeps
for `input, textarea, [contenteditable]` and requires zero.

**The Sandbox shot needed a new capture step.** The pane runs to about 4900px, so every
capture could previously only show the top -- evidence about a heading rather than about the
control someone asked to see. `{ scroll: { selector, to } }` scrolls a pane's own container
to bring a selector into view; it targets a SELECTOR rather than a pixel offset, because this
pane's height is a property of the flag registry and a pixel number would go stale the moment
a flag is added.
