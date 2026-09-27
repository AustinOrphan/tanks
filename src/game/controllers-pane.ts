import { blurIfPointer, describeDisabledReason, setSelected } from './ui';
import { captureFocus } from './focusable';
import { NOT_SUPPORTED, candidateLabel, slotSourceLabel, unsupportedPad, unsupportedSentence } from './controller-labels';
import { sameSlotSource, type Assignment, type SlotSource } from '../input/assignment';
import type { DetectedPad } from '../input/gamepad';
import type { PaneHost, Surface } from './pane-host';

/**
 * The Controllers pane (issue #556): who is driving each player slot, and what else they could
 * drive instead. Extracted against the seam in
 * `docs/superpowers/specs/2026-09-16-hud-pane-host-design.md`.
 *
 * WHAT IT OWNS. The pane's markup inside its container, the slot rows it rebuilds on every
 * change, the unsupported-pad line those rows point at, the assignment and bot-allowed flag it
 * renders from, its open and close chokepoint and the subscribers it fires, and its Back and
 * opener listeners.
 *
 * WHAT `hud.ts` KEEPS, and why. The container `<div>` stays in the one template with its role,
 * label and hidden class, because where the pane sits in the document is the host's decision and
 * so is its place in `PANEL_FAMILY`'s paint order. The host also keeps the `LAYERS` row, the
 * pane's slot in `setState`'s ordered close, the opener's visibility toggle (Main Menu markup),
 * and the `Hud` members, each delegating here.
 *
 * THE DETECTED PADS ARE THE HOST'S, deliberately. Versus Setup renders a device column derived
 * from the same list, and a `Hud` member writes it, so it stays one binding in `hud.ts` and this
 * pane reads it through `detectedPads()`. That is the ruling in the spec's rule 4, and the
 * rejected alternative -- this pane owning the list and Versus Setup subscribing -- is what
 * would make one pane depend on another.
 *
 * THE HEADING TEXT IS PASSED IN, not derived here. It is the pane's one route-dependent value:
 * "Controllers" when the game is paused, "Choose who's playing" otherwise. Handing the pane a
 * way to ask about route state would buy one string branch at the cost of a member on the host
 * interface that nothing else needs, so the host supplies the words instead -- the same reading
 * of copy that took the controller labels out of the closure in issue #901.
 *
 * THE MARKUP IS INTERPOLATED, NOT WRITTEN. `hud.ts` places `CONTROLLERS_BODY` where these lines
 * used to be, so the string it assigns to `innerHTML` is unchanged character for character.
 */
export const CONTROLLERS_BODY = `
      <h1 class="hud-controllers-title" id="hud-controllers-title"></h1>
      <!-- REPLACE, never append -- rebuilt on open and on every detection refresh, same
           convention setLevelSelect already uses for .hud-levels. -->
      <div class="hud-controller-rows"></div>
      <!-- Issue #597. The help line is constant: it describes the list (only pads the
           browser reports can appear), so it is not a warning a keyboard or touch player
           has to dismiss. The unsupported line shows only while a listed pad cannot be
           read, and is the reason its disabled candidates point at. -->
      <p class="ui-hint hud-controllers-help">Only controllers your browser reports appear here. Not listed? Press a button on it, or reconnect it.</p>
      <p class="ui-hint hud-controllers-unsupported hud-controllers-unsupported--hidden" id="hud-controllers-unsupported" role="status"></p>
      <button class="ui-btn ui-btn--slab hud-controllers-back" type="button">Back</button>
    `;

/** The host members this pane calls: its shared-state cost. Pinned by `pane-host.test.ts`. */
export type ControllersHost = Pick<PaneHost, 'enterSurface' | 'closeSurface' | 'isSurfaceOpen' | 'open' | 'back'>;

/** What the pane reads that the host owns, and the one string it cannot derive. */
export interface ControllersDeps {
  /** The live pad list, owned by `hud.ts` because Versus Setup renders from it too. */
  detectedPads(): readonly DetectedPad[];
  /** "Controllers" from the pause route, "Choose who's playing" from the Main Menu. */
  headingText(): string;
}

