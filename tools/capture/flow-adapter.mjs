/**
 * The `flow` capture producer (issue #815): a real application surface recorded at normal
 * playback speed through `tools/screens/record.mjs`.
 *
 * A sibling of the screen adapter, and shaped like it: build a strictly validated argv from
 * the recipe, shell out to a CLI that writes frames and a report, read the report back, and
 * hand the shared runner a schema-v1 result. The runner encodes the MP4, writes the manifest
 * and owns provenance and cleanup, exactly as for every other producer.
 *
 * WHAT THIS ADAPTER ADDS IS JUDGEMENT. The recorder measures and never decides (its header
 * says why); every measurement becomes an assertion here, against the recipe and the
 * checkout, so a capture that reached the wrong world, ran under a build it cannot name, lost
 * simulated time to a stalled frame, or slid into an outcome panel fails with the number that
 * says so. `judgeFlowReport` is pure, and `flow-adapter.test.ts` drives every gate both ways.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FLOW_FLAG_IDS, campaignArenaId } from '../screens/flow.mjs';
import { PRODUCER_RESULT_SCHEMA_VERSION } from './producer.mjs';
import { runProcess } from './process.mjs';
import { inspectSourceState } from './provenance.mjs';

/** The simulation's fixed rate (src/sim, 60 Hz) and how far a measured rate may sit from it. */
export const SIMULATION_TICK_RATE = 60;
export const SIMULATION_RATE_TOLERANCE = 0.03;

export function buildFlowArguments(recipe, outputRelative) {
  if (recipe.producer.kind !== 'flow') {
    throw new Error(`flow adapter cannot capture producer '${recipe.producer.kind}'`);
  }
  if (recipe.schedule.kind !== 'realtime') {
    throw new Error(`flow adapter records realtime schedules only, not '${recipe.schedule.kind}'`);
  }
  // Same containment rule as the gallery and screen adapters, for the same reason: this
  // string reaches a child process's argv.
  if (!/^tmp\/[A-Za-z0-9._/-]+$/.test(outputRelative) || outputRelative.includes('..')) {
    throw new Error('flow adapter output must be an isolated relative tmp/ path');
  }
  const { variant, fixture, viewport, schedule, playback, profile } = recipe;
  return [
    '--flow', recipe.producer.scenarioId,
    '--level', String(variant.level),
    '--seed', String(fixture.seed),
    '--driver', variant.driver,
    ...FLOW_FLAG_IDS.filter((id) => variant.flags[id] === true).flatMap((id) => ['--flag', id]),
    '--seconds', String(schedule.durationSeconds),
    '--fps', String(playback.intendedFps),
    '--w', String(viewport.width),
    '--h', String(viewport.height),
    '--dpr', String(viewport.devicePixelRatio),
    '--visual', profile.visual,
    '--stop', schedule.stop ?? 'window',
    '--dist', 'dist',
    '--out', outputRelative,
    '--report', `${outputRelative}/producer.json`,
    '--timeout', String(recipe.timeoutMs),
  ];
}

const assertion = (kind, passed, diagnostic, details) => ({ kind, passed, diagnostic, details });

/** The flags a recipe switched on, in the allowlist's order, as the recorder reports them. */
const onFlags = (flags) => Object.fromEntries(FLOW_FLAG_IDS.filter((id) => flags?.[id] === true).map((id) => [id, true]));

/**
 * Every gate, from the recorder's report and the recipe it served, against the checkout the
 * shared runner recorded. Pure: the report is data, and the negative controls in the test
 * file flip one field each.
 *
 * @param {object} recipe the validated flow recipe
 * @param {object} report `record.mjs`'s producer.json
 * @param {{ commitSha: string }} source the checkout the capture ran in
 */
