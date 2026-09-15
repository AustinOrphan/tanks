import type { TankPreview } from '../render/preview';
import { formatGallerySelection } from './gallery-selection';
import { mountGalleryWorkbench, type GalleryWorkbenchView } from './gallery-workbench';
import type { SkinId } from '../presentation/customization';
import type { GameStateMachine } from './state';
import type { Hud } from './hud';
import type { GameDeps } from './loop';
import {
  activeLayoutProfile,
  cancelledStatus,
  captureResultStatus,
  captureStatus,
  createBindingCapture,
  layoutModel,
  presetStatus,
  rebind,
  RESET_STATUS,
  type BindingCapture,
} from './controller-layout';
import { controllerLayoutFor } from './settings';
import { RECOMMENDED_LAYOUT, type ControlLayout } from '../input/gamepad-profile';
import { readConnectedPads, type GetGamepads } from '../input/gamepad';

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
 * `hud.on*` registrations, 15 reached no gameplay state at all and 3 more (the paint
 * shop's `onPick*`) reached it only through `restyle`'s renderer call. Those 18 came
 * here, and three later arrivals -- `onRecordsOpen`, added by issue #324's step S5 so the
 * page can paint the Records tables it now owns, and the Accessibility section's two
 * controls, `onMotionChange` (issue #289) and `onQualityChange` (issue #540) -- make 21
 * today, against `Hud`'s 28 registration methods.
 * The other 7 belong to a live match and are registered by `route-host.ts` as trampolines
 * into whatever session holds its slot: three that START gameplay, two touch controls
 * that need the live `InputController`, `onReassignSlot` (which owns per-slot input
 * sources), and `onQuitToTitle`.
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
   * Open the Versus Setup pane over whatever is showing, prefilled with the retained
   * configuration.
   *
   * The Versus button's own handler is one call to this, and so is the route host's
   * reopen for a finished versus match (issue #324, step S5). That second caller is why
   * it is exposed at all: the pane is an application surface, so the shell has to be able
   * to open it without the session that just ended reaching into the HUD to do it -- and
   * both openers must prefill from the same retained config, which only this module can
   * read (`deps.initialVersusConfig` is a live getter over the host's own copy).
   */
  openVersusSetup(): void;
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
   * Drop the gallery workbench's body and renderer, if mounted (issue #730). Idempotent, and
   * called at teardown for `disposePreview`'s reason: the pane can still be open then.
   */
  disposeGallery(): void;
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
  /**
   * Read one frame of pads for a controller-layout capture, if one is waiting (issue #754).
   *
   * Called by `route-host.ts` on its page frame, straight AFTER the menu poller -- not from a
   * frame loop of its own. The order is the point: the press that completes a capture is
   * dropped by the poller on the frame it lands (see `capturingBinding`), and is a held button,
   * not a new one, on the next. From a separate loop the two could run in either order, and a
   * B chosen for Fire could also close the pane.
   */
  pollBindingCapture(): void;
  /** Whether a capture is waiting, so the page's pad dispatch can stand aside for it. */
  capturingBinding(): boolean;
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
  | 'readPadDiagnostics'
  | 'galleryWorkbench'
  | 'raf'
  | 'host'
  | 'requestVersusSession'
  | 'requestCampaignSession'
  | 'initialVersusConfig'
> & {
  /**
   * Menu-time gamepad input (issue #494): the pads the page's own poller reads -- the union of
   * every connected pad, never the `pad[i] -> slot[i]` routing a session uses. Injected like
   * every other reader so jsdom drives menus through a fake pad and a fake frame clock.
   *
   * Here rather than only on `RouteHostDeps` since issue #754: the controller layout pane
   * reads the same pads to name the controller it configures and to capture a press.
   */
  readonly menuGamepads: GetGamepads;
};

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

  /**
   * How many levels are pickable: everything the player has CLEARED, capped.
   *
   * Cleared, not cleared-plus-the-next (owner ruling on issue #555). The `+ 1` made the
   * Levels pane an alternative campaign ladder rather than a replay of solved content: a
   * practice win records permanent progress -- `loop.ts` gates `recordCleared` on
   * `tracksProgress` alone and does NOT exclude practice, which its own comment says
   * outright -- so a player could practice the frontier level with independent lives,
   * bank the unlock, and repeat, climbing the whole campaign without ever spending a
   * campaign life. Offering only cleared levels seals that, and seals it structurally
   * rather than by a second guard: `recordCleared` keeps the maximum, so a pane that can
   * only ever offer levels already counted can never advance progress at all.
   *
   * The cost, stated because it is real: there is no longer a risk-free way to rehearse
   * the level you are stuck on. That was the same affordance viewed from the other side.
   *
   * The `Math.min` is NOT redundant, and this is the one place it matters: `progress`
   * resolves ordinals against the shipped campaign, while `deps.levels` is THIS session's
   * level system, which for a versus match or the sandbox is a single synthetic arena. A
   * save three levels deep would otherwise size that grid at 3.
   */
  const unlockedLevels = (): number =>
    Math.min(deps.progress.highestCleared(), deps.levels.levels.length);

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

  function openVersusSetup(): void {
    hud.showVersusSetup(true, deps.initialVersusConfig ?? null);
  }
  hud.onVersusOpen(openVersusSetup);
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
  // Its own stored key, never folded into device haptics: the two are detected, stored and
  // resolved independently end to end, and until issue #227 this one had no writer at all.
  hud.onControllerRumbleChange((next) => {
    deps.settings.setControllerRumble(next);
  });

  /**
   * Keep platform capabilities live while Settings is open (issue #227).
   *
   * The rumble control is shown REFUSED when no connected pad reports an actuator, and the
   * refusal names plugging one in as the fix -- so a reason that did not clear on hotplug
   * would be instructing the player to do something that then appears not to work.
   *
   * Needed because the only other `refreshCapabilities` caller is `loop.ts`'s per-frame pad
   * sweep, which runs while a match SIMULATES. A player in Settings with no match running is
   * the ordinary case and had no refresh at all.
   *
   * Read once immediately on open for the same reason the Controllers panel does: the
   * browser's hotplug events fire only on CHANGE, so opening over an already-connected pad
   * would otherwise show the boot snapshot. `refreshCapabilities` publishes only on a real
   * change, so the common case costs one scan and notifies nobody.
   */
  const onCapabilityHotplug = (): void => {
    deps.effectiveSettings.refreshCapabilities();
  };
  hud.onSettingsOpen(() => {
    onCapabilityHotplug();
    deps.host.addEventListener('gamepadconnected', onCapabilityHotplug);
    deps.host.addEventListener('gamepaddisconnected', onCapabilityHotplug);
  });
  hud.onSettingsClose(() => {
    deps.host.removeEventListener('gamepadconnected', onCapabilityHotplug);
    deps.host.removeEventListener('gamepaddisconnected', onCapabilityHotplug);
  });
  // The store and nothing else (issue #289). The display comes back through
  // `route-host.ts`'s `paintSettingsControls`, which the store's own notification wakes --
  // so the label redraws from the value the store ACCEPTED, and the same notification is
  // what makes the new policy reach `hud.setReducedMotion` on the same tick, with the pane
  // still open. Echoing the clicked value at the HUD here would show a preference the
  // store may have refused and would leave the transitions running on the old one.
  hud.onMotionChange((next) => {
    deps.settings.setMotion(next);
  });
  // The store and nothing else, exactly like the motion handler above (issue #540). What
  // differs is where the value lands afterwards: a session reads the accepted preset when
  // it BUILDS its renderer, so this write reaches the picture at the next match rather
  // than the frame after the click. The button's own hint says so.
  hud.onQualityChange((next) => {
    deps.settings.setQuality(next);
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

  /**
   * The controller self-test's live readout (issue #599), on the page's own frame loop for
   * exactly as long as the pane is open.
   *
   * A FRAME LOOP, not the hotplug listeners above, and the difference is the whole reason
   * this is separate wiring: `gamepadconnected`/`gamepaddisconnected` fire when a pad
   * arrives or leaves, and NOTHING fires when a stick moves. The Gamepad API has no change
   * event for axis or button state -- a reader polls or it sees nothing -- so a self-test
   * driven by hotplug events would show a pad that never moves, which is indistinguishable
   * from a broken pad and is the exact thing the tester is trying to rule out.
   *
   * SELF-RESCHEDULING, and stopped two ways: the pending handle is cancelled, AND the
   * callback checks the flag before asking for another frame. Either alone leaves a hole --
   * cancelling cannot reach a callback already running, and a flag alone leaves one frame
   * queued after close. The driver does not tick while a pane is up, so this loop is the
   * only thing running, and leaving it running would poll the hardware for the life of the
   * page over a pane that is gone.
   */
  let selfTestFrame: number | null = null;
  let selfTestPolling = false;
  const pollSelfTest = (): void => {
    selfTestFrame = null;
    hud.setPadDiagnostics(deps.readPadDiagnostics());
    if (selfTestPolling) selfTestFrame = deps.raf.request(pollSelfTest);
  };
  hud.onControllerSelfTestOpen(() => {
    selfTestPolling = true;
    // Read once immediately rather than waiting a frame: the pane is on screen before the
    // first callback lands, and an empty list for one frame reads as "no controller".
    pollSelfTest();
  });
  hud.onControllerSelfTestClose(() => {
    selfTestPolling = false;
    if (selfTestFrame !== null) deps.raf.cancel(selfTestFrame);
    selfTestFrame = null;
  });

  /**
   * THE CONTROLLER LAYOUT PANE (issue #754), live for exactly as long as it is open.
   *
   * WHICH CONTROLLER: the first connected pad the game reads. Layouts are stored per profile,
   * and with one standard profile shipped (#606 owns the next) every readable pad is that one;
   * a player with pads of two profiles configures the first, which the pane names.
   *
   * WHAT KEEPS IT CURRENT: the effective-settings subscription (a store write, from here or
   * anywhere) and the two hotplug events, for the Controllers panel's reason -- nothing else
   * runs while the page sits in Settings. Read once on open, since hotplug fires only on change.
   *
   * THE STORE IS THE ONLY WRITE. Every request writes `deps.settings` and repaints from what the
   * store then holds; the pane never shows a value the store did not accept.
   */
  let layoutOpen = false;
  let capture: BindingCapture | null = null;
  let layoutStatus = '';
  let stopLayoutSettings: (() => void) | null = null;
  const storedLayout = (profileId: string): ControlLayout =>
    controllerLayoutFor(deps.effectiveSettings.current().controllerLayouts, profileId);
  function paintLayout(): void {
    if (!layoutOpen) return;
    const profile = activeLayoutProfile(readConnectedPads(deps.menuGamepads));
    // A capture belongs to the controller kind it started on. If none is connected any more,
    // the wait ends with it rather than binding whatever is plugged in next.
    if (capture !== null && profile?.id !== capture.profile.id) {
      layoutStatus = cancelledStatus(capture.action);
      capture = null;
    }
    const layout = profile === null ? RECOMMENDED_LAYOUT : storedLayout(profile.id);
    hud.setControllerLayout(layoutModel(profile, layout, capture?.action ?? null, layoutStatus));
  }
  hud.onControllerLayoutOpen(() => {
    layoutOpen = true;
    capture = null;
    layoutStatus = '';
    stopLayoutSettings = deps.effectiveSettings.subscribe(paintLayout);
    deps.host.addEventListener('gamepadconnected', paintLayout);
    deps.host.addEventListener('gamepaddisconnected', paintLayout);
    paintLayout();
  });
  hud.onControllerLayoutClose(() => {
    layoutOpen = false;
    capture = null;
    layoutStatus = '';
    stopLayoutSettings?.();
    stopLayoutSettings = null;
    deps.host.removeEventListener('gamepadconnected', paintLayout);
    deps.host.removeEventListener('gamepaddisconnected', paintLayout);
  });
  hud.onControllerLayoutRequest((request) => {
    if (!layoutOpen) return;
    if (request.kind === 'cancel') {
      if (capture !== null) layoutStatus = cancelledStatus(capture.action);
      capture = null;
      paintLayout();
      return;
    }
    const profile = activeLayoutProfile(readConnectedPads(deps.menuGamepads));
    if (profile === null) {
      paintLayout();
      return;
    }
    if (request.kind === 'capture') {
      capture = createBindingCapture(request.action, profile);
      layoutStatus = captureStatus(request.action);
      paintLayout();
      return;
    }
    capture = null;
    // The status is set BEFORE the write: an accepted write repaints through the subscription,
    // and that repaint has to carry the sentence describing it.
    if (request.kind === 'preset') {
      layoutStatus = presetStatus(request.preset);
      deps.settings.setControllerLayout(profile.id, { ...storedLayout(profile.id), preset: request.preset });
    } else {
      layoutStatus = RESET_STATUS;
      deps.settings.resetControllerLayout(profile.id);
    }
    paintLayout();
  });

  function pollBindingCapture(): void {
    if (capture === null) return;
    const step = capture.step(readConnectedPads(deps.menuGamepads));
    if (step.kind === 'waiting') return;
    const { action, profile } = capture;
    capture = null;
    if (step.kind === 'cancel') {
      layoutStatus = cancelledStatus(action);
    } else {
      // Both halves of a swap in ONE write: the resolver refuses a one-sided binding onto an
      // occupied button (see `rebind`).
      const result = rebind(profile, storedLayout(profile.id), action, step.controlId);
      layoutStatus = captureResultStatus(profile, action, step.controlId, result);
      if (result.kind === 'bound') deps.settings.setControllerLayout(profile.id, result.layout);
    }
    paintLayout();
    // Announced through the HUD's one live region. A capture ends on a controller press with
    // focus still on the row, so without this a screen-reader player hears nothing happen.
    hud.showToast(layoutStatus);
  }

  /**
   * THE GALLERY WORKBENCH (issue #730), held the way the Customize preview is: mounted when
   * the pane opens, disposed when it closes, and disposed again, harmlessly, at teardown.
   *
   * The pane reopens on what it last showed. The first open reads the page's `?gallery=`
   * value; after that the selection a developer built survives a Back, for the reason the
   * configuration menu's does -- building it is the slow part. The value kept is the
   * canonical one, so a report about the page's link is not shown a second time.
   *
   * Absent `deps.galleryWorkbench`, nothing mounts. The HUD hides the entry on such a page,
   * so this is the backstop for a HUD and deps that disagree, not a path a player reaches.
   */
  let gallery: GalleryWorkbenchView | null = null;
  let galleryValue: string | null = deps.galleryWorkbench?.initial ?? null;
  const disposeGallery = (): void => {
    if (gallery === null) return;
    if (deps.galleryWorkbench !== undefined) {
      galleryValue = formatGallerySelection(gallery.selection, deps.galleryWorkbench.catalog);
    }
    gallery.dispose();
    gallery = null;
  };
  hud.onGalleryOpen(() => {
    const bench = deps.galleryWorkbench;
    if (bench === undefined) return;
    disposeGallery();
    gallery = mountGalleryWorkbench(hud.galleryBody, {
      catalog: bench.catalog,
      create: bench.create,
      raf: deps.raf,
      initial: galleryValue,
      linkFor: bench.linkFor,
      saveStill: bench.saveStill,
    });
  });
  hud.onGalleryClose(disposeGallery);

  /**
   * Everything the Records page shows, read from the page's own stores.
   *
   * The stores are current at every instant -- a session records INTO them rather than
   * keeping a copy -- so there is no moment at which reading them is early or late. That
   * is what lets the page own this surface outright (issue #324, step S5) where the
   * gameplay session used to push the same two values on every event-bearing frame: the
   * frames were only ever a way of not missing a change, and a page that reads on open
   * cannot miss one.
   */
  function paintRecords(): void {
    hud.setStats({ lifetime: deps.stats.lifetime(), attempt: deps.stats.attempt() });
    hud.setAchievements(deps.achievements.earned());
  }

  // Both tabs, on every open -- see `onRecordsOpen`'s own doc comment. The Records button
  // is shown at the Main Menu only (hud.ts hides it elsewhere), so this fires exactly
  // when the tables are about to be read and never during a match.
  hud.onRecordsOpen(paintRecords);

  hud.onResetStats(() => {
    deps.stats.resetStats();
    // Through the shared painter, which also re-reads the achievements half this button
    // does not touch. That is a repaint of an unchanged set, not a claim that Reset stats
    // clears anything else: one painter for one surface is what stops the two tabs
    // acquiring separate refresh rules.
    paintRecords();
  });

  hud.onResetProgress(() => {
    deps.progress.reset();
    // Achievements are progress, not statistics: this is the one reset that clears
    // them, and Reset stats deliberately leaves them alone.
    deps.achievements.reset();
    paintRecords();
    // Levels re-lock immediately: the select the player is looking at must not keep
    // offering a level the save no longer justifies.
    hud.setLevelSelect(unlockedLevels(), deps.levels.levels.length);
  });

  return {
    restyle,
    openVersusSetup,
    toggleMute,
    unlockedLevels,
    resizePreview(): void {
      preview?.resize();
    },
    disposePreview(): void {
      preview?.dispose();
      preview = null;
    },
    disposeGallery,
    setStyleSink(sink: StyleSink | null): void {
      styleSink = sink;
    },
    pollBindingCapture,
    capturingBinding: () => capture !== null,
  };
}
