import type { World } from '../world';
import type { Tank, AiState } from '../types';
import { lineOfSight, aimLead, aimJitter, dangerAvoidMove, wanderMove, shotHitsOwnSide, mineThreatensPlayer } from './targeting';
import { driveVelocity } from '../collision';
import { bulletConfig, MINE_CAP, DODGE_PATIENCE_TICKS, AI_AIM_SPREAD } from '../constants';
import type { AiDecision } from './decision';

export function greyDecision(world: World, tank: Tank): AiDecision {
  const avoid = dangerAvoidMove(world, tank);
  // dangerAvoidMove now vets its own direction against walls and armed mines (see
  // targeting.ts), so this can be trusted directly: a dodge into a wall used to net zero
  // displacement and pin Grey inside the danger corridor while it held fire.
  const move = avoid ?? wanderMove(world, tank);

  // Cautious (swapped from Teal): Grey holds fire while dodging, but only for
  // DODGE_PATIENCE_TICKS consecutive ticks (tracked via aiTimer/nextTimer). The cap is
  // mandatory, not cosmetic: the player's FIRE_COOLDOWN (0.4s) is shorter than the
  // THREAT_HORIZON (1.0s) that keeps dangerAvoidMove returning non-null, so a player who
  // just keeps shooting would otherwise suppress Grey's fire forever. Movement and
  // turret/fire are independent: past the threshold Grey still dodges (move stays the
  // dodge vector) but evaluates the shooting logic normally.
  const dodgeTicks = avoid ? tank.aiTimer + 1 : 0;
  if (avoid && dodgeTicks < DODGE_PATIENCE_TICKS) {
    return { desiredMove: move, turretAngle: tank.turretAngle, fire: false, fireType: 'normal', mine: false, nextState: 'reposition', nextTimer: dodgeTicks };
  }

  const player = world.tanks.find((t) => t.kind === 'player' && t.alive);
  let turretAngle = tank.turretAngle;
  let fire = false;
  let nextState: AiState = tank.aiState;

  if (player) {
    if (lineOfSight(tank.pos, player.pos, world.walls)) {
      const targetVel = driveVelocity(player);
      // Jitter only the live firing solution (see brown.ts's comment for why the
      // held/passthrough angle below must stay untouched).
      turretAngle = aimLead(tank.pos, player.pos, targetVel, bulletConfig.normal.speed)
        + aimJitter(world, tank, AI_AIM_SPREAD);
      // lineOfSight only tests WALLS, but resolveBulletHits kills any non-owner tank the
      // shell touches. Keep tracking the player with the turret either way -- only the
      // trigger is held, so the shot goes off the moment the teammate clears the lane.
      fire = !shotHitsOwnSide(world, tank, turretAngle, 'normal');
      nextState = fire ? 'fire' : 'reposition';
    } else {
      nextState = 'reposition';
    }
  }

  // Grey lays mines while roaming (spec §7: "avoids its own mines").
  // Only while NOT dodging: a mine dropped mid-dodge is wasted and risks self-trapping.
  // Gated on mineCooldown (Task 22's dispatcher decrements it and re-arms on success) and
  // on MINE_CAP as defence-in-depth: dropMine enforces this cap for every owner too, but
  // checking it here avoids burning a cooldown on a request dropMine would refuse anyway.
  // And gated on the player being close enough for the mine to threaten anything at all --
  // dropping merely because the cooldown allowed it made own mines the largest single cause
  // of AI deaths, with the tank littering ground nobody was contesting.
  const mine = !avoid && tank.mineCooldown <= 0 && tank.activeMineIds.length < MINE_CAP
    && mineThreatensPlayer(world, tank);

  // nextState is still vestigial for Grey: unlike Brown, greyDecision never branches on
  // tank.aiState (nextState here is just a passthrough/label, not a driver of behaviour).
  // nextTimer, unlike before, is NOT always 0 here — the patience counter above writes
  // dodgeTicks back via the early return while suppressed; this path (dodging has ended
  // or never started) resets it to 0, which is what lets a fresh dodge start counting
  // from 1 again next time.
  return { desiredMove: move, turretAngle, fire, fireType: 'normal', mine, nextState, nextTimer: 0 };
}
