import { describe, it, expect } from 'vitest';
import { createWorldFor } from './arena';
import { arenaById } from './config/arenas';
import { stepInputs } from './world';
import { createPlayerAiState, decidePlayerInput, mulberry32 } from './ai/player-profile';
import type { GameMode } from './types';

const HZ = 60;
const SECONDS = 90;
const PLAYERS = 3;

function playMatch(mode: GameMode, seed: number) {
  const arena = arenaById('vs-tri-01');
  const world = createWorldFor(arena, seed, undefined, 3, undefined, undefined, PLAYERS, undefined, mode);
  let w = world;
  const players = w.tanks.filter((t) => t.kind === 'player').map((t) => t.id);
  const rnd = players.map((_, i) => mulberry32(seed * 31 + i + 1));
  const ai = rnd.map((r) => createPlayerAiState(r));
  const obs = {
    mode, seed, players: players.length,
    firstContactTick: -1, shots: 0, mines: 0, kills: 0, breaches: 0,
    minSeparation: Infinity, maxSeparation: 0, sepSum: 0, pairTicks: 0,
    wallsAtStart: w.walls.length, firstKillTick: -1,
    teamSizes: [0, 0] as [number, number],
  };
  // Sampled once at t=0, before any death can empty a side: whether `teams` really split
  // this board, and HOW. At three players `teamOf(slot) = slot % 2` (arena.ts) stamps
  // 0/1/0 over the picker's order, so the split is 2v1 by construction -- which since
  // issue #584 is a supported match rather than the unfairness vs-tri-01's `ffa`-only
  // declaration was once justified by. The pane can override it per slot
  // (`teams?.[i] ?? teamOf(i)`, arena.ts:363); this harness measures the DEFAULT stamp,
  // which is the assignment a player who never touches the team controls will get.
  for (const t of w.tanks.filter((x) => x.kind === 'player')) {
    if (t.team === 0 || t.team === 1) obs.teamSizes[t.team]++;
  }
  for (let t = 0; t < HZ * SECONDS; t++) {
    const inputs = players.map((id, i) => decidePlayerInput(w, id, rnd[i], ai[i]));
    const res = stepInputs(w, inputs);
    w = res.world;
    for (const e of res.events) {
      // Hyphenated, and copied from the sim's own union rather than guessed: a harness
      // that counts 'tankDestroyed'/'wallDestroyed' reports 0 for both counters forever
      // and reads as a peaceful match. The assertions below are what would catch that.
      if (e.type === 'fire') obs.shots++;
      if (e.type === 'mine-dropped') obs.mines++;
      if (e.type === 'tank-destroyed') obs.kills++;
      if (e.type === 'wall-destroyed') obs.breaches++;
    }
    // Every LIVING pair, not just one: at N=3 the interesting quantity is whether the
    // three-way spacing the board is authored for survives contact.
    const alive = w.tanks.filter((x) => x.kind === 'player' && x.alive);
    for (let i = 0; i < alive.length; i++) {
      for (let j = i + 1; j < alive.length; j++) {
        const d = Math.hypot(alive[i].pos.x - alive[j].pos.x, alive[i].pos.y - alive[j].pos.y);
        obs.minSeparation = Math.min(obs.minSeparation, d);
        obs.maxSeparation = Math.max(obs.maxSeparation, d);
        obs.sepSum += d;
        obs.pairTicks++;
        if (obs.firstContactTick < 0 && d < 8) obs.firstContactTick = t;
      }
    }
    if (obs.kills > 0 && obs.firstKillTick < 0) obs.firstKillTick = t;
  }
  return {
    ...obs,
    meanSeparation: obs.pairTicks ? obs.sepSum / obs.pairTicks : 0,
    firstContactSec: obs.firstContactTick < 0 ? null : obs.firstContactTick / HZ,
    firstKillSec: obs.firstKillTick < 0 ? null : obs.firstKillTick / HZ,
  };
}

