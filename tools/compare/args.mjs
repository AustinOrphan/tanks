/**
 * `npm run capture:compare` argument parsing.
 *
 * Deliberately the same shape as tools/capture/args.mjs -- exact flag allowlist, no
 * positionals, no abbreviation, every value validated against a character class before it
 * reaches git or the filesystem. A compare run resolves user-supplied REFS and passes them
 * to `git`, so the ref validation here is the boundary that keeps a registry value or a
 * flag from being read as an option (`--upload-pack=...`) or a path.
 */

const RECIPE_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

export const COMPARE_USAGE = `Usage:
  npm run capture:compare -- --recipe <id> --base <ref> --head <ref> [--out <directory>] [--retain-frames]

Captures the same recipe at two refs in isolated worktrees and assembles labelled
before/after evidence. The output directory must be a relative path inside this checkout
and must not exist. Defaults to artifacts/compare/<recipe-id>.`;

/**
 * A ref is passed to `git rev-parse` and to `git worktree add`, so it must not be able to
 * look like an option or a path. Same rule as capture's `--source-ref`, which exists for
 * the same reason; kept as a separate function rather than imported so a change to one
 * command's surface cannot silently move the other's.
 */
function validateRef(flag, value) {
  if (
    value.length === 0
    || value.length > 240
    || value.startsWith('-')
    || value.startsWith('/')
    || value.endsWith('/')
    || value.includes('..')
    || value.includes('//')
    || /\p{Cc}/u.test(value)
    || !/^[A-Za-z0-9._/-]+$/.test(value)
  ) {
    throw new Error(`invalid ${flag} '${value}'`);
  }
}

export function parseCompareArgs(argv) {
  const options = {
    help: false,
    recipe: null,
    base: null,
    head: null,
    out: null,
    retainFrames: false,
  };
  const seen = new Set();
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (!flag.startsWith('--')) throw new Error(`unexpected positional argument '${flag}'`);
    if (seen.has(flag)) throw new Error(`duplicate option ${flag}`);
    seen.add(flag);
    if (flag === '--help') options.help = true;
    else if (flag === '--retain-frames') options.retainFrames = true;
    else if (['--recipe', '--base', '--head', '--out'].includes(flag)) {
      const value = argv[++index];
      if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
      if (flag === '--recipe') options.recipe = value;
      else if (flag === '--base') options.base = value;
      else if (flag === '--head') options.head = value;
      else options.out = value;
    } else throw new Error(`unknown option ${flag}`);
  }

  if (options.help) return options;

  for (const [flag, value] of [['--recipe', options.recipe], ['--base', options.base], ['--head', options.head]]) {
    if (value === null) throw new Error(`${flag} is required`);
  }
  if (!RECIPE_ID.test(options.recipe)) throw new Error(`invalid recipe ID '${options.recipe}'`);
  validateRef('--base', options.base);
  validateRef('--head', options.head);
  if (options.out !== null && (/\p{Cc}/u.test(options.out) || options.out.length > 240)) {
    throw new Error('--out contains invalid characters or is too long');
  }
  // Comparing a ref with itself is almost certainly a typo, and the answer would be a
  // guaranteed-identical result that tells the reader nothing. Refused rather than run,
  // because a run costs two worktrees and two browser captures.
  if (options.base === options.head) {
    throw new Error(`--base and --head are both '${options.base}'; there is nothing to compare`);
  }
  return options;
}

/** Where a compare run publishes when `--out` is absent. */
export function defaultCompareOut(recipeId) {
  return `artifacts/compare/${recipeId}`;
}
