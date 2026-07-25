import * as THREE from 'three';
import type { World } from '../sim/world';
import type { Wall, TankKind } from '../sim/types';
import { lerpAngle, lerpVec2 } from './interpolate';
import { TANK_RADIUS, BULLET_RADIUS } from '../sim/constants';

export interface EntityViews {
  sync(prev: World, curr: World, alpha: number): void;
  dispose(): void;
}

const TANK_COLORS: Record<TankKind, number> = {
  player: 0x3d7bd6,
  brown: 0x8a5a2b,
  grey: 0x8890a0,
  teal: 0x2bb0a6,
};

const TANK_BODY_H = 0.4;
const BULLET_Y = 0.35;
const MINE_Y = 0.06;
const WALL_H = 1.0;

function indexById<T extends { id: number }>(arr: T[]): Map<number, T> {
  const m = new Map<number, T>();
  for (const e of arr) m.set(e.id, e);
  return m;
}

function disposeObject(obj: THREE.Object3D): void {
  obj.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
    else if (mat) mat.dispose();
  });
  obj.parent?.remove(obj);
}

export function createEntityViews(scene: THREE.Scene): EntityViews {
  const tankViews = new Map<number, { group: THREE.Group; turret: THREE.Object3D }>();
  const bulletViews = new Map<number, THREE.Mesh>();
  const mineViews = new Map<number, THREE.Mesh>();
  const wallViews = new Map<number, THREE.Mesh>();

  function makeTank(kind: TankKind): { group: THREE.Group; turret: THREE.Object3D } {
    const group = new THREE.Group();
    const color = TANK_COLORS[kind];

    const bodyMat = new THREE.MeshStandardMaterial({ color, roughness: 0.75 });
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(TANK_RADIUS * 2, TANK_BODY_H, TANK_RADIUS * 1.6),
      bodyMat,
    );
    body.position.y = TANK_BODY_H / 2;
    body.castShadow = true;
    body.receiveShadow = true;
    group.add(body);

    const turret = new THREE.Group();
    turret.position.y = TANK_BODY_H + 0.12;
    const turretMat = new THREE.MeshStandardMaterial({ color, roughness: 0.5 });
    const dome = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.28, 0.5), turretMat);
    dome.castShadow = true;
    turret.add(dome);
    const barrel = new THREE.Mesh(
      new THREE.CylinderGeometry(0.07, 0.07, 0.7, 8),
      turretMat,
    );
    barrel.rotation.z = Math.PI / 2; // lay the cylinder along local +x
    barrel.position.set(0.42, 0, 0);
    barrel.castShadow = true;
    turret.add(barrel);
    group.add(turret);

    scene.add(group);
    return { group, turret };
  }

  function makeBullet(): THREE.Mesh {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(BULLET_RADIUS * 1.6, 8, 8),
      new THREE.MeshStandardMaterial({ color: 0xf5f0d0, emissive: 0x444422 }),
    );
    mesh.castShadow = true;
    scene.add(mesh);
    return mesh;
  }

  function makeMine(): THREE.Mesh {
    const mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(0.28, 0.28, MINE_Y * 2, 12),
      new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.6 }),
    );
    mesh.castShadow = true;
    scene.add(mesh);
    return mesh;
  }

  function makeWall(wall: Wall): THREE.Mesh {
    const w = wall.aabb.maxX - wall.aabb.minX;
    const d = wall.aabb.maxY - wall.aabb.minY;
    const geo = new THREE.BoxGeometry(w, WALL_H, d);
    const mat =
      wall.kind === 'destructible'
        ? new THREE.MeshStandardMaterial({ color: 0xb08040, roughness: 0.95 })
        : new THREE.MeshStandardMaterial({ color: 0x565b66, roughness: 0.85 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(
      (wall.aabb.minX + wall.aabb.maxX) / 2,
      WALL_H / 2,
      (wall.aabb.minY + wall.aabb.maxY) / 2,
    );
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    return mesh;
  }

  function syncTanks(prev: World, curr: World, alpha: number): void {
    const prevMap = indexById(prev.tanks);
    const seen = new Set<number>();
    for (const t of curr.tanks) {
      if (!t.alive) continue;
      seen.add(t.id);
      let view = tankViews.get(t.id);
      if (!view) {
        view = makeTank(t.kind);
        tankViews.set(t.id, view);
      }
      const p = prevMap.get(t.id);
      // New id (no prev): snap to curr pose, do not lerp from a garbage origin.
      const pos = p ? lerpVec2(p.pos, t.pos, alpha) : t.pos;
      const bodyA = p ? lerpAngle(p.bodyAngle, t.bodyAngle, alpha) : t.bodyAngle;
      const turretA = p ? lerpAngle(p.turretAngle, t.turretAngle, alpha) : t.turretAngle;
      view.group.position.set(pos.x, 0, pos.y);
      view.group.rotation.y = -bodyA;
      view.turret.rotation.y = -turretA;
    }
    for (const [id, view] of tankViews) {
      if (!seen.has(id)) {
        disposeObject(view.group);
        tankViews.delete(id);
      }
    }
  }

  function syncBullets(prev: World, curr: World, alpha: number): void {
    const prevMap = indexById(prev.bullets);
    const seen = new Set<number>();
    for (const b of curr.bullets) {
      if (!b.alive) continue;
      seen.add(b.id);
      let mesh = bulletViews.get(b.id);
      if (!mesh) {
        mesh = makeBullet();
        bulletViews.set(b.id, mesh);
      }
      const p = prevMap.get(b.id);
      const pos = p && p.alive ? lerpVec2(p.pos, b.pos, alpha) : b.pos;
      mesh.position.set(pos.x, BULLET_Y, pos.y);
    }
    for (const [id, mesh] of bulletViews) {
      if (!seen.has(id)) {
        disposeObject(mesh);
        bulletViews.delete(id);
      }
    }
  }

  function syncMines(_prev: World, curr: World, _alpha: number): void {
    const seen = new Set<number>();
    for (const m of curr.mines) {
      if (m.detonated) continue;
      seen.add(m.id);
      let mesh = mineViews.get(m.id);
      if (!mesh) {
        mesh = makeMine();
        mineViews.set(m.id, mesh);
      }
      mesh.position.set(m.pos.x, MINE_Y, m.pos.y);
      // Armed mines glow slightly to read as "hot".
      const mat = mesh.material as THREE.MeshStandardMaterial;
      mat.emissive.setHex(m.armed ? 0x661111 : 0x000000);
    }
    for (const [id, mesh] of mineViews) {
      if (!seen.has(id)) {
        disposeObject(mesh);
        mineViews.delete(id);
      }
    }
  }

  function syncWalls(curr: World): void {
    for (const wall of curr.walls) {
      const existing = wallViews.get(wall.id);
      if (wall.destroyed) {
        if (existing) {
          disposeObject(existing);
          wallViews.delete(wall.id);
        }
        continue;
      }
      if (!existing) {
        wallViews.set(wall.id, makeWall(wall));
      }
    }
  }

  function sync(prev: World, curr: World, alpha: number): void {
    syncWalls(curr);
    syncTanks(prev, curr, alpha);
    syncBullets(prev, curr, alpha);
    syncMines(prev, curr, alpha);
  }

  function dispose(): void {
    for (const v of tankViews.values()) disposeObject(v.group);
    for (const m of bulletViews.values()) disposeObject(m);
    for (const m of mineViews.values()) disposeObject(m);
    for (const m of wallViews.values()) disposeObject(m);
    tankViews.clear();
    bulletViews.clear();
    mineViews.clear();
    wallViews.clear();
  }

  return { sync, dispose };
}
