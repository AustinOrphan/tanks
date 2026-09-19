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
import { configFor } from '../../src/sim/config/roster.ts';
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
  let aiTicks = 0;
  /** @type {Map<number, number | undefined>} */
  const lastTarget = new Map();

  for (const { world } of scenarioSteps(generateScenario(seed, ticks))) {
    const bots = aiTanks(world);
    if (bots.length === 0) continue;
    aiTicks += bots.length;

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
            from: before,
            to: t.aiTargetId,
            reason: t.aiRetargetReason ?? null,
          });
        }
        lastTarget.set(t.id, t.aiTargetId);
      }
    }
  }
  return { changes, pressureSamples, aiTicks };
}

function main() {
  const seeds = parseSeeds(arg('seeds', '1-20'));
  const ticks = Number(arg('ticks', 1800));
  const all = { changes: [], pressureSamples: [], aiTicks: 0, seeds: seeds.length, seedsWithBots: 0 };
  for (const seed of seeds) {
    const r = measureSeed(seed, ticks);
    if (r.aiTicks > 0) all.seedsWithBots += 1;
    all.changes.push(...r.changes);
    all.pressureSamples.push(...r.pressureSamples);
    all.aiTicks += r.aiTicks;
  }
  // Read the value BACK out of the resolved config rather than trusting the patch: this is
  // what proves the parent's edit reached the simulation in this process.
  all.observedCommitmentTime = configFor('brown').ai.targetCommitmentTime;
  process.stdout.write(JSON.stringify(all));
}

// UNCONDITIONAL. `vite-node` sets `process.argv[1]` to its own binary, so the usual
// "was I run or imported?" guard is always false here and the script would exit silently
// having printed nothing -- which it did, before this comment existed. Nothing imports this
// module; the testable parts live in `stats.mjs`.
main();
