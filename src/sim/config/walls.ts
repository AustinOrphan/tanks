import type { WallKind } from '../types';
import { createCatalog } from './catalog';

// ---------------------------------------------------------------------------
// The SECOND entity family on the catalog machinery, which is what makes the
// pipeline generic rather than tank-shaped: walls. No balance classes yet, so
// the resolver is the identity -- the definition IS the runtime config. If wall
// tuning ever grows classes (armour tiers, breach thresholds), this grows a
// balance table and a real resolver the same way tanks did, without its
// consumers changing.
//
// Fidelity: authored to reproduce current behaviour exactly. Colours are the
// hex the renderer shipped as literals; destructibleByBlast mirrors the
// `kind === 'destructible'` test the mine system used to hardcode. Whether a
// blast PASSES a destructible wall on its way to a tank stays the documented
// build-time constant MINE_BLAST_THROUGH_DESTRUCTIBLE (constants.ts) -- it is a
// rule of the blast, not a property of one wall kind, and blastReaches already
// takes it as a parameter.
// ---------------------------------------------------------------------------

export interface WallDefinition {
  displayName: string;
  /** Presentation (render reads it; the pure sim never does). CSS hex. */
  color: string;
  /** May a mine blast destroy this wall? The mine system's one per-kind rule. */
  destructibleByBlast: boolean;
}

export const GAME_WALL_DEFS: Record<WallKind, WallDefinition> = {
  solid: {
    displayName: 'Solid',
    color: '#565b66',
    destructibleByBlast: false,
  },
  destructible: {
    displayName: 'Destructible',
    color: '#b08040',
    destructibleByBlast: true,
  },
};

const WALL_CATALOG = createCatalog<WallKind, WallDefinition, WallDefinition>(
  GAME_WALL_DEFS,
  (kind, defs) => defs[kind],
);

/** The resolved runtime config for a wall kind. */
export function wallConfigFor(kind: WallKind): WallDefinition {
  return WALL_CATALOG.get(kind);
}
