import { describe, it, expect } from 'vitest';
import { CAMPAIGN, CAMPAIGN_LEVELS, campaignLevelById, FIRST_CAMPAIGN_LEVEL } from './campaign';
import { ARENA_DEFS } from './arenas';

describe('CAMPAIGN: the shipped campaign', () => {
  it('is the one campaign this build ships', () => {
    expect(CAMPAIGN.id).toBe('main');
  });

  it('mirrors the shipped arenas 1:1, today', () => {
    // Day-one shape: campaign.json is a straight mirror of arenas.json's own order
    // (issue #154's own "out of scope" -- reordering the campaign is a later PR).
    expect(CAMPAIGN_LEVELS.length).toBe(5);
    expect(CAMPAIGN_LEVELS[0].id).toBe('level-01');
  });

  it('the set of levels\' arenaIds equals the set of ARENA_DEFS ids', () => {
    // A deliberate pin, not a tautology of "5 == 5": this forces a conscious edit
    // the day an arena joins ARENA_DEFS but not the campaign, or vice versa --
    // production code that only checked lengths would stay green under either.
    // Would fail if: an arena were added to config/data/arenas.json without a
    // matching campaign.json entry (or the reverse).
    const levelArenaIds = new Set(CAMPAIGN_LEVELS.map((l) => l.arenaId));
    const arenaIds = new Set(ARENA_DEFS.map((a) => a.id));
    expect(levelArenaIds).toEqual(arenaIds);
  });
});

describe('campaignLevelById', () => {
  it('finds a real level by id', () => {
    expect(campaignLevelById('level-01')).toEqual(CAMPAIGN_LEVELS[0]);
  });

  it('throws, naming the id, on an unknown level id', () => {
    // Would fail if: campaignLevelById fell back to a default instead of throwing.
    expect(() => campaignLevelById('level-99')).toThrow(/Unknown campaign level id: level-99/);
  });
});

describe('FIRST_CAMPAIGN_LEVEL', () => {
  it('is CAMPAIGN_LEVELS[0], not a freshly-constructed lookalike', () => {
    // Reference equality, not toEqual: levels.ts's sandbox branch and loop.ts's
    // ordinalOf/nextInSession helpers depend on CampaignLevel objects being
    // reused by reference, never rebuilt -- see the invariant in levels.ts.
    expect(FIRST_CAMPAIGN_LEVEL).toBe(CAMPAIGN_LEVELS[0]);
  });
});
