# Multiplayer in Tanks!

**Investigated 2026-08-09, adversarially verified, corrected and re-measured 2026-08-10.**
File/line citations are against commit `3522c0a` (`origin/main`) and were re-opened in that
tree. External claims carry a source URL and the date checked.

---

## Bottom line

**The simulation core is an unusually good foundation for multiplayer, and the game around it
is single-player to the bone.**

`step(world, input)` clones its input and returns a brand-new world (`src/sim/world.ts:242-
243`), so every tick is already an immutable snapshot: rollback save-states — normally the
expensive part of GGPO-style netcode — are free here. Enemy AI lives inside the deterministic
core, so an online build would transmit only human inputs.

Against that, the game layer assumes exactly one player everywhere: `applyPlayerInput` finds
a single tank by `kind === 'player'`, `resolveStatus` defines a win as "all non-player tanks
dead", the arena validator **hard-fails at load** on any grid without exactly one `P`, four
AI target-acquisition sites take the FIRST player found, and there is zero gamepad code.

**The honest order is couch co-op → local versus → online co-op → online versus.** The
strongest argument for starting local is that the camera already frames the whole board from
a fixed position, so couch co-op needs no split-screen work at all.

**The one thing that decides whether online is possible on the cheap — bit-identical floating
point across Chrome, Firefox and Safari — is UNMEASURED.** No second JS engine is installed
on this box. That is a task, not a permanent barrier: `playwright` is reachable from npm and
ships Linux builds of WebKit (JavaScriptCore) and Firefox (SpiderMonkey), though it is not
currently a dependency and its WebKit is not identical to shipped Safari.

---

## What is true today of this tree

### `step()` never mutates its argument

`src/sim/world.ts:242-243` — `export function step(world, input)` then
`const draft = cloneWorld(world)`, unconditional and before every stage; it returns
`{ world: draft, events }`. `cloneWorld` (:80-95) deep-copies tanks (via `cloneTank`, which
spreads plus copies `pos`, `desiredMove` and `activeMineIds`), bullets, mines, blasts, walls
and spawns. The full `Tank` interface (`types.ts:49-85`) has no nested mutable field the
clone misses.

**Every tick's world is therefore an already-immutable snapshot** — exactly the save-state
machinery rollback netcode normally has to build.

### The sim has no `Math.random`, and a guard enforces it

`grep -nE 'Math\.random'` over the non-test `.ts` files under `src/sim/` returns 4 hits, **all
comment lines** warning against it (`types.ts:221`, `ai/targeting.ts:416`, `:539`,
`ai/player-profile.ts:35`). Randomness is a seeded mulberry32 using `Math.imul`
(`types.ts:222-228`) — integer ops, bit-exact everywhere.

This is not merely a convention: `src/sim/purity.test.ts:203-208` machine-denies
`Math.random`, `Date.now`, `new Date` and `performance` with negative-control fixtures
(:599-627) and meta-tests asserting one fixture per rule (:757, :768).

### Tick cost: report the contrast, not the number

Measured by me on this box (Intel i7-8559U, Node v24.15.0), a committed-then-deleted probe:
20,000 **live** ticks per arena after a 3,000-tick warmup, driven with the golden trace's own
input pattern, re-creating the world whenever status left `playing` so every counted tick
actually simulates. Two consecutive runs:

| arena | step (run 1 / run 2) | cloneWorld | world resets per 20k ticks |
|---|---|---|---|
| 0 | 61.7 / 64.5 µs | 2.5 / 2.6 µs | 20 |
| 1 | 122.4 / 125.2 µs | 4.5 / 4.7 µs | 11 |
| 2 | 68.1 / 67.1 µs | 2.7 / 2.7 µs | 16 |
| 3 | 143.7 / 141.8 µs | 2.7 / 2.8 µs | 17 |

**An earlier draft reported 47.8–52.5 µs. That figure is withdrawn.** Its probe let arenas
terminate early, so most of its counted "ticks" did no work, and the number moves by more
than 2x when the probe changes — which by this repo's own rule means the stable contrast is
what to report, not the number:

- **`cloneWorld` is 2–7% of a tick.** Snapshotting is nearly free relative to simulating.
- **Tick cost varies 2.3x across arenas** (61 µs to 144 µs), tracking arena size and entity
  count.
- **An 8-frame rollback is roughly 0.5–1.2 ms of a 16.7 ms budget.** The conclusion the
  earlier draft drew survives; its arithmetic does not.

