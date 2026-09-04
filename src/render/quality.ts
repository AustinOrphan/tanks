/**
 * Render quality presets: the four knobs issue #113 named as hardcoded in scene.ts
 * (antialias, pixel ratio cap, shadow map size, shadow filter), pulled into a table so
 * an on-device sweep can be a URL change (`?dev=1&quality=low|medium|high`) instead of a
 * rebuild per pass. A fifth knob joined them later and did not come from that issue:
 * `muzzleSmoke`, which governs how much of muzzle-smoke.ts's effect exists at all.
 *
 * WHO PICKS ONE. A developer, through that flag, and -- since issue #540 -- the player,
 * in Settings. The ids and the shipped default moved to `presentation/quality.ts` when
 * that happened, because `game/settings.ts` and the Settings pane cannot import a module
 * that names `THREE.ShadowMapType`; this file kept the table, which is the half that is
 * genuinely renderer-owned. `loop.ts` resolves one preset per session through
 * `qualityFor`, flag first and the stored preference behind it, so a sweep is still a URL
 * change and a player's choice is still honoured when no flag is set.
 *
 * Auto-detection from a device probe is explicitly OUT OF SCOPE here -- see the issue --
 * pending the on-device measurement spike. Nothing in this file reads the hardware.
 *
 * SCOPE: this governs the GAME scene (`createScene`) and the per-frame effect systems
 * `createRenderer` builds around it. Two other WebGL contexts build their own renderers
 * and deliberately do not read the flag: `render/preview.ts` (the Customize pane's live
 * tank preview, hardcoded antialias/cap-2/shadows) and `tools/gallery` (a dev tool, which
 * reviews the smoke deliberately close up and must keep drawing all of it). So
 * `?dev=1&quality=low` does not change the Customize preview's cost -- the flag exists to
 * sweep GAMEPLAY cost on a device. Extending it to the preview is a decision for the
 * on-device sweep to justify, not a default.
 */
import * as THREE from 'three';
// The ids and the shipped default, from the layer that may name a player preference.
// Issue #540 made this a Setting, and `game/settings.ts` cannot import a Three.js module
// to learn what the player may pick -- see presentation/quality.ts for the whole reason.
import { DEFAULT_QUALITY_PRESET, type QualityPreset } from '../presentation/quality';

/**
 * How much of the muzzle-smoke effect (muzzle-smoke.ts) a preset may draw.
 *
 * Smoke is the only per-frame effect with a knob here, because it is the only one whose
 * cost is large enough to have been felt: it draws up to `billowsPerCloud * maxClouds`
 * large, translucent, normally-blended sprites, each one its own `SpriteMaterial` and so
 * its own draw call, over ground that is already shaded. Everything else this renderer
 * puts on a frame is either opaque geometry the depth buffer rejects early or a handful of
 * small additive quads. The numbers behind both fields, and what they cost, are measured
 * in tools/gl/harness.ts, by the check that counts what each preset draws and times it.
 */
export interface MuzzleSmokeQuality {
  /**
   * How many entries of muzzle-smoke.ts's `BILLOWS` table each cloud draws, taken as a
   * prefix -- so 1 keeps the centred, largest billow and drops the two that shear off it.
   */
  readonly billowsPerCloud: number;
  /** The ceiling on clouds alive at once, before the oldest is recycled. */
  readonly maxClouds: number;
}

export interface RenderQuality {
  readonly antialias: boolean;
  readonly pixelRatioCap: number;
  readonly shadowMapSize: number;
  readonly shadowType: THREE.ShadowMapType;
  /**
   * `null` means the muzzle-smoke system is NOT CONSTRUCTED -- see `createRenderer`. A
   * system built but told to draw nothing would still pay its `spawn`/`update` every
   * frame and still hold its pooled sprites in the scene, and the ruling for `low` was
   * that the effect is dropped, not quietened.
   */
  readonly muzzleSmoke: MuzzleSmokeQuality | null;
}

/**
 * The whole effect as issue #536 shipped it, and `high` must render identically to a tree
 * that never had this knob -- so `billowsPerCloud` is pinned against muzzle-smoke.ts's own
 * table length in quality.test.ts rather than merely looking like it.
 *
 * `maxClouds` is DERIVED, not chosen, and the derivation moved here with the number. A gun
 * cannot cycle faster than its own cooldown, and a refusal is gated by the same cooldown as
 * a shot (sim/cap-refusal-cooldown.test.ts records why: the `fireCooldown <= 0` gate is
 * upstream of `spawnBullet`, so a refused shot is not a free one). The shortest cooldown
 * config/difficulty.ts allows is 14 ticks, a hair under 0.24s, against muzzle-smoke.ts's
 * 0.75s life -- so one gun can have 4 clouds in the air. The tank multiplier is an UPPER
 * BOUND, not a measured seat count: the player roster caps at 4 slots (devflags.ts's
 * `players` accepts 1-4) and a campaign board adds its enemies, so 8 guns all firing at the
 * floor cooldown is comfortably past anything shipped. 8 * 4 = 32, and clouds are built
 * lazily, so an ordinary duel still allocates a handful.
 *
 * Generous precisely so it is not reached -- but `acquire` still says what happens if it
 * is, rather than leaving the answer to whichever branch happens to run first.
 */
export const FULL_MUZZLE_SMOKE: MuzzleSmokeQuality = { billowsPerCloud: 3, maxClouds: 32 };

