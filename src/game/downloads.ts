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

/**
 * Saves `canvas`'s pixels as a PNG named `fileName`, rejecting when the browser encodes nothing.
 *
 * For a canvas whose pixels are already a copy (the renderer's `captureFrame`), so the encoding
 * running later than this call does not matter.
 */
export function downloadCanvas(canvas: HTMLCanvasElement, fileName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob === null) {
        reject(new Error('the browser could not encode the canvas as a PNG'));
        return;
      }
      downloadBlob(blob, fileName);
      resolve();
    }, 'image/png');
  });
}
