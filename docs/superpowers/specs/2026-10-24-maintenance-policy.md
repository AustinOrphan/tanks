---
status: proposed
date: 2026-10-24
last-reviewed: 2026-10-24
scope: What the public repository accepts after the Public Prototype 1.0 release, how fixes move to and from the private repository, and what happens to later issues and pull requests
implementation-issues: [294, 1112]
implementation-prs: []
supersedes: []
superseded-by: []
---
# Public repository maintenance after Public Prototype 1.0

Proposed 2026-10-24 (#1112). Step 14 of the cutover procedure in #294 puts the public repository
into showcase and maintenance mode, and #294 requires the policy for that mode to be written down;
this is that policy. A rule that cites #294 or the
[project direction](./2026-08-22-project-direction.md) restates a decision already made there.
Every other rule is a proposal awaiting a ruling, and this document becomes `active` once each has
one.

## When it applies

The policy applies from the Public Prototype 1.0 release on: the commit that step 10 of #294's
procedure tags as the canonical public-prototype release. Until that commit, ordinary development
continues under [CONTRIBUTING.md](../../../CONTRIBUTING.md) and the direction listed in
[the documentation index](../../README.md).

The release tag stays on the release commit, and later commits on `main` do not move it, so the tag
remains the record of the prototype as released.

## What the repository accepts

From the release on, the repository is a showcase in maintenance mode: it accepts deliberate fixes
and representative improvements, and it does not routinely mirror commercial development back into
it (#294, step 14).

A change qualifies when it passes the question #294 used to classify work before the release: does
this need to exist for the public prototype to feel technically coherent, playable, and
representative? In practice that admits three kinds of change:

- **Fixes** to what the prototype already does: a crash, a wrong rule, a broken control, a failing
  check, or a document that no longer matches the tree.
- **Maintenance** that keeps the prototype building, deploying and verifiable, such as a dependency
  update that a security advisory or a broken build calls for.
- **Representative improvements**: a change that makes the prototype a clearer demonstration of
  what it already contains, without adding content or features to it.

It does not admit:

- work in the categories #294 lists under "Commercial-only work after cutover", among them campaign
  expansion, the final roster and progression, production assets, and platform and store
  integrations;
- commercial content or roadmap brought in only to keep the two histories looking alike (#294,
  "Repository relationship after cutover").

Every change, a fix or a backport alike, lands through a pull request against `main` that passes
the required checks (`verify (floor)`, `verify (current)` and `visual`) under the `Protect main`
ruleset, as before the release. The reason is that those checks are what keep the repository's
claims about itself checkable once development has moved elsewhere.

The deployed demo keeps following `main` through the existing Pages workflow, so a fix that lands
after the release reaches the demo.

## How changes move between the repositories

The repositories may diverge, and no automatic synchronization runs between them in either
direction (#294; [project direction](./2026-08-22-project-direction.md)).

**Private to public.** A generic fix may be backported deliberately from the private repository
when appropriate (#294). The backport is a new commit written against the public tree, never a
merge of private history, which would carry commercial commits with it. Its pull request states
that it is a backport and what it fixes, carries only the fix, and names no private commit, file or
plan. Commercial content, assets, balance data and roadmap stay out of it even when the private
change held them together (#294).

**Public to private.** A public change may be incorporated into the private repository when useful
(#294). That happens on the private side and asks nothing of this repository: no public issue, label
or pull request records it.

## Issues and pull requests after the release

**Issues.** Reports stay welcome after the release, as
[CONTRIBUTING.md](../../../CONTRIBUTING.md#what-is-welcome) lists them: bugs, reproductions,
crashes, platform problems, playtest feedback and questions. A report is triaged against the
question above. One that calls for a fix stays open until the fix lands; any other is closed with a
comment that gives the reason and links the matching entry in the
[known limitations](./2026-10-24-known-limitations.md) when one exists. Closing an issue here
records nothing about another repository: it neither promises the work elsewhere nor rules it out.

The issues still open before the release are classified under step 7 of #294's procedure, in #1114.
From the release on, every open issue is handled as above.

**Pull requests.** Outside code and asset contributions are not accepted, for the licensing reason
[CONTRIBUTING.md](../../../CONTRIBUTING.md) gives, and the release does not change that. An outside
pull request is closed with a link to CONTRIBUTING.md, and closing it is not a judgment about the
change. Automated dependency pull requests from
[`.github/dependabot.yml`](../../../.github/dependabot.yml) count as maintenance: one that passes
the required checks and keeps the prototype working may merge, and any other is closed.

## Outside this policy

- The license and copyright position, which step 5 of #294's procedure settles before the release is
  tagged.
- The private repository's contents, schedule and name.

## Related

- #294, the cutover gate, whose "Repository relationship after cutover" section and step 14 this
  policy sets out in full.
- [Public prototype and campaign direction](./2026-08-22-project-direction.md), the approved Public
  Prototype 1.0 boundary.
- [Known limitations of Public Prototype 1.0](./2026-10-24-known-limitations.md), what the prototype
  does not do at the freeze.
- [CONTRIBUTING.md](../../../CONTRIBUTING.md), the contribution policy before and after the release.
