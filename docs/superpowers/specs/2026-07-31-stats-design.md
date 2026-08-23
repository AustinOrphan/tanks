---
status: completed
date: 2026-07-31
last-reviewed: 2026-08-23
scope: Stats design: event attribution, lifetime/per-run stat tracking and persistence, and the stats page with two-click resets.
implementation-issues: []
implementation-prs: [56]
supersedes: []
superseded-by: []
---
# Stats: attribution in the event stream, a lifetime tally, and a stats page

Approved 2026-07-31: the full July stat list (kills split shell/mine, deaths, shots +
accuracy, mines laid + mine accuracy, walls destroyed, ricochets, self kills, AI
friendly fire); lifetime persisted PLUS a per-run readout on the win/lose panel;
two-click confirms for Reset Stats and Reset Progress, both on the stats page.

## Sim: events gain attribution (additive fields only)

The stream cannot say WHO did anything today. Added, from data already present at
each emit site: `ricochet.ownerId` (the shell's), `mine-dropped/armed/detonate
.ownerId` (the mine's), `wall-destroyed.ownerId` (the destroying blast's), and
`tank-destroyed.by = { source: 'shell' | 'blast', ownerId }`. Event-shape change:
all five consumers checked per CLAUDE.md; additive fields, so consumers that ignore
them keep working.

## Game: stats.ts

`createStatsStore(storage)` mirrors progress.ts (one key `tanks.stats.v1`, corrupt
reads as zeros, in-memory shadow when storage throws). Tracks lifetime AND the
current run; `record(events, playerId)` folds a frame's events in; `startRun()`
zeroes the run tally on every level switch. Attribution rules: deaths = player
tank-destroyed; self kill = player killed by their own shell/mine (also a death);
shell/mine kills = enemy destroyed with `by.ownerId === player`, split by source;
friendly fire = enemy destroyed by a non-player owner; accuracy = shell kills /
shots, mine accuracy = mine kills / mines laid (shown as -- when denominator 0).
Persisted on every batch that changed a counter.

## HUD: the stats page

A panel view reachable from the title via a Stats button: the table (lifetime
column, current-run column), Reset Stats, Reset Progress, Back. Both resets are
two-click: first click arms ("Really reset?") with a timeout, second click fires
`onResetStats`/`onResetProgress`. Reset Progress re-locks levels (the loop refreshes
level select from the live progress store). Win/lose panels gain one run-summary
line. New CSS selectors join the presence pins.

## Out of scope

Per-level stat breakdowns, leaderboards/export, stats for the sandbox (it records
nothing, like progress), migrating old sessions (there are none).
