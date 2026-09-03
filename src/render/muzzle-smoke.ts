import * as THREE from 'three';
import type { World } from '../sim/world';
import type { SimEvent } from '../sim/events';
import { SHELL_MUZZLE_FORWARD } from '../sim/constants';
import { BULLET_Y } from './tank-model';

/**
 * The gun smokes when it cycles (issue #536), and it smokes DIRTIER when nothing came out.
 *
 * This began as issue #356's `smoke` refusal arm -- a grey puff that appeared only when a
 * shot was refused, one of four candidate ways to say so. The owner played it and ruled it
 * out of that role: smoke should be what firing looks like, and a refusal should be smoke
 * that looks WRONG. So the puff is now unconditional shipped behaviour on `fire`, and
 * `fire-blocked` draws the same puff burnt.
 *
 * That is the second time an arm has taken this path. barrel-recoil.ts went first
 * (issue #526) and the two are deliberately different in kind, which is worth stating
 * because the difference is what this file has to work harder at. A refusal reads on the
 * recoil because the shell and the flash are ABSENT -- the player compares what they see
 * against a whole missing object. Here both events draw something, so the player is
 * comparing a puff against a REMEMBERED puff with no reference on screen. Value alone is a
 * thin channel for that, and on this arena it is thinner still: the felt is a dark green,
 * so a darker grey moves TOWARD the background and the exceptional event would end up less
 * visible than the routine one. Measured at the shipped camera, and the numbers are in
 * `SMOKE` below.
 *
 * NOT THE MUZZLE FLASH, and every visible property is chosen to keep the two apart.
 * blocked-fire-muzzle.ts fires the shot's own light: saturated yellow-white, ADDITIVE, one
 * sphere, collapsing, gone in 0.07s. Smoke is its opposite in each of those -- a
 * desaturated neutral (a grey on a shot, a near-black on a refusal), NORMALLY blended so
 * it obscures rather than glows, several soft billows rather than one hard body, EXPANDING
 * rather than collapsing, and alive long enough to drift. The flash is still a selectable
 * refusal arm, so the two now play TOGETHER for whoever sets that flag, which is another
 * reason they must not converge.
 *
 * A TEXTURE, not a shape. The owner asked for "a smoke type texture", and the reason it
 * has to be one is that smoke has no silhouette: an untextured sphere or disc reads as a
 * grey ball however softly it is shaded, because its boundary is exact. `makeSmokeTexture`
 * below paints a soft radial falloff whose edge is pushed in and out by a few angular
 * lobes, so each billow ends in an irregular fade instead of a circle. Generated as raw
 * pixels rather than drawn on a canvas, the same choice textures.ts and mine-warning.ts
 * make and for the same reason -- the jsdom test environment has no 2D context.
 *
 * SPRITES, so the billows face the camera from any angle. The gallery reviews this from
 * `--view close`, `low` and `top`, and a flat quad laid in the world would vanish edge-on
 * from one of them.
 *
 * NO RNG. Real smoke is random and this is not: the puff layout is a fixed table, because
 * the gallery renders the same timeline twice and needs the two renders byte-identical
 * (particles.ts's `rng` seam exists for exactly that reason). What the table buys instead
 * of randomness is that the billows differ from each other -- different offsets, sizes,
 * spins and drift rates -- so the cloud shears as it rises rather than reading as one
 * stamp printed several times.
 *
 * EVERY LIVING TANK, not just the player. As a refusal arm this was player-only, and that
 * was right: `fire-blocked` is emitted for every refused owner including AI, whose
 * ammunition is not the player's business. barrel-recoil.ts records why the guard does not
 * survive the change, and the reasoning is identical here -- firing is already visible, the
 * shell is right there, so smoke on it reports nothing the player cannot already see. An
 * enemy gun that fired clean while the player's smoked would be the odd thing on screen.
 * The refusal half rides along with that: an enemy's dark puff is legible only to someone
 * who was already watching that barrel, and the shell that did not appear leaks the same
 * fact anyway.
 */
