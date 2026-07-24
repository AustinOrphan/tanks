import { describe, it, expect } from 'vitest';
import { add } from './smoke';

describe('smoke: pure sim module runs headlessly', () => {
  it('adds two numbers', () => {
    expect(add(2, 3)).toBe(5);
  });

  it('handles negatives and zero', () => {
    expect(add(-4, 4)).toBe(0);
    expect(add(0, 0)).toBe(0);
  });
});
