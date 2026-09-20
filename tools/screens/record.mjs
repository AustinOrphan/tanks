/**
 * Record a real-time application capture (issue #815).
 *
 *   node tools/screens/record.mjs --flow campaign-round --level 1 --seed 7 --driver autoplay \
 *     [--flag pp1Roles] --seconds 10 --fps 30 --w 1280 --h 800 --dpr 1 --visual host-gpu \
 *     --dist dist --out tmp/producer --report tmp/producer/producer.json --timeout 120000
 *
 * The built page is served and driven exactly as the screen states are: one static server,
 * one Chromium, the same step vocabulary (`steps.mjs`). What differs is what happens once the
 * round is playing. Nothing steps the simulation; the page runs its own production loop at
 * wall-clock pace, and this process only watches: the CDP screencast hands over every frame
 * the compositor produces, with its timestamp; the replay surface (`?replay=1`) is polled for
 * the simulated tick count; the page's animation-frame timestamps are sampled. Afterwards the
 * frames are laid onto a constant-rate timeline (`flow.mjs`'s `resamplePlan`) and decoded by
 * one ffmpeg call into the `frame-%04d.png` sequence the shared capture pipeline encodes.
 *
 * THIS PROCESS MEASURES; `tools/capture/flow-adapter.mjs` JUDGES. Every number below goes into
 * the report as measured, and the adapter turns them into assertions against the recipe, so
 * the gates are testable without a browser and the report is complete even when a gate fails.
 *
 * Readiness is the one thing decided here, because nothing can be recorded without it: the
 * round must report `playing` within the budget, or this process exits non-zero naming what
 * it saw instead. A menu, a loading surface or an outcome panel is never recorded as gameplay.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runProcess } from '../capture/process.mjs';
import { GAME_CANVAS } from '../gallery/enter-gameplay.mjs';
import { audioContextOverrideSource } from '../shared/audio-context.mjs';
import { loadChromium } from '../shared/playwright.mjs';
import { serve as serveDist } from './capture.mjs';
import {
  FLOW_FLAG_IDS,
  FLOW_VISUALS,
  REALTIME_STOPS,
  TICKS_START,
  bankTicks,
  buildFlowUrl,
  campaignArenaId,
  findFlow,
  jpegDimensions,
  parseDiagnostics,
  playingWindow,
  resamplePlan,
  stopsAtSample,
  timingStats,
  totalTicks,
  validateFlowInputs,
} from './flow.mjs';
import { runStep } from './steps.mjs';

export const RECORD_REPORT_SCHEMA_VERSION = 1;


/** Poll the replay surface this often; the same cadence `steps.mjs` plays a round at. */
export const TICK_POLL_MS = 250;
/** The JPEG quality the screencast is asked for. Recorded in the report: frames are lossy before H.264. */
export const SCREENCAST_JPEG_QUALITY = 90;
/** The page's own catch-up clamp (`src/game/frame.ts` MAX_FRAME_DT), in milliseconds. */
export const FRAME_CLAMP_MS = 250;

/** The launch arguments for a visual profile. Recorded, never substituted: the report says which ran. */
export function launchArgumentsFor(visual, platform = process.platform) {
  if (visual === 'software-gl') return ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'];
  if (visual === 'host-gpu') {
    // Headless Chromium falls back to SwiftShader unless told to use the host's GPU. On macOS
    // that needs the Metal ANGLE backend named explicitly (measured: 18 fps without, 105 with,
    // at 1280x800 on an M1 Max); elsewhere Chromium picks a backend when a GPU is present.
    return ['--ignore-gpu-blocklist', ...(platform === 'darwin' ? ['--use-angle=metal'] : [])];
  }
  throw new Error(`unknown visual profile '${visual}' (${FLOW_VISUALS.join(', ')})`);
}

