# Issue #591 — the five ending screens

Captured from the production build with `tools/screens/run.mjs`, using `?dev=1&outcome=`
(issue #591's capture flag). Each screen is reached by the session really entering the
outcome phase, over a live session that has pushed its level choice and status.

| Screen | Primary action | Choose Level | Practice This Level |
| --- | --- | :-: | :-: |
| `mission-clear` | Next Level | — | **shown** |
| `campaign-over` | Start New Campaign | — | — |
| `campaign-complete` | Start New Campaign | — | — |
| `practice-cleared` | Retry | **shown** | — |
| `practice-failed` | Retry | **shown** | — |

**The measured visibility matches `OUTCOME_PANEL` exactly**, which is the point of these
captures: the two secondary controls each carry a multi-term gate, and both are in the
measured selector set of all five states, so a screen that stops offering one — or starts
offering one it should not — fails rather than photographing quietly.

Measured this run:

```
campaign-complete    choose-level=False practice-level=False
campaign-over        choose-level=False practice-level=False
mission-clear        choose-level=False practice-level=True 
practice-cleared     choose-level=True  practice-level=False
practice-failed      choose-level=True  practice-level=False
```

## What these prove, and what they do not

They render the real panel entry through the real gates. They do **not** play a match, so
they would not catch a game that stopped being winnable. The played-through capture is #617.

`?dev=1` also selects the DEVELOPER storage namespace (#245), so these states seed
`tanks.dev.`-prefixed keys — seeding a production save on a gated URL boots a first-time
player and the recipe's own clicks then time out, which is how this was found.
