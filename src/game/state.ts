import type { SimEvent } from '../sim/events';

/**
 * `'title'` is the MAIN MENU, and has been since before there was a title screen --
 * 54 references across the game and its tests read it that way. `'splash'` is the
 * actual title screen, which now precedes it. The names are the wrong way round and
 * that is deliberate: renaming `'title'` to `'menu'` and reusing `'title'` for the new
 * screen would compile clean while silently changing what every one of those existing
 * references asserts, which no test could catch. The rename is worth doing on its own,
 * in a change where `'title'` stops existing so the compiler must visit every site.
 */
export type GameState = 'splash' | 'title' | 'playing' | 'win' | 'lose' | 'paused';

export interface GameStateMachine {
  state: GameState;
  onEvents(events: SimEvent[]): void;
  toTitle(): void;
  /**
   * Splash -> menu, and ONLY from splash. The transition exists to be driven by a real
   * user gesture: browsers create an AudioContext suspended and refuse to resume one
   * outside a gesture handler, so before the first interaction the game has no audio at
   * all. Measured on the built bundle: at the menu with no gesture, both AudioContexts
   * report `suspended`; one background click flips both to `running`. Making the first
   * gesture unavoidable is what turns "silent until you touch it" from a bug report
   * into the screen's purpose.
   */
  dismissSplash(): void;
  startPlaying(): void;
  restart(): void;
  /** Only from 'playing': a finished or unstarted game has nothing to freeze. */
  pause(): void;
  /** Only from 'paused': a stray resume elsewhere must not restart anything. */
  resume(): void;
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
    state: 'splash',
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
    dismissSplash(): void {
      // Guarded, like pause/resume: quitting to the menu mid-game must not be able to
      // land back on the title screen, and a stray gesture during play must do nothing.
      if (machine.state === 'splash') setState('title');
    },
    pause(): void {
      if (machine.state === 'playing') setState('paused');
    },
    resume(): void {
      if (machine.state === 'paused') setState('playing');
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
