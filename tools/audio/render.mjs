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
 *   npm run audio -- --arms all      # every #516 blocked-fire audio arm, in order
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
  const args = { seconds: null, track: null, sfx: null, arms: null, list: false, out: null, loop: false, intensity: null, seed: null, suite: null, chain: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') args.list = true;
    else if (a === '--track') args.track = argv[++i];
    else if (a === '--sfx') args.sfx = argv[++i];
    else if (a === '--arms') args.arms = argv[++i];
    else if (a === '--seconds') args.seconds = Number(argv[++i]);
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--loop') args.loop = true;
    else if (a === '--intensity') args.intensity = Number(argv[++i]);
    else if (a === '--seed') args.seed = Number(argv[++i]);
    else if (a === '--suite') args.suite = argv[++i];
    else if (a === '--chain') args.chain = argv[++i];
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
if (!args.list && !args.track && !args.sfx && !args.arms && !args.suite && !args.chain) {
  console.error(
    'usage: npm run audio -- [--list] [--track <id> [--seconds N]] [--sfx <key|all>] [--arms <cue|all>] [--out file.wav]',
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
          layers: t.tracks.map(
            (l) => `${l.voice}:${l.notes ? l.notes.length : 'gen'}${l.intensity ? `@${l.intensity}` : ''}`,
          ),
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
                    'mine-arm', 'mine-boom', 'fire-blocked', 'fire-blocked-click', 'victory', 'defeat'];
      const keys = opts.sfx === 'all' ? KEYS : [opts.sfx];
      for (const k of keys) if (!KEYS.includes(k)) return { error: `unknown sfx "${k}". known: ${KEYS.join(', ')}` };
      const span = opts.sfx === 'all' ? keys.length * 0.9 + 1 : 1.4;
      const ctx = new OfflineAudioContext(1, Math.floor(RATE * span), RATE);
      keys.forEach((k, i) => synthVoice(ctx, ctx.destination, k, 0.15 + i * 0.9, { volume: 0.9 }));
      return { wav: toWav(await ctx.startRendering()), label: `sfx-${opts.sfx}` };
    }

    // --chain: play one track from each named SUITE in turn, entering every
    // suite after the first through its dominant with the tempo ramping. The
    // cross-set join is the thing that has to be judged by ear.
    if (opts.arms) {
      // Every #516 audio arm, rendered from the SAME table the director plays them from
      // (`BLOCKED_FIRE_ARMS` in src/audio/director.ts) rather than a second copy of the
      // rates and gains here -- a preview that restated them could drift from the game,
      // which is the one thing a preview must never do.
      const { BLOCKED_FIRE_ARMS, BLOCKED_FIRE_BASELINE } = await import('/src/audio/director.ts');
      const { BLOCKED_FIRE_CUES, cueDrives } = await import('/src/presentation/blocked-fire.ts');
      const arms = [...BLOCKED_FIRE_CUES].filter((c) => cueDrives(c, 'audio'));
      const voiceOf = (arm) => BLOCKED_FIRE_ARMS[arm] ?? BLOCKED_FIRE_BASELINE;
      const sig = (arm) => JSON.stringify([voiceOf(arm).key, voiceOf(arm).opts ?? null]);
      // `all` renders each distinct VOICE once. The multimodal cues drive audio too, but
      // through the baseline voice, so listing them would render the same sound three
      // times and read as three arms; they stay selectable by name.
      const seen = new Set();
      const distinct = arms.filter((a) => !seen.has(sig(a)) && seen.add(sig(a)));
      const one = opts.arms === 'all' ? distinct : [opts.arms];
      for (const a of one) if (!arms.includes(a)) return { error: `unknown audio arm "${a}". known: ${arms.join(', ')}` };
      const span = one.length * 0.9 + 1;
      const ctx = new OfflineAudioContext(1, Math.floor(RATE * span), RATE);
      one.forEach((arm, i) => {
        const voice = voiceOf(arm);
        // `volume` in a voice is a MULTIPLIER -- engine.ts plays it as
        // `VOICE_GAIN * masterVolume * (opts.volume ?? 1)` -- so it scales the preview's
        // base gain rather than replacing it. Overwriting instead rendered `thunk-soft`
        // at 0.3 where the game plays it at 0.9 * 0.3, which is exactly the drift this
        // mode reads the director's own table to avoid.
        synthVoice(ctx, ctx.destination, voice.key, 0.15 + i * 0.9, {
          rate: voice.opts?.rate,
          volume: 0.9 * (voice.opts?.volume ?? 1),
        });
      });
      const shared = arms.filter((a) => !one.includes(a) && one.some((b) => sig(b) === sig(a)));
      return {
        wav: toWav(await ctx.startRendering()),
        label: `arms-${opts.arms}`,
        note: one.join(' -> ') + (shared.length ? ` (same voice as: ${shared.join(', ')})` : ''),
      };
    }

    if (opts.chain) {
      const { suiteById, membersOf } = await import('/src/audio/suites.ts');
      const ids = opts.chain.split(',').map((x) => x.trim());
      const suites = ids.map(suiteById);
      const missing = ids.filter((id, i) => !suites[i]);
      if (missing.length) return { error: `unknown suite(s): ${missing.join(', ')}` };
      const cycleOf = (t) => {
        const lens = t.tracks.map((l) => (l.notes ? l.notes.length : t.barSteps * t.chords.length));
        const gcd = (a, b) => (b ? gcd(b, a % b) : a);
        return lens.reduce((a, b) => (a / gcd(a, b)) * b, 1);
      };
      const picks = suites.map((s, i) => membersOf(s)[i % membersOf(s).length]);
      // Budget for the join. Under the v5 transition nothing is invented to
      // bridge with: the incoming piece's OWN final bar is played as a pickup,
      // so a join costs exactly one bar of whatever is arriving. (This read
      // TRANS_STEPS, a constant the v5 rewrite deleted, so --chain has thrown
      // ReferenceError ever since -- the tool for auditioning joins could not
      // render one.)
      let seconds = 2;
      for (let i = 0; i < picks.length; i++) {
        seconds += cycleOf(picks[i]) * picks[i].stepSeconds;
        if (i > 0) seconds += picks[i].barSteps * picks[i].stepSeconds;
      }
      const ctx = new OfflineAudioContext(1, Math.floor(RATE * seconds), RATE);
      let pump = null;
      const bed = createMusicBed(ctx, ctx.destination, {
        setInterval: (fn) => { pump = fn; return 0; },
        clearInterval: () => {},
        track: picks[0],
        seed: opts.seed ?? undefined,
      });
      bed.setVolume(0.9);
      if (opts.intensity !== null) bed.setIntensity(opts.intensity);
      bed.start();
      const marks = [];
      let elapsed = cycleOf(picks[0]) * picks[0].stepSeconds;
      for (let i = 1; i < picks.length; i++) {
        marks.push({ at: elapsed, id: `${suites[i].id} (via its own final bar)` });
        // The pickup bar's span, for the timeline estimate only.
        elapsed += picks[i].barSteps * ((picks[i - 1].stepSeconds + picks[i].stepSeconds) / 2);
        elapsed += cycleOf(picks[i]) * picks[i].stepSeconds;
      }
      let next = 1;
      for (let t = 0.4; t < seconds - 0.4; t += 0.4) {
        ctx.suspend(t).then(() => {
          if (next < picks.length && t >= marks[next - 1].at - 1.5) {
            bed.changeSuite(picks[next]);
            next += 1;
          }
          if (pump) pump();
          ctx.resume();
        });
      }
      return { wav: toWav(await ctx.startRendering()), label: `chain-${ids.join('-')}`, marks };
    }

    // --suite: play several tracks back to back through the real bed, switching
    // at cycle boundaries. This is the thing that has to be judged by ear, so
    // the tool has to produce it rather than describe it.
    if (opts.suite) {
      const ids = opts.suite.split(',');
      const chosen = ids.map((id) => trackById(id.trim()));
      const missing = ids.filter((id, i) => !chosen[i]);
      if (missing.length) return { error: `unknown track(s): ${missing.join(', ')}` };
      const cycleOf = (t) => {
        const lens = t.tracks.map((l) => (l.notes ? l.notes.length : t.barSteps * t.chords.length));
        const gcd = (a, b) => (b ? gcd(b, a % b) : a);
        return lens.reduce((a, b) => (a / gcd(a, b)) * b, 1);
      };
      // The boundary switch is only clean when members share the interchange
      // contract; real suites are validated, but this flag takes arbitrary ids.
      // Preview flexibility is kept -- with the mismatch SAID, not silent.
      const first = chosen[0];
      for (const t of chosen.slice(1)) {
        if (t.stepSeconds !== first.stepSeconds || t.chords.join() !== first.chords.join()) {
          console.error(
            `WARNING: "${t.id}" does not share ${first.id}'s tempo/progression -- this join will jar (that may be what you are testing)`,
          );
        }
      }
      const seconds = chosen.reduce((acc, t) => acc + cycleOf(t) * t.stepSeconds, 0) + 2;
      const ctx = new OfflineAudioContext(1, Math.floor(RATE * seconds), RATE);
      let pump = null;
      const bed = createMusicBed(ctx, ctx.destination, {
        setInterval: (fn) => { pump = fn; return 0; },
        clearInterval: () => {},
        track: chosen[0],
        seed: opts.seed ?? undefined,
      });
      bed.setVolume(0.9);
      if (opts.intensity !== null) bed.setIntensity(opts.intensity);
      bed.start();
      // Queue each next member; the bed adopts it at the boundary on its own.
      const marks = [];
      let elapsed = 0;
      for (let i = 1; i < chosen.length; i++) {
        elapsed += cycleOf(chosen[i - 1]) * chosen[i - 1].stepSeconds;
        marks.push({ at: elapsed, id: chosen[i].id });
      }
      let next = 0;
      for (let t = 0.4; t < seconds - 0.4; t += 0.4) {
        ctx.suspend(t).then(() => {
          while (next < marks.length && t >= marks[next].at - 1.2) {
            bed.queueTrack(chosen[next + 1]);
            next += 1;
          }
          if (pump) pump();
          ctx.resume();
        });
      }
      return {
        wav: toWav(await ctx.startRendering()),
        label: `suite-${ids.map((s) => s.trim()).join('-')}`,
        marks,
      };
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
    // A GENERATED layer has no authored notes; its cycle is the progression.
    const steps = track.tracks.map((l) =>
      l.notes ? l.notes.length : track.barSteps * track.chords.length,
    );
    const loopSteps = steps.reduce(lcm, 1);
    const loopSeconds = loopSteps * track.stepSeconds;
    // --loop renders TWO cycles and keeps the SECOND: its head already carries
    // the previous cycle's ring-out, exactly as continuous playback sounds.
    // Review killed the previous fold approach twice over -- first it discarded
    // tail energy, then (fixed with a modulo) it ADDED next-cycle onsets on top
    // of the head, running the first ~2s of every loop +2.7dB hot while the
    // seam check printed "seamless". Steady-state extraction has neither
    // problem, because nothing is synthesised or summed at all.
    const seconds = opts.loop ? loopSeconds * 2 + 0.5 : (opts.seconds ?? 30);
    const ctx = new OfflineAudioContext(1, Math.floor(RATE * seconds), RATE);
    let pump = null;
    const bed = createMusicBed(ctx, ctx.destination, {
      setInterval: (fn) => { pump = fn; return 0; },
      clearInterval: () => {},
      track,
      seed: opts.seed ?? undefined,
    });
    bed.setVolume(0.9);
    // The arrangement the game would play at that moment: layers gate in and out.
    if (opts.intensity !== null) bed.setIntensity(opts.intensity);
    bed.start();
    // Register every suspend BEFORE rendering: offline rendering outruns an
    // await-one-at-a-time loop and suspend() then rejects for a passed frame.
    for (let t = 0.4; t < seconds - 0.4; t += 0.4) {
      ctx.suspend(t).then(() => { if (pump) pump(); ctx.resume(); });
    }
    const rendered = await ctx.startRendering();
    if (!opts.loop) return { wav: toWav(rendered), label: `track-${track.id}${opts.intensity !== null ? `-i${opts.intensity}` : ''}` };

    // Steady state: skip the first cycle, keep the second.
    const rate = rendered.sampleRate;
    const loopFrames = Math.round(loopSeconds * rate);
    const src = rendered.getChannelData(0);
    const out = new Float32Array(loopFrames);
    out.set(src.subarray(loopFrames, loopFrames * 2));
    const looped = new OfflineAudioContext(1, loopFrames, rate).createBuffer(1, loopFrames, rate);
    looped.getChannelData(0).set(out);
    // The seam: the step from the loop's end back to its own head. For authored
    // tracks steady-state cycles are identical so this is near-zero; a track
    // with GENERATED layers varies per cycle, so its "loop" is one snapshot and
    // the seam is reported honestly rather than assumed.
    const seam = Math.abs(out[0] - out[loopFrames - 1]);
    let typical = 0;
    for (let i = 1; i < Math.min(4000, loopFrames); i++) typical = Math.max(typical, Math.abs(out[i] - out[i - 1]));
    return { wav: toWav(looped), label: `track-${track.id}${opts.intensity !== null ? `-i${opts.intensity}` : ''}-loop`, seam, typical, loopSeconds };
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
    // Which arms are actually in the file, and which cues share a voice with them: an
    // `--arms all` render is otherwise five unlabelled thumps in a row.
    if (result.note) console.log(`  ${result.note}`);
    if (result.marks) {
      console.log(`  switches at: ${result.marks.map((m) => `${m.at.toFixed(2)}s -> ${m.id}`).join(', ')}`);
    }
    if (result.seam !== undefined) {
      // An absolute floor as well as the relative one: a generated track's loop
      // is one snapshot of a varying piece, so its wrap differs from its head by
      // a few parts in ten thousand -- around -74dBFS, far below audibility --
      // while the local "typical step" in a quiet head is smaller still. The
      // relative test alone called that an AUDIBLE STEP, which is false.
      const verdict = result.seam <= Math.max(result.typical, 1e-3) ? 'seamless' : 'AUDIBLE STEP';
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