/** Parse this CLI's argv. Strict: an unknown flag, a missing value or a bad number is an error. */
export function parseRecordArgs(argv) {
  const values = new Map();
  const flags = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) throw new Error(`unexpected argument '${token}'`);
    const name = token.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`--${name} needs a value`);
    i++;
    if (name === 'flag') {
      // `--flag pp1Roles` is a switch; `--flag enemyRole=both` is a choice. The value half is
      // checked by validateFlowInputs below, against that flag's own vocabulary.
      const eq = value.indexOf('=');
      const id = eq === -1 ? value : value.slice(0, eq);
      if (!FLOW_FLAG_IDS.includes(id)) throw new Error(`--flag ${id} is not a flow flag (${FLOW_FLAG_IDS.join(', ')})`);
      flags.push([id, eq === -1 ? true : value.slice(eq + 1)]);
      continue;
    }
    if (values.has(name)) throw new Error(`--${name} given twice`);
    values.set(name, value);
  }
  const required = ['flow', 'level', 'seed', 'driver', 'seconds', 'fps', 'w', 'h', 'dpr', 'visual', 'stop', 'dist', 'out', 'report', 'timeout'];
  for (const name of required) if (!values.has(name)) throw new Error(`--${name} is required`);
  // OPTIONAL, and a pair: a versus flow needs both, every other flow needs neither.
  // `validateFlowInputs` enforces that, so this only has to admit them.
  const optional = ['mode', 'players'];
  const known = new Set([...required, ...optional]);
  for (const name of values.keys()) if (!known.has(name)) throw new Error(`unknown option --${name}`);
  const num = (name) => {
    const n = Number(values.get(name));
    if (!Number.isFinite(n)) throw new Error(`--${name} must be a number`);
    return n;
  };
  const inputs = validateFlowInputs({
    level: num('level'),
    seed: num('seed'),
    driver: values.get('driver'),
    flags: Object.fromEntries(flags),
    // `undefined`, not null or a default: `validateFlowInputs` distinguishes absent from
    // present and refuses one without the other, and a default here would make every
    // campaign recording claim to be a two-player versus round.
    mode: values.has('mode') ? values.get('mode') : undefined,
    players: values.has('players') ? num('players') : undefined,
  });
  const seconds = num('seconds');
  const fps = num('fps');
  if (!(seconds > 0) || !(fps > 0)) throw new Error('--seconds and --fps must be positive');
  const frameCount = seconds * fps;
  if (!Number.isInteger(frameCount)) throw new Error(`--seconds x --fps must be a whole frame count, got ${frameCount}`);
  if (!FLOW_VISUALS.includes(values.get('visual'))) throw new Error(`--visual must be one of ${FLOW_VISUALS.join(', ')}`);
  if (!REALTIME_STOPS.includes(values.get('stop'))) throw new Error(`--stop must be one of ${REALTIME_STOPS.join(', ')}`);
  const timeout = num('timeout');
  if (!(timeout >= 1000)) throw new Error('--timeout must be at least 1000 ms');
  return {
    flow: findFlow(values.get('flow')),
    inputs,
    seconds,
    fps,
    frameCount,
    viewport: { width: num('w'), height: num('h'), devicePixelRatio: num('dpr') },
    visual: values.get('visual'),
    stop: values.get('stop'),
    dist: values.get('dist'),
    out: values.get('out'),
    report: values.get('report'),
    timeout,
  };
}

/** What identifies the served bundle, independently of the checkout it sits in. */
async function distFingerprint(dist) {
  const index = await readFile(join(dist, 'index.html'));
  let assets = [];
  try {
    assets = (await readdir(join(dist, 'assets'))).sort();
  } catch {
    assets = [];
  }
  return { indexSha256: createHash('sha256').update(index).digest('hex'), assets };
}

/**
 * What the page says about itself, read from the HUD's own state classes rather than from
 * visibility: `.hud-touch` drops its hidden modifier exactly while the surface is 'playing'
 * (hud.ts), the Main Menu panel is display:none once a round starts, the game canvas exists
 * once a session is built, the round-start countdown (`.hud-count`) hides when the round
 * goes live, and the Practice chip says whether this round belongs to a run.
 */
