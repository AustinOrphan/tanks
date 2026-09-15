import type { AppLocation } from './app-state';
import { FLAG_REGISTRY } from './devflags';
import {
  diagnosticsReport,
  type DiagnosticsInput,
  type DiagnosticsReport,
  type SessionDiagnostics,
} from './dev-diagnostics';
import { checkTrace, type ReplayTrace } from './replay';

/**
 * THE FILES A DEVELOPER SESSION CAN SAVE (issue #254): a diagnostics report and a replay.
 *
 * PURE, like `dev-diagnostics.ts` beside it. This module decides what each file contains, what
 * it is called, and what the pane says about it -- including when there is nothing to save.
 * Writing the bytes out is the page's (`downloads.ts`, bound in `createBrowserDeps`), and the
 * live facts are the session's, read through `DevExportPort`.
 *
 * NOTHING HERE WRITES. The port offers two readers and no writer, so an export that fails
 * part-way has no game or persistence state it could have changed.
 */

/** The diagnostics file's `format`, so a file found later says what it is. */
export const DIAGNOSTICS_FORMAT = 'tanks.diagnostics';
/** Bumped when a field changes meaning or goes away; adding a field does not bump it. */
export const DIAGNOSTICS_SCHEMA = 1;

/**
 * Where the live world stands, which Copy Diagnostics does not print (issue #254's "tick/round
 * state").
 *
 * Its own record rather than three more `SessionDiagnostics` fields: that record is also the
 * benchmark report's `session`, and a tick read at press time is not a fact about a benchmark
 * sitting.
 */
export interface RoundDiagnostics {
  /** `world.tick`. */
  readonly tick: number;
  /** `world.roundStartTick`: the tick the current round (or its countdown) began on. */
  readonly roundStartTick: number;
  /** Which surface is up, from `surfaceName`: `gameplay/playing`, `route/main-menu`, ... */
  readonly surface: string;
}

/**
 * The state machine's location as one string: `route/<route>` or `gameplay/<phase>`.
 *
 * Both halves, because a phase alone cannot say that a session is sitting at its own title
 * screen, and a route alone cannot tell a paused round from a running one.
 */
export function surfaceName(location: AppLocation): string {
  return location.kind === 'route'
    ? `route/${location.route.kind}`
    : `gameplay/${location.phase.kind}`;
}

/**
 * What a session hands the pane for the exports: two readers, read at press time.
 *
 * `replay` answers `null` when the page was not opened with replay recording on. That is a
 * state the pane explains, not an empty trace it saves.
 */
export interface DevExportPort {
  round(): RoundDiagnostics;
  replay(): ReplayTrace | null;
  /** The game canvas's current frame, copied; see `FrameCapture`. */
  captureFrame(): FrameCapture;
}

/**
 * A copy of the game canvas's frame (issue #254's screenshot), as the renderer's `captureFrame`
 * returns it.
 *
 * THE DRAWING BUFFER, NOTHING ELSE. `width` and `height` are its pixels: the canvas's CSS size
 * times `pixelRatio`, which is `devicePixelRatio` capped by the quality preset's
 * `pixelRatioCap`. The HUD is not in it, because the HUD is page markup laid over the canvas
 * rather than part of the WebGL image.
 */
export interface FrameCapture {
  /** A 2D canvas holding the copied pixels, so encoding it later cannot read a cleared buffer. */
  readonly image: HTMLCanvasElement;
  readonly width: number;
  readonly height: number;
  readonly pixelRatio: number;
}

export const NO_SESSION_SCREENSHOT_NOTE =
  'No session is running, so there is no game canvas to save. Start a round and press this again.';

/** The screenshot's file name and the pane's line, for a frame `capture` of `session` at `round`. */
export function screenshotExport(
  session: SessionDiagnostics | null,
  round: RoundDiagnostics,
  capture: Pick<FrameCapture, 'width' | 'height' | 'pixelRatio'>,
): { readonly fileName: string; readonly note: string } {
  const size = `${capture.width}x${capture.height}`;
  const seed = session === null ? '' : `-seed${session.seed}`;
  const fileName = `tanks-canvas${seed}-tick${round.tick}-${size}-dpr${capture.pixelRatio}.png`;
  return {
    fileName,
    note: `Saved ${fileName}: the game canvas only, ${size} pixels at pixel ratio ${capture.pixelRatio} (tick ${round.tick}, ${round.surface}). The HUD is not in it: it is page markup over the canvas, not part of the WebGL image.`,
  };
}

