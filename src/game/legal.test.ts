// @vitest-environment jsdom
//
// The About & Legal document surface (issue #117). What each case would catch is named with
// it, because a renderer test that asserts "it produced some elements" advertises coverage
// it does not have.
//
// The content itself is NOT re-asserted here -- tools/legal/generate.test.ts owns the
// question of whether the generated module still matches the repository's markdown. This
// file owns the question of what each block becomes once it is data.
import { describe, it, expect } from 'vitest';
import {
  collapseLegalDocuments,
  isLegalExpanded,
  legalBlockElement,
  renderLegalDocuments,
  renderLegalLinks,
  setLegalExpanded,
  type LegalDisclosure,
} from './legal';
import { LEGAL_DOCUMENTS, LEGAL_LINKS, type LegalBlock } from './legal-content';

function mount(): { container: HTMLElement; disclosures: LegalDisclosure[] } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  return { container, disclosures: renderLegalDocuments(container) };
}

/** The accessible name of a control, for the subset of naming these controls use. */
function accessibleName(el: HTMLElement): string {
  const labelled = el.getAttribute('aria-label');
  if (labelled !== null) return labelled;
  const parts: string[] = [];
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) parts.push(node.textContent ?? '');
    else if (node instanceof HTMLElement && node.getAttribute('aria-hidden') !== 'true') {
      parts.push(node.textContent ?? '');
    }
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

describe('the legal document disclosures', () => {
  it('offers one collapsed document per generated entry, each pointing at the region it opens', () => {
    // Two failures, one case: a document that renders no disclosure at all is unreachable,
    // and an `aria-controls` that names a missing id is the false containment claim #629
    // withdrew ARIA tabs over -- a screen reader is told a relationship the DOM does not have.
    const { container, disclosures } = mount();
    expect(LEGAL_DOCUMENTS.length).toBeGreaterThan(0);
    expect(disclosures.map((d) => d.id)).toEqual(LEGAL_DOCUMENTS.map((d) => d.id));
    for (const disclosure of disclosures) {
      expect(disclosure.toggle.getAttribute('aria-expanded')).toBe('false');
      const controls = disclosure.toggle.getAttribute('aria-controls') ?? '';
      expect(controls).not.toBe('');
      // Resolved against the DOM, not against `disclosure.body` -- comparing the attribute
      // to the object the same function just built would pass on an id that exists nowhere.
      expect(container.querySelector(`#${controls}`)).toBe(disclosure.body);
      expect(disclosure.body.classList.contains('hud-legal-body--hidden')).toBe(true);
      expect(isLegalExpanded(disclosure)).toBe(false);
    }
  });

  it('moves the attribute, the word and the class together when a document opens', () => {
    // Three carriers of one fact, and the defect is any one of them going stale: a body that
    // is revealed while `aria-expanded` stays `false` lies to a screen reader; a state word
    // stuck on "Show" lies to a sighted reader; a class left on hides a document the button
    // says is open. Asserted in both directions, so a `setLegalExpanded` that ignored its
    // argument and always opened would fail the second half.
    const { disclosures } = mount();
    const first = disclosures[0];

    setLegalExpanded(first, true);
    expect(first.toggle.getAttribute('aria-expanded')).toBe('true');
    expect(first.state.textContent).toBe('Hide');
    expect(first.body.classList.contains('hud-legal-body--hidden')).toBe(false);
    expect(isLegalExpanded(first)).toBe(true);

    setLegalExpanded(first, false);
    expect(first.toggle.getAttribute('aria-expanded')).toBe('false');
    expect(first.state.textContent).toBe('Show');
    expect(first.body.classList.contains('hud-legal-body--hidden')).toBe(true);
    expect(isLegalExpanded(first)).toBe(false);
  });

  it('names each toggle by its document alone, with the state word out of the name', () => {
    // `aria-expanded` already announces collapsed/expanded, so a state word inside the
    // accessible name makes a screen reader say the state twice and renames the control to
    // "Privacy Show" -- the two-announcements-of-one-fact collision #629 called out on the
    // achievement rows. Dropping `aria-hidden` from the state span is what this fails on.
    const { disclosures } = mount();
    for (const [i, disclosure] of disclosures.entries()) {
      expect(accessibleName(disclosure.toggle)).toBe(LEGAL_DOCUMENTS[i].label);
      expect(disclosure.state.getAttribute('aria-hidden')).toBe('true');
      // ...and the word IS on screen, which is the half `aria-hidden` must not take away.
      expect(disclosure.state.textContent).toBe('Show');
    }
  });

  it('closes every document, so a second visit opens on the index', () => {
    const { disclosures } = mount();
    for (const disclosure of disclosures) setLegalExpanded(disclosure, true);
    expect(disclosures.every(isLegalExpanded)).toBe(true);
    collapseLegalDocuments(disclosures);
    expect(disclosures.some(isLegalExpanded)).toBe(false);
  });

  it('rebuilds from scratch rather than appending to whatever was there', () => {
    // `renderLegalDocuments` is called once in production, but a second call that DOUBLED the
    // list would duplicate every `id` in the document -- and duplicate ids are exactly what
    // makes `aria-controls` resolve to the wrong element.
    const { container } = mount();
    const before = container.querySelectorAll('.hud-legal-doc').length;
    renderLegalDocuments(container);
    expect(container.querySelectorAll('.hud-legal-doc').length).toBe(before);
  });
});

