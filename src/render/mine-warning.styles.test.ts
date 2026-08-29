// The three judged style variants behind the `mineWarn` dev flag (issue #276 playtest
// round). Each test names the property that made its treatment survive the judging, so
// when the owner picks a winner the losers' tests are deleted with their code and the
// winner's tests explain what must not regress.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  heatColor, heatIntensity, cookoffScale, slumpScale, frozenFuseGrowth,
  styleBodyGrowthDuringTrip, beadHeight, spikeHeight, mastHeight,
  LANCE_HEIGHT, FUSE_WARNING_SECONDS,
  type MineWarnStyle, MINE_WARN_STYLES,
} from './mine-warning';
import { createEntityViews, MINE_Y } from './entities';
import type { World } from '../sim/world';
import type { Mine } from '../sim/types';
import { MINE_TIMER, MINE_PROXIMITY_DELAY_TICKS, DT } from '../sim/constants';

function mine(over: Partial<Mine> = {}): Mine {
  return { id: 1, ownerId: 2, pos: { x: 0, y: 0 }, timer: MINE_TIMER, armed: true, detonated: false, ...over };
}

function world(mines: Mine[]): World {
  return {
    tick: 0, nextId: 100, seed: 3, tanks: [], bullets: [], mines,
    blasts: [], walls: [], spawns: [], status: 'playing', lives: 3, roundStartTick: 0,
    unarmedTrigger: 'none', corpseBlocksShells: false, muzzleClearsTanks: true,
    coopAttempts: true, mode: 'campaign-coop', friendlyFire: false,
  };
}

function styledScene(style: MineWarnStyle) {
  const scene = new THREE.Scene();
  return { scene, v: createEntityViews(scene, undefined, style) };
}

const vert = (s: THREE.Scene) => s.children.find((c) => c.name === 'mine-warn-vert');
const bead = (s: THREE.Scene) => s.children.find((c) => c.name === 'mine-warn-bead');
const body = (s: THREE.Scene) => s.children.find((c) => (c as THREE.Mesh).geometry?.type === 'LatheGeometry') as THREE.Mesh;

describe('the shared heat ramp', () => {
  it('starts at the pulse bright pole, so the handover can step up but never dip', () => {
    // The monotone guarantee across the pulse->ramp handover holds WITHOUT knowing the
    // pulse phase only because the ramp starts at the pulse ceiling (0xff3322).
    const c = heatColor(0, new THREE.Color());
    expect(c.r).toBeCloseTo(0xff / 255, 6);
    expect(c.g).toBeCloseTo(0x33 / 255, 6);
    expect(c.b).toBeCloseTo(0x22 / 255, 6);
  });

  it('ends near-white, and LUMINANCE rises monotonically across the whole ramp', () => {
    // Luminance is the colourblind-safe carrier; a hue-only ramp would fail the dossier.
    // Sweeping the whole ramp is what catches a mid-LUT dip a 3-point check would miss.
    let prev = -1;
    const c = new THREE.Color();
    for (let i = 0; i <= 100; i++) {
      heatColor(i / 100, c);
      const lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
      expect(lum).toBeGreaterThanOrEqual(prev);
      prev = lum;
    }
    expect(heatIntensity(1)).toBeGreaterThan(heatIntensity(0)); // intensity ramps too
    // The endpoint, ASSERTED rather than implied by the title: a ramp frozen at its red
    // start passes non-strict monotonicity, and a negative control proved exactly that
    // mutation survived until this line existed. Near-white means green and blue are high.
    const end = heatColor(1, new THREE.Color());
    expect(end.g).toBeGreaterThan(0.9);
    expect(end.b).toBeGreaterThan(0.8);
  });

  it('cook-off swells to 1.10 and slump spreads to 1.45 wide by 0.5 flat, exactly', () => {
    // The judged magnitudes, pinned: the sync tests only bound these loosely (>1, <0.8),
    // so a quiet retune toward imperceptible would pass them while gutting the 25px read
    // the slump won its slot on.
    expect(cookoffScale(0)).toBe(1);
    expect(cookoffScale(1)).toBeCloseTo(1.10, 9);
    expect(slumpScale(0)).toEqual({ xz: 1, y: 1 });
    expect(slumpScale(1).xz).toBeCloseTo(1.45, 9);
    expect(slumpScale(1).y).toBeCloseTo(0.5, 9);
  });
});

