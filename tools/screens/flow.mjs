/**
 * The pure half of a real-time application capture (issue #815): what a flow is, how its
 * URL is built from structured inputs, and the arithmetic that turns compositor frames with
 * timestamps into a constant-frame-rate sequence and into the numbers a reviewer needs.
 *
 * Nothing here touches a browser, a file or a clock. `record.mjs` is the I/O shell around it,
 * and `tools/capture/flow-adapter.mjs` judges the report `record.mjs` writes. Keeping the
 * arithmetic here is what lets every way a capture can mislead -- a held frame, a clamped
 * frame, a reset trace, a wrong-sized frame -- be tested without Chromium.
 */
import { readFileSync } from 'node:fs';

/**
 * The campaign the flow plays, read from the same data the game reads (issue #154). A level
 * number in a recipe is bounded by this count and checked against this arena after the
 * round starts, because the game clamps an out-of-range jump to the last level rather than
 * refusing it (levels.ts), and a capture labelled "level 9" that shows level 5 is evidence of
 * nothing.
 */
const campaign = JSON.parse(
  readFileSync(new URL('../../src/sim/config/data/campaign.json', import.meta.url), 'utf8'),
);
export const CAMPAIGN_LEVEL_COUNT = campaign.levels.length;

/**
 * Every achievement id the game defines, read from its own source rather than restated, so a
 * new achievement is seeded the day it ships instead of unlocking itself mid-capture.
 */
export const ACHIEVEMENT_IDS = Object.freeze(
  [...readFileSync(new URL('../../src/game/achievements.ts', import.meta.url), 'utf8')
    .matchAll(/^\s{4}id: '([a-z0-9-]+)',$/gm)].map((m) => m[1]),
);

/** The arena a 1-based campaign level is built from. */
export function campaignArenaId(level) {
  const entry = campaign.levels[level - 1];
  if (entry === undefined) throw new Error(`campaign has no level ${level} (1-${CAMPAIGN_LEVEL_COUNT})`);
  return entry.arenaId;
}

/**
 * The developer flags a flow recipe may switch on, by the flag id `src/game/devflags.ts`
 * registers. An allowlist, not a pass-through: the issue forbids a recipe supplying an
 * arbitrary URL fragment, and `flow.test.ts` checks each id against the registry so a
 * renamed flag fails a test here rather than becoming an unknown parameter on the page.
 */
export const FLOW_FLAGS = Object.freeze({
  /** Issue #358's PP1 role-first ordnance matrix. A switch: present or absent. */
  pp1Roles: true,
  /**
   * Issue #773's non-colour role cue. A CHOICE, so the allowlist names its values.
   *
   * HARDCODED for the reason the gallery CLI hardcodes the same list: this file is `.mjs` and
   * cannot import the TypeScript that owns the vocabulary. `ENEMY_ROLE_CUES`
   * (src/presentation/enemy-role.ts) is the source of truth, and `flow.test.ts` pins the two
   * together in both directions, so a lever added there without a change here fails a test
   * rather than becoming a capture nobody can request.
   */
  enemyRole: Object.freeze(['girth', 'flare', 'dome', 'hull', 'deck', 'riser', 'crown', 'both']),
  /**
   * Issue #630's second identity channel, so a role cue can be judged beside an owner cue --
   * which is exactly what #773's evidence list asks for. Hardcoded and pinned like the above.
   */
  identityMarker: Object.freeze(['arcs', 'shape', 'roof']),
});
export const FLOW_FLAG_IDS = Object.freeze(Object.keys(FLOW_FLAGS));

/** The drivers a flow accepts. `autoplay` is the scripted player (`?autoplay=1`). */
export const FLOW_DRIVERS = Object.freeze(['autoplay']);

/**
 * The versus modes a flow may ask for. `teams` is here because the PAGE accepts it, so a
 * recipe naming it would otherwise be refused for a reason about this file rather than about
 * the game. No shipped recipe uses it yet.
 */
export const VERSUS_MODES = Object.freeze(['ffa', 'teams']);

