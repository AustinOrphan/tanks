import type { BlockedFireCue } from './devflags';
import type { SimEvent } from '../sim/events';
import type { Vec2 } from '../sim/types';
import { MINE_BLAST_RADIUS, TANK_RADIUS } from '../sim/constants';

/**
 * The seam issue #112 asks for: a haptics consumer of the SimEvent stream, the same
 * shape as `audio/director.ts` (the closest existing pattern -- see its own doc
 * comment). `handle` mirrors `AudioDirector.handle`, and `setPlayerId` mirrors its
 * rebind-on-level-switch method for the same reason: loadArena numbers tanks in
 * grid-scan order, so the player's id differs per arena.
 *
 * The vibrate function is INJECTED -- this is the whole point of the seam. On web,
 * `createBrowserDeps` (loop.ts) passes `resolveVibrate()`, which binds
 * `navigator.vibrate` when the platform has one. A future Capacitor build passes the
 * native haptics plugin instead, and a platform with neither gets `resolveVibrate`'s
 * own no-op. Nothing in this file ever touches `navigator` directly, which is what
 * keeps it testable without a device.
 */
export type VibrateFn = (pattern: number | number[]) => boolean;

// ---- Pulse durations (ms). Feel, not measurement -- chosen by eye, with no
// device in hand to tune against (see CLAUDE.md's "Numbers that are feel, not
// measurement"). Retuning is explicit follow-up once a real phone can be held;
// the tests below pin the CONSTANTS, not a guessed-right value, so retuning
// does not mean rewriting tests.

/** The player's own shot leaving the barrel. Short: it happens often and must not fatigue. */
export const FIRE_PULSE_MS = 15;

/**
 * The player's tank destroyed. A pattern, not a single pulse, so it reads as a
 * heavier, distinct event rather than a longer fire pulse.
 *
 * There is no separate "hit but survived" cue: the sim has no partial-damage
 * model (bullets.ts, mines.ts -- any hit that reaches a tank sets `alive = false`
 * in the same step that emits `tank-destroyed`), so "the player is hit" and "the
 * player is destroyed" are the same event on this stream. Inventing a distinct
 * "hit" pulse for an event that cannot fire would be untestable by construction.
 */
export const DESTROYED_PATTERN_MS: number[] = [50, 30, 50];

/** A mine detonating within kill reach of the player. */
export const MINE_NEAR_PULSE_MS = 60;
/**
 * The two mine warnings (issue #276), shaped so a hand can tell them apart without looking.
 *
 * A single SHORT tap for "the fuse is nearly out" and a two-beat pattern for "you tripped
 * this": the trip is the one that means a blast is now committed, so it gets the pattern the
 * hand notices. Both stay well under MINE_NEAR_PULSE_MS, because a warning that buzzes as
 * hard as the detonation would make the detonation feel like nothing.
 *
 * Reinforcement only, never the sole cue -- each warning also has a distinct visual and a
 * distinct sound, which is what the issue's accessibility criterion requires.
 */
export const MINE_FUSE_WARN_PULSE_MS = 18;
export const MINE_TRIP_PATTERN_MS: number[] = [22, 40, 22];

/**
 * Issue #356's haptic candidate: a dry double tap for a shot the shell cap refused.
 *
 * DISTINCT FROM FIRING BY SHAPE, not merely by length. `FIRE_PULSE_MS` is one 15 ms pulse;
 * this is two 8 ms taps with a 24 ms gap, so it reads as a mechanism failing to catch
 * rather than as a quieter shot. The issue asks for a pattern "distinct from successful
 * firing", and two cues that differ only in duration are not distinguishable through a
 * hand on a controller.
 *
 * Both taps are shorter than FIRE_PULSE_MS on purpose: a refusal is a smaller event than a
 * shot and must not out-shout one.
 */
export const BLOCKED_FIRE_PATTERN_MS: number[] = [8, 24, 8];

