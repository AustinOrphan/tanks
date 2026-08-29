import { createAudioEngine, type AudioEngine } from '../audio/engine';
import { AUDIO_MANIFEST } from '../audio/manifest';
import { createBrowserAppSettings, type AppSettings } from './app-settings';

/**
 * PAGE-scoped ownership of everything that must outlive a game session (issue #317).
 *
 * `app-settings.ts` established this shape for persistence and said so in its own doc
 * comment: *"This is deliberately NOT the persistent app shell of issue #317... #317 moves
 * the construction, not the model."* This is that move. `AppSettings` is now one of the
 * things the shell owns rather than the thing `boot.ts` owns directly, and two more join
 * it -- the audio engine and the Launch gate -- for the same reason it was hoisted:
 * `boot.ts` disposes the whole game handle and builds a fresh `GameDeps` on every
 * Campaign<->Versus switch, so anything a session owns restarts at its default there.
 *
 * What that costs when it is NOT owned above the session:
 *
 *  - **The Launch gate.** `createGameStateMachine` opens at the Launch route, so every
 *    reboot re-showed "Press any key or tap to begin" to a player who had already
 *    dismissed it. That is the acceptance criterion "the Launch gate appears at most once
 *    per document load".
 *  - **Audio.** A rebuilt engine starts with a suspended context. It self-heals -- the
 *    engine keeps its own document-level gesture listener and `tryResume` retries rather
 *    than latching (`audio/engine.ts`) -- so skipping the splash does not break UNLOCKING.
 *    What it breaks is ORDERING: the splash is what guaranteed a gesture had happened
 *    before the menu was on screen, and skipping it without hoisting the engine would
 *    trade a redundant splash for a menu that is silent until the player happens to click.
 *    Hoisting the engine is what makes skipping the splash correct rather than merely
 *    tolerable, which is why the two land together.
 */
export interface AppShell {
  /** The page's one settings/persistence owner. Unchanged by this module; only re-homed. */
  readonly settings: AppSettings;
  /**
   * The page's one audio engine, already unlocked by the time a second session exists.
   *
   * A session must NOT dispose this -- see `GameDeps.releaseAudio`, which is what a
   * session calls instead, and which stops the outgoing music bed without taking the
   * engine (and its resumed `AudioContext`) down with it.
   */
  readonly audio: AudioEngine;
  /**
   * Has the page-level Launch handoff already happened this document load?
   *
   * Read when a session's state machine is built, to decide whether it opens on the
   * splash or straight on the Main Menu.
   */
  launchDismissed(): boolean;
  /** Record that it has. Idempotent, and never reset: "per document load" is the point. */
  dismissLaunch(): void;
  /**
   * Release the page's owners. Called ONLY from the page teardown (`boot.ts`'s
   * non-persisted `pagehide`), never from a session -- the next session would get a
   * disposed audio engine and settings that stop reacting.
   */
  dispose(): void;
}

export interface AppShellDeps {
  readonly settings: AppSettings;
  readonly audio: AudioEngine;
}

export function createAppShell(deps: AppShellDeps): AppShell {
  let launchDone = false;
  return {
    settings: deps.settings,
    audio: deps.audio,
    launchDismissed: () => launchDone,
    dismissLaunch(): void {
      launchDone = true;
    },
    dispose(): void {
      // Audio first: it is the one holding a real `AudioContext` and document-level
      // listeners, and nothing in settings teardown depends on it being alive.
      deps.audio.dispose();
      deps.settings.dispose();
    },
  };
}

/**
 * The real one: browser storage and capability probes, the shipped audio manifest.
 *
 * The same shape as `createBrowserAppSettings`, which it wraps -- one unpinned wiring
 * line, named by `main.ts` and called exactly once by `boot.ts`.
 */
export function createBrowserAppShell(): AppShell {
  return createAppShell({
    settings: createBrowserAppSettings(),
    audio: createAudioEngine(AUDIO_MANIFEST),
  });
}
