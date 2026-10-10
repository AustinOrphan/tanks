# Issue #1010, criterion 9: evidence stills for level 1 as a lone brown

Produced from commit `6b6e97574a3b93a7e6c633ea69f393cdb0171df0` (branch `feat/level-one-lone-brown`,
worktree `imperative-waddling-willow`, `git rev-parse HEAD` recorded before and after every run;
the tree was clean throughout). "Before" means arena-01 at `c200cf62`, the commit the branch is
cut from and #1010 was re-verified against. No tracked file was modified and nothing was committed
or pushed. Everything here is local candidate evidence; required CI is still pending.

## Files

| File | What it shows |
| --- | --- |
| `level1-after-game.png` | **After, at play distance.** A live frame of the real game on level 1, shot through the game's own camera by the gallery's `--scene game` (fresh profile, Start Campaign, which plays level 1). One brown at the top left of centre, the player at the bottom, the same walls. 2480x1340 px: the game scene's viewport is `--w`/`--h` plus 40 CSS px, at `--dpr 2`. It is frame 11 of a 12-frame burst. |
| `board-before-after.png` (`.svg`) | **Before and after, as boards.** Left: `STANDARD_ARENA`, the pre-edit arena-01 (brown, grey, teal, player). Right: arena-01 at HEAD (brown, player). Drawn from the repository data: wall cells from the grid, tank discs at `loadArena`'s spawn positions with `TANK_RADIUS` and the catalog colours from `tank-defs.json`. A board drawing, not a game frame. |
| `bank-path.png` (`.svg`) | **The player's one-bounce bank onto the brown**, from the player spawn, on intact walls (left) and with every destructible destroyed (right). Blue is leg 1 (spawn to bounce), yellow is leg 2 (bounce to brown), the white dot is the bounce point, the white outline is the reflecting wall, and the red dashes are the direct line, which `lineOfSight` reports blocked. Shaded cells are the `[column, row, glyph]` marks passed to `renderBoard` (below). |
| `boards.txt` | Every ASCII board `renderBoard` (`src/sim/arena-claims.ts`) drew: before, after, and the two path boards, each with its numbers. |
| `boards.json` | The same numbers as data: spawn cells and positions, letter counts, and for each wall phase the angle, bounce point, reflector, face, leg lengths and every mark. |
| `screen-practice-baseline.diff` | The `screen.practice` baseline diff, `c200cf62` to HEAD: the Practice HUD's "Enemies: 3" at Level 1 becomes "Enemies: 1" (the topbar text and the count element). |
| `trace-compare.txt` | The golden-trace confinement: old and new dumps compared marker by marker. |
| `trace-old.json`, `trace-new.json` | The two dumps' hash, length and marker count. |
| `baseline-hash.diff` | The `BASELINE_HASH` re-pin and its "ELEVENTH CHANGE" entry in `tools/baseline/trace.ts`, `c200cf62` to HEAD. |
| `gallery-after.log` | The gallery run's output (`pageerrors: none`, exit 0). |
| `scripts/` | The scripts that made all of the above (see Commands). |

## 1. Before and after

**Before** is `STANDARD_ARENA` (`fixture-standard`, `src/sim/config/arena-fixtures.ts`). The script
does not assume it is the pre-edit board: it reads arena-01 from `c200cf62` with `git show` and
asserts the two grids are equal (`true`). It also asserts that arena-01 at HEAD and
`STANDARD_ARENA`, with enemy spawn letters read as floor, are identical, so walls and `P` did not
move (`true`).

| | Spawn letters (P, B, G, T, O, N, Y) | Spawns, `loadArena` order (column, row; world) |
| --- | --- | --- |
| Before (`c200cf62`) | 1, 1, 1, 1, 0, 0, 0 | brown 13, 7 (9, 5); grey 19, 7 (13, 5); teal 16, 10 (11, 7); player 16, 22 (11, 15) |
| After (HEAD) | 1, 1, 0, 0, 0, 0, 0 | brown 13, 7 (9, 5); player 16, 22 (11, 15) |

There is no 3D "before" frame at play distance. Making one would need a separate build of
`c200cf62`, which this run was told not to make, so "before" is the board drawing plus the
`screen.practice` baseline diff. The "after" frame was captured with no dev query, so it is the
real level 1 as a fresh player starts it. The campaign HUD in that frame shows Lives and Level and
no enemy count; the enemy count change is evidenced by the Practice HUD baseline diff.

Frame choice: I inspected frames 0, 6 and 11 of the 12-frame burst. All three are clean, with no
shell in flight, no countdown overlay and no artefacts. They differ only in the brown's turret
angle, which shows the game was live. The other nine frames' file sizes are within 0.1% of these
(1,282,890 to 1,283,820 bytes), but I did not open them. Frame 11 was chosen. The 12 frames and
the burst GIF stay in `gallery-out/level1-after/` in the worktree, which is gitignored.

