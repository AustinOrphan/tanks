# Main Menu and Settings hierarchy (issue #226, PR #523)

The same journey through both builds at 1280x800: open the game, look at the menu, start a
campaign, quit back, then open what the menu offers. Before is the commit preceding the
merge; after is the merge itself.

| File | What it shows |
| --- | --- |
| `menu-before-no-run.png` | eleven controls in one list, including mute, aim scheme, fire mode and haptics |
| `menu-after-no-run.png` | one dominant action, then Versus and Practice, then three utilities and a footer |
| `menu-before-with-run.png` | Continue appears, with New Game directly beneath it at the same weight |
| `menu-after-with-run.png` | Continue Campaign leads and names the run; starting over is tertiary |
| `stats-before.png` | Stats, one of two separate menu entries |
| `records-after.png` | Records: the same two surfaces as tabs of one entry |
| `settings-after.png` | the new Settings pane; Accessibility is absent because it has no controls yet |
| `confirm-replace-run.png` | the question asked before an active run is replaced |

The change that matters most is not in any still: on the old build, New Game with a run in
progress replaced that run immediately. The capture script recorded exactly that, logging
`no confirmation on this build (New Game replaced the run directly)`.

Button inventories the script read from each build:

- before, with a run: Continue, New Game, Stats, Achievements, Customize, Levels,
  Controllers, Versus, Mute (M), Aim: Stick, Fire: Tap to fire, Haptics: On
- after, with a run: Continue Campaign, Start New Campaign, Versus, Practice, Customize,
  Records, Settings, About & Legal
