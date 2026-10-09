// @vitest-environment jsdom
/*
 * What `buildMomentScene` hands the systems it builds (issue #1018). The pixels those systems
 * draw are tools/gl/harness.ts's business; this file pins the WIRING, which is where a moment
 * capture goes inert without anything failing: a flag that never reaches `createEntityViews`
 * draws the shipped board, and a motion policy that never reaches the recoil or the smoke draws
 * full motion in a frame labelled reduced.
 *
 * The scene builds under jsdom because the one WebGL object, the renderer, is injectable
 * (`MomentSceneOptions.renderer`); a recorder stands in for it. The three factories are wrapped
 * rather than replaced, so every system is the real one and only its arguments are recorded.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import type * as THREE from 'three';
import { ENEMY_ROLE_CUES } from '../../presentation/enemy-role';
import { buildMomentScene, type MomentSceneOptions } from './moment-scene';

const calls = vi.hoisted(() => ({
  entityArgs: [] as unknown[][],
  recoilMotion: [] as boolean[],
  smokeMotion: [] as boolean[],
}));

vi.mock('../entities', async (importOriginal) => {
  const real = await importOriginal<typeof import('../entities')>();
  return {
    ...real,
    createEntityViews: (...args: Parameters<typeof real.createEntityViews>) => {
      calls.entityArgs.push(args);
      return real.createEntityViews(...args);
    },
  };
});

vi.mock('../barrel-recoil', async (importOriginal) => {
  const real = await importOriginal<typeof import('../barrel-recoil')>();
  return {
    ...real,
    createBarrelRecoilSystem: (...args: Parameters<typeof real.createBarrelRecoilSystem>) => {
      const system = real.createBarrelRecoilSystem(...args);
      return {
        ...system,
        setReducedMotion: (on: boolean) => {
          calls.recoilMotion.push(on);
          system.setReducedMotion(on);
        },
      };
    },
  };
});

vi.mock('../muzzle-smoke', async (importOriginal) => {
  const real = await importOriginal<typeof import('../muzzle-smoke')>();
  return {
    ...real,
    createMuzzleSmokeSystem: (...args: Parameters<typeof real.createMuzzleSmokeSystem>) => {
      const system = real.createMuzzleSmokeSystem(...args);
      return {
        ...system,
        setReducedMotion: (on: boolean) => {
          calls.smokeMotion.push(on);
          system.setReducedMotion(on);
        },
      };
    },
  };
});

const fakeRenderer = (): THREE.WebGLRenderer =>
  ({ setSize() {}, render() {}, dispose() {} }) as unknown as THREE.WebGLRenderer;

function build(over: Partial<MomentSceneOptions>): void {
  const g = buildMomentScene({} as HTMLCanvasElement, 320, 240, {
    moment: 'fire', view: 'game', skin: 'solid', hull: null, accent: null, spawnAnim: 'warp',
    renderer: fakeRenderer(),
    ...over,
  });
  g.draw(0, 0);
  g.dispose();
}

afterEach(() => {
  calls.entityArgs.length = 0;
  calls.recoilMotion.length = 0;
  calls.smokeMotion.length = 0;
});

describe('buildMomentScene wiring (issue #1018)', () => {
  it('hands its enemyRole to createEntityViews -- population: every cue in ENEMY_ROLE_CUES', () => {
    // `createEntityViews`' sixth parameter, the slot renderer.ts fills from the same option.
    for (const cue of ENEMY_ROLE_CUES) {
      build({ enemyRole: cue });
      expect(calls.entityArgs.at(-1)?.[5], cue).toBe(cue);
    }
  });

  it('builds the shipped board without one', () => {
    build({});
    expect(calls.entityArgs.at(-1)?.[5]).toBeNull();
  });

  it('pushes a reduced motion policy to the barrel recoil and the muzzle smoke', () => {
    build({ motion: 'reduced' });
    expect(calls.recoilMotion, 'barrel recoil').toEqual([true]);
    expect(calls.smokeMotion, 'muzzle smoke').toEqual([true]);
  });

  it('pushes full motion, the systems\' own default, when the policy is full or absent', () => {
    // Both systems start at `reducedMotion = false`, so pushing `false` leaves a full-motion
    // moment exactly as it rendered before the push existed.
    build({ motion: 'full' });
    build({});
    expect(calls.recoilMotion).toEqual([false, false]);
    expect(calls.smokeMotion).toEqual([false, false]);
  });
});
