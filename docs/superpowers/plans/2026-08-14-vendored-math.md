# Plan — Issue #133: vendored deterministic math

Status: adopted 2026-08-14, implemented in the PR that carries this file.

Provenance: an option-comparison pass over three candidate ports ((a) netlib fdlibm,
(b) @stdlib's JS port, (c) transliterating V8's own fdlibm) against this repo's real
Node (v24.15.0, V8 13.6.233.17-node.48) as the validation oracle, adjudicated and
merged into (a)+(c): port netlib.org's canonical fdlibm text, cross-checked
structurally against V8's own historical `branch-heads/13.6` copy of the same
algorithm. The plan below is reproduced verbatim from the adjudicated version handed
to the implementer; the PR body carries what was actually measured against it
(the bit-compare mismatch counts, the golden-trace outcome, the cross-engine
hashes, the two verified V8-vs-netlib deltas found during the cross-check step this
plan calls for).

---

## Option comparison (10 lines)

**(a) netlib fdlibm**, **(b) @stdlib JS port**, **(c) transliterate V8's fdlibm** — investigated all three; picked a merged **(a)+(c)**: port netlib.org's canonical fdlibm text (8 files individually fetched, license verified), cross-checked structurally against V8's own historical copy.

**(c) as literally stated is refuted by direct evidence.** V8's `main` (chromium ~151-class) no longer contains fdlibm for `sin`/`cos`/`atan2`/`atan` — commits dated 2026-05-11 through 2026-05-22 ("Implement non-glibc Math.{cos,sin}() using LLVM's libm", "Implement Math.{atan,atan2}() using LLVM's libm") moved them to `LIBC_NAMESPACE::shared::*`, delegating to a pinned `third_party/llvm-libc` dependency (confirmed via DEPS). That implementation is a *harder* port (double-double/Dekker arithmetic, extra tables, ~211 lines for `sin` alone vs. fdlibm's ~977 total for sin+cos+atan2) and is <3 months old — not the free oracle the issue assumed for *today's* chromium.

**But a real, better-targeted oracle exists**: this repo's own Node (v24.15.0, V8 13.6.233 — measured directly) predates that migration; fetching V8 `branch-heads/13.6`'s `ieee754.cc` confirms it still runs classic inline fdlibm (`__kernel_sin`, `__ieee754_rem_pio2`, matching netlib byte-for-byte in structure). `BASELINE_HASH`/`ANGLE_HASH` are asserted under **vitest on Node**, not chromium — so the operationally relevant oracle is Node-native, not chromium-native, and a faithful classic-fdlibm port is likely (not certain — must be measured) to reproduce it bit-for-bit inside the golden trace's ±5.81 rad range. This also explains PR #160's odd "chromium ≠ Node" on `atan2` despite both being "V8": version skew across the same migration.

**(b) @stdlib** rejected: same non-match-any-native profile as (a), plus provenance-audit burden (unclear fdlibm lineage) and no size/complexity advantage once fdlibm's own files were sized. **hypot** is separate in all three options — never in `ieee754.cc` (it's a Torque builtin, `src/builtins/math.tq`, unaffected by the C++ migration, which is why PR #160 found Node≡chromium there) — write it directly as V8's own scaled `max`+`sqrt` formula; no fdlibm needed.

---

# Implementation plan: vendored deterministic math (issue #133)

## Provenance and license

Source text: **netlib.org/fdlibm** (`e_atan2.c`, `s_atan.c`, `s_sin.c`, `s_cos.c`, `k_sin.c`, `k_cos.c`, `e_rem_pio2.c`, `k_rem_pio2.c` — each fetched and sized directly for this plan). All eight carry the identical header:

```
Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.

Developed at SunSoft, a Sun Microsystems, Inc. business.
Permission to use, copy, modify, and distribute this
software is freely granted, provided that this notice
is preserved.
```

