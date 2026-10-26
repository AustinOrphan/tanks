// @vitest-environment jsdom
//
// THE RING AND THE CHIP AGREE (issue #1057). A player reads their identity off two surfaces at
// once: the ring around their tank (render/entities.ts) and their chip in the stock strip
// (game/hud.ts). The two are drawn by different code, from the same palette the session hands
// both, and the issue requires them to be one colour for every slot in FFA and every team in
// Teams under both palettes.
//
// Here rather than in src/: the layer guard (src/dependency-direction.test.ts) keeps a render
// test from importing game/ and a game test from importing render/entities, which is right for
// unit tests and is exactly why neither side's own suite can see the other. This file is the
// composition check, and it builds both real surfaces: three's scene graph runs on the CPU, so
// jsdom is enough for the ring as well as the chip.
import { describe, it, expect, afterEach } from 'vitest';
import * as THREE from 'three';
import { createEntityViews } from '../../src/render/entities';
import { createHud, type Hud, type VersusStock } from '../../src/game/hud';
import { OWNER_PALETTES, type OwnerPaletteId } from '../../src/presentation/identity';
import { createWorld, type World } from '../../src/sim/world';
import type { Spawn, Tank } from '../../src/sim/types';

const XS = [3, 9, 15, 21];

/**
 * `count` players at XS: FFA by slot, or teams A, B, C, A (at 4, a 2v1v1, so all 3 teams
 * appear). One player is the world `?dev=1&mode=ffa` (or `mode=teams`) builds without
 * `players`: slot 0 on team A.
 */
function players(mode: 'ffa' | 'teams', count = XS.length): World {
  const teams = [0, 1, 2, 0];
  const tanks: Tank[] = XS.slice(0, count).map((x, slot) => ({
    id: slot + 1, kind: 'player', pos: { x, y: slot % 2 === 0 ? 3 : 9 }, bodyAngle: 0,
    turretAngle: 0, alive: true, desiredMove: { x: 0, y: 0 }, activeMineIds: [],
    fireCooldown: 0, mineCooldown: 0, aiState: 'idle', aiTimer: 0, controlledBy: slot,
    ...(mode === 'teams' ? { team: teams[slot] } : {}),
  }));
  const spawns: Spawn[] = tanks.map((t) => ({ kind: 'player', pos: { ...t.pos }, angle: 0 }));
  return createWorld({ walls: [], tanks, spawns, lives: 3, mode });
}

/** Each player's identity ring colour, in slot order, read off the real scene. */
function ringColours(world: World, palette: OwnerPaletteId): number[] {
  const scene = new THREE.Scene();
  const views = createEntityViews(scene, undefined, null, null, null, OWNER_PALETTES[palette]);
  views.sync(world, world, 0);
  const byX = new Map<number, number>();
  scene.traverse((o) => {
    if (o.name !== 'identity-ring') return;
    let g: THREE.Object3D = o;
    while (g.parent && g.parent.type !== 'Scene') g = g.parent;
    byX.set(g.position.x, ((o as THREE.Mesh).material as THREE.MeshBasicMaterial).color.getHex());
  });
  views.dispose();
  return XS.map((x) => byX.get(x) ?? -1);
}

/**
 * The entrance ring round a one-player world's tank on a round's first frame, read off the
 * real scene. At one player it is the only ring drawn: identity does not apply, so there is
 * no identity ring to compare the chip with.
 */
function spawnRingColour(mode: 'ffa' | 'teams', palette: OwnerPaletteId): number {
  const scene = new THREE.Scene();
  const views = createEntityViews(scene, undefined, null, null, null, OWNER_PALETTES[palette]);
  const prev = players(mode, 1);
  const curr = players(mode, 1);
  curr.roundStartTick = prev.roundStartTick + 4; // a round boundary, so the entrance ring plays
  views.sync(prev, curr, 1, 0.016);
  let colour = -1;
  scene.traverse((o) => {
    if (o.name === 'spawn-ring') colour = ((o as THREE.Mesh).material as THREE.MeshBasicMaterial).color.getHex();
  });
  views.dispose();
  return colour;
}

