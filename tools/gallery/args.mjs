/**
 * Argument parsing and label hygiene for the gallery runner, kept in its own module so it
 * is testable without a browser or ffmpeg.
 */
export const DEFAULTS = {
  elements: 'mine',
  /**
   * 'gallery' poses elements against a bare ground plane and frames them to their own
   * span. 'game' drives the REAL game and shoots its REAL camera.
   *
   * The second exists because the first has now disagreed with it three times running:
   * a close-up flatters every option, and the decision is always made at play distance.
   * It was hand-rolled five times before becoming a mode.
   */
  scene: 'gallery',
  /** ms to wait after starting the game before shooting. Covers COUNTDOWN_TICKS. */
  settle: 3800,
  /** WxH+X+Y crop applied to each frame, in captured pixels. Omit to keep the frame. */
  crop: null,
  /**
   * Query string appended in --scene game, e.g. 'dev=1&seed=42'.
   *
   * Pinning the seed is worth doing for a comparison: the game is LIVE while it is
   * being shot, so without it the tanks are in different places and shells are in
   * flight in some frames and not others -- differences that have nothing to do with
   * what is being swept. It does not make the frames identical (frame pacing still
   * varies), so treat it as reducing the noise, not removing it.
   */
  query: null,
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
  labels: null,
  label: true,
  /**
   * Sim clock multiplier for --scene game, 0 < slowmo <= 1. Scales BOTH clocks the
   * driver reads -- rAF callback timestamps and performance.now -- because driver.ts
   * takes its frame delta from the rAF timestamp and only seeds from now(). Scaling
   * performance.now alone was measured to be a dead knob.
   */
  slowmo: 1,
  /** Frames to shoot in --scene game, one per rAF. >1 needs no --anim; it IS the anim. */
  burst: 1,
};

const BOOLISH = ['anim', 'reach', 'timer', 'fill'];

/**
 * Variants are separated by `;`, and the constants WITHIN a variant by `|`.
 *
 *   --sweep MINE_Y --values "0.06;0.09"
 *   --sweep MINE_Y,MINE_BASE_H --values "0.06|(MINE_Y*2)/4; 0.09|(MINE_Y*2)/3"
 *
 * `|` rather than `,` because the values are code, and expressions like `(MINE_Y * 2) / 4`
 * contain no pipes but very easily contain commas.
 */
export function parseValues(raw) {
  // Convenience: with one constant and no structure markers, plain commas separate
  // variants -- `--values 0.04,0.08,0.12`. Once a `;` or `|` appears the explicit form
  // takes over, because an expression like `(MINE_Y * 2) / 4` may contain commas but
  // never contains those.
  const simple = !raw.includes(';') && !raw.includes('|');
  const chunks = simple ? raw.split(',') : raw.split(';');
  return chunks
    .map((v) => v.split('|').map((x) => x.trim()).filter(Boolean))
    .filter((v) => v.length > 0);
}
const NUMERIC = ['w', 'h', 'fps', 'subdiv', 'settle', 'slowmo', 'burst'];

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
    if (key === 'elements') out.elements = value;
    else if (key === 'values') out.values = parseValues(value);
    else if (key === 'sweep') out.sweep = value.split(',').map((s) => s.trim()).filter(Boolean);
    else if (key === 'labels') out.labels = value.split(';').map((s) => s.trim());
    else if (NUMERIC.includes(key)) {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new Error(`--${key} must be a number, got ${value}`);
      out[key] = n;
    } else if (key in DEFAULTS) out[key] = value;
    else throw new Error(`unknown flag --${key}`);
  }
  if (out.scene !== 'gallery' && out.scene !== 'game') {
    throw new Error(`--scene must be 'gallery' or 'game', got '${out.scene}'`);
  }
  if (out.crop !== null && !/^\d+x\d+\+\d+\+\d+$/.test(out.crop)) {
    throw new Error(`--crop must look like 640x480+100+50, got '${out.crop}'`);
  }
  if (out.scene === 'game' && out.anim) {
    // The game runs its own clock; there is no age to step. Recording gameplay is a
    // different job from stepping a pose, and pretending otherwise would silently
    // produce N identical frames. Recording gameplay is what --burst is for.
    throw new Error('--anim is not supported with --scene game (use --burst N)');
  }
  if (out.scene !== 'game' && (out.slowmo !== 1 || out.burst !== 1)) {
    // The gallery scene has no live clock to slow and steps poses explicitly.
    throw new Error('--slowmo and --burst only apply to --scene game');
  }
  if (out.slowmo <= 0 || out.slowmo > 1) {
    throw new Error(`--slowmo must be in (0, 1], got ${out.slowmo}`);
  }
  if (!Number.isInteger(out.burst) || out.burst < 1) {
    throw new Error(`--burst must be a whole number of frames, got ${out.burst}`);
  }
  if (out.burst > 1 && out.sweep) {
    // A sweep wants one comparable cell per variant; a burst wants a timeline of one
    // variant. Composing them would grid N timelines and satisfy neither.
    throw new Error('--burst cannot be combined with --sweep');
  }
  const animated = out.anim || out.burst > 1;
  if (animated && out.out.endsWith('.png')) {
    // The animated branch runs the GIF encoder unconditionally; pointing it at a .png
    // wrote gif-pipeline output into a .png filename. Refuse up front.
    throw new Error('animated output (--anim/--burst) needs a .gif --out, or a directory for raw frames');
  }
  if (animated && out.crop !== null) {
    // --crop is applied only when assembling a still grid; the animated branch never
    // crops. Accepting it here was a silent no-op knob -- the flag parsed, validated,
    // and did nothing.
    throw new Error('--crop is not applied to animated output; crop the frames or gif afterwards');
  }
  if (out.sweep && out.values.length === 0) throw new Error('--sweep needs --values');
  if (!out.sweep && out.values.length > 0) throw new Error('--values needs --sweep');
  if (out.sweep) {
    // Every variant must supply a value for every swept constant. Silently padding here
    // would leave one constant at whatever the previous variant set it to, which reads on
    // screen as a variant that did not change.
    for (const v of out.values) {
      if (v.length !== out.sweep.length) {
        throw new Error(
          `--sweep names ${out.sweep.length} constant(s) but a variant supplies ${v.length}: ${v.join(' | ')}`,
        );
      }
    }
    if (out.labels && out.labels.length !== out.values.length) {
      throw new Error(`--labels has ${out.labels.length} entries for ${out.values.length} variants`);
    }
  }
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
