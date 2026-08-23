# Known holes and deferred-work reference

Coverage boundaries, load-bearing seams, backlog policy, and rejected fixes. Treat historical measurements as scoped to the tree stated beside them.

## Known holes

`src/main.ts` still has no test file and cannot have one: it runs at module scope against
`document.getElementById('app')`, so importing it starts the game. It is now **wiring only** —
everything it used to do (the WebGL error page, the teardown registration) lives in
`src/boot.ts`, which takes its collaborators as arguments and is tested. Keep `main.ts` free
of logic; anything added there is unpinned again, and that is the whole of its remaining risk.

The game loop used to be the worst of these — `while (false && acc >= DT)`, the shipped
game never simulating a tick, passed the full gate. It is now split across `game/frame.ts`
(pure timestep maths), `game/driver.ts` (the frame loop, clock and rAF injected) and
`game/loop.ts` (construction and wiring, dependencies injected as factories), each with a
sibling test file. **Two seams there are load-bearing and easy to lose in a tidy-up:**
`driver.ts` reads `sm.state` twice per frame and the reads must not be hoisted into one
const, because `onEvents` flips the state between them; and `Driver.world`/`prevWorld` must
stay getters, since a plain property snapshots at construction and `tsc` will not warn.
`loop.test.ts`'s last describe block exists because `driver.test.ts` injects fake hooks and
so cannot see whether `loop.ts` wires the real collaborators into them — the composition
blindness above, one layer up. Do not delete it.

Modules with no sibling test file, re-swept at `620eef4`: `main.ts`, `render/aimray.ts`,
`render/renderer.ts`, `render/scene.ts`, `sim/ai/decision.ts`, `sim/ai/index.ts`.

**A missing sibling file is not the same as untested, and for three of those five it is
now actively misleading.** `sim/ai/` is exercised through `sim/step-integration.test.ts`,
with 15 files asserting AI behaviour. `render/scene.ts` and `render/renderer.ts` **are
tested** — in a real browser, by `tools/gl/harness.ts`, because they build a
`WebGLRenderer` that vitest cannot construct. Run them with `npm run test:gl`; CI runs them
in the `visual` job. That covers the ground plane's dimensions, the resize re-fit,
`dispose`, and `screenToGround`'s canvas-rect handling — none of which `npm test` can see,
so **a green `npm test` is not the whole gate for `src/render/`**.

The one module genuinely without coverage is `main.ts`: it runs at module scope against
`document.getElementById('app')`, so importing it starts the game and no test can reach it.
Its logic lives in `src/boot.ts`, which is tested; keep `main.ts` free of anything else.

