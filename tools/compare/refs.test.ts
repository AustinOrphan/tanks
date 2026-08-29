import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
// @ts-expect-error -- plain-node ESM module, no types
import { resolveRef, readRegistryAtSha, requireRecipe, inspectCallerTree, RECIPES_PATH } from './refs.mjs';
// @ts-expect-error -- plain-node ESM module, no types
import { checkRecipeCompatibility, describeIncompatibility, checkEnvironmentParity } from './compatibility.mjs';
// @ts-expect-error -- plain-node ESM module, no types
import { createRegistry } from '../capture/registry.mjs';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

/** The shipped registry, used as the realistic "both sides agree" fixture. */
const SHIPPED = JSON.parse(readFileSync(new URL(`../../${RECIPES_PATH}`, import.meta.url), 'utf8'));

/**
 * A fake `runProcess` that answers a scripted map of `git <args joined>` -> stdout, and
 * throws for anything unscripted. Deliberately strict: a stub that returns '' for an
 * unexpected command turns a wrong git invocation into a passing test.
 */
function fakeGit(responses: Record<string, string | Error>) {
  const calls: string[][] = [];
  const runProcess = async (command: string, args: string[]) => {
    calls.push([command, ...args]);
    const key = args.join(' ');
    if (!(key in responses)) throw new Error(`unscripted git invocation: git ${key}`);
    const value = responses[key];
    if (value instanceof Error) throw value;
    return { stdout: value, stderr: '', code: 0 };
  };
  return { runProcess, calls };
}

describe('resolveRef', () => {
  it('resolves through ^{commit} so a tag or tree cannot reach git worktree add', async () => {
    const git = fakeGit({ 'rev-parse --verify --end-of-options main^{commit}': `${SHA_A}\n` });
    const side = await resolveRef('/repo', 'base', 'main', { runProcess: git.runProcess });
    expect(side).toEqual({ label: 'base', requestedRef: 'main', commitSha: SHA_A });
    // The peel and the option terminator are both load-bearing, so both are asserted
    // rather than left to the response key: `--end-of-options` is what stops a ref that
    // survived the CLI grammar from being read as a git option.
    expect(git.calls[0]).toEqual(['git', 'rev-parse', '--verify', '--end-of-options', 'main^{commit}']);
  });

  it('names the side and the ref when a ref does not resolve', async () => {
    const git = fakeGit({ 'rev-parse --verify --end-of-options nope^{commit}': new Error('unknown revision') });
    await expect(resolveRef('/repo', 'head', 'nope', { runProcess: git.runProcess }))
      .rejects.toThrow(/could not resolve --head 'nope'/);
  });

  it('refuses output that is not a 40-hex SHA', async () => {
    // A truncated or decorated rev-parse would otherwise be recorded in compare.json as
    // the exact commit the evidence came from, which is the one thing it must not lie about.
    const git = fakeGit({ 'rev-parse --verify --end-of-options main^{commit}': 'abc123\n' });
    await expect(resolveRef('/repo', 'base', 'main', { runProcess: git.runProcess }))
      .rejects.toThrow(/invalid commit SHA/);
  });
});

describe('inspectCallerTree', () => {
  it.each([['', false], [' M src/sim/world.ts\n', true]])(
    'reports dirty=%s for status output %j', async (status, dirty) => {
      const git = fakeGit({ 'status --porcelain --untracked-files=normal': status as string });
      expect(await inspectCallerTree('/repo', { runProcess: git.runProcess })).toEqual({ dirty });
    },
  );
});

describe('readRegistryAtSha', () => {
  const side = { label: 'base', requestedRef: 'main', commitSha: SHA_A };

  it('reads the registry out of the object database, never a checkout', async () => {
    const git = fakeGit({ [`show --end-of-options ${SHA_A}:${RECIPES_PATH}`]: JSON.stringify(SHIPPED) });
    const registry = await readRegistryAtSha('/repo', side, { runProcess: git.runProcess });
    expect(registry.map((e: { recipe: { id: string } }) => e.recipe.id)).toContain('gallery.fire.still');
    // `git show`, not `git checkout`/`git read-tree`: the caller's tree must be untouched
    // even on this path, and only the command actually used proves that.
    expect(git.calls[0][1]).toBe('show');
  });

  it('turns a ref that predates the capture registry into fixture-first guidance', async () => {
    const git = fakeGit({ [`show --end-of-options ${SHA_A}:${RECIPES_PATH}`]: new Error("path does not exist") });
    await expect(readRegistryAtSha('/repo', side, { runProcess: git.runProcess }))
      .rejects.toThrow(/Land the capture fixture on both\s+sides first/);
  });

  it('rejects an unparseable or invalid registry, naming the side', async () => {
    const bad = fakeGit({ [`show --end-of-options ${SHA_A}:${RECIPES_PATH}`]: '{not json' });
    await expect(readRegistryAtSha('/repo', side, { runProcess: bad.runProcess }))
      .rejects.toThrow(/base main \(aaaaaaa\) has an unparseable/);
    const invalid = fakeGit({ [`show --end-of-options ${SHA_A}:${RECIPES_PATH}`]: '[{"id":"x"}]' });
    await expect(readRegistryAtSha('/repo', side, { runProcess: invalid.runProcess }))
      .rejects.toThrow(/base main \(aaaaaaa\) has an invalid/);
  });
});

