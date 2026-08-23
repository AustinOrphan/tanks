---
status: active
date: 2026-08-23
last-reviewed: 2026-08-23
scope: Spike -- should `src/sim/` be Rust compiled to WASM?
implementation-issues: []
implementation-prs: []
supersedes: []
superseded-by: []
---
# Spike: should `src/sim/` be Rust compiled to WASM?

**Raised 2026-08-10**, alongside the cross-engine determinism issue.

**The question:** should the deterministic core be rewritten in Rust and compiled to WASM?

**Why it is live now.** Two things it would buy, both real. Rust + WASM gives
**bit-identical arithmetic across platforms**, and it is worth being exact about the
mechanism rather than waving at "WASM is deterministic". Two separate reasons combine:
WASM's core `f32`/`f64` arithmetic (add, sub, mul, div, sqrt) is specified as IEEE-754 and
correctly rounded, so it cannot vary by engine; and WASM has **no transcendental
instructions at all** — `sin`, `cos`, `atan2`, `hypot` would come from Rust's `libm`
compiled *into the module*, so every peer executes the same compiled implementation rather
than whatever their JS engine ships. It is the second reason that does the work here, and
it is exactly the property the 21 transcendental occurrences in `src/sim/` do not have
today (measured 2026-08-10 and re-measured after #128: 18 lines,
21 occurrences, 4 files — `collision.ts`, `types.ts`, `ai/targeting.ts`, `bullets.ts`; 10
`hypot`, 4 `sqrt`, 3 `cos`, 3 `sin`, 1 `atan2` — unchanged by the step-inputs refactor).
Note what that means precisely: it is the *specification* that does not guarantee
agreement. Three JS engines have since been measured agreeing anyway, which the first
bullet below takes up. And it opens a **native path** — the same
crate could back a Steam or console build without a JS engine, which
`docs/research/console-release.md` records as the blocker CrossCode solved by AOT-compiling
JS to C++.

**What it would cost is the thing to weigh, and it is not small.** `src/sim/` is the part
of this codebase that already works. Rewriting it discards, or forces a re-derivation of:
the golden trace (`tools/baseline/trace.test.ts`, 4 arenas × 6 seeds × 2500 ticks), the
two-cell-size decomposition guarantees (`decomposition.test.ts`), the purity guard and its
meta-test (`purity.test.ts`), the arena claim runner (`arena-claims.ts`), and the config
catalog's load-time validation — plus every sim-side unit file. It also puts a
serialisation boundary between the sim and its five event consumers, where today
`SimEvent[]` is a plain array.

**What would answer it:**

- **First, whether the cheap fix is even needed — and the answer has moved since this
  spike was drafted.** It read "that measurement is issue #121"; #121 closed with #128,
  which built the rig AND ran it. Chromium 151 (V8), firefox 153 (SpiderMonkey) and
  Playwright's webkit (JSC) each printed the pinned
  `015a5d17…`, matching Node, with the 21 transcendental occurrences **untouched**. So the
  arithmetic argument for Rust is not merely unproven, it is running against a
  three-engine agreement — since extended by the engines matrix and PR #168's legs to
  shipped Safari, iOS WebKit (Simulator) and arm64, all matching (see the multiplayer
  spike's gating bullet above). Still one sampled trajectory, not a proof about
  `Math.hypot`; the sole unmeasured runtime is a physical iOS device.
  The replacement work was issue #133, now closed: `src/sim/math/` vendors fdlibm's
  sin/cos/atan2 and V8's own hypot formula, and `VENDORED_ANGLE_HASH`
  (`tools/baseline/angles.ts`) measured chromium, firefox and webkit agreeing bit-for-bit
  on all of them, in JS, with no rewrite. **That closes the arithmetic argument for a
  native/WASM rewrite on the engines it measured** — the divergence a rewrite would have
  existed to fix is gone at the JS layer. The residual is the same one #128 left: shipped
  Safari, iOS and any ARM engine are still unmeasured by anything in this repo.
- **Second, whether multiplayer is actually being built.** Bit-identical arithmetic is
  worth a rewrite only if lockstep netcode is a commitment rather than an interest. See the
  multiplayer spike above — its gating measurement is the same one, and is half answered.
- **Third, whether a native release is a commitment.** `docs/research/console-release.md`
  concludes Switch/PlayStation are gated on NDA'd developer status and Steam is unblocked
  but not close. If no native target is committed, the second reason is hypothetical too.
- If both answers are yes, price it against a **strangler route** rather than a rewrite:
  port one leaf module (`collision.ts` is the smallest with real arithmetic) behind the
  existing TS interface, and check the golden trace hash is unchanged. If the hash cannot
  be held across the boundary for one module, it will not be held for the whole core, and
  that is the cheapest possible falsification.

**Constraint that shapes any answer:** the golden trace is the only thing that can tell you
a sim rewrite preserved behaviour. `determinism.test.ts` cannot — it asserts
self-consistency, which is invariant under behaviour change (CLAUDE.md says so, with a
worked mutation). Any port plan that does not carry the trace forward is unfalsifiable.

**Not scheduled.** Recorded because "rewrite the sim in Rust" is the kind of idea that
recurs, and the case against it — that it discards the one subsystem with no known defects
— should not have to be re-argued from scratch each time.

---
