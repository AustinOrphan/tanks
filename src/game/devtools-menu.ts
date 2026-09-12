import { setSelected } from './ui';
import { isMultiset, multisetCounts, type DevMenuView, type MenuControl } from './dev-config-menu';
import type { DevConfigNote } from './dev-config';

/**
 * The Developer Tools configuration menu's DOM (issue #246).
 *
 * Its own module for the reason `legal.ts` and `controller-selftest.ts` are: the body is
 * built from data `hud.ts` does not model, and `hud.ts` is already the largest file in
 * `src/game/`. `hud.ts` owns the pane and the layer; this owns what is inside it.
 *
 * STRUCTURE IS BUILT ONCE. The control list is derived from `FLAG_REGISTRY`, which cannot
 * change while the page lives, so every row, option button and stepper exists from
 * construction and `update` only writes selection state, notes and the previewed URL into
 * them. A render that rebuilt would throw away the focused control on every keystroke --
 * the same failure the controller self-test's own doc comment records, and worse here
 * because every press changes the selection.
 *
 * THE BUTTON-ROW IDIOM, as the issue asks: one `.ui-selectable` button per value with a ring
 * on the current one, the same convention `.hud-versus-option-btn` and `.hud-level-btn`
 * already use. Every value is therefore one press away rather than up to sixteen presses of
 * a cycler -- which matters most for `blockedFire`, the widest row in the registry.
 *
 * UNSET IS A BUTTON, at the head of every row. Each of these flags defaults to absent, so a
 * row without it is a control that can be set and never cleared.
 */

export interface DevConfigMenuHandlers {
  /** A value button was pressed: set this field to this value, or clear it when `null`. */
  onSet(field: string, value: string | null): void;
  /** A toggle or the bundle was pressed. */
  onToggle(field: string): void;
  /** A stepper arrow was pressed, `+1` or `-1`. */
  onStep(field: string, step: number): void;
  /** One of a multiset's per-value arrows was pressed (issue #246's `sandboxTanks`). */
  onStepValue(field: string, value: string, step: number): void;
  onPreset(id: string): void;
  onApply(): void;
  onReset(): void;
  onCopy(): void;
}

export interface DevConfigMenuView {
  /** Write one selection's worth of state into the rows built at construction. */
  update(view: DevMenuView): void;
  /** The URL the menu is currently previewing -- what Apply navigates to and Copy copies. */
  search(): string;
}

/** Rows keyed by field, so `update` can find what to write without re-querying the DOM. */
interface ControlRow {
  readonly root: HTMLElement;
  readonly value: HTMLElement;
  readonly notes: HTMLElement;
  /** Value buttons by the value they set; `''` is the Unset button. */
  readonly options: Map<string, HTMLButtonElement>;
  readonly toggle: HTMLButtonElement | null;
  /** For a multiset, the per-value count readouts. */
  readonly counts: Map<string, HTMLElement>;
}

function hint(text: string, cls: string): HTMLElement {
  const p = document.createElement('p');
  p.className = `ui-hint ${cls}`;
  p.textContent = text;
  return p;
}

function button(label: string, cls: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `ui-btn ui-btn--sm ${cls}`;
  b.textContent = label;
  return b;
}

/** One line per note, in the model's own words -- `detail` is written for exactly this. */
function writeNotes(el: HTMLElement, notes: readonly DevConfigNote[]): void {
  el.replaceChildren();
  el.classList.toggle('hud-devcfg-notes--hidden', notes.length === 0);
  for (const n of notes) {
    const line = document.createElement('li');
    line.className = `hud-devcfg-note hud-devcfg-note--${n.reason}`;
    line.textContent = n.detail;
    el.appendChild(line);
  }
}

