// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { bootCanvas } from './canvas';

const originalW = window.innerWidth;
const originalH = window.innerHeight;

function setViewport(w: number, h: number): void {
  Object.defineProperty(window, 'innerWidth', { value: w, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: h, configurable: true });
}

afterEach(() => {
  setViewport(originalW, originalH);
});

describe('bootCanvas', () => {
  it('puts the canvas in the root it was given', () => {
    const root = document.createElement('div');
    const canvas = bootCanvas(root);
    expect(canvas.tagName).toBe('CANVAS');
    expect(canvas.parentElement).toBe(root);
  });

  it('sizes the drawing buffer to the viewport, width to width', () => {
    // Deliberately non-square, so swapping the two is detectable at all: a
    // swapped buffer renders the arena stretched and the aspect wrong.
    setViewport(1280, 800);
    const canvas = bootCanvas(document.createElement('div'));
    expect(canvas.width).toBe(1280);
    expect(canvas.height).toBe(800);
  });

  it('gives the canvas a non-zero drawing buffer', () => {
    // A 0x0 buffer draws nothing at all, and the failure looks exactly like a
    // broken renderer.
    setViewport(1024, 768);
    const canvas = bootCanvas(document.createElement('div'));
    expect(canvas.width).toBeGreaterThan(0);
    expect(canvas.height).toBeGreaterThan(0);
  });

  it('stretches to fill its container via CSS, independent of the buffer size', () => {
    // The CSS size and the drawing-buffer size are different things; the
    // renderer sets pixel ratio from the latter.
    const canvas = bootCanvas(document.createElement('div'));
    expect(canvas.style.width).toBe('100%');
    expect(canvas.style.height).toBe('100%');
    expect(canvas.style.display).toBe('block');
  });
});
