import type { AiTargetPerception, ArenaGeometry, GameMode, UnarmedTrigger } from './types';

/**
 * The rules a world is played under: every value that is fixed for the life of one
 * `World` and read by the simulation as a policy -- which win/lose body runs, what may
 * harm whom, what a mine reacts to, how much of the board an AI may consider. Resolved
 * once, before the world exists (`resolveWorldRules` below, the only place a default is
 * chosen), frozen, and carried across every tick's clone as one reference (issue #472).
 *
 * Every field is required and `readonly`. That is the point rather than a style choice: an
 * optional rule read as `?? default` and dropped by a clone surfaces as the shipped default,
 * and neither TypeScript (an optional field is legally absent) nor any consumer (the
 * fallback hides it) can see the difference (#471). With the rules resolved here, a `World`
 * that exists carries a complete, valid rule set; a consumer reads `world.rules.x` with no
 * fallback; and adding a rule means adding it to this interface and to
 * `resolveWorldRules`, where an omission is a compile error and every hand-built rules
 * literal in the tree fails typecheck until it names the new key.
 *
 * `seed` is deliberately not here. It is fixed for the life of a world too, but it is the
 * entropy key rather than a policy: it does not change what the sim does with a draw, it
 * chooses the draw. It is required and typechecked already, so it carries none of the
 * optional-field hazard this boundary exists to remove.
 */
export interface WorldRules {
  /**
   * Which win/lose rule this world's `resolveStatus` dispatches to, and which spawn set
   * `loadArena` built it from. See GameMode (types.ts). `'campaign-coop'` is the shipped
   * rule and the default, so every call site that never passes `mode` -- including the
   * golden trace's -- gets the campaign win/lose rules.
   */
  readonly mode: GameMode;
  /**
   * Whether a shell or mine blast harms a teammate -- meaningful only in `'teams'` mode.
   * Default false: protect teammates by default, a named feel choice rather than a settled
   * genre convention (docs/superpowers/plans/2026-08-17-versus-modes.md).
   * Self-disabling outside `'teams'` by construction: the friendly-fire gate in
   * bullets.ts/mines.ts also requires both tanks to carry a `team`, which `loadArena`
   * only ever stamps when `mode === 'teams'` -- so this field is inert in
   * `'campaign-coop'`/`'ffa'` whatever its value, not merely unread.
   */
  readonly friendlyFire: boolean;
  /** What may detonate an UNARMED mine. See UnarmedTrigger (types.ts). Default 'none'. */
  readonly unarmedTrigger: UnarmedTrigger;
  /**
   * How much of the board an AI may consider when choosing WHO to fight (issue #359,
   * owner ruling 2026-08-31 superseding rule 1's perception bound).
   *
   * `'full'` is the shipped default: an AI may select any live opponent, exactly as the
   * PLAYER can see any tank on the board. The camera frames the whole playable area and
   * nothing fogs or culls, so a line-of-sight bound on SELECTION gave the AI an
   * information limit the human does not have -- and its counterplay was "stand behind a
   * wall and be forgotten", which reads as exploitable rather than beatable.
   *
   * `'line-of-sight'` restores the bound, behind `?dev=1&aiPerception=los`, so the
   * experiment stays runnable. It never binds a banking profile (an LOS-only reading
   * deletes bank shots, so any profile with `bankShotWeight > 0` is widened past it);
   * measured before the ruling, it left non-banking brown and olive without a target on
   * 44.78% and 77.79% of live ticks.
   *
   * Selection only. Aiming and firing still require a real line of sight (`hasSolution`),
   * so full awareness does not let a turret track a target through a wall -- it decides
   * who the tank is fighting, not what it can shoot.
   */
  readonly aiTargetPerception: AiTargetPerception;
  /**
   * Whether a tank killed earlier in the SAME resolveBulletHits pass still blocks a
   * later bullet aimed at it, instead of letting it pass through untouched.
   *
   * Default false: today's shipped rule, a GHOST -- resolveBulletHits skips any tank
   * whose `alive` is already false, so a second shell in the same tick sails through
   * the spot its target just vacated. Adopted ruling (2026-08-14): "Just-killed tank is a
   * ghost for now. Flippable switch in the future to playtest." `true` is the WALL
   * variant: resolveBulletHits snapshots which tanks were alive at the START of its
   * pass, and a bullet that reaches one which died EARLIER IN THE SAME PASS is
   * consumed right there -- `b.alive = false`, one 'explosion' event at the hit --
   * without re-killing the tank or re-emitting 'tank-destroyed'. A corpse from an
   * EARLIER stage (a mine kill from a prior tick, or from the shell-detonates-a-mine
   * loop earlier in this same resolveBulletHits call) is not in that snapshot and
   * keeps ghosting in BOTH positions -- this switch changes only the same-pass case.
   * See bullets.ts's resolveBulletHits.
   */
  readonly corpseBlocksShells: boolean;
  /**
   * Whether a shell's muzzle spawn point falls back to the owner's centre when it
   * would land inside a LIVE non-owner tank's hit circle (TANK_RADIUS + BULLET_RADIUS
   * -- resolveBulletHits' own collision threshold), the same fallback shape
   * muzzlePoint already uses for a muzzle inside a wall.
   *
   * Default true -- the adopted lean (2026-08-14): "Spawn at hull center might be the
   * way to go but im not certain. Maybe set that up but also have it be flippable."
   * `false` is the earlier behaviour, where the muzzle can spawn already inside a
   * neighbour's hit circle -- the triage that motivated this switch measured the harmful
   * variant as a ~0.5-3 degree tangent-escape sliver at exact minimum separation. See
   * bullets.ts's muzzlePoint.
   */
  readonly muzzleClearsTanks: boolean;
  /**
   * Coop's win/lose model when two or more `kind === 'player'` tanks share the world.
   * See world.ts's resolveStatusCoop for the full split; in one line: TRUE (the default)
   * is the "shared attempts" ruling (owner, 2026-08-16) -- one player dying alone costs
   * nothing and the survivor fights on, and only a full wipe (every player dead at
   * once) spends a life and restarts the WHOLE arena via resetArena, exactly the 1P
   * death experience generalized to "nobody is left standing." FALSE restores the POOL
   * model (docs/superpowers/plans/2026-08-15-coop-semantics.md): every player death drains
   * the shared pool by one and schedules that one tank's own per-tank respawn, leaving the
   * rest of the board untouched.
   *
   * A World construction switch, never a runtime flag read inside src/sim/ -- see
   * game/devflags.ts's `coopPool`, the game's only way to pass `false`.
   */
  readonly coopAttempts: boolean;
  /**
   * The grid this world's walls were built from -- see ArenaGeometry's own doc comment
   * (types.ts). Populated by loadArena (arena.ts), including for sandbox.ts's dev worlds;
   * `null` for a world built straight from raw tanks/walls/spawns arrays with no grid
   * behind it (most of world.test.ts's fixtures, render/preview.ts's prop). `null` rather
   * than optional: absence is a resolved answer here, stated by the creation boundary, not
   * a field a clone can forget.
   *
   * Read only by world.ts's respawnPos, to pick a versus respawn cell with
   * pickVersusSpawnCell (versus-spawns.ts). `null` degrades to the tank's own authored
   * spawn -- see respawnPos's own comment -- rather than throwing. A reference, never
   * deep-cloned: the grid strings and legend never mutate after loadArena builds them
   * (only Wall.destroyed, which lives on `World.walls`, changes mid-round), and
   * ArenaGeometry's fields are `readonly` (types.ts), so that is enforced by the type --
   * the freeze below is shallow and would not reach this object on its own.
   */
  readonly arenaGeometry: ArenaGeometry | null;
}

