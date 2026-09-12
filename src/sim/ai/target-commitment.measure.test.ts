/// <reference types="vite/client" />
import { describe, it } from 'vitest';
import { ARENAS, createWorldFor } from '../arena';
import { step } from '../world';
import { configFor } from '../config';
import { TICK_HZ } from '../constants';
import type { Tank } from '../types';
import type { World } from '../world';

// ---------------------------------------------------------------------------
// MEASUREMENT HARNESS, skipped in CI on purpose: TARGET COMMITMENT, scored BY CAUSE.
//
// Issue #359's remaining evidence item: "run the bounded deterministic comparison needed
// to validate the current uniform commitment time and material-switch threshold; change
// them only if evidence supports it."
//
// WHY THIS COULD NOT BE WRITTEN BEFORE. `commitTarget` computed a retarget reason and every
// caller discarded it, so a run could be scored on how OFTEN targets changed and never on
// WHY. Those two questions have opposite answers here: a high retarget rate driven by
// `target-lost` is a lethal match doing its job, and the same rate driven by
// `switched-on-expiry` is the thrashing the commitment window exists to prevent. Recording
// the reason is what makes this harness say something.
//
// WHY IT DOES NOT SWEEP THE VALUES. `configFor` resolves its catalogue once at module load,
// so varying `targetCommitmentTime` would mean `vi.mock` or a reimplementation of the
// policy inside the harness -- and a measurement of a reimplementation is a measurement of
// the reimplementation. This runs PRODUCTION `step()` at shipped values and reports the
// distributions that decide whether those values are right:
//
//  - **If `switched-on-expiry` almost never fires**, the material-switch margin is too high
//    (or targets never become materially better) and the commitment is effectively
//    permanent -- the span is doing nothing and could be any value at all.
//  - **If it fires at nearly every expiry**, the margin is too low: the AI is thrashing on
//    the span boundary, which is the defect the window was added to fix, just clocked.
//  - **If held durations cluster well under the span**, the span is not the binding
//    constraint -- `target-lost` is -- and tuning it would change nothing.
//
// MEASURED, 2026-09-08, at the shipped span of 90 ticks (1.5s), over 2 arenas x player
// counts 2/3/4 x 8 seeds:
//
//  - expiry-switch rate **1.9%-6.8%, mean 4.4%** across all 18 rows. Roughly 95 of every 100
//    expiries re-commit to the same opponent.
//  - median hold **144-338 ticks against a span of 90**, p95 up to 1850.
//  - `target-lost` dominates and scales with player count (about 3.3/min at 2 players,
//    about 4-8.5/min at 4); `switched-on-expiry` does not scale and stays near 1-2.5/min.
//
// READING: the span is very nearly inert. It expires constantly and almost never changes
// anything, so the value it holds is not what governs this behaviour -- the material-switch
// margin is, and it is rejecting ~95% of the challengers it sees. Target changes are driven
// by opponents dying, not by the clock. That is an argument for changing NEITHER value, and
// it also makes rule 4's uniformity question moot: there is no evidence for per-profile
// spans because the span barely matters at any value.
//
// Multi-player worlds, because that is the issue's subject: at playerCount 1 an enemy has
// exactly one opponent and there is nothing to select between, so a single-player
// measurement would report zeroes and prove nothing.
//
// KNOWN LIMIT OF THE SAMPLE, stated because it bounds what the numbers support. The player
// here wanders and never shoots, so a run ends when the arena kills it -- games are short,
// and the per-minute rates are computed over modest alive-time. What survives that is the
// SHAPE rather than the absolute rate: the expiry-switch percentage and the hold-versus-span
// ratio are ratios within a run, and they hold consistently across all 18 (arena, player
// count, kind) rows, which is why the reading below rests on those two and not on the rates.
//
// Usage: set VITE_RUN_MEASURE=1, run
//   VITE_RUN_MEASURE=1 npx vitest run src/sim/ai/target-commitment.measure.test.ts --testTimeout=3600000
//
// Read via `import.meta.env`, NOT `process.env`: this file lives under src/sim/, whose
// purity rule forbids the latter, and VITE_ is the required prefix for a shell env var to
// reach `import.meta.env` at all.
// ---------------------------------------------------------------------------

const SEEDS = 8;
const MAX_TICKS = 60 * 90; // 90s of game time per seed, at the fixed 60Hz step
const PLAYER_COUNTS = [2, 3, 4] as const;

type Reason = NonNullable<Tank['aiRetargetReason']>;

interface KindStats {
  /** Retargets by cause. */
  readonly counts: Record<Reason, number>;
  /** How many ticks each commitment was HELD before it changed. */
  readonly holds: number[];
  /** Spans that reached expiry: did the next tick switch, or re-commit? */
  expiries: number;
  switchedAtExpiry: number;
  /** Ticks this kind was alive, so rates are per-minute rather than per-run. */
  aliveTicks: number;
}

