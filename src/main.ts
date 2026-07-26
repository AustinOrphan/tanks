import { bootCanvas } from './render/canvas';
import { startGame } from './game/loop';

const root = document.getElementById('app')!;

// A WebGLRenderer constructed without WebGL support throws out of the module's
// top-level evaluation, leaving the visitor staring at the page background with
// the reason visible only in devtools -- indistinguishable from a broken
// deploy. Say so on the page instead.
try {
  const game = startGame(bootCanvas(root), root);
  // startGame's teardown was unreachable: nothing ever called it, so the RAF,
  // the window listeners and the GL context outlived the page.
  window.addEventListener('pagehide', () => game.dispose(), { once: true });
} catch (err) {
  root.innerHTML = '';
  const msg = document.createElement('div');
  msg.style.cssText =
    'display:flex;align-items:center;justify-content:center;height:100%;' +
    'padding:2rem;color:#d8dde6;font:16px/1.6 system-ui,sans-serif;text-align:center';
  msg.textContent =
    'This game needs WebGL, which this browser is not providing. ' +
    'Try another browser, or enable hardware acceleration in its settings.';
  root.appendChild(msg);
  console.error('Tanks! failed to start:', err);
}
