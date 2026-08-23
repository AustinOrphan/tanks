---
status: active
date: 2026-08-23
last-reviewed: 2026-08-23
scope: Spike -- console release (Steam, Switch, PlayStation)
implementation-issues: []
implementation-prs: []
supersedes: []
superseded-by: []
---
# Spike: console release (Steam, Switch, PlayStation)

**Raised 2026-08-10**, from the same investigation.
**Document: `docs/research/console-release.md`.**

**The question:** is any console or storefront release worth pursuing, and does it start with
content or with platform work?

**Why it is live now.** Three findings do not point the same way, and averaging them would
be wrong.

1. **Steam is unblocked but not close.** The gaps are concrete: zero gamepad code anywhere
   (`grep -rni gamepad` returns 3 doc hits, all "out of scope", and 0 under `src/`), five
   localStorage keys that Steam Auto-Cloud cannot see, 14 achievements with no external
   write path, no packaging target, and no LICENSE file.
2. **Steam Deck / Machine Verified is UNKNOWN, not a fail.** The criterion binds the default
   *controller configuration*, authored on the partner site — Valve's own recommendations
   page tells developers without native controller support to map one to keyboard/mouse. The
   real question is narrower: this game aims at a mouse POSITION, and nobody has tested
   whether a mouse-region binding plays acceptably.
3. **Switch and PlayStation are gated on approved developer status under NDA**, and no
   publicly documented licensed runtime was found that runs a TypeScript + three.js WebGL
   bundle on either. CrossCode's team AOT-compiled their JS to C++ to reach 60fps on Switch —
   a compiler project, not a port.

**What would answer it:**

- **Author a Steam Input default configuration and play it on a Deck.** That is the whole
  Verified input question, and it is cheap relative to writing a gamepad reader.
- **Does `dist/` render correctly and fast under WebKitGTK** (what Tauri would use on
  Linux/Deck), or does it require Electron's bundled Chromium? One measurement decides the
  whole shell architecture — install size, overlay behaviour, everything.
- **Do any `hud.css` em-relative font sizes compute below 9px at 1280x800?** The fixed-px
  declarations run 12px–72px and are fine; the `0.72em`/`0.85em`/`0.75em` rules are the only
  ones whose computed height cannot be read off the rule, and they were never checked.
- **Author arena-05 and time it end to end.** ANSWERED (issue #119, PR #145): ~55.5
  minutes wall-clock for the fifth level, including two validator-forced redesigns and
  every pin the level moved — and the pin list itself had grown two sites since CLAUDE.md's
  checklist was written, so the per-level figure to multiply is "an hour with the
  machinery mature". A 20-mission campaign extrapolates to roughly 15 more hours of
  authoring alone, before any per-level playtest or feel adjudication.
- For Switch/PlayStation there is no substitute for registering (free for Nintendo) and
  submitting a concept. **Neither platform publishes its criteria**, so nothing short of that
  converts the unknown into a fact — and the pitch is what is judged, so decide content
  first.

**Deliberately unestimated.** Console porting effort and cost are not estimated here: the
toolchains are NDA'd, and neither Nintendo nor Sony publishes devkit prices or certification
requirements. Any number would be invented.

---
