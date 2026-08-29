import {
  createNamespacedStorage,
  createStores,
  resolveStorageWithStatus,
  selectStorageNamespace,
  type GameStores,
  type StorageNamespace,
} from './storage';
import { noticeFor, type PlayerSettingsStore, type SettingsNotice } from './settings';
import {
  createCapabilitySource,
  createMediaReducedMotionSource,
  detectCapabilities,
  type CapabilitySource,
  type ReducedMotionSource,
} from './capabilities';
import { createEffectiveSettings, type EffectiveSettingsHandle } from './effective-settings';

/**
 * PAGE-scoped ownership of persistence and settings, created once per document load
 * (issue #320).
 *
 * This exists because the game handle does NOT survive navigation. `boot.ts` disposes the
 * whole handle and calls `startGame` again to enter a versus match or to come back to
 * campaign, and `createBrowserDeps` builds a fresh `GameDeps` -- fresh stores, fresh audio
 * engine -- on every one of those. Anything owned by a session therefore restarts at its
 * default whenever the player crosses that boundary, which is precisely the defect issue
 * #320 names: "mute and volume are not reliably preserved across full session reboots".
 *
 * Three concrete things follow from owning this above the session rather than inside it:
 *
 *  - there is ONE settings store per page, so there is no second shadow of a preference
 *    that could win a write race with the first;
 *  - the settings survive a reboot even when storage is DENIED, because the in-memory
 *    shim (`resolveStorage`) is resolved once instead of once per session -- a per-session
 *    resolve would hand each session its own private Map;
 *  - the persistence notice can fire at most once per page, rather than once per
 *    navigation, without a module-level latch nothing can reset between tests.
 *
 * This is deliberately NOT the persistent app shell of issue #317, and still is not: it
 * owns no routes, no canvas, no HUD and no lifecycle. Issue #317 did what this comment
 * said it would -- `app-shell.ts` now HOLDS this object rather than `boot.ts` holding it
 * directly, and adds the audio engine and the Launch gate beside it -- and it moved the
 * construction without changing the model here. Nothing in this file changed.
 */
export interface AppSettings {
  /**
   * The one resolved `Storage` every store in `stores` shares. save.ts's raw layer.
   *
   * On a developer session this is the NAMESPACED adapter, the same object the stores
   * were built on -- not the browser's `localStorage` underneath it. save.ts reads and
   * writes raw keys through whatever it is handed, so handing it the base storage here
   * would let a `?dev=1` session export the real player's save and import back over it,
   * through the one path that does not go through a store (issue #245).
   */
  readonly storage: Storage;
  /**
   * Which key namespace this page is persisting into. Read-only state for the Developer
   * Tools surface of issue #246 onwards; nothing in the game branches on it, because the
   * adapter has already applied it by the time any store sees a key.
   */
  readonly namespace: StorageNamespace;
  readonly stores: GameStores;
  /** Shorthand for `stores.settings`. The one writable settings source on the page. */
  readonly settings: PlayerSettingsStore;
  readonly effective: EffectiveSettingsHandle;
  /**
   * Register for the persistence notice. Returns an unregister.
   *
   * Delivered AT MOST ONCE per page, and only for a condition that has actually occurred:
   * memory-only storage or a future-schema lock are known at construction and delivered
   * to the first registrant immediately; a real `Storage` whose `setItem` throws (Safari
   * private mode) is not knowable until the first write, so this stays armed and fires
   * then. Consuming it at boot only -- the obvious shape -- would report the first two
   * cases and silently miss the third.
   *
   * The unregister matters: a game session registers this against its own HUD, and that
   * HUD is destroyed on every reboot. Without it, a notice arriving after a navigation
   * would call `showToast` on a torn-down HUD.
   */
  onNotice(cb: (notice: SettingsNotice) => void): () => void;
  /**
   * Release the OS media-query listener and the store subscriptions.
   *
   * Called ONLY from the page teardown (`boot.ts`'s non-persisted `pagehide`). A game
   * session must never call this: the next session would get a dead motion subscription
   * and settings that stop reacting after one navigation.
   */
  dispose(): void;
}

export interface AppSettingsDeps {
  readonly storage: Storage;
  /** The namespace `storage` already applies. Required, so a caller cannot forget it. */
  readonly namespace: StorageNamespace;
  readonly stores: GameStores;
  readonly capabilities: CapabilitySource;
  readonly motion: ReducedMotionSource;
}

export function createAppSettings(deps: AppSettingsDeps): AppSettings {
  const settings = deps.stores.settings;
  const effective = createEffectiveSettings({
    store: settings,
    capabilities: deps.capabilities,
    motion: deps.motion,
  });

  const listeners = new Set<(n: SettingsNotice) => void>();
  /** The latch. Once a notice has been delivered, this page says nothing further. */
  let delivered = false;

  function deliver(notice: SettingsNotice): void {
    if (delivered || listeners.size === 0) return;
    delivered = true;
    for (const cb of [...listeners]) cb(notice);
    // Nothing can fire again, so the registrations are dead weight -- and holding them
    // would keep a disposed HUD's closure alive across every later navigation.
    listeners.clear();
    offStore();
  }

  // Armed for the write-failure case. Every accepted change notifies with the CURRENT
  // status, so the first failed write is the first notification whose status has a notice.
  const offStore = settings.subscribe((_s, status) => {
    const notice = noticeFor(status);
    if (notice) deliver(notice);
  });

  return {
    storage: deps.storage,
    namespace: deps.namespace,
    stores: deps.stores,
    settings,
    effective,
    onNotice(cb): () => void {
      if (delivered) return () => {};
      listeners.add(cb);
      // A condition already true at construction is delivered to the first registrant
      // rather than waiting for a change that may never come.
      const pending = noticeFor(settings.status());
      if (pending) deliver(pending);
      return () => listeners.delete(cb);
    },
    dispose(): void {
      offStore();
      listeners.clear();
      effective.dispose();
    },
  };
}

/**
 * The real one: browser storage, browser capability probes, the OS media query.
 *
 * The only unpinned line in the chain, and the same shape as every other real
 * collaborator `boot.ts` is handed by `main.ts`.
 */
export function createBrowserAppSettings(): AppSettings {
  // Selected BEFORE the stores exist, and applied once: `storage` below is the namespaced
  // object, and both `createStores` and `AppSettings.storage` receive that same instance.
  // A second adapter, or the base storage on either side, would put half the session in
  // one namespace and half in the other.
  const namespace = selectStorageNamespace(globalThis.location?.search ?? '');
  const resolved = resolveStorageWithStatus();
  const availability = resolved.availability;
  const storage = createNamespacedStorage(resolved.storage, namespace);
  return createAppSettings({
    storage,
    namespace,
    stores: createStores(storage, availability),
    capabilities: createCapabilitySource(() => detectCapabilities()),
    motion: createMediaReducedMotionSource(),
  });
}