/**
 * The renderers a flow may ask for. `software-gl` is the SwiftShader every screen capture
 * uses; `host-gpu` asks headless Chromium for the machine's GPU. Which one actually rendered
 * is recorded in the report, never assumed: the delivered frame rate is what a gate reads.
 */
export const FLOW_VISUALS = Object.freeze(['software-gl', 'host-gpu']);

/**
 * How a realtime recording ends. `window` records the whole `durationSeconds`; `round-end`
 * stops at the last sample taken while the round was still playing, so a round shorter than
 * the window is captured whole and an outcome panel is never in the clip. The window is then
 * the ceiling, and the frame count is whatever the round lasted.
 */
export const REALTIME_STOPS = Object.freeze(['window', 'round-end']);

/**
 * Whether the poll that saw `surface` ends the recording.
 *
 * Pure, because the loop it governs runs only against a live page: a `round-end` recording
 * stops the moment play does, and a `window` recording runs its window out and leaves the
 * verdict to the adapter's still-playing gate.
 */
export function stopsAtSample(stop, surface) {
  if (!REALTIME_STOPS.includes(stop)) throw new Error(`unknown stop policy '${stop}' (${REALTIME_STOPS.join(', ')})`);
  return stop === 'round-end' && surface !== 'playing';
}

/**
 * The usable window a recording's samples define. Each sample is one poll, in order, with
 * the surface it saw and the wall-clock time it was taken (`atMs`). Under `window` every
 * sample belongs to the window and a surface that is not `playing` is the adapter's to
 * refuse; under `round-end` the window ends at the last playing sample, and the cut time is
 * what the frames are trimmed to.
 */
export function playingWindow(samples, stop) {
  if (!REALTIME_STOPS.includes(stop)) throw new Error(`unknown stop policy '${stop}' (${REALTIME_STOPS.join(', ')})`);
  const firstOff = samples.findIndex((sample) => sample.surface !== 'playing');
  const endedAs = firstOff === -1 ? null : samples[firstOff].surface;
  if (stop === 'window' || firstOff === -1) return { samples, stopReason: 'window', cutAtMs: null, endedAs };
  return {
    samples: samples.slice(0, firstOff),
    stopReason: 'round-ended',
    cutAtMs: firstOff === 0 ? samples[0].atMs : samples[firstOff - 1].atMs,
    endedAs,
  };
}

/** A realtime schedule's bounds: whole seconds of wall clock, and the headroom the boot needs. */
export const REALTIME_MIN_SECONDS = 1;
export const REALTIME_MAX_SECONDS = 60;
export const REALTIME_READINESS_BUDGET_MS = 60_000;

/**
 * The flows the `flow` producer can capture. A flow is how the built page is taken from a
 * fresh load into the state the recording starts from: the storage it boots with, the steps
 * that get past the launch splash (`open`), and the steps that reach gameplay (`start`).
 * The recipe supplies the level, seed, driver and flags.
 *
 * WHY LEVEL SELECT AND NOT NEW GAME. `?level=N` moves the level system's `start`, which is
 * what CONTINUE resumes; a New Game deliberately lands on level one whatever the flag says
 * (`campaign-new` in `loop.ts`, issue #428). A flow that pressed New Game therefore ignored
 * the level its recipe named, silently, for every level but one -- caught here by the
 * adapter's `flow-world-identity` gate, which compares the round's arena against the level's.
 * Level Select reaches any unlocked level directly, so the recipe's `level` means what it
 * says. The session is a practice attempt either way: a developer level jump never owns the
 * campaign run (`isDevJump` in `levels.ts`).
 *
 * ONE ENTRY, deliberately. The issue asks for a reusable capability proved by one consumer,
 * and a catalogue of one keeps the id space real (a recipe names a flow the way a screen
 * recipe names a state) without inventing flows nothing captures yet.
 */
