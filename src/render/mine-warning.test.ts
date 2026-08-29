import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  mineWarningFrame, FUSE_WARNING_SECONDS, RING_STEPS,
  glowRadius, glowOpacity, litInnerFraction, litStepFor, litInnerForStep,
  makeMineLitRing, makeMineGlowMesh, disposeMineGlowMesh,
  GLOW_START_SCALE, GLOW_END_SCALE,
} from './mine-warning';
import { MINE_R, MINE_Y, createEntityViews } from './entities';
import type { World } from '../sim/world';
import type { Mine } from '../sim/types';
import { MINE_TIMER, MINE_PROXIMITY_DELAY_TICKS, MINE_FUSE_WARNING_TICKS, DT } from '../sim/constants';

function mine(over: Partial<Mine> = {}): Mine {
  return { id: 1, ownerId: 2, pos: { x: 0, y: 0 }, timer: MINE_TIMER, armed: true, detonated: false, ...over };
}

function fillWorld(left: number): World {
  return {
    tick: 0, nextId: 100, seed: 3, tanks: [], bullets: [],
    mines: [{ id: 1, ownerId: 2, pos: { x: 0, y: 0 }, timer: MINE_TIMER, armed: true, detonated: false, proximityDelayLeft: left }],
    blasts: [], walls: [], spawns: [], status: 'playing', lives: 3, roundStartTick: 0,
    unarmedTrigger: 'none', corpseBlocksShells: false, muzzleClearsTanks: true,
    coopAttempts: true, mode: 'campaign-coop', friendlyFire: false,
  };
}

describe('fuse urgency: a glow from underneath', () => {
  it('is absent for a mine whose fuse has not reached its final window', () => {
    expect(mineWarningFrame(mine({ timer: FUSE_WARNING_SECONDS + DT })).fuse).toBeNull();
  });

  it('appears exactly at the threshold mines.ts latches its event on', () => {
    // Same comparison as src/sim/mines.ts (`timer <= MINE_FUSE_WARNING_TICKS * DT`), so the
    // first glow frame and the mine-fuse-warning event cannot disagree.
    expect(FUSE_WARNING_SECONDS).toBe(MINE_FUSE_WARNING_TICKS * DT);
    expect(mineWarningFrame(mine({ timer: FUSE_WARNING_SECONDS })).fuse).not.toBeNull();
  });

  it('GROWS monotonically as the fuse runs out, and is largest at expiry', () => {
    // The urgency channel. Sampled across the window rather than at one point, because a
    // single sample passes against a constant.
    const radii = [1, 0.75, 0.5, 0.25, 0].map(
      (f) => glowRadius(mineWarningFrame(mine({ timer: FUSE_WARNING_SECONDS * f })).fuse!.growth, MINE_R),
    );
    for (let i = 1; i < radii.length; i++) expect(radii[i]).toBeGreaterThan(radii[i - 1]);
  });

  it('BRIGHTENS as it spreads, so intensity and size agree', () => {
    // Two channels moving together rather than against each other: a glow that grew while
    // fading would read as receding at the moment it is most urgent.
    const early = mineWarningFrame(mine({ timer: FUSE_WARNING_SECONDS })).fuse!.growth;
    const late = mineWarningFrame(mine({ timer: 0 })).fuse!.growth;
    expect(glowOpacity(late)).toBeGreaterThan(glowOpacity(early));
  });

  it('NEVER oscillates: no frame is dimmer or smaller than the frame before it', () => {
    // The owner ruling that replaced the blink. Sweeping the whole window is what makes
    // this catch a re-introduced flash rather than a coarse spot check: any blink term at
    // all produces at least one backward step somewhere in these 400 samples.
    let prevR = -Infinity;
    let prevO = -Infinity;
    for (let i = 0; i <= 400; i++) {
      const g = mineWarningFrame(mine({ timer: FUSE_WARNING_SECONDS * (1 - i / 400) })).fuse!.growth;
      const r = glowRadius(g, MINE_R);
      const o = glowOpacity(g);
      expect(r).toBeGreaterThanOrEqual(prevR);
      expect(o).toBeGreaterThanOrEqual(prevO);
      prevR = r;
      prevO = o;
    }
  });

  it('clamps at peak rather than overshooting when the fuse is driven past zero', () => {
    // stepMines subtracts dt before it checks expiry, so a mine is observable at a NEGATIVE
    // timer for one tick. Without the high clamp the glow keeps growing past its authored
    // reach at the exact moment it should be steady. Removing clamp01 fails this.
    const atZero = mineWarningFrame(mine({ timer: 0 })).fuse!.growth;
    const past = mineWarningFrame(mine({ timer: -DT * 4 })).fuse!.growth;
    expect(glowRadius(past, MINE_R)).toBe(glowRadius(atZero, MINE_R));
    expect(glowRadius(past, MINE_R)).toBeCloseTo(MINE_R * GLOW_END_SCALE, 9);
  });

  it('starts smaller than the mine and ends larger, which is what "from underneath" needs', () => {
    // Under the body it is hidden; the visible part is the halo past the rim. Starting
    // inside the footprint is what makes it emerge from beneath rather than appear beside.
    expect(GLOW_START_SCALE).toBeLessThan(1);
    expect(GLOW_END_SCALE).toBeGreaterThan(1);
  });
});

