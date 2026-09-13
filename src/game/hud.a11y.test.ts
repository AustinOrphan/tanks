// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { createHud, type Hud } from './hud';
import { ACHIEVEMENTS } from './achievements';
import { ZERO_STATS } from './stats';
import type { TypedOutcome } from './app-state';

// ---------------------------------------------------------------------------
// Issue #629: landmarks, pane roles, and named controls.
//
// The survey behind this file (issue #327's comment) found ~50 gaps across six criteria;
// what lands here is criterion 1. Nothing in the suite asserted ANY of it before -- not
// the live region, not heading structure outside Customize, not whether a control has an
// accessible name at all -- so these are new contracts rather than tightened ones.
// ---------------------------------------------------------------------------

let hud: Hud | null = null;
function mount(): { hud: Hud; root: HTMLElement } {
  const root = document.createElement('div');
  document.body.appendChild(root);
  hud = createHud(root);
  return { hud, root };
}
afterEach(() => {
  hud?.dispose();
  hud = null;
  document.body.innerHTML = '';
});

/**
 * An APPROXIMATION of the accessible name, and deliberately a narrow one: `aria-label`,
 * then `aria-labelledby`, then text content. The real algorithm is far larger (it walks
 * `title`, `alt`, embedded control values, CSS generated content and more), and a full
 * implementation here would be a second thing to get wrong.
 *
 * It is adequate because the SHORTFALL is in the safe direction for every assertion
 * below. `title` is the one fallback the real algorithm has that this does not, and
 * leaning on `title` for a name is exactly the defect issue #629 records against the
 * colour swatches -- so a control this helper reports as unnamed is either genuinely
 * unnamed or named only by a tooltip, and both fail the same way for the same reason.
 */
function accessibleName(el: Element): string {
  const label = el.getAttribute('aria-label');
  if (label !== null && label.trim() !== '') return label.trim();
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy !== null) {
    const named = labelledBy
      .split(/\s+/)
      .map((id) => el.ownerDocument.getElementById(id)?.textContent?.trim() ?? '')
      .filter((t) => t !== '')
      .join(' ');
    if (named !== '') return named;
  }
  return (el.textContent ?? '').trim();
}

describe('HUD landmarks (issue #629)', () => {
  it('makes every focus-target pane a NAMED region', () => {
    // A region with no accessible name is not a landmark -- it is an extra level of
    // nesting. So the two halves are asserted together: the role is worthless without
    // the name, and the name was already there without the role.
    const { hud: h, root } = mount();
    // The match-failure alert is named from the failure it was given, so its `<h1>` is
    // empty until one arrives (issue #325) -- the same shape as `.hud-action` in the
    // control sweep below. Driven rather than excluded, on the same precedent: the state
    // worth asserting is the one the player actually meets, and a filter that skipped
    // unnamed panes would skip exactly the pane most likely to be wrong.
    h.showMatchFailure({ title: 'That match could not start.', detail: 'Something went wrong.', action: 'Back to menu' });
    const panes = Array.from(root.querySelectorAll('[tabindex="-1"][aria-labelledby]'));
    expect(panes.length, 'the pane population this sweeps').toBeGreaterThan(5);
    for (const pane of panes) {
      const role = pane.getAttribute('role');
      // `dialog`/`alertdialog` are STRONGER roles and keep them: .hud-splash and
      // .hud-confirm declare their own, and .hud-confirm backs its `aria-modal` with real
      // `inert` isolation (#628). Overwriting either with `region` would be a downgrade.
      expect(
        role === 'region' || role === 'dialog' || role === 'alertdialog',
        `${pane.className} has role '${role}'`,
      ).toBe(true);
      expect(accessibleName(pane), `${pane.className} is a landmark with no name`).not.toBe('');
    }
  });

  it('keeps the two dialogs OUT of the region pattern', () => {
    // The negative control for the sweep above, which passes on a tree where every pane
    // including both dialogs was flattened to `region`.
    const { root } = mount();
    expect(root.querySelector('.hud-splash')?.getAttribute('role')).toBe('dialog');
    expect(root.querySelector('.hud-confirm')?.getAttribute('role')).toBe('alertdialog');
  });

  it('keeps exactly one aria-live region, and it is the toasts', () => {
    // Untested until now, and the count is the assertion. Live regions compete: a second
    // one added casually (a status line, a countdown) makes both unreliable, and the
    // topbar is the standing temptation -- it carries shells-in-flight, which changes
    // several times a second in combat and would announce over everything else.
    const { root } = mount();
    const live = Array.from(root.querySelectorAll('[aria-live]'));
    expect(live.map((el) => (el as HTMLElement).className)).toEqual(['hud-toasts']);
    expect(live[0].getAttribute('aria-live')).toBe('polite');
  });
});