const PLAYING_IN = `(() => {
  const touch = document.querySelector('.hud-touch');
  const panel = document.querySelector('.hud-panel');
  const canvas = document.querySelector(${JSON.stringify(GAME_CANVAS)});
  const count = document.querySelector('.hud-count');
  const practice = document.querySelector('.hud-practice');
  const playing = touch !== null && !touch.classList.contains('hud-touch--hidden');
  const panelHidden = panel === null || getComputedStyle(panel).display === 'none';
  const countdown = count !== null && !count.classList.contains('hud-count--hidden');
  return { playing, panelHidden, canvas: canvas !== null, countdown, practice: practice !== null && !practice.classList.contains('hud-practice--hidden') };
})()`;

const SURFACE_IN = `(() => {
  const s = ${PLAYING_IN};
  return s.playing && s.panelHidden && s.canvas ? 'playing' : (s.panelHidden ? 'not-playing' : 'menu');
})()`;

/**
 * What the screen says once a round is over: the outcome panel's own heading ("Level
 * Cleared", "Level Failed", "Game Over"). A clip whose round ended is evidence of an
 * OUTCOME, and a reviewer should not have to infer which one from the last frame.
 */
const OUTCOME_IN = `(() => {
  const title = document.querySelector('.hud-title');
  const text = title === null ? '' : (title.textContent ?? '').trim();
  return text === '' ? null : text;
})()`;

const TICK_SAMPLE_IN = `(() => {
  const replay = globalThis.__tanks && globalThis.__tanks.replay;
  const surface = ${SURFACE_IN};
  if (typeof replay !== 'function') return { ticks: null, now: performance.now(), surface };
  return { ticks: replay().ticks.length, now: performance.now(), surface };
})()`;

const WORLD_IN = `(() => {
  const replay = globalThis.__tanks && globalThis.__tanks.replay;
  if (typeof replay !== 'function') return null;
  const meta = replay().meta;
  return { seed: meta.seed, arenaId: meta.arenaId };
})()`;

const RENDERER_IN = `(() => {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
  if (!gl) return null;
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : 'masked';
})()`;

const START_RAF_SAMPLER = `(() => {
  const samples = [];
  globalThis.__flowRaf = samples;
  const step = (t) => { samples.push(t); requestAnimationFrame(step); };
  requestAnimationFrame(step);
})()`;

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

/**
 * Drive the flow to the recording start. Throws, naming what was seen, when the round does not
 * report `playing` within `timeout`.
 */
async function reachPlaying(page, flow, inputs, timeout) {
  // The flow's own way past the splash, then the diagnostics detour every flow wants (the
  // page's account of which build it is and which parameters it accepted), then the flow's
  // own way into gameplay.
  for (const step of flow.open) await runStep(page, step, timeout);
  const detour = [
    { click: '.hud-devtools-open' },
    { waitVisible: '.hud-devtools' },
    { click: '.hud-diag-copy' },
    { waitVisible: '.hud-diag-out' },
  ];
  for (const step of detour) await runStep(page, step, timeout);
  const diagnosticsText = await page.evaluate("document.querySelector('.hud-diag-out').value");
  const diagnostics = parseDiagnostics(diagnosticsText);
  await runStep(page, { click: '.hud-devtools-back' }, timeout);
  const startedAt = Date.now();
  for (const step of flow.start(inputs)) await runStep(page, step, timeout);
  const waitFor = async (predicate, what) => {
    try {
      await page.waitForFunction(`(() => { const s = ${PLAYING_IN}; return ${predicate}; })()`, undefined, { timeout });
    } catch (error) {
      const seen = await page.evaluate(PLAYING_IN).catch(() => null);
      throw new Error(
        `flow '${flow.id}' did not reach ${what} within ${timeout} ms; last seen ${JSON.stringify(seen)}`,
        { cause: error },
      );
    }
  };
  await waitFor('s.playing && s.panelHidden && s.canvas', 'a playing round');
  const playingAt = Date.now();
  // The round opens with a countdown during which nothing moves (hud.ts setRoundPhase);
  // recording starts when it clears, so the window holds play, not a number.
  await waitFor('s.playing && !s.countdown', 'the end of the round-start countdown');
  const seen = await page.evaluate(PLAYING_IN);
  return {
    diagnostics,
    readyAfterMs: Date.now() - startedAt,
    countdownMs: Date.now() - playingAt,
    practice: seen.practice,
  };
}