/**
 * `medium`'s cheapened smoke. Both numbers were chosen from a measurement rather than a
 * taste, and the measurement is also the reason this comment says plainly that the win is
 * smaller than the complaint that prompted it.
 *
 * WHAT IT CUTS. `billowsPerCloud: 1` is the lever that attacks both of the effect's costs
 * at once: each billow is a sprite carrying its OWN `SpriteMaterial`, so nothing batches
 * and one billow fewer is both one draw call fewer and a large translucent quad's worth of
 * overdraw fewer. `maxClouds: 16` bounds the crowded frame rather than the ordinary one --
 * the ceiling is almost never reached in a duel, but a firefight is exactly when a frame is
 * already expensive. Together they leave `medium` a worst case of 16 sprites against
 * `high`'s 96.
 *
 * MEASURED in tools/gl/harness.ts (swiftshader, 800x500, eight guns, clouds frozen
 * mid-life, mean of 60 `render` calls best-of-3, two runs): at the full ceiling the effect
 * costs `high` about 0.165ms of main-thread time per frame and costs `medium` about
 * 0.024ms, an 86% cut; at the 8-cloud population a real firefight produces, about 0.055ms
 * against 0.019ms. The harness comment carries the full table and the controls.
 *
 * AND THE HONEST PART: 0.165ms is 1% of a 16.67ms frame. This is a lever, not a rescue.
 * The defect being fixed is that PR #537 shipped the effect with no way to turn it down at
 * all; it is not that the effect was measurably the lag it was then blamed for. A preset
 * that changed the picture and bought nothing would be worse than no preset.
 *
 * WHAT IT COSTS THE LOOK. The surviving billow is still a textured, irregular, expanding
 * puff; what goes is the SHEAR, the way three offset billows of different sizes and drift
 * rates pull apart as the cloud rises. That is the right loss to take -- it degrades how
 * the smoke moves rather than whether the player can see that the gun smoked, and a
 * refusal's near-black puff still reads against the felt, since its darkness and its
 * density are carried on the tint and the fade curve, not on the billow count.
 */
export const CHEAP_MUZZLE_SMOKE: MuzzleSmokeQuality = { billowsPerCloud: 1, maxClouds: 16 };

/**
 * `high` is today's shipped behaviour, copied byte-for-byte from scene.ts's own
 * constructor calls -- this is the DEFAULT preset, so an absent `quality` flag must
 * reproduce today's render exactly. Every field here names the line it mirrors, and
 * quality.test.ts pins each one against a literal (not against this table, which
 * would be a tautology).
 */
export const QUALITY_PRESETS: Record<QualityPreset, RenderQuality> = {
  high: {
    antialias: true, // scene.ts:116 `new THREE.WebGLRenderer({ canvas, antialias: true })`
    pixelRatioCap: 2, // scene.ts:117 & :293 `Math.min(window.devicePixelRatio, 2)`
    shadowMapSize: 2048, // scene.ts:168 `sun.shadow.mapSize.set(2048, 2048)`
    shadowType: THREE.PCFSoftShadowMap, // scene.ts:119 `renderer.shadowMap.type = THREE.PCFSoftShadowMap`
    muzzleSmoke: FULL_MUZZLE_SMOKE, // every billow of muzzle-smoke.ts's table, at its own ceiling
  },
  /**
   * A feel/perf step down. The four scene knobs are NOT yet measured on-device --
   * awaiting the sweep the issue defers -- but `muzzleSmoke` is, in the GL harness, and
   * its numbers are on CHEAP_MUZZLE_SMOKE above. Half the shadow texel density (1024 vs
   * 2048) and a slightly lower pixel ratio ceiling (1.5 vs 2) are where most of a
   * mid-range GPU's cost sits; antialias stays on, and the shadow filter steps down ONE
   * rung, PCFSoft -> plain PCF (still filtered, no longer soft-sampled) -- review caught
   * an earlier draft of this comment claiming "the soft PCF filter stays on", which is
   * high's filter, not this one's.
   */
  medium: {
    antialias: true,
    pixelRatioCap: 1.5,
    shadowMapSize: 1024,
    shadowType: THREE.PCFShadowMap,
    muzzleSmoke: CHEAP_MUZZLE_SMOKE,
  },
  /**
   * The floor. The four scene knobs are unmeasured: antialias off first -- MSAA is the
   * single most expensive per-pixel cost on a low-end GPU -- pixel ratio capped at native
   * (no supersampling at all), a quarter of medium's shadow resolution, and three.js's
   * cheapest hard-edged shadow filter (no PCF sampling).
   *
   * The smoke is the measured one, and it is dropped outright rather than cheapened. The
   * owner's ruling was three-way -- gone at `low`, cheapened at `medium`, untouched at
   * `high` -- and `null` is what "gone" has to mean for a system whose per-frame work
   * happens whether or not anything is visible.
   */
  low: {
    antialias: false,
    pixelRatioCap: 1,
    shadowMapSize: 512,
    shadowType: THREE.BasicShadowMap,
    muzzleSmoke: null,
  },
};

/** `null` (flag absent, or a garbage value the dev-flags parser already rejected to
 * null) resolves to the default preset -- never to a guess at what was meant. */
export function qualityFor(preset: QualityPreset | null): RenderQuality {
  return QUALITY_PRESETS[preset ?? DEFAULT_QUALITY_PRESET];
}