/**
 * "Near" for the mine-detonate cue: the radius `detonateMine` actually kills at,
 * not the wider `AI_MINE_FLEE_RADIUS` an AI starts retreating from (constants.ts).
 * A buzz for every mine an AI would merely give ground to would fire constantly
 * and mean nothing; this fires only when the player was genuinely in the blast.
 */
export const MINE_DANGER_RADIUS = MINE_BLAST_RADIUS + TANK_RADIUS;

function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export interface HapticsDirector {
  handle(events: SimEvent[]): void;
  /** Rebind which tank is "the player" -- see the module doc comment. */
  setPlayerId(id: number): void;
  /**
   * The player's current world position, so the mine-detonate cue can measure
   * distance. `null` when there is no live player tank in this world. Not derived
   * from the event stream itself: `mine-detonate` carries only the mine's own
   * position, not the player's.
   *
   * KNOWN RESIDUAL: loop.ts pushes this from `onSimulated`, which the driver calls
   * AFTER `handle` on the same frame (driver.ts's frame body) -- so a mine-detonate
   * event is checked against the position from the END of the PREVIOUS frame, one
   * tick of lag. Not swept or fixed: immaterial against MINE_DANGER_RADIUS (2.5
   * units) at TANK_SPEED, but a reviewer re-deriving the call order should not
   * "discover" it as new.
   */
  setPlayerPosition(pos: Vec2 | null): void;
  /** The persisted off switch (touch-settings.ts). Suppresses every pulse when false. */
  setEnabled(enabled: boolean): void;
}

// Mirrors audio/director.ts's DEFAULT_PLAYER_ID: an inert fallback only. The
// loop passes the real player id; no live tank is ever id 0.
const DEFAULT_PLAYER_ID = 0;

export interface HapticsOptions {
  /**
   * `?dev=1&blockedFire=haptic` (devflags.ts). Null -- the shipped default -- stays silent,
   * because issue #356 requires its treatments to be compared before one is adopted.
   */
  readonly blockedFire?: BlockedFireCue | null;
}

export function createHapticsDirector(
  vibrate: VibrateFn,
  initialPlayerId: number = DEFAULT_PLAYER_ID,
  options: HapticsOptions = {},
): HapticsDirector {
  let playerId = initialPlayerId;
  let playerPos: Vec2 | null = null;
  let enabled = true;

  function handleOne(e: SimEvent): void {
    switch (e.type) {
      case 'fire':
        // Discriminated by ownerId, not presence: the stream is shared, so a bare
        // `some(e => e.type === 'fire')` would pulse on every enemy shot too --
        // exactly the anti-pattern CLAUDE.md names.
        if (e.ownerId === playerId) vibrate(FIRE_PULSE_MS);
        break;
      case 'tank-destroyed':
        // e.tankId, not e.kind === 'player' -- same fix and same reason as
        // stats.ts's record(): at playerCount > 1 a second player-kind tank can
        // die without being the one THIS device tracks. Zero behavior change at
        // N=1, where the only player-kind tank's id is playerId.
        if (e.tankId === playerId) vibrate(DESTROYED_PATTERN_MS);
        break;
      case 'mine-detonate':
        if (playerPos !== null && distance(e.pos, playerPos) <= MINE_DANGER_RADIUS) {
          vibrate(MINE_NEAR_PULSE_MS);
        }
        break;
      // Conservative default set (issue #112): everything else is deliberately
      // silent for now. Tuning which of these deserve a cue is explicit follow-up.
      // 'respawn' joins this set deliberately, not by omission: haptics has no
      // per-player attribution machinery yet (setPlayerPosition is P1-only -- see
      // the module doc comment), and building it just for respawn is out of scope
      // for the coop semantics plan (docs/superpowers/plans/2026-08-15-coop-semantics.md).
      case 'respawn':
      case 'ricochet':
      case 'explosion':
      case 'mine-dropped':
      case 'mine-armed':
      case 'wall-destroyed':
      case 'win':
      case 'lose':
        break;
      case 'mine-triggered':
        // Distance-gated exactly like 'mine-detonate' above, and for the same reason: a
        // mine tripped by someone else across the arena is not this player's problem, and
        // buzzing for it is the anti-pattern CLAUDE.md names. The gate also bounds the
        // spam the issue asks about -- several mines going off at once can only produce
        // pulses for the ones actually near this player.
        if (playerPos !== null && distance(e.pos, playerPos) <= MINE_DANGER_RADIUS) {
          vibrate(MINE_TRIP_PATTERN_MS);
        }
        break;
      case 'mine-fuse-warning':
        if (playerPos !== null && distance(e.pos, playerPos) <= MINE_DANGER_RADIUS) {
          vibrate(MINE_FUSE_WARN_PULSE_MS);
        }
        break;
      case 'fire-blocked':
        // Issue #356's haptic arm, and SILENT unless the flag names it -- the issue asks
        // for its treatments to be compared before one is adopted, so none of them may
        // become the default by being wired first.
        //
        // Gated on the CONTROLLING player: `fire-blocked` is emitted for whoever was
        // refused, including AI tanks, and a hand does not want to feel an enemy's
        // capacity problems.
        //
        // No rate limit here, and that is measured rather than assumed. #451 made a
        // cap-blocked attempt activate the fire cooldown as if it were a real shot, so a
        // held trigger cannot generate more than one refusal per fire cadence: the longest
        // unbroken burst is ONE tick at every cap measured (5, 4 and 3), against 38 ticks
        // before that change. The unbounded output #356 forbids is unreachable by spamming.
        if (options.blockedFire === 'haptic' && e.ownerId === playerId) {
          vibrate(BLOCKED_FIRE_PATTERN_MS);
        }
        break;
      default: {
        // Exhaustiveness guard: a new SimEvent kind fails to compile here, the
        // same discipline audio/director.ts uses.
        const _exhaustive: never = e;
        return _exhaustive;
      }
    }
  }

  return {
    handle(events) {
      if (!enabled) return;
      for (const e of events) handleOne(e);
    },
    setPlayerId(id) {
      playerId = id;
    },
    setPlayerPosition(pos) {
      playerPos = pos;
    },
    setEnabled(v) {
      enabled = v;
    },
  };
}

