import {
  BINDABLE_ACTIONS,
  classifyPad,
  controlIdAt,
  presetsFor,
  profileFor,
  resolveEffectiveProfile,
  type BindableAction,
  type ControlLayout,
  type ControlProfile,
  type LayoutPreset,
} from '../input/gamepad-profile';
import type { ConnectedPad } from '../input/gamepad';

/**
 * The Settings controller-layout pane (issue #754): what it says, what a rebind writes, how a
 * button press is captured, and the pane body itself.
 *
 * Its own module rather than more of `hud.ts` for the reason `controller-selftest.ts` is: the
 * pane is a container the HUD owns and a body built from data the HUD does not model -- a
 * profile's bindable controls and a stored layout -- and `hud.ts` is already the largest file
 * in `src/game/`.
 *
 * NO RAW NUMBERS. Everything a player reads here is a name: an action's, a control's, or a
 * preset's. Indices stay inside `gamepad-profile.ts` and this module's capture step, and leave
 * them only as control ids. Raw indices belong to the Developer Tools self-test (#599).
 *
 * THE BODY IS BUILT ONCE. Unlike the self-test there is nothing analog to draw, so there is no
 * structure-versus-values split to make: the five actions are fixed, and every update writes
 * text and visibility into the nodes built at construction, which is what keeps focus on the
 * row a player just pressed.
 */

/** What each action is called on screen. */
export const ACTION_NAMES: Readonly<Record<BindableAction, string>> = Object.freeze({
  fire: 'Fire',
  mine: 'Mine',
  confirm: 'Confirm',
  back: 'Back',
  pause: 'Pause',
});

/**
 * Player-readable control names, per profile id.
 *
 * PER PROFILE, not per control id: the ids are positional (`face-bottom`), and a future
 * non-standard profile (#606) may put a differently labelled button in the same position. The
 * standard names give the two common labels for each position, since the Gamepad API's standard
 * mapping does not say whose controller it is.
 */
const CONTROL_NAMES: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({
  standard: Object.freeze({
    'face-bottom': 'A / Cross',
    'face-right': 'B / Circle',
    'face-left': 'X / Square',
    'face-top': 'Y / Triangle',
    'bumper-left': 'LB / L1',
    'bumper-right': 'RB / R1',
    'trigger-left': 'LT / L2',
    'trigger-right': 'RT / R2',
    select: 'View / Share',
    start: 'Menu / Options',
    'stick-left': 'Left stick press',
    'stick-right': 'Right stick press',
  }),
});

const PROFILE_NAMES: Readonly<Record<string, string>> = Object.freeze({
  standard: 'Standard controller',
});

export const PRESET_NAMES: Readonly<Record<LayoutPreset, string>> = Object.freeze({
  recommended: 'Recommended',
  southpaw: 'Southpaw',
});

export const PRESET_HINTS: Readonly<Record<LayoutPreset, string>> = Object.freeze({
  recommended: "The controller's own stick layout.",
  southpaw: 'Movement and aim sticks swapped.',
});

/**
 * A control's name for a player. An id with no written name reads as its words (`face-bottom`
 * -> "Face bottom") rather than as nothing, so a profile added without names is still usable.
 */
export function controlName(profileId: string, controlId: string | null): string {
  if (controlId === null) return 'Unnamed button';
  const named = CONTROL_NAMES[profileId]?.[controlId];
  if (named !== undefined) return named;
  const words = controlId.replace(/[-_.:]+/g, ' ').trim();
  return words.length === 0 ? 'Unnamed button' : words.charAt(0).toUpperCase() + words.slice(1);
}

export function profileName(profileId: string): string {
  return PROFILE_NAMES[profileId] ?? 'Controller';
}

/** The pane's text when no controller the game reads is visible. */
export const NO_CONTROLLER_TEXT =
  'No controller is visible yet. A browser only reports a controller after it is connected and a button is pressed — press one, and its layout appears here.';

export interface LayoutBindingRow {
  readonly action: BindableAction;
  readonly actionName: string;
  /** The name of the control this action reads now, after the layout is applied. */
  readonly controlName: string;
}

/** Everything the pane shows, in names. */
export interface ControllerLayoutModel {
  /** `null` when no controller the game reads is connected: the pane explains instead. */
  readonly profileName: string | null;
  readonly preset: LayoutPreset;
  /** The presets this profile can honour, in cycle order. One entry means no choice to offer. */
  readonly presets: readonly LayoutPreset[];
  readonly rows: readonly LayoutBindingRow[];
  /** Whether anything is stored for this profile, which is what Reset to Recommended removes. */
  readonly customised: boolean;
  /** The action waiting for a button press, if any. */
  readonly capturing: BindableAction | null;
  /** The last thing that happened, for the pane's status line. Empty for nothing. */
  readonly status: string;
}

