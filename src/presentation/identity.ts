/**
 * Player and team IDENTITY -- the renderer-independent answer to "WHO is this tank", as
 * a colour and, for teams, a letter. Chosen by the application (slot and team come from
 * the versus setup) and consumed by three projections at once: `render/entities.ts`
 * (rings, shell tints), `render/tread-trails.ts` and `render/death-pulse.ts` (the same
 * colour on the ground), and `game/hud.ts` / `game/loop.ts` (the stock readout and the
 * death vignette). Issue #473 moved it here from `render/entities.ts` so the HUD no
 * longer imports a Three.js module to learn a player's colour, and so no renderer file
 * is the authoritative source of a semantic the HUD paints too.
 *
 * Semantics only. Ring radii, materials and the placeholder hull swatch stay in
 * `render/entities.ts`; this module imports nothing but simulation TYPES, which
 * `src/dependency-direction.test.ts` enforces.
 */
import type { World } from '../sim/world';
import type { Tank, TankKind } from '../sim/types';

/**
 * Player IDENTITY colours -- WHO is driving, indexed by co-op SLOT (`Tank.controlledBy`).
 * Deliberately a separate palette from `customization.ts`'s `PALETTE` (hull paint, WHAT
 * style): the owner's brief draws the line explicitly -- "the ring says WHO, the hull
 * says WHAT STYLE" -- so a player who paints their hull orange must not have their own
 * identity colour collide with that choice by construction, which ties both palettes to
 * the same list would risk.
 *
 * Slot 0: a bright cyan-blue. Slot 1: a saturated amber-orange -- the blue/orange axis
 * Okabe-Ito uses for CVD safety (chosen for hue separation under protanopia,
 * deuteranopia AND tritanopia -- unlike a red/green pair, which collapses under the
 * first two), though these two exact hexes are not lifted from that palette (its
 * #0072B2/#E69F00 read too dark unlit against this scene's ground). It is also the
 * owner's own first suggestion ("P1 blue-white, P2 orange"). All four rings sit at least
 * `OWNER_FLOOR` in CIEDE2000, as drawn, from every roster kind's own `color`
 * (sim/config/data/tank-defs.json) and the co-op placeholder hull swatch
 * (`render/entities.ts`'s `UNSTYLED_SLOT_HEX`) -- measured by entities.test.ts's ring sweep
 * for both owner palettes (issue #1056), which replaced a sweep that compared hexes for
 * inequality only.
 *
 * Slot 2: a bright vermillion. Slot 3: a reddish-purple pushed toward violet. Both are
 * the remaining Okabe-Ito-adjacent hues past blue/orange (its own vermillion #D55E00
 * and reddish-purple #CC79A7), re-brightened the same way slots 0/1 were. Neither is a
 * clean win: RGB-distance-and-hue-angle checked by hand (not asserted -- the sweep of the
 * time compared hexes for inequality only) against the existing two rings, the roster and
 * the placeholder,
 * slot 2 sits only ~20 degrees of hue from slot 1's own orange (both are inherently
 * warm/red hues in this part of the palette -- Okabe-Ito's own orange and vermillion are
 * just as close, ~18 degrees apart), and slot 3's hue was moved OFF the literal
 * reddish-purple hue and toward violet specifically because the true reddish-purple
 * territory (~320-330 degrees) already sits close to `UNSTYLED_SLOT_HEX`'s own hue
 * (~323 degrees). Every other pairing (roster, placeholder) measured with a wide margin.
 */
export const IDENTITY_RING_COLORS: OwnerRingSet = [0x3fd0ff, 0xff8a1e, 0xff4d2e, 0x9d3bff];
/**
 * Ring/tint colour for any slot beyond the identity palette. Unreached today -- N-player
 * caps at 4 (devflags.ts's `players`) -- defined so a hypothetical 5th slot degrades to a
 * colour rather than `undefined` reaching a THREE material constructor.
 */
const IDENTITY_COLOR_FALLBACK = 0xffffff;
function identityColor(slot: number): number {
  return IDENTITY_RING_COLORS[slot] ?? IDENTITY_COLOR_FALLBACK;
}

