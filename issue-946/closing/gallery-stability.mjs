// #946 criterion 4 (first half): the five committed gallery moment recipes, captured through
// each tree's own gallery runner (tools/gallery/run.mjs, the capture page the moment producer
// drives), twice per tree, before (66694b47) and after (1c3a193e). Frames are compared by
// SHA-256. The runner is given the exact argv the capture adapter builds for the recipe
// (each tree's own buildGalleryArguments), so this is the recipe's capture minus the
// git-provenance step, which a git-archive tree cannot satisfy.
// usage: node gallery-stability.mjs <out.json> [runs]
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const T = '/Users/austinorphan/.claude/jobs/e6e7bb6c/tmp/closing/946-251/trees';
const PW = pathToFileURL('/Users/austinorphan/src/tanks/.claude/worktrees/closing-946/node_modules/playwright/index.mjs').href;
const [out, runsArg] = process.argv.slice(2);
const RUNS = Number(runsArg ?? 2);
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

const result = { trees: {}, recipesIdentical: null, comparisons: {} };
const recipesBy = {};
for (const tree of ['before', 'after']) {
  const root = join(T, tree);
  const raw = JSON.parse(readFileSync(join(root, 'tools/capture/recipes.json'), 'utf8'));
  const list = (Array.isArray(raw) ? raw : (raw.recipes ?? Object.values(raw))).map((e) => e.recipe ?? e);
  const moments = list.filter((r) => r.producer?.kind === 'moment');
  recipesBy[tree] = Object.fromEntries(moments.map((r) => [r.id, r]));
  const { buildGalleryArguments } = await import(pathToFileURL(join(root, 'tools/capture/gallery-adapter.mjs')).href);
  result.trees[tree] = {};
  for (let run = 1; run <= RUNS; run++) {
    for (const recipe of moments) {
      const rel = `tmp/closing946/${recipe.id}-r${run}`;
      const args = buildGalleryArguments(recipe, rel);
      const started = Date.now();
      const p = spawnSync(process.execPath, [join(root, 'tools/gallery/run.mjs'), ...args], {
        cwd: root, env: { ...process.env, PLAYWRIGHT_MODULE: PW }, encoding: 'utf8', timeout: 900000,
      });
      const dir = join(root, rel);
      const frames = existsSync(dir) ? readdirSync(dir).filter((n) => /^frame(-\d{4})?\.png$/.test(n)).sort() : [];
      let report = null;
      try { report = JSON.parse(readFileSync(join(dir, 'producer.json'), 'utf8')); } catch { /* none */ }
      const entry = {
        status: p.status, seconds: (Date.now() - started) / 1000,
        stderrTail: (p.stderr ?? '').split('\n').slice(-5).join('\n'),
        frames: frames.length,
        frameHashes: frames.map((f) => sha(join(dir, f))),
        pageErrors: report?.capture?.pageErrors?.length ?? null,
        fixtureAssertions: (report?.producer?.fixtureAssertions ?? []).map((a) => ({ type: a.type, passed: a.passed })),
        observedEvents: report?.producer?.observedEvents ?? null,
        tickCount: report?.producer?.tickCount ?? null,
        chromium: report?.browser?.chromiumVersion ?? null,
      };
      (result.trees[tree][recipe.id] ??= []).push(entry);
      console.log(`${tree} r${run} ${recipe.id}: exit ${p.status}, ${frames.length} frame(s), ` +
        `${entry.pageErrors} page error(s), assertions ${entry.fixtureAssertions.map((a) => a.passed).join(',') || '-'}, ${entry.seconds}s`);
      if (p.status !== 0) console.log(entry.stderrTail);
    }
  }
}
const ids = [...new Set([...Object.keys(recipesBy.before), ...Object.keys(recipesBy.after)])];
result.recipesIdentical = Object.fromEntries(ids.map((id) => [id,
  JSON.stringify(recipesBy.before[id] ?? null) === JSON.stringify(recipesBy.after[id] ?? null)]));
const same = (a, b) => a !== undefined && b !== undefined && a.frames > 0 && a.frames === b.frames
  && a.frameHashes.every((h, i) => h === b.frameHashes[i]);
const differing = (a, b) => (a && b ? a.frameHashes.filter((h, i) => h !== b.frameHashes[i]).length : null);
for (const id of ids) {
  const b = result.trees.before[id] ?? [];
  const a = result.trees.after[id] ?? [];
  result.comparisons[id] = {
    recipeIdentical: result.recipesIdentical[id],
    beforeControl: RUNS > 1 ? same(b[0], b[1]) : null,
    afterControl: RUNS > 1 ? same(a[0], a[1]) : null,
    beforeVsAfter: same(b[0], a[0]),
    framesDifferingBeforeVsAfter: differing(b[0], a[0]),
    frames: [b[0]?.frames, a[0]?.frames],
    eventsIdentical: JSON.stringify(b[0]?.observedEvents) === JSON.stringify(a[0]?.observedEvents),
  };
  console.log(id, JSON.stringify(result.comparisons[id]));
}
writeFileSync(out, JSON.stringify(result, null, 2));
