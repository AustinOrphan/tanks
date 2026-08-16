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
point across Chrome, Firefox and Safari — was UNMEASURED when this was written.** It is now
CLOSED at the function level for the sim's own call sites, updated 2026-08-14: PR #165
(issue #133, merged `ac981b4`) vendors fdlibm's sin/cos/atan2 and V8's own hypot formula into
`src/sim/math/`, migrating all 17 of the sim's former native transcendental call sites
(`Math.sqrt`'s 4 sites stay native — ES2025 correctly-rounded, unaffected). `VENDORED_ANGLE_HASH`
(`a4fdbbfb32debaae48844ba04f7492a55d9a03e53ada569f12c2ee344cd95aed`) matched on all **9** OS×
engine legs of the post-merge engines matrix — chromium 151, firefox 153 and Playwright webkit
(JSC), each on ubuntu x86-64, macos-latest arm64 and windows (run `31842261852` at `ac981b4`,
recorded in issue #133's closing comment). See the update under "Cross-engine floating point is
genuinely uncertain" and open question 1 below for the full measurement. The native functions
themselves still do NOT agree cross-engine — unchanged, see below — the sim just no longer
depends on them. Still open: shipped Safari and iOS remain untested by any of this (open
question 1's residual), and two sim-boundary items #165 deliberately left untouched —
`InputState.aim`'s canvas-size-dependent quantization and `SimEvent`'s missing tick field for
rollback de-duplication (both unchanged since this doc was first written, see Blocker 3's
update below) — are now the actual frontier of the determinism work.

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

> **Historical count, pre-#165, superseded 2026-08-14.** This inventory describes the tree
> before PR #165 (issue #133, merged `ac981b4`) vendored the math — the counts and the "these
> are native `Math.*` calls" framing no longer describe `src/sim/`. Post-migration,
> `grep -rn "Math\.\(sin\|cos\|atan2\|hypot\)\b" src/sim --include="*.ts"` excluding
> `.test.ts` files and `src/sim/math/` itself (which legitimately names them in comments and
> spot-value tests against the Node oracle) returns **zero** hits: all 17 occurrences on the
> 14 non-sqrt lines above now call `detSin`/`detCos`/`detAtan2`/`detHypot` from
> `src/sim/math/`. The 4 `Math.sqrt` lines are unchanged and still native. The quantization
> note immediately above still holds unchanged — same site, same 1e-12 grid, now sourced from
> `detCos`/`detSin` rather than `Math.cos`/`Math.sin`.

### Cross-engine floating point is genuinely uncertain

- ECMA-262 recommends but does not require fdlibm for `Math.cos`/`sin`/`tan`.
  > **SUPPORTED, retrieved verbatim 2026-08-12.** Two more WebFetch attempts this session, both
  > against this same URL, hit the same wall as before — the tool's summarizing model returned
  > only the multipage table of contents and reported the body "truncated due to length" (six
  > failed direct attempts at this section's text across two sessions now: four before this
  > one, two here). A third WebFetch this session, against the multipage INDEX page rather
  > than the section itself, was a discovery probe for a working link and also returned only a
  > summary of the table of contents — not counted in the six above, since it never targeted
  > the section text. A direct `curl` of the same URL, parsed by hand, retrieved the clause.
  > ECMA-262 §21.3.2 "Function Properties of the Math Object" is
  > byte-identical between the ratified ES2025 edition (16th edition, ratified 2025-06-25)
  > (https://262.ecma-international.org/16.0/index.html#sec-function-properties-of-the-math-object)
  > and the current living draft
  > (https://tc39.es/ecma262/multipage/numbers-and-dates.html#sec-function-properties-of-the-math-object,
  > self-titled "ECMAScript® 2027 Language Specification" at retrieval), both retrieved
  > 2026-08-12. Quoted in full:
  >
  > > The behaviour of the functions acos, acosh, asin, asinh, atan, atanh, atan2, cbrt, cos,
  > > cosh, exp, expm1, hypot, log, log1p, log2, log10, pow, random, sin, sinh, tan, and tanh
  > > is not precisely specified here except to require specific results for certain argument
  > > values that represent boundary cases of interest. For other argument values, these
  > > functions are intended to compute approximations to the results of familiar
  > > mathematical functions, but some latitude is allowed in the choice of approximation
  > > algorithms. The general intent is that an implementer should be able to use the same
  > > mathematical library for ECMAScript on a given hardware platform that is available to C
  > > programmers on that platform.
  > >
  > > Although the choice of algorithms is left to the implementation, it is recommended (but
  > > not specified by this standard) that implementations use the approximation algorithms
  > > for IEEE 754-2019 arithmetic contained in fdlibm, the freely distributable mathematical
  > > library from Sun Microsystems (http://www.netlib.org/fdlibm).
  >
  > `sin`, `cos`, `tan` and `atan2` are all named in that first sentence's implementation-
  > approximated list (so is `hypot`, see below); `sqrt` is not (see the next flag).
  > "Recommends but does not require" is now the primary document's own wording, retrieved
  > rather than paraphrased.
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

> **SUPPORTED (spec + measurement), retrieved/measured 2026-08-12.** "Hardware operation"
> was, and remains, the unsupported part — the spec makes no claim about hardware, and this
> discharge does not resurrect it. Two independent legs now stand in its place:
>
> **Spec leg.** The §21.3.2 note quoted above lists 23 functions as implementation-
> approximated (counted from the quote above: acos, acosh, asin, asinh, atan, atanh, atan2,
> cbrt, cos, cosh, exp, expm1, hypot, log, log1p, log2, log10, pow, random, sin, sinh, tan,
> tanh); `sqrt` is not one of them. Its own clause, ES2025 §21.3.2.33
> (https://262.ecma-international.org/16.0/index.html#sec-math.sqrt, byte-identical in the
> current tc39.es living draft, both retrieved verbatim 2026-08-12), reads in full:
>
> > This function returns the square root of x.
> >
> > It performs the following steps when called:
> > 1. Let n be ? ToNumber(x).
> > 2. If n is one of NaN, +0𝔽, -0𝔽, or +∞𝔽, return n.
> > 3. If n < -0𝔽, return NaN.
> > 4. Return 𝔽(the square root of ℝ(n)).
>
> Step 4 takes ℝ(n) — the EXACT real-number square root — and converts it through 𝔽, the
> spec's "Number value for" operator, defined (ES2025 §6.1.6.1,
> https://262.ecma-international.org/16.0/index.html#number-value-for, retrieved verbatim
> 2026-08-12) as choosing the closest representable double to the exact value, ties broken to
> the even significand: round-to-nearest, ties-to-even, applied to the true mathematical
> result. That is the textbook definition of "correctly rounded" — established by reading the
> primary document's own two clauses together, not inferred from a blog, even though the
> literal phrase "correctly rounded" appears in neither.
>
> **Measured leg.** `tools/baseline/angles.ts` (PR #160, commit `87d9855`) swept `sqrt` as a
> control band — 2,000 samples spanning denormal-to-near-overflow magnitudes — across
> Node/V8, chromium 151 (V8), firefox 153 (SpiderMonkey) and Playwright's webkit
> (JavaScriptCore, Linux build): all four produced the same sqrt sub-hash, the only one of
> the five functions swept (sin, cos, atan2, hypot, sqrt) that did not diverge. See
> `tools/baseline/angles.ts`'s module header ("MEASURED" paragraph) and [issue #133's
> comment](https://github.com/AustinOrphan/tanks/issues/133#issuecomment-5275673368).

> **PARTIALLY DISCHARGED, updated 2026-08-12.** The fdlibm-history claim — "not part of the
> fdlibm set engines converged on" — stays UNVERIFIED: no primary source for fdlibm's own
> hypot history was retrieved this session either, and the cited 2026-07-12 scrapfly
> measurement still neither tests nor mentions `hypot`. Supported by omission only is still
> not support.
>
> But that historical question turns out to be orthogonal to what this doc actually needs,
> which is whether `hypot` is safe to assume portable, not why it might not be. PR #160
> (`tools/baseline/angles.ts`, commit `87d9855`) measured portability directly: 2,000 pairs
> spanning denormal-to-near-overflow magnitudes, hashed over exact float64 bits, across
> Node/V8, chromium 151 (V8), firefox 153 (SpiderMonkey) and Playwright's webkit
> (JavaScriptCore, Linux build). Result: hypot diverges THREE-WAY — chromium, firefox and
> webkit each produced a distinct sub-hash, and only Node and chromium agreed with each other
> (verified at the full 64-hex-digit hash, not the runner's truncated print). See
> `tools/baseline/angles.ts`'s module header and [issue #133's
> comment](https://github.com/AustinOrphan/tanks/issues/133#issuecomment-5275673368).
>
> **Do not execute the proposed hypot→sqrt rewrite on the fdlibm-history reasoning — it is
> still unverified — but the measured three-way divergence is now an independent, sufficient
> reason `Math.hypot` cannot be assumed portable as written.**

**This section's uncertainty is no longer only hypothetical — PR #160 (commit `87d9855`)
measured it directly.** `tools/baseline/angles.ts` runs a deterministic, exact-bit-input
sweep of the sim's five transcendental functions (sin, cos, atan2, hypot, sqrt) across five
magnitude bands, hashed over raw float64 bits, in Node/V8, chromium 151 (V8), firefox 153
(SpiderMonkey) and Playwright's webkit (JavaScriptCore, Linux build, UA-spoofed as macOS
Safari). Measured (`npm run trace:browser -- --all`, this checkout, verified twice —
implementer then adjudicator, hashes matched verbatim): chromium (`6fb1a390…`), firefox
(`01c09fbb…`) and webkit (`702a88b5…`) each produce a hash distinct from Node's pinned
`ANGLE_HASH` (`d5d81535…`) and from each other. sin/cos disagree pairwise across all three
browser engines on every band swept, including ±2π — the same order of magnitude the golden
trace itself already samples. atan2 splits two camps (chromium ≡ webkit, firefox ≡ Node);
hypot disagrees three-way (Node ≡ chromium only, per the flag above). sqrt — the control, the
one function ES2025 specifies as correctly rounded (see the flag above) — agreed across all
four runtimes, which is what makes the rest of this a measurement of sin/cos/atan2/hypot
rather than a broken harness.

**The lattice caveat, so this is not overclaimed:** the golden trace (`BASELINE_HASH`) still
agrees on all three browser engines (open question 1, below). Instrumented across all 5
shipped arenas × 6 seeds × 2500 ticks, neither `bodyAngle` nor `turretAngle` ever exceeds
5.81 rad / 5.19 rad — inside `angles.ts`'s own smallest reachability band (±2π) — and
gameplay visits a sparse, structured lattice of angle values within it that happens to miss
the inputs where sin/cos/atan2/hypot diverge. So the trace's three-engine agreement is a
lattice artifact of what gameplay happens to sample, not evidence the functions themselves
agree; that is exactly what this measurement now shows directly instead of leaving inferred.
Sim-LEVEL divergence — an actual replay desyncing a peer — remains unobserved; #160 measured
the functions, not gameplay. See `tools/baseline/angles.ts`'s module header for the full
derivation and [issue #133's
comment](https://github.com/AustinOrphan/tanks/issues/133#issuecomment-5275673368) for the
write-up.

> **RESOLVED for the sim's own math, 2026-08-14** (PR #165, issue #133 closed). The
> uncertainty this whole section documents was real, and the sharpest single fact for it comes
> from the post-merge engines matrix itself (run `31842261852` at `ac981b4`,
> `.github/workflows/engines.yml`, PR #164, per issue #133's closing comment): on that one run,
> **webkit's native angle hash was three different values across the three OSes it ran on**
> (ubuntu x86-64, macos-latest arm64, windows), and firefox split on the arm64 leg too — native
> math cannot agree even within one engine family across platforms, let alone across engines.
>
> The sim no longer depends on any of it. `src/sim/math/` ports netlib fdlibm's sin/cos/atan2
> — cross-checked against V8's own historical `branch-heads/13.6` copy, since this repo's Node
> (v24.15.0, V8 13.6) still runs classic fdlibm while current chromium has migrated `sin`/
> `cos`/`atan2` to LLVM-libc (see the plan at
> `docs/superpowers/plans/2026-08-14-vendored-math.md`) — plus V8's own Torque `hypot`
> formula, wired at all 17 of the sim's former native call sites (`Math.sqrt`'s 4 sites stay
> native, ES2025 correctly-rounded, measured agreeing everywhere above). Two headline
> measurements, each taken twice (implementer then adjudicator, re-derived from scratch):
> the port is bit-identical to Node-native (0 mismatches of 17,500 sin samples, 17,500 cos,
> 3,026 atan2; 0 ULP over 2,000 hypot pairs), so the golden trace's `BASELINE_HASH`
> (`324aa9b5…`) did **not** move; and `VENDORED_ANGLE_HASH`
> (`a4fdbbfb32debaae48844ba04f7492a55d9a03e53ada569f12c2ee344cd95aed`) matched on all **9**
> legs of that same matrix run — chromium 151, firefox 153 and Playwright webkit (JSC), each
> on ubuntu/macos-arm64/windows.
>
> `npm run trace:browser -- --all` now fails on a vendored-hash mismatch, unlike a native
> `ANGLE_HASH` mismatch, which stays structural and unfixable and is left reporting-only; the
> engines matrix re-runs both on every push to `main`, weekly, and on demand, so a regression
> cannot land silently. The historical flags and measurements above are the record that
> justified doing this work and are left in place, not deleted. Not covered by any of this:
> shipped Safari and iOS, still untested by anything here (see open question 1's residual,
> below).

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

   > **Updated 2026-08-12** (PR #160, commit `87d9855`, issue #133). The "if" in this
   > blocker's second sentence is no longer hypothetical for the functions themselves:
   > chromium, firefox and webkit disagree on both `Math.hypot` (three-way) and `Math.cos`
   > (pairwise, on every band swept). See "Cross-engine floating point is genuinely
   > uncertain" above and `tools/baseline/angles.ts`. What is still unmeasured is the
   > SIM-level consequence — no divergent input has been shown to reach a real replay,
   > because the golden trace's sampled lattice never leaves the smallest band. **The
   > blocker stands**: "unmeasured" now means unmeasured at the gameplay level specifically,
   > not at the function level generally.
   >
   > **RESOLVED for the sim's own math, 2026-08-14** (PR #165, issue #133 closed). The sim no
   > longer calls native `Math.hypot`/`Math.cos` (or `sin`/`atan2`) anywhere: `src/sim/math/`
   > vendors fdlibm's sin/cos/atan2 and V8's own hypot formula, all 17 former call sites
   > migrated, and `VENDORED_ANGLE_HASH`
   > (`a4fdbbfb32debaae48844ba04f7492a55d9a03e53ada569f12c2ee344cd95aed`) matched on all 9 legs
   > of the post-merge engines matrix (run `31842261852` at `ac981b4`) — see the resolution
   > note under "Cross-engine floating point is genuinely uncertain" above. **This blocker no
   > longer applies to the sim's transcendental math**, gameplay-level or function-level; the
   > "if two engines disagree by one ULP" premise in this blocker's first sentence cannot
   > happen at these 17 sites any more, by construction (both engines run the same JS, not
   > two different native libms).
   >
   > **What replaces it as the actual frontier of the determinism work** is two sim-boundary
   > items #165 explicitly left untouched, both unchanged since this doc was first written and
   > both recorded in the multiplayer spike in `docs/superpowers/backlog.md`: `InputState.aim`
   > is a world-space point produced by unprojecting a mouse position against the ground plane
   > (`input/input.ts:153`), so it depends on canvas size — it must be quantized at the input
   > boundary before the sim consumes it, or two peers with different window sizes simulate
   > different inputs (see "`InputState.aim` is a world POINT" above; unbuilt, not yet
   > confirmed). And `SimEvent` (`src/sim/events.ts`) still carries no tick field, so
   > re-simulating N frames under rollback re-emits the same event N times into five
   > unconditional consumers (see "Rollback would break audio and particles" above); keying
   > events on tick + identity remains a design proposal, not validated.
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
   `015a5d1745ce2d3a9ca11e150b2874c10b1b8ca6d77988599787e2269fd198e4` *(the 4-arena
   baseline of this question's writing; the pin has been `324aa9b5…` since arena-05
   landed, and the comparison below predates that move)*. If all match, lockstep
   and rollback are both live options. If they diverge, either quantize the sim's 18
   transcendental lines (bounded) or abandon peer-deterministic netcode for an authoritative
   Node server. **This is THE gating measurement and nothing else should be decided before
   it.**

   > **PARTIALLY ANSWERED 2026-08-10** (issue #121). The rig exists —
   > `npm run trace:browser -- --all`, which serves `tools/baseline/page.html` and runs
   > `tools/baseline/trace.ts` under Playwright. Measured here, one run each:
   > **chromium 151.0.7922.34 (V8), firefox 153.0 (SpiderMonkey) and Playwright's webkit
   > (JavaScriptCore, `Version/26.5`) all printed `015a5d17…`** — identical to the Node
   > baseline. Playwright 1.62.0, Linux x86-64, headless, `--all`.
   >
   > **What that does NOT settle**, and the reasons are separate: Playwright's WebKit is a
   > Linux build of JSC and is not shipped Safari (its UA even claims macOS — read it as
   > "JSC agrees", not "Safari agrees"); no iOS engine was involved; every run was
   > x86-64, so ARM is untested; and agreement on one sampled trajectory is evidence
   > about the code paths that trajectory exercises, not a proof about `Math.hypot`
   > generally. The Safari/iOS half is now a task with a known method — open the page on
   > the device — rather than an unknown.
   >
   > **Further measured 2026-08-12** (PR #160, commit `87d9855`, issue #133). "Not a proof
   > about `Math.hypot` generally" turned out to be exactly right, and it is no longer only a
   > caveat — `tools/baseline/angles.ts` tested the general claim directly, on the same three
   > engines, and it fails: chromium (`6fb1a390…`), firefox (`01c09fbb…`) and webkit
   > (`702a88b5…`) produced three MUTUALLY DISTINCT hashes on a dense transcendental sweep,
   > none matching Node's `d5d81535…`. sin/cos disagree pairwise on every magnitude band
   > swept, including ±2π; atan2 splits chromium ≡ webkit vs firefox ≡ Node; hypot disagrees
   > three-way (Node ≡ chromium only). sqrt — ES2025's one correctly-rounded function, see
   > the flags above — agreed across all four, which is the harness's own validity check.
   > The golden trace's agreement is a LATTICE ARTIFACT: instrumented across all 5 arenas × 6
   > seeds × 2500 ticks, `bodyAngle`/`turretAngle` never exceed 5.81/5.19 rad — inside
   > `angles.ts`'s own smallest band — and gameplay's sampled inputs within that band happen
   > to miss where the functions diverge. **So this question's headline answer is now more
   > precise: YES for this one sampled trajectory, NO for the underlying functions in
   > general** — the gate this doc opened with ("bit-identical floating point... was
   > UNMEASURED") is now answered at the function level, and the answer is divergence, not
   > agreement. See `tools/baseline/angles.ts`'s module header and [issue #133's
   > comment](https://github.com/AustinOrphan/tanks/issues/133#issuecomment-5275673368).
   >
   > **ANSWERED, 2026-08-14** (PR #165, issue #133 closed). For the sim's own shipped math
   > path the answer is now **YES**: `VENDORED_ANGLE_HASH`
   > (`a4fdbbfb32debaae48844ba04f7492a55d9a03e53ada569f12c2ee344cd95aed`) matched across all 9
   > legs of the post-merge engines matrix — chromium 151, firefox 153 and Playwright webkit
   > (JSC), each on ubuntu x86-64, macos-latest arm64 and windows (run `31842261852` at
   > `ac981b4`, per issue #133's closing comment) — while that same run's NATIVE angle bands
   > still disagree: webkit alone produced three different hashes across the three OSes, and
   > firefox split on arm64. The golden trace's `BASELINE_HASH` (`324aa9b5…`) stayed unchanged
   > across all 9 legs too, since the port is bit-identical to the Node/V8-13.6 fdlibm it was
   > pinned under. The standing residual is unchanged in kind, only narrower: shipped Safari
   > and iOS are still untested by any of this — the macOS webkit legs above are the closest
   > proxy measured so far but are not shipped Safari — take that remainder by opening
   > `tools/baseline/page.html` by hand on the device.
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

   > **ANSWERED for co-op, 2026-08-15** (docs/superpowers/plans/2026-08-15-coop-semantics.md).
   > `world.lives` is a single SHARED pool, drained per player death rather than
   > per-death-event-reset. `resetArena`'s whole-board reset (repositioning every tank,
   > restoring every wall, clearing world-level bullets/mines/blasts) is deliberately NOT
   > reused for a mid-round coop death — it would erase a live partner's fight. A new
   > per-tank `stepRespawns` revives only the corpse, at its own `spawns[idx]` cell,
   > `RESPAWN_DELAY_TICKS` later, leaving everything else — enemies, wall damage, the
   > partner's live ordnance — untouched; a `RESPAWN_SHIELD_TICKS` damage-immune span
   > stands in for what `resetArena` used to guarantee safe. `resolveStatus` is a
   > guard-first split on `countPlayerTanks(world) >= 2`: the single-player body is
   > untouched below the guard, and the coop branch (`resolveStatusCoop`) is a
   > self-contained shared-pool rule, refined one step further than "a run must not end
   > while the partner is alive" — a run ends only once nobody is standing AND no
   > already-scheduled respawn is still owed (`pendingRespawn`, not the pool alone: a
   > respawn paid for on an earlier tick must be honored even if a later, different death
   > drains the pool to 0 first). Versus remains UNANSWERED — this plan's shared-pool
   > design assumes AI enemies stay the only opposing side; what `world.lives` means, or
   > what a win is, with zero AI on the board is a separate decision this plan does not
   > make.
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
`determinism.test.ts` cannot. *(This refactor has since SHIPPED exactly as described —
`stepInputs(world, inputs)` with the one-line `step` adapter, hash-proven; CLAUDE.md's
"the step boundary takes a LIST" section is the record. The pin it held unchanged was
this 4-arena hash; the current 5-arena pin is `324aa9b5…`.)*

Size: **M** — `src/sim/world.ts` plus every caller. Biggest unknown: how many of the 34 test
files mentioning `'player'` construct an `InputState` positionally and break on the signature.

Other PR-able items, filed as issues alongside this document: gamepad support behind
`?dev=1&gamepad=1`; a browser-side trace harness that prints the baseline hash from a real
browser (which builds the rig the determinism question needs); and correcting CLAUDE.md's
localStorage key count from four to five.

**Still not proposed as a PR — but both of this paragraph's original grounds are now resolved
above rather than open, so the reasoning that stands has changed.** The spec claim is no
longer uncited: ES2025 §21.3.2.33 is quoted in full at the `Math.sqrt` flag above. The
blog-inference problem is gone too — the `Math.hypot` flag above measured it diverging
three-way directly, stronger evidence against `hypot`'s portability than anything cited here
originally. That measurement could read as strengthening the case FOR the rewrite; it does
not, for a reason neither original ground touched: `Math.sqrt(x*x + y*y)` is not the same
computation as `Math.hypot(x, y)`. `x*x + y*y` overflows to `Infinity` before `sqrt` ever
runs, at magnitudes where `hypot` scales internally to avoid exactly that (see
`tools/baseline/angles.ts`'s `MAGNITUDE_DECADES` comment, which exists for this reason), and
nothing measured here checked what `sqrt(x*x + y*y)` itself returns, cross-engine, at the
sim's own coordinate scale — only that bare `sqrt` is portable in general and bare `hypot` is
not. **Read ECMA-262 §21.3.2 first, and then measure the substitute FORMULA itself before
proposing this as a PR** — `sqrt`'s portability does not transfer to a different expression
just because `sqrt` appears in it.

> **Superseded, 2026-08-14.** This whole caution was about a specific naive substitute —
> `Math.sqrt(x*x + y*y)` in place of `Math.hypot` — and that substitute was never built. PR
> #165 (issue #133) took a different route that sidesteps the overflow hazard this section
> warns about entirely: it vendors V8's own `hypot` formula (the scaled `max`+`sqrt` Torque
> implementation, which avoids the `x*x + y*y` overflow by construction) rather than
> approximating one. `detHypot` replaced all 10 of the sim's `Math.hypot` call sites, measured
> bit-identical to Node-native (0 ULP over 2,000 pairs) and cross-engine (`VENDORED_ANGLE_HASH`
> on 9 legs, see above). The naive-substitute question this section asks is moot for the sim;
> it may still be worth reading as a general caution against that specific shortcut elsewhere.
