import * as THREE from 'three';
import type { World } from '../sim/world';
import { MINE_PROXIMITY_RADIUS, MINE_BLAST_RADIUS, TANK_RADIUS } from '../sim/constants';

/**
 * Dev-only overlay: what a mine actually threatens, and how long you have.
 *
 * A mine is a puck of radius 0.28 that kills at 2.5 -- it shows about one part in eighty
 * of the ground it covers. That is a design choice (a mine you can read perfectly is a
 * much weaker weapon), not an oversight, so this stays behind a flag rather than shipping.
 * It exists so the radii can be PLAYTESTED: whether 1.5 and 2.5 are the right numbers is
 * not a question you can answer while both circles are invisible.
 *
 * Two rings, because a mine has two distinct radii and confusing them is the whole
 * problem: the inner one is where walking sets it off, the outer is where it kills. The
 * gap between them is the counter-intuitive part -- you can trigger a mine from well
 * inside its lethal range and still be standing in it when it goes.
 *
 * Both rings mark TANK-CENTRE thresholds, and both are exact: bisected through the real
 * step() (2026-07-31), the trigger fires at centre distance 1.500000 and the blast
 * kills at 2.500000 -- the drawn radii to six decimals. Read them as "where my tank's
 * CENTRE may go": a hull merely touching a ring is still ~half a hull safe. (The sim
 * treats a tank as a point for triggering and as a TANK_RADIUS circle for the blast;
 * the constants below bake that so the rings stay honest either way.)
 */
export interface MineDebug {
  /** Redraw for this frame's world. Cheap to call when disabled. */
  sync(world: World): void;
  dispose(): void;
}

export interface MineDebugOptions {
  /** Draw the proximity-trigger and kill-radius rings. */
  reach: boolean;
  /** Draw the remaining fuse, in seconds, beside each mine. */
  timer: boolean;
}

/** Where a mine kills: the blast plus the hull of whatever is standing there. */
export const MINE_KILL_RADIUS = MINE_BLAST_RADIUS + TANK_RADIUS;

/** Just off the felt, so the rings do not z-fight the ground plane. */
const RING_Y = 0.03;
const LABEL_Y = 1.05; // clear of the proximity ring, which it otherwise sits on

const PROXIMITY_COLOR = 0xffc857;
const KILL_COLOR = 0xff4444;

function makeRing(radius: number, color: number): THREE.Mesh {
  // Thickness scales with radius so both rings read as the same weight of line.
  const w = Math.max(0.03, radius * 0.02);
  const mesh = new THREE.Mesh(
    new THREE.RingGeometry(radius - w, radius, 64),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.8,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  mesh.rotation.x = -Math.PI / 2;
  return mesh;
}

/** A number drawn to a canvas and hung above the mine; the sprite billboards it. */
function makeLabel(): { sprite: THREE.Sprite; draw: (text: string) => void } {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false }),
  );
  sprite.scale.set(1.2, 0.6, 1);
  function draw(text: string): void {
    // jsdom provides no 2D context. The sprite still exists and is still positioned, so
    // the wiring stays testable; only the glyphs are missing.
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = 'bold 44px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.strokeText(text, 64, 32);
    ctx.fillStyle = '#ffe066';
    ctx.fillText(text, 64, 32);
    texture.needsUpdate = true;
  }
  return { sprite, draw };
}

export function createMineDebug(scene: THREE.Scene, options: MineDebugOptions): MineDebug {
  interface View {
    group: THREE.Group;
    label: { sprite: THREE.Sprite; draw: (text: string) => void } | null;
  }
  const views = new Map<number, View>();
  const enabled = options.reach || options.timer;

  function make(): View {
    const group = new THREE.Group();
    if (options.reach) {
      group.add(makeRing(MINE_PROXIMITY_RADIUS, PROXIMITY_COLOR));
      group.add(makeRing(MINE_KILL_RADIUS, KILL_COLOR));
    }
    let label: View['label'] = null;
    if (options.timer) {
      label = makeLabel();
      label.sprite.position.y = LABEL_Y;
      group.add(label.sprite);
    }
    scene.add(group);
    return { group, label };
  }

  function drop(id: number, view: View): void {
    scene.remove(view.group);
    view.group.traverse((o) => {
      const m = o as THREE.Mesh & { material?: THREE.Material; geometry?: THREE.BufferGeometry };
      m.geometry?.dispose();
      const mat = m.material as (THREE.Material & { map?: THREE.Texture }) | undefined;
      mat?.map?.dispose();
      mat?.dispose();
    });
    views.delete(id);
  }

  function sync(world: World): void {
    if (!enabled) return;
    const seen = new Set<number>();
    for (const m of world.mines) {
      // A detonated mine is already off the board; its rings must go too, or the overlay
      // keeps drawing a threat that no longer exists.
      if (m.detonated) continue;
      seen.add(m.id);
      let view = views.get(m.id);
      if (!view) {
        view = make();
        views.set(m.id, view);
      }
      view.group.position.set(m.pos.x, RING_Y, m.pos.y);
      // Never negative on screen: the sim can carry the timer a hair past zero within the
      // tick that detonates it.
      view.label?.draw(Math.max(0, m.timer).toFixed(2));
    }
    for (const [id, view] of [...views]) {
      if (!seen.has(id)) drop(id, view);
    }
  }

  function dispose(): void {
    for (const [id, view] of [...views]) drop(id, view);
    views.clear();
  }

  return { sync, dispose };
}