/**
 * Record `seconds` of the playing page: screencast frames to disk, tick samples, animation
 * frames. Returns everything measured, with frame timestamps relative to the first frame.
 */
async function recordWindow(page, context, { seconds, viewport, out, signal, stop }) {
  const cdp = await context.newCDPSession(page);
  const frames = [];
  const writes = [];
  let bytes = 0;
  cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    // Acknowledge first: Chromium holds back frames while a few are un-acked, and disk I/O
    // must not lower the rate this report measures.
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    const index = frames.length;
    frames.push({ index, timestamp: metadata.timestamp, file: `cast-${String(index).padStart(6, '0')}.jpg` });
    const buffer = Buffer.from(data, 'base64');
    bytes += buffer.length;
    writes.push(writeFile(join(out, frames[index].file), buffer));
  });
  await page.evaluate(START_RAF_SAMPLER);
  const samples = [];
  const startedAtMs = Date.now();
  await cdp.send('Page.startScreencast', {
    format: 'jpeg',
    quality: SCREENCAST_JPEG_QUALITY,
    maxWidth: Math.round(viewport.width * viewport.devicePixelRatio),
    maxHeight: Math.round(viewport.height * viewport.devicePixelRatio),
    everyNthFrame: 1,
  });
  try {
    const endAtMs = startedAtMs + seconds * 1000;
    for (;;) {
      if (signal?.aborted) throw new Error('recording aborted');
      const sample = await page.evaluate(TICK_SAMPLE_IN);
      samples.push({ ...sample, atMs: Date.now() });
      // A round-end stop ends at the first sample that is not playing; the window is then cut
      // back to the last sample that was, so the outcome panel is never in the clip.
      if (stopsAtSample(stop, sample.surface)) break;
      const remaining = endAtMs - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(TICK_POLL_MS, remaining));
    }
  } finally {
    await cdp.send('Page.stopScreencast').catch(() => {});
  }
  const stoppedAtMs = Date.now();
  await Promise.all(writes);
  const raf = await page.evaluate('globalThis.__flowRaf ? globalThis.__flowRaf.slice() : []');
  const surfaceAtEnd = await page.evaluate(SURFACE_IN);
  const outcome = surfaceAtEnd === 'playing' ? null : await page.evaluate(OUTCOME_IN);
  await cdp.detach().catch(() => {});
  const first = frames[0]?.timestamp ?? 0;
  return {
    frames: frames.map((frame) => ({ ...frame, timestamp: frame.timestamp - first })),
    firstFrameEpochSeconds: frames[0]?.timestamp ?? null,
    bytes,
    samples,
    raf,
    surfaceAtEnd,
    outcome,
    startedAtMs,
    stoppedAtMs,
  };
}

/** Summarise the tick samples: rate against page-side time, with resets banked. */
export function simulationFromSamples(samples) {
  const valid = samples.filter((sample) => sample.ticks !== null);
  if (valid.length < 2) {
    return { available: valid.length > 0, samples: samples.length, ticks: 0, seconds: 0, ticksPerSecond: null, resets: 0, surfaces: samples.map((s) => s.surface) };
  }
  let state = TICKS_START;
  let resets = 0;
  for (const sample of valid) {
    const next = bankTicks(state, sample.ticks);
    if (next.total > state.total) resets++;
    state = next;
  }
  const firstTicks = valid[0].ticks;
  const ticks = totalTicks(state) - firstTicks;
  const seconds = (valid[valid.length - 1].now - valid[0].now) / 1000;
  return {
    available: true,
    samples: samples.length,
    ticks,
    seconds,
    ticksPerSecond: seconds > 0 ? ticks / seconds : null,
    resets,
    surfaces: samples.map((s) => s.surface),
  };
}

