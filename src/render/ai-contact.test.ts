// @vitest-environment jsdom
// Dev-only is not untested, for the reason minedebug.test.ts gives: a broken overlay sends
// you chasing a sim bug that is not there. This one has a second reason -- it is the
// instrument #359's and #372's normal-speed judgements are made through, so a wrong
// classification here does not just mislead, it produces a wrong ruling.
//
// Three.js builds its scene graph on the CPU, so the wiring and the geometry are reachable
// headlessly. What is NOT reachable here is whether any of it reaches the framebuffer;
// tools/gl/harness.ts covers that against the real renderer, which is where renderer.ts
// lives per .claude/rules/rendering.md.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createAiContact, contactStateOf, contactLabel } from './ai-contact';
import { createWorld, type World } from '../sim/world';
import type { Tank, Wall } from '../sim/types';

function tank(id: number, kind: string, x: number, y: number, extra: Partial<Tank> = {}): Tank {
  return {
    id, kind, pos: { x, y }, bodyAngle: 0, turretAngle: 0, alive: true,
    desiredMove: { x: 0, y: 0 }, activeMineIds: [], fireCooldown: 0, mineCooldown: 0,
    aiState: 'idle', aiTimer: 0, ...extra,
  } as unknown as Tank;
}

/** A slab between (0,0) and (0,3), so a tank at the origin cannot see one at y = 3. */
const BLOCKER: Wall = {
  id: 1, kind: 'solid', destroyed: false,
  aabb: { minX: -2, minY: 1.2, maxX: 2, maxY: 1.8 },
};

function world(tanks: Tank[], walls: Wall[] = []): World {
  return createWorld({ walls, tanks, spawns: [], lives: 3 });
}

const groups = (scene: THREE.Scene): THREE.Group[] =>
  scene.children.filter((o): o is THREE.Group => o instanceof THREE.Group);

describe('contactStateOf tells the three states #372 names apart', () => {
  it('VISIBLE: a committed target with a clear line', () => {
    const ai = tank(1, 'brown', 0, 0, { aiTargetId: 2 });
    const w = world([ai, tank(2, 'player', 0, 3)]);
    expect(contactStateOf(w, ai)).toEqual({ state: 'visible', at: { x: 0, y: 3 } });
  });

  it('REMEMBERED: the same pair with a wall between them and memory left', () => {
    // The negative control for the case above is this one: the ONLY difference is the
    // wall. Without it the state is 'visible' (asserted directly above), so a
    // classification that ignored line of sight would fail one of the two.
    const ai = tank(1, 'brown', 0, 0, {
      aiTargetId: 2, aiLastSeenPos: { x: 0.4, y: 3 }, aiLastSeenTicks: 40,
    });
    const w = world([ai, tank(2, 'player', 0, 3)], [BLOCKER]);
    expect(contactStateOf(w, ai)).toEqual({ state: 'remembered', at: { x: 0.4, y: 3 } });
  });

  it('REMEMBERED points at the remembered position, never the live one', () => {
    // The distinction #372 exists for. Storing the Tank rather than a snapshot would make
    // `at` equal the target's CURRENT pos, which this asserts it is not.
    const ai = tank(1, 'brown', 0, 0, {
      aiTargetId: 2, aiLastSeenPos: { x: 0.4, y: 3 }, aiLastSeenTicks: 40,
    });
    const w = world([ai, tank(2, 'player', 2.5, 3)], [BLOCKER]);
    const { at } = contactStateOf(w, ai);
    expect(at).toEqual({ x: 0.4, y: 3 });
    expect(at).not.toEqual(w.tanks[1].pos);
  });

  it('NONE: memory expired', () => {
    const ai = tank(1, 'brown', 0, 0, {
      aiTargetId: 2, aiLastSeenPos: { x: 0.4, y: 3 }, aiLastSeenTicks: 0,
    });
    const w = world([ai, tank(2, 'player', 0, 3)], [BLOCKER]);
    expect(contactStateOf(w, ai)).toEqual({ state: 'none', at: null });
  });

  it('NONE: the committed target is dead, even with sight and memory intact', () => {
    // `aiTargetId` outliving its tank is the state target-memory.ts clears on; the overlay
    // must not keep drawing a line to a corpse. Flipping `alive` back to true reds this.
    const ai = tank(1, 'brown', 0, 0, {
      aiTargetId: 2, aiLastSeenPos: { x: 0, y: 3 }, aiLastSeenTicks: 40,
    });
    const w = world([ai, tank(2, 'player', 0, 3, { alive: false })]);
    expect(contactStateOf(w, ai).state).toBe('remembered');
    const noMemory = tank(1, 'brown', 0, 0, { aiTargetId: 2 });
    const w2 = world([noMemory, tank(2, 'player', 0, 3, { alive: false })]);
    expect(contactStateOf(w2, noMemory)).toEqual({ state: 'none', at: null });
  });
});