export interface MuzzleSmokeSystem {
  /** Puff at the muzzle of every living tank that fired or was refused this frame. */
  spawn(events: SimEvent[], world: World): void;
  update(dt: number): void;
  setReducedMotion(on: boolean): void;
  dispose(): void;
}

/**
 * Feel constants shared by both puffs. OWNER DECISIONS, stated rather than buried:
 *
 *  - 0.75s, an order of magnitude longer than the muzzle flash's 0.07s, because smoke
 *    that is gone in a blink is a flash wearing a grey coat. It is still the shortest
 *    thing on screen that could be called lingering: an explosion's particles live 0.6s
 *    AND throw 24 bright bodies outward, so a small grey cloud at the barrel cannot be
 *    mistaken for one however long it hangs.
 *  - The cloud rises slightly further than it drifts forward (0.30 against 0.28). Chosen
 *    on a rendered clip while this was still a refusal-only arm: with the drift dominant
 *    the billows read as a jet leaving the bore. That was wrong then, when the whole claim
 *    was that no shot had happened; it is only half wrong now, since the ordinary puff
 *    DOES accompany a shell. Kept as it is because the two puffs share this motion, and a
 *    jet on both would make the refusal harder to tell from the shot, not easier.
 */
const LIFETIME_SECONDS = 0.75;
/** Sprite size at birth, in world units, before the billow expands toward GROWN_SIZE. */
const BIRTH_SIZE = 0.34;
/**
 * Size at the end of the life. Roughly a hull's width across at full spread -- large
 * enough to read as a cloud, nowhere near the 2.5-unit reach of a mine blast.
 */
const GROWN_SIZE = 0.95;
/** How far the cloud drifts along the barrel over its life, in world units. */
const DRIFT_FORWARD = 0.28;
/** How far it rises over its life. Less than the drift: it is exhaust, not a signal fire. */
const RISE = 0.3;
/** Radians a billow turns over its whole life, times its own spin rate. Slow on purpose. */
const SPIN = 0.5;
/**
 * Clouds alive at once, before the next puff is dropped.
 *
 * DERIVED, not chosen. A gun cannot cycle faster than its own cooldown, and a refusal is
 * gated by the same cooldown as a shot (sim/cap-refusal-cooldown.test.ts records why: the
 * `fireCooldown <= 0` gate is upstream of `spawnBullet`, so a refused shot is not a free
 * one). The shortest cooldown config/difficulty.ts allows is 14 ticks, a hair under 0.24s,
 * against a 0.75s life -- so one gun can have 4 clouds in the air. The tank multiplier is
 * an UPPER BOUND, not a measured seat count: the player roster caps at 4 slots
 * (devflags.ts's `players` accepts 1-4) and a campaign board adds its enemies, so 8 guns
 * all firing at the floor cooldown is comfortably past anything shipped. 8 * 4 = 32, and
 * clouds are built lazily, so an ordinary duel still allocates a handful.
 *
 * Generous precisely so it is not reached -- but `acquire` still says what happens if it
 * is, rather than leaving the answer to whichever branch happens to run first.
 */
const MAX_CLOUDS = 32;

