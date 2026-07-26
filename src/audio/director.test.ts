import { describe, it, expect } from 'vitest';
import { createAudioDirector } from './director';
import type { AudioEngine } from './engine';
import { DEFAULT_VOLUME } from './manifest';
import type { SimEvent } from '../sim/events';

interface PlayCall {
  key: string;
  opts?: { rate?: number; volume?: number };
}

function makeSpyEngine(): { engine: AudioEngine; calls: PlayCall[] } {
  const calls: PlayCall[] = [];
  const engine: AudioEngine = {
    play: (key, opts) => {
      calls.push({ key, opts });
    },
    startMusic: () => {},
    stopMusic: () => {},
    setMuted: () => {},
    toggleMute: () => false,
    isMuted: () => false,
    setVolume: () => {},
    getVolume: () => DEFAULT_VOLUME,
    dispose: () => {},
  };
  return { engine, calls };
}

describe('createAudioDirector', () => {
  it('plays cannon for a player fire (ownerId 0) and cannon-enemy otherwise', () => {
    const { engine, calls } = makeSpyEngine();
    const director = createAudioDirector(engine);
    const playerFire: SimEvent = {
      type: 'fire',
      ownerId: 0,
      bulletType: 'normal',
      pos: { x: 0, y: 0 },
      angle: 0,
    };
    const enemyFire: SimEvent = {
      type: 'fire',
      ownerId: 1,
      bulletType: 'normal',
      pos: { x: 0, y: 0 },
      angle: 0,
    };
    director.handle([playerFire, enemyFire]);
    expect(calls.map((c) => c.key)).toEqual(['cannon', 'cannon-enemy']);
  });

  it('varies ping rate by bounceIndex (higher index -> higher rate)', () => {
    const { engine, calls } = makeSpyEngine();
    const director = createAudioDirector(engine);
    director.handle([
      { type: 'ricochet', pos: { x: 0, y: 0 }, bounceIndex: 0 },
      { type: 'ricochet', pos: { x: 0, y: 0 }, bounceIndex: 1 },
      { type: 'ricochet', pos: { x: 0, y: 0 }, bounceIndex: 2 },
    ]);
    expect(calls.every((c) => c.key === 'ping')).toBe(true);
    const rates = calls.map((c) => c.opts?.rate ?? 0);
    expect(rates[0]).toBeLessThan(rates[1]);
    expect(rates[1]).toBeLessThan(rates[2]);
  });

  it('maps explosion and tank-destroyed both to the explosion sound', () => {
    const { engine, calls } = makeSpyEngine();
    const director = createAudioDirector(engine);
    director.handle([
      { type: 'explosion', pos: { x: 0, y: 0 } },
      { type: 'tank-destroyed', tankId: 3, kind: 'brown', pos: { x: 0, y: 0 } },
    ]);
    expect(calls.map((c) => c.key)).toEqual(['explosion', 'explosion']);
  });

  it('maps mine-dropped to the drop thunk and mine-armed to the arming beep', () => {
    const { engine, calls } = makeSpyEngine();
    const director = createAudioDirector(engine);
    director.handle([
      { type: 'mine-dropped', mineId: 7, pos: { x: 0, y: 0 } },
      { type: 'mine-armed', mineId: 7, pos: { x: 0, y: 0 } },
    ]);
    expect(calls.map((c) => c.key)).toEqual(['mine-drop', 'mine-arm']);
  });

  it('maps mine-detonate to mine-boom', () => {
    const { engine, calls } = makeSpyEngine();
    const director = createAudioDirector(engine);
    director.handle([{ type: 'mine-detonate', mineId: 7, pos: { x: 0, y: 0 } }]);
    expect(calls.map((c) => c.key)).toEqual(['mine-boom']);
  });

  it('maps win to victory and lose to defeat', () => {
    const { engine, calls } = makeSpyEngine();
    const director = createAudioDirector(engine);
    director.handle([{ type: 'win' }, { type: 'lose' }]);
    expect(calls.map((c) => c.key)).toEqual(['victory', 'defeat']);
  });

  it('plays nothing for wall-destroyed (blast is already covered by explosion/mine-boom)', () => {
    const { engine, calls } = makeSpyEngine();
    const director = createAudioDirector(engine);
    director.handle([{ type: 'wall-destroyed', wallId: 12, pos: { x: 0, y: 0 } }]);
    expect(calls).toHaveLength(0);
  });

  it('respects a custom playerId', () => {
    const { engine, calls } = makeSpyEngine();
    const director = createAudioDirector(engine, 5);
    director.handle([
      { type: 'fire', ownerId: 5, bulletType: 'normal', pos: { x: 0, y: 0 }, angle: 0 },
      { type: 'fire', ownerId: 0, bulletType: 'normal', pos: { x: 0, y: 0 }, angle: 0 },
    ]);
    expect(calls.map((c) => c.key)).toEqual(['cannon', 'cannon-enemy']);
  });
});
