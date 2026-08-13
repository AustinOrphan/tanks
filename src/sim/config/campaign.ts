import { createCatalog } from './catalog';
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
