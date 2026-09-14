/**
 * The terminal commands that reproduce a gallery workbench selection (issue #731).
 *
 * The workbench draws in the browser. `npm run gallery` and `npm run capture` draw the same
 * subject from the command line, through the same two builders
 * (`render/gallery/workbench-scene.ts`'s `buildWorkbenchSubject` names them). This module turns
 * what the pane shows into those commands, as plain strings, so the pane can offer them.
 *
 * WHERE THE PROOF LIVES. `src/` may not import `tools/` (dependency-direction.test.ts), so nothing
 * here can call the gallery runner's own parser. `tools/gallery/command-roundtrip.test.ts` does:
 * it parses every command this module writes with `tools/gallery/args.mjs`'s `parseArgs`, and
 * pins `GALLERY_CAPTURE_STILLS` against `tools/capture/recipes.json`.
 */
import { DEFAULT_SPAWN_ANIM } from '../presentation/customization';

/**
 * A selection as the builders take it: paint-shop ids already resolved to hexes, the way
 * `gallery-workbench.ts`'s `sceneOptionsFor` resolves them, plus the frame on screen.
 */
export interface GalleryCommandInput {
  readonly subject: { readonly kind: 'element' | 'moment'; readonly id: string };
  readonly view: string;
  readonly skin: string;
  /** Hull hex, or null for the roster colour. */
  readonly hull: string | null;
  /** Accent hex, or null for the hull-derived tone. */
  readonly accent: string | null;
  readonly spawnAnim: string;
  readonly mineWarn: string | null;
  readonly reach: boolean;
  readonly timer: boolean;
  readonly frame: number;
}

/** A still's drawing-buffer size and the device pixel ratio the command states for it. */
export interface GalleryStillSize {
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
}

/** The `npm run gallery --` arguments that draw `input` as a still of `size`. */
export function galleryCommandArgs(input: GalleryCommandInput, size: GalleryStillSize): string[] {
  const args =
    input.subject.kind === 'moment' ? ['--scene', input.subject.id] : ['--elements', input.subject.id];
  args.push('--view', input.view, '--skin', input.skin);
  // Only when it is not the default. For a posed element the capture page styles the player
  // tank only when `?spawn-anim=` is present (tools/gallery/main.ts), so writing the default
  // would draw a different tank than the workbench shows. For a moment both forms draw the same.
  if (input.spawnAnim !== DEFAULT_SPAWN_ANIM) args.push('--spawn-anim', input.spawnAnim);
  if (input.hull !== null) args.push('--hull', input.hull);
  if (input.accent !== null) args.push('--accent', input.accent);
  if (input.mineWarn !== null) args.push('--mineWarn', input.mineWarn);
  // A moment scene draws neither mine overlay, so a moment's command carries neither flag.
  if (input.subject.kind === 'element') {
    if (input.reach) args.push('--reach');
    if (input.timer) args.push('--timer');
  }
  args.push('--w', String(size.width), '--h', String(size.height), '--dpr', String(size.dpr));
  if (input.frame > 0) args.push('--age', String(input.frame));
  return args;
}

/** The same subject as an animated GIF from frame 0, which only the command line assembles. */
export function galleryAnimArgs(input: GalleryCommandInput, size: GalleryStillSize): string[] {
  return [...galleryCommandArgs({ ...input, frame: 0 }, size), '--anim'];
}

const SHELL_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** One argument as a POSIX shell word: bare when nothing in it is special, single-quoted otherwise. */
export function shellWord(arg: string): string {
  return SHELL_SAFE.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function galleryCommand(args: readonly string[]): string {
  return ['npm', 'run', 'gallery', '--', ...args].map(shellWord).join(' ');
}

export function captureCommand(recipeId: string): string {
  return ['npm', 'run', 'capture', '--', '--recipe', recipeId].map(shellWord).join(' ');
}

/** A registered moment still recipe, restated from `tools/capture/recipes.json`. */
export interface GalleryCaptureStill {
  readonly id: string;
  readonly moment: string;
  readonly view: string;
  readonly skin: string;
  readonly hull: string | null;
  readonly accent: string | null;
  readonly spawnAnim: string;
  readonly tick: number;
  /** The size the recipe captures at, which is its own and not the workbench canvas's. */
  readonly viewport: GalleryStillSize;
}

/**
 * Every moment still in `tools/capture/recipes.json`, in its order. Restated because `src/` may
 * not read that file, the way `tools/gallery/args.mjs` restates the skin ids;
 * `tools/gallery/command-roundtrip.test.ts` fails if the two lists differ in any field.
 *
 * Only stills. A selection names one frame, and a clip recipe captures a whole timeline, so no
 * selection is the same capture as a clip. The other recipes are screens, which have no subject.
 */
export const GALLERY_CAPTURE_STILLS: readonly GalleryCaptureStill[] = Object.freeze([
  {
    id: 'gallery.fire.still',
    moment: 'fire',
    view: 'game',
    skin: 'solid',
    hull: null,
    accent: null,
    spawnAnim: 'warp',
    tick: 10,
    viewport: { width: 640, height: 480, dpr: 1 },
  },
  {
    id: 'gallery.ricochet.still',
    moment: 'ricochet',
    view: 'game',
    skin: 'solid',
    hull: null,
    accent: null,
    spawnAnim: 'warp',
    tick: 36,
    viewport: { width: 640, height: 480, dpr: 1 },
  },
]);

/**
 * The registered still that captures exactly `input`, or null. Every field the picture depends
 * on must be equal, the frame included; the canvas size is not compared, because it belongs to
 * the pane and not to the selection. The recipe adapter passes no mine warning, so a selection
 * with one never matches. The mine overlays are not compared: a moment draws neither.
 */
export function matchingCaptureStill(
  input: GalleryCommandInput,
  stills: readonly GalleryCaptureStill[] = GALLERY_CAPTURE_STILLS,
): GalleryCaptureStill | null {
  if (input.subject.kind !== 'moment' || input.mineWarn !== null) return null;
  return (
    stills.find(
      (s) =>
        s.moment === input.subject.id &&
        s.view === input.view &&
        s.skin === input.skin &&
        s.hull === input.hull &&
        s.accent === input.accent &&
        s.spawnAnim === input.spawnAnim &&
        s.tick === input.frame,
    ) ?? null
  );
}

/** A still's file name, carrying its subject, frame, pixel size and device pixel ratio. */
export function stillFileName(input: GalleryCommandInput, size: GalleryStillSize): string {
  return `gallery-${input.subject.id}-frame${input.frame}-${size.width}x${size.height}@${size.dpr}x.png`;
}
