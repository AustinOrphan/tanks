import {
  formatPadReport,
  padLabel,
  type PadDiagnostic,
  type ReportContext,
} from '../input/gamepad-diagnostics';

/**
 * The Developer Tools controller self-test's VIEW (issue #599): a live readout of every
 * axis and every button of every browser-visible pad, plus the copyable report.
 *
 * Its own module rather than more of `hud.ts` for the reason `legal.ts` is: the pane is a
 * container the HUD owns and a body built from data the HUD does not model, and `hud.ts`
 * is already the largest file in `src/game/`.
 *
 * THE RENDER IS SPLIT IN TWO, and that is the whole design. `update` is called on every
 * frame while the pane is open -- sticks and triggers are analog and there is no event to
 * wait for -- so a render that rebuilt the list each time would replace every node sixty
 * times a second. `hud.navigation.test.ts` already records what that costs on the
 * assignment panel, where a hotplug repaints every row and the focused control goes with
 * it. So STRUCTURE is built only when the pad set itself changes (a different index, name,
 * mapping, axis count or button count), and a frame that finds the same set writes text
 * and widths into the nodes that are already there.
 *
 * NOT A LIVE REGION. The values move continuously; announcing them would be unusable, so
 * the list is ordinary content a screen reader reads on demand. The copyable report is the
 * accessible path to the same information, which is the one a compatibility report needs
 * anyway.
 *
 * READ-ONLY: nothing here writes a setting, a store or a controller assignment. Opening
 * the self-test cannot change what any slot is bound to.
 */

/** How a channel's value is drawn: a bar filled `0..1` of its width, plus the number. */
interface ChannelRow {
  readonly root: HTMLElement;
  readonly fill: HTMLElement;
  readonly value: HTMLElement;
}

interface PadRow {
  /** The structural identity this row was built for; a change rebuilds rather than rewrites. */
  readonly key: string;
  readonly root: HTMLElement;
  readonly axes: readonly ChannelRow[];
  readonly buttons: readonly ChannelRow[];
}

export interface ControllerSelfTestView {
  /** Write one frame of live pad state. Cheap when the pad set has not changed. */
  update(pads: readonly PadDiagnostic[]): void;
  /** The copyable compatibility report for the pads most recently passed to `update`. */
  report(): string;
}

/**
 * What the report says about the machine, read from the page itself.
 *
 * Injected with a default rather than read inline, so a test states the context instead of
 * asserting whatever jsdom happens to report -- and so the two globals are named in one
 * place. Both are guarded: this module is imported by `hud.ts`, which is constructed in
 * environments that have no `navigator`.
 */
export function defaultReportContext(): ReportContext {
  return {
    userAgent: typeof navigator === 'undefined' ? '(no navigator)' : navigator.userAgent,
    url: typeof location === 'undefined' ? '(no location)' : location.href,
  };
}

/**
 * Where the fill starts and how wide it is, as percentages of the bar.
 *
 * A BUTTON fills from the left: 0 is untouched and 1 is fully travelled, and an empty bar
 * means an untouched button.
 *
 * AN AXIS FILLS FROM THE CENTRE, because its rest position is the middle of its range and
 * not the bottom of it. Drawing it left-filled maps a CENTRED stick to a half-full bar --
 * measured in the first capture of this pane, where a resting Axis 2 drew a longer fill
 * than a trigger genuinely held at 0.35, and the same bar shape meant two different things
 * on adjacent rows. Centre-out makes a resting stick empty, a push right grow rightward and
 * a push left grow leftward, so the direction is visible as well as the magnitude.
 */
function barGeometry(value: number, signed: boolean): { left: number; width: number } {
  const v = Number.isFinite(value) ? value : 0;
  if (!signed) return { left: 0, width: Math.max(0, Math.min(1, v)) * 100 };
  const clamped = Math.max(-1, Math.min(1, v));
  const half = Math.abs(clamped) * 50;
  return { left: clamped < 0 ? 50 - half : 50, width: half };
}

/**
 * `axis` is carried on the ROW, not inferred at paint time, because the centre mark the
 * stylesheet draws belongs only to a channel that rests in the MIDDLE of its range. Painted
 * on a button row it is meaningless -- a button fills 0 to 1 from the left -- and worse, it
 * reads as a partial fill on an untouched button. Measured: the first build drew it on all
 * 17 button rows of a standard pad.
 */
