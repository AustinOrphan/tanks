import type { PlatformCapabilities } from './capabilities';

/**
 * WHICH control settings are worth showing on this device (issue #227).
 *
 * The complement of `effective-settings.ts`, and the two must not be confused. That module
 * decides what a setting RESOLVES to; this one decides whether the player is offered the
 * control at all. `capabilities.ts` says so at the `touch` field: "the effective touch
 * scheme and fire mode are the stored preference regardless, because gating them would
 * silently rewrite a hybrid device's working settings. Which controls to SHOW from this is
 * issue #227." So nothing here may change a value -- it returns a presentation verdict and
 * the stored preference sits untouched behind it.
 *
 * THE RULE THAT DECIDES OMIT VERSUS EXPLAIN, because the issue asks for both and they pull
 * against each other ("irrelevant settings are omitted rather than disabled without
 * purpose" / "a temporarily unavailable but meaningful setting explains why"):
 *
 *  - A STABLE absence is omitted. No amount of plugging things in gives a desktop browser a
 *    touchscreen or `navigator.vibrate`, so a control for either is not "unavailable", it is
 *    irrelevant, and a disabled button with an explanation would be clutter that never
 *    resolves.
 *  - A TRANSIENT absence is shown and explained. `controllerRumble` is "at least one
 *    CONNECTED pad exposes a rumble actuator" (capabilities.ts), which the player changes by
 *    plugging one in. Hiding it would make the setting appear from nowhere on hotplug with
 *    no way to have anticipated it.
 *
 * PURE, and keyed off `PlatformCapabilities` rather than a user-agent string -- which is the
 * issue's own acceptance criterion ("capability and prompt logic have focused tests
 * independent of user-agent sniffing") and what lets the device matrix be a table of plain
 * objects in `control-relevance.test.ts`.
 *
 * NOT keyed off MODALITY, deliberately. The last input a player touched is transient and
 * oscillates on a hybrid device; a settings pane that rearranged itself because someone
 * brushed a trackpad would be the flicker the issue exists to prevent. Modality drives
 * `keyHint`'s transient button prompts and nothing durable.
 */

/** The four control settings whose relevance depends on the device. */
export type RelevanceSettingId = 'touchScheme' | 'fireMode' | 'deviceHaptics' | 'controllerRumble';

export type Relevance =
  /** Offer it normally. */
  | { readonly kind: 'shown' }
  /** Remove it: nothing the player can do makes it apply here. */
  | { readonly kind: 'omitted' }
  /** Keep it on screen, refused, and say what would make it work. */
  | { readonly kind: 'unavailable'; readonly reason: string };

/**
 * Why rumble is refused, in the player's terms and naming the action that fixes it.
 *
 * Says CONNECTED rather than "supported": a pad can be plugged in and still report no
 * actuator (Firefox exposes none at all today), and telling that player to connect a
 * controller they have already connected is worse than saying nothing.
 */
export const RUMBLE_UNAVAILABLE_REASON =
  'No connected controller reports a rumble motor. Connect one that does and this turns on.';

export const SHOWN: Relevance = Object.freeze({ kind: 'shown' });
const OMITTED: Relevance = Object.freeze({ kind: 'omitted' });
const RUMBLE_UNAVAILABLE: Relevance = Object.freeze({
  kind: 'unavailable',
  reason: RUMBLE_UNAVAILABLE_REASON,
});

/**
 * The verdict for every relevance-bearing setting, from capabilities alone.
 *
 * Returns ALL four every time rather than only the ones that changed: a partial record is
 * how a control gets hidden once and never restored, and the caller applies the whole set
 * on each push.
 */
export function settingRelevance(
  capabilities: PlatformCapabilities,
): Record<RelevanceSettingId, Relevance> {
  // Both touch controls answer to the same fact, and neither is a separate question: a
  // device with no touchscreen has no aim thumb to scheme and no fire gesture to mode.
  const touch = capabilities.touch ? SHOWN : OMITTED;
  return {
    touchScheme: touch,
    fireMode: touch,
    // `navigator.vibrate` is the device's own motor. A browser either has it or does not,
    // and no controller changes that -- rumble is the separate setting below.
    deviceHaptics: capabilities.deviceVibration ? SHOWN : OMITTED,
    controllerRumble: capabilities.controllerRumble ? SHOWN : RUMBLE_UNAVAILABLE,
  };
}

/** Whether a verdict puts the control on screen at all, refused or not. */
export function isOffered(relevance: Relevance): boolean {
  return relevance.kind !== 'omitted';
}
