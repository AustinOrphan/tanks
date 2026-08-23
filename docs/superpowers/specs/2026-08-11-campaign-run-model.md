---
status: active
date: 2026-08-11
last-reviewed: 2026-08-22
scope: Campaign, run, attempt, practice, persistence, and campaign-growth semantics
implementation-issues: [152, 153, 154, 298]
implementation-prs: []
supersedes: []
superseded-by: []
---
# Campaign, run, attempt, and practice model

Approved 2026-08-11.

This document establishes the game-state vocabulary and persistence boundaries for campaign play. It is intentionally about the **model**, not the final campaign length or final authored level list.

The high-level public/commercial boundary and authority of earlier campaign documents are
defined by [Public prototype and campaign direction](./2026-08-22-project-direction.md).

## Canonical terminology

### Campaign

A **campaign** is authored content: an ordered progression of levels.

The current game has one effective campaign, but the model should not require there to be only one forever. A campaign may eventually contain substantially more levels than the current game or the initial eleven-level teaching arc.

### Run

A **run** is one attempt to complete a campaign from its beginning to its end.

A run owns the campaign-wide life pool. If a player starts a run with three lives, loses one on level 1, and later reaches level 8, that same run has only two lives unless another life has been deliberately awarded by game design.

A run is **not** ended by:

- refreshing the page;
- closing and reopening the game;
- quitting gameplay back to the menu; or
- temporarily entering another non-campaign mode such as Level Select practice.

A run ends when:

- the player loses all run lives;
- the campaign is completed; or
- the player explicitly abandons/replaces it by starting a new run.

### Level

A **level** is one authored mission/step within a campaign.

Campaign order should not be derived from arena identifiers or array position as a permanent architectural assumption. A campaign level may reference an arena while carrying its own campaign identity and metadata.

### Attempt

An **attempt** is one try at the current level within a run.

Losing the player tank consumes a run life and ends the current attempt. If lives remain, another attempt begins on the same campaign level with the run's reduced life count.

This term replaces the current ambiguous use of `run` for level-sized statistics.

### Practice

**Practice** is isolated play entered through Level Select.

Practice has its own fresh lives and does not mutate the active campaign run. Specifically, practice must not:

- consume or restore campaign-run lives;
- advance or rewind the campaign run;
- replace the campaign run's current level;
- complete the active run; or
- make `Continue` resume from the practice level.

Permanent/lifetime statistics may still count practice activity where appropriate, but campaign-run-specific achievements or records must not be satisfiable through practice unless explicitly designed that way.

## Persistence boundaries

There are three conceptually different kinds of state.

### Permanent progression

Permanent progression survives every run and represents durable player history/unlocks. Examples include:

- unlocked levels;
- completed levels/campaigns;
- achievements;
- customization unlocks;
- lifetime statistics.

Starting a new run does not erase permanent progression.

### Active run state

The active run is persisted separately from permanent progression. The exact schema is an implementation detail, but the state should be equivalent to:

```ts
interface ActiveRun {
  campaignId: string;
  currentLevelId: string;
  livesRemaining: number;
  status: 'active';
}
```

Additional versioning, timestamps, run statistics, seed information, or migration fields may be added as needed.

The important rule is that `highestCleared` or a similar permanent-unlock field is **not** a substitute for active run state.

### Practice state

Practice is independent of the active run. It may be transient rather than persisted unless a later product decision requires resumable practice.

A simple conceptual shape is:

```ts
interface PracticeSession {
  levelId: string;
  livesRemaining: number;
}
```

## Required transitions

### New Run

Creates a fresh run at the campaign's first level with the campaign's starting life count.

If an active run already exists, New Run explicitly replaces/abandons it. This should not happen accidentally as a side effect of menu navigation.

### Continue

Loads the active run's persisted current level and remaining lives exactly as stored.

Continue must not infer the destination from the furthest permanently unlocked level.

### Player death

The run life is consumed and persisted before the player can escape the loss by refreshing or leaving gameplay.

If lives remain, the next attempt begins on the same level.

If no lives remain, the run ends in game over.

### Level clear

Permanent progression may be updated, but that is separate from advancing the active run.

The active run moves to the campaign's next level and carries its remaining lives forward.

### Quit to menu / refresh / reopen

These operations suspend presentation of the run; they do not create a new run or replenish lives.

### Campaign completion

Completing the final campaign level ends the active run successfully and records any appropriate permanent progression/statistics.

### Level Select

Selecting an unlocked level begins practice with independent lives. Leaving practice returns to the menu without altering the active run. Continue still resumes the campaign run that existed before practice began.

## Campaign levels and arenas

The current arenas should be treated as reusable game content, not as permanently synonymous with campaign level numbers.

A future-facing separation could look like:

```ts
interface ArenaDefinition {
  id: string;
  // geometry, spawns, claims, etc.
}

interface CampaignLevel {
  id: string;
  arenaId: string;
  // title, objectives, modifiers, roster overrides, medal thresholds, etc.
}

interface CampaignDefinition {
  id: string;
  levels: CampaignLevel[];
}
```

The exact interfaces are not prescribed here. The design requirement is that an arena such as `arena-03` can later appear at whichever campaign position makes sense without its arena identity needing to change.

The currently shipped arenas are best regarded as polished tech-demo/content prototypes. They are expected to be candidates for integration into later campaign/level-progression revisions rather than defining the final campaign ordering by themselves.

## The eleven-level arc

`2026-08-02-difficulty-curve-design.md` remains a useful starting point for the **opening teaching arc**. Its eleven levels are not intended to define the complete size of the final campaign.

The opening arc's purpose is to establish the game's basic mechanical vocabulary progressively: firing, ricochets, movement, mines, destructible walls, new enemy behaviors, rockets, larger spaces, and increasingly combined pressure.

More complete versions of the game are expected to continue substantially beyond those eleven levels, recombining established mechanics and introducing later enemy types, environments, objectives, arena structures, and other progression ideas.

Accordingly, any level numbering or placement of today's existing arenas in that eleven-level document should be considered **provisional campaign placement**, not permanent arena identity.

## Statistics and achievements

The word `run` should have one meaning throughout the product: an attempt to complete a campaign.

Useful scopes are therefore:

- **attempt** — one try at one level;
- **level** — activity associated with one campaign level, potentially across multiple attempts;
- **run** — the complete campaign attempt;
- **practice** — isolated Level Select play;
- **lifetime** — all qualifying play across the save.

Existing code or achievement wording that calls a level-sized bucket a `run` should be renamed or explicitly separated when the campaign-run model is implemented.

## Related work

- [Public prototype and campaign direction](./2026-08-22-project-direction.md) records the
  binding public-prototype boundary and high-level campaign direction.
- Issue #152 tracks the visible bug where lives can currently be restored by refresh/menu exit.
- Issue #153 tracks implementing a first-class persisted campaign-run model.
- The completed Level Select / Continue / New Game work from #135 predates this model; its UI remains useful, but Continue/New Run/Level Select behavior should follow the semantics above.