/**
 * The storage both Level Select flows seed, and the steps both take to reach a level.
 *
 * SHARED RATHER THAN REPEATED, and the manifest is what made that the right call: three
 * mutation entries anchor on these exact lines, and a second verbatim copy made every one of
 * them ambiguous -- `applyAt` refuses an anchor it can find twice. Extracting them keeps each
 * entry pointing at one place AND widens what it proves, since both flows now fail together
 * if the seeding or the route is broken.
 *
 * Enough progress that Level Select offers every campaign level: the pane renders one button
 * per UNLOCKED level, and under `?dev=1` the page reads the developer namespace, so these are
 * the developer-prefixed keys (`storage.ts`). No run is seeded: a practice pick neither reads
 * nor writes one.
 *
 * THE ACHIEVEMENTS ARE SEEDED TOO, and that is not tidiness. Progress alone leaves the
 * progress-shaped achievements unearned, so the first seconds of play unlock them and lay
 * toasts over the board -- an artifact of the fixture rather than of the game, and on a short
 * round they cover most of the clip. A player who had reached this progress would already hold
 * them. Every id is seeded: a capture is of PLAY, not of a notification.
 */
const LEVEL_SELECT_STORAGE = Object.freeze({
  'tanks.dev.tanks.progress.v1': JSON.stringify({ levelId: 'level-05' }),
  'tanks.dev.tanks.achievements.v1': JSON.stringify({ earned: ACHIEVEMENT_IDS }),
});

/** Dismiss the launch splash. Both flows open the same way. */
const PAST_SPLASH = Object.freeze([
  Object.freeze({ press: 'Space' }),
  Object.freeze({ waitHidden: '.hud-splash' }),
]);

/**
 * Reach one campaign level through Level Select.
 *
 * By accessible name, not by position: the grid renders a bare digit per unlocked level and
 * issue #629 gave each one this label.
 */
const levelSelectSteps = (level) => [
  { click: '.hud-levelselect-open' },
  { waitVisible: '.hud-levelselect' },
  { click: `.hud-level-btn[aria-label="Level ${level}"]` },
];

export const FLOWS = Object.freeze([
  Object.freeze({
    id: 'campaign-round',
    title: 'A campaign round at a chosen level',
    description:
      'Boot the built page with every level unlocked, dismiss the launch splash, read the '
      + 'session diagnostics, pick the requested level from Level Select, and record from the '
      + 'moment the round is playing and its start countdown has cleared.',
    /**
     * Enough progress that Level Select offers every campaign level: the pane renders one
     * button per UNLOCKED level. Under `?dev=1` the page reads the developer namespace, so
     * these are the developer-prefixed keys (`storage.ts`). No run is seeded: a practice pick
     * neither reads nor writes one.
     *
     * THE ACHIEVEMENTS ARE SEEDED TOO, and that is not tidiness. Progress alone leaves the
     * progress-shaped achievements unearned, so the first seconds of play unlock them and
     * lay toasts over the board -- an artifact of the fixture rather than of the game, and on
     * a short round they cover most of the clip. A player who had reached this progress would
     * already hold them. Every id is seeded: a capture is of PLAY, not of a notification.
     */
    storage: Object.freeze({
      'tanks.dev.tanks.progress.v1': JSON.stringify({ levelId: 'level-05' }),
      'tanks.dev.tanks.achievements.v1': JSON.stringify({ earned: ACHIEVEMENT_IDS }),
    }),
    open: Object.freeze([
      Object.freeze({ press: 'Space' }),
      Object.freeze({ waitHidden: '.hud-splash' }),
    ]),
    start: ({ level }) => [
      { click: '.hud-levelselect-open' },
      { waitVisible: '.hud-levelselect' },
      // By accessible name, not by position: the grid renders a bare digit per unlocked
      // level and issue #629 gave each one this label.
      { click: `.hud-level-btn[aria-label="Level ${level}"]` },
    ],
  }),
  Object.freeze({
    id: 'versus-round',
    title: 'A versus round at a chosen player count',
    description:
      'Boot the built page as a VERSUS session with the requested player count, dismiss the '
      + 'launch splash, pick the requested level from Level Select, and record from the moment '
      + 'the round is playing and its start countdown has cleared.',
    /**
     * A versus session under `?dev=1&mode=ffa` still runs the CAMPAIGN level system
     * (`hud.ts`'s `HudSessionKind` note), so Level Select is the way in here too and `level`
     * keeps meaning what it means everywhere else. What changes is the SHAPE of the session:
     * the stock strip is on, campaign stats are off, and `players` tanks share the board.
     */
    storage: LEVEL_SELECT_STORAGE,
    open: PAST_SPLASH,
    start: ({ level }) => [
      ...levelSelectSteps(level),
      // The strip is the thing a versus capture exists to show, and it is the only element
      // that says the session really is versus-shaped rather than a campaign board wearing
      // the flag. Waiting on it here turns "the mode parameter was ignored" from a capture
      // nobody notices into a flow that fails before it records a frame.
      { waitVisible: '.hud-versus-stocks:not(.hud-versus-stocks--hidden)' },
    ],
  }),
]);
export const FLOW_IDS = Object.freeze(FLOWS.map((flow) => flow.id));

