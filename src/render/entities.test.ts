// Three.js builds and transforms its scene graph on the CPU -- only the actual
// draw needs a GL context -- so the sim -> three mapping IS testable headlessly,
// and it is the layer where a silent sign error breaks the whole game while the
// suite stays green.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createEntityViews } from './entities';
import { createWorld, type World } from '../sim/world';
import type { Tank, Spawn, Bullet, Vec2 } from '../sim/types';
import { blastRadiusAt } from '../sim/mines';
import { MINE_TIMER } from '../sim/constants';
import { NORMAL_SPEED, MINE_BLAST_RADIUS, MINE_BLAST_EXPAND_TICKS, MINE_BLAST_HOLD_TICKS } from '../sim/constants';

function makeTank(id: number, kind: Tank['kind'], x: number, y: number): Tank {
  return {
    id,
    kind,
    pos: { x, y },
    bodyAngle: 0,
    turretAngle: 0,
    alive: true,
    desiredMove: { x: 0, y: 0 },
    activeMineIds: [],
    fireCooldown: 0,
    mineCooldown: 0,
    aiState: 'idle',
    aiTimer: 0,
  };
}

function makeWorld(): World {
  const player = makeTank(1, 'player', 5, 5);
  const spawns: Spawn[] = [{ kind: 'player', pos: { x: 5, y: 5 }, angle: 0 }];
  return createWorld({ walls: [], tanks: [player], spawns, lives: 3 });
}

/**
 * Recover the gun's heading as a SIM angle from the rendered scene graph.
 *
 * The barrel is parked at the turret's local +x. Reading its world position
 * relative to the tank group and mapping three's (x, z) back to the sim's
 * (x, y) inverts the whole render transform -- so this measures what a player
 * actually sees, not what the code intended.
 */
function renderedGunAngle(scene: THREE.Scene): number {
  scene.updateMatrixWorld(true);
  const group = scene.children.find((c) => c instanceof THREE.Group) as THREE.Group;
  const turret = group.children.find((c) => c instanceof THREE.Group) as THREE.Group;
  const barrel = turret.children.find(
    (c) => (c as THREE.Mesh).geometry instanceof THREE.CylinderGeometry,
  ) as THREE.Mesh;

  const gunPos = new THREE.Vector3();
  barrel.getWorldPosition(gunPos);
  const tankPos = new THREE.Vector3();
  group.getWorldPosition(tankPos);

  return Math.atan2(gunPos.z - tankPos.z, gunPos.x - tankPos.x);
}

const DEG = Math.PI / 180;

describe('entity views — turret aiming', () => {
  // The turret is a CHILD of the tank group, so writing the absolute
  // turretAngle onto it composed with the body rotation and aimed the barrel
  // at bodyAngle + turretAngle. Since moveTank sets bodyAngle to the driving
  // direction, the barrel pointed at the crosshair only while driving due east.
  it.each([
    { bodyAngle: 0, turretAngle: 0 },
    { bodyAngle: 0, turretAngle: 90 * DEG },
    { bodyAngle: 90 * DEG, turretAngle: 0 },
    { bodyAngle: 90 * DEG, turretAngle: 90 * DEG },
    { bodyAngle: 180 * DEG, turretAngle: 45 * DEG },
    { bodyAngle: -90 * DEG, turretAngle: 30 * DEG },
    { bodyAngle: 45 * DEG, turretAngle: 45 * DEG },
    { bodyAngle: 135 * DEG, turretAngle: -60 * DEG },
  ])(
    'points the barrel at turretAngle $turretAngle regardless of bodyAngle $bodyAngle',
    ({ bodyAngle, turretAngle }) => {
      const scene = new THREE.Scene();
      const views = createEntityViews(scene);
      const w = makeWorld();
      w.tanks[0].bodyAngle = bodyAngle;
      w.tanks[0].turretAngle = turretAngle;

      views.sync(w, w, 0);

      const rendered = renderedGunAngle(scene);
      // Compare as a direction, so the ±π wrap is not a false failure.
      expect(Math.cos(rendered)).toBeCloseTo(Math.cos(turretAngle), 9);
      expect(Math.sin(rendered)).toBeCloseTo(Math.sin(turretAngle), 9);

      views.dispose();
    },
  );

  it('places the tank at its sim position, mapping sim y to three z', () => {
    const scene = new THREE.Scene();
    const views = createEntityViews(scene);
    const w = makeWorld();
    w.tanks[0].pos = { x: 3, y: 17 };

    views.sync(w, w, 0);
    scene.updateMatrixWorld(true);

    const group = scene.children.find((c) => c instanceof THREE.Group) as THREE.Group;
    expect(group.position.x).toBeCloseTo(3, 9);
    expect(group.position.z).toBeCloseTo(17, 9);
    expect(group.position.y).toBeCloseTo(0, 9);

    views.dispose();
  });
});

