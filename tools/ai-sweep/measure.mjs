/**
 * One measurement pass of the AI target-commitment sweep (issue #359), in its own process.
 *
 * WHY ITS OWN PROCESS. `configFor` reads a catalog that `src/sim/config/roster.ts` resolves
 * ONCE at module load from validated JSON. Patching that JSON and re-importing in the same
 * process would read the cached module and measure the shipped value under every label --
 * the dead-knob failure this whole sweep is built to avoid. `run.mjs` therefore patches the
 * file and spawns this script fresh for each value.
 *
 * Run through `vite-node`, the repository's runner for tools that import `src/`.
 *
 *   vite-node tools/ai-sweep/measure.mjs -- --seeds 1-20 --ticks 1800
 *
 * Prints one JSON object on stdout and nothing else, so the parent can parse it.
 */
import { generateScenario, scenarioSteps } from '../../src/sim/scenarios.ts';
import { configFor, GAME_TANK_DEFS, TANK_KINDS } from '../../src/sim/config/roster.ts';
import { parseSeeds } from './stats.mjs';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}

/** The AI tanks a target-selection measurement is about: bots, alive, holding or seeking. */
const aiTanks = (world) => world.tanks.filter((t) => t.kind !== 'player' && t.alive);

function measureSeed(seed, ticks) {
  const changes = [];
  const pressureSamples = [];
  /** AI-ticks per tank kind: the denominator every per-profile rate is divided by (#908). */
  const ticksByKind = {};
  /** Shared-target samples per tank kind (#908). See the comment where they are pushed. */
  const sharedByKind = {};
  let aiTicks = 0;
  /** @type {Map<number, number | undefined>} */
  const lastTarget = new Map();

  for (const { world } of scenarioSteps(generateScenario(seed, ticks))) {
    const bots = aiTanks(world);
    if (bots.length === 0) continue;
    aiTicks += bots.length;
    for (const t of bots) ticksByKind[t.kind] = (ticksByKind[t.kind] ?? 0) + 1;

    // Pressure: the largest share of live bots aimed at one opponent this tick. Bots with no
    // target are counted in the denominator -- "nobody has a target" is low pressure, not
    // undefined -- so a run that loses sight of everyone does not read as a gang-up.
    const counts = new Map();
    for (const t of bots) {
      if (t.aiTargetId === undefined) continue;
      counts.set(t.aiTargetId, (counts.get(t.aiTargetId) ?? 0) + 1);
    }
    const largest = counts.size === 0 ? 0 : Math.max(...counts.values());
    pressureSamples.push(+(largest / bots.length).toFixed(4));

    // Per-kind pressure, as "how much company does this profile keep on its target" (#908):
    // for each bot that HAS a target, the share of live bots aimed at that same opponent.
    //
    // NOT the same shape as `pressureSamples` above, on purpose, and the asymmetry is the
    // point. The board-level sample counts target-less bots in its denominator, because
    // "nobody has a target" is low pressure for the board. A per-kind sample cannot: a bot
    // with no target is not sharing one, and scoring it 0 would let a profile that loses
    // sight of everyone read as the most considerate. So target-less ticks are absent from
    // `sharedByKind` and present in `ticksByKind`, which means `sharedTarget.n` below a
    // kind's AI-ticks is itself the measure of how often that kind had nothing to aim at.
    //
    // The floor is 1/bots.length, never 0: a bot always shares its target with itself.
    for (const t of bots) {
      if (t.aiTargetId === undefined) continue;
      const together = counts.get(t.aiTargetId) ?? 1;
      (sharedByKind[t.kind] ??= []).push(+(together / bots.length).toFixed(4));
    }

    for (const t of bots) {
      const before = lastTarget.get(t.id);
      if (before !== t.aiTargetId) {
        // `seen` guards the very first observation of a tank, which is not a CHANGE: it is
        // the tank appearing in the measurement, and counting it would add one phantom
        // retarget per bot per seed and inflate short-commitment rows the most.
        if (lastTarget.has(t.id)) {
          changes.push({
            tick: world.tick,
            tankId: t.id,
            // The SEED, because `tankId` is unique only within one. Every seed's changes are
            // concatenated into one array, so a span keyed by `tankId` alone pairs this seed's
            // tank 3 with the next seed's tank 3 -- and since each seed restarts the tick
            // counter, that produces NEGATIVE spans of up to a whole run's length. The `seen`
            // guard just above is what makes the pairing reachable: it swallows a tank's first
            // observation, so its first RECORDED change in a seed is a switch carrying a
            // defined `from`, and a defined `from` is what closes an open span. Measured over
            // seeds 1-40 at 1800 ticks, all 56 of the 56 distinct (seed, tank) pairs began that
            // way, and a tankId-only key over them yields 35 negative spans of 102, worst -1286.
            seed,
            // The tank's KIND, so a change can be attributed to the AI profile that chose it
            // (#908). Recorded here rather than looked up later, for the same reason as `seed`.
            kind: t.kind,
            from: before,
            to: t.aiTargetId,
            reason: t.aiRetargetReason ?? null,
          });
        }
        lastTarget.set(t.id, t.aiTargetId);
      }
    }
  }
  return { changes, pressureSamples, ticksByKind, sharedByKind, aiTicks };
}

