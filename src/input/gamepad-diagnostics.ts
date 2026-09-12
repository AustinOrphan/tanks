import { readConnectedPads, type GamepadLike, type GetGamepads } from './gamepad';

/**
 * Controller compatibility self-test (issue #599): read EVERY browser-visible pad in full,
 * and render it as text a tester can paste into a compatibility report.
 *
 * Why this is not `createGamepadReader` and not `readDetectedPads`. The reader answers
 * "what is this one pad asking the game to do", through the standard-mapping indices
 * `gamepad.ts` pins -- which is precisely the assumption under test here, so a diagnostic
 * built on it could never show a pad whose layout those indices get wrong.
 * `readDetectedPads` answers "what is plugged in", which the assignment panel needs and
 * this does too, but it deliberately drops everything except the index and the name. This
 * module answers the third question: what does the browser actually report for each pad,
 * unmapped and uninterpreted -- `mapping`, every axis, every button -- so that a pad whose
 * behaviour surprises the game can be described without guessing.
 *
 * PURE, and no DOM: `getGamepads` is injected exactly as it is everywhere else in this
 * directory, so the standard and non-standard fixtures the issue asks for are plain
 * objects. `hud.ts` renders what this returns; `route-ui.ts` decides when to call it.
 *
 * READ-ONLY BY CONSTRUCTION. Nothing here writes to `assignment.ts`, to settings, or to
 * any store -- opening the self-test cannot change what a slot is bound to, because this
 * module has no reference to anything that could.
 */

/** One button's live state. `value` is the analog travel a trigger reports; a digital button reports 0 or 1. */
export interface PadButtonSample {
  readonly pressed: boolean;
  readonly value: number;
}

/**
 * One pad as the self-test shows it. Counts are not carried separately: `axes.length` and
 * `buttons.length` ARE the axis and button counts the issue asks to display, and a
 * separate field could disagree with the array beside it.
 */
export interface PadDiagnostic {
  readonly padIndex: number;
  /** The browser's own name, `''` when it reports none -- the same convention `DetectedPad` uses. */
  readonly id: string;
  /**
   * The Gamepad API's `mapping`, verbatim. `''` means the browser reported no mapping at
   * all, which is the same thing it means in the API and is NOT normalised to
   * `'standard'`: a pad the browser has not remapped is exactly the case this diagnostic
   * exists to make visible.
   */
  readonly mapping: string;
  readonly axes: readonly number[];
  readonly buttons: readonly PadButtonSample[];
}

/**
 * A button's analog travel, falling back to the pressed flag.
 *
 * The fallback is not cosmetic. `GamepadLike.value` is optional so that every fake written
 * before this module existed still type-checks, and a browser is free to report a button
 * object without one. Reading `undefined` as 0 would then draw a HELD button as untouched
 * -- the report would state the opposite of what the tester is doing -- so a pressed button
 * with no reported value reads as fully travelled.
 */
function sampleButton(button: { readonly pressed: boolean; readonly value?: number }): PadButtonSample {
  const pressed = button.pressed === true;
  return { pressed, value: button.value ?? (pressed ? 1 : 0) };
}

/**
 * Every currently-connected pad, in full.
 *
 * Shares `readConnectedPads`'s single tolerant walk with the assignment panel, so the two
 * surfaces can never disagree about which indices are occupied. The arrays are COPIED out
 * of the live `Gamepad` objects rather than referenced: in a real browser those objects
 * are re-read each frame and a retained reference is a snapshot of nothing in particular,
 * which is how a "live" readout silently stops updating.
 */
export function readPadDiagnostics(getGamepads: GetGamepads): PadDiagnostic[] {
  return readConnectedPads(getGamepads).map(({ padIndex, pad }) => diagnosePad(padIndex, pad));
}

function diagnosePad(padIndex: number, pad: GamepadLike): PadDiagnostic {
  const axes: number[] = [];
  for (let i = 0; i < pad.axes.length; i++) axes.push(pad.axes[i] ?? 0);
  const buttons: PadButtonSample[] = [];
  for (let i = 0; i < pad.buttons.length; i++) {
    const b = pad.buttons[i];
    buttons.push(b == null ? { pressed: false, value: 0 } : sampleButton(b));
  }
  return { padIndex, id: pad.id ?? '', mapping: pad.mapping ?? '', axes, buttons };
}

/** What the report states about the machine it was taken on, so a pasted report is attributable. */
export interface ReportContext {
  readonly userAgent: string;
  /** The page's own address, developer parameters included -- which build and flags were live. */
  readonly url: string;
}

/** Two decimals: enough to see drift and dead-zone travel, short enough that 17 buttons fit a line. */
function fixed(n: number): string {
  return Number.isFinite(n) ? n.toFixed(2) : '0.00';
}

/** `''` is what the browser reported, so the report says so rather than inventing a name. */
export function padLabel(pad: PadDiagnostic): string {
  return pad.id === '' ? `Controller ${pad.padIndex}` : pad.id;
}

/**
 * The copyable half of the acceptance criteria: one block of plain text carrying every
 * pad's full state AND the browser/machine context, so pasting it into an issue is the
 * whole of filing a compatibility report.
 *
 * Markdown, because that is what the issue tracker renders, and one fenced block per pad
 * so the numeric rows survive the paste without being re-wrapped.
 *
 * NOT an export format. Issue #247 owns the developer diagnostics summary and its export
 * model; this is deliberately the smallest thing that satisfies "can be copied into an
 * issue", so that #247 can absorb it rather than having to unpick a second format.
 */
export function formatPadReport(pads: readonly PadDiagnostic[], context: ReportContext): string {
  const lines: string[] = ['## Controller compatibility report', '', `- User agent: ${context.userAgent}`, `- Page: ${context.url}`, `- Pads visible: ${pads.length}`];
  if (pads.length === 0) {
    lines.push('', 'No gamepad is visible to this page. A pad must be connected AND actuated once before a browser reports it.');
    return lines.join('\n');
  }
  for (const pad of pads) {
    lines.push('', `### Index ${pad.padIndex} -- ${padLabel(pad)}`, '');
    lines.push(`- mapping: ${pad.mapping === '' ? '(none reported)' : pad.mapping}`);
    lines.push(`- axes: ${pad.axes.length}`);
    lines.push(`- buttons: ${pad.buttons.length}`);
    lines.push('', '```');
    lines.push(pad.axes.map((v, i) => `axis ${i}: ${fixed(v)}`).join('\n'));
    lines.push(
      pad.buttons.map((b, i) => `button ${i}: ${b.pressed ? 'down' : 'up  '} ${fixed(b.value)}`).join('\n'),
    );
    lines.push('```');
  }
  return lines.join('\n');
}