export function findFlow(id) {
  const flow = FLOWS.find((candidate) => candidate.id === id);
  if (flow === undefined) throw new Error(`unknown flow '${id}' (known: ${FLOW_IDS.join(', ')})`);
  return flow;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Validate the structured inputs a flow is driven by. Shared by the recipe schema and by the
 * recorder's own argument parsing, so the two cannot disagree about what is allowed.
 */
export function validateFlowInputs({ level, seed, driver, flags, mode, players }) {
  if (!Number.isInteger(level) || level < 1 || level > CAMPAIGN_LEVEL_COUNT) {
    throw new Error(`level must be a whole number in [1, ${CAMPAIGN_LEVEL_COUNT}]`);
  }
  // Seed 0 is not "seed 0": the page's parser rejects it and derives a seed from the clock
  // (devflags.ts asSeed, loop.ts), which would record a reproducible-looking seed that
  // reproduces nothing.
  if (!Number.isInteger(seed) || seed < 1 || seed > 0xffff_ffff) {
    throw new Error('seed must be a whole number in [1, 4294967295]');
  }
  if (!FLOW_DRIVERS.includes(driver)) throw new Error(`driver must be one of ${FLOW_DRIVERS.join(', ')}`);
  // OPTIONAL, and only a versus flow supplies them. Both are real developer flags (`mode`,
  // `players`), so the page validates them a second time -- a value this accepted but the
  // page did not would quietly record the shipped campaign board instead of the arm, which
  // is why the ranges here are the page's own rather than a superset of them.
  if (mode !== undefined && !VERSUS_MODES.includes(mode)) {
    throw new Error(`mode must be one of ${VERSUS_MODES.join(', ')}`);
  }
  if (players !== undefined && (!Number.isInteger(players) || players < 2 || players > 4)) {
    throw new Error('players must be a whole number in [2, 4]');
  }
  // Both or neither: `mode` alone plays the board with one tank and no stock strip at all,
  // and `players` alone is campaign co-op, which is a different capture wearing this one's
  // name. A half-specified versus round is the failure that would look like a success.
  if ((mode === undefined) !== (players === undefined)) {
    throw new Error('mode and players must be given together');
  }
  if (!isPlainObject(flags)) throw new Error('flags must be a plain object');
  for (const [id, value] of Object.entries(flags)) {
    const allowed = FLOW_FLAGS[id];
    if (allowed === undefined) throw new Error(`flags.${id} is not a flow flag (${FLOW_FLAG_IDS.join(', ')})`);
    // A switch takes a boolean; a choice takes one of ITS OWN values, never an arbitrary
    // string. The page would read an unknown value as absent, so a capture would record the
    // arm it asked for and show the board without it.
    if (allowed === true) {
      if (typeof value !== 'boolean') throw new Error(`flags.${id} must be a boolean`);
    } else if (!allowed.includes(value)) {
      throw new Error(`flags.${id} must be one of ${allowed.join(', ')}`);
    }
  }
  return { level, seed, driver, flags: { ...flags }, mode, players };
}

/**
 * The query string the page is asked for, BUILT from validated fields in a fixed order and
 * never taken from a recipe as text. `dev=1` gates every other flag; `replay=1` publishes
 * the replay surface the recorder reads the tick count and the world identity from.
 */
export function buildFlowUrl(inputs) {
  const { level, seed, driver, flags, mode, players } = validateFlowInputs(inputs);
  const params = [['dev', '1'], ['replay', '1'], ['level', String(level)], ['seed', String(seed)]];
  // Session shape before driver and flags, the order the campaign parameters already follow.
  if (mode !== undefined) params.push(['mode', mode], ['players', String(players)]);
  if (driver === 'autoplay') params.push(['autoplay', '1']);
  for (const id of FLOW_FLAG_IDS) {
    const value = flags[id];
    if (value === undefined || value === false) continue;
    params.push([id, value === true ? '1' : value]);
  }
  return `?${params.map(([key, value]) => `${key}=${value}`).join('&')}`;
}

/** The query parameters a flow always carries for itself, as opposed to the experiment's flags. */
export const FLOW_DRIVER_PARAMS = Object.freeze(['dev', 'replay', 'level', 'seed', 'mode', 'players', 'autoplay']);

/**
 * Which compositor frame each output frame shows, at a constant `fps` from `start`.
 *
 * HOLD THE LAST FRAME. Output slot `k` falls at `start + k / fps`; it shows the latest
 * captured frame whose timestamp is at or before that instant, which is what a real-time
 * recorder does and what a viewer sees on a display: a frame stays up until the next one
 * lands. A slot the page did not render a new frame for repeats the previous one, and the
 * count of those repeats is reported, never hidden, because a smooth MP4 built from few
 * frames is the failure a reviewer most needs to be able to see.
 *
 * @param {{ timestamps: readonly number[], fps: number, frameCount: number, start?: number }} input
 *   timestamps in seconds, ascending; `start` defaults to the first timestamp
 */
export function resamplePlan({ timestamps, fps, frameCount, start = timestamps[0] }) {
  if (!Array.isArray(timestamps) || timestamps.length === 0) throw new Error('resamplePlan needs at least one frame');
  if (!(fps > 0) || !Number.isInteger(frameCount) || frameCount < 1) throw new Error('resamplePlan needs fps > 0 and a positive frameCount');
  for (let i = 1; i < timestamps.length; i++) {
    if (!(timestamps[i] >= timestamps[i - 1])) throw new Error(`timestamps must ascend (frame ${i})`);
  }
  const sources = [];
  let index = 0;
  for (let k = 0; k < frameCount; k++) {
    const at = start + k / fps;
    while (index + 1 < timestamps.length && timestamps[index + 1] <= at) index++;
    sources.push(index);
  }
  let heldFrames = 0;
  let run = 0;
  let maxConsecutiveHold = 0;
  for (let k = 1; k < sources.length; k++) {
    if (sources[k] === sources[k - 1]) {
      heldFrames++;
      run++;
      if (run > maxConsecutiveHold) maxConsecutiveHold = run;
    } else run = 0;
  }
  const last = timestamps[timestamps.length - 1];
  const end = start + frameCount / fps;
  return {
    sources,
    uniqueFramesUsed: new Set(sources).size,
    heldFrames,
    maxConsecutiveHold,
    sourceFrames: timestamps.length,
    coveredMs: Math.max(0, (last - start) * 1000),
    tailPadMs: Math.max(0, (end - last) * 1000),
  };
}

/**
 * What a run of animation-frame timestamps says about the page: its rate, how uneven it was,
 * and -- the number that matters for the timing contract -- how many frames crossed the
 * production driver's catch-up clamp. `MAX_FRAME_DT` in `src/game/frame.ts` is 0.25 s: a gap
 * longer than that costs the simulation wall time it never makes up, so `clampedFrames === 0`
 * is the exact statement that simulated time kept pace with the clock.
 *
 * @param {readonly number[]} timestamps rAF callback timestamps in milliseconds, ascending
 */
export function timingStats(timestamps, clampMs = 250) {
  const gaps = [];
  for (let i = 1; i < timestamps.length; i++) gaps.push(timestamps[i] - timestamps[i - 1]);
  const sorted = [...gaps].sort((a, b) => a - b);
  const at = (fraction) => (sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor(fraction * (sorted.length - 1)))]);
  const spanMs = timestamps.length > 1 ? timestamps[timestamps.length - 1] - timestamps[0] : 0;
  let clampedFrames = 0;
  let simTimeLostMs = 0;
  for (const gap of gaps) {
    if (gap > clampMs) {
      clampedFrames++;
      simTimeLostMs += gap - clampMs;
    }
  }
  return {
    frames: timestamps.length,
    spanMs,
    fps: spanMs > 0 ? (gaps.length / spanMs) * 1000 : null,
    gapP50Ms: at(0.5),
    gapP95Ms: at(0.95),
    gapMaxMs: sorted.length === 0 ? null : sorted[sorted.length - 1],
    clampMs,
    clampedFrames,
    simTimeLostMs,
  };
}

