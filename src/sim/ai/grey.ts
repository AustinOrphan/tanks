import type { World } from '../world';
import type { Tank, AiState } from '../types';
import { lineOfSight, aimLead, aimJitter, dangerAvoidMove, incomingThreats, mineInclination, profileAimSpread, seekMove, shotHitsOwnSide, mineThreatensPlayer } from './targeting';
import { driveVelocity } from '../collision';
import { TICK_HZ } from '../constants';
import { configFor, type ResolvedTankConfig } from '../config';
import type { AiDecision } from './decision';

// The DEFENSIVE-behaviour implementation (decideAi routes here for any tank whose
// resolved profile behaviour is DEFENSIVE -- grey today). `cfg` is injectable so
// tests can probe profile consumption; the default is the tank's own resolved config.
export function greyDecision(world: World, tank: Tank, cfg: ResolvedTankConfig = configFor(tank.kind)): AiDecision {
  // Weapon (bullet type + muzzle speed) comes from the resolved config, not a
  // hardcoded 'normal' -- Grey fires the STANDARD_SHELL its definition names.
  const weapon = cfg.weapon;
  const avoid = dangerAvoidMove(world, tank);
  // dangerAvoidMove now vets its own direction against walls and armed mines (see
  // targeting.ts), so this can be trusted directly: a dodge into a wall used to net zero
  // displacement and pin Grey inside the danger corridor while it held fire.
  // The baseline move is the distance-band seek (targeting.ts seekMove): approach
  // beyond ai.preferredDistance, retreat-by-draw inside ai.minimumDistance, wander
  // in the band. Dodging still overrides it entirely.
  const move = avoid ?? seekMove(world, tank, cfg);

  // Cautious (swapped from Teal): Grey holds fire while dodging, but only for a bounded
  // run of consecutive ticks (tracked via aiTimer/nextTimer). The patience span is
  // PROFILE-DRIVEN: (1 - ai.aggression) seconds -- a fully aggressive profile (1.0)
  // never suppresses, a fully passive one (0.0) holds a whole second. At the shipped
  // DEFENSIVE_BASIC aggression of 0.25 this is exactly the tuned 45 ticks the constant
  // DODGE_PATIENCE_TICKS pins (config/roster.test.ts asserts the equality, so retuning
  // either side is a loud two-file edit). The cap is mandatory, not cosmetic: the
  // player's FIRE_COOLDOWN (0.4s) is shorter than the THREAT_HORIZON (1.0s) that keeps
  // dangerAvoidMove returning non-null, so a player who just keeps shooting would
  // otherwise suppress Grey's fire forever. Movement and turret/fire are independent:
  // past the threshold Grey still dodges (move stays the dodge vector) but evaluates
  // the shooting logic normally.
  const patienceTicks = Math.round((1 - cfg.ai.aggression) * TICK_HZ);
  //
  // Gated on INCOMING FIRE, not on `avoid`. dangerAvoidMove also returns a direction for
  // a nearby mine -- including Grey's OWN, which it must still walk away from, because
  // detonateMine kills every tank in the blast with no owner exemption. But stepping away
  // from a mine leaves the turret free, and suppressing fire for it gagged Grey's trigger
  // for much of its life: it drops a mine only when the player is close enough to be
  // threatened, then stands inside its own flee radius with a clear shot and holds fire.
  // The patience mechanism is about bullets and nothing else.
  const underFire = incomingThreats(world, tank).length > 0;
  const dodgeTicks = underFire ? tank.aiTimer + 1 : 0;
  if (underFire && dodgeTicks < patienceTicks) {
    return { desiredMove: move, turretAngle: tank.turretAngle, fire: false, fireType: weapon.bulletType, mine: false, nextState: 'reposition', nextTimer: dodgeTicks };
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
      turretAngle = aimLead(tank.pos, player.pos, targetVel, weapon.speed)
        + aimJitter(world, tank, profileAimSpread(cfg));
      // lineOfSight only tests WALLS, but resolveBulletHits kills any non-owner tank the
      // shell touches. Keep tracking the player with the turret either way -- only the
      // trigger is held, so the shot goes off the moment the teammate clears the lane.
      fire = !shotHitsOwnSide(world, tank, turretAngle, weapon.bulletType);
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
  // Profile-drawn inclination (mineInclination, targeting.ts): the chance's
  // MAGNITUDE is the per-bucket probability of proposing when every tactical
  // gate below already says yes.
  const mine = mineInclination(world, tank, cfg)
    && !avoid && tank.mineCooldown <= 0 && tank.activeMineIds.length < cfg.mineCapacity
    && mineThreatensPlayer(world, tank);

  // nextState is still vestigial for Grey: unlike Brown, greyDecision never branches on
  // tank.aiState (nextState here is just a passthrough/label, not a driver of behaviour).
  // nextTimer, unlike before, is NOT always 0 here — the patience counter above writes
  // dodgeTicks back via the early return while suppressed; this path (dodging has ended
  // or never started) resets it to 0, which is what lets a fresh dodge start counting
  // from 1 again next time.
  return { desiredMove: move, turretAngle, fire, fireType: weapon.bulletType, mine, nextState, nextTimer: 0 };
}
