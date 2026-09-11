/**
 * Parses the repository's legal documents into the small block vocabulary the About &
 * Legal pane renders (issue #117).
 *
 * WHY A PARSER HERE RATHER THAN IN THE APP. `src/` may not import anything outside
 * itself -- `dependency-direction.test.ts`'s `escapes src/` rule -- so production code
 * cannot read `PRIVACY.md` and friends at all, and #117's acceptance criteria forbid
 * copying their text into a hand-maintained list that can drift from the repository
 * sources. The resolution is a generated module: this file turns each document into
 * data, `render.mjs` emits `src/game/legal-content.ts` from it, `generate.test.ts`
 * regenerates and diffs. Putting the markdown knowledge in a tool keeps the app a dumb
 * renderer, which is the same trade `tools/notices/` already makes for
 * THIRD-PARTY-NOTICES.md.
 *
 * THE SUBSET IS CLOSED, NOT GENERAL. This is not a markdown implementation; it handles
 * exactly the constructs the five committed documents use, and `assertSupported` below
 * throws on anything else so a future document cannot be silently half-rendered. The
 * inventory, measured with an awk pass over all five files: ATX headings, paragraphs,
 * bullet lists, pipe tables, fenced code, blockquotes, YAML frontmatter, HTML comments,
 * and inline bold/italic/code/links/entities. No ordered lists, no nested lists, no
 * inline HTML, no reference links, no setext headings -- and a document that adds one
 * fails the guard rather than losing the content.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/**
 * The documents the pane offers, in the order it offers them, most player-relevant
 * first. `label` is the disclosure button's word and is UI vocabulary; everything else
 * -- including each document's own heading -- comes from the file.
 */
export const LEGAL_SOURCES = [
  { id: 'privacy', label: 'Privacy', source: 'PRIVACY.md' },
  { id: 'credits', label: 'Credits', source: 'CREDITS.md' },
  { id: 'notices', label: 'Third-party notices', source: 'THIRD-PARTY-NOTICES.md' },
  { id: 'license', label: 'Code licence', source: 'LICENSE' },
  { id: 'content-license', label: 'Content licence', source: 'CONTENT-LICENSE.md' },
];

const ENTITIES = new Map([
  ['&mdash;', '—'],
  ['&ndash;', '–'],
  ['&amp;', '&'],
  ['&lt;', '<'],
  ['&gt;', '>'],
  ['&quot;', '"'],
  ['&apos;', "'"],
  ['&#39;', "'"],
  ['&nbsp;', ' '],
]);

/**
 * Flattens one line of inline markdown to the plain text the pane shows.
 *
 * Links keep their URL in parentheses only when the URL leaves the repository: a
 * `[`LICENSE`](LICENSE)` cross-reference would otherwise print a path that means nothing
 * to a player, while `[Play it](https://...)` is the one thing they might want to type.
 * Nothing here produces markup -- the renderer sets `textContent`, so a document that
 * grows an inline `<script>` becomes visible text rather than a script (and
 * `assertSupported` rejects it first).
 */
export function inlineText(line) {
  let out = line;
  out = out.replace(/\[([^\]]*)\]\(([^)]*)\)/g, (_m, text, url) =>
    /^[a-z]+:\/\//i.test(url) ? `${text} (${url})` : text,
  );
  // An autolink is the bare URL. LICENSE:5 is `<https://polyformproject.org/...>`, which
  // is the canonical text of the licence and the one line a reader might retype.
  out = out.replace(AUTOLINK, '$1');
  out = out.replace(/`([^`]*)`/g, '$1');
  out = out.replace(/\*\*([^*]+)\*\*/g, '$1');
  out = out.replace(/\*([^*]+)\*/g, '$1');
  out = out.replace(/(^|[^A-Za-z0-9_])_([^_]+)_(?![A-Za-z0-9_])/g, '$1$2');
  for (const [entity, char] of ENTITIES) out = out.split(entity).join(char);
  return out.trim();
}

/** `| a | b |` -> `['a', 'b']`. The outer empties from the leading/trailing pipe go. */
function tableCells(line) {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((c) => inlineText(c));
}

const SEPARATOR_ROW = /^\|?[\s|:-]+\|?$/;

/** `<https://example.com>` -- a bare URL in angle brackets, not an HTML tag. */
const AUTOLINK = /<([a-z]+:\/\/[^>\s]+)>/gi;

/**
 * Refuses a construct the block walk below would drop on the floor.
 *
 * The failure this exists to prevent is silent: an ordered list whose lines fall through
 * to the paragraph branch still renders -- as one run-on paragraph with the numbers
 * inline -- so nothing would be red while the pane misrepresented a licence. Throwing
 * here makes `npm run legal` the thing that fails, with the file and line to fix.
 */
function assertSupported(line, source, lineNo) {
  const where = `${source}:${lineNo}`;
  if (/^\s*\d+\.\s/.test(line)) {
    throw new Error(`${where}: ordered list is not in the supported subset -- add a block kind for it`);
  }
  if (/^\s+[-*]\s/.test(line)) {
    throw new Error(`${where}: nested list is not in the supported subset -- add a block kind for it`);
  }
  if (/^\s*<[a-zA-Z/]/.test(line) && !new RegExp(AUTOLINK.source, 'i').test(line.trim())) {
    throw new Error(`${where}: inline HTML is not in the supported subset -- the renderer sets textContent`);
  }
  if (/^\s*(===+|---+)\s*$/.test(line)) {
    throw new Error(`${where}: setext heading (or a stray rule) is not in the supported subset`);
  }
}

