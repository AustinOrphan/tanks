import type { SimEvent } from '../sim/events';
import type { World } from '../sim/world';
import { BLAST_LIFETIME_TICKS } from '../sim/mines';
import { identityApplies } from '../presentation/identity';
import type { SessionDescriptorKind } from './app-state';

/**
 * Issue #925 (parent #327): a co-op player's death, named without color.
 *
 * THE GAP, MEASURED BEFORE THIS WAS BUILT. At two or more player tanks the death vignette
 * tints to the dying tank's owner color (`deathVignetteColor` in loop.ts), and it fires for
 * the TRACKED player alone -- slot 0, the first player-kind tank -- as section 6 of the
 * identity spawn/death spec decided ("the primary player's fires the vignette"). What else
 * names a dying player at that moment depends on the session:
 *
 *  - VERSUS (FFA and teams) already names every death without color. Each stock strip entry
 *    is labeled `P<n>` (with the team letter under teams, and drawn as the slot's shape marks
 *    under FFA), every death lowers that slot's stock, the final one included, and the unit
 *    that just emptied carries the stock-loss cue; the live region says "Player N lost a
 *    stock. N remaining." (issue #629), one sentence per status push. A toast there would
 *    write a second sentence into the same live region for the same death, so versus is left
 *    alone.
 *  - CO-OP names nobody. Its status carries no strip, the live region says "Life lost. N
 *    lives remaining." on the tracked player's death and nothing on anyone else's, and the
 *    vignette's color was the only thing on screen that said whose death it was.
 *
 * So a co-op session at two or more player tanks raises a toast for a player tank that dies,
 * naming its slot: "P2 out". The ruling on #925 (2026-10-13, re-ruled 2026-10-24 to name the
 * player who died rather than the killer) asked for the slot's shape marker as well. Co-op
 * draws no shape marker anywhere -- `identity-marker-flag.ts` ships `shape` to FFA only -- so
 * a shape here would pair with nothing on the board; the slot number, which the controller
 * assignment and the stock strip both use, is the channel. Single-player keeps its classic
 * red vignette and its "Life lost" sentence exactly as before: one player, nobody to tell
 * apart.
 *
 * ONE STRING, TWO CHANNELS, BY CONSTRUCTION. The toast stack IS the page's one polite live
 * region (hud.ts's `.hud-toasts`), so the toast's own text is what a screen reader hears.
 * This module hands the HUD nothing else: writing the string to `announce` as well would
 * speak it twice.
 *
 * THE THROTTLE, so a multi-kill does not narrate every death. After a toast, no other
 * player's death raises one for `DEATH_TOAST_WINDOW_TICKS`, which is `BLAST_LIFETIME_TICKS`.
 * A shell stops on the first tank it hits, so it kills one; a mine's blast is the one hazard
 * that kills several, each on the tick its edge reaches it, and it stays lethal from age 0 to
 * `BLAST_LIFETIME_TICKS - 1`, so every death one blast causes falls inside one window. The
 * window is the sim's own number rather than a feel value, and moves with the blast if the
 * blast is retuned. Deaths further apart than one blast are separate events and each is named.
 *
 * THE VIGNETTE'S OWNER IS ALWAYS NAMED. The tracked player's death is taken first within a
 * frame, so a multi-kill that includes them names them, and the window never suppresses it:
 * the vignette flashes for that death on the same frame, and a toast naming another player
 * beside it would attribute the flash to the wrong player. The cost is a second toast when
 * the tracked player dies a few ticks after another player in the same blast.
 *
 * In `src/game/` beside `blocked-fire-hud.ts`, for that module's reason: loop.ts stays
 * wiring, and the policy's tests live here rather than among loop.test.ts's thousand
 * assertions about something else.
 */

/** The toast's text, and so what the live region says: the slot as the stock strip labels it. */
export function deathToastText(slot: number): string {
  return `P${slot + 1} out`;
}

/** Sim ticks after a death toast in which another player's death raises none. See above. */
export const DEATH_TOAST_WINDOW_TICKS = BLAST_LIFETIME_TICKS;

/** The slice of the HUD this cue drives: the toast writer a session is lent. */
export interface DeathToastSurface {
  showToast(message: string): void;
}

export interface DeathToastCue {
  /**
   * Toast this frame's player deaths, where this session names them. `sessionKind` is the
   * session's descriptor kind, the input that decides whether the HUD draws a stock strip;
   * `trackedId` is the vignette's owner, loop.ts's `playerId`.
   */
  handle(events: SimEvent[], world: World, sessionKind: SessionDescriptorKind, trackedId: number): void;
  /** A new world: its tick clock starts over, so the window does too. */
  reset(): void;
}

export function createDeathToastCue(hud: DeathToastSurface): DeathToastCue {
  let lastToastTick: number | null = null;

  return {
    handle(events, world, sessionKind, trackedId): void {
      if (sessionKind === 'versus') return;
      if (!identityApplies(world)) return;
      const deaths: number[] = [];
      for (const e of events) {
        // Player-kind only: an enemy's death is the players' success, not a player out.
        if (e.type !== 'tank-destroyed' || e.kind !== 'player') continue;
        if (e.tankId === trackedId) deaths.unshift(e.tankId);
        else deaths.push(e.tankId);
      }
      for (const id of deaths) {
        const inWindow = lastToastTick !== null && world.tick - lastToastTick < DEATH_TOAST_WINDOW_TICKS;
        if (inWindow && id !== trackedId) continue;
        // `tank-destroyed` carries no slot. A destroyed tank stays in `world.tanks` (`alive:
        // false`), the same lookup `deathVignetteColor` makes.
        const tank = world.tanks.find((t) => t.id === id);
        if (!tank) continue;
        hud.showToast(deathToastText(tank.controlledBy ?? 0));
        lastToastTick = world.tick;
      }
    },
    reset(): void {
      lastToastTick = null;
    },
  };
}
