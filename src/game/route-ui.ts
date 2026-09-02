import type { TankPreview } from '../render/preview';
import type { SkinId } from '../presentation/customization';
import type { GameStateMachine } from './state';
import type { Hud } from './hud';
import type { GameDeps } from './loop';

/**
 * The APPLICATION-ROUTE half of the HUD's handlers, owned above a gameplay session
 * (issue #427).
 *
 * `app-shell.ts` owns what must outlive a session and `session-host.ts` owns what is
 * replaced with one. This owns the third thing neither did: the controller behind the
 * routes the player sees when NO match is running -- Launch, Main Menu, Versus Setup,
 * Customize, Controllers, Settings. Those were registered inline in `startGameWith`,
 * which is what made the menu cost a world: reaching them meant constructing a session,
 * because the session was the only thing that ever wired them up.
 *
 * WHAT DECIDED THE SPLIT, measured on `loop.ts` rather than guessed: of its 25
 * `hud.on*` registrations, 15 reach no gameplay state at all and 3 more (the paint
 * shop's `onPick*`) reach it only through `restyle`'s renderer call. Those 18 are here.
 * The remaining 7 stay with the session and are listed in `startGameWith` beside the
 * call that builds this: three that START gameplay, two touch controls that need the
 * live `InputController`, `onReassignSlot` (which owns per-slot input sources), and
 * `onQuitToTitle`, whose return-to-route bookkeeping belongs to issue #429.
 *
 * The one thing here that a session-less page cannot do is push the style triple at the
 * gameplay renderer. That is `setStyleSink`, and its ABSENCE is the normal state rather
 * than a degraded one -- see its doc comment.
 */
export interface RouteUi {
  /**
   * Push the current style triple at the preview and the gameplay sink, if either
   * exists. Exposed because the paint shop is not the only thing that can change a
   * style -- a future settings import would want the same one-call refresh.
   */
  restyle(): void;
  /**
   * The mute toggle, shared with `loop.ts`'s M hotkey.
   *
   * Exposed rather than duplicated for the reason its original comment gives: all three
   * mute paths (both buttons and the key) must route through the STORE, or an M-key mute
   * stops surviving a reload while a clicked one keeps doing so.
   */
  toggleMute(): void;
  /** How many levels are pickable: everything cleared plus the next one, capped. */
  unlockedLevels(): number;
  /**
   * Re-fit the live preview, if the panel is open.
   *
   * Only while open: a disposed preview has nothing to resize, and re-reading
   * `hud.previewCanvas`'s now-hidden layout would just re-fit against stale/zero
   * dimensions for no visible effect.
   */
  resizePreview(): void;
  /**
   * Drop whatever preview context is held. Idempotent.
   *
   * The panel can still be open at teardown (`boot.ts`'s `pagehide` path can fire at any
   * time), which is why the session's dispose calls this rather than trusting the close
   * handler to have run.
   */
  disposePreview(): void;
  /**
   * Point the paint shop at a gameplay renderer, or `null` to unpoint it.
   *
   * A sink is how the route UI restyles the tank BEHIND the panel without holding a
   * renderer of its own, and `null` is the ordinary state of a page with no match
   * running -- not a degraded one. With no sink the store still records the pick and the
   * live preview still shows it; only the arena tank, which is not on screen, goes
   * unpushed. That is the whole of what the paint shop loses without a session, and it
   * is why these three handlers could move at all.
   */
  setStyleSink(sink: StyleSink | null): void;
}

/** Where a chosen style triple goes when a gameplay renderer exists to receive it. */
export type StyleSink = (hex: string, skin: SkinId, accentHex: string | null) => void;

/**
 * Everything the routes need, and deliberately nothing else.
 *
 * A `Pick` rather than a fresh interface: these are the SAME collaborators the session
 * gets, so restating their types here would be a second declaration to keep in step with
 * `GameDeps`. What the `Pick` buys is the negative claim -- a reader can see at a glance
 * that no `createRenderer`, `createInput`, `createDriver`, `run` or `levels.bounds`
 * appears, which is the ownership boundary this module exists to draw.
 */