describe('the legal block renderer', () => {
  it('renders every block kind the generator can emit, and the shipped data uses all of them', () => {
    // The non-vacuity half matters more than the mapping half: a `kinds` set missing an entry
    // would mean this file's per-kind cases below are testing a branch no document reaches,
    // and the pane would be one un-rendered construct away from a blank region.
    const kinds = new Set(LEGAL_DOCUMENTS.flatMap((d) => d.blocks.map((b) => b.kind)));
    expect([...kinds].sort()).toEqual(['code', 'heading', 'list', 'note', 'paragraph', 'table']);

    const tags = new Map<string, string>([
      ['heading', 'H4'],
      ['paragraph', 'P'],
      ['note', 'P'],
      ['code', 'PRE'],
      ['list', 'UL'],
      ['table', 'TABLE'],
    ]);
    for (const doc of LEGAL_DOCUMENTS) {
      for (const block of doc.blocks) {
        const el = legalBlockElement(block);
        const expected = block.kind === 'heading' && block.level === 3 ? 'H5' : tags.get(block.kind);
        expect(el.tagName, `${doc.id}: ${block.kind}`).toBe(expected);
      }
    }
  });

  it('nests a third-level heading under the second, which no committed document exercises', () => {
    // MEASURED, not assumed: an awk pass over all five documents finds `#` and `##` headings
    // and no `###`, so the loop above walks the `h4` branch for every shipped heading and
    // never the `h5` one. Without this case that branch is untested -- the same shape as the
    // empty-table case below, where the shipped data cannot reach the code.
    const deepest = new Map<number, number>();
    for (const doc of LEGAL_DOCUMENTS) {
      for (const block of doc.blocks) {
        if (block.kind === 'heading') deepest.set(block.level, (deepest.get(block.level) ?? 0) + 1);
      }
    }
    expect(deepest.get(2), 'the shipped documents have level-2 headings').toBeGreaterThan(0);
    expect(deepest.get(3), 'a committed document now uses ### -- the sweep above covers it').toBe(
      undefined,
    );
    expect(legalBlockElement({ kind: 'heading', level: 3, text: 'Sub-clause' }).tagName).toBe('H5');
  });

  it('distinguishes a note from a paragraph, which share a tag', () => {
    // Both are `<p>`, so the tag assertion above cannot tell them apart and a renderer that
    // dropped the `note` branch into `paragraph` would pass it. The class is the only thing
    // that reaches the left bar saying a passage was quoted in the source.
    const note = legalBlockElement({ kind: 'note', text: 'It is not legal advice.' });
    const para = legalBlockElement({ kind: 'paragraph', text: 'It is not legal advice.' });
    expect(note.className).toBe('hud-legal-note');
    expect(para.className).toBe('hud-legal-para');
  });

  it('heads a table by column with scope, and names it', () => {
    // #629's stats-table finding: `<td>` column headers head nothing, and on a table with no
    // caption a screen reader has no way to say what the figures are about. Driven from the
    // shipped tables rather than a fixture, so a caption the generator stopped deriving fails
    // here rather than in the tool's own suite alone.
    const tables = LEGAL_DOCUMENTS.flatMap((d) => d.blocks).filter(
      (b): b is Extract<LegalBlock, { kind: 'table' }> => b.kind === 'table',
    );
    expect(tables.length).toBe(5);
    for (const block of tables) {
      const el = legalBlockElement(block);
      expect(el.querySelector('caption')?.textContent).toBe(block.caption);
      expect(el.querySelector('caption')?.className).toBe('ui-sr-only');
      const cols = Array.from(el.querySelectorAll('thead th'));
      expect(cols.length).toBe(block.headers.length);
      for (const th of cols) expect(th.getAttribute('scope')).toBe('col');
      expect(el.querySelectorAll('tbody tr').length).toBe(block.rows.length);
      // No `<th>` in the body: these tables have column headers only, and a `<th>` on a data
      // cell announces a heading that heads nothing.
      expect(el.querySelectorAll('tbody th').length).toBe(0);
    }
  });

  it('keeps an empty table\'s headers rather than rendering a bare frame', () => {
    // CREDITS.md's two attribution tables ship with no rows on purpose -- the document says
    // so in the line beneath them -- so "rows: []" is data, not a parse failure, and the
    // headers are what tell a reader what a future row would hold.
    const el = legalBlockElement({
      kind: 'table',
      caption: 'SFX',
      headers: ['Key', 'File'],
      rows: [],
    });
    expect(el.querySelectorAll('thead th').length).toBe(2);
    expect(el.querySelectorAll('tbody tr').length).toBe(0);
  });

  it('puts document text in as text, so a document cannot inject markup', () => {
    // The shipped documents contain no markup today, which is exactly why this uses a hostile
    // fixture: assert only over `LEGAL_DOCUMENTS` and the `textContent` promise in legal.ts's
    // header is untested until the day it is violated. `innerHTML` here would make this fail
    // on the child count.
    const hostile = '<img src=x onerror="alert(1)"> & <b>bold</b>';
    for (const block of [
      { kind: 'paragraph', text: hostile },
      { kind: 'heading', level: 2, text: hostile },
      { kind: 'note', text: hostile },
      { kind: 'code', text: hostile },
    ] as const satisfies readonly LegalBlock[]) {
      const el = legalBlockElement(block);
      expect(el.textContent, block.kind).toBe(hostile);
      expect(el.children.length, block.kind).toBe(0);
    }
    const list = legalBlockElement({ kind: 'list', items: [hostile] });
    expect(list.querySelectorAll('li').length).toBe(1);
    expect(list.querySelector('li')?.textContent).toBe(hostile);
    const table = legalBlockElement({ kind: 'table', caption: 'c', headers: [hostile], rows: [[hostile]] });
    expect(table.querySelector('th')?.children.length).toBe(0);
    expect(table.querySelector('td')?.textContent).toBe(hostile);
  });
});

