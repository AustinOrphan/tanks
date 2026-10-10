// The owner palettes (issue #1056): the catalogue, Classic's shipped colours written out, and
// the floors each palette is held to, measured the way a player sees them -- composited over
// the felt with `overFelt`, then (for a colour-vision floor) simulated, then CIEDE2000.
//
// What lives elsewhere, and why: the floors against the roster and the unstyled placeholder,
// and the team pairs in normal vision, are in render/entities.test.ts, because the
// placeholder is read off a rendered scene and a presentation test cannot import the
// renderer. Classic's paint floor is #975's, in customization.test.ts, and is not repeated.
//
// Figures quoted below were measured with colour-distance.ts on 2026-10-10, origin/main
// c200cf62 plus issue #1056; identity.ts carries the full table per palette.
import { describe, it, expect } from 'vitest';
import {
  IDENTITY_RING_COLORS,
  TEAM_COLORS,
  OWNER_PALETTE_IDS,
  DEFAULT_OWNER_PALETTE,
  OWNER_PALETTE_LABELS,
  OWNER_PALETTES,
  type OwnerPaletteId,
} from './identity';
import { PALETTE } from './customization';
import {
  ARENA_FELT,
  OWNER_FLOOR,
  contrastRatio,
  distance,
  overFelt,
  simulateColourVision,
  type ColourVision,
} from './colour-distance';

type Vision = 'normal' | ColourVision;
const seenAs = (colour: number, vision: Vision): number =>
  vision === 'normal' ? colour : simulateColourVision(colour, vision);

interface Named {
  name: string;
  colour: number;
}
const ringsOf = (id: OwnerPaletteId): Named[] =>
  OWNER_PALETTES[id].rings.map((colour, i) => ({ name: `ring${i}`, colour }));
const teamsOf = (id: OwnerPaletteId): Named[] =>
  OWNER_PALETTES[id].teams.map((colour, i) => ({ name: `team${'ABC'[i]}`, colour }));
const ownersOf = (id: OwnerPaletteId): Named[] => [...ringsOf(id), ...teamsOf(id)];

/** Every pair in `set`, composited and seen with `vision`, closest first. */
function pairsOf(set: Named[], vision: Vision): { pair: string; d: number }[] {
  const out: { pair: string; d: number }[] = [];
  for (let i = 0; i < set.length; i++) {
    for (let j = i + 1; j < set.length; j++) {
      const d = distance(seenAs(overFelt(set[i].colour), vision), seenAs(overFelt(set[j].colour), vision));
      out.push({ pair: `${set[i].name} vs ${set[j].name}`, d });
    }
  }
  return out.sort((a, b) => a.d - b.d);
}

describe('owner palettes: the catalogue (issue #1056)', () => {
  it('offers Classic and High contrast, Classic first and the default, each labelled and complete', () => {
    expect(OWNER_PALETTE_IDS).toEqual(['classic', 'high-contrast']);
    expect(DEFAULT_OWNER_PALETTE).toBe('classic');
    expect(OWNER_PALETTE_LABELS).toEqual({ classic: 'Classic', 'high-contrast': 'High contrast' });
    for (const id of ['classic', 'high-contrast'] as const) {
      expect(OWNER_PALETTES[id].rings, `${id}: one ring per co-op slot`).toHaveLength(4);
      expect(OWNER_PALETTES[id].teams, `${id}: one colour per team`).toHaveLength(3);
    }
  });

  it('Classic is the shipped seven hexes, written out, and the very arrays every consumer reads', () => {
    // Written out rather than derived from the export, so a change to a shipped colour fails
    // here however it is made. Classic must render byte-identically to the game before #1056.
    expect(IDENTITY_RING_COLORS).toEqual([0x3fd0ff, 0xff8a1e, 0xff4d2e, 0x9d3bff]);
    expect(TEAM_COLORS).toEqual([0xff3b3b, 0xfcc0fc, 0x4eff3b]);
    // The same objects, not equal copies: a copy could be edited apart from what the game
    // draws, and then "Classic" in a settings menu would not be the shipped look.
    expect(OWNER_PALETTES.classic.rings).toBe(IDENTITY_RING_COLORS);
    expect(OWNER_PALETTES.classic.teams).toBe(TEAM_COLORS);
  });

  it('High contrast is the seven hexes its recorded table was measured from, written out', () => {
    // The floors and tightest-pair rows below notice a move only when it crosses a floor,
    // renames a pair or raises one by 0.5. Ring 3 three levels down in blue (#fdfdb8) passes
    // them all while identity.ts's rings protan cell, ring1 vs ring3, goes stale by 0.53 (15.54
    // to 15.01). So a move fails here first: re-measure the table in identity.ts, then update
    // these.
    const remeasure = 're-measure the table in identity.ts before moving a High contrast colour';
    expect(OWNER_PALETTES['high-contrast'].rings, remeasure).toEqual([0x63d1fd, 0x8ffd00, 0xfdbbc6, 0xfdfdbb]);
    expect(OWNER_PALETTES['high-contrast'].teams, remeasure).toEqual([0x63d1fd, 0xc6fd00, 0xf2c6bb]);
  });
});

