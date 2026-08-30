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

  it('plays every shipped arena except the ones named here as versus-only', () => {
    // A deliberate pin, not a tautology of "5 == 5": it forces a conscious edit the day
    // an arena joins ARENA_DEFS but not the campaign, or vice versa. That day arrived
    // with issue #271, and this is the conscious edit -- equality became a partition,
    // NOT a one-way subset. A bare `levelArenaIds ⊆ arenaIds` would let any number of
    // unplayed arenas ship unnoticed, which is exactly the hole the original comment was
    // guarding. Naming the exception keeps the pin sharp: a second versus board still
    // fails here until someone adds it to the list on purpose.
    //
    // Would fail if: an arena were added to config/data/arenas.json without either a
    // matching campaign.json entry or an entry below; or a campaign level named an arena
    // that does not exist (the loader rejects that first); or a board listed here were
    // quietly given a campaign level after all.
    const VERSUS_ONLY = new Set(['vs-duel-01', 'vs-tri-01', 'vs-quad-01']);

    const levelArenaIds = new Set(CAMPAIGN_LEVELS.map((l) => l.arenaId));
    const arenaIds = new Set(ARENA_DEFS.map((a) => a.id));
    const campaignArenaIds = new Set([...arenaIds].filter((id) => !VERSUS_ONLY.has(id)));
    expect(levelArenaIds).toEqual(campaignArenaIds);
    // The exceptions are real arenas, so a typo here cannot silently excuse nothing.
    for (const id of VERSUS_ONLY) expect(arenaIds, `${id} is not a shipped arena`).toContain(id);
    // ...and each is genuinely absent from the campaign, not merely listed.
    for (const id of VERSUS_ONLY) expect(levelArenaIds).not.toContain(id);
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