## 2. The bank shot from the player spawn

Method (`scripts/boards.ts`): the angle is the real `bankShot(playerSpawn, brown, walls, 1)` from
`src/sim/ai/targeting.ts`. Budget 1 because the player's normal shell bounces once, and
`NORMAL_BOUNCES = 1` is printed. `bankShot` returns the shortest single-bounce solution. The
bounce point is the real `reflectSweep` (`src/sim/collision.ts`) along that angle, the sweep a
fired shell takes. Both legs are sampled every 0.05 units into `[column, row, glyph]` cells and
drawn with `renderBoard`. Non-floor cells are not overwritten, so walls and the `P`/`B` letters
stay visible. The bounce cell `X` is the floor cell just before the face, so it never paints over
a wall.

| Wall phase | `lineOfSight` | `bankShot` angle | Bounce point | Reflector | Legs (units) | Marked cells |
| --- | --- | --- | --- | --- | --- | --- |
| Intact | false | -2.2455 rad | (6.000, 8.750) | east face of the destructible block at column 8 row 13 | 8.004 + 4.802 = 12.806 | 16 `o`, 9 `+`, 1 `X` |
| Breached (`breach(walls)`) | false | -0.6947 rad | (16.000, 10.833) | west face of the solid east pillar, columns 24-26, rows 15-23 | 6.509 + 9.112 = 15.620 | 13 `o`, 18 `+`, 1 `X` |

These match the faces arena-01's new notes name, and the test that pins them in
`src/sim/arena.test.ts` ("banks off the faces its notes name").

```
walls intact                        every destructible destroyed
.................................   .................................
.................................   .................................
.................................   .................................
......###...............###......   ......###...............###......
......###...............###......   ......###...............###......
......###...............###......   ......###...............###......
......###...............###......   ......###...............###......
......###....B..........###......   ......###....B+.........###......
......###...++..........###......   ......###.....++........###......
...........++....................   ...............++................
..........++.....................   ................++...............
.........++......................   .................++..............
......xxx+.....###......xxx......   ......xxx......###+++...xxx......
......xxxX.....###......xxx......   ......xxx......###..++..xxx......
......xxxoo....###......xxx......   ......xxx......###...++.xxx......
..........oo...###......###......   ...............###....++###......
...........oo..###......###......   ...............###.....X###......
............o..###......###......   ...............###...ooo###......
......###...oo..........###......   ......###...........oo..###......
......###....oo.........###......   ......###..........oo...###......
......###.....oo........###......   ......###.........oo....###......
......###......oo.......###......   ......###........oo.....###......
......###.......P.......###......   ......###.......Po......###......
......###...............###......   ......###...............###......
.................................   .................................
.................................   .................................
.................................   .................................
```

Legend: `.` floor, `#` solid, `x` destructible, `P` player spawn, `B` brown, `o` leg 1, `+` leg 2,
`X` bounce cell. The breached ASCII board still prints `x`, because `renderBoard` draws the grid
and not the wall state. The PNG draws destroyed blocks as dashed outlines.

## 3. `BASELINE_HASH`

| | Hash | Length | Markers |
| --- | --- | --- | --- |
| Old: pinned at `c200cf62` | `b46dec3cfda633989bf6962a0ade4b3d9b81c91447a7ce2781b97949845170ce` | 140,028 | 54 |
| New: pinned at HEAD | `1c3adc76125651c6b1cb52e56595cc436ff724ad661be94e22a552b29f1dc85c` | 131,258 | 54 |

Method (`scripts/run-trace.sh`, which uses `dump-trace.ts`, `arena01.ts` and `compare-trace.mjs`,
written earlier in this job in `w1010/` and re-run here, unchanged, against HEAD): both dumps come
from the repository's own `traceText()` on this tree. The "old" dump swaps only arena-01, in
process, for its `c200cf62` data, so it is not a run of the `c200cf62` tree. It reproduces
`c200cf62`'s pinned hash byte for byte, which attributes the whole move to arena-01's data. The
"new" dump uses the tree's own data and equals HEAD's pin. The comparison:

- 54 markers before and after (9 arenas by 6 seeds), arena-major, seeds 1 to 6 within each arena.
- Markers that differ outside arena index 0: **0**. The other 48 are byte-identical.
- Inside arena index 0, **6 of 6** differ, and the outcome changes in all six: `|0:1:lose:1545|`,
  `|0:2:lose:1178|`, `|0:3:lose:1427|`, `|0:4:lose:1255|`, `|0:5:lose:1252|` and
  `|0:6:lose:1240|` each become `|0:n:win:988|`.
