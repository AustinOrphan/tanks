// `gallery-link.ts`'s one helper, moved out of `gallery-selection.test.ts` with the function
// itself (issue #946): wiring builds the page link without importing the selection grammar,
// so the test that holds it should not import the grammar either.
import { describe, expect, it } from 'vitest';

import { gallerySearch } from './gallery-link';

describe('gallerySearch (issue #730)', () => {
  it('sets the gallery parameter with the gate on, keeping every other parameter', () => {
    expect(gallerySearch('', 'scene:fire,age:3')).toBe('?dev=1&gallery=scene:fire,age:3');
    expect(gallerySearch('?seed=7&dev=1&gallery=elements:tank', 'scene:fire')).toBe(
      '?seed=7&dev=1&gallery=scene:fire',
    );
    expect(gallerySearch('dev=0&tag=x', 'elements:mine')).toBe('?tag=x&dev=1&gallery=elements:mine');
  });

  it('writes a link the browser reads back as the same value', () => {
    const raw = 'scene:destroyed,view:low,spawn-anim:rise,reach';
    expect(new URLSearchParams(gallerySearch('?a=b', raw)).get('gallery')).toBe(raw);
  });
});
