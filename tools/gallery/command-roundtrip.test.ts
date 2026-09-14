// The gallery workbench's terminal commands (issue #731), read back by the runners they name.
//
// `src/` may not import `tools/`, so the round trip lives here: every command
// src/game/gallery-command.ts writes is split the way a POSIX shell splits it and parsed with the
// gallery runner's own `parseArgs`, and the recipe table it restates is compared with the
// capture registry it was copied from.
import { describe, it, expect } from 'vitest';
// @ts-expect-error -- plain-node tooling module, intentionally dependency-free.
import { parseArgs } from './args.mjs';
// @ts-expect-error -- plain-node tooling module, intentionally dependency-free.
import { CAPTURE_RECIPES } from '../capture/registry.mjs';
// @ts-expect-error -- plain-node tooling module, intentionally dependency-free.
import { parseCaptureArgs } from '../capture/args.mjs';
// @ts-expect-error -- plain-node tooling module, intentionally dependency-free.
import { buildGalleryArguments } from '../capture/gallery-adapter.mjs';
import {
  GALLERY_CAPTURE_STILLS,
  captureCommand,
  galleryCommand,
  galleryCommandArgs,
  type GalleryCommandInput,
} from '../../src/game/gallery-command';
import { GALLERY_STILL } from '../../src/game/gallery-workbench';
import { WORKBENCH_CATALOG } from '../../src/render/gallery/workbench-scene';
import { ACCENTS, PALETTE, SKINS, SPAWN_ANIMATIONS, DEFAULT_SPAWN_ANIM } from '../../src/presentation/customization';

/** Splits a command line the way a POSIX shell does for the words shellWord writes. */
function splitShell(line: string): string[] {
  const words: string[] = [];
  let word = '';
  let started = false;
  let quoted = false;
  let escaped = false;
  for (const ch of line) {
    if (quoted) {
      if (ch === "'") quoted = false;
      else word += ch;
    } else if (escaped) {
      word += ch;
      escaped = false;
    } else if (ch === "'") {
      quoted = true;
      started = true;
    } else if (ch === '\\') {
      escaped = true;
      started = true;
    } else if (ch === ' ') {
      if (started) words.push(word);
      word = '';
      started = false;
    } else {
      word += ch;
      started = true;
    }
  }
  if (quoted || escaped) throw new Error(`unterminated word in ${line}`);
  if (started) words.push(word);
  return words;
}

interface RunnerArgs {
  scene: string;
  elements: string;
  view: string;
  skin: string;
  hull: string | null;
  accent: string | null;
  spawnAnim: string;
  mineWarn: string | null;
  reach: boolean;
  timer: boolean;
  age: number;
  w: number;
  h: number;
  dpr: number;
}

const fieldsOf = (a: RunnerArgs) => ({
  scene: a.scene, elements: a.elements, view: a.view, skin: a.skin, hull: a.hull, accent: a.accent,
  spawnAnim: a.spawnAnim, mineWarn: a.mineWarn, reach: a.reach, timer: a.timer, age: a.age,
  w: a.w, h: a.h, dpr: a.dpr,
});

/** What the runner must read back for `input`, in its own field names and defaults. */
const expectedFor = (input: GalleryCommandInput) => ({
  scene: input.subject.kind === 'moment' ? input.subject.id : 'gallery',
  elements: input.subject.kind === 'element' ? input.subject.id : 'mine',
  view: input.view,
  skin: input.skin,
  hull: input.hull,
  accent: input.accent,
  spawnAnim: input.spawnAnim,
  mineWarn: input.mineWarn,
  reach: input.subject.kind === 'element' && input.reach,
  timer: input.subject.kind === 'element' && input.timer,
  age: input.frame,
  w: GALLERY_STILL.width,
  h: GALLERY_STILL.height,
  dpr: GALLERY_STILL.dpr,
});

const parseCommand = (line: string): RunnerArgs => {
  const words = splitShell(line);
  expect(words.slice(0, 4)).toEqual(['npm', 'run', 'gallery', '--']);
  return parseArgs(words.slice(4)) as RunnerArgs;
};

const BASE: GalleryCommandInput = {
  subject: { kind: 'moment', id: 'fire' }, view: 'game', skin: 'solid', hull: null, accent: null,
  spawnAnim: DEFAULT_SPAWN_ANIM, mineWarn: null, reach: false, timer: false, frame: 0,
};
const TANK = { kind: 'element', id: 'tank' } as const;

