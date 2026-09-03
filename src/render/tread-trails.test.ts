// Same reasoning as particles.test.ts/death-pulse.test.ts: Three builds meshes,
// materials and vector maths on the CPU, so a Scene needs no GL context and this is
// jsdom-testable.
import { describe, it, expect, vi } from 'vitest';
import { resolveWorldRules } from '../sim/rules';
import * as THREE from 'three';
import { createWorld, type World } from '../sim/world';
import type { Tank, Spawn } from '../sim/types';
import {
  createTreadTrailSystem, EMIT_SPACING, LIFETIME_SECONDS, MAX_TRAILS,
  TREAD_COLOR, TREAD_IDENTITY_BLEND, blendHex, treadColorFor,
} from './tread-trails';
import { HULL_WIDTH, TRACK_W } from './entities';
import { IDENTITY_RING_COLORS, TEAM_COLORS } from '../presentation/identity';

// Imported from the module rather than re-declared: a re-declared literal here
// would silently stop matching the module's own constant the moment either one
// is retuned, and the resulting test failures would read as a real regression
// rather than a stale copy.
const TREAD_OFFSET = HULL_WIDTH / 2 - TRACK_W / 2;

function makeTank(
  id: number,
  x: number,
  y: number,
  bodyAngle: number,
  extra: Partial<Tank> = {},
): Tank {
  return {
    id,
    kind: 'player',
    pos: { x, y },
    bodyAngle,
    turretAngle: 0,
    alive: true,
    desiredMove: { x: 0, y: 0 },
    activeMineIds: [],
    fireCooldown: 0,
    mineCooldown: 0,
    aiState: 'idle',
    aiTimer: 0,
    ...extra,
  };
}

function worldWith(tank: Tank): World {
  const spawns: Spawn[] = [{ kind: 'player', pos: { x: tank.pos.x, y: tank.pos.y }, angle: tank.bodyAngle }];
  return createWorld({ walls: [], tanks: [tank], spawns, lives: 3 });
}

/** Decals are pooled, so "active" means visible, exactly as particles.test.ts's activeMeshes. */
function decalMeshes(scene: THREE.Scene): THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>[] {
  return scene.children.filter(
    (c): c is THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> =>
      (c as THREE.Mesh).isMesh && c.visible && c.name === 'tread-decal',
  );
}

function setup(): { scene: THREE.Scene; tt: ReturnType<typeof createTreadTrailSystem> } {
  const scene = new THREE.Scene();
  return { scene, tt: createTreadTrailSystem(scene) };
}

describe('tread trails: emission cadence', () => {
  it('a stationary tank never prints a decal', () => {
    // Mutation this catches: emitting unconditionally (or on any distance >= 0)
    // instead of gating on EMIT_SPACING -- a parked tank would otherwise leave a
    // decal every render frame.
    const { scene, tt } = setup();
    const tank = makeTank(1, 0, 0, 0);
    const world = worldWith(tank);
    tt.sync(world, world); // first sighting: records the anchor, prints nothing
    tt.sync(world, world); // unchanged position: zero distance accumulated
    tt.sync(world, world);
    expect(decalMeshes(scene).length).toBe(0);
  });

  it('a tank moving exactly one EMIT_SPACING prints exactly one left/right pair', () => {
    // Mutation this catches: using `>` instead of `>=` at the threshold (would miss
    // an exact-spacing move), or emitting a single decal instead of a pair.
    const { scene, tt } = setup();
    const start = makeTank(1, 0, 0, 0);
    tt.sync(worldWith(start), worldWith(start));
    const moved = makeTank(1, EMIT_SPACING, 0, 0);
    tt.sync(worldWith(start), worldWith(moved));
    expect(decalMeshes(scene).length).toBe(2);
  });

  it('a tank moving four EMIT_SPACINGs in one sync call prints four pairs, not one', () => {
    // Mutation this catches: printing once per sync() call (frame-count-based)
    // instead of walking the full distance in fixed steps -- the issue's own
    // "not render-frame count" requirement.
    const { scene, tt } = setup();
    const start = makeTank(1, 0, 0, 0);
    tt.sync(worldWith(start), worldWith(start));
    const moved = makeTank(1, EMIT_SPACING * 4, 0, 0);
    tt.sync(worldWith(start), worldWith(moved));
    expect(decalMeshes(scene).length).toBe(8);
  });

  it('a dead tank stops emitting even while its recorded position keeps "moving"', () => {
    // Mutation this catches: dropping the `!t.alive` guard, which would keep
    // printing decals from a corpse's stale desiredMove or a re-used id.
    const { scene, tt } = setup();
    const start = makeTank(1, 0, 0, 0);
    tt.sync(worldWith(start), worldWith(start));
    const dead = makeTank(1, EMIT_SPACING * 4, 0, 0, { alive: false });
    tt.sync(worldWith(start), worldWith(dead));
    expect(decalMeshes(scene).length).toBe(0);
  });

  it('reviving a dead tank re-anchors silently rather than connecting a trail across its death gap', () => {
    // Mutation this catches: keeping a dead tank's anchor around instead of
    // deleting it, which would print a long straight run of decals from the death
    // position to the revive position on the very first tick back alive.
    const { scene, tt } = setup();
    const start = makeTank(1, 0, 0, 0);
    tt.sync(worldWith(start), worldWith(start));
    const dead = makeTank(1, 50, 50, 0, { alive: false });
    tt.sync(worldWith(start), worldWith(dead));
    const revived = makeTank(1, 5, 5, 0); // far from both prior positions
    tt.sync(worldWith(dead), worldWith(revived));
    expect(decalMeshes(scene).length).toBe(0); // this tick only re-anchors
  });
});