export function judgeFlowReport(recipe, report, source) {
  const p = report.producer;
  const t = p.timing;
  const out = [];

  const requested = { level: recipe.variant.level, seed: recipe.fixture.seed, driver: recipe.variant.driver, flags: onFlags(recipe.variant.flags) };
  const reported = { level: p.inputs?.level, seed: p.inputs?.seed, driver: p.inputs?.driver, flags: onFlags(p.inputs?.flags) };
  const sameInputs = JSON.stringify(requested) === JSON.stringify(reported);
  out.push(assertion(
    'flow-report-identity',
    p.kind === 'flow' && p.flowId === recipe.producer.scenarioId && sameInputs,
    p.kind === 'flow' && p.flowId === recipe.producer.scenarioId && sameInputs
      ? `recorded flow '${p.flowId}' with the requested level, seed, driver and flags`
      : `recorder reported ${p.kind}:${p.flowId} with inputs ${JSON.stringify(reported)}; recipe requested ${JSON.stringify(requested)}`,
    { requested, reported },
  ));

  const errors = p.pageErrors ?? [];
  out.push(assertion('page-errors', errors.length === 0, errors.length === 0 ? 'no uncaught page errors' : `uncaught page error(s): ${errors.join(' | ')}`, { errors }));

  const d = p.diagnostics ?? {};
  const configOk = d.developerMode === true && (d.requestedNotInEffect ?? []).length === 0 && (d.unknownParams ?? []).length === 0;
  out.push(assertion(
    'flow-config-effective',
    configOk,
    configOk
      ? 'the page opened developer mode and refused none of the requested parameters'
      : `the page's diagnostics show developer mode ${d.developerMode ? 'on' : 'off'}, refused ${JSON.stringify(d.requestedNotInEffect ?? [])}, unknown ${JSON.stringify(d.unknownParams ?? [])}`,
    { developerMode: d.developerMode ?? null, requestedNotInEffect: d.requestedNotInEffect ?? [], inEffectUnrequested: d.inEffectUnrequested ?? [], unknownParams: d.unknownParams ?? [], url: d.url ?? null },
  ));

  const build = d.build ?? { known: false, commit: null };
  const buildOk = build.known === true && build.commit === source.commitSha;
  out.push(assertion(
    'flow-build-identity',
    buildOk,
    buildOk
      ? `the page names build ${build.commit}, the checkout being captured`
      : build.known
        ? `the page names build ${build.commit} but the checkout is ${source.commitSha}; rebuild with VITE_BUILD_SHA=${source.commitSha} npm run build`
        : `the page does not know its build; build with VITE_BUILD_SHA=${source.commitSha} npm run build so the capture can name it`,
    { pageBuild: build, checkout: source.commitSha, dist: p.dist ?? null },
  ));

  const w = p.world ?? {};
  const expectedArena = campaignArenaId(recipe.variant.level);
  const worldOk = w.seed === recipe.fixture.seed && w.arenaId === expectedArena;
  out.push(assertion(
    'flow-world-identity',
    worldOk,
    worldOk
      ? `the round is seed ${w.seed} on ${w.arenaId}, level ${recipe.variant.level}'s arena`
      : `the round reports seed ${w.seed} on ${w.arenaId}; the recipe asked for seed ${recipe.fixture.seed} on ${expectedArena} (level ${recipe.variant.level})`,
    { reported: { seed: w.seed ?? null, arenaId: w.arenaId ?? null, practice: w.practice ?? null }, expected: { seed: recipe.fixture.seed, arenaId: expectedArena } },
  ));

  const r = p.readiness ?? {};
  const surfaces = t?.simulation?.surfaces ?? [];
  const stayed = r.surfaceAtStart === 'playing' && r.surfaceAtEnd === 'playing' && surfaces.every((s) => s === 'playing');
  out.push(assertion(
    'flow-still-playing',
    stayed,
    stayed
      ? `the round was playing at every sample and at the end of the ${t?.requestedSeconds ?? '?'} s window`
      : `the surface left 'playing' during the window: start ${r.surfaceAtStart}, end ${r.surfaceAtEnd}, samples ${JSON.stringify([...new Set(surfaces)])}`,
    { surfaceAtStart: r.surfaceAtStart ?? null, surfaceAtEnd: r.surfaceAtEnd ?? null, samples: surfaces.length, readyAfterMs: r.readyAfterMs ?? null, countdownMs: r.countdownMs ?? null },
  ));

  const render = t?.render ?? {};
  const clamped = render.clampedFrames ?? null;
  out.push(assertion(
    'flow-no-clamped-frames',
    clamped === 0,
    clamped === 0
      ? `no animation frame crossed the ${render.clampMs ?? 250} ms catch-up clamp; simulated time kept pace with the clock`
      : `${clamped ?? 'unknown'} animation frame(s) crossed the catch-up clamp, losing ${render.simTimeLostMs ?? '?'} ms of simulated time`,
    { clampedFrames: clamped, simTimeLostMs: render.simTimeLostMs ?? null, renderFps: render.fps ?? null, gapMaxMs: render.gapMaxMs ?? null },
  ));

  const sim = t?.simulation ?? {};
  const rate = sim.ticksPerSecond ?? null;
  const rateOk = sim.available === true && rate !== null && Math.abs(rate - SIMULATION_TICK_RATE) <= SIMULATION_TICK_RATE * SIMULATION_RATE_TOLERANCE;
  out.push(assertion(
    'flow-simulation-rate',
    rateOk,
    rateOk
      ? `the simulation advanced ${rate.toFixed(2)} ticks per wall-clock second over ${sim.seconds?.toFixed(2)} s`
      : sim.available
        ? `the simulation advanced ${rate === null ? 'an unknown number of' : rate.toFixed(2)} ticks per wall-clock second; ${SIMULATION_TICK_RATE} within ${SIMULATION_RATE_TOLERANCE * 100}% is normal speed`
        : 'the replay surface was not available, so the simulation rate could not be measured',
    { ticksPerSecond: rate, ticks: sim.ticks ?? null, seconds: sim.seconds ?? null, samples: sim.samples ?? null, resets: sim.resets ?? null, expected: SIMULATION_TICK_RATE, tolerance: SIMULATION_RATE_TOLERANCE },
  ));

  const f = p.frames ?? {};
  const mismatched = f.mismatched ?? [];
  const sizeOk = mismatched.length === 0 && f.first !== null && f.first !== undefined
    && f.first.width === f.expected?.width && f.first.height === f.expected?.height;
  out.push(assertion(
    'flow-frame-size',
    sizeOk,
    sizeOk
      ? `every staged frame is ${f.expected.width}x${f.expected.height}`
      : `frame size mismatch: expected ${f.expected?.width}x${f.expected?.height}, first ${JSON.stringify(f.first ?? null)}, mismatched ${JSON.stringify(mismatched.slice(0, 3))}`,
    { expected: f.expected ?? null, first: f.first ?? null, mismatched },
  ));

  const expectedFrames = recipe.schedule.durationSeconds * recipe.playback.intendedFps;
  const roundEnd = (recipe.schedule.stop ?? 'window') === 'round-end';
  const count = t?.frameCount ?? null;
  const countOk = t?.fps === recipe.playback.intendedFps && count !== null
    && (roundEnd ? count >= 1 && count <= expectedFrames : count === expectedFrames);
  out.push(assertion(
    'flow-frame-count',
    countOk,
    countOk
      ? roundEnd
        ? `${count} frames at ${recipe.playback.intendedFps} fps: the round ${t?.stop?.reason === 'round-ended' ? `ended after ${t?.stop?.playingSeconds?.toFixed(2)} s` : 'lasted the whole window'}, within the ${recipe.schedule.durationSeconds} s ceiling`
        : `${expectedFrames} frames at ${recipe.playback.intendedFps} fps`
      : `recorder produced ${count} frames at ${t?.fps} fps; the recipe's window is ${expectedFrames} at ${recipe.playback.intendedFps}${roundEnd ? ' at most' : ''}`,
    { frameCount: count, fps: t?.fps ?? null, expectedFrames, stop: t?.stop ?? null, resample: t?.resample ?? null },
  ));

  if (Object.hasOwn(recipe.variant, 'minimumDeliveredFps')) {
    const minimum = recipe.variant.minimumDeliveredFps;
    const delivered = t?.screencast?.fps ?? null;
    const deliveredOk = delivered !== null && delivered >= minimum;
    out.push(assertion(
      'flow-delivered-rate',
      deliveredOk,
      deliveredOk
        ? `the compositor delivered ${delivered.toFixed(1)} frames per second, at least the ${minimum} the recipe requires`
        : `the compositor delivered ${delivered === null ? 'no measurable' : delivered.toFixed(1)} frames per second under ${p.browser?.renderer ?? 'an unknown renderer'}; the recipe requires ${minimum}`,
      { deliveredFps: delivered, minimum, renderer: p.browser?.renderer ?? null, visual: p.browser?.visual ?? null, maxConsecutiveHold: t?.resample?.maxConsecutiveHold ?? null },
    ));
  }
  return out;
}