export type RouteUiDeps = Pick<
  GameDeps,
  | 'settings'
  | 'stats'
  | 'progress'
  | 'achievements'
  | 'levels'
  | 'customization'
  | 'effectiveSettings'
  | 'createPreview'
  | 'readDetectedPads'
  | 'host'
  | 'requestVersusSession'
  | 'requestCampaignSession'
  | 'initialVersusConfig'
>;

/**
 * Wire the route handlers onto a HUD and a state machine.
 *
 * Takes both as INSTANCES rather than factories: the point of the issue is that these
 * two already construct without a world (`createHud(root, opts)`, `createGameStateMachine
 * (config)`), so whoever owns the page can build them once and hand them here, with or
 * without a session ever existing.
 *
 * Registration is APPEND, not replace (`hud.ts` pushes each callback onto a per-name
 * list), so this must be called exactly once per HUD. `startGameWith` guarantees that by
 * building one only when its deps did not bring one.
 */
export function createRouteUi(hud: Hud, sm: GameStateMachine, deps: RouteUiDeps): RouteUi {
  /**
   * The paint shop's live preview: a SECOND WebGL context. Built on `onCustomizeOpen`,
   * torn down on `onCustomizeClose` -- together the ONE chokepoint hud.ts fires both
   * transitions through (see its doc comment), so this never SKIPS a dispose down the
   * "Start while the panel is open" path. But "torn down" is dispose(), not context
   * loss: measured directly (see render/preview.ts's doc comment), the underlying
   * WebGL context survives dispose() and is REUSED on the next open, because the HUD
   * holds one persistent `.hud-preview` canvas for the whole session rather than a
   * fresh one per open. So the context is held from the first Customize open through
   * the rest of the session, not freed and reacquired every open/close -- what
   * dispose() DOES reclaim every time is the THREE-side cost (the scene, the tank
   * mesh, the skin texture, the environment map, the shadow map). The number that
   * stays true either way, and is the one that actually matters: peak is two live
   * contexts (this one plus the main game's), never three.
   */
  let preview: TankPreview | null = null;

  /** The gameplay renderer's style input, when a session has offered one. */
  let styleSink: StyleSink | null = null;

  /** How many levels are pickable: everything cleared plus the next one, capped. */
  const unlockedLevels = (): number =>
    Math.min(deps.progress.highestCleared() + 1, deps.levels.levels.length);

  /**
   * Store -> audio -> button, for all three mute paths.
   *
   * Both mute buttons and the M hotkey used to call `audio.toggleMute()` directly and
   * hand its return value to `hud.setMuted`. Routing them all through the store is what
   * makes an M-key mute survive a reload; leaving any one of them on the old path would
   * make mute persist or not depending on which control the player used.
   */
  function toggleMute(): void {
    deps.settings.setMuted(!deps.settings.snapshot().audio.muted);
  }

  // Hull, skin and accent restyle through ONE call to each sink: the style is a triple,
  // and sending part of it would reset the rest to a default. The live preview (when
  // open) gets the SAME triple, so the tank behind the panel and the one inside it
  // never disagree.
  function restyle(): void {
    const hex = deps.customization.hexFor(deps.customization.hull());
    const skin = deps.customization.skin();
    const accentHex = deps.customization.accentHexFor(deps.customization.accent());
    styleSink?.(hex, skin, accentHex);
    preview?.setStyle(hex, skin, accentHex);
  }

  // Write the store and stop. `applySettings`, from the session's own subscription, is
  // what reaches the audio engine and both buttons -- see its own doc comment.
  hud.onMuteToggle(toggleMute);
  hud.onVolumeChange((v) => {
    deps.settings.setVolume(v);
  });

  hud.onVersusOpen(() => {
    hud.showVersusSetup(true, deps.initialVersusConfig ?? null);
  });
  // `?.`: `requestVersusSession` is optional (GameDeps' own doc comment) so every
  // existing test/caller that builds a GameDeps with no reboot seam at all keeps
  // compiling AND keeps working -- a Start click reaching here with nothing wired to
  // receive it must not throw.
  hud.onVersusStart((config) => {
    deps.requestVersusSession?.(config);
  });
  // The Campaign button -- a bare passthrough, same shape as the two above:
  // `deps.requestCampaignSession` is only ever wired on a setup-pane versus session's
  // own deps (applyVersusToDeps), so a campaign session's own click here (unreachable,
  // since hud.ts hides the button for the 'campaign-levels' relaunch target -- see
  // setRelaunchTarget) would no-op via `?.` exactly like a Start click with no
  // requestVersusSession wired does above.
  hud.onCampaignOpen(() => {
    deps.requestCampaignSession?.();
  });

  hud.onPauseTap(() => {
    if (sm.isPaused) sm.resume();
    else sm.pause();
  });

  hud.onTouchSchemeChange((next) => {
    deps.settings.setTouchScheme(next);
  });
  hud.onFireModeChange((next) => {
    deps.settings.setFireMode(next);
  });
  hud.onHapticsChange((next) => {
    deps.settings.setDeviceHaptics(next);
  });

  hud.onCustomizeOpen(() => {
    // The EFFECTIVE reduced-motion policy, resolved once here and handed down. preview.ts
    // used to call `window.matchMedia` itself, which meant the OS was the only input and
    // a player who wanted full effects anyway could not say so. Sampled at open, like the
    // media query it replaces -- the preview lives only while this panel is open.
    preview = deps.createPreview(
      hud.previewCanvas,
      hud.previewRotateButtons,
      deps.effectiveSettings.current().reducedMotion,
    );
    preview?.setStyle(
      deps.customization.hexFor(deps.customization.hull()),
      deps.customization.skin(),
      deps.customization.accentHexFor(deps.customization.accent()),
    );
  });
  hud.onCustomizeClose(() => {
    preview?.dispose();
    preview = null;
  });

  hud.onPickHullColor((id) => {
    deps.customization.setHull(id);
    // Echo the ACCEPTED value back: the store refuses off-palette ids, and the
    // swatch ring must show what was stored, not what was clicked.
    hud.setHullColor(deps.customization.hull());
    restyle();
  });

  hud.onPickSkin((id) => {
    deps.customization.setSkin(id);
    hud.setSkin(deps.customization.skin());
    restyle();
  });

  hud.onPickAccentColor((id) => {
    deps.customization.setAccent(id);
    hud.setAccentColor(deps.customization.accent());
    restyle();
  });

  // The panel's live pad list -- read once immediately on open (the browser's
  // gamepadconnected/disconnected events fire only on CHANGE, so opening over
  // already-connected pads would otherwise show nothing until the next hotplug), then
  // kept live by the two window listeners for as long as the panel stays open. Added and
  // removed at exactly this chokepoint -- the driver does not tick during title/paused,
  // so nothing else would refresh the panel while it is up.
  const onGamepadHotplug = (): void => {
    hud.setDetectedPads(deps.readDetectedPads());
  };
  hud.onControllersOpen(() => {
    onGamepadHotplug();
    deps.host.addEventListener('gamepadconnected', onGamepadHotplug);
    deps.host.addEventListener('gamepaddisconnected', onGamepadHotplug);
  });
  hud.onControllersClose(() => {
    deps.host.removeEventListener('gamepadconnected', onGamepadHotplug);
    deps.host.removeEventListener('gamepaddisconnected', onGamepadHotplug);
  });

  hud.onResetStats(() => {
    deps.stats.resetLifetime();
    hud.setStats({ lifetime: deps.stats.lifetime(), attempt: deps.stats.attempt() });
  });

  hud.onResetProgress(() => {
    deps.progress.reset();
    // Achievements are progress, not statistics: this is the one reset that clears
    // them, and Reset stats deliberately leaves them alone.
    deps.achievements.reset();
    hud.setAchievements(deps.achievements.earned());
    // Levels re-lock immediately: the select the player is looking at must not keep
    // offering a level the save no longer justifies.
    hud.setLevelSelect(unlockedLevels(), deps.levels.levels.length);
  });

  return {
    restyle,
    toggleMute,
    unlockedLevels,
    resizePreview(): void {
      preview?.resize();
    },
    disposePreview(): void {
      preview?.dispose();
      preview = null;
    },
    setStyleSink(sink: StyleSink | null): void {
      styleSink = sink;
    },
  };
}
