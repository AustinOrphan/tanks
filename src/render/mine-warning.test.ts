import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  mineWarningFrame, ringStepFor, ringInnerForStep, RING_STEPS, FUSE_WARNING_SECONDS,
  makeMineWarningRing, makeMineWarningRingMesh, makeMineWarningFillMesh, RING_OUTER_SCALE, FILL_OUTER_SCALE,
} from './mine-warning';
import { MINE_R, MINE_Y, createEntityViews } from './entities';
import type { World } from '../sim/world';
import type { Mine } from '../sim/types';
import { MINE_TIMER, MINE_PROXIMITY_DELAY_TICKS, MINE_FUSE_WARNING_TICKS, DT } from '../sim/constants';

function fillWorld(left: number): World {
  return {
    tick: 0, nextId: 100, seed: 3, tanks: [], bullets: [],
    mines: [{ id: 1, ownerId: 2, pos: { x: 0, y: 0 }, timer: MINE_TIMER, armed: true, detonated: false, proximityDelayLeft: left }],
    blasts: [], walls: [], spawns: [], status: 'playing', lives: 3, roundStartTick: 0,
    unarmedTrigger: 'none', corpseBlocksShells: false, muzzleClearsTanks: true,
    coopAttempts: true, mode: 'campaign-coop', friendlyFire: false,
  };
}

function mine(over: Partial<Mine> = {}): Mine {
  return { id: 1, ownerId: 2, pos: { x: 0, y: 0 }, timer: MINE_TIMER, armed: true, detonated: false, ...over };
}

describe('mineWarningFrame: fuse urgency', () => {
  it('is absent for a mine whose fuse has not reached its final window', () => {
    // The window is the fuse's LAST 0.5s; a mine one tick outside it must draw no ring at
    // all, or the "warning" is just the mine's whole life and says nothing.
    expect(mineWarningFrame(mine({ timer: FUSE_WARNING_SECONDS + DT })).fuse).toBeNull();
  });

  it('appears exactly at the threshold mines.ts latches its event on', () => {
    // Same comparison as src/sim/mines.ts (`timer <= MINE_FUSE_WARNING_TICKS * DT`), so the
    // first ring frame and the mine-fuse-warning event cannot disagree. Change either side
    // to `<` and this fails.
    expect(FUSE_WARNING_SECONDS).toBe(MINE_FUSE_WARNING_TICKS * DT);
    expect(mineWarningFrame(mine({ timer: FUSE_WARNING_SECONDS })).fuse).not.toBeNull();
  });

  it('THICKENS monotonically as the fuse runs out, and is thickest at expiry', () => {
    // The load-bearing half of the design: thickness is the channel that survives a still
    // frame and a colourblind viewer. Sampled across the window rather than at one point,
    // because a single sample passes against a constant.
    const inners = [1, 0.75, 0.5, 0.25, 0].map(
      (f) => mineWarningFrame(mine({ timer: FUSE_WARNING_SECONDS * f })).fuse!.inner,
    );
    for (let i = 1; i < inners.length; i++) {
      expect(inners[i]).toBeLessThan(inners[i - 1]); // smaller inner radius == thicker stroke
    }
    expect(inners[inners.length - 1]).toBeLessThan(inners[0]);
  });

  it('clamps at peak urgency rather than inverting when the fuse is driven past zero', () => {
    // stepMines subtracts dt before it checks expiry, so a mine can be observed at a
    // NEGATIVE timer for one tick. Without the HIGH clamp, urgency exceeds 1, `inner`
    // overshoots the thickest step, and the urgency cue runs BACKWARDS at its peak.
    // Removing clamp01 entirely is what fails this; note that clamp01's LOW bound is
    // unreachable in this branch, so replacing it with Math.min(1, ...) is an equivalent
    // mutant and this test correctly stays green for it.
    const atZero = mineWarningFrame(mine({ timer: 0 })).fuse!;
    const past = mineWarningFrame(mine({ timer: -DT * 4 })).fuse!;
    expect(past.inner).toBe(atZero.inner);
  });

  it('blinks FASTER late than early: successive on/off runs get SHORTER', () => {
    // "Blinks more and more rapidly" is the stated design, and the discriminating measure is
    // run LENGTH, not a transition count. An earlier version of this test compared
    // transitions in the first and last quarter and PASSED against a constant-rate blink --
    // it was only proving that the phase advanced at all. Run lengths are equal under a
    // linear phase and strictly decreasing under the quadratic one, so replacing
    // `urgency * urgency` with `urgency` fails here.
    const samples = 4000;
    const runs: number[] = [];
    let prev = mineWarningFrame(mine({ timer: FUSE_WARNING_SECONDS })).fuse!.on;
    let runStart = 0;
    for (let i = 1; i <= samples; i++) {
      const u = i / samples;
      const on = mineWarningFrame(mine({ timer: FUSE_WARNING_SECONDS * (1 - u) })).fuse!.on;
      if (on !== prev) {
        runs.push(u - runStart);
        runStart = u;
        prev = on;
      }
    }
    expect(runs.length).toBeGreaterThanOrEqual(2); // non-vacuity: there ARE blinks to compare
    for (let i = 1; i < runs.length; i++) expect(runs[i]).toBeLessThan(runs[i - 1]);
  });

  it('keeps the blink at or below 6 Hz, the flash-safety cap the module documents', () => {
    // A claim in the doc comment that nothing checked would drift the moment BLINK_TURNS is
    // retuned. Measures the shortest observed ON or OFF run in real seconds and asserts the
    // implied frequency; raising BLINK_TURNS past 1.5 fails this.
    const samples = 4000;
    let prev = mineWarningFrame(mine({ timer: FUSE_WARNING_SECONDS })).fuse!.on;
    let runStart = 0;
    let shortest = Infinity;
    for (let i = 1; i <= samples; i++) {
      const t = i / samples;
      const on = mineWarningFrame(mine({ timer: FUSE_WARNING_SECONDS * (1 - t) })).fuse!.on;
      if (on !== prev) {
        shortest = Math.min(shortest, (t - runStart) * FUSE_WARNING_SECONDS);
        runStart = t;
        prev = on;
      }
    }
    // A full cycle is two runs, so shortest-run seconds * 2 is the fastest period.
    expect(1 / (shortest * 2)).toBeLessThanOrEqual(6.01);
  });
});