/**
 * What a caller may say about the rules. Every key optional: an absent key means "the
 * shipped default", chosen in `resolveWorldRules` and nowhere else.
 */
export interface WorldRulesInit {
  /** Defaults to 'campaign-coop', the shipped rule. See WorldRules.mode. */
  mode?: GameMode;
  /** Defaults to false. See WorldRules.friendlyFire. */
  friendlyFire?: boolean;
  /** Defaults to 'none', the shipped rule. See WorldRules.unarmedTrigger. */
  unarmedTrigger?: UnarmedTrigger;
  /** Defaults to 'full' -- see WorldRules.aiTargetPerception. */
  aiTargetPerception?: AiTargetPerception;
  /** Defaults to false, the shipped GHOST rule. See WorldRules.corpseBlocksShells. */
  corpseBlocksShells?: boolean;
  /** Defaults to true, the adopted lean. See WorldRules.muzzleClearsTanks. */
  muzzleClearsTanks?: boolean;
  /** Defaults to true, the shared-attempts ruling. See WorldRules.coopAttempts. */
  coopAttempts?: boolean;
  /** Absent (null) unless the caller went through loadArena. See WorldRules.arenaGeometry. */
  arenaGeometry?: ArenaGeometry | null;
}

/**
 * Every rule key, as data -- what lets a test sweep the rules PROGRAMMATICALLY (build a
 * non-default value for each, step the world, assert each survived) so a rule added later
 * is covered without the test being edited. The `satisfies` is what keeps this list honest:
 * a key missing from it, or one that is not a rule, is a compile error at the one place a
 * new rule is already being added.
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
 * The creation boundary: turns what a caller said into the complete, frozen rule set a
 * `World` carries. This is the ONE place a rule's default is chosen -- `createWorld`
 * (world.ts) calls it, render/preview.ts's prop world calls it, and a test that builds a
 * `World` literal by hand calls it -- so "what does an unstated rule mean" has exactly one
 * answer in the tree, and a consumer never needs a `??` of its own.
 *
 * Frozen so that the object can be shared by reference across every tick's clone
 * (world.ts's cloneWorld) with nothing able to alias-mutate it: ES modules are strict
 * mode, so an assignment to a frozen property is a TypeError rather than a silent no-op.
 * The freeze is SHALLOW, and a spread of `world.rules` is a fresh, UNFROZEN copy -- so
 * derive a variant through this function, `resolveWorldRules({ ...world.rules, mode: 'ffa' })`,
 * which re-freezes it (pinned in rules.test.ts).
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