export async function runFlow(context, deps = {}) {
  const run = deps.runProcess ?? runProcess;
  const inspect = deps.inspectSourceState ?? inspectSourceState;
  const args = buildFlowArguments(context.recipe, context.outputRelative);
  try {
    await run(process.execPath, [join(context.root, 'tools/screens/record.mjs'), ...args], {
      cwd: context.root,
      env: {
        ...process.env,
        ...context.env,
        PLAYWRIGHT_MODULE: context.prerequisites.playwright.moduleSpecifier,
      },
      timeoutMs: context.recipe.timeoutMs,
      signal: context.signal,
    });
  } catch (error) {
    throw new Error(`flow capture failed: ${error.message}`, { cause: error });
  }

  let report;
  try {
    report = JSON.parse(await readFile(join(context.outputDirectory, 'producer.json'), 'utf8'));
  } catch (error) {
    throw new Error(`flow capture did not produce a readable producer report: ${error.message}`, { cause: error });
  }
  if (report?.producer?.flowId !== context.recipe.producer.scenarioId) {
    throw new Error(
      `flow capture reported flow '${report?.producer?.flowId}' for recipe '${context.recipe.producer.scenarioId}'`,
    );
  }
  const source = await inspect(context.root, null, { signal: context.signal });
  const frameCount = context.recipe.schedule.durationSeconds * context.recipe.playback.intendedFps;
  return {
    schemaVersion: PRODUCER_RESULT_SCHEMA_VERSION,
    producer: { kind: 'flow', scenarioId: context.recipe.producer.scenarioId },
    rawFrames: Array.from({ length: frameCount }, (_, index) =>
      join(context.outputDirectory, `frame-${String(index).padStart(4, '0')}.png`)),
    capture: {
      viewport: report.capture.viewport,
      frameSchedule: { kind: 'frames', frameCount },
    },
    assertions: judgeFlowReport(context.recipe, report, source),
    metadata: { flow: report.producer },
    toolVersions: report.toolVersions ?? {},
    diagnostics: [],
  };
}
