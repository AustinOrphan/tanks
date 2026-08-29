import { buildGallery } from './subjects';
import { buildMomentScene } from './moment-scene';
import { MOMENTS } from './moments';
import type { SkinId, SpawnAnimId } from '../../src/game/customization';
import { DEFAULT_SPAWN_ANIM } from '../../src/game/customization';

const params = new URLSearchParams(location.search);
const W = Number(params.get('w') ?? 640);
const H = Number(params.get('h') ?? 480);

const canvas = document.createElement('canvas');
canvas.style.width = `${W}px`;
canvas.style.height = `${H}px`;
document.body.appendChild(canvas);

// Validated in args.mjs before it ever reaches the URL; unvalidated here on purpose, so
// hand-typing ?skin=flow (or ?scene=fire, ?spawn-anim=rise) into the dev server works the
// same way ?elements= always has.
const skin = (params.get('skin') ?? 'solid') as SkinId;
const hull = params.get('hull');
const accent = params.get('accent');
const spawnAnimParam = params.get('spawn-anim') as SpawnAnimId | null;
const mineWarnParam = params.get('mineWarn') as import('../../src/render/mine-warning').MineWarnStyle | null;

// `scene` selects one of MOMENTS's scripted timelines over the default posed gallery.
// Looking the id up directly in MOMENTS (rather than checking against a hardcoded list)
// means the default 'gallery', 'game' (never actually reaches this page -- run.mjs's
// captureGame branches before building this URL), and any other non-moment string all
// fall through to buildGallery unchanged, same "unvalidated here on purpose" convention
// as skin above.
const sceneParam = params.get('scene') ?? 'gallery';
const moment = MOMENTS[sceneParam];

const g = moment
  ? buildMomentScene(canvas, W, H, {
      moment: sceneParam,
      view: params.get('view') ?? 'game',
      skin,
      hull,
      accent,
      // Required (not optional) for a moment scene -- see moment-scene.ts's field doc.
      // Falls back to the same DEFAULT_SPAWN_ANIM the CLI itself defaults to, so an
      // omitted ?spawn-anim= (the common case: run.mjs only emits it when non-default)
      // reads the same as an un-decorated --scene <moment> invocation.
      spawnAnim: spawnAnimParam ?? DEFAULT_SPAWN_ANIM,
      mineWarn: mineWarnParam,
    })
  : buildGallery(canvas, W, H, {
      elements: (params.get('elements') ?? 'mine').split(',').map((x) => x.trim()).filter(Boolean),
      view: params.get('view') ?? 'game',
      reach: params.has('reach'),
      timer: params.has('timer'),
      fill: params.has('fill'),
      skin,
      hull,
      accent,
      // Optional here: buildGallery only reaches setPlayerStyle when something is
      // actually being styled (subjects.ts's widened guard), and leaving this undefined
      // when ?spawn-anim= is absent is what keeps a plain gallery invocation from firing
      // setPlayerStyle at all.
      spawnAnim: spawnAnimParam ?? undefined,
      frames: params.has('frames') ? Number(params.get('frames')) : null,
    });

// The runner calls this per frame and screenshots between calls, so no pixels ever cross
// the CDP bridge -- returning frames as arrays ran node out of memory on a 4GB box.
type W2 = typeof window & {
  GALLERY_DRAW: (a: number, al: number) => void;
  GALLERY_FRAMES: number;
  GALLERY_READY: boolean;
  GALLERY_REPORT: unknown | null;
};
(window as W2).GALLERY_DRAW = (age, alpha) => g.draw(age, alpha);
(window as W2).GALLERY_FRAMES = g.frames;
(window as W2).GALLERY_REPORT = 'captureReport' in g ? g.captureReport : null;
g.draw(Number(params.get('age') ?? 0), Number(params.get('alpha') ?? 0));
(window as W2).GALLERY_READY = true;
