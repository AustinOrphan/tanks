import type { GamepadLike } from './gamepad';

/**
 * WHICH RAW INDEX MEANS WHICH TANKS ACTION, and whether this pad may be read at all
 * (issue #596).
 *
 * The defect this closes. `navigator.getGamepads()` can report a pad the browser has NOT
 * remapped -- `mapping: ''`, or a vendor string -- and every reader in this directory used
 * the standard-mapping indices on it regardless: axes 0-3 for the sticks, buttons 6 and 7
 * for mine and fire, 0/1/9/12-15 for the menu. On a pad whose layout those indices get
 * wrong, that is not "no input"; it is the WRONG input, silently. A stick reading as a
 * trigger is indistinguishable from a player pushing a trigger.
 *
 * So a pad is classified before it is read, and a pad that cannot be classified is not read
 * at all. `classifyPad` is the whole of that decision and is pure: a plain object in, a
 * verdict out, no DOM and no `navigator`, so every fixture the issue asks for -- standard,
 * recognized non-standard, unknown, insufficient -- is written as data.
 *
 * IDENTITY IS NOT PROFILE, which is the separation the issue names first. `padIndex` and
 * `id` say WHICH physical device this is and belong to `assignment.ts` and
 * `gamepad-diagnostics.ts`; a `ControlProfile` says how to READ one, and several devices can
 * share one. Nothing here holds an index.
 *
 * WHAT THIS DOES NOT OWN. The shipped non-standard catalogue below is EMPTY: the standard
 * profile is built in, and no device-specific profile ships yet. The first one belongs to
 * issue #606, which says in its own
 * dependencies that this layer "should provide the abstraction this implementation plugs
 * into" -- and #595 is the hardware investigation that has to come first, because a profile
 * is a claim about a physical device's layout and inventing one from no evidence would ship
 * a guess as a fact. Player-facing copy for an unsupported pad belongs to #597; this module
 * produces a structured reason and no prose.
 */

/** The axis pair positions a profile names. Values are indices into `Gamepad.axes`. */
export interface ProfileAxes {
  readonly moveX: number;
  readonly moveY: number;
  readonly aimX: number;
  readonly aimY: number;
}

/**
 * The button positions a profile names. Values are indices into `Gamepad.buttons`.
 *
 * MENU AND GAMEPLAY IN ONE RECORD, on purpose. They were two hard-coded sets in two files,
 * and issue #494 was caused by those sets overlapping: Confirm and Fire were both button 0,
 * so confirming Resume leaked a shell into the first simulated tick. Naming all nine
 * together is what lets `profileCollides` below be written at all -- a check that is
 * impossible when the two halves live in separate modules and neither can see the other.
 */
export interface ProfileButtons {
  readonly fire: number;
  readonly mine: number;
  readonly confirm: number;
  readonly back: number;
  readonly pause: number;
  readonly up: number;
  readonly down: number;
  readonly left: number;
  readonly right: number;
}

/** One way of reading a pad: every logical Tanks control, as raw indices. */
export interface ControlProfile {
  /** Stable identifier, for traces and diagnostics. Not player-facing copy. */
  readonly id: string;
  /** What this profile is for, in a developer's words. Not player-facing copy. */
  readonly label: string;
  readonly axes: ProfileAxes;
  readonly buttons: ProfileButtons;
}

/**
 * The standard Gamepad API layout, and THE ONE PLACE its indices are written.
 *
 * `gamepad.ts` and `gamepad-menu.ts` derive their exported constants from this record
 * rather than restating the numbers, so "the standard profile" and "what the reader
 * actually reads" cannot drift apart -- they are the same eleven values. The rationale for
 * each choice stays with the constant that exports it: why fire is the RIGHT trigger and
 * mine the left is a twin-stick argument and lives in `gamepad.ts`; why confirm is A and
 * back is B is a console convention and lives in `gamepad-menu.ts`.
 */
export const STANDARD_PROFILE: ControlProfile = Object.freeze({
  id: 'standard',
  label: 'Standard Gamepad API mapping',
  axes: Object.freeze({ moveX: 0, moveY: 1, aimX: 2, aimY: 3 }),
  buttons: Object.freeze({
    fire: 7,
    mine: 6,
    confirm: 0,
    back: 1,
    pause: 9,
    up: 12,
    down: 13,
    left: 14,
    right: 15,
  }),
});

/**
 * How a non-standard pad is recognized as one this catalogue knows.
 *
 * Every field is optional and every PRESENT field must match, so a profile can be as loose
 * or as tight as its evidence supports. `idIncludes` is a case-insensitive substring rather
 * than an equality test because a browser's `id` carries vendor and product codes that
 * differ per browser and per firmware -- issue #606 asks for "robust browser-reported
 * characteristics, avoiding brittle exact-id matching", and an exact `id` is the brittle
 * thing it means.
 *
 * A matcher with NO fields set would match every pad, which would make the first catalogue
 * entry swallow every unknown device; `validateProfileCatalogue` refuses it.
 */
