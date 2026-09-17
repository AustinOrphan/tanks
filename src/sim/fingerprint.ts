import type { World } from './world';

/**
 * Structural fingerprint of a world. `JSON.stringify` would hide -0 and turn NaN into
 * null -- exactly the two values a determinism bug is most likely to produce -- so numbers
 * go through a DataView as raw float64 bits.
 *
 * One definition for every determinism check (issue #760): `determinism.test.ts`'s
 * repeatability and branch checks, and the generated-scenario harness's repeat run
 * (`scenarios.ts`). Collections are walked in their stored order, so a change of ORDER
 * under identical inputs changes the fingerprint as surely as a change of value.
 */
export function worldFingerprint(w: World): string {
  const nums: number[] = [];
  const push = (...xs: number[]): void => {
    nums.push(...xs);
  };
  push(w.tick, w.nextId, w.seed, w.lives, w.roundStartTick, w.status === 'playing' ? 0 : 1);
  for (const t of w.tanks) {
    push(t.id, t.pos.x, t.pos.y, t.bodyAngle, t.turretAngle, t.alive ? 1 : 0);
    push(t.desiredMove.x, t.desiredMove.y, t.fireCooldown, t.mineCooldown, t.aiTimer);
  }
  for (const b of w.bullets) push(b.id, b.pos.x, b.pos.y, b.vel.x, b.vel.y, b.bouncesLeft);
  for (const m of w.mines) push(m.id, m.pos.x, m.pos.y, m.timer, m.armed ? 1 : 0);
  for (const wl of w.walls) push(wl.id, wl.destroyed ? 1 : 0);

  const view = new DataView(new ArrayBuffer(8));
  return nums
    .map((n) => {
      view.setFloat64(0, n);
      return view.getBigUint64(0).toString(36);
    })
    .join(',');
}
