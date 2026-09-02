import type { DevFlags } from './devflags';
import type { VersusConfig } from './versus-config';
import {
  type DeveloperMetadata,
  type SessionDescriptor,
  type VersusRules,
  campaignDescriptor,
  practiceLevelDescriptor,
  practiceSandboxDescriptor,
  versusDescriptor,
  versusRulesFromConfig,
  versusRulesFromDeveloperFlags,
} from './app-state';

/**
 * THE ONE TRANSLATION BOUNDARY between "what a boot or a menu gesture asked
 * for" and the canonical session model.
 *
 * Issue #316 requires that EVERY production and developer entry point produce
 * one accurate Campaign, Practice, or Versus descriptor, with developer
 * provenance kept orthogonal rather than becoming a fourth session kind. Before
 * this module, `loop.ts` decided identity inline from `deps.initialVersusConfig`
 * alone, so `?dev=1&mode=ffa` built a genuine FFA world while retaining a
 * Campaign descriptor -- the HUD, the typed outcome, and the campaign-run
 * bookkeeping all then described that world as Campaign.
 *
 * This module is pure: it reads an already-parsed `DevFlags` VALUE and does no
 * URL parsing, no storage, no DOM. `app-state.ts` (the core model) does not
 * import it; it imports `app-state.ts`. That direction is the point -- the
 * model stays free of developer-flag concepts, and this adapter is the only
 * place they are interpreted.
 */

// ---------------------------------------------------------------------------
// Session identity -- the per-session policy a descriptor is DERIVED from
// ---------------------------------------------------------------------------

/**
 * What kind of session this is, held for as long as the session keeps that
 * character. Deliberately NOT the descriptor itself: a Practice session's
 * descriptor names the level it is currently on, and that level changes on
 * every advance/retry. Storing the descriptor instead of the identity is what
 * let a stale Practice descriptor survive onto a campaign board (issue #316's
 * review, finding 4) -- so `loop.ts` stores THIS, and re-derives the descriptor
 * from it plus the actual level on every single world build.
 *
 * `practice-level` covers both a menu Level-Select pick and a developer level
 * jump: both are isolated play on a real campaign level that must not touch the
 * active run. Which of the two it was lives in `DeveloperMetadata`.
 */
export type SessionIdentity =
  | { readonly kind: 'campaign' }
  | { readonly kind: 'practice-level' }
  | { readonly kind: 'practice-sandbox' }
  | { readonly kind: 'versus'; readonly rules: VersusRules };

export interface SessionContext {
  readonly identity: SessionIdentity;
  readonly developer: DeveloperMetadata;
}

export function campaignIdentity(): SessionIdentity {
  return { kind: 'campaign' };
}

/** The identity a menu Level-Select pick switches the session to. */
export function practiceLevelIdentity(): SessionIdentity {
  return { kind: 'practice-level' };
}

// ---------------------------------------------------------------------------
// Descriptor derivation
// ---------------------------------------------------------------------------

/**
 * Derive the retained descriptor for a session identity ON a given level.
 *
 * `levelOrdinal` is the 1-based position of the level actually being built, in
 * THIS session's own sequence (`loop.ts`'s `ordinalOf`). It is read only by the
 * `practice-level` arm -- Campaign carries no level in its descriptor (the run
 * store is authoritative for where a campaign is), and sandbox/versus levels are
 * synthetic one-element sequences whose ordinal would say nothing.
 *
 * Because this is a pure function of (identity, level), `loop.ts` can call it
 * at every world build instead of maintaining a mutable descriptor that a
 * transition could forget to update. That is what makes the Practice/Campaign
 * divergence structurally impossible rather than merely fixed at the sites
 * where it had been observed.
 */
export function descriptorFor(
  identity: SessionIdentity,
  levelOrdinal: number,
): SessionDescriptor {
  switch (identity.kind) {
    case 'campaign':
      return campaignDescriptor();
    case 'practice-level':
      return practiceLevelDescriptor(levelOrdinal);
    case 'practice-sandbox':
      return practiceSandboxDescriptor();
    case 'versus':
      return versusDescriptor(identity.rules);
    default: {
      const unreachable: never = identity;
      return unreachable;
    }
  }
}

// ---------------------------------------------------------------------------
// Boot translation
// ---------------------------------------------------------------------------