/**
 * Team colours (n-player arc PR 4) -- 'teams' mode's alternative to IDENTITY_RING_COLORS
 * at the SAME lookup site (syncTanks' ring creation, shellTintFor), dispatched on
 * `world.rules.mode === 'teams'`. Where per-slot identity answers "which of 4 players",
 * teams answers "which SIDE" -- knowing your teammate's shell apart from an
 * opponent's matters more than telling two teammates apart.
 *
 * THREE, not two, since issue #281: four-player Teams may use two or three teams
 * (2v2 or 2v1v1), and `Tank.team` is now the CONFIGURED team rather than the derived
 * `slot % 2`. Before the third entry existed `teamColor(2)` fell through to
 * `IDENTITY_COLOR_FALLBACK` -- white, which is also the unstyled-slot placeholder -- so a
 * 2v1v1 match rendered one whole side as "no identity".
 *
 * The third hue was picked by MEASUREMENT, and the first measurement was WRONG in a way
 * worth recording. Ranking candidates by RGB distance chose a magenta `#ff4fd8`, which
 * sits 97 away from everything -- and only **10 degrees of hue** from `UNSTYLED_SLOT_HEX`.
 * This file's own note on `IDENTITY_RING_COLORS` above already says that ~320-330 degree
 * territory is spoken for, and that slot 3's hue was moved off it for exactly that reason.
 * RGB distance is the wrong metric here; HUE SEPARATION is the one the palette is actually
 * reasoned about in.
 *
 * Re-picked on that basis: the largest unoccupied hue gap among the saturated colours is 78
 * degrees, between olive (75) and the green tank (154). `#4eff3b` sits at its midpoint, 39
 * degrees from the nearest saturated neighbour, and carried the SAME saturation and value
 * as the two team hues of the time, red and the old blue `#3b82ff` (0.77 / 1.00), so the
 * trio read as one set. That stopped holding when team B became `#fcc0fc` (0.24 / 0.99,
 * issue #579 below).
 *
 * RED AND GREEN IS THE WORST PAIR FOR A DEUTERANOPE, and that is accepted rather than
 * overlooked: the constraint set leaves no hue that is both well separated here and
 * colour-blind-safe against red. It is why `TEAM_LABELS` exists and why the stock readout
 * carries the letter -- the issue requires the reinforcement precisely so the hue is not
 * load-bearing on its own.
 *
 * TEAM B IS NO LONGER BLUE (issue #579). It was `#3b82ff`, and once the ring stopped being
 * additively blended (#580) that blue survived compositing intact and landed on top of the
 * thing it is drawn beside: **2.09** from the player's default hull `#3d7bd6`, which is also
 * offered as the `Classic blue` paint. A blue ring around a blue tank carries no
 * information. Under the additive blending it replaced, the same pair measured 31.13 -- the
 * old value was masked by a bug, not earned.
 *
 * `#fcc0fc` was chosen by measuring, not by eye, against every colour a team ring can sit
 * beside. Note that set is smaller than it looks: team colours render only in `teams` mode,
 * which is versus-only, and versus arenas strip every non-player spawn (arena.ts) -- so
 * brown, teal and the rest never share a screen with these, and constraining against them
 * would have been over-constraint.
 *
 * Measured as drawn, composited over the felt. Re-measured with `colour-distance.ts` on
 * 2026-10-10 (origin/main c200cf62): the first, second and fourth rows reproduce #579's
 * figures; the colour-vision row did not, because #579 did not record its simulation, so it
 * now shows Machado 2009 (`simulateColourVision`, issue #1056) instead of #579's 25.4 / 29.5.
 *
 * | | old `#3b82ff` | new `#fcc0fc` |
 * | --- | ---: | ---: |
 * | vs the player hull and placeholder | 2.09 | **29.3** |
 * | vs every customization paint | 2.09 | **21.2** |
 * | vs teams A and C, worst across normal/protan/deutan/tritan | 24.5 | **31.9** |
 * | luminance contrast against the felt | 1.56 | **3.42** |
 *
 * Better on every axis, which is why it is here rather than a compromise. Cyan scored
 * higher against the hull and looked more vivid, and was rejected: it collapses to 8.6
 * against team C under tritanopia, because cyan and green converge there.
 */
export const TEAM_COLORS: readonly [number, number, number] = [0xff3b3b, 0xfcc0fc, 0x4eff3b];

/**
 * Single letters for the same three sides, and the reason they exist (issue #281).
 *
 * The issue asks for team choice to be "reinforce[d] ... with label/marker in addition to
 * color". A hue alone fails three readers at once: a colour-blind player, a player on a
 * forced-colours palette (issue #368 replaces authored hues outright), and anyone reading a
 * screenshot in greyscale. A letter survives all three, and it is the same A/B/C the setup
 * pane's team selector shows -- so the readout and the control that set it agree.
 */
