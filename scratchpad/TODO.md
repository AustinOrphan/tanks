# Queue

## Merged this session
#559 #560 #562 #563 #564 #565 #567(#555) #568 #569 #570(#561) #571 #572
Closed: #555, #561, #322.

## In progress
- Queue audit workflow running over #261, #279, #234, #323, #325 — acceptance criteria
  checked against shipped code, every "met" claim adversarially refuted.

## Awaiting owner
- **#566** — Main Menu painted for one crossfade when a pane opens from an end screen.
  Three options, two ruled out by measurement. Now has THREE callers of the pattern
  (handleChooseLevel, the versus relaunch, and handleChangeSetup from #572).
- **#323** — "Retry Mission where appropriate" undefined. Item (2) unblocked by #322.
- **#519** — relabel vs promoting #518.
- **#425 / #277 / #358** — need human playtests.

## Local environment note
`npm i --no-save playwright@1.62.0` was run to match the capture framework's pin
(node_modules only; package.json and the lockfile are untouched). `npm ci` restores it.
