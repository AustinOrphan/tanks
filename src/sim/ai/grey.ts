import type { World } from '../world';
import type { Tank, AiState } from '../types';
import { lineOfSight, aimLead, aimJitter, dangerAvoidMove, incomingThreats, mineInclination, profileAimSpread, seekMove, shotHitsOwnSide, mineThreatensPlayer, resolveOpponent } from './targeting';
import { perceiveHazards } from './hazard-perception';
import { driveVelocity } from '../collision';
import { TICK_HZ } from '../constants';
import { configFor, type ResolvedTankConfig } from '../config';
import type { AiDecision } from './decision';

// decideAi routes every DEFENSIVE-profile tank here -- grey and olive today. `cfg` is
// injectable for tests.
export function greyDecision(world: World, tank: Tank, cfg: ResolvedTankConfig = configFor(tank.kind)): AiDecision {
  const weapon = cfg.weapon;
  // Every hazard read below goes through this one snapshot (Directive B, issue #223), and
  // nothing else does: targeting, line of sight and the movement band read the real world,
  // because difficulty may not reach those.
  const hazard = perceiveHazards(world, tank, cfg);
  const seen = hazard.world;
  const fleeRadius = hazard.fleeRadius;
  const dangerCorridor = hazard.dangerCorridor;
  const avoid = dangerAvoidMove(seen, tank, fleeRadius, dangerCorridor);
  // dangerAvoidMove vets its own direction against walls and armed mines, so its dodge is
  // used directly.
  const move = avoid ?? seekMove(world, tank, cfg);

  // Grey holds fire under incoming fire for a bounded run of consecutive ticks. At
  // DEFENSIVE_BASIC's aggression of 0.25 the span is the tuned 45 ticks DODGE_PATIENCE_TICKS
  // pins (config/roster.test.ts asserts the equality, so retuning either side is a
  // two-file edit). The cap is mandatory: the player's FIRE_COOLDOWN (0.4s) is shorter
  // than the THREAT_HORIZON (1.0s) that keeps dangerAvoidMove returning non-null, so a
  // player who keeps shooting would otherwise suppress Grey's fire forever.
  const patienceTicks = Math.round((1 - cfg.ai.aggression) * TICK_HZ);
  // Gated on incoming fire, not on `avoid`. dangerAvoidMove also returns a direction for
  // a nearby mine -- including Grey's own, which it must still walk away from, because
  // detonateMine kills every tank in the blast with no owner exemption. But stepping away
  // from a mine leaves the turret free, and suppressing fire for it would gag Grey's trigger
  // for much of its life: it drops a mine only when the player is close enough to be
  // threatened, then stands inside its own flee radius with a clear shot and holds fire.
  const underFire = incomingThreats(seen, tank, dangerCorridor).length > 0;
  // dangerAvoidMove answers this same incomingThreats test before any mine, so a dodge
  // without underFire is a mine escape.
  const avoidKind = avoid === null ? null : underFire ? 'bullet' as const : 'mine' as const;
  const dodgeTicks = underFire ? tank.aiTimer + 1 : 0;
  // `sees` is computed before the patience early-return: the reaction clock (dispatcher,
  // aimTicks) must keep running through a dodge.
  const player = resolveOpponent(world, tank, cfg);
  const sees = player !== undefined && lineOfSight(tank.pos, player.pos, world.walls);
  if (underFire && dodgeTicks < patienceTicks) {
    return { desiredMove: move, turretAngle: tank.turretAngle, fire: false, hasSolution: sees, fireType: weapon.bulletType, mine: false, nextState: 'reposition', nextTimer: dodgeTicks, avoid, avoidKind, nextIntent: null, nextIntentTicks: 0, nextAimHeld: null, nextAimHeldTicks: 0 };
  }

  let turretAngle = tank.turretAngle;
  let fire = false;
  let nextState: AiState = tank.aiState;

  if (player) {
    if (sees) {
      const targetVel = driveVelocity(player);
      // Jitter only the live firing solution (see brown.ts's comment for why the
      // held/passthrough angle below must stay untouched).
      turretAngle = aimLead(tank.pos, player.pos, targetVel, weapon.speed)
        + aimJitter(world, tank, profileAimSpread(cfg));
      // lineOfSight only tests walls, but resolveBulletHits kills any non-owner tank the
      // shell touches.
      fire = !shotHitsOwnSide(world, tank, turretAngle, weapon.bulletType);
      nextState = fire ? 'fire' : 'reposition';
    } else {
      nextState = 'reposition';
    }
  }

  // Not while dodging: a mine dropped mid-dodge is wasted and risks self-trapping.
  // stepAi decrements mineCooldown and re-arms it only on a successful drop. The capacity
  // check is defence in depth: dropMine enforces a cap for every owner too.
  // The player-threat gate matters: dropping merely because the cooldown allowed it made
  // own mines the largest single cause of AI deaths, with the tank littering ground nobody
  // was contesting.
  const mine = mineInclination(world, tank, cfg)
    && !avoid && tank.mineCooldown <= 0 && tank.activeMineIds.length < cfg.mineCapacity
    && mineThreatensPlayer(world, tank, hazard.tacticalRadius);

  // nextState is a label only: greyDecision never branches on tank.aiState.
  // nextTimer resets here when patience is spent too, so the next held run counts from 1.
  // nextIntent/nextIntentTicks are placeholders -- decideAi overwrites both.
  return { desiredMove: move, turretAngle, fire, hasSolution: sees, fireType: weapon.bulletType, mine, nextState, nextTimer: 0, avoid, avoidKind, nextIntent: null, nextIntentTicks: 0, nextAimHeld: null, nextAimHeldTicks: 0 };
}