**Deferred work goes in the backlog** — `docs/superpowers/backlog.md` is the compact
index, one line per topic; each topic lives in its own file under
`docs/superpowers/backlog/` (issue #265's split), and the ledger topic
(`backlog/ledger.md`) carries the one-line pointers. Spikes carry what the question is
and what would answer it. A PR that defers something adds its entry (and, for a new
topic, its index line) in the same PR, **and a PR that closes something deletes its
entry in the same PR.**

**Issues or backlog?** One question: **can a PR close it?** If yes it is an issue — file it,
and `Fixes #N` closes it on merge, which is upkeep you do not have to remember. If it needs a
decision or a measurement *before* anyone could write that PR, it is a spike here.

That test does not partition cleanly, and saying it does would be worse than admitting it.
Some ledger lines are closable by a PR *and* carry a figure this file's guard recomputes —
the inert density knob and the unreachable tracks. When both apply, prefer the issue and
move the measurement with it. An earlier draft of this paragraph tried a three-part test
("owner, state, close event"); **none of the eight issues filed so far has an assignee**, so
the owner limb rejected every example that motivated the rule.

**What is binding today**, whatever should happen eventually: the ledger exists, the
delete-when-you-close rule above applies to it, and `tools/backlog.test.ts` gates its
counts (reading `backlog/ledger.md` since the split) plus the index's completeness.
If it migrates to issues that is a deliberate change, not attrition — "it should have been an
issue" is not a reason to leave a closed line sitting in the file.

One collision worth knowing: a ledger line ends in `#N` meaning **the PR it came from**, and
an issue is also `#N`. Write `issue #N` when you mean an issue.

The second half is the one that rots, and it is not a tidiness rule. When the previous
arrangement was finally harvested, a one-pass triage enumerated 147 items across the PRs it
swept and found **63 already done** — roughly two in five. Read that as an order of magnitude
rather than a rate: what counts as "one item" was a judgement call, not a command; the swept
set is enumerated in `backlog.md` rather than defined by a predicate (three drafts stated it
as a PR count and all three were false); and the PRs recording deferred work only in prose
were not swept. `docs/superpowers/backlog.md` carries the breakdown.

Two caveats on using it as evidence, since both cut against the rule. Nobody *could* have
struck those out — a merged description is immutable, so the rot was structural rather than
negligence. And `backlog.md` is days old, so its own rot rate is unmeasured. The number is
the reason to expect the failure here, not proof it has happened. What it does establish is
the cost: a reader who cannot separate live entries from dead ones has to re-derive them,
which is the whole expense the file exists to remove. Deleting the line is part of the work,
not follow-up to it.

`tools/backlog.test.ts` makes the deletion cheap to get right rather than merely required:
it cross-checks the ledger's stated counts against the list itself and pins no count literal
of its own, so deleting a line and updating the `Counts:` paragraph is a **one-file edit that
goes green**. It shipped with literals first, which made this sentence false — fixing the
header left the build red until the TEST's expected values were edited too, and "repair the
red build by changing what the test expects" is the habit that ends guards. If you find
yourself editing an expected count in `backlog.test.ts`, stop: you are removing the guard,
not satisfying it.

**What it does not see: everything above the `## Ledger` heading.** The spikes and the
numbered follow-up entries are unguarded, so closing one goes green either way — and closing
a spike often strands ledger lines that cite the same PR, so grep for that PR number before
calling it done. Green is not evidence you got this right; red is evidence you did not.

Two cases the binary rule does not cover. If a line bundled several facts and only one is
settled, **rewrite it down to what is still true** rather than deleting it, and say in the PR
body which half closed. If you verify a line and find it **false rather than done**, delete
it and itemise it under "Where the numbers went" — two lines already there were removed that
way. A wrong entry costs a reader more than a missing one.

That file exists because the previous arrangement was "merged PR descriptions carry the
detailed residual backlog". Roughly a quarter of merged PR bodies carry an ATX heading
matching `/residual/i` and about half mention deferred work anywhere
(`/residual|backlog|defer|follow[- ]?up|future work|next step|out of scope|not doing/i`) — so
finding an open item meant reading every PR body and hoping. **Deliberately no counts here:
they move on every merge, and each time one was written down it was stale within the hour.
Run the predicate if you need a number.** A first pass harvested most of the PRs with a
heading; those recording deferred work only in prose have NOT been swept, so a merged PR body
is still the only home for some of it.

Most of this section is a landmine map rather than a task list: it records what has already
been tried and must not be re-attempted, and that part stays here. The exception is the
retroreflecting-seam fix — "must distinguish a coplanar neighbour that continues the surface
from a perpendicular one that merely touches it" is an open task, and it has a ledger line.

**Retroreflecting wall seams: real, measure-zero, and do NOT apply the obvious fix.**
Solid walls now load as merged maximal rectangles (`mergeSolidRuns`, see "Walls load as
geometry, not as cells" above), not one AABB per grid cell — but a merged run still
abuts its neighbours at internal seams, so the buried-face hazard below is unchanged in
kind, only in which faces carry it. A ray arriving at *exactly* a seam coordinate can
enter through one of those buried faces; its normal then points along the run and the
shell reflects back the way it came instead of mirroring off the visible face. Measured
**against the pre-upscale `cellSize` 2 geometry, one AABB per grid cell** (retired since
this branch; not re-measured against merged geometry): **1 of 121 sampled crossings**
(45°, offsets −0.60..+0.60 in 0.01 steps against cellSize 2) — the one at exactly 0.00 —
and **0 of 155 ricochets** in 15 seeded games × 4000 ticks landed on an exact cell corner.
So it was not the hazard on every flat face the PR #1 backlog describes.

The obvious fix — reject a hit whose face is buried, by stepping a hair out along the normal
and testing containment in another wall — **was tried and reverted**: it fails 4 tests in
`collision.test.ts` and `escape.test.ts`. At the arena's concave inside corners the outward
step from a *legitimate* face lands inside the abutting perpendicular wall, so real surfaces
are misclassified as buried and shells pass straight through — reopening the escape bug that
holds a `SHELL_CAP` slot for the rest of a life. Any real fix must distinguish a coplanar
neighbour that continues the surface from a perpendicular one that merely touches it.
