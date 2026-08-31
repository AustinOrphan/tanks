import * as THREE from 'three';
import type { World } from '../sim/world';
import type { Tank, Vec2 } from '../sim/types';
import { lineOfSight } from '../sim/ai/targeting';
import { TANK_RADIUS } from '../sim/constants';

/**
 * Dev-only overlay: which opponent each AI is committed to, and whether it can currently
 * SEE that opponent, is only REMEMBERING where it was, or has nothing at all.
 *
 * Issues #359 and #372 both ask for this, in their Direction sections rather than their
 * acceptance lists: "expose target ID, reason, and commitment state in developer traces"
 * (#359) and "developer traces should distinguish visible contact, remembered last-seen
 * contact, and no contact" (#372). Neither behaviour is readable on screen without it --
 * a turret that has stopped tracking looks the same whether it is holding a remembered
 * bearing, sweeping a search arc, or simply broken, and which of four bots is pressuring
 * which of two players is not visible at all. This is the instrument those judgements
 * need, not a closed checkbox.
 *
 * READ-ONLY, and derived. Everything drawn here is computed from the World the renderer
 * was already handed -- `aiTargetId`, `aiTargetTicks`, `aiLastSeenPos`, `aiLastSeenTicks`
 * and a `lineOfSight` call -- so nothing in `src/sim/` changes to support it and the
 * one-way projection rule holds. That is also why the RETARGET REASON is absent: it is a
 * return value from `commitTarget`, not world state, so a per-frame consumer cannot see
 * it. Surfacing it would mean storing it on the Tank, which is a simulation change and
 * belongs to whoever needs the reason rather than to the overlay that would display it.
 *
 * EVERY AI GETS A MARKER, including one with no contact at all. A state that draws
 * nothing is indistinguishable from the overlay being off, which would make exactly the
 * third of the three states #372 names unreadable -- so "no contact" is grey rather than
 * absent.
 */
export interface AiContact {
  /** Redraw for this frame's world. */
  sync(world: World): void;
  dispose(): void;
}

/** The three states #372 asks a developer trace to tell apart. */
export type ContactState = 'visible' | 'remembered' | 'none';

/**
 * Which of the three states this tank is in, by the same reads the AI itself makes.
 *
 * Exported for the tests: the classification is the part with rules in it, and pinning it
 * through a rendered frame alone would need a colour sample per case.
 */
export function contactStateOf(world: World, tank: Tank): { state: ContactState; at: Vec2 | null } {
  const target = world.tanks.find((t) => t.id === tank.aiTargetId && t.alive);
  // Sight is re-derived rather than remembered from a flag, because that is what makes
  // 'visible' honest: the same `lineOfSight` the sim consults, against this frame's walls.
  if (target && lineOfSight(tank.pos, target.pos, world.walls)) {
    return { state: 'visible', at: target.pos };
  }
  if (tank.aiLastSeenPos !== undefined && (tank.aiLastSeenTicks ?? 0) > 0) {
    return { state: 'remembered', at: tank.aiLastSeenPos };
  }
  return { state: 'none', at: null };
}

const COLORS: Record<ContactState, number> = {
  visible: 0x4ade80,
  remembered: 0xffc857,
  none: 0x8892a0,
};

/** Just off the felt, matching the RING_Y precedent minedebug.ts sets for the same reason. */
const RING_Y = 0.031;
const LABEL_Y = 1.25;
const LINE_WIDTH = 0.06;
const CONTACT_RING_R = 0.42;

function ringMesh(radius: number): THREE.Mesh {
  const w = Math.max(0.03, radius * 0.06);
  const mesh = new THREE.Mesh(
    new THREE.RingGeometry(radius - w, radius, 48),
    new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  mesh.rotation.x = -Math.PI / 2;
  return mesh;
}

/**
 * A flat quad rather than a THREE.Line: `linewidth` is ignored by every WebGL renderer on
 * the platforms this ships to, so a Line would be a one-pixel hairline at best and
 * invisible at worst -- which is precisely the failure this overlay exists to rule out.
 * The quad lives inside a group that is rotated to the bearing, so `sync` only writes a
 * scale and the group's rotation.
 */
function connectorMesh(): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(1, LINE_WIDTH),
    new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.75,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  mesh.rotation.x = -Math.PI / 2;
  return mesh;
}