describe('frozenFuseGrowth: pure function of mine state, no view memory', () => {
  it('is 0 for a mine tripped OUTSIDE its fuse window', () => {
    expect(frozenFuseGrowth(mine({ timer: 2.0, proximityDelayLeft: 10 }))).toBe(0);
  });

  it('recovers the growth AT THE TRIP TICK, and holds it as both countdowns advance', () => {
    // The freeze is derived, not remembered: timer-at-trip = timer + elapsed-since-trip.
    // Two observations of the same trip at different delayLeft must agree exactly --
    // which is what makes replay-seek and scene-rebuild draw the identical frame.
    const atTrip = mine({ timer: FUSE_WARNING_SECONDS * 0.6, proximityDelayLeft: MINE_PROXIMITY_DELAY_TICKS });
    const tenLater = mine({
      timer: FUSE_WARNING_SECONDS * 0.6 - 10 * DT,
      proximityDelayLeft: MINE_PROXIMITY_DELAY_TICKS - 10,
    });
    expect(frozenFuseGrowth(tenLater)).toBeCloseTo(frozenFuseGrowth(atTrip), 9);
    expect(frozenFuseGrowth(atTrip)).toBeCloseTo(0.4, 6);
  });

  it('spike slams the body to full heat at the trip; lance and slump freeze it', () => {
    const m = mine({ timer: 2.0, proximityDelayLeft: 10 });
    expect(styleBodyGrowthDuringTrip('spike', m)).toBe(1);
    expect(styleBodyGrowthDuringTrip('lance', m)).toBe(0);
    expect(styleBodyGrowthDuringTrip('slump', m)).toBe(0);
  });
});

describe('the vertical progress channels', () => {
  it('lance: the bead DESCENDS from the lance top and touches the crown on the last frame', () => {
    // Altitude IS time remaining, with the fixed lance as the visible denominator -- the
    // still-frame-clock property that won the judging. Reversing the direction (a rising
    // bead) breaks both assertions.
    expect(beadHeight(0, MINE_Y * 2)).toBeCloseTo(LANCE_HEIGHT, 9);
    expect(beadHeight(1, MINE_Y * 2)).toBeCloseTo(MINE_Y * 2, 9);
    let prev = Infinity;
    for (let q = 0; q <= 1; q += 0.05) {
      const h = beadHeight(q, MINE_Y * 2);
      expect(h).toBeLessThanOrEqual(prev);
      prev = h;
    }
  });

  it('spike: rises monotonically from nothing to full height', () => {
    expect(spikeHeight(0)).toBe(0);
    expect(spikeHeight(1)).toBeCloseTo(1.4, 9);
    expect(spikeHeight(0.5)).toBeGreaterThan(spikeHeight(0.25));
  });

  it('mast: ease-OUT, clearing most of its height in the first fifth of the window', () => {
    // The vertical channel exists FOR the occluded case, so it must escape a parked hull
    // early -- a linear or ease-in rise defeats the reason the mast won its slot.
    expect(mastHeight(0.2)).toBeGreaterThan(1.1 * 0.3);
    expect(mastHeight(1)).toBeCloseTo(1.1, 9);
    expect(mastHeight(0.6)).toBeGreaterThan(mastHeight(0.3));
  });
});