export const TEAM_LABELS: readonly [string, string, string] = ['A', 'B', 'C'];
function teamColor(team: number): number {
  return TEAM_COLORS[team] ?? IDENTITY_COLOR_FALLBACK;
}

/** An owner palette's rings: one colour per co-op slot (`Tank.controlledBy`), slots 0 to 3. */
export type OwnerRingSet = readonly [number, number, number, number];
/** An owner palette's teams: one colour per side (`Tank.team`), in `TEAM_LABELS` order. */
export type OwnerTeamSet = readonly [number, number, number];
/**
 * A ring set and a team set, chosen together: #586 rules out choosing them independently.
 * The label is kept apart, in `OWNER_PALETTE_LABELS`, so a renderer handed a palette carries
 * no UI strings.
 */
export interface OwnerPalette {
  readonly rings: OwnerRingSet;
  readonly teams: OwnerTeamSet;
}

/**
 * The owner palettes (issue #1056, the data half of #586). The ids live here, free of any
 * renderer, so `game/settings.ts` can name them later the way it names
 * `presentation/quality.ts`'s presets. NOTHING READS THE PALETTES YET: every consumer still
 * indexes `IDENTITY_RING_COLORS` and `TEAM_COLORS`, which are Classic's own arrays, so the
 * game draws exactly what it drew before.
 */
export const OWNER_PALETTE_IDS = ['classic', 'high-contrast'] as const;
export type OwnerPaletteId = (typeof OWNER_PALETTE_IDS)[number];
export const DEFAULT_OWNER_PALETTE: OwnerPaletteId = 'classic';
export const OWNER_PALETTE_LABELS: Readonly<Record<OwnerPaletteId, string>> = {
  classic: 'Classic',
  'high-contrast': 'High contrast',
};

/**
 * HOW EVERY FIGURE BELOW WAS MEASURED: with `presentation/colour-distance.ts` on 2026-10-10,
 * origin/main c200cf62 plus issue #1056. Each colour is composited over the felt with
 * `overFelt` (alpha 0.85, as `makeIdentityRing` draws it); for a colour-vision column it is
 * then passed through `simulateColourVision` (Machado, Oliveira and Fernandes 2009, severity
 * 1); then measured with CIEDE2000 (`distance`). A minimum is over a set's pairs: 6 for the 4
 * rings, 3 for the 3 teams. Ground contrast is `contrastRatio` (WCAG 2.x) of the composited
 * colour against the felt. `identity.test.ts` holds each palette to its floors and pins every
 * tightest pair below by name, so these tables cannot drift without a test failing.
 */
