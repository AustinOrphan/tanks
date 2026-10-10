/**
 * Issue #1055 evidence page: the REAL HUD's versus stock strip, cued.
 *
 * Mounted exactly as `tools/hud/strip-width-page.ts` (HEAD) mounts it -- `createHud` with the
 * stock-cue arm and the identity mark the page's HUD is handed with no flag set, then
 * `setState('playing')` and a versus `setStatus` -- and adds the two things that page cannot:
 * the resolved reduced-motion policy (`hud.setReducedMotion`, the stylesheet's only view of it)
 * and a second push that drops a stock, which is what arms a cue. Nothing here builds entry
 * markup or mirrors a layout rule.
 *
 * Copied unchanged into both scratch trees (before = the branch's merge base, after = HEAD),
 * at `tools/media-1055/`, so the same page drives both stylesheets.
 */
import { createHud, type GameplayStatus, type Hud, type VersusStock } from '../../src/game/hud';
import { stripIdentityMarker } from '../../src/game/identity-marker-flag';
import type { StockCue } from '../../src/presentation/stock-cue';

interface Box { x: number; y: number; width: number; height: number }

export interface CueReading {
  topbar: Box;
  strip: Box;
  /** Each entry's box, in strip order. */
  entries: Box[];
  /** The right edge of the topbar's content box. */
  edge: number;
  face: boolean;
  /** The first entry's pip classes and the animations running on the page. */
  pipClasses: string[];
  animations: { delay: number; name: string; target: string; pseudo: string | null }[];
  /** The first entry's cued pip (else its first pip), as computed right now. */
  pip: { borderTopWidth: string; opacity: string; transform: string } | null;
  html: string;
}

let hud: Hud | null = null;
const box = (r: DOMRect): Box => ({ x: r.x, y: r.y, width: r.width, height: r.height });

function status(stocks: VersusStock[]): GameplayStatus {
  return { kind: 'versus', mission: 1, missions: 1, stocks };
}

function read(): CueReading {
  const root = document.getElementById('app') as HTMLElement;
  const strip = root.querySelector('.hud-versus-stocks') as HTMLElement;
  const topbar = root.querySelector('.hud-topbar') as HTMLElement;
  const bar = topbar.getBoundingClientRect();
  const entries = Array.from(strip.querySelectorAll('.hud-versus-stock-entry'));
  // The cued pip when there is one (in a row it is a trailing `--lost` pip), else the first.
  const pipEl = entries[0]?.querySelector('.hud-stock-pip.hud-stock-cue')
    ?? entries[0]?.querySelector('.hud-stock-pip') ?? null;
  const cs = pipEl === null ? null : getComputedStyle(pipEl);
  const face = getComputedStyle(strip).fontFamily.startsWith('"IBM Plex Sans"')
    && Array.from(document.fonts)
      .some((f) => f.family.replace(/"/g, '') === 'IBM Plex Sans' && f.status === 'loaded');
  return {
    topbar: box(bar),
    strip: box(strip.getBoundingClientRect()),
    entries: entries.map((e) => box(e.getBoundingClientRect())),
    edge: bar.right - parseFloat(getComputedStyle(topbar).paddingRight),
    face,
    pipClasses: Array.from(entries[0]?.querySelectorAll('.hud-stock-pip') ?? [])
      .map((p) => p.className),
    animations: document.getAnimations().map((a) => {
      const effect = a.effect as KeyframeEffect | null;
      const target = effect?.target as Element | null | undefined;
      return {
        delay: Number(effect?.getTiming().delay ?? 0),
        name: (a as CSSAnimation).animationName ?? '',
        target: target?.className.toString() ?? '',
        pseudo: effect?.pseudoElement ?? null,
      };
    }),
    pip: cs === null ? null : {
      borderTopWidth: cs.borderTopWidth, opacity: cs.opacity, transform: cs.transform,
    },
    html: strip.innerHTML,
  };
}

/** A fresh HUD showing `stocks`, the way the strip-width page mounts one. */
async function mount(stockCue: StockCue, stocks: VersusStock[], reduced: boolean): Promise<CueReading> {
  hud?.dispose();
  const root = document.getElementById('app') as HTMLElement;
  root.replaceChildren();
  hud = createHud(root, { stockCue, identityMarker: stripIdentityMarker(null) });
  hud.setReducedMotion(reduced);
  hud.setState('playing');
  hud.setStatus(status(stocks));
  const strip = root.querySelector('.hud-versus-stocks') as HTMLElement;
  void strip.offsetWidth;
  await document.fonts.ready;
  return read();
}

/** Push a later status on the same HUD: a stock that went down arms that slot's cue. */
function push(stocks: VersusStock[]): CueReading {
  (hud as Hud).setStatus(status(stocks));
  return read();
}

const nextFrame = (): Promise<number> => new Promise((res) => requestAnimationFrame(res));

/**
 * Pause every running animation at `ms` into its run, so a mid-cue frame is deterministic, then
 * let two frames pass so the paint the screenshot takes is of the paused state.
 *
 * `ms` is measured from the cue's start, not the animation's: the HUD gives a cue element a
 * negative `animation-delay` for the time already spent since the loss (`-Math.round(now -
 * at)`), which is -1ms whenever the rebuild lands half a millisecond after the push. Setting
 * `currentTime = ms` alone would then show `ms + 1`, so the delay is added back.
 */
async function freeze(ms: number): Promise<CueReading> {
  for (const a of document.getAnimations()) {
    a.pause();
    a.currentTime = ms + Number(a.effect?.getTiming().delay ?? 0);
  }
  await nextFrame();
  await nextFrame();
  return read();
}

Object.assign(window as unknown as Record<string, unknown>, {
  mountStrip: mount, pushStrip: push, freezeStrip: freeze, readStrip: read, cueReady: true,
});