/**
 * One document as `{ title, blocks }`.
 *
 * `title` is the document's own H1 when it has one; THIRD-PARTY-NOTICES.md has none
 * (it opens with its generated-by comment), so the caller's label stands in. The H1 is
 * consumed rather than emitted: the pane already heads each document with its label, and
 * a second copy of the same words is the collision #629 called out on the achievement
 * rows.
 */
export function parseLegalDocument(text, source) {
  const withoutComments = text.replace(/<!--[\s\S]*?-->/g, '');
  const body = withoutComments.startsWith('---\n')
    ? withoutComments.slice(withoutComments.indexOf('\n---', 3) + 4)
    : withoutComments;

  const lines = body.split('\n');
  const blocks = [];
  let title = null;
  let paragraph = [];
  // The nearest preceding heading, which becomes a table's `<caption>`. A table needs a
  // name of its own -- #629's stats-table finding was that unnamed headers head nothing --
  // and every table in these documents sits directly under the heading that describes it.
  let lastHeading = null;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push({ kind: 'paragraph', text: inlineText(paragraph.join(' ')) });
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const lineNo = i + 1;

    if (line.trim() === '') {
      flushParagraph();
      continue;
    }

    if (line.startsWith('```')) {
      flushParagraph();
      const code = [];
      i += 1;
      while (i < lines.length && !lines[i].startsWith('```')) {
        code.push(lines[i]);
        i += 1;
      }
      if (i >= lines.length) throw new Error(`${source}: unterminated code fence opened at line ${lineNo}`);
      blocks.push({ kind: 'code', text: code.join('\n') });
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      const level = heading[1].length;
      const text = inlineText(heading[2]);
      if (level === 1 && title === null) title = text;
      else {
        blocks.push({ kind: 'heading', level: Math.min(level, 3), text });
        lastHeading = text;
      }
      continue;
    }

    if (line.trim().startsWith('|')) {
      flushParagraph();
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        if (!SEPARATOR_ROW.test(lines[i])) rows.push(tableCells(lines[i]));
        i += 1;
      }
      i -= 1;
      const [headers, ...rest] = rows;
      // An all-empty row is a placeholder, not data: CREDITS.md's two attribution tables
      // ship exactly one each, and the italic line under them says so in the source.
      const populated = rest.filter((r) => r.some((c) => c !== ''));
      blocks.push({ kind: 'table', caption: lastHeading ?? title ?? source, headers, rows: populated });
      continue;
    }

    if (line.startsWith('> ')) {
      flushParagraph();
      const note = [];
      while (i < lines.length && lines[i].startsWith('> ')) {
        note.push(lines[i].slice(2));
        i += 1;
      }
      i -= 1;
      blocks.push({ kind: 'note', text: inlineText(note.join(' ')) });
      continue;
    }

    if (/^[-*]\s/.test(line)) {
      flushParagraph();
      const items = [];
      while (i < lines.length && (/^[-*]\s/.test(lines[i]) || (items.length > 0 && /^\s+\S/.test(lines[i])))) {
        if (/^[-*]\s/.test(lines[i])) items.push(lines[i].slice(2).trim());
        else items[items.length - 1] += ` ${lines[i].trim()}`;
        i += 1;
      }
      i -= 1;
      blocks.push({ kind: 'list', items: items.map(inlineText) });
      continue;
    }

    assertSupported(line, source, lineNo);
    paragraph.push(line.trim());
  }
  flushParagraph();

  return { title, blocks };
}

/** Every document, parsed, in `LEGAL_SOURCES` order. */
export function legalDocuments() {
  return LEGAL_SOURCES.map((entry) => {
    const text = readFileSync(path.join(ROOT, entry.source), 'utf8');
    const { title, blocks } = parseLegalDocument(text, entry.source);
    return { ...entry, title: title ?? entry.label, blocks };
  });
}

/**
 * The two outbound destinations, read out of the documents that already state them
 * rather than typed here: README.md's "Play it" link is the deployed site, and
 * PRIVACY.md's Contact section is where the policy itself sends a question. Both throw
 * when the line they read moves, which is the point -- a link that silently became
 * `undefined` is the drift this whole generator exists to prevent.
 */
export function legalLinks() {
  const find = (file, pattern, what) => {
    const match = pattern.exec(readFileSync(path.join(ROOT, file), 'utf8'));
    if (!match) throw new Error(`could not find ${what} in ${file} -- update the pattern in tools/legal/parse.mjs`);
    return { label: inlineText(match[1]), url: match[2] };
  };
  const site = find('README.md', /\[(Play it)\]\((https?:\/\/[^)]+)\)/, 'the "Play it" link');
  const contact = find('PRIVACY.md', /\[([^\]]*GitHub repository)\]\((https?:\/\/[^)]+)\)/, 'the Contact link');
  return [
    { id: 'site', label: 'Project website', url: site.url },
    { id: 'contact', label: contact.label, url: contact.url },
  ];
}
