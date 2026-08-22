import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
} from 'node:fs';
import path from 'node:path';

export const DOCUMENT_DIRS = [
  'docs/superpowers/plans',
  'docs/superpowers/specs',
];
export const DOCUMENT_STATUSES = [
  'proposed',
  'active',
  'completed',
  'superseded',
  'historical',
];
export const FRONTMATTER_BYTE_LIMIT = 4096;
export const LEGACY_BASELINE_PATH = 'tools/docs/legacy-document-baseline.json';

const SCALAR_FIELDS = new Set(['status', 'date', 'last-reviewed', 'scope']);
const ARRAY_FIELDS = new Set([
  'implementation-issues',
  'implementation-prs',
  'supersedes',
  'superseded-by',
]);
const ALLOWED_FIELDS = new Set([...SCALAR_FIELDS, ...ARRAY_FIELDS]);

function diagnostic(file, message, line = 1) {
  return { file, line, message };
}

function repoPath(value) {
  return value.split(path.sep).join('/');
}

function isDocumentPath(value) {
  return DOCUMENT_DIRS.some((dir) => value.startsWith(`${dir}/`)) && value.endsWith('.md');
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function parseScalar(raw, field, file, line, diagnostics) {
  const value = raw.trim();
  if (!value) {
    diagnostics.push(diagnostic(file, `\`${field}\` must not be empty`, line));
    return '';
  }
  if (!value.startsWith('"')) return value;
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed !== 'string') throw new TypeError('not a string');
    return parsed;
  } catch {
    diagnostics.push(diagnostic(file, `\`${field}\` must be plain text or a valid JSON string`, line));
    return '';
  }
}

function parseArray(raw, field, file, line, diagnostics) {
  try {
    const value = JSON.parse(raw);
    if (!Array.isArray(value)) throw new TypeError('not an array');
    return value;
  } catch {
    diagnostics.push(
      diagnostic(file, `\`${field}\` must be an inline JSON-compatible YAML array`, line),
    );
    return [];
  }
}

/**
 * Parse only the bounded prefix supplied by readDocumentPrefix. This deliberately accepts
 * a strict YAML subset: one top-level key per line and inline JSON-compatible arrays.
 */
export function parseDocumentMetadata(prefix, file = '<document>') {
  const text = prefix.replaceAll('\r\n', '\n');
  if (!text.startsWith('---\n')) return { metadata: null, diagnostics: [] };

  const lines = text.split('\n');
  const end = lines.indexOf('---', 1);
  if (end < 0) {
    return {
      metadata: {},
      diagnostics: [
        diagnostic(
          file,
          `metadata frontmatter must close within ${FRONTMATTER_BYTE_LIMIT} bytes`,
        ),
      ],
    };
  }

  const frontmatterBytes = Buffer.byteLength(lines.slice(0, end + 1).join('\n'), 'utf8');
  const diagnostics = [];
  if (frontmatterBytes > FRONTMATTER_BYTE_LIMIT) {
    diagnostics.push(
      diagnostic(file, `metadata frontmatter exceeds ${FRONTMATTER_BYTE_LIMIT} bytes`),
    );
  }

  const metadata = {};
  for (let index = 1; index < end; index += 1) {
    const line = lines[index];
    const lineNumber = index + 1;
    if (!line.trim()) continue;
    if (/^\s/.test(line)) {
      diagnostics.push(
        diagnostic(file, 'metadata must use top-level keys and inline arrays only', lineNumber),
      );
      continue;
    }

    const match = /^([a-z][a-z-]*):\s*(.*)$/.exec(line);
    if (!match) {
      diagnostics.push(diagnostic(file, 'invalid metadata field syntax', lineNumber));
      continue;
    }
    const [, field, raw] = match;
    if (!ALLOWED_FIELDS.has(field)) {
      diagnostics.push(diagnostic(file, `unknown metadata field \`${field}\``, lineNumber));
      continue;
    }
    if (Object.hasOwn(metadata, field)) {
      diagnostics.push(diagnostic(file, `duplicate metadata field \`${field}\``, lineNumber));
      continue;
    }
    metadata[field] = ARRAY_FIELDS.has(field)
      ? parseArray(raw, field, file, lineNumber, diagnostics)
      : parseScalar(raw, field, file, lineNumber, diagnostics);
  }

  return { metadata, diagnostics };
}