export function layoutModel(
  profile: ControlProfile | null,
  layout: ControlLayout,
  capturing: BindableAction | null,
  status: string,
): ControllerLayoutModel {
  if (profile === null) {
    return { profileName: null, preset: 'recommended', presets: [], rows: [], customised: false, capturing: null, status };
  }
  const effective = resolveEffectiveProfile(profile, layout);
  const rows = BINDABLE_ACTIONS.map((action) => ({
    action,
    actionName: ACTION_NAMES[action],
    controlName: controlName(profile.id, controlIdAt(profile, effective.profile.buttons[action])),
  }));
  return {
    profileName: profileName(profile.id),
    preset: effective.preset,
    presets: presetsFor(profile),
    rows,
    // The STORED layout, not the effective one: a stale binding the reader refuses still sits in
    // storage, and Reset is how a player clears it.
    customised: layout.preset !== 'recommended' || Object.keys(layout.bindings).length > 0,
    capturing,
    status,
  };
}

export type RebindResult =
  /** The layout to store. `displaced` is the action that moved to make room, if one did. */
  | { readonly kind: 'bound'; readonly layout: ControlLayout; readonly displaced: BindableAction | null }
  /** The action already reads that control. Nothing to store. */
  | { readonly kind: 'unchanged' }
  /** The control cannot take this action on this profile. Nothing to store. */
  | { readonly kind: 'refused' };

/**
 * Put `action` on `controlId`, moving whichever action is there now onto the button `action`
 * is leaving.
 *
 * THE SWAP IS WRITTEN HERE, NOT BY THE RESOLVER. `resolveEffectiveProfile` refuses a binding
 * that would share a button and returns it to the profile's own button; it accepts a swap only
 * when BOTH halves are in the layout. So a one-sided write onto an occupied button would be
 * stored and then silently not take effect. This writes both halves together.
 *
 * Bindings the current profile refuses (a stale control id) are dropped rather than carried, so
 * one stale entry cannot make every later rebind fail. A binding that names the profile's own
 * button for its action says nothing and is dropped too, so a player who moves Fire away and
 * back is left with nothing to reset.
 */
export function rebind(
  profile: ControlProfile,
  layout: ControlLayout,
  action: BindableAction,
  controlId: string,
): RebindResult {
  const target = (profile.bindable ?? []).find((control) => control.id === controlId);
  if (target === undefined) return { kind: 'refused' };
  const current = resolveEffectiveProfile(profile, layout);
  const buttons = current.profile.buttons;
  if (buttons[action] === target.index) return { kind: 'unchanged' };

  const stale = new Set(current.refused.map((refusal) => refusal.action));
  const bindings: Partial<Record<BindableAction, string>> = {};
  for (const other of BINDABLE_ACTIONS) {
    const bound = layout.bindings[other];
    if (bound !== undefined && !stale.has(other)) bindings[other] = bound;
  }
  bindings[action] = controlId;

  const displaced = BINDABLE_ACTIONS.find((other) => other !== action && buttons[other] === target.index) ?? null;
  if (displaced !== null) {
    const vacated = controlIdAt(profile, buttons[action]);
    if (vacated === null) return { kind: 'refused' };
    bindings[displaced] = vacated;
  }

  for (const other of BINDABLE_ACTIONS) {
    const bound = bindings[other];
    if (bound !== undefined && (profile.bindable ?? []).some((c) => c.id === bound && c.index === profile.buttons[other])) {
      delete bindings[other];
    }
  }

  const next: ControlLayout = Object.freeze({ preset: layout.preset, bindings: Object.freeze(bindings) });
  if (resolveEffectiveProfile(profile, next).refused.length > 0) return { kind: 'refused' };
  return { kind: 'bound', layout: next, displaced };
}

export type CaptureStep =
  | { readonly kind: 'waiting' }
  | { readonly kind: 'cancel' }
  | { readonly kind: 'pressed'; readonly controlId: string };

export interface BindingCapture {
  readonly action: BindableAction;
  readonly profile: ControlProfile;
  /** Read one frame of connected pads. Call once per frame while capture is active. */
  step(pads: readonly ConnectedPad[]): CaptureStep;
}

