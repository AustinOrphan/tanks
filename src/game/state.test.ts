import { describe, it, expect, vi } from 'vitest';
import { createGameStateMachine } from './state';

describe('game state machine', () => {
  it('starts in title', () => {
    const sm = createGameStateMachine();
    expect(sm.state).toBe('title');
  });

  it('startPlaying moves to playing', () => {
    const sm = createGameStateMachine();
    sm.startPlaying();
    expect(sm.state).toBe('playing');
  });

  it('transitions to win on a win event while playing', () => {
    const sm = createGameStateMachine();
    sm.startPlaying();
    sm.onEvents([{ type: 'win' }]);
    expect(sm.state).toBe('win');
  });

  it('transitions to lose on a lose event while playing', () => {
    const sm = createGameStateMachine();
    sm.startPlaying();
    sm.onEvents([{ type: 'lose' }]);
    expect(sm.state).toBe('lose');
  });

  it('ignores win/lose events when not playing', () => {
    const sm = createGameStateMachine();
    sm.onEvents([{ type: 'win' }]); // still in title
    expect(sm.state).toBe('title');
  });

  it('restart from win or lose returns to playing', () => {
    const sm = createGameStateMachine();
    sm.startPlaying();
    sm.onEvents([{ type: 'lose' }]);
    expect(sm.state).toBe('lose');
    sm.restart();
    expect(sm.state).toBe('playing');
  });

  it('only reacts to the first terminal event in a batch', () => {
    const sm = createGameStateMachine();
    sm.startPlaying();
    sm.onEvents([{ type: 'win' }, { type: 'lose' }]);
    expect(sm.state).toBe('win');
  });

  it('onChange fires exactly on transitions', () => {
    const sm = createGameStateMachine();
    const cb = vi.fn();
    sm.onChange(cb);
    sm.startPlaying();                 // title -> playing
    sm.onEvents([{ type: 'win' }]);    // playing -> win
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb).toHaveBeenNthCalledWith(1, 'playing');
    expect(cb).toHaveBeenNthCalledWith(2, 'win');
  });

  it('does not fire onChange when the state is unchanged', () => {
    const sm = createGameStateMachine();
    const cb = vi.fn();
    sm.onChange(cb);
    sm.toTitle(); // already in title, no transition
    expect(cb).not.toHaveBeenCalled();
  });
});

describe('pause transitions', () => {
  it('pauses only from playing', () => {
    const sm = createGameStateMachine();
    sm.pause();
    expect(sm.state).toBe('title'); // title is not pausable
    sm.startPlaying();
    sm.pause();
    expect(sm.state).toBe('paused');
  });

  it('resumes only from paused', () => {
    const sm = createGameStateMachine();
    sm.startPlaying();
    sm.resume();
    expect(sm.state).toBe('playing'); // no-op, not a crash
    sm.pause();
    sm.resume();
    expect(sm.state).toBe('playing');
  });

  it('cannot pause a finished game into a zombie state', () => {
    const sm = createGameStateMachine();
    sm.startPlaying();
    sm.onEvents([{ type: 'lose' }]);
    sm.pause();
    expect(sm.state).toBe('lose');
  });

  it('ignores win/lose events while paused: the sim is not stepping', () => {
    // Nothing SHOULD emit events while paused -- the driver holds -- but a stray
    // queued frame must not end a game the player believes is frozen.
    const sm = createGameStateMachine();
    sm.startPlaying();
    sm.pause();
    sm.onEvents([{ type: 'lose' }]);
    expect(sm.state).toBe('paused');
  });

  it('notifies subscribers on pause and resume', () => {
    const sm = createGameStateMachine();
    const seen: string[] = [];
    sm.onChange((s) => seen.push(s));
    sm.startPlaying();
    sm.pause();
    sm.resume();
    expect(seen).toEqual(['playing', 'paused', 'playing']);
  });
});
