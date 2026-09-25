import {
  ACCENTS,
  DEFAULT_ACCENT,
  DEFAULT_SKIN,
  DEFAULT_SPAWN_ANIM,
  PALETTE,
  SKINS,
  SPAWN_ANIMATIONS,
  type AccentId,
  type HullColorId,
  type SkinId,
  type SpawnAnimId,
} from '../presentation/customization';

/**
 * The gallery workbench's shareable selection (issue #730): what `?dev=1&gallery=` carries,
 * and the one reading of it both the pane and a pasted link go through.
 *
 * THE `gallery` DEVELOPER FLAG IS PERMANENT. It settles no open question, so it has no
 * ship-or-delete ruling to wait for: it is the workbench's shareable link for as long as the
 * workbench exists (`.claude/rules/game.md`'s exemption for flags that are not experiments).
 *
 * PURE, and `game/`-side, because it is the pane's vocabulary rather than the renderer's. The
 * render registries it validates against (`ELEMENTS`, `MOMENTS`, `VIEWS`, the mine-warning
 * styles) arrive as a `GalleryCatalog`, injected from the wiring that may import them -- the
 * same shape `render/gallery/workbench-scene.ts` exports as `WORKBENCH_CATALOG`. The paint shop's
 * registries are presentation vocabulary and are read directly.
 *
 * THE GRAMMAR is one parameter of comma-separated parts, each `key:value` or a bare `key`:
 *
 *     ?dev=1&gallery=scene:destroyed,view:low,skin:camo,hull:red,age:24
 *
 * The keys are `tools/gallery/main.ts`'s own parameter names (`scene`, `elements`, `view`,
 * `skin`, `hull`, `accent`, `spawn-anim`, `mineWarn`, `reach`, `timer`, `age`), so a link reads
 * like the capture page's query and maps onto it one key at a time. Two values differ on
 * purpose: `hull` and `accent` are the paint shop's ids (`red`, `gold`) rather than hexes,
 * because an id is what a person can read in a link and the hex is one table lookup away.
 *
 * NOTHING UNRECOGNISED IS SILENTLY REPLACED. A part that names no key, a value that names no
 * registered entry, a repeated key or a second subject each become a line in `problems`, and
 * the field keeps its default. The pane shows every line. That is the issue's "an unknown
 * value is reported rather than silently replaced with a default": the default is still what
 * draws, because something has to, but the link's author is told which part was not honoured.
 */

/** The render-side registry keys the workbench offers. Structurally `WorkbenchCatalog`. */
export interface GalleryCatalog {
  readonly elements: readonly string[];
  readonly moments: readonly string[];
  readonly views: readonly string[];
  readonly mineWarnStyles: readonly string[];
}

export interface GallerySubject {
  readonly kind: 'element' | 'moment';
  readonly id: string;
}

export interface GallerySelection {
  readonly subject: GallerySubject;
  readonly view: string;
  readonly skin: SkinId;
  /** A palette id, or null for the roster's own colour. */
  readonly hull: HullColorId | null;
  readonly accent: AccentId;
  readonly spawnAnim: SpawnAnimId;
  /** One of `GalleryCatalog.mineWarnStyles`, or null for the shipped treatment. */
  readonly mineWarn: string | null;
  readonly reach: boolean;
  readonly timer: boolean;
  /** The timeline frame, a whole number from 0. The workbench clamps it to the subject. */
  readonly frame: number;
}

export interface ParsedGallerySelection {
  readonly selection: GallerySelection;
  /** One sentence per part that was not honoured, in the order the parts appeared. */
  readonly problems: readonly string[];
}

/** The capture page's own default view, when the catalog has it. */
const DEFAULT_VIEW = 'game';

/** What an empty link draws: the capture page's defaults, on the first registered element. */
export function defaultGallerySelection(catalog: GalleryCatalog): GallerySelection {
  return {
    subject: { kind: 'element', id: catalog.elements[0] ?? '' },
    view: catalog.views.includes(DEFAULT_VIEW) ? DEFAULT_VIEW : (catalog.views[0] ?? DEFAULT_VIEW),
    skin: DEFAULT_SKIN,
    hull: null,
    accent: DEFAULT_ACCENT,
    spawnAnim: DEFAULT_SPAWN_ANIM,
    mineWarn: null,
    reach: false,
    timer: false,
    frame: 0,
  };
}

const KEYS = [
  'scene',
  'elements',
  'view',
  'skin',
  'hull',
  'accent',
  'spawn-anim',
  'mineWarn',
  'reach',
  'timer',
  'age',
] as const;
type Key = (typeof KEYS)[number];
const BARE: ReadonlySet<Key> = new Set<Key>(['reach', 'timer']);