describe('HUD control names (issue #629)', () => {
  it('never names a control with a bare digit', () => {
    // THE MEASURED GAP: level-select buttons, the versus player-count row and the versus
    // stock row all shipped `textContent = String(n)` and nothing else, so a screen
    // reader tabbing them heard "1, 2, 3" with nothing saying what they set. The pane has
    // three such rows at once, which is what made it unusable rather than merely terse.
    const { hud: h, root } = mount();
    h.setLevelSelect(2, 4);
    const digits = Array.from(root.querySelectorAll('button'))
      .filter((b) => /^\d+$/.test(accessibleName(b)))
      .map((b) => `${b.className} -> '${accessibleName(b)}'`);
    expect(digits, 'controls whose entire accessible name is a number').toEqual([]);
  });

  it('gives every rendered control a non-empty accessible name', () => {
    // Broader than the digit rule and catches the other half of the gap: the colour
    // swatches have NO text at all, and were named only by `title` -- a tooltip, which
    // some screen readers ignore outright and none of them promise.
    const { hud: h, root } = mount();
    h.setLevelSelect(2, 4);
    h.setAchievements(new Set());
    // `.hud-action` carries NO text in the markup -- its word is written by `setOutcome`
    // (it is Retry, or Next Level, or Main Menu depending on the ending), so the button
    // is genuinely nameless until an outcome is pushed. This sweep found that on its
    // first run. It is driven rather than filtered out, for two reasons: a
    // visibility filter is the vacuous-test trap (jsdom's `getComputedStyle` ignores an
    // ancestor's `display: none`, so "skip the hidden ones" quietly skips everything),
    // and the state worth asserting is the one the player actually meets.
    const lost: TypedOutcome = { kind: 'practice-result', cleared: false };
    h.setState('main-menu');
    h.setState('playing');
    h.setState('outcome-lose');
    h.setOutcome({ tally: 'solo', attempt: ZERO_STATS, action: 'campaign-levels', typedOutcome: lost });
    // The match-failure alert's dismiss button is nameless the same way and for the same
    // reason (issue #325): its label comes from the classified failure, so the markup
    // carries none. Driven, not filtered, on exactly the precedent above.
    h.showMatchFailure({ title: 'That match could not start.', detail: 'Something went wrong.', action: 'Back to menu' });

    const unnamed = Array.from(root.querySelectorAll('button'))
      .filter((b) => accessibleName(b) === '')
      .map((b) => b.className);
    expect(unnamed, 'controls with no accessible name').toEqual([]);
  });

  it('distinguishes the per-slot versus controls from each other', () => {
    // Up to four slots build the SAME words -- Human/Bot/Off, A/B/C, Easy/Normal/Hard --
    // so before this the pane was a run of interchangeable labels and the only thing
    // tying a control to its player was screen position, which is the one cue a
    // non-visual reader does not get. Uniqueness is the honest way to state it: it fails
    // whether the slot context is missing, wrong, or applied to only some of the rows.
    const { hud: h, root } = mount();
    h.setState('main-menu');
    h.showVersusSetup(true);
    (root.querySelector('.hud-versus-players-row [data-players="4"]') as HTMLButtonElement).click();
    (root.querySelector('.hud-versus-mode-row [data-mode="teams"]') as HTMLButtonElement).click();

    const slotButtons = Array.from(root.querySelectorAll('.hud-versus-slot-row button'));
    expect(slotButtons.length, 'four slots really rendered their controls').toBeGreaterThan(8);
    const names = slotButtons.map(accessibleName);
    expect(new Set(names).size, `duplicate names: ${names.join(' | ')}`).toBe(names.length);
  });
});

