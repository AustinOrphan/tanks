/**
 * The behavioural half of the UI kit (issue #321).
 *
 * `hud.css`'s `.ui-*` classes say what a primitive LOOKS like. This module owns what a
 * primitive DOES, for the parts that cannot live in a stylesheet: the accessible state a
 * control has to expose, and the association between a disabled control and the reason
 * it is disabled.
 *
 * It exists because the visual and the semantic halves of a state drifted apart. Five
 * choice rows -- hull swatches, accent swatches, skins, controller sources and the versus
 * options -- each toggled a selected class of their own and none of them told assistive
 * technology anything at all, so the current choice was carried by a white border and by
 * nothing else. A helper that moves both together is the only way that stays true for the
 * sixth row.
 *
 * Deliberately dependency-free and DOM-only: no sim, no storage, no state machine. It is
 * the layer #317's shell can build screens on without pulling `hud.ts` in behind it.
 */

/** The class `hud.css`'s `.ui-selectable--on` rule colours the selection ring with. */
const SELECTED_CLASS = 'ui-selectable--on';

/**
 * Mark a choice control as the current one, in both channels at once.
 *
 * `aria-pressed` rather than `role="radio"` + `aria-checked`, deliberately. A radio group
 * brings its own focus contract -- one tab stop for the group, arrow keys moving the
 * checked option -- and the HUD already has a roving tabindex of its own that walks every
 * `button, [tabindex]` in the panel (`onNavKeyDown`, issue #115). Declaring radios would
 * describe a keyboard model the panel does not implement, which is worse than describing
 * a toggle it does. The attribute is written on BOTH branches, never removed: a control
 * that has been selected and then deselected must still announce that it is pressable,
 * and an absent `aria-pressed` announces a plain button instead.
 */
export function setSelected(el: Element, selected: boolean): void {
  el.classList.toggle(SELECTED_CLASS, selected);
  el.setAttribute('aria-pressed', String(selected));
}

/**
 * Point a disabled control at the element that says why it is disabled.
 *
 * `aria-describedby` rather than putting the reason in the label: the reason is shared by
 * a whole row of controls and changes independently of any one of them, and a described-by
 * reference lets one visible line serve all of them without repeating it into every
 * accessible name. The reference is REMOVED when the control is enabled, so a screen
 * reader never reads a stale explanation for a control that now works.
 *
 * Removing rather than leaving an empty attribute matters: `aria-describedby=""` is still
 * a described-by relationship pointing at nothing, which some assistive technology reports
 * as a broken reference rather than as an absence.
 */
export function describeDisabledReason(el: Element, reasonId: string | null): void {
  if (reasonId === null) el.removeAttribute('aria-describedby');
  else el.setAttribute('aria-describedby', reasonId);
}