/**
 * Every profile's resolved `targetCommitmentTime`, keyed by profile id.
 *
 * WHY ALL OF THEM, not one. The previous read-back was `configFor('brown')` alone, which
 * proves a patch landed only when every profile moved together -- `run.mjs` says so in its
 * own comment, and leaves a `--profile` run with no read-back at all. Returning the whole map
 * lets the parent assert exactly what it asked for: the named profile moved and the other
 * seven did not.
 *
 * DERIVED FROM THE VALIDATED CATALOG, never from a table in this tool. `GAME_TANK_DEFS[kind]
 * .aiProfile` is the same mapping gameplay resolves through, so a kind that changes profile
 * cannot leave a stale copy here. Two kinds sharing a profile must agree; if they ever do
 * not, the resolution is not a function of the profile and the whole per-profile report is
 * meaningless, so that is thrown rather than silently last-write-wins.
 */
function resolvedCommitmentByProfile() {
  /** @type {Record<string, number>} */
  const byProfile = {};
  for (const kind of TANK_KINDS) {
    const profile = GAME_TANK_DEFS[kind].aiProfile;
    const value = configFor(kind).ai.targetCommitmentTime;
    if (byProfile[profile] !== undefined && byProfile[profile] !== value) {
      throw new Error(`profile ${profile} resolved ${byProfile[profile]} and ${value} for different kinds`);
    }
    byProfile[profile] = value;
  }
  return byProfile;
}

/** Which AI profile each tank kind carries, for the parent to group rows by. */
function profileByKind() {
  return Object.fromEntries(TANK_KINDS.map((kind) => [kind, GAME_TANK_DEFS[kind].aiProfile]));
}

function main() {
  const seeds = parseSeeds(arg('seeds', '1-20'));
  const ticks = Number(arg('ticks', 1800));
  const all = {
    changes: [], pressureSamples: [], ticksByKind: {}, sharedByKind: {},
    aiTicks: 0, seeds: seeds.length, seedsWithBots: 0,
  };
  for (const seed of seeds) {
    const r = measureSeed(seed, ticks);
    if (r.aiTicks > 0) all.seedsWithBots += 1;
    all.changes.push(...r.changes);
    all.pressureSamples.push(...r.pressureSamples);
    all.aiTicks += r.aiTicks;
    for (const [kind, n] of Object.entries(r.ticksByKind)) {
      all.ticksByKind[kind] = (all.ticksByKind[kind] ?? 0) + n;
    }
    for (const [kind, samples] of Object.entries(r.sharedByKind)) {
      (all.sharedByKind[kind] ??= []).push(...samples);
    }
  }
  // Read the values BACK out of the resolved config rather than trusting the patch: this is
  // what proves the parent's edit reached the simulation in this process.
  all.observedCommitmentByProfile = resolvedCommitmentByProfile();
  all.profileByKind = profileByKind();
  process.stdout.write(JSON.stringify(all));
}

// UNCONDITIONAL. `vite-node` sets `process.argv[1]` to its own binary, so the usual
// "was I run or imported?" guard is always false here and the script would exit silently
// having printed nothing -- which it did, before this comment existed. Nothing imports this
// module; the testable parts live in `stats.mjs`.
main();
