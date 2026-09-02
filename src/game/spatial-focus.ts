/**
 * Spatial focus movement (issue #495): the four directional `UiAction`s land on the
 * control that is geometrically nearest in that direction, so navigation follows what
 * the player SEES -- a row of segmented options walks Left/Right, a stack of rows walks
 * Up/Down, and a row that wraps at a narrow viewport behaves as the grid it has become.
 *
 * Pure over rectangles, not elements: the HUD measures its controls and hands the rects
 * in, so this is testable with a hand-drawn layout and jsdom's zero rects never decide
 * anything here. Logical DOM order is untouched -- Tab and assistive technology still
 * read the markup; only the arrows and the D-pad consult geometry.
 *
 * Rows are derived at navigation time by vertical overlap: a control whose vertical
 * centre falls inside the row being built joins it, anything else starts a new row, and
 * each row is ordered by its left edge. No CSS class names a row, so a pane that wraps
 * differently at another width needs no change here.
 *
 * Every move lands somewhere ("no dead ends"): Left/Right wrap within the row, Up/Down
 * wrap from the first row to the last and back, and with nothing focused a forward move
 * (Down/Right) lands on the first control and a backward move (Up/Left) on the last --
 * the same two entry points `hud.ts`'s one-dimensional walk had.
 *
 * DEGENERATE GEOMETRY -- every rect empty, which is what jsdom reports and what a hidden
 * subtree would -- collapses to one row of coincident rects. Rather than spin on a
 * single row, Up/Down then walk the list in document order, exactly the pre-#495 cycle,
 * so the keyboard walk that closes over every control keeps closing where there is no
 * layout to follow.
 */
import type { UiAction } from '../input/ui-actions';

export type Direction = Extract<UiAction, 'up' | 'down' | 'left' | 'right'>;

export function isDirection(action: UiAction): action is Direction {
  return action === 'up' || action === 'down' || action === 'left' || action === 'right';
}

/** The slice of `DOMRect` this needs; `DOMRect` itself satisfies it. */
export interface Rect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface Candidate<T> {
  readonly item: T;
  readonly rect: Rect;
}

const centreX = (r: Rect): number => r.left + r.width / 2;
const centreY = (r: Rect): number => r.top + r.height / 2;

/**
 * Group candidates into visual rows, top to bottom, each ordered left to right. Input
 * order breaks every tie (equal tops, equal lefts), which is what makes the degenerate
 * all-zero layout come out in document order.
 */
export function rowsOf<T>(candidates: readonly Candidate<T>[]): Candidate<T>[][] {
  const byTop = candidates
    .map((c, i) => ({ c, i }))
    .sort((a, b) => a.c.rect.top - b.c.rect.top || a.i - b.i);
  const rows: { top: number; bottom: number; members: { c: Candidate<T>; i: number }[] }[] = [];
  for (const entry of byTop) {
    const r = entry.c.rect;
    const row = rows[rows.length - 1];
    if (row && centreY(r) >= row.top && centreY(r) <= row.bottom) {
      row.members.push(entry);
      row.top = Math.min(row.top, r.top);
      row.bottom = Math.max(row.bottom, r.top + r.height);
    } else {
      rows.push({ top: r.top, bottom: r.top + r.height, members: [entry] });
    }
  }
  return rows.map((row) =>
    row.members.sort((a, b) => a.c.rect.left - b.c.rect.left || a.i - b.i).map((m) => m.c),
  );
}

/**
 * The candidate a move in `direction` lands on, or null only when there are no
 * candidates at all. `from` is the currently focused item, or null / an item not in the
 * list when focus sits on a container or something the sweep does not track.
 */
export function spatialNext<T>(
  candidates: readonly Candidate<T>[],
  from: T | null,
  direction: Direction,
): T | null {
  if (candidates.length === 0) return null;
  const forward = direction === 'down' || direction === 'right';
  const rows = rowsOf(candidates);
  let rowIdx = -1;
  let colIdx = -1;
  for (let r = 0; r < rows.length && rowIdx < 0; r++) {
    const c = rows[r].findIndex((cand) => cand.item === from);
    if (c >= 0) {
      rowIdx = r;
      colIdx = c;
    }
  }
  if (rowIdx < 0) {
    // Nothing tracked has focus: enter at the first or last control, as the 1-D walk did.
    return forward ? candidates[0].item : candidates[candidates.length - 1].item;
  }
  const row = rows[rowIdx];
  if (direction === 'left' || direction === 'right') {
    const step = direction === 'right' ? 1 : -1;
    return row[(colIdx + step + row.length) % row.length].item;
  }
  if (rows.length === 1) {
    // Degenerate or genuinely single-row layout: Up/Down walk document order so the
    // cycle still closes over every control (see the module comment).
    const ordered = candidates;
    const at = ordered.findIndex((cand) => cand.item === from);
    return ordered[(at + (forward ? 1 : -1) + ordered.length) % ordered.length].item;
  }
  const target = rows[(rowIdx + (forward ? 1 : -1) + rows.length) % rows.length];
  const x = centreX(row[colIdx].rect);
  let best = target[0];
  let bestDist = Math.abs(centreX(best.rect) - x);
  for (const cand of target) {
    const d = Math.abs(centreX(cand.rect) - x);
    if (d < bestDist) {
      best = cand;
      bestDist = d;
    }
  }
  return best.item;
}
