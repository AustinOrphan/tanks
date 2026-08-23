---
status: active
date: 2026-08-23
last-reviewed: 2026-08-23
scope: Spike -- `src/sim/` behind a real package boundary
implementation-issues: []
implementation-prs: []
supersedes: []
superseded-by: []
---
# Spike: `src/sim/` behind a real package boundary

**Raised 2026-08-10**, from the modularization pass.

**The question:** should `src/sim/` become a workspace package with its own
`package.json`, so purity is enforced by the module graph rather than by a test that reads
files?

**Why it is live now.** Purity today is `src/sim/purity.test.ts`, which scans every file
under `src/sim/` for imports of `three`, `howler` and the DOM. It is a good guard — it has
a meta-test, added after it reported green for four of five known-bad imports — but it is a
**string scan**, and this ledger already records two holes it cannot close (see the purity-guard lines under "Unpinned behaviour"): the specifier
regexes use `['"]` only, so a template-literal import specifier is invisible to it, and it
matches `Math.random`/`Date.now` as tokens, so an alias or destructure walks past it. A
package with an empty `dependencies` block closes the first class structurally: the import
would not resolve.

The second draw is that a package boundary is what would let **the identical sim run
server-side**. The multiplayer spike's most expensive branch is an authoritative Node
server; today that would mean importing out of an app's `src/` tree.

**What would answer it:**

- **Count the touched import paths before anything else.** Every file outside `src/sim/`
  that imports from it changes specifier. That count is the deciding number and nobody has
  it — `grep -rn "from '.*sim/" src/ tools/ --include="*.ts"` is the whole measurement.
- **Decide what happens to the files that straddle the line.** `src/sim/arena-claims.ts`
  imports the AI's `lineOfSight` and is imported only from the test layer; `src/sim/
  sandbox.ts` is a dev rig. Whether those ship inside the package or stay in the app is a
  decision, not a lookup.
- **Check the guards survive the move.** `purity.test.ts`, `decomposition.test.ts` and
  `tools/baseline/trace.test.ts` all resolve paths relative to the repo root today. A move
  that quietly stops running one of them is the failure mode to design against — verify by
  watching each one FAIL under a deliberate mutation after the move, not by a green run.
- **Check `tsconfig.json`'s `include` first.** It is `["src", "vite.config.ts"]`, so
  `tools/` is already untypechecked (see the preview residuals above). A workspace layout
  either fixes that or makes it worse, and which one is not obvious.

**Constraint that shapes any answer:** whatever the layout, `src/sim/` must keep importing
nothing from `three`, `howler` or the DOM, and a replay must stay an exact function of its
inputs. A package boundary is a stronger way to say that — it is not a licence to relax it.
**Do not delete `purity.test.ts` when the boundary lands.** An empty `dependencies` block
does not catch `Math.random`, `Date.now`, or a relative import that climbs out of the
package; those are the classes the scan owns, and they are the ones with no structural
replacement.

**Not scheduled**, and deliberately not an issue: it touches every import path in the tree,
so the decision has to precede the PR rather than be discovered inside it.

---