describe('entity views — interpolation discontinuities', () => {
  it('snaps rather than lerps across a round boundary', () => {
    // resetArena teleports every tank back to spawn within one tick while
    // keeping its id and reviving it. Lerping that drew the tank streaking
    // across the arena for a frame, on every life lost.
    const scene = new THREE.Scene();
    const views = createEntityViews(scene);

    const prev = makeWorld();
    prev.tanks[0].pos = { x: 15.5, y: 15 };
    prev.roundStartTick = 0;

    const curr = makeWorld();
    curr.tanks[0].pos = { x: 11, y: 15 };
    curr.roundStartTick = 480; // resetArena re-anchored the round

    views.sync(prev, curr, 0.5);
    scene.updateMatrixWorld(true);

    const group = scene.children.find((c) => c instanceof THREE.Group) as THREE.Group;
    expect(group.position.x).toBeCloseTo(11, 9); // curr pose, not the 13.25 midpoint

    views.dispose();
  });

  it('interpolates normally within a round', () => {
    const scene = new THREE.Scene();
    const views = createEntityViews(scene);

    const prev = makeWorld();
    prev.tanks[0].pos = { x: 10, y: 5 };
    const curr = makeWorld();
    curr.tanks[0].pos = { x: 11, y: 5 };
    // same roundStartTick on both -> ordinary motion

    views.sync(prev, curr, 0.5);
    scene.updateMatrixWorld(true);

    const group = scene.children.find((c) => c instanceof THREE.Group) as THREE.Group;
    expect(group.position.x).toBeCloseTo(10.5, 9);

    views.dispose();
  });

  it('clamps alpha, so an overshooting accumulator cannot extrapolate', () => {
    const scene = new THREE.Scene();
    const views = createEntityViews(scene);

    const prev = makeWorld();
    prev.tanks[0].pos = { x: 10, y: 5 };
    const curr = makeWorld();
    curr.tanks[0].pos = { x: 11, y: 5 };

    views.sync(prev, curr, 2.5); // would extrapolate to x=12.5 unclamped
    scene.updateMatrixWorld(true);

    const group = scene.children.find((c) => c instanceof THREE.Group) as THREE.Group;
    expect(group.position.x).toBeCloseTo(11, 9);

    views.dispose();
  });
});

// Helpers that pick a specific view out of the scene. Tanks are Groups too now that a
// shell is one, so "the first Group" is no longer good enough to identify either.
function shellGroup(scene: THREE.Scene): THREE.Group {
  const g = scene.children.find(
    (c): c is THREE.Group =>
      c instanceof THREE.Group && c.children.some((k) => (k as THREE.Mesh).geometry instanceof THREE.CylinderGeometry)
      && Math.abs(c.position.y - 0.35) < 1e-9,
  );
  if (!g) throw new Error('no shell view in scene');
  return g;
}
function blastMesh(scene: THREE.Scene): THREE.Mesh | undefined {
  return scene.children.find(
    (c): c is THREE.Mesh => c instanceof THREE.Mesh && c.geometry instanceof THREE.SphereGeometry,
  );
}
function mkBullet(id: number, pos: Vec2, vel: Vec2): Bullet {
  return { id, ownerId: 1, type: 'normal', pos, vel, bouncesLeft: 1, alive: true };
}