describe('tread trails: frame-rate independence and slow accumulation', () => {
  it('one big step and many small steps covering the same path print the same decals', () => {
    // Mutation this catches (the two most likely real bugs at once):
    //  (a) re-anchoring to the tank's CURRENT position every sync() call instead of
    //      advancing the anchor by exactly EMIT_SPACING and keeping the remainder --
    //      under that bug, ten 0.1-unit steps (each below EMIT_SPACING) would never
    //      cross the threshold from a moving reference point and print ZERO decals,
    //      instead of the four a single 1.0-unit step prints;
    //  (b) any dependence on how many sync() calls it took to cover the distance,
    //      rather than only on the distance itself (the issue's own "not
    //      render-frame count" requirement, stated as an equality rather than a
    //      single-path assertion).
    const bigStep = setup();
    const smallSteps = setup();
    const start = makeTank(1, 0, 0, 0);
    bigStep.tt.sync(worldWith(start), worldWith(start));
    smallSteps.tt.sync(worldWith(start), worldWith(start));

    bigStep.tt.sync(worldWith(start), worldWith(makeTank(1, 1.0, 0, 0)));

    // Eight steps of exactly 0.125 (1/8, exact in IEEE-754 binary, unlike 0.1) so
    // the sum is exactly 1.0 with no floating-point drift to confound the
    // comparison below.
    let at = 0;
    for (let i = 0; i < 8; i++) {
      const from = makeTank(1, at, 0, 0);
      at += 0.125;
      const to = makeTank(1, at, 0, 0);
      smallSteps.tt.sync(worldWith(from), worldWith(to));
    }

    const bigPositions = decalMeshes(bigStep.scene)
      .map((m) => [Math.round(m.position.x * 1e6), Math.round(m.position.z * 1e6)])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const smallPositions = decalMeshes(smallSteps.scene)
      .map((m) => [Math.round(m.position.x * 1e6), Math.round(m.position.z * 1e6)])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);

    expect(bigPositions.length).toBe(8); // floor(1.0 / 0.25) * 2 sides
    expect(smallPositions).toEqual(bigPositions);
  });
});

