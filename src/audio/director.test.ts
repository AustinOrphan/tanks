import { describe, it, expect } from 'vitest';
import { createAudioDirector } from './director';
import type { AudioEngine } from './engine';
import { DEFAULT_VOLUME } from './manifest';
import type { SimEvent } from '../sim/events';
import { BLOCKED_FIRE_CUES, type BlockedFireCue } from '../presentation/blocked-fire';

interface PlayCall {
  key: string;
  opts?: { rate?: number; volume?: number };
}

/** The cues whose name carries the `audio` channel -- issue #516's audio column. */
type AudioArm = 'audio' | 'click' | 'clunk' | 'thunk-soft' | 'pitch-empty' | 'haptic-audio' | 'ring-audio';

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
    unlock: () => {},
    setMusicIntensity: () => {},
    setMusicContext: () => {},
    duckMusic: () => {},
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

  it('steps ping rate by exactly RICOCHET_RATE_STEP per bounce', () => {
    const { engine, calls } = makeSpyEngine();
    const director = createAudioDirector(engine);
    director.handle([
      { type: 'ricochet', ownerId: 1, pos: { x: 0, y: 0 }, bounceIndex: 0 },
      { type: 'ricochet', ownerId: 1, pos: { x: 0, y: 0 }, bounceIndex: 1 },
      { type: 'ricochet', ownerId: 1, pos: { x: 0, y: 0 }, bounceIndex: 2 },
    ]);
    expect(calls.every((c) => c.key === 'ping')).toBe(true);
    const rates = calls.map((c) => c.opts?.rate ?? 0);

    // Pinned to exact values, not just `rates[0] < rates[1] < rates[2]`. That
    // ordinal form is satisfied by ANY positive step, so RICOCHET_RATE_STEP
    // could be retuned from 0.15 to 1.5 -- turning the third bounce of a
    // ricochet shell into a 4x-speed chipmunk shriek -- with this test green.
    // Playback rate is a musical quantity: the size of the step is the whole
    // design, and the direction is the trivial part.
    //
    // Derived from src/audio/director.ts: `rate = 1 + bounceIndex *
    // RICOCHET_RATE_STEP` with RICOCHET_RATE_STEP = 0.15, so bounces 0/1/2 give
    // 1, 1.15 and 1.30 -- a little over a semitone (~2.4) per bounce, audible
    // as a rising pitch without leaving the sample's usable range even at the
    // ricochet shell's third and final bounce (RICOCHET_BOUNCES = 3).
    // Both 1 + 0.15 and 1 + 2 * 0.15 are exact in IEEE-754 doubles, so `toEqual`
    // is safe here and says more than a tolerance would.
    expect(rates).toEqual([1, 1.15, 1.3]);
  });

  it('plays one explosion per kill, not two', () => {
    // A kill emits `tank-destroyed` AND `explosion` at the same pos on the same
    // tick (bullets.ts:80-81, mines.ts:50-51). Sounding both doubles an
    // identical waveform at identical currentTime: +6 dB, not a bigger boom.
    const { engine, calls } = makeSpyEngine();
    const director = createAudioDirector(engine);
    director.handle([
      { type: 'tank-destroyed', tankId: 3, kind: 'brown', by: { source: 'shell', ownerId: 9 }, pos: { x: 0, y: 0 } },
      { type: 'explosion', pos: { x: 0, y: 0 } },
    ]);
    expect(calls.map((c) => c.key)).toEqual(['explosion']);
  });

  it('maps mine-dropped to the drop thunk and mine-armed to the arming beep', () => {
    const { engine, calls } = makeSpyEngine();
    const director = createAudioDirector(engine);
    director.handle([
      { type: 'mine-dropped', mineId: 7, ownerId: 1, pos: { x: 0, y: 0 } },
      { type: 'mine-armed', mineId: 7, ownerId: 1, pos: { x: 0, y: 0 } },
    ]);
    expect(calls.map((c) => c.key)).toEqual(['mine-drop', 'mine-arm']);
  });

  it('maps mine-detonate to mine-boom', () => {
    const { engine, calls } = makeSpyEngine();
    const director = createAudioDirector(engine);
    director.handle([{ type: 'mine-detonate', mineId: 7, ownerId: 1, pos: { x: 0, y: 0 } }]);
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
    director.handle([{ type: 'wall-destroyed', wallId: 12, ownerId: 1, pos: { x: 0, y: 0 } }]);
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

describe('createAudioDirector: rebinding the player across levels', () => {
  it('follows setPlayerId, because loadArena numbers the player differently per arena', () => {
    // Measured: the player is id 16 in ARENA_01 and id 15 in ARENA_02 (ids come from
    // grid scan order). A director still bound to the old id would score the player's
    // own cannon as an enemy's from level 2 onward.
    const { engine, calls } = makeSpyEngine();
    const director = createAudioDirector(engine, 16);
    const fireBy = (ownerId: number): SimEvent =>
      ({ type: 'fire', ownerId, bulletType: 'normal', pos: { x: 0, y: 0 }, angle: 0 });

    director.handle([fireBy(15)]);
    director.setPlayerId(15);
    director.handle([fireBy(15), fireBy(16)]);
    expect(calls.map((c) => c.key)).toEqual(['cannon-enemy', 'cannon', 'cannon-enemy']);
  });
});

describe('mine warning cues (issue #276)', () => {
  it('plays DISTINCT sounds for the fuse warning and the proximity trip', () => {
    // These two events used to be explicit no-ops. The assertion that matters is that the
    // keys DIFFER: mapping both to one sound would satisfy "a cue exists" while destroying
    // the only thing the issue is about, which is telling them apart.
    const { engine, calls } = makeSpyEngine();
    const d = createAudioDirector(engine);
    d.handle([
      { type: 'mine-fuse-warning', mineId: 1, ownerId: 2, pos: { x: 0, y: 0 } },
      { type: 'mine-triggered', mineId: 1, ownerId: 2, pos: { x: 0, y: 0 } },
    ]);
    expect(calls.map((c) => c.key)).toEqual(['mine-fuse-warn', 'mine-trip']);
    expect(calls[0].key).not.toBe(calls[1].key);
  });

  it('plays neither cue for an unrelated event', () => {
    // Non-vacuity: proves the two assertions above are reading the events they name rather
    // than a director that plays these keys unconditionally.
    const { engine, calls } = makeSpyEngine();
    createAudioDirector(engine).handle([{ type: 'mine-armed', mineId: 1, ownerId: 2, pos: { x: 0, y: 0 } }]);
    expect(calls.map((c) => c.key)).not.toContain('mine-fuse-warn');
    expect(calls.map((c) => c.key)).not.toContain('mine-trip');
  });

  it('emits one cue per event, so simultaneous warnings stay bounded', () => {
    // The issue asks that multiple simultaneous warnings not spam. The director's contract
    // is one play per event; four mines warning on the same tick is four cues, not a loop.
    const { engine, calls } = makeSpyEngine();
    const evts: SimEvent[] = [1, 2, 3, 4].map((id) => ({
      type: 'mine-fuse-warning' as const, mineId: id, ownerId: 2, pos: { x: 0, y: 0 },
    }));
    createAudioDirector(engine).handle(evts);
    expect(calls.filter((c) => c.key === 'mine-fuse-warn')).toHaveLength(4);
  });
});


describe('blocked-fire cue (issue #356)', () => {
  const blocked = (ownerId: number): SimEvent =>
    ({ type: 'fire-blocked', ownerId, reason: 'shell-cap' }) as SimEvent;
  const played = (opts?: { blockedFire?: BlockedFireCue | null }, owner = 7) => {
    const keys: string[] = [];
    const engine = { play: (k: string) => keys.push(k), stopMusic: () => {}, playMusic: () => {} };
    const d = createAudioDirector(engine as never, 7, opts);
    d.handle([blocked(owner)]);
    return keys;
  };
  /** The same, keeping the play OPTIONS: three of issue #516's arms are variations. */
  const playedCalls = (cue: BlockedFireCue, owner = 7): PlayCall[] => {
    const calls: PlayCall[] = [];
    const engine = { play: (key: string, opts?: PlayCall['opts']) => calls.push({ key, opts }) };
    createAudioDirector(engine as never, 7, { blockedFire: cue }).handle([blocked(owner)]);
    return calls;
  };

  it('stays silent with no flag, because the treatments have not been compared yet', () => {
    expect(played()).toEqual([]);
    expect(played({ blockedFire: null })).toEqual([]);
  });

  it('plays the click when the flag names audio', () => {
    expect(played({ blockedFire: 'audio' })).toEqual(['fire-blocked']);
  });

  it('plays it for BOTH multimodal arms', () => {
    // The combinations #356 asks for by name. If either did not reach BOTH channels it
    // would be a second single-channel arm wearing a compound label -- which is exactly
    // what `ring-audio` was: the render side accepted it and the gate here did not, so the
    // pair drew a ring in silence while the flag advertised a multimodal treatment.
    expect(played({ blockedFire: 'haptic-audio' })).toEqual(['fire-blocked']);
    expect(played({ blockedFire: 'ring-audio' })).toEqual(['fire-blocked']);
  });

  const carriesAudio: Record<BlockedFireCue, boolean> = {
    haptic: false,
    audio: true,
    'haptic-audio': true,
    ring: false,
    'ring-audio': true,
    // The visual and haptic arms of issue #516's matrix: named in the vocabulary, and
    // false here permanently -- they carry no audio at all and must never sound, which
    // is what lets #356 attribute a preference to a channel rather than to a bundle.
    muzzle: false,
    turret: false,
    pips: false,
    hud: false,
    'haptic-tap': false,
    'haptic-double': false,
    'haptic-long': false,
    'haptic-rise': false,
    // Issue #516's four extra audio arms, now implemented (director.ts's
    // BLOCKED_FIRE_ARMS). This table is about CHANNEL MEMBERSHIP -- does this cue reach
    // the speaker at all -- so it counts calls; WHICH sound each arm makes is a
    // different contract, and has its own one-row-per-arm table below.
    click: true,
    clunk: true,
    'thunk-soft': true,
    'pitch-empty': true,
  };

  it('sounds for EVERY cue carrying `audio`, and for no other -- one row per cue', () => {
    // Per cue rather than per remembered case. The bug this replaces was not a wrong
    // branch, it was a missing one: `ring-audio` existed in the union and nothing here
    // mentioned it, so no assertion could fail. Keying the table off BLOCKED_FIRE_CUES
    // means a sixth cue cannot be added without stating whether it sounds -- the union
    // widening fails `Record<BlockedFireCue, boolean>` at compile time, and adding to the
    // set alone fails the key comparison below.
    expect(Object.keys(carriesAudio).sort()).toEqual([...BLOCKED_FIRE_CUES].sort());
    for (const [cue, shouldSound] of Object.entries(carriesAudio)) {
      expect(playedCalls(cue as BlockedFireCue), cue).toHaveLength(shouldSound ? 1 : 0);
    }
  });

  it('gives each audio arm its OWN voice -- one row per arm (issue #516)', () => {
    // The table above is CHANNEL MEMBERSHIP: five arms all playing the baseline click
    // would satisfy it completely. #516 exists to put five sounds in front of a person
    // who has to tell them apart at speed, so this pins what each arm actually plays.
    // MEASURED: collapsing director.ts's lookup to `BLOCKED_FIRE_BASELINE` left all 18 of
    // this file's tests green before this case existed.
    //
    // Three arms share the baseline BY DESIGN -- `audio` IS the baseline, and the two
    // multimodal arms exist to test a channel PAIRING, so giving them their own sound
    // would confound "is a pair better than one channel" with "is this sound better".
    const armVoice: Record<AudioArm, PlayCall> = {
      audio: { key: 'fire-blocked', opts: undefined },
      'haptic-audio': { key: 'fire-blocked', opts: undefined },
      'ring-audio': { key: 'fire-blocked', opts: undefined },
      // Its own recipe, because "a short dry mechanical click, NO TONE" removes a layer
      // and no playback rate or gain can do that.
      click: { key: 'fire-blocked-click', opts: undefined },
      // Variations of a cue that already exists rather than new sounds: half rate is
      // literally "lower and slower", and `thunk-soft` is that same gesture at 0.3 gain --
      // the same key and the same rate, differing in volume and nothing else, or it would
      // be answering a different question than "does restraint read as intentional".
      clunk: { key: 'fire-blocked', opts: { rate: 0.5 } },
      'thunk-soft': { key: 'fire-blocked', opts: { rate: 0.5, volume: 0.3 } },
      // The NORMAL FIRE cue itself, pitched down: the refusal heard as the same action
      // failing. Pulled back to 0.7 so it cannot be mistaken for the shot going off.
      'pitch-empty': { key: 'cannon', opts: { rate: 0.55, volume: 0.7 } },
    };
    // Every cue the membership table says sounds needs a row here, so a sixth audio arm
    // cannot be added, sound, and go unheard-of by this test.
    expect(Object.keys(armVoice).sort()).toEqual(
      Object.entries(carriesAudio)
        .filter(([, sounds]) => sounds)
        .map(([cue]) => cue)
        .sort(),
    );
    for (const [cue, voice] of Object.entries(armVoice)) {
      expect(playedCalls(cue as BlockedFireCue), cue).toEqual([voice]);
    }

    // And the five DISTINCT sounds really are five. Without this, pointing two arms at
    // one voice still passes every row above -- and a comparison between two arms that
    // sound identical is not a comparison.
    const compared = ['audio', 'click', 'clunk', 'thunk-soft', 'pitch-empty'] as const;
    const shapes = new Set(compared.map((cue) => JSON.stringify(armVoice[cue])));
    expect(shapes.size, `arms sharing a voice: ${[...shapes].join(' | ')}`).toBe(compared.length);
  });

  it('the arms are SEPARABLE: the haptic arm makes no sound', () => {
    // What makes the comparison meaningful. If every arm reached every channel there
    // would be nothing to compare, and a reviewer judging "audio" would in fact be
    // judging audio plus haptics.
    expect(played({ blockedFire: 'haptic' })).toEqual([]);
  });

  it('ignores a refusal that belongs to someone else', () => {
    expect(played({ blockedFire: 'audio' }, 9)).toEqual([]);
  });
});
