/**
 * The page `node tools/hud/strip-width.mjs` measures (issue #1055): the REAL HUD, mounted by
 * `createHud` with the stylesheet and bundled face it ships with, showing one versus stock strip
 * at a time. Nothing here builds entry markup or mirrors a layout rule -- the HUD applies
 * `narrowPipLayout` and `narrowMarkLayout` itself, under the real `NARROW_STRIP_QUERY` -- so what
 * is measured is what a player's page draws.
 *
 * Named apart from the runner on purpose: Vite resolves `./strip-width` to the `.mjs` before a
 * `.ts`, so a page module sharing the runner's name would load Node code into the browser.
 */
import { createHud, type GameplayStatus, type Hud, type VersusStock } from '../../src/game/hud';
import { stripIdentityMarker } from '../../src/game/identity-marker-flag';
import type { StockCue } from '../../src/presentation/stock-cue';

export interface StripReading {
  /** The strip's right edge, px from the viewport's left. */
  right: number;
  width: number;
  /** The right edge of the topbar's content box: the strip fits if it ends at or before this. */
  edge: number;
  /** What the HUD drew for the first entry, read from layout: `9/2` is a 9px unit with a 2px gap. */
  layout: string;
  /** Each entry's text, which is the label plus any digit a fallback adds. */
  labels: string[];
  /** The strip's markup, so the runner can compare two arms that should draw the same thing. */
  html: string;
  /** Whether the shipped face had loaded when the strip was measured. */
  face: boolean;
}

let hud: Hud | null = null;

const round = (n: number): number => Math.round(n * 10) / 10;

/** The unit size and gap of the first entry's pips or marks, plus `+n` when a count is drawn. */
function describe(entry: Element): string {
  const unit = entry.querySelector('.hud-stock-pip, .hud-stock-mark');
  const row = entry.querySelector('.hud-stock-pips, .hud-stock-marks');
  if (unit === null || row === null) return 'digit';
  const size = round(unit.getBoundingClientRect().width);
  const counted = entry.querySelector('.hud-stock-pip-count, .hud-stock-mark-count') !== null;
  if (counted) return `${size}+n`;
  return `${size}/${round(parseFloat(getComputedStyle(row).columnGap))}`;
}

async function measureStrip(stockCue: StockCue, stocks: VersusStock[]): Promise<StripReading> {
  hud?.dispose();
  const root = document.getElementById('app') as HTMLElement;
  root.replaceChildren();
  // The identity mark the page's HUD is handed with no flag set: the shipped FFA mark, which the
  // HUD draws ahead of each FFA entry (and of no teams entry) unless the `marks` arm runs.
  hud = createHud(root, { stockCue, identityMarker: stripIdentityMarker(null) });
  hud.setState('playing');
  const status: GameplayStatus = { kind: 'versus', mission: 1, missions: 1, stocks };
  hud.setStatus(status);
  const strip = root.querySelector('.hud-versus-stocks') as HTMLElement;
  // A face is fetched when laid-out text first asks for it, so lay out, then wait for the load.
  void strip.offsetWidth;
  await document.fonts.ready;
  const face = document.fonts.check(`${getComputedStyle(strip).fontSize} "IBM Plex Sans"`);
  const topbar = root.querySelector('.hud-topbar') as HTMLElement;
  const bar = topbar.getBoundingClientRect();
  const rect = strip.getBoundingClientRect();
  const entries = Array.from(strip.querySelectorAll('.hud-versus-stock-entry'));
  return {
    right: round(rect.right),
    width: round(rect.width),
    edge: round(bar.right - parseFloat(getComputedStyle(topbar).paddingRight)),
    layout: entries.length > 0 ? describe(entries[0]) : 'none',
    labels: entries.map((e) => e.textContent ?? ''),
    html: strip.innerHTML,
    face,
  };
}

(window as unknown as { measureStrip: typeof measureStrip }).measureStrip = measureStrip;
(window as unknown as { stripReady: boolean }).stripReady = true;