describe('tread trails: orientation', () => {
  it('a decal lies flat (world-up normal) even when the tank faces off-axis', () => {
    // Mutation this catches: setting BOTH `mesh.rotation.x = -Math.PI/2` and
    // `mesh.rotation.y = -bodyAngle` directly on an un-rotated plane (the naive
    // reading of the makeSpawnRing/minedebug ring precedent, which never sets
    // rotation.y and so never exposes this) instead of pre-rotating the shared
    // geometry once. Three's default XYZ Euler order composes those two rotations
    // so the plane tips up onto its edge at any bodyAngle away from 0 -- invisible
    // at bodyAngle 0 (a quick sanity check would pass), caught here by using PI/2.
    const { scene, tt } = setup();
    const start = makeTank(1, 0, 0, Math.PI / 2);
    tt.sync(worldWith(start), worldWith(start));
    const moved = makeTank(1, 0, EMIT_SPACING, Math.PI / 2);
    tt.sync(worldWith(start), worldWith(moved));

    const decals = decalMeshes(scene);
    expect(decals.length).toBe(2);
    for (const mesh of decals) {
      mesh.updateMatrixWorld();
      // Read the geometry's OWN baked local normal (rather than assuming which
      // local axis it lies along) and rotate THAT by the mesh's own quaternion --
      // implementation-agnostic about whether flatness came from a pre-rotated
      // geometry or a per-mesh rotation.x, so it only ever asserts the one thing
      // that actually matters: does this decal lie flat in WORLD space.
      const normalAttr = mesh.geometry.attributes.normal;
      const localNormal = new THREE.Vector3(normalAttr.getX(0), normalAttr.getY(0), normalAttr.getZ(0));
      const worldNormal = localNormal.applyQuaternion(mesh.quaternion);
      expect(worldNormal.x).toBeCloseTo(0, 5);
      expect(worldNormal.y).toBeCloseTo(1, 5);
      expect(worldNormal.z).toBeCloseTo(0, 5);
    }
  });

  it('the left/right pair is separated across the HEADING, not the travel direction', () => {
    // Mutation this catches: computing the tread offset from the direction of
    // travel (dx, dy) instead of from bodyAngle. Heading is fixed east (bodyAngle
    // 0) while the tank is walked along a diagonal that is neither parallel nor
    // perpendicular to east, so the two hypotheses predict different, distinguishable
    // separation vectors.
    const { scene, tt } = setup();
    const start = makeTank(1, 0, 0, 0); // facing east: heading (1, 0)
    tt.sync(worldWith(start), worldWith(start));
    // Travel direction (0.6, 0.8) after normalizing -- diagonal, not aligned with
    // heading on either axis. Distance is exactly one EMIT_SPACING (3-4-5 triangle
    // scaled to 0.25).
    const moved = makeTank(1, 0.15, 0.2, 0);
    tt.sync(worldWith(start), worldWith(moved));

    const decals = decalMeshes(scene);
    expect(decals.length).toBe(2);
    const [a, b] = decals;
    const sep = { x: a.position.x - b.position.x, y: a.position.z - b.position.z };
    const sepLen = Math.hypot(sep.x, sep.y);
    expect(sepLen).toBeCloseTo(2 * TREAD_OFFSET, 5);

    const heading = { x: 1, y: 0 };
    const dotHeading = (sep.x * heading.x + sep.y * heading.y) / sepLen;
    expect(dotHeading).toBeCloseTo(0, 5); // perpendicular to heading

    const travelDir = { x: 0.6, y: 0.8 };
    const dotTravel = (sep.x * travelDir.x + sep.y * travelDir.y) / sepLen;
    expect(Math.abs(dotTravel)).toBeCloseTo(0.8, 5); // NOT perpendicular to travel
  });
});

describe('tread trails: fade lifecycle', () => {
  it("an aged decal's opacity decreases smoothly and it recycles at end of life", () => {
    // Mutation this catches: opacity left at its spawn value (life never read back
    // into material.opacity), or the expiry check dropped so a decal never recycles.
    const { scene, tt } = setup();
    const start = makeTank(1, 0, 0, 0);
    tt.sync(worldWith(start), worldWith(start));
    tt.sync(worldWith(start), worldWith(makeTank(1, EMIT_SPACING, 0, 0)));
    const decals = decalMeshes(scene);
    expect(decals.length).toBe(2);
    const startOpacity = decals[0].material.opacity;

    tt.update(LIFETIME_SECONDS / 2);
    const midOpacity = decalMeshes(scene)[0].material.opacity;
    expect(midOpacity).toBeLessThan(startOpacity);
    expect(midOpacity).toBeCloseTo(startOpacity / 2, 5);

    tt.update(LIFETIME_SECONDS); // well past the remaining half-life
    expect(decalMeshes(scene).length).toBe(0);
  });

  it('update(0) -- the paused case -- ages nothing', () => {
    // Mutation this catches: decrementing life by a fixed feel-constant amount per
    // call instead of by `dt`, which would still age a decal while paused (dt
    // zeroed by animationDt, per frame.ts).
    const { scene, tt } = setup();
    const start = makeTank(1, 0, 0, 0);
    tt.sync(worldWith(start), worldWith(start));
    tt.sync(worldWith(start), worldWith(makeTank(1, EMIT_SPACING, 0, 0)));
    const before = decalMeshes(scene)[0].material.opacity;
    tt.update(0);
    tt.update(0);
    const after = decalMeshes(scene)[0].material.opacity;
    expect(after).toBe(before);
    expect(decalMeshes(scene).length).toBe(2);
  });
});

