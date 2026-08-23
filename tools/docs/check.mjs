import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatDiagnostics, validateRepositoryDocuments } from './metadata.mjs';
import { validateResearchInventory } from './research.mjs';

export function run(root = process.cwd(), io = console) {
  const research = validateResearchInventory(root);
  const documents = validateRepositoryDocuments(root);
  const diagnostics = [...research.diagnostics, ...documents.diagnostics];
  if (diagnostics.length > 0) {
    io.error(formatDiagnostics(diagnostics));
    return 1;
  }
  if (research.documents > 0) {
    io.log(`Research inventory valid: ${research.documents} documents.`);
  }
  io.log(
    `Document metadata valid: ${documents.metadataFiles} classified, ` +
      `${documents.legacyFiles} unchanged legacy, ${documents.files} total.`,
  );
  return 0;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) process.exitCode = run();