Cross-check step (do this before writing the port, not after): fetch `https://chromium.googlesource.com/v8/v8/+/branch-heads/13.6/src/base/ieee754.cc?format=TEXT` (or the matching branch for whatever V8 `node -p process.versions.v8` reports at implementation time) and diff its `__kernel_sin`/`__kernel_cos`/`__kernel_rem_pio2`/`__ieee754_rem_pio2`/`atan`/`atan2` bodies against the netlib text. If V8 silently fixed a bug netlib's public copy still carries, prefer V8's constants/branches for that function and note the delta in the vendored file's header comment. Since this repo has no `LICENSE` yet (#116 pending), the vendored file **must** carry, verbatim, at its top: the Sun Microsystems notice above, a one-line attribution ("Algorithm: fdlibm, netlib.org/fdlibm, cross-checked against V8 src/base/ieee754.cc branch-heads/13.6"), and — only if V8's text was used for any function body verbatim rather than netlib's — V8's own header addendum ("modified... Copyright 2016 the V8 project authors", under V8's top-level BSD-3-clause, "Copyright 2014, the V8 project authors. All rights reserved.").

`hypot` has separate, simpler provenance: V8's `src/builtins/math.tq` `MathHypot` (Torque), 2-arg path: `max = Max(|a|,|b|); return Sqrt((a/max)^2 + (b/max)^2) * max`. This is original V8 code (not fdlibm-derived), Apache/BSD-clean under V8's own license, no Kahan-summation path needed — **all 10 `hypot` call sites in `src/sim` are 2-argument** (grep-verified below), so the N-arg path is out of scope.

## File layout (under `src/sim/`, pure, zero imports beyond globals)

- `src/sim/math/bits.ts` — `getHighWord`/`setHighWord`/`getLowWord`/`setLowWord` via a shared `DataView` (explicit-endianness, mirroring `tools/baseline/angles.ts`'s `hashFloat64s` idiom — the module already established this exact pattern for a reason, reuse it rather than reinventing).
- `src/sim/math/rem-pio2.ts` — the `two_over_pi[]` table (~36 entries), `npio2_hw[]` (~32 entries), `PIo2[]` (8 entries), `kernelRemPio2`, `ieee754RemPio2`. This is the Payne-Hanek machinery and is the largest single piece (~450 lines of the ~977-line C original, netlib `e_rem_pio2.c` ~165 + `k_rem_pio2.c` ~287).
- `src/sim/math/trig.ts` — `kernelSin`, `kernelCos` (Horner polynomials, S1–S6/C1–C6 coefficients, ~67/~76 lines each), `atan` (its own reciprocal-symmetry reduction, no Payne-Hanek — `s_atan.c` ~115 lines), and the public dispatchers `detSin(x)`, `detCos(x)`, `detAtan2(y, x)` (`s_sin.c`/`s_cos.c`/`e_atan2.c` dispatcher logic, ~66/~67/~134 lines).
- `src/sim/math/hypot.ts` — `detHypot(a, b)`, ~15 lines.
- `src/sim/math/*.test.ts` — spot values (0, ±π/2, ±π, ±3π/2, denormal-adjacent, near-π/2-breakpoint) with each expected value stated and its source noted (Node-native at that point, since Node is the target oracle for ordinary well-conditioned inputs); NaN/±Infinity edge cases matching `Math.sin`/`Math.cos`/`Math.atan2`/`Math.hypot`'s documented ECMA-262 behavior since call sites may rely on it implicitly even though the sim never intentionally produces NaN/Infinity angles.
- `src/sim/purity.test.ts` needs no changes — it already scans every file under `src/sim/`; the port trivially satisfies it (only `DataView`, `Math.sqrt`/`abs`/`trunc`/`sign`/`max` — all exactly-specified, non-approximated operations — plus arithmetic).

**Engineering discipline, stated because the golden trace's assertion is all-or-nothing**: port line-by-line, preserving operation order and branch structure exactly. Do not "clean up" or algebraically simplify any expression — a mathematically-equivalent reordering rounds differently at the ULP level and would silently break bit-exactness against the Node-native target without changing correctness in any way a spot-value test would catch.

## Call-site migration

Re-derive command (verified against this checkout: **14 lines, 17 occurrences, 4 files**):

```
grep -rn "Math\.\(sin\|cos\|atan2\|hypot\)" src/sim --include="*.ts" | grep -v "\.test\.ts" | wc -l          # 14 lines
grep -rn "Math\.\(sin\|cos\|atan2\|hypot\)" src/sim --include="*.ts" | grep -v "\.test\.ts" \
  | grep -o "Math\.\(sin\|cos\|atan2\|hypot\)" | wc -l                                                        # 17 occurrences
grep -rl "Math\.\(sin\|cos\|atan2\|hypot\)" src/sim --include="*.ts" | grep -v "\.test\.ts"                   # 4 files
```

Mapping (import `detSin, detCos, detAtan2` from `src/sim/math/trig.ts`, `detHypot` from `src/sim/math/hypot.ts`; **`Math.sqrt` at `types.ts:155`, `collision.ts:41,54`, `targeting.ts:180` is left untouched** — ES2025 correctly-rounded, per the issue's own reasoning):

| file | line | call | replace with |
|---|---|---|---|
| `src/sim/types.ts` | 173 | `Math.atan2(a.y, a.x)` | `detAtan2(a.y, a.x)` |
| `src/sim/types.ts` | 177 | `Math.cos(r)` / `Math.sin(r)` | `detCos(r)` / `detSin(r)` |
| `src/sim/bullets.ts` | 118 | `Math.hypot(dx, dy)` | `detHypot(dx, dy)` |
| `src/sim/collision.ts` | 152 | `Math.hypot(dx, dy)` | `detHypot(dx, dy)` |
| `src/sim/collision.ts` | 385 | `Math.hypot(hit.push.x, hit.push.y)` | `detHypot(...)` |
| `src/sim/collision.ts` | 422 | `Math.cos(tank.bodyAngle)` / `Math.sin(...)` | `detCos`/`detSin` |
| `src/sim/ai/targeting.ts` | 34, 124, 215, 251, 396, 406, 614 | `Math.hypot(...)` (7 sites) | `detHypot(...)` |
| `src/sim/ai/targeting.ts` | 626 | `Math.cos(a)` / `Math.sin(a)` | `detCos(a)` / `detSin(a)` |

Migrate all 17 in one commit (they're tightly coupled through `types.ts`'s `fromAngle`/`angleOf`; a half-migrated state mixes native and vendored math for no benefit).

## Validation

**One-time acceptance measurement, reported in the PR body, not pinned as a live-comparison test** (pinning against a currently-native function would create exactly the moving-target problem this research just found in V8 itself — the existing `ANGLE_HASH` design already avoids this by comparing against a *constant*, never a live `Math.*` call, and the vendored functions must follow the same discipline):

1. Bit-compare `detSin`/`detCos`/`detAtan2`/`detHypot` against Node-native `Math.*` over the **full** angle-probe sweep (`tools/baseline/angles.ts`'s existing `bandSamples`/`atan2Samples`/`hypotPairs` generators, all five reachability bands ±2π..±1e8, not just the golden trace's lattice) — this is the primary correctness check, expecting exact bit-match given Node's V8 13.6 is pre-migration fdlibm. Report mismatch count/0 and, if nonzero, per-band localization.
2. Same sweep, accuracy bound (max ULP delta, not exact match) against chromium/firefox/webkit native, via `tools/baseline/page.html`/`run.mjs` run manually. No pass/fail threshold — native engines aren't obligated to agree with fdlibm or each other; report the numbers as a sanity check that the port isn't grossly wrong (fdlibm's own documented worst case is <1 ULP for sin/cos/atan2).

## Extending `tools/baseline/angles.ts`

Add a second set of groups computed with the vendored functions (reuse the exact same input generators — `bandSamples`, `atan2Samples`, `hypotPairs` — so vendored and native bands are directly comparable), e.g. `vsin:2pi`, `vcos:2pi`, ..., `vatan2`, `vhypot` (no `vsqrt` — out of scope). Add `computeVendoredAngleBands()`/`computeVendoredAngleHash()` mirroring the native pair, and a new pinned export:

```ts
export const VENDORED_ANGLE_HASH = '<measured>';
```

Critical difference from `ANGLE_HASH`: **this one is asserted equal across engines, not just self-stable on Node**, because cross-engine agreement is the entire point of vendoring — unlike native math, our JS is built only from `+ - * / %`, `Math.sqrt`/`abs`/`trunc`/`sign`/`max` and `DataView` bit access, all exactly specified by ECMA-262, so bit-identical output on every conformant engine is a construction guarantee, not a hope. Wire this into:
- `tools/baseline/angles.test.ts` (or a sibling `vendored-angles.test.ts`): `expect(await computeVendoredAngleHash()).toBe(VENDORED_ANGLE_HASH)` under vitest/Node — this becomes part of `npm test`, gating every push via `ci.yml`'s existing "Test" step.
- `tools/baseline/page.html`: a third block, `window.__vendoredAngleResult`, same shape as the existing two.
- `tools/baseline/run.mjs`: read and report it like the native angle block, **but unlike the native block, wire a mismatch into `failed`** (`if (!ar.match) failed++`) — the native block deliberately does *not* do this because native divergence is structural and unfixable; a vendored mismatch is a real regression. This automatically plugs into both `ci.yml`'s "Baseline trace (chromium)" step (single-engine, gates the Pages deploy) and `.github/workflows/engines.yml` ("Engines matrix" — already landed via PR #160, its own header literally calls itself "the acceptance harness issue #133's vendored-math work will assert against once that lands"; no new CI infrastructure needed, only wiring into what exists).

## The golden-trace transition

Old value: `BASELINE_HASH = '324aa9b5d369ec6abc61f73e8e454de67b5fbf365f4b0df2eedf2c01add33bb5'` (5 arenas × 6 seeds × 2500 ticks, asserted in `tools/baseline/trace.test.ts`).

Steps:
1. After migrating call sites, run `npx vitest run tools/baseline/trace.test.ts`.
2. **If it passes unchanged**: this is the predicted-but-unverified outcome given the Node/V8-13.6 provenance argument above. State it plainly as a measured fact once observed — do not claim it was expected with certainty beforehand; the issue's own text assumed the hash "will move," and the corrected reasoning here only makes "might not move on Node" plausible, not certain. No `BASELINE_HASH` edit needed.
3. **If it fails**: read the new hash from the test failure, update `BASELINE_HASH` in `tools/baseline/trace.ts`, state old and new hashes in the PR body per the issue's own requirement, and use `computeAngleBands`-style per-band bisection reasoning (or a temporary debug script over the trace's actual angle values) to localize which vendored function's rounding diverges from Node-native at the specific inputs the trace visits.
4. Either way: run `npm run trace:browser -- --all` and report chromium/firefox/webkit agreement (or disagreement) with the (possibly new) `BASELINE_HASH`, and separately with `VENDORED_ANGLE_HASH`. Name the engines and versions in the report, per the issue's closing requirement.
5. CI's "Baseline trace (chromium)" step (`ci.yml`) re-asserts the chromium leg on every push automatically; `engines.yml` re-asserts firefox/webkit and cross-OS (macOS arm64, Windows) on push-to-main/weekly/on-demand — no design change needed there, only the `run.mjs` wiring in the previous section.

## Perf

Follow `tools/gl/idle-cost.ts`'s established convention: a measurement tool, not a check — prints numbers, asserts nothing, because the number is hardware-dependent. Write `tools/baseline/tick-cost.mjs` (or extend an existing bench if the executing agent finds a closer fit): run `step(world, input)` N times (N large enough for stable timing, e.g. 100k) over a representative world (reuse a fixture from `tools/gallery/subjects.ts` or `trace.ts`'s own seeded worlds) with `performance.now()` before/after, report ns/tick. Measure once on the commit immediately before call-site migration and once immediately after, same machine, same run; report the ratio (JS-fdlibm vs. native), not a bare absolute number, per this repo's "read the ratio" convention.

## Every pin that moves

- `BASELINE_HASH` (`tools/baseline/trace.ts`) — see transition section; may or may not move, verify by running, don't assume.
- `ANGLE_HASH` — **unaffected**; it stays whatever Node's native functions compute, since the call sites it sweeps (`Math.sin` etc., inside `angles.ts` itself) are never touched by this PR.
- New: `VENDORED_ANGLE_HASH` — measured fresh, no prior value to reconcile.
- `CLAUDE.md`'s quoted hashes: the `BASELINE_HASH` value at line ~508–535 (only if step 3 above fires) and the "Engines matrix" paragraph's forward-reference to #133 (line ~543–545) should be updated to state the outcome once landed, not left as a future-tense pointer.
- `tools/mutate/manifest.json` — **checked: 0 of 13 entries touch `src/sim/types.ts`, `bullets.ts`, `collision.ts`, `ai/targeting.ts`, or `tools/baseline/{angles,trace}.ts`** (all 13 target `src/render/*`, `src/game/*`). Nothing to update there; optionally add a hand-picked entry for the new `src/sim/math/` files if a specific defect class is worth pinning (e.g., "collapse `detHypot`'s max-scaling to a naive `sqrt(a*a+b*b)`" as a `killed` entry), but this is optional curation, not required by the issue.
- Replay fingerprint (`src/game/replay.ts`) — **does not move**: the fingerprint covers only the four sim *data* files (balance, tank-defs, ai-profiles, arenas), not code. This PR is a code change, so pre-vendoring replay files go stale silently (their recorded events no longer reproduce bit-identically once vendored math is live) with no error — this is the documented, accepted gap noted at `src/game/replay.ts`'s own header ("does NOT cover CODE... a mismatch proves a trace is stale while a match does not prove it is fresh"). State this explicitly in the PR body since it's exactly the kind of silent staleness this repo's conventions call out.
- `docs/superpowers/backlog.md` — the WASM-rewrite spike (~line 711) says "The replacement work is issue #133, still open"; update that clause once #133 closes (spikes are above the `## Ledger` heading, so `tools/backlog.test.ts` won't catch a stale reference — do it anyway, in the same PR, per the closing convention).
- `docs/research/multiplayer.md` — cites #133/PR #160 extensively (open question 1, the gating-measurement bullet); a follow-up doc pass is warranted but is not required for this PR to be correct or mergeable.
- Close issue #133 via `Fixes #133` in the PR.

## Ordered steps (each keeps `npm test` green)

1. Write `src/sim/math/{bits,rem-pio2,trig,hypot}.ts` + unit tests, unwired to any call site. `npm test` green (new pure code only).
2. Run the one-time Node-native bit-compare over the full angle-probe sweep (not a permanent test — see Validation). Report numbers.
3. Migrate all 17 call sites in one commit. `npm test` green or red on `trace.test.ts` specifically — resolve per the transition steps above before proceeding.
4. Extend `angles.ts`/`page.html`/`run.mjs` with the vendored bands and `VENDORED_ANGLE_HASH`, wired as a real failure. `npm test` green.
5. `npm run trace:browser -- --all`; report cross-engine agreement for both hashes.
6. Perf measurement; report the ratio.
7. Update the pins in the previous section; close #133.

## Out of scope

`InputState.aim` quantization (canvas-size-dependent, a separate input-boundary change per the issue's own text). `SimEvent` tick-field/de-duplication for rollback. `hypot`'s N-arg/Kahan path (no call site needs it). Vendoring `Math.sqrt` (ES2025 correctly-rounded, explicitly excluded by the issue). Chasing V8's LLVM-libc migration as a validation target (documented as a residual finding, not pursued — see option comparison).

## Open questions for the project owner

None identified as blocking. Every provenance, layout, naming, and validation-design choice above is decided with evidence in hand; the one genuine uncertainty (does `BASELINE_HASH` move) is not a decision but a measurement the plan already specifies how to take and record either way.