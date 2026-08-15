import * as THREE from 'three';
import type { SimEvent } from '../sim/events';

export interface ParticleSystem {
  spawn(events: SimEvent[]): void;
  update(dt: number): void;
  dispose(): void;
}

interface Particle {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  vel: THREE.Vector3;
  life: number;
  maxLife: number;
  baseScale: number;
}

const MAX_PARTICLES = 500;
const GRAVITY = -6;
const EVENT_Y = 0.5;

export function createParticleSystem(scene: THREE.Scene): ParticleSystem {
  const geo = new THREE.SphereGeometry(0.08, 6, 6);
  const pool: Particle[] = [];
  const active: Particle[] = [];

  function acquire(): Particle | null {
    let p = pool.pop();
    if (!p) {
      if (active.length >= MAX_PARTICLES) return null;
      // depthWrite:false is the important half. A fading transparent particle
      // that writes depth punches an opaque-shaped hole in every particle
      // behind it -- visible as square cutouts wherever two bursts overlap,
      // which is exactly when a mine chains into an explosion. Additive
      // blending is also the right look for sparks and muzzle flash.
      const mat = new THREE.MeshBasicMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const mesh = new THREE.Mesh(geo, mat);
      scene.add(mesh);
      p = { mesh, vel: new THREE.Vector3(), life: 0, maxLife: 1, baseScale: 1 };
    }
    p.mesh.visible = true;
    active.push(p);
    return p;
  }

  function recycle(p: Particle, i: number): void {
    p.mesh.visible = false;
    active.splice(i, 1);
    pool.push(p);
  }

  function burst(
    x: number,
    z: number,
    count: number,
    color: number,
    speed: number,
    life: number,
    scale: number,
  ): void {
    for (let i = 0; i < count; i++) {
      const p = acquire();
      if (!p) return;
      const theta = Math.random() * Math.PI * 2;
      const up = Math.random() * 0.8 + 0.2;
      const s = speed * (0.5 + Math.random() * 0.5);
      p.vel.set(Math.cos(theta) * s, up * s, Math.sin(theta) * s);
      p.life = life * (0.7 + Math.random() * 0.6);
      p.maxLife = p.life;
      p.baseScale = scale;
      p.mesh.material.color.setHex(color);
      p.mesh.material.opacity = 1;
      p.mesh.position.set(x, EVENT_Y, z);
      p.mesh.scale.setScalar(scale);
    }
  }

  function spawn(events: SimEvent[]): void {
    for (const ev of events) {
      switch (ev.type) {
        case 'fire':
          burst(ev.pos.x, ev.pos.y, 5, 0xffd873, 4, 0.18, 0.6);
          break;
        case 'ricochet':
          burst(ev.pos.x, ev.pos.y, 6, 0xfff4c0, 5, 0.25, 0.5);
          break;
        case 'explosion':
          burst(ev.pos.x, ev.pos.y, 24, 0xff6a2b, 6, 0.6, 1.0);
          break;
        case 'tank-destroyed':
          // No burst of its own: both kill sites push `explosion` at the same
          // position on the same tick, so handling both doubled every kill into
          // a 48-particle burst (and, in the audio director, a doubled sample).
          break;
        case 'wall-destroyed':
          burst(ev.pos.x, ev.pos.y, 16, 0xb08040, 4, 0.5, 0.9);
          break;
        case 'mine-detonate':
          burst(ev.pos.x, ev.pos.y, 40, 0xffbb33, 8, 0.7, 1.4);
          break;
        case 'respawn':
          // Coop only (unreachable at playerCount 1 -- see events.ts). Reuses the
          // existing burst() primitive, no new asset -- a cyan-leaning colour distinct
          // from explosion's orange and mine-detonate's amber, reading as arrival
          // rather than destruction.
          burst(ev.pos.x, ev.pos.y, 20, 0x66e0ff, 5, 0.5, 0.9);
          break;
        // 'mine-dropped', 'mine-armed', 'win', 'lose' produce no particles.
        default:
          break;
      }
    }
  }

  function update(dt: number): void {
    for (let i = active.length - 1; i >= 0; i--) {
      const p = active[i];
      p.life -= dt;
      if (p.life <= 0) {
        recycle(p, i);
        continue;
      }
      p.vel.y += GRAVITY * dt;
      p.mesh.position.x += p.vel.x * dt;
      p.mesh.position.y += p.vel.y * dt;
      p.mesh.position.z += p.vel.z * dt;
      if (p.mesh.position.y < 0.02) p.mesh.position.y = 0.02;
      const k = p.life / p.maxLife;
      p.mesh.material.opacity = k;
      p.mesh.scale.setScalar(p.baseScale * (0.4 + 0.6 * k));
    }
  }

  function dispose(): void {
    for (const p of active) {
      p.mesh.material.dispose();
      scene.remove(p.mesh);
    }
    for (const p of pool) {
      p.mesh.material.dispose();
      scene.remove(p.mesh);
    }
    active.length = 0;
    pool.length = 0;
    geo.dispose();
  }

  return { spawn, update, dispose };
}
