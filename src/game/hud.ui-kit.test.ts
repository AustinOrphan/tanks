// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createHud, type Hud } from './hud';
import { devControls } from './dev-config';
import { LITERALS } from './devtools-menu';
import { installComputedStyleCache } from './computed-style-cache';

/**
 * The UI kit's contracts, swept across every control that uses them (issue #321).
 * Split from `hud.navigation.test.ts` (issue #1093), whose header says why.
 */

// Keeps `display` across focus moves, which jsdom 30.1.2 recomputes (issue #1093).
installComputedStyleCache();

let hud: Hud | null = null;

afterEach(() => {
  hud?.dispose();
  hud = null;
  document.body.innerHTML = '';
});

/**
 * The configuration menu's SELECTABLE buttons (issue #246): every value button and every
 * toggle. Derived from the registry rather than pinned, so a developer flag added tomorrow
 * does not break a UI-kit sweep that has nothing to do with it. The stepper arrows are not
 * choices and are deliberately outside this.
 */
function devMenuSelectables(): number {
  let n = 0;
  for (const c of devControls()) {
    if (c.control === 'toggle') n += 1;
    else if (c.control === 'select') n += 1 + (c.values?.length ?? 0);
    else n += 1 + (LITERALS[c.field]?.length ?? 0);
  }
  return n;
}

