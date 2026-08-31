---
status: active
date: 2026-08-23
last-reviewed: 2026-08-31
scope: Spike -- mobile app release (iOS App Store / Google Play)
implementation-issues: []
implementation-prs: []
supersedes: []
superseded-by: []
---
# Spike: mobile app release (iOS App Store / Google Play)

**Raised 2026-08-10**, from a four-part release investigation.
**Document: `docs/research/mobile-release.md`.**

**The question:** should Tanks! ship as a wrapped mobile app, and if so on which platform
first?

**Why it is live now.** The tree is unusually ready for a wrapper and nobody has said so in
one place: `grep` finds exactly 1 non-test occurrence of `fetch(`/`XMLHttpRequest`/`import(`
across `src/` (a type-position import in `audio/music.ts`'s `director?:` field), `public/audio/` holds only a
`.gitkeep`, and `base: './'` already emits `./assets/…`. Touch controls, gesture
classification, `pointercancel`/`blur`/`visibilitychange` recovery and the iOS audio-unlock
gesture path all ship today. What is missing is the store-quality shell — and one number.

**What would answer it:**

- **The gating measurement is frame time on a real mid-range Android.** Serve `dist/` over
  the LAN, add a temporary probe around the render call in `game/driver.ts`, and record
  p50/p95 over three 60-second rounds on arena-04. Report the distribution. Nothing in this
  repo has ever measured a frame time on a phone, and the render settings are desktop-tuned:
  `antialias: true`, a 2048x2048 PCFSoft shadow map, three directional lights, ACES tone
  mapping, a PMREM environment map, DPR capped at 2, and no instancing anywhere
  (`grep -rn InstancedMesh src/ tools/` returns nothing). **Until that number exists, the
  size of the port is a guess, and no estimate here is worth anything.**
- Then a one-variable-at-a-time knob sweep **on device** — shadow map 2048→1024, antialias
  off, DPR cap 2→1.5, dropping the fill/rim lights. `npm run gallery --sweep` already patches
  constants and restores them; it has never been pointed at a phone. Prove the knob is wired
  first: identical p50 across passes means a dead knob.
- Decide Capacitor vs Tauri v2 by enumerating the native surface actually wanted (my read:
  haptics, orientation lock, edge-to-edge, splash, nothing else). Capacitor 8 requires
  Node 22+, which now matches this repo's declared floor of 22.13.0.

**Two calendar constraints that no engineering shortens**, both re-verified 2026-08-10: a
personal Play account created after 2023-11-13 must run a closed test with **12 testers
opted in for 14 continuous days** before applying for production access; and from
**2026-08-31** new Play apps and updates must target API 36. iOS additionally cannot be built
from this machine at all — it needs macOS + Xcode, which is hardware, not code.

**Not scheduled.** The PR-able pieces (safe areas, a web app manifest, the storage seam, a
privacy policy) are filed as issues and are worth doing on their own merits.

**What the safe-area / manifest / framing PR left open** (issues #106, #107 and #108; PR
#130). Three of these need a notched phone in a hand, which is the reason they are here
rather than in an issue — nobody can write the closing PR from this machine.

- **Do the absolutely-positioned panels need insets too?** `.hud-topbar` and `.hud-touch`
  are inset by `max(base, env(safe-area-inset-*))`; the stats, achievements and customize
  panes are not, and reasoning cannot settle it — the panes are centred overlays, so
  whether a cutout eats a Back button depends on their real measured box. What would
  answer it: open each pane on a notched device in BOTH orientations and look. If they do
  need it, the shape is already there to copy.
- **`display: standalone` or `fullscreen`?** The manifest ships `standalone` because it is
  the value both platforms honour predictably; `fullscreen` is what a game usually wants
  on Android, and iOS's handling of it was not verified. One install on each platform
  answers it.
- **Orientation: lock landscape, or accept a small board in portrait?** Now measured
  rather than guessed, and it is NOT a correctness question — `framing.test.ts` sweeps
  4 shipped arenas x 10 aspects and nothing crops at 20:9 portrait (0.42). It is a
  product call: the same board fills 20.8–22.9% of the frame at 0.42 against 44.4–49.4%
  at 21:9 (population: all 4 shipped arenas at each aspect), recomputed by that file's
  `measures what a phone aspect costs` tripwire. A lock would live in a wrapper's native
  manifest, which this repo does not have yet — so it is a decision for the wrapper, not
  a change to make here.

---