describe('shell geometry', () => {
  it('is a cylinder with a rounded nose ahead of the body', () => {
    const scene = new THREE.Scene();
    const views = createEntityViews(scene);
    const w = makeWorld();
    w.bullets.push(mkBullet(50, { x: 1, y: 1 }, { x: NORMAL_SPEED, y: 0 }));
    views.sync(w, w, 0);

    const shell = shellGroup(scene);
    const body = shell.children.find((c) => (c as THREE.Mesh).geometry instanceof THREE.CylinderGeometry) as THREE.Mesh;
    const nose = shell.children.find((c) => (c as THREE.Mesh).geometry instanceof THREE.SphereGeometry) as THREE.Mesh;
    expect(body).toBeDefined();
    expect(nose).toBeDefined();
    // A COMPLETE sphere, and this assertion is the wrong-way-round one I got caught by:
    // a half sphere (phiLength PI) is an open single-sided shell you can see inside of
    // from overhead. Closed is what makes it read as solid from the gameplay camera.
    const np = (nose.geometry as THREE.SphereGeometry).parameters;
    expect(np.phiLength).toBeCloseTo(Math.PI * 2, 9);
    expect(np.thetaLength).toBeCloseTo(Math.PI, 9);
    // And it is at the FRONT. With the parts laid along local +x, a nose at -x or at the
    // origin would be a shell with its point buried in its own body.
    expect(nose.position.x).toBeGreaterThan(0);
    expect(nose.position.x).toBeCloseTo(
      (body.geometry as THREE.CylinderGeometry).parameters.height / 2,
      9,
    );
    views.dispose();
  });

  it('points along its velocity, with the sim-to-three sign flip', () => {
    // The classic silent failure in this layer. Velocity straight up the sim's +y is
    // angle +PI/2, which must become rotation.y = -PI/2; a missing minus draws every
    // shell mirrored about the axis and nothing else in the suite would notice.
    const scene = new THREE.Scene();
    const views = createEntityViews(scene);
    const w = makeWorld();
    w.bullets.push(mkBullet(50, { x: 1, y: 1 }, { x: 0, y: NORMAL_SPEED }));
    views.sync(w, w, 0);

    expect(shellGroup(scene).rotation.y).toBeCloseTo(-Math.PI / 2, 9);
    views.dispose();
  });
});