describe('the UI kit contracts, swept across every control that uses them (issue #321)', () => {
  async function mountEveryChoice(): Promise<{ hud: Hud; root: HTMLElement }> {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const h = createHud(root);
    // Handed to the file's `afterEach`, which this fixture skipped before issue #1015, so its
    // key listeners outlived the case. That was harmless while the HUD never left its first
    // surface; after the open and Back below, seven #919 cases later in the same file (now
    // hud.arrival.test.ts) had their key presses cancelled while the leaked HUDs lived
    // (observed), as an arrival-guarded HUD would.
    hud = h;
    // The Configuration menu's body is loaded when its pane first opens (issue #1015): opened
    // once through the real UI, the build awaited, and the HUD walked back to the surface it
    // was built on, so the menu's choices are inside the sweep rather than silently outside it.
    (root.querySelector('.hud-devtools-open') as HTMLButtonElement).click();
    (root.querySelector('.hud-devcfg-open') as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(root.querySelector('.hud-devcfg-presets'), 'the Configuration body was never built')
        .not.toBeNull();
    }, { timeout: 5000 });
    h.back();
    await vi.waitFor(() => {
      expect(root.querySelector('.ui-surface--leaving, .ui-surface--entering'), 'a crossfade never settled')
        .toBeNull();
    });
    h.setLevelSelect(2, 4);
    h.setBotAssignmentAllowed(true);
    h.setDetectedPads([{ padIndex: 1, id: 'Test Pad' }]);
    h.setControllers([{ kind: 'keyboard' }, { kind: 'gamepad', padIndex: 1 }]);
    // The paint shop's three rows render their selection when the game TELLS the HUD
    // what is stored -- `setHullColor`/`setSkin`/`setAccentColor`, the same calls
    // `loop.ts` makes at boot -- not at construction. A freshly built HUD shows no ring
    // on them and, equally, announces no pressed state; that symmetry is the point, and
    // driving the setters here is what puts those 18 controls inside the sweep at all
    // rather than leaving them permanently unselected and permanently unannounced.
    h.setHullColor((root.querySelector('.hud-swatch[data-hull]') as HTMLElement).dataset.hull as never);
    h.setSkin((root.querySelector('.hud-skin') as HTMLElement).dataset.skin as never);
    h.setAccentColor((root.querySelector('.hud-swatch[data-accent]') as HTMLElement).dataset.accent as never);
    return { hud: h, root };
  }

  const selectables = (root: HTMLElement): HTMLButtonElement[] =>
    Array.from(root.querySelectorAll('button.ui-selectable'));

  it('announces the current choice on EVERY choice control, not only draws it', async () => {
    // Before `setSelected`, the hull swatches, accent swatches, skins, controller
    // sources and versus options each toggled a class of their own and told assistive
    // technology nothing: the current choice was a white border and nothing else.
    const { root } = await mountEveryChoice();
    const btns = selectables(root);
    // Exactly, not a lower bound -- this is the sweep's denominator, and it is measured
    // against THIS fixture rather than derived: 11 swatches in the paint shop (PALETTE 6
    // + ACCENTS 5, which share `.hud-swatch`) + 7 skins (SKINS) + 8 in the Controllers
    // panel (2 slots x [Keyboard/Bot/None + 1 detected pad]) + 23 in the versus pane
    // (17 option buttons -- Mode 2, Players 3, Map 7, Stock 5 -- plus its who's-playing
    // ROLE buttons, 2 slots x [Human/Bot/Off] = 6). Map went 6 -> 7 with issue #271's
    // vs-duel-01, offered at the N=2 this fixture defaults to.
    //
    // 23 and not 25 since issue #260: the who's-playing block used to contribute 8
    // (2 slots x [Keyboard/Bot/None + 1 pad]) as a DEVICE preview reusing the
    // Controllers panel's own candidate rows. It renders per-slot ROLES now, and three
    // roles per slot is 6. A different slot, pad or player count pins a different
    // number; the number moving is the prompt to check the new row is inside the sweep
    // rather than beside it.
    //
    // 26 and not 23 since issue #267: a BOT slot also offers Easy/Normal/Hard.
    // `defaultSlots(2)` is `[human, bot]`, so exactly one slot carries them at this
    // fixture's player count -- 3 buttons, not 6. Re-derived, not incremented: the count
    // depends on how many slots are bots, so a fixture that defaulted both slots to Bot
    // would pin 29 here.
    //
    // +4 since issue #226: the Records tab pair, which appears in BOTH the Stats and the
    // Achievements pane so that each reads as one destination with two views. Their
    // selected state is STATIC -- a pane's own tab is always the current one -- so they
    // are the sweep's only members that never move, which is exactly why they have to be
    // in it: a static `aria-pressed` that disagreed with its static class would be
    // invisible to any test that only watched controls change.
    // Issue #246 adds the configuration menu's value buttons and toggles. DERIVED from the
    // registry rather than added as a literal: the menu renders one row per registered flag,
    // so a literal would make every future developer flag break this sweep. What the sweep is
    // ABOUT is unchanged -- every one of them must still announce its choice, asserted below
    // over the whole population.
    //
    // 28 and not 26 in the versus pane since issue #1035: Map goes 7 -> 9 at this fixture's
    // two players, with vs-tri-01 and vs-quad-01 offered at the lower counts they measure
    // suitable at.
    expect(btns.length).toBe(11 + 7 + 8 + 28 + 4 + devMenuSelectables());
    const missing = btns
      .filter((b) => !b.hasAttribute('aria-pressed'))
      .map((b) => Array.from(b.classList).join('.'));
    expect(missing, 'choice controls with no announced state').toEqual([]);
    // ...and the two channels agree, control for control. A helper that wrote the
    // attribute once at build time and then only moved the class would pass the sweep
    // above and fail here.
    const disagree = btns
      .filter((b) => (b.getAttribute('aria-pressed') === 'true')
        !== b.classList.contains('ui-selectable--on'))
      .map((b) => Array.from(b.classList).join('.'));
    expect(disagree, 'the ring and the announced state disagree').toEqual([]);
    // Not vacuous: something IS selected in this fixture, so the agreement above is not
    // "every control is false" agreeing with "no control has the class".
    expect(btns.filter((b) => b.getAttribute('aria-pressed') === 'true').length)
      .toBeGreaterThan(0);
  });

  it('moves the announced state with the choice, not only on the first render', async () => {
    const { hud: h, root } = await mountEveryChoice();
    const skins = () => Array.from(root.querySelectorAll('.hud-skin')) as HTMLButtonElement[];
    const pressed = () => skins().map((b) => b.getAttribute('aria-pressed'));
    const before = pressed();
    const other = skins().find((b) => b.getAttribute('aria-pressed') !== 'true')!;
    h.setSkin(other.dataset.skin as never);
    expect(pressed()).not.toEqual(before);
    expect(other.getAttribute('aria-pressed')).toBe('true');
    expect(pressed().filter((v) => v === 'true')).toHaveLength(1);
  });

  it('leaves the level grid with nothing to describe, because nothing in it is refused', async () => {
    // SUPERSEDES 'associates a locked level with the line that says why it is locked'.
    // That contract was real and this sweep still enforces it everywhere it applies --
    // the versus Start and the Controllers rows below. It stopped applying to the level
    // grid at issue #555, which removed the refused control rather than re-describing it:
    // the strongest form of "say why this is refused" is to not offer it.
    //
    // Kept as an assertion rather than deleted with the branch, because the failure this
    // guards is a re-added locked button that points at an element whose id went with it.
    const { hud: h, root } = await mountEveryChoice();
    expect(root.querySelector('#hud-levels-note'), 'the reason line outlived its reason').toBeNull();

    const btns = Array.from(root.querySelectorAll('.hud-level-btn')) as HTMLButtonElement[];
    // mountEveryChoice's setLevelSelect(2, 4): 2 unlocked, so 2 buttons and no more.
    expect(btns).toHaveLength(2);
    expect(btns.map((b) => b.disabled)).toEqual([false, false]);
    expect(btns.map((b) => b.getAttribute('aria-describedby'))).toEqual([null, null]);

    // The negative control: fully unlocked draws MORE buttons, still with nothing refused
    // and still with nothing described. Without it a grid that rendered no levels at all
    // would satisfy every assertion above.
    h.setLevelSelect(4, 4);
    const after = Array.from(root.querySelectorAll('.hud-level-btn')) as HTMLButtonElement[];
    expect(after).toHaveLength(4);
    expect(after.map((b) => b.disabled)).toEqual([false, false, false, false]);
    expect(after.map((b) => b.getAttribute('aria-describedby'))).toEqual([null, null, null, null]);
  });

  it("associates a refused Start with the reason, and describes the Controllers panel's real rows with nothing", async () => {
    // SUPERSEDES the versus half of this test. It used to assert that the pane's
    // who's-playing PREVIEW buttons pointed at #hud-versus-assignment-note while
    // disabled -- those buttons are gone (issue #260), and the pane's disabled control
    // is now Start itself, whose reason moves with the problem.
    const { root } = await mountEveryChoice();
    const described = (sel: string): (string | null)[] =>
      Array.from(root.querySelectorAll(`${sel} .hud-controller-source-btn`))
        .map((b) => b.getAttribute('aria-describedby'));
    // The standalone Controllers panel reassigns for real: its buttons need no excuse.
    expect(new Set(described('.hud-controllers'))).toEqual(new Set([null]));
    expect(described('.hud-controllers').length).toBeGreaterThan(0);
    // ...and the versus pane no longer renders any of those buttons at all.
    expect(described('.hud-versus-setup'), 'the device preview should be gone').toEqual([]);

    const start = root.querySelector('.hud-versus-start') as HTMLButtonElement;
    expect(start.disabled, 'the fixture default is startable').toBe(false);
    expect(start.getAttribute('aria-describedby'), 'an allowed Start needs no excuse').toBeNull();

    // Refuse it, and the association appears with the reason -- not merely near it.
    (root.querySelector('.hud-versus-slot-row[data-slot="0"] .hud-versus-role-btn[data-role="none"]') as HTMLButtonElement)
      .click();
    expect(start.disabled).toBe(true);
    const id = start.getAttribute('aria-describedby');
    expect(id).toBe('hud-versus-slot-reason-0');
    const reason = root.querySelector(`#${id}`) as HTMLElement;
    expect(reason, 'aria-describedby points at no element').not.toBeNull();
    expect(reason.textContent, 'the referenced element is empty, so the excuse says nothing')
      .not.toBe('');
  });
});
