// pickSimulatorUdid is the only part of find-simulator.mjs testable from this Linux box --
// the CLI entry shells out to `xcrun`, which does not exist here. Fixtures below are
// hand-built in the shape `xcrun simctl list devices available -j` actually documents
// (devices keyed by runtime identifier), not a guess.
import { describe, it, expect } from 'vitest';
// @ts-expect-error -- plain .mjs, deliberately dependency-free (see harness.mjs)
import { formatSimulator, pickSimulator, pickSimulatorUdid } from './find-simulator.mjs';

const fixture = (overrides = {}) => ({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-16-4': [
      { name: 'iPhone 14', udid: 'udid-16-4-iphone14', isAvailable: true },
    ],
    'com.apple.CoreSimulator.SimRuntime.iOS-17-4': [
      { name: 'iPhone 15', udid: 'udid-17-4-iphone15', isAvailable: true },
      { name: 'iPad Air (5th generation)', udid: 'udid-17-4-ipad', isAvailable: true },
    ],
    'com.apple.CoreSimulator.SimRuntime.watchOS-10-4': [
      { name: 'Apple Watch Series 9 (45mm)', udid: 'udid-watch', isAvailable: true },
    ],
    ...overrides,
  },
});

describe('pickSimulatorUdid', () => {
  it('returns the identity needed to diagnose a runner failure, not only the UDID', () => {
    const picked = pickSimulator(fixture());
    expect(picked).toEqual({
      name: 'iPhone 15',
      runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-17-4',
      udid: 'udid-17-4-iphone15',
    });
    expect(formatSimulator(picked, { details: true })).toBe(
      'iPhone 15\tudid-17-4-iphone15\tcom.apple.CoreSimulator.SimRuntime.iOS-17-4',
    );
  });

  it('picks an iPhone on the highest available iOS runtime', () => {
    expect(pickSimulatorUdid(fixture())).toBe('udid-17-4-iphone15');
  });

  it('accepts the raw JSON string form, not only a pre-parsed object', () => {
    expect(pickSimulatorUdid(JSON.stringify(fixture()))).toBe('udid-17-4-iphone15');
  });

  it('skips iPads and non-iOS runtimes (watchOS)', () => {
    // Remove the iPhone from the iOS-17-4 bucket -- only the iPad and the older iPhone
    // remain, so the answer must fall back to iOS-16-4's iPhone, not the iPad.
    const f = fixture({
      'com.apple.CoreSimulator.SimRuntime.iOS-17-4': [
        { name: 'iPad Air (5th generation)', udid: 'udid-17-4-ipad', isAvailable: true },
      ],
    });
    expect(pickSimulatorUdid(f)).toBe('udid-16-4-iphone14');
  });

  it('skips an iPhone that is not available', () => {
    const f = fixture({
      'com.apple.CoreSimulator.SimRuntime.iOS-17-4': [
        { name: 'iPhone 15', udid: 'udid-17-4-iphone15', isAvailable: false },
      ],
    });
    expect(pickSimulatorUdid(f)).toBe('udid-16-4-iphone14');
  });

  it('compares runtime versions NUMERICALLY, not lexically (iOS-17 must beat iOS-9)', () => {
    // A string compare would rank "iOS-9-0" above "iOS-17-4" (`'9' > '1'`). This is the
    // failure mode a numeric comparator exists to avoid.
    const f = {
      devices: {
        'com.apple.CoreSimulator.SimRuntime.iOS-9-0': [
          { name: 'iPhone 6', udid: 'udid-9-0', isAvailable: true },
        ],
        'com.apple.CoreSimulator.SimRuntime.iOS-17-4': [
          { name: 'iPhone 15', udid: 'udid-17-4', isAvailable: true },
        ],
      },
    };
    expect(pickSimulatorUdid(f)).toBe('udid-17-4');
  });

  it('throws when no iPhone is available at all', () => {
    expect(() => pickSimulatorUdid({ devices: {} })).toThrow(/no available iPhone simulator/);
  });
});
