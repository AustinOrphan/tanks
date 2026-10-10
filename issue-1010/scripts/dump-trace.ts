// #1010: dump the REAL golden-trace text (tools/baseline/trace.ts's traceText) to a file, with
// arena-01 optionally swapped in-process for another state first. No replica of the trace loop:
// `ARENAS` is the validated ARENA_DEFS array, which is not frozen, so replacing element 0 makes
// the real traceText() run that arena-01. Nothing on disk in the tree changes.
//
//   --patch none   the tree's own data (base tree: must hash to BASELINE_HASH; edited tree: the new hash)
//   --patch base   arena-01 restored to BASE_REF's data (edited tree: must hash back to the OLD hash --
//                  the attribution control, in the style of trace.ts's "ATTRIBUTION IS EXACT" entries)
//   --patch brown|teal|grey   arena-01 as that candidate (base tree: the predicted new text)
//
//   cd <tree> && npx vite-node .../w1010/dump-trace.ts -- --patch none --out .../w1010/out/trace-<label>.txt
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ROOT, BASE_REF, arena01State, argValue } from './arena01.ts';

const { ARENAS } = await import(`${ROOT}/src/sim/arena.ts`);
const { traceText, sha256Hex, BASELINE_HASH, TRACE_SEEDS } = await import(`${ROOT}/tools/baseline/trace.ts`);

const patch = argValue('--patch', 'none');
const out = argValue('--out', '');
if (!out) throw new Error('--out <file> is required');
if (ARENAS[0].id !== 'arena-01') throw new Error(`ARENAS[0] is ${ARENAS[0].id}, not arena-01`);
const treeGrid = ARENAS[0].grid.join('\n');
if (patch !== 'none') ARENAS[0] = await arena01State(patch);

const started = Date.now();
const text: string = traceText();
const hash: string = await sha256Hex(text);
const markers = text.match(/\|\d+:\d+:(playing|win|lose):\d+\|/g) ?? [];
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, text);
console.log(JSON.stringify({
  root: ROOT, baseRef: BASE_REF, patch,
  arena01GridChangedByPatch: ARENAS[0].grid.join('\n') !== treeGrid,
  arenas: ARENAS.length, seeds: TRACE_SEEDS, markers: markers.length,
  length: text.length, hash, BASELINE_HASH, matchesBaselineHash: hash === BASELINE_HASH,
  seconds: (Date.now() - started) / 1000, out,
}, null, 1));
