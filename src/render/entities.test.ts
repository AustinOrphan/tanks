// Three.js builds and transforms its scene graph on the CPU -- only the actual
// draw needs a GL context -- so the sim -> three mapping IS testable headlessly,
// and it is the layer where a silent sign error breaks the whole game while the
// suite stays green.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  createEntityViews, BARREL_OUT, MUZZLE_LEN, HULL_LEN, HULL_WIDTH, TRACK_W, TRACK_SHADE, BULLET_Y,
} from './entities';
import { createWorld, type World } from '../sim/world';
import { ARENAS, createWorldFor } from '../sim/arena';
import type { Tank, Spawn, Bullet, Vec2 } from '../sim/types';
import { blastRadiusAt } from '../sim/mines';
import { MINE_TIMER } from '../sim/constants';
import { BULLET_RADIUS, TANK_RADIUS, SHELL_SPAWN_FORWARD } from '../sim/constants';
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
  let barrel: THREE.Mesh | undefined;
  group.traverse((o) => {
    if (o.name === 'barrel') barrel = o as THREE.Mesh;
  });
  if (!barrel) throw new Error('no barrel mesh');

  // The MUZZLE TIP in world space, not the mesh origin. The barrel is a lathe built in
  // absolute breech-to-muzzle coordinates, so its origin sits at the turret centre --
  // measuring from there gives the tank's own position and no direction at all.
  const pts = (barrel.geometry as THREE.LatheGeometry).parameters.points;
  const tipLocal = new THREE.Vector3(0, Math.max(...pts.map((p) => p.y)), 0);
  const gunPos = barrel.localToWorld(tipLocal);
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
      && Math.abs(c.position.y - BULLET_Y) < 1e-9,
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

  it('flies at the height of the barrel that fires it', () => {
    // BULLET_Y was a hardcoded 0.35 against a barrel centreline at 0.65 -- shells flew
    // a third of a tank's height below the muzzle. The finder above follows BULLET_Y,
    // so it alone cannot see that drift; this compares the shell's height against the
    // barrel's MEASURED world height. Re-hardcoding either side fails here.
    const scene = new THREE.Scene();
    const views = createEntityViews(scene);
    const w = makeWorld();
    w.bullets.push(mkBullet(50, { x: 1, y: 1 }, { x: NORMAL_SPEED, y: 0 }));
    views.sync(w, w, 0);
    scene.updateMatrixWorld(true);

    let barrel: THREE.Object3D | undefined;
    scene.traverse((o) => {
      if (o.name === 'barrel') barrel = o;
    });
    if (!barrel) throw new Error('no barrel in scene');
    // The barrel sits at its turret group's origin, laid along local +x, so its world
    // position IS the centreline the shell must leave along.
    const centreline = new THREE.Vector3();
    barrel.getWorldPosition(centreline);
    expect(shellGroup(scene).position.y).toBeCloseTo(centreline.y, 9);
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
    w.blasts.push({ id: 900, ownerId: 1, credit: { source: 'blast', ownerId: 1 }, pos: { x: 4, y: 6 }, age });
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

describe('tank geometry', () => {
  // Found by NAME, not by geometry class: turret and barrel are both lathes now, so
  // "the first LatheGeometry" would silently pick whichever was added first.
  function part(scene: THREE.Scene, name: string): THREE.Mesh {
    let found: THREE.Mesh | undefined;
    scene.traverse((o) => {
      if (o.name === name) found = o as THREE.Mesh;
    });
    if (!found) throw new Error(`no mesh named ${name}`);
    return found;
  }
  function profile(m: THREE.Mesh): THREE.Vector2[] {
    return (m.geometry as THREE.LatheGeometry).parameters.points;
  }
  function build(): { scene: THREE.Scene; views: ReturnType<typeof createEntityViews> } {
    const scene = new THREE.Scene();
    const views = createEntityViews(scene);
    const w = makeWorld();
    views.sync(w, w, 0);
    return { scene, views };
  }

  it('has a bore WIDER than the shell it fires', () => {
    // THE ASSERTION THIS BLOCK EXISTS FOR. The barrel was radius 0.07 against a shell of
    // BULLET_RADIUS 0.10 -- the round was wider than the tube it came out of. Nothing
    // caught it, because no test related the two numbers.
    const { scene, views } = build();
    const pts = profile(part(scene, 'barrel'));
    // The bore is the barrel's narrow section, i.e. its smallest non-zero radius.
    const bore = Math.min(...pts.map((p) => p.x).filter((x) => x > 1e-9));
    expect(bore).toBeGreaterThan(BULLET_RADIUS);
    expect(bore).toBeGreaterThan(BULLET_RADIUS * 1.15); // with wall thickness to spare
    views.dispose();
  });

  it('flares at the muzzle, and only at the muzzle', () => {
    // The widest point must be at the TIP. A flare in the middle, or a barrel that is
    // one uniform tube, both fail -- and a uniform tube is what this replaced.
    const { scene, views } = build();
    const pts = profile(part(scene, 'barrel'));
    const maxR = Math.max(...pts.map((p) => p.x));
    const bore = Math.min(...pts.map((p) => p.x).filter((x) => x > 1e-9));
    expect(maxR).toBeGreaterThan(bore); // there IS a flare
    const tip = Math.max(...pts.map((p) => p.y));
    // Every point at full radius sits in the last stretch of the barrel.
    const widest = pts.filter((p) => Math.abs(p.x - maxR) < 1e-9);
    for (const p of widest) expect(tip - p.y).toBeLessThanOrEqual(MUZZLE_LEN + 1e-9);
    views.dispose();
  });

  it('keeps the barrel protruding past the turret, whatever the turret size', () => {
    // The barrel is built from the turret radius, not placed absolutely. At a fixed
    // position, growing the turret silently ate the visible gun -- 0.26 to 0.38 cost a
    // third of it. An earlier version of this asserted `> turretR + 0.3`, which the old
    // fixed placement ALSO satisfied at that turret size: it passed the mutation and
    // proved nothing.
    const { scene, views } = build();
    const tip = Math.max(...profile(part(scene, 'barrel')).map((p) => p.y));
    const turretR = Math.max(...profile(part(scene, 'turret')).map((p) => p.x));
    expect(tip - turretR).toBeCloseTo(BARREL_OUT, 9);
    // And the breech is seated INSIDE the turret, or the gun floats off the front.
    const breech = Math.min(...profile(part(scene, 'barrel')).map((p) => p.y));
    expect(breech).toBeGreaterThan(0);
    expect(breech).toBeLessThan(turretR);
    views.dispose();
  });

  it('draws a hull no NARROWER than the circle it collides with', () => {
    // The sim collides tanks as a circle of radius TANK_RADIUS. Nothing here can make
    // that wrong, but it can make it MISLEADING, and it did: the hull was 0.8 wide
    // against a 1.0-diameter circle, so a tank looked like it should fit through gaps
    // that stop it. Asserted against the sim constant, not a literal, so shrinking the
    // hull below its own collider fails rather than merely looking odd.
    // EQUALITY, not a floor. A floor only catches the hull shrinking below its collider;
    // a hull drawn WIDER than the circle lies the opposite way -- it looks like it should
    // be stopped by gaps it slides through -- and would pass a one-sided check silently.
    expect(HULL_WIDTH).toBeCloseTo(TANK_RADIUS * 2, 9);
    expect(HULL_LEN).toBeGreaterThanOrEqual(TANK_RADIUS * 2 * 0.95);
    // And roughly square in plan, which is what makes a circular collider defensible at
    // all -- a long narrow hull would need a different collider, not a different number.
    const ratio = HULL_LEN / HULL_WIDTH;
    expect(ratio).toBeGreaterThan(0.8);
    expect(ratio).toBeLessThan(1.3);
  });

  it('has tracks that read as part of the tank, not as its shadow', () => {
    const scene = new THREE.Scene();
    const views = createEntityViews(scene);
    const w = makeWorld();
    views.sync(w, w, 0);

    // Found by NAME. They were BoxGeometry and are extrusions now; keying on the class
    // meant the whole assertion silently found nothing the moment the shape changed.
    const tracks: THREE.Mesh[] = [];
    scene.traverse((o) => {
      if (o.name === 'track') tracks.push(o as THREE.Mesh);
    });
    expect(tracks).toHaveLength(2);
    expect(tracks[0].position.z).toBeCloseTo(-tracks[1].position.z, 9); // symmetric
    // The tracks run UNDER the hull, so their outer edge sits just inside its width --
    // never outside it, which would put running gear beyond the collision circle.
    const outer = Math.max(...tracks.map((t) => Math.abs(t.position.z))) + TRACK_W / 2;
    expect(outer).toBeLessThanOrEqual(HULL_WIDTH / 2 + 1e-9);
    expect(outer).toBeGreaterThan(HULL_WIDTH / 2 - TRACK_W); // and still near the edge

    // Darker than the paint but not near-black: at 0.45 they read as the tank's own
    // shadow at play distance, which is the whole reason TRACK_SHADE exists.
    expect(TRACK_SHADE).toBeGreaterThan(0.55);
    expect(TRACK_SHADE).toBeLessThan(1);
    views.dispose();
  });

  it('seats the turret ON the hull rather than sinking it in', () => {
    // The dome is CENTRED on the turret group's origin. Placing that origin at the hull
    // top buried 43% of the turret. A little seating is deliberate -- it should look
    // fitted, not balanced -- but it must be a sliver, not half the turret.
    const { scene, views } = build();
    const dome = part(scene, 'turret');
    const hull = part(scene, 'hull');
    scene.updateMatrixWorld(true);

    const pts = profile(dome);
    const domeHalf = (Math.max(...pts.map((p) => p.y)) - Math.min(...pts.map((p) => p.y))) / 2;
    const domeWorld = new THREE.Vector3();
    dome.getWorldPosition(domeWorld);
    hull.geometry.computeBoundingBox();
    const hullTop = hull.geometry.boundingBox!.max.y + hull.position.y;

    const sunk = hullTop - (domeWorld.y - domeHalf);
    expect(sunk).toBeGreaterThan(0); // seated, not floating above the hull
    expect(sunk).toBeLessThan(domeHalf * 0.5); // and nowhere near buried
    views.dispose();
  });

  it('draws the muzzle exactly where the SIM spawns shells', () => {
    // The bug this closes: shells were born at the tank's centre and flew out through
    // the hull, because the render's barrel length and the sim's spawn point were
    // unrelated numbers. Asserted against the sim constant, so re-hardcoding
    // BARREL_OUT fails here instead of showing up as shells appearing out of the
    // turret. (Retuning SHELL_SPAWN_FORWARD stays green -- BARREL_OUT follows it,
    // which is the point.)
    const { scene, views } = build();
    const tip = Math.max(...profile(part(scene, 'barrel')).map((p) => p.y));
    expect(tip).toBeCloseTo(SHELL_SPAWN_FORWARD, 9);
    views.dispose();
  });

  it('has a turret that is round, not a box', () => {
    // A square turret on a square hull is one silhouette at this camera angle; rounding
    // it is what lets you see the turret rotate independently of the body.
    const { scene, views } = build();
    const pts = profile(part(scene, 'turret'));
    expect(pts[0].x).toBeCloseTo(0, 9);
    expect(pts[pts.length - 1].x).toBeCloseTo(0, 9);
    const maxR = Math.max(...pts.map((p) => p.x));
    const top = Math.max(...pts.map((p) => p.y));
    const crown = pts.filter((p) => p.x > 0 && p.x < maxR - 1e-9 && p.y > top - TANK_RADIUS);
    expect(crown.length).toBeGreaterThan(2);
    views.dispose();
  });
});

describe('world replacement (level switch)', () => {
  // Both bugs reported 2026-07-31 live here: wall views were created per id and never
  // removed when an id vanished, nor rebuilt when the same id came back as a DIFFERENT
  // wall. Tanks re-sync per frame, so switching levels showed the OLD level's walls
  // around the NEW level's tanks -- and the sim ran the new walls, so shells and tanks
  // drove through drawn walls and bounced off invisible ones.
  function wallMeshes(scene: THREE.Scene): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    scene.traverse((o) => {
      if (o.name === 'wall') out.push(o as THREE.Mesh);
    });
    return out;
  }
  const centres = (ms: THREE.Mesh[]): string[] =>
    ms.map((m) => `${m.position.x},${m.position.z}`).sort();

  it('draws exactly the NEW world\'s walls after a switch, none of the old', () => {
    const scene = new THREE.Scene();
    const views = createEntityViews(scene);
    const l2 = createWorldFor(ARENAS[1], 1);
    views.sync(l2, l2, 0);
    const l1 = createWorldFor(ARENAS[0], 1);
    views.sync(l1, l1, 0);

    const want = l1.walls
      .filter((w) => !w.destroyed)
      .map((w) => `${(w.aabb.minX + w.aabb.maxX) / 2},${(w.aabb.minY + w.aabb.maxY) / 2}`)
      .sort();
    // Population: every wall of the world now being played, boundaries included.
    expect(centres(wallMeshes(scene))).toEqual(want);
    views.dispose();
  });

  it('rebuilds a tank view whose id changed KIND across worlds', () => {
    // loadArena numbers ids by grid scan, so the same id can be a different kind on a
    // different level. Position re-syncs every frame, but the mesh and colour were
    // built once per id -- a stale view draws the wrong tank.
    const scene = new THREE.Scene();
    const views = createEntityViews(scene);
    const a = makeWorld();
    a.tanks = [makeTank(5, 'brown', 3, 3)];
    views.sync(a, a, 0);
    const b = makeWorld();
    b.tanks = [makeTank(5, 'teal', 3, 3)];
    views.sync(b, b, 0);

    // Reference: what a teal tank looks like when built fresh.
    const refScene = new THREE.Scene();
    const refViews = createEntityViews(refScene);
    const r = makeWorld();
    r.tanks = [makeTank(5, 'teal', 3, 3)];
    refViews.sync(r, r, 0);

    const hullColor = (s: THREE.Scene): number => {
      let c = -1;
      s.traverse((o) => {
        if (o.name === 'hull') c = ((o as THREE.Mesh).material as THREE.MeshStandardMaterial).color.getHex();
      });
      return c;
    };
    expect(hullColor(scene)).toBe(hullColor(refScene));
    views.dispose();
    refViews.dispose();
  });
});

describe('the paint shop (player colour override)', () => {
  it('repaints the PLAYER live on the next sync, and never the enemies', () => {
    const scene = new THREE.Scene();
    const views = createEntityViews(scene);
    const w = makeWorld();
    w.tanks = [makeTank(1, 'player', 3, 3), makeTank(2, 'brown', 7, 7)];
    views.sync(w, w, 0);

    views.setPlayerStyle('#d64545', 'solid', null);
    views.sync(w, w, 0);

    const partColor = (x: number, name: string): number => {
      let c = -1;
      scene.traverse((o) => {
        if (o.name === name) {
          let g: THREE.Object3D | null = o;
          while (g.parent && g.parent.type !== 'Scene') g = g.parent;
          if (g && (g as THREE.Group).position.x === x) {
            c = ((o as THREE.Mesh).material as THREE.MeshStandardMaterial).color.getHex();
          }
        }
      });
      return c;
    };
    // The WHOLE tank repaints, not just the hull: review found a hull-only assertion
    // would pass a player wearing an enemy-coloured turret. Tracks are the shaded
    // derivative of the hull colour, so they prove the derivation follows too.
    expect(partColor(3, 'hull')).toBe(0xd64545);
    expect(partColor(3, 'turret')).toBe(0xd64545);
    expect(partColor(3, 'track')).toBe(new THREE.Color(0xd64545).multiplyScalar(TRACK_SHADE).getHex());
    expect(partColor(7, 'hull')).not.toBe(0xd64545); // brown keeps its identity

    // And back to the roster default.
    views.setPlayerStyle(null, 'solid', null);
    views.sync(w, w, 0);
    let restored = -1;
    scene.traverse((o) => {
      if (o.name === 'hull' && (o.parent as THREE.Group).position.x === 3) {
        restored = ((o as THREE.Mesh).material as THREE.MeshStandardMaterial).color.getHex();
      }
    });
    expect(restored).toBe(0x3d7bd6); // the roster's player blue
    views.dispose();
  });
});

describe('skins (player texture override)', () => {
  const matOf = (scene: THREE.Scene, x: number, name: string): THREE.MeshStandardMaterial => {
    let m: THREE.MeshStandardMaterial | null = null;
    scene.traverse((o) => {
      if (o.name === name) {
        let g: THREE.Object3D | null = o;
        while (g.parent && g.parent.type !== 'Scene') g = g.parent;
        if (g && (g as THREE.Group).position.x === x) {
          m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial;
        }
      }
    });
    if (!m) throw new Error(`no ${name} at x=${x}`);
    return m;
  };

  /**
   * Recover a named mesh's geometry from the scene, so its UVs can be read.
   *
   * Three builds and lays out geometry on the CPU, so this is measurable headlessly --
   * the pie-slice defect this guards was a UV mapping bug, and a UV mapping bug is
   * exactly the class that a green suite cannot see and only a screenshot found.
   */
  const geoOf = (scene: THREE.Scene, x: number, name: string): THREE.BufferGeometry => {
    let g: THREE.BufferGeometry | null = null;
    scene.traverse((o) => {
      if (o.name === name) {
        let root: THREE.Object3D | null = o;
        while (root.parent && root.parent.type !== 'Scene') root = root.parent;
        if (root && (root as THREE.Group).position.x === x) g = (o as THREE.Mesh).geometry;
      }
    });
    if (!g) throw new Error(`no ${name} geometry at x=${x}`);
    return g;
  };

  /**
   * Do all vertices sharing a z coordinate also share a v coordinate?
   *
   * That is precisely what "planar, projected from above" means, and it is the property
   * the stripe skin needs: the stripe is a band in v, so if v is a function of z alone
   * the band runs straight along the barrel. A LatheGeometry's own UVs fail it -- they
   * wrap u around the axis of revolution and run v along the PROFILE -- which is why a
   * hard-edged stripe arrived as pie slices radiating from the turret's centre.
   *
   * Deliberately NOT asserting v === z * k: that would re-derive production's own
   * formula and pass even if the scale were wrong in a way that ruined the look.
   */
  const vIsFunctionOfZ = (geo: THREE.BufferGeometry): boolean => {
    const pos = geo.attributes.position;
    const uv = geo.attributes.uv;
    const byZ = new Map<string, number>();
    for (let i = 0; i < pos.count; i++) {
      const key = pos.getZ(i).toFixed(4);
      const v = uv.getY(i);
      const seen = byZ.get(key);
      if (seen === undefined) byZ.set(key, v);
      else if (Math.abs(seen - v) > 1e-6) return false;
    }
    return true;
  };

  /** How many distinct v values a geometry carries -- 1 means the projection collapsed. */
  const distinctVs = (geo: THREE.BufferGeometry): number => {
    const uv = geo.attributes.uv;
    const seen = new Set<string>();
    for (let i = 0; i < uv.count; i++) seen.add(uv.getY(i).toFixed(4));
    return seen.size;
  };

  it('maps the turret and barrel planar for the STRIPE skin, and only for it', () => {
    // Austin: "Racing stripes pattern on turret is weird like pie slices?" -- confirmed
    // by screenshot, a white pinwheel on the dome while the hull carried clean bands.
    //
    // The fix is deliberately narrow. Austin also said the radial mapping was GOOD on
    // the other skins ("the turret of checkerboard is what I meant with the pinwheel",
    // "I liked the flow skin turret previously"), so every skin except `stripes` keeps
    // the lathe's own wrap. This test pins BOTH halves of that -- a fix applied to all
    // skins would fail the second half.
    //
    // The HULL is deliberately not checked here any more. It used to be, and the
    // property it was checked against -- v is a function of z alone -- was a proxy for
    // "the stripe runs straight along the tank" that only held while the hull was
    // projected flat. The hull's skirt is now unrolled outward (entities.ts's
    // `unrollSkirtUV`), so a flank vertex 0.2 units down carries v = z + 0.2 and the
    // proxy is false while the stripe still runs perfectly straight -- confirmed by
    // render, the striped hull is pixel-unchanged. The property that actually matters
    // for the hull is continuity, and it has its own test below.
    const scene = new THREE.Scene();
    const views = createEntityViews(scene);
    const w = makeWorld();
    w.tanks = [makeTank(1, 'player', 3, 3), makeTank(2, 'brown', 7, 7)];

    views.setPlayerStyle('#3d7bd6', 'stripes', null);
    views.sync(w, w, 0);
    for (const part of ['turret', 'barrel'] as const) {
      const geo = geoOf(scene, 3, part);
      expect(vIsFunctionOfZ(geo), `striped ${part} is not planar`).toBe(true);
      // ...and v must actually MOVE with z. Without this the assertion above passes on a
      // geometry whose v is constant, which is a flat unstriped part -- "a function of
      // z" is satisfied by a constant function, and that is precisely the degenerate
      // case a wrong scale factor would produce.
      expect(distinctVs(geo), `${part}'s stripe UVs are degenerate`).toBeGreaterThan(1);
    }

    for (const skin of ['checker', 'flow', 'camo', 'clouds'] as const) {
      views.setPlayerStyle('#3d7bd6', skin, null);
      views.sync(w, w, 0);
      expect(
        vIsFunctionOfZ(geoOf(scene, 3, 'turret')),
        `${skin} lost the lathe wrap that makes its turret a pinwheel`,
      ).toBe(false);
    }

    // The ENEMY never carries a skin map, so it must never be re-projected either --
    // otherwise the stripe skin would silently re-UV every tank on the board.
    views.setPlayerStyle('#3d7bd6', 'stripes', null);
    views.sync(w, w, 0);
    expect(vIsFunctionOfZ(geoOf(scene, 7, 'turret')), 'an enemy turret was re-projected').toBe(false);
  });

  /**
   * The hull's UV must be a CONTINUOUS FUNCTION OF POSITION -- which is exactly Austin's
   * "the hull should be distinctly one piece", stated so a machine can check it.
   *
   * ExtrudeGeometry is non-indexed, so the ring of positions where the top cap meets the
   * bevel, and where the bevel meets the side wall, exists several times over with a
   * different UV each. If those copies disagree, the texture jumps at that edge and the
   * hull reads as panels. If they agree everywhere, there is one unbroken surface.
   *
   * Measured on the shipped hull: 0.000000 with the projection, against 1.472500 with
   * ExtrudeGeometry's own UVs. The mutation that kills this is deleting the
   * `if (mapped) projectBodyUV(bodyGeo)` call -- verified by doing it.
   */
  const maxCoincidentUvGap = (geo: THREE.BufferGeometry): number => {
    const pos = geo.attributes.position;
    const uv = geo.attributes.uv;
    const seen = new Map<string, [number, number]>();
    let worst = 0;
    for (let i = 0; i < pos.count; i++) {
      const key = `${pos.getX(i).toFixed(5)},${pos.getY(i).toFixed(5)},${pos.getZ(i).toFixed(5)}`;
      const here: [number, number] = [uv.getX(i), uv.getY(i)];
      const first = seen.get(key);
      if (!first) seen.set(key, here);
      else worst = Math.max(worst, Math.abs(first[0] - here[0]), Math.abs(first[1] - here[1]));
    }
    return worst;
  };

  it('gives the hull ONE continuous surface, for every skin', () => {
    const scene = new THREE.Scene();
    const views = createEntityViews(scene);
    const w = makeWorld();
    w.tanks = [makeTank(1, 'player', 3, 3), makeTank(2, 'brown', 7, 7)];

    for (const skin of ['stripes', 'checker', 'flow', 'camo', 'clouds'] as const) {
      views.setPlayerStyle('#3d7bd6', skin, null);
      views.sync(w, w, 0);
      expect(
        maxCoincidentUvGap(geoOf(scene, 3, 'hull')),
        `${skin}'s hull is split at an edge -- it will render as panels`,
      ).toBeLessThan(1e-6);
    }

    // The negative control, and the reason the threshold above means anything: the
    // enemy hull carries no skin map and is left with ExtrudeGeometry's own UVs, which
    // fail the same check by six orders of magnitude. Without this the assertion could
    // be passing because the metric is broken rather than because the hull is whole.
    expect(
      maxCoincidentUvGap(geoOf(scene, 7, 'hull')),
      'the default extrude UVs suddenly look continuous -- is the metric wired?',
    ).toBeGreaterThan(1);
  });

  it('leaves the turret geometry EXACTLY as it was, which is what Austin asked for', () => {
    // "The turret looks great on flow and checkerplate so don't change the turret."
    //
    // Rebuilt here from the profile as it stands, and compared against the mesh the tank
    // is actually wearing, attribute by attribute. This is the strongest form of the
    // claim available headlessly: same positions, same normals, same UVs means the dome
    // cannot render differently, whatever changed around it.
    //
    // It fails if anyone projects the turret for a non-stripe skin -- the obvious
    // "fix it everywhere" generalisation of the hull change, and the one thing here
    // Austin explicitly ruled out.
    const scene = new THREE.Scene();
    const views = createEntityViews(scene);
    const w = makeWorld();
    w.tanks = [makeTank(1, 'player', 3, 3)];

    const half = 0.28 / 2;
    const R = 0.36;
    const FILLET = 0.09;
    const pts = [
      new THREE.Vector2(0, -half),
      new THREE.Vector2(R, -half),
      new THREE.Vector2(R, half - FILLET),
    ];
    for (let i = 1; i <= 5; i++) {
      const a = (i / 5) * (Math.PI / 2);
      pts.push(new THREE.Vector2(
        R - FILLET + FILLET * Math.cos(a),
        half - FILLET + FILLET * Math.sin(a),
      ));
    }
    pts.push(new THREE.Vector2(0, half));
    const reference = new THREE.LatheGeometry(pts, 20);

    for (const skin of ['checker', 'flow', 'camo', 'clouds'] as const) {
      views.setPlayerStyle('#3d7bd6', skin, null);
      views.sync(w, w, 0);
      const dome = geoOf(scene, 3, 'turret');
      for (const attr of ['position', 'normal', 'uv'] as const) {
        expect(
          Array.from(dome.attributes[attr].array),
          `${skin} moved the turret's ${attr}`,
        ).toEqual(Array.from(reference.attributes[attr].array));
      }
    }
  });

  it('paints the barrel at the TURRET\'s texel density, so the two mesh', () => {
    // Austin: "just change the barrel skin so it meshes with the existing turret
    // appearances of those skins."
    //
    // Both parts are lathes, and LatheGeometry normalises u to one full texture repeat
    // around the circumference WHATEVER that circumference is. The turret is 2*PI*0.36 =
    // 2.26 world units around and the barrel tube 2*PI*0.13 = 0.82, so the same tile was
    // packed 2.8x tighter on the gun -- flow's soft swirl arrived there as fine corduroy.
    //
    // Asserted as a RATIO of world densities rather than against the literal 0.361, so
    // it keeps meaning the right thing if TURRET_R or BARREL_R is retuned. The mutation
    // that kills it is dropping the matchLatheToTurret call, which sends the ratio to
    // 2.77 -- verified by doing it.
    const scene = new THREE.Scene();
    const views = createEntityViews(scene);
    const w = makeWorld();
    w.tanks = [makeTank(1, 'player', 3, 3), makeTank(2, 'brown', 7, 7)];
    views.setPlayerStyle('#3d7bd6', 'checker', null);
    views.sync(w, w, 0);

    /** Texture repeats per world unit, around the part's circumference. */
    const uDensity = (geo: THREE.BufferGeometry): number => {
      const pos = geo.attributes.position;
      const uv = geo.attributes.uv;
      let lo = Infinity;
      let hi = -Infinity;
      let maxR = 0;
      for (let i = 0; i < uv.count; i++) {
        lo = Math.min(lo, uv.getX(i));
        hi = Math.max(hi, uv.getX(i));
        maxR = Math.max(maxR, Math.hypot(pos.getX(i), pos.getZ(i)));
      }
      return (hi - lo) / (2 * Math.PI * maxR);
    };

    const turret = uDensity(geoOf(scene, 3, 'turret'));
    const barrel = uDensity(geoOf(scene, 3, 'barrel'));
    // The barrel's widest radius is the muzzle flare (BARREL_R * 1.40), not the tube the
    // scale is set from, so the matched density lands a shade UNDER the turret's rather
    // than exactly on it. 0.71 is that ratio; the point is that it is near 1 and nowhere
    // near the 2.77 an unscaled lathe gives.
    expect(barrel / turret).toBeGreaterThan(0.6);
    expect(barrel / turret).toBeLessThan(1.05);

    // The enemy is the control: untouched, it shows the defect this test describes.
    const bare = uDensity(geoOf(scene, 7, 'barrel')) / uDensity(geoOf(scene, 7, 'turret'));
    expect(bare, 'an unmapped barrel should still carry the raw lathe wrap').toBeGreaterThan(1.9);
  });

  it('puts the barrel\'s UV seam underneath, where the camera never looks', () => {
    // Scaling u to a fraction of a repeat means it no longer meets itself where the
    // lathe closes, so there is a seam. BARREL_SEAM_PHI rotates the lathe by exactly 4
    // of its 16 segments -- a relabelling that leaves the surface identical -- to put
    // that seam on the gun's underside.
    //
    // Checked in the barrel's LOCAL frame, then through the mesh's own rotation, so it
    // is the seam's real world direction being asserted and not a coordinate convention.
    const scene = new THREE.Scene();
    const views = createEntityViews(scene);
    const w = makeWorld();
    w.tanks = [makeTank(1, 'player', 3, 3)];
    views.setPlayerStyle('#3d7bd6', 'checker', null);
    views.sync(w, w, 0);

    let barrel: THREE.Mesh | null = null;
    scene.traverse((o) => { if (o.name === 'barrel') barrel = o as THREE.Mesh; });
    const mesh = barrel!;
    const geo = mesh.geometry;
    const pos = geo.attributes.position;
    const uv = geo.attributes.uv;

    // The seam is the u = 0 meridian. Take its vertices at a real radius (skip the two
    // poles, which sit on the axis and have no direction) and average which way they
    // face. It is the RADIAL part that carries the seam's direction -- a lathe vertex's
    // full position is mostly its distance ALONG the gun, which would swamp the signal
    // and read as -0.36 for a seam that is in fact pointing straight down.
    let sumY = 0;
    let n = 0;
    for (let i = 0; i < uv.count; i++) {
      if (uv.getX(i) > 1e-9) continue;
      const radial = new THREE.Vector3(pos.getX(i), 0, pos.getZ(i));
      if (radial.length() < 1e-6) continue; // on the lathe axis
      radial.normalize().applyEuler(mesh.rotation);
      sumY += radial.y;
      n++;
    }
    expect(n, 'no off-axis seam vertices found -- is the probe wired?').toBeGreaterThan(0);
    // -1 is straight down. Anything above 0 would put the seam on the visible top.
    expect(sumY / n).toBeLessThan(-0.99);
  });

  it('dresses hull AND turret in the map, leaves tracks solid and enemies bare', () => {
    const scene = new THREE.Scene();
    const views = createEntityViews(scene);
    const w = makeWorld();
    w.tanks = [makeTank(1, 'player', 3, 3), makeTank(2, 'brown', 7, 7)];
    views.setPlayerStyle('#d64545', 'camo', null);
    views.sync(w, w, 0);

    // Mapped parts go WHITE so the map's own tint is not multiplied twice.
    expect(matOf(scene, 3, 'hull').map).not.toBeNull();
    expect(matOf(scene, 3, 'hull').color.getHex()).toBe(0xffffff);
    expect(matOf(scene, 3, 'turret').map).not.toBeNull();
    expect(matOf(scene, 3, 'turret').color.getHex()).toBe(0xffffff);
    // Tracks stay the solid shaded derivative of the chosen hex (design decision).
    expect(matOf(scene, 3, 'track').map).toBeNull();
    expect(matOf(scene, 3, 'track').color.getHex()).toBe(
      new THREE.Color(0xd64545).multiplyScalar(TRACK_SHADE).getHex(),
    );
    // The enemy keeps its identity: no map, roster colour.
    expect(matOf(scene, 7, 'hull').map).toBeNull();

    // Back to solid: the map comes OFF and the tint returns to the material.
    views.setPlayerStyle('#d64545', 'solid', null);
    views.sync(w, w, 0);
    expect(matOf(scene, 3, 'hull').map).toBeNull();
    expect(matOf(scene, 3, 'hull').color.getHex()).toBe(0xd64545);
    views.dispose();
  });

  it('flow drifts its texture offset with dt; a static skin does not', () => {
    const scene = new THREE.Scene();
    const views = createEntityViews(scene);
    const w = makeWorld();
    w.tanks = [makeTank(1, 'player', 3, 3)];

    views.setPlayerStyle(null, 'flow', null);
    views.sync(w, w, 0, 0.5);
    const flowMap = matOf(scene, 3, 'hull').map as THREE.Texture;
    // 0.08 repeats/s (the skin def's scroll.u) over 0.5s of dt.
    expect(flowMap.offset.x).toBeCloseTo(0.04, 6);
    expect(flowMap.offset.y).toBe(0);
    views.sync(w, w, 0); // dt omitted: animation frozen, offset holds
    expect(flowMap.offset.x).toBeCloseTo(0.04, 6);

    views.setPlayerStyle(null, 'camo', null);
    views.sync(w, w, 0, 0.5);
    const camoMap = matOf(scene, 3, 'hull').map as THREE.Texture;
    expect(camoMap.offset.x).toBe(0); // no scroll in the def, no drift
    views.dispose();
  });

  it('a respawn keeps the SAME live texture: death must not dispose the skin', () => {
    // disposeObject deliberately skips material maps; if it ever starts disposing
    // them, the player's skin dies with the player and every respawn wears a
    // disposed (blank) texture. This pins the respawn path directly.
    const scene = new THREE.Scene();
    const views = createEntityViews(scene);
    const alive = makeWorld();
    alive.tanks = [makeTank(1, 'player', 3, 3)];
    const dead = makeWorld();
    dead.tanks = [];
    views.setPlayerStyle(null, 'camo', null);
    views.sync(alive, alive, 0);
    const worn = matOf(scene, 3, 'hull').map as THREE.Texture;
    let disposed = 0;
    worn.addEventListener('dispose', () => disposed++);
    views.sync(dead, dead, 0); // death: the view is swept
    views.sync(alive, alive, 0); // respawn: rebuilt view
    expect(matOf(scene, 3, 'hull').map).toBe(worn); // same texture object, not a remint
    expect(disposed).toBe(0); // and it was never disposed in between
    views.dispose();
  });

  it('restyling and dispose() both release the owned skin texture', () => {
    const scene = new THREE.Scene();
    const views = createEntityViews(scene);
    const w = makeWorld();
    w.tanks = [makeTank(1, 'player', 3, 3)];
    views.setPlayerStyle(null, 'camo', null);
    views.sync(w, w, 0);
    const first = matOf(scene, 3, 'hull').map as THREE.Texture;
    let disposed = 0;
    first.addEventListener('dispose', () => disposed++);
    views.setPlayerStyle(null, 'checker', null); // replaces the map -> old one must go
    expect(disposed).toBe(1);
    views.sync(w, w, 0);
    const second = matOf(scene, 3, 'hull').map as THREE.Texture;
    let disposed2 = 0;
    second.addEventListener('dispose', () => disposed2++);
    views.dispose();
    expect(disposed2).toBe(1);
  });
});
