/**
 * REPEATING OR REROLLING THE SCENARIO IN FRONT OF YOU (issue #252).
 *
 * Three runtime actions, and one place that decides what each of them means:
 *
 *  - **Restart with Same Seed** rebuilds the current board from the seed it is already
 *    running, so a bug seen once can be walked into again.
 *  - **Reroll Seed** rebuilds it from a fresh one and reports the number, so the world that
 *    just appeared can be pinned into a URL.
 *  - **Restart Current Round** rebuilds the round without touching what the session IS.
 *
 * WHY A BOUNDARY RATHER THAN THREE HANDLERS. The issue's own words: "expose operations
 * through a tested developer-actions boundary; UI code must not mutate world internals". A
 * button that reached into a world would be the fourth thing in this repository able to
 * replace one, and the only one nothing could test without a browser. So the UI calls
 * `runDevAction`, this module decides whether the action is even available and what
 * arguments it implies, and a `DevActionPort` supplied by the session does the one thing
 * only a session can do.
 *
 * PURE. No DOM, no `location`, no world: the port is injected, so every case below --
 * campaign, sandbox, versus, and the unavailable states -- is a plain object in a test.
 */

/** The three actions, in the order the pane offers them. */
export const DEV_ACTION_IDS = ['restart-same-seed', 'reroll-seed', 'restart-round'] as const;

export type DevActionId = (typeof DEV_ACTION_IDS)[number];

/**
 * What a session must be able to do for these actions to mean anything.
 *
 * ONE METHOD, not three. Every action is "rebuild the current board", differing only in
 * which seed and whether the round's carried state survives -- so the port takes those as
 * arguments rather than growing a method per button, and a fourth action later is a new
 * entry in the catalogue below rather than a new thing for `loop.ts` to implement.
 */
export interface DevActionPort {
  /** The seed the running world was built from -- `world.seed`, the RESOLVED one. */
  currentSeed(): number;
  /**
   * Rebuild the current board and return the seed it was built with.
   *
   * @param seed An exact seed, or `null` for a fresh one. `null` must produce a seed that
   * is genuinely new even when the URL pinned one, or Reroll reports a number that is not
   * the world's -- see `dev-actions.test.ts`'s case for it.
   * @param keepLives Whether the rebuilt board carries the lives the round had. This is the
   * whole of "preserves documented match/session fields and resets only documented round
   * state": the level, the session identity, the assignment and the run are untouched by
   * every action here, because none of them is an argument.
   */
  rebuild(seed: number | null, keepLives: boolean): number;
  /**
   * Whether there is a round to act on at all. False at the main menu, where nothing is
   * simulating -- distinct from the developer gate, which is about whether the PANE exists.
   */
  hasRound(): boolean;
}

/** One action, as the pane needs to render it. */
export interface DevActionSpec {
  readonly id: DevActionId;
  /** The control's label. Developer-facing; there is no player-facing copy in this feature. */
  readonly label: string;
  /**
   * Whether pressing it discards state a developer might not want to lose, and therefore
   * needs confirming first. All three rebuild the world, so all three do -- stated per
   * action rather than assumed, so a later read-only action does not inherit a confirmation
   * it does not need.
   */
  readonly confirms: boolean;
  /** What the armed control says while it waits for the second press. */
  readonly confirmLabel: string;
}

export const DEV_ACTIONS: Readonly<Record<DevActionId, DevActionSpec>> = Object.freeze({
  'restart-same-seed': Object.freeze({
    id: 'restart-same-seed',
    label: 'Restart with Same Seed',
    confirms: true,
    confirmLabel: 'Restart, losing this round?',
  }),
  'reroll-seed': Object.freeze({
    id: 'reroll-seed',
    label: 'Reroll Seed',
    confirms: true,
    confirmLabel: 'Reroll, losing this round?',
  }),
  'restart-round': Object.freeze({
    id: 'restart-round',
    label: 'Restart Current Round',
    confirms: true,
    confirmLabel: 'Restart this round?',
  }),
});

/** Why an action did nothing. Structured, so the pane states it rather than guessing. */
export type DevActionRefusal =
  /** Nothing is simulating; there is no board to rebuild. */
  | 'no-round';

export type DevActionOutcome =
  /** Done. `seed` is what the rebuilt world is actually running, never what was requested. */
  | { readonly kind: 'ran'; readonly id: DevActionId; readonly seed: number }
  | { readonly kind: 'refused'; readonly id: DevActionId; readonly reason: DevActionRefusal };

/**
 * Run one action.
 *
 * THE SEED IT REPORTS IS THE PORT'S RETURN VALUE, not the one this function asked for. That
 * is the difference between "Reroll reports an exact seed that can immediately be copied
 * into a reproduction URL" and a button that reports its own intention: a port that
 * declined to reroll, or resolved the seed differently, is caught here rather than believed.
 *
 * WHICH ARGUMENTS EACH ACTION IMPLIES, which is the whole of the policy:
 *
 *  - `restart-same-seed` -> the current seed, lives reset. The point is the same BOARD from
 *    the start, so carrying a depleted life count would not reproduce the initial state the
 *    issue's first criterion names.
 *  - `reroll-seed` -> a fresh seed, lives reset. Same reasoning: a new scenario starts new.
 *  - `restart-round` -> a fresh seed, lives KEPT. This is the one that preserves the
 *    session's carried state; it resets the round and nothing above it.
 */
export function runDevAction(id: DevActionId, port: DevActionPort): DevActionOutcome {
  if (!port.hasRound()) return { kind: 'refused', id, reason: 'no-round' };
  const requested = id === 'restart-same-seed' ? port.currentSeed() : null;
  const keepLives = id === 'restart-round';
  return { kind: 'ran', id, seed: port.rebuild(requested, keepLives) };
}