describe('requireRecipe', () => {
  const registry = createRegistry(SHIPPED);
  const side = { label: 'head', requestedRef: 'HEAD', commitSha: SHA_B };

  it('finds a recipe that exists', () => {
    expect(requireRecipe(registry, side, 'gallery.fire.still').recipe.id).toBe('gallery.fire.still');
  });

  it('lists what the ref does know when the recipe is missing there', () => {
    // The actionable half: "missing" alone leaves the reader guessing whether they typo'd
    // the ID or picked a ref that predates it.
    expect(() => requireRecipe(registry, side, 'gallery.nope.still'))
      .toThrow(new RegExp(
        String.raw`does not exist at head HEAD \(bbbbbbb\)\. That ref knows: `
        + String.raw`gallery\.ai-tracking\.normal, gallery\.drive\.normal, `
        + String.raw`gallery\.fire\.still, gallery\.ricochet\.still`,
      ));
  });
});

describe('checkRecipeCompatibility', () => {
  const entry = createRegistry(SHIPPED).find((e: { recipe: { id: string } }) => e.recipe.id === 'gallery.fire.still');
  const clone = () => JSON.parse(JSON.stringify(entry.recipe));

  it('calls a recipe compatible with itself', () => {
    const result = checkRecipeCompatibility(entry, entry);
    expect(result.compatible).toBe(true);
    expect(result.differing).toEqual([]);
  });

  it.each([
    ['viewport', (r: any) => { r.viewport.width = 800; }],
    ['fixture', (r: any) => { r.fixture.seed = 99; }],
    ['schedule', (r: any) => { r.schedule.tick = 11; }],
    ['producer.scenarioId', (r: any) => { r.producer.scenarioId = 'destroyed'; }],
    ['recipeVersion', (r: any) => { r.recipeVersion = 2; }],
    ['expectations', (r: any) => { r.expectations.events[0].count = 2; }],
    ['playback', (r: any) => { r.playback.rate = 0.5; }],
  ])('refuses and NAMES a changed %s', (field, mutate) => {
    const recipe = clone();
    mutate(recipe);
    const head = createRegistry([recipe])[0];
    const result = checkRecipeCompatibility(entry, head);
    expect(result.compatible).toBe(false);
    // Naming the field is the whole value of the per-field pass; asserting only
    // `compatible === false` would pass against a check that reports nothing useful.
    expect(result.differing).toContain(field);
  });

  it('names the artifact set when the two recipes request different media', () => {
    // `artifacts` cannot be varied on its own: #342's schema pins canonical filenames per
    // format, so a still recipe's artifacts are exactly [png:capture.png]. The only way
    // two VALID recipes differ here is by being different kinds of capture, which is what
    // this compares -- a still against the shipped temporal recipe. Attempting to isolate
    // it produced `png must use the canonical filename capture.png`, which is the schema
    // doing its job.
    const temporal = createRegistry(SHIPPED).find(
      (e: { recipe: { id: string } }) => e.recipe.id === 'gallery.ai-tracking.normal',
    );
    const result = checkRecipeCompatibility(entry, temporal);
    expect(result.compatible).toBe(false);
    expect(result.differing).toContain('artifacts');
    expect(result.differing).toContain('schedule');
  });

  it('still refuses when the hash differs but every compared field matches', () => {
    // The recipe's title is outside the field table but inside the hash. Without this the
    // obvious implementation -- compatible = differing.length === 0 -- passes every other
    // test in this block while silently accepting a recipe that is not the reviewed one.
    const recipe = clone();
    recipe.title = 'A different title for the same measurement';
    const head = createRegistry([recipe])[0];
    const result = checkRecipeCompatibility(entry, head);
    expect(result.compatible).toBe(false);
    expect(result.differing).toEqual([]);
    const message = describeIncompatibility('gallery.fire.still', { requestedRef: 'main', commitSha: SHA_A },
      { requestedRef: 'HEAD', commitSha: SHA_B }, result);
    expect(message).toMatch(/Every field this contract compares matches/);
  });

  it('is insensitive to key ORDER, which is not a semantic difference', () => {
    const recipe = clone();
    recipe.viewport = { devicePixelRatio: recipe.viewport.devicePixelRatio, height: recipe.viewport.height, width: recipe.viewport.width };
    const head = createRegistry([recipe])[0];
    expect(checkRecipeCompatibility(entry, head).compatible).toBe(true);
  });

  it('describes a real difference with both values, so the message is actionable', () => {
    const recipe = clone();
    recipe.viewport.width = 800;
    const head = createRegistry([recipe])[0];
    const message = describeIncompatibility('gallery.fire.still', { requestedRef: 'main', commitSha: SHA_A },
      { requestedRef: 'HEAD', commitSha: SHA_B }, checkRecipeCompatibility(entry, head));
    expect(message).toContain('viewport');
    expect(message).toContain('800');
    expect(message).toContain('640');
    expect(message).toMatch(/Land the capture fixture on both refs first/);
  });
});

describe('checkEnvironmentParity', () => {
  it('reports agreement across the recorded tool versions', () => {
    const tools = { node: 'v24', playwright: '1.62.0', ffmpeg: 'n7.1' };
    expect(checkEnvironmentParity({ tools }, { tools }).equal).toBe(true);
  });

  it('names a tool that differs rather than throwing the captures away', () => {
    // Both captures already exist and are honest recordings; a loud caveat serves the
    // reader better than discarding the evidence. So this reports, and does not refuse.
    const result = checkEnvironmentParity(
      { tools: { node: 'v24', chromium: '151' } },
      { tools: { node: 'v24', chromium: '152' } },
    );
    expect(result.equal).toBe(false);
    expect(result.differing).toEqual(['chromium']);
  });

  it('treats a tool recorded on one side only as a difference', () => {
    const result = checkEnvironmentParity({ tools: { node: 'v24' } }, { tools: { node: 'v24', ffmpeg: 'n7.1' } });
    expect(result.equal).toBe(false);
    expect(result.differing).toEqual(['ffmpeg']);
  });
});
