---
status: active
date: 2026-08-22
last-reviewed: 2026-08-22
scope: Public Prototype 1.0 boundary and high-level campaign direction
implementation-issues: [264, 294, 298]
implementation-prs: []
supersedes: ["docs/superpowers/plans/2026-08-02-difficulty-curve-stretch-1.md", "docs/superpowers/specs/2026-08-02-difficulty-curve-design.md"]
superseded-by: []
---
# Public prototype and campaign direction

Approved 2026-08-22.

This document is the binding high-level direction for classifying plans, specifications,
research, and backlog work in this public repository. Detailed gameplay documents remain
authoritative within their own scopes unless this document explicitly narrows or supersedes
them.

## Public repository boundary

**Public Prototype 1.0** is the intended finish line for the public `AustinOrphan/tanks`
repository. The public result should be a polished, technically representative, playable
prototype and engineering showcase. It is not intended to contain the complete commercial
game's content, proprietary assets, platform integrations, production roadmap, or final
release implementation.

Before cutover, work belongs in this repository when it is needed to make the prototype
technically coherent, playable, representative, verifiable, documented, or presentable.
Work needed only for the shipping commercial game should be preserved but not treated as an
active public-repository commitment.

After Public Prototype 1.0 is frozen, full-game development moves to a private commercial
repository created from the public cutover commit. The repositories may then diverge;
generic fixes can be deliberately backported in either direction without automatically
publishing commercial content or roadmap detail. Issue #294 owns the release gate, final
audit, tag, private-repository creation, and post-cutover maintenance procedure.

## Campaign direction

The eleven-level difficulty-curve design remains a useful reference for an **opening
teaching arc**. It is not the complete-game campaign and does not establish a permanent
campaign-length ceiling. A more complete commercial game is expected to continue
substantially beyond those eleven missions.

The current arenas are polished tech-demo and content prototypes, not immutable campaign
slots. They may be revised, reordered, replaced, reused, or integrated wherever later
campaign progression needs them. The earlier instruction that existing arenas are
"renumbered, not rewritten" is therefore no longer binding.

This decision does not choose a final campaign length, final arena list, or replacement
geometry. Those remain later design and implementation decisions.

## Effect on earlier documents

- [Campaign, run, attempt, and practice model](./2026-08-11-campaign-run-model.md) remains
  active and authoritative for campaign, run, attempt, practice, and persistence semantics.
  Its treatment of the eleven-level arc and current arenas is consistent with this direction.
- [A taught difficulty curve](./2026-08-02-difficulty-curve-design.md) is superseded as
  binding project direction. Its measured experiments and eleven-level teaching sequence
  remain useful historical design reference, but its fixed full-arc, arena-placement, and
  no-rewrite constraints do not.
- [Difficulty Curve, Stretch 1](../plans/2026-08-02-difficulty-curve-stretch-1.md) is
  superseded as an executable plan. It depends on the retired fixed-placement decision and
  contains pre-upscale arena geometry.

Supersession retires authority, not evidence. Both older documents remain at their stable
paths so their rationale and measurements can still be consulted deliberately.

## Classification rule

The classification work in #299, #300, and #301 must distinguish public-prototype work from
future commercial-game context without loading document bodies. A plan or specification
whose remaining work belongs exclusively after cutover is not active public-repository
direction: preserve it as `historical` and begin its metadata scope with
`Future commercial-game context:`. This repository-scoped classification does not cancel
the idea or prevent deliberate migration to the private repository.
