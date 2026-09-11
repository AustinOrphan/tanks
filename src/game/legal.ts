/**
 * The About & Legal pane's document surface (issue #117).
 *
 * A dumb renderer over generated data. Every word of legal text comes from
 * `legal-content.ts`, which `npm run legal` writes from the repository's own PRIVACY.md,
 * CREDITS.md, THIRD-PARTY-NOTICES.md, LICENSE and CONTENT-LICENSE.md -- #117's
 * "no legal content is duplicated into a hand-maintained list that can drift from
 * repository sources" is satisfied at the source, not by discipline. Nothing here decides
 * what a document says; it decides which element each block becomes.
 *
 * WHY DISCLOSURES AND NOT SUB-SCREENS. Five documents are ~25 KB of text and #117 asks for
 * "a readable scrolling document surface without crowding normal menus". The obvious shape
 * -- a second pane per document -- is the one the layer stack cannot express: `openLayer`
 * REPLACES a pane rather than covering it (hud.ts's own doc comment on the rule), so a
 * document opened from About would record the About BUTTON as its origin and send Back to
 * the Main Menu, not to the index the player came from. One pane with per-document
 * disclosures keeps Back honest and keeps the whole surface inside the one container the
 * layer stack knows about.
 *
 * EVERY STRING GOES IN THROUGH `textContent`. The generator flattens inline markdown to
 * plain text and rejects inline HTML, so there is no path from a document to markup, and a
 * licence that grows an `<img onerror=...>` becomes visible characters.
 */
import {
  LEGAL_DOCUMENTS,
  LEGAL_LINKS,
  type LegalBlock,
  type LegalDocument,
} from './legal-content';

/** One document's disclosure: the button that opens it and the region it opens. */
export interface LegalDisclosure {
  readonly id: string;
  readonly toggle: HTMLButtonElement;
  readonly body: HTMLElement;
  readonly state: HTMLElement;
}

const BODY_HIDDEN = 'hud-legal-body--hidden';

function text<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  content: string,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  el.className = className;
  el.textContent = content;
  return el;
}

/**
 * One block as one element.
 *
 * Heading levels are shifted down twice: the pane's own `<h1>` is "About & Legal" and each
 * document is an `<h2>`, so a document's own `##` is an `<h3>`. A flat run of `<h2>`s would
 * say every licence clause is a sibling of the pane title, which is the structural half of
 * the same defect #629 fixed by giving the panes landmarks.
 */