export interface BootSessionInput {
  /** Already-parsed developer flags. This module never parses a URL itself. */
  readonly devFlags: DevFlags;
  /**
   * The setup pane's config when this session is a versus reboot, else `null`.
   * Present iff `boot.ts` rebooted through `requestVersusSession`, which is
   * also exactly when a VERSUS `LevelSystem` is installed.
   */
  readonly versusConfig: VersusConfig | null;
  /**
   * Whether the `dev` gate itself was on. Not derivable from `DevFlags`: a bare
   * `?dev=1` parses to exactly `DEV_FLAGS_OFF`, so the flags object alone cannot
   * tell "developer mode, nothing enabled" from "no developer mode".
   */
  readonly developerMode: boolean;
}

/**
 * Translate one boot into its canonical session context.
 *
 * The branch order below mirrors how the world is ACTUALLY built, so the
 * descriptor cannot disagree with the running game:
 *
 *  1. a setup-pane versus reboot installs `createVersusLevelSystem` -> Versus,
 *     with the pane's selection snapshotted UNRESOLVED (it may still say
 *     `'random'`);
 *  2. `?dev=1&level=sandbox` installs the sandbox branch of
 *     `createLevelSystem` -> Practice on the sandbox, which has no campaign
 *     ordinal to report;
 *  3. `?dev=1&mode=ffa|teams` keeps the CAMPAIGN level system but builds every
 *     world with `mode: 'ffa'|'teams'` -> Versus. This is the case the review
 *     found retaining a Campaign descriptor;
 *  4. `?dev=1&level=N` jumps to a real campaign level but must not consume,
 *     advance, or end the active run -> Practice on that level, exactly the
 *     shape a menu Level-Select pick has. `sessionOrigin` is what tells the two
 *     apart;
 *  5. otherwise -> Campaign.
 *
 * `levelJump` is recorded independently of which branch won, because both facts
 * can be true at once (`?dev=1&mode=ffa&level=3` is a Versus session played on
 * level 3's arena). It is `null` for a setup-pane versus reboot, whose versus
 * `LevelSystem` ignores `level` entirely -- recording a jump there would claim
 * an effect that did not happen.
 */
export function resolveBootSessionContext(input: BootSessionInput): SessionContext {
  const { devFlags, versusConfig, developerMode } = input;
  const jumpedLevel = typeof devFlags.level === 'number' ? devFlags.level : null;

  // 1. Setup-pane versus reboot.
  if (versusConfig !== null) {
    return {
      identity: { kind: 'versus', rules: versusRulesFromConfig(versusConfig) },
      developer: {
        active: developerMode,
        // Pane-driven, not developer-driven: the session kind was chosen by a
        // player in the UI even when developer mode also happens to be on.
        sessionOrigin: null,
        // The versus LevelSystem never reads `level`; claiming a jump here
        // would be provenance for an effect that did not occur.
        levelJump: null,
      },
    };
  }

  // 2. Developer sandbox.
  if (devFlags.level === 'sandbox') {
    return {
      identity: { kind: 'practice-sandbox' },
      developer: { active: developerMode, sessionOrigin: 'sandbox', levelJump: null },
    };
  }

  // 3. Developer versus flags, on the campaign level system.
  if (devFlags.mode === 'ffa' || devFlags.mode === 'teams') {
    return {
      identity: {
        kind: 'versus',
        rules: versusRulesFromDeveloperFlags({
          mode: devFlags.mode,
          // `players` is its own flag and may be absent: `?dev=1&mode=ffa`
          // really does build a one-slot FFA world, and the rules say so
          // rather than inventing a plausible 2.
          players: devFlags.players ?? 1,
          friendlyFire: devFlags.friendlyFire,
        }),
      },
      developer: {
        active: developerMode,
        sessionOrigin: 'versus-flags',
        levelJump: jumpedLevel,
      },
    };
  }

  // 4. Developer level jump.
  if (jumpedLevel !== null) {
    return {
      identity: { kind: 'practice-level' },
      developer: { active: developerMode, sessionOrigin: 'level-jump', levelJump: jumpedLevel },
    };
  }

  // 5. Ordinary campaign.
  return {
    identity: { kind: 'campaign' },
    developer: { active: developerMode, sessionOrigin: null, levelJump: null },
  };
}

