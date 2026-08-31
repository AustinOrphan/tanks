import type { ResolvedTankConfig } from '../config/types';

/**
 * Per-bot competence presets for versus (issue #267).
 *
 * THE BINDING MODEL, which both this issue and #223 state in the same words: a difficulty
 * preset is an *orthogonal competence modifier applied over the tank type's authored AI
 * profile*. The profile keeps personality -- behaviour, aggression, preferred and minimum
 * distance, retreat tendency, movement and shot commitment, direct-vs-bank preference,
 * mine tendency, weapons. Difficulty may only make a bot better or worse at the things it
 * is already trying to do.
 *
 * WHY MULTIPLIERS AND NOT VALUES. An absolute table would BE a tank-by-difficulty profile
 * matrix, which both issues forbid by name, and it would silently stop tracking the
 * authored profile the first time anyone retuned it -- `hard` would keep asserting the
 * number it was written with. A multiplier composes: retune the profile and all three
 * difficulties move with it, which is what "over the authored profile" has to mean.
 *
 * THE THREE AXES HERE ARE THE THREE THAT EXIST. Both issues list six; `AIProfile` ships
 * fields for `aimAccuracy`, `reactionTime` and `estimationAccuracy` only. Awareness delay,
 * safety margin and hazard-perception refresh cadence have no field yet, and **#223 owns
 * them** -- its first acceptance criterion is that its presets "resolve through the
 * canonical preset selected by #267", i.e. through this table. When those fields land they
 * join `COMPETENCE`, and nothing here has to change shape to accept them.
 *
 * THE NUMBERS ARE PROVISIONAL. Both issues ask for modifiers "selected from deterministic
 * sweeps and representative normal-speed play evidence", and no such sweep has been run.
 * What is NOT provisional is the structure: `normal` is exactly identity, the ordering is
 * monotone on every axis, and `hard` cannot reach perfection -- see `clampCompetence`.
 */
export type BotDifficulty = 'easy' | 'normal' | 'hard';

/** Offer order, which is also difficulty order. */
export const BOT_DIFFICULTIES: readonly BotDifficulty[] = ['easy', 'normal', 'hard'];

/**
 * What a slot with no explicit choice plays at.
 *
 * `normal` is the exact no-op, so this default is what makes the whole feature additive:
 * a config saved before difficulty existed, and a slot the player never touched, both
 * resolve to the profile the game already shipped.
 */
export const DEFAULT_BOT_DIFFICULTY: BotDifficulty = 'normal';

export function isBotDifficulty(value: unknown): value is BotDifficulty {
  return typeof value === 'string' && (BOT_DIFFICULTIES as readonly string[]).includes(value);
}

/** The multiplier applied to each competence axis, per preset. */
interface CompetenceScale {
  /** Higher is better: `profileAimSpread` divides the anchor spread by this. */
  readonly aimAccuracy: number;
  /** Higher is better: `profileHazardSpread` divides the anchor spread by this. */
  readonly estimationAccuracy: number;
  /** Higher is WORSE -- it is a delay in seconds before a bot will take its shot. */
  readonly reactionTime: number;
}

/**
 * The presets.
 *
 * `normal` is all-ones and is additionally short-circuited in `withBotDifficulty`, so it
 * is identity by construction and not merely by arithmetic -- floating-point multiplication
 * by 1 is exact, but relying on that for a "byte-identical no-op" claim is the kind of
 * argument that stops being true the day someone writes 1.0 as 100/100.
 *
 * The asymmetry between `easy` and `hard` is deliberate. `easy` moves further from
 * `normal` than `hard` does, because the shipped player profile (`STATIC_BASIC`: aim 0.55,
 * reaction 0.8s, estimation 0.5) is already a middling opponent -- there is far more room
 * below it than above it before a bot stops being fun in the other direction.
 */
const COMPETENCE: Record<BotDifficulty, CompetenceScale> = {
  easy: { aimAccuracy: 0.65, estimationAccuracy: 0.65, reactionTime: 1.7 },
  normal: { aimAccuracy: 1, estimationAccuracy: 1, reactionTime: 1 },
  hard: { aimAccuracy: 1.25, estimationAccuracy: 1.25, reactionTime: 0.7 },
};

/**
 * The ceiling on either accuracy axis, and the reason `hard` can never be an oracle.
 *
 * Both `profileAimSpread` and `profileHazardSpread` derive a spread by DIVIDING an anchor
 * by the accuracy, so spread shrinks to nothing only as accuracy grows without bound. A
 * ceiling below 1 therefore guarantees a nonzero spread: some seeded error survives at
 * `hard`, which is exactly the "no preset may create oracle-perfect awareness or aim"
 * rule, enforced rather than asserted.
 *
 * 0.95 is the best accuracy any shipped profile carries (`RICOCHET_SNIPER`), so `hard`
 * cannot make a bot sharper than the sharpest authored enemy in the game.
 */
export const MAX_COMPETENCE_ACCURACY = 0.95;

/** Floor on either accuracy, so `easy` degrades into clumsiness rather than into a divide
 *  by something near zero -- the spread is the anchor divided by this. */
export const MIN_COMPETENCE_ACCURACY = 0.15;

/**
 * The shortest reaction a preset may produce, in seconds.
 *
 * 0.2s is 12 ticks at 60Hz, and below the fastest authored profile (`BERSERKER_ROCKET`,
 * 0.25s). The floor is the second half of "retains nonzero reaction limitations": without
 * it a large enough `hard` multiplier would eventually reach a bot that fires on the tick
 * it acquires.
 */
export const MIN_COMPETENCE_REACTION_TIME = 0.2;

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/**
 * A resolved config with its competence axes scaled by `difficulty`.
 *
 * Returns the INPUT OBJECT UNCHANGED for `normal` -- referential identity, not an equal
 * copy. That is what lets the no-op claim be checked with `toBe` rather than `toEqual`,
 * and it means a `normal` bot cannot differ from a pre-#267 bot even by object shape.
 *
 * Everything except `ai` is passed through untouched, which is the profile/competence
 * split made structural: there is no path here that can reach `behavior`, `weapon`,
 * `movementSpeed` or the distance band, so a future edit cannot quietly widen difficulty
 * into personality without changing this function's shape.
 */
export function withBotDifficulty(
  cfg: ResolvedTankConfig,
  difficulty: BotDifficulty = DEFAULT_BOT_DIFFICULTY,
): ResolvedTankConfig {
  if (difficulty === 'normal') return cfg;
  const scale = COMPETENCE[difficulty];
  return {
    ...cfg,
    ai: {
      ...cfg.ai,
      aimAccuracy: clamp(
        cfg.ai.aimAccuracy * scale.aimAccuracy,
        MIN_COMPETENCE_ACCURACY,
        MAX_COMPETENCE_ACCURACY,
      ),
      estimationAccuracy: clamp(
        cfg.ai.estimationAccuracy * scale.estimationAccuracy,
        MIN_COMPETENCE_ACCURACY,
        MAX_COMPETENCE_ACCURACY,
      ),
      reactionTime: Math.max(
        cfg.ai.reactionTime * scale.reactionTime,
        MIN_COMPETENCE_REACTION_TIME,
      ),
    },
  };
}
