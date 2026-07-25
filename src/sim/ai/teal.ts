import type { World } from '../world';
import type { Tank } from '../types';
import { lineOfSight, aimLead, bankShot, dangerAvoidMove, wanderMove } from './targeting';
import { driveVelocity } from '../collision';
import { bulletConfig, RICOCHET_BOUNCES, DODGE_PATIENCE_TICKS, BANK_PREFER_TICKS } from '../constants';
import type { AiDecision } from './decision';

export function tealDecision(world: World, tank: Tank): AiDecision {
  const avoid = dangerAvoidMove(world, tank);
  // Mobile (spec §7): wander is the baseline move whenever there's nothing more specific
  // to do; dodging overrides it when a threat is present. This lets Teal keep roaming
  // (and reposition itself into new bank opportunities) instead of standing still as a
  // stationary turret while it has line-of-sight or a bank path.
  const move = avoid ?? wanderMove(world, tank);

  // Dodge suppression has a patience limit: Teal holds fire while dodging, but only for
  // DODGE_PATIENCE_TICKS consecutive ticks (tracked via aiTimer/nextTimer), so sustained
  // player fire (THREAT_HORIZON 1.0s > FIRE_COOLDOWN 0.4s) or a parked mine can't suppress
  // Teal's shooting forever. Movement and turret/fire are independent (same pattern as
  // grey.ts): past the threshold Teal still dodges (move stays the dodge vector) but
  // evaluates the shooting logic normally.
  const dodgeTicks = avoid ? tank.aiTimer + 1 : 0;
  if (avoid && dodgeTicks < DODGE_PATIENCE_TICKS) {
    return { desiredMove: move, turretAngle: tank.turretAngle, fire: false, fireType: 'ricochet', mine: false, nextState: 'reposition', nextTimer: dodgeTicks };
  }

  const player = world.tanks.find((t) => t.kind === 'player' && t.alive);
  if (!player) {
    return { desiredMove: { x: 0, y: 0 }, turretAngle: tank.turretAngle, fire: false, fireType: 'ricochet', mine: false, nextState: 'idle', nextTimer: 0 };
  }

  const speed = bulletConfig.ricochet.speed;

  function tryDirect(): number | null {
    if (!lineOfSight(tank.pos, player!.pos, world.walls)) return null;
    const targetVel = driveVelocity(player!);
    return aimLead(tank.pos, player!.pos, targetVel, speed);
  }
  // bankShot is O(walls^2): each surviving wall face runs two full losIgnoring scans.
  // Measured fine at ARENA_01's wall count (~480 ray tests/tick/Teal, microseconds); a
  // much denser arena would want throttling. Evaluated lazily below so the non-preferred
  // option only pays this cost when the preferred option actually fails.
  function tryBank(): number | null {
    return bankShot(tank.pos, player!.pos, world.walls, RICOCHET_BOUNCES);
  }

  // Alternate which shot type Teal prefers on a deterministic ~2s cycle (user decision:
  // "alternate/mix"), so it visibly performs both bank shots and direct shots rather than
  // banking only when the player happens to stand behind cover. Both orderings still fall
  // through to the other option when the preferred one is unavailable -- a preference, not
  // an exclusion; Teal never loses a shot it could have taken.
  const preferBank = Math.floor(world.tick / BANK_PREFER_TICKS) % 2 === 0;
  const turretAngle = preferBank ? (tryBank() ?? tryDirect()) : (tryDirect() ?? tryBank());

  if (turretAngle !== null) {
    return { desiredMove: move, turretAngle, fire: true, fireType: 'ricochet', mine: false, nextState: 'fire', nextTimer: 0 };
  }

  // Neither exists: reposition. Teal never falls back to a direct/rocket shot (spec §7).
  return { desiredMove: move, turretAngle: tank.turretAngle, fire: false, fireType: 'ricochet', mine: false, nextState: 'reposition', nextTimer: dodgeTicks };
}
