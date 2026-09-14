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
| `priority:now` | A bounded, unblocked leaf selected for the active queue. Keep no more than eight open Now issues; automation refills vacancies from Next (see [Now queue automation](#now-queue-automation)). |
| `priority:next` | Expected after the current queue or after named blockers clear. This is the pool automation refills Now from, and where an in-flight Now issue returns while its pull request is open. |
| `priority:later` | Intentionally deferred. Automation never promotes from Later. |

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

Add `human-required` when finishing the issue needs a person: a sign-off, a device session, a
product decision, or work an agent must not do alone. It can sit beside `agent-ready` on an
issue whose remaining work is mixed, but it keeps the issue out of the Now queue and out of
automatic promotion until it is removed.

Use `needs-split` for a `size:l` implementation issue or a `size:xl` proposal that does not
yet have a complete child breakdown. Remove it once the children cover the parent outcome and
acceptance criteria. A completed roll-up epic remains `size:xl` but is not `agent-ready`.

When an issue closes, automation removes `agent-ready` and every `priority:*` label. Size,
risk, area, and impact remain as durable history. Reopening does not restore priority or
readiness; triage the issue again against its current scope and blockers.

## Now queue automation

`priority:now` is capacity-limited executable work and `priority:next` is the approved pool
it refills from. The `Issue backlog contract` workflow reconciles the queue
(`npm run issues:reconcile`, `tools/issues/queue.mjs`) from one snapshot of open-issue state,
idempotently: running it twice against unchanged state writes nothing. The capacity is
`MAX_NOW_ISSUES` in `tools/issues/metadata.mjs`, currently eight. Eight is a ceiling and the
desired size when enough valid work exists; the queue stays below it rather than admit
unsuitable work. Automation performs queue mechanics only. It never invents product
priority, and a valid Now item is never moved because a newer candidate outranks it.

**Now versus In Progress.** Now is the queue of work to pick up; an issue an open or draft
pull request already implements is in progress, not queued. In-flight detection is exactly
"an open pull request in this repository whose closing references name the issue" (GitHub's
own linkage: a `Closes #N` keyword or a Development-sidebar link, fork pull requests
included). A branch without a pull request, or a pull request that merely mentions the
issue, is not detected; nothing is inferred from titles. When a Now issue becomes in flight,
reconciliation removes `priority:now`, adds `priority:next` if no other `priority:*` label
remains so the issue keeps exactly one horizon, and refills the slot. The in-flight rule
keeps it out of Now while the pull request is open; if the pull request closes unmerged it
is a candidate again, and if its closing reference is edited away it can be re-promoted.

**Eligibility.** A Next issue may enter Now automatically only when all of these hold: it is
an open issue, not a pull request; it carries `priority:next` and `agent-ready`; it carries
neither `human-required` nor `needs-split`; its size is `size:xs`, `size:s`, or `size:m`; it
has no open native blocked-by dependency; no open or draft pull request implements it; it
has no native sub-issues; and the audit reports no metadata error against it (the heuristic
readiness-marker warnings do not exclude). The sub-issue rule is the conservative reading of
"a concrete leaf, not a roll-up" pending a decision on whether an XS-M issue with a sign-off
child counts as a leaf; such issues are listed in the reconciliation summary as held, never
promoted silently.

**Ranking.** Candidates are ordered deterministically: Public Prototype 1.0 relevance first
(membership in the milestone of that exact title); then `impact:high`, `impact:medium`,
`impact:low`; then greater dependency leverage, the count of open issues the candidate
natively blocks; then `risk:high`, `risk:medium`, `risk:low` as a risk-reduction tie-break;
then `size:xs`, `size:s`, `size:m`; then the lowest issue number. A criterion that cannot
be determined for every candidate is skipped for the whole ranking and named in the summary
rather than guessed. Ranking chooses what enters a vacancy and nothing else.

**What leaves Now.** A valid Now item stays until it closes (label cleanup), becomes in
flight (automatic demotion), or a human moves it. A Now item that loses `agent-ready`, gains
`human-required` or `needs-split`, is re-sized to L/XL, or acquires an open native blocker
is an audit error that keeps its slot until a person resolves it; automation does not demote
for those, because reconciliation runs on every label event and a human who adds
`priority:now` and then `agent-ready` in two clicks must not have the first event bounce the
issue back to Next. For the same reason a Now item that carries a second `priority:*` label
is left exactly as it is: it may be an interrupted promotion or a person half way through a
hand demotion, and the audit's `duplicate-priority` error names it either way. The audit also
warns when Now is below capacity while eligible candidates exist. An over-full queue is
likewise a human decision: automation promotes nothing into it and never demotes a valid
item to make room. Because a freed slot is refilled on the next event, swap by hand by
adding the replacement to Now first and removing the outgoing item second.

**Triggers.** Reconciliation runs on every issue event the workflow receives (opened,
edited, deleted, transferred, reopened, labeled, unlabeled, closed), on pull requests being
opened, reopened, edited, or closed unmerged, on manual dispatch, and daily. A merged pull
request's close is skipped because its linked issues' own closed events carry the effect. A
blocked-by edge removed by hand or a Development-sidebar link fires no event and waits for
the next event or the daily run. Label writes use the workflow token, whose events never
start another run, and the plan is a fixed point, so the workflow cannot loop on itself.

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