function channelRow(label: string, axis: boolean): ChannelRow {
  const root = document.createElement('li');
  root.className = axis ? 'hud-selftest-channel hud-selftest-channel--axis' : 'hud-selftest-channel';
  const name = document.createElement('span');
  name.className = 'hud-selftest-channel-name';
  name.textContent = label;
  const bar = document.createElement('span');
  bar.className = 'hud-selftest-channel-bar';
  const fill = document.createElement('span');
  fill.className = 'hud-selftest-channel-fill';
  bar.appendChild(fill);
  const value = document.createElement('span');
  value.className = 'hud-selftest-channel-value';
  root.append(name, bar, value);
  return { root, fill, value };
}

function padKey(pad: PadDiagnostic): string {
  return [pad.padIndex, pad.id, pad.mapping, pad.axes.length, pad.buttons.length].join('|');
}

function buildPadRow(pad: PadDiagnostic): PadRow {
  const root = document.createElement('li');
  root.className = 'hud-selftest-pad';
  const name = document.createElement('h2');
  name.className = 'hud-selftest-pad-name';
  name.textContent = `Index ${pad.padIndex} — ${padLabel(pad)}`;
  const meta = document.createElement('p');
  meta.className = 'hud-selftest-pad-meta';
  // The three facts a compatibility report turns on, on the row itself and not only in the
  // copied text: whether the browser remapped the pad, and how many channels it has.
  meta.textContent = `mapping: ${pad.mapping === '' ? '(none reported)' : pad.mapping} · axes: ${pad.axes.length} · buttons: ${pad.buttons.length}`;
  const channels = document.createElement('ul');
  channels.className = 'hud-selftest-channels';
  const axes = pad.axes.map((_, i) => channelRow(`Axis ${i}`, true));
  const buttons = pad.buttons.map((_, i) => channelRow(`Button ${i}`, false));
  for (const row of [...axes, ...buttons]) channels.appendChild(row.root);
  root.append(name, meta, channels);
  return { key: padKey(pad), root, axes, buttons };
}

function writeChannel(row: ChannelRow, value: number, signed: boolean, down: boolean): void {
  const { left, width } = barGeometry(value, signed);
  row.fill.style.marginInlineStart = `${left.toFixed(1)}%`;
  row.fill.style.width = `${width.toFixed(1)}%`;
  row.value.textContent = Number.isFinite(value) ? value.toFixed(2) : '0.00';
  row.root.classList.toggle('hud-selftest-channel--down', down);
}

export function renderControllerSelfTest(
  container: HTMLElement,
  readContext: () => ReportContext = defaultReportContext,
): ControllerSelfTestView {
  const empty = document.createElement('p');
  empty.className = 'hud-selftest-empty';
  // A browser does not report a pad until it has been ACTUATED once, so "nothing here" is
  // the expected first state even with a controller plugged in. Saying so is the difference
  // between a working self-test and one a tester reports as broken.
  empty.textContent =
    'No controller is visible yet. A browser only reports a pad after it has been connected and then moved or pressed once — press a button on the controller.';
  const list = document.createElement('ul');
  list.className = 'hud-selftest-pads';
  container.append(empty, list);

  let rows: PadRow[] = [];
  let latest: readonly PadDiagnostic[] = [];

  return {
    update(pads) {
      latest = pads;
      empty.classList.toggle('hud-selftest-empty--hidden', pads.length > 0);
      const keys = pads.map(padKey).join('\n');
      if (keys !== rows.map((r) => r.key).join('\n')) {
        // The pad SET changed: a hotplug, a rename, or a pad whose channel count differs.
        // This is the only path that touches the DOM tree; every other frame writes values.
        rows = pads.map(buildPadRow);
        list.replaceChildren(...rows.map((r) => r.root));
      }
      for (let i = 0; i < rows.length; i++) {
        const pad = pads[i];
        const row = rows[i];
        for (let a = 0; a < row.axes.length; a++) {
          writeChannel(row.axes[a], pad.axes[a] ?? 0, true, false);
        }
        for (let b = 0; b < row.buttons.length; b++) {
          const button = pad.buttons[b];
          writeChannel(row.buttons[b], button?.value ?? 0, false, button?.pressed === true);
        }
      }
    },
    report() {
      return formatPadReport(latest, readContext());
    },
  };
}