// ---------------------------------------------------------------------------
// Relaunch policy -- NOT session identity
// ---------------------------------------------------------------------------

/**
 * Which system this session's menu and outcome ACTIONS relaunch play through.
 *
 * A SEPARATE CONCEPT FROM SESSION IDENTITY, and the whole point of this type.
 * Identity answers "what is being played" (it is the descriptor's own kind, and
 * it drives the gameplay HUD: campaign stats, the versus stock strip).
 * This answers "what does the button DO", which is a question about the
 * installed `LevelSystem` and the reboot seam, not about the world:
 *
 *  - `'campaign-levels'`: Continue/Levels/New Game rebuild through the campaign
 *    `LevelSystem` that is actually installed, and a finished session's action
 *    button lands back on this session's own board ("Play Again"/"Retry").
 *  - `'versus-setup'`: there is no campaign level system to continue into --
 *    `createVersusLevelSystem` installed one synthetic level -- so Continue and
 *    Levels are hidden, New Game reads "Start Match", the Campaign button is
 *    offered, and a finished match's action button reopens the setup pane
 *    ("Versus Setup").
 *
 * The two genuinely disagree for exactly one boot, which is why they cannot be
 * one value: `?dev=1&mode=ffa|teams` has VERSUS identity (it really does build
 * an FFA/teams world -- see `resolveBootSessionContext` branch 3) while keeping
 * the CAMPAIGN level system, so its buttons must stay campaign-shaped. Folding
 * that boot's identity down to Campaign to get the buttons right is the defect
 * this split removes; folding its buttons up to Versus would relabel a click
 * that lands on a campaign board as "Versus Setup", which `loop.ts`'s
 * `onStartRestart` shows is not what the click does.
 *
 * TEMPORARY, in the sense the UI/UX direction gives it: #317's persistent shell
 * and #323's outcome redesign replace these legacy title/outcome affordances
 * outright. Until then this is the one place the policy is decided.
 */
export type RelaunchTarget = 'campaign-levels' | 'versus-setup';

/**
 * Decide a session's relaunch target from the canonical model -- the session
 * identity plus its developer provenance -- never from `initialVersusConfig`,
 * a URL read, or a `world.rules.mode` check (issue #316's HUD-identity criterion).
 *
 * `'versus-setup'` iff the SETUP PANE booted this session, which is exactly
 * `resolveBootSessionContext` branch 1 and exactly when
 * `createVersusLevelSystem` is installed.
 */
export function relaunchTargetFor(context: SessionContext): RelaunchTarget {
  return context.identity.kind === 'versus' && context.developer.sessionOrigin !== 'versus-flags'
    ? 'versus-setup'
    : 'campaign-levels';
}

// ---------------------------------------------------------------------------
// Menu-gesture identity transitions
// ---------------------------------------------------------------------------

/**
 * The identity a Levels-panel pick switches a session to, given the identity
 * that session BOOTED with.
 *
 * A level pick changes which LEVEL is played, not which GAME is played. It is
 * only a kind change for a real campaign boot, where picking a level is the
 * gesture that isolates play from the active run (issue #153's Practice/
 * Campaign split). Every other boot is already run-neutral and its own level
 * system keeps building its own kind of world:
 *
 *  - a developer-flag versus boot (`?dev=1&mode=ffa`) runs the CAMPAIGN level
 *    system, whose `world()` closure stamps `flags.mode` on EVERY world it
 *    builds (`levels.ts`) -- and the Levels button is genuinely reachable
 *    there, since that system reports the full campaign sequence. Returning
 *    Practice here would report `practice-result` for a match the sim decided
 *    by last-slot-standing, and would drop the stock strip mid-session;
 *  - the sandbox (`?dev=1&level=sandbox`) has one synthetic level that is not
 *    in any campaign sequence, so `practice-level`'s ordinal would be a
 *    fabrication;
 *  - a setup-pane versus boot has one synthetic level too;
 *  - a developer level jump is already `practice-level`.
 */
export function identityForLevelPick(bootIdentity: SessionIdentity): SessionIdentity {
  return bootIdentity.kind === 'campaign' ? practiceLevelIdentity() : bootIdentity;
}