/**
 * Sum simulated ticks across world rebuilds, the rule `steps.mjs`'s `advancePlay` uses: the
 * replay surface counts the CURRENT world's ticks and a lost life or a new level starts a new
 * trace at 0, so a sample below the previous one banks the previous world's count.
 */
export const TICKS_START = Object.freeze({ total: 0, last: 0 });

export function bankTicks(state, ticks) {
  if (!Number.isInteger(ticks) || ticks < 0) throw new Error(`tick sample must be a whole number, got ${ticks}`);
  return ticks < state.last ? { total: state.total + state.last, last: ticks } : { total: state.total, last: ticks };
}

export const totalTicks = (state) => state.total + state.last;

const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

/**
 * The pixel size a JPEG declares, read from its start-of-frame segment. The screencast hands
 * over JPEG bytes, and the shared media check rejects any output that is not exactly the
 * viewport at its device pixel ratio -- so every frame is measured before it is staged, and
 * a wrong size fails here with the frame's index, not after the MP4 is encoded.
 */
export function jpegDimensions(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error('not a JPEG: missing SOI marker');
  }
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) throw new Error(`not a JPEG: expected a marker at byte ${offset}`);
    const marker = bytes[offset + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xff) {
      offset += marker === 0xff ? 1 : 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break;
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (SOF_MARKERS.has(marker)) {
      if (offset + 9 > bytes.length) break;
      const height = (bytes[offset + 5] << 8) | bytes[offset + 6];
      const width = (bytes[offset + 7] << 8) | bytes[offset + 8];
      return { width, height };
    }
    offset += 2 + length;
  }
  throw new Error('not a JPEG: no start-of-frame segment');
}

