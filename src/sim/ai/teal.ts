import type { World } from '../world';
import type { Tank } from '../types';
import { lineOfSight, aimLead, aimJitter, bankShot, dangerAvoidMove, wanderMove, shotHitsOwnSide } from './targeting';
import { driveVelocity } from '../collision';
import { bulletConfig, RICOCHET_BOUNCES, BANK_PREFER_TICKS, MINE_CAP, AI_AIM_SPREAD } from '../constants';
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
    // No target, but Teal is the MOBILE personality (spec §7): keep roaming, exactly as
    // Grey does in the same situation. Freezing at {0,0} here made Teal a stationary
    // target for the whole of every countdown and every player respawn -- a hardcoded
    // zero, not a decision. `move` already folds in the dodge when one is present.
    return { desiredMove: move, turretAngle: tank.turretAngle, fire: false, fireType: 'ricochet', mine: false, nextState: 'idle', nextTimer: 0 };
  }

  const speed = bulletConfig.ricochet.speed;

  // Jitter is applied to BOTH the direct and bank solutions, right where each is
  // computed, so it's present regardless of which path preferBank ends up taking (and
  // never touches the reposition fallback's held/passthrough angle below).
  // Both solutions are additionally vetted with shotHitsOwnSide: lineOfSight/bankShot only
  // test walls, but resolveBulletHits kills any non-owner tank the shell touches -- and,
  // once a ricochet turns around, the shooter too. Returning null (rather than gating
  // `fire` at the end) is what lets the OTHER shot type still be tried: Teal loses the
  // blocked shot, not the whole tick.
  function tryDirect(): number | null {
    if (!lineOfSight(tank.pos, player!.pos, world.walls)) return null;
    const targetVel = driveVelocity(player!);
    const angle = aimLead(tank.pos, player!.pos, targetVel, speed) + aimJitter(world, tank, AI_AIM_SPREAD);
    return shotHitsOwnSide(world, tank, angle, 'ricochet') ? null : angle;
  }
  // bankShot is O(walls^2): each surviving wall face runs two full losIgnoring scans.
  // Measured fine at ARENA_01's wall count (~480 ray tests/tick/Teal, microseconds); a
  // much denser arena would want throttling. Evaluated lazily below so the non-preferred
  // option only pays this cost when the preferred option actually fails.
  function tryBank(): number | null {
    const raw = bankShot(tank.pos, player!.pos, world.walls, RICOCHET_BOUNCES);
    if (raw === null) return null;
    const angle = raw + aimJitter(world, tank, AI_AIM_SPREAD);
    return shotHitsOwnSide(world, tank, angle, 'ricochet') ? null : angle;
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
