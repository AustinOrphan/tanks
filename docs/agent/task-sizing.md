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

## Required metadata

Every open implementation issue or roll-up epic has exactly one label from each of five
dimensions: size, risk, primary area, impact, and planning horizon. Choose one primary area
even when secondary systems are involved:

| Label | Primary ownership |
| --- | --- |
| `area:repository` | Repository configuration, automation, project documentation, or governance. |
| `area:ui` | Menus, HUD, settings, accessibility, or interaction presentation. |
| `area:ai` | AI perception, decisions, aiming, movement, or difficulty behavior. |
| `area:versus` | Versus modes, setup, spawning, maps, scoring, or match rules. |
| `area:rendering` | Three.js projection, effects, animation, materials, or visual assets. |
| `area:gameplay` | Shared player-facing mechanics not primarily owned by another area. |
| `area:developer-tools` | Gallery, diagnostics, generators, probes, or developer workflows. |

Impact describes expected value, independently of size and risk:

| Label | Use it when |
| --- | --- |
| `impact:high` | The outcome blocks a current release or primary player flow, protects user data, or unlocks a major dependency chain. |
| `impact:medium` | The outcome materially improves quality, maintainability, or a secondary workflow. |
| `impact:low` | The outcome is optional polish, experimentation, or longer-horizon breadth. |

Planning horizon describes when work belongs in the execution queue, not how valuable it is:

| Label | Use it when |
| --- | --- |
| `priority:now` | A bounded, unblocked leaf selected for the active queue. Keep no more than eight open Now issues. |
| `priority:next` | Expected after the current queue or after named blockers clear. |
| `priority:later` | Intentionally deferred. |

Only an `agent-ready` `size:xs`, `size:s`, or `size:m` leaf may be `priority:now`.
Roll-up epics stay Next or Later and are completed through their linked children.

## Runtime execution queue

The Now queue is a planning horizon, not permission to implement several tasks at once.
Default to at most one active implementation. A candidate-complete PR awaiting required CI
remains tracked but does not consume that implementation slot, so one independent ready leaf
may start without waiting for it.

Before selecting that leaf, compare its dependencies and likely file surface with every
CI-pending PR. Independent work normally branches from current `main` in its own worktree. If
the next leaf needs pending code, choose another ready leaf or deliberately stack it on the
predecessor and record that dependency; never treat a stacked branch as independently
mergeable. See [CI-pending execution](testing-and-review.md#ci-pending-execution) for status,
check-boundary, failure, and merge rules.

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

When an issue closes, automation removes `agent-ready` and every `priority:*` label. Size,
risk, area, and impact remain as durable history. Reopening does not restore priority or
readiness; triage the issue again against its current scope and blockers.

## Triage workflow

1. Assign exactly one size, risk, primary area, impact, and planning-horizon label.
2. Split `size:l` work and turn `size:xl` work into a roll-up checklist of linked children.
3. Put the local outcome, constraints, and acceptance criteria in each child. Link the parent
   for shared rationale instead of copying the entire epic into every child.
4. Add `agent-ready` only to unblocked leaf issues that pass the readiness checklist; only
   those XS-M leaves may enter the bounded Now queue.
5. During implementation, re-size or split before allowing a branch to absorb unrelated work.
6. On closure, retain durable metadata and let automation clear transient priority/readiness.

This keeps issue prompts self-contained without forcing every agent session to ingest the
whole roadmap or a long global instruction file.