- The text after arena index 0's last marker is byte-identical: 126,111 characters in both, with
  sha256 prefix `542035fd74074dd4` in both. The first differing character is at offset 42,
  inside run 0:1.
- Arena 0's section goes from 13,917 to 5,147 characters, and the total from 140,028 to 131,258
  (-8,770, all of it inside arena 0).

This re-run is byte-identical to the earlier confinement in `w1010/out/` (same comparison text,
same old and new dumps, checked with `diff`/`cmp`). `npx vitest run tools/baseline/trace.test.ts
src/sim/arena.test.ts` passed at HEAD (2 files, 63 tests). The `trace.ts` entry attributes the
win at tick 988 in every seed to the trace's fixed scripted input against one stationary enemy
(the seed moves the brown's aim, not the player's input). It is not a difficulty measurement.

## Commands

From the worktree root. Each was run once, with one gallery run at a time on port 5599.
`<media>` is `/Users/austinorphan/.claude/jobs/8fe9c2c6/tmp/media-1010` and `<scripts>` is
`/Users/austinorphan/.claude/jobs/8fe9c2c6/tmp/media-1010-scripts`. Copies of the scripts are in
`scripts/` here; `run-trace.sh` calls the originals in `w1010/` by absolute path.

```sh
git rev-parse HEAD   # 6b6e97574a3b93a7e6c633ea69f393cdb0171df0
npm run gallery -- --scene game --w 1200 --h 630 --dpr 2 --slowmo 0.3 --burst 12 --settle 12000 --out gallery-out/level1-after
cp gallery-out/level1-after/frame-0011.png <media>/level1-after-game.png
npx vite-node <scripts>/boards.ts -- --out <media>
sh <scripts>/run-trace.sh   # dump-trace.ts --patch base and --patch none, then compare-trace.mjs
git diff c200cf62 HEAD -- tools/screens/baseline/screen.practice.json > <media>/screen-practice-baseline.diff
git diff c200cf62 HEAD -- tools/baseline/trace.ts > <media>/baseline-hash.diff
npx vitest run tools/baseline/trace.test.ts src/sim/arena.test.ts
```

`boards.ts` imports only the tree's own modules (`ARENA_01`, `loadArena`, `STANDARD_ARENA`,
`renderBoard`, `cellOf`, `breach`, `bankShot`, `lineOfSight`, `reflectSweep`, `fromAngle`,
`TANK_RADIUS`, `NORMAL_BOUNCES`, `tank-defs.json`) and rasterises its SVGs with the repository's
installed Playwright Chromium. It writes only under `--out`.

## Populations

- Before and after boards: 4 spawns before (brown, grey, teal, player), 2 after (brown, player),
  on a 33x27 grid with cell size 2/3 unit.
- Bank path: 2 wall phases (intact, breached), one target (the brown at column 13 row 7) and one
  origin (the player spawn at column 16 row 22). Only `bankShot`'s shortest solution per phase is
  drawn; other one-bounce solutions were not enumerated.
- Golden trace: 54 runs (9 arenas by 6 seeds); 6 moved (arena-01's), 48 did not.
- Gallery: 1 run, 12 frames, 3 opened, 1 chosen.

## Limitations

- **No playtest.** These stills show necessary conditions: one brown, no direct line from the
  spawn, and a one-bounce bank on both wall phases. They do not show that "a bank shot is clearly
  the answer". That is judged by the playtest criterion on #355, as the issue says. The same bank
  check also passes on the pre-edit board for the brown's and the teal's cells, so it is a
  regression guard and not a proof.
- **The bank path is targeting geometry, not a fired shell.** I did not simulate a player shell
  fired from the muzzle at that angle in the running game, with muzzle offset, shell lifetime or
  the brown's response. The path is from the spawn centre, as in `bankOfferFailures` in
  `src/sim/arena.test.ts`.
- **No 3D before frame** (see section 1). The board drawing is not a game frame, and the
  `screen.practice` evidence is the baseline JSON diff, not a picture.
- **The after frame is live and unseeded.** Tank poses and turret angles at the instant of capture
  vary from run to run. Rendering was under the local headless Chromium, which is not the CI
  `visual` job.
- **The old trace is a swap, not the old tree.** It is HEAD's `traceText()` with arena-01's
  `c200cf62` data. That it reproduces `c200cf62`'s pinned hash is the attribution evidence.
  Chromium re-verifies the pin in CI. The firefox and webkit re-run belongs to the Engines matrix
  workflow after merge and was not run here.
- **No normal-speed clip.** That is a workstation step, not an acceptance criterion: the flow
  recipes require 45 delivered frames per second.
