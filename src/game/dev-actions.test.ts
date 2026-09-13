import { describe, it, expect } from 'vitest';
import {
  DEV_ACTIONS,
  DEV_ACTION_IDS,
  runDevAction,
  type DevActionId,
  type DevActionPort,
} from './dev-actions';

/**
 * A port that records what it was asked for and answers with whatever it is told to.
 *
 * `rebuild` returns a seed of its OWN choosing rather than echoing the request, because that
 * is what a real session does: `loop.ts` resolves `null` against a clock, and can resolve a
 * requested seed differently if something outranks it. A fake that echoed would make the
 * "reports what the world is running, not what was asked for" case unfalsifiable.
 */
function port(
  overrides: Partial<{ seed: number; hasRound: boolean; resolved: number }> = {},
): DevActionPort & { calls: Array<{ seed: number | null; keepLives: boolean }> } {
  const calls: Array<{ seed: number | null; keepLives: boolean }> = [];
  return {
    calls,
    currentSeed: () => overrides.seed ?? 1234,
    hasRound: () => overrides.hasRound ?? true,
    rebuild: (seed, keepLives) => {
      calls.push({ seed, keepLives });
      return overrides.resolved ?? seed ?? 99999;
    },
  };
}

describe('the action catalogue', () => {
  it('names every id exactly once, and every entry names itself', () => {
    // The catalogue is a `Record` keyed by id AND each entry repeats its own id, so the two
    // can disagree. A pane rendering `DEV_ACTIONS[id].label` beside a handler dispatching on
    // the key would then show one action and run another.
    expect(Object.keys(DEV_ACTIONS).sort()).toEqual([...DEV_ACTION_IDS].sort());
    for (const id of DEV_ACTION_IDS) expect(DEV_ACTIONS[id].id).toBe(id);
  });

  it('gives every action that rebuilds the world a confirmation, with distinct wording', () => {
    // All three discard the round. The labels differ because the armed control is the only
    // thing that says WHICH action is one press from firing, and three identical prompts
    // would make the armed state useless.
    const labels = DEV_ACTION_IDS.map((id) => DEV_ACTIONS[id].confirmLabel);
    expect(DEV_ACTION_IDS.every((id) => DEV_ACTIONS[id].confirms)).toBe(true);
    expect(new Set(labels).size).toBe(labels.length);
    expect(new Set(DEV_ACTION_IDS.map((id) => DEV_ACTIONS[id].label)).size).toBe(3);
  });
});

describe('runDevAction: which arguments each action implies', () => {
  it('restarts the same seed by NAMING it, and resets lives', () => {
    // Criterion 1: "same-seed restart reproduces the deterministic initial state". Asking for
    // the current seed is half of it; resetting lives is the other half, because the same
    // seed with a depleted life count is a different initial state, not the same one.
    const p = port({ seed: 777 });
    expect(runDevAction('restart-same-seed', p)).toEqual({ kind: 'ran', id: 'restart-same-seed', seed: 777 });
    expect(p.calls).toEqual([{ seed: 777, keepLives: false }]);
  });

  it('rerolls by asking for NO seed, so the session draws a fresh one', () => {
    // `null`, not "some other number this module invented": choosing a seed is the session's
    // job -- it owns the clock and the flag precedence -- and a pure module inventing one
    // would be a second seed policy that could disagree with the first.
    const p = port({ resolved: 424242 });
    expect(runDevAction('reroll-seed', p)).toEqual({ kind: 'ran', id: 'reroll-seed', seed: 424242 });
    expect(p.calls).toEqual([{ seed: null, keepLives: false }]);
  });

  it('restarts the round keeping lives, which is the one action that carries state', () => {
    // Criterion 3: "preserves documented match/session fields and resets only documented
    // round state". The documented carried field is lives; the level, session identity,
    // assignment and run are preserved by NOT being arguments at all.
    const p = port();
    runDevAction('restart-round', p);
    expect(p.calls).toEqual([{ seed: null, keepLives: true }]);
  });

  it('separates the three, so no two actions ask for the same thing', () => {
    // The negative control for the three cases above: a dispatch that collapsed (an `if`
    // falling through, a copy-pasted branch) would make two of these identical, and each
    // case alone would still pass.
    const asked = DEV_ACTION_IDS.map((id) => {
      const p = port({ seed: 5 });
      runDevAction(id, p);
      return JSON.stringify(p.calls[0]);
    });
    expect(new Set(asked).size).toBe(3);
  });
});

describe('runDevAction: what it reports, and when it refuses', () => {
  it('reports the seed the WORLD is running, not the one it asked for', () => {
    // The difference between an action and a claim. A session can resolve a request
    // differently -- a pinned `?seed=` that outranked the request, a clamp, a rejection --
    // and a pane echoing the intention would state a seed no world was ever built from,
    // which is exactly the number a developer is about to paste into an issue.
    const p = port({ seed: 777, resolved: 111 });
    expect(runDevAction('restart-same-seed', p)).toEqual({ kind: 'ran', id: 'restart-same-seed', seed: 111 });
  });

  it('refuses every action with no round, and rebuilds nothing', () => {
    // "Focused tests cover ... invalid/unavailable states". The pane is reachable from the
    // main menu, where there is no board: a rebuild there would have nothing to rebuild, and
    // the refusal carries a reason so the pane says why rather than appearing to do nothing.
    for (const id of DEV_ACTION_IDS) {
      const p = port({ hasRound: false });
      expect(runDevAction(id, p), id).toEqual({ kind: 'refused', id, reason: 'no-round' });
      expect(p.calls, id).toEqual([]);
    }
  });

  it('asks whether there is a round BEFORE asking what seed it is running', () => {
    // Order matters: `currentSeed()` on a session with no world is a question with no honest
    // answer, and a port that threw there would turn a refusal into a crash.
    const asked: string[] = [];
    const p: DevActionPort = {
      currentSeed: () => {
        asked.push('currentSeed');
        return 1;
      },
      hasRound: () => {
        asked.push('hasRound');
        return false;
      },
      rebuild: () => {
        asked.push('rebuild');
        return 1;
      },
    };
    runDevAction('restart-same-seed', p);
    expect(asked).toEqual(['hasRound']);
  });

  it('carries the id back on every outcome, so a pane cannot attribute a result to the wrong button', () => {
    for (const id of DEV_ACTION_IDS) {
      expect(runDevAction(id, port()).id, id).toBe(id);
      expect(runDevAction(id, port({ hasRound: false })).id, id).toBe(id);
    }
  });
});

describe('the id union and the runtime list agree', () => {
  it('accepts every DevActionId the type allows', () => {
    // A compile-time union and a runtime array are two lists, and `DEV_ACTION_IDS` is the
    // source of the type -- so this is not circular, it is the check that nothing dispatches
    // on a fourth id the catalogue never got.
    const ids: DevActionId[] = [...DEV_ACTION_IDS];
    for (const id of ids) expect(runDevAction(id, port()).kind).toBe('ran');
  });
});
