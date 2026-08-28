---
name: verify-change
description: Classify a Tanks diff by risk, run the canonical required verification, and report merge evidence. Use when asked to verify a change, choose checks, diagnose a gate failure, or prepare a pull request for merge.
context: fork
background: false
---

# Verify a change

Treat invocation arguments as scope hints, never as a replacement for inspecting the complete diff.

## Workflow

1. From the repository root, inspect the branch, `git status --short`, and the complete diff against its target. Separate intended work from unrelated changes; never discard, overwrite, or stash work you do not own.
2. Read the [merge bar](../../../docs/agent/testing-and-review.md#merge-bar), the [verification command surface](../../../docs/agent/commands-and-operations.md#verification-command-surface), and every scoped rule matching a touched path. Load only the sections needed for this diff.
3. Classify the complete diff as low, standard, or high risk. Use the highest applicable tier and state the concrete reason; accompanying tests or documentation do not lower the tier.
4. Run focused checks first when they provide a faster diagnosis, then satisfy the tier floor:
   - Low: inspect the diff and run the directly relevant documentation, formatting, link, or generator check.
   - Standard: run `npm run verify:quick`; add `npm run verify:build` when production output can change.
   - High: run the quick/build candidate floor, every affected subsystem check, and an adversarial review of invariants, consumers, compatibility, and failure modes.
5. For behavior, code, or tests touched, run every applicable mutation entry with `npm run mutate -- --only <id>` and add or update entries when required. Prove a claimed testing gap with a real failing production mutation.
6. Add `npm run verify:visual` for user-visible output or renderer/WebGL work. Add the applicable trace, persistence, portability, or device check required by the merge bar.
7. Do not run `npm run verify:full` locally by default. Use it for mutation-harness changes, broad manifest edits, CI mutation-failure diagnosis, cross-cutting behavior that targeted selection cannot cover, or another named repository-wide risk.
8. Treat required CI as authoritative: `verify (current)` runs the complete mutation manifest, `verify (floor)` covers the supported Node floor, and `visual` remains independent. Inspect failures; before all three pass, report only local candidate verification.
9. On failure, identify the first causal atomic step and inspect its output. Do not turn an unexplained rerun into evidence or claim later steps passed when they never ran.
10. Reinspect the final diff and status. Recompute all quoted counts after the last edit.

## Stop conditions

- Stop before destructive cleanup when unrelated changes overlap the work.
- Stop and report an incomplete gate when a required browser, platform, credential, or clean-worktree prerequisite is unavailable.
- Stop on a failing required check until it is fixed, explicitly scoped as unrelated with evidence, or returned to the user as a blocker.

## Evidence

Report the risk tier and rationale, every exact command and outcome, final test/check counts, inspected visual artifact paths when applicable, expected absences, and any check not run or only partially reproduced. Distinguish selected local mutation evidence from complete-manifest CI, and passed, pending, skipped, or unavailable checks. Never call a candidate fully verified while required CI is pending.