const isKey = (k: string): k is Key => (KEYS as readonly string[]).includes(k);

/**
 * Read a `gallery` parameter's value. Never throws; an empty value is the default selection
 * with no problems.
 */
export function parseGallerySelection(raw: string, catalog: GalleryCatalog): ParsedGallerySelection {
  const problems: string[] = [];
  const base = defaultGallerySelection(catalog);
  let subject = base.subject;
  let view = base.view;
  let skin = base.skin;
  let hull = base.hull;
  let accent = base.accent;
  let spawnAnim = base.spawnAnim;
  let mineWarn = base.mineWarn;
  let reach = base.reach;
  let timer = base.timer;
  let frame = base.frame;

  const seen = new Set<string>();
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (trimmed === '') continue;
    const colon = trimmed.indexOf(':');
    const key = colon === -1 ? trimmed : trimmed.slice(0, colon);
    const value = colon === -1 ? null : trimmed.slice(colon + 1);
    if (!isKey(key)) {
      problems.push(`"${trimmed}" is not a gallery setting, so it was ignored.`);
      continue;
    }
    const slot = key === 'scene' || key === 'elements' ? 'subject' : key;
    if (seen.has(slot)) {
      problems.push(
        slot === 'subject'
          ? `"${trimmed}" is a second subject; only the first one is shown.`
          : `"${key}" is given more than once; only the first one is used.`,
      );
      continue;
    }
    seen.add(slot);
    if (BARE.has(key)) {
      if (value !== null) {
        problems.push(`"${key}" takes no value, so "${trimmed}" was ignored.`);
        continue;
      }
      if (key === 'reach') reach = true;
      else timer = true;
      continue;
    }
    if (value === null || value === '') {
      problems.push(`"${key}" needs a value, so it was ignored.`);
      continue;
    }
    const refuse = (what: string): void => {
      problems.push(`"${value}" is not a registered ${what}, so the default is shown.`);
    };
    switch (key) {
      case 'scene':
        if (catalog.moments.includes(value)) subject = { kind: 'moment', id: value };
        else refuse('moment');
        break;
      case 'elements':
        if (catalog.elements.includes(value)) subject = { kind: 'element', id: value };
        else refuse('element');
        break;
      case 'view':
        if (catalog.views.includes(value)) view = value;
        else refuse('view');
        break;
      case 'skin': {
        const found = SKINS.find((s) => s.id === value);
        if (found) skin = found.id;
        else refuse('skin');
        break;
      }
      case 'hull': {
        const found = PALETTE.find((s) => s.id === value);
        if (found) hull = found.id;
        else refuse('hull colour');
        break;
      }
      case 'accent': {
        const found = ACCENTS.find((s) => s.id === value);
        if (found) accent = found.id;
        else refuse('accent');
        break;
      }
      case 'spawn-anim': {
        const found = SPAWN_ANIMATIONS.find((s) => s.id === value);
        if (found) spawnAnim = found.id;
        else refuse('spawn animation');
        break;
      }
      case 'mineWarn':
        if (catalog.mineWarnStyles.includes(value)) mineWarn = value;
        else refuse('mine warning');
        break;
      case 'age':
        if (/^\d+$/.test(value)) frame = Number(value);
        else problems.push(`"${value}" is not a frame number, so the first frame is shown.`);
        break;
    }
  }
  return {
    selection: { subject, view, skin, hull, accent, spawnAnim, mineWarn, reach, timer, frame },
    problems,
  };
}

/**
 * The canonical value for a selection: the subject first, then only the fields that differ
 * from the default, in `KEYS` order. Canonical so one selection has one link, and the pane's
 * link field changes only when the selection does.
 */
export function formatGallerySelection(selection: GallerySelection, catalog: GalleryCatalog): string {
  const base = defaultGallerySelection(catalog);
  const parts = [
    selection.subject.kind === 'moment' ? `scene:${selection.subject.id}` : `elements:${selection.subject.id}`,
  ];
  if (selection.view !== base.view) parts.push(`view:${selection.view}`);
  if (selection.skin !== base.skin) parts.push(`skin:${selection.skin}`);
  if (selection.hull !== null) parts.push(`hull:${selection.hull}`);
  if (selection.accent !== base.accent) parts.push(`accent:${selection.accent}`);
  if (selection.spawnAnim !== base.spawnAnim) parts.push(`spawn-anim:${selection.spawnAnim}`);
  if (selection.mineWarn !== null) parts.push(`mineWarn:${selection.mineWarn}`);
  if (selection.reach) parts.push('reach');
  if (selection.timer) parts.push('timer');
  if (selection.frame > 0) parts.push(`age:${selection.frame}`);
  return parts.join(',');
}
