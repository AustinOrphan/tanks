// #1010: confine a golden-trace move to one arena by direct comparison of two dumps, the method
// tools/baseline/trace.ts used for #424 and #425 (startsWith cannot be the evidence when the
// changed arena is not last).
//
//   node .../w1010/compare-trace.mjs <old.txt> <new.txt> [--arena 0] [--arenas 9] [--seeds 6]
//
// Checks, each printed with its numbers; exits 1 if any fails:
//   1. both dumps carry arenas x seeds markers (54 = 9 x 6), in order a:1..seeds per arena;
//   2. every marker outside --arena is byte-identical, old to new;
//   3. the text before --arena's first run (empty for arena 0) is byte-identical;
//   4. the text after --arena's last marker is byte-identical (length reported);
//   5. so the first differing character lies inside --arena's own section.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const [oldPath, newPath] = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !all[i - 1]?.startsWith('--'));
const opt = (name, d) => { const i = process.argv.indexOf(name); return i >= 0 ? Number(process.argv[i + 1]) : d; };
const A = opt('--arena', 0);
const ARENAS = opt('--arenas', 9);
const SEEDS = opt('--seeds', 6);
const oldText = readFileSync(oldPath, 'utf8');
const newText = readFileSync(newPath, 'utf8');
const sha = (t) => createHash('sha256').update(t, 'utf8').digest('hex');

function markers(text) {
  const re = /\|(\d+):(\d+):(playing|win|lose):(\d+)\|/g;
  const out = [];
  for (let m; (m = re.exec(text)); ) {
    out.push({ a: +m[1], seed: +m[2], status: m[3], tick: +m[4], start: m.index, end: m.index + m[0].length, raw: m[0] });
  }
  return out;
}
const mo = markers(oldText);
const mn = markers(newText);
const fails = [];
const say = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) fails.push(msg); };

const expected = ARENAS * SEEDS;
say(mo.length === expected && mn.length === expected, `markers: old ${mo.length}, new ${mn.length}, expected ${expected} (${ARENAS} arenas x ${SEEDS} seeds)`);
const ordered = (ms) => ms.every((m, i) => m.a === Math.floor(i / SEEDS) && m.seed === (i % SEEDS) + 1);
say(ordered(mo) && ordered(mn), 'markers run arena-major, seeds 1..6 within each arena, in both dumps');

const differing = mo.map((m, i) => [m, mn[i]]).filter(([o, n]) => n && o.raw !== n.raw);
const outside = differing.filter(([o]) => o.a !== A);
say(outside.length === 0, `markers that differ outside arena ${A}: ${outside.length}`);
console.log(`     markers that differ inside arena ${A}: ${differing.length - outside.length} of ${SEEDS}`);
for (const [o, n] of differing) console.log(`       ${o.raw} -> ${n.raw}`);
const changedOutcome = differing.filter(([o, n]) => o.status !== n.status).length;
console.log(`     outcome (status) changed in ${changedOutcome} of ${differing.length} differing runs`);

const sectionStart = (ms) => (A === 0 ? 0 : ms[A * SEEDS - 1].end);
const sectionEnd = (ms) => ms[A * SEEDS + SEEDS - 1].end;
const headOld = oldText.slice(0, sectionStart(mo));
const headNew = newText.slice(0, sectionStart(mn));
say(headOld === headNew, `text before arena ${A}'s first run byte-identical: ${headOld.length} characters`);
const tailOld = oldText.slice(sectionEnd(mo));
const tailNew = newText.slice(sectionEnd(mn));
say(tailOld === tailNew, `text after arena ${A}'s last marker byte-identical: old ${tailOld.length}, new ${tailNew.length} characters; sha256 ${sha(tailOld).slice(0, 16)} / ${sha(tailNew).slice(0, 16)}`);

let first = 0;
while (first < oldText.length && first < newText.length && oldText[first] === newText[first]) first++;
const runAt = (ms, idx) => { const m = ms.find((x) => x.end > idx); return m ? `${m.a}:${m.seed}` : 'end'; };
say(first >= sectionStart(mo) && first < sectionEnd(mo), `first differing character at ${first} (inside run ${runAt(mo, first)} of the old dump)`);

const secLen = (ms, text, a) => (a === 0 ? ms[SEEDS - 1].end : ms[a * SEEDS + SEEDS - 1].end - ms[a * SEEDS - 1].end);
console.log(`     arena ${A} section: old ${secLen(mo, oldText, A)}, new ${secLen(mn, newText, A)} characters`);
console.log(`     total length: old ${oldText.length}, new ${newText.length} (${newText.length - oldText.length >= 0 ? '+' : ''}${newText.length - oldText.length})`);
console.log(`     old sha256 ${sha(oldText)}`);
console.log(`     new sha256 ${sha(newText)}`);
console.log(`     newText.startsWith(oldText): ${newText.startsWith(oldText)} (expected false: arena ${A} is not last)`);
process.exit(fails.length ? 1 : 0);