export interface ControllersPane {
  /** A candidate button was pressed: the slot, and what it should be driven by. */
  onReassignSlot(cb: (slot: number, source: SlotSource) => void): void;
  /**
   * The assignment to render. Unconditional, like `setLevelSelect` and unlike
   * `setAchievements`: "REPLACE, never append" means the rows stay current whether or not the
   * pane is open, so a boot-time push and a mid-session hotplug both land correctly whenever the
   * pane is next shown, with no separate refresh-on-open path to keep in sync.
   */
  setControllers(assignment: Assignment): void;
  /** Whether a bot may drive a player slot in the RUNNING session; the campaign refuses it. */
  setBotAssignmentAllowed(allowed: boolean): void;
  /** Repaint from the host's current pad list. `hud.ts` calls this when that list changes. */
  refresh(): void;
  /** The pane just became visible. Fired only on an actual transition. */
  onControllersOpen(cb: () => void): void;
  /** The pane just closed, by any path. Fired only on an actual transition. */
  onControllersClose(cb: () => void): void;
  /**
   * The single open/close chokepoint: the Back button, `back()`, and `setState`'s unconditional
   * close all come through here, so a subscriber that starts polling gamepads on open cannot
   * leak a poller down another path.
   */
  show(open: boolean, instant?: boolean): void;
  /**
   * A sibling pane is replacing this one (issue #558). The incoming pane fades this surface
   * out, so only the subscribers are released, and only if the pane was on screen.
   */
  release(): void;
  /** Remove the opener and Back listeners this pane added. */
  dispose(): void;
}

