import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

export const RESEARCH_DIR = 'docs/research';
export const RESEARCH_INVENTORY_PATH = 'docs/research/inventory.json';
export const RESEARCH_CLASSIFICATIONS = ['public-prototype', 'commercial-direction', 'mixed'];

const LINE_FIELD_LIMIT = 200;
const TAG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function diagnostic(file, message, line = 1) {
  return { file, line, message };
}

function repoPath(value) {
  return value.split(path.sep).join('/');
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function collectResearchDocuments(root, relativeDir, output) {
  const absoluteDir = path.join(root, relativeDir);
  if (!existsSync(absoluteDir)) return;
  for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
    const relative = repoPath(path.join(relativeDir, entry.name));
    if (entry.isDirectory()) collectResearchDocuments(root, relative, output);
    else if (entry.isFile() && entry.name.endsWith('.md')) output.push(relative);
  }
}

export function collectResearchPaths(root) {
  const paths = [];
  collectResearchDocuments(root, RESEARCH_DIR, paths);
  return paths.sort();
}

function validateBoundedLine(value, field, file, diagnostics) {
  if (typeof value !== 'string' || !value.trim()) {
    diagnostics.push(diagnostic(file, `inventory entry requires a non-empty \`${field}\``));
    return;
  }
  if ([...value].length > LINE_FIELD_LIMIT) {
    diagnostics.push(
      diagnostic(file, `\`${field}\` must be ${LINE_FIELD_LIMIT} characters or fewer`),
    );
  }
}