/** Lay the frames onto the constant-rate timeline and decode them; returns the plan and the frame sizes seen. */
async function decodeFrames({ frames, fps, frameCount, out, viewport, timeoutMs, signal, run }) {
  const plan = resamplePlan({ timestamps: frames.map((f) => f.timestamp), fps, frameCount });
  const expected = { width: Math.round(viewport.width * viewport.devicePixelRatio), height: Math.round(viewport.height * viewport.devicePixelRatio) };
  const mismatched = [];
  const sizes = new Map();
  for (const index of new Set(plan.sources)) {
    const size = jpegDimensions(await readFile(join(out, frames[index].file)));
    sizes.set(index, size);
    if (size.width !== expected.width || size.height !== expected.height) mismatched.push({ index, ...size });
  }
  for (const [slot, index] of plan.sources.entries()) {
    await copyFile(join(out, frames[index].file), join(out, `in-${String(slot).padStart(4, '0')}.jpg`));
  }
  // Relative names only, and cwd is the producer directory: no absolute path reaches ffmpeg's argv.
  await run('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-framerate', String(fps), '-start_number', '0', '-i', 'in-%04d.jpg',
    '-frames:v', String(frameCount), '-start_number', '0', 'frame-%04d.png',
  ], { cwd: out, timeoutMs, signal });
  const produced = (await readdir(out)).filter((name) => /^frame-\d{4}\.png$/.test(name)).sort();
  if (produced.length !== frameCount) {
    throw new Error(`ffmpeg wrote ${produced.length} frames; ${frameCount} were planned`);
  }
  for (const name of await readdir(out)) {
    if (/^(cast-\d{6}|in-\d{4})\.jpg$/.test(name)) await rm(join(out, name), { force: true });
  }
  return { plan, expected, mismatched, sizeOfFirst: sizes.get(plan.sources[0]) ?? null };
}

/**
 * The whole recording, from a served `dist` to a written report. `deps` exist for tests: a
 * fake Chromium and server prove that every resource is released on the failure paths.
 */
