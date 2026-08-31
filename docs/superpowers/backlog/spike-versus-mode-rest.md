---
status: active
date: 2026-08-23
last-reviewed: 2026-08-23
scope: Spike -- the rest of versus mode -- setup UI and maps
implementation-issues: []
implementation-prs: []
supersedes: []
superseded-by: []
---
# Spike: the rest of versus mode -- setup UI and maps

**Raised 2026-08-17**, alongside the versus-spawns PR
(`docs/superpowers/plans/2026-08-17-versus-spawns.md`), which derives well-separated
FFA/teams spawn cells from arena geometry but deliberately stops at initial placement.
Originally six questions; the first three are answered and closed by
`docs/superpowers/plans/2026-08-17-versus-stock.md` (a directive settled match-format
order -- stock first -- and the spawn-protection/respawn-placement shapes), struck below
rather than deleted so the record of what was open, and when it closed, survives. A
fourth (spawn animation) has since closed too, separately, by #203/#205 rather than by
the stock PR -- also struck below, same idiom.

1. ~~**Stock/lives.**~~ -- CLOSED by the stock PR. `VERSUS_STOCK` (`constants.ts`,
   `data/balance.json`), default 3, per-tank (`Tank.stockRemaining`), sharing
   `RESPAWN_DELAY_TICKS`/`RESPAWN_SHIELD_TICKS` with campaign-coop rather than a second
   pair of constants -- versus's respawn timing and post-revival grace are not new feel
   values, they are coop's own.
2. ~~**Respawn cell selection.**~~ -- CLOSED by the stock PR. `pickVersusSpawnCell` is
   now wired to `stepRespawns` via `World.arenaGeometry`, scored against every currently
   living tank's position.
3. ~~**Spawn protection.**~~ -- CLOSED by the stock PR. A directive settled duration
   (reuses `RESPAWN_SHIELD_TICKS`, no new timer) and shape (`isActionLocked`: fire/mine
   locked, movement and aim unrestricted) -- no visual cue was in scope; that remains
   render-layer work, not named as its own open question since nothing here depends on
   it.
4. ~~**Spawn animation.**~~ -- CLOSED by #203 (spawn animation core: identity entrance
   + shield invincibility, three variants shared by round start and respawn,
   `src/render/spawn-anim.ts`) and #205 (identity death pulse). Versus respawns get the
   same entrance for free, through the generic dead -> alive edge (`entities.ts`'s
   `enteredRespawn = !!prevT && !prevT.alive && t.alive`) that `stepRespawns` already
   flips for any tank, versus included -- no versus-specific treatment was needed.