Also withdrawn: the claim that arena 0 "reached `win` at tick 698" (unreproducible — driven
to termination it *loses*, at tick 1058–1272 depending on seed), and the claim that `step()`
"early-returns once status is not playing". It does not: `world.ts:242-259` always clones and
increments `draft.tick`, and guards only the stage block.

### Transcendental inventory, re-counted

`grep -nE 'Math\.(sin|cos|atan2|hypot|sqrt|pow|exp|log)\('` over the non-test `.ts` files
under `src/sim/` returns **18 lines / 21 occurrences**:

| function | occurrences | where |
|---|---|---|
| `Math.hypot` | 10 | `ai/targeting.ts` x7, `collision.ts` x2, `bullets.ts` x1 |
| `Math.sqrt` | 4 | `types.ts:150`, `collision.ts:41`, `collision.ts:54`, `ai/targeting.ts:180` |
| `Math.cos` | 3 | `types.ts:172`, `collision.ts:416`, `ai/targeting.ts:626` |
| `Math.sin` | 3 | same three lines |
| `Math.atan2` | 1 | `types.ts:168` |
| `pow`/`exp`/`log` | 0 | — |

(Three lines carry both `cos` and `sin`, which is how 21 occurrences become 18 lines. An
earlier draft said "19 call sites", "sqrt (5)" and "eight AI hypot sites" — all three wrong.)

One AI site already quantizes trig output to a 1e-12 grid — `ai/targeting.ts:626` — but the
comment says it is for a 6-decimal test comparison, **not** for cross-engine determinism, and
it is the only such site.

### Cross-engine floating point is genuinely uncertain

- ECMA-262 recommends but does not require fdlibm for `Math.cos`/`sin`/`tan`.
  > **UNSUPPORTED as cited.** The spec text was not retrieved verbatim (four WebFetch
  > attempts on tc39.es and 262.ecma-international.org returned only the table of contents).
  > Corroborated by search but not by the primary document. Settle it against the ECMA-262
  > PDF, sections 4.4.1 and 21.3.2.
