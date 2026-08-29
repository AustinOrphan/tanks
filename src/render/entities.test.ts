// Three.js builds and transforms its scene graph on the CPU -- only the actual
// draw needs a GL context -- so the sim -> three mapping IS testable headlessly,
// and it is the layer where a silent sign error breaks the whole game while the
// suite stays green.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  createEntityViews, BARREL_OUT, MUZZLE_LEN, HULL_LEN, HULL_WIDTH, TRACK_W, TRACK_SHADE, BULLET_Y,
  STRIPE_TURRET_MODE, IDENTITY_RING_COLORS, IDENTITY_RING_INNER_R, IDENTITY_RING_OUTER_R,
  TEAM_COLORS,
} from './entities';
import { createWorld, type World } from '../sim/world';
import { ARENAS, createWorldFor } from '../sim/arena';
import type { Tank, Spawn, Bullet, Vec2 } from '../sim/types';
import { blastRadiusAt } from '../sim/mines';
import { MINE_TIMER } from '../sim/constants';
import { BULLET_RADIUS, TANK_RADIUS, SHELL_SPAWN_FORWARD, SHELL_MUZZLE_FORWARD } from '../sim/constants';
import { NORMAL_SPEED, MINE_BLAST_RADIUS, MINE_BLAST_EXPAND_TICKS, MINE_BLAST_HOLD_TICKS } from '../sim/constants';
import { RESPAWN_SHIELD_TICKS } from '../sim/constants';
import { configFor } from '../sim/config';
import { TANK_KINDS } from '../sim/config/validate';
import { createSkinTexture } from './skins';
import { createDeathPulseSystem } from './death-pulse';

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

  it('draws the muzzle opening exactly at the SIM muzzle plane', () => {
    // The bug this closes: shells were born at the tank's centre and flew out through
    // the hull, because the render's barrel length and the sim's spawn point were
    // unrelated numbers. Asserted against the sim constant, so re-hardcoding
    // BARREL_OUT fails here instead of showing up as shells appearing out of the
    // turret. (Retuning SHELL_MUZZLE_FORWARD stays green -- BARREL_OUT follows it,
    // which is the point.)
    //
    // The PLANE, not SHELL_SPAWN_FORWARD (issue #237): the spawn is now one bullet-radius
    // behind the opening, so deriving the drawn barrel from it would shorten the gun by
    // exactly that radius. Swapping this symbol back to SHELL_SPAWN_FORWARD is the
    // regression, and it fails here.
    const { scene, views } = build();
    const tip = Math.max(...profile(part(scene, 'barrel')).map((p) => p.y));
    expect(tip).toBeCloseTo(SHELL_MUZZLE_FORWARD, 9);
    views.dispose();
  });

  it('starts the shell nose flush with the drawn muzzle opening, not past it', () => {
    // Issue #237's headline, as a render/sim coupling rather than as two constants that
    // happen to agree today. The shell is drawn as a sphere of BULLET_RADIUS centred on
    // the sim's spawn point, so its nose reaches SHELL_SPAWN_FORWARD + BULLET_RADIUS.
    // That has to land on the barrel tip: further out is the daylight pop this issue
    // exists to remove, further in is a shell born inside the gun.
    //
    // Negative control -- this fails if shellSpawnForward stops subtracting the radius
    // (nose lands a radius past the tip) and if it subtracts the wrong radius. It is the
    // only assertion in the tree that ties the inset's SIZE to the drawn geometry;
    // everything else in bullets.test.ts refers to SHELL_SPAWN_FORWARD symbolically and
    // therefore holds for any inset at all, including zero.
    const { scene, views } = build();
    const tip = Math.max(...profile(part(scene, 'barrel')).map((p) => p.y));
    expect(SHELL_SPAWN_FORWARD + BULLET_RADIUS).toBeCloseTo(tip, 9);
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

    // TRACKS, not the hull -- issue #137 made every hull material white (the map
    // carries the tint now, entities.ts's `matColor`), so a hull-colour comparison
    // stopped discriminating kinds at all: brown and teal both read 0xffffff, and this
    // test kept passing even with the kind-change rebuild guard disabled (verified by
    // mutation before this fix -- a stale brown view is ALSO white). Tracks stay
    // unmapped and keep each kind's own shaded colour, so they are still a real
    // discriminator.
    const trackColor = (s: THREE.Scene): number => {
      let c = -1;
      s.traverse((o) => {
        if (o.name === 'track') c = ((o as THREE.Mesh).material as THREE.MeshStandardMaterial).color.getHex();
      });
      return c;
    };
    expect(trackColor(scene)).toBe(trackColor(refScene));

    // And the hull's MAP now carries the identity that used to live in its colour --
    // this is the new discriminator issue #137 introduced, checked directly rather
    // than assumed from the track alone.
    const hullMap = (s: THREE.Scene): THREE.DataTexture => {
      let t: THREE.DataTexture | null = null;
      s.traverse((o) => {
        if (o.name === 'hull') t = ((o as THREE.Mesh).material as THREE.MeshStandardMaterial).map as THREE.DataTexture;
      });
      if (!t) throw new Error('no hull map found');
      return t;
    };
    expect(Array.from(hullMap(scene).image.data)).toEqual(Array.from(hullMap(refScene).image.data));

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
    const partMap = (x: number, name: string): THREE.Texture | null => {
      let m: THREE.Texture | null = null;
      scene.traverse((o) => {
        if (o.name === name) {
          let g: THREE.Object3D | null = o;
          while (g.parent && g.parent.type !== 'Scene') g = g.parent;
          if (g && (g as THREE.Group).position.x === x) {
            m = ((o as THREE.Mesh).material as THREE.MeshStandardMaterial).map;
          }
        }
      });
      return m;
    };
    // Captured BEFORE the restyle: the enemy's own two-tone map (issue #137) and its
    // track colour, both of which the "never the enemies" half below now has to prove
    // are untouched by a PLAYER-only restyle.
    const enemyMapBefore = partMap(7, 'hull');
    const enemyTrackBefore = partColor(7, 'track');
    expect(enemyMapBefore).not.toBeNull();

    views.setPlayerStyle('#d64545', 'solid', null);
    views.sync(w, w, 0);

    // The WHOLE tank repaints, not just the hull: review found a hull-only assertion
    // would pass a player wearing an enemy-coloured turret. Tracks are the shaded
    // derivative of the hull colour, so they prove the derivation follows too.
    expect(partColor(3, 'hull')).toBe(0xd64545);
    expect(partColor(3, 'turret')).toBe(0xd64545);
    expect(partColor(3, 'track')).toBe(new THREE.Color(0xd64545).multiplyScalar(TRACK_SHADE).getHex());
    // "brown keeps its identity": since issue #137, `partColor(7, 'hull')` is ALWAYS
    // 0xffffff -- every enemy is mapped now (`enemySkinMapFor`), and a mapped material's
    // colour is unconditionally forced white (entities.ts's `matColor`), regardless of
    // whether the player's restyle leaked onto the enemy. So a hull-colour comparison
    // against the player's red can no longer discriminate "untouched" from "repainted"
    // -- it would read the same either way. The track colour and the hull's own map
    // identity are what still separate the two, and are asserted directly here rather
    // than inferred from colour.
    expect(partColor(7, 'track')).toBe(enemyTrackBefore);
    expect(partMap(7, 'hull')).toBe(enemyMapBefore);

    // And back to the roster default. partColor walks to the top tank group (past the
    // spawn-anim `visual` group), so it is robust to the scene-graph depth the
    // visual-group split added; the old inline `o.parent.position.x === 3` check assumed
    // the hull's DIRECT parent was the tank group, which the split made false.
    views.setPlayerStyle(null, 'solid', null);
    views.sync(w, w, 0);
    expect(partColor(3, 'hull')).toBe(0x3d7bd6); // the roster's player blue
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
    // The design feedback: "Racing stripes pattern on turret is weird like pie slices?" --
    // confirmed by screenshot, a white pinwheel on the dome while the hull carried clean bands.
    //
    // The fix is deliberately narrow. The same feedback also said the radial mapping was GOOD on
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
    // render. NOT pixel-unchanged, which an earlier draft of this comment claimed: at
    // the time of that claim 192 of 630,000 pixels differed, all of them antialiasing
    // along the stripe edges on the hull's shoulders. "Visually unchanged" is what the
    // evidence supports, and the hull has since changed deliberately anyway, because
    // STRIPE_TURRET_MODE is now 'body'. The property that actually matters
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

    // The ENEMY carries a skin map now too (`two-tone`, issue #137) but its resolved
    // skin is never `stripes` -- only the player can choose that -- so it must still
    // never be planar-re-projected, or the stripe skin would silently re-UV every tank
    // on the board the moment the player wore it. This is `striped`'s KIND-independence
    // proven directly: entities.ts keys `striped` on the tank's own resolved skin, and
    // an enemy's resolved skin is always `two-tone`.
    views.setPlayerStyle('#3d7bd6', 'stripes', null);
    views.sync(w, w, 0);
    expect(vIsFunctionOfZ(geoOf(scene, 7, 'turret')), 'an enemy turret was re-projected').toBe(false);
  });

  /**
   * The hull's UV must be a CONTINUOUS FUNCTION OF POSITION -- which is exactly the design
   * ruling's "the hull should be distinctly one piece", stated so a machine can check it.
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

  it('gives the hull ONE continuous surface, for every skin -- the player\'s and the enemy\'s', () => {
    const scene = new THREE.Scene();
    const views = createEntityViews(scene);
    const w = makeWorld();
    w.tanks = [makeTank(1, 'player', 3, 3), makeTank(2, 'brown', 7, 7)];

    for (const skin of ['stripes', 'checker', 'flow', 'camo', 'clouds', 'two-tone'] as const) {
      views.setPlayerStyle('#3d7bd6', skin, null);
      views.sync(w, w, 0);
      expect(
        maxCoincidentUvGap(geoOf(scene, 3, 'hull')),
        `${skin}'s hull is split at an edge -- it will render as panels`,
      ).toBeLessThan(1e-6);
    }

    // The ENEMY is mapped too now (`two-tone`, issue #137), so its hull gets the exact
    // same continuous treatment as the player's -- it is no longer the negative control
    // it used to be, and this is the assertion that would catch a regression there:
    // deleting `enemySkinMapFor`'s wiring (entities.ts) makes `mapped` false again for
    // every enemy and this fails the same way the old unmapped hull did.
    expect(
      maxCoincidentUvGap(geoOf(scene, 7, 'hull')),
      "the enemy hull is split at an edge -- it will render as panels",
    ).toBeLessThan(1e-6);

    // The negative control, and the reason the thresholds above mean anything. It can
    // no longer come from an enemy tank -- every kind carries a map now -- so this uses
    // the one skin that is still unmapped: the PLAYER wearing `solid`, whose
    // `createSkinTexture` returns null (skins.ts). Left with ExtrudeGeometry's own UVs,
    // it fails the same check by six orders of magnitude. Without this the assertions
    // above could be passing because the metric is broken rather than because the hulls
    // are whole.
    views.setPlayerStyle('#3d7bd6', 'solid', null);
    views.sync(w, w, 0);
    expect(
      maxCoincidentUvGap(geoOf(scene, 3, 'hull')),
      'the default extrude UVs suddenly look continuous -- is the metric wired?',
    ).toBeGreaterThan(1);
  });

  /**
   * Texel density per triangle: UV area divided by world area, in repeats^2 per unit^2.
   *
   * 1.0 means the texture is drawn at its authored size. Near 0 means the triangle has
   * been squashed to nothing in UV space and its texture is smeared across it.
   */
  const triangleDensities = (geo: THREE.BufferGeometry, minNy: number, maxNy: number): number[] => {
    const pos = geo.attributes.position;
    const nrm = geo.attributes.normal;
    const uv = geo.attributes.uv;
    const out: number[] = [];
    for (let t = 0; t < pos.count; t += 3) {
      const ny = (nrm.getY(t) + nrm.getY(t + 1) + nrm.getY(t + 2)) / 3;
      if (ny < minNy || ny > maxNy) continue;
      const ax = pos.getX(t + 1) - pos.getX(t), ay = pos.getY(t + 1) - pos.getY(t), az = pos.getZ(t + 1) - pos.getZ(t);
      const bx = pos.getX(t + 2) - pos.getX(t), by = pos.getY(t + 2) - pos.getY(t), bz = pos.getZ(t + 2) - pos.getZ(t);
      const world = 0.5 * Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx);
      if (world < 1e-9) continue;
      const au = uv.getX(t + 1) - uv.getX(t), av = uv.getY(t + 1) - uv.getY(t);
      const bu = uv.getX(t + 2) - uv.getX(t), bv = uv.getY(t + 2) - uv.getY(t);
      out.push(Math.abs(au * bv - av * bu) * 0.5 / world);
    }
    return out;
  };

  it('unrolls the hull SKIRT, so the sides carry the pattern at its true size', () => {
    // THE HALF OF THE HULL FIX THAT NOTHING ELSE PINS, and it took two attempts to get
    // right, so it gets its own test. Projecting the body from above alone leaves the
    // skirt continuous but DEGENERATE: a near-vertical wall has almost no extent when
    // projected onto the ground plane, so its whole height collapses onto the single
    // line of texels at the hull's outline and renders as vertical smears -- checker
    // became columns instead of squares, camo a picket fence.
    //
    // The continuity test above cannot see this, by construction: a collapsed skirt is
    // perfectly continuous. Neither can it see the unroll being applied INWARD. Both of
    // those mutations left the whole suite green before this test existed.
    //
    // Two properties, stating different halves of the claim -- the skirt is drawn at the
    // right SIZE, and it is folded the right WAY:
    //
    //   density  the side walls must be drawn at roughly the authored texel size.
    //   outward  the UV footprint must be BIGGER than the hull's plan footprint, by
    //            about the body's height on each side, because that is what unrolling a
    //            skirt outward does.
    //
    // An earlier version of this comment claimed a division of labour -- that density
    // catches the zeroed drop and outward catches the reversal, "because no single one
    // catches both". That is FALSE. Measured by disarming each assertion in turn and
    // running the other; population: 3 mutations x 2 assertions, all 6 cells run.
    //
    //                        density (> 0.5)    outward (> 0.3)
    //     drop = 0               0.0000  fail      0.0000  fail
    //     drop reversed          0.1048  fail     -0.0205  fail
    //     drop x 0.6             0.6010  PASS      0.2236  fail
    //
    // So the real division of labour is the other way round from the one claimed:
    // `outward` is the load-bearing one. It catches a partial unroll -- the skirt folded
    // the right way but not far enough -- which density passes, because density only
    // asserts a lower bound and 0.6 clears it.
    //
    // `density` is NOT proven load-bearing by this sweep: no mutation was found that it
    // catches and `outward` misses. It is kept because it states the size half of the
    // claim directly, and because an over-unroll (drop scaled UP) passes both -- a gap
    // neither assertion closes, since both are lower bounds.
    const scene = new THREE.Scene();
    const views = createEntityViews(scene);
    const w = makeWorld();
    w.tanks = [makeTank(1, 'player', 3, 3), makeTank(2, 'brown', 7, 7)];
    views.setPlayerStyle('#3d7bd6', 'checker', null);
    views.sync(w, w, 0);
    const hull = geoOf(scene, 3, 'hull');

    // Side walls only: |normal.y| small. The caps are excluded because a cap is exactly
    // the flat projection and would pass trivially.
    const walls = triangleDensities(hull, -0.3, 0.3);
    expect(walls.length, 'no side-wall triangles found -- is the probe wired?').toBeGreaterThan(20);
    const worst = Math.min(...walls);
    // Measured 1.000 on every side-wall triangle: an unrolled skirt is an isometry, so
    // its texel density is exactly the top face's. Zeroing the drop measures 0.000.
    expect(worst, 'the hull skirt is squashed in UV -- it will render as vertical smears')
      .toBeGreaterThan(0.5);

    const pos = hull.attributes.position;
    const uv = hull.attributes.uv;
    let planX = 0;
    let uvU = 0;
    for (let i = 0; i < pos.count; i++) {
      planX = Math.max(planX, Math.abs(pos.getX(i)));
      uvU = Math.max(uvU, Math.abs(uv.getX(i)));
    }
    // The body is TANK_BODY_H (0.4) deep, so unrolling adds that much beyond the plan at
    // the nose and tail. Measured: plan half-length 0.500, u half-extent 0.900.
    expect(uvU - planX, 'the skirt is not unrolled OUTWARD past the hull outline')
      .toBeGreaterThan(0.3);
  });

  it('keeps the hull\'s u axis running along the tank', () => {
    // `projectPlanarUV`'s `along` argument used to be documented as carrying no pattern
    // information, on the grounds that the stripe painter ignores u. That stopped being
    // true the moment the hull was projected for EVERY skin: u is now where checker's
    // squares, camo's patches and flow's bands read their position along the tank from.
    // Collapsing it (`get(i, along) * 0`) turns the checker hull into horizontal bands
    // and left the entire suite green.
    const scene = new THREE.Scene();
    const views = createEntityViews(scene);
    const w = makeWorld();
    w.tanks = [makeTank(1, 'player', 3, 3)];

    for (const skin of ['checker', 'flow', 'camo', 'clouds', 'stripes'] as const) {
      views.setPlayerStyle('#3d7bd6', skin, null);
      views.sync(w, w, 0);
      const hull = geoOf(scene, 3, 'hull');
      const pos = hull.attributes.position;
      const uv = hull.attributes.uv;
      let lo = Infinity;
      let hi = -Infinity;
      // u must MOVE with x, not merely vary: a u that tracked z would also have extent.
      let sumXU = 0;
      let sumXX = 0;
      for (let i = 0; i < uv.count; i++) {
        lo = Math.min(lo, uv.getX(i));
        hi = Math.max(hi, uv.getX(i));
        sumXU += pos.getX(i) * uv.getX(i);
        sumXX += pos.getX(i) * pos.getX(i);
      }
      // Slope of u against x through the origin. 1.0 is "u IS the length coordinate".
      expect(sumXU / sumXX, `${skin}'s hull u no longer tracks the tank's length`)
        .toBeGreaterThan(0.8);
      expect(hi - lo, `${skin}'s hull u has collapsed`).toBeGreaterThan(HULL_LEN * 0.9);
    }
  });

  it('runs ONE stripe field across the whole tank, at a single width', () => {
    // STRIPE_TURRET_MODE is 'body' -- the verdict, having seen both rendered: "I like
    // continuous stripes actually." Nothing outside entities.ts referred to it, so the
    // shipped choice was pinned by nothing and the rejected mode exercised by nothing.
    //
    // Asserted through the BEHAVIOUR rather than the constant: every part must carry the
    // stripe at the same world width, which is what 'body' means and what 'part'
    // (0.084 / 0.069 / 0.025 on hull / turret / barrel) fails.
    const scene = new THREE.Scene();
    const views = createEntityViews(scene);
    const w = makeWorld();
    w.tanks = [makeTank(1, 'player', 3, 3)];
    views.setPlayerStyle('#3d7bd6', 'stripes', null);
    views.sync(w, w, 0);

    /**
     * Repeats of v per world unit across the part -- so 1 means "the stripe is drawn at
     * the width the painter authored".
     *
     * `minNy` restricts which vertices count, and the hull NEEDS it: its skirt is
     * unrolled, which deliberately pushes v beyond z and inflates the slope. Measuring
     * the hull's TOP CAP alone (normal.y > 0.999, where the drop is zero) isolates the
     * flat projection, which is the thing being compared across parts. Signed, not
     * absolute: the bottom cap's outer ring carries the full body height of offset and
     * inflates the slope to 1.364 if it is let in. The turret and barrel are not
     * unrolled, so every one of their vertices is already in that space.
     */
    const vScale = (geo: THREE.BufferGeometry, minNy: number): number => {
      const pos = geo.attributes.position;
      const nrm = geo.attributes.normal;
      const uv = geo.attributes.uv;
      let sumAV = 0;
      let sumAA = 0;
      for (let i = 0; i < uv.count; i++) {
        if (nrm.getY(i) < minNy) continue;
        const a = pos.getZ(i);
        sumAV += a * uv.getY(i);
        sumAA += a * a;
      }
      return sumAV / sumAA;
    };

    const hull = vScale(geoOf(scene, 3, 'hull'), 0.999);
    const turret = vScale(geoOf(scene, 3, 'turret'), -1);
    const barrel = vScale(geoOf(scene, 3, 'barrel'), -1);
    expect(hull).toBeCloseTo(1, 5);
    expect(turret, 'the turret stripe is scaled to the turret, not to the tank').toBeCloseTo(1, 5);
    expect(barrel, 'the barrel stripe is scaled to the barrel, not to the tank').toBeCloseTo(1, 5);
    expect(STRIPE_TURRET_MODE).toBe('body');
  });

  it('leaves the turret geometry EXACTLY as it was, which is what the design feedback asked for', () => {
    // "The turret looks great on flow and checkerplate so don't change the turret."
    //
    // Rebuilt here from the profile as it stands, and compared against the mesh the tank
    // is actually wearing, attribute by attribute. This is the strongest form of the
    // claim available headlessly: same positions, same normals, same UVs means the dome
    // cannot render differently, whatever changed around it.
    //
    // It fails if anyone projects the turret for a non-stripe skin -- the obvious
    // "fix it everywhere" generalisation of the hull change, and the one thing here
    // was explicitly ruled out.
    //
    // The three literals below DUPLICATE TURRET_H, TURRET_R and TURRET_FILLET, which is
    // a second home for those numbers and is deliberate: importing production's own
    // profile would compare it against itself and pass however the turret was rebuilt.
    // An independent reconstruction is the whole value here. The cost is real -- retune
    // the turret and this test fails until the literals are updated too -- and that
    // failure is the correct signal, because retuning the turret IS the change the
    // design feedback asked not to happen by accident.
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
    // The design feedback: "just change the barrel skin so it meshes with the existing turret
    // appearances of those skins."
    //
    // Both parts are lathes, and LatheGeometry normalises u to one full texture repeat
    // around the circumference WHATEVER that circumference is. The turret is 2*PI*0.36 =
    // 2.26 world units around and the barrel tube 2*PI*0.13 = 0.82, so the same tile was
    // packed 2.8x tighter on the gun -- flow's soft swirl arrived there as fine corduroy.
    //
    // Asserted as a RATIO of world densities rather than against the literal 0.361, so
    // it keeps meaning the right thing if TURRET_R or BARREL_R is retuned. The mutation
    // that kills it is dropping the matchLatheToTurret call, which takes the ratio from
    // 0.714 to 1.978 -- verified by doing it.
    //
    // 1.978 rather than the 2.77 the tube circumferences alone would suggest, because
    // the density below is measured against each part's WIDEST radius and the barrel's
    // is the muzzle flare (0.182) rather than the tube (0.13). Both numbers are real;
    // they answer different questions, and this is the one this test can see.
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

    // The ENEMY is mapped too now (`two-tone`, issue #137), and `matchLatheToTurret`
    // does not branch on skin or kind, so its barrel gets the identical matching
    // treatment as the player's -- it can no longer stand in as the "untouched, raw
    // lathe" control this test used to read it as.
    const enemyTurret = uDensity(geoOf(scene, 7, 'turret'));
    const enemyBarrel = uDensity(geoOf(scene, 7, 'barrel'));
    expect(enemyBarrel / enemyTurret).toBeGreaterThan(0.6);
    expect(enemyBarrel / enemyTurret).toBeLessThan(1.05);

    // The negative control, and the reason the bounds above mean anything, now has to
    // come from an UNMAPPED tank instead of an enemy -- the player wearing `solid`, the
    // one skin whose `createSkinTexture` returns null (skins.ts). It shows the defect
    // this test describes: a raw, unscaled lathe wrap.
    views.setPlayerStyle('#3d7bd6', 'solid', null);
    views.sync(w, w, 0);
    const bare = uDensity(geoOf(scene, 3, 'barrel')) / uDensity(geoOf(scene, 3, 'turret'));
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

  it('dresses hull AND turret in the map, leaves tracks solid', () => {
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
    // The enemy is mapped too now (`two-tone`, issue #137) -- its own coverage lives in
    // the "enemy skins" describe block below, so this test is not the place to restate
    // it. What is still true here, and worth keeping in THIS test: the player's paint
    // shop change did not touch the enemy's material at all -- same white tint, same
    // map identity, before and after the player's restyle below.
    const enemyMapBefore = matOf(scene, 7, 'hull').map;
    expect(enemyMapBefore).not.toBeNull();

    // Back to solid: the map comes OFF and the tint returns to the material -- for the
    // PLAYER only. The enemy is untouched by a player-only restyle.
    views.setPlayerStyle('#d64545', 'solid', null);
    views.sync(w, w, 0);
    expect(matOf(scene, 3, 'hull').map).toBeNull();
    expect(matOf(scene, 3, 'hull').color.getHex()).toBe(0xd64545);
    expect(matOf(scene, 7, 'hull').map).toBe(enemyMapBefore);
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

  it('the player can wear two-tone, exactly like any other skin', () => {
    // Mirrors the coverage every other skin already has via setPlayerStyle -- issue
    // #137's player-facing half. Fails if 'two-tone' is ever missing from PAINTERS
    // (skins.ts) or from customization.ts's SKINS/SkinId.
    const scene = new THREE.Scene();
    const views = createEntityViews(scene);
    const w = makeWorld();
    w.tanks = [makeTank(1, 'player', 3, 3)];
    views.setPlayerStyle('#3d7bd6', 'two-tone', null);
    views.sync(w, w, 0);
    expect(matOf(scene, 3, 'hull').map).not.toBeNull();
    expect(matOf(scene, 3, 'hull').color.getHex()).toBe(0xffffff);
    views.dispose();
  });
});

describe('enemy skins (issue #137)', () => {
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

  const ENEMY_KINDS = ['brown', 'grey', 'teal', 'olive', 'green'] as const;

  it('gives every enemy kind a skin map -- they used to get null, every one of them', () => {
    // THE negative control that flips: before this issue, `entities.ts:411` was
    // `kind === 'player' ? playerSkinMap : null`, so every enemy material's `map` was
    // null. This is the per-kind assertion the issue asks for, not "some tank has a
    // skin" -- it fails if even ONE kind is missed by `enemySkinMapFor`.
    const scene = new THREE.Scene();
    const views = createEntityViews(scene);
    const w = makeWorld();
    w.tanks = ENEMY_KINDS.map((kind, i) => makeTank(i + 2, kind, i + 2, i + 2));
    views.sync(w, w, 0);
    for (let i = 0; i < ENEMY_KINDS.length; i++) {
      const x = i + 2;
      expect(matOf(scene, x, 'hull').map, `${ENEMY_KINDS[i]} hull has no skin map`).not.toBeNull();
      expect(matOf(scene, x, 'turret').map, `${ENEMY_KINDS[i]} turret has no skin map`).not.toBeNull();
      // Mapped parts go white so the map's own tint is not multiplied twice -- the same
      // rule the player's mapped materials follow (entities.test.ts's earlier describe).
      expect(matOf(scene, x, 'hull').color.getHex(), ENEMY_KINDS[i]).toBe(0xffffff);
    }
    views.dispose();
  });

  it('derives each kind\'s texture from ITS OWN colour, not a shared one', () => {
    // Discriminates BETWEEN kinds, as the issue asks -- two different kinds must
    // produce two different textures, and each must match what `createSkinTexture`
    // paints directly from that kind's OWN `configFor(kind).color`, not merely differ
    // from its neighbour by accident (e.g. a stale cache keyed wrong).
    const scene = new THREE.Scene();
    const views = createEntityViews(scene);
    const w = makeWorld();
    w.tanks = [makeTank(2, 'brown', 2, 2), makeTank(3, 'grey', 3, 3)];
    views.sync(w, w, 0);

    const brownMap = matOf(scene, 2, 'hull').map as THREE.DataTexture;
    const greyMap = matOf(scene, 3, 'hull').map as THREE.DataTexture;
    expect(Array.from(brownMap.image.data)).not.toEqual(Array.from(greyMap.image.data));

    const expectedBrown = createSkinTexture('two-tone', configFor('brown').color, null)!;
    const expectedGrey = createSkinTexture('two-tone', configFor('grey').color, null)!;
    expect(Array.from(brownMap.image.data)).toEqual(Array.from(expectedBrown.image.data));
    expect(Array.from(greyMap.image.data)).toEqual(Array.from(expectedGrey.image.data));
    expectedBrown.dispose();
    expectedGrey.dispose();
    views.dispose();
  });

  it('shares ONE texture per kind across every tank of that kind', () => {
    // Not required by the issue, but worth pinning: `enemySkinMapFor` caches by kind,
    // so two `brown` tanks on the board are not two separate 64kB textures.
    const scene = new THREE.Scene();
    const views = createEntityViews(scene);
    const w = makeWorld();
    w.tanks = [makeTank(2, 'brown', 2, 2), makeTank(3, 'brown', 3, 3)];
    views.sync(w, w, 0);
    expect(matOf(scene, 2, 'hull').map).toBe(matOf(scene, 3, 'hull').map);
    views.dispose();
  });

  it('dispose() releases every enemy kind\'s texture, not just the player\'s', () => {
    // PROVE THE GAP FIRST: `dispose()` used to read `playerSkinMap?.dispose()` alone
    // (entities.ts, pre-issue-#137). Enemy kinds did not have their own textures then,
    // so there was nothing to leak -- but the moment `enemySkinMapFor` starts minting
    // one DataTexture per kind, that single-slot dispose is no longer sufficient, and
    // nothing else in this file would have caught the leak (disposeObject deliberately
    // skips material maps). This is exactly that gap, closed.
    const scene = new THREE.Scene();
    const views = createEntityViews(scene);
    const w = makeWorld();
    w.tanks = ENEMY_KINDS.map((kind, i) => makeTank(i + 2, kind, i + 2, i + 2));
    views.sync(w, w, 0);

    const maps = ENEMY_KINDS.map((_, i) => matOf(scene, i + 2, 'hull').map as THREE.Texture);
    let disposedCount = 0;
    for (const m of maps) m.addEventListener('dispose', () => disposedCount++);
    views.dispose();
    expect(disposedCount, 'not every enemy kind\'s texture was disposed -- a per-kind leak').toBe(
      ENEMY_KINDS.length,
    );
  });
});

describe('co-op per-slot player styling', () => {
  const hexToInt = (hex: string): number => parseInt(hex.slice(1), 16);

  // TWO kind: 'player' tanks is not a loadable arena -- config/validate.ts still
  // hard-fails any grid without exactly one 'P'. Built via createWorld directly,
  // same construction style as step-inputs.test.ts's twoPlayerWorld: this is the
  // only way to reach the per-slot render seam before a second input exists.
  function twoPlayerWorld(): World {
    const p1: Tank = { ...makeTank(1, 'player', 3, 3), controlledBy: 0 };
    const p2: Tank = { ...makeTank(2, 'player', 9, 9), controlledBy: 1 };
    const spawns: Spawn[] = [
      { kind: 'player', pos: { x: 3, y: 3 }, angle: 0 },
      { kind: 'player', pos: { x: 9, y: 9 }, angle: 0 },
    ];
    return createWorld({ walls: [], tanks: [p1, p2], spawns, lives: 3 });
  }

  const hullColor = (scene: THREE.Scene, x: number): number => {
    let c = -1;
    scene.traverse((o) => {
      if (o.name === 'hull') {
        let g: THREE.Object3D | null = o;
        while (g.parent && g.parent.type !== 'Scene') g = g.parent;
        if (g && (g as THREE.Group).position.x === x) {
          c = ((o as THREE.Mesh).material as THREE.MeshStandardMaterial).color.getHex();
        }
      }
    });
    return c;
  };

  it('resolves two DIFFERENT styles for two co-op slots in the same world', () => {
    // Fails before the per-slot Map exists: the old four module-level singletons had
    // exactly one slot to colour, so a second styled player tank either did not
    // exist or repainted on top of the first.
    const scene = new THREE.Scene();
    const views = createEntityViews(scene);
    const w = twoPlayerWorld();
    views.setPlayerStyle('#d64545', 'solid', null, 0);
    views.setPlayerStyle('#2255aa', 'solid', null, 1);
    views.sync(w, w, 0);

    expect(hullColor(scene, 3)).toBe(0xd64545);
    expect(hullColor(scene, 9)).toBe(0x2255aa);
    views.dispose();
  });

  it('leaves an unstyled slot 1 on the placeholder when only P1 is styled', () => {
    const scene = new THREE.Scene();
    const views = createEntityViews(scene);
    const w = twoPlayerWorld();
    views.setPlayerStyle('#d64545', 'solid', null, 0); // slot defaults to 0
    views.sync(w, w, 0);

    const p1Color = hullColor(scene, 3);
    const p2Color = hullColor(scene, 9);
    expect(p1Color).toBe(0xd64545);
    // Distinct from P1's styled colour AND from the roster's own player-kind
    // default -- a placeholder, not an accidental match either way.
    expect(p2Color).not.toBe(p1Color);
    expect(p2Color).not.toBe(hexToInt(configFor('player').color));
    views.dispose();
  });

  it('the unstyled-slot placeholder is distinct from every roster kind\'s own colour', () => {
    // Verified against the REAL rendered colour, not a hardcoded expected hex -- the
    // placeholder's exact value is a feel pick (CLAUDE.md's TANK_TURN_RATE
    // treatment); what this pins is only that it never collides with a roster kind.
    const scene = new THREE.Scene();
    const views = createEntityViews(scene);
    const w = twoPlayerWorld();
    views.sync(w, w, 0); // neither slot styled: slot 1 renders on the placeholder
    const placeholder = hullColor(scene, 9);

    for (const kind of TANK_KINDS) {
      expect(placeholder, `placeholder vs ${kind}`).not.toBe(hexToInt(configFor(kind).color));
    }
    views.dispose();
  });
});

describe('player identity: ring and shell tint', () => {
  // Same construction as the co-op styling block above -- two `kind: 'player'` tanks is
  // not a loadable arena (config/validate.ts hard-fails any grid without exactly one
  // 'P'), so this is the only way to reach the >=2-player render path pre-second-input.
  function twoPlayerWorld(): World {
    const p1: Tank = { ...makeTank(1, 'player', 3, 3), controlledBy: 0 };
    const p2: Tank = { ...makeTank(2, 'player', 9, 9), controlledBy: 1 };
    const spawns: Spawn[] = [
      { kind: 'player', pos: { x: 3, y: 3 }, angle: 0 },
      { kind: 'player', pos: { x: 9, y: 9 }, angle: 0 },
    ];
    return createWorld({ walls: [], tanks: [p1, p2], spawns, lives: 3 });
  }

  // Four DISTINCT x coordinates, deliberately: ringColorAt (below) matches on x alone,
  // so any repeat would make its lookup ambiguous between two slots.
  function fourPlayerWorld(): World {
    const p0: Tank = { ...makeTank(1, 'player', 3, 3), controlledBy: 0 };
    const p1: Tank = { ...makeTank(2, 'player', 9, 9), controlledBy: 1 };
    const p2: Tank = { ...makeTank(3, 'player', 15, 3), controlledBy: 2 };
    const p3: Tank = { ...makeTank(4, 'player', 21, 9), controlledBy: 3 };
    const spawns: Spawn[] = [
      { kind: 'player', pos: { x: 3, y: 3 }, angle: 0 },
      { kind: 'player', pos: { x: 9, y: 9 }, angle: 0 },
      { kind: 'player', pos: { x: 15, y: 3 }, angle: 0 },
      { kind: 'player', pos: { x: 21, y: 9 }, angle: 0 },
    ];
    return createWorld({ walls: [], tanks: [p0, p1, p2, p3], spawns, lives: 3 });
  }

  function threePlayerWorldWithOneEnemy(): World {
    const p1: Tank = { ...makeTank(1, 'player', 3, 3), controlledBy: 0 };
    const p2: Tank = { ...makeTank(2, 'player', 9, 9), controlledBy: 1 };
    const enemy: Tank = makeTank(3, 'brown', 6, 6);
    const spawns: Spawn[] = [
      { kind: 'player', pos: { x: 3, y: 3 }, angle: 0 },
      { kind: 'player', pos: { x: 9, y: 9 }, angle: 0 },
      { kind: 'brown', pos: { x: 6, y: 6 }, angle: 0 },
    ];
    return createWorld({ walls: [], tanks: [p1, p2, enemy], spawns, lives: 3 });
  }

  function identityRings(scene: THREE.Scene): THREE.Mesh[] {
    const rings: THREE.Mesh[] = [];
    scene.traverse((o) => {
      if (o.name === 'identity-ring') rings.push(o as THREE.Mesh);
    });
    return rings;
  }

  /** The ring's colour, found by walking up to the tank GROUP sitting at world x. */
  function ringColorAt(scene: THREE.Scene, x: number): number {
    let c = -1;
    scene.traverse((o) => {
      if (o.name !== 'identity-ring') return;
      let g: THREE.Object3D | null = o;
      while (g.parent && g.parent.type !== 'Scene') g = g.parent;
      if (g && (g as THREE.Group).position.x === x) {
        c = ((o as THREE.Mesh).material as THREE.MeshBasicMaterial).color.getHex();
      }
    });
    return c;
  }

  it('draws no identity ring in a single-player world', () => {
    // The gap this proves: single-player must stay pixel-identical to before this
    // feature existed, which the ring itself would visibly break if it ever drew with
    // only one player-kind tank in the world.
    const scene = new THREE.Scene();
    const views = createEntityViews(scene);
    const w = makeWorld();
    views.sync(w, w, 0);
    expect(identityRings(scene)).toHaveLength(0);
    views.dispose();
  });

  it('draws one identity ring per player tank once a second player joins', () => {
    const scene = new THREE.Scene();
    const views = createEntityViews(scene);
    const w = twoPlayerWorld();
    views.sync(w, w, 0);
    expect(identityRings(scene)).toHaveLength(2);
    views.dispose();
  });

  it('draws no ring on an enemy tank sharing a >=2-player world', () => {
    const scene = new THREE.Scene();
    const views = createEntityViews(scene);
    const w = threePlayerWorldWithOneEnemy();
    views.sync(w, w, 0);
    // Two players, one enemy: exactly two rings, none of them on the enemy at x=6.
    expect(identityRings(scene)).toHaveLength(2);
    expect(ringColorAt(scene, 6)).toBe(-1);
    views.dispose();
  });

  it('colours each slot\'s ring from IDENTITY_RING_COLORS, distinctly', () => {
    const scene = new THREE.Scene();
    const views = createEntityViews(scene);
    const w = twoPlayerWorld();
    views.sync(w, w, 0);
    expect(ringColorAt(scene, 3)).toBe(IDENTITY_RING_COLORS[0]);
    expect(ringColorAt(scene, 9)).toBe(IDENTITY_RING_COLORS[1]);
    expect(IDENTITY_RING_COLORS[0]).not.toBe(IDENTITY_RING_COLORS[1]);
    views.dispose();
  });

  it('colours all 4 slots\' rings from IDENTITY_RING_COLORS at N=4, all pairwise distinct', () => {
    // Extends the pair above past two players -- IDENTITY_RING_COLORS now carries 4
    // entries (the N-player ring extension), and this is the only place that renders
    // slot 2/3's own ring rather than trusting array-length extrapolation.
    const scene = new THREE.Scene();
    const views = createEntityViews(scene);
    const w = fourPlayerWorld();
    views.sync(w, w, 0);
    expect(IDENTITY_RING_COLORS).toHaveLength(4); // population: all 4 configured slots
    const rendered = [
      ringColorAt(scene, 3), ringColorAt(scene, 9), ringColorAt(scene, 15), ringColorAt(scene, 21),
    ];
    expect(rendered).toEqual([...IDENTITY_RING_COLORS]);
    for (let i = 0; i < rendered.length; i++) {
      for (let j = i + 1; j < rendered.length; j++) {
        expect(rendered[i], `slot ${i} vs slot ${j}`).not.toBe(rendered[j]);
      }
    }
    views.dispose();
  });

  it('both identity ring colours are distinct from every roster colour and the placeholder', () => {
    // Makes entities.ts's own distinctness claim TRUE rather than asserted: the ring
    // says WHO, the hull says WHAT STYLE, so an identity hex colliding with a hull a
    // player could be wearing (or the unstyled-slot placeholder) would blur exactly
    // the channel the ring exists to carry. Reads the REAL rendered placeholder off
    // the scene, same as the placeholder-distinctness sweep above. Breaks if any
    // IDENTITY_RING_COLORS entry is changed onto a roster/placeholder hue. Iterates
    // `IDENTITY_RING_COLORS` directly (not a hardcoded count), so this already covers
    // all 4 entries now that the array carries 4, with no edit needed to this test.
    const scene = new THREE.Scene();
    const views = createEntityViews(scene);
    const w = twoPlayerWorld();
    views.sync(w, w, 0); // slot 1 unstyled: renders the placeholder hull
    // Local copy of the co-op styling block's hullColor reader (scoped there).
    let placeholder = -1;
    scene.traverse((o) => {
      if (o.name !== 'hull') return;
      let g: THREE.Object3D | null = o;
      while (g.parent && g.parent.type !== 'Scene') g = g.parent;
      if (g && (g as THREE.Group).position.x === 9) {
        placeholder = ((o as THREE.Mesh).material as THREE.MeshStandardMaterial).color.getHex();
      }
    });
    expect(placeholder, 'placeholder hull was found in the scene').not.toBe(-1);
    for (const ring of IDENTITY_RING_COLORS) {
      for (const kind of TANK_KINDS) {
        expect(ring, `ring vs ${kind}`).not.toBe(parseInt(configFor(kind).color.slice(1), 16));
      }
      expect(ring, 'ring vs unstyled placeholder').not.toBe(placeholder);
    }
    views.dispose();
  });

  // n-player arc PR 4: teams mode colours rings/shell tints by TEAM (2 hues) rather
  // than per-slot identity -- dispatched at the same lookup site the per-slot palette
  // already lives at (identityColor). The per-slot palette stays for
  // campaign-coop/ffa, which is why the tests above (built at the default
  // 'campaign-coop' mode) are untouched.
  function fourPlayerTeamsWorld(): World {
    const p0: Tank = { ...makeTank(1, 'player', 3, 3), controlledBy: 0, team: 0 };
    const p1: Tank = { ...makeTank(2, 'player', 9, 9), controlledBy: 1, team: 1 };
    const p2: Tank = { ...makeTank(3, 'player', 15, 3), controlledBy: 2, team: 0 };
    const p3: Tank = { ...makeTank(4, 'player', 21, 9), controlledBy: 3, team: 1 };
    const spawns: Spawn[] = [
      { kind: 'player', pos: { x: 3, y: 3 }, angle: 0 },
      { kind: 'player', pos: { x: 9, y: 9 }, angle: 0 },
      { kind: 'player', pos: { x: 15, y: 3 }, angle: 0 },
      { kind: 'player', pos: { x: 21, y: 9 }, angle: 0 },
    ];
    return createWorld({ walls: [], tanks: [p0, p1, p2, p3], spawns, lives: 3, mode: 'teams' });
  }

  it('TEAM_COLORS: exactly 2 hues, pairwise distinct from each other, every roster colour and the placeholder', () => {
    expect(TEAM_COLORS).toHaveLength(2);
    expect(TEAM_COLORS[0]).not.toBe(TEAM_COLORS[1]);
    // Real rendered placeholder, same method as the identity-ring sweep above.
    const scene = new THREE.Scene();
    const views = createEntityViews(scene);
    views.sync(twoPlayerWorld(), twoPlayerWorld(), 0);
    let placeholder = -1;
    scene.traverse((o) => {
      if (o.name !== 'hull') return;
      let g: THREE.Object3D | null = o;
      while (g.parent && g.parent.type !== 'Scene') g = g.parent;
      if (g && (g as THREE.Group).position.x === 9) {
        placeholder = ((o as THREE.Mesh).material as THREE.MeshStandardMaterial).color.getHex();
      }
    });
    expect(placeholder).not.toBe(-1);
    for (const team of TEAM_COLORS) {
      for (const kind of TANK_KINDS) {
        expect(team, `team vs ${kind}`).not.toBe(parseInt(configFor(kind).color.slice(1), 16));
      }
      for (const ring of IDENTITY_RING_COLORS) {
        expect(team, 'team vs an identity-ring hue').not.toBe(ring);
      }
      expect(team, 'team vs unstyled placeholder').not.toBe(placeholder);
    }
    views.dispose();
  });

  it('teams mode colours every ring by TEAM, not by slot -- slots 0/2 (team 0) match, slots 1/3 (team 1) match, and the two teams differ', () => {
    const scene = new THREE.Scene();
    const views = createEntityViews(scene);
    const w = fourPlayerTeamsWorld();
    views.sync(w, w, 0);
    const [c0, c1, c2, c3] = [
      ringColorAt(scene, 3), ringColorAt(scene, 9), ringColorAt(scene, 15), ringColorAt(scene, 21),
    ];
    expect(c0).toBe(TEAM_COLORS[0]);
    expect(c1).toBe(TEAM_COLORS[1]);
    expect(c2).toBe(TEAM_COLORS[0]); // team 0, same colour as slot 0
    expect(c3).toBe(TEAM_COLORS[1]); // team 1, same colour as slot 1
    expect(c0).not.toBe(c1);
    // Negative control: this is NOT just the per-slot palette read differently -- slot
    // 2's colour must not be IDENTITY_RING_COLORS[2] (its per-slot entry).
    expect(c2).not.toBe(IDENTITY_RING_COLORS[2]);
    views.dispose();
  });

  it('teams mode colours shell tint by TEAM too, mirroring the ring dispatch', () => {
    const scene = new THREE.Scene();
    const views = createEntityViews(scene);
    const w = fourPlayerTeamsWorld();
    w.bullets.push(playerBullet(60, 3, 15)); // slot 2 (team 0)'s shell, at x=15
    views.sync(w, w, 0);
    expect(shellEmissiveAt(scene, 15)).toBe(TEAM_COLORS[0]);
    views.dispose();
  });

  it("a DEAD player owner's shell keeps its identity tint -- a shell must not lose its firer's colour mid-flight", () => {
    // Pins the deliberate absence of an .alive check in shellTintFor: the firer dying
    // a tick after shooting must not strip the shell's identity. Breaks if the lookup
    // ever adds an alive-only filter.
    const scene = new THREE.Scene();
    const views = createEntityViews(scene);
    const w = twoPlayerWorld();
    w.tanks[1].alive = false; // P2 (id 2, controlledBy 1) is a corpse
    w.bullets.push(playerBullet(60, 2, 6)); // P2's shell, still in flight
    views.sync(w, w, 0);
    expect(shellEmissiveAt(scene, 6)).toBe(IDENTITY_RING_COLORS[1]);
    views.dispose();
  });

  it('the ring sits entirely outside the hull\'s own collision radius', () => {
    // A ring that started inside TANK_RADIUS would be drawn UNDER the hull from
    // overhead and read as nothing at all -- the same class of mistake HULL_WIDTH's
    // own test exists to catch for the hull itself.
    expect(IDENTITY_RING_INNER_R).toBeGreaterThan(TANK_RADIUS);
    expect(IDENTITY_RING_OUTER_R).toBeGreaterThan(IDENTITY_RING_INNER_R);
  });

  it('removing the second player (rebuilding down to one) drops the ring on the next sync', () => {
    // There is no live path that shrinks playerCount mid-game today, but the render
    // layer should not depend on that: the ring is a property of the CURRENT world's
    // player count, recomputed every sync, not latched at first draw.
    const scene = new THREE.Scene();
    const views = createEntityViews(scene);
    const two = twoPlayerWorld();
    views.sync(two, two, 0);
    expect(identityRings(scene)).toHaveLength(2);

    const one = makeWorld();
    views.sync(one, one, 0);
    expect(identityRings(scene)).toHaveLength(0);
    views.dispose();
  });

  function playerBullet(id: number, ownerId: number, x: number): Bullet {
    return { id, ownerId, type: 'normal', pos: { x, y: 0 }, vel: { x: NORMAL_SPEED, y: 0 }, bouncesLeft: 1, alive: true };
  }

  /** The shell body's emissive colour, by matching the group's world x position. */
  function shellEmissiveAt(scene: THREE.Scene, x: number): number {
    let c = -1;
    scene.traverse((o) => {
      if (!(o instanceof THREE.Group)) return;
      if (!o.children.some((k) => (k as THREE.Mesh).geometry instanceof THREE.CylinderGeometry)) return;
      if (Math.abs(o.position.x - x) > 1e-9) return;
      const body = o.children.find((k) => (k as THREE.Mesh).geometry instanceof THREE.CylinderGeometry) as THREE.Mesh;
      c = (body.material as THREE.MeshStandardMaterial).emissive.getHex();
    });
    return c;
  }

  const UNTINTED_EMISSIVE = 0x444422; // the shipped brass shell's own emissive, untinted

  it('does not tint a shell in a single-player world, even one owned by the player', () => {
    const scene = new THREE.Scene();
    const views = createEntityViews(scene);
    const w = makeWorld(); // one player tank, id 1
    w.bullets.push(playerBullet(50, 1, 4));
    views.sync(w, w, 0);
    expect(shellEmissiveAt(scene, 4)).toBe(UNTINTED_EMISSIVE);
    views.dispose();
  });

  it('does not tint an enemy-owned shell even in a >=2-player world', () => {
    const scene = new THREE.Scene();
    const views = createEntityViews(scene);
    const w = threePlayerWorldWithOneEnemy();
    w.bullets.push(playerBullet(50, 3, 7)); // owned by the enemy tank, id 3
    views.sync(w, w, 0);
    expect(shellEmissiveAt(scene, 7)).toBe(UNTINTED_EMISSIVE);
    views.dispose();
  });

  it('tints a shell with its owner\'s slot identity colour once a second player exists', () => {
    const scene = new THREE.Scene();
    const views = createEntityViews(scene);
    const w = twoPlayerWorld();
    w.bullets.push(playerBullet(50, 1, 4)); // owned by P1 (tank id 1, slot 0)
    w.bullets.push(playerBullet(51, 2, 10)); // owned by P2 (tank id 2, slot 1)
    views.sync(w, w, 0);
    expect(shellEmissiveAt(scene, 4)).toBe(IDENTITY_RING_COLORS[0]);
    expect(shellEmissiveAt(scene, 10)).toBe(IDENTITY_RING_COLORS[1]);
    views.dispose();
  });

  it('resolves the tint ONCE, at the bullet view\'s creation tick, like kind/gen for tanks', () => {
    // Mirrors the tank-view rebuild-trigger comment: ownership never changes over a
    // shell's life, so there is nothing to re-resolve per frame. This proves the tint
    // set at creation survives further sync calls with the SAME bullet id untouched.
    const scene = new THREE.Scene();
    const views = createEntityViews(scene);
    const w = twoPlayerWorld();
    w.bullets.push(playerBullet(50, 1, 4));
    views.sync(w, w, 0);
    views.sync(w, w, 0.5);
    views.sync(w, w, 1);
    expect(shellEmissiveAt(scene, 4)).toBe(IDENTITY_RING_COLORS[0]);
    views.dispose();
  });
});

describe('spawn animation (#199)', () => {
  // Traverses the WHOLE scene for the first object with this name -- the same shape as
  // `identityRings`/`shellGroup` above, generalised to a name argument since spawn-ring
  // is the only name this block needs to find.
  function findByName(scene: THREE.Scene, name: string): THREE.Object3D | undefined {
    let found: THREE.Object3D | undefined;
    scene.traverse((o) => {
      if (!found && o.name === name) found = o;
    });
    return found;
  }

  // Every test in this block runs a single player tank (id 1), so the sole 'hull' mesh
  // in the scene IS that tank's body -- `id` is kept in the signature for symmetry with
  // a future multi-tank case, not because it disambiguates one here.
  function tankBodyMaterial(scene: THREE.Scene, _id: number): THREE.MeshStandardMaterial {
    const hull = findByName(scene, 'hull');
    if (!hull) throw new Error('no hull mesh found');
    return (hull as THREE.Mesh).material as THREE.MeshStandardMaterial;
  }

  /** Same lookup as `tankBodyMaterial`, generalised to any of the tank's own mesh names. */
  function tankMaterial(scene: THREE.Scene, name: string): THREE.MeshStandardMaterial {
    const obj = findByName(scene, name);
    if (!obj) throw new Error(`no ${name} mesh found`);
    return (obj as THREE.Mesh).material as THREE.MeshStandardMaterial;
  }

  function deadPlayerWorld(): World {
    const p: Tank = { ...makeTank(1, 'player', 5, 5), alive: false };
    const spawns: Spawn[] = [{ kind: 'player', pos: { x: 5, y: 5 }, angle: 0 }];
    return createWorld({ walls: [], tanks: [p], spawns, lives: 3 });
  }

  function alivePlayerWorld(shieldUntilTick: number | undefined, tick: number): World {
    const p: Tank = { ...makeTank(1, 'player', 5, 5), alive: true, shieldUntilTick };
    const spawns: Spawn[] = [{ kind: 'player', pos: { x: 5, y: 5 }, angle: 0 }];
    const w = createWorld({ walls: [], tanks: [p], spawns, lives: 3 });
    w.tick = tick;
    return w;
  }

  it('starts a spawn entrance and adds a spawn ring on the dead->alive edge', () => {
    const scene = new THREE.Scene();
    const views = createEntityViews(scene);
    const prev = deadPlayerWorld();
    const curr = alivePlayerWorld(undefined, 0);
    views.sync(prev, curr, 1, 0.016);
    // Mutation that breaks this: never creating the ring on the respawn edge.
    const ring = findByName(scene, 'spawn-ring');
    expect(ring).toBeTruthy();
    views.dispose();
  });

  it("holds the spawn ring at its OWN world-space radius, independent of the tank's scale", () => {
    // spawn-anim.ts's RING_BASE_R comment: "base radius is 1 world unit so a frame's
    // `ring.radius` is a direct world-space radius" -- that contract breaks if the ring
    // is a scaled child of a parent that is ALSO scaled (three composes parent x child
    // scale). DEFAULT_SPAWN_ANIM is 'warp'; at entrance progress 0.5 its tankScale is
    // 0.6 + 0.4*0.5 = 0.8 (provably not 1) and its ring.radius is 0.4 + 1.6*0.5 = 1.2.
    // dt 0.25 against ENTRANCE_SECONDS 0.5 lands exactly on that midpoint.
    const scene = new THREE.Scene();
    const views = createEntityViews(scene);
    const prev = deadPlayerWorld();
    const curr = alivePlayerWorld(undefined, 0);
    views.sync(prev, curr, 1, 0.25);
    const ring = findByName(scene, 'spawn-ring') as THREE.Mesh;
    expect(ring).toBeTruthy();
    // Mutation that breaks this: scaling the ring's own parent by tankScale (or any
    // ancestor shared with the tank's visible parts) instead of leaving the ring's
    // ancestor chain at scale 1 -- getWorldScale is the composed, on-screen scale,
    // not the ring's own local `.scale`, so it catches exactly that composition bug.
    const worldScale = ring.getWorldScale(new THREE.Vector3());
    expect(worldScale.x).toBeCloseTo(1.2, 5);
    expect(worldScale.y).toBeCloseTo(1.2, 5);
    expect(worldScale.z).toBeCloseTo(1.2, 5);
    views.dispose();
  });

  it('starts the entrance on a campaign round restart even though the tank was alive in both frames', () => {
    // resetArena (world.ts) revives the player AND bumps roundStartTick in the SAME
    // tick, so campaign's single-player respawn can go straight from alive->alive and
    // never pass through alive: false -- enteredRespawn alone would miss it entirely.
    // This is the trigger Step 1's investigation exists to justify: only
    // roundStartTick moving distinguishes a campaign round restart from ordinary play.
    const scene = new THREE.Scene();
    const views = createEntityViews(scene);
    const prev = alivePlayerWorld(undefined, 0); // roundStartTick 1 (createWorld's default)
    const curr = alivePlayerWorld(undefined, 0);
    curr.roundStartTick = 5; // what resetArena's own bump looks like from here
    views.sync(prev, curr, 1, 0.016);
    // Mutation that breaks this: dropping the `enteredRound` half of the trigger.
    expect(findByName(scene, 'spawn-ring')).toBeTruthy();
    views.dispose();
  });

  it('drives the invincibility overlay from shieldUntilTick, not a latched copy', () => {
    // An early/late `>` comparison survives two wrong reads that both still move the
    // right direction over two syncs: reading shieldLeft off `prev.tick` instead of
    // `curr.tick`, and deriving invincible progress from `spawn.elapsed` instead of
    // `shieldUntilTick - curr.tick`. Asserting the EXACT opacity against the `warp`
    // animator's own formula (spawn-anim.ts) discriminates both, in a single sync.
    const scene = new THREE.Scene();
    const views = createEntityViews(scene);
    const prev = deadPlayerWorld(); // tick 0
    // dt 0.6 > ENTRANCE_SECONDS (0.5), so this ONE sync both triggers the entrance edge
    // AND advances straight past it into the invincibility branch -- prev.tick (0) and
    // curr.tick (10) are both live inputs to this single call, which is what lets a
    // wrong-tick read diverge from the right one without needing a second sync.
    const curr = alivePlayerWorld(90, 10); // shieldUntilTick 90, tick 10 -> 80 ticks left
    views.sync(prev, curr, 1, 0.6);
    const opacity = tankBodyMaterial(scene, 1).opacity;
    // Expected value re-derived from spawn-anim.ts's `warp` invincible formula
    // (tankOpacity = 0.45 + 0.55*p) rather than hardcoded, so the assertion states its
    // own derivation: shieldLeft = shieldUntilTick - curr.tick = 90 - 10 = 80,
    // p = 1 - shieldLeft/RESPAWN_SHIELD_TICKS = 1 - 80/90 = 1/9.
    const shieldLeft = 90 - 10;
    const expectedP = 1 - shieldLeft / RESPAWN_SHIELD_TICKS;
    const expectedOpacity = 0.45 + 0.55 * expectedP;
    // Mutation A (shieldLeft read off `prev.tick` instead of `curr.tick`): shieldLeft
    // becomes 90 - 0 = 90, p = 0, opacity = 0.45 -- fails this assertion.
    // Mutation B (progress derived from `spawn.elapsed` instead of shieldUntilTick -
    // curr.tick): elapsed is 0.6 on this first sync, a different number entirely --
    // fails this assertion too.
    expect(opacity).toBeCloseTo(expectedOpacity, 5);
    views.dispose();
  });

  it('restores full opacity, drops the ring and clears state once the shield expires', () => {
    const scene = new THREE.Scene();
    const views = createEntityViews(scene);
    const prev = deadPlayerWorld();
    views.sync(prev, alivePlayerWorld(90, 10), 1, 0.6);
    expect(findByName(scene, 'spawn-ring')).toBeTruthy();
    // Shield already expired (tick 91 > shieldUntilTick 90): the very next sync should
    // restore solid opacity and remove the ring rather than leaving it lingering.
    views.sync(alivePlayerWorld(90, 10), alivePlayerWorld(90, 91), 1, 0.016);
    expect(tankBodyMaterial(scene, 1).opacity).toBe(1);
    expect(findByName(scene, 'spawn-ring')).toBeUndefined();
    // Mutation that breaks this: setTankOpacity(view, 1) restores opacity but never
    // resets `transparent`, so a tank that has ever animated stays in the transparent
    // render pass forever after the animation completes. Covers body, track and turret
    // (the barrel shares the turret's material, so it needs no separate check).
    for (const name of ['hull', 'track', 'turret']) {
      expect(tankMaterial(scene, name).transparent).toBe(false);
    }
    views.dispose();
  });

  it('does not retrigger the entrance on every tick a respawned tank stays alive', () => {
    // A dead->alive edge only exists on the FIRST sync after the respawn; every later
    // sync between the same two alive worlds must leave the existing spawn state (and
    // its ring) alone rather than re-adding a second ring.
    const scene = new THREE.Scene();
    const views = createEntityViews(scene);
    const prev = deadPlayerWorld();
    const curr = alivePlayerWorld(RESPAWN_SHIELD_TICKS, 0);
    views.sync(prev, curr, 1, 0.016);
    views.sync(curr, curr, 1, 0.016);
    views.sync(curr, curr, 1, 0.016);
    let ringCount = 0;
    scene.traverse((o) => {
      if (o.name === 'spawn-ring') ringCount++;
    });
    expect(ringCount).toBe(1);
    views.dispose();
  });

  // A second tank, alongside the player, whose own roundStartTick this test drives
  // through a change -- resetArena revives EVERY tank and bumps roundStartTick once
  // for the whole world, so an enemy sees the exact same `enteredRound` signal the
  // player does. Only the `t.kind === 'player'` guard is what keeps it from also
  // getting an entrance; the death effect for enemies is a separate issue (#199's own
  // brief says so explicitly), so this pins that enemies get NONE, not some other
  // treatment.
  function playerAndEnemyWorld(roundStartTick: number): World {
    const p: Tank = { ...makeTank(1, 'player', 5, 5), alive: true };
    const enemy: Tank = makeTank(2, 'brown', 8, 8);
    const spawns: Spawn[] = [
      { kind: 'player', pos: { x: 5, y: 5 }, angle: 0 },
      { kind: 'brown', pos: { x: 8, y: 8 }, angle: 0 },
    ];
    const w = createWorld({ walls: [], tanks: [p, enemy], spawns, lives: 3 });
    w.roundStartTick = roundStartTick;
    return w;
  }

  it('never starts a spawn entrance for an enemy tank, even on a campaign round restart', () => {
    const scene = new THREE.Scene();
    const views = createEntityViews(scene);
    const prev = playerAndEnemyWorld(1);
    const curr = playerAndEnemyWorld(5); // resetArena-style roundStartTick bump, both tanks alive throughout
    views.sync(prev, curr, 1, 0.016);
    let ringCount = 0;
    scene.traverse((o) => {
      if (o.name === 'spawn-ring') ringCount++;
    });
    // Exactly 1: the player's own entrance ring fires (roundStartTick changed) --
    // this is not "no rings ever", it is "the enemy specifically gets none".
    // Mutation that breaks this: dropping the `t.kind === 'player'` guard, which
    // would also start an entrance for the enemy (ringCount 2, not 1).
    expect(ringCount).toBe(1);
    views.dispose();
  });

  it('plays the STYLED slot\'s spawn variant, not the hardcoded default (#201)', () => {
    // setPlayerStyle's 5th arg stores a per-slot spawnAnim; the entrance at :1354 must
    // read it back through styleFor(slot) rather than reading DEFAULT_SPAWN_ANIM
    // directly. warp and rise disagree sharply on entrance tankScale, so reading the
    // composed world scale off a real mesh (the same technique the ring-radius test
    // above uses) distinguishes them without reaching into entities.ts internals.
    const scene = new THREE.Scene();
    const views = createEntityViews(scene);
    views.setPlayerStyle(null, 'solid', null, 0, 'rise');
    const prev = deadPlayerWorld();
    const curr = alivePlayerWorld(undefined, 0);
    // dt 0.25 against ENTRANCE_SECONDS 0.5 lands exactly on progress 0.5, same as the
    // ring-radius test above.
    views.sync(prev, curr, 1, 0.25);
    const hull = findByName(scene, 'hull') as THREE.Mesh;
    expect(hull).toBeTruthy();
    const worldScale = hull.getWorldScale(new THREE.Vector3());
    // rise's entrance tankScale is `p` itself: 0.5. warp's (the default, and what this
    // test would read if :1354 ignored the stored variant) is 0.6 + 0.4*p = 0.8.
    // Mutation that breaks this: entities.ts:1354 reading DEFAULT_SPAWN_ANIM instead of
    // styleFor(slot).spawnAnim -- the tank would come back at 0.8, not 0.5.
    expect(worldScale.x).toBeCloseTo(0.5, 5);
    expect(worldScale.y).toBeCloseTo(0.5, 5);
    expect(worldScale.z).toBeCloseTo(0.5, 5);
    views.dispose();
  });
});

// ---------------------------------------------------------------------------
// Issue #239: a VS stock respawn keeps the tank's id and does NOT restart the
// round, so `snap` (roundStartTick) is false and the revived tank lerped from
// its DEATH position to its new respawn point. The spawn ring is a child of the
// tank group, so it inherited the same travel -- the ring appeared to fly across
// the arena from where the player died to where they came back.
// ---------------------------------------------------------------------------
describe('entity views — a stock respawn snaps to the selected spawn point (#239)', () => {
  const DIED_AT: Vec2 = { x: 5, y: 5 };
  const RESPAWN_AT: Vec2 = { x: 30, y: 10 };

  /** Two player tanks in one world: id 1 is the one that dies, id 2 never does. */
  function vsWorld(
    one: { alive: boolean; pos: Vec2; bodyAngle?: number; turretAngle?: number },
    twoPos: Vec2,
    mode: 'ffa' | 'teams' = 'ffa',
  ): World {
    const teams = mode === 'teams';
    const t1: Tank = {
      ...makeTank(1, 'player', one.pos.x, one.pos.y),
      alive: one.alive,
      bodyAngle: one.bodyAngle ?? 0,
      turretAngle: one.turretAngle ?? 0,
      controlledBy: 0,
      ...(teams ? { team: 0 } : {}),
    };
    const t2: Tank = {
      ...makeTank(2, 'player', twoPos.x, twoPos.y),
      controlledBy: 1,
      ...(teams ? { team: 1 } : {}),
    };
    const spawns: Spawn[] = [
      { kind: 'player', pos: DIED_AT, angle: 0 },
      { kind: 'player', pos: twoPos, angle: 0 },
    ];
    // roundStartTick is left at createWorld's default on BOTH worlds in every case
    // below: a stock respawn does not restart the round, which is exactly why the
    // existing whole-round snap does not cover it.
    return createWorld({ walls: [], tanks: [t1, t2], spawns, lives: 3, ...(teams ? { mode: 'teams' as const } : {}) });
  }

  const tankGroups = (scene: THREE.Scene): THREE.Group[] =>
    scene.children.filter((c): c is THREE.Group => c instanceof THREE.Group);

  /**
   * Drive the scene to the frame BEFORE the revival and return the survivor's group.
   *
   * Identifying the two groups by uuid rather than by position, because position is
   * what these tests measure. While tank 1 is dead its view is disposed and removed
   * (syncTanks' own cleanup loop), so exactly one group is left and it is tank 2's;
   * the group that appears on the next sync is therefore tank 1's new one.
   */
  function upToTheDeath(scene: THREE.Scene, views: ReturnType<typeof createEntityViews>): THREE.Group {
    const alive = vsWorld({ alive: true, pos: DIED_AT }, { x: 20, y: 20 });
    views.sync(alive, alive, 1, 0.016);
    const dead = vsWorld({ alive: false, pos: DIED_AT }, { x: 20, y: 20 });
    views.sync(alive, dead, 1, 0.016);
    const left = tankGroups(scene);
    expect(left, 'the dead tank\'s view should have been disposed').toHaveLength(1);
    return left[0];
  }

  function revivedGroup(scene: THREE.Scene, survivor: THREE.Group): THREE.Group {
    const other = tankGroups(scene).filter((g) => g.uuid !== survivor.uuid);
    expect(other, 'the revived tank has no group of its own').toHaveLength(1);
    return other[0];
  }

  it.each([0, 0.25, 0.5, 0.99])(
    'puts the revived tank at its respawn point at alpha %s, never between the two',
    (alpha) => {
      const scene = new THREE.Scene();
      const views = createEntityViews(scene);
      const survivor = upToTheDeath(scene, views);

      const dead = vsWorld({ alive: false, pos: DIED_AT }, { x: 20, y: 20 });
      const revived = vsWorld({ alive: true, pos: RESPAWN_AT }, { x: 21, y: 20 });
      views.sync(dead, revived, alpha, 0.016);
      scene.updateMatrixWorld(true);

      const g = revivedGroup(scene, survivor);
      expect(g.position.x, 'x is between the death point and the respawn').toBeCloseTo(RESPAWN_AT.x, 9);
      expect(g.position.z, 'z is between the death point and the respawn').toBeCloseTo(RESPAWN_AT.y, 9);
      views.dispose();
    },
  );

  it('anchors the spawn ring at the respawn point too, in WORLD space', () => {
    // The ring is a child of the tank group, so it cannot be checked by reading its
    // local position -- that is 0,0,0 whatever the group does. This reads where it
    // actually lands after the whole transform, which is what a player sees.
    const scene = new THREE.Scene();
    const views = createEntityViews(scene);
    const survivor = upToTheDeath(scene, views);

    const dead = vsWorld({ alive: false, pos: DIED_AT }, { x: 20, y: 20 });
    const revived = vsWorld({ alive: true, pos: RESPAWN_AT }, { x: 21, y: 20 });
    views.sync(dead, revived, 0.5, 0.016);
    scene.updateMatrixWorld(true);

    let ring: THREE.Object3D | undefined;
    revivedGroup(scene, survivor).traverse((o) => {
      if (o.name === 'spawn-ring') ring = o;
    });
    expect(ring, 'no spawn ring on the revived tank').toBeTruthy();
    const at = new THREE.Vector3();
    ring!.getWorldPosition(at);
    expect(at.x).toBeCloseTo(RESPAWN_AT.x, 9);
    expect(at.z).toBeCloseTo(RESPAWN_AT.y, 9);
    views.dispose();
  });

  it('snaps only the revived tank: the other player keeps interpolating on the same sync', () => {
    // The half that makes this a per-TANK teleport rather than a second world-wide
    // `snap`. Without it the fix would freeze every tank in the arena for a frame
    // whenever anyone respawned.
    const scene = new THREE.Scene();
    const views = createEntityViews(scene);
    const survivor = upToTheDeath(scene, views);

    const dead = vsWorld({ alive: false, pos: DIED_AT }, { x: 20, y: 20 });
    const revived = vsWorld({ alive: true, pos: RESPAWN_AT }, { x: 21, y: 20 });
    views.sync(dead, revived, 0.5, 0.016);
    scene.updateMatrixWorld(true);

    expect(survivor.position.x, 'the survivor was snapped too').toBeCloseTo(20.5, 9);
    expect(survivor.position.z).toBeCloseTo(20, 9);
    views.dispose();
  });

  it('snaps the revived tank\'s FACING as well as its position', () => {
    // A respawn re-orients as well as relocating. Lerping the angle drew the hull
    // spinning to its new heading over the same frame it was streaking across the map.
    const scene = new THREE.Scene();
    const views = createEntityViews(scene);
    const survivor = upToTheDeath(scene, views);

    const dead = vsWorld({ alive: false, pos: DIED_AT, bodyAngle: 0, turretAngle: 0 }, { x: 20, y: 20 });
    const revived = vsWorld(
      { alive: true, pos: RESPAWN_AT, bodyAngle: Math.PI / 2, turretAngle: Math.PI / 2 },
      { x: 21, y: 20 },
    );
    views.sync(dead, revived, 0.5, 0.016);
    scene.updateMatrixWorld(true);

    const g = revivedGroup(scene, survivor);
    expect(g.rotation.y, 'the hull was lerped to a half-turned heading').toBeCloseTo(-Math.PI / 2, 9);
    views.dispose();
  });

  // FFA and Teams reach the SAME snap -- the mode changes only which colour the spawn
  // ring is built in (resolveOwnerColor: team colour under 'teams', identity colour
  // otherwise), and the acceptance criteria ask for both to be covered rather than for
  // one to be argued to imply the other.
  it.each(['ffa', 'teams'] as const)('holds in %s mode, tank and ring alike', (mode) => {
    const scene = new THREE.Scene();
    const views = createEntityViews(scene);
    const alive = vsWorld({ alive: true, pos: DIED_AT }, { x: 20, y: 20 }, mode);
    views.sync(alive, alive, 1, 0.016);
    const dead = vsWorld({ alive: false, pos: DIED_AT }, { x: 20, y: 20 }, mode);
    views.sync(alive, dead, 1, 0.016);
    const survivor = tankGroups(scene)[0];

    const revived = vsWorld({ alive: true, pos: RESPAWN_AT }, { x: 21, y: 20 }, mode);
    views.sync(dead, revived, 0.5, 0.016);
    scene.updateMatrixWorld(true);

    const g = revivedGroup(scene, survivor);
    expect(g.position.x).toBeCloseTo(RESPAWN_AT.x, 9);
    expect(g.position.z).toBeCloseTo(RESPAWN_AT.y, 9);
    let ring: THREE.Object3D | undefined;
    g.traverse((o) => {
      if (o.name === 'spawn-ring') ring = o;
    });
    const at = new THREE.Vector3();
    ring!.getWorldPosition(at);
    expect(at.x).toBeCloseTo(RESPAWN_AT.x, 9);
    expect(at.z).toBeCloseTo(RESPAWN_AT.y, 9);
    // The mode really is in play, rather than the argument being ignored: under 'teams'
    // the ring is built in the tank's TEAM colour, under 'ffa' in its identity colour,
    // and team 0 and slot 0 are different colours.
    const expected = mode === 'teams' ? TEAM_COLORS[0] : IDENTITY_RING_COLORS[0];
    expect((ring as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>).material.color.getHex())
      .toBe(expected);
    views.dispose();
  });

  it('leaves the death pulse at the death point while the spawn effect begins at the respawn', () => {
    // The two-location sequence, composed: the two systems are independent by
    // construction -- death-pulse.ts reads the EVENT's `pos` and never the tank view
    // (its own test pins that), while the spawn ring is a child of the tank group --
    // so this is the case that shows the pair reading as one event to the player: a
    // ring left behind where the tank died, and a second ring where it comes back.
    const scene = new THREE.Scene();
    const views = createEntityViews(scene);
    const dp = createDeathPulseSystem(scene);
    const survivor = upToTheDeath(scene, views);

    const dead = vsWorld({ alive: false, pos: DIED_AT }, { x: 20, y: 20 });
    dp.spawn(
      [{ type: 'tank-destroyed', tankId: 1, kind: 'player', by: { source: 'shell', ownerId: 1 }, pos: DIED_AT }],
      dead,
      { enemyEnabled: false },
    );
    const revived = vsWorld({ alive: true, pos: RESPAWN_AT }, { x: 21, y: 20 });
    views.sync(dead, revived, 0.5, 0.016);
    scene.updateMatrixWorld(true);

    const pulse = scene.children.filter((c) => c.name === 'death-ring' && c.visible);
    expect(pulse, 'no death pulse for the death that started this').toHaveLength(1);
    expect(pulse[0].position.x, 'the death pulse followed the tank to its respawn').toBeCloseTo(DIED_AT.x, 9);
    expect(pulse[0].position.z).toBeCloseTo(DIED_AT.y, 9);

    let ring: THREE.Object3D | undefined;
    revivedGroup(scene, survivor).traverse((o) => {
      if (o.name === 'spawn-ring') ring = o;
    });
    const at = new THREE.Vector3();
    ring!.getWorldPosition(at);
    expect(at.x, 'the spawn effect did not start at the respawn').toBeCloseTo(RESPAWN_AT.x, 9);
    expect(at.z).toBeCloseTo(RESPAWN_AT.y, 9);
    // Not vacuous: the two rings are in genuinely different places, so an
    // implementation that put both at either end fails one of the two pairs above.
    expect(Math.abs(pulse[0].position.x - at.x)).toBeGreaterThan(1);

    dp.dispose();
    views.dispose();
  });

  it('handles a respawn at the SAME point as the death without special-casing it', () => {
    // The degenerate case the acceptance criteria name: snapping and lerping agree
    // here, so this cannot distinguish the fix -- it exists to prove the fix does not
    // BREAK the case where nothing moved, which a mis-scoped snap easily could.
    const scene = new THREE.Scene();
    const views = createEntityViews(scene);
    const survivor = upToTheDeath(scene, views);

    const dead = vsWorld({ alive: false, pos: DIED_AT }, { x: 20, y: 20 });
    const revived = vsWorld({ alive: true, pos: DIED_AT }, { x: 21, y: 20 });
    views.sync(dead, revived, 0.5, 0.016);
    scene.updateMatrixWorld(true);

    const g = revivedGroup(scene, survivor);
    expect(g.position.x).toBeCloseTo(DIED_AT.x, 9);
    expect(g.position.z).toBeCloseTo(DIED_AT.y, 9);
    views.dispose();
  });
});
