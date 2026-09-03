import { describe, it, expect } from 'vitest';
import { createModalityTracker, keyHint, MODALITY_SWITCH_MS, type Modality } from './modality';

describe('modality tracker: the first input wins immediately (issue #496)', () => {
  it('accepts the very first input of the page with no history, whatever it is', () => {
    for (const first of ['keyboard', 'pointer', 'touch', 'gamepad'] as const) {
      const t = createModalityTracker();
      expect(t.current(), 'a fresh page names no modality').toBeNull();
      expect(t.note(first, 0), first).toBe(true);
      expect(t.current()).toBe(first);
    }
  });

  it('notifies subscribers on that first input, and the unsubscribe stops it', () => {
    const t = createModalityTracker();
    const seen: Modality[] = [];
    const stop = t.subscribe((m) => seen.push(m));
    t.note('keyboard', 0);
    expect(seen).toEqual(['keyboard']);
    stop();
    t.note('touch', 0);
    t.note('touch', MODALITY_SWITCH_MS);
    expect(seen, 'an unsubscribed listener kept hearing').toEqual(['keyboard']);
  });
});

describe('modality tracker: a switch needs the threshold (issue #496)', () => {
  it('a single stray event of another modality does not switch, and the incumbent resets the challenge', () => {
    const t = createModalityTracker(MODALITY_SWITCH_MS);
    t.note('keyboard', 0);
    expect(t.note('pointer', 100), 'one stray pointer event switched').toBe(false);
    expect(t.current()).toBe('keyboard');
    // The keyboard reasserts: the pointer's clock starts over, so an event at 500 -- past
    // the threshold measured from 100 -- is a fresh candidate, not a winner.
    t.note('keyboard', 200);
    expect(t.note('pointer', 500)).toBe(false);
    expect(t.current(), 'the challenge should have restarted').toBe('keyboard');
  });

  it('switches once the candidate has held the field for the whole threshold, and not before', () => {
    const t = createModalityTracker(MODALITY_SWITCH_MS);
    t.note('keyboard', 0);
    expect(t.note('touch', 1000)).toBe(false);
    expect(t.note('touch', 1000 + MODALITY_SWITCH_MS - 1), 'switched one millisecond early').toBe(false);
    expect(t.current()).toBe('keyboard');
    expect(t.note('touch', 1000 + MODALITY_SWITCH_MS)).toBe(true);
    expect(t.current()).toBe('touch');
  });

  it('two challengers interleaving never switch: each restarts the other\'s clock, however long it goes on', () => {
    // The hybrid-device case this rule exists for -- a hand on the pad and a palm on the
    // trackpad -- holds the incumbent rather than alternating the prompts between them.
    const t = createModalityTracker(MODALITY_SWITCH_MS);
    t.note('keyboard', 0);
    let now = 100;
    for (let i = 0; i < 6; i++) {
      expect(t.note(i % 2 === 0 ? 'pointer' : 'gamepad', now), `alternating at ${now}`).toBe(false);
      now += MODALITY_SWITCH_MS;
    }
    expect(t.current(), 'alternating challengers switched the prompt').toBe('keyboard');
    // The negative control for the loop: with the incumbent reasserting once to clear the
    // pending challenge, one challenger alone then wins on its own uninterrupted span.
    t.note('keyboard', now);
    t.note('gamepad', now);
    expect(t.note('gamepad', now + MODALITY_SWITCH_MS)).toBe(true);
    expect(t.current()).toBe('gamepad');
  });

  it('the incumbent repeating is never a change, however long it goes on', () => {
    const t = createModalityTracker(MODALITY_SWITCH_MS);
    t.note('keyboard', 0);
    for (const now of [10, 500, 5000]) expect(t.note('keyboard', now), String(now)).toBe(false);
    expect(t.current()).toBe('keyboard');
  });

  it('the threshold is injected: a tracker built with a different one switches on that one', () => {
    const t = createModalityTracker(50);
    t.note('keyboard', 0);
    t.note('touch', 0);
    expect(t.note('touch', 49)).toBe(false);
    expect(t.note('touch', 50)).toBe(true);
  });
});

describe('keyHint: one policy for static hints across the HUD (issue #496)', () => {
  it('names the key for a keyboard, a pad\'s button only when one is bound, nothing for touch, and keeps the key for a mouse', () => {
    expect(keyHint('keyboard', 'M', 'Y')).toBe(' (M)');
    expect(keyHint('gamepad', 'M', 'Y'), 'a bound pad button is named').toBe(' (Y)');
    // The case review caught: with no pad binding, the hint is empty rather than an
    // invented button, or a key a couch player has no keyboard for. Mute is this today.
    expect(keyHint('gamepad', 'M', null), 'an unbound action must not name a button').toBe('');
    expect(keyHint('touch', 'M', 'Y'), 'a touch device has no key to press').toBe('');
    expect(keyHint('pointer', 'M', 'Y'), 'a mouse user still has a keyboard').toBe(' (M)');
  });

  it('before any input, keeps the shipped keyboard hint -- what a desktop page shows untouched', () => {
    expect(keyHint(null, 'M', 'Y')).toBe(' (M)');
  });
});