describe('tread trails: bounded pool', () => {
  it('never exceeds MAX_TRAILS and recycles the OLDEST decal (by object identity) once full', () => {
    // Mutation this catches: dropping new emissions once full (particles.ts's own
    // policy, wrong for this issue's explicit "reuse/recycle oldest" requirement --
    // would leave the count under MAX_TRAILS and the captured mesh untouched), or
    // growing the pool without bound (would exceed MAX_TRAILS), or recycling an
    // arbitrary/newest decal instead of the oldest (would evict soemthing other
    // than the captured mesh, leaving it at its ORIGINAL position).
    const { scene, tt } = setup();
    const start = makeTank(1, 0, 0, 0);
    tt.sync(worldWith(start), worldWith(start));

    // One EMIT_SPACING step: exactly the first pair ever created.
    tt.sync(worldWith(start), worldWith(makeTank(1, EMIT_SPACING, 0, 0)));
    const firstMesh = decalMeshes(scene)[0];
    const firstPos = firstMesh.position.clone();

    // Fill the pool to EXACTLY MAX_TRAILS (no eviction yet): 358 more decals ==
    // 179 more pairs == 179 * EMIT_SPACING more distance from the current anchor.
    const fillTarget = EMIT_SPACING + 179 * EMIT_SPACING;
    tt.sync(worldWith(makeTank(1, EMIT_SPACING, 0, 0)), worldWith(makeTank(1, fillTarget, 0, 0)));
    expect(decalMeshes(scene).length).toBe(MAX_TRAILS);

    // One more pair beyond the cap: both acquisitions must evict, starting with
    // the oldest (firstMesh, per the FIFO invariant every decal shares maxLife).
    const overTarget = fillTarget + EMIT_SPACING;
    tt.sync(worldWith(makeTank(1, fillTarget, 0, 0)), worldWith(makeTank(1, overTarget, 0, 0)));

    expect(decalMeshes(scene).length).toBe(MAX_TRAILS); // still bounded, never more
    // The captured object was REUSED (still visible, same identity) rather than
    // abandoned -- and its position moved to the newest emission, proving it was
    // the one evicted-and-recycled, not left dangling at its original spot.
    expect(firstMesh.visible).toBe(true);
    expect(firstMesh.position.equals(firstPos)).toBe(false);
    expect(firstMesh.position.x).toBeCloseTo(overTarget, 5);
  });
});

