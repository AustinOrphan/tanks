// @vitest-environment jsdom
//
// The gallery workbench pane's body (issue #730), driven with a recorder in place of the
// WebGL handle and a hand-pumped animation frame. What the handle itself guarantees -- the
// same frame however it is reached, no GL growth -- is workbench-scene.test.ts and the GL
// harness. What this file pins is that the pane asks for the right thing and cleans up.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { ACCENTS, PALETTE, SKINS, SPAWN_ANIMATIONS } from '../presentation/customization';
import type { GalleryCatalog } from './gallery-selection';
import {
  mountGalleryWorkbench,
  type GalleryWorkbenchDeps,
  type GalleryWorkbenchHandle,
  type GalleryWorkbenchSceneOptions,
} from './gallery-workbench';

const CATALOG: GalleryCatalog = {
  elements: ['mine', 'tank'],
  moments: ['fire', 'destroyed'],
  views: ['close', 'game', 'low'],
  mineWarnStyles: ['lance', 'slump'],
};

/** Timeline length per subject id; posed elements are static. */
const FRAMES: Record<string, number> = { fire: 20, destroyed: 60, mine: 1, tank: 1 };

interface Rig {
  deps: GalleryWorkbenchDeps;
  shown: GalleryWorkbenchSceneOptions[];
  seeks: number[];
  disposed: number;
  frames: () => { request: number; cancel: number; pump: () => void };
}

function rig(initial: string | null, withLink = true): Rig {
  const shown: GalleryWorkbenchSceneOptions[] = [];
  const seeks: number[] = [];
  let pendingCb: ((now: number) => void) | null = null;
  let requests = 0;
  let cancels = 0;
  const r: Rig = {
    shown,
    seeks,
    disposed: 0,
    frames: () => ({
      request: requests,
      cancel: cancels,
      pump: () => {
        const cb = pendingCb;
        pendingCb = null;
        cb?.(0);
      },
    }),
    deps: {
      catalog: CATALOG,
      initial,
      raf: {
        request(cb) {
          requests++;
          pendingCb = cb;
          return requests;
        },
        cancel() {
          cancels++;
          pendingCb = null;
        },
      },
      linkFor: withLink ? (value) => `/tanks/?dev=1&gallery=${value}` : undefined,
      create(_canvas, _w, _h, opts): GalleryWorkbenchHandle {
        let frames = FRAMES[opts.subject.id];
        let frame = 0;
        shown.push(opts);
        return {
          get frames() {
            return frames;
          },
          get frame() {
            return frame;
          },
          show(next) {
            shown.push(next);
            frames = FRAMES[next.subject.id];
            frame = 0;
          },
          seek(f) {
            seeks.push(f);
            frame = Math.min(Math.max(0, Math.floor(f)), frames - 1);
          },
          dispose() {
            r.disposed++;
          },
        };
      },
    },
  };
  return r;
}

let root: HTMLElement;
afterEach(() => {
  document.body.innerHTML = '';
});
function mount(r: Rig) {
  root = document.createElement('div');
  document.body.appendChild(root);
  return mountGalleryWorkbench(root, r.deps);
}
const q = <T extends HTMLElement>(sel: string): T => root.querySelector<T>(sel) as T;
const field = <T extends HTMLElement>(name: string): T => q<T>(`[data-field="${name}"]`);
const optionValues = (name: string): string[] =>
  [...field<HTMLSelectElement>(name).options].map((o) => o.value);
const change = (name: string, value: string | boolean): void => {
  const el = field<HTMLInputElement | HTMLSelectElement>(name);
  if (typeof value === 'boolean') (el as HTMLInputElement).checked = value;
  else el.value = value;
  el.dispatchEvent(new Event('change'));
};

describe('the gallery workbench offers what the registries hold (issue #730)', () => {
  it('fills every selector from the catalog and the paint-shop registries, with no ids of its own', () => {
    mount(rig(null));
    expect(optionValues('subject')).toEqual([
      ...CATALOG.moments.map((id) => `scene:${id}`),
      ...CATALOG.elements.map((id) => `elements:${id}`),
    ]);
    expect(optionValues('view')).toEqual(CATALOG.views);
    expect(optionValues('skin')).toEqual(SKINS.map((s) => s.id));
    expect(optionValues('hull')).toEqual(['', ...PALETTE.map((s) => s.id)]);
    expect(optionValues('accent')).toEqual(ACCENTS.map((a) => a.id));
    expect(optionValues('spawnAnim')).toEqual(SPAWN_ANIMATIONS.map((s) => s.id));
    expect(optionValues('mineWarn')).toEqual(['', ...CATALOG.mineWarnStyles]);
  });

  it('builds the scene with paint-shop ids resolved to the hexes the builders take', () => {
    const r = rig('scene:fire,hull:red,accent:gold');
    mount(r);
    expect(r.shown[0].hull).toBe(PALETTE.find((s) => s.id === 'red')?.hex);
    expect(r.shown[0].accent).toBe(ACCENTS.find((a) => a.id === 'gold')?.hex);
    change('hull', '');
    change('accent', 'auto');
    expect(r.shown.at(-1)?.hull).toBeNull();
    expect(r.shown.at(-1)?.accent).toBeNull();
  });
});