// MEASUREMENT HARNESS, gated on an env var rather than describe.skip -- the convention
// this repo already uses (ai/commitment.measure.test.ts, duel-playtest.measure.test.ts),
// because hand-flipping a skip is a one-word diff easy to miss in review.
//
// Issue #272 asks for normal-speed playtest observations for every declared mode, and
// since issue #627 vs-tri-01 declares TWO -- `ffa` and `teams` -- so both are driven here.
// The `teams` arm is new: the board declared `ffa` alone until #584 established that
// asymmetric Teams are intentionally supported in PP1, which retired the "three players
// have no fair team split" reasoning the narrowing rested on.
//
// WHAT THIS HARNESS IS NOT. #627 rules that normal-speed HUMAN play is authoritative for
// whether Keystone is a good 2v1 board, and automated measurement is supporting evidence
// only. This is automated measurement: bots, at the sim layer, with no read on how the
// board feels. It can show that a 2v1 match on this board is fought rather than stalled,
// and it can show the default stamp is 2v1 at all; it cannot show that the axis spawn is
// not quietly doomed against two allied bases. Do not cite it as the ruling.
//
// There is still no shipped path to a bot-vs-bot match on a CHOSEN versus board -- the
// setup pane's slot rows offer Keyboard/None, bot roles come from #260's slot-source
// model, and the `bots` dev flag runs the campaign level system -- so the match is driven
// here instead, at the sim layer, through the REAL scripted-player AI all three sides use,
// at the real 60 Hz fixed timestep for 90 seconds.
const measure = import.meta.env.VITE_RUN_MEASURE ? describe : describe.skip;

measure('vs-tri-01 bot-vs-bot playtest (set VITE_RUN_MEASURE=1 to run)', () => {
  it('records observations for every declared mode', () => {
    for (const mode of ['ffa', 'teams'] as GameMode[]) {
      for (const seed of [7, 11, 23]) {
        const o = playMatch(mode, seed);
        console.log(`PLAYTEST ${mode} seed=${seed} players=${o.players} shots=${o.shots} mines=${o.mines} kills=${o.kills} breaches=${o.breaches} firstContact=${o.firstContactSec}s firstKill=${o.firstKillSec}s sep(min/mean/max)=${o.minSeparation.toFixed(2)}/${o.meanSeparation.toFixed(2)}/${o.maxSeparation.toFixed(2)} teams=${o.teamSizes.join('v')}`);
        // NOT `expect(true).toBe(true)`. Each of these fails on a specific, previously-made
        // mistake rather than decorating the run:
        //   - players: the board really seated THREE tanks, so this is an N=3 observation
        //     and not a silently-2-player one (createWorldFor's playerCount is positional).
        //   - shots + mines: the AI actually engaged, counted across BOTH weapons rather
        //     than shells alone. Measured while writing this: seed 23 fires zero shells in
        //     90 seconds and still takes 4 kills and 7 breaches, entirely from mines -- so
        //     `shots > 0` asserted a guarantee the sim does not make, and was replaced
        //     rather than tuned around. The event names are hyphenated and taken from
        //     `events.ts`'s union; a harness that invents camelCase names reports 0 for
        //     every counter, which is the bug that once made six matches read as peaceful.
        //   - pairTicks: the separation figures have a population behind them, so the
        //     min/mean/max above cannot be Infinity/0/0 from an empty loop.
        expect(o.players, `${mode} seed=${seed}: seated players`).toBe(PLAYERS);
        expect(o.shots + o.mines, `${mode} seed=${seed}: the match was fought`).toBeGreaterThan(0);
        expect(o.pairTicks, `${mode} seed=${seed}: separation was sampled`).toBeGreaterThan(0);
        //   - teamSizes: the one assertion that discriminates BETWEEN the two modes rather
        //     than repeating the ffa run twice, and at three players it also pins the SHAPE
        //     of the split. 2v1 is the whole of what issue #627 approved: an even split is
        //     arithmetically impossible here, so `[2, 1]` failing would mean either that
        //     `teams` stamped nobody (the mode silently not applying) or that the default
        //     stamp had drifted off `teamOf(slot) = slot % 2`. The ffa branch asserts the
        //     complement -- no team stamped at all -- so neither direction can drift into
        //     the other unnoticed.
        if (mode === 'teams') {
          expect(o.teamSizes, `${mode} seed=${seed}: the 2v1 split #627 approved`).toEqual([2, 1]);
        } else {
          expect(o.teamSizes, `${mode} seed=${seed}: ffa stamps no team`).toEqual([0, 0]);
        }
      }
    }
  }, 300000);
});
