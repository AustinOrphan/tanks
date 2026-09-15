import { describe, it, expect } from 'vitest';
import { SPAWN_ANIMATORS, ENTRANCE_SECONDS, SHIELD_TRANSLUCENCY, protectedOpacity } from './spawn-anim';

const warp = SPAWN_ANIMATORS.warp;
const C = 0x3fd0ff;

describe('warp animator', () => {
  it('entrance: fades and scales the tank in, ring expands', () => {
    const a = warp('entrance', 0, C);
    const b = warp('entrance', 1, C);
    // Mutation that breaks this: an animator that returns a constant frame.
    expect(a.tankOpacity).toBeLessThan(b.tankOpacity);
    expect(a.tankScale).toBeLessThan(b.tankScale);
    expect(a.ring.radius).toBeLessThan(b.ring.radius);
    expect(b.tankOpacity).toBeCloseTo(1, 5); // fully solid by end of entrance
    expect(b.tankScale).toBeCloseTo(1, 5);
  });
  it('invincible: MEETS the entrance at opaque, goes translucent, and returns to opaque', () => {
    // progress here is 0=just shielded, 1=shield about to end.
    //
    // THIS CASE USED TO ASSERT THE DEFECT. It read "tank is translucent at the start and
    // solidifies to opaque" and required `start.tankOpacity < 1` -- which is precisely the
    // one-frame drop issue #230 describes: the entrance ends at 1.0 (asserted two cases
    // above) and this phase opened at 0.45. The old assertion could only pass while the
    // discontinuity existed.
    const start = warp('invincible', 0, C);
    const mid = warp('invincible', 0.5, C);
    const end = warp('invincible', 1, C);
    expect(start.tankOpacity).toBeCloseTo(1, 5); // continuous with the entrance's last frame
    expect(end.tankOpacity).toBeCloseTo(1, 5); // continuous with the un-shielded tank
    expect(mid.tankOpacity).toBeLessThan(1); // ...and visibly protected in between
  });
  it('clamps progress outside [0,1] (negative control: no NaN, no >1 opacity)', () => {
    for (const p of [-1, 2]) {
      const f = warp('entrance', p, C);
      expect(f.tankOpacity).toBeGreaterThanOrEqual(0);
      expect(f.tankOpacity).toBeLessThanOrEqual(1);
    }
  });
  it('ENTRANCE_SECONDS is a positive, finite duration', () => {
    expect(ENTRANCE_SECONDS).toBeGreaterThan(0);
    expect(Number.isFinite(ENTRANCE_SECONDS)).toBe(true);
  });
});

const rise = SPAWN_ANIMATORS.rise;

describe('rise animator', () => {
  it('entrance: scales up from near-zero (distinct from warp, which starts at 0.6)', () => {
    const a = rise('entrance', 0, 0x3fd0ff);
    const b = rise('entrance', 1, 0x3fd0ff);
    // Mutation that breaks this: rise === warp (its start scale would be 0.6, not < 0.2).
    expect(a.tankScale).toBeLessThan(0.2);
    expect(b.tankScale).toBeCloseTo(1, 5);
    expect(a.tankScale).toBeLessThan(b.tankScale);
  });
  it('invincible: ring opacity oscillates (pulse), unlike warp\'s monotone fade', () => {
    const samples = [0, 0.25, 0.5, 0.75, 1].map((p) => rise('invincible', p, 0x3fd0ff).ring.opacity);
    // A pulse is non-monotone: at least one sample rises after falling (or vice versa).
    // Mutation that breaks this: a monotone ring opacity (rise aliased to warp).
    const monotone = samples.every((v, i) => i === 0 || v <= samples[i - 1])
      || samples.every((v, i) => i === 0 || v >= samples[i - 1]);
    expect(monotone).toBe(false);
  });
});

const beacon = SPAWN_ANIMATORS.beacon;

describe('beacon animator', () => {
  it('invincible: tank stays opaque; ring ARC depletes from full to empty', () => {
    const start = beacon('invincible', 0, 0x3fd0ff);
    const end = beacon('invincible', 1, 0x3fd0ff);
    // Mutations that break this: beacon aliased to warp (start opacity would be 0.45,
    // and arc would be constant 1 the whole time).
    expect(start.tankOpacity).toBeCloseTo(1, 5);
    expect(end.tankOpacity).toBeCloseTo(1, 5);
    expect(start.ring.arc).toBeCloseTo(1, 5);
    expect(end.ring.arc).toBeCloseTo(0, 5);
    expect(end.ring.arc).toBeLessThan(start.ring.arc);
  });
});

