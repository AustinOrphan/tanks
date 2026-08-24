---
status: superseded
date: 2026-07-31
last-reviewed: 2026-08-23
scope: Pause state design: Esc/P and blur triggers, frozen-scene overlay, and the settings-pane seed shared with the title panel.
implementation-issues: []
implementation-prs: [45]
supersedes: []
superseded-by: ["docs/superpowers/specs/2026-08-23-ui-ux-direction.md"]
---
# Pause: a frozen scene, a panel over it, and the seed of the settings pane

Approved 2026-07-31 (all three decisions taken with the user).

## What ships

1. **A `paused` game state.** Only reachable from `playing`; resume returns to
   `playing`. The sim stops stepping, the renderer keeps drawing the frozen pose, the
   pause panel overlays it — the exact hold-pose path title/win/lose already use in
   `driver.ts` (state !== 'playing' drops the accumulator, so resume does not repay
   paused time).
2. **Triggers.** `Esc` and `P` toggle pause while playing (and un-pause while paused).
   Losing window focus (`blur`) auto-pauses a playing game — a blurred tab must not
   keep eating lives. Blur in any other state does nothing; focus does NOT auto-resume.
3. **The panel.** Title "Paused"; buttons: **Resume** and **Quit to Title**; plus
   volume and mute controls — the topbar pair, grouped here as the start of the
   settings pane. Restart Level is deliberately out of scope (it needs a lives-policy
   decision; fresh lives would make retry-scumming free).
4. **Quit to Title** returns to the title panel; the next Start begins a FRESH run:
   world rebuilt at `levels.start` with fresh lives, exactly like the game-over path.

## Hazards named up front

- `hud.setState`'s final `else` renders "Game Over" — a new state that forgets its
  branch would show a corpse screen. The switch must handle `paused` explicitly.
- `sm.onChange('playing')` currently calls `audio.startMusic()`; resume re-enters
  `playing`, so startMusic must be idempotent or the transition must distinguish
  resume from start.
- The pause hotkey must respect focused form controls the way `isMuteHotkey` does,
  and `Esc` must not fight the volume slider.
- `HostWindow` gains the `blur` listener type; dispose must remove it.

## Out of scope

Restart Level, any new settings beyond audio, pause during title/win/lose (no-op),
auto-resume on focus.
