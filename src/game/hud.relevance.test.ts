// @vitest-environment jsdom
//
// Per-device control visibility in the Settings pane (issue #227) -- the half
// `control-relevance.test.ts` does not cover: what the verdict does to the DOM, and what it
// must never do to a stored value. Each case names the production change it would catch.
import { describe, it, expect, afterEach } from 'vitest';
import { createHud, type Hud } from './hud';
import { settingRelevance, RUMBLE_UNAVAILABLE_REASON } from './control-relevance';
import { NO_CAPABILITIES, type PlatformCapabilities } from './capabilities';

let hud: Hud | null = null;
afterEach(() => {
  hud?.dispose();
  hud = null;
  document.body.innerHTML = '';
});

const caps = (over: Partial<PlatformCapabilities> = {}): PlatformCapabilities => ({
  ...NO_CAPABILITIES,
  ...over,
});

function mount(): { hud: Hud; root: HTMLElement } {
  const root = document.createElement('div');
  document.body.appendChild(root);
  hud = createHud(root);
  hud.setState('main-menu');
  return { hud, root };
}

const q = <T extends HTMLElement>(root: HTMLElement, sel: string): T =>
  root.querySelector<T>(sel) as T;
const shown = (el: HTMLElement): boolean => getComputedStyle(el).display !== 'none';
const controlsSection = (root: HTMLElement): HTMLElement =>
  q(root, '.hud-settings-section[data-section="controls"]');

const CONTROL_SELECTORS = {
  touchScheme: '.hud-scheme-toggle',
  fireMode: '.hud-firemode-toggle',
  deviceHaptics: '.hud-haptics-toggle',
  controllerRumble: '.hud-rumble-toggle',
} as const;

describe('setControlRelevance (issue #227)', () => {
  it('offers every control before the page has said anything, so a wiring omission fails OPEN', () => {
    // The direction matters. Failing CLOSED here would hide every control on a device that
    // supports them until a push arrived -- invisible in a test that always pushes, and a
    // blank Controls section for any consumer that forgets to.
    const { root } = mount();
    for (const sel of Object.values(CONTROL_SELECTORS)) expect(shown(q(root, sel)), sel).toBe(true);
  });

  it('omits the touch pair and the haptics toggle on a desktop, and collapses nothing else', () => {
    const { hud: h, root } = mount();
    h.setControlRelevance(settingRelevance(caps()));
    expect(shown(q(root, CONTROL_SELECTORS.touchScheme))).toBe(false);
    expect(shown(q(root, CONTROL_SELECTORS.fireMode))).toBe(false);
    expect(shown(q(root, CONTROL_SELECTORS.deviceHaptics))).toBe(false);
    // Still on screen, refused -- the whole point of the stable/transient split.
    expect(shown(q(root, CONTROL_SELECTORS.controllerRumble))).toBe(true);
    expect(shown(controlsSection(root)), 'Controllers and Rumble keep the section alive').toBe(
      true,
    );
  });

  it('RESTORES a control when the device gains the capability, not only hides it', () => {
    // A one-way apply is the classic shape of this bug: the record is applied on every push,
    // so a control hidden for one device must come back for the next. Nothing else here
    // would notice -- every other case pushes once.
    const { hud: h, root } = mount();
    h.setControlRelevance(settingRelevance(caps()));
    expect(shown(q(root, CONTROL_SELECTORS.deviceHaptics))).toBe(false);
    h.setControlRelevance(settingRelevance(caps({ touch: true, deviceVibration: true })));
    expect(shown(q(root, CONTROL_SELECTORS.deviceHaptics))).toBe(true);
    expect(shown(q(root, CONTROL_SELECTORS.touchScheme))).toBe(true);
  });

  it('collapses the whole Controls section when nothing in it is left visible', () => {
    // The rule the Settings markup already carried for the empty Accessibility section,
    // leaned on in the other direction. Reached by hiding the Controllers entry too, which
    // is the only member of that section this verdict does not own -- so this is the
    // section-collapse rule under test rather than the verdict.
    const { hud: h, root } = mount();
    h.setControlRelevance(settingRelevance(caps()));
    q(root, '.hud-settings-controllers').classList.add('hud-settings-controllers--test-hidden');
    const style = document.createElement('style');
    style.textContent = '.hud-settings-controllers--test-hidden{display:none}';
    document.head.appendChild(style);
    h.setControlRelevance(settingRelevance(caps()));
    expect(shown(controlsSection(root)), 'a heading over nothing').toBe(false);
    style.remove();
  });

  it('never collapses a section whose only survivor is a REFUSED control', () => {
    // A refused control carries the explanation. If `isOffered` counted it as gone, the
    // section would collapse and take the reason with it -- the player would lose both the
    // setting and the sentence telling them how to get it back.
    const { hud: h, root } = mount();
    h.setControlRelevance(settingRelevance(caps()));
    expect(q<HTMLButtonElement>(root, CONTROL_SELECTORS.controllerRumble).disabled).toBe(true);
    expect(shown(controlsSection(root))).toBe(true);
  });
});

