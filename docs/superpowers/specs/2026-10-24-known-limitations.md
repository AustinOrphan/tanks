---
status: proposed
date: 2026-10-24
last-reviewed: 2026-10-24
scope: What Public Prototype 1.0 does not do at the freeze, grouped by platform and devices, accessibility, content and tooling; a draft to re-check at the release commit
implementation-issues: [294, 1113]
implementation-prs: []
supersedes: []
superseded-by: []
---
# Known limitations of Public Prototype 1.0

Draft (#1113). Step 8 of the cutover procedure in #294 asks for every public-prototype limitation
that remains at the freeze to be resolved or documented; this note documents them. Each entry was
checked against `main` at `7528b56d` and against its issue on 2026-10-24. The note is re-checked at
the release commit: an entry fixed by then comes out, a limitation found by then goes in, and the
status becomes `active` with that date in `last-reviewed`.

Each entry says what the prototype does not do and links the issue or document that holds the
detail. This note makes no statement about when or whether a linked issue is resolved. Ideas the
prototype never set out to include are not listed.

## Platform and devices

- **Phones.** Gameplay frame time has never been measured on a physical phone, and the rendering
  defaults were tuned on desktop. The budget and its procedure are in #288 and the
  [device benchmark procedure](../plans/2026-09-14-device-benchmark-procedure.md).
- **Real-device presentation.** Phone, controller and television presentation has been reviewed in
  emulated viewports only, with no physical notched phone and no television at couch distance
  (#986). Emulated safe-area insets are checked for the toast rail and the shell-capacity flash
  alone, and the full-screen panes apply no inset of their own.
- **Large displays.** The menus keep their phone composition on a large display, with more space
  around it: rows wrap and panes scroll, and nothing re-composes
  ([viewport composition](./2026-09-26-viewport-composition.md), #1033).
- **Short screens.** On a short viewport, a menu pane's Back control can start below the fold,
  reachable by scrolling: in 15 of 36 pane-and-viewport combinations measured on 2026-09-26
  (#1034).
- **Stock strip on a phone.** At 480px wide and narrower, the Versus stock strip shows one mark and
  a count instead of one mark per stock for four players at five stocks, in FFA and Teams, and for
  four-player Teams at four stocks. The count stays exact
  ([`stock-cue.ts`](../../../src/presentation/stock-cue.ts); ruled on #1128).
- **Controllers.** Controller assignment is tested with synthetic gamepads. It has not been verified
  end to end with real gamepads in Safari and a Chromium-based browser, including hotplug and a
  reconnect that returns a different index (#616).
- **GameCube controllers.** A GameCube controller on an adapter is not supported: a browser may not
  expose the adapter at all, and a pad the game cannot classify is refused rather than misread
  (#595, #606).
- **Local play only.** Versus is played on one screen, with no online play, and every human player
  after Player 1 needs a controller ([README](../../../README.md#modes)).
- **WebGL 2.** Gameplay needs WebGL 2. A browser that does not provide it shows a message in place of
  the game ([`startup-failure.ts`](../../../src/game/startup-failure.ts)).

## Accessibility

- **Manual review.** Screen-reader narration, thumb reach on a phone and controller-only play have
  automated coverage but no signed-off manual review on hardware. #939 is that review; this entry
  comes out if it signs off before the release.
- **Enemy roles.** Enemy kinds share one silhouette and are told apart by hue alone. A non-color
  role cue exists only as a developer experiment behind `?dev=1&enemyRole=` (#357).
- **Shell type.** A shell carries no cue to its type, visual or audio: a standard shell, a fast
  rocket and a ricochet rocket are drawn alike, so in the campaign the kind of shot is learned from
  the tank that fired it (#1061). Versus fires standard shells only.
- **Shell owner.** With two or more players, a shell shows who fired it by tint alone (#1024).
- **Bounces left.** How many bounces a shell has left is conveyed by sound alone (#632).
- **Teams.** In Teams, each tank's ring carries its own player's shape, drawn in the team color, and
  the stock strip keeps each entry's A/B/C team letter (#1132). On the arena, a side is still told by
  color alone: teammates share one color, and no non-color mark identifies a team there (#923).
- **Focus ring over gameplay.** The focus ring's contrast is derived from a bound and measured on
  six application surfaces, but it has not been sampled over live gameplay behind Pause, where
  explosions and muzzle flashes pass under it (#1081).
- **Text scaling.** Text-only scaling to 200%, as distinct from page zoom, has no evidence (#326).

## Content

- **Campaign.** The campaign has five levels. Level 1 was re-authored as a single-threat lesson, and
  the levels after it are not arranged as a concept-introduction and graduation arc (#360).
- **Enemy balance.** Enemy roles and active-shell budgets are the roster's authored values, not
  validated by normal-speed play. The role-first matrix exists only as the `pp1Roles` developer
  experiment (#358).
- **Yellow.** The roster defines six enemy kinds, and Yellow appears in no campaign level
  ([README](../../../README.md#project-status)).
- **Mines.** Mine fuse and warning timings are the shipped values and have not been tuned by
  playtest (#277).
- **AI targeting.** How an AI tank commits to one of several player targets in co-op and versus bot
  play was accepted on recorded evidence, without a normal-speed human sign-off (#719).
- **Bot aim.** A computer player in Versus, and the scripted player in the README clip, re-rolls its
  aim error every tick with no aim hold, so its turret can visibly jitter where a campaign enemy's
  holds steady (`decidePlayerInput` in `src/sim/ai/player-profile.ts`; the enemies' hold is
  #344's). Seen during the Public Prototype 1.0 sign-offs and placed after the cutover.
- **Campaign co-op and controllers.** Campaign and Practice are played by one player on keyboard,
  mouse or touch. A controller for Player 1 and co-op for two to four players exist only behind the
  `gamepad` and `players` developer flags ([dev flags](../../dev-flags.md)).
- **Versus boards.** No campaign board offered in Versus has a play verdict for any player count or
  mode (#584). Team shapes such as 2v1 and 3v1 have no board floor of their own; the floor counts
  FFA and Teams only (#1038).
- **Bonus challenges.** No bonus level follows a perfect campaign run (#369, #370).
- **Audio.** No recorded audio ships: the game synthesizes every sound in Web Audio
  ([README](../../../README.md#audio-assets), [CREDITS.md](../../../CREDITS.md)).

## Tooling

- **Browsers.** The required checks drive Chromium alone, rendering WebGL in software through
  SwiftShader. Firefox, WebKit, shipped Safari and the iOS Simulator run only the simulation's
  determinism trace, in a workflow that reports and does not gate
  ([`engines.yml`](../../../.github/workflows/engines.yml)).
- **GPU cost.** The environment map's rendering cost has been measured only under SwiftShader, so
  its cost on a real GPU is unknown (#1063).
- **Screen states.** The screen-state suite has no recipe for the generic `startup-failed` state
  (#972).
- **Developer Tools.** Developer Tools ship behind `?dev=1` with partial automated coverage of focus
  and Back, but without manual keyboard, touch or controller evidence, and their destructive-action
  confirmations have not been checked by hand on any of the three (#948).
- **Built output.** That an ordinary URL downloads no developer module was measured once by hand,
  at the close of #946; no CI check guards it (#1017).
- **TypeScript.** TypeScript is held below version 7 in
  [`.github/dependabot.yml`](../../../.github/dependabot.yml), because `npm run hud:closure` is
  built on the compiler API that version 7 removes (#807).

## Re-checking at the release commit

- #288, #584 and #939 were open at `priority:next` with no milestone when this note was drafted, so
  each may close before the release. #939 is the narrowed review session that #327, on the
  milestone, waits for.
- Issues on the Public Prototype 1.0 milestone are not listed, because the freeze waits for them.
  One that is deferred instead of completed gains an entry here.