describe('owner palettes: floors, composited over the felt (issue #1056)', () => {
  // Each floor sits just under what the palette it binds measures, per #1056. Populations:
  // a palette has 4 ring colours and 3 team colours; 6 ring pairs and 3 team pairs.
  const GROUND_FLOOR = 3; // WCAG 2.x's contrast floor for non-text graphics
  const FELT_FLOOR = 30;
  const RING_PAIR_FLOOR = 18;
  const RING_PAIR_VISION_FLOOR = 11;
  const TEAM_PAIR_VISION_FLOOR = 17;

  it.each(['classic', 'high-contrast'] as const)(
    '%s: every ring and team colour sits at least 30 from the felt',
    (id) => {
      // Measured minimum: Classic 38.82, High contrast 38.83, both ring0. Both palettes are
      // held to it (#586's AC2). The floor is not implied by 3:1 contrast: a near-black ring
      // passes 3:1 on the dark side while sitting under 30 from the felt.
      const owners = ownersOf(id);
      expect(owners, '4 rings + 3 teams').toHaveLength(7);
      for (const { name, colour } of owners) {
        expect(distance(overFelt(colour), ARENA_FELT), `${name} vs the felt`).toBeGreaterThanOrEqual(FELT_FLOOR);
      }
    },
  );

  it('high contrast: every ring and team colour reaches 3:1 against the felt', () => {
    // Measured: rings 3.0021 / 3.9077 / 3.1851 / 4.7130, teams 3.0021 / 4.1676 / 3.3195. The
    // minimum is ring0 and team A, the same cyan, by 0.0021 -- see identity.ts before moving it.
    // Classic is not held to this: its rings reach 1.19 to 2.91.
    const owners = ownersOf('high-contrast');
    expect(owners, '4 rings + 3 teams').toHaveLength(7);
    for (const { name, colour } of owners) {
      expect(contrastRatio(overFelt(colour), ARENA_FELT), `${name} vs the felt`).toBeGreaterThanOrEqual(GROUND_FLOOR);
    }
  });

  it('high contrast: every ring pair clears 18 in normal vision', () => {
    // Measured minimum: 18.74, ring1 vs ring3.
    const pairs = pairsOf(ringsOf('high-contrast'), 'normal');
    expect(pairs, '6 pairs of 4 rings').toHaveLength(6);
    for (const { pair, d } of pairs) expect(d, pair).toBeGreaterThanOrEqual(RING_PAIR_FLOOR);
  });

  it.each(['protan', 'deutan', 'tritan'] as const)(
    'high contrast: every ring pair clears 11 under %s',
    (vision) => {
      // Measured minimums: protan 15.54, deutan 14.79 (both ring1 vs ring3), tritan 11.26
      // (ring0 vs ring1). Classic's are 14.92 / 8.08 / 10.73, which is what this palette is for.
      const pairs = pairsOf(ringsOf('high-contrast'), vision);
      expect(pairs, '6 pairs of 4 rings').toHaveLength(6);
      for (const { pair, d } of pairs) expect(d, pair).toBeGreaterThanOrEqual(RING_PAIR_VISION_FLOOR);
    },
  );

  it.each(['protan', 'deutan', 'tritan'] as const)(
    'high contrast: every team pair clears 17 under %s',
    (vision) => {
      // Measured minimums: protan 23.75 (A vs C), deutan 22.05 (B vs C), tritan 17.72 (A vs
      // B). In normal vision the team pairs are held to TEAM_FLOOR by entities.test.ts.
      const pairs = pairsOf(teamsOf('high-contrast'), vision);
      expect(pairs, '3 pairs of 3 teams').toHaveLength(3);
      for (const { pair, d } of pairs) expect(d, pair).toBeGreaterThanOrEqual(TEAM_PAIR_VISION_FLOOR);
    },
  );

  it('high contrast: every ring and team colour clears OWNER_FLOOR from every hull paint', () => {
    // A painted hull is a tank the ring is drawn beside, so this is OWNER_FLOOR's own job.
    // Measured minimum: 17.87, team C vs white. Classic keeps #975's floor of 1 instead
    // (customization.test.ts): #586 tolerates its ring1 at 1.17 from the orange paint.
    let pairs = 0;
    for (const { name, colour } of ownersOf('high-contrast')) {
      for (const swatch of PALETTE) {
        const d = distance(overFelt(colour), parseInt(swatch.hex.slice(1), 16));
        expect(d, `${name} vs ${swatch.id}`).toBeGreaterThanOrEqual(OWNER_FLOOR);
        pairs += 1;
      }
    }
    expect(pairs, '7 owner colours x 6 paints').toBe(42);
  });
});