describe('mineWarningFrame: proximity trip', () => {
  it('is absent until the mine is actually tripped', () => {
    // `proximityDelayLeft` undefined is the sim's "not tripped". Rendering a fill for an
    // untripped mine would tell the player they had set off a mine they had not touched.
    expect(mineWarningFrame(mine()).proximity).toBeNull();
  });

  it('starts EMPTY on the tick it is tripped', () => {
    expect(mineWarningFrame(mine({ proximityDelayLeft: MINE_PROXIMITY_DELAY_TICKS })).proximity!.fill).toBe(0);
  });

  it('is exactly FULL on the last frame before the blast', () => {
    // The acceptance criterion "the final proximity-warning frame agrees with the
    // blast-start tick". stepMines decrements first and detonates at 0, so 1 is the last
    // value ever rendered. Dividing by DELAY rather than DELAY-1 tops out at 29/30 and
    // fails here -- which is the arithmetic slip this test exists to catch.
    expect(mineWarningFrame(mine({ proximityDelayLeft: 1 })).proximity!.fill).toBe(1);
  });

  it('grows monotonically from trip to blast', () => {
    const fills: number[] = [];
    for (let left = MINE_PROXIMITY_DELAY_TICKS; left >= 1; left--) {
      fills.push(mineWarningFrame(mine({ proximityDelayLeft: left })).proximity!.fill);
    }
    for (let i = 1; i < fills.length; i++) expect(fills[i]).toBeGreaterThan(fills[i - 1]);
  });

  it('does not blink: the trip cue is fill only, so the two states differ in KIND', () => {
    // If the proximity cue also blinked, the two warnings would be "a blinking thing" and
    // "a blinking thing", and the criterion is that a player can tell them apart. The fill
    // being monotone is what makes a still frame legible.
    expect(mineWarningFrame(mine({ proximityDelayLeft: 15 })).proximity).not.toHaveProperty('on');
  });
});

