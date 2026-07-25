import type { AudioEngine } from './engine';
import type { SimEvent } from '../sim/events';

export interface AudioDirector {
  handle(events: SimEvent[]): void;
}

// Inert fallback only: the loop (task 33) passes the real player id. loadArena
// assigns ids from 1 in grid-scan order, so the player is NOT id 0.
const DEFAULT_PLAYER_ID = 0;
// Each successive ricochet bounce shifts the ping pitch up for audible juice.
const RICOCHET_RATE_STEP = 0.15;

export function createAudioDirector(
  engine: AudioEngine,
  playerId: number = DEFAULT_PLAYER_ID,
): AudioDirector {
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
        engine.play('explosion');
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
  };
}
