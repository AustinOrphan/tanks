import { buildGallery } from './subjects';
import type { SkinId } from '../../src/game/customization';

const params = new URLSearchParams(location.search);
const W = Number(params.get('w') ?? 640);
const H = Number(params.get('h') ?? 480);

const canvas = document.createElement('canvas');
canvas.style.width = `${W}px`;
canvas.style.height = `${H}px`;
document.body.appendChild(canvas);

const g = buildGallery(canvas, W, H, {
  elements: (params.get('elements') ?? 'mine').split(',').map((x) => x.trim()).filter(Boolean),
  view: params.get('view') ?? 'game',
  reach: params.has('reach'),
  timer: params.has('timer'),
  fill: params.has('fill'),
  // Validated in args.mjs before it ever reaches the URL; unvalidated here on purpose,
  // so hand-typing ?skin=flow into the dev server works the same way ?elements= does.
  skin: (params.get('skin') ?? 'solid') as SkinId,
  hull: params.get('hull'),
  accent: params.get('accent'),
  frames: params.has('frames') ? Number(params.get('frames')) : null,
});

// The runner calls this per frame and screenshots between calls, so no pixels ever cross
// the CDP bridge -- returning frames as arrays ran node out of memory on a 4GB box.
type W2 = typeof window & { GALLERY_DRAW: (a: number, al: number) => void; GALLERY_FRAMES: number; GALLERY_READY: boolean };
(window as W2).GALLERY_DRAW = (age, alpha) => g.draw(age, alpha);
(window as W2).GALLERY_FRAMES = g.frames;
g.draw(Number(params.get('age') ?? 0), Number(params.get('alpha') ?? 0));
(window as W2).GALLERY_READY = true;
