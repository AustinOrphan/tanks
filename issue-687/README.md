# Issue #687: toasts and the capacity flash under the topbar

Each image shows a before and after pair, cropped to the top 200 CSS px of the page.

- **Builds:** before is `origin/main` at `86e3fa9`; after is branch `fix/topbar-clearance-for-overlays`.
- **Browser:** Chromium 151 (Playwright 1.62.0), rendering with swiftshader.
- **Top inset:** set with DevTools' `Emulation.setSafeAreaInsetsOverride`, because headless
  Chromium otherwise reports `env(safe-area-inset-top)` as 0.
- **Toast:** real. It is the M-key mute shortcut's "Muted" notice, pressed once per capture.
- **Capacity flash:** STAGED. Its text is set to `shells 5/5` and its animation is replaced by the
  12–65% hold state of `hud-capacity-flash` (opacity 1, no transform). The real cue lasts 0.9s and
  only fires on a refused shot.
- **DPR:** 2 for the phone sizes, 1 for 1280x800.

Values are CSS px from `getBoundingClientRect`, taken at the moment of each capture.

| capture | topbar bottom | toast top, before → after | flash top, before → after |
|---|---|---|---|
| 390x844, 59px inset, match | 89 | 64 → 101 | 56 → 93 |
| 844x390, 59px inset, match | 99 | 64 → 111 | 56 → 103 |
| 320x568, no inset, match | 33 | 64 → 45 | 56 → 37 |
| 1280x800, no inset, match | 52 | 64 → 64 | 56 → 56 |
| 390x844, 59px inset, Main Menu | hidden | 64 → 59 | not shown there |
| 1280x800, no inset, Main Menu | hidden | 64 → 14 | not shown there |

In the "before" column of both inset rows, the flash and the toast start inside the topbar.
In the 390x844 "before" frame, the flash text is drawn over "Lives" and "Level".