describe('mineWarningFrame: the two states coexist', () => {
  it('a mine tripped inside its final fuse window reports BOTH', () => {
    // Reachable in play: walk into a mine that is already nearly out of fuse. Neither cue
    // may suppress the other, or one of the two events silently loses its presentation.
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

describe('ring thickness quantisation', () => {
  it('maps the thinnest and thickest frames onto the end steps', () => {
    const thin = mineWarningFrame(mine({ timer: FUSE_WARNING_SECONDS })).fuse!.inner;
    const thick = mineWarningFrame(mine({ timer: 0 })).fuse!.inner;
    expect(ringStepFor(thin)).toBe(0);
    expect(ringStepFor(thick)).toBe(RING_STEPS - 1);
  });

  it('never indexes outside the ladder, even for out-of-range input', () => {
    // ringStepFor is fed a computed radius; an unclamped map would return -1 or RING_STEPS,
    // and a caller indexing that gets undefined and draws nothing rather than throwing.
    for (const v of [-5, 0, 0.5, 1, 5]) {
      expect(ringStepFor(v)).toBeGreaterThanOrEqual(0);
      expect(ringStepFor(v)).toBeLessThan(RING_STEPS);
    }
  });

  it('round-trips: every step maps back to itself', () => {
    // The two directions are used together -- the frame gives `inner`, the renderer asks for
    // a step, and the geometry is built from that step. If they disagreed the drawn ring
    // would not be the frame's ring. Sweeping every step is what makes this non-vacuous.
    for (let step = 0; step < RING_STEPS; step++) {
      expect(ringStepFor(ringInnerForStep(step))).toBe(step);
    }
  });

  it('builds a ring whose inner radius honours the requested step and outer radius', () => {
    const outer = 0.28;
    const geo = makeMineWarningRing(outer, RING_STEPS - 1);
    const p = geo.getAttribute('position');
    let min = Infinity;
    let max = 0;
    for (let i = 0; i < p.count; i++) {
      const r = Math.hypot(p.getX(i), p.getY(i));
      min = Math.min(min, r);
      max = Math.max(max, r);
    }
    expect(max).toBeCloseTo(outer, 6);
    expect(min).toBeCloseTo(outer * ringInnerForStep(RING_STEPS - 1), 6);
    geo.dispose();
  });
});

describe('the cues are actually VISIBLE, not just computed', () => {
  // This whole block exists because the first version of this feature was CORRECT in its
  // numbers and invisible on screen for half of the countdown. The frame tests above all
  // passed against it: they assert `fill` and `inner`, which say nothing about whether the
  // pixels reach the player. The mine body is opaque, depth-writing, and MINE_R across.

  it('both cues stay INSIDE the mine footprint', () => {
    // Owner ruling on PR #396: the cues live on the mine's own top surface, not as a patch
    // of arena around it. An earlier revision reached 2.2x and 3.0x the mine's radius. This
    // fails the moment either scale grows back past the body.
    expect(MINE_R * RING_OUTER_SCALE).toBeLessThan(MINE_R);
    expect(MINE_R * FILL_OUTER_SCALE).toBeLessThanOrEqual(MINE_R);
  });

  it('the two cues share one footprint, so only their SHAPE tells them apart', () => {
    // Contained on one small crown, size can no longer be a distinguishing channel -- a
    // thickening annulus versus a growing disc is what is left, and matching the outer radii
    // is what forces that. Diverge the scales and this fails.
    expect(RING_OUTER_SCALE).toBe(FILL_OUTER_SCALE);
  });

  it('the ring sits within the FLAT part of the dome, not out on the falling curve', () => {
    // The cues are flat discs laid at apex height; the dome falls away from its apex, so a
    // wide one would visibly float off the curve at its rim. Recomputes the lathe's own
    // elliptical profile rather than trusting a number in a comment: at the ring's outer
    // radius the surface must still be close to the apex.
    const baseH = (MINE_Y * 2) / 3;
    const domeH = MINE_Y * 2 - baseH;
    const r = MINE_R * RING_OUTER_SCALE;
    const surfaceY = baseH + domeH * Math.sin(Math.acos(r / MINE_R));
    expect(MINE_Y * 2 - surfaceY).toBeLessThan(0.03); // within 3cm of the apex
  });

  it('the fill clears the mine body, so it is visible from the tick it is tripped', () => {
    // The defect this replaces: a ground-level fill under an opaque mine is invisible until
    // it is wider than the body, which is most of the reaction window -- the cue starts late
    // and grows out from BEHIND the mine. Two ways to fix it; this asserts the one chosen.
    const scene = new THREE.Scene();
    const v = createEntityViews(scene);
    const w = fillWorld(MINE_PROXIMITY_DELAY_TICKS); // the very first tripped frame
    v.sync(w, w, 0);
    const mesh = scene.children.find((c) => c.name === 'mine-proximity-fill') as THREE.Mesh;
    expect(mesh).toBeDefined();
    // Above the dome: the body spans 0..2*MINE_Y, so anything above that is not occluded.
    expect(mesh.position.y).toBeGreaterThan(MINE_Y * 2);
    v.dispose();
  });

  it('the fill still depth-tests, so a tank standing on the mine hides it', () => {
    // The rejected alternative was `depthTest: false`, which cleared the mine but also drew
    // over the tank -- caught in a normal-speed capture, not by any assertion. Keeping the
    // default here is what makes the height above load-bearing rather than belt-and-braces.
    const mesh = makeMineWarningFillMesh();
    const mat = mesh.material as THREE.MeshBasicMaterial;
    expect(mat.depthTest).not.toBe(false);
    mesh.geometry.dispose();
    mat.dispose();
  });

  it('the ring DOES depth-test, so a tank driving over the mine covers it', () => {
    // The asymmetry is deliberate and worth pinning: the ring is outside the body and reads
    // as ground marking, so normal occlusion is right for it. Only the fill overrides it.
    const mesh = makeMineWarningRingMesh();
    const mat = mesh.material as THREE.MeshBasicMaterial;
    expect(mat.depthTest).not.toBe(false);
    mesh.geometry.dispose();
    mat.dispose();
  });
});