describe('owner palettes: the recorded figures (issue #1056)', () => {
  // identity.ts records each palette's tightest pair per vision type. Each row pins the pair
  // BY NAME, with a loose ceiling on its value, in the form #975 uses for ring1 vs orange: a
  // re-pick or a helper change that moves which pair is tightest fails here, and identity.ts's
  // table gets re-measured. The floor side belongs to the floor tests above, so a floor's own
  // negative control does not also fail a row here. Two High contrast names are near ties,
  // recorded in identity.ts: rings protan by 0.56 and rings deutan by 0.31.
  it.each([
    { palette: 'classic', set: 'rings', vision: 'normal', pair: 'ring1 vs ring2', recorded: 20.11 },
    { palette: 'classic', set: 'rings', vision: 'protan', pair: 'ring1 vs ring2', recorded: 14.92 },
    { palette: 'classic', set: 'rings', vision: 'deutan', pair: 'ring1 vs ring2', recorded: 8.08 },
    { palette: 'classic', set: 'rings', vision: 'tritan', pair: 'ring1 vs ring2', recorded: 10.73 },
    { palette: 'classic', set: 'teams', vision: 'normal', pair: 'teamA vs teamB', recorded: 35.98 },
    { palette: 'classic', set: 'teams', vision: 'protan', pair: 'teamA vs teamC', recorded: 37.9 },
    { palette: 'classic', set: 'teams', vision: 'deutan', pair: 'teamA vs teamC', recorded: 18.9 },
    { palette: 'classic', set: 'teams', vision: 'tritan', pair: 'teamA vs teamB', recorded: 31.93 },
    { palette: 'high-contrast', set: 'rings', vision: 'normal', pair: 'ring1 vs ring3', recorded: 18.74 },
    { palette: 'high-contrast', set: 'rings', vision: 'protan', pair: 'ring1 vs ring3', recorded: 15.54 },
    { palette: 'high-contrast', set: 'rings', vision: 'deutan', pair: 'ring1 vs ring3', recorded: 14.79 },
    { palette: 'high-contrast', set: 'rings', vision: 'tritan', pair: 'ring0 vs ring1', recorded: 11.26 },
    { palette: 'high-contrast', set: 'teams', vision: 'normal', pair: 'teamA vs teamC', recorded: 31.52 },
    { palette: 'high-contrast', set: 'teams', vision: 'protan', pair: 'teamA vs teamC', recorded: 23.75 },
    { palette: 'high-contrast', set: 'teams', vision: 'deutan', pair: 'teamB vs teamC', recorded: 22.05 },
    { palette: 'high-contrast', set: 'teams', vision: 'tritan', pair: 'teamA vs teamB', recorded: 17.72 },
  ] as const)('$palette $set, $vision: the tightest pair is $pair', ({ palette, set, vision, pair, recorded }) => {
    const pairs = pairsOf(set === 'rings' ? ringsOf(palette) : teamsOf(palette), vision);
    expect(pairs, set === 'rings' ? '6 pairs of 4 rings' : '3 pairs of 3 teams').toHaveLength(set === 'rings' ? 6 : 3);
    expect(pairs[0].pair).toBe(pair);
    expect(pairs[0].d).toBeLessThan(recorded + 0.5);
  });
});