export interface ProfileMatcher {
  /** `Gamepad.mapping`, compared exactly. `''` is a real value and matches a pad reporting none. */
  readonly mapping?: string;
  /** A case-insensitive substring of `Gamepad.id`. */
  readonly idIncludes?: string;
  /** Exact `axes.length`. */
  readonly axes?: number;
  /** Exact `buttons.length`. */
  readonly buttons?: number;
}

/** A catalogue entry: how to recognize a pad, and how to read it once recognized. */
export interface ProfileEntry {
  readonly match: ProfileMatcher;
  readonly profile: ControlProfile;
}

/**
 * The shipped non-standard catalogue. EMPTY, and deliberately so -- see this module's
 * header. Issue #606 adds the first entry once #595 has measured a real adapter; adding one
 * is a data change here and touches no reader.
 *
 * Typed and exported rather than inlined so that the empty case is a visible decision with a
 * reason beside it, instead of a missing feature.
 */
export const PROFILE_CATALOGUE: readonly ProfileEntry[] = Object.freeze([]);

/**
 * Why a pad will not be read. Structured, never prose: issue #596 requires "a structured
 * unsupported reason for UI/diagnostics without embedding presentation copy in the input
 * layer", and #597 owns the sentence a player sees.
 */
/** No catalogue entry matched, and the browser did not report the standard mapping. */
export interface UnknownMappingReason {
  readonly code: 'unknown-mapping';
  /** Verbatim, `''` when the browser reported none -- the same convention `PadDiagnostic` uses. */
  readonly mapping: string;
  readonly id: string;
}

/**
 * A profile DID match, and the pad does not expose the controls it names. The counts are
 * carried so a diagnostic can say "4 buttons, 16 needed" without re-deriving either.
 */
export interface InsufficientControlsReason {
  readonly code: 'insufficient-controls';
  readonly profileId: string;
  readonly axes: number;
  readonly buttons: number;
  readonly requiredAxes: number;
  readonly requiredButtons: number;
}

export type UnsupportedReason = UnknownMappingReason | InsufficientControlsReason;

/**
 * The verdict on one pad. Four cases, which are the four the issue asks to distinguish --
 * and `standard` is kept separate from `profile` rather than folded into one "supported"
 * case, because the question "did the browser remap this, or did we recognize it ourselves"
 * is exactly what a compatibility report needs to answer.
 */
export type PadSupport =
  | { readonly kind: 'standard'; readonly profile: ControlProfile }
  | { readonly kind: 'profile'; readonly profile: ControlProfile }
  // The `reason` is narrowed to the matching variant rather than left as the whole union, so
  // `kind` and `reason.code` cannot disagree and a consumer reading `reason.axes` off an
  // `insufficient` verdict does not have to re-narrow a union the `kind` already settled.
  | { readonly kind: 'unknown'; readonly reason: UnknownMappingReason }
  | { readonly kind: 'insufficient'; readonly reason: InsufficientControlsReason };

/** The profile to read a pad with, or `null` when it must not be read at all. */
export function profileFor(support: PadSupport): ControlProfile | null {
  return support.kind === 'standard' || support.kind === 'profile' ? support.profile : null;
}

/**
 * How many axes and buttons a profile's own indices require.
 *
 * DERIVED, never declared beside the profile: a hand-written "needs 4 axes" can disagree
 * with the indices above it, and the disagreement is silent in the direction that matters
 * (too low, so an out-of-range index reads `undefined`). The highest index named plus one
 * is the requirement by construction.
 */
export function profileRequirements(profile: ControlProfile): {
  readonly axes: number;
  readonly buttons: number;
} {
  const axes = Math.max(...Object.values(profile.axes)) + 1;
  const buttons = Math.max(...Object.values(profile.buttons)) + 1;
  return { axes, buttons };
}

/**
 * Whether a profile puts a menu action and a gameplay action on the same button.
 *
 * THE ISSUE #494 GUARD, generalized. Fire and Confirm were the same button once, and
 * confirming Resume fired a shell on the first simulated tick; `gamepad.ts`'s resync exists
 * because of it. The standard profile no longer collides, but a NON-STANDARD profile could
 * reintroduce it silently -- a pad with few buttons is exactly the case where a catalogue
 * author is tempted to double one up. This is what makes that a refused catalogue rather
 * than a returned bug.
 *
 * Returns the colliding pairs, so the refusal can name them.
 */
