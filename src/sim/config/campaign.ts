import { createCatalog } from './catalog';
import type { ArenaDefinition } from './arena-types';
import type { CampaignDefinition, CampaignLevel } from './campaign-types';
import { validateCampaign } from './validate';
import { ARENA_DEFS } from './arenas';
import campaignJson from './data/campaign.json';

/**
 * The one shipped campaign: player-facing level identity and ordering, decoupled
 * from `ARENA_DEFS`'s own catalog order (see campaign-types.ts). Validated at
 * load: a bad edit is a boot failure naming the exact path (levels[2].arenaId),
 * never a silently broken level select.
 */
export const CAMPAIGN: CampaignDefinition =
  validateCampaign(campaignJson, new Set(ARENA_DEFS.map((a) => a.id)));
export const CAMPAIGN_LEVELS: readonly CampaignLevel[] = CAMPAIGN.levels;

const BY_ID = createCatalog<string, CampaignLevel, CampaignLevel>(
  Object.fromEntries(CAMPAIGN_LEVELS.map((l) => [l.id, l])),
  (id, defs) => defs[id],
);

/** Lookup by id, for anything naming a level rather than indexing it. */
export function campaignLevelById(id: string): CampaignLevel {
  const found = BY_ID.get(id);
  if (!found) throw new Error(`Unknown campaign level id: ${id}`);
  return found;
}

export const FIRST_CAMPAIGN_LEVEL: CampaignLevel = CAMPAIGN_LEVELS[0];

/**
 * The arenas the campaign actually plays, in `ARENA_DEFS` catalog order.
 *
 * Not every shipped arena is a campaign level. Issue #271 added `vs-duel-01`, a board
 * authored FOR versus and never entered from the campaign, and the versus arc will add
 * more. Campaign-facing sweeps -- difficulty pacing, the claim inventory, the cover
 * ratios each arena quotes in its notes -- take THIS population rather than
 * `ARENA_DEFS`, so that shipping a versus board cannot silently widen a claim that was
 * only ever measured about campaign pacing, and cannot force campaign vocabulary
 * (`lane`, `sightlineAfterBreach`, `spawnBlockRobust`) onto a board validated by
 * `versus-catalog-rules.ts` instead.
 *
 * Geometry sweeps are deliberately NOT scoped this way: `cellCentre` round-trips,
 * spawn-lattice placement and the versus spawn/sightline machinery are properties of
 * every board the game can load, so those keep iterating `ARENA_DEFS`.
 */
const CAMPAIGN_ARENA_IDS: ReadonlySet<string> = new Set(CAMPAIGN_LEVELS.map((l) => l.arenaId));
export const CAMPAIGN_ARENA_DEFS: readonly ArenaDefinition[] = ARENA_DEFS.filter((a) =>
  CAMPAIGN_ARENA_IDS.has(a.id),
);