describe('blast views', () => {
  function withBlast(age: number): World {
    const w = makeWorld();
    w.blasts.push({ id: 900, ownerId: 1, pos: { x: 4, y: 6 }, age });
    return w;
  }

  it('is drawn at the radius the SIM says it has, not a look-alike curve', () => {
    // Mid-expansion, so the value is neither 0 nor the full radius -- either of those
    // would pass against a hardcoded constant.
    const scene = new THREE.Scene();
    const views = createEntityViews(scene);
    const w = withBlast(2);
    views.sync(w, w, 0);

    const mesh = blastMesh(scene)!;
    expect(mesh).toBeDefined();
    expect(mesh.scale.x).toBeCloseTo(blastRadiusAt(2), 9);
    expect(mesh.scale.x).toBeLessThan(MINE_BLAST_RADIUS); // it really is mid-growth
    // THE FOOTPRINT IS THE KILL RADIUS. The fireball is squashed vertically because a
    // ground burst vents sideways, but that squash must never touch the horizontal axes:
    // the sim is 2D and this circle is exactly what it kills. Scaling x or z would draw a
    // blast whose reach lies about itself.
    expect(mesh.scale.z).toBeCloseTo(mesh.scale.x, 9);
    expect(mesh.scale.y).toBeLessThan(mesh.scale.x); // flattened, not a sphere
    expect(mesh.scale.y).toBeGreaterThan(0);
    expect(mesh.position.x).toBeCloseTo(4, 9);
    expect(mesh.position.z).toBeCloseTo(6, 9); // sim y -> three z
    views.dispose();
  });

  it('interpolates its radius between ticks', () => {
    // A 5-tick expansion drawn in discrete steps reads as a stutter at 60fps.
    const scene = new THREE.Scene();
    const views = createEntityViews(scene);
    views.sync(withBlast(1), withBlast(2), 0.5);

    const expected = (blastRadiusAt(1) + blastRadiusAt(2)) / 2;
    expect(blastMesh(scene)!.scale.x).toBeCloseTo(expected, 9);
    // The midpoint is distinct from both endpoints, so this fails if alpha is ignored.
    expect(expected).not.toBeCloseTo(blastRadiusAt(2), 9);
    views.dispose();
  });

  it('holds at full opacity after it stops growing, THEN fades', () => {
    const scene = new THREE.Scene();
    const views = createEntityViews(scene);
    const mat = () => (blastMesh(scene)!.material as THREE.MeshStandardMaterial);

    const early = withBlast(1);
    views.sync(early, early, 0);
    expect(mat().opacity).toBeCloseTo(1, 9); // still growing

    // THE ASSERTION THIS TEST EXISTS FOR. The tick right after expansion ends used to be
    // already fading; it must now still be solid, or there is no beat at full size.
    const justHeld = withBlast(MINE_BLAST_EXPAND_TICKS);
    views.sync(justHeld, justHeld, 0);
    expect(mat().opacity).toBeCloseTo(1, 9);

    const stillHeld = withBlast(MINE_BLAST_EXPAND_TICKS + 1);
    views.sync(stillHeld, stillHeld, 0);
    expect(mat().opacity).toBeCloseTo(1, 9);

    // Then it does fade, partway through the hold rather than at the end of it.
    const fading = withBlast(MINE_BLAST_EXPAND_TICKS + MINE_BLAST_HOLD_TICKS - 1);
    views.sync(fading, fading, 0);
    expect(mat().opacity).toBeLessThan(1);
    expect(mat().opacity).toBeGreaterThan(0);

    // And reaches zero exactly as it retires -- the last tick carried to alpha 1. Without
    // this the fireball pops out of existence at a third of its opacity.
    const last = withBlast(MINE_BLAST_EXPAND_TICKS + MINE_BLAST_HOLD_TICKS - 1);
    views.sync(last, last, 1);
    expect(mat().opacity).toBeCloseTo(0, 9);
    views.dispose();
  });

  it('removes the view when the blast retires', () => {
    // stepBlasts drops the blast from the world; a view left behind is a fireball that
    // never goes out.
    const scene = new THREE.Scene();
    const views = createEntityViews(scene);
    const live = withBlast(2);
    views.sync(live, live, 0);
    expect(blastMesh(scene)).toBeDefined();

    const gone = makeWorld(); // no blasts
    views.sync(live, gone, 0);
    expect(blastMesh(scene)).toBeUndefined();
    views.dispose();
  });
});

