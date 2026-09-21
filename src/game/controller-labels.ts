import type { SlotSource } from '../input/assignment';
import type { DetectedPad } from '../input/gamepad';

/**
 * The words the assignment panel and the versus setup pane put on a controller (issue #556).
 *
 * WHY THESE LEFT `hud.ts`. They are copy, and copy is the one thing in that file with no
 * reason to be inside a closure: every one of them is a pure function of a slot source and the
 * live pad list. Inside `createHud` they read `currentDetectedPads` from scope, which made
 * them reachable only by rendering a panel and reading the DOM back -- so the strings a player
 * actually sees had no direct test, and a wrong one could only be caught by someone looking at
 * a screenshot.
 *
 * `pads` is threaded as a PARAMETER rather than captured. That is the whole change: the caller
 * already holds the live list, and passing it is what turns five closure members into five
 * functions with inputs and outputs. It is also the only closure binding this group touched --
 * measured, not assumed: `currentDetectedPads` was read at three points and nothing else in
 * the cluster reached outside itself.
 */

/** The suffix both a refused candidate and a slot's current source carry (issue #597). */
export const NOT_SUPPORTED = ' — not supported';

/**
 * The full label for a slot's CURRENT source.
 *
 * A gamepad is named from the live list rather than from a cached name, so a pad that was
 * renamed or replaced reads as what is plugged in now. Falling back to `Controller N` keeps a
 * pad the browser declines to name from rendering as an empty string.
 */
export function slotSourceLabel(source: SlotSource, pads: readonly DetectedPad[]): string {
  switch (source.kind) {
    case 'keyboard':
      return 'Keyboard / Mouse / Touch';
    case 'bot':
      return 'Bot';
    case 'none':
      return 'Unassigned';
    case 'gamepad': {
      const live = pads.find((p) => p.padIndex === source.padIndex);
      const name = live && live.id.length > 0 ? live.id : `Controller ${source.padIndex}`;
      return `${name} (index ${source.padIndex})`;
    }
  }
}

/**
 * The short label a CANDIDATE button carries -- `slotSourceLabel` minus the "Keyboard / Mouse
 * / Touch" and "Unassigned" prose, which read fine as a current-state summary but not as a
 * button someone is about to click.
 */
export function candidateLabel(source: SlotSource, pads: readonly DetectedPad[]): string {
  switch (source.kind) {
    case 'keyboard':
      return 'Keyboard';
    case 'bot':
      return 'Bot';
    case 'none':
      return 'None';
    case 'gamepad':
      return slotSourceLabel(source, pads);
  }
}

/** Whether the live list holds `padIndex` as a pad Tanks will not read. */
export function unsupportedPad(padIndex: number, pads: readonly DetectedPad[]): boolean {
  return pads.some((p) => p.padIndex === padIndex && p.unsupported !== undefined);
}

/**
 * One pad's reason, in the player's words (issue #597). `gamepad-diagnostics.ts`'s
 * `describeSupport` is the DEVELOPER line for the same verdict and says so; this is the
 * sentence the issue assigns to the assignment panel, keyed off the structured code so the
 * input layer stays free of copy.
 */
export function unsupportedSentence(pad: DetectedPad, pads: readonly DetectedPad[]): string {
  const name = slotSourceLabel({ kind: 'gamepad', padIndex: pad.padIndex }, pads);
  const why =
    pad.unsupported?.code === 'insufficient-controls'
      ? 'it has too few buttons or sticks for Tanks.'
      : "Tanks can't read its buttons in this browser.";
  return `${name} isn't supported: ${why}`;
}
