/**
 * The blocked-fire CUE: which channel(s) tell the player their shot was refused. One
 * semantic signal with four consumers in three layers -- `game/haptics.ts` (buzz),
 * `audio/director.ts` (click), `render/blocked-fire-ring.ts` and `render/renderer.ts`
 * (ring) -- chosen by the application (`game/devflags.ts` parses `?blockedFire=`) and
 * implemented by each projection for the arms that name its channel. Issue #473 moved
 * the vocabulary here from `game/devflags.ts` so the audio director and the renderer no
 * longer import the developer-flag parser to name a cue.
 *
 * Issue #356's candidate blocked-fire cues, named so they can be compared in one session.
 *
 * `haptic`, `audio`, and `haptic+audio` -- the last being the MULTIMODAL combination the
 * issue asks for by name ("compare at least one multimodal combination against the
 * strongest single-channel treatment"). Those two channels are deliberately the ones that
 * need no screen space, so they can be judged without the HUD arms existing yet.
 *
 * `ring` is the tank-local visual treatment (render/blocked-fire-ring.ts), and
 * `ring+audio` pairs it with the click -- a SECOND multimodal arm, so the issue's
 * "multimodal against the strongest single channel" comparison is not itself limited to
 * one combination.
 *
 * Still to come: the weapon-local pulse and the transient HUD readout. Neither is omitted
 * for lack of a flag -- the flag is the part every arm shares -- but each needs its own
 * render artefact.
 */
/**
 * Exported so each channel's suite can assert one row PER CUE rather than per remembered
 * case. A cue reaches a channel when its name carries that channel, but nothing enforces
 * that -- every consumer enumerates the members it acts on -- and `ring+audio` was added to
 * the union twice over before a table caught either half: the audio enumeration in
 * director.ts was left at two arms so the pair shipped silent, and blocked-fire-ring.ts's
 * own gate then went un-asserted for the paired cue (measured: narrowing it to
 * `cue !== 'ring'` left all 8 of that file's tests green).
 *
 * Three of the four consumers now key a table off this set -- director.test.ts (`audio`),
 * haptics.test.ts (`haptic`), blocked-fire-ring.test.ts (`ring`) -- so a sixth cue fails
 * them until its channels are stated. The fourth, renderer.ts's construction gate, is not
 * among them: it has no sibling Vitest file by policy (.claude/rules/rendering.md) and is
 * reached only through the GL harness, which exercises `ring` alone.
 */
export const BLOCKED_FIRE_CUES = new Set(['haptic', 'audio', 'haptic+audio', 'ring', 'ring+audio']);
export type BlockedFireCue = 'haptic' | 'audio' | 'haptic+audio' | 'ring' | 'ring+audio';