/**
 * Wait for the next button press on a pad of `profile`'s kind.
 *
 * ONLY A NEW PRESS COUNTS. The first frame records what is already held -- the Confirm that
 * started capture is still down when it begins -- and a button counts only once it goes down
 * after being up. Otherwise the button that opened capture would bind itself.
 *
 * THE D-PAD CANCELS. It is never bindable (`STANDARD_PROFILE.bindable` leaves it out), so a new
 * D-pad press can never be a binding, which makes it the one controller way out that works
 * whatever is being rebound. Back cannot serve: Back's own button is a legitimate choice to
 * capture. A D-pad press on the same frame as a button press cancels.
 *
 * Pads of another profile are ignored, since their buttons would be named against the wrong
 * list.
 */
export function createBindingCapture(action: BindableAction, profile: ControlProfile): BindingCapture {
  let held: Set<string> | null = null;
  const { up, down, left, right } = profile.buttons;
  const directions = [up, down, left, right];
  return {
    action,
    profile,
    step(pads) {
      const now = new Set<string>();
      let cancel = false;
      let pressed: string | null = null;
      for (const { padIndex, pad } of pads) {
        const padProfile = profileFor(classifyPad(pad));
        if (padProfile === null || padProfile.id !== profile.id) continue;
        const isNew = (index: number): boolean => {
          if (pad.buttons[index]?.pressed !== true) return false;
          const key = `${padIndex}:${index}`;
          now.add(key);
          return held !== null && !held.has(key);
        };
        for (const index of directions) if (isNew(index)) cancel = true;
        for (const control of profile.bindable ?? []) {
          if (isNew(control.index) && pressed === null) pressed = control.id;
        }
      }
      const first = held === null;
      held = now;
      if (first) return { kind: 'waiting' };
      if (cancel) return { kind: 'cancel' };
      if (pressed !== null) return { kind: 'pressed', controlId: pressed };
      return { kind: 'waiting' };
    },
  };
}

/** The profile the pane configures: the first connected pad the game reads, or `null`. */
export function activeLayoutProfile(pads: readonly ConnectedPad[]): ControlProfile | null {
  for (const { pad } of pads) {
    const profile = profileFor(classifyPad(pad));
    if (profile !== null) return profile;
  }
  return null;
}

export const captureStatus = (action: BindableAction): string =>
  `Press the button for ${ACTION_NAMES[action]}. Press the D-pad, Escape or Cancel to stop.`;

export const cancelledStatus = (action: BindableAction): string => `${ACTION_NAMES[action]} was not changed.`;

/** What a finished capture says, read from the layout it produced. */
export function captureResultStatus(
  profile: ControlProfile,
  action: BindableAction,
  controlId: string,
  result: RebindResult,
): string {
  const name = controlName(profile.id, controlId);
  if (result.kind === 'refused') return `${name} can't be used for ${ACTION_NAMES[action]}.`;
  if (result.kind === 'unchanged') return `${ACTION_NAMES[action]} is already on ${name}.`;
  const moved = result.displaced;
  if (moved === null) return `${ACTION_NAMES[action]} is now ${name}.`;
  const buttons = resolveEffectiveProfile(profile, result.layout).profile.buttons;
  const movedTo = controlName(profile.id, controlIdAt(profile, buttons[moved]));
  return `${ACTION_NAMES[action]} is now ${name}. ${ACTION_NAMES[moved]} moved to ${movedTo}.`;
}

export const RESET_STATUS = 'Recommended layout restored.';

export const presetStatus = (preset: LayoutPreset): string => `Sticks: ${PRESET_NAMES[preset]}. ${PRESET_HINTS[preset]}`;

/** What the pane asks the page to do. The page decides; the pane only reports the press. */
export type LayoutRequest =
  | { readonly kind: 'preset'; readonly preset: LayoutPreset }
  | { readonly kind: 'capture'; readonly action: BindableAction }
  | { readonly kind: 'cancel' }
  | { readonly kind: 'reset' };

export interface ControllerLayoutView {
  update(model: ControllerLayoutModel): void;
  onRequest(cb: (request: LayoutRequest) => void): void;
  /** The last model drawn. */
  readonly model: ControllerLayoutModel;
  /** Remove every listener the body added. */
  dispose(): void;
}

const EMPTY_MODEL: ControllerLayoutModel = Object.freeze({
  profileName: null,
  preset: 'recommended',
  presets: [],
  rows: [],
  customised: false,
  capturing: null,
  status: '',
});

