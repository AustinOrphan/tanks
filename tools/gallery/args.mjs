/**
 * Argument parsing and label hygiene for the gallery runner, kept in its own module so it
 * is testable without a browser or ffmpeg.
 */
export const DEFAULTS = {
  subject: 'mine',
  view: 'game',
  out: 'gallery-out',
  w: 640,
  h: 480,
  fps: 20,
  subdiv: 3,
  anim: false,
  reach: false,
  timer: false,
  fill: false,
  sweep: null,
  values: [],
  label: true,
};

const BOOLISH = ['anim', 'reach', 'timer', 'fill'];
const NUMERIC = ['w', 'h', 'fps', 'subdiv'];

export function parseArgs(argv) {
  const out = { ...DEFAULTS, values: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    if (BOOLISH.includes(key)) { out[key] = true; continue; }
    if (key === 'no-label') { out.label = false; continue; }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`--${key} needs a value`);
    i++;
    if (key === 'values') out.values = value.split(',').map((s) => s.trim()).filter(Boolean);
    else if (NUMERIC.includes(key)) {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new Error(`--${key} must be a number, got ${value}`);
      out[key] = n;
    } else if (key in DEFAULTS) out[key] = value;
    else throw new Error(`unknown flag --${key}`);
  }
  if (out.sweep && out.values.length === 0) throw new Error('--sweep needs --values');
  if (!out.sweep && out.values.length > 0) throw new Error('--values needs --sweep');
  return out;
}

/**
 * Make a string safe to hand to ffmpeg's drawtext.
 *
 * Both of these have already cost a rebuild: drawtext reads `%` as a strftime escape and
 * `=` as an option separator, so a label containing either is silently DROPPED -- that is
 * how a nine-cell variant grid came out with no labels at all. And `node -e console.log(x)`
 * emits ANSI colour codes in this environment, which land in the image as a literal
 * "[33m25[39m".
 */
export function safeLabel(text) {
  return String(text)
    .replace(new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g'), '')
    .replace(/%/g, 'pc')
    .replace(/[=:\\'\[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Lay n cells out as near-square a grid as possible, filling rows first. */
export function gridShape(n) {
  if (n <= 0) return { cols: 0, rows: 0 };
  const cols = Math.ceil(Math.sqrt(n));
  return { cols, rows: Math.ceil(n / cols) };
}