describe('the gallery workbench restores a link, and reports what it could not (issue #730)', () => {
  it('opens on the linked selection and frame, and writes the same link back', () => {
    const link = 'scene:destroyed,view:low,skin:camo,spawn-anim:rise,mineWarn:lance,age:24';
    const r = rig(link);
    const view = mount(r);
    expect(r.shown[0]).toMatchObject({
      subject: { kind: 'moment', id: 'destroyed' },
      view: 'low',
      skin: 'camo',
      spawnAnim: 'rise',
      mineWarn: 'lance',
    });
    expect(r.seeks).toEqual([24]);
    expect(field<HTMLSelectElement>('subject').value).toBe('scene:destroyed');
    expect(field<HTMLSelectElement>('view').value).toBe('low');
    expect(q<HTMLInputElement>('.hud-gallery-scrub').value).toBe('24');
    expect(view.problems).toEqual([]);
    expect(q<HTMLUListElement>('.hud-gallery-problems').hidden).toBe(true);
    expect(q<HTMLTextAreaElement>('.hud-gallery-link').value).toBe(`/tanks/?dev=1&gallery=${link}`);
  });

  it('lists every part it did not honour, on screen', () => {
    mount(rig('scene:destroyed,view:sideways,zoom:2,age:500'));
    const list = q<HTMLUListElement>('.hud-gallery-problems');
    expect(list.hidden).toBe(false);
    expect([...list.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      '"sideways" is not a registered view, so the default is shown.',
      '"zoom:2" is not a gallery setting, so it was ignored.',
      '"age:500" is past this subject\'s last frame, so frame 59 is shown.',
    ]);
  });

  it('clears the report once a control changes, because the pane no longer shows that link', () => {
    const view = mount(rig('view:sideways'));
    expect(view.problems).toHaveLength(1);
    change('view', 'close');
    expect(view.problems).toEqual([]);
    expect(q<HTMLUListElement>('.hud-gallery-problems').hidden).toBe(true);
  });

  it('hides Copy Link when no link can be written', () => {
    mount(rig(null, false));
    expect(q<HTMLElement>('.hud-gallery-linkrow').hidden).toBe(true);
  });
});

describe('the gallery workbench timeline (issue #730)', () => {
  it('a subject change shows the new subject from frame 0 and updates the link', () => {
    const r = rig('scene:fire,age:9');
    const view = mount(r);
    change('subject', 'elements:tank');
    expect(r.shown.at(-1)?.subject).toEqual({ kind: 'element', id: 'tank' });
    expect(view.selection.frame).toBe(0);
    expect(q<HTMLInputElement>('.hud-gallery-scrub').disabled).toBe(true);
    expect(q<HTMLTextAreaElement>('.hud-gallery-link').value).toBe('/tanks/?dev=1&gallery=elements:tank');
  });

  it('scrubbing seeks the handle to the chosen frame', () => {
    const r = rig('scene:fire');
    const view = mount(r);
    const scrub = q<HTMLInputElement>('.hud-gallery-scrub');
    scrub.value = '7';
    scrub.dispatchEvent(new Event('input'));
    expect(r.seeks.at(-1)).toBe(7);
    expect(view.selection.frame).toBe(7);
    expect(q<HTMLTextAreaElement>('.hud-gallery-link').value).toBe('/tanks/?dev=1&gallery=scene:fire,age:7');
  });

  it('plays one frame per animation frame and stops on the last one', () => {
    const r = rig('scene:fire,age:17');
    const view = mount(r);
    const play = q<HTMLButtonElement>('.hud-gallery-play');
    play.click();
    expect(play.textContent).toBe('Pause');
    r.frames().pump();
    expect(view.selection.frame).toBe(18);
    r.frames().pump();
    expect(view.selection.frame).toBe(19);
    r.frames().pump(); // at the last frame: stops rather than wrapping
    expect(view.selection.frame).toBe(19);
    expect(play.textContent).toBe('Play');
    const requested = r.frames().request;
    r.frames().pump();
    expect(r.frames().request).toBe(requested);
  });

  it('pausing cancels the pending frame', () => {
    const r = rig('scene:fire');
    mount(r);
    const play = q<HTMLButtonElement>('.hud-gallery-play');
    play.click();
    play.click();
    expect(r.frames().cancel).toBe(1);
  });
});