/** Only what resolution needs from the global object, so a test can hand over a fake. */
export interface VibrateHost {
  readonly navigator?: { vibrate?: (pattern: number | number[]) => boolean };
}

/**
 * `navigator.vibrate` when the platform has one, a no-op otherwise -- mirrors
 * `resolveStorage`'s shape in storage.ts, the repo's established degrade pattern.
 *
 * Feature-detected with `typeof ... === 'function'` rather than a bare property
 * read, because the support story is not the "Android-only" shape an earlier,
 * unsourced draft of this project's own research claimed. Per MDN (which marks the
 * API "not Baseline") and a caniuse.com/vibration summary fetched 2026-08-11, the
 * real split is Chromium vs. WebKit/Firefox, not an OS split: Safari has never
 * implemented it, on desktop macOS or iOS (every iOS browser is WebKit under the
 * hood), and Firefox does not support it either -- while Chrome and Edge support it
 * on both desktop and Android. So a no-op is not a rare edge case here; it is what
 * Safari and Firefox users get, always, on any OS. The finer detail behind that
 * summary (exact version cutoffs, Samsung Internet, Opera Mobile) was not indepen-
 * dently re-verified and should be treated as secondhand if it matters to a decision.
 */
export function resolveVibrate(host: VibrateHost = globalThis as unknown as VibrateHost): VibrateFn {
  // The try/catch is what "mirrors resolveStorage" actually means -- its defining
  // feature is surviving a host whose property access THROWS (storage.ts: "A getter
  // that THROWS is the case that motivates the try/catch below"). Review proved the
  // first version of this function propagated such a throw instead of degrading.
  try {
    const nav = host.navigator;
    if (nav && typeof nav.vibrate === 'function') {
      // bind, or Chromium's native method throws "Illegal invocation" when called
      // detached from its navigator. Pinned by a test whose fake reads `this`.
      return nav.vibrate.bind(nav);
    }
  } catch {
    /* fall through to the no-op */
  }
  return () => false;
}
