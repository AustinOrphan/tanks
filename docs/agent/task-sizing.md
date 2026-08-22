# Task sizing and agent readiness

Size implementation work by change surface and uncertainty, not elapsed time or story-point
velocity. The purpose is to keep a leaf issue small enough for one coherent branch and pull
request, especially when an agent will implement it.

## Size labels

| Label | Use it when |
| --- | --- |
| `size:xs` | A tiny, localized change with an obvious implementation and verification path. |
| `size:s` | One focused subsystem change that fits comfortably in one pull request. |
| `size:m` | Several coordinated changes that still form one reviewable pull request. |
| `size:l` | Multiple subsystems, material unknowns, or more than one likely pull request. Split it before assigning implementation unless the issue records a specific reason not to. |
| `size:xl` | A roll-up epic only. Track completion through linked child issues; never hand the epic itself to an implementation agent. |

Assign exactly one size to implementation issues and epics. Re-size when investigation
changes the known scope. Size does not measure importance.

## Risk labels

Risk is independent of size:

| Label | Typical change |
| --- | --- |
| `risk:low` | Documentation, metadata, or a tightly localized presentation change. |
| `risk:medium` | User-visible behavior, rendering/tooling integration, or a moderately broad change with bounded failure modes. |
| `risk:high` | Deterministic simulation, persistence or migrations, security boundaries, release/CI behavior, or another change where a subtle defect can corrupt state or block delivery. |

Mixed work inherits the highest applicable risk. Use the risk tier to choose verification and
review depth; do not inflate the size to represent risk.

## Readiness labels

Add `agent-ready` only when all of these are true:

- the issue is `size:xs`, `size:s`, or `size:m`;
- the outcome and objective acceptance criteria are explicit;
- relevant constraints, invariants, verification, and out-of-scope behavior are recorded;
- every blocking dependency is complete;
- no unresolved product or architecture decision is required to begin;
- the work plausibly fits one branch and pull request.

Remove `agent-ready` if a new blocker appears or the scope grows. Do not use it as a priority
label.

Use `needs-split` for a `size:l` implementation issue or a `size:xl` proposal that does not
yet have a complete child breakdown. Remove it once the children cover the parent outcome and
acceptance criteria. A completed roll-up epic remains `size:xl` but is not `agent-ready`.

## Triage workflow

1. Assign one size and one risk label.
2. Split `size:l` work and turn `size:xl` work into a roll-up checklist of linked children.
3. Put the local outcome, constraints, and acceptance criteria in each child. Link the parent
   for shared rationale instead of copying the entire epic into every child.
4. Add `agent-ready` only to unblocked leaf issues that pass the readiness checklist.
5. During implementation, re-size or split before allowing a branch to absorb unrelated work.

This keeps issue prompts self-contained without forcing every agent session to ingest the
whole roadmap or a long global instruction file.