/** The diagnostics file: Copy Diagnostics' record, stamped, plus the round. */
export interface DiagnosticsFile extends DiagnosticsReport {
  readonly format: typeof DIAGNOSTICS_FORMAT;
  readonly schema: typeof DIAGNOSTICS_SCHEMA;
  /** `null` when no session holds the slot, as `session` is. */
  readonly round: RoundDiagnostics | null;
}

/** A file to save, and the line the pane shows once it is saved. */
export interface ExportFile {
  readonly kind: 'file';
  readonly fileName: string;
  /** The MIME type the bytes are saved with. */
  readonly type: string;
  readonly text: string;
  readonly note: string;
}

/** Nothing to save, and why. */
export interface ExportUnavailable {
  readonly kind: 'unavailable';
  readonly note: string;
}

export type ExportResult = ExportFile | ExportUnavailable;

export function diagnosticsFile(input: DiagnosticsInput, round: RoundDiagnostics | null): DiagnosticsFile {
  return { format: DIAGNOSTICS_FORMAT, schema: DIAGNOSTICS_SCHEMA, ...diagnosticsReport(input), round };
}

/**
 * The diagnostics file, named for the seed and tick it describes.
 *
 * Always a file, session or not: Copy Diagnostics reports a page with no session too, and the
 * file carries `session: null` and `round: null` rather than refusing.
 */
export function diagnosticsExport(input: DiagnosticsInput, round: RoundDiagnostics | null): ExportFile {
  const file = diagnosticsFile(input, round);
  const fileName =
    file.session === null
      ? 'tanks-diagnostics-no-session.json'
      : `tanks-diagnostics-seed${file.session.seed}${round === null ? '' : `-tick${round.tick}`}.json`;
  const build = file.build.known ? `build ${file.build.commit}` : 'build unknown (not a deployed build)';
  const where = round === null ? 'no session running' : `tick ${round.tick}, ${round.surface}`;
  return {
    kind: 'file',
    fileName,
    type: 'application/json',
    text: `${JSON.stringify(file, null, 2)}\n`,
    note: `Saved ${fileName}: the fields Copy Diagnostics reports, plus where the round stands (${where}); ${build}.`,
  };
}

/** The `replay` flag's own parameter name, from the registry rather than as a literal. */
const REPLAY_PARAM = FLAG_REGISTRY.replay.param ?? 'replay';

export const NO_SESSION_REPLAY_NOTE =
  'No session is running, so there is no replay to save. Start a round and press this again.';

/** A file-name segment: anything outside letters, digits, `-` and `_` becomes `-`. */
function fileSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '-');
}

/**
 * The replay, when there is one this build can replay.
 *
 * THREE WAYS TO SAVE NOTHING, each said plainly (issue #254: "explain that state instead of
 * emitting a misleading empty replay"):
 *
 *  - recording is off on this page, so there is no trace at all;
 *  - recording is on, but this world has not simulated a tick, so the trace is empty;
 *  - `checkTrace` refuses it, so replay tooling on this build would not reproduce the run.
 *
 * The text is `JSON.stringify(trace)`, the object `__tanks.replay()` returns, so a saved file
 * parses back into a trace `checkTrace` and `replayTrace` accept as they are.
 */
export function replayExport(trace: ReplayTrace | null): ExportResult {
  if (trace === null) {
    return {
      kind: 'unavailable',
      note: `Replay recording is off on this page, so there is no replay to save. Reload with ${REPLAY_PARAM}=1 added to the address to record one.`,
    };
  }
  if (trace.ticks.length === 0) {
    return {
      kind: 'unavailable',
      note: 'Replay recording is on, but this world has not simulated a tick yet, so there is nothing to save. Start the round and press this again.',
    };
  }
  const check = checkTrace(trace);
  if (!check.ok) {
    return {
      kind: 'unavailable',
      note: `No replay was saved: this build could not reproduce it (${check.reason}).`,
    };
  }
  const ticks = trace.ticks.length;
  const fileName = `tanks-replay-seed${trace.meta.seed}-${fileSegment(trace.meta.arenaId)}-${ticks}ticks.json`;
  const truncated = trace.truncated
    ? ' Recording stopped at its tick limit, so the ticks after that are not in it.'
    : '';
  return {
    kind: 'file',
    fileName,
    type: 'application/json',
    text: `${JSON.stringify(trace)}\n`,
    note: `Saved ${fileName}: ${ticks} tick${ticks === 1 ? '' : 's'} of this world (seed ${trace.meta.seed}, ${trace.meta.arenaId}), from its first tick.${truncated}`,
  };
}
