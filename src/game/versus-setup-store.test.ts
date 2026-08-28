import { describe, it, expect } from 'vitest';
import { createVersusSetupStore, defaultVersusSetup, VERSUS_SETUP_KEY } from './versus-setup-store';
import { createMemoryStorage } from './storage';
import { defaultSlots } from './versus-setup';

/** A Storage whose every method throws -- private mode, or storage disabled by policy. */
function hostileStorage(): Storage {
  const boom = () => {
    throw new Error('denied');
  };
  return {
    getItem: boom, setItem: boom, removeItem: boom, clear: boom, key: boom,
    get length(): number {
      throw new Error('denied');
    },
  } as unknown as Storage;
}

describe('createVersusSetupStore', () => {
  it('starts at the documented default when nothing is stored', () => {
    expect(createVersusSetupStore(createMemoryStorage()).get()).toEqual(defaultVersusSetup());
  });

  it('round-trips a setup through the RAW key, not just through the shadow', () => {
    // Reads back through a SECOND store on the same storage. A store that only updated its
    // in-memory shadow would pass an assertion made against the same instance and lose
    // everything on reload -- which is the criterion under test.
    const storage = createMemoryStorage();
    const a = createVersusSetupStore(storage);
    a.set({ mode: 'teams', players: 4, stock: 5, friendlyFire: true, arenaId: 'arena-03', slots: [
      { role: 'human' }, { role: 'human' }, { role: 'bot' }, { role: 'none' },
    ] });

    const b = createVersusSetupStore(storage);
    expect(b.get().mode).toBe('teams');
    expect(b.get().players).toBe(4);
    expect(b.get().stock).toBe(5);
    expect(b.get().friendlyFire).toBe(true);
    expect(b.get().arenaId).toBe('arena-03');
    expect(b.get().slots.map((s) => s.role)).toEqual(['human', 'human', 'bot', 'none']);
  });

  it('writes one JSON payload under its own versioned key', () => {
    // The raw-key boundary CLAUDE.md names: an export of "the save" has to be able to see
    // this, so it must be one key with one JSON value rather than several loose ones.
    const storage = createMemoryStorage();
    createVersusSetupStore(storage).set(defaultVersusSetup());
    const raw = storage.getItem(VERSUS_SETUP_KEY);
    expect(raw).not.toBeNull();
    expect(() => JSON.parse(raw as string)).not.toThrow();
  });

  it('survives unparseable JSON rather than throwing on boot', () => {
    // A store that let this throw would break LAUNCH, not just versus, because createStores
    // runs during boot. Hand-edited or truncated storage has to degrade to defaults.
    const storage = createMemoryStorage();
    storage.setItem(VERSUS_SETUP_KEY, '{not json');
    expect(() => createVersusSetupStore(storage)).not.toThrow();
    expect(createVersusSetupStore(storage).get()).toEqual(defaultVersusSetup());
  });

  it('repairs a structurally wrong payload field by field', () => {
    // Parseable but wrong is the likelier case across builds, and the one where returning
    // the whole fallback would silently discard choices that were fine.
    const storage = createMemoryStorage();
    storage.setItem(VERSUS_SETUP_KEY, JSON.stringify({ mode: 'battle-royale', players: 3, slots: 'nope' }));
    const got = createVersusSetupStore(storage).get();
    expect(got.mode).toBe('ffa'); // junk -> default
    expect(got.players).toBe(3); // valid -> kept
    expect(got.slots).toHaveLength(3); // rebuilt to match players
  });

  it('sanitizes on the way IN, so get() and the stored bytes agree', () => {
    // A pane mid-edit can easily hand over slots out of step with `players`. Without
    // set()-side sanitization the stored payload and get() disagree until the next reload.
    const storage = createMemoryStorage();
    const store = createVersusSetupStore(storage);
    store.set({ ...defaultVersusSetup(), players: 4, slots: defaultSlots(2) });
    expect(store.get().slots).toHaveLength(4);
    const persisted = JSON.parse(storage.getItem(VERSUS_SETUP_KEY) as string);
    expect(persisted.slots).toHaveLength(4);
  });

  it('clear() forgets the key and returns to defaults', () => {
    const storage = createMemoryStorage();
    const store = createVersusSetupStore(storage);
    store.set({ ...defaultVersusSetup(), players: 4 });
    store.clear();
    expect(storage.getItem(VERSUS_SETUP_KEY)).toBeNull();
    expect(store.get()).toEqual(defaultVersusSetup());
  });

  it('works against a storage that throws on every call', () => {
    // Private-mode posture, matching every other store: never throw, and let the shadow
    // carry the session. Both the constructor and a later set() have to hold.
    const store = createVersusSetupStore(hostileStorage());
    expect(store.get()).toEqual(defaultVersusSetup());
    expect(() => store.set({ ...defaultVersusSetup(), players: 3 })).not.toThrow();
    expect(store.get().players).toBe(3); // the shadow still carries it
    expect(() => store.clear()).not.toThrow();
  });
});
