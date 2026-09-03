/**
 * The blocked-fire CUE: which channel(s) tell the player their shot was refused. One
 * semantic signal with consumers in three layers -- `game/haptics.ts` (buzz),
 * `audio/director.ts` (click), `game/blocked-fire-hud.ts` (the transient capacity line),
 * and, under `render/`, `blocked-fire-ring.ts`, `blocked-fire-muzzle.ts`,
 * `blocked-fire-turret.ts`, `blocked-fire-pips.ts` and `renderer.ts`'s construction gate
 * -- chosen by the application (`game/devflags.ts` parses `?blockedFire=`) and
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
 * The visual channel's other four arms (issue #516) are built and each has its own
 * artefact: `muzzle` a flash at the barrel opening cut short of a real discharge
 * (render/blocked-fire-muzzle.ts), `turret` a recoil stutter on the gun itself
 * (render/blocked-fire-turret.ts), `pips` a capacity strip on the felt beside the tank
 * (render/blocked-fire-pips.ts), and `hud` a transient capacity line off the arena
 * (game/blocked-fire-hud.ts, painted by hud.ts's signalShellCapacity). Deliberately four
 * different pictures rather than four sizes of one: #356 rules by comparison, and arms
 * that differ only in degree would produce no ruling.
 *
 * The audio and haptic arms landed alongside them in their own change, so every
 * single-channel arm the matrix names is now implemented. Still to come: #516's pairing of
 * the strongest new visual with the strongest new audio, which the issue deliberately
 * defers until the single-channel arms exist to choose between.
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
 * Seven of the eight consumers now key a table off this set -- director.test.ts (`audio`),
 * haptics.test.ts (`haptic`), and one per visual arm in blocked-fire-ring.test.ts,
 * blocked-fire-muzzle.test.ts, blocked-fire-turret.test.ts, blocked-fire-pips.test.ts and
 * blocked-fire-hud.test.ts -- so a new cue fails all seven until its channels are stated.
 * The eighth, renderer.ts's construction gate, is not among them: it has no sibling Vitest
 * file by policy (.claude/rules/rendering.md) and is reached only through the GL harness,
 * which exercises the four arena arms against each other but not the whole cue set.
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
 * Which channel each cue BELONGS TO -- a vocabulary map, not a claim that anything is
 * wired (issue #516). `cueDrives(cue, 'audio')` answers "is this cue mine" for a
 * consumer in one place instead of each one listing members, but a cue can be named here
 * and still be completely inert: the twelve arms the comparison matrix adds are
 * classified from the day they are named and become audible, visible or felt only when a
 * consumer implements them. Ownership, in other words, not behaviour. A multimodal arm
 * belongs to more than one channel, which is why this is set-valued rather than a field.
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
