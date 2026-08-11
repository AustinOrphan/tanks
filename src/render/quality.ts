/**
 * Render quality presets: the four knobs issue #113 named as hardcoded in scene.ts
 * (antialias, pixel ratio cap, shadow map size, shadow filter), pulled into a table so
 * an on-device sweep can be a URL change (`?dev=1&quality=low|medium|high`) instead of a
 * rebuild per pass.
 *
 * Auto-detection from a device probe is explicitly OUT OF SCOPE here -- see the issue --
 * pending the on-device measurement spike. This only makes the knobs reachable.
 */
import * as THREE from 'three';

export type QualityPreset = 'low' | 'medium' | 'high';

export interface RenderQuality {
  readonly antialias: boolean;
  readonly pixelRatioCap: number;
  readonly shadowMapSize: number;
  readonly shadowType: THREE.ShadowMapType;
}

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
  },
  /**
   * A feel/perf step down, NOT yet measured on-device -- awaiting the sweep the issue
   * defers. Half the shadow texel density (1024 vs 2048) and a slightly lower pixel
   * ratio ceiling (1.5 vs 2) are where most of a mid-range GPU's cost sits; antialias
   * and the soft PCF filter stay on because they are comparatively cheap next to a
   * full-resolution shadow map.
   */
  medium: {
    antialias: true,
    pixelRatioCap: 1.5,
    shadowMapSize: 1024,
    shadowType: THREE.PCFShadowMap,
  },
  /**
   * The floor, also unmeasured. Antialias off first -- MSAA is the single most
   * expensive per-pixel cost on a low-end GPU -- pixel ratio capped at native (no
   * supersampling at all), a quarter of medium's shadow resolution, and three.js's
   * cheapest hard-edged shadow filter (no PCF sampling).
   */
  low: {
    antialias: false,
    pixelRatioCap: 1,
    shadowMapSize: 512,
    shadowType: THREE.BasicShadowMap,
  },
};

/** The preset an absent or unrecognised `quality` flag resolves to: today's behaviour. */
export const DEFAULT_QUALITY_PRESET: QualityPreset = 'high';

/** `null` (flag absent, or a garbage value the dev-flags parser already rejected to
 * null) resolves to the default preset -- never to a guess at what was meant. */
export function qualityFor(preset: QualityPreset | null): RenderQuality {
  return QUALITY_PRESETS[preset ?? DEFAULT_QUALITY_PRESET];
}