describe('every workbench selector round-trips through the gallery runner (issue #731)', () => {
  // Population: one case per value of every selector the pane offers, each on an otherwise
  // default selection, read from the registries the pane itself reads.
  const groups: Record<string, [string, GalleryCommandInput][]> = {
    subject: [
      ...WORKBENCH_CATALOG.moments.map((id) => [`scene ${id}`, { ...BASE, subject: { kind: 'moment', id } }] as [string, GalleryCommandInput]),
      ...WORKBENCH_CATALOG.elements.map((id) => [`elements ${id}`, { ...BASE, subject: { kind: 'element', id } }] as [string, GalleryCommandInput]),
    ],
    view: WORKBENCH_CATALOG.views.map((view) => [`view ${view}`, { ...BASE, view }]),
    skin: SKINS.map((s) => [`skin ${s.id}`, { ...BASE, skin: s.id }]),
    hull: PALETTE.map((p) => [`hull ${p.id}`, { ...BASE, hull: p.hex }]),
    accent: ACCENTS.filter((a) => a.hex !== null).map((a) => [`accent ${a.id}`, { ...BASE, accent: a.hex }]),
    spawnAnim: SPAWN_ANIMATIONS.flatMap((s) => [
      [`spawn-anim ${s.id} on a moment`, { ...BASE, spawnAnim: s.id }] as [string, GalleryCommandInput],
      [`spawn-anim ${s.id} on a posed tank`, { ...BASE, subject: TANK, spawnAnim: s.id }] as [string, GalleryCommandInput],
    ]),
    mineWarn: WORKBENCH_CATALOG.mineWarnStyles.map((m) => [`mineWarn ${m}`, { ...BASE, mineWarn: m }]),
    overlays: [
      ['reach and timer on a posed mine', { ...BASE, subject: { kind: 'element', id: 'mine' }, reach: true, timer: true }],
      ['reach and timer on a moment, which draws neither', { ...BASE, reach: true, timer: true }],
    ],
    frame: [['frame 7', { ...BASE, frame: 7 }]],
  };

  for (const [group, cases] of Object.entries(groups)) {
    it(`reads back the selection for every ${group} value`, () => {
      expect(cases.length, `${group} has no values to sweep`).toBeGreaterThan(0);
      for (const [label, input] of cases) {
        const parsed = parseCommand(galleryCommand(galleryCommandArgs(input, GALLERY_STILL)));
        expect(fieldsOf(parsed), label).toEqual(expectedFor(input));
      }
    });
  }
});

describe('GALLERY_CAPTURE_STILLS restates the registered moment stills (issue #731)', () => {
  const registered = (CAPTURE_RECIPES as { recipe: Record<string, any> }[])
    .map((e) => e.recipe)
    .filter((r) => r.producer.kind === 'moment' && r.schedule.kind === 'still');

  it('holds exactly the moment still recipes the registry holds, field for field and in order', () => {
    expect(registered.length, 'the registry has no moment stills to compare').toBeGreaterThan(0);
    expect([...GALLERY_CAPTURE_STILLS]).toEqual(
      registered.map((r) => ({
        id: r.id,
        moment: r.producer.scenarioId,
        view: r.variant.view,
        skin: r.variant.skin,
        hull: r.variant.hull,
        accent: r.variant.accent,
        spawnAnim: r.variant.spawnAnimation,
        tick: r.schedule.tick,
        viewport: { width: r.viewport.width, height: r.viewport.height, dpr: r.viewport.devicePixelRatio },
      })),
    );
  });

  it('names each one in a capture command the capture runner accepts, for a recipe it registers', () => {
    const ids = new Set(registered.map((r) => r.id));
    for (const still of GALLERY_CAPTURE_STILLS) {
      const words = splitShell(captureCommand(still.id));
      expect(words.slice(0, 4)).toEqual(['npm', 'run', 'capture', '--']);
      const options = parseCaptureArgs(words.slice(4)) as { recipe: string };
      expect(ids.has(options.recipe), still.id).toBe(true);
    }
  });

  it('a selection matching a still draws what that recipe draws, apart from the canvas size', () => {
    // The recipe's own gallery arguments, as the capture adapter builds them, read by the same
    // parser as the workbench's command for the matching selection.
    for (const recipe of registered) {
      const input: GalleryCommandInput = {
        ...BASE,
        subject: { kind: 'moment', id: recipe.producer.scenarioId },
        view: recipe.variant.view,
        skin: recipe.variant.skin,
        hull: recipe.variant.hull,
        accent: recipe.variant.accent,
        spawnAnim: recipe.variant.spawnAnimation,
        frame: recipe.schedule.tick,
      };
      const picture = (a: RunnerArgs) => {
        const { w: _w, h: _h, dpr: _dpr, ...rest } = fieldsOf(a);
        return rest;
      };
      const fromRecipe = parseArgs(buildGalleryArguments(recipe, 'tmp/command-roundtrip')) as RunnerArgs;
      const fromWorkbench = parseCommand(galleryCommand(galleryCommandArgs(input, GALLERY_STILL)));
      expect(picture(fromWorkbench), recipe.id).toEqual(picture(fromRecipe));
    }
  });
});
