import type { World } from '../world';
import type { Tank, Vec2 } from '../types';
import { angleOf, vsub } from '../types';
import { lineOfSight } from './targeting';
import { AI_LAST_SEEN_TICKS } from '../constants';

/**
 * Bounded last-seen contact memory (issue #372, binding PP1 behaviour).
 *
 * An AI should not behave as though an enemy stopped existing on the exact tick direct line
 * of sight broke. When the committed target goes out of sight, the tank keeps looking at the
 * last point it ACTUALLY OBSERVED for a bounded span, then gives up and returns to #371's
 * ordinary search.
 *
 * A STORED COPY, never a live reference. `resolveOpponent` hands back the target Tank, whose
 * `pos` keeps moving while the AI cannot see it -- so remembering the tank would remember
 * the present, which is the privileged hidden state this issue forbids by name. What is
 * stored is a Vec2 snapshot taken on a tick when line of sight was valid.
 *
 * ATTENTION ONLY. This never reaches firing: `hasSolution` is computed by each personality
 * from current line of sight (or a bank path), and the dispatcher's trigger additionally
 * requires the barrel to have arrived (issue #371). A remembered contact moves the turret
 * and nothing else, which is the issue's "attention/perception aid, not permission to attack
 * invisible state".
 *
 * Written back by `stepAi`, beside the committed target it belongs to -- issue #372's own
 * dependency note asks for memory to hang off #359's canonical target identity rather than a
 * second, parallel target path.
 */

/** The remembered contact, or null when the tank has none that is still valid. */
export function rememberedContact(tank: Tank): Vec2 | null {
  if (tank.aiLastSeenPos === undefined || (tank.aiLastSeenTicks ?? 0) <= 0) return null;
  return tank.aiLastSeenPos;
}

/**
 * Refresh or age this tank's memory of its committed target.
 *
 * Called once per tank per tick by `stepAi`, immediately after `commitTarget`, so the
 * memory always concerns the opponent the tank is actually committed to.
 */
export function updateTargetMemory(world: World, tank: Tank, target: Tank | undefined): void {
  if (!target || !target.alive) {
    // Rule 5's other half: an invalid target leaves nothing to remember. Clearing rather
    // than letting the span run out matters -- a tank that kept staring at where a corpse
    // used to be would look broken, not attentive.
    tank.aiLastSeenPos = undefined;
    tank.aiLastSeenTicks = 0;
    return;
  }
  if (lineOfSight(tank.pos, target.pos, world.walls)) {
    // Rule 4: fresh observation always replaces the remembered point outright.
    tank.aiLastSeenPos = { x: target.pos.x, y: target.pos.y };
    tank.aiLastSeenTicks = AI_LAST_SEEN_TICKS;
    return;
  }
  tank.aiLastSeenTicks = Math.max(0, (tank.aiLastSeenTicks ?? 0) - 1);
  if (tank.aiLastSeenTicks === 0) tank.aiLastSeenPos = undefined;
}

/** The angle from this tank to its remembered contact, or null when it has none. */
export function memoryAim(tank: Tank): number | null {
  const seen = rememberedContact(tank);
  return seen ? angleOf(vsub(seen, tank.pos)) : null;
}