describe('tread trails: round boundary and level switch', () => {
  it('clears every active decal and every tracked anchor when roundStartTick changes', () => {
    // Mutation this catches: dropping the roundStartTick check entirely (decals
    // from the old board would keep fading in place on the new one), or clearing
    // the decal pool but leaving the anchors map (the very next move would connect
    // a straight-line trail across the whole arena from the stale anchor to the
    // new position).
    const { scene, tt } = setup();
    const start = makeTank(1, 0, 0, 0);
    tt.sync(worldWith(start), worldWith(start));
    tt.sync(worldWith(start), worldWith(makeTank(1, EMIT_SPACING, 0, 0)));
    expect(decalMeshes(scene).length).toBe(2);

    const oldWorld = worldWith(makeTank(1, EMIT_SPACING, 0, 0));
    const newLevelTank = makeTank(1, 500, 500, 0); // a different board's spawn point
    const newWorld = { ...worldWith(newLevelTank), roundStartTick: oldWorld.roundStartTick + 1 };

    tt.sync(oldWorld, newWorld);
    expect(decalMeshes(scene).length).toBe(0);

    // The anchor must also be gone: a small move from the NEW position should not
    // immediately connect back across the 500-unit gap the level switch created.
    tt.sync(newWorld, { ...newWorld, tanks: [makeTank(1, 500 + EMIT_SPACING, 500, 0)] });
    expect(decalMeshes(scene).length).toBe(2); // one ordinary pair, not a giant run
  });

  it('clears on an announced level switch whose two worlds share roundStartTick (#531)', () => {
    // The case the roundStartTick comparison structurally cannot see, and the one the
    // test above is the NEGATIVE CONTROL for: `clears every active decal and every
    // tracked anchor when roundStartTick changes` drives the same level switch with the
    // numbers unequal, so it stays green whether or not the announcement is honoured.
    // Only a switch between two worlds that agree on roundStartTick discriminates.
    //
    // Both worlds here come straight from createWorld, which stamps `roundStartTick: 1`
    // unconditionally -- so this is the ordinary shape of clearing a level on the first
    // attempt, not a contrived fixture. Measured against this module with the
    // announcement ignored: the two decals below became 158 in a straight line to the
    // new spawn.
    //
    // Mutation this catches: dropping the `replaced ||` half of `sync`'s guard.
    const { scene, tt } = setup();
    const start = makeTank(1, 0, 0, 0);
    tt.sync(worldWith(start), worldWith(start));
    tt.sync(worldWith(start), worldWith(makeTank(1, EMIT_SPACING, 0, 0)));
    expect(decalMeshes(scene).length).toBe(2);

    const oldWorld = worldWith(makeTank(1, EMIT_SPACING, 0, 0));
    const newWorld = worldWith(makeTank(1, 14, 14, 0)); // a different board's spawn point
    // Stated rather than assumed: if createWorld ever stops starting every world at the
    // same tick, this test silently stops being about the first-round case at all.
    expect(newWorld.roundStartTick).toBe(oldWorld.roundStartTick);

    tt.worldReplaced();
    tt.sync(oldWorld, newWorld);
    expect(decalMeshes(scene).length).toBe(0);

    // And the anchor with them: a short move from the new spawn must print one ordinary
    // pair rather than reconnecting across the gap the switch opened.
    tt.sync(newWorld, { ...newWorld, tanks: [makeTank(1, 14 + EMIT_SPACING, 14, 0)] });
    expect(decalMeshes(scene).length).toBe(2);
  });

  it('spends the announcement on one sync and keeps printing afterwards', () => {
    // Negative control for the over-correction: a latch that is set but never cleared
    // wipes the board on every frame after the first level switch of the session, which
    // reads as tread trails simply not working any more. Nothing above can see that --
    // every other case in this file syncs at most twice after a clear.
    //
    // Mutation this catches: removing `worldWasReplaced = false;` from `sync`.
    const { scene, tt } = setup();
    const start = makeTank(1, 0, 0, 0);
    tt.worldReplaced();
    tt.sync(worldWith(start), worldWith(start));
    // Four separate syncs of one EMIT_SPACING each, so a latch that survived even one
    // extra frame would show up as fewer than the full eight decals here.
    let x = 0;
    for (let i = 0; i < 4; i++) {
      const from = worldWith(makeTank(1, x, 0, 0));
      x += EMIT_SPACING;
      tt.sync(from, worldWith(makeTank(1, x, 0, 0)));
    }
    expect(decalMeshes(scene).length).toBe(8);
  });

  it('does not clear a board that was never announced and never changed round', () => {
    // Negative control for the under-correction's opposite: `clearAll()` called
    // unconditionally, which passes every "the board is empty afterwards" assertion in
    // this describe block while erasing ordinary play.
    const { scene, tt } = setup();
    const start = makeTank(1, 0, 0, 0);
    tt.sync(worldWith(start), worldWith(start));
    tt.sync(worldWith(start), worldWith(makeTank(1, EMIT_SPACING, 0, 0)));
    const stayed = worldWith(makeTank(1, EMIT_SPACING, 0, 0));
    tt.sync(stayed, worldWith(makeTank(1, EMIT_SPACING * 2, 0, 0)));
    expect(decalMeshes(scene).length).toBe(4);
  });
});

