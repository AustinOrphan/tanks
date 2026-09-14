import { ACCENTS, PALETTE, SKINS, SPAWN_ANIMATIONS } from '../presentation/customization';
import type { RafScheduler } from './driver';
import {
  captureCommand,
  galleryAnimArgs,
  galleryCommand,
  galleryCommandArgs,
  matchingCaptureStill,
  stillFileName,
  type GalleryCommandInput,
  type GalleryStillSize,
} from './gallery-command';
import {
  formatGallerySelection,
  parseGallerySelection,
  defaultGallerySelection,
  type GalleryCatalog,
  type GallerySelection,
} from './gallery-selection';

/**
 * The gallery workbench pane's body (issue #730): the selectors, the canvas, the timeline,
 * the problem list and the link.
 *
 * Its own module for the reason `devtools-menu.ts` and `controller-selftest.ts` are: `hud.ts`
 * owns the pane and the layer, and this owns what is inside it. It is mounted when the pane
 * opens and disposed when it closes, by `route-ui.ts`, which holds the handle the way it holds
 * the Customize preview's.
 *
 * NO WEBGL HERE. The scene handle is `render/gallery/workbench-scene.ts`'s `createWorkbench`,
 * injected as `deps.create`, because `game/` may not import the render registries or the
 * builders (dependency-direction.test.ts). The types below are structural twins of that
 * module's, so a jsdom test can drive this body with a recorder.
 *
 * EVERY LISTENER IS REGISTERED ON ONE ABORT SIGNAL, and structure is built once at mount. A
 * scene change writes into existing controls and adds no listener, and `dispose` removes
 * them all with one `abort()`. That is how "repeated scene changes leave no growth in
 * listeners" holds by construction, and `gallery-workbench.test.ts` counts it.
 */

/** A selection resolved for the renderer: paint-shop ids become the hexes the builders take. */
export interface GalleryWorkbenchSceneOptions {
  readonly subject: GallerySelection['subject'];
  readonly view: string;
  readonly skin: GallerySelection['skin'];
  readonly hull: string | null;
  readonly accent: string | null;
  readonly spawnAnim: GallerySelection['spawnAnim'];
  readonly mineWarn: string | null;
  readonly reach: boolean;
  readonly timer: boolean;
}

/** Structurally `render/gallery/workbench-scene.ts`'s `Workbench`. */
export interface GalleryWorkbenchHandle {
  readonly frames: number;
  readonly frame: number;
  show(opts: GalleryWorkbenchSceneOptions): void;
  seek(frame: number): void;
  dispose(): void;
}

export interface GalleryWorkbenchDeps {
  readonly catalog: GalleryCatalog;
  readonly create: (
    canvas: HTMLCanvasElement,
    w: number,
    h: number,
    opts: GalleryWorkbenchSceneOptions,
  ) => GalleryWorkbenchHandle;
  readonly raf: RafScheduler;
  /** The page's `?gallery=` value, or null to open on the defaults. */
  readonly initial: string | null;
  /** The full link for a selection value. Absent hides Copy Link: a HUD that cannot see the page cannot write one. */
  readonly linkFor?: (value: string) => string;
  /**
   * Saves the canvas's current frame as an image file of the given name (issue #731).
   * `createBrowserDeps` binds `downloadCanvasStill`. Absent hides Download Still, as an absent
   * `linkFor` hides Copy Link.
   */
  readonly saveStill?: (canvas: HTMLCanvasElement, fileName: string) => void;
}

export interface GalleryWorkbenchView {
  readonly selection: GallerySelection;
  readonly problems: readonly string[];
  dispose(): void;
}

/** The drawing buffer. Fixed, so a frame position is the same picture on every screen. */
export const GALLERY_CANVAS = { width: 640, height: 400 } as const;

/**
 * What a still of the canvas is: the drawing buffer's own pixels, which is the size at device
 * pixel ratio 1 (issue #731). The CSS scales the canvas to fit the pane, but a still and the
 * command both describe the buffer, so neither depends on the screen it was made on.
 */
export const GALLERY_STILL: GalleryStillSize = Object.freeze({
  width: GALLERY_CANVAS.width,
  height: GALLERY_CANVAS.height,
  dpr: 1,
});

/**
 * Saves `canvas`'s current pixels as a PNG named `fileName` (issue #731).
 *
 * The canvas is read in a later task than the draw. That returns the picture only because the
 * workbench's renderer is created with `preserveDrawingBuffer: true`
 * (`render/gallery/workbench-scene.ts`'s `createWorkbenchRenderer`). Without it the buffer is
 * cleared once the frame is presented, and this would save a blank image.
 */
