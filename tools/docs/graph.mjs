import path from 'node:path';
import {
  collectDocumentPaths,
  parseDocumentMetadata,
  readDocumentPrefix,
} from './metadata.mjs';

function diagnostic(file, message, line = 1) {
  return { file, line, message };
}

function readGraph(root) {
  const documents = new Map();
  for (const file of collectDocumentPaths(root)) {
    const parsed = parseDocumentMetadata(readDocumentPrefix(path.join(root, file)), file);
    if (parsed.metadata !== null) documents.set(file, parsed.metadata);
  }
  return documents;
}

function edges(metadata, field) {
  const values = metadata[field];
  return Array.isArray(values) ? values.filter((value) => typeof value === 'string') : [];
}

/**
 * Graph-level supersession invariants the per-file validator cannot prove: both ends of
 * every link must be classified, reciprocal, and the supersedes relation must be acyclic.
 */
export function validateDocumentGraph(root) {
  const documents = readGraph(root);
  const diagnostics = [];
  let links = 0;

  for (const [file, metadata] of documents) {
    for (const target of edges(metadata, 'supersedes')) {
      links += 1;
      const other = documents.get(target);
      if (!other) {
        diagnostics.push(
          diagnostic(file, `\`supersedes\` target \`${target}\` has no metadata; classify it first`),
        );
        continue;
      }
      if (!edges(other, 'superseded-by').includes(file)) {
        diagnostics.push(
          diagnostic(file, `\`supersedes\` \`${target}\`, which does not record \`superseded-by\` \`${file}\``),
        );
      }
    }
    for (const target of edges(metadata, 'superseded-by')) {
      const other = documents.get(target);
      if (!other) {
        diagnostics.push(
          diagnostic(file, `\`superseded-by\` target \`${target}\` has no metadata; classify it first`),
        );
        continue;
      }
      if (!edges(other, 'supersedes').includes(file)) {
        diagnostics.push(
          diagnostic(file, `\`superseded-by\` \`${target}\`, which does not record \`supersedes\` \`${file}\``),
        );
      }
    }
  }

  const visiting = new Set();
  const done = new Set();
  const visit = (file, trail) => {
    if (done.has(file)) return;
    if (visiting.has(file)) {
      diagnostics.push(
        diagnostic(file, `supersession cycle: ${[...trail, file].join(' -> ')}`),
      );
      return;
    }
    visiting.add(file);
    const metadata = documents.get(file);
    if (metadata) {
      for (const target of edges(metadata, 'supersedes')) visit(target, [...trail, file]);
    }
    visiting.delete(file);
    done.add(file);
  };
  for (const file of documents.keys()) visit(file, []);

  diagnostics.sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.message.localeCompare(b.message),
  );
  return { diagnostics, documents: documents.size, links };
}
