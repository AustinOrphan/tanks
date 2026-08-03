// docs/superpowers/backlog.md quotes measurements. An earlier draft of it quoted a figure
// ("34.77%") that existed in no PR body and in no measurement -- it was fabricated during
// drafting, survived a self-review, and was caught only by an adversarial reader running
// `git log -S`. Nothing in the repo could have caught it, because prose is not checked.
//
// These are the checkable subset: numbers derived from committed data or from the file's
// own structure. Each is recomputed here and compared against the figure the file states,
// so the two cannot drift apart. Figures that depend on GitHub (how many merged PRs carry
// a residual heading) are deliberately NOT pinned -- they move on every merge, and the
// file says so instead of quoting a frozen number.
//
// CLAUDE.md's rule is "quote a measurement and you owe it a recomputing test". This is
// that debt for backlog.md.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import tracks from '../src/audio/data/music-tracks.json';
import suitesJson from '../src/audio/data/music-suites.json';

const BACKLOG = readFileSync(fileURLToPath(new URL('../docs/superpowers/backlog.md', import.meta.url)), 'utf8');
const CLAUDE_MD = readFileSync(fileURLToPath(new URL('../CLAUDE.md', import.meta.url)), 'utf8');
/** Both files hard-wrap, so any sentence-level match must ignore where the lines break. */
const FLAT_BACKLOG = BACKLOG.replace(/\s+/g, ' ');

/** Bullet counts per `###` subsection of the Ledger, in document order. */
function ledgerSections(): { title: string; bullets: number }[] {
  const ledger = BACKLOG.slice(BACKLOG.indexOf('## Ledger'));
  const out: { title: string; bullets: number }[] = [];
  for (const line of ledger.split('\n')) {
    if (line.startsWith('### ')) out.push({ title: line.slice(4), bullets: 0 });
    else if (out.length > 0 && line.startsWith('- ')) out[out.length - 1].bullets += 1;
  }
  return out;
}