export function downloadCanvasStill(canvas: HTMLCanvasElement, fileName: string): void {
  canvas.toBlob((blob) => {
    if (blob === null) return;
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }, 'image/png');
}

export function sceneOptionsFor(selection: GallerySelection): GalleryWorkbenchSceneOptions {
  return {
    subject: selection.subject,
    view: selection.view,
    skin: selection.skin,
    hull: selection.hull === null ? null : (PALETTE.find((s) => s.id === selection.hull)?.hex ?? null),
    accent: ACCENTS.find((a) => a.id === selection.accent)?.hex ?? null,
    spawnAnim: selection.spawnAnim,
    mineWarn: selection.mineWarn,
    reach: selection.reach,
    timer: selection.timer,
  };
}

export function mountGalleryWorkbench(container: HTMLElement, deps: GalleryWorkbenchDeps): GalleryWorkbenchView {
  const { catalog } = deps;
  const lifetime = new AbortController();
  const on = <K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    type: K,
    listener: (e: HTMLElementEventMap[K]) => void,
  ): void => target.addEventListener(type, listener, { signal: lifetime.signal });

  const parsed =
    deps.initial === null
      ? { selection: defaultGallerySelection(catalog), problems: [] as readonly string[] }
      : parseGallerySelection(deps.initial, catalog);
  let selection = parsed.selection;
  let problems: string[] = [...parsed.problems];

  // ---- structure, built once ----
  const problemList = document.createElement('ul');
  problemList.className = 'hud-gallery-problems';
  problemList.setAttribute('role', 'status');

  const form = document.createElement('div');
  form.className = 'hud-gallery-form';
  const select = (field: string, label: string, options: readonly (readonly [string, string])[]): HTMLSelectElement => {
    const wrap = document.createElement('label');
    wrap.className = 'hud-gallery-field';
    const name = document.createElement('span');
    name.textContent = label;
    const el = document.createElement('select');
    el.className = 'hud-gallery-select';
    el.dataset.field = field;
    for (const [value, text] of options) el.appendChild(new Option(text, value));
    wrap.append(name, el);
    form.appendChild(wrap);
    return el;
  };
  const checkbox = (field: string, label: string): HTMLInputElement => {
    const wrap = document.createElement('label');
    wrap.className = 'hud-gallery-field hud-gallery-field--check';
    const el = document.createElement('input');
    el.type = 'checkbox';
    el.dataset.field = field;
    const name = document.createElement('span');
    name.textContent = label;
    wrap.append(el, name);
    form.appendChild(wrap);
    return el;
  };

  const subjectSel = (() => {
    const wrap = document.createElement('label');
    wrap.className = 'hud-gallery-field';
    const name = document.createElement('span');
    name.textContent = 'Subject';
    const el = document.createElement('select');
    el.className = 'hud-gallery-select';
    el.dataset.field = 'subject';
    const group = (label: string, key: string, ids: readonly string[]): void => {
      const g = document.createElement('optgroup');
      g.label = label;
      for (const id of ids) g.appendChild(new Option(id, `${key}:${id}`));
      el.appendChild(g);
    };
    group('Moments', 'scene', catalog.moments);
    group('Posed elements', 'elements', catalog.elements);
    wrap.append(name, el);
    form.appendChild(wrap);
    return el;
  })();
  const viewSel = select('view', 'View', catalog.views.map((v) => [v, v] as const));
  const skinSel = select('skin', 'Skin', SKINS.map((s) => [s.id, s.label] as const));
  const hullSel = select('hull', 'Hull', [['', 'Roster colour'], ...PALETTE.map((s) => [s.id, s.label] as const)]);
  const accentSel = select('accent', 'Accent', ACCENTS.map((a) => [a.id, a.label] as const));
  const spawnSel = select('spawnAnim', 'Spawn animation', SPAWN_ANIMATIONS.map((s) => [s.id, s.label] as const));
  const mineWarnSel = select('mineWarn', 'Mine warning', [['', 'Shipped'], ...catalog.mineWarnStyles.map((s) => [s, s] as const)]);
  const reachBox = checkbox('reach', 'Mine reach overlay');
  const timerBox = checkbox('timer', 'Mine timer overlay');

  const canvas = document.createElement('canvas');
  canvas.className = 'hud-gallery-canvas';
  canvas.width = GALLERY_CANVAS.width;
  canvas.height = GALLERY_CANVAS.height;

  const timeline = document.createElement('div');
  timeline.className = 'hud-gallery-timeline';
  const playBtn = document.createElement('button');
  playBtn.type = 'button';
  playBtn.className = 'ui-btn hud-gallery-play';
  const scrub = document.createElement('input');
  scrub.type = 'range';
  scrub.className = 'hud-gallery-scrub';
  scrub.min = '0';
  scrub.step = '1';
  scrub.setAttribute('aria-label', 'Timeline frame');
  const frameOut = document.createElement('output');
  frameOut.className = 'hud-gallery-frame';
  timeline.append(playBtn, scrub, frameOut);

  const linkRow = document.createElement('div');
  linkRow.className = 'hud-gallery-linkrow';
  const linkField = document.createElement('textarea');
  linkField.className = 'hud-gallery-link';
  linkField.readOnly = true;
  linkField.rows = 2;
  linkField.setAttribute('aria-label', 'Workbench link');
  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'ui-btn hud-gallery-copy';
  copyBtn.textContent = 'Copy Link';
  linkRow.append(linkField, copyBtn);
  linkRow.hidden = deps.linkFor === undefined;

  // The same selection from the command line (issue #731): the gallery command, the registered
  // capture recipe when one captures exactly this, and the animated form the browser does not
  // assemble. Then a still of the frame on screen, at the size it states.
  const commandRow = document.createElement('div');
  commandRow.className = 'hud-gallery-commandrow';
  const commandField = document.createElement('textarea');
  commandField.className = 'hud-gallery-command';
  commandField.readOnly = true;
  commandField.rows = 2;
  commandField.setAttribute('aria-label', 'Gallery command');
  const copyCommandBtn = document.createElement('button');
  copyCommandBtn.type = 'button';
  copyCommandBtn.className = 'ui-btn hud-gallery-copy-command';
  copyCommandBtn.textContent = 'Copy Command';
  commandRow.append(commandField, copyCommandBtn);
  const recipeLine = document.createElement('p');
  recipeLine.className = 'hud-gallery-note hud-gallery-recipe';
  const animLine = document.createElement('p');
  animLine.className = 'hud-gallery-note hud-gallery-anim';
  const stillRow = document.createElement('div');
  stillRow.className = 'hud-gallery-stillrow';
  const stillBtn = document.createElement('button');
  stillBtn.type = 'button';
  stillBtn.className = 'ui-btn hud-gallery-still';
  stillBtn.textContent = 'Download Still';
  const stillSize = document.createElement('span');
  stillSize.className = 'hud-gallery-still-size';
  stillSize.textContent = `${GALLERY_STILL.width} x ${GALLERY_STILL.height} px, device pixel ratio ${GALLERY_STILL.dpr}`;
  stillRow.append(stillBtn, stillSize);
  stillRow.hidden = deps.saveStill === undefined;

  container.replaceChildren(problemList, form, canvas, timeline, linkRow, commandRow, recipeLine, animLine, stillRow);

  // ---- the scene ----
  const handle = deps.create(canvas, canvas.width, canvas.height, sceneOptionsFor(selection));
  handle.seek(selection.frame);
  if (handle.frame !== selection.frame) {
    problems.push(
      `"age:${selection.frame}" is past this subject's last frame, so frame ${handle.frame} is shown.`,
    );
  }
  selection = { ...selection, frame: handle.frame };

  // ---- painting ----
  const paintProblems = (): void => {
    problemList.replaceChildren(
      ...problems.map((p) => {
        const li = document.createElement('li');
        li.textContent = p;
        return li;
      }),
    );
    problemList.hidden = problems.length === 0;
  };
  const paintForm = (): void => {
    subjectSel.value = `${selection.subject.kind === 'moment' ? 'scene' : 'elements'}:${selection.subject.id}`;
    viewSel.value = selection.view;
    skinSel.value = selection.skin;
    hullSel.value = selection.hull ?? '';
    accentSel.value = selection.accent;
    spawnSel.value = selection.spawnAnim;
    mineWarnSel.value = selection.mineWarn ?? '';
    reachBox.checked = selection.reach;
    timerBox.checked = selection.timer;
    // A moment scene draws neither overlay (render/gallery/workbench-scene.ts), so the boxes
    // are shown disabled there rather than offering a setting that changes nothing.
    const posed = selection.subject.kind === 'element';
    reachBox.disabled = !posed;
    timerBox.disabled = !posed;
  };
  const paintTimeline = (): void => {
    const last = handle.frames - 1;
    scrub.max = String(last);
    scrub.value = String(handle.frame);
    scrub.disabled = last === 0;
    playBtn.disabled = last === 0;
    frameOut.textContent = `Frame ${handle.frame} of ${last}`;
  };
  const paintLink = (): void => {
    if (deps.linkFor !== undefined) linkField.value = deps.linkFor(formatGallerySelection(selection, catalog));
  };
  const commandInput = (): GalleryCommandInput => ({ ...sceneOptionsFor(selection), frame: selection.frame });
  const paintCommand = (): void => {
    const input = commandInput();
    commandField.value = galleryCommand(galleryCommandArgs(input, GALLERY_STILL));
    const still = matchingCaptureStill(input);
    recipeLine.hidden = still === null;
    recipeLine.textContent =
      still === null
        ? ''
        : `Registered capture recipe ${still.id}, captured at ${still.viewport.width} x ${still.viewport.height} px: ${captureCommand(still.id)}`;
    const animated = handle.frames > 1;
    animLine.hidden = !animated;
    animLine.textContent = animated
      ? `As an animated GIF, which only the command line assembles: ${galleryCommand(galleryAnimArgs(input, GALLERY_STILL))}`
      : '';
  };

  // ---- playback: one timeline frame per animation frame, stopping at the last ----
  let playing = false;
  let pending: number | null = null;
  const paintPlay = (): void => {
    playBtn.textContent = playing ? 'Pause' : 'Play';
    playBtn.setAttribute('aria-pressed', String(playing));
  };
  const afterSeek = (): void => {
    selection = { ...selection, frame: handle.frame };
    paintTimeline();
    paintLink();
    paintCommand();
  };
  const setPlaying = (next: boolean): void => {
    playing = next;
    if (!next && pending !== null) {
      deps.raf.cancel(pending);
      pending = null;
    }
    if (next && pending === null) {
      if (handle.frame >= handle.frames - 1) {
        handle.seek(0);
        afterSeek();
      }
      pending = deps.raf.request(advance);
    }
    paintPlay();
  };
  function advance(): void {
    pending = null;
    if (!playing) return;
    if (handle.frame >= handle.frames - 1) {
      setPlaying(false);
      return;
    }
    handle.seek(handle.frame + 1);
    afterSeek();
    pending = deps.raf.request(advance);
  }

  // ---- input ----
  const readForm = (): GallerySelection => {
    const [key, ...rest] = subjectSel.value.split(':');
    const hull = hullSel.value;
    return {
      subject: { kind: key === 'scene' ? 'moment' : 'element', id: rest.join(':') },
      view: viewSel.value,
      skin: skinSel.value as GallerySelection['skin'],
      hull: hull === '' ? null : (hull as NonNullable<GallerySelection['hull']>),
      accent: accentSel.value as GallerySelection['accent'],
      spawnAnim: spawnSel.value as GallerySelection['spawnAnim'],
      mineWarn: mineWarnSel.value === '' ? null : mineWarnSel.value,
      reach: reachBox.checked,
      timer: timerBox.checked,
      frame: 0,
    };
  };
  const onFormChange = (): void => {
    setPlaying(false);
    selection = readForm();
    // The problems described the link the pane opened on. Once a control is changed the pane
    // no longer shows that link, so a report about it would describe something not on screen.
    problems = [];
    handle.show(sceneOptionsFor(selection));
    paintForm();
    paintProblems();
    afterSeek();
  };
  for (const control of [subjectSel, viewSel, skinSel, hullSel, accentSel, spawnSel, mineWarnSel, reachBox, timerBox]) {
    on(control, 'change', onFormChange);
  }
  on(scrub, 'input', () => {
    setPlaying(false);
    handle.seek(Number(scrub.value));
    afterSeek();
  });
  on(playBtn, 'click', () => setPlaying(!playing));
  // Fills and selects the field first, so the link can be copied by keyboard where the async
  // Clipboard API is unavailable -- the same arrangement the controller self-test's Copy uses.
  on(copyBtn, 'click', () => {
    linkField.focus();
    linkField.select();
    globalThis.navigator?.clipboard?.writeText(linkField.value).catch(() => undefined);
  });
  on(copyCommandBtn, 'click', () => {
    commandField.focus();
    commandField.select();
    globalThis.navigator?.clipboard?.writeText(commandField.value).catch(() => undefined);
  });
  on(stillBtn, 'click', () => {
    deps.saveStill?.(canvas, stillFileName(commandInput(), GALLERY_STILL));
  });

  paintForm();
  paintProblems();
  paintPlay();
  paintTimeline();
  paintLink();
  paintCommand();

  let disposed = false;
  return {
    get selection(): GallerySelection {
      return selection;
    },
    get problems(): readonly string[] {
      return problems;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      setPlaying(false);
      lifetime.abort();
      handle.dispose();
      container.replaceChildren();
    },
  };
}