function buildControl(mc: MenuControl, handlers: DevConfigMenuHandlers): ControlRow {
  const c = mc.control;
  const root = document.createElement('li');
  root.className = 'hud-devcfg-control';
  root.dataset.field = c.field;

  const name = document.createElement('h3');
  name.className = 'hud-devcfg-name';
  name.textContent = c.param;
  const value = document.createElement('span');
  value.className = 'hud-devcfg-value';
  name.appendChild(value);
  root.append(name, hint(c.description, 'hud-devcfg-desc'));

  const options = new Map<string, HTMLButtonElement>();
  const counts = new Map<string, HTMLElement>();
  let toggle: HTMLButtonElement | null = null;
  const row = document.createElement('div');
  row.className = 'hud-devcfg-row';

  if (c.control === 'toggle') {
    // One button that flips, the shape the settings toggles already use. A two-button
    // on/off row would be two controls for one bit.
    toggle = button(c.isBundle ? 'Bundle' : 'Off', 'ui-selectable hud-devcfg-toggle');
    toggle.addEventListener('click', () => handlers.onToggle(c.field));
    row.appendChild(toggle);
  } else if (c.control === 'select') {
    const unset = button('Unset', 'ui-selectable hud-devcfg-option');
    unset.addEventListener('click', () => handlers.onSet(c.field, null));
    options.set('', unset);
    row.appendChild(unset);
    for (const v of c.values ?? []) {
      const b = button(v, 'ui-selectable hud-devcfg-option');
      b.addEventListener('click', () => handlers.onSet(c.field, v));
      options.set(v, b);
      row.appendChild(b);
    }
  } else if (isMultiset(c)) {
    // A COUNT PER VALUE. The numeric stepper below is meaningless here -- the value is a
    // comma-separated list with repeats kept, so `Number(...)` is NaN and the control was
    // inert until this existed. One row per kind, each with its own pair of arrows, which is
    // what a sandbox is actually chosen by.
    for (const v of c.values ?? []) {
      const cell = document.createElement('span');
      cell.className = 'hud-devcfg-count';
      const down = button('−', 'hud-devcfg-step');
      down.setAttribute('aria-label', `One fewer ${v}`);
      down.addEventListener('click', () => handlers.onStepValue(c.field, v, -1));
      const readout = document.createElement('span');
      readout.className = 'hud-devcfg-count-value';
      const up = button('+', 'hud-devcfg-step');
      up.setAttribute('aria-label', `One more ${v}`);
      up.addEventListener('click', () => handlers.onStepValue(c.field, v, 1));
      cell.append(down, readout, up);
      counts.set(v, readout);
      row.appendChild(cell);
    }
    const unset = button('Unset', 'ui-selectable hud-devcfg-option');
    unset.addEventListener('click', () => handlers.onSet(c.field, null));
    options.set('', unset);
    row.appendChild(unset);
  } else {
    // A stepper, never a text field: the issue rules out a general-purpose text-entry
    // primitive, and a menu that needs a keyboard is not operable by controller.
    const down = button('−', 'hud-devcfg-step');
    down.setAttribute('aria-label', `Decrease ${c.param}`);
    down.addEventListener('click', () => handlers.onStep(c.field, -1));
    const up = button('+', 'hud-devcfg-step');
    up.setAttribute('aria-label', `Increase ${c.param}`);
    up.addEventListener('click', () => handlers.onStep(c.field, 1));
    const unset = button('Unset', 'ui-selectable hud-devcfg-option');
    unset.addEventListener('click', () => handlers.onSet(c.field, null));
    options.set('', unset);
    row.append(down, up, unset);
    // The literals a parser takes beside a number -- `level=sandbox`, `walls=random:8` --
    // are their own buttons: `sandbox` is not a bigger level and `random:8` is not more
    // walls than 8, so a stepper must not walk through them.
    for (const literal of LITERALS[c.field] ?? []) {
      const b = button(literal, 'ui-selectable hud-devcfg-option');
      b.addEventListener('click', () => handlers.onSet(c.field, literal));
      options.set(literal, b);
      row.appendChild(b);
    }
  }
  root.appendChild(row);

  const notes = document.createElement('ul');
  notes.className = 'hud-devcfg-notes hud-devcfg-notes--hidden';
  root.appendChild(notes);
  return { root, value, notes, options, toggle, counts };
}

/**
 * The non-numeric values a valued flag also accepts, by field.
 *
 * Written here rather than derived because the registry states them only inside a prose
 * `type` string; the PARSER is still the authority on whether they are accepted, and
 * `dev-config-menu.test.ts` asserts each one survives a round trip, so a literal that stopped
 * being valid fails rather than sitting in the menu doing nothing.
 */
