/**
 * The page-side AudioContext override every browser tool that boots the app installs
 * (issues #860, #875, #877).
 *
 * WHY THIS FILE EXISTS. The override arrived in `tools/screens/steps.mjs` because the screen
 * capture harness was where the wedge was first diagnosed. Importing it from there would make
 * `tools/visual`, `tools/gallery`, `tools/bench`, `tools/uikit` and `tools/audio` depend on
 * the screens harness for one string, so it lives beside `playwright.mjs` instead: the
 * tools-family shelf for things every tool may need and no tool owns. Nothing here launches a
 * browser or touches a socket, so a unit test can import it.
 */

/**
 * Removed before boot, in every capture, on every platform.
 *
 * `new AudioContext()` is not uniformly cheap: on some hosts Chromium's audio service never
 * connects and the constructor returns only after an internal 20-SECOND timeout. The app
 * builds two contexts during startup -- Howler's, when `createAudioEngine` first touches
 * `Howler.volume()`, and its own in `engine.ts`'s `ensureCtx` -- so on such a host the page
 * blocks for ~40 s before `load` fires and every capture of a script-running state dies on
 * Playwright's 30 s navigation default. That is what made the screen tools look wedged
 * locally while passing in CI, and why the script-disabled states were the only ones that
 * came back (issue #860).
 *
 * Deleting the constructor takes the app down a path it already supports rather than a
 * broken one: `ensureCtx` is written to return null when the constructor is absent, and
 * Howler falls back to HTML5 Audio when `AudioContext` is undefined.
 *
 * UNCONDITIONAL, not opt-in behind an environment variable, and that is the point. A flag
 * only the wedged machines set would let a local capture and a CI capture photograph
 * different pages -- precisely the divergence these gates exist to catch, and the same
 * lesson the bundled typeface (issue #864) already cost us once. Measured before it went
 * in: all 45 states in the checked subset produce byte-identical measurements and the same
 * zero page errors with the real constructor and without it, so what the gate compares is
 * unchanged and only the host dependency is gone.
 *
 * The host condition is also INTERMITTENT, which is a second argument for unconditional. The
 * same box that recorded the reproducible `20003 ms` in #860 measured 21-75 ms when #877 was
 * implemented, across five launch configurations (default args, the swiftshader args two of
 * the tools pass, `channel: 'chromium'`, and the headless shell). Nothing in the repository
 * changed in between. A tool that only installed the override where the wedge reproduces
 * would therefore install it or not depending on the day.
 *
 * `OfflineAudioContext` is deliberately left alone. It is a different constructor that never
 * touches the audio device, and it is what `tools/audio/render.mjs` renders through -- see
 * that tool's own note for the measurement proving its output is unchanged by this override.
 */
export function audioContextOverrideSource() {
  return `(() => {
    delete window.AudioContext;
    delete window.webkitAudioContext;
  })()`;
}