describe('contactLabel', () => {
  it('names the committed target and its commitment span', () => {
    const t = tank(1, 'brown', 0, 0, { aiTargetId: 4, aiTargetTicks: 27 });
    expect(contactLabel(t, 'visible')).toBe('#4 c27');
  });

  it('adds the memory span only while remembering, where it is the thing running out', () => {
    const t = tank(1, 'brown', 0, 0, { aiTargetId: 4, aiTargetTicks: 27, aiLastSeenTicks: 61 });
    expect(contactLabel(t, 'remembered')).toBe('#4 c27 m61');
    expect(contactLabel(t, 'visible')).toBe('#4 c27');
  });

  it('says searching when no target is committed at all', () => {
    expect(contactLabel(tank(1, 'brown', 0, 0), 'none')).toBe('-- searching');
  });
});

describe('createAiContact scene wiring', () => {
  it('marks every alive AI and no player, so "no contact" is visible rather than absent', () => {
    const scene = new THREE.Scene();
    const overlay = createAiContact(scene);
    overlay.sync(world([
      tank(1, 'brown', 0, 0),
      tank(2, 'grey', 1, 1),
      tank(3, 'player', 2, 2),
      tank(4, 'teal', 3, 3, { alive: false }),
    ]));
    // Two: the player and the dead tank are both excluded. Dropping either exclusion
    // makes this 3 or 4.
    expect(groups(scene)).toHaveLength(2);
  });

  it('puts the far end of the connector exactly on the contact point', () => {
    // The assertion that catches an axis or sign error. Sim (x, y) becomes three (x, _, y)
    // and a group rotated about +Y by -theta sends local +X to (cos, 0, sin) -- easy to get
    // backwards, and a 180-degree error draws a confident line at the wrong tank. Checked
    // in WORLD space so it holds however the pivot is parameterised.
    const scene = new THREE.Scene();
    const overlay = createAiContact(scene);
    const ai = tank(1, 'brown', -1.5, 0.5, { aiTargetId: 2 });
    overlay.sync(world([ai, tank(2, 'player', 2.25, 3.75)]));
    const group = groups(scene)[0];
    group.updateMatrixWorld(true);
    const pivot = group.children.find((o): o is THREE.Group => o instanceof THREE.Group)!;
    const far = pivot.localToWorld(new THREE.Vector3(pivot.children[0].scale.x, 0, 0));
    expect(far.x).toBeCloseTo(2.25, 6);
    expect(far.z).toBeCloseTo(3.75, 6);
  });

  it('hides the connector and the contact ring when there is nothing to point at', () => {
    const scene = new THREE.Scene();
    const overlay = createAiContact(scene);
    overlay.sync(world([tank(1, 'brown', 0, 0)]));
    const group = groups(scene)[0];
    const pivot = group.children.find((o): o is THREE.Group => o instanceof THREE.Group)!;
    expect(pivot.visible).toBe(false);
    // ...and shows them again once contact exists, so the hide is state, not a one-way trap.
    overlay.sync(world([tank(1, 'brown', 0, 0, { aiTargetId: 2 }), tank(2, 'player', 0, 3)]));
    expect(pivot.visible).toBe(true);
  });

  it('drops a tank that leaves the world, and disposes everything on dispose', () => {
    const scene = new THREE.Scene();
    const overlay = createAiContact(scene);
    overlay.sync(world([tank(1, 'brown', 0, 0), tank(2, 'grey', 1, 1)]));
    expect(groups(scene)).toHaveLength(2);
    // A killed tank must take its rings with it: the same rule minedebug.test.ts pins for
    // a detonated mine. Leaving the view behind draws a contact for a tank that is gone.
    overlay.sync(world([tank(1, 'brown', 0, 0)]));
    expect(groups(scene)).toHaveLength(1);
    overlay.dispose();
    expect(scene.children).toHaveLength(0);
  });
});
