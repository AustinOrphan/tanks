import { cueDrives, type BlockedFireCue } from '../presentation/blocked-fire';
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

export interface AudioDirectorOptions {
  /**
   * `?dev=1&blockedFire=<cue>` (devflags.ts) -- every arm whose name carries the `audio`
   * channel, which is what `cueDrives(cue, 'audio')` answers. Anything else -- including
   * the shipped default of null -- stays silent, because issue #356 requires its
   * treatments to be compared before one is adopted.
   */
  readonly blockedFire?: BlockedFireCue | null;
}

/** One blocked-fire arm's sound: an engine key, and how that key is varied. */
interface BlockedFireVoice {
  readonly key: string;
  readonly opts?: { rate?: number; volume?: number };
}

/**
 * What the shipped `audio` arm plays, and what every arm that does not name its own
 * variation falls back to -- `haptic-audio` and `ring-audio`, whose audio half IS this
 * baseline by definition (they exist to test a channel PAIRING, so varying their sound
 * too would confound the two questions).
 */
const BLOCKED_FIRE_BASELINE: BlockedFireVoice = { key: 'fire-blocked' };

/**
 * Issue #516's four extra audio arms, as VARIATIONS rather than new sounds wherever the
 * matrix's own description is a transposition (all numbers are owner decisions, stated
 * here rather than buried at the call site):
 *
 *   clunk        "a heavier mechanical refusal, LOWER and SLOWER" -- literally the
 *                baseline at half playback rate: every frequency halved (the noise tick
 *                4200->3000 Hz becomes 2100->1500, the square body 210->150 Hz becomes
 *                105->75) and every duration doubled (18 ms + 30 ms becomes 36 + 60). No
 *                gain change: `VOICE_GAIN * MAX_VOICES` is engine.ts's no-clip budget and
 *                a volume above 1 would spend it, so "heavier" is bought with pitch and
 *                length, which is what the word describes anyway.
 *   thunk-soft   "THE SAME GESTURE at low volume" -- so it must be the same key at the
 *                same rate as `clunk`, differing in gain and nothing else, or the
 *                experiment (does restraint read as intentional or as a bug?) is
 *                answering a different question. 0.3 is a clear step down without
 *                dropping under the arena bed.
 *   pitch-empty  "a pitched-down variant of the NORMAL FIRE cue" -- the `cannon` key
 *                itself at rate 0.55, so the refusal is heard as the same action failing.
 *                Pulled to 0.7 gain because an unattenuated cannon IS the shot sound, and
 *                a refusal that is as loud as a shot is the failure mode #356 names: the
 *                player believes they fired.
 *   click        "a short dry mechanical click, NO TONE" -- the one arm no rate or gain
 *                can produce, because removing the baseline's square body is a change of
 *                GRAPH. It gets its own recipe (synth.ts's `fire-blocked-click`), which
 *                is how this repo authors a sound: there are no audio assets and, per
 *                CREDITS.md, there will not be.
 *
 * Nothing here bypasses the engine, so every arm is muted by mute and scaled by the
 * volume setting exactly as `cannon` is -- `volume` below is a per-voice multiplier the
 * engine applies ON TOP of the master volume, never instead of it.
 */
const BLOCKED_FIRE_ARMS: Readonly<Partial<Record<BlockedFireCue, BlockedFireVoice>>> = {
  click: { key: 'fire-blocked-click' },
  clunk: { key: 'fire-blocked', opts: { rate: 0.5 } },
  'thunk-soft': { key: 'fire-blocked', opts: { rate: 0.5, volume: 0.3 } },
  'pitch-empty': { key: 'cannon', opts: { rate: 0.55, volume: 0.7 } },
};

export function createAudioDirector(
  engine: AudioEngine,
  initialPlayerId: number = DEFAULT_PLAYER_ID,
  options: AudioDirectorOptions = {},
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
        // "You tripped this" -- see synth.ts for why it FALLS where 'mine-arm' rises.
        engine.play('mine-trip');
        break;
      case 'mine-fuse-warning':
        // "Time is running out". One cue at the window boundary; the ring's accelerating
        // blink carries the rest, so nothing here needs a clock of its own.
        engine.play('mine-fuse-warn');
        break;
      case 'fire-blocked': {
        const cue = options.blockedFire;
        // Issue #356's audio arm, and SILENT unless the flag names it: the issue chooses
        // its cue from evidence, not from whoever wired the event up first.
        //
        // Gated on the CONTROLLING player, like every other cue here. `fire-blocked` is
        // emitted for whoever was refused, AI tanks included, and an enemy running out of
        // shells is not something the player should hear.
        //
        // No rate limit, and that is measured: #451 made a cap-blocked attempt activate
        // the fire cooldown as if it were a real shot, so the longest unbroken burst is
        // ONE tick at every cap measured. See haptics.ts's note for the numbers.
        // EVERY cue whose name carries `audio`, which is the trap this gate already fell
        // into once: `ring-audio` was added to the union and wired on the render side while
        // the enumeration here was left at two arms, so the pair was silent and still called
        // multimodal. That enumeration is now ONE call to `cueDrives` against the
        // presentation layer's channel map (issue #516), so a new audio cue cannot be
        // classified in one place and forgotten in another; which SOUND it makes is the
        // arm's own identity, looked up separately below.
        if (cue != null && cueDrives(cue, 'audio') && e.ownerId === playerId) {
          const voice = BLOCKED_FIRE_ARMS[cue] ?? BLOCKED_FIRE_BASELINE;
          engine.play(voice.key, voice.opts);
        }
        break;
      }
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
