// The destroyed-hull arm vocabulary (issue #232). Pure: no Three.js, no DOM.
import { describe, it, expect } from 'vitest';
import { WRECK_EFFECTS, isWreckEffect } from './wreck';

describe('the wreck arm vocabulary', () => {
  it('accepts exactly the shipped arms', () => {
    for (const e of WRECK_EFFECTS) expect(isWreckEffect(e), e).toBe(true);
    // 'crumble' is in the issue's list and deliberately NOT an arm (see the module header), so
    // it is here as a rejected value rather than as an oversight.
    for (const bad of ['crumble', 'CRUMBLE', '', 'sink ', null, 7, undefined, ['sink']]) {
      expect(isWreckEffect(bad), String(bad)).toBe(false);
    }
  });

  it('offers three arms that differ in what the hull does, not where it is', () => {
    // Stated so the flag's value list has a population rather than possibly being empty, and
    // so dropping an arm -- which would quietly narrow the ruling to a two-way choice -- fails
    // here rather than in a capture nobody requested.
    expect([...WRECK_EFFECTS]).toEqual(['sink', 'fade', 'tilt']);
  });
});
