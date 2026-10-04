# Kickoff instance

The local overlay for the owner's `kickoff` skill: what its resume protocol needs to know about
this repository. The protocol lives in the skill, which is kept in the owner's private dotfiles
and linked into `~/.claude/skills/kickoff` on the owner's machine. A session anywhere else
(another machine, a cloud session) has this overlay but not the protocol. Where the two
differ, this file wins. Protocol changes belong in the skill; this file holds only local rules
and places.

Nothing here is current state. Open pull requests, CI results, the queue's contents and live
owner rulings go in the status document below, which is rewritten at every boundary.

## Status

**Current state** lives in `kickoff-status.md`, in the Claude Code memory directory for this
project: the directory whose `MEMORY.md` every session here is given at startup. The main
checkout and every worktree resolve to that same directory, so a status written from inside a
worktree outlives the worktree. Give it the same frontmatter as the other notes there, with
type `project`, and a one-line pointer in `MEMORY.md`, and keep it to current state only. If it
does not exist yet, build it from live state and write it at the first boundary. Several
sessions share it, so re-read it immediately before rewriting it, and keep rulings and pull
requests that another session recorded.

It does not outlive the machine and is not in the repository. Pull requests, CI and the queue
can be rebuilt from GitHub; an owner ruling given only in conversation cannot. Record a ruling
where it survives: on the issue or pull request it governs, or, when it changes how the
repository works, in its docs through a pull request.

Verify the status against live state before acting on it:

```sh
gh pr list -R AustinOrphan/tanks --state open
gh pr checks <n> -R AustinOrphan/tanks                    # for each open pull request
gh pr view <n> -R AustinOrphan/tanks --comments           # owner comments and reviews
gh api graphql -f query='query { repository(owner: "AustinOrphan", name: "tanks") {
  pullRequest(number: <n>) { reviewThreads(first: 100) { nodes { isResolved path } } } } }' \
  --jq '[.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved | not)]'
gh run list -R AustinOrphan/tanks --branch main --limit 10
gh pr list -R AustinOrphan/tanks --state merged --limit 10
gh issue list -R AustinOrphan/tanks --state open -l priority:now
```

**Not status:** `.remember/` is written by the remember plugin into whichever checkout a session
runs in. A worktree's copy is deleted with the worktree, and the main checkout's copy stops
advancing once sessions move into worktrees. Read it as history. `docs/README.md` is a
generated document index.

**Long history**, searched on demand: `git log` and merged pull requests; closed issues; the
completed plans under `docs/superpowers/plans/`, which are the implementation record;
`docs/agent/` for rationale and landmines; the owner's memory notes beside the status document
(owner rulings and landmines, machine-local); and the `.remember/` summaries.

## Working copies

Module B looks at every one of these, whatever its branch name says:

- the main checkout, on `main`;
- every directory under `.claude/worktrees/`. Claude Code session worktrees start on a
  `worktree-<name>` branch and may since have moved to a change branch; workflow runs leave
  `wf_<run>-<n>` worktrees;
- Codex worktrees under `~/.codex/worktrees/<id>/tanks`, on a detached HEAD;
- local branches with no worktree, especially those with no upstream or an upstream marked
  `gone`.

```sh
git fetch --prune origin                                  # so deleted branches show as gone
git worktree list --porcelain
git for-each-ref --format='%(refname:short) %(upstream:short) %(upstream:track)' refs/heads
git -C <path> status --porcelain                          # for each working copy
git branch -r --contains <commit>                         # already on a remote branch?
gh pr list -R AustinOrphan/tanks --state all --head <branch>
```

The sweep changes nothing until it knows whose work it found. A worktree lock reads
`claude session <name> (pid N start <time>)`, with the time in UTC. If that process is still
running (`ps -p <pid> -o lstart=,command=` prints its start in local time), the worktree
belongs to a live session: report it and leave it alone. Rescue only where the lock's process
is gone or there is no lock. Report what a Codex worktree holds to the owner rather than
changing it.

