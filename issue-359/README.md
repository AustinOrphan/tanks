# Issue #359 harness evidence: AI contact overlay in live co-op, and the versus-bots boundary

Captured 2026-09-13 with `npm run gallery -- --scene game` from branch `feat/shell-bounce-trail-experiment` at `bd47231`. That branch changes no `src/sim/` or AI file (`git diff origin/main -- src/sim` is empty), and its own trail flag is not set. Chromium with swiftshader, DPR 1.

## Reading the overlay (`?dev=1&aiContact=1`, `src/render/ai-contact.ts`)

- **Line:** from each enemy to the opponent it is committed to.
- **Label:** `#<target id> c<commitment ticks left>` while the target is visible. `#<id> c<ticks> m<memory ticks left>` while it is only remembered (out of sight).
- **Reason letter:** a trailing `a` (acquired), `l` (target lost) or `s` (switched on expiry) shows only for 30 ticks (0.5 s) after the change.

## Capture conditions, and what they are not

- **Command:** `--w 640 --h 400 --slowmo 0.008 --settle 420000 --burst 180`, with queries:
  - 2 bots: `dev=1&seed=42&level=5&players=2&bots=2&aiContact=1`
  - 4 bots: `dev=1&seed=7&level=5&players=4&bots=4&aiContact=1`
- **`level=5` did not take effect on this path.** Every frame's HUD reads `PRACTICE · Lives: 3 · Level: 1` and the board is level 1's arena, with 3 enemies. These are level 1 captures.
- **Not normal-speed playback.** `src/game/frame.ts` credits each frame `min(realDt, 0.25 s)` of game time, and a burst frame waits on its screenshot. `--slowmo 0.008` brings that down to an estimated ~17 ms of game per frame: the 2-bot run took 801 s for 420 s of settle plus 180 frames, about 2.1 s per frame, times 0.008. That total includes browser start-up, so it is an estimate, not a measured tick count.
- **Why `--slowmo` at all:** an earlier unslowed attempt at level 1 showed "Level 1 cleared!" from its second frame, because the bots cleared it during the default settle.

## Files

- **`coop2-frames-000-120.png`:** 2 bots, frames 0 and 120 of 180.
  - Frame 0: the brown enemy's line runs to the blue player and the grey enemy's to the pink one, so the two committed lines split across both players.
  - Frame 120: labels read `#4 c44 m42` (brown, target remembered), `#5 c44` (teal, target visible) and `#5 c44 m27` (grey, remembered).
- **`coop2-frame-120-labels-4x.png`:** those labels, cropped 200x80 at (260, 118) and scaled 4x nearest-neighbour.
- **`coop4-frame-090-with-labels.png`:** 4 bots, frame 90 of 180, beside its label area cropped 200x90 at (240, 115) and scaled up nearest-neighbour. The grey enemy reads `#6 c66 s`: it switched opponent on commitment expiry within the previous 0.5 s. The brown enemy reads `#7 c66`, the teal `#4 c66`.
- **`versus-ffa4-bots-frame-002.png`:** `dev=1&seed=42&players=4&bots=4&mode=ffa&aiContact=1`, 1280x800, frame 2 of 20. There are no AI contact markers: versus strips enemy spawns, and `stepAi` skips every player-kind tank, bot slots included.
