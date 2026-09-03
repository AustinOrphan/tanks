import { describe, it, expect } from 'vitest';
import { createBlockedFireHudCue, type ShellCapacitySurface } from './blocked-fire-hud';
import { createWorld, type World } from '../sim/world';
import { configFor } from '../sim/config';
import type { Bullet, Tank } from '../sim/types';
import type { SimEvent } from '../sim/events';
import { BLOCKED_FIRE_CUES, type BlockedFireCue } from '../presentation/blocked-fire';

const CAP = configFor('player').weapon.maxActiveProjectiles;

function tank(id: number, kind: string): Tank {
  return {
    id, kind, pos: { x: id, y: 0 }, bodyAngle: 0, turretAngle: 0, alive: true,
    desiredMove: { x: 0, y: 0 }, activeMineIds: [], fireCooldown: 0, mineCooldown: 0,
    aiState: 'idle', aiTimer: 0,
  } as unknown as Tank;
}
const bullet = (id: number, ownerId: number, alive = true): Bullet =>
  ({ id, ownerId, type: 'normal', pos: { x: 0, y: 0 }, vel: { x: 1, y: 0 }, bouncesLeft: 1, alive }) as Bullet;
function world(tanks: Tank[], bullets: Bullet[] = []): World {
  const w = createWorld({ walls: [], tanks, spawns: [], lives: 3 });
  w.bullets.push(...bullets);
  return w;
}
const blocked = (ownerId: number): SimEvent =>
  ({ type: 'fire-blocked', ownerId, reason: 'shell-cap' }) as SimEvent;
const fullLoad = (ownerId: number): Bullet[] =>
  Array.from({ length: CAP }, (_, i) => bullet(100 + i, ownerId));

function spy(): { hud: ShellCapacitySurface; calls: { inFlight: number; cap: number }[] } {
  const calls: { inFlight: number; cap: number }[] = [];
  return { hud: { signalShellCapacity: (info) => calls.push(info) }, calls };
}

