// @vitest-environment jsdom
//
// createTankPreview builds a real WebGLRenderer, which jsdom cannot provide -- so this
// file can only exercise the ONE branch that does not need a working GL context: the
// fail-soft guard around construction. Everything else (the mesh it builds, the skin it
// applies, dispose behaviour, camera framing) needs a real context and lives in
// tools/gl/harness.ts instead, run with `npm run test:gl`.
import { describe, it, expect } from 'vitest';
import { createTankPreview } from './preview';

describe('createTankPreview: fails soft when no WebGL context is available', () => {
  it('returns null instead of throwing', () => {
    // jsdom implements no WebGL context at all -- canvas.getContext('webgl') and
    // ('webgl2') both return null here, which is exactly the condition
    // THREE.WebGLRenderer's constructor throws on ("Error creating WebGL context").
    // That is a REAL, unmocked exercise of the same catch branch a browser takes when
    // it has run out of contexts to hand out -- not a simulation of it.
    const canvas = document.createElement('canvas');
    expect(canvas.getContext('webgl2')).toBeNull();
    expect(canvas.getContext('webgl')).toBeNull();

    let result: ReturnType<typeof createTankPreview> | 'threw' = 'threw';
    try {
      result = createTankPreview(canvas);
    } catch {
      result = 'threw';
    }
    // The assertion that can fail: removing the try/catch around `new
    // THREE.WebGLRenderer` in preview.ts makes this throw instead of returning null,
    // which this catches and reports as 'threw' rather than null.
    expect(result).toBeNull();
  });
});
