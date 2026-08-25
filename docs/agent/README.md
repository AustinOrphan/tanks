# Agent reference index

`CLAUDE.md` contains only instructions needed in nearly every session. Claude Code loads a
matching `.claude/rules/*.md` file after it reads a file covered by that rule's `paths`
patterns. The documents here preserve detailed reasoning, measurements, rejected
approaches, and landmines without spending that context at startup.

These files are normal Markdown references, not `@path` imports. Search for the relevant
heading and read only the required section.

| Reference | Use it for |
| --- | --- |
| `commands-and-operations.md` | specialized commands, CI, Pages, rulesets, portability |
| `architecture.md` | simulation, rendering, data catalogs, AI, arenas, geometry, traces |
| `testing-and-review.md` | risk tiers, test design, mutation evidence, measurement, merge review |
| `development.md` | development flags, feel constants, branch and squash conventions |
| `task-sizing.md` | issue size, risk, decomposition, and agent-readiness criteria |
| `known-holes.md` | untested seams, deferred-work policy, rejected collision fixes |
| `context-budget.md` | exact global instruction-size measurement and enforced budget |
| `document-metadata.md` | plan/spec metadata, the research inventory, and validation workflow |

For product direction, plans, specifications, backlog topics, and research, start from
[`docs/README.md`](../README.md). It is generated from each document's own metadata, so it
separates current direction from the implementation record without anyone maintaining a
second list by hand.
