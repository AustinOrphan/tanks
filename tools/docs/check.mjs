import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatDiagnostics, validateRepositoryDocuments } from './metadata.mjs';

export function run(root = process.cwd(), io = console) {
  const result = validateRepositoryDocuments(root);
  if (result.diagnostics.length > 0) {
    io.error(formatDiagnostics(result.diagnostics));
    return 1;
  }
  io.log(
    `Document metadata valid: ${result.metadataFiles} classified, ` +
      `${result.legacyFiles} unchanged legacy, ${result.files} total.`,
  );
  return 0;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) process.exitCode = run();
