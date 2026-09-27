/**
 * A campaign level: player-facing identity, decoupled from board content, so which
 * board a level plays and where it sits in the campaign can be edited independently
 * (issue #154).
 */
export interface CampaignLevel {
  /**
   * Player-facing level identity. Opaque -- compared for equality only, never
   * parsed. Order comes only from position in `CampaignDefinition.levels`, not
   * from anything encoded in the id itself.
   */
  readonly id: string;
  /** Validated at load to name a real `arenaById()` entry (config/arenas.ts). */
  readonly arenaId: string;
}

export interface CampaignDefinition {
  readonly id: string;
  readonly levels: readonly CampaignLevel[];
}
