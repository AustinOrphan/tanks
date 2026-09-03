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
 * ALL SIX AXES ARE HERE (#223 landed the other three). `AIProfile` shipped fields for
 * `aimAccuracy`, `reactionTime` and `estimationAccuracy`; #223 added `awarenessDelay`,
 * `safetyMargin` and `hazardRefreshTime`, and they joined `COMPETENCE` exactly as this
 * comment predicted, without the composition changing shape. Nothing else in `AIProfile` is
 * reachable from here, which is the personality/competence split made structural.
 *
 * TWO COMPOSITION KINDS, and the reason is arithmetic rather than taste. Five axes are
 * scaled MULTIPLICATIVELY, because they are magnitudes with a meaningful zero the profile
 * never authors and a multiplier is what lets a retuned profile carry all three difficulties
 * with it. `safetyMargin` is composed ADDITIVELY because it is SIGNED and authored at 0: a
 * multiplier cannot move zero, so an additive offset is the only composition under which
 * `easy` can cut a corner and `hard` can keep room while `normal` stays exactly the authored
 * value. Both kinds are explicit, bounded and validated, which is what both issues require;
 * neither introduces a per-kind override or a tank-by-difficulty table.
 *
 * THE NUMBERS ARE STILL PROVISIONAL, and the sweep that was missing has since been run --
 * ai/bot-difficulty.measure.test.ts, 16 seeds per arm on vs-duel-01. It reported `easy`
 * separating decisively (0 wins in 16, kill ledger inverted) and `hard` busier but not
 * measurably better at that population, which is recorded on #223 along with the mechanism
 * (the `AI_AIM_SPREAD` anchor, not the accuracy ceiling). Choosing new multipliers needs the
 * normal-speed human read #223 also requires, so the three incumbent columns are unchanged
 * here. What is NOT provisional is the structure: `normal` is exactly identity, the ordering
 * is monotone on every axis, and `hard` cannot reach perfection -- see the bounds below.
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

/** The modifier applied to each competence axis, per preset. */
interface CompetenceScale {
  /** Multiplier. Higher is better: `profileAimSpread` divides the anchor spread by this. */
  readonly aimAccuracy: number;
  /** Multiplier. Higher is better: `profileHazardSpread` divides the anchor by this. */
  readonly estimationAccuracy: number;
  /** Multiplier. Higher is WORSE -- a delay in seconds before a bot will take its shot. */
  readonly reactionTime: number;
  /**
   * Multiplier. Higher is WORSE -- seconds of staleness in the hazard picture
   * (`perceiveHazards`, ai/hazard-perception.ts). It shares `reactionTime`'s column value
   * because they are the same kind of handicap on the same clock: one is how long before a
   * bot shoots at what it sees, the other how long before it sees it at all.
   */
  readonly awarenessDelay: number;
  /**
   * ADDITIVE, world units, and the only signed entry in this table. Higher is BETTER: it is
   * extra clearance kept beyond the hazard radius a bot believes in, so `easy` goes negative
   * and cuts the corner while `hard` keeps room.
   */
  readonly safetyMargin: number;
  /**
   * Multiplier. Higher is WORSE -- seconds a bot lives with one hazard read before drawing a
   * new one. Longer means a bad read governs more of an encounter, which is what makes this
   * "less reliable" rather than merely "different"; it is bounded BELOW because refreshing
   * every tick averages the error away inside one dodge and hands the oracle back.
   */
  readonly hazardRefreshTime: number;
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
  easy: {
    aimAccuracy: 0.65, estimationAccuracy: 0.65, reactionTime: 1.7,
    awarenessDelay: 1.7, safetyMargin: -0.2, hazardRefreshTime: 1.7,
  },
  normal: {
    aimAccuracy: 1, estimationAccuracy: 1, reactionTime: 1,
    awarenessDelay: 1, safetyMargin: 0, hazardRefreshTime: 1,
  },
  hard: {
    aimAccuracy: 1.25, estimationAccuracy: 1.25, reactionTime: 0.7,
    awarenessDelay: 0.7, safetyMargin: 0.2, hazardRefreshTime: 0.7,
  },
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

/**
 * The shortest hazard-picture staleness a preset may produce, in seconds.
 *
 * The reaction-time floor's twin, and load-bearing for the same rule read the other way: a
 * bot whose picture is current to the tick reacts to the shell's TRUE position, which is
 * precisely the oracle escape solve issue #223 opens against. 0.05s is 3 ticks at 60Hz --
 * shorter than the perception window of the fastest authored reaction (0.25s) and long
 * enough that a shell at the slowest shell speed has visibly moved.
 */
export const MIN_COMPETENCE_AWARENESS_DELAY = 0.05;

/**
 * The shortest hazard-refresh window a preset may produce, in seconds.
 *
 * The limit case is the defect: a bot that re-draws its hazard error every tick averages the
 * error away over the frames of a single dodge and behaves as if it had none, which is the
 * "frame-to-frame noise" #223 names and the oracle by another route. 0.1s is 6 ticks, still
 * a fifth of the authored 0.5s window, so `hard` has real room before the floor binds.
 */
export const MIN_COMPETENCE_HAZARD_REFRESH = 0.1;

/**
 * The largest magnitude, in world units, either direction of `safetyMargin` may reach.
 *
 * Symmetric and applied to the RESOLVED value, so it bounds an authored margin plus the
 * preset's offset rather than the offset alone. 0.5 is one TANK_RADIUS: at the top a bot
 * keeps a tank's width of extra room, at the bottom it cuts a tank's width off the radius it
 * would otherwise flee to -- past which "cautious" and "careless" stop being adjustments to
 * a judgment and start being a different judgment.
 */
export const MAX_COMPETENCE_SAFETY_MARGIN = 0.5;

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
      awarenessDelay: Math.max(
        cfg.ai.awarenessDelay * scale.awarenessDelay,
        MIN_COMPETENCE_AWARENESS_DELAY,
      ),
      // The one ADDITIVE axis (see CompetenceScale.safetyMargin). Clamped symmetrically
      // rather than floored at zero: a negative resolved margin is `easy` cutting the
      // corner, which is the behaviour the preset is defined to produce, not a degenerate
      // value to be rescued.
      safetyMargin: clamp(
        cfg.ai.safetyMargin + scale.safetyMargin,
        -MAX_COMPETENCE_SAFETY_MARGIN,
        MAX_COMPETENCE_SAFETY_MARGIN,
      ),
      hazardRefreshTime: Math.max(
        cfg.ai.hazardRefreshTime * scale.hazardRefreshTime,
        MIN_COMPETENCE_HAZARD_REFRESH,
      ),
    },
  };
}
