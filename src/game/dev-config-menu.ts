import {
  devControls,
  devSearchFrom,
  explainDevConfig,
  DEV_FLAG_GROUPS,
  DEV_PRESETS,
  type DevControl,
  type DevConfigNote,
  type DevConfigState,
  type DevFlagGroup,
  type DevPresetSpec,
  type DevSelection,
} from './dev-config';
import { selectStorageNamespace, type StorageNamespace } from './storage';

/**
 * The Developer Tools configuration menu's VIEW MODEL (issue #246).
 *
 * Issue #623 already built the model: the registry-derived control list, the six presets,
 * the URL builder and the explainer. This issue renders it, and this module is the layer
 * between -- pure, no DOM, so the whole of "what would the menu show" is assertable without
 * a browser.
 *
 * THE ROUND TRIP IS THE DESIGN, and it is what makes the preview honest. A selection is
 * turned into a SEARCH STRING (`devSearchFrom`), and everything shown is then read back out
 * of that string by `explainDevConfig` -- which routes `parseDeveloperMode` and
 * `parseDevFlags`, the same two functions `createBrowserDeps` calls at boot. So the preview
 * is not a second computation of what the flags mean; it is the real one, run early. Apply
 * and Reload navigates to the exact string it previewed and Copy Link copies it, which is
 * the whole of "Apply and Reload starts with the previewed effective configuration".
 *
 * Deriving the notes from the SELECTION instead would let the preview and the reload
 * disagree, and nothing in the suite would notice.
 *
 * THE WARNING VOCABULARY IS THE MODEL'S. Five `DevConfigReason` values plus
 * `unknownParams`, and no more: the owner's 2026-09-08 ruling on this issue is that the
 * surface renders the semantics the configuration model actually provides, and that separate
 * `clamped`/`deprecated`/`incompatible` categories are not to be invented to satisfy older
 * wording. `DEPRECATED_DEV_PARAMS` is exported empty and is deliberately not a category here.
 */

/** One control, with the value the menu currently holds for it and the model's notes about it. */
export interface MenuControl {
  readonly control: DevControl;
  /**
   * What the menu has selected, in the shape `devSearchFrom` takes: `false`/absent for an
   * off toggle, a string for a select or an input, `true` for an on toggle.
   */
  readonly value: string | number | boolean | null;
  /** Every note the explainer produced for this field -- rejected, inert, bundle-forced, and so on. */
  readonly notes: readonly DevConfigNote[];
}

export interface MenuGroup {
  readonly group: DevFlagGroup;
  readonly controls: readonly MenuControl[];
}

export interface DevMenuView {
  /** Every group in `DEV_FLAG_GROUPS` order; a group with no controls is omitted. */
  readonly groups: readonly MenuGroup[];
  /** The URL this selection means. Apply navigates to it; Copy Link copies it. */
  readonly search: string;
  /** What that URL actually produces, read back through the parser the game boots with. */
  readonly state: DevConfigState;
  /**
   * Which persistence namespace the previewed URL would boot into.
   *
   * Shown BEFORE Apply because it is the one consequence that outlives the reload and is
   * invisible in the flags: `selectStorageNamespace` keys off the gate, so a developer page
   * persists behind `tanks.dev.` and cannot see a production save at all. A player who lost
   * sight of that reads it as their progress having vanished.
   */
  readonly namespace: StorageNamespace;
  readonly presets: readonly DevPresetSpec[];
}

/** Notes the explainer produced that name no control -- unknown parameters carry the param, not a field. */
function notesFor(state: DevConfigState, field: string): DevConfigNote[] {
  return state.notes.filter((n) => n.field === field);
}

/**
 * What the menu shows for one selection.
 *
 * `base` is a `location.search`, whose NON-developer parameters `devSearchFrom` carries
 * through -- a deep link or a router's own query survives Apply.
 */
export function devMenuView(selection: DevSelection, base = ''): DevMenuView {
  const search = devSearchFrom(selection, base);
  const state = explainDevConfig(search);
  const controls = devControls();
  const groups: MenuGroup[] = [];
  for (const group of DEV_FLAG_GROUPS) {
    const inGroup = controls
      .filter((c) => c.group === group)
      .map((control): MenuControl => ({
        control,
        value: selection[control.field as keyof DevSelection] ?? null,
        notes: notesFor(state, control.field),
      }));
    if (inGroup.length > 0) groups.push({ group, controls: inGroup });
  }
  return {
    groups,
    search,
    state,
    namespace: selectStorageNamespace(search),
    presets: DEV_PRESETS,
  };
}