function validateNumberArray(values, field, file, diagnostics) {
  if (!Array.isArray(values)) {
    diagnostics.push(diagnostic(file, `\`${field}\` must be an array of positive integers`));
    return;
  }
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

function validateRelatedDocs(values, file, root, diagnostics) {
  if (!Array.isArray(values)) {
    diagnostics.push(diagnostic(file, '`related-docs` must be an array of repository doc paths'));
    return;
  }
  const seen = new Set();
  for (const value of values) {
    if (typeof value !== 'string' || !value.startsWith('docs/') || value.includes('\\')) {
      diagnostics.push(
        diagnostic(file, '`related-docs` values must be repository-relative `docs/` paths'),
      );
      continue;
    }
    if (seen.has(value)) {
      diagnostics.push(diagnostic(file, `\`related-docs\` contains duplicate path \`${value}\``));
    }
    if (!existsSync(path.join(root, value))) {
      diagnostics.push(diagnostic(file, `\`related-docs\` target does not exist: \`${value}\``));
    }
    seen.add(value);
  }
}

function validateTags(values, file, diagnostics) {
  if (!Array.isArray(values) || values.length === 0) {
    diagnostics.push(diagnostic(file, 'inventory entry requires at least one `tags` value'));
    return;
  }
  const seen = new Set();
  for (const value of values) {
    if (typeof value !== 'string' || !TAG_PATTERN.test(value)) {
      diagnostics.push(diagnostic(file, '`tags` values must be lowercase kebab-case'));
      continue;
    }
    if (seen.has(value)) {
      diagnostics.push(diagnostic(file, `\`tags\` contains duplicate value \`${value}\``));
    }
    seen.add(value);
  }
}

function validateEntry(entry, root, diagnostics) {
  const file = RESEARCH_INVENTORY_PATH;
  const label = typeof entry.path === 'string' ? entry.path : '<entry>';
  const scoped = (message) => diagnostic(file, `${label}: ${message.message ?? message}`, 1);
  const local = [];

  validateBoundedLine(entry.scope, 'scope', file, local);
  validateBoundedLine(entry.relevance, 'relevance', file, local);
  validateTags(entry.tags, file, local);
  validateNumberArray(entry['related-issues'] ?? [], 'related-issues', file, local);
  validateNumberArray(entry['related-prs'] ?? [], 'related-prs', file, local);
  validateRelatedDocs(entry['related-docs'] ?? [], file, root, local);

  if (!RESEARCH_CLASSIFICATIONS.includes(entry.classification)) {
    local.push(
      diagnostic(
        file,
        `\`classification\` must be one of: ${RESEARCH_CLASSIFICATIONS.join(', ')}`,
      ),
    );
  }
  if (!validDate(entry.date)) local.push(diagnostic(file, '`date` must be YYYY-MM-DD'));
  const reviewed = entry['last-reviewed'];
  if (reviewed !== undefined && !validDate(reviewed)) {
    local.push(diagnostic(file, '`last-reviewed` must be YYYY-MM-DD'));
  }
  if (validDate(entry.date) && validDate(reviewed) && reviewed < entry.date) {
    local.push(diagnostic(file, '`last-reviewed` must not be earlier than `date`'));
  }

  for (const item of local) diagnostics.push(scoped(item));
}

export function validateResearchInventory(root) {
  const documents = collectResearchPaths(root);
  const inventoryFile = path.join(root, RESEARCH_INVENTORY_PATH);
  const diagnostics = [];

  if (documents.length === 0 && !existsSync(inventoryFile)) {
    return { diagnostics, documents: 0, entries: 0 };
  }
  if (!existsSync(inventoryFile)) {
    diagnostics.push(
      diagnostic(RESEARCH_INVENTORY_PATH, 'research inventory is missing while research documents exist'),
    );
    return { diagnostics, documents: documents.length, entries: 0 };
  }

  let inventory;
  try {
    inventory = JSON.parse(readFileSync(inventoryFile, 'utf8'));
  } catch {
    diagnostics.push(diagnostic(RESEARCH_INVENTORY_PATH, 'research inventory is invalid JSON'));
    return { diagnostics, documents: documents.length, entries: 0 };
  }

  if (inventory?.version !== 1) {
    diagnostics.push(diagnostic(RESEARCH_INVENTORY_PATH, '`version` must equal 1'));
  }
  const entries = Array.isArray(inventory?.documents) ? inventory.documents : null;
  if (!entries) {
    diagnostics.push(diagnostic(RESEARCH_INVENTORY_PATH, '`documents` must be an array'));
    return { diagnostics, documents: documents.length, entries: 0 };
  }

  const paths = entries.map((entry) => entry?.path);
  const seen = new Set();
  for (const value of paths) {
    if (typeof value !== 'string') {
      diagnostics.push(diagnostic(RESEARCH_INVENTORY_PATH, 'every inventory entry requires a `path`'));
      continue;
    }
    if (seen.has(value)) {
      diagnostics.push(
        diagnostic(RESEARCH_INVENTORY_PATH, `duplicate inventory entry for \`${value}\``),
      );
    }
    seen.add(value);
  }

  const known = new Set(documents);
  for (const value of seen) {
    if (!known.has(value)) {
      diagnostics.push(
        diagnostic(
          RESEARCH_INVENTORY_PATH,
          `inventory entry has no research document: \`${value}\``,
        ),
      );
    }
  }
  for (const document of documents) {
    if (!seen.has(document)) {
      diagnostics.push(
        diagnostic(
          RESEARCH_INVENTORY_PATH,
          `research document missing from the inventory: \`${document}\``,
        ),
      );
    }
  }

  const sorted = [...paths].every(
    (value, index) => index === 0 || typeof value !== 'string' || typeof paths[index - 1] !== 'string' || paths[index - 1] <= value,
  );
  if (!sorted) {
    diagnostics.push(diagnostic(RESEARCH_INVENTORY_PATH, 'inventory entries must be sorted by `path`'));
  }

  for (const entry of entries) {
    if (entry && typeof entry === 'object') validateEntry(entry, root, diagnostics);
  }

  diagnostics.sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.message.localeCompare(b.message),
  );
  return { diagnostics, documents: documents.length, entries: entries.length };
}
