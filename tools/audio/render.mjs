#!/usr/bin/env node
/**
 * `npm run audio` -- listen to the game's sounds without launching the game.
 *
 * The visual equivalent (`npm run gallery`) has existed for a while; audio had
 * nothing, so iterating on a tune meant starting the game and waiting for the
 * right moment. This renders through a real OfflineAudioContext in headless
 * chromium (node has no Web Audio) and writes a .wav.
 *
 * It imports the REAL modules through vite. A preview that reimplemented the
 * synth would be worse than no preview at all: you would tune against a lie.
 *
 *   npm run audio -- --track arena --seconds 30
 *   npm run audio -- --sfx explosion
 *   npm run audio -- --sfx all
 *   npm run audio -- --list
 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = Number(process.env.AUDIO_TOOL_PORT ?? 5210);
const OUT_DIR = resolve(ROOT, 'audio-out');

function parseArgs(argv) {
  const args = { seconds: null, track: null, sfx: null, list: false, out: null, loop: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') args.list = true;
    else if (a === '--track') args.track = argv[++i];
    else if (a === '--sfx') args.sfx = argv[++i];
    else if (a === '--seconds') args.seconds = Number(argv[++i]);
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--loop') args.loop = true;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
// Numeric flags: a missing or non-numeric value used to reach
// OfflineAudioContext and surface as a stack trace about frame counts.
for (const [flag, value] of Object.entries(args)
  .filter(([k]) => ['seconds', 'intensity', 'seed'].includes(k))
  .map(([k, v]) => [`--${k}`, v])) {
  if (value !== null && value !== undefined && !Number.isFinite(value)) {
    console.error(`${flag} needs a number, got ${JSON.stringify(value)}`);
    process.exit(2);
  }
}
if (!args.list && !args.track && !args.sfx) {
  console.error(
    'usage: npm run audio -- [--list] [--track <id> [--seconds N]] [--sfx <key|all>] [--out file.wav]',
  );
  process.exit(2);
}

async function respondsOn(url) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1000) });
    return true;
  } catch {
    return false;
  }
}

// Same resolution order as tools/gl/run.mjs: an explicit module, then whatever
// npm has installed.
async function loadChromium() {
  const tried = [];
  for (const spec of [process.env.PLAYWRIGHT_MODULE, 'playwright'].filter(Boolean)) {
    try {
      return (await import(spec)).chromium;
    } catch (e) {
      tried.push(`${spec}: ${e.message}`);
    }
  }
  console.error(`could not load playwright.\n${tried.join('\n')}`);
  process.exit(1);
}

const base = `http://localhost:${PORT}/`;
let vite = null;
let browser = null;
try {
  if (!(await respondsOn(base))) {
    vite = spawn(resolve(ROOT, 'node_modules/.bin/vite'), ['--port', String(PORT), '--strictPort'], {
      cwd: ROOT,
      stdio: 'ignore',
    });
    const deadline = Date.now() + 30000;
    while (!(await respondsOn(base))) {
      if (vite.exitCode !== null) throw new Error(`vite exited ${vite.exitCode}`);
      if (Date.now() > deadline) throw new Error('vite did not start');
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  const chromium = await loadChromium();
  browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('page error:', String(e)));
  await page.goto(base, { waitUntil: 'domcontentloaded' });

  const result = await page.evaluate(async (opts) => {
    const { synthVoice } = await import('/src/audio/synth.ts');
    const { createMusicBed } = await import('/src/audio/music.ts');
    const { MUSIC_TRACKS, trackById } = await import('/src/audio/music-data.ts');
    const RATE = 44100;

    if (opts.list) {
      return {
        list: MUSIC_TRACKS.map((t) => ({
          id: t.id,
          stepSeconds: t.stepSeconds,
          layers: t.tracks.map((l) => `${l.voice}:${l.notes.length}`),
        })),
      };
    }

    const toWav = (buf) => {
      const frames = buf.length;
      const bytes = frames * 2;
      const ab = new ArrayBuffer(44 + bytes);
      const v = new DataView(ab);
      const str = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
      str(0, 'RIFF'); v.setUint32(4, 36 + bytes, true); str(8, 'WAVE');
      str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
      v.setUint16(22, 1, true); v.setUint32(24, buf.sampleRate, true);
      v.setUint32(28, buf.sampleRate * 2, true); v.setUint16(32, 2, true);
      v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, bytes, true);
      const data = buf.getChannelData(0);
      let o = 44;
      let peak = 0;
      for (let i = 0; i < frames; i++) {
        const s = Math.max(-1, Math.min(1, data[i]));
        peak = Math.max(peak, Math.abs(s));
        v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        o += 2;
      }
      let bin = '';
      const u8 = new Uint8Array(ab);
      for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
      return { data: btoa(bin), peak };
    };

    if (opts.sfx) {
      const KEYS = ['cannon', 'cannon-enemy', 'ping', 'explosion', 'mine-drop',
                    'mine-arm', 'mine-boom', 'victory', 'defeat'];
      const keys = opts.sfx === 'all' ? KEYS : [opts.sfx];
      for (const k of keys) if (!KEYS.includes(k)) return { error: `unknown sfx "${k}". known: ${KEYS.join(', ')}` };
      const span = opts.sfx === 'all' ? keys.length * 0.9 + 1 : 1.4;
      const ctx = new OfflineAudioContext(1, Math.floor(RATE * span), RATE);
      keys.forEach((k, i) => synthVoice(ctx, ctx.destination, k, 0.15 + i * 0.9, { volume: 0.9 }));
      return { wav: toWav(await ctx.startRendering()), label: `sfx-${opts.sfx}` };
    }

    const track = trackById(opts.track);
    if (!track) {
      return { error: `unknown track "${opts.track}". known: ${MUSIC_TRACKS.map((t) => t.id).join(', ')}` };
    }
    // The true period is the LCM of the layer lengths, not the max. The
    // scheduler deliberately lets layers differ (a 4-step bass under a 6-step
    // lead repeats every 12, not every 6), so exporting `max` put the bass on
    // the wrong half of its cycle on every repeat -- and the seam check happily
    // called that "seamless", because each individual sample still lined up.
    const gcd = (a, b) => (b ? gcd(b, a % b) : a);
    const lcm = (a, b) => (a / gcd(a, b)) * b;
    const steps = track.tracks.map((l) => l.notes.length);
    const loopSteps = steps.reduce(lcm, 1);
    const loopSeconds = loopSteps * track.stepSeconds;
    // --loop renders EXACTLY one cycle and folds the ring-out back over the
    // start, so the file itself loops seamlessly. Without that the tail is
    // simply cut and repeating the file clicks -- the in-game bed never
    // restarts, so this is an artefact of rendering, not of the music.
    // Long enough for the longest ring-out to finish, derived rather than
    // guessed: a hold of 8 steps at 0.5s/step needs 4s on its own, and a fixed
    // budget silently truncated it.
    const { VOICES } = await import('/src/audio/music-data.ts');
    const longestHold = Math.max(...track.tracks.map((l) => VOICES[l.voice].hold));
    const TAIL = longestHold * track.stepSeconds + 0.5;
    const seconds = opts.loop ? loopSeconds + TAIL : (opts.seconds ?? 30);
    const ctx = new OfflineAudioContext(1, Math.floor(RATE * seconds), RATE);
    let pump = null;
    const bed = createMusicBed(ctx, ctx.destination, {
      setInterval: (fn) => { pump = fn; return 0; },
      clearInterval: () => {},
      track,
    });
    bed.setVolume(0.9);
    bed.start();
    // Register every suspend BEFORE rendering: offline rendering outruns an
    // await-one-at-a-time loop and suspend() then rejects for a passed frame.
    for (let t = 0.4; t < seconds - 0.4; t += 0.4) {
      ctx.suspend(t).then(() => { if (pump) pump(); ctx.resume(); });
    }
    const rendered = await ctx.startRendering();
    if (!opts.loop) return { wav: toWav(rendered), label: `track-${track.id}` };

    // Fold: everything past one cycle is the tail of notes that started inside
    // it, which is exactly what would be sounding as the loop comes round again.
    const rate = rendered.sampleRate;
    const loopFrames = Math.round(loopSeconds * rate);
    const src = rendered.getChannelData(0);
    const out = new Float32Array(loopFrames);
    out.set(src.subarray(0, loopFrames));
    // Modulo accumulate, not a single wrap: the old `i < loopFrames` bound threw
    // away everything past 2x the loop. On a short loop with a long pad that was
    // 61% of the tail's energy, at full amplitude -- and the tool then blamed
    // the music for the click its own arithmetic had created.
    for (let i = loopFrames; i < src.length; i++) out[i % loopFrames] += src[i];
    const looped = new OfflineAudioContext(1, loopFrames, rate).createBuffer(1, loopFrames, rate);
    looped.getChannelData(0).set(out);
    // Report the seam: the step across the wrap point, in the same units as the
    // signal. A perfect loop has a discontinuity no larger than the waveform's
    // own sample-to-sample motion.
    const seam = Math.abs(out[0] - out[loopFrames - 1]);
    let typical = 0;
    for (let i = 1; i < Math.min(4000, loopFrames); i++) typical = Math.max(typical, Math.abs(out[i] - out[i - 1]));
    return { wav: toWav(looped), label: `track-${track.id}-loop`, seam, typical, loopSeconds };
  }, args);

  if (result.error) {
    console.error(result.error);
    process.exitCode = 1;
  } else if (result.list) {
    console.log('tracks in src/audio/data/music-tracks.json:\n');
    for (const t of result.list) {
      console.log(`  ${t.id.padEnd(12)} step ${t.stepSeconds}s   layers: ${t.layers.join(', ')}`);
    }
  } else {
    mkdirSync(OUT_DIR, { recursive: true });
    const file = args.out ? resolve(args.out) : resolve(OUT_DIR, `${result.label}.wav`);
    writeFileSync(file, Buffer.from(result.wav.data, 'base64'));
    // Peak is reported so silence is obvious without opening the file -- a
    // preview that quietly writes 30s of nothing is worse than an error.
    console.log(`wrote ${file}  (peak ${result.wav.peak.toFixed(3)})`);
    if (result.seam !== undefined) {
      const verdict = result.seam <= result.typical ? 'seamless' : 'AUDIBLE STEP';
      console.log(
        `  loop ${result.loopSeconds.toFixed(2)}s  seam ${result.seam.toExponential(2)} ` +
          `vs typical sample step ${result.typical.toExponential(2)}  -> ${verdict}`,
      );
    }
    if (result.wav.peak < 1e-3) {
      console.error('WARNING: that render is silent.');
      process.exitCode = 1;
    }
  }
} finally {
  if (browser) await browser.close().catch(() => {});
  if (vite) vite.kill();
}
