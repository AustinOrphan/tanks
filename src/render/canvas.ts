export function bootCanvas(root: HTMLElement): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.style.display = 'block';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  root.appendChild(canvas);
  return canvas;
}
