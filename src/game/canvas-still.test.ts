// @vitest-environment jsdom
//
// `canvas-still.ts`'s one helper, moved out of `gallery-workbench.test.ts` with the function
// itself (issue #946): wiring binds it without importing the workbench pane, so the test that
// holds it should not import the pane either.
import { describe, expect, it, vi } from 'vitest';

import { downloadCanvasStill } from './canvas-still';

describe('downloadCanvasStill (issue #731)', () => {
  it('encodes the canvas as a PNG and downloads it under the given name', () => {
    const canvas = document.createElement('canvas');
    const encoded: string[] = [];
    canvas.toBlob = (cb: BlobCallback, type?: string) => {
      encoded.push(type ?? '');
      cb(new Blob(['png'], { type: 'image/png' }));
    };
    // jsdom implements neither half of the object-URL pair, so both are stood in for, and the
    // deferred revoke is run here rather than left to fire after the stand-ins are gone.
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(() => 'blob:still');
    const revoked: string[] = [];
    URL.revokeObjectURL = (url: string) => revoked.push(url);
    const clicked: { href: string; download: string }[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ href: this.href, download: this.download });
    });
    vi.useFakeTimers();
    let revokedBeforeTimers: string[] = [];
    try {
      downloadCanvasStill(canvas, 'gallery-fire-frame10-640x400@1x.png');
      revokedBeforeTimers = [...revoked];
      vi.runAllTimers();
    } finally {
      vi.useRealTimers();
      click.mockRestore();
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    }
    expect(encoded).toEqual(['image/png']);
    expect(clicked).toEqual([{ href: 'blob:still', download: 'gallery-fire-frame10-640x400@1x.png' }]);
    // Released, but only after the click: revoking first would cancel the download it names.
    expect([revokedBeforeTimers, revoked]).toEqual([[], ['blob:still']]);
  });
});