/**
 * What separates a shot from a refusal, and the MEASUREMENT that decided it.
 *
 * The owner asked for "darker, blacker" smoke on a misfire, and that is the primary signal
 * here: `color` is the first field and the refusal's is a near-black soot against the
 * shot's mid grey. Darkness alone was tried first, and it failed. What follows is why, in
 * the numbers it failed by, because the failure is not obvious and the next person to
 * retune this will be tempted to simplify it back.
 *
 * HOW IT WAS MEASURED. tools/gl/harness.ts renders the shipped arena at the SHIPPED
 * CAMERA -- not the gallery's close-up, where any two treatments look different -- and
 * takes a frame 0.2667s after a single event, by which time the muzzle burst (0.234s at
 * most) and the barrel recoil (0.16s) have both finished, so a `fire` frame and a
 * `fire-blocked` frame differ by the puff and nothing else. Differences are reported as a
 * mean absolute difference in LEVELS (0-255) over the colour bytes the cloud covers, and
 * the puff covers about 200 of the 400,000 pixels in that frame, which is the scale the
 * question is really being asked at.
 *
 * DARKNESS ALONE, MEASURED: with the refusal differing from the shot only in colour --
 * this same near-black, at the shot's own 0.72 density and squared thinning -- the two
 * puffs came out 20.34 levels apart. That sounds like plenty until it is asked the
 * question that matters, which is not "do these differ" but "does either LOOK unusual".
 * Against the empty arena, the shot's puff departs by 11.13 levels and the darker
 * refusal's by 9.20. Backwards, precisely as issue #536 predicted: the felt is a dark
 * green, so a darker grey moves TOWARD the background, and the exceptional event was the
 * quieter of the two. There is no fixing that by darkening further -- black is the end of
 * that road, and the shot's grey has more room above the felt than any black has below it.
 *
 * THE NEGATIVE CONTROL for all of it: with the refusal drawing the shot's own look, the
 * two frames are identical to the byte and the separation reads 0.00 levels. That is what
 * "no difference" scores on this instrument, so the numbers above are the puff and not the
 * renderer.
 *
 * SO THE DIFFERENCE IS CARRIED ON DENSITY AS WELL, and density was chosen over the
 * alternatives because it REINFORCES the owner's word instead of substituting for it. A
 * refusal's smoke is nearly solid, and it holds that density through its life rather than
 * thinning away in the first moments -- which is what a bad discharge physically produces:
 * unburnt propellant makes thick soot, a clean shot makes a wisp. The puff is still
 * darker; it is now darker AND thicker, so the dark value obscures the felt instead of
 * blending into it. MEASURED with both: the two puffs are 27.54 levels apart, and the
 * refusal now departs from the empty arena by 16.94 against the shot's 10.60. The
 * exceptional event is the louder one, which is the way round it has to be, and the GL
 * check asserts that direction rather than just the gap -- the colour-only version above
 * fails it.
 *
 * Every number here is a lower bound on what the player sees. The sample is taken late,
 * because that is what it takes to be sure nothing but the smoke is left on screen; at
 * that moment the shot's cloud is at 41% of its birth density and the refusal's at 64%.
 *
 * WHAT IS DELIBERATELY NOT SPLIT: lifetime, size, spread, drift and rise. Those are what
 * tell smoke from the muzzle flash it can sit beside (see the file header), and they are
 * also the properties that would make a refusal a different EFFECT rather than the same
 * gun having a bad time. Both clouds are born in the same place, grow to the same size and
 * die at the same moment; only how black and how thick they are differs.
 */
interface SmokeLook {
  /**
   * Sprite tint. Every field here is `readonly` because the table is exported: a test or a
   * tool holding it could otherwise retune the shipped look for the rest of the process,
   * and the numbers above would stop describing what anything renders.
   */
  readonly color: number;
  /** Opacity at birth, before the cloud thins away. */
  readonly peakOpacity: number;
  /**
   * Exponent on the thinning curve, `(1 - k) ** fadePower`. Higher thins sooner: at 2 the
   * cloud has given up 56% of its density a third of the way through its life, at 1 only
   * 33%. This is the "holds its density" half of the refusal's extra weight, and it is a
   * curve rather than a bigger `peakOpacity` because peak is already nearly at its ceiling
   * and because what the eye has to catch is the cloud a few frames in, not at birth.
   */
  readonly fadePower: number;
}
export const SMOKE: Readonly<Record<'fired' | 'refused', SmokeLook>> = {
  /**
   * The shot. Grey 0x9aa1a8, desaturated on purpose: every other arena cue is a saturated
   * warm colour (the ring's amber, the flash's yellow-white, the pips' hot orange), so a
   * cool neutral is the one thing on the board that is not signalling. Peak opacity 0.72
   * rather than 1 -- smoke you can see the barrel through -- and a squared thinning, so the
   * ordinary puff is at its most legible in the first moments and then gets out of the way.
   * These are the values the owner played and approved as the `smoke` arm, kept unchanged
   * on purpose: retuning them here would discard the judgement that adopted them.
   */
  fired: { color: 0x9aa1a8, peakOpacity: 0.72, fadePower: 2 },
  /**
   * The refusal. 0x08090a is as near black as this cloud goes while keeping the faint cool
   * cast that makes it read as the same substance burnt rather than as a different
   * material. 0.96 stops short of solid because a puff you cannot see the barrel through
   * would hide the recoil the player is also meant to notice underneath it, and the linear
   * thinning is what keeps the soot present for the whole 0.75s instead of only its first
   * fifth.
   */
  refused: { color: 0x08090a, peakOpacity: 0.96, fadePower: 1 },
};