describe('the refused rumble control (issue #227)', () => {
  it('is disabled, says why in view, and points its own aria-describedby at the reason', () => {
    // Both halves, because either alone is a half-measure: a visible sentence near a control
    // is not announced with it, and an `aria-describedby` with no visible text is a reason
    // only some players get.
    const { hud: h, root } = mount();
    h.setControlRelevance(settingRelevance(caps()));
    const btn = q<HTMLButtonElement>(root, CONTROL_SELECTORS.controllerRumble);
    const note = q(root, '.hud-rumble-note');
    expect(btn.disabled).toBe(true);
    expect(shown(note)).toBe(true);
    expect(note.textContent).toBe(RUMBLE_UNAVAILABLE_REASON);
    expect(btn.getAttribute('aria-describedby')).toBe(note.id);
    expect(note.id).not.toBe('');
  });

  it('clears the refusal and the note when a rumble pad arrives', () => {
    // The hotplug case stated at the HUD boundary. A note left standing would tell a player
    // with a working controller to connect one.
    const { hud: h, root } = mount();
    h.setControlRelevance(settingRelevance(caps()));
    h.setControlRelevance(settingRelevance(caps({ controllerRumble: true })));
    const btn = q<HTMLButtonElement>(root, CONTROL_SELECTORS.controllerRumble);
    expect(btn.disabled).toBe(false);
    expect(btn.getAttribute('aria-describedby')).toBe(null);
    expect(shown(q(root, '.hud-rumble-note'))).toBe(false);
    expect(q(root, '.hud-rumble-note').textContent).toBe('');
  });

  it('reads the STORED preference, so an unplugged pad never makes the label say Off', () => {
    // Availability is said by the refusal, not by the label. Painting this from the
    // effective value would show `Rumble: Off` over a preference that is still on, and a
    // player who then toggled it would be turning ON something already on.
    const { hud: h, root } = mount();
    h.setControllerRumble(true);
    h.setControlRelevance(settingRelevance(caps()));
    const btn = q<HTMLButtonElement>(root, CONTROL_SELECTORS.controllerRumble);
    expect(btn.textContent).toBe('Rumble: On');
    expect(btn.disabled, 'refused and still reading On').toBe(true);
  });

  it('announces its state and what a press would do, like its haptics sibling', () => {
    const { hud: h, root } = mount();
    h.setControllerRumble(false);
    const btn = q<HTMLButtonElement>(root, CONTROL_SELECTORS.controllerRumble);
    expect(btn.textContent).toBe('Rumble: Off');
    expect(btn.getAttribute('aria-label')).toMatch(/Controller rumble: Rumble: Off\./);
    expect(btn.getAttribute('aria-label')).toMatch(/switch to Rumble: On/);
  });

  it('reports the flipped value on click, and does not paint it itself', () => {
    // The store is the writer (route-ui.ts). A HUD that echoed the click would show a
    // preference the store may have refused -- the same rule the motion toggle states.
    const { hud: h, root } = mount();
    const seen: boolean[] = [];
    h.onControllerRumbleChange((on) => seen.push(on));
    h.setControllerRumble(true);
    q<HTMLButtonElement>(root, CONTROL_SELECTORS.controllerRumble).click();
    expect(seen).toEqual([false]);
    expect(q(root, CONTROL_SELECTORS.controllerRumble).textContent, 'unpainted until told').toBe(
      'Rumble: On',
    );
  });
});

describe('the Settings open/close chokepoint (issue #227)', () => {
  it('fires once per transition, through the Back button', () => {
    const { hud: h, root } = mount();
    const log: string[] = [];
    h.onSettingsOpen(() => log.push('open'));
    h.onSettingsClose(() => log.push('close'));
    q<HTMLButtonElement>(root, '.hud-settings-open').click();
    expect(log).toEqual(['open']);
    h.back();
    expect(log).toEqual(['open', 'close']);
    h.back();
    expect(log).toEqual(['open', 'close']);
  });

  it('closes on a surface change too, which never runs showSettings(false)', () => {
    // `setState` drops every layer outright rather than closing it, and that is the path a
    // match starting under an open Settings pane takes. Without the release there,
    // `route-ui.ts`'s hotplug listeners outlive the pane -- the pane-scoped-resource leak.
    const { hud: h, root } = mount();
    const log: string[] = [];
    h.onSettingsClose(() => log.push('close'));
    q<HTMLButtonElement>(root, '.hud-settings-open').click();
    h.setState('playing');
    expect(log).toEqual(['close']);
  });
});
