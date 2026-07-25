import type { World } from '../world';
import type { Tank } from '../types';
import { lineOfSight, aimLead, bankShot, dangerAvoidMove, wanderMove } from './targeting';
import { driveVelocity } from '../collision';
import { bulletConfig, RICOCHET_BOUNCES, BANK_PREFER_TICKS, MINE_CAP } from '../constants';
import type { AiDecision } from './decision';

export function tealDecision(world: World, tank: Tank): AiDecision {
  const avoid = dangerAvoidMove(world, tank);
  // Mobile (spec §7): wander is the baseline move whenever there's nothing more specific
  // to do; dodging overrides it when a threat is present. This lets Teal keep roaming
  // (and reposition itself into new bank opportunities) instead of standing still as a
  // stationary turret while it has line-of-sight or a bank path.
  const move = avoid ?? wanderMove(world, tank);

  // Aggressive (swapped from Grey): the dodge above overrides only `move`. Unlike Grey,
  // Teal does NOT hold fire while dodging and has no patience counter — it dodges and
  // shoots in the same tick, same as Grey used to. Nothing below consumes tank.aiTimer,
  // so nextTimer is always 0 on every path.
  const player = world.tanks.find((t) => t.kind === 'player' && t.alive);
  if (!player) {
    // Idle with no target -- but a dodge still overrides the idle {0,0}, same as the
    // firing paths below: Teal reacts to incoming fire regardless of whether it currently
    // has anyone to shoot at.
    return { desiredMove: avoid ? move : { x: 0, y: 0 }, turretAngle: tank.turretAngle, fire: false, fireType: 'ricochet', mine: false, nextState: 'idle', nextTimer: 0 };
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

  // Teal now lays mines too (mirrors Grey's rule). Only while NOT dodging: a mine dropped
  // mid-dodge is wasted and risks self-trapping. MINE_CAP is checked here as
  // defence-in-depth: dropMine enforces this cap for every owner too, but checking it
  // here avoids burning tank.mineCooldown on a request dropMine would refuse anyway.
  const mine = !avoid && tank.mineCooldown <= 0 && tank.activeMineIds.length < MINE_CAP;

  if (turretAngle !== null) {
    return { desiredMove: move, turretAngle, fire: true, fireType: 'ricochet', mine, nextState: 'fire', nextTimer: 0 };
  }

  // Neither exists: reposition. Teal never falls back to a direct/rocket shot (spec §7).
  return { desiredMove: move, turretAngle: tank.turretAngle, fire: false, fireType: 'ricochet', mine, nextState: 'reposition', nextTimer: 0 };
}
