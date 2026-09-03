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
 * `haptic`, `audio`, and `haptic-audio` -- the last being the MULTIMODAL combination the
 * issue asks for by name ("compare at least one multimodal combination against the
 * strongest single-channel treatment"). Those two channels are deliberately the ones that
 * need no screen space, so they can be judged without the HUD arms existing yet.
 *
 * `ring` is the tank-local visual treatment (render/blocked-fire-ring.ts), and
 * `ring-audio` pairs it with the click -- a SECOND multimodal arm, so the issue's
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
 * that -- every consumer enumerates the members it acts on -- and `ring-audio` was added to
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
/**
 * The multimodal arms are spelled with a hyphen, not a plus, because these values are
 * typed into `?dev=1&blockedFire=...` by hand (issue #497). `URLSearchParams` decodes a
 * literal `+` as a space, so `ring+audio` reached the parser as `ring audio` and fell
 * back to null -- a playtester saw a silent flag and read it as a broken cue. Every
 * documented value must survive a paste unescaped; `devflags.test.ts` pins that for the
 * whole registry, and `devflags.ts` still accepts the properly encoded legacy `%2B`
 * spellings as aliases.
 */
export type BlockedFireCue =
  // Visual, tank- or weapon-local (issue #516's comparison matrix).
  | 'ring'
  | 'muzzle'
  | 'turret'
  | 'pips'
  | 'hud'
  // Audio.
  | 'audio'
  | 'click'
  | 'clunk'
  | 'thunk-soft'
  | 'pitch-empty'
  // Haptic.
  | 'haptic'
  | 'haptic-tap'
  | 'haptic-double'
  | 'haptic-long'
  | 'haptic-rise'
  // Multimodal.
  | 'haptic-audio'
  | 'ring-audio';
// Typed against the union rather than inferred as `Set<string>`, so iterating the set
// yields `BlockedFireCue` and a member the union does not name is a compile error here.
export const BLOCKED_FIRE_CUES: ReadonlySet<BlockedFireCue> = new Set<BlockedFireCue>([
  'ring',
  'muzzle',
  'turret',
  'pips',
  'hud',
  'audio',
  'click',
  'clunk',
  'thunk-soft',
  'pitch-empty',
  'haptic',
  'haptic-tap',
  'haptic-double',
  'haptic-long',
  'haptic-rise',
  'haptic-audio',
  'ring-audio',
]);

/**
 * The channel each cue drives, so a consumer asks "is this mine" once rather than
 * listing members (issue #516). A multimodal arm belongs to more than one channel,
 * which is the whole reason this is a set-valued question and not a field.
 */
export type BlockedFireChannel = 'visual' | 'audio' | 'haptic';

const CHANNELS: Readonly<Record<BlockedFireCue, readonly BlockedFireChannel[]>> = {
  ring: ['visual'],
  muzzle: ['visual'],
  turret: ['visual'],
  pips: ['visual'],
  hud: ['visual'],
  audio: ['audio'],
  click: ['audio'],
  clunk: ['audio'],
  'thunk-soft': ['audio'],
  'pitch-empty': ['audio'],
  haptic: ['haptic'],
  'haptic-tap': ['haptic'],
  'haptic-double': ['haptic'],
  'haptic-long': ['haptic'],
  'haptic-rise': ['haptic'],
  'haptic-audio': ['haptic', 'audio'],
  'ring-audio': ['visual', 'audio'],
};

/** True when `cue` drives `channel`. Null (the shipped default) drives nothing. */
export function cueDrives(cue: BlockedFireCue | null | undefined, channel: BlockedFireChannel): boolean {
  return cue != null && CHANNELS[cue].includes(channel);
}

/** Narrow a raw string (a URL flag value) to a cue the union names. */
export function isBlockedFireCue(raw: string): raw is BlockedFireCue {
  return (BLOCKED_FIRE_CUES as ReadonlySet<string>).has(raw);
}