describe('proximity trip: the mine lights from the OUTSIDE in', () => {
  it('is absent until the mine is actually tripped', () => {
    expect(mineWarningFrame(mine()).proximity).toBeNull();
  });

  it('starts as a rim hairline on the tick it is tripped', () => {
    const f = mineWarningFrame(mine({ proximityDelayLeft: MINE_PROXIMITY_DELAY_TICKS })).proximity!;
    expect(f.lit).toBe(0);
    expect(litInnerFraction(f.lit)).toBe(1); // inner edge still out at the rim
  });

  it('is FULLY lit on the last frame before the blast', () => {
    // "The final proximity-warning frame agrees with the blast-start tick". stepMines
    // decrements first and detonates at 0, so 1 is the last value ever rendered. Dividing
    // by DELAY rather than DELAY-1 tops out at 29/30 and the mine never finishes lighting.
    const f = mineWarningFrame(mine({ proximityDelayLeft: 1 })).proximity!;
    expect(f.lit).toBe(1);
    expect(litInnerFraction(f.lit)).toBe(0); // inner edge closed to the centre
  });

  it('closes INWARD, not outward -- the direction is the whole ruling', () => {
    // The previous revision grew a disc from the centre out. Those are the same numbers
    // read the other way round, so a sign error reproduces the old look while every timing
    // assertion still passes. This is the test that separates them.
    const inners: number[] = [];
    for (let left = MINE_PROXIMITY_DELAY_TICKS; left >= 1; left--) {
      inners.push(litInnerFraction(mineWarningFrame(mine({ proximityDelayLeft: left })).proximity!.lit));
    }
    for (let i = 1; i < inners.length; i++) expect(inners[i]).toBeLessThan(inners[i - 1]);
    expect(inners[0]).toBeGreaterThan(inners[inners.length - 1]);
  });

  it('keeps the mine\'s own radius as its OUTER edge at every step', () => {
    // What makes it read as the mine lighting up rather than as a disc growing on top of
    // it: the lit region is always anchored to the rim, and only the inner edge moves.
    for (let step = 0; step < RING_STEPS; step++) {
      const geo = makeMineLitRing(MINE_R, step);
      const p = geo.getAttribute('position');
      let max = 0;
      for (let i = 0; i < p.count; i++) max = Math.max(max, Math.hypot(p.getX(i), p.getY(i)));
      expect(max).toBeCloseTo(MINE_R, 6);
      geo.dispose();
    }
  });

  it('never draws a zero-width ring, so the first tripped frame shows something', () => {
    // RingGeometry with inner === outer has no visible surface. Without the hairline floor
    // the cue would appear to start late by however long step 0 lasts.
    const geo = makeMineLitRing(MINE_R, 0);
    const p = geo.getAttribute('position');
    let min = Infinity;
    for (let i = 0; i < p.count; i++) min = Math.min(min, Math.hypot(p.getX(i), p.getY(i)));
    expect(min).toBeLessThan(MINE_R);
    geo.dispose();
  });

  it('stays within the mine footprint', () => {
    // The containment half of the owner's earlier ruling still holds for this cue: it is
    // the mine lighting up, so it may not spread onto the arena.
    const geo = makeMineLitRing(MINE_R, RING_STEPS - 1);
    const p = geo.getAttribute('position');
    let max = 0;
    for (let i = 0; i < p.count; i++) max = Math.max(max, Math.hypot(p.getX(i), p.getY(i)));
    // 1e-6, not an exact bound: RingGeometry stores positions as float32, so the rim
    // vertices land a few hundred-millionths either side of the radius they were built
    // from. A tighter epsilon tests the buffer's precision rather than the containment.
    expect(max).toBeLessThanOrEqual(MINE_R + 1e-6);
    geo.dispose();
  });
});

