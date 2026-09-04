---
paths:
  - "**/*.test.ts"
  - "**/*.test.mjs"
  - "tools/mutate/**"
  - "vite.config.ts"
---

# Testing rules

- Prove the gap first: apply the production mutation, observe the old test set stay green,
  add the test, and observe the mutation fail.
- During local candidate verification, run every existing or new manifest entry relevant to
  the behavior, code, and tests touched with `npm run mutate -- --only <id>`. `--only` is
  repeatable and accepts a comma list, so one invocation carries the whole selection; an
  id matching no entry refuses the run and names every such id, and the closing tally
  prints how many entries were requested beside how many ran. Add or update entries when
  the coverage contract changes; pin a new entry with `killedBy` (the vitest full names of
  the tests that fail) and reserve an exact `expectFailures` for an entry whose rationale
  states a population, since only counted entries need remeasuring when tests are added to
  their scoped files.
- Do not run the complete manifest locally by default. Reserve `npm run mutate` or
  `npm run verify:full` for mutation-harness changes, broad manifest edits, CI mutation
  diagnosis, cross-cutting work that targeted selection cannot cover, or another named
  repository-wide risk. High-risk classification alone is not a reason.
- CI's `verify (current)` job is authoritative for the complete mutation manifest. Report
  selected local mutation evidence precisely and do not claim repository-wide mutation
  verification before that required check passes.
- Unit tests that call a stage directly cannot prove composition. Pipeline ordering and
  invocation belong in integration/pipeline tests that enter through the public boundary.
- Event assertions identify the producer/owner and validate payloads; presence-only checks
  are insufficient on a shared stream.
- Every assertion needs a production mutation or negative fixture that makes it fail.
  Guards require meta-tests or equivalent known-bad controls.
- State the swept population and exclusions beside every count. Recompute totals after the
  final test is added.
- Assert immediately after the operation under test; a later cleanup/no-op can erase the
  defect before a trailing assertion.
- If local and CI results disagree, compare installed versions with the lockfile and use
  `npm ci` before debugging behavior.
- Most tools outside `tools/mutate/` are not covered by `tsc`. Do not treat a green
  typecheck as proof that arbitrary tooling is valid.
- Verify expected changes and expected absences in output; a zero exit code alone is not
  evidence that the intended file or body changed.

Read `docs/agent/testing-and-review.md` before adding guards, publishing measurements, or
performing the merge review.
