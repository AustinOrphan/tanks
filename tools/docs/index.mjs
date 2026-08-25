#!/usr/bin/env node
/**
 * Generates docs/README.md -- the one documentation index issue #266 asks for -- from the
 * metadata the corpus already carries: the frontmatter contract in
 * docs/agent/document-metadata.md (#263) for plans, specifications, and backlog topics, and
 * docs/research/inventory.json for research notes.
 *
 *   npm run docs:index
 *
 * Nothing here is hand-written except the static prose in this file. `npm run docs:check`
 * and tools/docs/index.test.ts both regenerate the string and fail when the committed file
 * disagrees, so the fix for a red drift check is to run the command above -- never to edit
 * docs/README.md or to relax the guard.
 *
 * Deliberate non-goals, so the index stays an index:
 * - Backlog topics are COUNTED here and enumerated in docs/superpowers/backlog.md, which
 *   tools/backlog.test.ts already gates for completeness. Listing them twice would give one
 *   fact two independently-guarded homes, and they would drift.
 * - No document is moved, renamed, or archived. Status placement is derived, not imposed.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectDocumentPaths, parseDocumentMetadata } from './metadata.mjs';
import { RESEARCH_INVENTORY_PATH } from './research.mjs';

export const INDEX_PATH = 'docs/README.md';
const INDEX_DIR = 'docs/';
const BACKLOG_DIR = 'docs/superpowers/backlog/';
const BACKLOG_INDEX = 'docs/superpowers/backlog.md';

/** Statuses that mean "read this as current direction". */
const CURRENT_STATUSES = ['proposed', 'active'];
/** Statuses that mean "read this as history". */
const HISTORICAL_STATUSES = ['superseded', 'historical'];

function splitFrontmatter(text) {
  const normalized = text.replaceAll('\r\n', '\n');
  if (!normalized.startsWith('---\n')) return { front: normalized, body: normalized };
  const close = normalized.indexOf('\n---\n', 3);
  if (close < 0) return { front: normalized, body: '' };
  return { front: normalized.slice(0, close + 5), body: normalized.slice(close + 5) };
}

function firstHeading(body) {
  const match = /^#\s+(.+?)\s*$/m.exec(body);
  return match ? match[1] : null;
}

/** Link target relative to docs/README.md, which sits one level above the corpus. */
function relativeLink(repoPath) {
  return repoPath.startsWith(INDEX_DIR) ? repoPath.slice(INDEX_DIR.length) : `../${repoPath}`;
}