/**
 * The billows, as a fixed table -- see the header for why this is not random.
 *
 * `along`/`across` place each billow relative to the muzzle in barrel-local units, `lift`
 * raises it, `size` and `drift` scale its own growth and travel against the constants
 * above, and `spin` gives each one a different starting angle so the same texture stamped
 * three times is not recognisable as the same texture.
 */
const BILLOWS: readonly {
  along: number;
  across: number;
  lift: number;
  size: number;
  drift: number;
  spin: number;
}[] = [
  { along: 0.0, across: 0.0, lift: 0.0, size: 1.0, drift: 1.0, spin: 0.0 },
  { along: 0.13, across: 0.07, lift: 0.04, size: 0.78, drift: 1.25, spin: 2.2 },
  { along: 0.08, across: -0.09, lift: -0.02, size: 0.64, drift: 0.8, spin: 4.1 },
];

/** Texture resolution. 64 is the size mine-warning.ts's glow falloff settled on. */
const TEX_SIZE = 64;

/**
 * The billow stamp: white, with all the shape in the alpha channel so the material's
 * `color` is free to tint it. That the shape lives entirely in alpha is what lets one
 * texture serve both looks -- the shot's grey and the refusal's soot are the same cloud
 * under two tints, which is the point.
 *
 * The radial falloff is squared, the same choice mine-warning.ts's glow makes so the disc
 * has no visible edge where alpha is falling fastest. What is different here is that the
 * radius itself wobbles with the angle: three broad lobes and five finer ones push the
 * boundary in and out by about a fifth, which is what turns a circle into something with
 * the lumpy, unrepeating outline smoke has. The interior is mottled slightly by the same
 * angle, fading out toward the middle, so the billow is not a uniform wash.
 */
function makeSmokeTexture(): THREE.DataTexture {
  const n = TEX_SIZE;
  const px = new Uint8ClampedArray(n * n * 4);
  const c = (n - 1) / 2;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = (y * n + x) * 4;
      const dx = x - c;
      const dy = y - c;
      const ang = Math.atan2(dy, dx);
      const lobes = 1 + 0.2 * Math.sin(ang * 3 + 0.9) + 0.11 * Math.sin(ang * 5 - 2.1);
      const d = Math.hypot(dx, dy) / c / lobes;
      const fade = d >= 1 ? 0 : (1 - d) * (1 - d);
      const mottle = 1 - 0.18 * (1 - d) * (0.5 + 0.5 * Math.sin(ang * 7 + 1.3));
      px[i] = 255;
      px[i + 1] = 255;
      px[i + 2] = 255;
      px[i + 3] = Math.round(255 * fade * mottle);
    }
  }
  const t = new THREE.DataTexture(px, n, n, THREE.RGBAFormat);
  t.needsUpdate = true;
  return t;
}

