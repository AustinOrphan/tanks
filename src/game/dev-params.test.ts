import { describe, it, expect } from 'vitest';
import { canonicalDevSearch } from './dev-config';
import { developerExitSearch, knownDevParams } from './dev-params';

describe('developerExitSearch', () => {
  it('removes the master gate AND every other developer parameter', () => {
    // The whole point, and the reason this is not `canonicalDevSearch(.., {keepGate:false})`:
    // that call keeps the flags and drops only the gate, which is a developer URL missing
    // its gate rather than an ordinary URL. Asserted side by side so the difference is a
    // test rather than a comment.
    const search = '?dev=1&aimRay=1&shellCount=1&pp1Roles=1';
    expect(developerExitSearch(search)).toBe('');
    expect(canonicalDevSearch(search, { keepGate: false }).search).not.toBe('');
  });

  it('preserves unrelated parameters, in order and with their own duplicates', () => {
    // Order and duplicates both, because they belong to whatever put them there. Two `ref`s
    // arriving means two `ref`s leaving; collapsing them would be this function editing
    // someone else's parameter.
    expect(developerExitSearch('?ref=a&dev=1&utm=x&ref=b&aimRay=1')).toBe('?ref=a&utm=x&ref=b');
  });

  it('sweeps the registry rather than a hand-kept list, so a new flag cannot outlive Exit', () => {
    // Built FROM knownDevParams: a flag added to FLAG_REGISTRY tomorrow is removed by this
    // function on the same day, with no second list to remember. The sweep is the assertion.
    const every = knownDevParams().map((p) => `${p}=1`).join('&');
    expect(developerExitSearch(`?${every}&keep=me`)).toBe('?keep=me');
  });

  it('drops retired developer parameters too', () => {
    // DEPRECATED_DEV_PARAMS is empty today, so this passes one explicitly rather than
    // asserting nothing. A retired parameter is still a developer parameter, and an Exit
    // that left one behind would hand back a URL still carrying developer state.
    expect(developerExitSearch('?dev=1&oldFlag=1&keep=me', ['oldFlag'])).toBe('?keep=me');
  });

  it('returns an empty string rather than a bare question mark', () => {
    expect(developerExitSearch('?dev=1')).toBe('');
    expect(developerExitSearch('')).toBe('');
  });

  it('accepts a search with or without the leading question mark', () => {
    expect(developerExitSearch('dev=1&keep=me')).toBe('?keep=me');
  });
});