// Anti-rot guard: until the picker UI (issue #201) lands, this is the only thing that
// exercises rise/beacon by id through the registry rather than through the module-level
// const above -- the `--spawn-anim` gallery arg has landed and reaches them too, but a
// player-facing way to choose this in real play is still deferred. Fails if a variant is
// ever aliased to a dead/constant frame.
it.each(['warp', 'rise', 'beacon'] as const)('%s is a live animator, not a constant', (id) => {
  const a = SPAWN_ANIMATORS[id]('entrance', 0, 0);
  const b = SPAWN_ANIMATORS[id]('entrance', 1, 0);
  expect(a).not.toEqual(b);
});

describe('the spawn animators under reduced motion (issue #651)', () => {
  const PHASES = [0, 0.25, 0.5, 0.75, 1];

  it('holds every scale and radius at rest, across all three animators and both phases', () => {
    // `death-pulse.ts`'s rule applied here: the growth goes, the fade stays. A spawning tank
    // still arrives -- it fades in, and its ring still fades -- but nothing swells, shrinks
    // or expands outward.
    for (const [id, animate] of Object.entries(SPAWN_ANIMATORS)) {
      for (const phase of ['entrance', 'invincible'] as const) {
        for (const p of PHASES) {
          const f = animate(phase, p, 0, true);
          expect(f.tankScale, `${id}/${phase}@${p} tank scale`).toBe(1);
          expect(f.ring.radius, `${id}/${phase}@${p} ring radius`).toBe(1);
        }
      }
    }
  });

  it('negative control: the same frames DO move at full motion', () => {
    // Without this the case above would pass on an animator that had simply been flattened
    // for everyone, which is the opposite of a preference.
    const moved = Object.entries(SPAWN_ANIMATORS).flatMap(([id, animate]) =>
      PHASES.filter((p) => {
        const f = animate('entrance', p, 0, false);
        return f.tankScale !== 1 || f.ring.radius !== 1;
      }).map((p) => `${id}@${p}`),
    );
    expect(moved.length, 'no animator moves anything at full motion').toBeGreaterThan(5);
  });

  it('keeps the fades, which are what say a tank is arriving at all', () => {
    // The half that must NOT be calmed. An entrance with no opacity ramp is a tank that
    // simply appears, and the preference is about motion, not about deleting the cue.
    for (const [id, animate] of Object.entries(SPAWN_ANIMATORS)) {
      const early = animate('entrance', 0.1, 0, true);
      const late = animate('entrance', 0.9, 0, true);
      expect(late.tankOpacity, `${id} must still fade in`).toBeGreaterThan(early.tankOpacity);
    }
  });

  it("holds rise's invincible ring at the value it oscillates about, rather than at zero", () => {
    // THE CASE THE SEAM EXISTS FOR. This ring's opacity oscillates at a rising frequency --
    // five cycles over the phase by the end -- and a `SpawnFrame` carries only the value the
    // oscillation reached, so no correction applied downstream could tell it from a fade.
    // Held at the mean, not at zero: an invisible ring deletes "you are still protected".
    const held = PHASES.map((p) => SPAWN_ANIMATORS.rise('invincible', p, 0, true).ring.opacity);
    for (const o of held) expect(o).toBeCloseTo(0.15, 12); // 0.3 * the 0.5 mean
    expect(new Set(held).size, 'a held value must not vary with progress').toBe(1);
    // ...and it really does oscillate otherwise, or the assertion above measures nothing.
    const free = PHASES.map((p) => SPAWN_ANIMATORS.rise('invincible', p, 0, false).ring.opacity);
    expect(new Set(free).size, 'the free ring must vary').toBeGreaterThan(1);
  });

  it("leaves beacon's depleting arc alone, because it is a timer rather than motion", () => {
    // The boundary. `arc` says how much shield is left; calming it would delete information
    // rather than movement, and a player would lose the countdown entirely.
    for (const p of PHASES) {
      const calm = SPAWN_ANIMATORS.beacon('invincible', p, 0, true);
      const free = SPAWN_ANIMATORS.beacon('invincible', p, 0, false);
      expect(calm.ring.arc).toBe(free.ring.arc);
      expect(calm.ring.arc).toBeCloseTo(1 - p, 12);
    }
  });

  it('defaults to full motion, so every existing call site is unchanged', () => {
    for (const [id, animate] of Object.entries(SPAWN_ANIMATORS)) {
      expect(animate('entrance', 0.5, 0), `${id} default`).toEqual(animate('entrance', 0.5, 0, false));
    }
  });
});