function blockElement(block: LegalBlock): HTMLElement {
  switch (block.kind) {
    case 'heading':
      return text(block.level === 2 ? 'h3' : 'h4', 'hud-legal-heading', block.text);
    case 'paragraph':
      return text('p', 'hud-legal-para', block.text);
    case 'note':
      return text('p', 'hud-legal-note', block.text);
    case 'code':
      // `<pre>` rather than a styled div: the licence texts inside these fences are
      // hard-wrapped by their authors, and collapsing that whitespace reflows a legal
      // notice into something its copyright holder did not write.
      return text('pre', 'hud-legal-code', block.text);
    case 'list': {
      const ul = document.createElement('ul');
      ul.className = 'hud-legal-list';
      for (const item of block.items) ul.appendChild(text('li', 'hud-legal-item', item));
      return ul;
    }
    case 'table': {
      const table = document.createElement('table');
      table.className = 'hud-legal-table';
      // Named, and headed by column with `scope` -- the two halves #629 found missing on
      // the stats table, where an unheaded `<td>` row left every figure announced bare.
      // The caption is screen-reader-only because the visible heading directly above the
      // table already says the same words, and two visible copies is the collision #629
      // called out on the achievement rows.
      table.appendChild(text('caption', 'ui-sr-only', block.caption));
      const thead = document.createElement('thead');
      const headRow = document.createElement('tr');
      for (const header of block.headers) {
        const th = text('th', 'hud-legal-th', header);
        th.setAttribute('scope', 'col');
        headRow.appendChild(th);
      }
      thead.appendChild(headRow);
      table.appendChild(thead);
      const tbody = document.createElement('tbody');
      for (const row of block.rows) {
        const tr = document.createElement('tr');
        for (const cell of row) tr.appendChild(text('td', 'hud-legal-td', cell));
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      return table;
    }
  }
}

function disclosureFor(doc: LegalDocument): LegalDisclosure {
  const wrap = document.createElement('div');
  wrap.className = 'hud-legal-doc';
  wrap.dataset.legal = doc.id;

  const toggleId = `hud-legal-toggle-${doc.id}`;
  const bodyId = `hud-legal-body-${doc.id}`;

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'ui-btn ui-btn--sm hud-legal-toggle';
  toggle.id = toggleId;
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-controls', bodyId);
  toggle.appendChild(text('span', 'hud-legal-toggle-label', doc.label));
  // The state in words as well as in `aria-expanded`, because a caret alone puts the one
  // fact this control reports into shape and colour only (issue #630's class of defect).
  // `aria-hidden` on it: `aria-expanded` ALREADY announces collapsed/expanded, so leaving
  // it in the accessible name would make a screen reader say the state twice and would
  // name the button "Privacy Show".
  const state = text('span', 'hud-legal-toggle-state', 'Show');
  state.setAttribute('aria-hidden', 'true');
  toggle.appendChild(state);

  const body = document.createElement('div');
  body.className = `hud-legal-body ${BODY_HIDDEN}`;
  body.id = bodyId;
  body.setAttribute('role', 'group');
  body.setAttribute('aria-labelledby', toggleId);
  body.appendChild(text('h3', 'hud-legal-title', doc.title));
  body.appendChild(
    text('p', 'hud-legal-source', `The full text of ${doc.source} in this repository.`),
  );
  for (const block of doc.blocks) body.appendChild(blockElement(block));

  wrap.appendChild(toggle);
  wrap.appendChild(body);
  return { id: doc.id, toggle, body, state };
}

/**
 * Builds the two outbound links into `container`.
 *
 * `<a>`, not a button that calls `window.open`: a screen reader announces a link as a link,
 * which is how a player learns the control leaves the app before activating it -- and a
 * button that navigates is the same false promise as `aria-modal` without a focus trap,
 * which #628 existed to remove. `tabindex="0"` is redundant for the Tab order (an `<a href>`
 * is already focusable) and load-bearing for the roving order: hud.ts's `focusableControls`
 * selects `'button, [tabindex]'`, so without it a gamepad and the D-pad could never reach
 * these two. "Opens a new tab" is deliberately IN the accessible name -- `target="_blank"`
 * alone is not reliably announced, and #117 asks for external-link behaviour to be explicit.
 */
export function renderLegalLinks(container: HTMLElement): HTMLAnchorElement[] {
  container.textContent = '';
  return LEGAL_LINKS.map((link) => {
    const a = document.createElement('a');
    a.className = 'ui-btn ui-btn--sm hud-legal-link';
    a.href = link.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.tabIndex = 0;
    a.dataset.legalLink = link.id;
    a.appendChild(text('span', 'hud-legal-link-label', link.label));
    a.appendChild(text('span', 'hud-legal-link-hint', 'Opens a new tab'));
    container.appendChild(a);
    return a;
  });
}

/** Builds one collapsed disclosure per document into `container`, in catalog order. */
export function renderLegalDocuments(container: HTMLElement): LegalDisclosure[] {
  container.textContent = '';
  return LEGAL_DOCUMENTS.map((doc) => {
    const disclosure = disclosureFor(doc);
    container.appendChild(disclosure.toggle.parentElement as HTMLElement);
    return disclosure;
  });
}

/** Shows or hides one document, in `aria-expanded`, in words, and in `display`. */
export function setLegalExpanded(disclosure: LegalDisclosure, expanded: boolean): void {
  disclosure.toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  disclosure.state.textContent = expanded ? 'Hide' : 'Show';
  disclosure.body.classList.toggle(BODY_HIDDEN, !expanded);
}

/** Whether the disclosure is open, read off the attribute rather than off a local flag. */
export function isLegalExpanded(disclosure: LegalDisclosure): boolean {
  return disclosure.toggle.getAttribute('aria-expanded') === 'true';
}

/**
 * Collapses every document.
 *
 * Called when the pane closes, so reopening About presents the index rather than whatever
 * was left open -- the same reason the Records panes re-render on open instead of keeping a
 * scroll position across a visit.
 */
export function collapseLegalDocuments(disclosures: readonly LegalDisclosure[]): void {
  for (const disclosure of disclosures) setLegalExpanded(disclosure, false);
}