let hud: Hud | null = null;
afterEach(() => {
  hud?.dispose();
  hud = null;
  document.body.innerHTML = '';
});

/** Each player's stock chip colour, in slot order, read off the real HUD. */
function chipColours(world: World, palette: OwnerPaletteId): string[] {
  const root = document.createElement('div');
  document.body.appendChild(root);
  hud = createHud(root);
  hud.setStockPalette(OWNER_PALETTES[palette]);
  hud.setState('playing');
  // The session's own projection (loop.ts's versusStocksOf): slot and team off each tank.
  const stocks: VersusStock[] = world.tanks
    .filter((t) => t.kind === 'player')
    .map((t) => ({ slot: t.controlledBy ?? 0, stock: 3, team: t.team }));
  hud.setStatus({ kind: 'versus', mission: 1, missions: 1, stocks });
  return Array.from(root.querySelectorAll<HTMLElement>('.hud-versus-stock-entry')).map((e) => e.style.color);
}

const rgb = (hex: number): string => `rgb(${(hex >> 16) & 0xff}, ${(hex >> 8) & 0xff}, ${hex & 0xff})`;

describe('the identity ring and the stock chip are one colour (issue #1057)', () => {
  // Population: 2 modes x 2 palettes, 4 players each -- 4 FFA slots, and in Teams 3 teams
  // over 4 tanks. Palettes spelled out rather than iterated from OWNER_PALETTE_IDS, so a
  // palette dropped from the catalogue loses its case loudly rather than silently.
  for (const mode of ['ffa', 'teams'] as const) {
    for (const palette of ['classic', 'high-contrast'] as const) {
      it(`${mode}, ${palette}: every player's ring and chip match`, () => {
        const world = players(mode);
        const rings = ringColours(world, palette);
        const chips = chipColours(world, palette);
        expect(rings, 'one ring per player').not.toContain(-1);
        expect(chips, 'one chip per player').toHaveLength(4);
        expect(chips).toEqual(rings.map(rgb));
      });
    }
  }

  it('NEGATIVE CONTROL: a ring and a chip drawn from different palettes disagree in every slot', () => {
    // What the cases above would have to catch: the renderer handed one palette, the HUD the
    // other. Every one of the 7 owner colours differs between the two palettes, so a
    // mismatched pair cannot pass by coincidence.
    for (const mode of ['ffa', 'teams'] as const) {
      const world = players(mode);
      const rings = ringColours(world, 'high-contrast').map(rgb);
      const chips = chipColours(world, 'classic');
      for (let i = 0; i < 4; i++) expect(chips[i], `${mode} slot ${i}`).not.toBe(rings[i]);
    }
  });

  // One player, under High contrast: the chip has to match the entrance ring, which keeps the
  // shipped colour because identity does not apply. Population: 1 FFA slot and 1 team, each
  // against its Classic colour written out (slot 0 #3fd0ff, team A #ff3b3b). The four-player
  // high-contrast cases above are the control: there the same palette does reach both.
  it('ffa, one player, high-contrast: the chip keeps the shipped colour its spawn ring draws', () => {
    const spawn = spawnRingColour('ffa', 'high-contrast');
    expect(spawn, 'the entrance ring is Classic slot 0').toBe(0x3fd0ff);
    expect(chipColours(players('ffa', 1), 'high-contrast')).toEqual([rgb(spawn)]);
  });

  it('teams, one player, high-contrast: the chip keeps the shipped colour its spawn ring draws', () => {
    const spawn = spawnRingColour('teams', 'high-contrast');
    expect(spawn, 'the entrance ring is Classic team A').toBe(0xff3b3b);
    expect(chipColours(players('teams', 1), 'high-contrast')).toEqual([rgb(spawn)]);
  });
});