/**
 * RESET OPTIONS: developer mode with nothing else asked for.
 *
 * `devSearchFrom({})` and deliberately NOT `developerExitSearch`, whose job is to remove the
 * gate as well -- that would drop the page into the production namespace on the next load,
 * which is a different and much larger action than clearing the options.
 */
export function resetSelection(): DevSelection {
  return {};
}

/** Flip a toggle (or the bundle). Absent and `false` are the same thing to the builder. */
export function toggleField(selection: DevSelection, field: string): DevSelection {
  const next = { ...selection } as Record<string, unknown>;
  if (next[field] === true) delete next[field];
  else next[field] = true;
  return next as DevSelection;
}

/**
 * Step a select-like control through its own `values`, wrapping, with UNSET as one of the
 * stops.
 *
 * Unset has to be reachable or a control could never be put back: every one of these flags
 * defaults to absent, and a cycle over `values` alone would trap the menu on whichever value
 * it first landed on. It is the FIRST stop rather than the last so a fresh control's forward
 * press selects `values[0]` -- the reading a player expects from an unset control.
 */
export function cycleSelect(selection: DevSelection, control: DevControl, step = 1): DevSelection {
  const stops: (string | null)[] = [null, ...(control.values ?? [])];
  const current = (selection[control.field as keyof DevSelection] ?? null) as string | null;
  const at = stops.indexOf(current);
  const next = stops[(((at < 0 ? 0 : at) + step) % stops.length + stops.length) % stops.length];
  const out = { ...selection } as Record<string, unknown>;
  if (next === null) delete out[control.field];
  else out[control.field] = next;
  return out as DevSelection;
}

/**
 * Step a valued control's number, with the PARSER deciding what is in range.
 *
 * The registry states each input's accepted shape as prose for a human -- "an integer 1-4",
 * "a positive integer", "a 1-based index into the campaign, or the literal `sandbox`" -- and
 * nothing machine-readable. A stepper needs bounds, and the obvious move is to write them
 * down here, which duplicates knowledge `parseDevFlags` already owns and puts the menu one
 * edit away from offering a value the game will refuse.
 *
 * So this proposes a candidate and asks the model. `explainDevConfig` reports a `rejected`
 * note for a value the parser would not take, so a step that lands out of range is simply
 * not taken. The bounds are therefore always exactly the parser's, and adding a flag or
 * retuning a range needs no change here at all.
 *
 * `null` means unset; stepping up from unset starts at `from`, which is the first value the
 * flag can hold rather than a guess -- and stepping down THROUGH it clears the control,
 * because every one of these defaults to absent and an unreachable unset is a control that
 * can never be put back.
 */
export function stepNumeric(
  selection: DevSelection,
  control: DevControl,
  step: number,
  from = 1,
  base = '',
): DevSelection {
  const current = selection[control.field as keyof DevSelection] ?? null;
  const out = { ...selection } as Record<string, unknown>;
  if (current === null) {
    if (step < 0) return selection;
    out[control.field] = String(from);
    return accepted(out as DevSelection, control, base) ? (out as DevSelection) : selection;
  }
  const n = Number(current);
  if (!Number.isFinite(n)) return selection;
  const next = n + step;
  if (next < from && step < 0) {
    delete out[control.field]; // stepping below the first value clears it
    return out as DevSelection;
  }
  out[control.field] = String(next);
  return accepted(out as DevSelection, control, base) ? (out as DevSelection) : selection;
}

/** Whether the model takes this selection's value for one field, asked rather than assumed. */
function accepted(selection: DevSelection, control: DevControl, base: string): boolean {
  const state = explainDevConfig(devSearchFrom(selection, base));
  return !state.notes.some((n) => n.field === control.field && n.reason === 'rejected');
}

/**
 * Set a valued control to one of the literals its parser accepts beside a number --
 * `level=sandbox`, `walls=random:8` -- or clear it.
 *
 * Kept separate from `stepNumeric` because these are not points on the same axis: `sandbox`
 * is not a bigger level and `random:8` is not more walls than 8. The menu offers them as
 * their own control rather than as a stop a stepper walks through.
 */
export function setLiteral(
  selection: DevSelection,
  control: DevControl,
  literal: string | null,
): DevSelection {
  const out = { ...selection } as Record<string, unknown>;
  if (literal === null) delete out[control.field];
  else out[control.field] = literal;
  return out as DevSelection;
}
