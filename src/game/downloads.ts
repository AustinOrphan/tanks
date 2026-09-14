/**
 * Saving a file from the page (issue #254's developer exports).
 *
 * Browser-only, and bound in `createBrowserDeps`: the HUD is handed these as
 * `developerDownloads`, so an injected HUD in a test has none and never starts a real download.
 */

/** Saves `blob` as `fileName` through a temporary object URL. */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Saves `text` as `fileName`, with MIME type `type`. */
export function downloadText(text: string, fileName: string, type: string): void {
  downloadBlob(new Blob([text], { type }), fileName);
}
