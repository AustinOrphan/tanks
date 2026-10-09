# Issue #1036: Citadel (`vs-quad-02`), the second four-player versus board

From commit `3980f9e2adca049b4b59395e0a52d594ae7e3c45` on `feat/second-four-player-versus-board`,
branched from `main` at `c083f9c5`.

**These are renders and scripted-bot measurements, not a playtest.** Whether the board plays well
is #1037's sign-off by normal-speed human play.

## Files

| File | What it is |
| --- | --- |
| `setup-map-row-4p.png` | the Versus Setup map cards at four players, from a production build, with Citadel selected; Random now counts 7 eligible boards |
| `setup-card-citadel.png` | the Citadel card alone |
| `board-vs-quad-02-n4.png` | a top-down render of Citadel (`tools/mapgen/render.mjs`), with the four spawns `loadArena` really picks at N=4 |
| `board-vs-quad-01-n4.png` | the same render of Quarters, for comparison |

## Calibration, `npx vite-node tools/mapgen/calibrate.mjs`, N=4 (reported, not gated)

```
board         N  ok  wall  dstr  cov  spc  legal  corr  open  dead  lane2  lane3  lane4  slit  prs  unr  mine  pMin  pMax  sprd  neck  rout  1way  pts  sight  bank  bOnly  rot  c3
vs-quad-01    4   y  0.31  0.06   67  1.1  0.47  0.10  0.26  0.0487  0.92  0.63  0.38  0.0000    6    0     0  23.0  36.0  0.45  2.67  1.33     4   68  0.32  0.15  0.06  0.00  0.42
vs-quad-02    4   y  0.26  0.04   52  1.4  0.50  0.07  0.15  0.0140  0.92  0.60  0.35  0.0000    6    0     0  23.0  36.0  0.47  2.00  1.33     4   73  0.23  0.16  0.07  0.00  0.36
```

Against Quarters, Citadel has:

- less wall (0.26 against 0.31) and more tank-legal floor (0.50 against 0.47);
- fewer dead-end pockets (0.0140 against 0.0487);
- a narrower pinch that every pair must pass (2.00 world units, one 3-cell lane, against 2.67);
- less of the board in direct view (`sight` 0.23 against 0.32).

At N=2 it reads 0.598 against the imported 60% wide-corridor budget, which it misses by 0.002;
`tools/mapgen/measure.test.ts` reports that rather than gating on it.

## Scripted bots, `VITE_RUN_MEASURE=1 npx vitest run src/sim/quad-playtest.measure.test.ts`

The harness is now parameterised by board, so both four-player boards run on the same seeds
(7, 11, 23), modes and assertions: 90-second matches at the 60 Hz timestep, all four sides the
real scripted-player AI.

| Board | Mode | Shots | Mines | Kills | Breaches | First contact (s) | First kill (s) | Separation min/mean/max |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Quarters | FFA | 85 / 127 / 113 | 5 / 9 / 3 | 11 / 11 / 11 | 5 / 6 / 3 | 9.4 / 9.4 / 8.9 | 10.7 / 11.4 / 11.1 | 13.5 / 13.0 / 14.0 mean |
| Quarters | Teams | 71 / 113 / 96 | 4 / 8 / 12 | 10 / 11 / 9 | 0 / 12 / 15 | 8.8 / 9.0 / 9.3 | 10.8 / 12.1 / 16.0 | 14.0 / 13.5 / 11.4 mean |
| Citadel | FFA | 64 / 31 / 32 | 20 / 11 / 9 | 11 / 11 / 10 | 0 / 0 / 0 | 6.1 / 5.8 / 8.0 | 16.1 / 10.4 / 12.0 | 14.0 / 13.2 / 14.4 mean |
| Citadel | Teams | 90 / 57 / 82 | 17 / 18 / 25 | 8 / 8 / 5 | 0 / 13 / 7 | 6.1 / 5.8 / 8.0 | 17.3 / 10.4 / 12.1 | 13.4 / 13.6 / 13.4 mean |

Each cell lists seeds 7 / 11 / 23. On Citadel the bots meet sooner, fire fewer shells, lay more
mines, and breach the court's gates only in Teams. Teams split 2v2 on every seed on both boards.
A scripted-agent run supports a verdict; it never establishes one.

## Geometry, measured on the real `loadArena`

- **Spawns.** At N=4 the spawns are (1,1), (31,1), (1,25) and (31,25), one orbit of the board's
  two mirrors. Every spawn's path distances to the other three are {34, 34, 54}, the same with
  the gates standing or breached. Teams pairs the top corners against the bottom ones.
- **Suitability.** Suitable at N=2, 3 and 4, with tank egress, `sealedSpawns` 0, `fatalEscapes`
  0 and every spawn pair concealed. It stays suitable on all ten variant seeds at each count.
- **Room.** 655 open cells: 163.75 per player at N=4, against the 96.33 tightest offered.
- **The court.** It is reachable only through a gate: a drive from north of it to south of it is
  24 cells round it and 14 through it once breached.
- **Distinct from Quarters.** Its grid differs from vs-quad-01's under identity, both flips and
  the half turn.
