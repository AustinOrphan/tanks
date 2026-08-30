import { describe, it, expect, beforeAll } from 'vitest';
import { createHash } from 'node:crypto';
import { ARENAS } from '../../src/sim/arena';
import {
  BASELINE_HASH,
  TRACE_SEEDS,
  sha256Hex,
  traceText,
} from './trace';

/**
 * The Node half of the golden trace. The body now lives in ./trace.ts so a browser can
 * run the identical code (tools/baseline/run.mjs, tools/baseline/page.html) -- see that
 * module's header for why, and for what this fingerprint does and does not cover.
 *
 * This file's job is three assertions, each of which can fail on its own:
 *   1. the fingerprint still equals BASELINE_HASH -- the behaviour pin;
 *   2. the trace really ran every (arena, seed) pair, so the pin has the population it
 *      claims rather than an early return's;
 *   3. sha256Hex (Web Crypto, the only hashing a browser can do here) agrees with
 *      node:crypto -- the extraction swapped the hash implementation, and if that swap
 *      were wrong the browser runner would report a mismatch that had nothing to do with
 *      the engine's floating point, which is the exact confusion it exists to avoid.
 */

let text: string;
let hash: string;

beforeAll(async () => {
  text = traceText();
  hash = await sha256Hex(text);
}, 300_000);

describe('baseline', () => {
  it('fingerprint', () => {
    console.log(`BASELINE ${hash}`);
    expect(hash).toBe(BASELINE_HASH);
  });

  it('covers every shipped arena at every seed', () => {
    // One `|a:seed:status:tick|` marker is appended per run, after the tick loop, so the
    // count states the fingerprint's POPULATION out loud: 6 shipped arenas x 6 seeds.
    //
    // Deliberately against LITERALS, not against TRACE_SEEDS: written as
    // `ARENAS.length * TRACE_SEEDS` this test moved with the constant and could not fail
    // (measured -- TRACE_SEEDS 6 -> 3 left it green). It adds nothing to the hash on its
    // own, since any change of scope moves the hash too. What it catches is the failure
    // mode this repo has recorded: someone narrows the trace, sees red, and RE-RECORDS
    // the hash. That goes green above and red here.
    const markers = text.match(/\|\d+:\d+:(playing|win|lose):\d+\|/g) ?? [];
    expect(TRACE_SEEDS).toBe(6);
    expect(ARENAS.length).toBe(6);
    expect(markers.length).toBe(6 * 6);
  });
});

describe('sha256Hex (Web Crypto) matches node:crypto', () => {
  // 'tanks-0' hashes to 6931e1e007... -- byte 0x07, which renders as a single nibble
  // without padStart. That is the classic hex-encoding bug and it only shows up on
  // inputs that happen to contain a low byte, so the fixture is chosen to contain one.
  const cases = ['', 'tanks-0', 'a|b|c', '015a5d17'];

  for (const s of cases) {
    it(`agrees on ${JSON.stringify(s)}`, async () => {
      const web = await sha256Hex(s);
      expect(web).toBe(createHash('sha256').update(s, 'utf8').digest('hex'));
      expect(web).toHaveLength(64);
    });
  }

  it('agrees on the trace text itself', () => {
    expect(hash).toBe(createHash('sha256').update(text, 'utf8').digest('hex'));
  });
});
