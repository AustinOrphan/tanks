---
name: mutation-check
description: Select, run, and interpret the Tanks mutation manifest while proving test assertions can fail. Use when adding behavioral coverage, validating a test gap, investigating a survivor, or diagnosing the mutation step in verification or CI.
context: fork
background: false
---

# Check a mutation

Treat invocation arguments as an optional mutation ID, source behavior, test file, or reported survivor.

## Workflow

1. Inspect the diff, `tools/mutate/manifest.json`, and the affected production/test files. Read the mutation section of the [command reference](../../../docs/agent/commands-and-operations.md) and the relevant [testing conventions](../../../docs/agent/testing-and-review.md#testing-conventions-learned-the-hard-way).
2. Name the exact production defect the assertion must catch. For new coverage, run that production mutation against the pre-assertion tests first and observe the gap before treating the new test as evidence.
3. Prefer `npm run mutate -- --only <id>` for one known behavior. Run `npm run mutate` when validating the complete manifest or satisfying `npm run verify:full`; do not reproduce the harness with ad hoc search-and-replace commands.
4. Let the harness establish a green scoped baseline, prove the declared tests reach the target file, apply the mutation, and restore the original bytes. After every run, independently inspect `git status --short` and the target diff to confirm restoration.
5. Interpret the result precisely:
   - `KILLED`: the scoped Vitest run caught the mutation; confirm the declared outcome and any exact failure count match.
   - `SURVIVES`: the scoped Vitest run did not catch it. This does not prove typecheck or the full gate misses it.
   - `BASELINE-RED`: stop; the mutation did not cause the existing failure.
   - A mismatch, unreachable target, failed apply, interruption, or restore warning is a harness/manifest failure until explained.
6. If the final tree legitimately changes the failure population, remeasure it after the last test edit and record why the manifest count changed. Never update a count merely to make the gate green.

## Stop conditions

- Stop before running when any manifest target the harness may rewrite has uncommitted changes. Do not stash or discard unrelated work to force the run.
- Stop immediately on uncertain restoration and verify the target bytes before any further edit.
- Stop on a survivor or outcome mismatch until the missing coverage, equivalence, deliberate documented gap, or stale declaration is established with evidence.

## Evidence

Report the command, mutation ID, target, scoped tests, green baseline, declared and observed verdict, exact failed-test count and population when pinned, and an independent clean-restoration check. Report typecheck or broader verification separately; mutation output is not a substitute for either.