export function profileCollisions(profile: ControlProfile): string[] {
  const gameplay = { fire: profile.buttons.fire, mine: profile.buttons.mine };
  const menu = {
    confirm: profile.buttons.confirm,
    back: profile.buttons.back,
    pause: profile.buttons.pause,
    up: profile.buttons.up,
    down: profile.buttons.down,
    left: profile.buttons.left,
    right: profile.buttons.right,
  };
  const out: string[] = [];
  for (const [g, gi] of Object.entries(gameplay)) {
    for (const [m, mi] of Object.entries(menu)) {
      if (gi === mi) out.push(`${g}/${m}`);
    }
  }
  return out;
}

/**
 * Refuses a catalogue that cannot mean what it says. Called on the shipped catalogue at
 * module load in `gamepad-profile.test.ts`, and available to any test or tool
 * that builds one.
 *
 * Throws rather than returning a result, on the same grounds as the entity catalogues in
 * `src/sim/`: an invalid profile is a programming error at authoring time, not a runtime
 * condition a reader should branch on.
 */
export function validateProfileCatalogue(entries: readonly ProfileEntry[]): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    const { id } = entry.profile;
    if (id === '') throw new Error('profile catalogue: an entry has an empty profile id');
    if (seen.has(id)) throw new Error(`profile catalogue: duplicate profile id ${JSON.stringify(id)}`);
    seen.add(id);
    if (id === STANDARD_PROFILE.id) {
      throw new Error(
        `profile catalogue: ${JSON.stringify(id)} is the built-in standard profile and cannot be redefined`,
      );
    }
    const fields = Object.values(entry.match).filter((v) => v !== undefined);
    if (fields.length === 0) {
      throw new Error(`profile catalogue: ${JSON.stringify(id)} has an empty matcher and would match every pad`);
    }
    const collisions = profileCollisions(entry.profile);
    if (collisions.length > 0) {
      throw new Error(
        `profile catalogue: ${JSON.stringify(id)} puts a gameplay and a menu action on one button (${collisions.join(', ')}) -- see issue #494`,
      );
    }
  }
}

function matches(match: ProfileMatcher, pad: GamepadLike): boolean {
  if (match.mapping !== undefined && (pad.mapping ?? '') !== match.mapping) return false;
  if (
    match.idIncludes !== undefined &&
    !(pad.id ?? '').toLowerCase().includes(match.idIncludes.toLowerCase())
  ) {
    return false;
  }
  if (match.axes !== undefined && pad.axes.length !== match.axes) return false;
  if (match.buttons !== undefined && pad.buttons.length !== match.buttons) return false;
  return true;
}

/**
 * The classifier.
 *
 * ORDER IS THE CONTRACT, and it is: the browser's own word first, the catalogue second,
 * refusal last.
 *
 *  1. `mapping === 'standard'` is the browser stating it has already remapped this pad onto
 *     the standard layout. Nothing in a catalogue may override that, which is what keeps the
 *     issue's "standard-mapped controllers retain current behavior" criterion true no matter
 *     what #606 later adds.
 *  2. Otherwise the catalogue is searched in order and the FIRST match wins.
 *  3. Otherwise the pad is unknown and will not be read.
 *
 * A pad that reaches step 1 or 2 is then checked against its profile's own requirements, so
 * "recognized" and "has the controls" are separate verdicts -- a `mapping: 'standard'` pad
 * exposing two axes is a real thing a browser can report, and reading its aim stick off the
 * end of the array would be the silent-wrong-input defect again, one layer down.
 *
 * @param catalogue Injected with the shipped one as the default, so a test can classify
 * against a fixture catalogue without mutating module state.
 */
export function classifyPad(
  pad: GamepadLike,
  catalogue: readonly ProfileEntry[] = PROFILE_CATALOGUE,
): PadSupport {
  const mapping = pad.mapping ?? '';
  const recognized: { profile: ControlProfile; kind: 'standard' | 'profile' } | null =
    mapping === 'standard'
      ? { profile: STANDARD_PROFILE, kind: 'standard' }
      : (() => {
          const entry = catalogue.find((e) => matches(e.match, pad));
          return entry === undefined ? null : { profile: entry.profile, kind: 'profile' as const };
        })();

  if (recognized === null) {
    return { kind: 'unknown', reason: { code: 'unknown-mapping', mapping, id: pad.id ?? '' } };
  }

  const need = profileRequirements(recognized.profile);
  if (pad.axes.length < need.axes || pad.buttons.length < need.buttons) {
    return {
      kind: 'insufficient',
      reason: {
        code: 'insufficient-controls',
        profileId: recognized.profile.id,
        axes: pad.axes.length,
        buttons: pad.buttons.length,
        requiredAxes: need.axes,
        requiredButtons: need.buttons,
      },
    };
  }
  return recognized.kind === 'standard'
    ? { kind: 'standard', profile: recognized.profile }
    : { kind: 'profile', profile: recognized.profile };
}
