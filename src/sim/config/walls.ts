import type { WallKind } from '../types';
import { createCatalog } from './catalog';

// ---------------------------------------------------------------------------
// No balance classes yet, so the resolver only copies. If wall tuning ever grows
// classes (armour tiers, breach thresholds), this grows a balance table and a
// real resolver the same way tanks did, without its consumers changing.
//
// Whether a blast passes a destructible wall on its way to a tank is the
// build-time constant MINE_BLAST_THROUGH_DESTRUCTIBLE (constants.ts), not a
// field here: it is a rule of the blast, not a property of one wall kind.
// ---------------------------------------------------------------------------

export interface WallDefinition {
  displayName: string;
  /** Presentation (render reads it; the pure sim never does). CSS hex. */
  color: string;
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
  // Copied so the resolved object is not a live handle on the definition table.
  (kind, defs) => ({ ...defs[kind] }),
);

export function wallConfigFor(kind: WallKind): WallDefinition {
  return WALL_CATALOG.get(kind);
}