export const OWNER_PALETTES: Readonly<Record<OwnerPaletteId, OwnerPalette>> = {
  /**
   * CLASSIC: the shipped colours, held by reference so it cannot drift from what the game
   * draws.
   *
   * | set | normal | protan | deutan | tritan |
   * | --- | ---: | ---: | ---: | ---: |
   * | rings | 20.11 ring1-ring2 | 14.92 ring1-ring2 | 8.08 ring1-ring2 | 10.73 ring1-ring2 |
   * | teams | 35.98 A-B | 37.90 A-C | 18.90 A-C | 31.93 A-B |
   *
   * Ground contrast: rings 2.91 / 2.22 / 1.59 / 1.19; teams 1.47 / 3.42 / 3.80. Classic
   * predates the 3:1 and colour-vision floors and is not held to them. It is held to the
   * floors both palettes share: 38.82 from the felt (ring0), rings 17.09 from the roster
   * (ring0 vs teal) and 19.41 from the placeholder (ring3), teams 33.36 from the player hull
   * (team B) and 25.54 from the placeholder (team A), team pairs 35.98 against TEAM_FLOOR.
   * Its tightest paint pair, ring1 vs orange at 1.17, is tolerated by #586.
   */
  classic: { rings: IDENTITY_RING_COLORS, teams: TEAM_COLORS },
  /**
   * HIGH CONTRAST: #586's candidates (rings #63d1fd #8ffd00 #fdbbc6 #fdfdbb, teams #63d1fd
   * #c6fd00 #f2c6bb), recovered from `palette-candidates-as-rings.png` on pr-media by
   * inverting the composite. No channel was moved: every floor passes as recovered.
   *
   * | set | normal | protan | deutan | tritan |
   * | --- | ---: | ---: | ---: | ---: |
   * | rings | 18.74 ring1-ring3 | 15.54 ring1-ring3 | 14.79 ring1-ring3 | 11.26 ring0-ring1 |
   * | teams | 31.52 A-C | 23.75 A-C | 22.05 B-C | 17.72 A-B |
   *
   * Ground contrast: rings 3.00 / 3.91 / 3.19 / 4.71; teams 3.00 / 4.17 / 3.32. Against the
   * other floors: 38.83 from the felt (ring0), 17.87 from the hull paints (team C vs white),
   * rings 17.33 from the roster (ring0 vs teal) and 30.23 from the placeholder (ring2), teams
   * 25.29 from the player hull (team A) and 37.67 from the placeholder (team C).
   *
   * THREE THINGS TO KNOW BEFORE MOVING A COLOUR. Ring 0 and team A, the same cyan, reach 3:1
   * by 0.0021 (3.0021): one level down in any channel fails it (G gives 2.9761). Two tightest
   * pairs are near ties -- rings protan is 0.56 ahead of ring0-ring2 (16.10) and rings deutan
   * 0.31 ahead of ring2-ring3 (15.10) -- so a small move can change their names. And the gain
   * over Classic is narrower than #586 first read: the worst ring colour-vision pair is 11.26
   * against Classic's 8.08 (1.4x), and the worst team pair (17.72) is slightly BELOW Classic's
   * (18.90); the teams' gain is team A's ground contrast, 1.47 to 3.00.
   */
  'high-contrast': {
    rings: [0x63d1fd, 0x8ffd00, 0xfdbbc6, 0xfdfdbb],
    teams: [0x63d1fd, 0xc6fd00, 0xf2c6bb],
  },
};

/**
 * The shared team/identity dispatch, factored out (issue #200's death-pulse work) so
 * `syncTanks`'s ring/spawn-ring sites, `shellTintFor` and `death-pulse.ts`'s own ring
 * all agree on one function instead of three copies of `curr.mode === 'teams' ?
 * teamColor(...) : identityColor(...)` -- `loop.ts::deathVignetteColor` used to keep a
 * FOURTH copy that indexed `TEAM_COLORS`/`IDENTITY_RING_COLORS` directly rather than
 * calling `teamColor`/`identityColor`, which is why it fell back to
 * `SINGLE_PLAYER_DEATH_VIGNETTE` (red) instead of `IDENTITY_COLOR_FALLBACK` (white) on
 * an out-of-range slot -- unreached today (`players` caps at 4, matching both
 * palettes' length) and not pinned by any test, so folding it into this fallback
 * changes no observed behaviour. `tank.team ?? 0`/`tank.controlledBy ?? 0` mirror the
 * defensive fallbacks the three existing call sites already use.
 */
export function resolveOwnerColor(world: World, tank: Tank): number {
  return world.rules.mode === 'teams' ? teamColor(tank.team ?? 0) : identityColor(tank.controlledBy ?? 0);
}

/**
 * How many player-kind tanks a world has to have before identity rings/shell tints draw
 * at all. Below this, both are the single-player game exactly as shipped before this
 * feature -- byte-identical, not merely visually similar -- which is the stated
 * requirement. Held by the three single-player negative-control tests below this
 * threshold, and verified once manually by md5-comparing gallery renders against an
 * unmodified checkout (a method, not a checked-in tool -- rerun it if this area moves).
 */
const MULTIPLAYER_THRESHOLD = 2;

/**
 * The ONE gate identity colour hangs on, exported so a fourth consumer cannot assemble its
 * own copy of `countPlayerTanks(...) >= MULTIPLAYER_THRESHOLD`.
 *
 * Issue #284 is why it is exported rather than left local: tread trails need exactly this
 * predicate, and `resolveOwnerColor`'s own comment records what happened the last time a
 * call site rebuilt the identity logic instead of calling into it -- a fourth copy that
 * indexed the palettes directly and fell back to the wrong colour. `sync` below now calls
 * this too, so there is one definition rather than one plus a re-derivation.
 */
export function identityApplies(world: World): boolean {
  return countPlayerTanks(world.tanks) >= MULTIPLAYER_THRESHOLD;
}
function countPlayerTanks(tanks: readonly { kind: TankKind }[]): number {
  let n = 0;
  for (const t of tanks) if (t.kind === 'player') n++;
  return n;
}