/** A short string drawn to a canvas and billboarded, same technique as minedebug.ts. */
function makeLabel(): { sprite: THREE.Sprite; draw: (text: string) => void } {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false }),
  );
  sprite.scale.set(2.4, 0.6, 1);
  function draw(text: string): void {
    // jsdom provides no 2D context; the sprite is still built and still positioned, so
    // the wiring stays testable and only the glyphs are missing. Same note minedebug.ts
    // carries for the same reason.
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = 'bold 34px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.strokeText(text, 128, 32);
    ctx.fillStyle = '#e8edf2';
    ctx.fillText(text, 128, 32);
    texture.needsUpdate = true;
  }
  return { sprite, draw };
}

/**
 * `#<target> c<commitment ticks> m<memory ticks>`, or `-- searching` with no target.
 *
 * Exported and pure so the string can be pinned without a canvas: jsdom draws no glyphs,
 * so a test that went through `draw` would assert nothing about what it says.
 */
export function contactLabel(tank: Tank, state: ContactState): string {
  if (tank.aiTargetId === undefined) return '-- searching';
  const commit = tank.aiTargetTicks ?? 0;
  const memory = tank.aiLastSeenTicks ?? 0;
  return state === 'remembered'
    ? `#${tank.aiTargetId} c${commit} m${memory}`
    : `#${tank.aiTargetId} c${commit}`;
}

export function createAiContact(scene: THREE.Scene): AiContact {
  interface View {
    group: THREE.Group;
    self: THREE.Mesh;
    connectorPivot: THREE.Group;
    connector: THREE.Mesh;
    contact: THREE.Mesh;
    label: { sprite: THREE.Sprite; draw: (text: string) => void };
  }
  const views = new Map<number, View>();

  function make(): View {
    const group = new THREE.Group();
    const self = ringMesh(TANK_RADIUS + 0.16);
    self.position.y = RING_Y;
    group.add(self);

    const connectorPivot = new THREE.Group();
    connectorPivot.position.y = RING_Y;
    const connector = connectorMesh();
    connectorPivot.add(connector);
    group.add(connectorPivot);

    const contact = ringMesh(CONTACT_RING_R);
    contact.position.y = RING_Y;
    group.add(contact);

    const label = makeLabel();
    label.sprite.position.y = LABEL_Y;
    group.add(label.sprite);

    scene.add(group);
    return { group, self, connectorPivot, connector, contact, label };
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

  function paint(mesh: THREE.Mesh, color: number, opacity: number): void {
    const mat = mesh.material as THREE.MeshBasicMaterial;
    mat.color.setHex(color);
    mat.opacity = opacity;
  }

  function sync(world: World): void {
    const seen = new Set<number>();
    for (const tank of world.tanks) {
      // Players are not driven by stepAi, so they have no committed target to show; a ring
      // round the tank you are steering would be noise, not information.
      if (tank.kind === 'player' || !tank.alive) continue;
      seen.add(tank.id);
      let view = views.get(tank.id);
      if (!view) {
        view = make();
        views.set(tank.id, view);
      }
      const { state, at } = contactStateOf(world, tank);
      const color = COLORS[state];
      view.group.position.set(tank.pos.x, 0, tank.pos.y);
      paint(view.self, color, 0.9);
      view.label.draw(contactLabel(tank, state));

      if (at === null) {
        view.connectorPivot.visible = false;
        view.contact.visible = false;
        continue;
      }
      const dx = at.x - tank.pos.x;
      const dy = at.y - tank.pos.y;
      const dist = Math.hypot(dx, dy);
      view.connectorPivot.visible = dist > 1e-6;
      view.contact.visible = true;
      // Sim bearing theta points at (cos, sin) in (x, y); rotating a group about three's
      // +Y by -theta sends its local +X to (cos theta, 0, sin theta), which is that same
      // direction once sim y is read as world z.
      view.connectorPivot.rotation.y = -Math.atan2(dy, dx);
      view.connector.scale.x = Math.max(dist, 1e-6);
      view.connector.position.x = dist / 2;
      paint(view.connector, color, state === 'remembered' ? 0.55 : 0.75);
      view.contact.position.set(dx, RING_Y, dy);
      paint(view.contact, color, 0.9);
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