describe('HUD data tables (issue #629)', () => {
  it('heads the stats table by column and by row, and names the table', () => {
    // The header row was built out of <td>, so "Lifetime" and "Level attempt" named
    // nothing -- every figure under them was read bare. `scope` is the other half: on a
    // table with BOTH row and column headers a screen reader otherwise has to guess which
    // a <th> is, and the guess is not reliable.
    const { hud: h, root } = mount();
    h.setStats({ lifetime: ZERO_STATS, attempt: ZERO_STATS });
    h.setState('main-menu');
    (root.querySelector('.hud-records-open') as HTMLButtonElement).click();

    const table = root.querySelector('.hud-stats-table') as HTMLElement;
    expect(table.querySelector('caption')?.textContent ?? '', 'the table names itself').not.toBe('');
    const cols = Array.from(table.querySelectorAll('thead th[scope="col"]')).map((c) => c.textContent);
    expect(cols).toEqual(['Lifetime', 'Level attempt']);
    const rowHeads = Array.from(table.querySelectorAll('tbody th'));
    expect(rowHeads.length, 'the body has row headers at all').toBeGreaterThan(0);
    for (const th of rowHeads) expect(th.getAttribute('scope'), th.textContent ?? '').toBe('row');
    // The corner cell heads neither its row nor its column; a <th> there announces an
    // empty heading on every row, so it must stay a data cell.
    expect(table.querySelector('thead tr')?.firstElementChild?.tagName).toBe('TD');
  });
});

describe('HUD achievement list (issue #629)', () => {
  it('says earned or locked in words, not only in a class', () => {
    // The single fact the pane exists to report was the one thing a screen reader could
    // not get: earned state lived in `--earned` and nowhere else, so an earned row and a
    // locked row were announced identically.
    const { hud: h, root } = mount();
    const first = ACHIEVEMENTS[0];
    h.setAchievements(new Set([first.id]));
    h.setState('main-menu');
    (root.querySelector('.hud-records-open') as HTMLButtonElement).click();
    (root.querySelector('.hud-records-tab-achievements') as HTMLButtonElement).click();

    const rows = Array.from(root.querySelectorAll('.hud-achievement'));
    expect(rows.length).toBe(ACHIEVEMENTS.length);
    expect(root.querySelector('.hud-achievement-list')?.getAttribute('role')).toBe('list');
    for (const row of rows) expect(row.getAttribute('role')).toBe('listitem');

    const earned = rows.find((r) => (r as HTMLElement).dataset.achievement === first.id)!;
    const locked = rows.find((r) => (r as HTMLElement).dataset.achievement !== first.id)!;
    expect(earned.textContent).toMatch(/Earned/);
    expect(locked.textContent).toMatch(/Locked/);
    // The state text must not be visible text a sighted reader also sees twice -- #630
    // owns the visible marker, and two of them is the predictable collision.
    expect(earned.querySelector('.ui-sr-only')?.textContent?.trim()).toBe('Earned.');
  });
});