describe('the outbound legal links', () => {
  it('is a link, opens safely, and says so in its name', () => {
    // Four separable failures: a `<button>` instead of an `<a>` never announces as a link, so
    // a player cannot tell the control leaves the app; a missing `rel` hands the new tab a
    // live `window.opener` back into the game; a missing `tabindex` drops the link out of
    // `focusableControls`' `'button, [tabindex]'` selector, so a gamepad can never reach it
    // (see hud.navigation.test.ts's control count, measured at 83 without it); and a name that
    // omits "Opens a new tab" leaves the one thing `target="_blank"` does not reliably
    // announce unsaid.
    const container = document.createElement('div');
    document.body.appendChild(container);
    const links = renderLegalLinks(container);

    expect(LEGAL_LINKS.length).toBeGreaterThan(0);
    expect(links.length).toBe(LEGAL_LINKS.length);
    for (const [i, link] of links.entries()) {
      expect(link.tagName).toBe('A');
      expect(link.getAttribute('href')).toBe(LEGAL_LINKS[i].url);
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')).toBe('noopener noreferrer');
      expect(link.getAttribute('tabindex')).toBe('0');
      expect(accessibleName(link)).toBe(`${LEGAL_LINKS[i].label} Opens a new tab`);
    }
  });

  it('sends every destination off this device over https', () => {
    // These two URLs are read out of README.md and PRIVACY.md by the generator. A pattern
    // that silently matched a different line would most likely produce a relative path or a
    // repository file name, both of which resolve against the game's own origin and neither
    // of which is a destination.
    for (const link of LEGAL_LINKS) expect(link.url).toMatch(/^https:\/\/[^/]+\//);
  });
});