/**
 * The session diagnostics the page's own Developer Tools pane writes (issue #684), read back
 * as data. The report is the page's account of itself: which build it is, whether developer
 * mode opened, and which requested parameters it refused or did not know. A capture that only
 * echoed its own URL would prove it asked; this proves the page agreed.
 */
export function parseDiagnostics(text) {
  if (typeof text !== 'string' || !text.startsWith('## Tanks! session diagnostics')) {
    throw new Error('not a Tanks! session diagnostics report');
  }
  const lines = text.split('\n');
  const line = (prefix) => lines.find((l) => l.startsWith(prefix))?.slice(prefix.length).trim() ?? null;
  const buildRaw = line('- Build:');
  const build = buildRaw !== null && /^[0-9a-f]{40}$/.test(buildRaw)
    ? { commit: buildRaw, known: true }
    : { commit: null, known: false };
  const mode = line('- Developer mode:');
  const section = (heading) => {
    const start = lines.indexOf(heading);
    if (start === -1) return [];
    const names = [];
    for (let i = start + 1; i < lines.length; i++) {
      if (lines[i].startsWith('### ')) break;
      const match = /^- `([^`]+)`/.exec(lines[i]);
      if (match) names.push(match[1]);
    }
    return names;
  };
  return {
    url: line('- URL:'),
    build,
    developerMode: mode === 'on',
    requestedNotInEffect: section('### Requested, but not in effect'),
    inEffectUnrequested: section('### In effect without being requested'),
    unknownParams: section('### Parameters this build does not know'),
  };
}