export async function recordFlow(options, deps = {}) {
  const chromiumLoader = deps.loadChromium ?? loadChromium;
  const serve = deps.serve ?? serveDist;
  const run = deps.runProcess ?? runProcess;
  const { flow, inputs, seconds, fps, frameCount, viewport, visual, stop, dist, out, report, timeout, signal } = options;
  if (!existsSync(resolve(dist, 'index.html'))) throw new Error(`no index.html under ${dist}; build first`);
  await mkdir(out, { recursive: true });
  const url = buildFlowUrl(inputs);
  const fingerprint = await distFingerprint(dist);
  const launchArgs = launchArgumentsFor(visual);

  let server = null;
  let browser = null;
  let context = null;
  try {
    server = await serve(dist);
    const base = `http://127.0.0.1:${server.address().port}/`;
    const chromium = await chromiumLoader();
    browser = await chromium.launch({ headless: true, args: launchArgs });
    context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: viewport.devicePixelRatio,
      reducedMotion: 'no-preference',
    });
    // Issue #877: every tool that boots the app removes the AudioContext constructor first.
    await context.addInitScript(audioContextOverrideSource());
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error?.message ?? error)));
    if (Object.keys(flow.storage).length > 0) {
      await page.goto(base, { waitUntil: 'domcontentloaded' });
      await page.evaluate((entries) => {
        localStorage.clear();
        for (const [key, value] of entries) localStorage.setItem(key, value);
      }, Object.entries(flow.storage));
    }
    await page.goto(`${base}${url}`, { waitUntil: 'load' });
    const { diagnostics, readyAfterMs, countdownMs, practice } = await reachPlaying(page, flow, inputs, timeout);
    const world = await page.evaluate(WORLD_IN);
    const renderer = await page.evaluate(RENDERER_IN);
    const recorded = await recordWindow(page, context, { seconds, viewport, out, signal, stop });
    const window = playingWindow(recorded.samples, stop);
    // Frames after the cut are dropped before anything is laid on the timeline. The screencast
    // stamps frames with epoch seconds and the samples carry epoch milliseconds, so the two
    // clocks compare directly.
    const cutEpoch = window.cutAtMs === null ? null : window.cutAtMs / 1000;
    const keptFrames = cutEpoch === null
      ? recorded.frames
      : recorded.frames.filter((frame) => recorded.firstFrameEpochSeconds + frame.timestamp <= cutEpoch);
    if (keptFrames.length === 0) throw new Error(`the round ended (${window.endedAs}) before any frame was recorded`);
    const playingSeconds = keptFrames[keptFrames.length - 1].timestamp - keptFrames[0].timestamp;
    const keptFrameCount = window.stopReason === 'window' ? frameCount : Math.max(1, Math.min(frameCount, Math.floor(playingSeconds * fps)));
    const decoded = await decodeFrames({ frames: keptFrames, fps, frameCount: keptFrameCount, out, viewport, timeoutMs: timeout, signal, run });
    const render = timingStats(recorded.raf, FRAME_CLAMP_MS);
    const castStats = timingStats(keptFrames.map((f) => f.timestamp * 1000), FRAME_CLAMP_MS);
    const simulation = simulationFromSamples(window.samples);

    const producer = {
      kind: 'flow',
      flowId: flow.id,
      title: flow.title,
      inputs,
      storage: Object.keys(flow.storage),
      url,
      dist: fingerprint,
      diagnostics,
      world: { ...world, expectedArenaId: campaignArenaId(inputs.level), practice },
      readiness: {
        readyAfterMs,
        countdownMs,
        surfaceAtStart: 'playing',
        surfaceAtEnd: window.samples.length > 0 ? window.samples[window.samples.length - 1].surface : recorded.surfaceAtEnd,
        endedAs: window.endedAs,
        endedWith: recorded.outcome,
      },
      timing: {
        policy: 'real-time: the production game loop at wall-clock pace, recorded from the compositor screencast and resampled to a constant frame rate by holding the last frame',
        requestedSeconds: seconds,
        stop: { requested: stop, reason: window.stopReason, cutAtMs: window.cutAtMs, playingSeconds, droppedFrames: recorded.frames.length - keptFrames.length },
        fps,
        frameCount: keptFrameCount,
        recording: { startedAtMs: recorded.startedAtMs, stoppedAtMs: recorded.stoppedAtMs, wallMs: recorded.stoppedAtMs - recorded.startedAtMs },
        simulation,
        render: { ...render, measuredUnder: 'cdp-screencast', note: 'headless animation frames are not display-throttled; a rate above the display rate is a headless artefact' },
        screencast: {
          format: 'jpeg',
          quality: SCREENCAST_JPEG_QUALITY,
          framesReceived: keptFrames.length,
          fps: castStats.fps,
          gapP50Ms: castStats.gapP50Ms,
          gapP95Ms: castStats.gapP95Ms,
          gapMaxMs: castStats.gapMaxMs,
          bytes: recorded.bytes,
          firstFrameEpochSeconds: recorded.firstFrameEpochSeconds,
        },
        resample: { method: 'hold-last-frame', ...decoded.plan, sources: undefined },
      },
      frames: { expected: decoded.expected, first: decoded.sizeOfFirst, mismatched: decoded.mismatched },
      browser: { version: browser.version(), headless: true, visual, renderer, launchArgs },
      pageErrors,
    };
    const reportBody = {
      schemaVersion: RECORD_REPORT_SCHEMA_VERSION,
      capture: { viewport },
      producer,
      toolVersions: { chromium: browser.version() },
    };
    await mkdir(resolve(report, '..'), { recursive: true });
    await writeFile(report, JSON.stringify(reportBody, null, 2));
    return reportBody;
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    if (server) await new Promise((ok) => server.close(ok));
  }
}

async function main() {
  const options = parseRecordArgs(process.argv.slice(2));
  const controller = new AbortController();
  for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => controller.abort());
  const body = await recordFlow({ ...options, signal: controller.signal });
  const t = body.producer.timing;
  console.log(
    `${options.flow.id}: ${t.frameCount} frames at ${t.fps} fps from ${t.screencast.framesReceived} screencast frames; `
      + `sim ${t.simulation.ticksPerSecond?.toFixed(1) ?? 'n/a'} ticks/s; render ${t.render.fps?.toFixed(1) ?? 'n/a'} fps; `
      + `surface at end ${body.producer.readiness.surfaceAtEnd}`,
  );
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error.stack ?? String(error));
    process.exit(1);
  });
}