- V8 ships an fdlibm port, and as of a 2026-07-12 measurement `Math.sin/cos/tan/exp/pow/log/
  atan/atan2` do not leak the host OS — **but `Math.tanh` now does**, because V8 commit
  `c1486295ae5` replaced its bundled fdlibm `tanh` with `std::tanh` reading the host libm,
  shipping in Chrome 148
  ([scrapfly.dev/posts/browser-math-os-fingerprint](https://scrapfly.dev/posts/browser-math-os-fingerprint/),
  published 2026-07-12, checked 2026-08-09). That is the guarantee eroding one function at a
  time.
  > **Note:** OS-leakage *within* an engine is not the same question as V8-vs-JSC agreement.
  > This source does not settle the question it is nearest to.
- **Correction:** an earlier draft said "V8 and SpiderMonkey both ship fdlibm ports". Its own
  citation says the opposite of the SpiderMonkey half: Tom Ritter's Firefox intent
  ([groups.google.com/a/mozilla.org/g/dev-platform](https://groups.google.com/a/mozilla.org/g/dev-platform/c/0dxAO-JsoXI/m/eEhjM9VsAgAJ),
  2021-07-23, checked 2026-08-09) states Firefox "currently doesn't use the cross-platform
  fdlibm for Math.cos, Math.sin, and Math.tan" and "chooses to use the local,
  platform-supplied math library", with adoption planned under Resist Fingerprinting and
  Nightly. No primary source was found showing SpiderMonkey ships fdlibm by default today.
- JavaScriptCore's (Safari's) status could not be verified from a primary source.

> **UNSUPPORTED:** "`Math.sqrt` is safe because it is a hardware operation and correctly
> rounded." IEEE 754-2019 does require `squareRoot` to be correctly rounded, and search
> suggests `Math.sqrt` is not in ECMAScript's implementation-approximated set — but the spec
> text confirming ECMAScript binds `Math.sqrt` to IEEE `squareRoot` was not retrieved, and
> "hardware operation" is an implementation detail, not a spec guarantee.

> **UNSUPPORTED:** "`Math.hypot` is not part of the fdlibm set engines converged on." The
> cited measurement neither tests nor mentions `hypot`. Supported by omission only, which is
> not support — and it was the stated justification for a proposed hypot→sqrt rewrite. **Do
> not execute that rewrite on this reasoning.**

### The camera already frames the whole board

`src/render/framing.ts` — `framedBounds` returns `worldWidth + boundary * 2`;
`fitCameraToArea` runs a 40-step bisection on distance with `FRAME_MARGIN = 0.03`, from a
fixed position. **Couch co-op and local versus need zero camera work** — no split-screen, no
dynamic zoom, no follow logic. This is the single strongest argument for doing local modes
first.

### Local versus needs no change to make one player's shell kill the other

`src/sim/bullets.ts:188-202` exempts only `t.id === b.ownerId`, and only while the shell is
still leaving the muzzle. `Bullet` (`types.ts:87-96`) carries an `ownerId` and no team field.

### The single-player assumptions, enumerated

| what | where |
|---|---|
| One player tank by kind | `world.ts:122` (`applyPlayerInput`), `world.ts:216` (`resolveStatus`) |
| Win = every non-player tank dead; lose = player dead, lives exhausted | `world.ts:210-240` |
| Death resets the WHOLE arena via `tanks[i]` ↔ `spawns[i]` index alignment | `world.ts:179-208` |
| One shared lives counter | `World.lives`, `world.ts:26` |
| Exactly one `P` per grid, or a **load-time failure** | `config/validate.ts:257` — `if (players !== 1) fail(file, path, ...)`; `SPAWN_LETTERS` (`config/arena-types.ts:9-17`) defines one player letter |
| Four AI sites take the FIRST player | `ai/brown.ts:15`, `ai/grey.ts:51`, `ai/teal.ts:30`, `ai/targeting.ts:492` — all `world.tanks.find((t) => t.kind === 'player' && t.alive)` |
| One AI site already generalises (it is a loop) | `ai/targeting.ts:159` (`mineThreatensPlayer`) |
| Claim machinery assumes one player spawn | `arena-claims.ts:155` and `:209` (`spawns.find((s) => s.kind === 'player')`) |

**Correction:** an earlier draft cited `arena-claims.ts:281` as a third `find` for the player.
Line 281 is `for (const enemy of spawns.filter((s) => s.kind !== 'player'))` — a filter for
NON-players. Two of the three cited lines carry the quoted code, so the scope word "all" was
wrong. The blocker stands on :155 and :209.

### How far the assumption spreads

Measured by presence of the `'player'` string literal: **23 of 74 non-test `.ts` files** and
**34 of 86 test files** (`find src tools -name '*.ts'` totals 160). Concretely:
`game/loop.ts` holds one mutable `playerId` (:369, :545) used for HUD, stats and audio
attribution; `audio/director.ts:29` picks `cannon` vs `cannon-enemy` off a single id;
`render/entities.ts` keys the player's custom colour and skin on `kind === 'player'` at
**exactly four lines — 405, 411, 437, 693** (an earlier draft also cited :920, which is a
`createSkinTexture(...)` call, not a kind check), so two same-kind tanks would render
identically; `render/aimray.ts:46` draws one aim ray; `game/stats.ts:118` attributes against
one id.

> **Read that as an upper bound, not a work estimate.** Literal presence is a superset of
> "files that must change": it includes comments and `configFor('player')` colour lookups a
> second player need not touch, and it excludes files that only handle `playerId`. The honest
> form is "**at most** 23 of 74".

### `InputState.aim` is a world POINT, and that is a netcode constraint

`types.ts:127-134` — `aim: Vec2`, commented "aim is a world-space ground point"; consumed as
a direction at `world.ts:151` (`vsub(input.aim, player.pos)`); produced at
`input/input.ts:153` by `screenToGround(e.clientX, e.clientY)`, which depends on canvas size.

Two peers with different window sizes therefore produce different aim floats. **The input
must be quantized at the input boundary before the sim consumes it**, or the local player
simulates a different input than the remote peer replays. (The mechanism follows directly
from the shapes read; it has not been built to confirm.)

### Rollback would break audio and particles without event de-duplication

`src/sim/events.ts` is a 10-member union and **no event carries a tick field**
(`grep -n tick src/sim/events.ts` returns nothing). Re-simulating N frames re-emits the same
`SimEvent` stream N times, and consumers are unconditional: `particles.ts` draws a burst at
`ev.pos`, `audio/director.ts:29` plays a sound per event. Keying events on tick + identity is
a design proposal here, not a validated one.

### The pure sim already runs headlessly under Node

`vite.config.ts:20` sets `environment: 'node'`; `tools/baseline/trace.test.ts` imports only
`src/sim/arena` and `src/sim/world`. It runs green — I ran it: `BASELINE
015a5d1745ce2d3a9ca11e150b2874c10b1b8ca6d77988599787e2269fd198e4` in 3.6 s, and the full
suite passes (84 files passed / 1 skipped; 1624 passed / 2 skipped). That is what an
authoritative-server design would need.

### No gamepad code, and one keyboard shared between both key sets

`grep -rni "gamepad"` across `.ts`/`.json`/`.html`/`.mjs` excluding `node_modules` and `dist`
returns zero source hits (3 doc hits, all "out of scope"). And `src/input/input.ts:372-380`
maps **both** WASD and the arrow keys onto one move vector, with a global `preventDefault`
for space and arrow keys at :125-127 — so a second player cannot simply take the arrows
without restructuring key handling.

---

## Infrastructure, if online is ever wanted

| Item | Value | Source | Checked |
|---|---|---|---|
| GitHub Pages is static-only | "Published GitHub Pages sites may be no larger than 1 GB"; "soft bandwidth limit of 100 GB per month"; "soft limit of 10 builds per hour" | [docs.github.com/.../github-pages-limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits) | 2026-08-09 |
| Cloudflare Durable Objects free tier | 100,000 requests/day, 13,000 GB-s/day, SQLite storage backend only; WebSockets supported with the Hibernation API; Workers Paid starts at $5/month | [developers.cloudflare.com/durable-objects/platform/pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) | 2026-08-09 |
| Cloudflare TURN | "$0.05/real-time GB outbound"; "There is a free tier of 1,000 GB before any charges start." | [realtime/turn](https://developers.cloudflare.com/realtime/turn/), [turn/faq](https://developers.cloudflare.com/realtime/turn/faq/) | 2026-08-09 |
| Trystero | MIT; "Peers can connect via BitTorrent, Nostr, MQTT, Supabase, Firebase, IPFS, or a self-hosted WebSocket relay" | [github.com/dmotz/trystero](https://github.com/dmotz/trystero) | 2026-08-09 |
| GGPO | MIT-licensed (since 2019-10-09), "Written in C, C++" | [github.com/pond3r/ggpo](https://github.com/pond3r/ggpo) | 2026-08-09 |

**Caveat on the Pages build limit:** the same page continues, "This limit does not apply if
you build and publish your site with a custom GitHub Actions workflow" — which is exactly
what this repo does (`.github/workflows/pages.yml`). **The 10-builds/hour limit does not bind
this deploy.** The static-only point stands and is the one that matters.

> **UNSUPPORTED:** "GGPO cannot be linked into a browser TypeScript bundle." C++ compiles to
> WebAssembly and no evidence was given that GGPO specifically resists it. The practical
> conclusion — implement the algorithm rather than adopt the library — may still be right,
> but it is asserted, not shown.

> **Folklore, not measurement:** estimates that WebRTC falls back to a TURN relay 15–30% of
> the time. Every figure found was a vendor blog and they disagreed with each other. It
> matters only for costing TURN, and Cloudflare's 1,000 GB free tier makes that negligible at
> hobby scale either way.

Trystero's honest caveat: it substitutes a dependency on third-party public infrastructure
with no SLA for a dependency on infrastructure you own. Its reliability, bundle size, and
behaviour under the `/tanks/` deploy are all unverified.

---

## Blockers

1. **Any online mode requires server infrastructure that does not exist and cannot exist in
   this deploy.** The game ships as a static bundle to GitHub Pages with `base: './'`. WebRTC
   P2P still needs a signalling channel for SDP and ICE exchange, plus STUN/TURN. That is not
   a code problem; it is a decision about who runs and pays for something, and CLAUDE.md's
   own dev-flag doctrine warns against building a feature with no owner and no decision.
2. **The arena validator rejects any grid without exactly one player spawn, at module load**
   (`config/validate.ts:257`). A two-player board is a boot failure. Versus boards also have
   no meaningful notion of "enemy spawn", which is what `structuralFailures` and the
   `sightlineAfterBreach` / `spawnBlockRobust` machinery are built on.
3. **Cross-engine bit-equality is unmeasured, and it gates both lockstep and rollback.** If
   two engines disagree by one ULP on `Math.hypot` or `Math.cos`, peers diverge within
   seconds and no netcode engineering fixes it — the fallback is an authoritative server,
   which is the most expensive of the four designs. No second engine is installed here.
4. **Changing `step()`'s signature risks the project's only behavioural regression guard.**
   `tools/baseline/trace.test.ts:14` calls `step(w, { move, aim, fire, mine })` with a single
   `InputState` and pins the hash at :42. A multi-input refactor either re-records that hash
   — losing the ability to claim the refactor was behaviour-preserving — or must be shaped so
   the one-player path is provably byte-identical. `determinism.test.ts` cannot substitute:
   it asserts self-consistency, which is invariant under behaviour changes.
5. **Local versus on one keyboard is a poor product, and there is no gamepad fallback.** Both
   key sets drive one tank today and arrows/space are `preventDefault`ed globally.

---

## Open questions

1. **Do Chrome, Firefox and Safari (desktop and iOS) produce a bit-identical baseline trace
   hash?** Run the extracted trace body in each and compare against
   `015a5d1745ce2d3a9ca11e150b2874c10b1b8ca6d77988599787e2269fd198e4`. If all match, lockstep
   and rollback are both live options. If they diverge, either quantize the sim's 18
   transcendental lines (bounded) or abandon peer-deterministic netcode for an authoritative
   Node server. **This is THE gating measurement and nothing else should be decided before
   it.** Practical note: Playwright ships Linux WebKit (JavaScriptCore) and Firefox
   (SpiderMonkey) builds — but it is not a dependency of this repo, and its WebKit is not
   identical to shipped Safari, so the iOS half stays open regardless.
2. **Should a second player be a new `TankKind` (`'player2'`) or a new field on `Tank`
   (e.g. `controlledBy`)?** Prototype both far enough to count touched files. The `TankKind`
   route gets compiler help — a new kind is a compile error until `TANK_KINDS` lists it,
   which forces a `tank-defs.json` entry and hands the renderer a distinct colour via
   `configFor(kind).color`. The field route avoids editing four AI files and the spawn-letter
   table, but the compiler will not walk you through the sites. The count of files each
   forces you to visit is the deciding number.
3. **What are win and lose in co-op, and in versus?** A product decision. Co-op: is
   `world.lives` shared or per-player? Does one death reset the whole arena as it does today
   (`world.ts:179-208`), or does the survivor play on? Versus: `resolveStatus` defines a win
   as "every non-player tank dead" and the HUD shows "Enemies remaining" — neither has
   meaning with no AI enemies. **Write the rule down before touching `resolveStatus`**,
   because the current implementation encodes exactly one answer.
4. **How do the arena `claims` and `structuralFailures` rules generalise past one player
   spawn?** With two spawns, "no enemy sees the player spawn" becomes a cross product; on a
   versus board with zero AI it becomes vacuous, which is the failure mode CLAUDE.md warns
   about most. Also decide whether two player spawns must not see each other at round start.
5. **Which netcode: lockstep, rollback, or authoritative snapshots?** Downstream of the
   determinism probe plus one latency decision. Rollback is the natural fit — save-states are
   free — but it needs `SimEvent` de-duplication across re-simulated ticks, new machinery
   touching all five event consumers. Lockstep is far simpler and adds input delay, which
   co-op tolerates and versus does not. Prototype rollback against a fake 100 ms link first.
6. **Who owns and pays for signalling?** Cheapest path you control: Cloudflare Workers +
   Durable Objects. Cheapest path you do not: Trystero over public relays — no server, no
   bill, no SLA. **There is also a genuinely zero-infrastructure option worth pricing first:
   manual SDP copy-paste ("send this code to your friend"), which works on the current static
   deploy today** and would let an online prototype be built and measured before anyone signs
   up for anything.
7. **Does the shared apex-domain origin create a problem for online state?** Before storing a
   room code, peer identity or signalling token, check whether it lands in the localStorage
   namespace shared across `austinorphan.com` project pages, and check the deployed `/sw.js`
   scope.

---

## What a first PR would be

**Make `step` accept an input LIST without moving the golden trace.** This is the keystone
change for all four modes, and it can land alone and *provably* behaviour-preserving: add
`step(world, inputs: InputState[])` with `applyPlayerInput` iterating players in tank-array
order, keep a one-argument adapter, and assert the pinned hash
`015a5d17…` is **unchanged**. That assertion is the entire point — it is the one test that
can prove the refactor did not alter single-player behaviour, and CLAUDE.md is explicit that
`determinism.test.ts` cannot.

Size: **M** — `src/sim/world.ts` plus every caller. Biggest unknown: how many of the 34 test
files mentioning `'player'` construct an `InputState` positionally and break on the signature.

Other PR-able items, filed as issues alongside this document: gamepad support behind
`?dev=1&gamepad=1`; a browser-side trace harness that prints the baseline hash from a real
browser (which builds the rig the determinism question needs); and correcting CLAUDE.md's
localStorage key count from four to five.

**Deliberately NOT proposed as a PR:** replacing `Math.hypot` with `Math.sqrt(x*x + y*y)`.
The case for it rests on an uncited spec claim about `Math.sqrt` and an inference from a blog
post that never mentions `hypot`. Read ECMA-262 §21.3.2 first.