function validateNumberArray(values, field, file, diagnostics) {
  const seen = new Set();
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      diagnostics.push(diagnostic(file, `\`${field}\` values must be positive integers`));
      continue;
    }
    if (seen.has(value)) {
      diagnostics.push(diagnostic(file, `\`${field}\` contains duplicate value ${value}`));
    }
    seen.add(value);
  }
}

function validatePathArray(values, field, file, knownDocuments, diagnostics) {
  const seen = new Set();
  for (const value of values) {
    if (typeof value !== 'string' || !isDocumentPath(value) || value.includes('\\')) {
      diagnostics.push(
        diagnostic(
          file,
          `\`${field}\` values must be repository-relative plan or specification paths`,
        ),
      );
      continue;
    }
    if (value === file) {
      diagnostics.push(diagnostic(file, `\`${field}\` must not reference the document itself`));
    }
    if (seen.has(value)) {
      diagnostics.push(diagnostic(file, `\`${field}\` contains duplicate path \`${value}\``));
    }
    if (knownDocuments && !knownDocuments.has(value)) {
      diagnostics.push(diagnostic(file, `\`${field}\` target does not exist: \`${value}\``));
    }
    seen.add(value);
  }
}

export function validateDocumentMetadata(metadata, file, knownDocuments = null) {
  const diagnostics = [];
  const status = metadata.status;
  if (!DOCUMENT_STATUSES.includes(status)) {
    diagnostics.push(
      diagnostic(file, `\`status\` must be one of: ${DOCUMENT_STATUSES.join(', ')}`),
    );
  }

  const date = metadata.date;
  const reviewed = metadata['last-reviewed'];
  if (!date && !reviewed) {
    diagnostics.push(diagnostic(file, 'metadata requires `date` or `last-reviewed`'));
  }
  if (date && !validDate(date)) diagnostics.push(diagnostic(file, '`date` must be YYYY-MM-DD'));
  if (reviewed && !validDate(reviewed)) {
    diagnostics.push(diagnostic(file, '`last-reviewed` must be YYYY-MM-DD'));
  }
  if (validDate(date ?? '') && validDate(reviewed ?? '') && reviewed < date) {
    diagnostics.push(diagnostic(file, '`last-reviewed` must not be earlier than `date`'));
  }

  const scope = metadata.scope;
  if (typeof scope !== 'string' || !scope.trim()) {
    diagnostics.push(diagnostic(file, 'metadata requires a non-empty `scope`'));
  } else if ([...scope].length > 200) {
    diagnostics.push(diagnostic(file, '`scope` must be 200 characters or fewer'));
  }

  const issues = metadata['implementation-issues'] ?? [];
  const prs = metadata['implementation-prs'] ?? [];
  const supersedes = metadata.supersedes ?? [];
  const supersededBy = metadata['superseded-by'] ?? [];
  validateNumberArray(issues, 'implementation-issues', file, diagnostics);
  validateNumberArray(prs, 'implementation-prs', file, diagnostics);
  validatePathArray(supersedes, 'supersedes', file, knownDocuments, diagnostics);
  validatePathArray(supersededBy, 'superseded-by', file, knownDocuments, diagnostics);

  const overlap = new Set(supersedes.filter((value) => supersededBy.includes(value)));
  for (const value of overlap) {
    diagnostics.push(
      diagnostic(file, `the same document cannot appear in both supersession fields: \`${value}\``),
    );
  }
  if (status === 'superseded' && supersededBy.length === 0) {
    diagnostics.push(diagnostic(file, '`superseded` documents require a `superseded-by` target'));
  }
  if (status && status !== 'superseded' && supersededBy.length > 0) {
    diagnostics.push(
      diagnostic(file, 'a document with `superseded-by` must have `status: superseded`'),
    );
  }

  return diagnostics;
}

function collectMarkdownFiles(root, relativeDir, output) {
  const absoluteDir = path.join(root, relativeDir);
  if (!existsSync(absoluteDir)) return;
  for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
    const relative = repoPath(path.join(relativeDir, entry.name));
    if (entry.isDirectory()) collectMarkdownFiles(root, relative, output);
    else if (entry.isFile() && entry.name.endsWith('.md')) output.push(relative);
  }
}

