// Per-bot competence presets (issue #267).
//
// The contract these pin is a SHAPE, not a set of tuning numbers: the multipliers are
// provisional until the sweep both #267 and #223 ask for has been run, so asserting them
// literally would pin the one thing that is meant to move. What must not move is that
// `normal` is exactly nothing, that the ordering is monotone, that `hard` cannot become an
// oracle, and that difficulty never reaches a personality field.
import { describe, it, expect } from 'vitest';
import {
  withBotDifficulty,
  isBotDifficulty,
  BOT_DIFFICULTIES,
  DEFAULT_BOT_DIFFICULTY,
  MAX_COMPETENCE_ACCURACY,
  MIN_COMPETENCE_REACTION_TIME,
  type BotDifficulty,
} from './bot-difficulty';
import { configFor } from '../config';
import { TANK_KINDS } from '../config/validate';

/** The profile a versus bot actually inherits: a bot fills a PLAYER slot. */
const playerCfg = () => configFor('player');

describe('bot difficulty presets', () => {
  it('offers exactly three, in difficulty order, defaulting to the no-op', () => {
    expect(BOT_DIFFICULTIES).toEqual(['easy', 'normal', 'hard']);
    expect(DEFAULT_BOT_DIFFICULTY).toBe('normal');
    // The ids are stable and stored, so an unknown string from disk must not become one.
    expect(isBotDifficulty('normal')).toBe(true);
    expect(isBotDifficulty('nightmare')).toBe(false);
    expect(isBotDifficulty(undefined)).toBe(false);
  });

  it('normal is the SAME object, not merely an equal one', () => {
    // Referential identity, deliberately: this is what makes the whole feature additive.
    // A `toEqual` here would pass against a build that rebuilt the config every tick, and
    // the claim being made is stronger than equality -- a `normal` bot cannot differ from
    // a pre-#267 bot even by object shape.
    for (const kind of TANK_KINDS) {
      const cfg = configFor(kind);
      expect(withBotDifficulty(cfg, 'normal')).toBe(cfg);
      // ...and the same is true of an omitted argument, which is what every existing
      // caller of decidePlayerInput passes.
      expect(withBotDifficulty(cfg)).toBe(cfg);
    }
  });

  it('moves every competence axis monotonically, easy -> normal -> hard', () => {
    const base = playerCfg();
    const easy = withBotDifficulty(base, 'easy').ai;
    const normal = withBotDifficulty(base, 'normal').ai;
    const hard = withBotDifficulty(base, 'hard').ai;
    // Higher accuracy is better; higher reaction TIME is worse. Asserted as strict
    // inequalities so a preset that quietly became a no-op fails here.
    expect(easy.aimAccuracy).toBeLessThan(normal.aimAccuracy);
    expect(normal.aimAccuracy).toBeLessThan(hard.aimAccuracy);
    expect(easy.estimationAccuracy).toBeLessThan(normal.estimationAccuracy);
    expect(normal.estimationAccuracy).toBeLessThan(hard.estimationAccuracy);
    expect(easy.reactionTime).toBeGreaterThan(normal.reactionTime);
    expect(normal.reactionTime).toBeGreaterThan(hard.reactionTime);
  });

  it('never makes a bot an oracle, however hard the preset is applied', () => {
    // The issue's binding rule: "No preset may create oracle-perfect awareness or aim."
    // Both spreads are an anchor DIVIDED by accuracy, so a bounded accuracy is what keeps
    // the spread nonzero. Checked against a synthetic profile already at the ceiling, not
    // just the shipped one -- the shipped player profile is nowhere near it, so testing
    // only that would leave the clamp itself unexercised.
    const base = playerCfg();
    const extreme = { ...base, ai: { ...base.ai, aimAccuracy: 0.99, estimationAccuracy: 0.99, reactionTime: 0.21 } };
    const hard = withBotDifficulty(extreme, 'hard').ai;
    expect(hard.aimAccuracy).toBeLessThanOrEqual(MAX_COMPETENCE_ACCURACY);
    expect(hard.estimationAccuracy).toBeLessThanOrEqual(MAX_COMPETENCE_ACCURACY);
    expect(hard.aimAccuracy).toBeLessThan(1);
    expect(hard.estimationAccuracy).toBeLessThan(1);
    expect(hard.reactionTime).toBeGreaterThanOrEqual(MIN_COMPETENCE_REACTION_TIME);
    expect(hard.reactionTime).toBeGreaterThan(0);
  });

  it('touches competence ONLY -- personality is the profile\'s, at every difficulty', () => {
    // The division both issues make in the same words. Asserted by comparing whole
    // objects with the three competence axes removed, so a field added to AIProfile later
    // is covered by this test without anyone remembering to list it.
    const base = playerCfg();
    const strip = (cfg: ReturnType<typeof playerCfg>): Record<string, unknown> => {
      const { aimAccuracy, estimationAccuracy, reactionTime, ...personality } = cfg.ai;
      void aimAccuracy; void estimationAccuracy; void reactionTime;
      return { ...cfg, ai: personality };
    };
    for (const d of BOT_DIFFICULTIES) {
      expect(strip(withBotDifficulty(base, d))).toEqual(strip(base));
    }
  });

  it('composes over the AUTHORED profile rather than replacing it', () => {
    // A multiplier, not a table: two different base profiles must land on two different
    // results at the same preset. An absolute per-difficulty table would collapse them,
    // which is the "tank-by-difficulty profile matrix" both issues forbid by name.
    const base = playerCfg();
    const sharper = { ...base, ai: { ...base.ai, aimAccuracy: base.ai.aimAccuracy * 1.4 } };
    const a = withBotDifficulty(base, 'hard').ai.aimAccuracy;
    const b = withBotDifficulty(sharper, 'hard').ai.aimAccuracy;
    expect(b).toBeGreaterThan(a);
  });

  it('leaves a profile that is already clamped alone at easy, rather than inverting it', () => {
    // Guard against the clamp firing in the wrong direction: easy must never IMPROVE a
    // bot, even on a profile whose values sit near a bound.
    const base = playerCfg();
    const feeble = { ...base, ai: { ...base.ai, aimAccuracy: 0.2, estimationAccuracy: 0.2 } };
    const easy = withBotDifficulty(feeble, 'easy').ai;
    expect(easy.aimAccuracy).toBeLessThanOrEqual(feeble.ai.aimAccuracy);
    expect(easy.estimationAccuracy).toBeLessThanOrEqual(feeble.ai.estimationAccuracy);
  });

  it('every preset resolves for every shipped tank kind', () => {
    // Population stated: all shipped kinds x all three presets. A preset that threw on one
    // profile would be a crash in a versus match rather than a bad difficulty.
    let checked = 0;
    for (const kind of TANK_KINDS) {
      for (const d of BOT_DIFFICULTIES as readonly BotDifficulty[]) {
        const ai = withBotDifficulty(configFor(kind), d).ai;
        expect(Number.isFinite(ai.aimAccuracy)).toBe(true);
        expect(Number.isFinite(ai.estimationAccuracy)).toBe(true);
        expect(Number.isFinite(ai.reactionTime)).toBe(true);
        expect(ai.reactionTime).toBeGreaterThan(0);
        checked++;
      }
    }
    expect(checked).toBe(TANK_KINDS.length * 3);
  });
});