describe('converge: an arrival gathers instead of expanding (issue #230)', () => {
  /*
   * The issue's first complaint is that spawn and death are "hard to tell apart at normal
   * speed", and the reason is concrete: every shipped entrance grows its ring outward --
   * warp 0.4 -> 2.0, beacon 0.5 -> 1.7, rise a bump -- and `death-pulse.ts` grows its ring
   * outward too. Two events, one vocabulary.
   *
   * These assert the OPPOSITION rather than a curve, because the curve is a feel constant
   * and the opposition is the contract.
   */
  const ids = ['warp', 'rise', 'beacon'] as const;

  const sweep = (id: (typeof ids)[number], opposed: boolean) =>
    Array.from({ length: 41 }, (_, i) =>
      SPAWN_ANIMATORS[id]('entrance', i / 40, 0, false, opposed).ring.radius,
    );

  it('shipped: the ring travels OUTWARD, which is why it reads like the death pulse', () => {
    // The negative control, and the measurement the issue rests on.
    //
    // Stated as "widest after the start, never closing onto the tank" rather than
    // "ends wider", because `rise` is a symmetric bump (0.9 + 0.3 sin(p*pi)) that returns
    // to its starting radius -- an end-to-end comparison calls rise flat and says nothing
    // about the outward throw it shares with warp, beacon and the death pulse.
    for (const id of ids) {
      const r = sweep(id, false);
      expect(Math.max(...r), `${id} never travels outward`).toBeGreaterThan(r[0]);
      expect(r[r.length - 1], `${id} closes onto the tank`).toBeGreaterThanOrEqual(r[0]);
    }
  });

  it('opposed: every style converges instead', () => {
    // ALL THREE, not one. The player picks a spawn STYLE; arrival-versus-destruction is a
    // property of the EVENT, and a language that held for only one style would leave the
    // other two still reading like deaths.
    for (const id of ids) {
      const r = sweep(id, true);
      // The exact inverse of the control above: widest AT the start, and it finishes
      // strictly inside where it began.
      expect(Math.max(...r), `${id} is not widest at the start`).toBe(r[0]);
      expect(r[r.length - 1], `${id} does not converge`).toBeLessThan(r[0]);
    }
  });

  it('lands on the tank rather than passing through it', () => {
    // The ring ends at the tank's own footprint (radius 1), so the arrival resolves ON the
    // thing that arrived. Collapsing past it would read as the tank being swallowed.
    for (const id of ids) {
      const end = SPAWN_ANIMATORS[id]('entrance', 1, 0, false, true).ring.radius;
      expect(end, `${id}`).toBeCloseTo(1, 2);
    }
  });

  it('brightens as it closes, so the landing is the brightest frame', () => {
    for (const id of ids) {
      const early = SPAWN_ANIMATORS[id]('entrance', 0.1, 0, false, true).ring.opacity;
      const late = SPAWN_ANIMATORS[id]('entrance', 0.9, 0, false, true).ring.opacity;
      expect(late, `${id}`).toBeGreaterThan(early);
    }
  });

  it('holds still under reduced motion without vanishing', () => {
    // The rule this file already states, applied to the new arm: scales and radii hold at
    // their resting value. Not zero opacity -- an invisible ring deletes the cue rather
    // than calming it, the trap #652 records for `.hud-capacity` and `.hud-count`.
    for (const id of ids) {
      for (const p of [0.1, 0.5, 0.9]) {
        const f = SPAWN_ANIMATORS[id]('entrance', p, 0, true, true);
        expect(f.ring.radius, `${id} @${p}`).toBe(1);
        expect(f.ring.opacity, `${id} @${p} vanished`).toBeGreaterThan(0);
      }
    }
  });

  it('leaves the INVINCIBLE phase alone, which is a state and not an event', () => {
    // Opposing a sustained "you are still protected" against a death would be opposing two
    // things that never occur together.
    for (const id of ids) {
      const shipped = SPAWN_ANIMATORS[id]('invincible', 0.4, 0);
      const opposed = SPAWN_ANIMATORS[id]('invincible', 0.4, 0, false, true);
      expect(opposed, id).toEqual(shipped);
    }
  });
});

// ---------------------------------------------------------------------------
// Issue #230's entrance -> invincibility contract, applied to all three variants.
//
// The owner's 2026-09-12 comment names the defect precisely: `warp` and `rise` end their
// entrance at `tankOpacity: 1` and opened the invincible phase at `0.45 + 0.55·p` = 0.45,
// and `beacon` held 1.0 throughout so it read as fully vulnerable while protected. These
// cases are the contract that replaced all three behaviours, asserted as a SWEEP over every
// variant rather than one spot-check per animator -- the defect class is "one variant
// disagrees with the others", which a per-variant case cannot see.
// ---------------------------------------------------------------------------

