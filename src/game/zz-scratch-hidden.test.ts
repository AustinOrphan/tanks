// @vitest-environment jsdom
import { it, expect } from 'vitest';
it('hidden attr', () => {
  const b = document.createElement('button');
  b.hidden = true;
  document.body.appendChild(b);
  expect(getComputedStyle(b).display).toBe('none');
});
