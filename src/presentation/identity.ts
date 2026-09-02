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
 * owner's own first suggestion ("P1 blue-white, P2 orange"). Neither value equals any
 * roster kind's own `color` (config/data/tank-defs.json)
 * or the co-op placeholder hull swatch (`render/entities.ts`'s `UNSTYLED_SLOT_HEX`) -- pinned by
 * entities.test.ts's identity-ring distinctness sweep, which diffs all 4 ring hexes,
 * pairwise, against each other AND against every roster colour and the placeholder.
 *
 * Slot 2: a bright vermillion. Slot 3: a reddish-purple pushed toward violet. Both are
 * the remaining Okabe-Ito-adjacent hues past blue/orange (its own vermillion #D55E00
 * and reddish-purple #CC79A7), re-brightened the same way slots 0/1 were. Neither is a
 * clean win: RGB-distance-and-hue-angle checked by hand (not asserted -- the sweep below
 * is inequality-only) against the existing two rings, the roster and the placeholder,
 * slot 2 sits only ~20 degrees of hue from slot 1's own orange (both are inherently
 * warm/red hues in this part of the palette -- Okabe-Ito's own orange and vermillion are
 * just as close, ~18 degrees apart), and slot 3's hue was moved OFF the literal
 * reddish-purple hue and toward violet specifically because the true reddish-purple
 * territory (~320-330 degrees) already sits close to `UNSTYLED_SLOT_HEX`'s own hue
 * (~323 degrees). Every other pairing (roster, placeholder) measured with a wide margin.
 */
export const IDENTITY_RING_COLORS: readonly number[] = [0x3fd0ff, 0xff8a1e, 0xff4d2e, 0x9d3bff];
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
 * degrees from the nearest saturated neighbour, and carries the SAME saturation and value
 * as the two existing team hues (0.77 / 1.00) so the trio reads as one set.
 *
 * RED AND GREEN IS THE WORST PAIR FOR A DEUTERANOPE, and that is accepted rather than
 * overlooked: the constraint set leaves no hue that is both well separated here and
 * colour-blind-safe against red. It is why `TEAM_LABELS` exists and why the stock readout
 * carries the letter -- the issue requires the reinforcement precisely so the hue is not
 * load-bearing on its own. A vivid red/blue/green trio, verified distinct
 * from every roster colour, both identity-ring hues and the unstyled-slot placeholder
 * by entities.test.ts's sweep -- same reuse-the-mechanism, new-colour-source shape PR1
 * itself used for IDENTITY_RING_COLORS' own placeholder swatch.
 */
export const TEAM_COLORS: readonly [number, number, number] = [0xff3b3b, 0x3b82ff, 0x4eff3b];

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