describe('blocked-fire HUD cue (issue #516, parent #356)', () => {
  it('says nothing when the flag is absent', () => {
    // The shipped default every arm shares: none may become the cue by being wired first.
    // The NAMED cues are covered per cue by the table below; null and undefined cannot be,
    // because neither is a member of BLOCKED_FIRE_CUES.
    const w = world([tank(1, 'player')], fullLoad(1));
    for (const blockedFire of [null, undefined] as const) {
      const { hud, calls } = spy();
      createBlockedFireHudCue(hud, 1, { blockedFire }).handle([blocked(1)], w);
      expect(calls).toHaveLength(0);
    }
    // ...and with no options object at all, which is how every non-dev caller builds it.
    const { hud, calls } = spy();
    createBlockedFireHudCue(hud, 1).handle([blocked(1)], w);
    expect(calls).toHaveLength(0);
  });

  it('flashes for EVERY cue carrying `hud`, and for no other -- one row per cue', () => {
    // The table every blocked-fire consumer keeps (director.test.ts owns `audio`,
    // haptics.test.ts `haptic`, and each visual arm its own), and the reason each exists:
    // the defect that shipped `ring-audio` silent was not a wrong branch, it was a MISSING
    // one -- a cue no assertion mentioned. Keying the table off BLOCKED_FIRE_CUES means
    // the next cue cannot be added without stating whether it flashes: widening the union
    // fails `Record<BlockedFireCue, boolean>` at compile time, and adding to the set alone
    // fails the key comparison below.
    const carriesHud: Record<BlockedFireCue, boolean> = {
      hud: true,
      // The other four visual arms are drawn in the ARENA by their own render systems and
      // never touch this surface, which is the distinction #356 asks to compare: a cue on
      // the tank against a cue off it. The audio and haptic arms have no screen at all.
      ring: false,
      'ring-audio': false,
      muzzle: false,
      turret: false,
      pips: false,
      audio: false,
      click: false,
      clunk: false,
      'thunk-soft': false,
      'pitch-empty': false,
      haptic: false,
      'haptic-tap': false,
      'haptic-double': false,
      'haptic-long': false,
      'haptic-rise': false,
      'haptic-audio': false,
    };
    expect(Object.keys(carriesHud).sort()).toEqual([...BLOCKED_FIRE_CUES].sort());
    const w = world([tank(1, 'player')], fullLoad(1));
    for (const [cue, shouldFlash] of Object.entries(carriesHud)) {
      const { hud, calls } = spy();
      createBlockedFireHudCue(hud, 1, { blockedFire: cue as BlockedFireCue }).handle([blocked(1)], w);
      expect(calls.length, cue).toBe(shouldFlash ? 1 : 0);
    }
  });

  it('reports the SIMULATION\'s own numbers: live shells against the resolved cap', () => {
    // #356 requires the displayed capacity to derive from the same resolved tank
    // configuration spawnBullet enforces. Both numbers here are the two halves of
    // `shellCapReached` -- ownerShellCount and configFor(kind).weapon.maxActiveProjectiles
    // -- so a readout that disagreed with the gate that refused the shot is impossible by
    // construction rather than by remembering to keep two copies in step.
    const { hud, calls } = spy();
    const w = world(
      [tank(1, 'player'), tank(2, 'brown')],
      [...fullLoad(1), bullet(9, 1, false), bullet(8, 2)],
    );
    createBlockedFireHudCue(hud, 1, { blockedFire: 'hud' }).handle([blocked(1)], w);
    expect(calls).toEqual([{ inFlight: CAP, cap: CAP }]);
  });

  it('COUNTS the shells rather than assuming the cap', () => {
    // In play the two are equal at a refusal -- being at the cap is what refused the shot
    // -- so a system that simply reported `cap` twice would be indistinguishable in a real
    // match, and wrong the moment the ordnance experiment retunes the cap or a future
    // refusal reason arrives that is not "full". The count is read from the world's own
    // live shells for that owner, which is what this doctored world proves.
    const { hud, calls } = spy();
    const w = world([tank(1, 'player')], [bullet(1, 1), bullet(2, 1), bullet(3, 1, false)]);
    createBlockedFireHudCue(hud, 1, { blockedFire: 'hud' }).handle([blocked(1)], w);
    expect(calls).toEqual([{ inFlight: 2, cap: CAP }]);
  });

  it('ignores a refusal that is not the CONTROLLING player\'s', () => {
    // The stream is shared: `fire-blocked` is emitted for whoever was refused, AI tanks
    // and other players included. A presence-only check would flash the local HUD every
    // time any tank in the arena ran out of shells.
    const { hud, calls } = spy();
    const w = world([tank(1, 'player'), tank(2, 'player'), tank(3, 'brown')], fullLoad(2));
    const cue = createBlockedFireHudCue(hud, 1, { blockedFire: 'hud' });
    cue.handle([blocked(2), blocked(3)], w);
    expect(calls).toHaveLength(0);
    // ...and the control: the same frame, with the tracked player refused, does flash.
    cue.handle([blocked(1)], w);
    expect(calls).toHaveLength(1);
  });

  it('follows the tracked player across arenas', () => {
    // Tank ids are arena-dependent (loadArena numbers by grid scan), so a latched id
    // silently stops matching on level 2 -- the reason the audio and haptic directors
    // carry the same setter, pushed from the same place in loop.ts's switchTo.
    const { hud, calls } = spy();
    const cue = createBlockedFireHudCue(hud, 1, { blockedFire: 'hud' });
    const next = world([tank(7, 'player')], fullLoad(7));
    cue.handle([blocked(7)], next);
    expect(calls).toHaveLength(0);
    cue.setPlayerId(7);
    cue.handle([blocked(7)], next);
    expect(calls).toHaveLength(1);
  });

  it('says nothing when there is no tracked player at all', () => {
    // A world with no player tank (between arenas, or a spectate-shaped session) must not
    // flash on the AI tanks that are still shooting in it.
    const { hud, calls } = spy();
    const w = world([tank(1, 'brown')], fullLoad(1));
    createBlockedFireHudCue(hud, undefined, { blockedFire: 'hud' }).handle([blocked(1)], w);
    expect(calls).toHaveLength(0);
  });

  it('flashes ONCE per frame however many refusals arrive in it', () => {
    // The animation is restarted by each call (hud.ts's signalShellCapacity), so a
    // duplicated event in one frame would restart it twice for no visible gain. #356 also
    // forbids unbounded output from held or spammed fire; this is the per-frame half of
    // that, the per-second half being the fire cooldown a refused attempt still pays
    // (#451).
    const { hud, calls } = spy();
    const w = world([tank(1, 'player')], fullLoad(1));
    createBlockedFireHudCue(hud, 1, { blockedFire: 'hud' }).handle([blocked(1), blocked(1)], w);
    expect(calls).toHaveLength(1);
  });

  it('ignores every other event on the shared stream', () => {
    // The stream carries a whole frame. Nothing but a refusal may reach this surface.
    const { hud, calls } = spy();
    const w = world([tank(1, 'player')], fullLoad(1));
    createBlockedFireHudCue(hud, 1, { blockedFire: 'hud' }).handle(
      [
        { type: 'fire', ownerId: 1, bulletType: 'normal', pos: { x: 0, y: 0 }, angle: 0 },
        { type: 'tank-destroyed', tankId: 1, kind: 'player', pos: { x: 0, y: 0 } },
      ] as SimEvent[],
      w,
    );
    expect(calls).toHaveLength(0);
  });
});