5. ~~**A versus setup menu.**~~ -- CLOSED by the versus setup-menu spec/plan
   (`docs/superpowers/specs/2026-08-21-versus-setup-menu-design.md`,
   `docs/superpowers/plans/2026-08-21-versus-setup-menu.md`, branch
   `feat/versus-setup-menu`). A **Versus** button on the title screen opens a setup pane
   -- mode, players (2-4), map (the 5 arenas + Random, seeded variants always on), a
   stock-count selector, and friendly fire (Teams only) -- built on the same panel
   open/back machinery Controllers/Customize already use. Start reboots the session
   through the existing `startGameWith` seam (one-value-per-session, unchanged); match
   end returns to the pane with the previous selections intact (session-only retention,
   no seventh store) rather than to title, with an in-match per-player stock readout in
   the HUD top bar for the whole session. `?dev=1&mode=…&players=…` still parses and
   still works -- the menu supersedes it as the player-facing path, and retiring the
   flags is a separate per-flag decision this PR does not make. Who's-playing rows are
   shown in the pane (reusing the Controllers panel's row renderer) but do NOT carry
   through Start: the rows edit only the running session's assignment, which Start
   disposes, so a pane-chosen Bot slot never reaches the next match, and the pane offers
   no Bot option at all before any versus session has run -- open as issue #260 (#228
   AC2), not shipped by this PR. This PR is "Part of #228" (the tracking issue for
   shipping versus to a real player), not a close of it: the assignment/bot-fill gap
   above (issue #260, AC2); Quit landing on the versus-kind title instead of the pane,
   plus every reboot (including every rematch) showing a second "press any key" splash
   before play (issue #261, AC5); ~~per-slot bot difficulty~~; ~~a match-rules table for
   sim-enforced shell/mine caps~~; invalid-combination explanations; pad/touch
   keyboard-navigation validation of the pane; and the persistence ruling (session-only
   vs. `localStorage`) remain open there. **Two of those have since closed, struck above
   rather than deleted, same idiom as items 1-5.** Per-slot bot difficulty shipped with
   #267 -- `ai/bot-difficulty.ts`'s three presets as multipliers over the authored
   profile, offered per slot in the pane. The match-rules table is #268: the pane now
   carries a **Standard rules** line stating the effective shell and mine limits, read at
   render time from the same configuration `spawnBullet` and `dropMine` enforce
   (`weapon.maxActiveProjectiles` and `mineCapacity`) rather than duplicated in the UI --
   which is also why it is a stated RULE rather than the editable table the phrase
   originally imagined: #268's binding decision is that PP1 exposes no cap controls.
6. **Map selection / procedural generation.** Already named as unbuilt in this file's
   Ledger ("Procedural generation of shipped levels; the four arenas are authored
   grids... #43") -- and directly relevant here, since `pickVersusSpawnCell` was
   deliberately written against the arena's OWN geometry (BFS + line-of-sight over
   `grid`/`legend`/`cellSize`) rather than authored spawn points specifically so it would
   work on a board with no author. That is now proven on the 5 shipped, hand-authored
   arenas, for BOTH initial placement and (since the stock PR) respawn; it has not been
   exercised against a generated one, because none exists yet. **Partly answered by the
   board-rules PR** (`docs/superpowers/plans/2026-08-17-versus-board-rules.md`):
   `src/sim/versus-board.ts` gives "which maps to offer at a given player count" a
   checkable definition -- separation, mutual concealment and a room ratio, all derived
   from geometry the same way `pickVersusSpawnCell` is, so it works on a generated board
   too, once one exists. It answered the RULE, not the MENU: nothing called it from
   `loadArena`, no UI consulted it, and it has only ever been measured against the 5
   shipped arenas (15 of 15 (arena, N) combinations pass, by a wide margin -- none of the
   3 criteria currently rejects a shipped board). **The MENU half is now CLOSED too, by
   the versus setup-menu PR** (item 5, above): the setup pane's Map row calls exactly
   this catalog -- `versusMapChoices`/`versusBoardCatalog`, filtered by the pane's chosen
   player count -- plus a Random option added on top, which draws uniformly from the
   catalog's passing entries via the session's own seed derivation (no `Math.random`).
   The gap this paragraph named is closed for the UI half; the underlying measurement is
   unchanged (still only the 5 shipped arenas). **Superseded mechanism, #270 (2026-08-23):
   the offer now reads the DEDICATED declared catalog** (`versus-catalog.json` +
   `versusMapChoices(players, mode)`, stable VS ids, declarations proven against the same
   `evaluateVersusBoard` machinery by `versus-catalog-rules.test.ts`'s sweep);
   `versusBoardCatalog` remains the measurement tool, no longer the runtime offer list.
   The purpose-built maps themselves are #271-#273, the selector previews #274. **Further answered, on the map-supply
   side, by the map-variants PR** (`docs/superpowers/plans/2026-08-17-versus-map-variants.md`):
   `src/sim/versus-variants.ts` builds the directive's named middle step between "one
   fixed board per arena" and full procedural generation -- a seeded, deterministic
   SUBSET of an authored board's destructible cells is omitted per match (solid
   geometry, dimensions and the `P` cell untouched), wired into `loadArena` guard-first
   so campaign-coop is unaffected and every existing versus call that omits a seed stays
   on the authored board. It DOES reach the shipped path this time (unlike the
   board-rules PR): `createWorldFor` threads its own seed into `loadArena`, so a real
   `?dev=1&mode=ffa` session gets a variant automatically, gated by a bounded retry
   against `evaluateVersusBoard`'s own two regressable criteria (falling back to the
   authored board if every retry is exhausted). Whole-board procedural generation --
   a board with no authored solid-wall skeleton at all -- remains exactly as unbuilt as
   before; this PR only varies destructible cells within one.

**Why 4-6 still belong together rather than as three separate spikes:** this framing is
now stale for the same reason it went stale for item 4 -- two of the three items it
described as jointly gating have since closed, so the ORIGINAL claim ("they still gate
each other") no longer holds for any pair. Spawn animation (4) closed first (#203/#205,
see item 4 above). The setup menu (5) has now closed too (see item 5 above, this PR):
the "a setup menu that only offers 2 shipped arenas is premature before map selection has
an answer" gating this paragraph once described did not, in the event, block anything --
the menu shipped against exactly the 5 arenas item 6's board-rules PR had already
validated (15 of 15 (arena, N) combinations) plus a seeded Random, without waiting for
whole-board procedural generation. What is left of the original three-way gating is
nothing: item 6's remaining half (whole-board procedural generation, still open) does
not block anything else named in this grouping, and nothing else here blocks it. Kept
under one heading, not split or renumbered to "6", for the historical record of why
these three were grouped and when each piece closed -- the same practice items 1-4 above
already use.

**What would answer it:** ~~a product decision on whether versus ships with dev-flag-only
access or a real menu (5)~~ (answered above -- the versus setup-menu PR shipped the
menu), and ~~a decision on spawn animation's shape (4)~~ (answered above -- #203's three
variants); what remains is either a decision to keep versus scoped to the existing 5
arenas indefinitely, or the procedural-generation spike above (`## Spike: pathfinding and
risk-aversion weights in the movement AI`'s neighbour sections) reaching its own answer
first (6) -- the one piece of 4-6 still open.

**Not scheduled.** Recorded so the one remaining piece of versus mode -- whole-board
procedural generation, item 6's own residual -- is not mistaken for finished now that 4
and 5 have both closed, and is not rediscovered from scratch by the next person who
reads `pickVersusSpawnCell`'s doc comment and wonders why `avoid` takes live positions
when nothing calls it that way yet -- something has, since the stock PR, but the caveat
this line originally guarded (an unwired signature) no longer applies; the sentence stays
because the next reader's question is still worth answering directly rather than by
implication.

---
