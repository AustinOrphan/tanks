import type { SimEvent } from '../sim/events';

export type GameState = 'title' | 'playing' | 'win' | 'lose';

export interface GameStateMachine {
  state: GameState;
  onEvents(events: SimEvent[]): void;
  toTitle(): void;
  startPlaying(): void;
  restart(): void;
  onChange(cb: (s: GameState) => void): void;
}

export function createGameStateMachine(): GameStateMachine {
  const subscribers: Array<(s: GameState) => void> = [];

  function emit(): void {
    for (const cb of subscribers) cb(machine.state);
  }

  function setState(next: GameState): void {
    if (next === machine.state) return;
    machine.state = next;
    emit();
  }

  const machine: GameStateMachine = {
    state: 'title',
    onEvents(events: SimEvent[]): void {
      if (machine.state !== 'playing') return;
      for (const ev of events) {
        if (ev.type === 'win') {
          setState('win');
          return;
        }
        if (ev.type === 'lose') {
          setState('lose');
          return;
        }
      }
    },
    toTitle(): void {
      setState('title');
    },
    startPlaying(): void {
      setState('playing');
    },
    restart(): void {
      // restart always re-enters 'playing' (the loop rebuilds a fresh arena world)
      // and notifies subscribers, even if it was already in a non-playing state.
      machine.state = 'playing';
      emit();
    },
    onChange(cb: (s: GameState) => void): void {
      subscribers.push(cb);
    },
  };

  return machine;
}