describe('the two states coexist', () => {
  it('a mine tripped inside its final fuse window reports BOTH', () => {
    const f = mineWarningFrame(mine({ timer: FUSE_WARNING_SECONDS / 2, proximityDelayLeft: 10 }));
    expect(f.fuse).not.toBeNull();
    expect(f.proximity).not.toBeNull();
  });

  it('a detonated mine reports neither, so nothing outlives the blast', () => {
    const f = mineWarningFrame(mine({ timer: 0, proximityDelayLeft: 1, detonated: true }));
    expect(f.fuse).toBeNull();
    expect(f.proximity).toBeNull();
  });
});

describe('quantisation of the illuminated annulus', () => {
  it('round-trips: every step maps back to itself', () => {
    for (let step = 0; step < RING_STEPS; step++) {
      expect(litStepFor(litInnerForStep(step))).toBe(step);
    }
  });

  it('never indexes outside the ladder, even for out-of-range input', () => {
    for (const v of [-5, 0, 0.5, 1, 5]) {
      expect(litStepFor(v)).toBeGreaterThanOrEqual(0);
      expect(litStepFor(v)).toBeLessThan(RING_STEPS);
    }
  });
});

describe('the cues are actually VISIBLE, not just computed', () => {
  // This block exists because an earlier revision was CORRECT in its numbers and invisible
  // on screen for half the countdown. Frame tests assert fractions; nothing in them says
  // whether pixels reach the player.

  it('the glow is ADDITIVE and FADES OUT, so it reads as light rather than a painted disc', () => {
    // Additive alone is not enough: a flat additive disc still has a hard rim, and a hard
    // rim is the decal quality the owner objected to arriving by another route. The alpha
    // must actually reach zero at the circumference.
    const mesh = makeMineGlowMesh();
    const mat = mesh.material as THREE.MeshBasicMaterial;
    expect(mat.blending).toBe(THREE.AdditiveBlending);
    const tex = mat.map!;
    expect(tex).toBeDefined();
    const px = (tex.image as { data: Uint8ClampedArray }).data;
    const n = tex.image.width as number;
    const alphaAt = (x: number, y: number) => px[(y * n + x) * 4 + 3];
    const mid = Math.floor((n - 1) / 2);
    expect(alphaAt(mid, mid)).toBeGreaterThan(240); // opaque at the centre
    expect(alphaAt(0, mid)).toBe(0); // and gone at the rim
    expect(alphaAt(mid, mid)).toBeGreaterThan(alphaAt(Math.floor(n * 0.75), mid)); // monotone
    disposeMineGlowMesh(mesh);
  });

  it('disposing the glow releases its TEXTURE, which Material.dispose does not', () => {
    // entities.ts's generic disposeObject frees geometry and material only, so routing the
    // glow through it would leak one 64x64 RGBA buffer per mine that burned its fuse down.
    const mesh = makeMineGlowMesh();
    const tex = (mesh.material as THREE.MeshBasicMaterial).map!;
    let disposed = false;
    tex.addEventListener('dispose', () => {
      disposed = true;
    });
    disposeMineGlowMesh(mesh);
    expect(disposed).toBe(true);
  });

  it('the illumination clears the dome, so it is visible from the tick it is tripped', () => {
    // Laid on the felt it would be under an opaque body and hidden for most of the window.
    const scene = new THREE.Scene();
    const v = createEntityViews(scene);
    const w = fillWorld(MINE_PROXIMITY_DELAY_TICKS);
    v.sync(w, w, 0);
    const mesh = scene.children.find((c) => c.name === 'mine-proximity-fill') as THREE.Mesh;
    expect(mesh).toBeDefined();
    expect(mesh.position.y).toBeGreaterThan(MINE_Y * 2);
    v.dispose();
  });

  it('the glow sits BELOW the mine, which is what makes it a glow from underneath', () => {
    // The two cues are separated by height, not just by shape: light under the object
    // versus light on it. Same height for both would collapse that distinction.
    const scene = new THREE.Scene();
    const v = createEntityViews(scene);
    const w: World = { ...fillWorld(5), mines: [{ ...fillWorld(5).mines[0], timer: FUSE_WARNING_SECONDS / 2 }] };
    v.sync(w, w, 0);
    const glow = scene.children.find((c) => c.name === 'mine-fuse-warning') as THREE.Mesh;
    const lit = scene.children.find((c) => c.name === 'mine-proximity-fill') as THREE.Mesh;
    expect(glow.position.y).toBeLessThan(MINE_Y); // under the body
    expect(lit.position.y).toBeGreaterThan(MINE_Y * 2); // on the crown
    v.dispose();
  });
});
