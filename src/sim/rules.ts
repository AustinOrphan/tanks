import type { AiTargetPerception, ArenaGeometry, GameMode, UnarmedTrigger } from './types';

/**
 * Every value fixed for the life of one `World` and read by the simulation as a policy.
 * Resolved once by `resolveWorldRules`, the only place a default is chosen, then frozen and
 * shared by reference across every tick's clone (issue #472).
 *
 * Every field is required. An optional rule read as `?? default` and dropped by a clone
 * surfaces as the shipped default, and neither TypeScript nor any consumer can see the
 * difference (#471). So adding a rule means adding it here and to `resolveWorldRules`, and
 * every hand-built rules literal in the tree fails typecheck until it names the new key.
 *
 * `seed` is deliberately not here: it is the entropy key rather than a policy, and it is
 * already required, so it carries none of the optional-field hazard.
 */
export interface WorldRules {
  /**
   * Default `'campaign-coop'`, so every call site that never passes `mode` -- including the
   * golden trace's -- gets the campaign win/lose rules.
   */
  readonly mode: GameMode;
  /**
   * Whether a shell or mine blast harms a teammate. Default false is a feel choice
   * (docs/superpowers/plans/2026-08-17-versus-modes.md). Inert outside `'teams'`: the gates in
   * bullets.ts/mines.ts also require both tanks to carry a `team`, which `loadArena` only
   * stamps when `mode === 'teams'`.
   */
  readonly friendlyFire: boolean;
  readonly unarmedTrigger: UnarmedTrigger;
  /**
   * `'full'` by owner ruling 2026-08-31 (issue #359), superseding rule 1's perception bound;
   * the reasoning is at the check in ai/targeting.ts's `selectPerceived`. `'line-of-sight'`
   * keeps the experiment runnable behind `?dev=1&aiPerception=los`, and never binds a profile
   * with `bankShotWeight > 0` (an LOS-only reading would delete bank shots). Measured before
   * the ruling, it left non-banking brown and olive without a target on 44.78% and 77.79% of
   * live ticks.
   */
  readonly aiTargetPerception: AiTargetPerception;
  /**
   * Whether a tank killed earlier in the SAME resolveBulletHits pass still blocks a later
   * bullet aimed at it.
   *
   * Default false, the GHOST rule (ruling 2026-08-14: "Just-killed tank is a ghost for now.
   * Flippable switch in the future to playtest."): a second shell in the same tick sails
   * through the spot its target just vacated. `true` consumes that bullet at the hit with one
   * 'explosion' event, without re-killing the tank or re-emitting 'tank-destroyed'. A corpse
   * from an EARLIER stage (a mine kill from a prior tick, or the shell-detonates-a-mine loop
   * earlier in the same resolveBulletHits call) keeps ghosting either way.
   */
  readonly corpseBlocksShells: boolean;
  /**
   * Whether a shell's muzzle spawn point falls back to the owner's centre when it would land
   * inside a LIVE non-owner tank's hit circle, as muzzlePoint (bullets.ts) already does for a
   * muzzle inside a wall. Default true, the owner's adopted lean (2026-08-14); `false` lets
   * the muzzle spawn inside a neighbour's hit circle, which the motivating triage measured as
   * a ~0.5-3 degree tangent-escape sliver at exact minimum separation.
   */
  readonly muzzleClearsTanks: boolean;
  /**
   * Coop's win/lose model when two or more `kind === 'player'` tanks share the world; see
   * world.ts's resolveStatusCoop. TRUE is the "shared attempts" ruling (owner, 2026-08-16):
   * only a full wipe spends a life, and it restarts the whole arena. FALSE is the POOL model
   * (docs/superpowers/plans/2026-08-15-coop-semantics.md): every player death drains the
   * shared pool by one and respawns that tank alone. The game sets it from
   * game/devflags.ts's `coopPool`.
   */
  readonly coopAttempts: boolean;
  /**
   * The grid this world's walls were built from. Populated by loadArena (arena.ts); `null`
   * for a world built straight from raw tanks/walls/spawns arrays (most of world.test.ts's
   * fixtures, render/preview.ts's prop). `null` rather than optional, so a clone cannot
   * forget it.
   *
   * Read only by world.ts's respawnPos, where `null` degrades to the tank's authored spawn.
   * Shared by reference, never deep-cloned: nothing in it changes after loadArena (destroyed
   * walls live on `World.walls`), and the freeze below is shallow, so ArenaGeometry's
   * `readonly` fields are what enforce that.
   */
  readonly arenaGeometry: ArenaGeometry | null;
}

export interface WorldRulesInit {
  mode?: GameMode;
  friendlyFire?: boolean;
  unarmedTrigger?: UnarmedTrigger;
  aiTargetPerception?: AiTargetPerception;
  corpseBlocksShells?: boolean;
  muzzleClearsTanks?: boolean;
  coopAttempts?: boolean;
  arenaGeometry?: ArenaGeometry | null;
}

/**
 * Every rule key as data, so a test can sweep every rule without being edited when one is
 * added. The `satisfies` makes a missing key, or one that is not a rule, a compile error.
 */
export const WORLD_RULE_KEYS: readonly (keyof WorldRules)[] = Object.keys({
  mode: true,
  friendlyFire: true,
  unarmedTrigger: true,
  aiTargetPerception: true,
  corpseBlocksShells: true,
  muzzleClearsTanks: true,
  coopAttempts: true,
  arenaGeometry: true,
} satisfies Record<keyof WorldRules, true>) as (keyof WorldRules)[];

/**
 * The one place a rule's default is chosen, so a consumer never needs a `??` of its own.
 *
 * Frozen so the object can be shared by reference across every tick's clone (world.ts's
 * cloneWorld) with nothing able to alias-mutate it: ES modules are strict mode, so an
 * assignment to a frozen property is a TypeError rather than a silent no-op. The freeze is
 * SHALLOW, and a spread of `world.rules` is a fresh, UNFROZEN copy -- so derive a variant
 * through this function, `resolveWorldRules({ ...world.rules, mode: 'ffa' })`, which
 * re-freezes it (pinned in rules.test.ts).
 */
export function resolveWorldRules(init: WorldRulesInit = {}): WorldRules {
  return Object.freeze({
    mode: init.mode ?? 'campaign-coop',
    friendlyFire: init.friendlyFire ?? false,
    unarmedTrigger: init.unarmedTrigger ?? 'none',
    aiTargetPerception: init.aiTargetPerception ?? 'full',
    corpseBlocksShells: init.corpseBlocksShells ?? false,
    muzzleClearsTanks: init.muzzleClearsTanks ?? true,
    coopAttempts: init.coopAttempts ?? true,
    arenaGeometry: init.arenaGeometry ?? null,
  });
}
