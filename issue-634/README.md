# Issue #634 — the versus role button had no size

Both frames are the built page at 1280x800 @2dpr through `tools/screens/run.mjs`, state
`screen.versus-setup`, with only `hud.ts`'s class list differing.

| | Frame | `.hud-versus-role-btn` box |
| --- | --- | --- |
| Before | `before.png` | **61 x 21** |
| After | `after.png` | **77 x 31** |

The box is recorded by the capture itself: `.hud-versus-role-btn` was added to that state's
`measure` list here, so the number travels with the picture rather than being read off it.

`.ui-btn` is deliberately sizeless — size comes from a `--slab`/`--sm` modifier — and the
per-slot Human/Bot/Off buttons carried the primitive with neither a modifier nor a rule of
their own, so they rendered at zero padding beside team and difficulty buttons that are
`--sm`.

**The fix is the missing modifier, not a new rule.** The issue's title asks for a style rule,
but its two siblings in the same row have no rule of their own either; they are `--sm`. A
bespoke rule duplicating that padding would have made one of three siblings sized by a
different mechanism.

31px is its siblings' height, not the 44px touch-target floor (`--hud-control-min`). Touch
minimums are #633's, and this change does not claim them.