export function createControllersPane(
  host: ControllersHost,
  surface: Surface,
  opener: HTMLButtonElement,
  deps: ControllersDeps,
): ControllersPane {
  const root = surface.el;
  const titleEl = root.querySelector('.hud-controllers-title') as HTMLElement;
  const rowsEl = root.querySelector('.hud-controller-rows') as HTMLElement;
  const controllersUnsupportedEl = root.querySelector('.hud-controllers-unsupported') as HTMLElement;
  const backBtn = root.querySelector('.hud-controllers-back') as HTMLButtonElement;
  const reassignSlotCbs: Array<(slot: number, source: SlotSource) => void> = [];
  const openCbs: Array<() => void> = [];
  const closeCbs: Array<() => void> = [];
  let currentAssignment: Assignment = [];
  let botAllowed = false;

  /**
   * One row per slot, one button per candidate source, replacing whatever was there.
   *
   * Parameterized over the TARGET CONTAINER and the ASSIGNMENT for the second caller it was
   * extracted for: the versus pane's who's-playing preview, which rendered these same rows
   * disabled through an `interactive` flag and pointed them at an explanatory note. That caller
   * is gone as of issue #260 -- the versus pane renders retained ROLES now, not a device
   * assignment (`renderVersusSlotRows`, hud.ts) -- so the flag was dropped as dead code, and the
   * manifest entry that pinned it (`ui-versus-preview-reason-left-on-the-real-rows`) was retired
   * with it. `renderRows` is now the only caller.
   */
  function renderRowsInto(container: HTMLElement, assignment: Assignment): void {
    const pads = deps.detectedPads();
    const restoreFocus = captureFocus(container);
    container.replaceChildren();
    for (let slot = 0; slot < assignment.length; slot++) {
      const source = assignment[slot];
      const row = document.createElement('div');
      row.className = 'hud-controller-row';
      row.dataset.slot = String(slot);

      const label = document.createElement('span');
      label.className = 'hud-controller-row-label';
      label.textContent = `Player ${slot + 1}`;

      const current = document.createElement('span');
      current.className = 'hud-controller-row-current';
      current.textContent = slotSourceLabel(source, pads);
      const disconnected =
        source.kind === 'gamepad' && !pads.some((p) => p.padIndex === source.padIndex);
      current.classList.toggle('hud-controller-row-current--disconnected', disconnected);
      if (disconnected) current.textContent += ' — disconnected';
      // An assigned pad Tanks cannot read (issue #597) is present, so it is not
      // "disconnected", and without this it reads exactly like a pad that works.
      if (source.kind === 'gamepad' && unsupportedPad(source.padIndex, pads)) {
        current.textContent += NOT_SUPPORTED;
      }

      row.append(label, current);

      // `'bot'` is offered only where a bot may legitimately drive a player tank -- see
      // `botAssignmentAllowed`. Omitted from the list rather than rendered disabled: a
      // greyed-out control in the campaign advertises a capability the campaign does not
      // have, and `loop.ts` refuses the reassignment independently anyway.
      const candidates: SlotSource[] = [
        { kind: 'keyboard' },
        ...(botAllowed ? [{ kind: 'bot' } as SlotSource] : []),
        { kind: 'none' },
        ...pads.map((p): SlotSource => ({ kind: 'gamepad', padIndex: p.padIndex })),
      ];
      for (const candidate of candidates) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ui-btn ui-selectable hud-controller-source-btn';
        btn.textContent = candidateLabel(candidate, pads);
        btn.dataset.candidate = candidate.kind === 'gamepad' ? `gamepad-${candidate.padIndex}` : candidate.kind;
        setSelected(btn, sameSlotSource(candidate, source));
        // A pad Tanks cannot read is SHOWN, refused, and pointed at its reason (issue #597):
        // listing it is what separates "your browser reports it but the game cannot use it"
        // from "nothing was detected". It gets no reassign listener, so a synthetic click
        // cannot assign a pad the reader would sample as neutral every tick.
        if (candidate.kind === 'gamepad' && unsupportedPad(candidate.padIndex, pads)) {
          btn.textContent += NOT_SUPPORTED;
          btn.disabled = true;
          describeDisabledReason(btn, controllersUnsupportedEl.id);
          row.appendChild(btn);
          continue;
        }
        const forSlot = slot; // captured per-iteration, not the loop's shared binding
        btn.addEventListener('click', () => {
          for (const cb of reassignSlotCbs) cb(forSlot, candidate);
        });
        row.appendChild(btn);
      }
      container.appendChild(row);
    }
    const unreadable = pads.filter((p) => p.unsupported !== undefined);
    // NOT point-free. `unsupportedSentence` takes the live pad list as its second
    // argument since #556 moved it out of this closure, and `Array.map` passes the INDEX
    // there -- which typechecks only because the compiler refused it here. A signature
    // whose second parameter happened to be optional would have compiled and silently
    // named every pad from an index-shaped list.
    controllersUnsupportedEl.textContent = unreadable
      .map((pad) => unsupportedSentence(pad, pads))
      .join(' ');
    controllersUnsupportedEl.classList.toggle('hud-controllers-unsupported--hidden', unreadable.length === 0);
    restoreFocus();
  }

  function renderRows(): void {
    renderRowsInto(rowsEl, currentAssignment);
  }

  // Guarded on the ACTUAL transition, same as Customize's `show`, so route-ui.ts's window
  // listener add/remove never sees a redundant open or close.
  function show(open: boolean, instant = false): void {
    // Read before the transition begins -- same reason as Customize's `show`.
    const wasOpen = host.isSurfaceOpen(surface);
    if (open) {
      host.enterSurface(surface, () => {
        // The only copy that differs between the two entry points -- see this panel's own
        // markup comment. Supplied by the host, which is the half that knows the route.
        titleEl.textContent = deps.headingText();
        renderRows();
        root.focus();
        if (!wasOpen) for (const cb of openCbs) cb();
      });
    } else {
      host.closeSurface(
        surface,
        () => {
          if (wasOpen) for (const cb of closeCbs) cb();
        },
        instant,
      );
    }
  }

  const handleOpen = (): void => {
    host.open(opener);
  };
  // Reachable from 'paused' as well as the Main Menu (owner ruling: "in case controllers
  // disconnect"), which is why this panel's Back was the one that could never hard-code its
  // destination. The layer records the surface it was opened over, so Back from a paused round
  // returns to the paused round -- the same rule every other pane follows rather than a special
  // case for this one.
  const handleBack = (): void => {
    host.back();
  };
  opener.addEventListener('click', handleOpen);
  opener.addEventListener('click', blurIfPointer);
  backBtn.addEventListener('click', handleBack);
  backBtn.addEventListener('click', blurIfPointer);

  return {
    onReassignSlot(cb) {
      reassignSlotCbs.push(cb);
    },
    setControllers(assignment) {
      currentAssignment = assignment;
      renderRows();
    },
    setBotAssignmentAllowed(allowed) {
      botAllowed = allowed;
      renderRows();
    },
    refresh: renderRows,
    onControllersOpen(cb) {
      openCbs.push(cb);
    },
    onControllersClose(cb) {
      closeCbs.push(cb);
    },
    show,
    release() {
      // Guarded on the surface being open for the same reason `show` guards on `wasOpen`: a
      // release fired for a pane that was never on screen would stop a poller nobody started.
      if (host.isSurfaceOpen(surface)) for (const cb of closeCbs) cb();
    },
    dispose() {
      opener.removeEventListener('click', handleOpen);
      opener.removeEventListener('click', blurIfPointer);
      backBtn.removeEventListener('click', handleBack);
      backBtn.removeEventListener('click', blurIfPointer);
    },
  };
}
