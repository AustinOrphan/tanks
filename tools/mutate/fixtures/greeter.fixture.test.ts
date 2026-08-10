// Runs under the normal `npm test` gate too (matches tools/**/*.test.ts), which is
// fine -- it is fast and always green against the shipped greeter.mjs. Its second job
// is to be a real target for orchestrate.test.ts's end-to-end cases, which mutate
// greeter.mjs for real and run exactly this file through the real harness.
import { describe, it, expect } from 'vitest';
import { greet } from './greeter.mjs';

describe('greet (harness fixture)', () => {
  it('greets by name', () => {
    expect(greet('world')).toBe('hello world');
  });
});