describe('backlog.md quotes numbers it can still justify', () => {
  it('loads as text at all', () => {
    // Without this every `toContain` below passes vacuously on "".
    expect(BACKLOG.length).toBeGreaterThan(2000);
    expect(BACKLOG).toContain('## Ledger');
  });

  // These two cases deliberately pin NO absolute number. The section counts are the file
  // describing itself, not a measurement of the world, so freezing them here would make
  // every legitimate backlog edit -- adding a line, or closing one, which CLAUDE.md now
  // REQUIRES -- also an edit to this file's expected values. That trains the one habit
  // that defeats guards: repairing a red build by changing what the test expects. It is
  // also what made CLAUDE.md's "removing a line fails the build until the header agrees"
  // false when first written; with literals here, fixing the header left it red.
  //
  // So: parse the header's own claim and compare it to the list. Update the prose, go
  // green. The numbers that ARE pinned as literals below are the ones measuring committed
  // DATA, where a frozen value is the point.
  it('states its own section counts correctly', () => {
    const counts = ledgerSections().filter((s) => s.bullets > 0).map((s) => s.bullets);
    const total = counts.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(0); // else an empty parse would satisfy everything below

    const stated = /Counts: \*\*(\d+) lines below\*\* — ([\d/ ]+?) across/.exec(FLAT_BACKLOG);
    expect(stated, 'the Counts sentence must exist and keep its shape').not.toBeNull();
    expect(Number(stated![1])).toBe(total);
    expect(stated![2].trim()).toBe(counts.join(' / '));
  });

  it('states how many lines came from outside the harvested scope', () => {
    const ledger = BACKLOG.slice(BACKLOG.indexOf('## Ledger'));
    const bullets = ledger.split('\n').filter((l) => l.startsWith('- '));
    const prose = bullets.filter((l) => l.includes('prose-only PR')).length;
    expect(bullets.length).toBeGreaterThan(0);

    // The scope claim is the one review falsified last time: the harvest covered PRs with
    // a residual HEADING, and these are the spot-checked extras. An unmarked out-of-scope
    // line silently makes the split wrong.
    const stated = /\*\*(\d+)\*\* came from the 21 PRs in scope and \*\*(\d+)\*\* from prose-only/.exec(FLAT_BACKLOG);
    expect(stated, 'the in-scope/prose-only split sentence must exist').not.toBeNull();
    expect(Number(stated![1])).toBe(bullets.length - prose);
    expect(Number(stated![2])).toBe(prose);

    // "Where the numbers went" restates the in-scope figure. Both must move together, or
    // the file contradicts itself with the build green -- which is the defect this whole
    // test file exists to prevent.
    const restated = /became the \*\*(\d+)\*\* in-scope lines above/.exec(FLAT_BACKLOG);
    expect(restated, 'the restatement in "Where the numbers went" must exist').not.toBeNull();
    expect(Number(restated![1])).toBe(bullets.length - prose);
  });

  it('states the same harvest figures in CLAUDE.md and backlog.md', () => {
    // CLAUDE.md argues the delete-when-you-close rule from "147 harvested, 63 already
    // done, 43%". backlog.md is where those came from. Two files quoting one measurement
    // is how they drift -- and a stale 43% would be arguing from a number that no longer
    // holds, in the file whose whole job is to be believed.
    const enumerated = /(\d+) items were enumerated/.exec(BACKLOG)?.[1];
    const closed = /(\d+) were already closed by later work/.exec(BACKLOG)?.[1];
    expect(enumerated).toBe('147');
    expect(closed).toBe('63');
    // Both files hard-wrap their prose, so a sentence spans lines and an exact substring
    // match breaks on re-wrapping rather than on a wrong number. Collapse whitespace first:
    // the first draft of this test did not, and failed on the line break inside the very
    // sentence it was checking.
    const flat = CLAUDE_MD.replace(/\s+/g, ' ');
    expect(flat).toContain(`${enumerated} deferred items harvested`);
    expect(flat).toContain(`**${closed} were already done**`);
    // And the percentage CLAUDE.md rounds to must be the one those two produce.
    const pct = Math.round((Number(closed) / Number(enumerated)) * 100);
    expect(flat).toContain(`${pct}% of what read as a backlog`);
  });

  it('recomputes "13 of 42" generated layers at density >= 0.5', () => {
    // melody.ts gates a step on `rnd() < spec.density * 2`, so any density >= 0.5 makes the
    // predicate unconditionally true. The count changes whenever a layer is authored.
    const generated = tracks.flatMap((t) => t.tracks).filter((l) => l.generate);
    const inert = generated.filter((l) => (l.generate as { density: number }).density >= 0.5);
    expect(generated).toHaveLength(42);
    expect(inert).toHaveLength(13);
    expect(BACKLOG).toContain('**13 of 42**');
  });

  it('recomputes "25 of 31" tracks reachable from a suite', () => {
    // A track no suite names cannot be selected by the game. Adding a suite, or adding a
    // track to one, silently invalidates the quoted figure -- which is the whole risk.
    // music-suites.json is a bare ARRAY, not `{ suites: [...] }` -- the first draft of this
    // test assumed the wrapper and threw, which is the cheapest possible proof it reads
    // the real file rather than a shape someone imagined.
    const suites = suitesJson as { members: string[] }[];
    const named = new Set(suites.flatMap((s) => s.members));
    const ids = tracks.map((t) => t.id);
    const reachable = ids.filter((id) => named.has(id));
    expect(ids).toHaveLength(31);
    expect(reachable).toHaveLength(25);
    expect(BACKLOG).toContain('**25 of 31**');
    // Name the unreachable set too: the ledger lists them, and a rename should fail here.
    const orphans = ids.filter((id) => !named.has(id)).sort();
    expect(orphans).toEqual(['blitz', 'dread', 'hunt', 'siege', 'standoff', 'triumph']);
    for (const o of orphans) expect(BACKLOG).toContain(o);
  });
});