describe('styled sync: the variants through createEntityViews', () => {
  it('default (no style): never creates a vertical element', () => {
    // The shipped treatment must be byte-identical with the flag absent -- the whole
    // playtest premise is that the default is untouched while variants are compared.
    const scene = new THREE.Scene();
    const v = createEntityViews(scene);
    const w = world([mine({ timer: 0.1, proximityDelayLeft: 10 })]);
    v.sync(w, w, 0);
    expect(vert(scene)).toBeUndefined();
    expect(bead(scene)).toBeUndefined();
    v.dispose();
  });

  for (const style of [...MINE_WARN_STYLES] as MineWarnStyle[]) {
    it(`${style}: suppresses BOTH default cues -- one treatment at a time`, () => {
      const { scene, v } = styledScene(style);
      const w = world([mine({ timer: 0.1, proximityDelayLeft: 10 })]);
      v.sync(w, w, 0);
      expect(scene.children.find((c) => c.name === 'mine-fuse-warning')).toBeUndefined();
      expect(scene.children.find((c) => c.name === 'mine-proximity-fill')).toBeUndefined();
      v.dispose();
    });
  }

  it('lance: fuse heats and swells the BODY, with the base kept seated on the felt', () => {
    const { scene, v } = styledScene('lance');
    const w = world([mine({ timer: 0.05 })]); // deep in the fuse window
    v.sync(w, w, 0);
    const mesh = body(scene);
    const mat = mesh.material as THREE.MeshStandardMaterial;
    expect(mat.emissiveIntensity).toBeGreaterThan(1);
    expect(mesh.scale.x).toBeGreaterThan(1);
    // Seating invariant: the lathe spans +/-MINE_Y about its origin, so position.y must
    // track the Y scale exactly or the swollen base sinks through the felt.
    expect(mesh.position.y).toBeCloseTo(MINE_Y * mesh.scale.y, 9);
    v.dispose();
  });

  it('slump: spreads WIDE and squashes FLAT -- the horizontal axis the camera keeps', () => {
    const { scene, v } = styledScene('slump');
    const w = world([mine({ timer: 0.05 })]);
    v.sync(w, w, 0);
    const mesh = body(scene);
    expect(mesh.scale.x).toBeGreaterThan(1.2);
    expect(mesh.scale.y).toBeLessThan(0.8);
    expect(mesh.position.y).toBeCloseTo(MINE_Y * mesh.scale.y, 9);
    v.dispose();
  });

  it('lance: the lance stands FULL HEIGHT from the first tripped frame (fixed denominator)', () => {
    const { scene, v } = styledScene('lance');
    const w = world([mine({ proximityDelayLeft: MINE_PROXIMITY_DELAY_TICKS })]);
    v.sync(w, w, 0);
    expect(vert(scene)).toBeDefined();
    expect(bead(scene)).toBeDefined();
    // The lance is centred at H/2 and never scales -- only the bead moves.
    expect(vert(scene)!.position.y).toBeCloseTo(LANCE_HEIGHT / 2, 9);
    expect(bead(scene)!.position.y).toBeCloseTo(LANCE_HEIGHT, 6);
    v.dispose();
  });

  it('lance: the bead descends across the window and reaches the crown at the last frame', () => {
    const { scene, v } = styledScene('lance');
    const heights: number[] = [];
    for (const left of [MINE_PROXIMITY_DELAY_TICKS, 20, 10, 1]) {
      const w = world([mine({ proximityDelayLeft: left })]);
      v.sync(w, w, 0);
      heights.push(bead(scene)!.position.y);
    }
    for (let i = 1; i < heights.length; i++) expect(heights[i]).toBeLessThan(heights[i - 1]);
    expect(heights[heights.length - 1]).toBeCloseTo(MINE_Y * 2, 6);
    v.dispose();
  });

  it('spike and slump: the vertical grows as the countdown runs', () => {
    for (const style of ['spike', 'slump'] as const) {
      const { scene, v } = styledScene(style);
      const sizes: number[] = [];
      for (const left of [25, 15, 5]) {
        const w = world([mine({ proximityDelayLeft: left })]);
        v.sync(w, w, 0);
        const g = vert(scene)!;
        sizes.push(style === 'spike' ? g.scale.y : g.getObjectByName('mast-rod')!.scale.y);
      }
      expect(sizes[1]).toBeGreaterThan(sizes[0]);
      expect(sizes[2]).toBeGreaterThan(sizes[1]);
      v.dispose();
    }
  });

  it('freezes the fuse channel during a trip: the body stops moving, the vertical moves', () => {
    // Two moving channels for one certain outcome was the judged reverse-snap hazard.
    // A mine tripped mid-fuse-window must hold its body pose while the bead descends.
    const { scene, v } = styledScene('lance');
    const t0 = FUSE_WARNING_SECONDS * 0.5;
    const a = world([mine({ timer: t0, proximityDelayLeft: 20 })]);
    v.sync(a, a, 0);
    const scaleA = body(scene).scale.x;
    // Ten ticks later: fuse burned further AND the trip advanced -- body must not move.
    const b = world([mine({ timer: t0 - 10 * DT, proximityDelayLeft: 10 })]);
    v.sync(b, b, 0);
    expect(body(scene).scale.x).toBeCloseTo(scaleA, 9);
    v.dispose();
  });

  it('tears the vertical down at the blast, and dispose() leaves nothing behind', () => {
    const { scene, v } = styledScene('spike');
    const live = world([mine({ proximityDelayLeft: 5 })]);
    v.sync(live, live, 0);
    expect(vert(scene)).toBeDefined();
    const gone = world([mine({ proximityDelayLeft: 1, detonated: true })]);
    v.sync(gone, gone, 0);
    expect(vert(scene)).toBeUndefined();
    const again = world([mine({ proximityDelayLeft: 5 })]);
    v.sync(again, again, 0);
    v.dispose();
    expect(vert(scene)).toBeUndefined();
    expect(bead(scene)).toBeUndefined();
  });
});
