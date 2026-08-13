/**
 * A campaign level: player-facing identity, decoupled from board content.
 *
 * Issue #154: before this, "level N" meant `ARENAS[N-1]` everywhere in the game
 * layer -- permanent progress, the active run, and a replay's stamp all named a
 * level by its position in the arena catalog. That collapsed two different
 * things (which board a level plays, and where a level sits in the campaign)
 * into one array position, so the two could never be edited independently.
 */
export interface CampaignLevel {
  /**
   * Player-facing level identity. Opaque -- compared for equality only, never
   * parsed. Order comes ONLY from position in `CampaignDefinition.levels`, not
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