/** Escape the pipe and backslash that would otherwise break a Markdown table row. */
function cell(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function numberList(singular, values) {
  if (!values || values.length === 0) return '';
  const label = values.length === 1 ? singular : `${singular}s`;
  return `${label} ${values.map((value) => `#${value}`).join(', ')}`;
}

export function readIndexDocument(root, relative) {
  const text = readFileSync(path.join(root, relative), 'utf8');
  const { body } = splitFrontmatter(text);
  const { metadata } = parseDocumentMetadata(text, relative);
  const fields = metadata ?? {};
  return {
    path: relative,
    status: typeof fields.status === 'string' ? fields.status : null,
    scope: typeof fields.scope === 'string' ? fields.scope : '',
    title: firstHeading(body) ?? path.basename(relative, '.md'),
    issues: Array.isArray(fields['implementation-issues']) ? fields['implementation-issues'] : [],
    prs: Array.isArray(fields['implementation-prs']) ? fields['implementation-prs'] : [],
    supersededBy: Array.isArray(fields['superseded-by']) ? fields['superseded-by'] : [],
    supersedes: Array.isArray(fields.supersedes) ? fields.supersedes : [],
  };
}

export function collectIndexModel(root) {
  const documents = collectDocumentPaths(root).map((relative) => readIndexDocument(root, relative));
  const backlog = documents.filter((entry) => entry.path.startsWith(BACKLOG_DIR));
  const rest = documents.filter((entry) => !entry.path.startsWith(BACKLOG_DIR));

  const inventoryPath = path.join(root, RESEARCH_INVENTORY_PATH);
  let research = [];
  if (existsSync(inventoryPath)) {
    const parsed = JSON.parse(readFileSync(inventoryPath, 'utf8'));
    research = Array.isArray(parsed?.documents) ? [...parsed.documents] : [];
    research.sort((a, b) => String(a?.path).localeCompare(String(b?.path)));
  }

  const statusTally = new Map();
  for (const entry of backlog) {
    const key = entry.status ?? 'unclassified';
    statusTally.set(key, (statusTally.get(key) ?? 0) + 1);
  }

  return {
    current: rest.filter((entry) => CURRENT_STATUSES.includes(entry.status)),
    completed: rest.filter((entry) => entry.status === 'completed'),
    historical: rest.filter((entry) => HISTORICAL_STATUSES.includes(entry.status)),
    unclassified: rest.filter((entry) => entry.status === null),
    backlog,
    backlogStatuses: [...statusTally.entries()].sort((a, b) => a[0].localeCompare(b[0])),
    research,
    total: documents.length + research.length,
  };
}

function link(entry) {
  return `[${cell(entry.title)}](${relativeLink(entry.path)})`;
}

function implementsCell(entry) {
  const parts = [numberList('issue', entry.issues), numberList('PR', entry.prs)].filter(Boolean);
  return parts.length > 0 ? parts.join('; ') : '--';
}

function table(header, rows) {
  if (rows.length === 0) return [];
  return [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ];
}

function pluralDocuments(count) {
  return count === 1 ? '1 document' : `${count} documents`;
}

export function renderDocumentIndex(root) {
  const model = collectIndexModel(root);
  const lines = [];

  lines.push('# Documentation index');
  lines.push('');
  lines.push(
    '<!-- GENERATED by tools/docs/index.mjs from document metadata. Run `npm run docs:index`',
    '     to regenerate; do not edit this file by hand. -->',
  );
  lines.push('');
  lines.push(
    `This is the entry point for the ${model.total} plans, specifications, backlog topics, and`,
    'research notes in this repository.',
    'Read this file whole; read the documents it lists one at a time.',
    'Nothing here is imported into a session\'s startup context.',
  );
  lines.push('');
  lines.push(
    'Placement is derived, not asserted: every row below comes from the `status` field the',
    'document declares under `docs/agent/document-metadata.md`, or from',
    '`docs/research/inventory.json` for research. Issue and pull-request numbers refer to this',
    'repository.',
  );
  lines.push('');

  lines.push('## Where documentation belongs');
  lines.push('');
  lines.push(
    ...table(
      ['Material', 'Home', 'Lifecycle'],
      [
        [
          'Durable product or design direction',
          '`docs/superpowers/specs/`',
          '`active` while authoritative; `superseded` when a later specification replaces it',
        ],
        [
          'Durable implementation rationale, measurements, and landmines',
          '`docs/agent/architecture.md` and its siblings',
          'edited in place; no status field',
        ],
        [
          'The plan for one change',
          '`docs/superpowers/plans/`',
          '`completed` once its pull request lands; kept as an implementation record',
        ],
        [
          'An open question needing a decision or measurement first',
          '`docs/superpowers/backlog/`',
          'deleted or narrowed by the pull request that answers it',
        ],
        [
          'External or feasibility research',
          '`docs/research/`',
          'one inventory entry per document',
        ],
        [
          'Operating instructions for contributors and agents',
          '`CLAUDE.md`, `.claude/rules/`, `docs/agent/`',
          'loaded by scope, never from this index',
        ],
      ],
    ),
  );
  lines.push('');
  lines.push(
    'A **durable decision** belongs in a specification when it sets product or design direction,',
    'and in `docs/agent/architecture.md` when it is implementation rationale that outlives any',
    'one change. A **temporary plan** records how a single change was carried out and stops being',
    'authoritative the moment it ships: read a `completed` plan as history, not as direction.',
    'There is no separate decision-record directory -- the `status` field and the supersession',
    'graph carry that role, and `npm run docs:check` validates both.',
  );
  lines.push('');

  lines.push('## Current direction');
  lines.push('');
  if (model.current.length === 0) {
    lines.push('No plan or specification is currently `proposed` or `active`.');
  } else {
    lines.push(
      `${pluralDocuments(model.current.length)} carry a \`proposed\` or \`active\` status.`,
      'These are the only plans and specifications that state current direction.',
    );
    lines.push('');
    lines.push(
      ...table(
        ['Document', 'Status', 'Scope', 'Implements'],
        model.current.map((entry) => [
          link(entry),
          `\`${entry.status}\``,
          cell(entry.scope),
          implementsCell(entry),
        ]),
      ),
    );
  }
  lines.push('');

  lines.push('## Backlog topics');
  lines.push('');
  const backlogSummary = model.backlogStatuses
    .map(([status, count]) => `${count} \`${status}\``)
    .join(', ');
  lines.push(
    `${pluralDocuments(model.backlog.length)} under \`docs/superpowers/backlog/\`` +
      (backlogSummary ? ` (${backlogSummary})` : '') +
      '.',
    'A topic is present only while its question is open.',
    `They are enumerated in [the backlog index](${relativeLink(BACKLOG_INDEX)}), which`,
    '`tools/backlog.test.ts` gates for completeness; this index counts them rather than listing',
    'them a second time.',
  );
  lines.push('');

  lines.push('## Research');
  lines.push('');
  if (model.research.length === 0) {
    lines.push('No research documents are recorded.');
  } else {
    lines.push(
      `${pluralDocuments(model.research.length)} under \`docs/research/\`.`,
      'Research is recorded in `docs/research/inventory.json` rather than in frontmatter, and',
      '`classification` places a note against the Public Prototype 1.0 boundary; it is not a',
      'status.',
    );
    lines.push('');
    lines.push(
      ...table(
        ['Document', 'Classification', 'Scope'],
        model.research.map((entry) => [
          `[${cell(path.basename(String(entry.path)))}](${relativeLink(String(entry.path))})`,
          `\`${cell(entry.classification ?? 'unclassified')}\``,
          cell(entry.scope ?? ''),
        ]),
      ),
    );
  }
  lines.push('');

  lines.push('## Implementation record');
  lines.push('');
  if (model.completed.length === 0) {
    lines.push('No plan or specification is `completed`.');
  } else {
    lines.push(
      `${pluralDocuments(model.completed.length)} are \`completed\`.`,
      'A completed document records how one change was made; it is not current direction.',
      'Scope lines are omitted here to keep the index short -- open the document, or find it',
      'through the issue or pull request that closed it.',
    );
    lines.push('');
    lines.push(
      ...table(
        ['Document', 'Implements'],
        model.completed.map((entry) => [link(entry), implementsCell(entry)]),
      ),
    );
  }
  lines.push('');

  lines.push('## Superseded and historical');
  lines.push('');
  if (model.historical.length === 0) {
    lines.push('No plan or specification is `superseded` or `historical`.');
  } else {
    lines.push(
      `${pluralDocuments(model.historical.length)} are no longer authoritative.`,
      'Follow the replacement before acting on anything they say.',
    );
    lines.push('');
    lines.push(
      ...table(
        ['Document', 'Status', 'Replaced by', 'Implements'],
        model.historical.map((entry) => [
          link(entry),
          `\`${entry.status}\``,
          entry.supersededBy.length > 0
            ? entry.supersededBy
                .map((target) => `[${cell(path.basename(String(target)))}](${relativeLink(String(target))})`)
                .join(', ')
            : '--',
          implementsCell(entry),
        ]),
      ),
    );
  }
  lines.push('');

  if (model.unclassified.length > 0) {
    lines.push('## Unclassified');
    lines.push('');
    lines.push(
      `${pluralDocuments(model.unclassified.length)} carry no metadata header.`,
      'They are accepted only while unchanged, through',
      '`tools/docs/legacy-document-baseline.json`; changing one requires adding a valid header.',
    );
    lines.push('');
    lines.push(
      ...table(
        ['Document'],
        model.unclassified.map((entry) => [link(entry)]),
      ),
    );
    lines.push('');
  }

  lines.push('## Agent reference material');
  lines.push('');
  lines.push(
    'Detailed rationale for the code itself -- architecture, commands, testing policy, known',
    'holes -- is routed from',
    `[\`docs/agent/README.md\`](${relativeLink('docs/agent/README.md')}), which is already their`,
    'index. Those files are normal Markdown links and are never imported into startup context.',
  );
  lines.push('');

  return `${lines.join('\n')}`.replace(/\n+$/, '\n');
}

export function validateDocumentIndex(root) {
  const absolute = path.join(root, INDEX_PATH);
  if (!existsSync(absolute)) {
    return {
      diagnostics: [
        { file: INDEX_PATH, line: 1, message: 'generated index is missing; run `npm run docs:index`' },
      ],
    };
  }
  const committed = readFileSync(absolute, 'utf8');
  const generated = renderDocumentIndex(root);
  if (committed !== generated) {
    return {
      diagnostics: [
        {
          file: INDEX_PATH,
          line: 1,
          message: 'generated index is out of date; run `npm run docs:index`',
        },
      ],
    };
  }
  return { diagnostics: [] };
}

export function write(root = process.cwd(), io = console) {
  const absolute = path.join(root, INDEX_PATH);
  const next = renderDocumentIndex(root);
  writeFileSync(absolute, next, 'utf8');
  // Read back what was actually written -- a zero exit code is not verification.
  if (readFileSync(absolute, 'utf8') !== next) {
    io.error(`wrote ${INDEX_PATH} but the read-back does not match what was generated`);
    return 1;
  }
  io.log(`Wrote ${INDEX_PATH}.`);
  return 0;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) process.exitCode = write();