function button(className: string): HTMLButtonElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = `ui-btn ui-btn--sm ${className}`;
  return el;
}

export function renderControllerLayout(container: HTMLElement): ControllerLayoutView {
  const profileEl = document.createElement('p');
  profileEl.className = 'hud-layout-profile';
  const emptyEl = document.createElement('p');
  emptyEl.className = 'hud-layout-empty';
  emptyEl.textContent = NO_CONTROLLER_TEXT;

  const controls = document.createElement('div');
  controls.className = 'hud-layout-controls';
  const presetBtn = button('hud-layout-preset');
  const list = document.createElement('ul');
  list.className = 'hud-layout-bindings';
  const rowButtons = new Map<BindableAction, HTMLButtonElement>();
  for (const action of BINDABLE_ACTIONS) {
    const item = document.createElement('li');
    const rowBtn = button('hud-layout-bind');
    rowBtn.dataset.action = action;
    item.appendChild(rowBtn);
    list.appendChild(item);
    rowButtons.set(action, rowBtn);
  }
  const cancelBtn = button('hud-layout-cancel');
  cancelBtn.textContent = 'Cancel';
  const resetBtn = button('hud-layout-reset');
  resetBtn.textContent = 'Reset to Recommended';
  controls.append(presetBtn, list, cancelBtn, resetBtn);

  // A live region, because the result of a capture arrives from a controller press with focus
  // still on the row: without an announcement a screen-reader player hears nothing happen.
  const statusEl = document.createElement('p');
  statusEl.className = 'hud-layout-status';
  statusEl.setAttribute('role', 'status');
  statusEl.setAttribute('aria-live', 'polite');

  container.append(profileEl, emptyEl, controls, statusEl);

  const cbs: Array<(request: LayoutRequest) => void> = [];
  const request = (r: LayoutRequest): void => {
    for (const cb of cbs) cb(r);
  };
  let model = EMPTY_MODEL;

  const onPreset = (): void => {
    const { presets, preset } = model;
    if (presets.length < 2) return;
    request({ kind: 'preset', preset: presets[(presets.indexOf(preset) + 1) % presets.length] });
  };
  // Pressing the row that is waiting stops waiting; pressing another row moves the wait there.
  const onRow = (e: Event): void => {
    const action = (e.currentTarget as HTMLElement).dataset.action as BindableAction;
    request(model.capturing === action ? { kind: 'cancel' } : { kind: 'capture', action });
  };
  const onCancel = (): void => request({ kind: 'cancel' });
  const onReset = (): void => request({ kind: 'reset' });
  presetBtn.addEventListener('click', onPreset);
  for (const rowBtn of rowButtons.values()) rowBtn.addEventListener('click', onRow);
  cancelBtn.addEventListener('click', onCancel);
  resetBtn.addEventListener('click', onReset);

  const view: ControllerLayoutView = {
    update(next) {
      model = next;
      const present = next.profileName !== null;
      profileEl.hidden = !present;
      profileEl.textContent = next.profileName ?? '';
      emptyEl.hidden = present;
      controls.hidden = !present;

      presetBtn.hidden = next.presets.length < 2;
      presetBtn.textContent = `Sticks: ${PRESET_NAMES[next.preset]}`;
      presetBtn.title = PRESET_HINTS[next.preset];
      presetBtn.setAttribute('aria-label', `Sticks: ${PRESET_NAMES[next.preset]}. ${PRESET_HINTS[next.preset]}`);

      for (const row of next.rows) {
        const rowBtn = rowButtons.get(row.action);
        if (rowBtn === undefined) continue;
        const waiting = next.capturing === row.action;
        rowBtn.textContent = waiting ? `${row.actionName}: press a button…` : `${row.actionName}: ${row.controlName}`;
        rowBtn.setAttribute('aria-pressed', String(waiting));
      }
      cancelBtn.hidden = next.capturing === null;
      resetBtn.disabled = !next.customised;
      statusEl.textContent = next.status;
    },
    onRequest(cb) {
      cbs.push(cb);
    },
    get model() {
      return model;
    },
    dispose() {
      presetBtn.removeEventListener('click', onPreset);
      for (const rowBtn of rowButtons.values()) rowBtn.removeEventListener('click', onRow);
      cancelBtn.removeEventListener('click', onCancel);
      resetBtn.removeEventListener('click', onReset);
    },
  };
  view.update(EMPTY_MODEL);
  return view;
}
