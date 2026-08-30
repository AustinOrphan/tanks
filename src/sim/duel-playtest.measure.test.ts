import { describe, it, expect } from 'vitest';
import { createWorldFor } from './arena';
import { arenaById } from './config/arenas';
import { stepInputs } from './world';
import { createPlayerAiState, decidePlayerInput, mulberry32 } from './ai/player-profile';
import type { GameMode } from './types';

const HZ = 60;
const SECONDS = 90;

function playMatch(mode: GameMode, seed: number) {
  const arena = arenaById('vs-duel-01');
  const world = createWorldFor(arena, seed, undefined, 3, undefined, undefined, 2, undefined, mode);
  let w = world;
  const players = w.tanks.filter((t) => t.kind === 'player').map((t) => t.id);
  const rnd = players.map((_, i) => mulberry32(seed * 31 + i + 1));
  const ai = rnd.map((r) => createPlayerAiState(r));
  const obs = {
    mode, seed, players: players.length,
    firstContactTick: -1, shots: 0, kills: 0, breaches: 0,
    minSeparation: Infinity, maxSeparation: 0, sepSum: 0, ticks: 0,
    wallsAtStart: w.walls.length, endTick: -1,
  };
  for (let t = 0; t < HZ * SECONDS; t++) {
    const inputs = players.map((id, i) => decidePlayerInput(w, id, rnd[i], ai[i]));
    const res = stepInputs(w, inputs);
    w = res.world;
    for (const e of res.events) {
      if (e.type === 'fire') obs.shots++;
      if (e.type === 'tank-destroyed') obs.kills++;
      if (e.type === 'wall-destroyed') obs.breaches++;
    }
    const alive = w.tanks.filter((x) => x.kind === 'player' && x.alive);
    if (alive.length === 2) {
      const [a, b] = alive;
      const d = Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y);
      obs.minSeparation = Math.min(obs.minSeparation, d);
      obs.maxSeparation = Math.max(obs.maxSeparation, d);
      obs.sepSum += d;
      obs.ticks++;
      if (obs.firstContactTick < 0 && d < 8) obs.firstContactTick = t;
    }
    if (obs.kills > 0 && obs.endTick < 0) obs.endTick = t;
  }
  return {
    ...obs,
    meanSeparation: obs.ticks ? obs.sepSum / obs.ticks : 0,
    firstContactSec: obs.firstContactTick < 0 ? null : obs.firstContactTick / HZ,
    firstKillSec: obs.endTick < 0 ? null : obs.endTick / HZ,
  };
}

// MEASUREMENT HARNESS, gated on an env var rather than describe.skip -- the convention
// this repo already uses (ai/commitment.measure.test.ts), because hand-flipping a skip is
// a one-word diff easy to miss in review.
//
// Issue #271 asks for normal-speed playtest observations for every declared mode. There is
// no shipped path to a bot-vs-bot match on a CHOSEN versus board -- the setup pane's slot
// rows offer Keyboard/None (bot roles come from #260's slot-source model, which needs a
// detected controller), and the `bots` dev flag runs the campaign level system, so it
// cannot reach a catalog board. So the match is driven here instead, at the sim layer,
// through the REAL scripted-player AI both sides use, at the real 60 Hz fixed timestep for
// 90 seconds. It is not a video, and it is not a human's read of how the board feels.
const measure = import.meta.env.VITE_RUN_MEASURE ? describe : describe.skip;

measure('vs-duel-01 bot-vs-bot playtest (set VITE_RUN_MEASURE=1 to run)', () => {
  it('records observations for every declared mode', () => {
    for (const mode of ['ffa', 'teams'] as GameMode[]) {
      for (const seed of [7, 11, 23]) {
        const o = playMatch(mode, seed);
        console.log(`PLAYTEST ${mode} seed=${seed} players=${o.players} shots=${o.shots} kills=${o.kills} breaches=${o.breaches} firstContact=${o.firstContactSec}s firstKill=${o.firstKillSec}s sep(min/mean/max)=${o.minSeparation.toFixed(2)}/${o.meanSeparation.toFixed(2)}/${o.maxSeparation.toFixed(2)}`);
      }
    }
    expect(true).toBe(true);
  }, 300000);
});