describe('the gallery workbench releases everything it holds (issue #730)', () => {
  it('adds no listener on scene changes, and removes every one on dispose', () => {
    const r = rig('scene:fire');
    const added = vi.spyOn(EventTarget.prototype, 'addEventListener');
    const view = mount(r);
    const atMount = added.mock.calls.length;
    for (let i = 0; i < 20; i++) {
      change('subject', i % 2 === 0 ? 'scene:destroyed' : 'elements:mine');
      change('view', i % 2 === 0 ? 'low' : 'game');
    }
    expect(added.mock.calls.length, 'listeners added by 40 scene changes').toBe(atMount);
    added.mockRestore();

    const detachedSubject = field<HTMLSelectElement>('subject');
    const detachedPlay = q<HTMLButtonElement>('.hud-gallery-play');
    const shownBefore = r.shown.length;
    view.dispose();
    detachedSubject.value = 'scene:fire';
    detachedSubject.dispatchEvent(new Event('change'));
    detachedPlay.click();
    expect(r.shown.length, 'a change after dispose reached the handle').toBe(shownBefore);
    expect(r.frames().request, 'a Play after dispose requested a frame').toBe(0);
  });

  it('disposes the handle once, cancels a playing frame, and empties the pane', () => {
    const r = rig('scene:fire');
    const view = mount(r);
    q<HTMLButtonElement>('.hud-gallery-play').click();
    view.dispose();
    view.dispose();
    expect(r.disposed).toBe(1);
    expect(r.frames().cancel).toBe(1);
    expect(root.childElementCount).toBe(0);
  });
});

describe('the gallery workbench offers the command line for its selection (issue #731)', () => {
  const command = (): string => q<HTMLTextAreaElement>('.hud-gallery-command').value;
  const recipe = (): HTMLElement => q('.hud-gallery-recipe');
  const anim = (): HTMLElement => q('.hud-gallery-anim');

  it('shows the gallery command for the selection, and rewrites it when a control changes', () => {
    mount(rig('scene:fire'));
    expect(command()).toBe('npm run gallery -- --scene fire --view game --skin solid --w 640 --h 400 --dpr 1');
    change('view', 'low');
    expect(command()).toContain('--view low');
  });

  it('follows the timeline: scrubbing writes the frame on screen as --age', () => {
    mount(rig('scene:fire'));
    const scrub = q<HTMLInputElement>('.hud-gallery-scrub');
    scrub.value = '7';
    scrub.dispatchEvent(new Event('input'));
    expect(command().endsWith('--age 7')).toBe(true);
  });

  it('names the registered capture recipe on an exact match, and not one frame away', () => {
    mount(rig('scene:fire,age:10'));
    expect(recipe().hidden).toBe(false);
    expect(recipe().textContent).toContain('gallery.fire.still');
    expect(recipe().textContent).toContain('npm run capture -- --recipe gallery.fire.still');
    document.body.innerHTML = '';

    mount(rig('scene:fire,age:11'));
    expect(recipe().hidden, 'frame 11 is not the recipe').toBe(true);
    expect(recipe().textContent).toBe('');
  });

  it('drops the recipe once a control moves the selection off it', () => {
    mount(rig('scene:fire,age:10'));
    change('view', 'low');
    expect(recipe().hidden).toBe(true);
  });

  it('offers the animated command only for a subject with more than one frame', () => {
    mount(rig('scene:fire'));
    expect(anim().hidden).toBe(false);
    expect(anim().textContent).toContain('--anim');
    change('subject', 'elements:mine');
    expect(anim().hidden, 'a static posed element has nothing to animate').toBe(true);
  });

  it('Download Still saves the canvas under a name carrying the frame, pixel size and DPR', () => {
    const r = rig('scene:fire,age:10');
    const saved: [HTMLCanvasElement, string][] = [];
    r.deps = { ...r.deps, saveStill: (canvas, name) => saved.push([canvas, name]) };
    mount(r);
    expect(q('.hud-gallery-stillrow').hidden).toBe(false);
    expect(q('.hud-gallery-still-size').textContent).toBe('640 x 400 px, device pixel ratio 1');
    q<HTMLButtonElement>('.hud-gallery-still').click();
    expect(saved).toEqual([[q<HTMLCanvasElement>('.hud-gallery-canvas'), 'gallery-fire-frame10-640x400@1x.png']]);
  });

  it('hides Download Still when nothing can save one', () => {
    mount(rig('scene:fire'));
    expect(q('.hud-gallery-stillrow').hidden).toBe(true);
  });
});
