---
status: active
date: 2026-08-23
last-reviewed: 2026-08-31
scope: Spike -- multiplayer — which mode, and does peer determinism hold?
implementation-issues: []
implementation-prs: []
supersedes: []
superseded-by: []
---
# Spike: multiplayer — which mode, and does peer determinism hold?

**Raised 2026-08-10**, from the same investigation.
**Document: `docs/research/multiplayer.md`.**

**The question:** which multiplayer mode, if any, and can it be peer-deterministic or does it
need a server?

**Why it is live now.** The sim is a genuinely good netcode foundation and the game around it
is not, and the gap has never been written down. `step(world, input)` clones its argument
(`world.ts:242-243`) so every tick is already an immutable snapshot — rollback save-states,
normally the expensive part, are free. Measured on this box, `cloneWorld` is **2–7% of a
tick**, and an 8-frame rollback is roughly **0.5–1.2 ms of a 16.7 ms budget**. (Report the
contrast, not the tick number: two probes disagreed by more than 2x, and tick cost varies
2.3x across arenas — 61 µs to 144 µs — so the absolute moves when the probe moves.)

Against that, the single-player assumption was load-bearing in five places. **Three have now
moved; two remain** (re-verified against the tree on 2026-08-31, not carried forward):

- **MOVED, issue #120** — the step boundary takes a LIST (`stepInputs`, with `step` as a
  one-argument adapter) and pairs inputs with player tanks by position, so
  `applyPlayerInput` finding one tank by kind is no longer the only path.
- **MOVED, the versus arc** — `resolveStatus` no longer finds one tank by kind. It filters
  the player tanks and resolves through `isVersusEliminated`, so N players already decide a
  round (`world.ts`).
- **MOVED, issue #359** — the four AI target-acquisition sites that took the FIRST player
  found are gone. Every AI now reads one committed opponent through `resolveOpponent`, whose
  selection is perception-bounded and breaks ties with a seeded per-AI draw; zero
  `kind === 'player' && t.alive` scans remain in `ai/targeting.ts`.
- **STANDS** — the arena validator **hard-fails at module load** on any campaign grid without
  exactly one `P` (`config/validate.ts`'s `players !== 1` check; versus boards are validated separately through
  the versus catalog).
- **STANDS** — a death still resets the arena by `tanks[i]` ↔ `spawns[i]` index alignment
  (`respawnPos`, `world.ts`). The fifth, "no gamepad code, so local versus has no second
controller," is now stale: couch co-op's input-routing PR
(`docs/superpowers/plans/2026-08-15-coop-input-routing.md`, branch `coop-input`) gives
`?dev=1&coop=1` a real second controller — a standalone gamepad-only `PlayerInputSource`
driving the `controlledBy === 1` tank end to end through `stepInputs`. That still is not
"local versus": the couch co-op semantics PR
(`docs/superpowers/plans/2026-08-15-coop-semantics.md`, branch `coop-semantics`) answered
win/lose for CO-OP — `world.lives` is one shared pool, `resolveStatus` guard-splits on
`countPlayerTanks(world) >= 2` — but that answer assumes AI enemies remain the only
opposing side. VERSUS (two humans, no AI opponent) is unaddressed: "every non-player tank
dead" and a HUD reading "Enemies remaining" still mean nothing with zero AI, so a second
player can drive but a round with no enemies does not yet know how to end.

**What would answer it:**

- **THE gating measurement: do Chrome, Firefox and Safari produce a bit-identical baseline
  trace hash?** **Half answered 2026-08-10 (issue #121).** The rig is
  `npm run trace:browser -- --all` (`tools/baseline/{trace.ts,page.html,run.mjs}`), and one
  run each of chromium 151 (V8), firefox 153 (SpiderMonkey) and Playwright's webkit
  (JavaScriptCore) printed
  `015a5d1745ce2d3a9ca11e150b2874c10b1b8ca6d77988599787e2269fd198e4`, matching Node.
  **Now measured, not open:** shipped Safari 26.5.2 and real iOS WebKit (Mobile Safari,
  iOS 18.7 Simulator, arm64) both matched `BASELINE_HASH` and `VENDORED_ANGLE_HASH` on
  PR #168's first engines-matrix run (`15989dd`, 2026-08-15) — safaridriver for Safari,
  the beacon for the simulator. ARM was already covered (run 31842261852). The divergence
  choice this line used to pose is settled — issue #133 vendored fdlibm into
  `src/sim/math/` (PR #165) — so a diverging device would indicate a bug in the vendored
  port or the harness, not a fork in the road. Sole remaining gap: a physical iOS device,
  one URL away (`npm run trace:browser -- --beacon`, open the printed URL on the phone).
- **Decide win/lose semantics for VERSUS: ANSWERED 2026-08-17** (n-player arc PR 4;
  docs/superpowers/plans/2026-08-17-versus-modes.md; docs/research/multiplayer.md's own
  open question 3 carries the full write-up). Co-op is answered separately (see above),
  twice: the default is shared ATTEMPTS (2026-08-16 ruling — a lone death costs nothing,
  a full wipe spends a life and resets the arena), with the original shared-pool
  respawn-in-place model behind `?dev=1&coopPool=1`. Versus (FFA + teams) is a THIRD and
  FOURTH `World.mode`, dispatched at the same guard-first split: `loadArena` strips every
  enemy spawn rather than repurposing one as a bonus player slot, single life per round
  with no stock/lives system, FFA wins on exactly one player tank left alive, teams wins
  when one team is wiped and the other has a survivor, and a simultaneous final wipeout
  resolves to `'lose'` rather than a new `'draw'` status (named residual, not built).
- **`TankKind` vs a `controlledBy` field on `Tank`: ANSWERED, route B (the field).** A
  scratch prototype (branch `p2-prototype`, commit `297bdaf`, off `be1bda8`) touched only
  `types.ts` and `arena.ts`, stayed `tsc --noEmit` clean, and needed no edit to any
  existing `kind: 'player'` fixture -- kind never diverges, so every `kind === 'player'`
  identity check in the tree keeps matching a second human-driven tank unchanged. The
  couch co-op foundation (`docs/superpowers/plans/2026-08-15-coop-foundation.md`) adopted
  it: `Tank.controlledBy?: number`, stamped only when `loadArena` is called with
  `playerCount > 1`, landed on `coop-foundation`.
- **Price the zero-infrastructure option first:** manual SDP copy-paste works on the current
  static deploy today, with no signalling server at all, and would let an online prototype be
  measured before anyone signs up for Cloudflare or depends on Trystero's public relays.

**Constraint that shapes any answer:** `InputState.aim` is a world-space POINT produced by
unprojecting a mouse position against the ground plane, so it depends on canvas size. Two
peers with different window sizes produce different aim floats — the input must be quantized
at the input boundary before the sim consumes it. And `SimEvent` carries no tick field, so
re-simulation re-emits the same events and rollback needs de-duplication across all five
consumers.

---