Two things look like unpushed work and are not:

- Merges are squash-only, so a branch whose pull request has already merged still shows its
  own commits as ahead of `main`. Check the branch's pull request first.
- `pr-media-*` branches stage images for the protected `pr-media` branch, which specs embed
  images from, so they have no upstream of their own. Their commits are normally on
  `origin/pr-media` already; `git branch -r --contains` confirms it.

A `worktree-<name>` branch is renamed for its change before it is pushed (see "Git and pull
requests" in `CLAUDE.md`). Module B's default of merging `main` into open pull requests is
narrowed under [Merge policy](#merge-policy).

The mutation pool creates detached worktrees of `HEAD` under the system temp directory
(`mutate-worker-<pid>-*`) and removes them when it finishes. A worker whose restore failed keeps
its worktree and names it. They hold no work of their own.

Inside an isolated Claude Code session, the worktree guard refuses git aimed at any other
checkout, so uncommitted work elsewhere is invisible from there. Do not work around the guard
with a script. The full sweep belongs to a session started in the main checkout, before it
isolates. An isolated session reports the copies it could not inspect as unswept.

## Queue

Work is ordered by issue labels, defined in task-sizing.md under
[Required metadata](task-sizing.md#required-metadata) and
[Readiness labels](task-sizing.md#readiness-labels):

- **Horizon:** `priority:now` is the capacity-limited queue, which the `Issue backlog
  contract` workflow refills from `priority:next`; `priority:later` is never promoted
  automatically. Every open issue carries exactly one horizon.
- **Readiness:** `agent-ready` means the issue passes the readiness checklist;
  `human-required` means finishing it needs a person; `needs-split` means it is too large to
  hand over. Treat any other label that names a person's part, such as `playtest-required`,
  `hardware-required` or `needs-review`, as needing a person too.
- **Milestone:** membership in `Public Prototype 1.0` ranks first in the automation's ordering,
  ahead of impact.

Module C's steps, read for this repository:

1. In-flight pull requests: failing checks, and owner comments or unresolved review threads,
   are work for that pull request. Dependabot update pull requests are reviewed by a person,
   and nothing merges them
   ([Dependency updates](commands-and-operations.md#dependency-updates)). Report their checks;
   regenerate output on an update branch only when the owner asks.
2. Valid `priority:now` issues that no open or draft pull request implements. The dry run
   below lists Now items the audit rejects separately; those wait for a person.
3. The `priority:next` issues the dry-run reconciliation lists as eligible, in its order. The
   [eligibility rules](task-sizing.md#now-queue-automation) also check size, blockers and
   sub-issues, so do not filter labels by hand.
4. Does not apply. The owner sets priority through these labels. When steps 1 to 3 yield
   nothing, the run is blocked on triage: say so in the status document, and do not add
   `priority:now` or `agent-ready` to make work. Add them only on the owner's instruction.

```sh
npm run issues:reconcile -- --dry-run      # eligible candidates, in rank order
npm run issues:frontier                    # dependency graph: what is unblocked
```

Both need a GitHub token in `GH_TOKEN` (`gh auth token` supplies one). Without it, reconcile
refuses to run and frontier hits the anonymous rate limit. Frontier's "ready" means only "no
open blocker"; it does not check eligibility.

An issue is claimed by an open or draft pull request whose closing references name it
(`Closes #N`); there is no assignee convention. Before starting an issue, also check whether
it is already done. A pull request that said "Refs" instead of "Closes" leaves the issue open
even after its work has merged:

```sh
gh pr list -R AustinOrphan/tanks --state all --search "<n>"
git grep -nE '#<n>([^0-9]|$)'
```

At most one task is under implementation at a time
([Runtime execution queue](task-sizing.md#runtime-execution-queue)).

## Gates

The repository's own verification rules apply unchanged: the risk tiers and commands in
`CLAUDE.md` ("Verification and review"), the required checks it lists under "Git and pull
requests", the full matrix in [testing-and-review.md](testing-and-review.md#merge-bar), and
the `verify-change` skill.

- On a pull request, `verify (current)` runs every mutation entry the diff can affect. Preview
  that selection after fetching, with `npm run mutate -- --changed origin/main --list`. A
  change to any path in `ALWAYS_RUN_PATTERNS` (`tools/mutate/select.mjs`), such as
  `package.json`, the lockfile or the CI workflow, selects the whole manifest. The rule in
  `CLAUDE.md` against routine full local runs then applies.
- Local runs are candidate evidence. After pushing, record the pull request as `CI pending`
  and move on ([CI-pending execution](testing-and-review.md#ci-pending-execution)).

## Merge policy

- **The owner merges.** An agent never merges, enables auto-merge, or pushes to `main`. A
  pull request whose required checks pass and whose review threads are all resolved is
  reported as merge-ready and left.
- The owner merges green pull requests while other work is still running, and a merge deletes
  the head branch. Run `gh pr view <n> --json state` before pushing to a pull request's branch
  or editing the pull request; `[new branch]` in push output means it had already merged.
- Squash is the only merge method. The pull-request title becomes the whole squash commit and
  the body is dropped, so the title must stand alone.
- Do not merge `main` into a pull request's branch just because `main` moved; this narrows
  the skill's module B. The required checks are not strict, and every push re-runs them,
  mutation shards included, which puts a green pull request back to pending. Merge
  `origin/main` in only to resolve a conflict or to pick up code the branch needs.
- A stacked branch is rebased or retargeted when its predecessor lands
  ([CI-pending execution](testing-and-review.md#ci-pending-execution)). A branch that carries
  commits already squash-merged through another pull request conflicts with `main` even though
  the content matches: re-cut it from `origin/main` and cherry-pick its own commits. Push that
  with `--force-with-lease`, and only to a branch no other session is using. These two cases
  are the only exceptions to the skill's rule against rewriting shared history. `main` itself
  blocks force-push, deletion and non-linear history, with no bypass.
- No attribution: no `Co-Authored-By` or tool trailers, no agent or session names in branch
  names, and no Claude session links in commits, pull requests or comments.

## Environment limits

These fail a gate or stall a session for reasons unrelated to the change.

- **Installs are shared and drift.** A worktree may symlink a shared `node_modules`, carry its
  own, or have none, and a merged dependency update reaches none of them until someone
  reinstalls. `npm ci` also removes Playwright, which every browser gate needs. Reinstall at a
  quiet boundary, as
  [commands-and-operations.md](commands-and-operations.md#a-merged-update-does-not-reach-a-working-copy-issue-817)
  describes.
- **Mutation selection reads commits.** `--changed <ref>` diffs the merge base against `HEAD`,
  so it ignores uncommitted work; with nothing committed it selects nothing and still exits 0.
  The worker pool (`--jobs`) also tests `HEAD`. Commit first and read the `[select]` line. A
  run also refuses to mutate a file that is dirty in git, which is how a mutation stranded by
  a killed run shows up.
- **Long commands outlive the tool.** Claude Code stops a foreground command after two
  minutes by default and ten at most. Run long gates in the background.
- **Text metrics differ between macOS and the Linux CI.** A local green screen check does not
  clear text-sized layout; the `visual` check does.
- **A global gitignore that covers `.claude/`**, as the owner's does, hides new files there
  from `git add -A`; add them with `git add -f`.
- On a small machine, see
  [Constrained-machine escape hatches](commands-and-operations.md#constrained-machine-escape-hatches).

Limits specific to the owner's machine, such as shell aliases, network blocks, browser stalls
and the worktree guard's rules for shell commands, are in the owner's memory notes, which
`MEMORY.md` indexes. Those notes are machine-local.
