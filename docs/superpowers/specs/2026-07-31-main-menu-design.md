---
status: completed
date: 2026-07-31
last-reviewed: 2026-08-23
scope: Title panel becomes the main menu: Start/Level Select/Settings, localStorage level-unlock progress, and a dev-only sandbox.
implementation-issues: []
implementation-prs: [47]
supersedes: []
superseded-by: []
---
# Main menu: level select with saved progress, and settings on the title panel

Approved 2026-07-31 (all three decisions taken with the user): Start + Level Select +
Settings on the menu; levels locked until cleared with progress in localStorage; the
sandbox stays dev-flag-only.

## What ships

1. **The title panel becomes the main menu**: Start Game (begins at the furthest
   unlocked level), a Level Select row, and the audio settings group (the pause pane's
   pair, shown on both panels; the CSS class generalises from `hud-pause-settings` to
   `hud-panel-settings`).
2. **`src/game/progress.ts`**: `createProgressStore(storage)` over one localStorage key
   (`tanks.progress.v1`) holding the highest cleared 1-based level. Injected through
   GameDeps; in-memory fallback when storage throws (Safari private mode); corrupt or
   missing data reads as nothing cleared. Never touches the sim.
3. **Unlock rule**: level i (0-based) is pickable iff i <= highestCleared. Level 1 is
   always open. Every win records its level AT THE WIN EVENT, not at the button press,
   so quitting after a win keeps the unlock. `?dev=1&level=N` bypasses locks; sandbox
   remains dev-only and records nothing.
4. **Level select wiring**: locked buttons disabled and visibly locked; an unlocked
   click rebuilds the world at that level and starts play, guarded to the title state
   in the handler (CSS hiding is not the only defence).

## Out of scope

Tank customization (no art/colour system yet), sandbox on the menu, any settings
beyond audio, remote/cloud persistence.
