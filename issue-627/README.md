# Issue #627 — Keystone advertises three-player Teams

Captures from `npm run screens -- --state screen.versus-setup.teams`, the catalogue state
added alongside the change. Both frames are the built page at 1280x800 @2dpr, driven through
the same steps: open Versus Setup, click **3** players, click **Teams**.

| | Map row |
| --- | --- |
| Before | `before-map-row.png` — Arena 1-5 + Random (6 buttons) |
| After | `after-map-row.png` — Arena 1-5 + **Keystone** + Random (7 buttons) |

Full-pane frames are `before-3p-teams.png` and `after-3p-teams.png`.

The after frame also shows the default 2v1 stamp the approval turns on: Player 1 **A**,
Player 2 **B**, Player 3 **A** — `teamOf(slot) = slot % 2` (`src/sim/arena.ts`). The A/B/C
buttons on each slot are how a player reassigns it, which is what makes the materially
distinct 2v1 assignments #627 asks about reachable.

These are evidence that the button is offered and themed. They are **not** evidence that
Keystone plays well as 2v1; that is #627's own question and it is settled by normal-speed
human play.