describe('mine views', () => {
  function withMine(over: Partial<{ timer: number; armed: boolean }>): World {
    const w = makeWorld();
    w.mines.push({
      id: 70, ownerId: 1, pos: { x: 2, y: -3 },
      timer: over.timer ?? MINE_TIMER, armed: over.armed ?? false, detonated: false,
    });
    return w;
  }
  const mineMesh = (scene: THREE.Scene): THREE.Mesh =>
    scene.children.find(
      (c): c is THREE.Mesh => c instanceof THREE.Mesh && c.geometry instanceof THREE.LatheGeometry,
    )!;

  it('is a puck capped by a dome that is WIDE and LOW, not a hemisphere', () => {
    const scene = new THREE.Scene();
    const views = createEntityViews(scene);
    const w = withMine({});
    views.sync(w, w, 0);

    const geo = mineMesh(scene).geometry as THREE.LatheGeometry;
    expect(geo).toBeDefined();
    const pts = geo.parameters.points;
    // Closed on the axis, so the dome has an apex rather than a hole.
    expect(pts[pts.length - 1].x).toBeCloseTo(0, 9);

    const maxR = Math.max(...pts.map((p) => p.x));
    const top = Math.max(...pts.map((p) => p.y));
    const bottom = Math.min(...pts.map((p) => p.y));

    // CURVED ACROSS THE WHOLE TOP. A plain cylinder jumps from full radius to the axis in
    // one step, and a flat top with a rounded rim only bends near the edge. Requiring
    // many intermediate radii spread over the dome's height rejects both.
    const domeStart = pts.filter((p) => p.x > maxR - 1e-9).reduce((m, p) => Math.max(m, p.y), bottom);
    const dome = pts.filter((p) => p.y > domeStart + 1e-9);
    expect(dome.length).toBeGreaterThan(5);
    // Monotonically narrowing as it rises -- an actual dome, not a stack of rims.
    for (let i = 1; i < dome.length; i++) {
      expect(dome[i].x).toBeLessThan(dome[i - 1].x);
      expect(dome[i].y).toBeGreaterThan(dome[i - 1].y);
    }
    // FLATTENED is the whole point: the dome must be much wider than it is tall. A
    // hemisphere would have rise === radius, so this is the assertion that fails if the
    // dome is ever rounded up into a ball.
    const rise = top - domeStart;
    expect(rise).toBeGreaterThan(0);
    expect(rise).toBeLessThan(maxR / 2);

    // The specified split: a third of the height is straight side wall, the dome is the
    // other two thirds. Ratios rather than absolutes, so retuning the puck's overall size
    // does not have to come back here -- but reshaping it does.
    const totalH = top - bottom;
    const sideH = domeStart - bottom;
    expect(sideH / totalH).toBeCloseTo(1 / 3, 2);
    expect(rise / totalH).toBeCloseTo(2 / 3, 2);
    views.dispose();
  });

  it('pulses from the sim timer alone, and faster as the fuse burns down', () => {
    // THE POINT OF THIS TEST: the blink must be a projection of world state, not a clock.
    // Same timer in, same emissive out -- otherwise a paused game keeps flashing and two
    // machines replaying one world disagree.
    const scene = new THREE.Scene();
    const views = createEntityViews(scene);
    const mat = () => (mineMesh(scene).material as THREE.MeshStandardMaterial);

    const sample = (timer: number): number => {
      const w = withMine({ timer, armed: true });
      views.sync(w, w, 0);
      return mat().emissive.r;
    };

    const a = sample(2.0);
    const b = sample(2.0);
    expect(b).toBeCloseTo(a, 12); // deterministic: no wall-clock anywhere in it

    // Count how often the pulse turns over across the first and last thirds of the fuse.
    // Rate, not brightness: a mine that merely got brighter would pass a peak check.
    const crossings = (from: number, to: number): number => {
      let n = 0;
      let prev = sample(from);
      let rising = false;
      for (let i = 1; i <= 60; i++) {
        const t = from + ((to - from) * i) / 60;
        const v = sample(t);
        if (i > 1 && (v > prev) !== rising) n++;
        rising = v > prev;
        prev = v;
      }
      return n;
    };
    const early = crossings(MINE_TIMER, MINE_TIMER * (2 / 3));
    const late = crossings(MINE_TIMER / 3, 0);
    expect(late).toBeGreaterThan(early); // accelerating, not a constant blink
    views.dispose();
  });

  it('keeps armed and unarmed distinguishable at the same point in the fuse', () => {
    // The pulse encodes the fuse; the base colour still has to say whether walking near
    // it will set it off. Sampled at one timer so only `armed` differs.
    const scene = new THREE.Scene();
    const views = createEntityViews(scene);
    const mat = () => (mineMesh(scene).material as THREE.MeshStandardMaterial);

    const idle = withMine({ timer: 1.0, armed: false });
    views.sync(idle, idle, 0);
    const dim = mat().emissive.r;

    const live = withMine({ timer: 1.0, armed: true });
    views.sync(live, live, 0);
    const hot = mat().emissive.r;

    expect(hot).toBeGreaterThan(dim);
    views.dispose();
  });
});