interface Cloud {
  billows: THREE.Sprite[];
  /** The muzzle the cloud left, in three's coordinates. */
  origin: THREE.Vector3;
  /** Barrel direction and its perpendicular, both unit, in three's xz plane. */
  forward: THREE.Vector3;
  right: THREE.Vector3;
  life: number;
  /** The look this cloud was born with -- see SMOKE. Held so `update` can fade from it. */
  peak: number;
  fadePower: number;
}

export function createMuzzleSmokeSystem(scene: THREE.Scene): MuzzleSmokeSystem {
  let reducedMotion = false;
  // One texture for every billow of every cloud, disposed once: `Material.dispose()` does
  // not release a bound map, which is the leak disposeMineGlowMesh exists to avoid.
  const texture = makeSmokeTexture();
  const pool: Cloud[] = [];
  const active: Cloud[] = [];

  function makeCloud(): Cloud {
    const billows = BILLOWS.map((b) => {
      const sprite = new THREE.Sprite(
        // NORMAL blending, unlike every other additive effect in this renderer. Additive
        // smoke would brighten the felt behind it, which is the one thing smoke never
        // does -- and it is precisely what makes the muzzle flash read as light. It is
        // also what makes the refusal's near-black tint mean anything at all: under
        // additive blending a dark colour adds nothing and the puff would vanish.
        new THREE.SpriteMaterial({
          map: texture,
          color: SMOKE.fired.color,
          transparent: true,
          opacity: SMOKE.fired.peakOpacity,
          depthWrite: false,
        }),
      );
      sprite.material.rotation = b.spin;
      sprite.name = 'muzzle-smoke';
      scene.add(sprite);
      return sprite;
    });
    return {
      billows,
      origin: new THREE.Vector3(),
      forward: new THREE.Vector3(1, 0, 0),
      right: new THREE.Vector3(0, 0, 1),
      life: LIFETIME_SECONDS,
      peak: SMOKE.fired.peakOpacity,
      fadePower: SMOKE.fired.fadePower,
    };
  }

  function acquire(look: SmokeLook): Cloud | null {
    let cl = pool.pop();
    if (!cl) {
      if (active.length >= MAX_CLOUDS) {
        // At budget, the OLDEST cloud is recycled rather than the newest puff skipped.
        // `active` is append-ordered and entries leave it as they expire, so index 0 is
        // the cloud nearest the end of its life -- already the thinnest on screen.
        // Refusing the new puff instead would drop smoke from the shot the player just
        // fired and is watching, while a nearly-faded cloud from half a second ago kept
        // its slot. Something is lost either way at the ceiling; this loses the less
        // visible thing.
        const oldest = active.shift();
        if (!oldest) return null;
        for (const sprite of oldest.billows) sprite.visible = false;
        cl = oldest;
      } else {
        cl = makeCloud();
      }
    }
    // Only what `place` does not write: a reused cloud takes its size, position and spin
    // from the placement `spawn` makes immediately below, but nothing else would clear the
    // opacity it faded out at -- or the tint of the OTHER event, since one pool now serves
    // both looks and a refusal's cloud is recycled into the next ordinary shot.
    for (const sprite of cl.billows) {
      sprite.visible = true;
      sprite.material.color.setHex(look.color);
      sprite.material.opacity = look.peakOpacity;
    }
    cl.life = LIFETIME_SECONDS;
    cl.peak = look.peakOpacity;
    cl.fadePower = look.fadePower;
    active.push(cl);
    return cl;
  }

  /** Place every billow of `cl` at `k` (0 -> 1) through its life. */
  function place(cl: Cloud, k: number): void {
    for (let i = 0; i < cl.billows.length; i++) {
      const b = BILLOWS[i];
      const sprite = cl.billows[i];
      // Written on EVERY frame under the CURRENT policy rather than skipped when reduced
      // motion is on -- the landmine blocked-fire-ring.ts records: skipping the term
      // freezes a live billow wherever it had drifted to when the preference flipped.
      // Reduced motion removes the travel, not the cue: the cloud still appears, at the
      // size it would have spread to, and still thins away.
      const travel = reducedMotion ? 0 : k;
      // Growth eased so most of the spread happens early, the way a puff bursts out of a
      // barrel and then slows. Held at full spread under reduced motion, because a puff
      // stuck at its birth size would be a grey dot rather than smoke.
      const grow = reducedMotion ? 1 : Math.pow(k, 0.6);
      const size = (BIRTH_SIZE + (GROWN_SIZE - BIRTH_SIZE) * grow) * b.size;
      sprite.scale.set(size, size, 1);
      const along = b.along + DRIFT_FORWARD * b.drift * travel;
      sprite.position.set(
        cl.origin.x + cl.forward.x * along + cl.right.x * b.across,
        cl.origin.y + b.lift + RISE * travel,
        cl.origin.z + cl.forward.z * along + cl.right.z * b.across,
      );
      sprite.material.rotation = b.spin + SPIN * b.drift * travel;
    }
  }

  function spawn(events: SimEvent[], world: World): void {
    for (const e of events) {
      // Both event types, one gesture, two looks. `fire` is a shot that left the barrel
      // and `fire-blocked` is one the shell cap refused (sim/bullets.ts's
      // `shellCapReached`); the gun cycled either way, so it smokes either way, and what
      // the player reads is that the smoke came out wrong.
      if (e.type !== 'fire' && e.type !== 'fire-blocked') continue;
      // A dead tank's view is being torn down or replaced, and a cloud left at its muzzle
      // would hang over a corpse. Every LIVING owner smokes, player and enemy alike.
      const owner = world.tanks.find((t) => t.id === e.ownerId);
      if (!owner || !owner.alive) continue;
      const cl = acquire(e.type === 'fire' ? SMOKE.fired : SMOKE.refused);
      if (!cl) continue;
      // The muzzle plane, the same point bullets.ts hands the real fire event as `flash`:
      // world (x, y) -> three (x, z), and the barrel points along `turretAngle`.
      const cos = Math.cos(owner.turretAngle);
      const sin = Math.sin(owner.turretAngle);
      cl.origin.set(
        owner.pos.x + cos * SHELL_MUZZLE_FORWARD,
        BULLET_Y,
        owner.pos.y + sin * SHELL_MUZZLE_FORWARD,
      );
      cl.forward.set(cos, 0, sin);
      // The barrel's perpendicular in the ground plane, so `across` spreads the billows
      // sideways across the bore rather than along it whatever way the turret points.
      cl.right.set(-sin, 0, cos);
      place(cl, 0);
    }
  }

  function update(dt: number): void {
    for (let i = active.length - 1; i >= 0; i--) {
      const cl = active[i];
      cl.life -= dt;
      if (cl.life <= 0) {
        for (const sprite of cl.billows) sprite.visible = false;
        active.splice(i, 1);
        pool.push(cl);
        continue;
      }
      // k runs 0 -> 1 across the life. The cloud expands while it thins, which is the
      // whole shape of the effect: the flash it can sit beside does the exact opposite.
      const k = 1 - cl.life / LIFETIME_SECONDS;
      place(cl, k);
      // Both the peak and the curve come from the CLOUD, not from a shared constant, and
      // that is the whole of the density half of the refusal (see SMOKE). Reading either
      // from `SMOKE.fired` here would pull a refusal's soot back to the ordinary puff's
      // weight on its very first update -- leaving the extra density on screen for one
      // sixtieth of a second, which is a defect no assertion taken at birth can see.
      const fade = Math.pow(1 - k, cl.fadePower);
      for (const sprite of cl.billows) sprite.material.opacity = cl.peak * fade;
    }
  }

  function dispose(): void {
    for (const cl of [...active, ...pool]) {
      for (const sprite of cl.billows) {
        scene.remove(sprite);
        sprite.material.dispose();
      }
    }
    texture.dispose();
    active.length = 0;
    pool.length = 0;
  }

  return {
    spawn,
    update,
    setReducedMotion: (on: boolean) => { reducedMotion = on; },
    dispose,
  };
}
