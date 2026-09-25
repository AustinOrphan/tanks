/**
 * Saving a canvas frame as a PNG (issue #731).
 *
 * ITS OWN MODULE so that wiring can bind it without importing the gallery workbench
 * (issue #946). `loop.ts` needs this one ten-line helper to fill `galleryWorkbench.saveStill`,
 * and taking it from `gallery-workbench.ts` put that whole pane -- and, through it,
 * `gallery-command.ts` and `gallery-selection.ts` -- into the graph every ordinary page load
 * walks. Nothing here imports anything, so this file is a leaf and stays eager for free.
 */

/**
 * Saves `canvas`'s current pixels as a PNG named `fileName`.
 *
 * The button is pressed after the drawn frame has been presented. That returns the picture only
 * because the workbench's renderer is created with `preserveDrawingBuffer: true`
 * (`render/gallery/workbench-scene.ts`'s `createWorkbenchRenderer`). Without it the buffer is
 * cleared once the frame is presented, and this would save a blank image; tools/gl/harness.ts's
 * still check fails with that setting off.
 */
export function downloadCanvasStill(canvas: HTMLCanvasElement, fileName: string): void {
  canvas.toBlob((blob) => {
    if (blob === null) return;
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }, 'image/png');
}
