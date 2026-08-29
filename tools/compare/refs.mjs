/**
 * Resolving the two sides of a comparison, and reading each side's recipe registry.
 *
 * EVERYTHING HERE RUNS BEFORE A WORKTREE EXISTS. A comparison costs two checkouts and two
 * browser captures, and every reason to refuse one -- an unresolvable ref, a ref that
 * predates the capture registry, a recipe missing on one side, a recipe that means
 * something different on each side -- is knowable from `git show` alone. Failing here also
 * means there is no worktree to leak when the refusal happens.
 *
 * The registry is read out of the object database with `git show <sha>:<path>`, never by
 * checking anything out, so the caller's tree is untouched even on the failure paths.
 */
import { runProcess } from '../capture/process.mjs';
import { createRegistry } from '../capture/registry.mjs';

export const RECIPES_PATH = 'tools/capture/recipes.json';

async function git(root, args, run, signal, what) {
  try {
    return await run('git', args, { cwd: root, timeoutMs: 15_000, signal });
  } catch (error) {
    throw new Error(`${what}: ${error.message}`, { cause: error });
  }
}

/**
 * Resolve a user-supplied ref to the exact commit it names.
 *
 * `^{commit}` rather than a bare rev-parse: a ref naming an annotated tag or a tree would
 * otherwise resolve to a non-commit object that `git worktree add` then refuses in a much
 * less obvious way. The recorded SHA is what `compare.json` reports and what the worktrees
 * are created at, so a branch that moves mid-run cannot make the two halves disagree.
 */
export async function resolveRef(root, label, ref, deps = {}) {
  const run = deps.runProcess ?? runProcess;
  const { stdout } = await git(
    root,
    ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`],
    run,
    deps.signal,
    `could not resolve --${label} '${ref}'`,
  );
  const commitSha = stdout.trim();
  if (!/^[0-9a-f]{40}$/i.test(commitSha)) {
    throw new Error(`git returned an invalid commit SHA '${commitSha}' for --${label} '${ref}'`);
  }
  return { label, requestedRef: ref, commitSha };
}

/**
 * Whether the CALLER's tree has uncommitted work.
 *
 * Recorded, never acted on. `--head HEAD` resolves to the COMMIT, so a dirty tree means
 * the evidence is not of the code the user is looking at; that is a legitimate thing to do
 * deliberately and a very easy thing to do by accident, so compare.json says which it was
 * rather than the command guessing.
 */
export async function inspectCallerTree(root, deps = {}) {
  const run = deps.runProcess ?? runProcess;
  const { stdout } = await git(
    root,
    ['status', '--porcelain', '--untracked-files=normal'],
    run,
    deps.signal,
    'could not inspect the caller working tree',
  );
  return { dirty: stdout.trim().length > 0 };
}

/**
 * Read and validate the capture registry as it existed at one commit.
 *
 * A ref older than the capture tooling makes `git show` fail, and that is precisely the
 * "land the capture fixture first" case the issue asks to diagnose -- so it is translated
 * into that instruction rather than surfaced as a raw git error about a missing path.
 */
export async function readRegistryAtSha(root, side, deps = {}) {
  const run = deps.runProcess ?? runProcess;
  let stdout;
  try {
    ({ stdout } = await run(
      'git',
      ['show', '--end-of-options', `${side.commitSha}:${RECIPES_PATH}`],
      { cwd: root, timeoutMs: 15_000, signal: deps.signal },
    ));
  } catch (error) {
    throw new Error(
      `${side.label} ${short(side)} has no ${RECIPES_PATH}. Land the capture fixture on both `
        + 'sides first, then make the behaviour change: comparing a capture against a ref that '
        + 'cannot produce it is not evidence about the change.',
      { cause: error },
    );
  }
  let raw;
  try {
    raw = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`${side.label} ${short(side)} has an unparseable ${RECIPES_PATH}: ${error.message}`, { cause: error });
  }
  try {
    return createRegistry(raw);
  } catch (error) {
    throw new Error(`${side.label} ${short(side)} has an invalid ${RECIPES_PATH}: ${error.message}`, { cause: error });
  }
}

/** `base a1b2c3d`-style label for diagnostics, so a reader can tell the two sides apart. */
export function short(side) {
  return `${side.requestedRef} (${side.commitSha.slice(0, 7)})`;
}

/**
 * Find one recipe on one side, or explain what to do about its absence.
 *
 * The asymmetry worth knowing: the compare COMMAND only has to exist on head, because base
 * is only ever asked to run `npm run capture`. The RECIPE has to exist on both, because it
 * is the thing being held fixed while the code varies.
 */
export function requireRecipe(registry, side, recipeId) {
  const entry = registry.find((candidate) => candidate.recipe.id === recipeId);
  if (entry) return entry;
  const known = registry.map((candidate) => candidate.recipe.id).sort();
  throw new Error(
    `recipe '${recipeId}' does not exist at ${side.label} ${short(side)}. `
      + `That ref knows: ${known.length > 0 ? known.join(', ') : '(no recipes)'}. `
      + 'Land the capture fixture first, then make the behaviour change.',
  );
}