describe('About & Legal heading structure (issue #117)', () => {
  const levels = (el: Element): number[] =>
    Array.from(el.querySelectorAll('h1, h2, h3, h4, h5, h6')).map((h) => Number(h.tagName[1]));

  it('nests every document section under the document, and skips no level', () => {
    // Two separable failures, and the second is the one this pane actually had in draft.
    //
    // A SKIPPED level (h2 -> h4) tells a screen reader's heading navigation that a section is
    // missing. A section heading at the SAME level as its document's title says the licence
    // clauses are siblings of the licence, not parts of it -- which is what the first draft
    // shipped (title `h3`, sections `h3`), and which no skip check can see because nothing is
    // skipped. The structural half of what #629 fixed by giving the panes landmarks.
    const { hud: h, root } = mount();
    h.setState('main-menu');
    (root.querySelector('.hud-about-open') as HTMLButtonElement).click();
    // Every document open, so the sections are in the tree at all.
    for (const toggle of Array.from(root.querySelectorAll<HTMLButtonElement>('.hud-legal-toggle'))) {
      toggle.click();
    }
    const about = root.querySelector('.hud-about') as HTMLElement;

    const order = levels(about);
    // Non-vacuity: an empty pane, or one whose documents never opened, passes a no-skip walk
    // trivially. Five titles plus their sections is dozens of headings.
    expect(order.length).toBeGreaterThan(20);
    expect(order[0], 'the pane heads itself').toBe(1);
    for (let i = 1; i < order.length; i += 1) {
      expect(order[i], `heading ${i} skips a level after h${order[i - 1]}`).toBeLessThanOrEqual(
        order[i - 1] + 1,
      );
    }

    const bodies = Array.from(root.querySelectorAll<HTMLElement>('.hud-legal-body'));
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      const [title, ...sections] = levels(body);
      expect(title, `${body.id} has no title heading`).not.toBeUndefined();
      // Not `toBeGreaterThan(title)` alone: a document with no sections would pass an empty
      // loop, so the population is pinned first for the documents that have them.
      expect(sections.length, `${body.id} has no section headings`).toBeGreaterThan(0);
      for (const level of sections) {
        expect(level, `${body.id}: a section is not nested under its document title`).toBeGreaterThan(
          title,
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Issue #629's remaining half: announcing the status transitions that deserve it.
//
// The policy is narrow on purpose. `setStatus` is pushed EVERY FRAME from the loop's
// `refreshTopbar`, so the interesting failure is not "nothing is announced" -- it is a
// live region that narrates continuously, talks over the toasts, or repeats a sentence a
// focused surface already read aloud.
// ---------------------------------------------------------------------------

/** The screen-reader-only line inside the page's one live region. */
const spoken = (root: HTMLElement): string =>
  (root.querySelector('.hud-announce') as HTMLElement).textContent ?? '';

const campaign = (over: Partial<{ mission: number; missions: number; lives: number; enemies: number }> = {}) =>
  ({
    kind: 'campaign' as const,
    mission: over.mission ?? 1,
    missions: over.missions ?? 5,
    lives: over.lives ?? 3,
    enemies: over.enemies ?? 4,
  });

const versus = (stocks: Array<{ slot: number; stock: number }>) =>
  ({ kind: 'versus' as const, mission: 1, missions: 1, stocks });

describe('live status announcements (issue #629)', () => {
  it('announces a life loss ONCE, with the count the bar is showing', () => {
    // The number comes from the status push that follows the death, not from the death
    // signal -- `signalPlayerDeath` carries only a colour, and reading the previous push
    // would speak a count one frame out of step with the topbar beside it.
    const { hud: h, root } = mount();
    h.setStatus(campaign({ lives: 3 }));
    expect(spoken(root)).toBe('');
    h.signalPlayerDeath(0xff0000);
    h.setStatus(campaign({ lives: 2 }));
    expect(spoken(root)).toBe('Life lost. 2 lives remaining.');
  });

  it('says "1 life", not "1 lives"', () => {
    const { hud: h, root } = mount();
    h.setStatus(campaign({ lives: 2 }));
    h.signalPlayerDeath(0xff0000);
    h.setStatus(campaign({ lives: 1 }));
    expect(spoken(root)).toBe('Life lost. 1 life remaining.');
  });

  it('does NOT announce a life loss from a lives drop with no death behind it', () => {
    // THE REASON THIS IS NOT A DIFF. `pushStatus` fires on every world build -- a level
    // advance with fresh lives, a quit, issue #252's restarts -- so a session replaced by a
    // different board that starts lower would otherwise be narrated as a death.
    const { hud: h, root } = mount();
    h.setStatus(campaign({ lives: 3 }));
    h.setStatus(campaign({ lives: 1 }));
    expect(spoken(root)).toBe('');
  });

  it('announces each life loss once, not once per frame', () => {
    // Criterion 6, and the load-bearing one: the loop re-pushes the same status every
    // frame. Sixty identical writes to a live region is speech spam, which is the failure
    // mode this whole feature is most likely to produce.
    const { hud: h, root } = mount();
    h.setStatus(campaign({ lives: 3 }));
    h.signalPlayerDeath(0xff0000);
    for (let i = 0; i < 60; i++) h.setStatus(campaign({ lives: 2 }));
    expect(spoken(root)).toBe('Life lost. 2 lives remaining.');
    // ...and a SECOND death still speaks, because its sentence differs.
    h.signalPlayerDeath(0xff0000);
    h.setStatus(campaign({ lives: 1 }));
    expect(spoken(root)).toBe('Life lost. 1 life remaining.');
  });

  it('WRITES the live region once across sixty identical pushes, not sixty times', () => {
    // The case above asserts the final text, which a broken repeat guard also produces --
    // sixty identical writes leave the same string behind. What distinguishes them is the
    // number of DOM mutations, because that is what a screen reader reacts to: a live
    // region rewritten every frame announces every frame, even with identical content.
    // `takeRecords()` is synchronous, so no timing is involved.
    const { hud: h, root } = mount();
    h.setStatus(campaign({ lives: 3 }));
    h.signalPlayerDeath(0xff0000);
    const node = root.querySelector('.hud-announce') as HTMLElement;
    const observer = new MutationObserver(() => {});
    observer.observe(node, { childList: true, characterData: true, subtree: true });
    for (let i = 0; i < 60; i++) h.setStatus(campaign({ lives: 2 }));
    const writes = observer.takeRecords().length;
    observer.disconnect();
    expect(writes).toBe(1);
  });

  it('says nothing at all for the high-frequency readouts', () => {
    // Criterion 4. Enemies is the one that changes on every kill; shells and the countdown
    // never reach `setStatus` at all, which is why the topbar is still not a live region.
    const { hud: h, root } = mount();
    h.setStatus(campaign({ enemies: 4 }));
    for (const enemies of [3, 2, 1, 0]) h.setStatus(campaign({ enemies }));
    expect(spoken(root)).toBe('');
  });

  it('announces a versus stock loss, naming the player and what is left', () => {
    const { hud: h, root } = mount();
    h.setStatus(versus([{ slot: 0, stock: 3 }, { slot: 1, stock: 3 }]));
    h.setStatus(versus([{ slot: 0, stock: 3 }, { slot: 1, stock: 2 }]));
    expect(spoken(root)).toBe('Player 2 lost a stock. 2 remaining.');
  });

  it('does not narrate a rematch, where every stock goes back UP', () => {
    const { hud: h, root } = mount();
    h.setStatus(versus([{ slot: 0, stock: 1 }, { slot: 1, stock: 2 }]));
    h.setStatus(versus([{ slot: 0, stock: 3 }, { slot: 1, stock: 3 }]));
    expect(spoken(root)).toBe('');
  });

  it('does not read a DIFFERENT match’s lower stock as a loss in this one', () => {
    // A two-player match replaced by a four-player one: slot 0 holds fewer stocks than it
    // did, and nobody lost anything. The slot SET is what distinguishes them.
    const { hud: h, root } = mount();
    h.setStatus(versus([{ slot: 0, stock: 5 }, { slot: 1, stock: 5 }]));
    h.setStatus(versus([
      { slot: 0, stock: 3 }, { slot: 1, stock: 3 }, { slot: 2, stock: 3 }, { slot: 3, stock: 3 },
    ]));
    expect(spoken(root)).toBe('');
  });

  it('announces a level advance', () => {
    const { hud: h, root } = mount();
    h.setStatus(campaign({ mission: 1, missions: 5 }));
    h.setStatus(campaign({ mission: 2, missions: 5 }));
    expect(spoken(root)).toBe('Level 2 of 5.');
  });

  it('stays SILENT about the level while an outcome surface is up', () => {
    // Criterion 5: the win panel is focused and read at exactly the moment the next mission
    // number arrives, so announcing it here would say the same thing twice. Gated on the
    // panel's own visibility rather than on a delay.
    const { hud: h, root } = mount();
    h.setStatus(campaign({ mission: 1, missions: 5 }));
    h.setState('outcome-win');
    h.setStatus(campaign({ mission: 2, missions: 5 }));
    expect(spoken(root)).toBe('');
  });

  it('forgets the transition across a gap in gameplay', () => {
    // `setStatus(null)` is leaving gameplay. Re-entering on a different level must not read
    // as an advance, and an owed death announcement belongs to the session that is over.
    const { hud: h, root } = mount();
    h.setStatus(campaign({ mission: 1, lives: 3 }));
    h.signalPlayerDeath(0xff0000);
    h.setStatus(null);
    h.setStatus(campaign({ mission: 4, lives: 1 }));
    expect(spoken(root)).toBe('');
  });

  it('keeps the announcement out of sight, inside the one live region', () => {
    // The visual HUD is unchanged (criterion 7): this is a `.ui-sr-only` child of the toast
    // stack, not a second region and not a visible toast. Both halves asserted, because a
    // node that was merely hidden would announce nothing and a node outside the region
    // would compete with it.
    const { root } = mount();
    const node = root.querySelector('.hud-announce') as HTMLElement;
    expect(node.classList.contains('ui-sr-only')).toBe(true);
    expect(node.closest('[aria-live]')?.className).toBe('hud-toasts');
    expect(node.hasAttribute('aria-live')).toBe(false);
  });
});
