import type { AudioEngine } from './engine';
import type { SimEvent } from '../sim/events';

export interface AudioDirector {
  handle(events: SimEvent[]): void;
  /**
   * Rebind which tank is "the player". loadArena numbers tanks in grid-scan order, so
   * the player's id differs per arena (16 in ARENA_01, 15 in ARENA_02) -- a director
   * still bound to the old id scores the player's own cannon as an enemy's from the
   * next level onward.
   */
  setPlayerId(id: number): void;
}

// Inert fallback only: the loop (task 33) passes the real player id. loadArena
// assigns ids from 1 in grid-scan order, so the player is NOT id 0.
const DEFAULT_PLAYER_ID = 0;
// Each successive ricochet bounce shifts the ping pitch up for audible juice.
const RICOCHET_RATE_STEP = 0.15;

export function createAudioDirector(
  engine: AudioEngine,
  initialPlayerId: number = DEFAULT_PLAYER_ID,
): AudioDirector {
  let playerId = initialPlayerId;
  function handleOne(e: SimEvent): void {
    switch (e.type) {
      case 'fire':
        engine.play(e.ownerId === playerId ? 'cannon' : 'cannon-enemy');
        break;
      case 'ricochet':
        engine.play('ping', { rate: 1 + e.bounceIndex * RICOCHET_RATE_STEP });
        break;
      case 'explosion':
        engine.play('explosion');
        break;
      case 'tank-destroyed':
        // No dedicated sound. Both kill sites (bullets.ts, mines.ts) push
        // `explosion` at the same position on the very same tick, so playing
        // one here too started two identical 90 Hz voices at the same
        // currentTime -- +6 dB of the same waveform, not a bigger boom.
        break;
      case 'mine-dropped':
        engine.play('mine-drop'); // the drop thunk
        break;
      case 'mine-armed':
        engine.play('mine-arm'); // the arming beep — the mine just went live
        break;
      case 'mine-detonate':
        engine.play('mine-boom');
        break;
      case 'respawn':
        // Deferred, explicitly (see the coop semantics plan,
        // docs/superpowers/plans/2026-08-15-coop-semantics.md): a respawn cue needs
        // either a NEW synthesized sound (a feel decision nobody has heard yet) or
        // repurposing an existing one, which risks a death-adjacent cue like
        // ping/mine-arm reading as the wrong thing on revival. Not free the way the
        // particle burst is (render/particles.ts).
        break;
      case 'wall-destroyed':
        // No dedicated sound: the accompanying explosion / mine-boom already
        // covers the blast that destroyed the wall.
        break;
      case 'win':
        engine.play('victory');
        break;
      case 'lose':
        engine.play('defeat');
        break;
      case 'mine-triggered':
      case 'mine-fuse-warning':
        // Issue #275 lands the deterministic phases only; the two DISTINCT cues
        // ("you tripped this" vs "time is running out") are #276's deliberate
        // work, so both events are explicitly silent here.
        break;
      default: {
        // Exhaustiveness guard: if a new SimEvent kind is added, this fails to compile.
        const _exhaustive: never = e;
        return _exhaustive;
      }
    }
  }

  return {
    handle(events) {
      for (const e of events) handleOne(e);
    },
    setPlayerId(id) {
      playerId = id;
    },
  };
}