describe('the shielded-spawn opacity contract (issue #230)', () => {
  const VARIANTS = [
    ['warp', warp],
    ['rise', rise],
    ['beacon', beacon],
  ] as const;

  it('meets the entrance at OPAQUE, with no step at the phase boundary', () => {
    // The boundary is where `entities.ts` switches animators: the last entrance frame runs
    // at progress ~1 and the first invincible frame at 0. Both must read the same opacity,
    // or the tank flickers on the frame it becomes protected.
    for (const [name, anim] of VARIANTS) {
      const lastEntrance = anim('entrance', 1, 0xffffff);
      const firstProtected = anim('invincible', 0, 0xffffff);
      expect(lastEntrance.tankOpacity, `${name} entrance end`).toBeCloseTo(1, 5);
      expect(firstProtected.tankOpacity, `${name} protected start`).toBeCloseTo(1, 5);
    }
  });

  it('meets an entrance that ended PART-WAY into the shield at opaque, too', () => {
    // The case above is the animator alone at p = 0, and play never reaches it: the shield
    // counts down from the revival tick while the entrance runs on render time, so the first
    // protected frame is about a third of the way in. `entities.ts` latches that point and
    // passes it as `protectedFrom`; the phase must open opaque from there and still reach the
    // floor once it has eased in.
    for (const from of [1 / 9, 1 / 3, 0.5]) {
      for (const [name, anim] of VARIANTS) {
        const first = anim('invincible', from, 0xffffff, false, false, from);
        expect(first.tankOpacity, `${name} from ${from}`).toBeCloseTo(1, 5);
      }
      expect(protectedOpacity(0.7, from), `floor after easing in from ${from}`).toBeCloseTo(1 - SHIELD_TRANSLUCENCY, 10);
    }
    // The defect, stated: eased in from 0, a phase opening at 1/3 is already on the floor.
    expect(protectedOpacity(1 / 3)).toBeCloseTo(1 - SHIELD_TRANSLUCENCY, 10);
  });

  it('is visibly translucent while protection is running', () => {
    // Criterion: "the tank ... transitions smoothly to a visibly TRANSLUCENT protected
    // state". `beacon` is the one this was false for -- it held 1.0 for the entire phase.
    // 0.9 rather than 1 as the threshold: a difference a player could not see would satisfy
    // "less than opaque" while leaving the variant looking vulnerable, which is the defect.
    for (const [name, anim] of VARIANTS) {
      expect(anim('invincible', 0.5, 0xffffff).tankOpacity, name).toBeLessThan(0.9);
    }
  });

  it('is back at OPAQUE before the shield ends, so an expiring shield cannot dip', () => {
    // `entities.ts` drops to the un-shielded tank at `tankOpacity: 1` the moment `shieldLeft`
    // hits 0. If the curve were still translucent at p = 1 the tank would snap opaque -- the
    // same discontinuity as the entrance boundary, at the other end of the phase.
    for (const [name, anim] of VARIANTS) {
      expect(anim('invincible', 1, 0xffffff).tankOpacity, name).toBeCloseTo(1, 5);
    }
  });

  it('never steps by more than a hair between adjacent frames', () => {
    // The two boundary cases above pin the ENDS. This pins the middle: a curve that satisfied
    // both ends and jumped somewhere inside would pass them and still flicker. 120 samples is
    // roughly two seconds of 60Hz frames across the phase; the bound is well under what an
    // eye reads as a step, and well over the curve's real per-sample slope.
    for (const [name, anim] of VARIANTS) {
      let prev = anim('invincible', 0, 0xffffff).tankOpacity;
      for (let i = 1; i <= 120; i++) {
        const next = anim('invincible', i / 120, 0xffffff).tankOpacity;
        expect(Math.abs(next - prev), `${name} at ${i}/120`).toBeLessThan(0.05);
        prev = next;
      }
    }
  });

  it('gives all three variants the SAME protected opacity at every point', () => {
    // "Warp, Rise, and Beacon all communicate protection under one documented visual
    // contract." One curve, so the three cannot drift apart -- and this is what would fail if
    // a future variant re-inlined its own numbers, which is how beacon came to differ.
    for (let i = 0; i <= 20; i++) {
      const p = i / 20;
      const [a, b, c] = VARIANTS.map(([, anim]) => anim('invincible', p, 0xffffff).tankOpacity);
      expect(b, `at p=${p}`).toBeCloseTo(a as number, 10);
      expect(c, `at p=${p}`).toBeCloseTo(a as number, 10);
    }
  });

  it('keeps the shipped translucency floor, so this is a WHERE change and not a depth retune', () => {
    // The old curve's most translucent frame was 0.45 (`0.45 + 0.55·0`). `SHIELD_TRANSLUCENCY`
    // is 0.55, so the new floor is the same number -- the issue defers retuning the depth to
    // play, and this pins that the change moved the floor's position rather than its value.
    expect(1 - SHIELD_TRANSLUCENCY).toBeCloseTo(0.45, 10);
    expect(protectedOpacity(0.5)).toBeCloseTo(0.45, 10);
  });
});