const emptyStats = (): KindStats => ({
  counts: { acquired: 0, 'target-lost': 0, 'switched-on-expiry': 0 },
  holds: [],
  expiries: 0,
  switchedAtExpiry: 0,
  aliveTicks: 0,
});

/** A wandering, non-shooting player: the AI's behaviour is the subject, not a duel. */
function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function run(arenaIdx: number, playerCount: number): string {
  const stats = new Map<string, KindStats>();
  const statsFor = (kind: string): KindStats => {
    let s = stats.get(kind);
    if (!s) { s = emptyStats(); stats.set(kind, s); }
    return s;
  };

  for (let seed = 1; seed <= SEEDS; seed++) {
    let w: World = createWorldFor(ARENAS[arenaIdx], seed, { lives: 3, playerCount: playerCount });
    const rnd = mulberry(seed * 7919 + 13);
    let heading = rnd() * Math.PI * 2;
    /** Per-tank carry-over, so a change can be attributed and a hold can be measured. */
    const heldFor = new Map<number, number>();
    const wasAtExpiry = new Map<number, boolean>();

    for (let t = 0; t < MAX_TICKS && w.status === 'playing'; t++) {
      for (const tank of w.tanks) {
        if (tank.kind === 'player' || !tank.alive) continue;
        const s = statsFor(tank.kind);
        s.aliveTicks += 1;

        // A retarget is age zero: `commitTarget` resets the age at the one place it writes
        // a reason, so this reads changes rather than inferring them from an id diff --
        // which would miss a switch back to the same opponent.
        const fresh = tank.aiRetargetReason !== undefined && (tank.aiRetargetAgeTicks ?? -1) === 0;
        if (fresh) {
          s.counts[tank.aiRetargetReason as Reason] += 1;
          const held = heldFor.get(tank.id);
          if (held !== undefined) s.holds.push(held);
          heldFor.set(tank.id, 0);
          // Was the PREVIOUS tick sitting at expiry? Then this change is the expiry
          // decision resolving, and it resolved by switching.
          if (wasAtExpiry.get(tank.id)) s.switchedAtExpiry += 1;
        } else {
          heldFor.set(tank.id, (heldFor.get(tank.id) ?? 0) + 1);
        }
        // An expiry is a tick whose span has run out. The NEXT tick either switches
        // (counted above) or re-commits, and both outcomes are what the margin decides.
        const atExpiry = tank.aiTargetId !== undefined && (tank.aiTargetTicks ?? 0) === 0;
        if (atExpiry && !wasAtExpiry.get(tank.id)) s.expiries += 1;
        wasAtExpiry.set(tank.id, atExpiry);
      }

      heading += (rnd() - 0.5) * 0.4;
      const dir = { x: Math.cos(heading), y: Math.sin(heading) };
      w = step(w, { move: dir, aim: dir, fire: false, mine: false }).world;
    }
  }

  const q = (a: number[], p: number): number =>
    a.length === 0 ? NaN : [...a].sort((x, y) => x - y)[Math.floor(a.length * p)];

  const rows = [...stats.entries()].sort().map(([kind, s]) => {
    const minutes = s.aliveTicks / TICK_HZ / 60;
    const per = (n: number): string => (minutes === 0 ? 'n/a' : (n / minutes).toFixed(2));
    const span = Math.round(configFor(kind as never).ai.targetCommitmentTime * TICK_HZ);
    const switchRate = s.expiries === 0 ? 'n/a' : `${((100 * s.switchedAtExpiry) / s.expiries).toFixed(1)}%`;
    return [
      `${kind.padEnd(7)} span=${String(span).padStart(3)}t`,
      `per-min acquired=${per(s.counts.acquired)} lost=${per(s.counts['target-lost'])} switched=${per(s.counts['switched-on-expiry'])}`,
      `hold p50=${q(s.holds, 0.5)} p95=${q(s.holds, 0.95)} n=${s.holds.length}`,
      `expiries=${s.expiries} switched=${switchRate}`,
    ].join('  ');
  });
  return `arena${arenaIdx + 1} players=${playerCount}\n  ${rows.join('\n  ')}`;
}

const measure = import.meta.env.VITE_RUN_MEASURE ? describe : describe.skip;

measure('target-commitment measurement (set VITE_RUN_MEASURE=1 to run)', () => {
  it('reports retarget causes, hold durations and expiry outcomes per kind', () => {
    const out: string[] = [];
    for (const arena of [0, 2]) {
      for (const players of PLAYER_COUNTS) out.push(run(arena, players));
    }
    console.log('\n' + out.join('\n'));
  });
});