describe('tread trails: dispose', () => {
  it('releases every mesh, material, and the shared geometry, leaving the scene empty', () => {
    // Mutation this catches: disposing only `active` and leaking every pooled
    // (recycled-but-currently-inactive) decal's material, or leaving meshes
    // attached to the scene after dispose.
    const { scene, tt } = setup();
    const start = makeTank(1, 0, 0, 0);
    tt.sync(worldWith(start), worldWith(start));
    // Emit, then let it fully fade so at least one decal is POOLED (inactive) as
    // well as however many are still active, exercising both disposal loops.
    tt.sync(worldWith(start), worldWith(makeTank(1, EMIT_SPACING, 0, 0)));
    tt.update(LIFETIME_SECONDS * 2);
    tt.sync(worldWith(makeTank(1, EMIT_SPACING, 0, 0)), worldWith(makeTank(1, EMIT_SPACING * 2, 0, 0)));
    expect(scene.children.length).toBeGreaterThan(0);

    tt.dispose();
    expect(scene.children.length).toBe(0);
  });

  it('calls material.dispose() on every decal ever created (pooled AND active) and geometry.dispose() exactly once', () => {
    // scene.children.length===0 alone does not catch this: `scene.remove(mesh)`
    // drops a mesh from the scene graph regardless of whether its material or
    // geometry were ever disposed, so a mutation that deletes BOTH
    // `d.mesh.material.dispose()` calls and the trailing `geo.dispose()` still
    // leaves every mesh removed and the prior test green. Spying on the shared
    // prototype methods counts actual dispose() INVOCATIONS, which a `remove()`
    // cannot fake.
    const materialDispose = vi.spyOn(THREE.MeshBasicMaterial.prototype, 'dispose');
    const geometryDispose = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose');
    try {
      const { tt } = setup();
      const start = makeTank(1, 0, 0, 0);
      tt.sync(worldWith(start), worldWith(start));
      // Four EMIT_SPACINGs -> 4 pairs -> 8 DISTINCT decal objects, all active.
      tt.sync(worldWith(start), worldWith(makeTank(1, EMIT_SPACING * 4, 0, 0)));
      // Fully fade all 8: every one recycles into the pool (0 active, 8 pooled).
      tt.update(LIFETIME_SECONDS * 2);
      // One more EMIT_SPACING -> exactly 1 more pair -> acquire() pops 2 of the 8
      // pooled decals back into `active`. No NEW decal objects are created (the
      // pool already had spares) -- still exactly 8 unique objects in existence,
      // now split 2 active / 6 pooled, exercising both arrays `dispose()` walks.
      tt.sync(
        worldWith(makeTank(1, EMIT_SPACING * 4, 0, 0)),
        worldWith(makeTank(1, EMIT_SPACING * 5, 0, 0)),
      );

      tt.dispose();

      expect(materialDispose).toHaveBeenCalledTimes(8);
      expect(geometryDispose).toHaveBeenCalledTimes(1);
    } finally {
      materialDispose.mockRestore();
      geometryDispose.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// IDENTITY TINT (issue #284). The trail layer is the quietest thing on the board and
// covers the most of it, so every assertion below is about the tint being present AND
// staying subordinate -- a test that only checked "the colour changed" would pass a trail
// printed at full ring brightness, which is the failure this feature has to avoid.
// ---------------------------------------------------------------------------
function multiWorld(tanks: Tank[], mode?: 'ffa' | 'teams'): World {
  const spawns: Spawn[] = tanks.map((t) => ({ kind: 'player' as const, pos: { ...t.pos }, angle: t.bodyAngle }));
  const w = createWorld({ walls: [], tanks, spawns, lives: 3 });
  return mode ? { ...w, rules: resolveWorldRules({ mode }) } : w;
}
/** Every distinct decal colour the system printed, in emission order. */
function printedColors(scene: THREE.Scene): number[] {
  const out: number[] = [];
  scene.traverse((o) => {
    if (o instanceof THREE.Mesh && o.visible && o.material instanceof THREE.MeshBasicMaterial) {
      out.push(o.material.color.getHex());
    }
  });
  return out;
}
/** Drive one tank far enough to print marks, and report the colours. */
function driveAndRead(world: World, moved: Tank[]): number[] {
  const scene = new THREE.Scene();
  const sys = createTreadTrailSystem(scene);
  sys.sync(world, world); // first sighting: anchors only
  const after = { ...world, tanks: world.tanks.map((t) => {
    const m = moved.find((x) => x.id === t.id);
    return m ? { ...t, pos: { x: t.pos.x + EMIT_SPACING * 3, y: t.pos.y } } : t;
  }) } as World;
  sys.sync(world, after);
  const colors = printedColors(scene);
  sys.dispose();
  return colors;
}

describe('tread trails carry their owner identity in VS (issue #284)', () => {
  it('derives the tint from the canonical identity constants, not a local palette', () => {
    // The acceptance criterion that matters most: `resolveOwnerColor`'s own comment records
    // a call site that rebuilt this logic and fell back to the wrong colour. So the expected
    // value here is COMPUTED from the shipped constants rather than written as a literal --
    // retuning the palette moves both sides together, and a private copy in tread-trails
    // would move only one.
    for (let slot = 0; slot < IDENTITY_RING_COLORS.length; slot++) {
      const tank = makeTank(slot + 1, 5, 5, 0, { controlledBy: slot });
      const other = makeTank(99, 40, 40, 0, { controlledBy: (slot + 1) % 4 });
      const w = multiWorld([tank, other], 'ffa');
      expect(treadColorFor(w, tank), `slot ${slot}`)
        .toBe(blendHex(TREAD_COLOR, IDENTITY_RING_COLORS[slot], TREAD_IDENTITY_BLEND));
    }
  });

  it('uses the TEAM colour in teams, not the slot colour', () => {
    for (const team of [0, 1]) {
      const tank = makeTank(1, 5, 5, 0, { controlledBy: 3, team });
      const w = multiWorld([tank, makeTank(2, 40, 40, 0, { controlledBy: 1, team: 1 - team })], 'teams');
      expect(treadColorFor(w, tank), `team ${team}`)
        .toBe(blendHex(TREAD_COLOR, TEAM_COLORS[team], TREAD_IDENTITY_BLEND));
      // ...and it is genuinely the team's, not the slot's: slot 3's identity colour would
      // give a different answer, so this cannot pass by both palettes agreeing.
      expect(treadColorFor(w, tank))
        .not.toBe(blendHex(TREAD_COLOR, IDENTITY_RING_COLORS[3], TREAD_IDENTITY_BLEND));
    }
  });

  it('leaves campaign trails neutral -- and for the same reason rings are', () => {
    // One player-kind tank is below entities.ts's identity threshold, so this is the shared
    // gate saying no, not a separate mode check in this module that could drift from it.
    const solo = makeTank(1, 5, 5, 0, { controlledBy: 0 });
    expect(treadColorFor(worldWith(solo), solo)).toBe(TREAD_COLOR);
    // An ENEMY is neutral even on a multiplayer board: it has no slot and no team, and
    // `resolveOwnerColor` would otherwise hand it slot 0's colour.
    // FOUR-PLAYER CO-OP is neutral too, and this case exists because rendering it caught the
    // opposite: co-op clears the player-count gate (four player tanks, four identity rings),
    // so the first implementation tinted campaign trails. #284 says campaign stays neutral.
    const coop = [0, 1, 2, 3].map((slot) => makeTank(slot + 1, 5 + slot * 8, 5, 0, { controlledBy: slot }));
    const coopWorld = multiWorld(coop); // no mode override -> 'campaign-coop'
    expect(coopWorld.rules.mode).toBe('campaign-coop');
    for (const t of coop) expect(treadColorFor(coopWorld, t), `co-op slot ${t.controlledBy}`).toBe(TREAD_COLOR);
    // ...and the same four tanks in ffa ARE tinted, so the case above is the mode doing the
    // work rather than something else making every assertion neutral.
    const vsWorld = multiWorld(coop, 'ffa');
    for (const t of coop) expect(treadColorFor(vsWorld, t)).not.toBe(TREAD_COLOR);
    const enemy = makeTank(2, 9, 9, 0, { kind: 'brown' });
    const w = multiWorld([makeTank(1, 5, 5, 0, { controlledBy: 0 }), makeTank(3, 40, 40, 0, { controlledBy: 1 }), enemy], 'ffa');
    expect(treadColorFor(w, enemy)).toBe(TREAD_COLOR);
  });

  it('stays QUIETER than the identity ring it leans toward, on every channel', () => {
    // The subordinate-layer criterion, measured rather than asserted by eye: each channel of
    // a printed mark sits between the neutral earth and the ring colour, and strictly nearer
    // the neutral. A trail printed at full ring brightness fails this; so does one printed
    // past it.
    for (let slot = 0; slot < IDENTITY_RING_COLORS.length; slot++) {
      const tank = makeTank(1, 5, 5, 0, { controlledBy: slot });
      const w = multiWorld([tank, makeTank(2, 40, 40, 0, { controlledBy: (slot + 1) % 4 })], 'ffa');
      const tint = treadColorFor(w, tank);
      for (const shift of [16, 8, 0]) {
        const neutral = (TREAD_COLOR >> shift) & 0xff;
        const ring = (IDENTITY_RING_COLORS[slot] >> shift) & 0xff;
        const got = (tint >> shift) & 0xff;
        expect(Math.abs(got - neutral), `slot ${slot} channel ${shift}`)
          .toBeLessThanOrEqual(Math.abs(got - ring));
        expect(got, `slot ${slot} channel ${shift} left the neutral..ring interval`)
          .toBeGreaterThanOrEqual(Math.min(neutral, ring));
        expect(got).toBeLessThanOrEqual(Math.max(neutral, ring));
      }
    }
  });

  it('prints each owner its own colour through the real emit path', () => {
    // Not `treadColorFor` in isolation: the colour has to survive `emitPair` and reach the
    // material a decal actually renders with.
    const a = makeTank(1, 5, 5, 0, { controlledBy: 0 });
    const b = makeTank(2, 20, 20, 0, { controlledBy: 1 });
    const w = multiWorld([a, b], 'ffa');
    const colors = new Set(driveAndRead(w, [a, b]));
    expect(colors.has(blendHex(TREAD_COLOR, IDENTITY_RING_COLORS[0], TREAD_IDENTITY_BLEND))).toBe(true);
    expect(colors.has(blendHex(TREAD_COLOR, IDENTITY_RING_COLORS[1], TREAD_IDENTITY_BLEND))).toBe(true);
    expect(colors.has(TREAD_COLOR), 'a VS mark printed neutral').toBe(false);
  });

  it('does not let a POOLED decal keep the previous owner colour', () => {
    // Decals are recycled (`pool.pop() ?? makeDecal()`), so a colour set once at construction
    // would give slot 1 slot 0's marks the moment the pool turns over. Setting it per
    // EMISSION is what prevents that, and this is the case that proves it.
    const scene = new THREE.Scene();
    const sys = createTreadTrailSystem(scene);
    const a = makeTank(1, 5, 5, 0, { controlledBy: 0 });
    const b = makeTank(2, 20, 20, 0, { controlledBy: 1 });
    let w = multiWorld([a, b], 'ffa');
    sys.sync(w, w);
    // Move A only, then expire everything, then move B only into the recycled decals.
    const movedA = { ...w, tanks: [{ ...a, pos: { x: 5 + EMIT_SPACING * 4, y: 5 } }, b] } as World;
    sys.sync(w, movedA);
    sys.update(LIFETIME_SECONDS + 0.1);
    w = movedA;
    const movedB = { ...w, tanks: [w.tanks[0], { ...b, pos: { x: 20 + EMIT_SPACING * 4, y: 20 } }] } as World;
    sys.sync(w, movedB);
    const colors = new Set(printedColors(scene));
    const aTint = blendHex(TREAD_COLOR, IDENTITY_RING_COLORS[0], TREAD_IDENTITY_BLEND);
    const bTint = blendHex(TREAD_COLOR, IDENTITY_RING_COLORS[1], TREAD_IDENTITY_BLEND);
    expect(colors.has(bTint), "B's recycled marks are not B's colour").toBe(true);
    expect(colors.has(aTint), "A's expired marks kept their colour in the pool").toBe(false);
    sys.dispose();
  });

  it('blendHex is a plain per-channel lerp, with both ends exact', () => {
    expect(blendHex(0x000000, 0xffffff, 0)).toBe(0x000000);
    expect(blendHex(0x000000, 0xffffff, 1)).toBe(0xffffff);
    expect(blendHex(0x000000, 0xffffff, 0.5)).toBe(0x808080);
    expect(blendHex(0x102030, 0x506070, 0.5)).toBe(0x304050);
    // Channels do not bleed into each other, which a naive numeric lerp on the packed
    // value would do the moment one channel carried.
    expect(blendHex(0x0000ff, 0xff0000, 0.5)).toBe(0x800080);
  });
});
