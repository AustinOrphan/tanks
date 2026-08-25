const RECIPE_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

export const CAPTURE_USAGE = `Usage:
  npm run capture -- --list
  npm run capture -- --recipe <id> [--out <directory>] [--retain-frames] [--source-ref <ref>]

The output directory must be a relative path inside this checkout and must not exist.`;

export function parseCaptureArgs(argv) {
  const options = {
    help: false,
    list: false,
    recipe: null,
    out: null,
    retainFrames: false,
    sourceRef: null,
  };
  const seen = new Set();
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (!flag.startsWith('--')) throw new Error(`unexpected positional argument '${flag}'`);
    if (seen.has(flag)) throw new Error(`duplicate option ${flag}`);
    seen.add(flag);
    if (flag === '--help') options.help = true;
    else if (flag === '--list') options.list = true;
    else if (flag === '--retain-frames') options.retainFrames = true;
    else if (['--recipe', '--out', '--source-ref'].includes(flag)) {
      const value = argv[++index];
      if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
      if (flag === '--recipe') options.recipe = value;
      else if (flag === '--out') options.out = value;
      else options.sourceRef = value;
    } else throw new Error(`unknown option ${flag}`);
  }

  if (options.help) return options;
  if (options.list && options.recipe !== null) throw new Error('--list cannot be combined with --recipe');
  if (!options.list && options.recipe === null) throw new Error('choose --list or --recipe <id>');
  if (options.list && (options.out !== null || options.retainFrames || options.sourceRef !== null)) {
    throw new Error('--out, --retain-frames, and --source-ref require --recipe');
  }
  if (options.recipe !== null && !RECIPE_ID.test(options.recipe)) {
    throw new Error(`invalid recipe ID '${options.recipe}'`);
  }
  if (options.out !== null && (/\p{Cc}/u.test(options.out) || options.out.length > 240)) {
    throw new Error('--out contains invalid characters or is too long');
  }
  if (options.sourceRef !== null) {
    if (
      options.sourceRef.length > 240
      || options.sourceRef.startsWith('-')
      || options.sourceRef.startsWith('/')
      || options.sourceRef.endsWith('/')
      || options.sourceRef.includes('..')
      || options.sourceRef.includes('//')
      || /\p{Cc}/u.test(options.sourceRef)
      || !/^[A-Za-z0-9._/-]+$/.test(options.sourceRef)
    ) {
      throw new Error(`invalid --source-ref '${options.sourceRef}'`);
    }
  }
  return options;
}