export const LITERALS: Record<string, readonly string[]> = {
  level: ['sandbox'],
  sandboxWalls: ['random:8'],
};

export function renderDevConfigMenu(
  container: HTMLElement,
  handlers: DevConfigMenuHandlers,
  view: DevMenuView,
): DevConfigMenuView {
  const rows = new Map<string, ControlRow>();

  const presets = document.createElement('div');
  presets.className = 'hud-devcfg-presets';
  for (const p of view.presets) {
    const b = button(p.label, 'hud-devcfg-preset');
    b.dataset.preset = p.id;
    b.title = p.description;
    b.setAttribute('aria-label', `${p.label}. ${p.description}`);
    b.addEventListener('click', () => handlers.onPreset(p.id));
    presets.appendChild(b);
  }

  const groups = document.createElement('div');
  groups.className = 'hud-devcfg-groups';
  for (const g of view.groups) {
    const section = document.createElement('section');
    section.className = 'hud-devcfg-group';
    section.dataset.group = g.group;
    const h = document.createElement('h2');
    h.textContent = g.group;
    const list = document.createElement('ul');
    list.className = 'hud-devcfg-controls';
    for (const mc of g.controls) {
      const row = buildControl(mc, handlers);
      rows.set(mc.control.field, row);
      list.appendChild(row.root);
    }
    section.append(h, list);
    groups.appendChild(section);
  }

  // The namespace, ABOVE the actions rather than below them: it is the one consequence that
  // outlives the reload, and it is invisible in the flags themselves.
  const namespace = hint('', 'hud-devcfg-namespace');
  const unknown = hint('', 'hud-devcfg-unknown hud-devcfg-unknown--hidden');
  const url = document.createElement('p');
  url.className = 'hud-devcfg-url';

  const actions = document.createElement('div');
  actions.className = 'hud-devcfg-actions';
  const apply = button('Apply and Reload', 'hud-devcfg-apply');
  apply.addEventListener('click', () => handlers.onApply());
  const reset = button('Reset Options', 'hud-devcfg-reset');
  reset.addEventListener('click', () => handlers.onReset());
  const copy = button('Copy Link', 'hud-devcfg-copy');
  copy.addEventListener('click', () => handlers.onCopy());
  actions.append(apply, reset, copy);

  container.append(presets, groups, namespace, unknown, url, actions);

  let current = view;
  function update(next: DevMenuView): void {
    current = next;
    for (const g of next.groups) {
      for (const mc of g.controls) {
        const row = rows.get(mc.control.field);
        if (!row) continue;
        const value = mc.value === null ? '' : String(mc.value);
        // A TOGGLE says its state on its own button, so repeating it beside the name would
        // print "invincible — unset" over a button reading "Off" -- two words for one bit,
        // and "unset" is the wrong one of them.
        row.value.textContent = row.toggle ? '' : value === '' ? ' — unset' : ` — ${value}`;
        if (row.toggle) {
          const on = mc.value === true;
          setSelected(row.toggle, on);
          row.toggle.textContent = on ? 'On' : 'Off';
        }
        for (const [v, b] of row.options) setSelected(b, v === value);
        if (row.counts.size > 0) {
          const counted = multisetCounts({ [mc.control.field]: mc.value } as never, mc.control);
          for (const [v, el] of row.counts) el.textContent = `${v} ×${counted.get(v) ?? 0}`;
        }
        writeNotes(row.notes, mc.notes);
      }
    }
    namespace.textContent =
      `Saved data namespace after reload: ${next.namespace}. ` +
      'A developer page keeps its own saves and cannot see a production one.';
    const unknowns = next.state.unknownParams;
    unknown.classList.toggle('hud-devcfg-unknown--hidden', unknowns.length === 0);
    unknown.textContent =
      unknowns.length === 0
        ? ''
        : `Not a developer parameter, and carried through untouched: ${unknowns.join(', ')}`;
    url.textContent = next.search;
  }

  update(view);
  return { update, search: () => current.search };
}