export function collectDocumentPaths(root) {
  const paths = [];
  for (const dir of DOCUMENT_DIRS) collectMarkdownFiles(root, dir, paths);
  return paths.sort();
}

export function readDocumentPrefix(absolutePath) {
  const descriptor = openSync(absolutePath, 'r');
  try {
    const buffer = Buffer.alloc(FRONTMATTER_BYTE_LIMIT + 1);
    const bytes = readSync(descriptor, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytes).toString('utf8');
  } finally {
    closeSync(descriptor);
  }
}

export function sha256File(absolutePath) {
  return createHash('sha256').update(readFileSync(absolutePath)).digest('hex');
}

export function readLegacyBaseline(root) {
  const file = path.join(root, LEGACY_BASELINE_PATH);
  const diagnostics = [];
  if (!existsSync(file)) {
    return {
      documents: {},
      diagnostics: [diagnostic(LEGACY_BASELINE_PATH, 'legacy document baseline is missing')],
    };
  }

  let baseline;
  try {
    baseline = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {
      documents: {},
      diagnostics: [diagnostic(LEGACY_BASELINE_PATH, 'legacy document baseline is invalid JSON')],
    };
  }

  if (baseline?.version !== 1) {
    diagnostics.push(diagnostic(LEGACY_BASELINE_PATH, '`version` must equal 1'));
  }
  if (baseline?.algorithm !== 'sha256') {
    diagnostics.push(diagnostic(LEGACY_BASELINE_PATH, '`algorithm` must equal `sha256`'));
  }
  if (!baseline?.documents || typeof baseline.documents !== 'object' || Array.isArray(baseline.documents)) {
    diagnostics.push(diagnostic(LEGACY_BASELINE_PATH, '`documents` must be an object'));
    return { documents: {}, diagnostics };
  }

  const entries = Object.entries(baseline.documents);
  if (entries.length === 0) {
    diagnostics.push(diagnostic(LEGACY_BASELINE_PATH, '`documents` must not be empty'));
  }
  for (const [document, hash] of entries) {
    if (!isDocumentPath(document)) {
      diagnostics.push(
        diagnostic(LEGACY_BASELINE_PATH, `invalid legacy document path: \`${document}\``),
      );
    }
    if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) {
      diagnostics.push(
        diagnostic(LEGACY_BASELINE_PATH, `invalid SHA-256 for \`${document}\``),
      );
    }
  }
  return { documents: baseline.documents, diagnostics };
}

export function validateRepositoryDocuments(root) {
  const files = collectDocumentPaths(root);
  const knownDocuments = new Set(files);
  const baseline = readLegacyBaseline(root);
  const diagnostics = [...baseline.diagnostics];
  let metadataFiles = 0;
  let legacyFiles = 0;

  for (const file of Object.keys(baseline.documents)) {
    if (isDocumentPath(file) && !knownDocuments.has(file)) {
      diagnostics.push(
        diagnostic(file, 'document recorded by the immutable legacy baseline is missing'),
      );
    }
  }

  for (const file of files) {
    const absolute = path.join(root, file);
    const parsed = parseDocumentMetadata(readDocumentPrefix(absolute), file);
    if (parsed.metadata !== null) {
      metadataFiles += 1;
      diagnostics.push(...parsed.diagnostics);
      diagnostics.push(...validateDocumentMetadata(parsed.metadata, file, knownDocuments));
      continue;
    }

    const expected = baseline.documents[file];
    if (!expected) {
      diagnostics.push(
        diagnostic(
          file,
          'missing document metadata; add frontmatter using `docs/agent/document-metadata.md`',
        ),
      );
      continue;
    }
    const actual = sha256File(absolute);
    if (actual !== expected) {
      diagnostics.push(
        diagnostic(
          file,
          'legacy document changed; add metadata rather than updating its baseline hash',
        ),
      );
      continue;
    }
    legacyFiles += 1;
  }

  diagnostics.sort((a, b) =>
    a.file.localeCompare(b.file) || a.line - b.line || a.message.localeCompare(b.message),
  );
  return { diagnostics, files: files.length, metadataFiles, legacyFiles };
}

export function formatDiagnostics(diagnostics) {
  return diagnostics.map(({ file, line, message }) => `${file}:${line}: ${message}`).join('\n');
}
